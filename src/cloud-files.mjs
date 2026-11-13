import { open, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const CLOUD_ATTACHMENT_MAX_BYTES = 512 * 1024;
const fail = message => Object.assign(new Error(message), { code: 'CLOUD_FILE_INVALID', status: 400 });
const segments = path => {
  if (typeof path !== 'string' || path.length > 2048) throw fail('文件路径无效');
  const parts = path.split('/');
  if (!parts.length || parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f]/u.test(part))) throw fail('文件必须位于云电脑工作区内');
  return parts;
};

/** 逐层固定目录 FD，拒绝符号链接；命令并发换名不能把 Runtime 的文件访问引到私有目录。 */
export function createCloudFileStore(root) {
  const ownedPrefix = (botId, sessionId) => `uploads/${createHash('sha256').update(JSON.stringify([botId, sessionId])).digest('hex').slice(0, 32)}/`;
  /** 与 withParent 同口径地打开一个目录 FD 链：逐层 O_NOFOLLOW，拒绝符号链接。 */
  const openDirectory = async parts => {
    let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const part of parts) {
        const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await directory.close();
        directory = next;
      }
      return directory;
    } catch (error) {
      await directory.close().catch(() => {});
      throw error;
    }
  };
  const withParent = async (path, create, task) => {
    const parts = segments(path); let parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const part of parts.slice(0, -1)) {
        const target = `/proc/self/fd/${parent.fd}/${part}`;
        if (create) await mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const next = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await parent.close(); parent = next;
      }
      return await task(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`);
    } finally { await parent.close(); }
  };
  const read = path => withParent(path, false, async target => {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > CLOUD_ATTACHMENT_MAX_BYTES) throw fail('仅支持不超过 512 KiB 的普通文件');
      const bytes = Buffer.alloc(CLOUD_ATTACHMENT_MAX_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > CLOUD_ATTACHMENT_MAX_BYTES) throw fail('文件超过 512 KiB');
      return bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
  });
  return {
    async upload({ botId, sessionId, name, dataUrl }) {
      if (typeof name !== 'string' || name.length > 120 || /[\/\\\u0000-\u001f]/u.test(name)) throw fail('文件名无效');
      const match = typeof dataUrl === 'string' && dataUrl.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/iu);
      if (!match || match[2].length > Math.ceil(CLOUD_ATTACHMENT_MAX_BYTES / 3) * 4) throw fail('附件格式无效或超过 512 KiB');
      const bytes = Buffer.from(match[2], 'base64');
      if (bytes.length > CLOUD_ATTACHMENT_MAX_BYTES || bytes.toString('base64') !== match[2]) throw fail('附件编码无效');
      const path = ownedPrefix(botId, sessionId) + randomUUID() + '-' + name;
      await withParent(path, true, async target => { const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await file.writeFile(bytes); } finally { await file.close(); } });
      return { path, name, bytes: bytes.length, mediaType: match[1].toLowerCase() };
    },
    async attachment({ botId, sessionId, path }) {
      if (typeof path !== 'string' || !path.startsWith(ownedPrefix(botId, sessionId))) throw fail('附件不属于当前云端会话');
      return read(path);
    },
    async download(path) { const data = await read(path); return { path, name: path.split('/').at(-1), bytes: data.length, data: data.toString('base64') }; },
    /**
     * 列出某个云端会话上传过的附件（最新 200 个）。
     *
     * 只返回 `uploads/<bot+session hash>/` 这一层里的普通文件：符号链接、子目录、
     * 控制字符文件名全部跳过；超过 512 KiB 的文件不出现在列表里（下载也会被拒），
     * 避免面板给出一个点了必然失败、或者会把大文件读进内存的入口。
     */
    async list({ botId, sessionId }) {
      const prefix = ownedPrefix(botId, sessionId);
      let directory;
      try { directory = await openDirectory(prefix.slice(0, -1).split('/')); }
      catch (error) { if (error?.code === 'ENOENT') return { files: [] }; throw error; }
      try {
        const entries = await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true });
        const files = [];
        for (const entry of entries) {
          if (!entry.isFile() || /[\\\u0000-\u001f]/u.test(entry.name)) continue;
          const file = await open(`/proc/self/fd/${directory.fd}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
          if (!file) continue;
          try {
            const info = await file.stat();
            if (info.isFile() && info.size <= CLOUD_ATTACHMENT_MAX_BYTES) files.push({ path: prefix + entry.name, name: entry.name, bytes: info.size });
          } finally { await file.close().catch(() => {}); }
        }
        return { files: files.slice(0, 200) };
      } finally { await directory.close(); }
    },
  };
}
