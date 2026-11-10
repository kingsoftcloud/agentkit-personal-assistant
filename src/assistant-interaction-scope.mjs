/** Read live DSH identity without restoring a Session or acquiring execution ownership. */
export const interactionIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
export const interactionIndex = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

/** The frozen assistant facade has no cloud-bound Client Controller or Gateway. */
export const cloudAssistantComposerCapability = Object.freeze({
  mode: 'durable-cloud', nativeSessionBinding: false, nativeComposer: false,
  reason: 'cross-host-controller-unavailable',
});

export function createAssistantInteractionScope({ ctx, hostId, ownsSession }) {
  if (!interactionIdentifier(hostId) || typeof ownsSession !== 'function') throw new TypeError('Invalid assistant interaction scope');
  const available = () => typeof ctx?.get?.('agents')?.get === 'function'
    && typeof ctx?.get?.('sessionProjections')?.stateOf === 'function';
  const owned = sessionId => interactionIdentifier(sessionId) && ownsSession(sessionId) === true;
  const agentFor = sessionId => available() && owned(sessionId) ? ctx.get('agents').get(sessionId) : undefined;
  function read(sessionId) {
    const agent = agentFor(sessionId);
    if (!agent || agent.session?.id !== sessionId) return null;
    const boundary = ctx.get('sessionProjections').stateOf(agent.session, 'turnBoundary');
    if (!Number.isSafeInteger(boundary?.lastTurn) || boundary.lastTurn < 1 || !interactionIndex(boundary.openTurnStartSeq)) return null;
    return { agent, scope: Object.freeze({ hostId, sessionId, turn: boundary.lastTurn, turnStartSeq: boundary.openTurnStartSeq }) };
  }
  return {
    available, owned, agentFor, read,
    current(scope, agent) {
      const live = read(scope.sessionId);
      return Boolean(live && live.agent === agent && sameInteractionScope(scope, live.scope));
    },
  };
}

export function sameInteractionScope(left, right) {
  return Boolean(left && right && left.hostId === right.hostId && left.sessionId === right.sessionId
    && left.turn === right.turn && left.turnStartSeq === right.turnStartSeq);
}

export const interactionError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
