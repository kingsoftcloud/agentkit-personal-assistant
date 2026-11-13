import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudFileStore, CLOUD_ATTACHMENT_MAX_BYTES } from '../src/cloud-files.mjs';

test('真实 Linux 附件上传/下载中文一致，跨会话与符号链接越界拒绝', { skip: process.env.AGENTKIT_FILES_LIVE !== '1' }, async t => {
  const root = await mkdtemp(join(process.env.AGENTKIT_FILES_TEST_ROOT || tmpdir(), '.pa-files-live-'));
  const outside = await mkdtemp(join(tmpdir(), 'pa-files-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const store = createCloudFileStore(root), data = Buffer.from('你好，云电脑 😀\n');
  const uploaded = await store.upload({ botId: 'default', sessionId: 'one', name: '中文.txt', dataUrl: 'data:text/plain;base64,' + data.toString('base64') });
  assert.deepEqual(await store.attachment({ botId: 'default', sessionId: 'one', path: uploaded.path }), data);
  assert.equal((await store.download(uploaded.path)).data, data.toString('base64'));
  await assert.rejects(store.attachment({ botId: 'default', sessionId: 'two', path: uploaded.path }), /不属于/);
  await writeFile(join(outside, 'private'), 'private-test-sentinel');
  await symlink(outside, join(root, 'escape'));
  await symlink(join(outside, 'private'), join(root, 'file-escape'));
  await assert.rejects(store.download('escape/private'));
  await assert.rejects(store.download('file-escape'));
  await assert.rejects(store.download('../private'), /工作区/);
});

test('真实 Linux 附件列表只列当前会话的普通文件，跳过符号链接、子目录与超限文件', { skip: process.env.AGENTKIT_FILES_LIVE !== '1' }, async t => {
  const root = await mkdtemp(join(process.env.AGENTKIT_FILES_TEST_ROOT || tmpdir(), '.pa-files-list-'));
  const outside = await mkdtemp(join(tmpdir(), 'pa-files-list-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const store = createCloudFileStore(root);
  const dataUrl = 'data:text/plain;base64,' + Buffer.from('hi').toString('base64');
  await store.upload({ botId: 'default', sessionId: 'one', name: 'a.txt', dataUrl });
  await store.upload({ botId: 'default', sessionId: 'one', name: 'b.txt', dataUrl });
  await store.upload({ botId: 'default', sessionId: 'two', name: 'other.txt', dataUrl });

  // 目录里再放一个子目录、一个越界符号链接和一个超限文件，验证列表会过滤掉它们。
  const { createHash } = await import('node:crypto');
  const { mkdir, symlink: link, writeFile: write } = await import('node:fs/promises');
  const dir = join(root, 'uploads', createHash('sha256').update(JSON.stringify(['default', 'one'])).digest('hex').slice(0, 32));
  await mkdir(join(dir, 'nested'), { recursive: true });
  await write(join(outside, 'secret'), 'secret');
  await link(join(outside, 'secret'), join(dir, 'escape.txt'));
  await write(join(dir, 'huge.bin'), Buffer.alloc(CLOUD_ATTACHMENT_MAX_BYTES + 1));

  const { files } = await store.list({ botId: 'default', sessionId: 'one' });
  assert.deepEqual(files.map(file => file.name).sort(), ['a.txt', 'b.txt']);

  const other = await store.list({ botId: 'default', sessionId: 'two' });
  assert.deepEqual(other.files.map(file => file.name), ['other.txt']);

  // 不存在的会话目录返回空列表，而不是抛 ENOENT。
  assert.deepEqual((await store.list({ botId: 'default', sessionId: 'missing' })).files, []);
});
