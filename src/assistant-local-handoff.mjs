/** A bounded handoff protocol. The shipped executor is simulation-only and never accesses a computer. */
import { createHash, randomUUID } from 'node:crypto';
import { createAssistantInteractionScope, interactionError, sameInteractionScope } from './assistant-interaction-scope.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => ({ accepted: false, reason });

function readOnlyAction(input) {
  // Version one deliberately has no shell, URL, write, credential, or permission operation.
  if (input?.kind !== 'read-file' || typeof input.path !== 'string' || !input.path || input.path.length > 1024
    || /[\\\x00-\x1f\x7f:]/.test(input.path) || input.path.startsWith('/')
    || input.path.split('/').some(part => !part || part === '.' || part === '..')
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 1024 * 1024
    || Object.keys(input).some(key => !['kind', 'path', 'maxBytes'].includes(key))) {
    throw interactionError('ASSISTANT_HANDOFF_ACTION_INVALID', '交接仅支持明确指定的相对文件和读取大小', 400);
  }
  return Object.freeze({ kind: 'read-file', path: input.path, maxBytes: input.maxBytes });
}

/**
 * requestConfirmation belongs to a trusted user-facing executor, never to a cloud
 * request body. It receives the exact immutable offer and returns allowed-once or
 * rejected. There is no JSON `approved:true` bypass. Shipping composition omits
 * executor and therefore cannot offer or execute a local action.
 */
