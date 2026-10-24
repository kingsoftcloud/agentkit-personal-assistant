import { randomUUID } from 'node:crypto';

const BOT_ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Raised when the DSH Host did not inject its public Session Controller.
 *
 * The standalone cloud HTTP runtime intentionally does not manufacture a
 * controller. It must be hosted by DSH (or be given an explicit adapter) before
 * a turn can be called "executing".
 */
export class DshSessionControllerUnavailableError extends Error {
  constructor(message = 'DSH Session Controller is not available') {
    super(message);
    this.name = 'DshSessionControllerUnavailableError';
    this.code = 'DSH_SESSION_CONTROLLER_UNAVAILABLE';
    this.status = 503;
  }
}

function serviceFromContext(ctx) {
  if (ctx && typeof ctx.get === 'function') {
    try { return ctx.get('sessionController'); } catch { return undefined; }
  }
  return ctx?.sessionController;
}

function requiredIdentifier(value, field, pattern) {
  const text = String(value ?? '').trim();
  if (!pattern.test(text)) throw Object.assign(new TypeError(`${field} is invalid`), { code: 'DSH_TURN_INPUT_INVALID' });
  return text;
}

function contentOf(input) {
  const text = String(input ?? '').trim();
  if (!text) throw Object.assign(new TypeError('input is required'), { code: 'DSH_TURN_INPUT_INVALID' });
  return [{ type: 'text', text }];
}

/**
 * Adapt the public DSH Host SessionController to the Personal Assistant turn
 * contract. The controller remains the source of truth for execution and
 * history; this bridge only performs session admission and prompt delivery.
 */
export function createDshTurnBridge({ ctx, sessionController, registry, requestIdFactory = randomUUID } = {}) {
  const controller = sessionController ?? serviceFromContext(ctx);
  const available = Boolean(controller && typeof controller.prompt === 'function');
  const installedPrompts = new WeakSet();
  const unavailable = () => { throw new DshSessionControllerUnavailableError(); };

  async function installBotPrompt(sessionId, botId, bot) {
    if (!bot?.systemPrompt || typeof controller.resolveAgent !== 'function') return;
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved?.error) throw resolved.error;
    const agent = resolved?.agent ?? resolved;
    const prompt = agent?.ctx?.get?.('systemPrompt');
    if (!agent || !prompt || typeof prompt.section !== 'function' || installedPrompts.has(agent)) return;
    prompt.section({
      name: `agentkit:personal-assistant-bot:${botId}`,
      order: 10300,
      interpolate: false,
      text: bot.systemPrompt,
    });
    installedPrompts.add(agent);
  }

  async function ensureSession({ sessionId, botId, bot, signal }) {
    if (typeof controller.projections === 'function') {
      const projection = await controller.projections({ sessionId }, signal);
      if (projection?.kind === 'migration-required') {
        throw Object.assign(new Error('DSH session requires migration'), { code: 'DSH_SESSION_MIGRATION_REQUIRED', status: 409 });
      }
      if (projection) {
        await installBotPrompt(sessionId, botId, bot);
        return;
      }
    } else if (typeof controller.inspect === 'function') {
      const inspection = await controller.inspect(sessionId, signal);
      if (inspection) {
        await installBotPrompt(sessionId, botId, bot);
        return;
      }
    }
    if (typeof controller.create !== 'function') {
      throw Object.assign(new Error(`DSH session "${sessionId}" does not exist`), { code: 'DSH_SESSION_NOT_FOUND', status: 404 });
    }
    const request = { sessionId };
    // Agent preset selection is optional for custom Hosts. A Bot can provide
    // one without coupling the plugin to DSH's private preset implementation.
    if (bot?.agentPreset) request.agentPreset = bot.agentPreset;
    await controller.create(request);
    await installBotPrompt(sessionId, botId, bot);
    return { botId };
  }

  async function submitTurn({ botId, sessionId, input, requestId, mode = 'queue', clientTimeZone, signal } = {}) {
    if (!available) return unavailable();
    const requestSignal = signal ?? new AbortController().signal;
    const id = requiredIdentifier(botId, 'botId', BOT_ID);
    const session = requiredIdentifier(sessionId, 'sessionId', SESSION_ID);
    const bot = registry?.require ? registry.require(id) : undefined;
    if (!['queue', 'steer'].includes(mode)) throw Object.assign(new TypeError('mode must be queue or steer'), { code: 'DSH_TURN_INPUT_INVALID' });
    const content = contentOf(input);
    const rpcId = requiredIdentifier(requestId ?? requestIdFactory(), 'requestId', SESSION_ID);
    await ensureSession({ sessionId: session, botId: id, bot, signal: requestSignal });
    const request = { sessionId: session, requestId: rpcId, mode, content };
    if (clientTimeZone !== undefined) request.clientTimeZone = String(clientTimeZone);
    const result = await controller.prompt(request, requestSignal);
    if (result?.accepted !== true) {
      throw Object.assign(new Error('DSH Session Controller did not accept the turn'), { code: 'DSH_TURN_NOT_ACCEPTED', status: 503 });
    }
    return Object.freeze({ accepted: true, execution: 'dsh-session-controller', sessionId: session, botId: id, requestId: rpcId });
  }

  return Object.freeze({
    available,
    controller,
    submitTurn,
  });
}

export function sessionControllerFromContext(ctx) {
  return serviceFromContext(ctx);
}
