/**
 * 个人助理 Host 侧「会话通道」。
 *
 * 把宿主 DSH 的会话/对话能力收敛成面板可用的 5 个方法，由 `host-gateway.mjs`
 * 暴露为 `personal-assistant.sessions.list` / `.session.create` / `.session.snapshot`
 * / `.session.events` / `.turn.submit`。
 *
 * ## 事件来源：已核对的宿主真实 API（未臆造）
 *
 * 宿主 `ctx.sessionController` 由 `@deepseek-ai/dsh-api-session-controller` 提供，实测位于
 * `/Applications/AgentKit Studio.app/Contents/Resources/app.asar` 内的
 * `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`，公开方法有：
 *
 *   list(request, signal)                     → { items: SessionSummary[] }（冷热会话均可读，不激活 Agent）
 *   inspect(sessionId, signal)                → { meta, inheritedEventCount, events }
 *                                               （已挂载 = live snapshot；冷会话 = 持久化事件前缀；不激活 Agent）
 *   create({ sessionId?, cwd?, agentPreset? })→ { sessionId, agentPreset? }
 *   prompt({ sessionId, requestId, mode, content, clientTimeZone? }, signal) → { accepted: true }
 *   rename({ sessionId, title })              → { title, seq }
 *   page / follow / projections / cancel / updateQueue / fork / search / modelCatalog …
 *
 * 会话标题**不在** list 行里：由 `sessionTitle` 服务注册的 `title` projection 提供
 * （list 行为 `row.projections.values.title`），事件日志里则是 durable `session/title`
 * 事件（`data.title`）。因此本通道分别从这两处折叠标题。
 *
 * ## 实现选择、限制与后续替换点
 *
 * 1. 事件读取用 `inspect()` 全量事件前缀 + durable 事件 `seq` 做**单调游标**切片，
 *    而不是 `follow()`。原因：`follow()` 是 Remote 流载体专用的长连接 async generator
 *    （request 形如 `{ address: { kind: 'session', sessionId } }`），并且对冷会话会
 *    promotion（**激活 Agent**），不适合面板这种请求/响应式 RPC。
 *    → 替换点：改为
 *      `controller.follow({ address: { kind: 'session', sessionId }, maxMessages, assistantStream: true }, signal)`，
 *      把 `snapshot` / `event` / `assistant-stream` 帧灌进每个会话的推流缓冲；
 *      需要 RPC 层支持服务端推送（当前 connection.fetch 只有请求/响应）。
 * 2. 因此当前没有 token 级流式增量：assistant 文本按 durable `assistant/message`
 *    （每个 step 一条）投递，也不投递工具过程 `step` 行。客户端 `mergeEvents` 支持
 *    `delta` / `step`，接入 follow 后再补齐。
 * 3. 每次读取都会整份物化事件日志（inspect 语义），长会话成本随日志线性增长；
 *    这里用「单次增量条数 + 字节上限」兜底，保证 RPC 响应有界。
 *    替换点同上，或改用 `page({ address, throughSeq, beforeSeq })` 只读尾部页。
 * 4. Bot 归属只在进程内记忆（createSession 时记录，后续回合缺省时复用）；
 *    Host 重启后退回 `defaultBotId`。持久归属属于云端 runtime 的 sessionOwnerResolver
 *    （见 `dsh-session-bridge.mjs` 的 `setSessionOwnerResolver`）。
 * 5. 命名空间：只创建/列出 `sessionIdPrefix`（默认 `pa-`）前缀的会话，避免把用户
 *    在 Studio 中的其它会话暴露到个人助理面板（DSH `list` 返回全部可见会话）。
 */
import { randomUUID } from 'node:crypto';
import { DshSessionControllerUnavailableError } from './dsh-session-bridge.mjs';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
import { tmpdir } from 'node:os';

const SESSION_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BOT_ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const TITLE_BYTES = 512;
const TURN_BYTES = 32 * 1024;
const ROLE_OF_TYPE = Object.freeze({ 'user/message': 'user', 'assistant/message': 'assistant' });

