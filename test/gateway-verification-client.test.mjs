import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { GatewayDesktopClient, openGatewayDesktop } from '../scripts/verification/gateway-desktop-client.mjs';

const serverFrame = (opcode, payload, fin = true) => {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(data.length < 126 ? 2 : 4); header[0] = (fin ? 0x80 : 0) | opcode;
  if (data.length < 126) header[1] = data.length; else { header[1] = 126; header.writeUInt16BE(data.length, 2); }
  return Buffer.concat([header, data]);
};
class Socket extends EventEmitter {
  writes = [];
  write(data) { this.writes.push(data); this.onWrite?.(data); return true; }
  destroy() { this.destroyed = true; this.emit('close'); }
  end(data) { if (data) this.write(data); this.emit('close'); }
}
const clientBody = packet => {
  assert.ok(packet[1] & 0x80, 'client frames must be masked');
  const size = packet[1] & 127, offset = size === 126 ? 4 : 2, mask = packet.subarray(offset, offset + 4), payload = Buffer.from(packet.subarray(offset + 4));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return (packet[0] & 15) === 1 ? JSON.parse(payload.toString()) : null;
};

test('验收客户端只保留 JPEG 大小与时间，不保留图像正文；支持分片与同包多消息', () => {
  const socket = new Socket(), client = new GatewayDesktopClient(socket), jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
  socket.emit('data', Buffer.concat([serverFrame(1, { type: 'frame', seq: 1 }), serverFrame(2, jpeg.subarray(0, 3), false), serverFrame(0, jpeg.subarray(3))]));
  assert.equal(client.frames.length, 1); assert.equal(client.frames[0].bytes, jpeg.length);
  assert.deepEqual(Object.keys(client.frames[0]).sort(), ['at', 'bytes']); assert.deepEqual(client.events, []);
});

test('409 前的只读状态同步不能被误判成接管成功，历史响应也不串给新命令', async () => {
  const socket = new Socket(), client = new GatewayDesktopClient(socket);
  socket.emit('data', serverFrame(1, { type: 'control', readOnly: false, controlEpoch: 2 }));
  const pending = client.request({ type: 'control.acquire', controlEpoch: 2 }, value => value.type === 'control' && !value.readOnly);
  socket.emit('data', Buffer.concat([serverFrame(1, { type: 'control', readOnly: true, controlEpoch: 2 }), serverFrame(1, { type: 'error', status: 409, code: 'COMPUTER_LEASE_CONFLICT' })]));
  await assert.rejects(pending, { status: 409, code: 'COMPUTER_LEASE_CONFLICT' });
});

test('不是 JPEG 的二进制不能被记作首帧成功', () => {
  const socket = new Socket(), client = new GatewayDesktopClient(socket);
  socket.emit('data', serverFrame(2, Buffer.from('not a frame')));
  assert.match(client.failure.message, /not JPEG/); assert.equal(socket.destroyed, true); assert.equal(client.frames.length, 0);
});

test('网关只在出票 HTTP 用 Bearer，WSS 只用 opaque 子协议且不把 token 放 URL', async t => {
  const socket = new Socket(); const ticket = 'x'.repeat(40); let sawUpgrade = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://gateway.example.test/IssuePersonalAssistantDesktopTicket');
    assert.equal(options.headers.authorization, 'Bearer fixture-secret');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ Code: 0, Data: { Ticket: ticket, AgentId: 'agent', BotId: 'default', WsPath: 'personal-assistant/desktop/ws', ExpiresAt: Math.floor(Date.now() / 1000) + 59 } }) };
  });
  t.mock.method(https, 'request', (url, options) => {
    sawUpgrade = true;
    assert.equal(url.href, 'https://gateway.example.test/personal-assistant/desktop/ws');
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers['sec-websocket-protocol'], `agentkit.personal-assistant.desktop.v1, agentkit.desktop.ticket.${ticket}`);
    assert.equal(options.rejectUnauthorized, undefined, 'TLS 验证不能关闭');
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit('upgrade', { headers: {
      'sec-websocket-accept': createHash('sha1').update(`${options.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64'),
      'sec-websocket-protocol': 'agentkit.personal-assistant.desktop.v1',
    } }, socket, Buffer.alloc(0)));
    return request;
  });
  socket.onWrite = packet => {
    const body = clientBody(packet);
    if (body?.type === 'open') { assert.equal(body.mode, 'observe'); queueMicrotask(() => socket.emit('data', serverFrame(1, { type: 'ready', sessionId: 'view', readOnly: true, controlAvailable: true, controlEpoch: 0 }))); }
  };
  const { client, ready } = await openGatewayDesktop({ gatewayUrl: 'https://gateway.example.test', apiKey: 'fixture-secret', agentId: 'agent', botId: 'default', taskId: 'task' });
  assert.equal(sawUpgrade, true); assert.equal(ready.controlAvailable, true); await client.close();
});

test('出票到期时间严格使用 Server 的 Unix 秒契约，错误类型或超过一分钟均拒绝', async t => {
  let expiry;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ Code: 0, Data: {
    Ticket: 'x'.repeat(40), AgentId: 'agent', BotId: 'default', WsPath: 'personal-assistant/desktop/ws', ExpiresAt: expiry,
  } }) }));
  t.mock.method(https, 'request', () => assert.fail('invalid ticket must be rejected before WS upgrade'));
  for (expiry of [new Date(Date.now() + 59000).toISOString(), Date.now() + 59000, '1793010000', 0, null, Math.floor(Date.now() / 1000) + 120]) {
    await assert.rejects(openGatewayDesktop({ gatewayUrl: 'https://gateway.example.test', apiKey: 'fixture-secret', agentId: 'agent', botId: 'default' }), /ticket binding is invalid/u);
  }
});
