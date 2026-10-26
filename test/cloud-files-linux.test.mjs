import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudFileStore } from '../src/cloud-files.mjs';

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
