/** Minimal authenticated WebSocket bridge for the Studio desktop view. */
import { createHash } from 'node:crypto';

const PROTOCOL = 'agentkit.personal-assistant.desktop.v1';
const maxFrame = 300 * 1024;
const frame = (opcode, payload = Buffer.alloc(0)) => {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = data.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), data]);
  if (length < 65536) { const h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(length, 2); return Buffer.concat([h, data]); }
  const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(length), 2); return Buffer.concat([h, data]);
};
const accept = key => createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
const jsonFrame = value => frame(1, JSON.stringify(value));

function parseFrames(state, chunk, onFrame) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0]; const second = state.buffer[1]; const masked = Boolean(second & 0x80); let length = second & 0x7f; let offset = 2;
    if (length === 126) { if (state.buffer.length < 4) return; length = state.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (state.buffer.length < 10) return; const value = state.buffer.readBigUInt64BE(2); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large'); length = Number(value); offset = 10; }
    if (!masked || length > 1024 * 1024) throw new Error('invalid client frame');
    if (state.buffer.length < offset + 4 + length) return;
    const key = state.buffer.subarray(offset, offset + 4); offset += 4;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + length)); state.buffer = state.buffer.subarray(offset + length);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= key[i % 4];
    onFrame(first & 0x0f, payload);
  }
}

export function attachDesktopWebSocket({ server, runtimeToken, brokerDesktopRequest, botIdOf, taskIdOf }) {
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url || '/', 'http://desktop.local').pathname !== '/v1/computer/desktop/ws') { socket.destroy(); return; }
    const authorization = String(request.headers.authorization || '');
    if (!runtimeToken || authorization !== `Bearer ${runtimeToken}`) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    const requested = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
    const protocol = requested.find(value => value === PROTOCOL) || PROTOCOL;
    const key = request.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`);
    if (head?.length) socket.unshift(head);
    const state = { buffer: Buffer.alloc(0), sessionId: null, botId: null, taskId: null, leaseId: null, closed: false, lastInputAt: Date.now(), timer: null, frameBusy: false };
    const send = value => { if (!state.closed) socket.write(jsonFrame(value)); };
    const close = async () => {
      if (state.closed) return; state.closed = true; if (state.timer) clearTimeout(state.timer);
      if (state.sessionId) await brokerDesktopRequest('/broker/desktop/close', { sessionId: state.sessionId }).catch(() => {});
      try { socket.end(frame(8)); } catch {}
    };
    const poll = async () => {
      if (state.closed || !state.sessionId || state.frameBusy) return;
      state.frameBusy = true;
      try {
        const result = await brokerDesktopRequest('/broker/desktop/frame', { sessionId: state.sessionId });
        if (!result.unchanged && result.data) {
          const metadata = { type: 'frame', seq: result.seq, format: result.format, width: result.width, height: result.height, bytes: result.bytes };
          send(metadata);
          const bytes = Buffer.from(result.data, 'base64');
          if (bytes.length > maxFrame) throw Object.assign(new Error('desktop frame too large'), { code: 'DESKTOP_FRAME_TOO_LARGE' });
          if (!state.closed) socket.write(frame(2, bytes));
        } else send({ type: 'frame', seq: result.seq, unchanged: true, width: result.width, height: result.height });
      } catch (error) { send({ type: 'error', code: error?.code || 'DESKTOP_FRAME_FAILED', message: String(error?.message || 'desktop frame failed') }); }
      finally {
        state.frameBusy = false;
        if (!state.closed) { const active = Date.now() - state.lastInputAt < 1000; state.timer = setTimeout(poll, active ? 100 : 1000); }
      }
    };
    const onMessage = async (opcode, payload) => {
      if (opcode === 8) return close();
      if (opcode === 9) { socket.write(frame(10, payload)); return; }
      if (opcode !== 1) return;
      let body; try { body = JSON.parse(payload.toString('utf8')); } catch { send({ type: 'error', code: 'INVALID_JSON' }); return; }
      try {
        if (body.type === 'open') {
          state.botId = botIdOf(body.botId); state.taskId = taskIdOf(body.taskId); state.leaseId = body.leaseId || null;
          const opened = await brokerDesktopRequest('/broker/desktop/session', { botId: state.botId, taskId: state.taskId, leaseId: state.leaseId || undefined });
          state.sessionId = opened.sessionId; send({ type: 'ready', ...opened, protocol: PROTOCOL }); poll(); return;
        }
        if (body.type === 'input') {
          if (!state.sessionId) throw Object.assign(new Error('desktop session is not open'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
          state.lastInputAt = Date.now();
          const accepted = await brokerDesktopRequest('/broker/desktop/input', { sessionId: state.sessionId, botId: state.botId, taskId: state.taskId, leaseId: state.leaseId, event: body.event });
          send({ type: 'input-accepted', ...accepted }); return;
        }
        if (body.type === 'close') return close();
        send({ type: 'error', code: 'DESKTOP_MESSAGE_UNSUPPORTED' });
      } catch (error) { send({ type: 'error', status: error?.status || 400, code: error?.code || 'DESKTOP_REQUEST_FAILED', message: String(error?.message || 'desktop request failed') }); }
    };
    socket.on('data', chunk => { try { parseFrames(state, chunk, onMessage); } catch { close(); } });
    socket.on('close', close); socket.on('error', close);
  });
}
