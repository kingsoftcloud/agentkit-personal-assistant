import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, request } from 'node:http';
import { attachDesktopWebSocket } from '../runtime/desktop-ws.mjs';
import { DESKTOP_CLIPBOARD_MAX_BYTES } from '../runtime/desktop-session.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'ws-clipboard-test' };
const env = { AGENTKIT_DESKTOP_JWKS_JSON: JSON.stringify({ keys: [jwk] }) };
const RUNTIME_TOKEN = 'local-test-token-at-least-24-characters';

function permit(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'agentkit-desktop+jwt', kid: 'ws-clipboard-test' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'agentengine-server', aud: 'agentkit-personal-assistant-desktop', scope: 'desktop', agentId: 'ar-test', botId: 'writer', mode: 'read', jti: randomBytes(12).toString('hex'), iat: now, exp: now + 30, leaseId: '', ...overrides })).toString('base64url');
  const unsigned = `${header}.${claims}`;
  return `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

function encode(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4];
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : payload.length < 65536
      ? Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 255])
      : (() => { const value = Buffer.alloc(10); value[0] = 0x81; value[1] = 0xff; value.writeBigUInt64BE(BigInt(payload.length), 2); return value; })();
  return Buffer.concat([header, mask, masked]);
}

async function connect(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/desktop/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': 'agentkit.personal-assistant.desktop.v1', ...headers } });
    req.once('error', reject);
    req.once('response', response => { response.resume(); resolve({ status: response.statusCode }); });
    req.once('upgrade', (response, socket) => {
      const messages = []; let buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          let size = buffer[1] & 0x7f; let offset = 2;
          if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
          if (size === 127 || buffer.length < offset + size) return;
          if ((buffer[0] & 15) === 1) messages.push(JSON.parse(buffer.subarray(offset, offset + size).toString()));
          buffer = buffer.subarray(offset + size);
        }
      });
      resolve({ status: response.statusCode, socket, send: value => socket.write(encode(value)), async next(predicate) {
        const end = Date.now() + 2000;
        while (Date.now() < end) { const value = messages.find(predicate); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
        throw new Error('WebSocket response timed out');
      } });
    });
    req.end();
  });
}

async function fixture(t, { desktopPermit } = {}) {
  const calls = [];
  const server = createServer();
  attachDesktopWebSocket({ server, runtimeToken: RUNTIME_TOKEN, assistantId: 'ar-test', env,
    botIdOf: value => value, taskIdOf: value => value || 'task',
    brokerDesktopRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === '/broker/lease/acquire') return { lease: { leaseId: 'lease-1' } };
      if (path === '/broker/desktop/session') return { sessionId: 'session-1', readOnly: false, controlEpoch: 0, idleMode: 'retain-desktop' };
      if (path === '/broker/action') return body.action === 'clipboard.read' ? { text: '云电脑剪贴板' } : { written: true };
      return {};
    },
    brokerDesktopFrameBinary: async () => ({ unchanged: true, seq: 0, width: 1280, height: 800 }),
    listBots: () => [],
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = await connect(server.address().port, desktopPermit ? { 'X-AgentEngine-Desktop-Permit': desktopPermit } : { authorization: `Bearer ${RUNTIME_TOKEN}` });
  t.after(() => client.socket?.destroy());
  assert.equal(client.status, 101);
  return { client, calls };
}

const clipboardActionCalls = calls => calls.filter(call => call.path === '/broker/action');

test('可控桌面通过 WS 读写剪贴板，broker 请求带租约且 value 原样回传', async t => {
  const { client, calls } = await fixture(t);
  client.send({ type: 'open', botId: 'writer', taskId: 'task-1', mode: 'control' });
  await client.next(value => value.type === 'ready');
  client.send({ type: 'clipboard.read', requestId: 'clip-read-1' });
  const read = await client.next(value => value.type === 'clipboard.response' && value.requestId === 'clip-read-1');
  assert.deepEqual(read, { type: 'clipboard.response', requestId: 'clip-read-1', ok: true, value: { text: '云电脑剪贴板' } });
  assert.deepEqual(clipboardActionCalls(calls)[0].body, { botId: 'writer', taskId: 'task-1', leaseId: 'lease-1', action: 'clipboard.read', args: {} });
  client.send({ type: 'clipboard.write', requestId: 'clip-write-1', text: '本地复制 → 云电脑' });
  const write = await client.next(value => value.type === 'clipboard.response' && value.requestId === 'clip-write-1');
  assert.deepEqual(write, { type: 'clipboard.response', requestId: 'clip-write-1', ok: true, value: { written: true } });
  assert.deepEqual(clipboardActionCalls(calls)[1].body.args, { text: '本地复制 → 云电脑' });
});

test('剪贴板参数校验：非字符串 400、超 64 KiB 413，且不触碰 broker', async t => {
  const { client, calls } = await fixture(t);
  client.send({ type: 'open', botId: 'writer', taskId: 'task-1', mode: 'control' });
  await client.next(value => value.type === 'ready');
  client.send({ type: 'clipboard.write', requestId: 'bad-type', text: 42 });
  const invalid = await client.next(value => value.requestId === 'bad-type');
  assert.deepEqual(invalid.error, { code: 'CLIPBOARD_TEXT_INVALID', message: '剪贴板文本必须是字符串', status: 400 });
  client.send({ type: 'clipboard.write', requestId: 'too-large', text: 'x'.repeat(DESKTOP_CLIPBOARD_MAX_BYTES + 1) });
  const oversized = await client.next(value => value.requestId === 'too-large');
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'CLIPBOARD_TEXT_TOO_LARGE');
  assert.equal(oversized.error.status, 413);
  assert.equal(clipboardActionCalls(calls).length, 0);
  client.send({ type: 'clipboard.read', requestId: 'bad id!' });
  assert.equal((await client.next(value => value.type === 'error')).code, 'CLIPBOARD_REQUEST_INVALID');
});

test('未打开桌面时 clipboard 返回 404，只读授权返回 403', async t => {
  const noSession = await fixture(t);
  noSession.client.send({ type: 'clipboard.read', requestId: 'no-session' });
  const missing = await noSession.client.next(value => value.requestId === 'no-session');
  assert.deepEqual(missing.error, { code: 'DESKTOP_SESSION_NOT_FOUND', message: 'desktop session is not open', status: 404 });
  const readOnly = await fixture(t, { desktopPermit: permit() });
  readOnly.client.send({ type: 'open', botId: 'writer', taskId: 'task-1' });
  await readOnly.client.next(value => value.type === 'ready');
  readOnly.client.send({ type: 'clipboard.read', requestId: 'read-only' });
  const denied = await readOnly.client.next(value => value.requestId === 'read-only');
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'DESKTOP_READ_ONLY');
  assert.equal(denied.error.status, 403);
  assert.equal(clipboardActionCalls(readOnly.calls).length, 0);
});

test('handoff 未持有控制权时 clipboard 返回 409，不误用旁观租约', async t => {
  const { client, calls } = await fixture(t, { desktopPermit: permit({ mode: 'control' }) });
  client.send({ type: 'open', botId: 'writer', taskId: 'task-1', mode: 'observe' });
  await client.next(value => value.type === 'ready');
  client.send({ type: 'clipboard.write', requestId: 'handoff-write', text: 'x', controlEpoch: 0 });
  const denied = await client.next(value => value.requestId === 'handoff-write');
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'DESKTOP_CONTROL_EPOCH_CHANGED');
  assert.equal(denied.error.status, 409);
  assert.equal(clipboardActionCalls(calls).length, 0);
});
