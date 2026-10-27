/** 验收专用 Gateway WSS 客户端：TLS 保持验证，票据只放子协议，JPEG 只计数。 */
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const PROTOCOL = 'agentkit.personal-assistant.desktop.v1', MAX_FRAME = 400 * 1024;
const maskedFrame = (opcode, data = Buffer.alloc(0)) => {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data), mask = randomBytes(4);
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (body.length < 126) header[1] = 0x80 | body.length;
  else { header[1] = 0x80 | 126; header.writeUInt16BE(body.length, 2); }
  const payload = Buffer.from(body);
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, payload]);
};

export class GatewayDesktopClient extends EventEmitter {
  constructor(socket, { openedAt = Date.now() } = {}) {
    super(); this.socket = socket; this.openedAt = openedAt; this.events = []; this.sequence = 0;
    this.frames = []; this.pending = Buffer.alloc(0); this.fragment = null; this.controlEpoch = 0; this.closed = false;
    socket.on('data', chunk => { try { this.parse(chunk); } catch (error) { this.failure = error; socket.destroy(); this.emit('ended'); } });
    socket.on('error', error => { this.failure = error; this.emit('ended'); });
    socket.on('close', () => { this.closed = true; this.emit('ended'); });
  }
  parse(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > 2 * 1024 * 1024) throw new Error('gateway WS receive buffer exceeds limit');
    while (this.pending.length >= 2) {
      const fin = Boolean(this.pending[0] & 0x80), opcode = this.pending[0] & 15;
      if (this.pending[0] & 0x70) throw new Error('unexpected WS extension bits');
      if (this.pending[1] & 0x80) throw new Error('server WS frames must not be masked');
      let length = this.pending[1] & 127, offset = 2;
      if (length === 126) { if (this.pending.length < 4) return; length = this.pending.readUInt16BE(2); offset = 4; }
      if (length === 127) {
        if (this.pending.length < 10) return;
        const wide = this.pending.readBigUInt64BE(2);
        if (wide > BigInt(MAX_FRAME)) throw new Error('gateway WS frame exceeds limit');
        length = Number(wide); offset = 10;
      }
      if (length > MAX_FRAME) throw new Error('gateway WS frame exceeds limit');
      if (this.pending.length < offset + length) return;
      const payload = this.pending.subarray(offset, offset + length); this.pending = this.pending.subarray(offset + length);
      if (opcode === 8) { this.closed = true; this.emit('ended'); return; }
      if (opcode === 9) { this.socket.write(maskedFrame(10, payload)); continue; }
      if (opcode === 10) continue;
      if (opcode === 0) {
        if (!this.fragment) throw new Error('unexpected WS continuation');
        this.fragment.chunks.push(payload); this.fragment.bytes += length;
        if (this.fragment.bytes > MAX_FRAME) throw new Error('fragmented WS message exceeds limit');
        if (fin) { const fragment = this.fragment; this.fragment = null; this.message(fragment.opcode, Buffer.concat(fragment.chunks)); }
      } else if (!fin) {
        if (this.fragment || ![1, 2].includes(opcode)) throw new Error('invalid fragmented WS message');
        this.fragment = { opcode, chunks: [payload], bytes: payload.length };
      } else this.message(opcode, payload);
    }
  }
  message(opcode, payload) {
    if (opcode === 2) {
      if (payload.length > 307200) throw new Error('JPEG exceeds 300 KiB');
      if (payload.length < 4 || payload.readUInt16BE(0) !== 0xffd8 || payload.readUInt16BE(payload.length - 2) !== 0xffd9) throw new Error('gateway binary payload is not JPEG');
      this.frames.push({ at: Date.now(), bytes: payload.length });
      if (this.frames.length > 3000) this.frames.shift();
      this.emit('frame'); return;
    }
    if (opcode !== 1) throw new Error('unsupported gateway WS opcode');
    const value = JSON.parse(payload.toString('utf8'));
    if (value.type === 'frame') return; // 不保留画面、base64 或帧正文。
    if (['ready', 'control'].includes(value.type)) {
      if (Number.isSafeInteger(value.controlEpoch)) this.controlEpoch = value.controlEpoch;
      this.readOnly = value.readOnly; this.sessionId = value.sessionId || this.sessionId;
    }
    this.events.push({ sequence: ++this.sequence, value });
    if (this.events.length > 256) this.events.shift();
    this.emit('message');
  }
  send(value) { if (this.closed) throw this.failure || new Error('gateway WS is closed'); this.socket.write(maskedFrame(1, JSON.stringify(value))); }
  next(predicate, { after = 0, timeoutMs = 12000 } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => { clearTimeout(timer); this.off('message', inspect); this.off('ended', ended); error ? reject(error) : resolve(value); };
      const inspect = () => {
        const index = this.events.findIndex(event => event.sequence > after && predicate(event.value));
        if (index >= 0) finish(null, this.events.splice(index, 1)[0].value);
      };
      const ended = () => finish(this.failure || new Error('gateway WS ended before response'));
      timer = setTimeout(() => finish(new Error('gateway WS response timeout')), timeoutMs);
      this.on('message', inspect); this.on('ended', ended); inspect();
      if (this.closed) ended();
    });
  }
  async request(value, predicate) {
    const after = this.sequence; this.send(value);
    const reply = await this.next(event => event.type === 'error' || predicate(event), { after });
    if (reply.type === 'error') throw Object.assign(new Error(reply.message || reply.code), { code: reply.code, status: reply.status });
    return reply;
  }
  async close() {
    if (this.closed) return;
    const done = new Promise(resolve => { const timer = setTimeout(() => { this.socket.destroy(); resolve(); }, 3000); this.socket.once('close', () => { clearTimeout(timer); resolve(); }); });
    this.send({ type: 'close' }); this.socket.end(maskedFrame(8, Buffer.from([0x03, 0xe8])));
    await done;
  }
}