const TEMP_ROOT = tmpdir().replace(/\/+$/u, '');
/** 判断会话工作区是否落在临时目录下（含 macOS 的 /private 别名）。 */
function isTempCwd(cwd) {
  const normalized = String(cwd || '').replace(/\/+$/u, '');
  if (!normalized) return false;
  for (const root of new Set([TEMP_ROOT, TEMP_ROOT.startsWith('/private/') ? TEMP_ROOT : `/private${TEMP_ROOT}`, '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'])) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const messageNotFound = /^session ".*" not found$/u;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

/**
 * 宿主会把环境说明、skill 目录、team 消息等作为 `user/message` 注入（`data.source.kind` 非 `user`）。
 * DSH 自己的会话投影只把 `source.kind === 'user'`（以及 compact 检查点）当成真人消息，
 * 面板同样只显示这些，否则会出现一大段 "Current DSH file policy…" 之类的内部提示。
 */
function isHumanUserMessage(event) {
  const source = event?.data?.source;
  if (!source || typeof source !== 'object') return true; // 旧格式无 source 时按真人消息处理
  return source.kind === 'user' || source.kind === 'compact';
}

/** 把一条 durable 会话事件收敛成客户端可渲染的 message 事件；不支持的隐私内容一律丢弃。 */
function messageEventOf(event) {
  const role = ROLE_OF_TYPE[event?.type];
  if (!role || !Number.isSafeInteger(event.seq) || event.seq < 0) return undefined;
  if (role === 'user' && !isHumanUserMessage(event)) return undefined;
  // user/message 的 data 就是消息本体，assistant/message 的 data 形如 { message }。
  const message = role === 'user' ? event.data : event?.data?.message;
  const text = textOfContent(message?.content).trim();
  if (!text) return undefined;
  return Object.freeze({ type: 'message', id: `m-${event.seq}`, role, text, done: true, seq: event.seq });
}

/** durable `session/title` 折叠出的最新标题。 */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;

/**
 * 把面板上传的图片（data URL）转成宿主 prompt content 的 image 部件。
 * 只接受宿主明确支持的四种位图；非图片附件本通道不投递（宿主暂不支持文件部件）。
 */
function imageParts(attachments) {
  if (!Array.isArray(attachments)) return [];
  const parts = [];
  for (const item of attachments.slice(0, MAX_IMAGES)) {
    if (!item || typeof item !== 'object') continue;
    const mediaType = typeof item.mimeType === 'string' ? item.mimeType : '';
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) continue;
    const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : '';
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:') || comma < 0) continue;
    const data = dataUrl.slice(comma + 1);
    if (Buffer.byteLength(data, 'base64') > IMAGE_BYTES) continue;
    parts.push({ type: 'image', mediaType, data, ...(typeof item.name === 'string' && item.name ? { name: item.name.slice(0, 120) } : {}) });
  }
  return parts;
}

function titleOfEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title) return event.data.title;
  }
  return null;
}

function titleOfRow(row) {
  const value = row?.projections?.values?.title;
  return typeof value === 'string' && value ? value : null;
}

function totalOf(events, atLeast = 0) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const seq = events[index]?.seq;
    if (Number.isSafeInteger(seq) && seq >= 0) return Math.max(atLeast, seq + 1);
  }
  return atLeast;
}

/**
 * 门面对象：可注入 sessionController（测试用假控制器），缺省从 DSH ctx 解析。
 * 所有方法在控制器缺失时抛 `DshSessionControllerUnavailableError`
 * （`code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE'`, `status: 503`）。
 *
 * @param {object} options
 * @param {object} [options.sessionController] 显式注入的 DSH sessionController
 * @param {object} [options.ctx] DSH 插件上下文（用于解析 'sessionController' 服务）
 * @param {object} [options.turnBridge] `createDshTurnBridge()` 结果；有 Bot 时优先走它（装 Bot 提示词与工具）
 * @param {(botId:string)=>object|undefined} [options.resolveBot] Bot 解析器（BotRegistry.get 之类）
 * @param {string} [options.defaultBotId] 客户端未指定 botId 时的缺省助理
 * @param {string} [options.sessionIdPrefix] 个人助理会话命名空间前缀
 * @param {function():string} [options.requestIdFactory] 会话/回合标识生成器
 */
