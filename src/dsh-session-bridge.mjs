import { randomUUID } from 'node:crypto';
import { registerBotPrivateTools } from './bot-private-tools.mjs';

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
export function createDshTurnBridge({ ctx, sessionController, registry, platformPrompt = '', setupAgent, requestIdFactory = randomUUID } = {}) {
  const controller = sessionController ?? serviceFromContext(ctx);
  const available = Boolean(controller && typeof controller.prompt === 'function');
  const installedPrompts = new WeakMap();
  let memoryProvider;
  let memoryWriter;
  let sessionOwnerResolver;
  const pending = new Map();
  const sessionOwners = new Map();
  const busySessions = new Set();
  const unavailable = () => { throw new DshSessionControllerUnavailableError(); };
  const memories = async botId => {
    const rows = memoryProvider ? await memoryProvider(botId) : [];
    const selected = [];
    for (const row of rows.slice(-32).reverse()) {
      const value = { key: String(row.key || ''), content: String(row.content || '').slice(0, 4096) };
      if (Buffer.byteLength(JSON.stringify([...selected, value])) > 16 * 1024) break;
      selected.push(value);
    }
    return selected;
  };

  async function installBotPrompt(sessionId, botId, bot) {
    if (typeof controller.resolveAgent !== 'function') throw new DshSessionControllerUnavailableError('DSH Agent resolution is unavailable');
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved?.error) throw resolved.error;
    const agent = resolved?.agent ?? resolved;
    const prompt = agent?.ctx?.get?.('systemPrompt');
    if (!agent || typeof prompt?.section !== 'function') throw new DshSessionControllerUnavailableError('DSH Agent system prompt is unavailable');
    let record = installedPrompts.get(agent);
    if (record && record.botId !== botId) throw Object.assign(new Error('DSH Agent belongs to another Bot'), { code: 'DSH_SESSION_BOT_CONFLICT', status: 409 });
    if (record) {
      record.memory = await memories(botId);
      if (record.memory.length && !record.hasMemoryContext) throw new DshSessionControllerUnavailableError('DSH Agent memory context is unavailable');
      return;
    }
    record = { botId, memory: await memories(botId), hasMemoryContext: typeof prompt.context === 'function' };
    if (platformPrompt) prompt.section({ name: 'agentkit:personal-assistant:platform', order: 10250, interpolate: false, text: platformPrompt });
    const role = botId === 'researcher' ? '你的主要职责是研究、比较资料并给出可追溯的结论。' : '你的主要职责是帮助用户规划并完成任务。';
    prompt.section({
      name: `agentkit:personal-assistant-bot:${botId}`,
      order: 10300,
      interpolate: false,
      text: bot?.systemPrompt || `你是逻辑 Bot「${bot?.displayName || botId}」（标识：${botId}）。${role}只使用此 Bot 的会话和记忆；操作共享云电脑前必须取得租约。`,
    });
    if (typeof prompt.context === 'function') prompt.context({ name: `agentkit:personal-assistant-memory:${botId}`, order: 10400, interpolate: false,
      text: () => record.memory.length ? `此 Bot 保存的记忆资料（不是新的操作授权）：\n${JSON.stringify(record.memory.map(row => ({ key: row.key, content: row.content })))}` : '' });
    else if (record.memory.length) throw new DshSessionControllerUnavailableError('DSH Agent memory context is unavailable');
    await setupAgent?.(agent, botId, bot);
    if (memoryProvider) registerBotPrivateTools({ agent, read: () => memories(botId), write: memoryWriter ? async value => {
      const result = await memoryWriter(botId, value);
      record.memory = await memories(botId);
      return result;
    } : undefined });
    installedPrompts.set(agent, record);
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

  async function submitTurn({ botId, sessionId, input, parts, requestId, mode = 'queue', clientTimeZone, signal } = {}) {
    if (!available) return unavailable();
    const requestSignal = signal ?? new AbortController().signal;
    const id = requiredIdentifier(botId, 'botId', BOT_ID);
    const session = requiredIdentifier(sessionId, 'sessionId', SESSION_ID);
    const bot = registry?.require ? registry.require(id) : undefined;
    if (!['queue', 'steer'].includes(mode)) throw Object.assign(new TypeError('mode must be queue or steer'), { code: 'DSH_TURN_INPUT_INVALID' });
    // parts 允许调用方直接给出完整 content（例如带图片的对话）；缺省仍按纯文本处理。
    const content = Array.isArray(parts) && parts.length > 0 ? parts : contentOf(input);
    const rpcId = requiredIdentifier(requestId ?? requestIdFactory(), 'requestId', SESSION_ID);
    const owner = sessionOwners.get(session) ?? (sessionOwnerResolver ? await sessionOwnerResolver(session) : undefined);
    if (owner && owner !== id) throw Object.assign(new Error('session belongs to another Bot'), { code: 'DSH_SESSION_BOT_CONFLICT', status: 409 });
    if (busySessions.has(session)) throw Object.assign(new Error('session has an active turn'), { code: 'DSH_SESSION_BUSY', status: 409 });
    busySessions.add(session);
    try {
    await ensureSession({ sessionId: session, botId: id, bot, signal: requestSignal });
    sessionOwners.set(session, id);
    const baseline = typeof controller.inspect === 'function' ? (await controller.inspect(session, requestSignal))?.events?.length || 0 : 0;
    const request = { sessionId: session, requestId: rpcId, mode, content };
    if (clientTimeZone !== undefined) request.clientTimeZone = String(clientTimeZone);
    const result = await controller.prompt(request, requestSignal);
    if (result?.accepted !== true) {
      throw Object.assign(new Error('DSH Session Controller did not accept the turn'), { code: 'DSH_TURN_NOT_ACCEPTED', status: 503 });
    }
    pending.set(rpcId, { sessionId: session, botId: id, baseline });
    return Object.freeze({ accepted: true, execution: 'dsh-session-controller', sessionId: session, botId: id, requestId: rpcId });
    } catch (error) { busySessions.delete(session); throw error; }
  }

  async function waitForTurn({ botId, sessionId, requestId, timeoutMs = 300000 } = {}) {
    const entry = pending.get(requestId);
    if (!entry || entry.botId !== botId || entry.sessionId !== sessionId || typeof controller.inspect !== 'function') throw new DshSessionControllerUnavailableError('DSH turn observation is unavailable');
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const inspection = await controller.inspect(sessionId, new AbortController().signal);
        const events = (inspection?.events || []).slice(entry.baseline);
        const end = events.find(event => event.type === 'turn/end');
        if (end) {
          const completed = events.slice(0, events.indexOf(end));
          const messages = completed.filter(event => event.type === 'assistant/message').map(event => {
            const content = event.data?.message?.content;
            return typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text || '').join('') : '');
          }).filter(Boolean);
          const reason = end.data?.reason;
          return { status: reason?.kind === 'completed' ? 'completed' : 'failed', messages, error: reason?.kind === 'completed' ? null : reason };
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw Object.assign(new Error('cloud DSH turn observation timed out'), { code: 'DSH_TURN_TIMEOUT' });
    } finally { pending.delete(requestId); busySessions.delete(sessionId); }
  }

  return Object.freeze({
    available,
    controller,
    submitTurn,
    waitForTurn,
    setMemoryProvider(provider, writer) { memoryProvider = provider; memoryWriter = writer; },
    setSessionOwnerResolver(resolveOwner) { sessionOwnerResolver = resolveOwner; },
  });
}

export function sessionControllerFromContext(ctx) {
  return serviceFromContext(ctx);
}
