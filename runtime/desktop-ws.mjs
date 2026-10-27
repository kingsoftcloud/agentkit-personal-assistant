/** Minimal authenticated WebSocket bridge for the Studio desktop view. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyDesktopPermit, desktopUnauthorized as unauthorized } from './desktop-permit.mjs';
// 云端桌面的剪贴板上限与 computer 容器保持一致；这里不导入 desktop-session.mjs，
// 因为该模块只打进 computer 产物，runtime 镜像里不存在（导入会让插件启动失败）。
import { DESKTOP_CLIPBOARD_MAX_BYTES } from './desktop-clipboard-limit.mjs';
import { DIRECTORY_BOT_ID, publicBotDirectory } from '../src/client/bot-directory.mjs';

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
export const CLOUD_SESSION_MAX_PENDING_BYTES = 1024 * 1024;

function createBoundedSocketWriter(socket, maxPendingBytes) {
  let blocked = false;
  const drain = () => { blocked = false; };
  socket.on('drain', drain);
  return {
    get ready() { return !socket.destroyed && !blocked && socket.writableLength < maxPendingBytes; },
    write(packet) {
      if (socket.destroyed) return false;
      if (socket.writableLength + packet.length > maxPendingBytes) { socket.destroy(); return false; }
      if (!socket.write(packet)) blocked = true;
      return true;
    },
    dispose() { socket.off('drain', drain); },
  };
}
/** 慢桌面客户端最多保留两帧；等待 drain 时跳帧，不建立帧队列。 */
export const createDesktopSocketWriter = socket => createBoundedSocketWriter(socket, DESKTOP_MAX_PENDING_BYTES);
/** 独立会话连接容纳一个 512 KiB 文件的 base64 响应；仍有固定内存上限。 */
export const createCloudSessionSocketWriter = socket => createBoundedSocketWriter(socket, CLOUD_SESSION_MAX_PENDING_BYTES);
export { verifyDesktopPermit } from './desktop-permit.mjs';
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