export function createHostSessionChannel(options = {}) {
  const {
    ctx, sessionController, turnBridge, resolveBot, defaultBotId,
    sessionIdPrefix = 'pa-', requestIdFactory = randomUUID,
    maxSessions = 50, maxSnapshotMessages = 200,
    maxEventsPerRead = 200, maxEventsBytes = 256 * 1024, maxSnapshotBytes = 512 * 1024,
  } = options;
  if (typeof sessionIdPrefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/u.test(sessionIdPrefix)) {
    throw new TypeError('sessionIdPrefix must be a short identifier prefix');
  }
  if (defaultBotId !== undefined && defaultBotId !== null && defaultBotId !== '' && !BOT_ID.test(String(defaultBotId))) {
    throw new TypeError('defaultBotId must be a Bot identifier');
  }
  if (typeof requestIdFactory !== 'function') throw new TypeError('requestIdFactory must be a function');
  // 上限必须是正整数：0 会让增量游标停滞，客户端会原地轮询。
  for (const [field, value] of Object.entries({ maxSessions, maxSnapshotMessages, maxEventsPerRead, maxEventsBytes, maxSnapshotBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
  }
  const fixedDefaultBot = defaultBotId === undefined || defaultBotId === null || defaultBotId === '' ? undefined : String(defaultBotId);
  /** 进程内的会话 → Bot 归属；Host 重启后回退 defaultBotId（见文件头限制 4）。 */
  const sessionBots = new Map();

  function controller() {
    if (sessionController) return sessionController;
    if (ctx && typeof ctx.get === 'function') {
      try { return ctx.get('sessionController'); } catch { return undefined; }
    }
    return undefined;
  }

  function requireController(method) {
    const value = controller();
    if (!value || typeof value[method] !== 'function') throw new DshSessionControllerUnavailableError();
    return value;
  }

  function sessionIdOf(value) {
    const text = String(value ?? '').trim();
    if (!SESSION_ID.test(text)) throw fail('DSH_SESSION_ID_INVALID', '会话标识无效');
    return text;
  }

  function botIdOf(value) {
    const text = String(value ?? '').trim();
    if (!BOT_ID.test(text)) throw fail('DSH_SESSION_BOT_INVALID', '助理标识无效');
    return text;
  }

  function mintSuffix() {
    const suffix = String(requestIdFactory() ?? '');
    if (!SESSION_SUFFIX.test(suffix)) throw fail('DSH_SESSION_ID_INVALID', '会话标识生成失败', 500);
    return suffix;
  }

  function botDefinition(botId) {
    if (!botId || typeof resolveBot !== 'function') return undefined;
    let bot;
    try { bot = resolveBot(botId); } catch { bot = undefined; }
    if (!bot) throw fail('DSH_SESSION_BOT_INVALID', `助理「${botId}」不可用，请重新选择`);
    return bot;
  }

  function chooseBot(value, sessionId) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return botIdOf(value);
    if (sessionId && sessionBots.has(sessionId)) return sessionBots.get(sessionId);
    return fixedDefaultBot;
  }

  function failure(error, action) {
    if (error?.code === 'DSH_SESSION_CONTROLLER_UNAVAILABLE') return error;
    const code = error?.code;
    if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'session/not-found' || messageNotFound.test(String(error?.message ?? ''))) {
      return fail('DSH_SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    }
    if (code === 'session/title-invalid') return fail('DSH_SESSION_TITLE_INVALID', '会话标题无效');
    if (code === 'session/conflict') return fail('DSH_SESSION_CONFLICT', '会话与宿主已有会话冲突', 409);
    if (code === 'session/agent-busy' || code === 'session/request-conflict') return fail('DSH_SESSION_BUSY', 'DSH 拒绝了这一轮对话，请稍后重试', 409);
    if (code === 'session/migration-required') return fail('DSH_SESSION_MIGRATION_REQUIRED', '会话需要先完成格式迁移', 409);
    if (code === 'gateway/bad-request') return fail('DSH_SESSION_REQUEST_INVALID', '会话请求参数无效');
    return fail('DSH_SESSION_CONTROLLER_UNAVAILABLE', `${action}暂时不可用，请稍后重试`, 503);
  }

  function turnFailure(error) {
    const code = error?.code;
    if (code === 'DSH_SESSION_CONTROLLER_UNAVAILABLE') return error;
    if (code === 'DSH_SESSION_BOT_CONFLICT') return fail('DSH_SESSION_BOT_CONFLICT', '该会话属于另一个助理', 409);
    if (code === 'DSH_SESSION_BUSY') return fail('DSH_SESSION_BUSY', '会话正在处理上一轮对话，请稍后重试', 409);
    if (code === 'DSH_SESSION_MIGRATION_REQUIRED') return fail('DSH_SESSION_MIGRATION_REQUIRED', '会话需要先完成格式迁移', 409);
    if (code === 'DSH_SESSION_NOT_FOUND') return fail('DSH_SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    if (code === 'DSH_TURN_INPUT_INVALID') return fail('DSH_TURN_INPUT_INVALID', '消息内容无效');
    if (code === 'DSH_TURN_NOT_ACCEPTED') return fail('DSH_TURN_NOT_ACCEPTED', 'DSH 未接受这一轮对话', 503);
    if (/^BOT_NOT_FOUND/u.test(String(error?.message ?? ''))) return fail('DSH_SESSION_BOT_INVALID', '助理不存在，请重新选择');
    return failure(error, '发送消息');
  }

  /** 会话列表：只回个人助理命名空间内的会话，并对返回字段做白名单（不透传 Host 内部投影）。 */
  async function listSessions(signal) {
    const control = requireController('list');
    let result;
    try { result = await control.list({}, signal); } catch (error) { throw failure(error, '读取会话列表'); }
    const rows = Array.isArray(result?.items) ? result.items : [];
    const sessions = [];
    for (const row of rows) {
      const sessionId = typeof row?.sessionId === 'string' ? row.sessionId : '';
      if (!sessionId.startsWith(sessionIdPrefix)) continue;
      // 会话库是全局的：临时工作区（/tmp、/private/tmp 等）里的会话属于测试/试跑，
      // 不能被真实面板复用，否则对话会被绑定到一个临时目录（写入受限、模型上下文错乱）。
      if (typeof row?.cwd === 'string' && isTempCwd(row.cwd)) continue;
      sessions.push({
        sessionId,
        title: titleOfRow(row),
        updatedAt: typeof row?.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      });
      if (sessions.length >= maxSessions) break;
    }
    return { sessions };
  }

  /** 新建个人助理会话；指定 title 时用宿主 `rename` 落成 durable `session/title`。 */
  async function createSession({ botId, title } = {}, signal) {
    const control = requireController('create');
    const requestedTitle = title === undefined || title === null ? undefined : String(title).trim();
    if (requestedTitle !== undefined && Buffer.byteLength(requestedTitle) > TITLE_BYTES) throw fail('DSH_SESSION_TITLE_INVALID', '会话标题过长');
    const bot = chooseBot(botId, undefined);
    const definition = botDefinition(bot);
    const sessionId = `${sessionIdPrefix}${mintSuffix()}`;
    const request = { sessionId, ...(typeof definition?.agentPreset === 'string' && definition.agentPreset ? { agentPreset: definition.agentPreset } : {}) };
    let created;
    try { created = await control.create(request); } catch (error) { throw failure(error, '新建会话'); }
    const createdId = typeof created?.sessionId === 'string' && SESSION_ID.test(created.sessionId) ? created.sessionId : sessionId;
    if (bot) sessionBots.set(createdId, bot);
    if (!requestedTitle) return { sessionId: createdId, title: null };
    const renamer = requireController('rename');
    try {
      const accepted = await renamer.rename({ sessionId: createdId, title: requestedTitle });
      return { sessionId: createdId, title: typeof accepted?.title === 'string' && accepted.title ? accepted.title : requestedTitle };
    } catch (error) { throw failure(error, '设置会话标题'); }
  }

  /** 会话快照：标题 + 最近若干轮消息 + 游标（游标之后的增量由 readEvents 继续拉取）。 */
  async function getSnapshot({ sessionId } = {}, signal) {
    const id = sessionIdOf(sessionId);
    const control = requireController('inspect');
    let inspection;
    try { inspection = await control.inspect(id, signal); } catch (error) { throw failure(error, '读取会话'); }
    const events = Array.isArray(inspection?.events) ? inspection.events : [];
    const messages = [];
    let bytes = 0;
    for (let index = events.length - 1; index >= 0 && messages.length < maxSnapshotMessages; index -= 1) {
      const message = messageEventOf(events[index]);
      if (!message) continue;
      const size = Buffer.byteLength(message.text);
      if (messages.length > 0 && bytes + size > maxSnapshotBytes) break;
      messages.push({ id: message.id, role: message.role, text: message.text, seq: message.seq });
      bytes += size;
    }
    messages.reverse();
    return { sessionId: id, title: titleOfEvents(events), messages, cursor: totalOf(events) };
  }

  /**
   * 游标增量。`cursor` 是 durable 事件位置（不是消息条数）：支持渲染的事件会消费游标，
   * 不支持的事件（工具结果、请求头等）同样**前进**游标但不投递，客户端据 `done` 判断本轮是否还有新事件。
   */
  async function readEvents({ sessionId, cursor = 0 } = {}, signal) {
    const id = sessionIdOf(sessionId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw fail('DSH_CURSOR_INVALID', '游标无效');
    const control = requireController('inspect');
    let inspection;
    try { inspection = await control.inspect(id, signal); } catch (error) { throw failure(error, '读取会话事件'); }
    const events = Array.isArray(inspection?.events) ? inspection.events : [];
    const emitted = [];
    let next = cursor;
    let bytes = 0;
    for (const event of events) {
      const seq = event?.seq;
      if (!Number.isSafeInteger(seq) || seq < 0 || seq < next) continue;
      const message = messageEventOf(event);
      if (message) {
        const size = Buffer.byteLength(message.text);
        if (emitted.length >= maxEventsPerRead || (emitted.length > 0 && bytes + size > maxEventsBytes)) break;
        emitted.push(message);
        bytes += size;
      }
      next = seq + 1;
    }
    return { events: emitted, cursor: next, done: next >= totalOf(events, cursor) };
  }

  /**
   * 提交一轮对话。注入了 turnBridge 时优先用它（Bot 提示词、工具与 Busy 互斥都由 bridge 负责）；
   * 否则回退到原始 `prompt`（无 Bot 语义，供独立 Host / 测试使用）。
   */
  async function submitTurn({ sessionId, botId, text, attachments } = {}, signal) {
    const id = sessionIdOf(sessionId);
    const content = String(text ?? '').trim();
    const images = imageParts(attachments);
    if (!content && images.length === 0) throw fail('DSH_TURN_INPUT_INVALID', '请先输入要发送的内容');
    if (Buffer.byteLength(content) > TURN_BYTES) throw fail('DSH_TURN_INPUT_INVALID', '消息过长，请分段发送', 413);
    const parts = [...(content ? [{ type: 'text', text: content }] : []), ...images];
    const control = requireController('prompt');
    const turnId = mintSuffix();
    const bot = chooseBot(botId, id);
    // 宿主没有配置任何 Bot 时，对话仍然可用：直接走 DSH 会话控制器，
    // 不因为「没有助理」把面板堵死（云端目录里的助理 id 与宿主 Bot 不是同一套命名空间）。
    if (turnBridge && bot) {
      if (turnBridge.available === false) throw new DshSessionControllerUnavailableError();
      botDefinition(bot);
      let result;
      try {
        result = await turnBridge.submitTurn({ botId: bot, sessionId: id, input: content, parts, requestId: turnId, signal });
      } catch (error) { throw turnFailure(error); }
      // dsh-session-bridge 的 busy 标记只在 waitForTurn 的 finally 里释放。面板是「提交即返回 +
      // 轮询事件」的拉模型，不由本通道阻塞等结果，因此这里在后台观察这一轮直到 turn/end，
      // 否则同一会话的第二次提交会被永久判为 DSH_SESSION_BUSY。
      if (typeof turnBridge.waitForTurn === 'function') {
        try {
          const observed = turnBridge.waitForTurn({ botId: bot, sessionId: id, requestId: turnId });
          if (observed && typeof observed.catch === 'function') observed.catch(() => {});
        } catch {}
      }
      return { turnId: typeof result?.requestId === 'string' && SESSION_ID.test(result.requestId) ? result.requestId : turnId, sessionId: id };
    }
    if (bot) sessionBots.set(id, bot);
    let result;
    try {
      result = await control.prompt({ sessionId: id, requestId: turnId, mode: 'queue', content: parts }, signal ?? new AbortController().signal);
    } catch (error) { throw failure(error, '发送消息'); }
    if (result?.accepted !== true) throw fail('DSH_TURN_NOT_ACCEPTED', 'DSH 未接受这一轮对话', 503);
    return { turnId, sessionId: id };
  }

  return Object.freeze({
    get available() {
      const value = controller();
      return Boolean(value && typeof value.inspect === 'function' && typeof value.list === 'function');
    },
    listSessions,
    createSession,
    getSnapshot,
    readEvents,
    submitTurn,
  });
}
