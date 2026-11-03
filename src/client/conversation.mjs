/**
 * 个人助理主面板的对话视图。
 *
 * 数据全部走 Studio Host 的 personal-assistant.* RPC：
 *   sessions.list / session.create / session.snapshot / session.events / turn.submit
 * Host 侧通道尚未就绪时，这里只降级为一条可重试的提示，不抛出、不影响插件激活。
 *
 * ## 本回合进行中的「客户端排队」
 *
 * 服务端在一轮进行中会拒绝第二次 turn.submit（409 DSH_SESSION_BUSY），而一轮思考可能
 * 持续几十秒。因此当「有在途 turn / 助理正在输出」时，发送不直接打 RPC，而是进客户端
 * 待发队列（`queue`），在消息列表里以「已排队，本轮结束后发送」显示，可逐条撤回。
 * 当前回合结束（session.events 的 turns 里不再有 queued/running）后自动发出队首；
 * 每发一条就等它这一轮结束，因此连续多条天然串行，不会互相打断。
 *
 * 边界（有意为之，改动前请先读）：
 * 1. 队列只在内存里，不写 localStorage：刷新页面会丢排队消息，所以队列非空时挂
 *    beforeunload 提示，避免静默丢失。
 * 2. 切换会话（含宿主自动重建会话 id）时丢弃队列并提示：排队消息带原 sessionId，
 *    跨会话续发等于把用户的话发到别的会话里，比丢弃更糟。
 * 3. 兜底：即使客户端误判空闲，云电脑仍可能忙。此时该条消息回到队首并退避重试
 *    （最多 QUEUE_MAX_ATTEMPTS 次），绝不直接丢消息、也不改成"发送失败"吓人。
 * 4. 只有宿主明确报告「没有在途 turn」才推进队列；本地 Host 通道不返回 turns 时
 *    依赖兜底重试，最坏情况是会多试几次，但不会因为排队而丢消息。
 *
 * ## 首屏与授权提示（契约第 4 章第 1–4 条）
 *
 * - 首次进入且没有本地快照时渲染骨架（`data-pa-conversation-skeleton`），不用整页 spinner；
 *   有上次快照时先回显再向云端校准（stale-while-revalidate）。
 * - 支持 `initialSessionId`（列表页历史会话入口）与 `onBack`（返回列表）、
 *   `connectionDot`（页头三态圆点插槽）。
 * - `revokedAt` 非空时在对话流插入一条系统提示「本机授权已撤销」，同一会话只插一条；
 *   撤销发生时对话未挂载也能在下次进入时补上。
 */

import { renderMarkdown } from './markdown.mjs';

/**
 * 宿主 DSH 的 MarkdownText 需要的 chrome 文案（代码块复制/折行、脚注）。
 * 结构对齐 ui-chat 的 markdownLabels()：缺了 code 会在遇到代码块时直接抛错。
 */
const MARKDOWN_LABELS = {
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
  },
  footnotes: '脚注',
};

/**
 * 渲染助理消息正文。
 *
 * 优先用宿主 DSH 暴露的原生 MarkdownText：micromark 解析 + DSH 原生 .markdown 样式，
 * 表格、标题层级、代码高亮、链接行为与 DSH 会话一致，插件不再自己维护解析器。
 * 宿主没有这个模块（老版本）时退回本目录 markdown.mjs 的极简渲染。
 */
export function renderAssistantBody(h, text, styles, markdown) {
  const MarkdownText = markdown?.MarkdownText;
  const source = typeof text === 'string' ? text : '';
  if (typeof MarkdownText === 'function') return h(MarkdownText, { text: source, labels: MARKDOWN_LABELS });
  return renderMarkdown(h, source, styles) || '…';
}

const EMPTY_HINT = '有什么可以帮你？';
/** 这两类失败是“消息根本没开始跑”的瞬时状态：云端现在会按会话排队重试，
 * 历史会话里残留的记录不再渲染成任务失败，避免对话结束后一直显示红色失败。 */
const TRANSIENT_TURN_ERRORS = new Set(['DSH_SESSION_BUSY', 'DSH_TURN_TIMEOUT']);
const TURN_ERROR_TEXT = {
  RUNTIME_PROCESS_INTERRUPTED: '云电脑重启，任务被中断',
  DSH_SESSION_CONTROLLER_UNAVAILABLE: '云端连接暂时不可用，请稍后重试',
  DSH_TURN_NOT_ACCEPTED: '云端没有接受这一轮对话，请重新发送',
  DSH_SESSION_NOT_FOUND: '会话不存在或已被删除',
};
const turnErrorText = error => {
  const value = String(error || '').trim();
  if (!value) return '请检查任务状态后重试';
  if (TURN_ERROR_TEXT[value]) return TURN_ERROR_TEXT[value];
  // 纯大写错误码对用户没有意义；短句/中文错误保持原文。
  return /^[A-Z][A-Z0-9_]{5,}$/u.test(value) ? '云端没有完成这一轮，请重试' : value.slice(0, 160);
};

/** 判定回合结束后稍等再发队首：云端把 turn 标记为 running 有延迟，抢跑会撞 409。 */
const QUEUE_FLUSH_DELAY_MS = 400;
/** 云电脑仍忙时的退避重试上限：超过后交还给用户手动重试（消息内容仍在列表里）。 */
const QUEUE_MAX_ATTEMPTS = 8;
const QUEUE_RETRY_DELAY_MS = 1500;

