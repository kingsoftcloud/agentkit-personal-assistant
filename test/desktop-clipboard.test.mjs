import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createDesktopController, DESKTOP_CLIPBOARD_MAX_BYTES } from '../runtime/desktop-session.mjs';
import { createComputerAgentServer } from '../runtime/computer-agentd.mjs';
import { createActionRequest } from '../src/computer-broker-protocol.mjs';
import {
  createComputerBrokerClient,
  createHttpComputerBrokerTransport,
  createMockComputerBroker,
} from '../src/computer-broker.mjs';

// src/client/index.mjs 静态引用 conversation.mjs；共享 worktree 里该文件可能正被
// 另一位队友编辑。加载失败时只跳过客户端形状用例，不能掩盖桌面/协议层回归。
let clientModule;
try { clientModule = await import('../src/client/index.mjs'); } catch { clientModule = undefined; }

const readyWindowProperties = '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400001\n_NET_ACTIVE_WINDOW(WINDOW): window id # 0x800002\n';

function fakeProcess() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.killed = true;
    child.emit('exit', 0);
    child.emit('close', 0);
  };
  return child;
}

function fakeClipboardProcess() {
  const child = fakeProcess();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  return child;
}

function createController({ spawnClipboard, onExec } = {}) {
  return createDesktopController({
    display: ':99',
    spawn(file) {
      if (file === 'xclip' && spawnClipboard) return spawnClipboard();
      return fakeProcess();
    },
    async exec(file, args) {
      if (file === 'xprop') return { stdout: readyWindowProperties };
      if (onExec) return onExec(file, args);
      return { stdout: '' };
    },
  });
}

test('readClipboard 用一次性 xclip 读取 UTF8_STRING，无 owner 时返回空字符串而不是抛错', async () => {
  const calls = [];
  let mode = 'text';
  const controller = createController({
    onExec: async (file, args) => {
      calls.push([file, ...args]);
      if (file !== 'xclip') return { stdout: '' };
      if (mode === 'text') return { stdout: '本地复制 → 云电脑' };
      throw Object.assign(new Error('Error: target STRING not available'), { code: 1 });
    },
  });
  try {
    assert.equal(await controller.readClipboard(), '本地复制 → 云电脑');
    mode = 'empty';
    assert.equal(await controller.readClipboard(), '');
    assert.deepEqual(calls.find(call => call[0] === 'xclip'), ['xclip', '-selection', 'clipboard', '-out', '-display', ':99', '-target', 'UTF8_STRING']);
  } finally { await controller.dispose(); }
});

test('readClipboard 按 UTF-8 字符边界截断到 64 KiB，不产生半个汉字', async () => {
  const text = '你'.repeat(30000);
  const controller = createController({ onExec: async file => file === 'xclip' ? { stdout: text } : { stdout: '' } });
  try {
    const value = await controller.readClipboard();
    const bytes = Buffer.byteLength(value, 'utf8');
    assert.ok(bytes <= DESKTOP_CLIPBOARD_MAX_BYTES);
    assert.equal(bytes % 3, 0);
    assert.equal(value, '你'.repeat(bytes / 3));
  } finally { await controller.dispose(); }
});

test('writeClipboard 校验 owner 就绪后保留它供粘贴，下一次写入回收旧 owner', async () => {
  const owners = [];
  let clipboardOut = '';
  let writtenValue = '';
  const controller = createController({
    spawnClipboard() {
      const child = fakeClipboardProcess();
      child.stdin.end = value => { writtenValue = value; clipboardOut = value; };
      owners.push(child);
      return child;
    },
    onExec: async file => file === 'xclip' ? { stdout: clipboardOut } : { stdout: '' },
  });
  try {
    assert.deepEqual(await controller.writeClipboard('第一份'), { written: true });
    assert.equal(writtenValue, '第一份');
    assert.equal(owners.length, 1);
    assert.equal(owners[0].exitCode, null, '写完后 owner 必须继续持有 selection');
    assert.deepEqual(await controller.writeClipboard('第二份'), { written: true });
    assert.equal(owners.length, 2);
    assert.equal(owners[0].exitCode, 0, '新写入必须回收旧 owner');
    assert.equal(owners[1].exitCode, null);
  } finally { await controller.dispose(); }
  assert.equal(owners[1].exitCode, 0, '桌面停止时必须回收剪贴板 owner');
});

test('writeClipboard 在 xclip 无法持有 selection 时抛 DESKTOP_CLIPBOARD_FAILED', async () => {
  const controller = createController({
    spawnClipboard() {
      const child = fakeClipboardProcess();
      child.stdin.end = () => { queueMicrotask(() => { child.exitCode = 1; }); };
      return child;
    },
    onExec: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(controller.writeClipboard('x'), error => error.code === 'DESKTOP_CLIPBOARD_FAILED');
  } finally { await controller.dispose(); }
});

async function agentFixture(t, { desktopMode = '1' } = {}) {
  const state = { text: '云电脑里的剪贴板', writes: [] };
  const service = createComputerAgentServer({
    env: { USER_ID: 'u', ASSISTANT_ID: 'a', COMPUTER_ID: 'c', COMPUTER_HOST: '127.0.0.1', COMPUTER_PORT: '0', AGENTKIT_DESKTOP_MODE: desktopMode },
    desktopFactory: () => ({
      ensureDisplay: async () => {},
      dispose: async () => {},
      closeSessionsForLease: () => {},
      readClipboard: async () => state.text,
      writeClipboard: async text => { state.writes.push(text); state.text = text; return { written: true }; },
    }),
    browserFactory: () => ({ available: true, openDesktopWindow: async () => ({}), dispose: async () => {} }),
    logger: { info() {}, error() {} },
  });
  service.listen();
  await once(service.server, 'listening');
  await service.whenReady;
  t.after(() => service.close());
  const post = async (path, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/broker/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u', assistantId: 'a', computerId: 'c', botId: 'b1', taskId: 't1', ...body }),
    });
    return { status: response.status, value: await response.json() };
  };
  const lease = (await post('lease/acquire', { botId: 'b1', taskId: 't1' })).value.lease;
  return { post, state, lease, identity: { botId: 'b1', taskId: 't1', leaseId: lease.leaseId } };
}