export function attachDesktopWebSocket({ server, runtimeToken, assistantId, brokerDesktopRequest, brokerDesktopFrameBinary, botIdOf, taskIdOf, listBots, sessionRequest, env = process.env }) {
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
    const state = { buffer: Buffer.alloc(0), sessionId: null, botId: null, taskId: null, leaseId: null, autoLease: false, closed: false, paused: false, idle: false, idleTimer: null, idleTransition: null, suspendSupported: false, epoch: 0, lastInputAt: Date.now(), lastFrameSeq: -1, timer: null, renewTimer: null, frameBusy: false, pending: Promise.resolve(), pendingMessages: 0 };
    const writer = createDesktopSocketWriter(socket);
    let sessionWriter;
    const send = value => { if (!state.closed) (value.type === 'session.response' ? sessionWriter || writer : writer).write(jsonFrame(value)); };
    const releaseResources = async () => {
      const sessionId = state.sessionId, leaseId = state.autoLease ? state.leaseId : null;
      state.sessionId = null; state.autoLease = false; state.leaseId = null;
      // 独立发起清理，避免一个失联的 close 请求挡住租约释放。
      await Promise.allSettled([
        ...(sessionId ? [Promise.resolve().then(() => brokerDesktopRequest('/broker/desktop/close', { sessionId, botId: state.botId, taskId: state.taskId }))] : []),
        ...(leaseId && !state.handoff ? [Promise.resolve().then(() => brokerDesktopRequest('/broker/lease/release', { botId: state.botId, taskId: state.taskId, leaseId }))] : []),
      ]);
    };
    const close = async ({ event, closeCode = 1000 } = {}) => {
      if (state.closed) return releaseResources();
      if (event) send({ type: 'closed', retryable: false, ...event });
      state.closed = true; state.epoch++; clearTimeout(state.timer); clearInterval(state.renewTimer); clearTimeout(state.idleTimer);
      state.timer = null; state.renewTimer = null; writer.dispose(); sessionWriter?.dispose();
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
    const armIdle = () => {
      clearTimeout(state.idleTimer);
      if (!state.suspendSupported || state.closed || state.idle || state.requestedMode === 'read' || state.handoff) return;
      state.idleTimer = setTimeout(() => {
        state.pending = state.pending.then(() => suspend(false)).catch(error => fail(error, 'DESKTOP_IDLE_FAILED'));
      }, Math.max(0, state.idleTimeoutMs - (Date.now() - state.lastInputAt)));
      state.idleTimer.unref?.();
    };
    const startRenewal = () => {
      clearInterval(state.renewTimer);
      if (!state.autoLease || state.idle || state.closed) return;
      const leaseId = state.leaseId, epoch = state.epoch;
      state.renewTimer = setInterval(() => {
        if (state.closed || state.idle || state.epoch !== epoch) return;
        if (state.handoff && Date.now() - state.lastInputAt >= state.idleTimeoutMs) {
          state.pending = state.pending.then(async () => {
            if (!state.leaseId || state.closed) return;
            const changed = await brokerDesktopRequest('/broker/desktop/control/release', { sessionId: state.sessionId, botId: state.botId, taskId: state.taskId, leaseId: state.leaseId, controlEpoch: state.controlEpoch });
            applyControl(changed);
          }).catch(error => fail(error, 'DESKTOP_CONTROL_RELEASE_FAILED'));
          return;
        }
        void brokerDesktopRequest('/broker/lease/renew', { botId: state.botId, taskId: state.taskId, leaseId, ttlMs: 120000 }).catch(async error => {
          if (state.closed || state.idle || state.epoch !== epoch) return;
          if (state.handoff && Number(error?.status) === 409) {
            try { await syncControl(); } catch (syncError) { await fail(syncError, 'DESKTOP_CONTROL_SYNC_FAILED'); }
            return;
          }
          await fail(error, 'COMPUTER_LEASE_RENEW_FAILED');
          if (!state.closed) await close({ event: { reason: 'broker-unavailable', code: error?.code || 'COMPUTER_LEASE_RENEW_FAILED', status: error?.status || 503, retryable: true }, closeCode: 1011 });
        });
      }, 30_000);
      state.renewTimer.unref?.();
    };
    const applyControl = changed => {
      state.controlEpoch = changed.controlEpoch; state.leaseId = changed.readOnly ? null : changed.lease?.leaseId || state.leaseId;
      state.autoLease = !changed.readOnly; state.epoch++; state.lastInputAt = Date.now(); startRenewal();
      send({ type: 'control', ...changed, lease: undefined, protocol: PROTOCOL });
    };
    const syncControl = async () => {
      const changed = await brokerDesktopRequest('/broker/desktop/control/state', { sessionId: state.sessionId, botId: state.botId, taskId: state.taskId });
      if (!state.closed) applyControl(changed);
    };
    const suspend = async fromBroker => {
      if (state.closed || state.idle || !state.sessionId || !state.suspendSupported) return;
      if (!fromBroker && Date.now() - state.lastInputAt < state.idleTimeoutMs) { armIdle(); return; }
      state.idle = true; state.epoch++;
      clearTimeout(state.timer); clearTimeout(state.idleTimer); clearInterval(state.renewTimer);
      state.timer = null; state.renewTimer = null;
      state.idleTransition = (async () => {
        await brokerDesktopRequest('/broker/desktop/idle', { sessionId: state.sessionId, botId: state.botId, taskId: state.taskId, leaseId: state.leaseId });
        if (state.autoLease && state.leaseId) await brokerDesktopRequest('/broker/lease/release', { botId: state.botId, taskId: state.taskId, leaseId: state.leaseId });
        state.autoLease = false; state.leaseId = state.externalLeaseId || null;
        if (!state.closed) send({ type: 'idle', sessionId: state.sessionId, reason: 'idle-timeout', leaseReleased: !state.externalLeaseId, protocol: PROTOCOL });
      })();
      try { await state.idleTransition; } finally { state.idleTransition = null; }
    };
    const activate = opened => {
      state.idle = false; state.epoch++; state.lastInputAt = Date.now(); state.lastFrameSeq = -1;
      state.controlEpoch = opened.controlEpoch ?? 0;
      state.suspendSupported = opened.idleMode === 'suspend'; state.idleTimeoutMs = Math.max(1000, Number(opened.idleTimeoutMs) || 600000);
      startRenewal(); armIdle();
      send({ type: 'ready', ...opened, protocol: PROTOCOL }); void poll();
    };
    const poll = async () => {
      if (state.closed || state.idle || state.paused || !state.sessionId || state.frameBusy) return;
      if (!writer.ready) { state.timer = setTimeout(poll, 80); return; }
      state.frameBusy = true;
      const epoch = state.epoch;
      const startedAt = Date.now();
      let nextFrameDelayMs = Date.now() - state.lastInputAt < 10_000 ? 80 : 1000;
      try {
        if (typeof brokerDesktopFrameBinary !== 'function') throw Object.assign(new Error('binary desktop broker is unavailable'), { code: 'DESKTOP_BINARY_BROKER_REQUIRED' });
        const result = await brokerDesktopFrameBinary({ sessionId: state.sessionId, afterSeq: state.lastFrameSeq });
        if (state.closed || state.idle || state.epoch !== epoch) return;
        if (Number.isFinite(result.nextFrameDelayMs)) nextFrameDelayMs = Math.max(50, Math.min(1000, result.nextFrameDelayMs));
        if (!result.unchanged && result.data) {
          const metadata = { type: 'frame', seq: result.seq, format: result.format, width: result.width, height: result.height, bytes: result.bytes };
          if (!Buffer.isBuffer(result.data)) throw Object.assign(new Error('desktop broker did not return binary data'), { code: 'DESKTOP_BINARY_FRAME_REQUIRED' });
          const bytes = result.data;
          if (bytes.length > maxFrame) throw Object.assign(new Error('desktop frame too large'), { code: 'DESKTOP_FRAME_TOO_LARGE' });
          // 元数据和 JPEG 一起写，回压期间不会只发送半对消息。
          if (!state.closed && writer.ready && writer.write(Buffer.concat([jsonFrame(metadata), frame(2, bytes)]))) state.lastFrameSeq = result.seq;
        } else send({ type: 'frame', seq: result.seq, unchanged: true, width: result.width, height: result.height });
      } catch (error) {
        if (!state.closed && state.epoch === epoch) {
          if (state.suspendSupported && error?.code === 'DESKTOP_SESSION_IDLE') {
            try { await suspend(true); } catch (idleError) { await fail(idleError, 'DESKTOP_IDLE_FAILED'); }
          }
          else await fail(error, 'DESKTOP_FRAME_FAILED');
        }
      }
      finally {
        state.frameBusy = false;
        if (!state.closed && !state.idle && !state.paused) state.timer = setTimeout(poll, Math.max(0, nextFrameDelayMs - (Date.now() - startedAt)));
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
        if (body.type === 'session.request') {
          // control 票据授权交互执行；目录/只读桌面票据不能读取会话或提交回合。
          // 不打开桌面、不申请电脑租约；真实云端工具执行时独立获取租约。
          if (claims && (claims.mode !== 'control' || claims.botId === DIRECTORY_BOT_ID)) throw Object.assign(new Error('会话执行需要具名助理控制授权'), { code: 'CLOUD_SESSION_CONTROL_REQUIRED', status: 403 });
          if (!/^[A-Za-z0-9_-]{1,80}$/u.test(String(body.requestId || ''))) throw Object.assign(new Error('会话请求标识无效'), { code: 'CLOUD_SESSION_REQUEST_INVALID', status: 400 });
          if (body.agentId !== assistantId || (claims && body.botId !== claims.botId)) throw Object.assign(new Error('会话身份与票据不一致'), { code: 'CLOUD_SESSION_IDENTITY_MISMATCH', status: 403 });
          if (state.sessionId) throw Object.assign(new Error('会话与桌面需要独立连接'), { code: 'CLOUD_SESSION_CONNECTION_CONFLICT', status: 409 });
          if (typeof sessionRequest !== 'function') throw Object.assign(new Error('请升级云端会话服务'), { code: 'CLOUD_SESSION_UNAVAILABLE', status: 503 });
          sessionWriter ??= createCloudSessionSocketWriter(socket);
          try {
            const value = await sessionRequest({ agentId: assistantId, botId: botIdOf(body.botId), operation: body.operation, payload: body.payload });
            send({ type: 'session.response', requestId: body.requestId, agentId: assistantId, botId: body.botId, ok: true, value });
          } catch (error) {
            send({ type: 'session.response', requestId: body.requestId, agentId: assistantId, botId: body.botId, ok: false, error: { code: error.code || 'CLOUD_SESSION_FAILED', message: error.status ? error.message : '云端会话请求失败', status: error.status || 503 } });
          }
          return;
        }
        if (body.type === 'bots.list') {
          if (claims && (claims.mode !== 'read' || claims.botId !== DIRECTORY_BOT_ID)) throw Object.assign(new Error('助理目录需要独立只读授权'), { code: 'DESKTOP_DIRECTORY_SCOPE_REQUIRED', status: 403 });
          if (state.sessionId || typeof listBots !== 'function') throw Object.assign(new Error('助理目录暂不可用'), { code: 'DESKTOP_DIRECTORY_UNAVAILABLE', status: 503 });
          send({ type: 'bots', bots: publicBotDirectory(await listBots()), features: ['desktop-handoff/v1'] });
          return close();
        }
        if (body.type === 'open') {
          if (sessionWriter) throw Object.assign(new Error('会话与桌面需要独立连接'), { code: 'CLOUD_SESSION_CONNECTION_CONFLICT', status: 409 });
          if (claims?.botId === DIRECTORY_BOT_ID) throw Object.assign(new Error('目录授权不能打开桌面'), { code: 'DESKTOP_DIRECTORY_READ_ONLY', status: 403 });
          if (state.sessionId) throw Object.assign(new Error('desktop session already open'), { code: 'DESKTOP_SESSION_ALREADY_OPEN', status: 409 });
          if (claims && body.botId !== claims.botId) throw Object.assign(new Error('desktop Bot does not match permit'), { code: 'DESKTOP_BOT_MISMATCH', status: 403 });
          if (claims?.mode === 'control' && body.mode !== 'observe') throw Object.assign(new Error('请更新客户端，通过旁观会话接管云电脑'), { code: 'DESKTOP_HANDOFF_REQUIRED', status: 403 });
          if (claims?.mode === 'read' && (['control', 'observe'].includes(body.mode) || body.leaseId)) throw Object.assign(new Error('desktop permit is read-only'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
          if (body.mode === 'observe' && (!claims || claims.mode !== 'control')) throw Object.assign(new Error('无签名控制授权不能启用桌面接管'), { code: 'DESKTOP_CONTROL_GRANT_REQUIRED', status: 403 });
          if (claims && body.leaseId && body.leaseId !== claims.leaseId) throw Object.assign(new Error('desktop lease does not match permit'), { code: 'DESKTOP_LEASE_MISMATCH', status: 403 });
          state.botId = botIdOf(body.botId); state.taskId = taskIdOf(body.taskId); state.leaseId = body.leaseId || null;
          state.handoff = body.mode === 'observe';
          state.externalLeaseId = state.leaseId; state.requestedMode = state.handoff ? 'observe' : (claims ? claims.mode : body.mode) === 'control' ? 'control' : 'read';
          brokerStarted = true;
          if (!state.handoff && (claims ? claims.mode : body.mode) === 'control' && !state.leaseId) {
            const acquired = await brokerDesktopRequest('/broker/lease/acquire', { botId: state.botId, taskId: state.taskId, idempotencyKey: `desktop-ws:${state.botId}:${state.taskId}:${Date.now()}`, ttlMs: 120000 });
            state.leaseId = acquired.lease?.leaseId || null; state.autoLease = true;
            if (state.closed) return releaseResources();
          }
          const opened = await brokerDesktopRequest('/broker/desktop/session', { botId: state.botId, taskId: state.taskId, leaseId: state.leaseId || undefined, releaseLeaseOnIdle: state.autoLease,
            ...(state.handoff ? { mode: 'observe', controlPermit: String(request.headers['x-agentengine-desktop-permit'] || '') } : {}) });
          state.sessionId = opened.sessionId;
          if (state.closed) return releaseResources();
          activate(opened); return;
        }
        if (body.type === 'control.acquire' || body.type === 'control.release') {
          if (!state.sessionId || !state.handoff || claims?.mode !== 'control' || claims.botId === DIRECTORY_BOT_ID) throw Object.assign(new Error('当前授权只允许旁观'), { code: 'DESKTOP_CONTROL_GRANT_REQUIRED', status: 403 });
          if (!Number.isSafeInteger(body.controlEpoch) || body.controlEpoch !== state.controlEpoch) throw Object.assign(new Error('控制权状态已更新，请重新操作'), { code: 'DESKTOP_CONTROL_EPOCH_CHANGED', status: 409 });
          const sessionId = state.sessionId;
          const changed = await brokerDesktopRequest(`/broker/desktop/control/${body.type === 'control.acquire' ? 'acquire' : 'release'}`, { sessionId, botId: state.botId, taskId: state.taskId, leaseId: state.leaseId, controlEpoch: body.controlEpoch });
          if (state.closed) { await brokerDesktopRequest('/broker/desktop/close', { sessionId, botId: state.botId, taskId: state.taskId }); return; }
          applyControl(changed);
          return;
        }
        if (body.type === 'input') {
          if (claims?.mode === 'read') throw Object.assign(new Error('只读授权不能发送输入'), { code: 'DESKTOP_READ_ONLY', status: 403 });
          if (!state.sessionId) throw Object.assign(new Error('desktop session is not open'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
          if (state.idle) { send({ type: 'error', status: 409, code: 'DESKTOP_SESSION_IDLE', recoverable: true, message: '桌面已空闲，请先恢复连接' }); return; }
          if (state.handoff && (!state.leaseId || body.controlEpoch !== state.controlEpoch)) throw Object.assign(new Error('输入未持有当前控制权'), { code: 'DESKTOP_CONTROL_EPOCH_CHANGED', status: 409 });
          brokerStarted = true;
          const accepted = await brokerDesktopRequest('/broker/desktop/input', { sessionId: state.sessionId, botId: state.botId, taskId: state.taskId, leaseId: state.leaseId, controlEpoch: state.controlEpoch, event: body.event });
          if (state.closed) return;
          state.lastInputAt = Date.now(); armIdle();
          if (state.timer) clearTimeout(state.timer);
          if (!state.frameBusy) state.timer = setTimeout(poll, 0);
          send({ type: 'input-accepted', ...accepted }); return;
        }
        if (body.type === 'clipboard.read' || body.type === 'clipboard.write') {
          // 面板与云电脑之间只有这条 WS 是活通道；剪贴板复用 agentd 的
          // /broker/action，不在这里重新实现 X11 读写。
          const requestId = String(body.requestId || '');
          // 非法标识无法安全回显，直接回通用错误帧；合法标识的错误统一走
          // clipboard.response，客户端只按 requestId 关联。
          if (!/^[A-Za-z0-9_-]{1,80}$/u.test(requestId)) { send({ type: 'error', status: 400, code: 'CLIPBOARD_REQUEST_INVALID', message: '剪贴板请求标识无效' }); return; }
          try {
            if (claims?.mode === 'read') throw Object.assign(new Error('只读授权不能读写剪贴板'), { code: 'DESKTOP_READ_ONLY', status: 403 });
            if (!state.sessionId) throw Object.assign(new Error('desktop session is not open'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
            if (state.idle) throw Object.assign(new Error('桌面已空闲，请先恢复连接'), { code: 'DESKTOP_SESSION_IDLE', status: 409 });
            if (state.handoff && (!state.leaseId || body.controlEpoch !== state.controlEpoch)) throw Object.assign(new Error('剪贴板未持有当前控制权'), { code: 'DESKTOP_CONTROL_EPOCH_CHANGED', status: 409 });
            if (body.type === 'clipboard.write' && typeof body.text !== 'string') throw Object.assign(new Error('剪贴板文本必须是字符串'), { code: 'CLIPBOARD_TEXT_INVALID', status: 400 });
            if (body.type === 'clipboard.write' && Buffer.byteLength(body.text, 'utf8') > DESKTOP_CLIPBOARD_MAX_BYTES) throw Object.assign(new Error('剪贴板文本不能超过 64 KiB'), { code: 'CLIPBOARD_TEXT_TOO_LARGE', status: 413 });
            brokerStarted = true;
            const value = await brokerDesktopRequest('/broker/action', { botId: state.botId, taskId: state.taskId, leaseId: state.leaseId, action: body.type, args: body.type === 'clipboard.write' ? { text: body.text } : {} });
            if (state.closed) return;
            send({ type: 'clipboard.response', requestId, ok: true, value });
            return;
          } catch (error) {
            if (state.closed) return;
            // 控制权在操作期间变化时同步一次 epoch，客户端下一帧即可重试。
            if (state.handoff && Number(error?.status) === 409) { try { await syncControl(); } catch {} }
            send({ type: 'clipboard.response', requestId, ok: false, error: { code: error?.code || 'CLIPBOARD_FAILED', message: error?.status ? String(error?.message || '剪贴板请求失败') : '云端剪贴板请求失败', status: error?.status || 400 } });
            return;
          }
        }
        if (body.type === 'close') return close();
        if (body.type === 'pause') { state.paused = true; if (state.timer) clearTimeout(state.timer); return; }
        if (body.type === 'resume') {
          if (claims?.mode === 'read' && body.mode === 'control') throw Object.assign(new Error('desktop permit is read-only'), { code: 'DESKTOP_READ_ONLY', status: 403 });
          state.paused = false;
          if (!state.idle) { void poll(); return; }
          if (body.activity !== true) return;
          await state.idleTransition;
          if (state.closed) return;
          let mode = body.mode || state.requestedMode;
          if (!['read', 'control'].includes(mode) || (claims?.mode === 'read' && mode === 'control')) throw Object.assign(new Error('desktop permit is read-only'), { code: 'DESKTOP_READ_ONLY', status: 403 });
          brokerStarted = true;
          if (mode === 'control' && !state.leaseId) {
            try {
              const acquired = await brokerDesktopRequest('/broker/lease/acquire', { botId: state.botId, taskId: state.taskId, idempotencyKey: `desktop-resume:${state.botId}:${state.taskId}:${Date.now()}`, ttlMs: 120000 });
              state.leaseId = acquired.lease?.leaseId || null; state.autoLease = true;
              if (state.closed) return releaseResources();
            } catch (error) {
              if (Number(error?.status) !== 409) throw error;
              mode = 'read'; send({ type: 'error', status: 409, code: error.code || 'COMPUTER_LEASE_CONFLICT', recoverable: true, message: '其他助理正在使用云电脑，已恢复为只读旁观' });
            }
          }
          const opened = await brokerDesktopRequest('/broker/desktop/resume', { sessionId: state.sessionId, botId: state.botId, taskId: state.taskId, leaseId: mode === 'control' ? state.leaseId || undefined : undefined, releaseLeaseOnIdle: mode === 'control' && state.autoLease });
          if (state.closed) return releaseResources();
          state.requestedMode = mode; activate(opened); return;
        }
        send({ type: 'error', code: 'DESKTOP_MESSAGE_UNSUPPORTED' });
      } catch (error) {
        if (state.handoff && (String(body.type).startsWith('control.') || body.type === 'input')) {
          if (Number(error.status) === 409) { try { await syncControl(); } catch {} }
          send({ type: 'error', status: error.status || 400, code: error.code || 'DESKTOP_CONTROL_FAILED', recoverable: true, readOnly: !state.leaseId, controlEpoch: state.controlEpoch, message: error.message || '控制权暂不可用，仍可继续旁观' });
          return;
        }
        if (body.type === 'resume' && state.idle && state.autoLease && state.leaseId) {
          try {
            await brokerDesktopRequest('/broker/lease/release', { botId: state.botId, taskId: state.taskId, leaseId: state.leaseId });
            state.autoLease = false; state.leaseId = state.externalLeaseId || null;
          } catch { await close({ event: { reason: 'resume-cleanup-failed', status: 503 }, closeCode: 1011 }); return; }
        }
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
