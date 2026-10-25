import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, request } from 'node:http';
import { attachDesktopWebSocket, verifyDesktopPermit } from '../runtime/desktop-ws.mjs';
import { DIRECTORY_BOT_ID } from '../src/client/bot-directory.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'server-test' };
const env = { AGENTKIT_DESKTOP_JWKS_JSON: JSON.stringify({ keys: [jwk] }) };
function permit(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'agentkit-desktop+jwt', kid: 'server-test' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'agentengine-server', aud: 'agentkit-personal-assistant-desktop', scope: 'desktop', agentId: 'ar-test', botId: 'observer', mode: 'read', jti: randomBytes(12).toString('hex'), iat: now, exp: now + 30, leaseId: '', ...overrides })).toString('base64url');
  const unsigned = `${header}.${claims}`;
  return `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString('base64url')}`;
}
function encode(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4];
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 255]);
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
      resolve({ status: response.statusCode, protocol: response.headers['sec-websocket-protocol'], socket, send: value => socket.write(encode(value)), async next(predicate) {
        const end = Date.now() + 2000;
        while (Date.now() < end) { const value = messages.find(predicate); if (value) return value; await new Promise(r => setTimeout(r, 5)); }
        throw new Error('WebSocket response timed out');
      } });
    });
    req.end();
  });
}

test('desktop permit verifies signer, Agent, audience, expiry and rejects forged payload', async () => {
  const valid = permit();
  assert.equal((await verifyDesktopPermit(valid, { assistantId: 'ar-test', env })).mode, 'read');
  for (const value of [permit({ agentId: 'ar-other' }), permit({ aud: 'another-service' }), permit({ exp: 1 }), `${valid.slice(0, -3)}abc`]) {
    await assert.rejects(() => verifyDesktopPermit(value, { assistantId: 'ar-test', env }), error => error.status === 401);
  }
  await assert.rejects(() => verifyDesktopPermit(valid, { assistantId: 'ar-test', env: {} }), error => error.status === 401);
});

test('desktop socket rejects forged headers, locks read permit Bot/mode, consumes permit once', async t => {
  const calls = [];
  const server = createServer();
  attachDesktopWebSocket({ server, runtimeToken: 'private-token-at-least-24-characters', assistantId: 'ar-test', env,
    botIdOf: value => value, taskIdOf: value => value || 'task',
    brokerDesktopRequest: async (path, body) => { calls.push({ path, body }); return path.endsWith('/session') ? { sessionId: 'observe-session', readOnly: true } : {}; },
    brokerDesktopFrameBinary: async () => ({ unchanged: true, seq: 1, width: 1280, height: 800 }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  assert.equal((await connect(port, { 'X-AgentEngine-Desktop-Assistant-Id': 'ar-test', 'X-AgentEngine-Desktop-Session': 'anything' })).status, 401);
  const token = permit();
  const client = await connect(port, { 'X-AgentEngine-Desktop-Permit': token });
  t.after(() => client.socket?.destroy());
  assert.equal(client.status, 101);
  assert.equal(client.protocol, 'agentkit.personal-assistant.desktop.v1');
  client.send({ type: 'open', botId: 'other', taskId: 't' });
  assert.equal((await client.next(value => value.type === 'error')).status, 403);
  client.send({ type: 'open', botId: 'observer', taskId: 't', mode: 'control' });
  assert.equal((await client.next(value => value.status === 409)).code, 'COMPUTER_LEASE_REQUIRED');
  client.send({ type: 'open', botId: 'observer', taskId: 't' });
  assert.equal((await client.next(value => value.type === 'ready')).readOnly, true);
  assert.equal(calls.some(value => value.path.includes('/acquire')), false);
  assert.equal((await connect(port, { 'X-AgentEngine-Desktop-Permit': token })).status, 401);
  client.socket.destroy();
});

test('目录授权只返回助理展示字段，不开桌面、不申请租约，且不能改作控制', async t => {
  const calls = [];
  const server = createServer();
  attachDesktopWebSocket({ server, runtimeToken: 'private-token-at-least-24-characters', assistantId: 'ar-test', env,
    botIdOf: value => value, taskIdOf: value => value,
    listBots: () => [{ botId: 'writer', displayName: '写作助理', systemPrompt: 'private prompt' }],
    brokerDesktopRequest: async path => { calls.push(path); return {}; },
    brokerDesktopFrameBinary: async () => { calls.push('frame'); return {}; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const clients = [];
  t.after(() => clients.forEach(client => client.socket?.destroy()));
  for (const [botId, mode] of [[DIRECTORY_BOT_ID, 'read'], ['writer', 'read'], [DIRECTORY_BOT_ID, 'control']]) {
    const client = await connect(server.address().port, { 'X-AgentEngine-Desktop-Permit': permit({ botId, mode }) }); clients.push(client);
    client.send({ type: 'bots.list' });
    if (botId === DIRECTORY_BOT_ID && mode === 'read') assert.deepEqual((await client.next(value => value.type === 'bots')).bots, [{ botId: 'writer', displayName: '写作助理' }]);
    else assert.equal((await client.next(value => value.type === 'error')).status, 403);
  }
  const reader = await connect(server.address().port, { 'X-AgentEngine-Desktop-Permit': permit({ botId: DIRECTORY_BOT_ID, mode: 'read' }) }); clients.push(reader);
  reader.send({ type: 'open', botId: DIRECTORY_BOT_ID, taskId: 't' });
  assert.equal((await reader.next(value => value.type === 'error')).status, 403);
  assert.deepEqual(calls, []);
});

test('只读签名授权在空闲恢复时仍不能升级控制或申请租约', async t => {
  const calls = [], server = createServer();
  attachDesktopWebSocket({ server, runtimeToken: 'local-private-token-at-least-24', assistantId: 'ar-test', env,
    botIdOf: value => value, taskIdOf: value => value,
    brokerDesktopRequest: async (path, body) => { calls.push({ path, body }); return path.endsWith('/session') || path.endsWith('/resume') ? { sessionId: 'observer-idle', readOnly: true, idleMode: 'suspend', idleTimeoutMs: 1000 } : {}; },
    brokerDesktopFrameBinary: async () => ({ unchanged: true, seq: 1, nextFrameDelayMs: 1000 }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = await connect(server.address().port, { 'X-AgentEngine-Desktop-Permit': permit() });
  t.after(() => { client.socket.destroy(); server.closeAllConnections(); server.close(); });
  client.send({ type: 'open', botId: 'observer', taskId: 't', mode: 'read' });
  await client.next(v => v.type === 'idle');
  client.send({ type: 'resume', mode: 'control', activity: true });
  assert.equal((await client.next(v => v.code === 'DESKTOP_READ_ONLY')).status, 403);
  assert.equal(calls.some(v => v.path.endsWith('/acquire')), false);
  assert.equal(calls.some(v => v.path.endsWith('/input')), false);
});
