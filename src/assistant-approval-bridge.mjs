/** Optional live answerer for DSH approval/request. Never reconstruct questions from audit history. */
import { randomUUID } from 'node:crypto';
import { displayText } from './assistant-history.mjs';
import { createAssistantInteractionScope, interactionError, interactionIdentifier, sameInteractionScope } from './assistant-interaction-scope.mjs';

function presentationOf(request, locale) {
  const readable = value => {
    const text = typeof value === 'string' ? displayText(value).trim().slice(0, 2000) : '';
    return text.replace(/\[已隐藏凭据\]/g, '').trim() ? text : undefined;
  };
  const reason = readable(request.reason);
  const displayReason = Object.freeze(Object.fromEntries(Object.entries(request.displayReason || {})
    .filter(([key, value]) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(key) && readable(value))
    .slice(0, 16).map(([key, value]) => [key, readable(value)])));
  const detail = displayReason[locale] || displayReason[locale.split('-')[0]] || displayReason.en || reason;
  return {
    ...(reason ? { reason } : {}),
    ...(Object.keys(displayReason).length ? { displayReason } : {}),
    presentation: detail || (locale.startsWith('zh') ? `工具 ${request.toolName} 请求审批，但未提供具体操作说明；当前只能拒绝`
      : `Tool ${request.toolName} requests approval without action details; only rejection is available`),
    canAllow: Boolean(detail),
    choices: Object.freeze(detail ? ['allowed-once', 'rejected'] : ['rejected']),
  };
}

/**
 * The authenticated transport owner scopes snapshot/decide to its own Session and
 * calls disconnect when its interaction channel ends. This adapter neither
 * changes DSH policy nor creates a permission grant store. `accepted` acknowledges
 * the live answer only; DSH still owns audit persistence and action execution.
 */
export function createAssistantApprovalBridge({ ctx, hostId, ownsSession, enabled = false,
  policyOf = () => 'never', isConnected = () => true, requestTimeoutMs = 120000, now = Date.now, locale = 'zh' } = {}) {
  if (typeof enabled !== 'boolean' || typeof isConnected !== 'function' || typeof locale !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 86400000) {
    throw new TypeError('Invalid assistant approval configuration');
  }
  const native = createAssistantInteractionScope({ ctx, hostId, ownsSession });
  const generation = randomUUID(), pending = new Map();
  let disposed = false;
  const policy = agent => {
    try {
      // A native session override wins even if a composition callback is stale.
      if (ctx.get('approval')?.overrideOf?.(agent.session) === 'never') return 'never';
      return policyOf(agent);
    } catch { return undefined; }
  };
  const online = sessionId => { try { return isConnected(sessionId) === true; } catch { return false; } };
  const isCurrent = entry => {
    try { return native.current(entry.view, entry.agent); } catch { return false; }
  };
  function settle(entry, outcome) {
    if (pending.get(entry.view.requestId) !== entry) return false;
    pending.delete(entry.view.requestId);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.resolve(outcome);
    return true;
  }
  function refresh(sessionId) {
    for (const entry of pending.values()) {
      if (entry.view.sessionId !== sessionId) continue;
      if (entry.signal?.aborted || !isCurrent(entry)) settle(entry, 'cancelled');
      else if (!online(sessionId)) settle(entry, 'unavailable');
      else if (now() >= entry.view.expiresAt) settle(entry, 'unavailable');
      else if (policy(entry.agent) !== 'ask') settle(entry, 'rejected');
    }
  }
  const serviceAvailable = () => typeof ctx?.on === 'function' && native.available();
  function capabilities(sessionId) {
    if (disposed) return { interactive: false, reason: 'closed' };
    if (!enabled) return { interactive: false, reason: 'disabled' };
    if (!release || !serviceAvailable()) return { interactive: false, reason: 'native-services-unavailable' };
    const agent = native.agentFor(sessionId);
    if (!agent) return { interactive: false, reason: 'session-inactive' };
    if (policy(agent) !== 'ask') return { interactive: false, reason: 'policy-never' };
    if (!online(sessionId)) return { interactive: false, reason: 'offline' };
    return { interactive: true, reason: 'available' };
  }
  function answer(request, next) {
    if (!native.owned(request?.agent?.session?.id)) return next();
    if (disposed || !enabled || !serviceAvailable()) return Promise.resolve('unavailable');
    if (policy(request.agent) !== 'ask') return Promise.resolve('rejected');
    if (request.signal?.aborted) return Promise.resolve('cancelled');
    if (!online(request.agent.session.id)) return Promise.resolve('unavailable');
    const live = native.read(request.agent.session.id);
    if (!live || live.agent !== request.agent || !interactionIdentifier(request.toolName)) return Promise.resolve('unavailable');
    const view = Object.freeze({
      kind: 'approval', requestId: randomUUID(), generation, ...live.scope,
      toolName: request.toolName,
      ...(interactionIdentifier(request.callId) ? { callId: request.callId } : {}),
      ...presentationOf(request, locale), expiresAt: now() + requestTimeoutMs,
    });
    return new Promise(resolve => {
      const entry = { view, agent: request.agent, signal: request.signal, resolve };
      entry.abort = () => settle(entry, 'cancelled');
      pending.set(view.requestId, entry);
      entry.timer = setTimeout(() => settle(entry, 'unavailable'), requestTimeoutMs);
      entry.timer.unref?.();
      request.signal?.addEventListener('abort', entry.abort, { once: true });
      if (request.signal?.aborted) entry.abort();
    });
  }
  // This exact-session answerer precedes the generic remote-owner UI, which
  // may otherwise await a desktop that does not own this cloud conversation.
  // Foreign Sessions still delegate; native never-policy runs before this seam.
  const release = enabled && serviceAvailable() ? ctx.on('approval/request', answer, { prepend: true }) : undefined;
  return {
    snapshot(sessionId) {
      refresh(sessionId);
      return { capabilities: capabilities(sessionId), pending: [...pending.values()]
        .filter(entry => entry.view.sessionId === sessionId).map(entry => entry.view) };
    },
    decide(sessionId, input = {}) {
      if (!['allowed-once', 'rejected'].includes(input.decision)) throw interactionError('ASSISTANT_APPROVAL_DECISION_INVALID', '请选择仅允许这一次或拒绝', 400);
      refresh(sessionId);
      const entry = pending.get(input.requestId);
      if (!entry || entry.view.sessionId !== sessionId || input.generation !== generation || !sameInteractionScope(entry.view, input)) {
        return { accepted: false, reason: 'request-stale' };
      }
      // No asynchronous boundary is allowed between identity checks and settlement.
      if (disposed || !online(sessionId) || !isCurrent(entry) || entry.signal?.aborted || now() >= entry.view.expiresAt || policy(entry.agent) !== 'ask') {
        settle(entry, 'cancelled');
        return { accepted: false, reason: 'request-stale' };
      }
      if (input.decision === 'allowed-once' && !entry.view.canAllow) return { accepted: false, reason: 'details-unavailable' };
      settle(entry, input.decision);
      return { accepted: true, outcome: input.decision };
    },
    disconnect(sessionId) {
      for (const entry of [...pending.values()]) if (entry.view.sessionId === sessionId) settle(entry, 'unavailable');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      release?.();
      for (const entry of [...pending.values()]) settle(entry, 'unavailable');
    },
  };
}
