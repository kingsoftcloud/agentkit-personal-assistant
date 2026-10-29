/**
 * 云端 DSH 网页入口桥。
 *
 * 云端 DSH 网页（`dsh web`）只监听同一 Pod 的 127.0.0.1:8081，且必须带启动时生成的
 * token。云桌面里的浏览器和宿主共享同一个网络命名空间，因此地址本身可达，缺的只是
 * token。这里做两件事：
 *   1) 从本机 DSH 启动日志里读出这一次的网页地址（token 只在这个 Pod 内使用）；
 *   2) 把地址推送给云电脑的 desktop agentd（`dsh.web` 动作），由它交给欢迎页桥。
 *
 * 边界：
 *   - token 不落盘、不写日志：只在内存里传给 agentd；日志只记录 host/port。
 *   - 只接受本机回环地址，避免把外网地址塞进云桌面。
 *   - 推送失败不阻塞宿主就绪，由调用方在后台重试；地址变化（DSH 重启）会再推一次。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TOKEN_URL_PATTERN = /https?:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9._~+\/-]{8,})/u;

/** 从一段日志文本里取出本机 DSH 网页地址；没有就返回 null。 */
export function extractDshWebUrl(text) {
  if (typeof text !== 'string' || !text) return null;
  const match = TOKEN_URL_PATTERN.exec(text);
  if (!match) return null;
  const url = match[0];
  try {
    const parsed = new URL(url);
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
    return parsed.href;
  } catch { return null; }
}

/** 只允许本机回环 http(s) 地址。 */
export function isLoopbackDshWebUrl(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 512) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch { return false; }
}

/**
 * 读运行容器 /tmp 里的地址文件（entrypoint 从 DSH 启动输出里摘出来，权限 600，容器重启即失效）。
 * 这是首选来源；日志解析只是没有该文件时的兜底。
 */
export async function readDshWebUrlFile({ file, readFile = null } = {}) {
  const target = file || process.env.AGENTKIT_DSH_WEB_URL_FILE || '/tmp/agentkit-runtime/dsh-web-url';
  if (typeof target !== 'string' || !target) return null;
  try {
    const read = readFile || (await import('node:fs/promises')).readFile;
    const text = await read(target, 'utf8');
    const line = String(text).split('\n').map(item => item.trim()).find(item => item.startsWith('http://') || item.startsWith('https://'));
    return isLoopbackDshWebUrl(line) ? new URL(line).href : null;
  } catch { return null; }
}

/**
 * 读最新的 DSH 启动日志，找这一步用的网页地址。
 * 日志文件名形如 startup-<iso>-<uuid>.log，按修改时间取最新一条即可。
 */
export async function findDshWebUrl({ dshHome, readdir, stat, readFile } = {}) {
  if (typeof dshHome !== 'string' || !dshHome) return null;
  const dir = `${dshHome.replace(/\/+$/u, '')}/logs`;
  let names;
  try { names = await readdir(dir); } catch { return null; }
  const candidates = (Array.isArray(names) ? names : []).filter(name => /^startup-.*\.log$/u.test(name));
  if (candidates.length === 0) return null;
  const withTimes = await Promise.all(candidates.map(async name => {
    try { return { name, at: (await stat(`${dir}/${name}`)).mtimeMs || 0 }; } catch { return null; }
  }));
  const newest = withTimes.filter(Boolean).sort((left, right) => right.at - left.at)[0];
  if (!newest) return null;
  let text;
  try { text = await readFile(`${dir}/${newest.name}`, 'utf8'); } catch { return null; }
  return extractDshWebUrl(text);
}

/** 把网页地址推给云电脑 agentd；返回 {published:true} 或抛错。 */
export async function publishDshWebUrl({ brokerUrl, url, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!isLoopbackDshWebUrl(url)) throw Object.assign(new Error('云端助理地址必须是本机回环地址'), { code: 'DSH_WEB_URL_INVALID' });
  if (typeof brokerUrl !== 'string' || !brokerUrl) throw Object.assign(new Error('缺少云电脑地址'), { code: 'COMPUTER_BROKER_UNAVAILABLE' });
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('缺少 fetch 实现'), { code: 'COMPUTER_BROKER_UNAVAILABLE' });
  const target = new URL('/broker/dsh-web', brokerUrl.endsWith('/') ? brokerUrl : `${brokerUrl}/`);
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 'personal-assistant.computer-broker/v1', url }),
    ...(signal ? { signal } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || body.error || `云电脑拒绝了云端助理地址 (${response.status})`), { code: body.error || 'COMPUTER_BROKER_FAILED', status: response.status });
  return { published: true, url };
}

/**
 * 后台把地址推给云电脑：日志可能比宿主就绪晚出现，所以隔一会儿重试几次；
 * 找到地址后还要周期性重推 —— 云电脑容器（agentd）可以单独重启，重启后
 * 内存里的 dshWebUrl 会丢，只推一次会让欢迎页的「云助理」一直 404。
 * 任何失败都只记日志，不影响宿主启动。
 */
export function startDshWebBridge({ env = process.env, brokerUrl, intervalMs = 5000, attempts = 24, republishMs = 30000, timers = { setTimeout, clearTimeout }, logger = console, findUrl = findDshWebUrl, publish = publishDshWebUrl } = {}) {
  const endpoint = brokerUrl || env.COMPUTER_BROKER_URL || env.AGENTKIT_COMPUTER_URL;
  const dshHome = env.DSH_HOME;
  let stopped = false;
  let timer = null;
  let lastPublished = null;
  let lastPublishedAt = 0;
  let remaining = attempts;
  const run = async () => {
    if (stopped) return;
    let url = null;
    try {
      url = await readDshWebUrlFile({ file: env.AGENTKIT_DSH_WEB_URL_FILE })
        || await findUrl({ dshHome, readdir: (await import('node:fs/promises')).readdir, stat: (await import('node:fs/promises')).stat, readFile: (await import('node:fs/promises')).readFile });
    } catch (error) {
      logger.warn(JSON.stringify({ event: 'personal-assistant.dsh-web.unavailable', code: error?.code || 'DSH_WEB_LOOKUP_FAILED' }));
    }
    if (url) {
      const changed = url !== lastPublished;
      if (changed || Date.now() - lastPublishedAt >= republishMs) {
        try {
          await publish({ brokerUrl: endpoint, url });
          lastPublished = url; lastPublishedAt = Date.now();
          remaining = attempts;
          if (changed) logger.info(JSON.stringify({ event: 'personal-assistant.dsh-web.registered', host: new URL(url).hostname, port: new URL(url).port }));
        } catch (error) {
          logger.warn(JSON.stringify({ event: 'personal-assistant.dsh-web.publish-retry', code: error?.code || 'DSH_WEB_PUBLISH_FAILED' }));
        }
      }
      timer = timers.setTimeout(() => { void run(); }, intervalMs);
      timer?.unref?.();
      return;
    }
    remaining -= 1;
    if (remaining <= 0 || stopped) return;
    timer = timers.setTimeout(() => { void run(); }, intervalMs);
    timer?.unref?.();
  };
  void run();
  return Object.freeze({ stop() { stopped = true; if (timer) timers.clearTimeout(timer); }, get published() { return lastPublished; } });
}