export async function openGatewayDesktop({ gatewayUrl, apiKey, agentId, botId, mode = 'control', taskId }) {
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/') throw new Error('verification requires an HTTPS gateway origin');
  const began = Date.now();
  const issued = await fetch(new URL('IssuePersonalAssistantDesktopTicket', gateway), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ AgentId: agentId, BotId: botId, Mode: mode }),
  });
  const result = await issued.json();
  if (!issued.ok || result.Code !== 0) throw Object.assign(new Error(`gateway ticket refused: HTTP ${issued.status}; ${String(result.Message || 'unknown').slice(0, 200)}`), { status: issued.status });
  const data = result.Data;
  // Server's public ticket contract is an integer Unix timestamp in seconds.
  // Do not accept date strings or milliseconds: either can mask a bad fixture.
  const expiresAt = Number.isSafeInteger(data?.ExpiresAt) ? data.ExpiresAt * 1000 : NaN;
  if (!/^[A-Za-z0-9_-]{32,512}$/u.test(data?.Ticket || '') || data.WsPath !== 'personal-assistant/desktop/ws' || data.AgentId !== agentId || data.BotId !== botId
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 60000) throw new Error('gateway ticket binding is invalid');
  const url = new URL(data.WsPath, gateway), key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  const openedAt = Date.now();
  const client = await new Promise((resolve, reject) => {
    const request = https.request(url, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key,
      'sec-websocket-protocol': `${PROTOCOL}, agentkit.desktop.ticket.${data.Ticket}` }, timeout: 10000 });
    request.on('upgrade', (response, socket, head) => {
      if (response.headers['sec-websocket-accept'] !== expected || response.headers['sec-websocket-protocol'] !== PROTOCOL) { socket.destroy(); reject(new Error('gateway WS handshake identity is invalid')); return; }
      const value = new GatewayDesktopClient(socket, { openedAt });
      if (head.length) value.parse(head);
      resolve(value);
    });
    request.on('response', response => { response.resume(); reject(Object.assign(new Error(`gateway WS upgrade refused: HTTP ${response.statusCode}`), { status: response.statusCode })); });
    request.on('timeout', () => request.destroy(new Error('gateway WS upgrade timeout')));
    request.on('error', reject); request.end();
  });
  client.ticketMs = openedAt - began; client.handshakeMs = Date.now() - openedAt;
  const ready = await client.request({ type: 'open', botId, taskId, mode: mode === 'read' ? 'read' : 'observe' }, value => value.type === 'ready');
  return { client, ready };
}