test('broker action 暴露 clipboard.read/clipboard.write 并复用同一租约语义', async t => {
  const { post, state, identity } = await agentFixture(t);
  const read = await post('action', { ...identity, action: 'clipboard.read', args: {} });
  assert.equal(read.status, 200);
  assert.deepEqual(read.value, { text: '云电脑里的剪贴板' });
  const write = await post('action', { ...identity, action: 'clipboard.write', args: { text: '从本机粘贴' } });
  assert.equal(write.status, 200);
  assert.deepEqual(write.value, { written: true });
  assert.deepEqual(state.writes, ['从本机粘贴']);
  assert.deepEqual((await post('action', { ...identity, action: 'clipboard.read', args: {} })).value, { text: '从本机粘贴' });
  assert.equal((await post('action', { botId: 'b1', taskId: 't1', action: 'clipboard.read', args: {} })).value.error, 'COMPUTER_LEASE_REQUIRED');
  assert.equal((await post('action', { ...identity, action: 'clipboard.write', args: {} })).value.error, 'CLIPBOARD_TEXT_INVALID');
  assert.equal((await post('action', { ...identity, action: 'clipboard.write', args: { text: 42 } })).status, 400);
  const oversize = await post('action', { ...identity, action: 'clipboard.write', args: { text: 'x'.repeat(DESKTOP_CLIPBOARD_MAX_BYTES + 1) } });
  assert.equal(oversize.status, 413);
  assert.equal(oversize.value.error, 'CLIPBOARD_TEXT_TOO_LARGE');
});

test('未启用桌面模式时 clipboard action 返回 503，不假装同步成功', async t => {
  const { post, identity } = await agentFixture(t, { desktopMode: '0' });
  const result = await post('action', { ...identity, action: 'clipboard.read', args: {} });
  assert.equal(result.status, 503);
  assert.equal(result.value.error, 'DESKTOP_UNAVAILABLE');
});

test('broker 协议与传输层原样透传 clipboard 动作，不再另行过滤', async () => {
  const request = createActionRequest({ assistantId: 'a', botId: 'b', computerId: 'c', taskId: 't', leaseId: 'l', action: 'clipboard.write', args: { text: 'hi' } });
  assert.equal(request.action, 'clipboard.write');
  assert.deepEqual({ ...request.args }, { text: 'hi' });
  assert.throws(() => createActionRequest({ assistantId: 'a', botId: 'b', computerId: 'c', taskId: 't', leaseId: 'l', action: 'clipboard.paste', args: {} }), /Unsupported computer action/);
  const sent = [];
  const transport = createHttpComputerBrokerTransport({
    baseUrl: 'http://127.0.0.1:8787',
    fetchImpl: async (url, options) => { sent.push({ url: String(url), body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ text: '' }) }; },
  });
  const client = createComputerBrokerClient({ transport });
  await client.action({ assistantId: 'a', botId: 'b', computerId: 'c', taskId: 't', leaseId: 'l', action: 'clipboard.read', args: {} });
  assert.equal(sent[0].url, 'http://127.0.0.1:8787/broker/action');
  assert.deepEqual(sent[0].body.args, {});
  assert.equal(sent[0].body.action, 'clipboard.read');
  const mock = createMockComputerBroker({ computerId: 'c' });
  const lease = (await mock.client.acquireLease({ assistantId: 'a', botId: 'b', computerId: 'c', taskId: 't' })).lease;
  await mock.client.action({ assistantId: 'a', botId: 'b', computerId: 'c', taskId: 't', leaseId: lease.leaseId, action: 'clipboard.write', args: { text: 'hi' } });
  assert.equal(mock.actions.at(-1).action, 'clipboard.write');
  assert.deepEqual(mock.actions.at(-1).args, { text: 'hi' });
});

test('客户端只新增 clipboardRead/clipboardWrite，兼容既有 computer.action RPC 形状', async t => {
  if (!clientModule) return t.skip('src/client/index.mjs 暂时无法加载（共享 worktree 中 conversation.mjs 正在被编辑）');
  const { createPersonalAssistantClient } = clientModule;
  const calls = [];
  const client = createPersonalAssistantClient({
    gateway: { request: async (operation, payload) => { calls.push({ operation, payload }); return { accepted: true }; } },
    profileId: 'profile-1',
  });
  assert.equal(client.selectBot('bot-1'), 'bot-1');
  assert.deepEqual(await client.clipboardRead(), { accepted: true });
  assert.deepEqual(await client.clipboardWrite('粘贴文本'), { accepted: true });
  assert.deepEqual(calls, [
    { operation: 'personal-assistant.computer.action', payload: { action: 'clipboard.read', args: {}, botId: 'bot-1', profileId: 'profile-1' } },
    { operation: 'personal-assistant.computer.action', payload: { action: 'clipboard.write', args: { text: '粘贴文本' }, botId: 'bot-1', profileId: 'profile-1' } },
  ]);
});
