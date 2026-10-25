/** Minimal authenticated WebSocket bridge for the Studio desktop view. */
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

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
export const DESKTOP_MAX_PENDING_BYTES = 2 * (maxFrame + 1024);

/** 慢客户端最多保留两帧大小；等待 drain 时跳帧，不建立帧队列。 */
export function createDesktopSocketWriter(socket) {
  let blocked = false;
  const drain = () => { blocked = false; };
  socket.on('drain', drain);
  return {
    get ready() { return !socket.destroyed && !blocked && socket.writableLength < DESKTOP_MAX_PENDING_BYTES; },
    write(packet) {
      if (socket.destroyed) return false;
      if (socket.writableLength + packet.length > DESKTOP_MAX_PENDING_BYTES) { socket.destroy(); return false; }
      if (!socket.write(packet)) blocked = true;
      return true;
    },
    dispose() { socket.off('drain', drain); },
  };
}
const unauthorized = message => Object.assign(new Error(message), { status: 401, code: 'DESKTOP_UNAUTHORIZED' });
const permitKeys = new Map();

async function desktopJwks(env) {
  if (env.AGENTKIT_DESKTOP_JWKS_JSON) return JSON.parse(env.AGENTKIT_DESKTOP_JWKS_JSON);
  const source = String(env.AGENTKIT_DESKTOP_JWKS_URL || '');
  if (!source) throw unauthorized('desktop verification keys are not configured');
  const url = new URL(source);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.AGENTKIT_DESKTOP_ALLOW_HTTP_JWKS === '1'))) throw unauthorized('desktop JWKS URL is not trusted');
  const cached = permitKeys.get(source);
  if (cached && cached.expires > Date.now()) return cached.value;
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw unauthorized('desktop verification keys unavailable');
  const raw = await response.text();
  if (raw.length > 64 * 1024) throw unauthorized('desktop verification keys exceed limit');
  const value = JSON.parse(raw);
  permitKeys.set(source, { value, expires: Date.now() + 60_000 });
  return value;
}

/** 验证既有 Server workload 密钥签发的 JWS；不信任 caller 自带身份头。 */
export async function verifyDesktopPermit(token, { assistantId, env = process.env, now = () => Date.now() } = {}) {
  try {
    if (typeof token !== 'string' || token.length > 16 * 1024) throw unauthorized('desktop permit is missing');
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some(value => !/^[A-Za-z0-9_-]+$/u.test(value))) throw unauthorized('desktop permit is malformed');
    const header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (header.alg !== 'EdDSA' || header.typ !== 'agentkit-desktop+jwt' || !header.kid) throw unauthorized('desktop permit algorithm is invalid');
    const jwks = await desktopJwks(env);
    const key = jwks?.keys?.find(value => value.kid === header.kid && value.kty === 'OKP' && value.crv === 'Ed25519');
    if (!key || !verify(null, Buffer.from(`${segments[0]}.${segments[1]}`, 'ascii'), createPublicKey({ key, format: 'jwk' }), Buffer.from(segments[2], 'base64url'))) throw unauthorized('desktop permit signature is invalid');
    const seconds = Math.floor(now() / 1000);
    if (claims.iss !== 'agentengine-server' || claims.aud !== 'agentkit-personal-assistant-desktop' || claims.scope !== 'desktop' || claims.agentId !== assistantId || !claims.botId || !claims.jti || !['read', 'control'].includes(claims.mode)) throw unauthorized('desktop permit binding is invalid');
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > seconds || claims.exp <= seconds || claims.exp - claims.iat > 60) throw unauthorized('desktop permit expired');
    return Object.freeze(claims);
  } catch (error) { throw error?.status === 401 ? error : unauthorized('desktop permit could not be verified'); }
}

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const equalToken = (left, right) => {
  const first = Buffer.from(left), second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
};

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

