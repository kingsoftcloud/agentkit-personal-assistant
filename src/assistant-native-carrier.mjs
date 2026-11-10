/** Receipt-scoped transport for the real DSH Client graph, with public-only projections. */
import { randomUUID } from 'node:crypto';
import { assistantCloudFailure } from './assistant-transport.mjs';
import { projectAssistantNativePage, projectAssistantNativeFollowFrame,
  projectAssistantNativeControlFrame, projectAssistantNativeProjections,
  projectAssistantNativeProjectionBaseline, projectAssistantNativeStatusEvent,
  ASSISTANT_NATIVE_PREVIEW_BYTES } from './assistant-native-projection.mjs';

import { ASSISTANT_NATIVE_REPRESENTATION } from './contracts/assistant-native.mjs';
export { ASSISTANT_NATIVE_REPRESENTATION } from './contracts/assistant-native.mjs';
const PRINCIPAL = 'agentkit-assistant-native';
// list/control require both global RPC admission and the exact Session grant:
// the native Controller filters every returned row using its current action.
const READ_SESSION = ['session/list', 'session/control', 'session/page', 'session/follow', 'session/projections'];
const READ_GLOBAL = ['session/list', 'session/control'];
const CALLS = new Set(['session/list', 'session/projections', 'session/page', 'session/prompt', 'session/cancel', 'fileUploads/upload']);
const STREAMS = new Set(['$events', 'session/control', 'session/follow', 'remoteAccess/follow']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const key = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const fail = (code = 'ASSISTANT_NATIVE_REQUEST_INVALID', status = 400) => Object.assign(new Error('原生助理连接请求无法完成，请刷新后重试'), { code, status });
const safeFailure = error => {
  const safe = assistantCloudFailure(503, { error: { code: error?.code } });
  if (safe.code !== 'ASSISTANT_CLOUD_REQUEST_FAILED') return { code: safe.code, message: safe.message, details: {} };
  return { code: error?.code === 'remote-access/denied' ? 'remote-access/denied' : 'gateway/invocation-unavailable',
    message: '云端助理连接暂不可用，请刷新核对状态', details: {} };
};
const size = value => Buffer.byteLength(JSON.stringify(value));
const empty = async function* () {};

/**
 * Install an ephemeral non-owner read policy. Each opened carrier belongs to an
 * already authorized exact Session; its id is a handle, never a bearer grant.
 * The caller must authenticate the original receipt on every request.
 */
export function createAssistantNativeCarrierService({ ctx, createPeer,
  idleMs = 60000, pollMs = 20000, presenceMs = 35000, onSessionDisconnect = () => {}, maxCarriers = 4, maxStreams = 8,
  maxInflight = 12, maxFrames = 32, maxBytes = 256 * 1024, historyMessages = 16,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  for (const value of [idleMs, pollMs, presenceMs, maxCarriers, maxStreams, maxInflight, maxFrames, maxBytes, historyMessages]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid native carrier limits');
  }
  if (pollMs >= idleMs || pollMs >= presenceMs) throw new TypeError('Native polling must finish before idle and presence expiry');
  if (typeof onSessionDisconnect !== 'function') throw new TypeError('Invalid native disconnect callback');
  const gateway = ctx?.get?.('typertGateway'), access = ctx?.get?.('remoteAccess');
  if (typeof gateway?.invoke !== 'function' || typeof gateway?.wireStream?.open !== 'function'
    || typeof access?.registerPolicy !== 'function' || typeof createPeer !== 'function') throw fail('ASSISTANT_NATIVE_UNAVAILABLE', 503);
  // Leave room for the HTTP result envelope and poll bookkeeping. The history
  // window remains a suffix of the real sequence; older records are paginated.
  const historyBytes = Math.max(1, maxBytes - 1024);
  function historyWindow(value) {
    if (size(value) <= historyBytes) return value;
    let low = 1, high = value.records.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (size({ ...value, records: value.records.slice(middle), hasMore: true }) <= historyBytes) high = middle;
      else low = middle + 1;
    }
    if (low >= value.records.length) throw fail('ASSISTANT_NATIVE_RESPONSE_TOO_LARGE', 502);
    return { ...value, records: value.records.slice(low), hasMore: true };
  }
  const carriers = new Map(), liveSessions = new Set(), principalKind = `${PRINCIPAL}:${randomUUID()}`; let disposed = false, disposal;
  const removePolicy = access.registerPolicy(principalKind, { bindings(principal) {
    const carrier = carriers.get(principal.carrierId);
    if (!carrier || carrier.principal !== principal || carrier.closed) return [];
    return [
      { role: { name: 'assistant-native-read', resource: 'session', actions: READ_SESSION }, resource: { kind: 'session', id: carrier.sessionId } },
      { role: { name: 'assistant-native-filtered-read', resource: 'global', actions: READ_GLOBAL }, resource: { kind: 'global' } },
    ];
  } });

  // Presence describes an observed read connection, never human approval or a
  // permission lease. Only successful polls of a real ready $events stream
  // renew it; opening a carrier or using unrelated RPCs does not.
  function refreshPresence(sessionId) {
    const time = now();
    const live = [...carriers.values()].some(carrier => carrier.sessionId === sessionId && !carrier.closed
      && [...carrier.streams.values()].some(stream => stream.endpoint === '$events' && stream.ready
        && !stream.ended && !stream.abort.signal.aborted && stream.observedAt !== undefined && time - stream.observedAt < presenceMs));
    if (live) liveSessions.add(sessionId);
    else if (liveSessions.delete(sessionId)) {
      try {
        Promise.resolve(onSessionDisconnect(sessionId)).catch(() => { console.error('[assistant-native] Disconnect notification failed'); });
      } catch (error) { console.error('[assistant-native] Disconnect notification failed'); }
    }
    return live;
  }
  function retirePresence(carrier, stream) {
    clearTimer(stream.presenceTimer); stream.observedAt = undefined;
    refreshPresence(carrier.sessionId);
  }
  function observePresence(carrier, stream, items) {
    refreshPresence(carrier.sessionId);
    if (stream.endpoint !== '$events' || !stream.ready || stream.ended || stream.abort.signal.aborted
      || stream.observedAt === undefined && !items.some(frame => frame.type === 'ready')) return;
    stream.observedAt = now(); clearTimer(stream.presenceTimer);
    stream.presenceTimer = setTimer(() => refreshPresence(carrier.sessionId), presenceMs);
    stream.presenceTimer?.unref?.();
    refreshPresence(carrier.sessionId);
  }

  function touch(carrier) {
    carrier.touched = now(); clearTimer(carrier.timer);
    carrier.timer = setTimer(() => { void close(carrier).catch(() => {}); }, idleMs);
    carrier.timer?.unref?.();
  }
  function lookup(sessionId, id) {
    const carrier = carriers.get(id);
    if (!carrier || carrier.sessionId !== sessionId || carrier.closed) throw fail('ASSISTANT_NATIVE_STALE', 410);
    if (now() - carrier.touched >= idleMs) {
      void close(carrier).catch(() => {}); throw fail('ASSISTANT_NATIVE_STALE', 410);
    }
    refreshPresence(sessionId); touch(carrier); return carrier;
  }
  async function stopStream(carrier, stream) {
    if (!stream) return;
    stream.abort.abort(); stream.ended = true; stream.queue = []; stream.bytes = 0; retirePresence(carrier, stream); stream.wake?.();
    carrier.streams.delete(stream.id);
    await stream.done;
  }
  function close(carrier) {
    if (carrier.closing) return carrier.closing;
    carrier.closed = true; carriers.delete(carrier.id); clearTimer(carrier.timer);
    carrier.abort.abort(); refreshPresence(carrier.sessionId); access.invalidate?.(carrier.principal);
    carrier.closing = (async () => {
      await Promise.all([...carrier.streams.values()].map(stream => stopStream(carrier, stream)));
      await carrier.peer.dispose();
    })();
    return carrier.closing;
  }
  function capabilities(sessionId) {
    return { owner: false, representation: ASSISTANT_NATIVE_REPRESENTATION, durableSubmit: true,
      grants: [{ resource: { kind: 'session', id: sessionId }, actions: [
        ...READ_SESSION, 'session/prompt', 'session/cancel', 'fileUploads/upload',
      ] }], approval: false, localPaths: false, commands: false, modelSelection: false, liveText: false,
      history: { maxMessages: historyMessages, maxBytes: historyBytes, messagePreviewBytes: ASSISTANT_NATIVE_PREVIEW_BYTES, boundedReplay: true, boundedInbox: true, completeSourceLog: false } };
  }
  function validateEndpoint(carrier, endpoint, payload, stream) {
    if (!(stream ? STREAMS : CALLS).has(endpoint) || !exact(payload, ['args']) || !record(payload.args)) throw fail('ASSISTANT_NATIVE_OPERATION_FORBIDDEN', 403);
    const args = payload.args;
    if (['$events', 'session/control', 'remoteAccess/follow'].includes(endpoint)) {
      if (Object.keys(args).length) throw fail();
      return args;
    }
    if (endpoint === 'session/list') {
      // The official descriptor names its reserved empty argument `_request`.
      if (!exact(args, ['_request']) || !exact(args._request, []) ) throw fail();
      return args;
    }
    if (endpoint === 'fileUploads/upload') {
      if (!exact(args, ['agentId', 'request']) || args.agentId !== carrier.sessionId
        || !exact(args.request, ['name', 'data']) || typeof args.request.name !== 'string' || typeof args.request.data !== 'string') throw fail();
      return args;
    }
    if (!exact(args, ['request']) || !record(args.request)) throw fail();
    const request = args.request;
    if (endpoint === 'session/page' || endpoint === 'session/follow') {
      if (!exact(request, ['address', 'throughSeq', 'beforeSeq', 'maxMessages', 'turnWindow', 'assistantStream', 'afterSeq'])
        || !exact(request.address, ['kind', 'sessionId']) || request.address.kind !== 'session'
        || request.address.sessionId !== carrier.sessionId) throw fail('ASSISTANT_NATIVE_SESSION_FORBIDDEN', 403);
      if (request.maxMessages !== undefined && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages < 1)) throw fail();
      if (request.turnWindow !== undefined && (!exact(request.turnWindow, ['minMessages', 'minTurns'])
        || !Number.isSafeInteger(request.turnWindow.minMessages) || request.turnWindow.minMessages < 1
        || request.turnWindow.minMessages > (request.maxMessages ?? 50)
        || !Number.isSafeInteger(request.turnWindow.minTurns) || request.turnWindow.minTurns < 1)) throw fail();
      // Native defaults can request 500 messages/minimum 50, independent of the
      // carrier byte cap. Keep exact address/cursors, never its unbounded window.
      const { turnWindow, ...bounded } = request;
      return { request: { ...bounded, maxMessages: Math.min(request.maxMessages ?? historyMessages, historyMessages) } };
    } else if (request.sessionId !== carrier.sessionId) throw fail('ASSISTANT_NATIVE_SESSION_FORBIDDEN', 403);
    if (endpoint === 'session/projections' && !exact(request, ['sessionId'])) throw fail();
    if (endpoint === 'session/cancel') {
      if (!exact(args, ['request']) || !exact(args.request, ['sessionId']) || !record(args.request)
        || args.request.sessionId !== carrier.sessionId) throw fail('ASSISTANT_NATIVE_SESSION_FORBIDDEN', 403);
      return args;
    }
    if (endpoint === 'session/prompt') {
      if (!exact(request, ['sessionId', 'requestId', 'requestFingerprint', 'mode', 'content', 'clientTimeZone'])
        || request.mode !== 'queue' || request.requestFingerprint !== undefined || !key(request.requestId)
        || !Array.isArray(request.content) || request.content.some(part => !record(part)
          || !['text', 'file', 'image'].includes(part.type) || part.type === 'image' && (typeof part.receiptId !== 'string' || part.data !== undefined))) throw fail();
    }
    return args;
  }
  async function unary(carrier, endpoint, payload, signal) {
    const args = validateEndpoint(carrier, endpoint, payload, false);
    // Durable admission is cloud-owned. A browser cancellation never stops an
    // accepted task or abandons its persistence acknowledgement.
    if (endpoint === 'session/prompt') {
      const input = args.request;
      const accepted = await carrier.runAssistant('submit', { requestId: input.requestId, content: input.content,
        ...(input.clientTimeZone === undefined ? {} : { timezone: input.clientTimeZone }) });
      if (accepted?.accepted !== true || accepted.sessionId !== carrier.sessionId || accepted.requestId !== input.requestId) throw fail('ASSISTANT_NATIVE_RECEIPT_INVALID', 502);
      return { accepted: true };
    }
    if (endpoint === 'fileUploads/upload') {
      const receipt = await carrier.runAssistant('attachment-upload', { kind: 'file', name: args.request.name, data: args.request.data });
      if (!receipt?.receiptId || !receipt?.attachment) throw fail('ASSISTANT_NATIVE_RECEIPT_INVALID', 502);
      return { receiptId: receipt.receiptId, file: receipt.attachment };
    }
    if (endpoint === 'session/cancel') {
      // Cancellation is the one native write that must not round-trip through
      // the read policy: the Host already owns the exact Session and its live
      // Agent, and the accepted receipt above never covers a stopped turn.
      const accepted = await carrier.runAssistant('cancel', {});
      if (accepted?.accepted !== true) throw fail('ASSISTANT_NATIVE_RECEIPT_INVALID', 502);
      return { accepted: true };
    }
    const value = await gateway.invoke({ namespace: 'session', method: endpoint.slice('session/'.length), args,
      peer: carrier.peer, signal: AbortSignal.any([carrier.abort.signal, ...(signal ? [signal] : [])]) });
    if (endpoint === 'session/page') return historyWindow(projectAssistantNativePage(value, carrier.sessionId));
    if (endpoint === 'session/projections') return projectAssistantNativeProjections(value, carrier.sessionId);
    if (!Array.isArray(value?.items)) throw fail('ASSISTANT_NATIVE_PROJECTION_INVALID', 502);
    return { items: value.items.filter(row => row.sessionId === carrier.sessionId).map(row => ({
      sessionId: carrier.sessionId, updatedAt: Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0 ? row.updatedAt : 0,
      running: row.running === true, blank: row.blank === true, agentAvailable: row.agentAvailable === true,
      ...(row.formatStatus === 'current' || row.formatStatus === 'migration-required' ? { formatStatus: row.formatStatus } : {}),
      ...(row.projections && ['cached', 'sequenced'].includes(row.projections.kind)
        ? { projections: { kind: row.projections.kind, ...projectAssistantNativeProjectionBaseline(row.projections) } } : {}),
    })) };
  }
  async function* source(carrier, endpoint, payload, signal) {
    const args = validateEndpoint(carrier, endpoint, payload, true);
    if (endpoint === 'remoteAccess/follow') {
      yield { type: 'baseline', owner: false, grants: capabilities(carrier.sessionId).grants };
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      return;
    }
    const upstream = await gateway.wireStream.open(endpoint, { args }, empty(), carrier.peer, signal);
    for await (const frame of upstream) {
      if (signal.aborted) return;
      if (endpoint === '$events') {
        if (frame?.type === 'ready' && typeof frame.clientId === 'string') yield { type: 'ready', clientId: frame.clientId, host: { home: '' } };
        else if (frame?.type === 'emit') {
          // Session running state is the one Host fact the native composer
          // needs so its own send button can become Stop. Every other event
          // and all waterfalls stay outside this read-only carrier.
          const status = projectAssistantNativeStatusEvent(frame, carrier.sessionId);
          if (status) yield status;
        }
      } else if (endpoint === 'session/follow') {
        const safe = projectAssistantNativeFollowFrame(frame, carrier.sessionId);
        yield safe.type === 'snapshot' ? historyWindow(safe) : safe;
      }
      else {
        const safe = projectAssistantNativeControlFrame(frame, carrier.sessionId);
        if (safe !== null) yield safe;
      }
    }
  }
  function startStream(carrier, input, signal) {
    if (!key(input.streamId) || carrier.streams.has(input.streamId) || carrier.streams.size >= maxStreams) throw fail('ASSISTANT_NATIVE_STREAM_LIMIT', 409);
    validateEndpoint(carrier, input.endpoint, input.payload, true);
    signal?.throwIfAborted();
    const abort = new AbortController(), lifetime = AbortSignal.any([carrier.abort.signal, abort.signal]);
    const stream = { id: input.streamId, endpoint: input.endpoint, abort, ready: false, queue: [], bytes: 0, ended: false, polling: false };
    carrier.streams.set(stream.id, stream);
    stream.done = (async () => {
      try {
        for await (const frame of source(carrier, input.endpoint, input.payload, lifetime)) {
          if (lifetime.aborted) break;
          const bytes = size(frame);
          if (stream.queue.length >= maxFrames || stream.bytes + bytes > maxBytes) throw fail('ASSISTANT_NATIVE_STREAM_OVERFLOW', 503);
          if (input.endpoint === '$events' && frame.type === 'ready') stream.ready = true;
          stream.queue.push(frame); stream.bytes += bytes; stream.wake?.();
        }
      } catch (error) {
        if (!lifetime.aborted) stream.error = safeFailure(error);
      } finally { stream.ended = true; retirePresence(carrier, stream); stream.wake?.(); }
    })();
    return { opened: true };
  }
  async function poll(carrier, input, signal) {
    const stream = carrier.streams.get(input.streamId);
    if (!stream) throw fail('ASSISTANT_NATIVE_STREAM_STALE', 410);
    if (stream.polling) throw fail('ASSISTANT_NATIVE_POLL_CONFLICT', 409);
    stream.polling = true;
    const cancelled = () => { stream.abort.abort(); retirePresence(carrier, stream); stream.wake?.(); };
    signal?.addEventListener('abort', cancelled, { once: true });
    try {
      signal?.throwIfAborted();
      if (!stream.queue.length && !stream.ended) await new Promise(resolve => {
        let timer;
        const done = () => { clearTimer(timer); if (stream.wake === done) stream.wake = undefined; resolve(); };
        stream.wake = done; timer = setTimer(done, pollMs);
      });
      signal?.throwIfAborted();
      const items = stream.queue.splice(0); stream.bytes = 0;
      const result = { items, ended: stream.ended, ...(stream.error ? { error: stream.error } : {}) };
      if (stream.ended) carrier.streams.delete(stream.id);
      observePresence(carrier, stream, items);
      touch(carrier); return result;
    } finally {
      signal?.removeEventListener('abort', cancelled); stream.polling = false;
      if (signal?.aborted) await stopStream(carrier, stream);
    }
  }
  return {
    open({ sessionId, runAssistant, signal }) {
      if (disposed || !key(sessionId) || typeof runAssistant !== 'function') throw fail('ASSISTANT_NATIVE_UNAVAILABLE', 503);
      signal?.throwIfAborted();
      if (carriers.size >= maxCarriers) throw fail('ASSISTANT_NATIVE_CARRIER_LIMIT', 429);
      const id = randomUUID(), principal = Object.freeze({ kind: principalKind, carrierId: id });
      const peer = createPeer({ principal, interactions: 'answer' });
      if (!peer || peer.principal !== principal || peer.principal.kind === 'owner' || typeof peer.dispose !== 'function') throw new TypeError('Native carrier requires its exact non-owner Peer');
      const carrier = { id, sessionId, principal, peer, runAssistant, abort: new AbortController(), streams: new Map(), inflight: 0, closed: false };
      carriers.set(id, carrier); touch(carrier); access.invalidate?.(principal);
      peer.signal.addEventListener('abort', () => { void close(carrier).catch(() => {}); }, { once: true });
      return { carrierId: id, sessionId, representation: ASSISTANT_NATIVE_REPRESENTATION, capabilities: capabilities(sessionId), idleMs };
    },
    async request(sessionId, operation, input = {}, { signal } = {}) {
      const keys = operation === 'native-call' ? ['carrierId', 'channel', 'endpoint', 'payload']
        : operation === 'native-stream-open' ? ['carrierId', 'streamId', 'endpoint', 'payload']
          : operation === 'native-close' ? ['carrierId'] : ['carrierId', 'streamId'];
      if (!exact(input, keys) || !key(input.carrierId)
        || operation.startsWith('native-stream-') && !key(input.streamId)) throw fail();
      if (operation === 'native-close' && !carriers.has(input.carrierId)) return { closed: true };
      const carrier = lookup(sessionId, input.carrierId);
      if (operation === 'native-close') { await close(carrier); return { closed: true }; }
      if (operation === 'native-stream-cancel') {
        await stopStream(carrier, carrier.streams.get(input.streamId)); return { cancelled: true };
      }
      if (carrier.inflight >= maxInflight) throw fail('ASSISTANT_NATIVE_INFLIGHT_LIMIT', 429);
      carrier.inflight++;
      try {
        if (operation === 'native-stream-open') return startStream(carrier, input, signal);
        if (operation === 'native-stream-poll') return await poll(carrier, input, signal);
        if (operation !== 'native-call' || input.channel !== '/api') throw fail('ASSISTANT_NATIVE_OPERATION_FORBIDDEN', 403);
        try {
          const value = await unary(carrier, input.endpoint, input.payload, signal);
          if (size(value) > maxBytes) throw fail('ASSISTANT_NATIVE_RESPONSE_TOO_LARGE', 502);
          return { ok: true, value };
        }
        catch (error) { return { ok: false, error: safeFailure(error) }; }
      } finally { carrier.inflight--; }
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => { await Promise.all([...carriers.values()].map(close)); removePolicy(); })();
      return disposal;
    },
    activeCount: () => carriers.size,
    hasLiveSession: sessionId => refreshPresence(sessionId),
  };
}