export function createAssistantLocalHandoff({ ctx, hostId, ownsSession, executor,
  requestConfirmation, offerTimeoutMs = 120000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(offerTimeoutMs) || offerTimeoutMs < 1 || offerTimeoutMs > 86400000) throw new TypeError('Invalid handoff expiry');
  if (executor && (executor.kind !== 'simulation' || typeof executor.snapshot !== 'function' || typeof executor.execute !== 'function')) {
    throw new TypeError('Only the controlled simulation executor is supported');
  }
  const native = createAssistantInteractionScope({ ctx, hostId, ownsSession });
  const generation = randomUUID(), offers = new Map();
  let disposed = false;
  const target = () => executor?.snapshot();
  function capabilities() {
    if (disposed) return { supported: false, mode: 'unavailable', reason: 'closed', executesLocally: false };
    if (!executor) return { supported: false, mode: 'unavailable', reason: 'executor-unavailable', executesLocally: false };
    if (!native.available()) return { supported: false, mode: 'simulation', reason: 'native-services-unavailable', executesLocally: false };
    if (!target()?.connected) return { supported: false, mode: 'simulation', reason: 'executor-disconnected', executesLocally: false };
    if (typeof requestConfirmation !== 'function') return { supported: false, mode: 'simulation', reason: 'confirmation-unavailable', executesLocally: false };
    return { supported: true, mode: 'simulation', reason: 'available', executesLocally: false };
  }
  function valid(entry) {
    if (!entry || disposed || now() >= entry.offer.expiresAt || entry.abort.signal.aborted) return false;
    try {
      const destination = target();
      return Boolean(destination?.connected && destination.id === entry.offer.targetExecutorId
        && destination.generation === entry.offer.targetGeneration
        && native.current(entry.offer, entry.agent));
    } catch { return false; }
  }
  function matches(entry, sessionId, input) {
    return Boolean(entry && entry.offer.sessionId === sessionId && input.generation === generation
      && sameInteractionScope(entry.offer, input) && input.targetExecutorId === entry.offer.targetExecutorId
      && input.targetGeneration === entry.offer.targetGeneration && input.actionDigest === entry.offer.actionDigest);
  }
  function retire(entry, status) {
    entry.status = status;
    clearTimeout(entry.timer);
    entry.abort.abort();
    // Keep only live offers. An unknown, retired, or replayed id is always stale.
    offers.delete(entry.offer.requestId);
  }
  return {
    capabilities,
    snapshot(sessionId) {
      for (const entry of [...offers.values()]) if (entry.offer.sessionId === sessionId && !valid(entry)) retire(entry, 'expired');
      return { capabilities: capabilities(), offers: [...offers.values()].filter(entry => entry.offer.sessionId === sessionId)
        .map(entry => ({ ...entry.offer, status: entry.status })) };
    },
    offer(sessionId, input) {
      const available = capabilities();
      if (!available.supported) return fail(available.reason);
      const live = native.read(sessionId), destination = target();
      if (!live) return fail('turn-inactive');
      const action = readOnlyAction(input);
      const offer = Object.freeze({ kind: 'local-handoff', requestId: randomUUID(), generation, ...live.scope,
        targetExecutorId: destination.id, targetGeneration: destination.generation,
        expiresAt: now() + offerTimeoutMs, action, actionDigest: digest(action), mode: 'simulation' });
      const entry = { offer, agent: live.agent, status: 'offered', abort: new AbortController() };
      entry.timer = setTimeout(() => retire(entry, 'expired'), offerTimeoutMs);
      entry.timer.unref?.();
      offers.set(offer.requestId, entry);
      return { accepted: true, offer };
    },
    validate(sessionId, input = {}) {
      const entry = offers.get(input.requestId);
      if (!matches(entry, sessionId, input) || !valid(entry)) return fail('offer-stale');
      if (entry.status !== 'offered') return fail('already-started');
      return { accepted: true, offer: entry.offer };
    },
    async execute(sessionId, input = {}) {
      const available = capabilities();
      if (!available.supported) return fail(available.reason);
      const entry = offers.get(input.requestId);
      if (!matches(entry, sessionId, input) || !valid(entry)) return fail('offer-stale');
      if (entry.status !== 'offered') return fail('already-started');
      entry.status = 'awaiting-confirmation';
      let onAbort;
      try {
        const abandoned = new Promise(resolve => {
          onAbort = () => resolve('rejected');
          entry.abort.signal.addEventListener('abort', onAbort, { once: true });
        });
        const decision = await Promise.race([
          Promise.resolve().then(() => requestConfirmation(entry.offer, entry.abort.signal)), abandoned,
        ]);
        if (decision !== 'allowed-once') { retire(entry, 'rejected'); return fail('rejected'); }
        // Recheck after user input: neither a new turn nor a reconnected target
        // may inherit permission from the old offer. No await before dispatch.
        if (!valid(entry)) { retire(entry, 'expired'); return fail('offer-stale'); }
        entry.status = 'executing';
        const receipt = await executor.execute(entry.offer, entry.abort.signal);
        if (!valid(entry) || receipt?.simulated !== true || receipt.executed !== false
          || receipt.requestId !== entry.offer.requestId || receipt.targetExecutorId !== entry.offer.targetExecutorId
          || receipt.targetGeneration !== entry.offer.targetGeneration || receipt.actionDigest !== entry.offer.actionDigest) throw new Error('Invalid simulation receipt');
        retire(entry, 'simulated');
        return { accepted: true, status: 'simulated', receipt };
      } catch {
        // Never retry an executor whose outcome was not established.
        retire(entry, 'failed');
        return fail('execution-unconfirmed');
      } finally {
        entry.abort.signal.removeEventListener('abort', onAbort);
      }
    },
    cancel(sessionId, requestId) {
      const entry = offers.get(requestId);
      if (!entry || entry.offer.sessionId !== sessionId) return fail('offer-stale');
      retire(entry, 'cancelled');
      return { accepted: true };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...offers.values()]) retire(entry, 'cancelled');
    },
  };
}

/** Pure protocol fixture: records an intended read; no fs, network, process, or desktop API. */
export function createSimulatedLocalExecutor({ id = 'simulated-computer' } = {}) {
  let connected = true, generation = 1;
  const calls = [];
  return {
    kind: 'simulation',
    snapshot: () => Object.freeze({ id, generation, connected }),
    disconnect: () => { connected = false; },
    reconnect: () => { connected = true; generation++; },
    calls: () => [...calls],
    async execute(offer, signal) {
      signal.throwIfAborted();
      if (!connected || offer.targetExecutorId !== id || offer.targetGeneration !== generation) throw new Error('Simulation target changed');
      const receipt = Object.freeze({ simulated: true, executed: false, requestId: offer.requestId,
        targetExecutorId: id, targetGeneration: generation, actionDigest: offer.actionDigest });
      calls.push(receipt);
      return receipt;
    },
  };
}