export function attachDesktopWebSocket({ server, runtimeToken, assistantId, brokerDesktopRequest, brokerDesktopFrameBinary, botIdOf, taskIdOf, env = process.env }) {
  const usedPermits = new Map();
  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://desktop.local');
    const pathname = url.pathname;
    if (!['/v1/desktop/ws', '/v1/computer/desktop/ws'].includes(pathname)) { socket.destroy(); return; }
    if (url.search) { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    const authorization = String(request.headers.authorization || '');
    const direct = loopback(request.socket.remoteAddress) && runtimeToken && equalToken(authorization, `Bearer ${runtimeToken}`);
    let claims = null;
    try {
      if (!direct) {
        claims = await verifyDesktopPermit(String(request.headers['x-agentengine-desktop-permit'] || ''), { assistantId, env });
        for (const [nonce, expires] of usedPermits) if (expires <= Date.now()) usedPermits.delete(nonce);
        if (usedPermits.has(claims.jti)) throw unauthorized('desktop permit already used');
        usedPermits.set(claims.jti, claims.exp * 1000);
      }
    } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    const requested = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!requested.includes(PROTOCOL)) { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    const protocol = PROTOCOL;
    const key = request.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`);
    if (head?.length) socket.unshift(head);
    const state = { buffer: Buffer.alloc(0), sessionId: null, botId: null, taskId: null, leaseId: null, autoLease: false, closed: false, paused: false, lastInputAt: Date.now(), lastFrameSeq: -1, timer: null, renewTimer: null, frameBusy: false, pending: Promise.resolve(), pendingMessages: 0 };
    const writer = createDesktopSocketWriter(socket);
    const send = value => { if (!state.closed) writer.write(jsonFrame(value)); };
    const releaseResources = async () => {
      const sessionId = state.sessionId, leaseId = state.autoLease ? state.leaseId : null;
      state.sessionId = null; state.autoLease = false; state.leaseId = null;
      // 独立发起清理，避免一个失联的 close 请求挡住租约释放。
      await Promise.allSettled([
        ...(sessionId ? [Promise.resolve().then(() => brokerDesktopRequest('/broker/desktop/close', { sessionId }))] : []),
        ...(leaseId ? [Promise.resolve().then(() => brokerDesktopRequest('/broker/lease/release', { botId: state.botId, taskId: state.taskId, leaseId }))] : []),
      ]);
    };
    const close = async ({ event, closeCode = 1000 } = {}) => {
      if (state.closed) return releaseResources();
      if (event) send({ type: 'closed', retryable: false, ...event });
      state.closed = true; clearTimeout(state.timer); clearInterval(state.renewTimer);
      state.timer = null; state.renewTimer = null; writer.dispose();
      const payload = Buffer.alloc(2); payload.writeUInt16BE(closeCode);
      try { socket.end(frame(8, Buffer.concat([payload, Buffer.from(event?.reason || 'desktop-closed')]))); } catch {}
      await releaseResources();
    };
    const fail = async (error, fallback) => {
      if (state.closed) return;
      const status = error?.status || 400, code = error?.code || fallback;
      const message = String(error?.message || 'desktop request failed');
      send({ type: 'error', status, code, message });
      if ([404, 409].includes(Number(status))) await close({ event: { status, code, message, reason: Number(status) === 409 ? 'lease-lost' : 'session-ended' } });
    };
    const poll = async () => {
      if (state.closed || state.paused || !state.sessionId || state.frameBusy) return;
      if (!writer.ready) { state.timer = setTimeout(poll, 80); return; }
      state.frameBusy = true;
      const startedAt = Date.now();
      let nextFrameDelayMs = Date.now() - state.lastInputAt < 10_000 ? 80 : 1000;
      try {
        if (typeof brokerDesktopFrameBinary !== 'function') throw Object.assign(new Error('binary desktop broker is unavailable'), { code: 'DESKTOP_BINARY_BROKER_REQUIRED' });
        const result = await brokerDesktopFrameBinary({ sessionId: state.sessionId, afterSeq: state.lastFrameSeq });
        if (Number.isFinite(result.nextFrameDelayMs)) nextFrameDelayMs = Math.max(50, Math.min(1000, result.nextFrameDelayMs));
        if (!result.unchanged && result.data) {
          const metadata = { type: 'frame', seq: result.seq, format: result.format, width: result.width, height: result.height, bytes: result.bytes };
          if (!Buffer.isBuffer(result.data)) throw Object.assign(new Error('desktop broker did not return binary data'), { code: 'DESKTOP_BINARY_FRAME_REQUIRED' });
          const bytes = result.data;
          if (bytes.length > maxFrame) throw Object.assign(new Error('desktop frame too large'), { code: 'DESKTOP_FRAME_TOO_LARGE' });
          // 元数据和 JPEG 一起写，回压期间不会只发送半对消息。
          if (!state.closed && writer.ready && writer.write(Buffer.concat([jsonFrame(metadata), frame(2, bytes)]))) state.lastFrameSeq = result.seq;
        } else send({ type: 'frame', seq: result.seq, unchanged: true, width: result.width, height: result.height });
      } catch (error) { await fail(error, 'DESKTOP_FRAME_FAILED'); }
      finally {
        state.frameBusy = false;
        if (!state.closed && !state.paused) state.timer = setTimeout(poll, Math.max(0, nextFrameDelayMs - (Date.now() - startedAt)));
      }
    };
    const onMessage = async (opcode, payload) => {
      if (state.closed) return;
      if (opcode === 8) return close();
      if (opcode === 9) { writer.write(frame(10, payload)); return; }
      if (opcode !== 1) return;
      let body; try { body = JSON.parse(payload.toString('utf8')); } catch { send({ type: 'error', code: 'INVALID_JSON' }); return; }
      let brokerStarted = false;
      try {
        if (body.type === 'open') {
          if (state.sessionId) throw Object.assign(new Error('desktop session already open'), { code: 'DESKTOP_SESSION_ALREADY_OPEN', status: 409 });
          if (claims && body.botId !== claims.botId) throw Object.assign(new Error('desktop Bot does not match permit'), { code: 'DESKTOP_BOT_MISMATCH', status: 403 });
          if (claims?.mode === 'read' && (body.mode === 'control' || body.leaseId)) throw Object.assign(new Error('desktop permit is read-only'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
          if (claims && body.leaseId && body.leaseId !== claims.leaseId) throw Object.assign(new Error('desktop lease does not match permit'), { code: 'DESKTOP_LEASE_MISMATCH', status: 403 });
          state.botId = botIdOf(body.botId); state.taskId = taskIdOf(body.taskId); state.leaseId = body.leaseId || null;
          brokerStarted = true;
          if ((claims ? claims.mode : body.mode) === 'control' && !state.leaseId) {
            const acquired = await brokerDesktopRequest('/broker/lease/acquire', { botId: state.botId, taskId: state.taskId, idempotencyKey: `desktop-ws:${state.botId}:${state.taskId}:${Date.now()}`, ttlMs: 120000 });
            state.leaseId = acquired.lease?.leaseId || null; state.autoLease = true;
            if (state.closed) return releaseResources();
          }
          const opened = await brokerDesktopRequest('/broker/desktop/session', { botId: state.botId, taskId: state.taskId, leaseId: state.leaseId || undefined });
          state.sessionId = opened.sessionId;
          if (state.closed) return releaseResources();
          if (state.autoLease) {
            state.renewTimer = setInterval(() => {
              void brokerDesktopRequest('/broker/lease/renew', { botId: state.botId, taskId: state.taskId, leaseId: state.leaseId, ttlMs: 120000 }).catch(async error => {
                await fail(error, 'COMPUTER_LEASE_RENEW_FAILED');
                if (!state.closed) await close({ event: { reason: 'broker-unavailable', code: error?.code || 'COMPUTER_LEASE_RENEW_FAILED', status: error?.status || 503, retryable: true }, closeCode: 1011 });
              });
            }, 30_000);
            state.renewTimer.unref?.();
          }
          send({ type: 'ready', ...opened, protocol: PROTOCOL }); poll(); return;
        }
        if (body.type === 'input') {
          if (!state.sessionId) throw Object.assign(new Error('desktop session is not open'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
          state.lastInputAt = Date.now();
          brokerStarted = true;
          const accepted = await brokerDesktopRequest('/broker/desktop/input', { sessionId: state.sessionId, botId: state.botId, taskId: state.taskId, leaseId: state.leaseId, event: body.event });
          if (state.closed) return;
          if (state.timer) clearTimeout(state.timer);
          if (!state.frameBusy) state.timer = setTimeout(poll, 0);
          send({ type: 'input-accepted', ...accepted }); return;
        }
        if (body.type === 'close') return close();
        if (body.type === 'pause') { state.paused = true; if (state.timer) clearTimeout(state.timer); return; }
        if (body.type === 'resume') { state.paused = false; void poll(); return; }
        send({ type: 'error', code: 'DESKTOP_MESSAGE_UNSUPPORTED' });
      } catch (error) {
        if ((brokerStarted || body.type === 'input') && [404, 409].includes(Number(error?.status))) return fail(error, 'DESKTOP_REQUEST_FAILED');
        if (!state.sessionId && state.autoLease && state.leaseId) {
          await releaseResources();
        }
        send({ type: 'error', status: error?.status || 400, code: error?.code || 'DESKTOP_REQUEST_FAILED', message: String(error?.message || 'desktop request failed') });
      }
    };
    socket.on('data', chunk => { try { parseFrames(state, chunk, (opcode, payload) => {
      if (++state.pendingMessages > 64) { socket.destroy(); void close(); return; }
      state.pending = state.pending.then(() => onMessage(opcode, payload)).catch(() => close()).finally(() => { state.pendingMessages -= 1; });
    }); } catch { close(); } });
    socket.on('close', () => { void close(); }); socket.on('error', () => { void close(); });
  });
}