const styles = {
  page: {
    flex: '1 1 0px', height: '100%', maxHeight: '100%', minHeight: 0, minWidth: 0,
    overflow: 'hidden', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', fontSize: 13,
    color: 'var(--dsw-alias-label-primary, #17202c)', background: 'var(--dsw-alias-bg-layer-1, #fff)',
  },
  header: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 16px',
    borderBottom: '1px solid var(--dsw-alias-border-default, #d8dee8)', flex: 'none',
  },
  title: { margin: 0, fontSize: 14, fontWeight: 600 },
  status: { color: 'var(--dsw-alias-label-secondary, #536174)', fontSize: 12 },
  spacer: { marginLeft: 'auto' },
  ghost: {
    border: '1px solid var(--dsw-alias-border-default, #d8dee8)', background: 'transparent',
    color: 'inherit', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12,
  },
  scroller: { flex: '1 1 0px', minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', boxSizing: 'border-box', padding: '20px 16px 8px' },
  thread: { maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 },
  row: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' },
  rowUser: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' },
  who: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #536174)' },
  bubble: {
    maxWidth: '86%', padding: '9px 12px', borderRadius: 12, lineHeight: 1.7,
    overflowWrap: 'anywhere', display: 'flex', flexDirection: 'column', gap: 8,
    // 主题 token 在浅色下都是纯白，用 currentColor 混色才能在明暗主题里都有轮廓。
    background: 'color-mix(in srgb, currentColor 5%, transparent)',
  },
  paragraph: { margin: 0, whiteSpace: 'pre-wrap' },
  heading: { fontWeight: 600, fontSize: 13.5 },
  headingStrong: { fontSize: 15 },
  list: { margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 },
  codeBlock: {
    margin: 0, padding: '10px 12px', borderRadius: 8, overflowX: 'auto', fontSize: 12, lineHeight: 1.65,
    background: 'color-mix(in srgb, currentColor 9%, transparent)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  inlineCode: {
    padding: '1px 5px', borderRadius: 5, fontSize: 12,
    background: 'color-mix(in srgb, currentColor 9%, transparent)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  quote: { margin: 0, paddingLeft: 10, borderLeft: '3px solid var(--dsw-alias-border-default, #d8dee8)', color: 'var(--dsw-alias-label-secondary, #536174)' },
  rule: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-default, #d8dee8)', margin: '2px 0', width: '100%' },
  link: { color: '#2f6bff', textDecoration: 'none' },
  bubbleUser: {
    maxWidth: '86%', padding: '9px 12px', borderRadius: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', background: 'color-mix(in srgb, #2f6bff 12%, transparent)',
  },
  pulse: { animation: 'pa-awaiting 1.2s ease-in-out infinite' },
  step: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #536174)', lineHeight: 1.7, overflowWrap: 'anywhere' },
  centered: { flex: 1, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' },
  centeredInner: { maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' },
  composer: { flex: '0 0 auto', minWidth: 0, boxSizing: 'border-box', padding: '8px 16px 14px' },
  composerInner: {
    maxWidth: 720, minWidth: 0, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-default, #d8dee8)', borderRadius: 16, padding: '10px 10px 8px 12px',
    background: 'var(--dsw-alias-bg-layer-1, #fff)',
  },
  textarea: {
    flex: 1, width: '100%', minWidth: 0, boxSizing: 'border-box', minHeight: 24, maxHeight: 200, resize: 'none', border: 'none', outline: 'none',
    background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, lineHeight: 1.7,
  },
  composerBar: { display: 'flex', alignItems: 'center', gap: 8 },
  iconButton: {
    flex: 'none', width: 28, height: 28, display: 'grid', placeItems: 'center', cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-default, #d8dee8)', borderRadius: 999,
    background: 'transparent', color: 'var(--dsw-alias-label-secondary, #536174)', padding: 0,
  },
  send: {
    flex: 'none', width: 28, height: 28, display: 'grid', placeItems: 'center', border: 'none', borderRadius: 999,
    cursor: 'pointer', padding: 0, background: 'var(--dsw-alias-label-primary, #17202c)',
    color: 'var(--dsw-alias-bg-layer-1, #fff)',
  },
  sendDisabled: { background: 'var(--dsw-alias-border-default, #d8dee8)', color: 'var(--dsw-alias-label-secondary, #536174)', cursor: 'default' },
  // 排队中的快捷入口：不是禁用态，而是"可继续排队"的强调态，避免看起来点不动。
  sendQueued: {
    flex: 'none', width: 28, height: 28, display: 'grid', placeItems: 'center', borderRadius: 999, cursor: 'pointer', padding: 0,
    border: '1px dashed var(--dsw-alias-label-primary, #17202c)', background: 'transparent',
    color: 'var(--dsw-alias-label-primary, #17202c)',
  },
  queueBadge: {
    flex: 'none', borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '18px',
    background: 'color-mix(in srgb, #946200 14%, transparent)', color: '#946200',
  },
  queueBubble: {
    maxWidth: '86%', padding: '9px 12px', borderRadius: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', border: '1px dashed color-mix(in srgb, currentColor 35%, transparent)',
    background: 'color-mix(in srgb, currentColor 4%, transparent)',
    color: 'var(--dsw-alias-label-secondary, #536174)',
  },
  queueRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' },
  queueHint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #536174)' },
  queueCancel: {
    border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', borderRadius: 6,
    color: 'var(--dsw-alias-label-secondary, #536174)', display: 'inline-flex', alignItems: 'center', gap: 3, font: 'inherit', fontSize: 11,
  },
  queueNotice: { maxWidth: 720, margin: '0 auto 6px', fontSize: 12, color: '#946200', lineHeight: 1.6 },
  attach: {
    flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px 3px 4px', borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-2, #f4f6fa)', fontSize: 11, maxWidth: 180,
  },
  attachName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  attachThumb: { width: 20, height: 20, borderRadius: 4, objectFit: 'cover', flex: 'none' },
  attachRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
};

const text = value => (typeof value === 'string' ? value : '');

const SESSION_POINTER_PREFIX = 'agentkit.personal-assistant.current-session.v1';
const sessionPointerKey = scope => {
  const agentId = text(scope?.agentId), botId = text(scope?.botId);
  return agentId && botId ? `${SESSION_POINTER_PREFIX}:${encodeURIComponent(agentId)}:${encodeURIComponent(botId)}` : '';
};
const readSessionPointer = scope => {
  const key = sessionPointerKey(scope);
  if (!key) return '';
  try { return text(globalThis.localStorage?.getItem(key)); } catch { return ''; }
};
const writeSessionPointer = (scope, sessionId) => {
  const key = sessionPointerKey(scope), value = text(sessionId);
  if (!key || !value) return;
  try { globalThis.localStorage?.setItem(key, value); } catch { /* 宿主可能禁用存储，不影响云端会话 */ }
};
const clearSessionPointer = scope => {
  const key = sessionPointerKey(scope);
  if (!key) return;
  try { globalThis.localStorage?.removeItem(key); } catch { /* 宿主可能禁用存储 */ }
};
const sessionFailure = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

/**
 * 本地快照缓存（stale-while-revalidate）：面板重新打开时先画上次看到的历史，再向云端
 * 校准。只缓存渲染需要的最小结构，并容忍存储不可用：配额满、隐私模式、宿主禁用
 * localStorage 都静默退化成「没有缓存」，绝不能因此打断真正的会话。
 */
const SESSION_SNAPSHOT_VERSION = 1;
const SESSION_SNAPSHOT_LIMIT = 50;
const SESSION_SNAPSHOT_TEXT_LIMIT = 4000;
const SESSION_SNAPSHOT_BYTES_LIMIT = 256 * 1024;
const SESSION_SNAPSHOT_WRITE_INTERVAL_MS = 1500;
// 与 sessionPointerKey 共用 PREFIX 与 scope 编码，避免两套 key 规则各自漂移。
const sessionSnapshotKey = (scope, sessionId) => {
  const base = sessionPointerKey(scope), id = text(sessionId);
  return base && id ? `${base}:snapshot:${encodeURIComponent(id)}` : '';
};
const byteLength = value => (typeof TextEncoder === 'function' ? new TextEncoder().encode(value).length : value.length);
const removeSessionSnapshot = (scope, sessionId) => {
  const key = sessionSnapshotKey(scope, sessionId);
  if (!key) return;
  try { globalThis.localStorage?.removeItem(key); } catch { /* 宿主可能禁用存储 */ }
};
const readSessionSnapshot = (scope, sessionId) => {
  const key = sessionSnapshotKey(scope, sessionId);
  if (!key) return null;
  let raw;
  try { raw = globalThis.localStorage?.getItem(key); } catch { return null; }
  if (!raw) return null;
  try {
    // 体积/结构任何一项不合法都整体丢弃，不做部分修复，避免坏数据反复渲染。
    if (byteLength(raw) >= SESSION_SNAPSHOT_BYTES_LIMIT) throw new Error('oversized snapshot');
    const value = JSON.parse(raw);
    if (value?.version !== SESSION_SNAPSHOT_VERSION || value.sessionId !== text(sessionId)
      || !Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > SESSION_SNAPSHOT_LIMIT) throw new Error('invalid snapshot');
    const messages = value.messages.map((row, index) => ({
      id: text(row?.id) || `history-${index}`,
      role: ['user', 'assistant', 'step'].includes(text(row?.role)) ? text(row?.role) : 'assistant',
      text: text(row?.text),
      done: true,
    }));
    if (messages.every(row => !row.text)) throw new Error('empty snapshot');
    return { messages };
  } catch {
    removeSessionSnapshot(scope, sessionId);
    return null;
  }
};
const writeSessionSnapshot = (scope, sessionId, messages) => {
  const key = sessionSnapshotKey(scope, sessionId);
  if (!key) return;
  const rows = (Array.isArray(messages) ? messages : [])
    .filter(row => row && text(row.text))
    .slice(-SESSION_SNAPSHOT_LIMIT)
    .map(row => ({ id: text(row.id), role: text(row.role) || 'assistant', text: text(row.text).slice(0, SESSION_SNAPSHOT_TEXT_LIMIT) }));
  // 空会话不写缓存：下次打开照样要校准，写一份空快照只会占存储。
  if (rows.length === 0) return;
  try {
    const raw = JSON.stringify({ version: SESSION_SNAPSHOT_VERSION, sessionId: String(sessionId), savedAt: Date.now(), messages: rows });
    if (byteLength(raw) >= SESSION_SNAPSHOT_BYTES_LIMIT) { removeSessionSnapshot(scope, sessionId); return; }
    globalThis.localStorage?.setItem(key, raw);
  } catch { /* 配额满/隐私模式：静默降级为无缓存 */ }
};
const sameSnapshotMessages = (before, after) => Array.isArray(before) && before.length === after.length
  && after.every((row, index) => before[index]?.id === row.id && before[index]?.role === row.role && before[index]?.text === row.text);

/** 与 DSH 原生对话框一致的发送箭头。 */
const sendGlyph = h => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M12 19V5M5 12l7-7 7 7' }));
const plusGlyph = h => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true },
  h('path', { d: 'M12 5v14M5 12h14' }));
const closeGlyph = h => h('svg', { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', 'aria-hidden': true },
  h('path', { d: 'M6 6l12 12M18 6L6 18' }));

/**
 * 首屏骨架：与真实气泡同构（用户气泡靠右、助理正文靠左），
 * 数据到后整块替换，避免整页 spinner 或空白闪一下。
 */
const conversationSkeleton = h => {
  const bone = (key, width, height, extra = null) => h('span', {
    key, 'aria-hidden': 'true',
    style: { display: 'block', width, height, borderRadius: height >= 20 ? 12 : 6, background: '#e5e9f0', animation: 'pa-skeleton 1.4s ease-in-out infinite', ...(extra || {}) },
  });
  const rows = [];
  for (let index = 0; index < 3; index += 1) {
    rows.push(h('div', { key: `user-${index}`, style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 } },
      bone('who', 34, 10), bone('bubble', index === 0 ? '62%' : '48%', 34, { background: 'color-mix(in srgb, #2f6bff 10%, transparent)', animation: 'none' })));
    rows.push(h('div', { key: `assistant-${index}`, style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 } },
      bone('who', 28, 10), bone('line-1', `${78 - index * 12}%`, 12), bone('line-2', `${58 - index * 8}%`, 12)));
  }
  return h('div', { 'data-pa-conversation-skeleton': 'true', 'aria-hidden': 'true', style: { display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 8 } }, rows);
};

export function PersonalAssistantConversation({ React: R, request, scope, markdown = undefined, onOpenComputer = null, onBack = null, initialSessionId = '', revokedAt = '', connectionDot = null } = {}) {
  if (!R) return '个人助理对话尚未就绪，请重新打开';
  const { createElement: h, useCallback, useEffect, useRef, useState } = R;
  const [phase, setPhase] = useState('loading');
  // 本地快照只是「先画出来」；calibrated 表示云端 snapshot 已经回来、cursor 可信。
  // 校准前不启动 session.events 轮询，避免拿缓存里的旧 cursor 去撞 SESSION_CURSOR_STALE。
  const [calibrated, setCalibrated] = useState(false);
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const [runtimeInstanceId, setRuntimeInstanceId] = useState('');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState([]);
  const fileRef = useRef(null);
  const [sending, setSending] = useState(false);
  // 回合已提交、助理还没出第一条消息时的等待态：不给反馈会让人以为没发出去。
  const [awaiting, setAwaiting] = useState(false);
  const [progressText, setProgressText] = useState('');
  // 本轮进行中收到的消息：只存在内存里，本轮结束后逐条发出（见文件头注释的边界说明）。
  const [queue, setQueue] = useState([]);
  const [queueNotice, setQueueNotice] = useState('');
  // 撤销本机授权后的系统提示：只在下一次进入面板前留在本次对话流里，
  // 不写本地快照（它描述的是本机状态，不属于云端会话内容）。
  const [systemNotices, setSystemNotices] = useState([]);
  const cursorRef = useRef(0);
  const outboxRef = useRef(new Map());
  const queueRef = useRef([]);
  const flushingRef = useRef(false);
  const retryTimerRef = useRef(null);
  // 事件轮询/定时器回调里要读到最新值，避免用首次渲染的闭包判断"忙不忙"。
  const sendingRef = useRef(false); sendingRef.current = sending;
  const awaitingRef = useRef(false); awaitingRef.current = awaiting;
  const phaseRef = useRef('loading'); phaseRef.current = phase;
  const generationRef = useRef(0);
  const aliveRef = useRef(true);
  const scrollerRef = useRef(null);
  const followLatestRef = useRef(true);
  const sessionRef = useRef('');
  sessionRef.current = sessionId;
  const messagesRef = useRef([]);
  messagesRef.current = messages;
  const snapshotWriteAtRef = useRef(0);
  const pollTraceTicksRef = useRef(0);
  // 记录上一次的授权状态：只有 true → false 才是「撤销」，
  // 首次挂载时 already-false 不算撤销，不插系统提示。

  const call = useCallback(async (operation, payload = {}) => {
    if (typeof request !== 'function') throw new Error('Studio Host 尚未连接');
    const startedAt = Date.now();
    try {
      return await request(operation, payload);
    } finally {
      // 打点：与 Host 侧同一条 event，只输出操作名与耗时，参数与凭据不落日志。
      // session.events 轮询只留慢请求与 1/20 采样，避免刷屏（口径与 Host 侧一致）。
      try {
        const totalMs = Date.now() - startedAt;
        const poll = operation === 'personal-assistant.session.events';
        if (poll) pollTraceTicksRef.current += 1;
        if (!poll || totalMs >= 300 || pollTraceTicksRef.current % 20 === 0) {
          console.info(JSON.stringify({ event: 'personal-assistant.rpc', operation, source: 'client', totalMs }));
        }
      } catch { /* 打点绝不能影响请求本身 */ }
    }
  }, [request]);

  const mergeEvents = useCallback(events => {
    if (!Array.isArray(events) || events.length === 0) return;

    setMessages(previous => {
      const next = [...previous];
      for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'message') {
          const id = text(event.id) || `local-${next.length}`;
          const role = text(event.role) || 'assistant';
          const body = text(event.text);
          const index = next.findIndex(item => item.id === id);
          const message = { id, role, text: body, done: event.done !== false, clientTurnId: event.clientTurnId, status: 'accepted' };
          if (index >= 0) next[index] = { ...next[index], ...message };
          else if (role === 'user') {
            // 本地乐观消息与服务端 durable 消息是同一条：认领服务端 id，避免气泡出现两次。
            const optimistic = next.findIndex(item => item.role === 'user' && event.clientTurnId && item.clientTurnId === event.clientTurnId);
            if (optimistic >= 0) next[optimistic] = { ...message };
            else next.push(message);
          } else next.push(message);
        } else if (event.type === 'delta') {
          const id = text(event.id) || `local-${next.length}`;
          const index = next.findIndex(item => item.id === id);
          if (index >= 0) next[index] = { ...next[index], text: next[index].text + text(event.text) };
          else next.push({ id, role: 'assistant', text: text(event.text), done: false });
        } else if (event.type === 'step' && text(event.text)) {
          const step = { id: text(event.id), role: 'step', text: text(event.text), done: true };
          const index = next.findIndex(item => item.id === step.id);
          if (index >= 0) next[index] = step; else next.push(step);
        }
      }
      return next;
    });
  }, []);

  const openSession = useCallback(async id => {
    if (!id) return;
    // 排队消息带原 sessionId：切到别的会话后继续发等于把用户的话发错地方，所以丢弃并提示。
    // （刷新页面同样丢弃：队列只在内存里，靠 beforeunload 提示用户别在刷新上踩雷。）
    const previousSession = sessionRef.current;
    if (previousSession && previousSession !== id && queueRef.current.length > 0) {
      const dropped = queueRef.current.length;
      queueRef.current = []; setQueue([]);
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      setQueueNotice(`已切换会话，${dropped} 条排队消息未发送，已取消`);
    } else if (previousSession && previousSession !== id) setQueueNotice('');
    sessionRef.current = id;
    const generation = ++generationRef.current;
    setSessionId(id);
    setPhase('loading');
    setError('');
    setCalibrated(false);
    cursorRef.current = 0;
    followLatestRef.current = true;
    setMessages([]);
    // 先回显本地快照（stale-while-revalidate）：网络快时几乎无感，慢时用户立刻看到历史。
    // 只按 scope+sessionId 命中；应用新快照时仍走 aliveRef/sessionRef/generation 三重守卫。
    const cached = readSessionSnapshot(scope, id);
    if (cached) {
      setMessages(cached.messages);
      setPhase('ready');
    }
    try {
      const snapshot = await call('personal-assistant.session.snapshot', { sessionId: id });
      if (!aliveRef.current || sessionRef.current !== id || generation !== generationRef.current) return;
      setRuntimeInstanceId(text(snapshot?.runtimeInstanceId));
      cursorRef.current = Number(snapshot?.cursor) || 0;
      const history = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
      const calibratedMessages = history.map((message, index) => ({
        id: text(message?.id) || `history-${index}`,
        role: text(message?.role) || 'assistant',
        text: text(message?.text),
        done: true,
      }));
      // 与回显内容一致就不重建数组，避免历史区整块替换导致的闪烁。
      if (!sameSnapshotMessages(cached?.messages, calibratedMessages)) setMessages(calibratedMessages);
      setAwaiting(snapshot.turns?.some(turn => ['queued', 'running'].includes(turn.status)) || false);
      writeSessionPointer(scope, id);
      if (calibratedMessages.length > 0) writeSessionSnapshot(scope, id, calibratedMessages);
      else removeSessionSnapshot(scope, id);
      snapshotWriteAtRef.current = Date.now();
      setPhase('ready');
      setCalibrated(true);
    } catch (failure) {
      if (!aliveRef.current || generation !== generationRef.current) return;
      if (['SESSION_NOT_FOUND', 'DSH_SESSION_NOT_FOUND'].includes(String(failure?.code || ''))) {
        clearSessionPointer(scope);
        removeSessionSnapshot(scope, id);
        setMessages([]);
      }
      setPhase('error');
      setError(failure?.message || '无法读取会话内容');
    }
  }, [call, scope]);

  const createSession = useCallback(async () => {
    if (!aliveRef.current) return;
    if (sendingRef.current || awaitingRef.current || queueRef.current.length > 0) {
      setQueueNotice('当前会话还有进行中的任务，请等待完成后再新建会话');
      return;
    }
    setPhase('loading');
    setError('');
    try {
      const created = await call('personal-assistant.session.create', {});
      const createdId = text(created?.sessionId);
      if (!createdId) throw sessionFailure('PERSONAL_ASSISTANT_SESSION_CREATE_INVALID', '云端没有返回有效的新会话标识');
      setSessions(previous => [...previous.filter(row => text(row?.sessionId) !== createdId), { sessionId: createdId, title: text(created?.title) || '新会话' }]);
      await openSession(createdId);
    } catch (failure) {
      if (!aliveRef.current) return;
      setPhase('error');
      setError(failure?.message || '新会话创建失败，请重试');
    }
  }, [call, openSession]);

  const bootstrap = useCallback(async () => {
    setPhase('loading');
    setError('');
    if (!aliveRef.current) return;
    // stale-while-revalidate：上次成功打开过的会话先按本地快照画出来，
    // 再向云端 sessions.list / snapshot 校准。命中缓存时首屏不是骨架、也不是空白。
    const cachedSessionId = text(initialSessionId) || readSessionPointer(scope);
    const cached = cachedSessionId ? readSessionSnapshot(scope, cachedSessionId) : null;
    if (cachedSessionId && cached) {
      sessionRef.current = cachedSessionId;
      setSessionId(cachedSessionId);
      setMessages(cached.messages);
      setPhase('ready');
    }
    try {
      const listed = await call('personal-assistant.sessions.list');
      if (!aliveRef.current) return;
      if (!Array.isArray(listed?.sessions)) throw sessionFailure('PERSONAL_ASSISTANT_SESSION_LIST_INVALID', '云端会话目录格式无效，请重试');
      if (listed.sessions.some(row => !row || typeof row !== 'object' || !text(row.sessionId))) {
        throw sessionFailure('PERSONAL_ASSISTANT_SESSION_LIST_INVALID', '云端会话目录包含无效会话，请重试');
      }
      const available = listed.sessions;
      setRuntimeInstanceId(text(listed.runtimeInstanceId));
      setSessions(available);
      if (available.length > 0) {
        // 打开优先级：列表页点进来的指定会话 > 上次打开的会话 > 目录第一条。
        const preferred = text(initialSessionId) || readSessionPointer(scope);
        const selected = available.find(row => text(row.sessionId) === preferred) || available[0];
        await openSession(text(selected.sessionId));
        return;
      }
      // 历史会话入口指定的会话可能还没出现在目录里（目录有分页/延迟），直接按 id 打开。
      if (text(initialSessionId)) { await openSession(text(initialSessionId)); return; }
      // 有过成功打开的会话却突然拿到空目录，通常是 PVC/状态目录/Bot 范围出了问题。
      // 不再静默创建一个空会话；用户可以通过头部的“新会话”显式确认创建。
      if (readSessionPointer(scope)) throw sessionFailure('PERSONAL_ASSISTANT_SESSION_STATE_MISSING', '云端历史会话暂时不可见，请检查实例状态后重试');
      await createSession();
    } catch (failure) {
      if (!aliveRef.current) return;
      setPhase('error');
      setError(failure?.message || '会话通道暂时不可用');
    }
  }, [call, createSession, initialSessionId, openSession, scope]);

  useEffect(() => {
    aliveRef.current = true;
    void bootstrap();
    return () => {
      aliveRef.current = false;
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    };
  }, [bootstrap]);

  // 撤销本机授权：在对话流插入一条系统提示（契约第 4 章第 4 条）。
  // revokedAt 由面板外壳维护，同一会话里只插一条；撤销后首次进入对话也会补上。
  useEffect(() => {
    if (!revokedAt) return;
    setSystemNotices(list => list.some(row => row.id === 'local-access-revoked')
      ? list
      : [...list, { id: 'local-access-revoked', text: '本机授权已撤销' }]);
  }, [revokedAt]);

  // 事件增量：宿主侧按 cursor 返回增量，空增量也要前进 cursor。
  // 本地快照回显后 cursor 还不可信，必须等 snapshot 校准完（calibrated）再开轮询。
  useEffect(() => {
    if (phase !== 'ready' || !sessionId || !calibrated) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const page = await call('personal-assistant.session.events', { sessionId, cursor: cursorRef.current });
        if (cancelled) return;
        cursorRef.current = Number(page?.cursor ?? cursorRef.current) || 0;
        mergeEvents(page?.events);
        if (Array.isArray(page.turns)) {
          setAwaiting(page.turns.some(turn => ['queued', 'running'].includes(turn.status)));
          const active = page.turns.findLast(turn => ['queued', 'running'].includes(turn.status));
          const labels = { cloud_computer: '操作云电脑', cloud_workspace: '处理云端文件', cloud_bash: '执行云端命令', cloud_run_code: '运行云端代码', assistant_schedule: '设置云端任务' };
          const tool = active?.progress?.tool;
          setProgressText(tool ? `${active.progress.state === 'running' ? '正在' : '已完成'}${labels[tool] || (tool.startsWith('cloud_browser_') ? '操作云端浏览器' : '执行工具')}` : '');
          const visibleFailures = page.turns
            .filter(turn => ['failed', 'interrupted', 'cancelled'].includes(turn.status) && !TRANSIENT_TURN_ERRORS.has(String(turn.error || '')))
            .map(turn => ({ type: 'step', id: `turn-status-${turn.turnId}`, text: `任务${turn.status === 'failed' ? '失败' : '已中断'}：${turnErrorText(turn.error)}` }));
          mergeEvents(visibleFailures);
        }
        setError('');
      } catch (failure) {
        if (!cancelled) {
          if (failure.code === 'SESSION_CURSOR_STALE') { void openSession(sessionId); return; }
          setError(failure.message || '云端连接中断，正在恢复；任务不会改到本机执行');
        }
      }
      if (!cancelled) timer = setTimeout(tick, 600);
    };
    timer = setTimeout(tick, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [phase, sessionId, call, mergeEvents, openSession, calibrated]);

  // 增量到达后节流落一次本地快照；写失败静默降级（见 writeSessionSnapshot）。
  useEffect(() => {
    if (!calibrated || phase !== 'ready' || !sessionId) return;
    const now = Date.now();
    if (now - snapshotWriteAtRef.current < SESSION_SNAPSHOT_WRITE_INTERVAL_MS) return;
    snapshotWriteAtRef.current = now;
    writeSessionSnapshot(scope, sessionId, messagesRef.current);
  }, [messages, calibrated, phase, sessionId, scope]);

  useEffect(() => {
    // 只移动自己拥有的消息区，不能让 scrollIntoView 连带滚动宿主和输入框。
    const scroller = scrollerRef.current;
    if (scroller && followLatestRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, awaiting]);

  const pickFiles = async event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    const loaded = [];
    for (const file of files.slice(0, 4)) {
      if (!file || file.size > 512 * 1024) { setError('每个附件最多 512 KiB，请先压缩或拆分文件'); continue; }
      const dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
      if (!dataUrl) continue;
      loaded.push({ id: `${Date.now()}-${file.name}`, name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, dataUrl });
    }
    if (loaded.length) setAttachments(previous => [...previous, ...loaded].slice(0, 4));
  };

  const commitQueue = next => { queueRef.current = next; setQueue(next); };
  const clearRetryTimer = () => { if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; } };
  // 409 不一定都是"忙"，但把 409 当忙处理最坏只是多退避几次；反过来误判成失败会直接吞掉用户消息。
  const isBusyFailure = failure => Number(failure?.status) === 409
    || /SESSION_BUSY|active turn|正忙|处理中/u.test(`${failure?.code || ''} ${failure?.message || ''}`);

  /** 真正发一轮：乐观气泡 → 上传待发附件 → turn.submit；失败原因交回排队层决定重试还是报错。 */
  const sendTurn = async (item, { restoreDraft = false } = {}) => {
    outboxRef.current.set(item.clientTurnId, item);
    followLatestRef.current = true;
    setSending(true); setError(''); setAwaiting(true);
    setMessages(previous => previous.some(row => row.clientTurnId === item.clientTurnId)
      ? previous.map(row => row.clientTurnId === item.clientTurnId ? { ...row, status: 'pending' } : row)
      : [...previous, { id: `local-user-${item.clientTurnId}`, clientTurnId: item.clientTurnId, role: 'user', text: item.text, done: false, status: 'pending' }]);
    let current = item;
    try {
      let attachments = Array.isArray(current.attachments) ? current.attachments : [];
      if (attachments.length === 0 && Array.isArray(current.uploads) && current.uploads.length > 0) {
        const uploaded = [];
        for (const upload of current.uploads) uploaded.push(await call('personal-assistant.file.upload', { sessionId: current.sessionId, name: upload.name, dataUrl: upload.dataUrl }));
        attachments = uploaded.map(({ path, name, mediaType, bytes }) => ({ path, name, mediaType, bytes }));
        // 上传结果回写到重试项上：重试时只重发 turn.submit，不再重复上传。
        current = { ...current, attachments, uploads: [] };
        outboxRef.current.set(current.clientTurnId, current);
      }
      const receipt = await call('personal-assistant.turn.submit', { sessionId: current.sessionId, text: current.text, clientTurnId: current.clientTurnId, attachments });
      if (!aliveRef.current) return { ok: true, item: current };
      outboxRef.current.delete(current.clientTurnId);
      setMessages(previous => previous.map(row => row.clientTurnId === current.clientTurnId ? { ...row, status: 'accepted', turnId: receipt.turnId } : row));
      return { ok: true, item: current };
    } catch (failure) {
      if (!aliveRef.current) return { ok: false, failure, item: current };
      // 忙：说明服务端认为还有回合在跑，保持"进行中"而不是假装失败；其余失败才复位等待态。
      setAwaiting(isBusyFailure(failure));
      // 忙失败会转成排队（内容已在气泡里），不再同时塞回输入框，避免一份内容出现两处。
      if (restoreDraft && !isBusyFailure(failure)) setDraft(value => value || current.text);
      setMessages(previous => previous.map(row => row.clientTurnId === current.clientTurnId ? { ...row, status: 'failed', failure: failure.message || '发送结果待确认，重试将复用原标识' } : row));
      return { ok: false, failure, item: current };
    } finally { if (aliveRef.current) setSending(false); }
  };

  /** 没发出去的消息回到队首退避重试；到上限就把内容还给输入框，绝不静默丢弃。 */
  const requeueForRetry = (item, failure) => {
    const attempts = (item.attempts || 0) + 1;
    outboxRef.current.delete(item.clientTurnId);
    setMessages(previous => previous.filter(row => row.clientTurnId !== item.clientTurnId));
    if (attempts > QUEUE_MAX_ATTEMPTS) {
      setQueueNotice(`排队消息多次未发出（${failure?.message || '云电脑仍忙'}），已放回输入框，请手动重试`);
      setDraft(value => value || item.text);
      return;
    }
    commitQueue([{ ...item, attempts }, ...queueRef.current]);
    const wait = (QUEUE_RETRY_DELAY_MS * Math.min(attempts, 3) / 1000).toFixed(1);  // 1.5 / 3.0 / 4.5 秒
    setQueueNotice(`云电脑仍在处理上一轮，消息已排队，约 ${wait} 秒后自动重发`);
    clearRetryTimer();
    retryTimerRef.current = setTimeout(() => { retryTimerRef.current = null; void attemptQueuedHead(true); }, QUEUE_RETRY_DELAY_MS * Math.min(attempts, 3));
  };

  /** 取队首发出。force=true 是退避重试：绕过 awaiting 守卫，但仍要求会话一致。 */
  const attemptQueuedHead = async force => {
    const session = sessionRef.current;
    if (flushingRef.current || !aliveRef.current || phaseRef.current !== 'ready' || !session) return false;
    if (sendingRef.current) return false;  // 已有提交在途时一律不抢，避免重复提交
    if (!force && awaitingRef.current) return false;
    const head = queueRef.current[0];
    if (!head) return false;
    if (head.sessionId !== session) { commitQueue([]); setQueueNotice('会话已变化，排队消息未发送'); return false; }
    flushingRef.current = true;
    commitQueue(queueRef.current.slice(1));
    try {
      const result = await sendTurn(head);
      if (result.ok) return true;
      if (isBusyFailure(result.failure)) requeueForRetry(result.item || head, result.failure);
      else setQueueNotice(`排队消息发送失败：${result.failure?.message || '请点击重试'}`);
      return false;
    } finally { flushingRef.current = false; }
  };

  const cancelQueued = clientTurnId => {
    outboxRef.current.delete(clientTurnId);
    commitQueue(queueRef.current.filter(item => item.clientTurnId !== clientTurnId));
    setQueueNotice('已撤回排队消息');
  };

  const submit = async (retryItem = null) => {
    if (phase !== 'ready' || !sessionId) return;
    if (retryItem) { if (!sending) void sendTurn(retryItem, { restoreDraft: true }); return; }
    const content = draft.trim() || (attachments.length ? '请查看附件。' : '');
    if (!content) return;
    const uploads = attachments.map(({ name, mimeType, size, dataUrl }) => ({ name, mimeType, size, dataUrl }));
    // 本轮还在进行：只入队，不打 turn.submit —— 服务端此时必定 409，排队才不会让用户看到"任务失败"。
    if (sending || awaiting) {
      commitQueue([...queueRef.current, { clientTurnId: crypto.randomUUID(), text: content, sessionId, uploads, attempts: 0, queuedAt: Date.now() }]);
      followLatestRef.current = true;
      setDraft(''); setAttachments([]); setError(''); setQueueNotice('');
      return;
    }
    setDraft(''); setAttachments([]); setError(''); setQueueNotice('');
    const result = await sendTurn({ clientTurnId: crypto.randomUUID(), text: content, sessionId, uploads, attempts: 0 }, { restoreDraft: true });
    if (!result.ok && isBusyFailure(result.failure)) requeueForRetry(result.item, result.failure);
  };

  // 回合结束（events 的 turns 回到空闲）后自动推进队列：每发一条就等它这一轮结束，连续多条自然串行。
  useEffect(() => {
    if (phase !== 'ready' || !sessionId || sending || awaiting || queue.length === 0) return undefined;
    // 延后一拍：云端把 turn 标成 running 有延迟，刚结束就抢发容易撞 409（撞了会退避重试）。
    const timer = setTimeout(() => { void attemptQueuedHead(false); }, QUEUE_FLUSH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase, sessionId, sending, awaiting, queue]);

  // 队列不落盘：刷新会丢排队消息，因此在有排队内容时拦住一次误刷新（见文件头"边界"）。
  useEffect(() => {
    if (queue.length === 0 || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [queue.length]);

  // Studio(macOS) 的拖拽区靠 data-window-drag 标记：PA 页面没有外壳 tab strip，需要自己的头部行。
  const header = h('header', { style: { ...styles.header, minHeight: 52, padding: '8px 16px', gap: 8 }, 'data-window-drag': '' },
    typeof onBack === 'function' ? h('button', {
      type: 'button', 'aria-label': '返回', title: '返回 Bot 列表', 'data-window-drag-recall': '', onClick: onBack,
      style: { flex: 'none', width: 28, height: 28, display: 'grid', placeItems: 'center', padding: 0, border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-secondary, #536174)', cursor: 'pointer' },
    }, h('svg', { 'aria-hidden': 'true', width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none' }, h('path', { d: 'M9.8 3.4 5.2 8l4.6 4.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))) : null,
    h('h1', { style: styles.title }, '个人助理'),
    h('span', { style: styles.status }, phase === 'ready' ? '云端常驻，关掉窗口也会继续' : phase === 'loading' ? '正在连接…' : '连接不可用'),
    h('span', { style: styles.spacer }),
    connectionDot || null,
    h('button', { type: 'button', 'data-window-drag-recall': '', disabled: phase === 'loading' || sending || awaiting || queue.length > 0, onClick: () => void createSession(), 'aria-label': '新建会话', title: queue.length > 0 ? '请等待排队消息发送后再新建会话' : '新建云端会话', style: styles.ghost }, '新会话'),
    onOpenComputer ? h('button', { type: 'button', 'data-window-drag-recall': '', onClick: onOpenComputer, 'aria-label': '打开云电脑侧栏', title: '打开或重新打开云电脑侧栏', style: { ...styles.ghost, display: 'inline-flex', alignItems: 'center', gap: 6 } }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }), h('path', { d: 'M8 21h8M12 17v4' })), '云电脑') : null);

  return h('section', { 'data-personal-assistant-conversation': 'true', 'data-agent-id': text(scope?.agentId) || undefined, 'data-bot-id': text(scope?.botId) || undefined, 'data-session-id': sessionId || undefined, 'data-runtime-instance-id': runtimeInstanceId || undefined, style: styles.page, onClick: async event => {
    const link = event.target.closest?.('a[href^="cloud-file:"]');
    if (!link) return;
    event.preventDefault();
    try {
      const value = await call('personal-assistant.file.download', { sessionId, path: decodeURIComponent(link.getAttribute('href').slice('cloud-file:'.length)) });
      const bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const download = document.createElement('a'); download.href = url; download.download = value.name; download.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(failure.message || '云端文件下载失败'); }
  } }, header,
    h('style', null, '@keyframes pa-awaiting { 0%, 100% { opacity: 0.35 } 50% { opacity: 1 } }@keyframes pa-skeleton { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }'),
    error && messages.length > 0 ? h('div', { role: 'alert', style: { padding: '8px 16px', background: '#fff0d6' } }, error) : null,
    h('div', { ref: scrollerRef, 'data-personal-assistant-messages': 'true', style: styles.scroller, onScroll: event => {
      const element = event.currentTarget;
      followLatestRef.current = element.scrollHeight - element.clientHeight - element.scrollTop < 64;
    } },
      h('div', { style: styles.thread },
        messages.length === 0
          ? (phase === 'error' ? h('div', { style: { ...styles.centeredInner, margin: '0 auto', paddingTop: 40 } },
            h('strong', null, '暂时连不上个人助理'), h('span', { style: styles.status }, error || '请稍后重试'),
            h('button', { style: styles.ghost, onClick: () => void bootstrap() }, '重试'))
            : phase === 'loading' ? conversationSkeleton(h) : h('div', { style: { ...styles.status, paddingTop: 40, textAlign: 'center' } }, EMPTY_HINT))
          : null,
        messages.map(message => {
          if (message.role === 'step') return h('div', { key: message.id, style: styles.step }, `· ${message.text}`);
          const mine = message.role === 'user';
          return h('div', { key: message.id, style: mine ? styles.rowUser : styles.row },
            h('span', { style: styles.who }, mine ? '你' : '助理'),
            h('div', { style: mine ? styles.bubbleUser : styles.bubble },
              mine ? (message.text || '…') : renderAssistantBody(h, message.text, styles, markdown)),
            message.status === 'failed' ? h('button', { onClick: () => void submit(outboxRef.current.get(message.clientTurnId)), disabled: sending }, `${message.failure} · 重试发送`) : null);
        }),
        // 本机授权撤销后的系统提示：不属于云端消息，不落快照，只在本次面板会话里保留。
        systemNotices.map(notice => h('div', {
          key: notice.id, role: 'status', 'data-pa-system-notice': 'local-access-revoked',
          style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8, background: '#fff0d6', color: '#946200', fontSize: 12, lineHeight: 1.7 },
        },
        h('span', { 'aria-hidden': 'true', style: { flex: 'none', marginTop: 1 } }, '!'),
        h('span', { style: { flex: 1, minWidth: 0 } },
          notice.text,
          h('span', { style: { color: '#76808e' } }, '；本机控制入口已禁用，云电脑与云端会话不受影响。')))),
        awaiting ? h('div', { key: 'awaiting', style: styles.row },
          h('span', { style: styles.who }, '助理'),
          h('div', { style: { ...styles.bubble, color: 'var(--dsw-alias-label-secondary, #536174)' } },
            h('span', { style: styles.pulse }, progressText || '正在处理…'))) : null,
        queue.map(item => h('div', { key: `queued-${item.clientTurnId}`, style: styles.rowUser },
          h('span', { style: styles.who }, '你 · 排队中'),
          h('div', { style: styles.queueBubble }, `${item.text}${item.uploads?.length ? `（${item.uploads.length} 个附件待发）` : ''}`),
          h('div', { style: styles.queueRow },
            h('span', { style: styles.queueHint }, item.attempts ? '云电脑仍在处理上一轮，稍后自动重发' : '已排队，本轮结束后发送'),
            h('button', {
              type: 'button', 'aria-label': `撤回排队消息：${item.text.slice(0, 24)}`, title: '撤回这条排队消息',
              style: styles.queueCancel, onClick: () => cancelQueued(item.clientTurnId),
            }, closeGlyph(h), '撤回')))))),
    h('div', { 'data-personal-assistant-composer': 'true', style: styles.composer },
      queueNotice ? h('div', { role: 'status', style: styles.queueNotice }, queueNotice) : null,
      h('div', { style: styles.composerInner },
        attachments.length > 0 ? h('div', { style: styles.attachRow }, attachments.map(item => h('span', { key: item.id, style: styles.attach },
          item.mimeType.startsWith('image/') ? h('img', { src: item.dataUrl, alt: '', style: styles.attachThumb }) : null,
          h('span', { style: styles.attachName }, item.name),
          h('button', {
            'aria-label': `移除 ${item.name}`,
            style: { ...styles.iconButton, width: 16, height: 16, border: 'none' },
            onClick: () => setAttachments(previous => previous.filter(entry => entry.id !== item.id)),
          }, closeGlyph(h))))) : null,
        h('textarea', {
          'aria-label': '给个人助理发消息', value: draft, rows: 1, style: styles.textarea,
          placeholder: phase !== 'ready' ? '云端暂未连接，可先写下消息'
            : (sending || awaiting ? '本轮进行中：现在发送会排队，本轮结束后自动发出' : '给个人助理发消息，Enter 发送，Shift+Enter 换行'),
          onChange: event => setDraft(event.target.value),
          onKeyDown: event => {
            if (phase === 'ready' && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) { event.preventDefault(); void submit(); }
          },
        }),
        h('div', { style: styles.composerBar },
          h('button', { 'aria-label': '添加附件', style: styles.iconButton, disabled: phase !== 'ready' || sending, title: '上传到云电脑：最多 4 个文件，每个 512 KiB', onClick: () => fileRef.current?.click() }, plusGlyph(h)),
          h('input', { ref: fileRef, type: 'file', multiple: true, accept: 'image/*,.txt,.md,.json,.pdf', style: { display: 'none' }, onChange: pickFiles }),
          h('span', { style: styles.spacer }),
          queue.length > 0 ? h('span', { role: 'status', style: styles.queueBadge }, `排队中 ${queue.length}`) : null,
          h('button', {
            // 排队非空时保持可点，并明确告诉用户"这是在排队"，不能做成禁用到以为点不动的样子。
            'aria-label': queue.length > 0 ? `发送消息（排队中 ${queue.length} 条）` : '发送消息',
            title: sending || awaiting ? '本轮进行中：发送后会排队，本轮结束后自动发出' : '发送消息',
            disabled: phase !== 'ready' || (!draft.trim() && attachments.length === 0),
            style: phase !== 'ready' || (!draft.trim() && attachments.length === 0)
              ? { ...styles.send, ...styles.sendDisabled }
              : (sending || awaiting ? styles.sendQueued : styles.send),
            onClick: () => void submit(),
          }, sendGlyph(h))))));
}
