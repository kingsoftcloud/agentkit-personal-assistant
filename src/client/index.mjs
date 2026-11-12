/** Browser-safe Personal Assistant client and Cloud Computer panel. */

// 新面板视图（纯函数，见 docs/prototype-implementation-plan.md 第 1 章）。
// 数据与回调统一在本文件的 PersonalAssistantPanelShell 里注入，视图本身不发请求。
import { renderBotsList } from './views/bots-list.mjs';
import { renderBotDetail } from './views/bot-detail.mjs';
import { renderSettings } from './views/settings.mjs';
import { renderLocalAccess, LOCAL_ACCESS_SCOPES } from './views/local-access.mjs';
import { renderCreateProgress } from './views/create-progress.mjs';
import { backIcon, button as panelButton, connectionDot, connectionStateOf, styles as panelUi, TOKENS as PANEL_TOKENS } from './views/ui.mjs';

export class PersonalAssistantGatewayUnavailableError extends Error {
  constructor() {
    super('Personal Assistant gateway is not connected');
    this.name = 'PersonalAssistantGatewayUnavailableError';
    this.code = 'PERSONAL_ASSISTANT_GATEWAY_UNAVAILABLE';
  }
}

function gatewayRequest(gateway, operation, payload) {
  if (!gateway || typeof gateway.request !== 'function') throw new PersonalAssistantGatewayUnavailableError();
  return gateway.request(operation, payload);
}

export function createPersonalAssistantClient({ gateway, profileId = 'default' } = {}) {
  let selectedBotId = null;
  const request = (operation, payload = {}) => gatewayRequest(gateway, operation, { ...payload, profileId });
  const desktop = {
    open: input => request('personal-assistant.desktop.session.open', { ...input, botId: input?.botId ?? selectedBotId }),
    ticket: input => request('personal-assistant.desktop.ticket', { ...input, botId: input?.botId ?? selectedBotId }),
    frame: input => request('personal-assistant.desktop.frame', input),
    input: input => request('personal-assistant.desktop.input', input),
    close: input => request('personal-assistant.desktop.session.close', input),
  };
  return Object.freeze({
    configuration: () => request('personal-assistant.configuration'),
    listBots: () => request('personal-assistant.bots.list'),
    getBot: botId => request('personal-assistant.bots.get', { botId }),
    selectBot(botId) {
      selectedBotId = String(botId ?? '').trim();
      if (!selectedBotId) throw new TypeError('botId must be a non-empty string');
      return selectedBotId;
    },
    selectedBot: () => selectedBotId,
    session: input => request('personal-assistant.session.create', { ...input, botId: input?.botId ?? selectedBotId }),
    listSessions: botId => request('personal-assistant.sessions.list', { botId: botId ?? selectedBotId }),
    // 网关公开的是单数 session.create；旧的 sessions.create 从未进入云端会话通道。
    createSession: input => request('personal-assistant.session.create', { ...input, botId: input?.botId ?? selectedBotId }),
    listMessages: sessionId => request('personal-assistant.sessions.messages.list', { sessionId, botId: selectedBotId }),
    appendMessage: (sessionId, input) => request('personal-assistant.sessions.messages.append', { sessionId, ...input, botId: input?.botId ?? selectedBotId }),
    listTurns: sessionId => request('personal-assistant.sessions.turns.list', { sessionId, botId: selectedBotId }),
    submitTurn: (sessionId, input) => request('personal-assistant.sessions.turns.submit', { sessionId, ...input, botId: input?.botId ?? selectedBotId }),
    searchMemory: query => request('personal-assistant.memory.search', { query, botId: selectedBotId }),
    remember: input => request('personal-assistant.memory.upsert', { ...input, botId: input?.botId ?? selectedBotId }),
    computerStatus: computerId => request('personal-assistant.computer.status', { computerId, botId: selectedBotId }),
    computerAction: input => request('personal-assistant.computer.action', { ...input, botId: input?.botId ?? selectedBotId }),
    browserOpen: url => request('personal-assistant.computer.action', { action: 'open', args: { url }, botId: selectedBotId }),
    browserSnapshot: () => request('personal-assistant.computer.action', { action: 'snapshot', args: {}, botId: selectedBotId }),
    browserClick: selector => request('personal-assistant.computer.action', { action: 'click', args: { selector }, botId: selectedBotId }),
    browserType: (text, selector) => request('personal-assistant.computer.action', { action: 'type', args: { text, ...(selector === undefined ? {} : { selector }) }, botId: selectedBotId }),
    browserPress: key => request('personal-assistant.computer.action', { action: 'press', args: { key }, botId: selectedBotId }),
    browserScreenshot: () => request('personal-assistant.computer.action', { action: 'screenshot', args: {}, botId: selectedBotId }),
    browserDownload: args => request('personal-assistant.computer.action', { action: 'download', args: args || {}, botId: selectedBotId }),
    browserClose: () => request('personal-assistant.computer.action', { action: 'stop', args: {}, botId: selectedBotId }),
    cloudBash: (command, timeoutMs) => request('personal-assistant.computer.action', { action: 'terminal.exec', args: { language: 'shell', command, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, botId: selectedBotId }),
    cloudRunCode: (language, code, timeoutMs) => request('personal-assistant.computer.action', { action: 'terminal.exec', args: { language, code, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, botId: selectedBotId }),
    clipboardRead: () => request('personal-assistant.computer.action', { action: 'clipboard.read', args: {}, botId: selectedBotId }),
    clipboardWrite: text => request('personal-assistant.computer.action', { action: 'clipboard.write', args: { text }, botId: selectedBotId }),
    desktop,
  });
}

export const inject = Object.freeze([
  'slots', 'connection', 'sidebarRight', 'uiWorkspace', 'workspaces', 'sessions', 'uiConversation',
]);
export const PERSONAL_ASSISTANT_PANEL_ID = 'personal-assistant';
export const PERSONAL_ASSISTANT_CLIENT_DEFAULTS = Object.freeze({ enabled: false, autoConnect: false });
export const PERSONAL_ASSISTANT_COMPUTER_TAB = 'personal-assistant-computer';
export const PERSONAL_ASSISTANT_VIEW_ID = 'personal-assistant-session';
const PERSONAL_ASSISTANT_DSH_SESSION_KEY = 'personal-assistant.dsh-session-id';
const personalAssistantDshSessions = new Set();
/** Settings and the main panel are mounted in different DSH slots. */
export const PERSONAL_ASSISTANT_CONFIGURATION_EVENT = 'personal-assistant:configuration-changed';

function emitConfigurationChanged(configuration) {
  const target = globalThis.window;
  if (!target || typeof target.dispatchEvent !== 'function') return;
  const event = typeof globalThis.CustomEvent === 'function'
    ? new globalThis.CustomEvent(PERSONAL_ASSISTANT_CONFIGURATION_EVENT, { detail: configuration })
    : { type: PERSONAL_ASSISTANT_CONFIGURATION_EVENT, detail: configuration };
  try { target.dispatchEvent(event); } catch { /* 宿主卸载过程中忽略通知 */ }
}
import { fitDesktopBox, mapDisplayPoint, mergeWheel, normalizeDisplay } from './desktop-view.mjs';
import { createDesktopControl } from './desktop-control.mjs';
import { createClipboardChannel, isPasteShortcut, isCopyShortcut, copyShortcutEvents, copyCloudClipboard, pasteToCloud, readLocalClipboard, writeLocalClipboard, clipboardTextOf } from './components/desktop-clipboard.mjs';
import { PersonalAssistantConversation } from './conversation.mjs';
import { createSessionAssistantWorkbench } from './native-workbench.mjs';
import { publicBotDirectory, resolveAssistantBotId } from './bot-directory.mjs';
export const PERSONAL_ASSISTANT_CLIENT_BUILD = typeof __PA_CLIENT_BUILD__ === 'string' ? __PA_CLIENT_BUILD__ : '开发模式';
/** 构建标记按本机时区显示（构建串是 UTC，直接截断会让用户看到 8 小时前的时间）。 */
export function localBuildLabel(build) {
  const time = new Date(build);
  if (Number.isNaN(time.getTime())) return String(build || '开发模式');
  const pad = value => String(value).padStart(2, '0');
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`;
}
const FIRST_FRAME_TIMEOUT_MS = 12_000;
let clientReact;
export function setClientReactRuntime(runtime) { clientReact = runtime; }
let clientMarkdown;
/**
 * 注入宿主 DSH 的 ui-primitives —— 原生 Markdown 渲染器（MarkdownText）所在模块。
 * 老宿主导出的模块里没有 MarkdownText 时传 undefined，对话视图退回自带极简渲染。
 */
export function setClientMarkdownRuntime(runtime) {
  clientMarkdown = runtime && typeof runtime.MarkdownText === 'function' ? runtime : undefined;
}
const ui = {
  background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #17202c)',
  border: '1px solid var(--dsw-alias-border-default, #d8dee8)',
};
const bindingFailure = error => typeof error?.message === 'string' && error.message && !/^(fetch failed|Failed to fetch)$/u.test(error.message) ? error.message.slice(0, 180) : '云电脑连接失败，请稍后重试';
const failure = error => error?.code === 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE' && Number(error?.status) === 409 ? '当前云端版本尚不支持助理列表，请更新云端助理后重试' : '连接暂时不可用，请稍后重试';
const directoryUnsupported = error => Number(error?.status) === 409 && ['PERSONAL_ASSISTANT_DIRECTORY_UNSUPPORTED', 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE'].includes(error?.code);
/**
 * 「未开通」引导页的唯一事实来源：云电脑面板、设置页、首页共用同一套判断与动作。
 *
 * reason 由 DSH Host 给出：needs-create（账号下确实没有实例）、credential-unavailable（有实例但
 * 凭证取不到）、unavailable（连状态都读不到，多为 DSH Host 未登录云端或网关不可达）。
 * 只有确认没有实例时才给「开通」入口——一个子账号一个个人助理，已开通必须复用，避免重复创建；
 * candidates 非空时一律优先连接已发现的实例。
 */
export function unconfiguredGuidance(binding) {
  const reason = typeof binding?.reason === 'string' ? binding.reason : '';
  const candidates = Array.isArray(binding?.candidates) ? binding.candidates.filter(row => typeof row?.agentId === 'string' && row.agentId) : [];
  const check = { id: 'check', label: '检查开通状态' };
  if (candidates.length > 0) return {
    tone: 'reuse', title: '发现已开通的个人助理',
    detail: '你的个人助理已经存在，直接连接即可继续使用。',
    actions: [{ id: 'connect', label: '连接已发现的个人助理', primary: true }, check],
  };
  if (reason === 'needs-create') return {
    tone: 'create', title: '开通个人助理',
    detail: '开通后直接聊天；需要看画面或操作文件时，再打开云电脑。',
    actions: [{ id: 'create', label: '开通个人助理', primary: true }, check],
  };
  if (reason === 'credential-unavailable') return {
    tone: 'reuse', title: '正在恢复连接凭证',
    detail: '你的个人助理已经存在，正在恢复连接凭证。',
    actions: [{ id: 'connect', label: '重新获取连接凭证', primary: true }, check],
  };
  const detail = typeof binding?.detail === 'string' && binding.detail ? binding.detail : '';
  return {
    tone: 'retry', title: '暂时读不到开通状态',
    detail: `${detail}请先登录 DSH Host 云端账号，再刷新状态。`,
    actions: [check, { id: 'create', label: '确认未开通后开通', primary: false }],
  };
}

const onboardingStyle = {
  page: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: '32px 20px', textAlign: 'center', boxSizing: 'border-box' },
  eyebrow: { fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary, #536174)' },
  title: { margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' },
  detail: { margin: 0, maxWidth: 460, lineHeight: 1.75, color: 'var(--dsw-alias-label-secondary, #536174)' },
  actions: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', marginTop: 4 },
  primary: { ...ui, borderRadius: 8, padding: '8px 16px', cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: 500, border: 'none', background: 'var(--dsw-alias-label-primary, #17202c)', color: 'var(--dsw-alias-bg-layer-1, #fff)' },
  ghost: { ...ui, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', font: 'inherit', fontSize: 13, background: 'transparent' },
  notice: { margin: 0, maxWidth: 460, color: 'var(--dsw-alias-label-secondary, #536174)', fontSize: 12, lineHeight: 1.7 },
  diag: { alignSelf: 'center', color: 'var(--dsw-alias-label-tertiary, #76808e)', fontSize: 11, opacity: 0.8, maxWidth: '100%', overflowWrap: 'anywhere' },
};

// 故意不映射 Meta：⌘ 在 Linux 里没有对应键，映射成 Super_L 只会在云端卡住它。
const keyNames = { Control: 'Control_L', Alt: 'Alt_L', Shift: 'Shift_L', Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'BackSpace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'space' };

export function PersonalAssistantPanel({ request, initialBotId = '', openInSidebar = null, variant = 'page', nativeFullscreen = false, connectionDot = null, onBack = null, connectOnMount = false, embedded = false } = {}) {
  const R = clientReact || globalThis.React;
  if (!R) return '个人助理页面尚未就绪，请重新打开';
  const { createElement: h, useEffect, useRef, useState } = R;
  const useLayoutEffect = R.useLayoutEffect || useEffect;
  const [config, setConfig] = useState(null);
  const [bots, setBots] = useState([]);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryCloseCode, setDirectoryCloseCode] = useState(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [botId, setBotId] = useState(initialBotId);
  const [phase, setPhase] = useState('loading');
  const [notice, setNotice] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [fps, setFps] = useState(0);
  const [controlPhase, setControlPhase] = useState('observe');
  const [binding, setBinding] = useState(null);
  const [busy, setBusy] = useState('');
  const [clipboardNotice, setClipboardNotice] = useState('');
  // 桌面卡片尺寸由「可用宽 × 可用高」共同决定：全屏后高度不够时按高度反推宽度，
  // 保证远端整幅画面（含云浏览器顶部地址/输入条）完整可见，不靠滚动兜底。
  const [desktopDisplay, setDesktopDisplay] = useState(() => normalizeDisplay());
  const [stageBox, setStageBox] = useState(null);
  const controlRef = useRef(null);
  const clipboardRef = useRef(null), clipboardTimerRef = useRef(null);
  const canvasRef = useRef(null), inputRef = useRef(null), viewRef = useRef(null), cursorRef = useRef(null), stageAreaRef = useRef(null), controlCapsuleRef = useRef(null);
  const fullscreenRef = useRef(nativeFullscreen); fullscreenRef.current = nativeFullscreen;
  const state = useRef({ mounted: true, socket: null, generation: 0, frameEpoch: 0, session: null, suspended: false, resuming: false, pendingInputs: [], display: { width: 1280, height: 800 }, readOnly: true, botId, config: null, reconnect: null, firstFrame: null, receivedSeq: -1, pendingFrame: null, decoding: false, frames: 0, lastMove: 0, wheelPending: { x: 0, y: 0 }, wheelFrame: 0, pressed: new Set(), buttons: new Set(), composition: false, retries: 0, taskId: '', mode: 'control', frameMetadata: null, reconnectAllowed: false, controlError: '' });
  state.current.botId = botId;
  const rpc = async (operation, payload = {}) => {
    if (typeof request !== 'function') throw new Error('DSH Host Host 尚未连接');
    return request(operation, payload);
  };
  const send = body => {
    const current = state.current;
    if (current.socket?.readyState !== 1) return false;
    current.socket.send(JSON.stringify(body)); return true;
  };
  const releaseInputs = () => {
    const current = state.current;
    for (const key of current.pressed) { if (key === '_copyShortcut') continue; controlRef.current?.input({ type: 'key', action: 'up', key }); }
    for (const button of current.buttons) controlRef.current?.input({ type: 'button', action: 'up', button });
    current.pressed.clear(); current.buttons.clear();
  };
  const releasePointer = () => {
    for (const button of state.current.buttons) controlRef.current?.input({ type: 'button', action: 'up', button });
    state.current.buttons.clear();
  };
  if (!controlRef.current) controlRef.current = createDesktopControl({
    send,
    changed: value => {
      const current = state.current; current.controlPhase = value.phase; current.readOnly = value.readOnly; current.controlEpoch = value.controlEpoch;
      if (value.readOnly && cursorRef.current) cursorRef.current.style.visibility = 'hidden';
      if (value.phase === 'observe') { current.pressed.clear(); current.buttons.clear(); }
      if (current.mounted) { setReadOnly(value.readOnly); setControlPhase(value.phase); }
    },
    failed: message => { state.current.controlError = message || '控制权暂不可用'; if (state.current.mounted) setNotice(message); },
  });
  // 剪贴板请求复用同一条桌面 WS（云端 desktop-ws 的 clipboard.read / clipboard.write），
  // 用 requestId 关联回复；旧版云端不认这两个消息类型，超时后给明确提示而不是转圈。
  if (!clipboardRef.current) clipboardRef.current = createClipboardChannel({ send, controlEpoch: () => controlRef.current?.snapshot?.controlEpoch });
  const releaseControl = () => { releaseInputs(); controlRef.current.release(); state.current.pressed.clear(); state.current.buttons.clear(); };
  const flushPointer = () => {
    const current = state.current;
    if (current.pointerFrame) cancelAnimationFrame(current.pointerFrame);
    current.pointerFrame = null;
    const next = current.lastPointer; current.lastPointer = null;
    if (next && (!current.readOnly || current.controlPhase === 'acquiring') && (!current.sentPointer || next.x !== current.sentPointer.x || next.y !== current.sentPointer.y)) {
      controlRef.current.input({ type: 'pointermove', ...next }); current.sentPointer = next;
    }
  };
  const clearTimers = () => {
    clearTimeout(state.current.reconnect); clearTimeout(state.current.firstFrame);
    state.current.reconnect = null; state.current.firstFrame = null;
  };
  const close = (announce = true) => {
    const current = state.current; current.reconnectAllowed = false;
    // E6：_copyShortcut 是合成复制用的伪按键，不是真实按下的键。关闭/卸载前先移除，
    // 否则 releaseInputs 会把它当真实按键发一条 keyup 给云电脑（也可能跨连接残留）。
    current.pressed.delete('_copyShortcut');
    clearTimers(); releaseControl(); current.generation += 1;
    clipboardRef.current?.rejectAll();
    try { send({ type: 'close' }); current.socket?.close(1000, 'panel closed'); } catch {}
    controlRef.current.reset({ readOnly: true }); current.lastDrawnFrame = null; current.socket = null; current.session = null; current.pendingFrame = null; current.frameMetadata = null; current.readOnly = true; inputRef.current?.blur();
    current.suspended = false; current.resuming = false; current.pendingInputs = []; current.frameEpoch++;
    if (announce && current.mounted) { setPhase(current.config?.configured ? 'idle' : 'unconfigured'); setReadOnly(true); }
  };
  const ended = value => {
    close(false); setReadOnly(true); setPhase('closed');
    setNotice(value?.reason === 'lease-lost' || Number(value?.status) === 409
      ? '控制租约已失效，桌面连接已关闭；请重新连接或选择只读旁观'
      : value?.code === 'DESKTOP_SESSION_NOT_FOUND' || Number(value?.status) === 404
        ? '桌面会话已结束（可能因空闲超时），请重新连接'
        : '桌面连接已结束，可重新连接云电脑');
  };
  const input = event => {
    const current = state.current;
    if (event.type !== 'pointermove') flushPointer();
    if (current.suspended || current.resuming) {
      if (event.type === 'pointermove') return false;
      const controlling = current.mode === 'control';
      if (controlling) {
        if (current.pendingInputs.length >= 32) { close(); setNotice('恢复期间输入过快，请重新连接'); return false; }
        current.pendingInputs.push(event);
      }
      if (!current.resuming) resumeIdle();
      return controlling;
    }
    if (!current.session || current.socket?.readyState !== 1) { setNotice('云电脑尚未连接，输入未发送'); return false; }
    return controlRef.current.input(event);
  };
  const clipboardNotify = message => {
    if (!state.current.mounted) return;
    setClipboardNotice(message);
    if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    clipboardTimerRef.current = setTimeout(() => { if (state.current.mounted) setClipboardNotice(''); }, 4000);
  };
  // 合成按键走现有桌面输入通道：只读旁观时 input() 会拒发并返回 false，由粘贴流程提示先接管。
  const sendDesktopKeys = events => {
    let sent = false;
    for (const event of events) sent = input(event) || sent;
    return sent;
  };
  // 剪贴板读写和桌面输入共用 human 控制租约。旁观状态下先申请接管并等待
  // 服务端回执，避免写入剪贴板先于 lease 成功而稳定收到 409。
  const ensureClipboardControl = async () => {
    const current = state.current;
    const snapshot = controlRef.current?.snapshot;
    if (!current.session || current.socket?.readyState !== 1) { clipboardNotify('云电脑尚未连接，请先打开桌面'); return false; }
    if (snapshot && snapshot.phase === 'controlling' && snapshot.readOnly === false) return true;
    if (current.suspended || current.resuming) { clipboardNotify('云电脑正在恢复，请稍候再试'); return false; }
    if (!snapshot?.available) { clipboardNotify('当前为只读旁观，请先打开控制模式'); return false; }
    current.controlError = '';
    if (!controlRef.current.acquire()) { clipboardNotify('当前无法接管云电脑，请重试'); return false; }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const latest = controlRef.current.snapshot;
      if (latest.phase === 'controlling' && latest.readOnly === false) return true;
      if (current.controlError) break;
    }
    clipboardNotify(current.controlError || '接管云电脑超时，请重试');
    return false;
  };
  // ⌘C：先把复制按键交给云电脑，让云端应用自己完成“复制”，再取回云端剪贴板。
  // 云端桌面始终是 Linux，不能把 macOS 的 Meta 映射为 Super_L，否则 Linux 应用不会执行复制。
  const copyCloudClipboardToLocal = async () => {
    let previousText;
    if (!state.current.pressed.has('_copyShortcut')) {
      state.current.pressed.add('_copyShortcut');
      try {
        // 先记下复制前的云端剪贴板：应用把内容发布到 selection 是异步的，
        // 没有基线就分不清「应用没复制」和「读得太早」。
        try { previousText = clipboardTextOf(await clipboardRef.current.read()); } catch { previousText = undefined; }
        sendDesktopKeys(copyShortcutEvents());
      } finally { state.current.pressed.delete('_copyShortcut'); }
    }
    return copyCloudClipboard({ readCloud: () => clipboardRef.current.read(), writeLocal: text => writeHostClipboard(text), notify: clipboardNotify, previousText });
  };
  // 本机剪贴板优先走 Host 进程（pbpaste/pbcopy）：DSH Host 渲染器没有 clipboard 权限，
  // navigator.clipboard 在面板里会被拒，⌘C/⌘V 就成了空操作。旧 Host 不支持时再退回浏览器 API。
  const readHostClipboard = async () => {
    try {
      const value = await rpc('personal-assistant.clipboard.read');
      if (typeof value?.text === 'string') return value.text;
    } catch (error) {
      // Host 已明确回复「内容超过 64 KiB」：这是可读的业务结论，不能退回浏览器剪贴板把它吞掉。
      if (error?.code === 'PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE') throw error;
      /* 旧 Host 没有剪贴板 RPC，退回浏览器剪贴板 */
    }
    return readLocalClipboard();
  };
  const writeHostClipboard = async text => {
    try { await rpc('personal-assistant.clipboard.write', { text: String(text ?? '') }); return; }
    catch (error) {
      // 写方向同理：Host 明确说超限就上抛，交给 clipboardFriendlyError 显示可读文案。
      if (error?.code === 'PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE') throw error;
      /* 旧 Host 没有剪贴板 RPC，退回浏览器剪贴板 */
    }
    await writeLocalClipboard(String(text ?? ''));
  };
  const pasteLocalClipboardToCloud = () => pasteToCloud({
    readLocal: () => readHostClipboard(),
    writeCloud: text => clipboardRef.current.write(text),
    sendKeys: sendDesktopKeys,
    ensureControl: ensureClipboardControl,
    notify: clipboardNotify,
  });
  // paste 事件兜底：macOS 上 Electron 的编辑菜单可能先把 ⌘V 吃掉，但浏览器仍会把
  // 剪贴板内容作为 paste 事件交给聚焦的输入框，这里直接把文本写进云电脑剪贴板。
  const pasteTextToCloud = text => pasteToCloud({
    readLocal: async () => String(text ?? ''),
    writeCloud: value => clipboardRef.current.write(value),
    sendKeys: sendDesktopKeys,
    ensureControl: ensureClipboardControl,
    notify: clipboardNotify,
  });
  const drawLatest = async () => {
    const current = state.current;
    if (current.decoding) return;
    current.decoding = true;
    try {
      while (current.pendingFrame) {
        const job = current.pendingFrame; current.pendingFrame = null;
        let bitmap;
        try {
          bitmap = await createImageBitmap(new Blob([job.bytes], { type: 'image/jpeg' }));
          if (!current.mounted || current.suspended || job.frameEpoch !== current.frameEpoch || job.generation !== current.generation || job.seq < current.receivedSeq || !canvasRef.current) continue;
          current.lastDrawnFrame = job;
          const canvas = canvasRef.current, rect = canvas.getBoundingClientRect();
          const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
          canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr));
          const context = canvas.getContext('2d'), display = current.display;
          const scale = Math.min(canvas.width / display.width, canvas.height / display.height);
          const width = display.width * scale, height = display.height * scale;
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
          const waitingForFirstFrame = current.firstFrame !== null;
          current.frames += 1; clearTimeout(current.firstFrame); current.firstFrame = null; current.retries = 0;
          if (waitingForFirstFrame) setNotice('');
          setPhase(current.readOnly ? 'readonly' : 'ready'); setAttempt(0);
        } catch { if (current.mounted) setNotice('桌面帧无法解码，请重试'); }
        finally { bitmap?.close(); }
      }
    } finally { current.decoding = false; }
  };
  const markIdle = value => {
    const current = state.current;
    clearTimeout(current.firstFrame); current.firstFrame = null;
    current.suspended = true; current.resuming = false; current.readOnly = true; current.pendingInputs = []; current.frameEpoch++;
    current.pendingFrame = null; current.frameMetadata = null; current.pressed.clear(); current.buttons.clear(); current.frames = 0;
    setFps(0); setReadOnly(true); setPhase('dormant'); setNotice(value?.leaseReleased === false ? '已空闲，画面已暂停；控制权仍由外部任务管理' : '已空闲，控制权已释放；操作桌面即可恢复');
  };
  const resumeIdle = () => {
    const current = state.current;
    if (current.resuming || !current.suspended) return;
    if (current.socket?.readyState !== 1) { void open(current.mode, false, current.pendingInputs); return; }
    current.resuming = true; setPhase('resuming'); setNotice('正在恢复桌面并检查控制权，请稍候。');
    send({ type: 'resume', mode: current.mode, activity: true });
    const generation = current.generation, socket = current.socket;
    current.firstFrame = setTimeout(() => { if (current.mounted && current.generation === generation && current.firstFrame !== null) socket.close(4000, 'resume frame timeout'); }, FIRST_FRAME_TIMEOUT_MS);
  };
  const open = async (mode = 'read', reconnecting = false, bufferedInputs = []) => {
    const current = state.current;
    const selected = String(current.botId || '').trim();
    if (!current.config?.configured) { setPhase('unconfigured'); return; }
    if (!selected || !current.bots?.some(bot => bot.botId === selected)) { setNotice('云端助理尚未就绪，请稍后重试'); return; }
    close(false);
    current.pendingInputs = bufferedInputs; current.resuming = bufferedInputs.length > 0;
    const generation = ++current.generation;
    current.reconnectAllowed = true;
    if (!reconnecting) current.retries = 0;
    current.mode = mode; current.taskId ||= `dsh-host-desktop-${globalThis.crypto.randomUUID()}`;
    current.receivedSeq = -1; current.frameMetadata = null;
    setPhase(reconnecting ? 'reconnecting' : 'connecting'); setNotice('首次或休眠后连接可能需要数秒，请稍候。');
    try {
      const ticket = await rpc('personal-assistant.desktop.ticket', { agentId: current.config.agentId, botId: selected, mode: mode === 'observe' ? 'control' : mode });
      if (!current.mounted || generation !== current.generation) return;
      const socket = new WebSocket(ticket.wsUrl, ['agentkit.personal-assistant.desktop.v1', `agentkit.desktop.ticket.${ticket.ticket}`]);
      socket.binaryType = 'arraybuffer'; current.socket = socket;
      const valid = () => current.mounted && current.generation === generation;
      socket.onopen = () => {
        if (!valid()) { socket.close(); return; }
        send({ type: 'open', botId: selected, taskId: current.taskId, mode, ...(ticket.leaseId ? { leaseId: ticket.leaseId } : {}) });
        current.firstFrame = setTimeout(() => { if (valid()) { setNotice('云电脑响应较慢，正在重新连接'); socket.close(4000, 'first frame timeout'); } }, FIRST_FRAME_TIMEOUT_MS);
      };
      socket.onmessage = event => {
        if (!valid()) return;
        if (typeof event.data !== 'string') {
          const meta = current.frameMetadata; current.frameMetadata = null;
          const bytes = event.data;
          if (!meta || !Number.isSafeInteger(meta.seq) || meta.seq <= current.receivedSeq || !(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > 307200) return;
          if (current.suspended) return;
          current.receivedSeq = meta.seq; current.pendingFrame = { bytes, seq: meta.seq, generation, frameEpoch: current.frameEpoch }; void drawLatest(); return;
        }
        let value; try { value = JSON.parse(event.data); } catch { return; }
        if (value.type === 'ready') {
          current.suspended = false; current.resuming = false; current.receivedSeq = -1;
          current.session = value.sessionId; current.readOnly = Boolean(value.readOnly); current.display = normalizeDisplay(value.display); setDesktopDisplay(current.display);
          current.mode = mode;
          controlRef.current.reset(value);
          const inputs = current.pendingInputs; current.pendingInputs = [];
          if (!current.readOnly) for (const event of inputs) controlRef.current.input(event);
          else { current.pressed.clear(); current.buttons.clear(); }
          setReadOnly(current.readOnly); setNotice('云电脑已连接，正在准备桌面画面'); return;
        }
        if (value.type === 'control') { controlRef.current.accept(value); setNotice(''); return; }
        if (value.type === 'idle') { markIdle(value); return; }
        if (value.type === 'frame') { if (!value.unchanged) current.frameMetadata = value; return; }
        if (value.type === 'clipboard.response') { clipboardRef.current?.accept(value); return; }
        if (value.type === 'closed') { if (value.retryable !== true) ended(value); return; }
        if (value.type === 'error') {
          if (Number.isSafeInteger(value.controlEpoch) && value.controlEpoch < current.controlEpoch) return;
          setNotice(value.message || value.code || '云电脑请求失败');
          if (current.handoffSupported && value.recoverable === true) { controlRef.current.reject(value); return; }
          if (value.recoverable === true && Number(value.status) === 409) {
            if (value.code === 'DESKTOP_SESSION_IDLE') markIdle();
            else { current.pendingInputs = []; current.readOnly = true; current.pressed.clear(); current.buttons.clear(); setReadOnly(true); setPhase('readonly'); }
            return;
          }
          if (Number(value.status) === 409 && mode === 'control' && !current.session) { void open(state.current.handoffSupported ? 'observe' : 'read'); return; }
          if ([404, 409].includes(Number(value.status)) || value.code === 'DESKTOP_SESSION_NOT_FOUND') ended(value);
          else if (!current.session) { setPhase('error'); close(false); }
        }
      };
      socket.onerror = () => { if (valid()) setNotice('桌面通道暂时断开，正在重连'); };
      socket.onclose = event => {
        if (!valid()) return;
        if (current.suspended && event.code !== 1000) { clearTimeout(current.firstFrame); current.firstFrame = null; current.socket = null; setPhase('dormant'); return; }
        current.session = null; clipboardRef.current?.rejectAll(); clearTimeout(current.firstFrame); current.firstFrame = null;
        if (!current.reconnectAllowed || event.code === 1000) { ended(); return; }
        if (document.hidden) { setPhase('hidden'); return; }
        const count = ++current.retries; setAttempt(count);
        if (count > 5) { current.reconnectAllowed = false; setPhase('error'); setNotice('无法连接云电脑，请检查实例状态或网络后重试'); return; }
        setPhase('reconnecting'); current.reconnect = setTimeout(() => { void open(mode, true, current.pendingInputs); }, Math.min(8000, 1000 * 2 ** (count - 1)));
      };
    } catch (error) { if (current.mounted && generation === current.generation) { setPhase('error'); setNotice(failure(error)); } }
  };
  // DSH Host 负责发现实例、恢复/生成凭证；页面只读取公开状态，绝不接触凭据。
  const bindingSnapshot = async signal => {
    if (signal?.aborted) return null;
    try { const value = await rpc('personal-assistant.desktop.status'); return value && typeof value === 'object' ? value : null; }
    catch (error) {
      if (error?.code === 'PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE' || error?.status === 404) return null;
      return { configured: false, reason: 'unavailable', detail: bindingFailure(error), candidates: [] };
    }
  };
  const bindAssistant = async action => {
    if (busy) return;
    setBusy(action);
    setNotice(action === 'create' ? '正在创建个人助理，可能需要几分钟…' : '正在获取云端连接凭证…');
    try { await rpc(`personal-assistant.desktop.${action}`); setNotice(''); await refreshConnection(); }
    catch (error) { setNotice(bindingFailure(error)); setBinding(await bindingSnapshot().catch(() => null)); }
    finally { setBusy(''); }
  };
  const refreshConnection = async (signal, retried = false) => {
    close(false); setPhase('loading'); setNotice(''); setDirectoryError(''); setDirectoryCloseCode(null);
    try {
      const value = await rpc('personal-assistant.configuration');
      if (signal?.aborted || !state.current.mounted) return;
      state.current.config = value; setConfig(value);
      if (!value.configured) {
        const snapshot = await bindingSnapshot(signal);
        if (signal?.aborted || !state.current.mounted) return;
        state.current.bots = []; setBots([]); setBotId(''); setBinding(snapshot); setPhase('unconfigured');
        if (snapshot?.configured && !retried) { await refreshConnection(signal, true); return; }
        return;
      }
      setBinding(null);
      const result = await rpc('personal-assistant.bots.list');
      if (signal?.aborted || !state.current.mounted) return;
      if (result.directoryAvailable !== true) throw Object.assign(new Error('directory unavailable'), { code: 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE', status: 409 });
      const available = publicBotDirectory(result.bots);
      state.current.bots = available; state.current.handoffSupported = result.features?.includes('desktop-handoff/v1') === true; setBots(available);
      const selected = available.length ? resolveAssistantBotId(available, initialBotId || value.botId) : '';
      state.current.botId = selected; setBotId(selected); setPhase(available.length ? 'idle' : 'empty');
      if (selected && (['computer', 'native-tab'].includes(variant) || connectOnMount)) void open(state.current.handoffSupported ? 'observe' : 'read');
    } catch (error) {
      if (signal?.aborted || !state.current.mounted) return;
      if (Number.isInteger(error?.closeCode) && error.closeCode >= 1000 && error.closeCode <= 4999) setDirectoryCloseCode(error.closeCode);
      state.current.bots = []; setBots([]); setBotId('');
      // 配置接口本身失败（DSH Host 未登录、网关不可达）时不能直接判死：desktop.status 不抛错，
      // 用它区分「账号下确实没有实例」与「暂时读不到状态」，把开通/复用入口交给引导页。
      const snapshot = retried ? null : await bindingSnapshot(signal).catch(() => null);
      if (signal?.aborted || !state.current.mounted) return;
      if (snapshot?.configured) { setBinding(null); await refreshConnection(signal, true); return; }
      if (snapshot) {
        setBinding(typeof snapshot.reason === 'string' && snapshot.reason ? snapshot : { ...snapshot, reason: 'unavailable', detail: bindingFailure(error) });
        setPhase('unconfigured');
        return;
      }
      setPhase('directory-error');
      setDirectoryError(directoryUnsupported(error) ? '云端助理需要更新，请更新后重新连接。' : failure(error));
    }
  };
  useEffect(() => {
    const current = state.current; current.mounted = true;
    const controller = new AbortController();
    void refreshConnection(controller.signal);
    const interval = setInterval(() => { if (current.mounted) setFps(current.frames); current.frames = 0; }, 1000);
    const visibility = () => {
      if (document.hidden) { releasePressedKeys(); releaseControl(); send({ type: 'pause' }); }
      else if (current.socket?.readyState === 1) send({ type: 'resume' });
      else if (current.reconnectAllowed && current.config?.configured && current.session === null && current.socket) void open(current.mode, true);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (current.lastDrawnFrame) { current.pendingFrame = current.lastDrawnFrame; void drawLatest(); } }) : null;
    if (canvasRef.current) observer?.observe(canvasRef.current);
    const blur = () => { releasePressedKeys(); releaseControl(); };
    const outside = event => { if (!viewRef.current?.contains(event.target)) { releasePressedKeys(); releaseControl(); } };
    // 快捷键兜底：焦点不在隐藏输入框时（用户可能刚点过对话区），⌘C/⌘V 仍应作用到云电脑。
    // 走到这里时隐藏输入框已经把事件 preventDefault 过，说明正常路径处理完了，不重复执行。
    // 面板自己的文本输入框保留原生复制粘贴，绝不抢。
    const shortcut = event => {
      if (event.type !== 'keydown' || event.defaultPrevented) return;
      if (!isCopyShortcut(event) && !isPasteShortcut(event)) return;
      const target = event.target;
      const tag = String(target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true) return;
      if (!current.session || current.readOnly) return;
      key(event);
    };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', blur); document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', shortcut);
    return () => {
      current.mounted = false;
      // E5：剪贴板提示的 4s 定时器属于本面板，卸载时清掉并置空引用，避免残留回调写已卸载状态。
      if (clipboardTimerRef.current) { clearTimeout(clipboardTimerRef.current); clipboardTimerRef.current = null; }
      observer?.disconnect();
      if (current.pointerFrame) cancelAnimationFrame(current.pointerFrame);
      if (current.wheelFrame) cancelAnimationFrame(current.wheelFrame);
      controller.abort(); releasePressedKeys(); clearKeyWatchdogs(); close(false); clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', blur); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', shortcut);
    };
  }, [request]);
  const point = event => mapDisplayPoint({ clientX: event.clientX, clientY: event.clientY, rect: canvasRef.current.getBoundingClientRect(), display: state.current.display });
  // 触控板一次滑动手势会推几十上百个 wheel 事件。以前每个事件都发一条 input，
  // 云端每个都要跑一次 xdotool 且顺带触发一次抓帧，滚起来就明显迟滞；这里按动画帧
  // 合并：像素累计够一格才发一条 wheel（余数跨帧保留），鼠标一格 = 一次滚动，触控板
  // 按累计距离滚动，消息数和远端开销都降一个数量级。
  const wheel = event => {
    event.preventDefault();
    const current = state.current;
    const pending = current.wheelPending || (current.wheelPending = { x: 0, y: 0 });
    current.wheelPending = { x: pending.x + (Number(event.deltaX) || 0), y: pending.y + (Number(event.deltaY) || 0) };
    if (current.wheelFrame) return;
    current.wheelFrame = requestAnimationFrame(() => {
      current.wheelFrame = 0;
      if (!current.mounted) return;
      const merged = mergeWheel(current.wheelPending);
      current.wheelPending = merged.pending;
      if (!merged.clicks.deltaX && !merged.clicks.deltaY) return;
      input({ type: 'wheel', deltaX: merged.clicks.deltaX, deltaY: merged.clicks.deltaY });
    });
  };
  const pointer = event => {
    event.preventDefault(); const current = state.current, button = [1, 2, 3][event.button] || 1;
    if (event.type === 'pointerdown') { inputRef.current?.focus(); canvasRef.current?.setPointerCapture(event.pointerId); if (input({ type: 'button', action: 'down', button, ...point(event) })) current.buttons.add(button); }
    else { input({ type: 'button', action: 'up', button, ...point(event) }); current.buttons.delete(button); if (canvasRef.current?.hasPointerCapture(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId); }
  };
  // 云端桌面是 X11：只按下、不发抬起，系统会**自动重复**这个键——用户看到的就是
  // 「疯狂输入某个字符，我根本没动键盘」。失焦、面板隐藏、连接抖动都可能吞掉那一条抬起。
  const KEY_STUCK_MS = 2500;
  const keyTimers = () => {
    const current = state.current;
    if (!(current.keyTimers instanceof Map)) current.keyTimers = new Map();
    return current.keyTimers;
  };
  const releasePressedKeys = () => {
    const current = state.current;
    const keys = [...current.pressed];
    if (!keys.length) return;
    for (const name of keys) current.pressed.delete(name);
    for (const name of keys) { try { input({ type: 'key', action: 'up', key: name }); } catch { /* 通道已断：云端会由下一次连接重置 */ } }
  };
  const clearKeyWatchdogs = () => {
    const timers = keyTimers();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
  /** 每次按键事件（含自动重复）续命；真卡住时补一次抬起，避免 X11 无限重复。 */
  const armKeyWatchdog = name => {
    const timers = keyTimers();
    const previous = timers.get(name);
    if (previous) clearTimeout(previous);
    timers.set(name, setTimeout(() => {
      timers.delete(name);
      if (!state.current.pressed.has(name)) return;
      state.current.pressed.delete(name);
      try { input({ type: 'key', action: 'up', key: name }); } catch { /* ignore */ }
    }, KEY_STUCK_MS));
  };
  const disarmKeyWatchdog = name => {
    const timers = keyTimers();
    const timer = timers.get(name);
    if (timer) { clearTimeout(timer); timers.delete(name); }
  };
  const key = event => {
    if (state.current.composition || event.isComposing || event.nativeEvent?.isComposing || event.key === 'Process' || event.key === 'Unidentified') return;
    // 宿主的 ⌘/Win 键本身绝不能转发：Linux 里它等于 Super_L，按下去就卡住，
    // 之后所有 Ctrl 组合都会变成 Super+Ctrl+X 而被应用忽略——网页正文复制失效就是这么来的。
    if (event.key === 'Meta' || event.key === 'OS') return;
    // 画布上的 ⌘V/Ctrl+V 是"把本地剪贴板贴进云电脑"，不能把裸按键转给 Linux 桌面（它要的是 Ctrl+V）。
    if (isPasteShortcut(event)) { event.preventDefault(); void pasteLocalClipboardToCloud(); return; }
    if (isCopyShortcut(event)) {
      event.preventDefault();
      // 长按/重复的 keydown 不再触发第二次复制。
      if (event.type === 'keydown' && !event.repeat) void copyCloudClipboardToLocal();
      return;
    }
    // ⌘ + 字符：Linux 应用认的是 Ctrl，翻译成一次原子按下（'ctrl+a'），
    // 而不是把 Super 和字母分两条消息发过去——两条消息云端会并发处理，顺序不保证。
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      if (event.type === 'keydown' && !event.repeat) input({ type: 'key', action: 'tap', key: `ctrl+${event.key.toLowerCase()}` });
      return;
    }
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    // 普通文本只走 input/compositionend，避免同一按键被发送两遍。
    if (event.key.length === 1 && !modified) return;
    if (event.key === 'Escape' && fullscreenRef.current) return;
    event.preventDefault();
    const name = keyNames[event.key] || event.key;
    if (!/^[A-Za-z0-9_]+$/u.test(name)) return;
    if (event.type === 'keydown') {
      if (!event.repeat && input({ type: 'key', action: 'down', key: name })) state.current.pressed.add(name);
      armKeyWatchdog(name);
    } else {
      disarmKeyWatchdog(name);
      input({ type: 'key', action: 'up', key: name });
      state.current.pressed.delete(name);
    }
  };
  const stateText = { loading: '正在检查助理状态', idle: '准备连接', dormant: '已空闲', resuming: '正在恢复桌面', unconfigured: '个人助理尚未开通', empty: '暂时没有可用助理', 'directory-error': '暂时无法读取助理列表', connecting: '正在启动云电脑', readonly: '只读旁观', ready: '正在控制云电脑', reconnecting: '正在恢复连接', hidden: '画面已暂停', closed: '桌面连接已结束', error: '连接暂时不可用' }[phase];
  const buttonStyle = { ...ui, borderRadius: 6, padding: '7px 12px', cursor: 'pointer', font: 'inherit' };
  const active = ['ready', 'readonly', 'hidden', 'reconnecting', 'dormant', 'resuming'].includes(phase);
  const selectable = bots.length > 0;
  const bindingReason = binding?.reason || '';
  const candidateCount = Array.isArray(binding?.candidates) ? binding.candidates.length : 0;
  const bindingTitle = bindingReason === 'needs-create' ? '还没有创建个人助理'
    : bindingReason === 'credential-unavailable' ? '正在恢复个人助理的连接凭证'
    : bindingReason === 'unavailable' ? '暂时无法自动连接个人助理' : '个人助理尚未开通';
  const bindingDetail = bindingReason === 'needs-create' ? '云账号下还没有个人助理实例，创建后即可在这里连接专属云电脑。'
    : bindingReason === 'credential-unavailable' ? '云端暂时没有返回连接凭证，可以重新获取。'
    : bindingReason === 'unavailable' ? (binding?.detail || '请检查云端登录状态后重试。')
    : '开通完成后，即可在这里连接专属云电脑。';
  const emptyTitle = phase === 'unconfigured' ? bindingTitle : phase === 'empty' ? '助理正在准备中' : phase === 'directory-error' ? '暂时无法连接云端助理' : '正在检查助理状态';
  const emptyDetail = phase === 'unconfigured' ? bindingDetail : phase === 'empty' ? '云端初始化完成后，可用助理会显示在这里。' : phase === 'directory-error' ? directoryError : '请稍候';
  const computerVariant = variant === 'computer' || variant === 'native-tab';
  // 接管状态紧贴桌面卡片下方；测量时扣掉胶囊本身，避免状态条把画面挤出右栏。
  useLayoutEffect(() => {
    if (!computerVariant) return undefined;
    const node = stageAreaRef.current;
    if (!node) return undefined;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const measuredCapsuleHeight = controlCapsuleRef.current?.getBoundingClientRect?.().height || 0;
      const capsuleHeight = active || selectable ? Math.min(128, Math.max(44, measuredCapsuleHeight)) : 0;
      const availableHeight = Math.max(0, rect.height - (capsuleHeight ? capsuleHeight + 10 : 0));
      const next = fitDesktopBox({ availableWidth: rect.width, availableHeight, display: desktopDisplay, maxWidth: 1280 });
      setStageBox(previous => {
        if (!(next.width > 0 && next.height > 0)) return previous ?? null;
        return previous && Math.abs(previous.width - next.width) < 0.5 && Math.abs(previous.height - next.height) < 0.5 ? previous : next;
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    if (controlCapsuleRef.current) observer?.observe(controlCapsuleRef.current);
    return () => observer?.disconnect();
  }, [computerVariant, desktopDisplay, active, selectable, controlPhase, notice, clipboardNotice]);
  const guidance = phase === 'unconfigured' ? unconfiguredGuidance(binding) : null;
  const onboardingClick = action => {
    if (action === 'check') void refreshConnection();
    else void bindAssistant(action);
  };
  const onboarding = guidance ? h('div', { 'data-personal-assistant-onboarding': 'true', style: onboardingStyle.page },
    h('div', { 'data-window-drag': '', style: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' } },
      h('div', { style: onboardingStyle.eyebrow }, '个人助理 · 开通引导'),
      h('h2', { style: onboardingStyle.title }, guidance.title)),
    h('p', { style: onboardingStyle.detail }, guidance.detail),
    h('div', { style: onboardingStyle.actions },
      guidance.actions.map(action => h('button', {
        key: action.id, disabled: Boolean(busy), style: action.primary ? onboardingStyle.primary : onboardingStyle.ghost,
        onClick: () => onboardingClick(action.id),
      }, busy === action.id ? (action.id === 'create' ? '正在开通…' : action.id === 'connect' ? '正在连接…' : '检查中…') : action.label)),
      busy ? h('span', { role: 'status', style: onboardingStyle.notice }, '处理中，请稍候…') : null),
    notice ? h('p', { role: 'status', style: onboardingStyle.notice }, notice) : null,
    h('details', { style: onboardingStyle.diag }, h('summary', { style: { cursor: 'pointer' } }, '诊断'),
      h('small', { 'data-personal-assistant-build': PERSONAL_ASSISTANT_CLIENT_BUILD }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`))) : null;
  const stage = h('div', { ref: viewRef, 'data-personal-assistant-desktop-card': computerVariant ? 'true' : undefined, style: {
    position: 'relative', background: 'var(--dsw-alias-bg-layer-2, #f1f3f6)',
    ...(computerVariant ? { ...(stageBox && stageBox.width > 0 && stageBox.height > 0 ? { width: `${stageBox.width}px`, height: `${stageBox.height}px` } : { width: '100%', aspectRatio: `${desktopDisplay.width} / ${desktopDisplay.height}` }), flex: 'none', minWidth: 0, borderRadius: 14, overflow: 'hidden', boxShadow: '0 0 0 1px var(--dsw-alias-border-default, #d8dee8), 0 8px 28px #1018280d' } : { flex: 1, minHeight: 240 }),
  } },
    ['dormant', 'resuming'].includes(phase) ? h('div', { role: 'status', style: { position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', display: 'grid', placeItems: 'center', padding: 16, textAlign: 'center', background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 82%, transparent)', color: 'var(--dsw-alias-label-primary, #17202c)' } }, phase === 'dormant' ? '已空闲，操作桌面即可恢复' : '正在恢复桌面…') : null,
    h('canvas', { ref: canvasRef, 'aria-label': '云电脑桌面', tabIndex: active ? 0 : -1, onPointerDown: pointer, onPointerUp: pointer, onPointerCancel: releasePointer, onLostPointerCapture: releasePointer, onPointerLeave: () => { if (cursorRef.current) cursorRef.current.style.visibility = 'hidden'; }, onPointerMove: event => {
      const current = state.current, latest = event.nativeEvent?.getCoalescedEvents?.().at(-1) || event;
      if (cursorRef.current) { const rect = canvasRef.current.getBoundingClientRect(); cursorRef.current.style.transform = `translate(${latest.clientX - rect.left}px, ${latest.clientY - rect.top}px)`; cursorRef.current.style.visibility = current.readOnly ? 'hidden' : 'visible'; }
      current.lastPointer = point(latest);
      if (!current.pointerFrame) current.pointerFrame = requestAnimationFrame(() => { if (current.mounted) flushPointer(); });
    }, onContextMenu: event => event.preventDefault(), onWheel: wheel, onKeyDown: key, onKeyUp: key, style: { ...(computerVariant ? { position: 'absolute', inset: 0 } : {}), width: '100%', height: '100%', display: 'block', visibility: active ? 'visible' : 'hidden', pointerEvents: active ? 'auto' : 'none', touchAction: 'none', cursor: readOnly ? 'default' : 'none' } }),
    h('div', { ref: cursorRef, 'aria-hidden': true, style: { position: 'absolute', top: 0, left: 0, pointerEvents: 'none', visibility: 'hidden', zIndex: 2, width: 18, height: 22 } }, h('svg', { viewBox: '0 0 18 22', width: 18, height: 22 }, h('path', { d: 'M1 1v16l4-4 3 7 3-1-3-7h6z', fill: '#fff', stroke: '#162033', strokeWidth: 1.2 }))),
    !active ? h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16, textAlign: 'center' } },
      h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 500 } }, selectable ? stateText : emptyTitle),
      h('p', { style: { margin: 0, maxWidth: 380, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary, #536174)' } }, selectable ? notice || '连接后即可使用云端桌面，关闭面板会释放本次控制。' : emptyDetail),
      !selectable && phase !== 'loading' ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' } },
        phase === 'unconfigured' && bindingReason === 'needs-create' ? h('button', { style: buttonStyle, disabled: Boolean(busy), onClick: () => void bindAssistant('create') }, busy === 'create' ? '正在创建…' : '创建个人助理') : null,
        phase === 'unconfigured' && (bindingReason === 'credential-unavailable' || candidateCount > 0) ? h('button', { style: buttonStyle, disabled: Boolean(busy), onClick: () => void bindAssistant('connect') }, busy === 'connect' ? '正在获取…' : bindingReason === 'credential-unavailable' ? '重新获取连接凭证' : '连接已发现的个人助理') : null,
        h('button', { style: { ...buttonStyle, background: 'transparent' }, disabled: Boolean(busy), onClick: () => void refreshConnection() }, '检查开通状态'),
        busy ? h('span', { role: 'status', style: { color: 'var(--dsw-alias-label-secondary, #536174)', fontSize: 12 } }, '处理中，请稍候…') : null) : null) : null,
    // 可见的构建标记：嵌入到外壳时由外壳页脚统一展示，避免桌面内再叠一层诊断。
    embedded ? null : h('span', { 'data-personal-assistant-build-badge': PERSONAL_ASSISTANT_CLIENT_BUILD, 'aria-hidden': true,
      style: { position: 'absolute', left: 6, bottom: 4, zIndex: 3, pointerEvents: 'none', fontSize: 10, lineHeight: '12px',
        padding: '1px 5px', borderRadius: 4, color: '#fff', background: '#0f172acc', fontFamily: 'ui-monospace, monospace' } },
      `构建 ${localBuildLabel(PERSONAL_ASSISTANT_CLIENT_BUILD)}`),
    h('input', { ref: inputRef, 'aria-label': '云电脑文本输入', autoComplete: 'off', disabled: !active || (readOnly && !controlRef.current.snapshot.available && !(state.current.mode === 'control' && ['dormant', 'resuming'].includes(phase))), tabIndex: -1, style: { position: 'absolute', width: 1, height: 1, opacity: 0, left: 0, top: 0 }, onKeyDown: key, onKeyUp: key, onPaste: event => { const text = event.clipboardData?.getData?.('text/plain') ?? ''; if (!text) return; event.preventDefault(); void pasteTextToCloud(text); }, onCompositionStart: () => { state.current.composition = true; }, onCompositionEnd: event => { state.current.composition = false; const text = event.currentTarget.value; event.currentTarget.value = ''; if (text) input({ type: 'text', text }); }, onInput: event => { if (state.current.composition || event.nativeEvent?.isComposing) return; const text = event.currentTarget.value; event.currentTarget.value = ''; if (text) input({ type: 'text', text }); } }));
  const secondaryInk = 'var(--dsw-alias-label-secondary, #536174)';
  const ghostStyle = { ...buttonStyle, background: 'transparent', color: 'inherit', border: ui.border };
  const pillStyle = { ...buttonStyle, borderRadius: 999, padding: '7px 16px', border: 'none', fontWeight: 500, background: 'var(--dsw-alias-label-primary, #17202c)', color: 'var(--dsw-alias-bg-layer-1, #fff)' };
  if (computerVariant) {
    return h('section', { 'data-personal-assistant-computer': 'true', style: { ...ui, border: 'none', height: '100%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', fontSize: 13 } },
      variant !== 'native-tab' ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: ui.border } },
        h('strong', { style: { fontWeight: 500 } }, '云电脑'),
        h('span', { role: 'status', 'aria-live': 'polite', style: { color: secondaryInk, fontSize: 12 } }, stateText),
        null) : null,
      readOnly && active && !controlRef.current.snapshot.available ? h('div', { role: 'alert', style: { background: '#fff0d6', color: '#763c00', padding: '8px 12px' } }, '只读旁观：鼠标和键盘不会发送到云电脑') : null,
      h('div', { 'data-personal-assistant-desktop-layout': 'true', style: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 16px 12px', boxSizing: 'border-box' } },
      h('div', { ref: stageAreaRef, 'data-personal-assistant-desktop-stack': 'true', style: { width: '100%', maxWidth: 1280, minHeight: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 } },
      onboarding || stage,
      active || selectable ? h('div', { ref: controlCapsuleRef, 'data-personal-assistant-control-capsule': 'true', role: 'status', 'aria-live': 'polite', style: { flex: 'none', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 6, width: 'fit-content', maxWidth: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-1, #fff)', border: ui.border, boxShadow: '0 1px 4px #10182808', lineHeight: 1.5 } },
        !active && selectable ? h('button', { style: pillStyle, disabled: ['connecting', 'resuming'].includes(phase), onClick: () => void open(state.current.handoffSupported ? 'observe' : 'read') }, phase === 'connecting' ? '正在启动…' : '重新连接') : null,
        active && readOnly ? h('span', { style: { color: secondaryInk, fontSize: 12 } }, controlPhase === 'acquiring' ? '正在接管…' : controlPhase === 'releasing' ? '正在交还…' : '助理正在使用 · 点画面即可接管') : null,
        active && readOnly && controlRef.current.snapshot.available ? h('button', { style: { ...pillStyle, padding: '3px 9px', fontSize: 11 }, onClick: () => controlRef.current.acquire() }, '接管') : null,
        active && !readOnly ? h('span', { style: { color: secondaryInk, fontSize: 12 } }, '您拥有控制权 · 点画面外释放') : null,
        active && !readOnly ? h('button', { style: { ...ghostStyle, padding: '3px 9px', fontSize: 11 }, onClick: releaseControl }, '交还') : null,
        active && notice ? h('span', { style: { color: secondaryInk, fontSize: 12 } }, notice) : null,
        // 剪贴板不再放按钮：面板里只保留 ⌘V 粘贴 / ⌘C 复制与一行状态文字。
        active && clipboardNotice ? h('span', { role: 'status', 'aria-live': 'polite', style: { color: secondaryInk, fontSize: 12 } }, clipboardNotice) : null) : null),
      ),
      h('details', { style: { flex: 'none', alignSelf: 'flex-end', color: 'var(--dsw-alias-label-tertiary, #76808e)', fontSize: 11, opacity: 0.8, maxWidth: '100%', overflowWrap: 'anywhere' } }, h('summary', { style: { cursor: 'pointer' } }, '诊断'), h('small', { 'data-personal-assistant-build': PERSONAL_ASSISTANT_CLIENT_BUILD }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`)));
  }
  return h('section', { 'data-personal-assistant-panel': 'true', 'data-personal-assistant-embedded': embedded ? 'true' : undefined, style: { ...ui, border: 'none', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', fontSize: 13 } },
    embedded ? null : h('header', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: 12, borderBottom: ui.border } },
      typeof onBack === 'function' ? h('button', { type: 'button', 'aria-label': '返回', title: '返回对话', onClick: onBack, style: { ...buttonStyle, padding: '4px 8px' } }, '←') : null,
      h('strong', { style: { fontWeight: 500, marginRight: 8 } }, '个人助理'),
      selectable && ['idle', 'closed', 'error'].includes(phase) ? h('button', { style: buttonStyle, onClick: () => void refreshConnection() }, '刷新助理列表') : null,
      typeof openInSidebar === 'function' ? h('button', { style: buttonStyle, onClick: openInSidebar }, '放到右侧栏') : null,
      selectable ? h('button', { style: buttonStyle, disabled: ['connecting', 'resuming'].includes(phase), onClick: () => phase === 'dormant' ? resumeIdle() : void open(state.current.handoffSupported ? 'observe' : 'control') }, phase === 'dormant' ? '恢复画面' : readOnly && phase === 'readonly' ? '申请控制' : active ? '重新连接' : '连接云电脑') : null,
      selectable ? h('button', { style: buttonStyle, disabled: phase === 'connecting', onClick: () => void open('read') }, '只读旁观') : null,
      connectionDot ? h('span', { style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' } }, connectionDot) : null,
      active ? h('span', { role: 'status', 'aria-live': 'polite', style: { marginLeft: connectionDot ? 4 : 'auto', color: 'var(--dsw-alias-label-secondary, #536174)' } }, stateText) : null),
    phase === 'readonly' ? h('div', { role: 'alert', style: { background: '#fff0d6', color: '#763c00', padding: '8px 12px' } }, '当前为只读旁观，鼠标和键盘输入不会发送；可申请控制') : null,
    active && notice ? h('div', { role: 'status', style: { padding: '8px 12px' } }, notice) : null,
    // E7：整页面板（shell 桌面 tab）也要显示剪贴板提示，不能只留在 computer 变体里。
    active && clipboardNotice ? h('div', { role: 'status', 'aria-live': 'polite', style: { padding: '8px 12px', color: 'var(--dsw-alias-label-secondary, #536174)', fontSize: 12 } }, clipboardNotice) : null,
    onboarding || stage,
    embedded ? null : h('footer', { style: { display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 12, padding: '7px 12px', color: 'var(--dsw-alias-label-secondary, #536174)', borderTop: ui.border } },
      h('details', { open: diagnosticsOpen, onToggle: event => setDiagnosticsOpen(event.currentTarget.open) }, h('summary', { style: { cursor: 'pointer' } }, '诊断'),
        directoryCloseCode ? h('div', { style: { paddingTop: 8 } }, `目录连接关闭码：${directoryCloseCode}`) : null,
        h('div', { style: { paddingTop: 8, lineHeight: 1.8, overflowWrap: 'anywhere' } }, h('div', null, `云端实例：${config?.agentId || '未开通'}`), h('div', null, `连接标识：${botId || '未连接'}`), h('div', null, `画面帧率：${fps} fps`), h('div', null, '快捷键会转发到云电脑；Esc 优先退出全屏'))),
      h('small', { 'data-personal-assistant-build': PERSONAL_ASSISTANT_CLIENT_BUILD, style: { opacity: 0.75 } }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`)));
}


/** 主面板：对话式入口，云电脑在右侧栏。 */
export function PersonalAssistantHome({ request, nativeWorkbench, sessionSurface = false } = {}) {
  const R = clientReact || globalThis.React;
  if (!R) return '个人助理页面尚未就绪，请重新打开';
  const { createElement: h, useEffect, useState, useCallback } = R;
  const [scope, setScope] = useState(null);
  const [error, setError] = useState('');
  const [binding, setBinding] = useState(null);
  const [bindingBusy, setBindingBusy] = useState('');
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setScope(null); setError(''); setBinding(null);
    void (async () => {
      try {
        const config = await request('personal-assistant.configuration');
        if (!config.configured) {
          // 未开通不是错误：读一次不抛错的绑定快照，交给引导页决定「开通」还是「复用」。
          const snapshot = await request('personal-assistant.desktop.status').catch(() => null);
          if (!cancelled) setBinding(snapshot || { configured: false, reason: 'unavailable', candidates: [] });
          return;
        }
        const directory = await request('personal-assistant.bots.list');
        if (directory.directoryAvailable !== true) throw new Error('暂时无法连接云端助理，请稍后重试');
        const botId = resolveAssistantBotId(directory.bots, config.botId || directory.primaryBotId);
        if (!cancelled) setScope({ agentId: config.agentId, botId });
      } catch (failure) { if (!cancelled) setError(failure.message || '云端助理暂不可用'); }
    })();
    return () => { cancelled = true; };
  }, [request, attempt]);
  const scopedRequest = useCallback((operation, payload = {}) => {
    if (!scope) throw new Error('云端助理尚未连接');
    if (payload.agentId && payload.agentId !== scope.agentId) throw new Error('云端实例不一致');
    if (operation !== 'personal-assistant.bots.list' && payload.botId && payload.botId !== scope.botId) throw new Error('云端助理不一致');
    return request(operation, { ...payload, ...scope });
  }, [request, scope?.agentId, scope?.botId]);
  useEffect(() => { if (scope && nativeWorkbench?.available) nativeWorkbench.bind(scope, scopedRequest); else if (scope) setError(nativeWorkbench?.unavailableReason || '当前宿主需要更新原生侧栏组件'); }, [nativeWorkbench, scopedRequest, scope?.agentId, scope?.botId]);
  const guidance = binding ? unconfiguredGuidance(binding) : null;
  const runBinding = action => {
    if (bindingBusy) return;
    setBindingBusy(action); setError('');
    void (async () => {
      try { await request(`personal-assistant.desktop.${action}`); retry(value => value + 1); }
      catch (reason) { setError(reason?.message || '操作失败，请稍后重试'); }
      finally { setBindingBusy(''); }
    })();
  };
  if (!scope && guidance) return h('div', { 'data-personal-assistant-onboarding': 'true', style: onboardingStyle.page },
    h('div', { 'data-window-drag': '', style: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' } },
      h('div', { style: onboardingStyle.eyebrow }, '个人助理 · 开通引导'),
      h('h2', { style: onboardingStyle.title }, guidance.title)),
    h('p', { style: onboardingStyle.detail }, guidance.detail),
    h('div', { style: onboardingStyle.actions },
      guidance.actions.map(action => h('button', {
        key: action.id, disabled: Boolean(bindingBusy),
        style: action.primary ? onboardingStyle.primary : onboardingStyle.ghost,
        onClick: () => action.id === 'check' ? retry(value => value + 1) : runBinding(action.id),
      }, bindingBusy === action.id ? '处理中…' : action.label))),
    error ? h('p', { role: 'alert', style: { ...onboardingStyle.notice, color: '#b42318' } }, error) : null);
  if (!scope) return h('div', { role: 'status', style: { padding: 24 } }, error || '正在连接云端个人助理…', error ? h('button', { onClick: () => retry(value => value + 1) }, '重新连接') : null);
  if (!nativeWorkbench?.available) return h('div', { role: 'alert', style: { padding: 24 } }, '当前宿主尚未提供原生云电脑侧栏，请更新 DSH Host 后重新打开。');
  return h('div', {
    key: `${scope.agentId}:${scope.botId}`, 'data-personal-assistant-home': 'true',
    'data-agent-id': scope.agentId, 'data-bot-id': scope.botId,
    style: { flex: '1 1 0px', height: '100%', maxHeight: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' },
  }, h(PersonalAssistantConversation, { React: R, request: scopedRequest, scope, markdown: clientMarkdown, sessionSurface, onOpenComputer: () => nativeWorkbench.open() }));

}

/**
 * DSH Session-scoped Personal Assistant view.
 *
 * This is the surface mounted by `conversation.view`, so the host keeps its
 * normal Session chrome and can mount the cloud computer in the native right
 * sidebar.  The old global `main` panel remains available as an exported
 * legacy component for consumers that embed it directly, but the plugin entry
 * no longer uses it as the primary Personal Assistant route.
 */
export function PersonalAssistantSessionView({ request, sessionId, sidebarRight } = {}) {
  const R = clientReact || globalThis.React;
  if (!R) return '个人助理会话页面尚未就绪，请重新打开';
  const { createElement: h, useEffect, useRef } = R;
  const bridgeRef = useRef(null);
  if (!bridgeRef.current || bridgeRef.current.sessionId !== sessionId) {
    bridgeRef.current?.workbench?.dispose?.();
    bridgeRef.current = {
      sessionId,
      workbench: createSessionAssistantWorkbench({ sidebarRight, kind: PERSONAL_ASSISTANT_COMPUTER_TAB }),
    };
  }
  const workbench = bridgeRef.current.workbench;
  useEffect(() => () => workbench.dispose?.(), [workbench]);
  return h(PersonalAssistantHome, { request, nativeWorkbench: workbench, sessionSurface: true });
}

/** DSH's resident composer is replaced by the Personal Assistant composer. */
export function PersonalAssistantComposerPlaceholder() { return null; }

function storedPersonalAssistantSessionId() {
  try {
    const id = String(globalThis.localStorage?.getItem(PERSONAL_ASSISTANT_DSH_SESSION_KEY) || '').trim();
    if (!id) return '';
    const raw = globalThis.localStorage?.getItem(`dsh.conversation.${id}`);
    const state = raw ? JSON.parse(raw) : null;
    if (state?.personalAssistantOwned !== true || state.view !== PERSONAL_ASSISTANT_VIEW_ID) return '';
    personalAssistantDshSessions.add(id);
    return id;
  } catch { return ''; }
}

function rememberPersonalAssistantSessionId(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  personalAssistantDshSessions.add(id);
  try { globalThis.localStorage?.setItem(PERSONAL_ASSISTANT_DSH_SESSION_KEY, id); } catch { /* storage is optional */ }
}

function forgetPersonalAssistantSessionId(sessionId) {
  const id = String(sessionId || '').trim();
  if (id) personalAssistantDshSessions.delete(id);
  try {
    if (!sessionId || String(globalThis.localStorage?.getItem(PERSONAL_ASSISTANT_DSH_SESSION_KEY) || '') === id) {
      globalThis.localStorage?.removeItem(PERSONAL_ASSISTANT_DSH_SESSION_KEY);
    }
  } catch { /* storage is optional */ }
}

function persistPersonalAssistantView(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  try {
    const key = `dsh.conversation.${id}`;
    let state = {};
    const raw = globalThis.localStorage?.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') state = parsed;
    }
    state.view = PERSONAL_ASSISTANT_VIEW_ID;
    state.personalAssistantOwned = true;
    state.viewRequest = null;
    globalThis.localStorage?.setItem(key, JSON.stringify(state));
  } catch { /* storage is optional */ }
}

/** Small loading surface shown only while the main panel hands navigation to DSH. */
export function PersonalAssistantSessionLauncher({ openSession } = {}) {
  const R = clientReact || globalThis.React;
  if (!R) return '正在打开个人助理会话…';
  const { createElement: h, useEffect, useRef, useState } = R;
  const started = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (started.current || typeof openSession !== 'function') return undefined;
    started.current = true;
    let alive = true;
    Promise.resolve().then(() => openSession()).catch(reason => {
      if (alive) setError(reason?.message || '无法打开个人助理会话');
    });
    return () => { alive = false; };
  }, [openSession]);
  return h('div', {
    'data-personal-assistant-session-launcher': 'true', role: error ? 'alert' : 'status',
    style: { height: '100%', display: 'grid', placeItems: 'center', padding: 24, color: 'var(--dsw-alias-label-secondary, #536174)' },
  }, error || '正在打开个人助理会话…');
}


/* ------------------------------------------------------------------ *
 * 面板外壳：panelView 状态机（list|detail|settings|create|chat|desktop）。
 *
 * 职责边界（契约第 1、4 章）：
 * - 视图是纯函数，只接收数据与回调；本文件负责所有 personal-assistant.* RPC。
 * - 每个新 RPC 都允许 Host 尚未实现：catch 后回落到 localStorage 缓存 / 空状态 / 骨架，
 *   绝不让异常冒到 React 树外，也不出现整页空白。
 * - stale-while-revalidate：overview、bot.detail、settings.inspect 先回显缓存再校准。
 * ------------------------------------------------------------------ */

/** 面板缓存前缀（契约第 4 章第 2 条）。 */
const PANEL_CACHE_PREFIX = 'personal-assistant.cache.';
/** 只保留最近几份面板数据，避免长期占用 localStorage 配额。 */
const PANEL_CACHE_MAX_ENTRIES = 8;

const panelCacheKey = name => `${PANEL_CACHE_PREFIX}${name}`;
const panelCacheStorage = () => {
  try { return globalThis.localStorage || null; } catch { return null; }
};

/** 读缓存：JSON 损坏、隐私模式、配额满都返回 null，调用方按无缓存处理。 */
function readPanelCache(name) {
  try {
    const raw = panelCacheStorage()?.getItem(panelCacheKey(name));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('value' in parsed)) return null;
    return parsed;
  } catch { return null; }
}

/** 写缓存：失败静默降级（不阻断请求结果上屏）。 */
function writePanelCache(name, value) {
  try {
    const storage = panelCacheStorage();
    if (!storage) return false;
    storage.setItem(panelCacheKey(name), JSON.stringify({ at: Date.now(), value }));
    prunePanelCache(storage);
    return true;
  } catch { return false; }
}

function removePanelCache(name) {
  try { panelCacheStorage()?.removeItem(panelCacheKey(name)); } catch { /* 忽略 */ }
}

function prunePanelCache(storage) {
  try {
    const entries = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key !== 'string' || !key.startsWith(PANEL_CACHE_PREFIX)) continue;
      let at = 0;
      try { at = Number(JSON.parse(storage.getItem(key) || '{}')?.at) || 0; } catch { at = 0; }
      entries.push({ key, at });
    }
    if (entries.length <= PANEL_CACHE_MAX_ENTRIES) return;
    for (const entry of entries.sort((left, right) => left.at - right.at).slice(0, entries.length - PANEL_CACHE_MAX_ENTRIES)) storage.removeItem(entry.key);
  } catch { /* 忽略 */ }
}

const BOT_STATUSES = new Set(['running', 'idle', 'offline']);
const COMPUTER_STATES = new Set(['connected', 'idle', 'offline']);
const isUnavailableFailure = failure => failure?.code === 'PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE'
  || failure?.code === 'PERSONAL_ASSISTANT_OPERATION_UNKNOWN' || Number(failure?.status) === 404;

/** 列表/详情共用的 Bot 概要归一化：字段缺失时给安全默认值，不把 undefined 画到界面上。 */
function normalizeBot(row, index = 0, primaryId = '') {
  const id = String(row?.id ?? row?.botId ?? '').trim() || `bot-${index}`;
  const role = row?.role === 'primary' || row?.role === 'custom'
    ? row.role
    : (id === primaryId || (index === 0 && !primaryId) ? 'primary' : 'custom');
  return {
    id,
    name: String(row?.name ?? row?.displayName ?? '个人助理').slice(0, 64) || '个人助理',
    role,
    status: BOT_STATUSES.has(row?.status) ? row.status : 'idle',
    model: String(row?.model ?? ''),
    memoryCount: Number.isFinite(Number(row?.memoryCount)) ? Number(row.memoryCount) : 0,
    capabilityCount: Number.isFinite(Number(row?.capabilityCount)) ? Number(row.capabilityCount) : 0,
    computer: COMPUTER_STATES.has(row?.computer) ? row.computer : 'offline',
  };
}

function normalizeActive(row, index, bots) {
  const kind = row?.kind === 'approval' ? 'approval' : 'turn';
  const botId = String(row?.botId ?? '');
  const bot = bots.find(item => item.id === botId);
  return {
    id: String(row?.id ?? `${kind}-${index}`),
    kind, botId, botName: String(row?.botName ?? bot?.name ?? ''),
    title: String(row?.title ?? (kind === 'approval' ? '需要你确认一个操作' : '助理正在执行任务')),
    detail: String(row?.detail ?? ''),
    approvalId: String(row?.approvalId ?? ''),
    elapsedMs: Number(row?.elapsedMs) || 0,
  };
}

function normalizeRecent(row, index, bots) {
  const botId = String(row?.botId ?? '');
  const bot = bots.find(item => item.id === botId);
  return {
    id: String(row?.id ?? `recent-${index}`),
    title: String(row?.title ?? '完成了一个任务'),
    status: row?.status === 'failed' ? 'failed' : 'done',
    at: String(row?.at ?? ''),
    botId, botName: String(row?.botName ?? bot?.name ?? ''),
  };
}

/** bots.overview → 视图数据；目录兜底时标记 degraded，UI 显示「部分数据暂不可用」。 */
function normalizeOverview(raw, fallbackBots = [], primaryId = '') {
  const rows = Array.isArray(raw?.bots) && raw.bots.length ? raw.bots : fallbackBots;
  const bots = rows.map((row, index) => normalizeBot(row, index, primaryId));
  return {
    bots,
    active: Array.isArray(raw?.active) ? raw.active.filter(row => row && typeof row === 'object').map((row, index) => normalizeActive(row, index, bots)) : [],
    recent: Array.isArray(raw?.recent) ? raw.recent.filter(row => row && typeof row === 'object').map((row, index) => normalizeRecent(row, index, bots)) : [],
    counts: raw?.counts && typeof raw.counts === 'object' ? {
      schedules: Number(raw.counts.schedules) || 0,
      memories: Number(raw.counts.memories) || 0,
      files: Number(raw.counts.files) || 0,
    } : null,
    degraded: raw?.degraded === true,
  };
}

/** 目录兜底：Host 还没实现 bots.overview 时，用已有 bots.list 拼出可点击的列表。 */
function overviewFromDirectory(directoryBots, primaryId) {
  return normalizeOverview({ bots: directoryBots.map((row, index) => normalizeBot(row, index, primaryId)), active: [], recent: [], counts: null, degraded: true });
}

function normalizeDetail(raw, botId, fallbackBot = null) {
  const botRow = raw?.bot && typeof raw.bot === 'object' ? raw.bot : (fallbackBot || { id: botId });
  const bot = {
    ...normalizeBot(botRow, 0, botRow.role === 'primary' ? botId : ''),
    id: String(botRow.id ?? botId),
    name: String(botRow.name ?? fallbackBot?.name ?? '个人助理'),
    description: String(botRow.description ?? ''),
    createdAt: String(raw?.createdAt ?? botRow.createdAt ?? ''),
    lastActiveAt: String(botRow.lastActiveAt ?? ''),
    modelDetail: String(botRow.modelDetail ?? ''),
  };
  const memoryItems = Array.isArray(raw?.memory?.items) ? raw.memory.items : [];
  return {
    bot,
    memory: {
      count: Number.isFinite(Number(raw?.memory?.count)) ? Number(raw.memory.count) : memoryItems.length,
      items: memoryItems.filter(item => item && typeof item === 'object').map((item, index) => ({
        id: String(item.id ?? `memory-${index}`),
        text: String(item.text ?? ''),
        scope: String(item.scope ?? ''),
      })),
    },
    capabilities: Array.isArray(raw?.capabilities) ? raw.capabilities.filter(row => row && typeof row === 'object').map(row => ({
      id: String(row.id ?? ''), label: String(row.label ?? row.id ?? '能力'),
      source: row.source === 'mcp' ? 'mcp' : 'builtin', status: row.status === 'error' ? 'error' : 'ready',
    })) : [],
    computer: raw?.computer && typeof raw.computer === 'object' ? {
      connected: raw.computer.connected === true,
      resolution: String(raw.computer.resolution ?? ''),
      usage: raw.computer.usage && typeof raw.computer.usage === 'object'
        ? { tokens: String(raw.computer.usage.tokens ?? ''), hours: String(raw.computer.usage.hours ?? '') } : null,
    } : null,
    // Host 的目录/本机状态不可用时会显式给 degraded，页面按「部分数据暂不可用」展示。
    degraded: raw?.degraded === true,
  };
}

function normalizeCreateStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stage = String(raw.stage ?? '');
  return {
    instanceId: String(raw.instanceId ?? ''),
    stage,
    stages: Array.isArray(raw.stages) ? raw.stages.filter(row => row && typeof row === 'object').map(row => ({
      id: String(row.id ?? ''),
      status: ['done', 'active', 'pending', 'failed'].includes(row.status) ? row.status : 'pending',
      detail: String(row.detail ?? ''),
    })) : [],
    elapsedMs: Number(raw.elapsedMs) || 0,
    estimatedRemainingMs: Number(raw.estimatedRemainingMs) || 0,
    error: raw.error ? String(raw.error) : '',
  };
}

/** Host create.status 的默认快照也是 instance/pending；只有 active 阶段或剩余时间才代表正在创建。 */
function isCreateProgressActive(status) {
  if (!status || !status.stage || status.stage === 'done' || status.stage === 'failed') return false;
  if (status.stages.some(stage => stage.status === 'active')) return true;
  if (status.estimatedRemainingMs > 0) return true;
  return status.stage === 'instance' && status.elapsedMs > 0;
}

function settingsDraftFrom(inspect) {
  return {
    model: String(inspect?.model ?? ''),
    prompt: String(inspect?.prompt ?? ''),
    environmentVariables: Array.isArray(inspect?.environmentVariables)
      ? inspect.environmentVariables.filter(row => row && typeof row === 'object').map(row => ({
        key: String(row.key ?? ''), value: String(row.value ?? ''), sensitive: row.sensitive === true, saved: true, dirty: false,
      }))
      : [],
  };
}

const SHELL_KEYFRAMES = '@keyframes pa-skeleton { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }@keyframes pa-spin { to { transform: rotate(360deg) } }';

/**
 * 面板外壳组件：注册在 main 槽位。
 * props 与旧 PersonalAssistantHome 对齐，便于宿主无感切换。
 */
export function PersonalAssistantShell({ request, nativeWorkbench, initialBotId = '' } = {}) {
  const R = clientReact || globalThis.React;
  if (!R) return '个人助理页面尚未就绪，请重新打开';
  const { createElement: h, useEffect, useRef, useState } = R;

  // G3.5：把「已开通 + 云实例/Bot 身份」与概览一起放进 SWR 缓存。重开面板时首帧直接按
  // 上次的 Bot 列表渲染，configuration 仍在后台真实校准（失败只提示，不退回开通报板）。
  // 缓存只在首帧读一次，后续重新渲染不重复打 localStorage。
  const bootCacheRef = useRef(null);
  if (!bootCacheRef.current) bootCacheRef.current = { shell: readPanelCache('shell'), overview: readPanelCache('overview') };
  const bootShellCache = bootCacheRef.current.shell?.value;
  const bootOverviewCache = bootCacheRef.current.overview?.value || null;
  const bootConfig = bootShellCache?.configured === true
    ? { configured: true, agentId: String(bootShellCache.agentId || ''), botId: String(bootShellCache.botId || '') }
    : null;

  // —— 导航 ——
  const [panelView, setPanelView] = useState('list');
  // —— 本机连接/授权（三态圆点口径）——
  const [connection, setConnection] = useState({ connected: false, authorized: false, scopes: [], riskConfirm: true, grantedAt: null, host: null, loading: true, unavailable: false });
  const [localAccessOpen, setLocalAccessOpen] = useState(false);
  const [localScopes, setLocalScopes] = useState(LOCAL_ACCESS_SCOPES.map(scope => scope.id));
  const [riskConfirmDraft, setRiskConfirmDraft] = useState(true);
  const [localBusy, setLocalBusy] = useState('');
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  // 撤销时间戳：对话页未挂载时也要能补系统提示（契约第 4 章第 4 条）。
  const [localRevokedAt, setLocalRevokedAt] = useState('');
  // —— 列表概览（首帧用缓存，避免在 configuration 返回前停在「正在读取开通状态…」）——
  const [overview, setOverview] = useState(bootOverviewCache);
  const [overviewLoading, setOverviewLoading] = useState(!bootOverviewCache);
  const [overviewDegraded, setOverviewDegraded] = useState(bootOverviewCache?.degraded === true);
  const [config, setConfig] = useState(bootConfig);
  const [binding, setBinding] = useState(null);
  const [bindingBusy, setBindingBusy] = useState('');
  const [scope, setScope] = useState(bootConfig ? { agentId: bootConfig.agentId, botId: bootConfig.botId } : null);
  const [selectedBotId, setSelectedBotId] = useState(String(initialBotId || bootConfig?.botId || ''));
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [showAllActivity, setShowAllActivity] = useState(false);
  // —— 历史会话 ——
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [sessions, setSessions] = useState([]);
  const [chatSessionId, setChatSessionId] = useState('');
  // —— 详情 ——
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailDegraded, setDetailDegraded] = useState(false);
  const [manageMemory, setManageMemory] = useState(false);
  const [showAllMemory, setShowAllMemory] = useState(false);
  const [modelBusy, setModelBusy] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState({ open: false, text: '', busy: false, error: '' });
  const [createBot, setCreateBot] = useState({ open: false, name: '', busy: false, error: '' });
  // —— 设置 ——
  const [settingsInspect, setSettingsInspect] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsDegraded, setSettingsDegraded] = useState(false);
  const [settingsVersions, setSettingsVersions] = useState(null);
  const [settingsBusy, setSettingsBusy] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [settingsNotice, setSettingsNotice] = useState('');
  const [settingsDraft, setSettingsDraft] = useState({ model: '', prompt: '', environmentVariables: [] });
  const [envDeletes, setEnvDeletes] = useState([]);
  const [closeAssistant, setCloseAssistant] = useState({ open: false, text: '', busy: false, error: '', closedNotice: '' });
  // —— 首次创建 ——
  const [createStatus, setCreateStatus] = useState(null);
  const [createCollapsed, setCreateCollapsed] = useState(false);
  const [createDiagnostics, setCreateDiagnostics] = useState(false);
  const [createNotice, setCreateNotice] = useState('');
  const [createError, setCreateError] = useState('');

  const aliveRef = useRef(true);
  const previousAuthorizedRef = useRef(undefined);
  const createTimerRef = useRef(null);
  const createStartedAtRef = useRef(0);
  const createAttemptRef = useRef(0);
  const createRequestPendingRef = useRef(false);
  const createCollapsedRef = useRef(false);
  createCollapsedRef.current = createCollapsed;

  const rpc = async (operation, payload = {}) => {
    if (typeof request !== 'function') throw new Error('DSH Host Host 尚未连接');
    return request(operation, payload);
  };
  /** 带上 scope 的请求：会话类 RPC 需要 agentId/botId 一起传，宿主按 scope 路由。 */
  const scopedCall = (operation, payload = {}) => {
    const extra = {};
    if (scope?.agentId) extra.agentId = scope.agentId;
    if (scope?.botId && !payload.botId) extra.botId = scope.botId;
    return rpc(operation, { ...payload, ...extra });
  };
  /** 给指定 scope 造一个绑定请求：切换 Bot 后立即绑定，不依赖下一次渲染的闭包。 */
  const requestForScope = targetScope => (operation, payload = {}) => {
    if (!targetScope) throw new Error('云端助理尚未连接');
    if (payload.agentId && payload.agentId !== targetScope.agentId) throw new Error('云端实例不一致');
    if (operation !== 'personal-assistant.bots.list' && payload.botId && payload.botId !== targetScope.botId) throw new Error('云端助理不一致');
    return request(operation, { ...payload, ...targetScope });
  };
  const scopedRequest = scope ? requestForScope(scope) : null;
  /** 云电脑面板自己会选 Bot，这里只补 agentId，不校验 botId。 */
  const panelRequest = (operation, payload = {}) => request(operation, {
    ...payload,
    ...(scope?.agentId && !payload.agentId ? { agentId: scope.agentId } : {}),
  });
  const clearCreateTimer = () => { if (createTimerRef.current) { clearTimeout(createTimerRef.current); createTimerRef.current = null; } };
  const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

  /* ---------- 本机连接/授权 ---------- */

  const loadConnection = async () => {
    try {
      const value = await rpc('personal-assistant.local-access.status');
      const next = {
        connected: value?.connected === true,
        authorized: value?.authorized === true,
        scopes: Array.isArray(value?.scopes) ? value.scopes.map(String) : [],
        riskConfirm: value?.riskConfirm !== false,
        grantedAt: value?.grantedAt ? String(value.grantedAt) : null,
        host: value?.host && typeof value.host === 'object' ? value.host : null,
        loading: false,
        unavailable: false,
      };
      setConnection(next);
      // 授权可能被 Host 自动撤销（超时/权限变更），这里也要补系统提示，不能只看按钮动作。
      const previousAuthorized = previousAuthorizedRef.current;
      previousAuthorizedRef.current = next.authorized;
      if (previousAuthorized === true && next.authorized === false) setLocalRevokedAt(String(Date.now()));
      if (!next.authorized) setLocalScopes(next.scopes.length ? next.scopes : LOCAL_ACCESS_SCOPES.map(item => item.id));
      setRiskConfirmDraft(next.riskConfirm);
      return next;
    } catch {
      // Host 尚未实现 local-access.status：按「未连接」处理。绝不能猜成已授权。
      setConnection({ connected: false, authorized: false, scopes: [], riskConfirm: true, grantedAt: null, host: null, loading: false, unavailable: true });
      setLocalScopes(LOCAL_ACCESS_SCOPES.map(item => item.id));
      return null;
    }
  };

  const grantLocalAccess = async () => {
    if (localBusy) return;
    setLocalBusy('grant'); setLocalError(''); setLocalNotice('');
    try {
      await rpc('personal-assistant.local-access.grant', { scopes: localScopes, riskConfirm: riskConfirmDraft });
      const next = await loadConnection();
      setLocalNotice(next?.authorized ? '已授权本机控制' : '授权已提交，等待本机确认');
    } catch (failure) {
      setLocalError(failure?.message || '授权失败：Host 尚未提供本机授权能力');
    } finally { setLocalBusy(''); }
  };

  const revokeLocalAccess = async () => {
    if (localBusy) return;
    setLocalBusy('revoke'); setLocalError(''); setLocalNotice('');
    try {
      await rpc('personal-assistant.local-access.revoke');
      setLocalRevokedAt(String(Date.now()));
      await loadConnection();
      setLocalNotice('已撤销本机授权');
    } catch (failure) {
      setLocalError(failure?.message || '撤销失败：Host 尚未提供本机授权能力');
    } finally { setLocalBusy(''); }
  };

  /* ---------- 概览 / 作用域 ---------- */

  const loadOverview = async ({ fallbackBots = [], primaryId = '' } = {}) => {
    try {
      const raw = await rpc('personal-assistant.bots.overview');
      const normalized = normalizeOverview(raw, fallbackBots, primaryId);
      setOverview(normalized);
      setOverviewDegraded(normalized.degraded === true);
      writePanelCache('overview', normalized);
    } catch (failure) {
      // 降级 1：用目录拼最小概览（可点、可进详情）；降级 2：保留缓存；否则空状态。
      const fallback = fallbackBots.length ? overviewFromDirectory(fallbackBots, primaryId) : null;
      if (fallback) {
        setOverview(previous => previous || fallback);
        setOverviewDegraded(true);
        writePanelCache('overview', fallback);
      } else {
        setOverview(previous => previous || { bots: [], active: [], recent: [], counts: null, degraded: true });
        setOverviewDegraded(true);
      }
      if (!isUnavailableFailure(failure)) setNotice(failure?.message || '暂时读不到 Bot 概览，已展示缓存数据');
    } finally {
      setOverviewLoading(false);
    }
  };

  const loadSessions = async () => {
    setHistoryLoading(true); setHistoryError('');
    try {
      const value = await scopedCall('personal-assistant.sessions.list');
      const rows = Array.isArray(value?.sessions) ? value.sessions.filter(row => row && row.sessionId) : [];
      setSessions(rows.map(row => ({ id: String(row.sessionId), title: String(row.title ?? row.sessionId), at: String(row.updatedAt ?? row.at ?? '') })));
    } catch (failure) {
      setHistoryError('历史会话暂时读不到，稍后重试');
      if (!isUnavailableFailure(failure)) setSessions(previous => previous);
    } finally { setHistoryLoading(false); }
  };

  /** Re-open an in-flight Host creation after the panel was unmounted and mounted again. */
  const recoverCreateProgress = async () => {
    let status;
    try {
      const raw = await rpc('personal-assistant.create.status');
      status = normalizeCreateStatus(raw);
    } catch (failure) {
      // Older Hosts do not expose create.status; the normal binding snapshot below remains the fallback.
      if (!isUnavailableFailure(failure) && Number(failure?.status) !== 404) setCreateError(failure?.message || '读取创建进度失败');
      return false;
    }
    if (!status || (!isCreateProgressActive(status) && status.stage !== 'failed')) return false;
    setCreateStatus(status);
    setCreateError(status.error || '');
    setCreateNotice('');
    setCreateCollapsed(false);
    setCreateDiagnostics(false);
    createStartedAtRef.current = Date.now() - Math.max(0, status.elapsedMs);
    setPanelView('create');
    if (isCreateProgressActive(status)) {
      clearCreateTimer();
      createTimerRef.current = setTimeout(() => { void pollCreateStatus(); }, 0);
    }
    return true;
  };

  /** 首次装载：先回显缓存，再解析 scope 与概览；任何一步失败都落回可操作的界面。 */
  const boot = async ({ recoverOpening = true } = {}) => {
    // 1) 首帧已由 state 初值回显缓存；这里兜底「本次渲染之后才写入」的概览缓存（stale-while-revalidate）。
    const cachedOverview = readPanelCache('overview');
    if (cachedOverview?.value) {
      setOverview(cachedOverview.value);
      setOverviewDegraded(cachedOverview.value.degraded === true);
      setOverviewLoading(false);
    }
    void loadConnection();
    let configValue = null;
    let configFailed = false;
    try { configValue = await rpc('personal-assistant.configuration'); } catch { configFailed = true; }
    if (!aliveRef.current) return;
    // G3.5：真实校准失败时保留缓存首帧（列表、Bot 身份都还在），只提示；不能把列表打回开通报板。
    if (configFailed && bootConfig) {
      setOverviewLoading(false);
      setNotice('暂时读不到云端状态，先展示上次的数据');
      return;
    }
    setConfig(configValue || null);
    if (!configValue?.configured) {
      // 创建请求可能仍在 Host 内进行：重新挂载页面时先恢复进度，不能把进行中的实例误判成「尚未开通」。
      const resumedCreate = recoverOpening && await recoverCreateProgress();
      if (resumedCreate) {
        removePanelCache('shell');
        setBinding(null);
        setOverview(null); setOverviewLoading(false);
        return;
      }
      // 未开通不是错误：交给开通报板（01）。desktop.status 不抛错，用它区分「没有实例」与「读不到」。
      removePanelCache('shell');
      const snapshot = await rpc('personal-assistant.desktop.status').catch(() => null);
      if (!aliveRef.current) return;
      setBinding(snapshot || { configured: false, reason: 'unavailable', candidates: [] });
      setOverview(null); setOverviewLoading(false);
      return;
    }
    setBinding(null);
    let directory = null;
    try { directory = await rpc('personal-assistant.bots.list'); } catch { directory = null; }
    let directoryBots = [];
    try { directoryBots = directory?.directoryAvailable === true ? publicBotDirectory(directory.bots) : []; } catch { directoryBots = []; }
    let botId = '';
    try { botId = directoryBots.length ? resolveAssistantBotId(directoryBots, initialBotId || configValue.botId) : ''; } catch { botId = directoryBots[0]?.botId || ''; }
    if (!aliveRef.current) return;
    const nextScope = { agentId: String(configValue.agentId || ''), botId };
    setScope(nextScope);
    setSelectedBotId(previous => previous || botId);
    // 写回「已开通 + 当前 Bot」：下次重开面板首帧就能直接渲染列表，而不是停在开通报板。
    writePanelCache('shell', { configured: true, agentId: nextScope.agentId, botId });
    if (nativeWorkbench?.available) {
      try { nativeWorkbench.bind(nextScope, requestForScope(nextScope)); } catch { /* 原生侧栏绑定失败不阻断面板 */ }
    }
    await loadOverview({ fallbackBots: directoryBots, primaryId: botId });
    if (!aliveRef.current) return;
    if (!botId) { setOverviewLoading(false); return; }
  };

  useEffect(() => {
    aliveRef.current = true;
    const target = globalThis.window;
    const onConfigurationChanged = () => {
      if (!aliveRef.current) return;
      // The Settings slot may finish binding while this shell stays mounted
      // behind the modal. Re-read the real configuration and scope.
      void boot();
    };
    target?.addEventListener?.(PERSONAL_ASSISTANT_CONFIGURATION_EVENT, onConfigurationChanged);
    void boot();
    return () => {
      aliveRef.current = false;
      target?.removeEventListener?.(PERSONAL_ASSISTANT_CONFIGURATION_EVENT, onConfigurationChanged);
      clearCreateTimer();
    };
    // request 由宿主注入且生命周期内稳定；挂载一次即可，后续动作都走显式刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  /* ---------- 列表动作 ---------- */

  const openChat = (botId = '') => {
    const target = String(botId || '');
    if (target && scope && target !== scope.botId) {
      const nextScope = { ...scope, botId: target };
      setScope(nextScope);
      setSelectedBotId(target);
      setChatSessionId('');
      if (nativeWorkbench?.available) { try { nativeWorkbench.bind(nextScope, requestForScope(nextScope)); } catch { /* 忽略 */ } }
      writePanelCache('shell', { configured: true, agentId: nextScope.agentId, botId: target });
    }
    setPanelView('chat');
  };

  const openDetail = (botId) => {
    const id = String(botId || '');
    if (!id) return;
    setSelectedBotId(id);
    setManageMemory(false); setShowAllMemory(false);
    setDeleteConfirm({ open: false, text: '', busy: false, error: '' });
    setPanelView('detail');
    const cached = readPanelCache(`bot-detail.${id}`);
    if (cached?.value) { setDetail(cached.value); setDetailLoading(false); setDetailDegraded(cached.value.degraded === true); }
    else { setDetail(null); setDetailLoading(true); }
    void loadDetail(id);
  };

  const loadDetail = async (botId) => {
    setDetailLoading(true);
    try {
      const raw = await scopedCall('personal-assistant.bot.detail', { botId });
      const fallback = botSummary(botId);
      const normalized = normalizeDetail(raw, botId, fallback);
      setDetail(normalized); setDetailDegraded(normalized.degraded === true);
      writePanelCache(`bot-detail.${botId}`, normalized);
    } catch (failure) {
      // 降级：退回列表里的概要（可看模型与状态），记忆/能力显示空状态。
      setDetail(previous => previous || normalizeDetail({}, botId, botSummary(botId)));
      setDetailDegraded(true);
      if (!isUnavailableFailure(failure)) setNotice(failure?.message || '详情暂时读不到，已展示概要');
    } finally { setDetailLoading(false); }
  };

  const botSummary = botId => (overview?.bots || []).find(bot => bot.id === botId) || { id: botId, name: botId, role: 'custom', status: 'idle', model: '', memoryCount: 0, capabilityCount: 0, computer: 'offline' };

  const changeBotModel = async model => {
    const botId = selectedBotId || detail?.bot?.id;
    if (!botId || !model || modelBusy) return;
    setModelBusy('model'); setNotice('');
    try {
      await scopedCall('personal-assistant.bot.model.update', { botId, model });
      setDetail(previous => previous ? { ...previous, bot: { ...previous.bot, model } } : previous);
      setOverview(previous => previous ? { ...previous, bots: previous.bots.map(bot => bot.id === botId ? { ...bot, model } : bot) } : previous);
      setNotice('模型已切换，从下一条消息生效');
    } catch (failure) {
      setNotice(failure?.message || '模型切换失败，请稍后重试');
    } finally { setModelBusy(''); }
  };

  const deleteMemory = async memoryId => {
    const botId = selectedBotId || detail?.bot?.id;
    if (!botId || !memoryId) return;
    try {
      const result = await scopedCall('personal-assistant.bot.memory.delete', { botId, memoryId });
      if (result?.deleted === false) { setNotice('记忆删除未生效：本机状态存储暂不可用'); return; }
      setDetail(previous => previous ? {
        ...previous,
        memory: {
          count: Math.max(0, Number(previous.memory?.count || 0) - 1),
          items: (previous.memory?.items || []).filter(item => item.id !== memoryId),
        },
      } : previous);
    } catch (failure) { setNotice(failure?.message || '删除记忆失败，请稍后重试'); }
  };

  const submitDeleteBot = async () => {
    const name = String(detail?.bot?.name || '');
    const confirmName = String(deleteConfirm.text || '').trim();
    if (!name || confirmName !== name || deleteConfirm.busy) return;
    const botId = selectedBotId || detail?.bot?.id;
    setDeleteConfirm(previous => ({ ...previous, busy: true, error: '' }));
    try {
      await scopedCall('personal-assistant.bot.delete', { botId, confirmName });
      removePanelCache(`bot-detail.${botId}`);
      setDetail(null); setPanelView('list');
      setNotice('Bot 已删除；云电脑与工作区文件保留');
      await loadOverview();
    } catch (failure) {
      setDeleteConfirm(previous => ({ ...previous, busy: false, error: failure?.message || '删除失败，请稍后重试' }));
    }
  };

  const submitCreateBot = async () => {
    const name = createBot.name.trim();
    if (!name || createBot.busy) return;
    setCreateBot(previous => ({ ...previous, busy: true, error: '' }));
    try {
      const result = await rpc('personal-assistant.bot.create', { name });
      const id = String(result?.bot?.id ?? '');
      setCreateBot({ open: false, name: '', busy: false, error: '' });
      await loadOverview();
      if (id) openDetail(id);
    } catch (failure) {
      setCreateBot(previous => ({ ...previous, busy: false, error: isUnavailableFailure(failure) ? 'Host 尚未提供 Bot 创建能力，请稍后重试' : (failure?.message || '创建 Bot 失败') }));
    }
  };

  /* ---------- 设置 ---------- */

  const applySettingsDraft = inspect => {
    setSettingsInspect(inspect && typeof inspect === 'object' ? inspect : null);
    setSettingsDraft(settingsDraftFrom(inspect));
    setEnvDeletes([]);
  };

  const openSettings = () => {
    setPanelView('settings'); setSettingsError(''); setSettingsNotice('');
    setCloseAssistant(previous => ({ ...previous, open: false, text: '', error: '' }));
    const cached = readPanelCache('settings-inspect');
    if (cached?.value) { applySettingsDraft(cached.value); setSettingsDegraded(false); }
    else { setSettingsInspect(null); setSettingsDraft({ model: config?.model || '', prompt: '', environmentVariables: [] }); }
    void loadSettings();
  };

  const loadSettings = async () => {
    setSettingsLoading(true);
    try {
      const raw = await scopedCall('personal-assistant.settings.inspect');
      applySettingsDraft(raw);
      setSettingsDegraded(false);
      writePanelCache('settings-inspect', raw || {});
      try {
        const versions = await scopedCall('personal-assistant.settings.versions', { currentVersion: raw?.runtime?.version || '' });
        setSettingsVersions(versions && typeof versions === 'object' ? versions : { catalogAvailable: false, versions: [] });
      } catch {
        setSettingsVersions({ catalogAvailable: false, versions: [] });
      }
    } catch (failure) {
      // 降级：保留缓存/空草稿，页面仍可操作（保存时会把真实错误抛回）。
      setSettingsDegraded(true);
      if (!readPanelCache('settings-inspect')?.value) setSettingsDraft({ model: config?.model || '', prompt: '', environmentVariables: [] });
      if (!isUnavailableFailure(failure)) setSettingsError(failure?.message || '读取云端配置失败');
    } finally { setSettingsLoading(false); }
  };

  const saveSettings = async () => {
    if (settingsBusy) return;
    setSettingsBusy('save'); setSettingsError(''); setSettingsNotice('');
    try {
      const environmentVariables = (settingsDraft.environmentVariables || [])
        .filter(row => String(row.key || '').trim())
        .map(row => ({ key: String(row.key).trim(), value: String(row.value ?? ''), sensitive: row.sensitive === true }));
      await scopedCall('personal-assistant.settings.update', {
        model: String(settingsDraft.model || '').trim(),
        prompt: String(settingsDraft.prompt || ''),
        environmentVariables,
        deleteKeys: envDeletes,
      });
      setEnvDeletes([]);
      setSettingsNotice('已提交云端更新，通常 1–2 分钟完成，期间云电脑可能短暂重连。');
      await loadSettings();
    } catch (failure) {
      setSettingsError(failure?.message || '保存失败，请稍后重试');
    } finally { setSettingsBusy(''); }
  };

  const closeAssistantNow = async () => {
    const agentId = String(config?.agentId || '');
    const confirmText = String(closeAssistant.text || '').trim();
    if (!agentId || confirmText !== agentId || closeAssistant.busy) return;
    setCloseAssistant(previous => ({ ...previous, busy: true, error: '' }));
    try {
      await rpc('personal-assistant.desktop.destroy', { confirmAgentId: agentId });
      setCloseAssistant({ open: false, text: '', busy: false, error: '', closedNotice: '个人助理已关闭：云端实例已删除，关联的云资源订单正在释放，本机绑定已清除。' });
      setConfig(previous => ({ ...(previous || {}), configured: false }));
      setOverview(null); setScope(null);
      setPanelView('list');
    } catch (failure) {
      const message = String(failure?.message || '');
      setCloseAssistant(previous => ({
        ...previous, busy: false,
        error: /更新 DSH Host|云连接服务/iu.test(message) ? '当前 DSH Host 版本还不支持关闭个人助理，请更新 DSH Host 后重试。' : (message || '关闭个人助理失败，请稍后重试'),
      }));
    }
  };

  /* ---------- 首次创建 ---------- */

  const creationInProgress = panelView === 'create' && createStatus && !['done', 'failed'].includes(createStatus.stage);
  useEffect(() => {
    if (!creationInProgress) return;
    const timer = setInterval(() => {
      const elapsedMs = Date.now() - createStartedAtRef.current;
      setCreateStatus(previous => previous && !['done', 'failed'].includes(previous.stage) && elapsedMs > previous.elapsedMs
        ? { ...previous, elapsedMs } : previous);
    }, 1_000);
    return () => clearInterval(timer);
  }, [Boolean(creationInProgress)]);

  const pollDesktopReady = async () => {
    try { const value = await rpc('personal-assistant.desktop.status'); return value?.configured === true; } catch { return false; }
  };

  const finishCreate = async () => {
    const attempt = ++createAttemptRef.current;
    clearCreateTimer();
    setCreateNotice('创建完成，正在刷新 Bot 列表…');
    await boot({ recoverOpening: false });
    if (!aliveRef.current || createAttemptRef.current !== attempt) return;
    setPanelView('list');
    setCreateStatus(null);
  };

  const pollCreateStatus = async () => {
    if (!aliveRef.current) return;
    const attempt = createAttemptRef.current;
    const isCurrent = () => aliveRef.current && createAttemptRef.current === attempt;
    try {
      const raw = await rpc('personal-assistant.create.status');
      if (!isCurrent()) return;
      const status = normalizeCreateStatus(raw);
      if (!status) throw Object.assign(new Error('create.status 格式无效'), { code: 'PERSONAL_ASSISTANT_CREATE_STATUS_INVALID' });
      // The previous attempt can still be the Host's last status when a retry
      // starts. The current desktop.create response owns its terminal result.
      if (!createRequestPendingRef.current || !['done', 'failed'].includes(status.stage)) {
        setCreateStatus(previous => ({ ...status, elapsedMs: Math.max(previous?.elapsedMs || 0, status.elapsedMs) }));
        setCreateError(status.error || '');
        if (status.stage === 'done') return finishCreate();
        if (status.stage === 'failed') return;
      }
    } catch (failure) {
      if (!isCurrent()) return;
      // Host 没实现 create.status：退化为轮询 desktop.status，仍然能等到「已开通」；
      // 这段时间用本地阶段占位，界面不空白。
      if (isUnavailableFailure(failure) || Number(failure?.status) === 404) {
        setCreateStatus(previous => previous && previous.stage !== 'failed' ? { ...previous, stage: previous.stage || 'runtime' } : { stage: 'runtime', stages: [], elapsedMs: Date.now() - createStartedAtRef.current, estimatedRemainingMs: 90_000 });
        if (await pollDesktopReady()) {
          if (isCurrent()) return finishCreate();
          return;
        }
      } else {
        setCreateError(failure?.message || '读取创建进度失败，仍在后台创建');
      }
    }
    if (!isCurrent() || createCollapsedRef.current) return;
    clearCreateTimer();
    createTimerRef.current = setTimeout(() => { void pollCreateStatus(); }, 1000);
  };

  const startCreate = async () => {
    if (bindingBusy || createRequestPendingRef.current) return;
    const attempt = ++createAttemptRef.current;
    createRequestPendingRef.current = true;
    setBindingBusy('create'); setNotice(''); setError('');
    setCreateStatus({ stage: 'instance', stages: [], elapsedMs: 0, estimatedRemainingMs: 150_000 });
    setCreateCollapsed(false); setCreateDiagnostics(false);
    setCreateError(''); setCreateNotice('');
    setPanelView('create');
    createStartedAtRef.current = Date.now();
    // desktop.create 可能持续数分钟；进度轮询必须与创建 RPC 并行启动，不能等 RPC 返回后才开始计时。
    clearCreateTimer();
    const creating = rpc('personal-assistant.desktop.create');
    void pollCreateStatus();
    try {
      const result = await creating;
      if (aliveRef.current && createAttemptRef.current === attempt && result?.configured === true) {
        await finishCreate();
      }
    } catch (failure) {
      if (aliveRef.current && createAttemptRef.current === attempt) {
        createAttemptRef.current += 1;
        clearCreateTimer();
        const message = failure?.message || '开通请求没有被云端接受';
        setCreateError(message);
        setCreateStatus(previous => ({ stage: 'failed', stages: [], elapsedMs: previous?.elapsedMs || 0, estimatedRemainingMs: 0, error: message }));
      }
    } finally {
      createRequestPendingRef.current = false;
      if (aliveRef.current) setBindingBusy('');
    }
  };

  const toggleCreateCollapsed = () => {
    const next = !createCollapsed;
    setCreateCollapsed(next);
    if (next) {
      // 收起即停止轮询，但保留已拿到的状态；展开时补一次校准。
      clearCreateTimer();
    } else if (createStatus && !['done', 'failed'].includes(createStatus.stage)) {
      void pollCreateStatus();
    }
  };

  const cancelCreate = () => {
    // 契约没有取消创建的 RPC：创建在云端继续，这里只退出进度页，避免用户以为已取消。
    createAttemptRef.current += 1;
    clearCreateTimer();
    setCreateNotice('创建会在云端继续；完成后会自动出现在列表里。');
    setPanelView('list');
  };

  /* ---------- 历史会话 ---------- */

  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) void loadSessions();
  };

  const openHistorySession = sessionId => {
    setChatSessionId(String(sessionId || ''));
    setPanelView('chat');
  };

  const openCloudComputer = () => {
    // Prefer the host-owned right sidebar when the DSH host exposes it. Older
    // hosts keep the page variant as a safe fallback.
    if (nativeWorkbench?.available && scope?.agentId && scope?.botId) {
      try { nativeWorkbench.open(); return; } catch { /* fallback below */ }
    }
    setPanelView('desktop');
  };

  /* ---------- 渲染 ---------- */

  const bots = overview?.bots || [];
  const runningCount = bots.filter(bot => bot.status === 'running').length;
  const degraded = overviewDegraded || detailDegraded || settingsDegraded;
  // 圆点三态点击口径（契约第 2 章）：authorized/connected 打开授权弹层；offline 是重连。
  const onDotOpen = () => {
    if (connectionStateOf(connection) === 'offline') {
      // offline 的点击含义是「重连」：立刻重查连接，并把结果直接显示在弹层里。
      setLocalAccessOpen(true); setLocalError(''); setLocalNotice('正在重新检查本机连接…');
      void loadConnection().then(next => {
        setLocalNotice(next?.connected ? '本机已连接，可继续授权' : '本机仍未连接：请确认 DSH Host 本机客户端在运行');
      });
      return;
    }
    setLocalAccessOpen(open => !open);
    setLocalError(''); setLocalNotice('');
  };
  const dotNode = connectionDot({ h, connection, onOpen: onDotOpen });
  const configured = config?.configured === true;

  const renderHeader = () => {
    if (panelView === 'list') {
      return h('header', { style: panelUi.header, 'data-window-drag': '' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('span', { style: panelUi.title }, '个人助理'),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: PANEL_TOKENS.inkSoft, minWidth: 0 } },
            h('span', { 'aria-hidden': 'true', style: { flex: 'none', width: 6, height: 6, borderRadius: 999, background: PANEL_TOKENS.success } }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${bots.length} 个 Bot · ${runningCount} 个运行中`))),
        h('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 12 } },
          h('button', { type: 'button', 'data-window-drag-recall': '', onClick: openSettings, style: { border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontSize: 12, color: PANEL_TOKENS.inkSoft, cursor: 'pointer' } }, '设置'),
          dotNode,
          panelButton({ h, label: '新建 Bot', variant: 'primary', 'data-window-drag-recall': '', onClick: () => setCreateBot({ open: true, name: '', busy: false, error: '' }) })));
    }
    if (panelView === 'create') {
      return h('header', { style: panelUi.header, 'data-window-drag': '' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('span', { style: panelUi.title }, '个人助理'),
          h('span', { style: { fontSize: 11, color: PANEL_TOKENS.warn } }, '正在开通')),
        h('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 8 } },
          dotNode,
          panelButton({ h, label: createCollapsed ? '展开' : '收起', variant: 'ghost', 'data-window-drag-recall': '', onClick: toggleCreateCollapsed, style: { height: 30 } })));
    }
    if (panelView === 'desktop') {
      return h('header', { style: { ...panelUi.header, padding: '0 12px 0 8px' }, 'data-window-drag': '' },
        h('button', {
          type: 'button', 'aria-label': '返回对话', title: '返回对话', 'data-window-drag-recall': '', onClick: () => setPanelView('chat'),
          style: { flex: 'none', width: 32, height: 32, display: 'grid', placeItems: 'center', padding: 0, border: 'none', borderRadius: 8, background: 'transparent', color: PANEL_TOKENS.inkSoft, cursor: 'pointer' },
        }, backIcon({ h, size: 14 })),
        h('span', { style: { ...panelUi.title, flex: 1 } }, '云电脑'),
        dotNode);
    }
    // detail / settings：返回 + 标题 + 徽章 + 圆点 + 右侧动作（画板 04/08）
    return h('header', { style: { ...panelUi.header, padding: '0 12px 0 8px' }, 'data-window-drag': '' },
      h('button', {
        type: 'button', 'aria-label': '返回', title: '返回 Bot 列表', 'data-window-drag-recall': '', onClick: () => setPanelView('list'),
        style: { flex: 'none', width: 32, height: 32, display: 'grid', placeItems: 'center', padding: 0, border: 'none', borderRadius: 8, background: 'transparent', color: PANEL_TOKENS.inkSoft, cursor: 'pointer' },
      }, backIcon({ h, size: 14 })),
      h('div', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { ...panelUi.title, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, panelView === 'settings' ? '设置' : (detail?.bot?.name || 'Bot 详情')),
        panelView === 'detail' && detail?.bot?.role === 'primary'
          ? h('span', { style: { borderRadius: 999, padding: '1px 7px', fontSize: 11, lineHeight: 1.7, background: PANEL_TOKENS.subtle, color: PANEL_TOKENS.inkSoft } }, '主助理')
          : null),
      dotNode,
      panelView === 'settings'
        ? panelButton({ h, label: settingsBusy === 'save' ? '保存中…' : '保存', variant: 'primary', 'data-window-drag-recall': '', disabled: settingsBusy === 'save' || !configured || !settingsInspect, onClick: saveSettings, style: { height: 32 } })
        : panelButton({ h, label: '编辑', variant: 'ghost', 'data-window-drag-recall': '', onClick: () => setNotice('模型、记忆与能力可直接在下方调整'), style: { height: 32 } }));
  };

  const renderOnboarding = () => {
    const guidance = binding ? unconfiguredGuidance(binding) : null;
    if (!guidance) return h('div', { role: 'status', style: { flex: '1 1 0px', display: 'grid', placeItems: 'center', padding: 24, color: PANEL_TOKENS.inkSoft } }, '正在读取开通状态…');
    return h('div', { 'data-personal-assistant-onboarding': 'true', style: panelUi.page },
      h('main', { style: { ...onboardingStyle.page, flex: '1 1 0px', minHeight: 0 } },
        h('div', { style: onboardingStyle.eyebrow }, '个人助理 · 开通引导'),
        h('h1', { style: onboardingStyle.title }, guidance.title),
        h('p', { style: onboardingStyle.detail }, guidance.detail),
        h('div', { style: onboardingStyle.actions },
          guidance.actions.map(action => h('button', {
            key: action.id, disabled: Boolean(bindingBusy),
            style: action.primary ? onboardingStyle.primary : onboardingStyle.ghost,
            onClick: () => {
              if (action.id === 'check') { void boot(); return; }
              if (action.id === 'create') { void startCreate(); return; }
              // connect 复用现有 desktop.connect（旧宿主可能没有 create.status，仍能等到 configured）
              void (async () => {
                setBindingBusy(action.id); setError('');
                try { await rpc(`personal-assistant.desktop.${action.id}`); await boot(); }
                catch (failure) { setError(failure?.message || '操作失败，请稍后重试'); }
                finally { setBindingBusy(''); }
              })();
            },
          }, bindingBusy === action.id ? '处理中…' : action.label))),
        error ? h('p', { role: 'alert', style: { ...onboardingStyle.notice, color: PANEL_TOKENS.danger } }, error) : null,
        notice ? h('p', { role: 'status', style: onboardingStyle.notice }, notice) : null));
  };

  const renderBody = () => {
    if (panelView === 'create') {
      return h('main', { style: { ...panelUi.main, alignItems: 'center', justifyContent: 'center', gap: 18, padding: '28px 32px' } },
        renderCreateProgress({
          h, status: createStatus, collapsed: createCollapsed, diagnosticsOpen: createDiagnostics,
          notice: createNotice, error: createError,
          actions: {
            onExpand: () => { setCreateCollapsed(false); if (createStatus && !['done', 'failed'].includes(createStatus.stage)) void pollCreateStatus(); },
            onDiagnostics: () => setCreateDiagnostics(open => !open),
            onCancel: cancelCreate,
            onRetry: () => void startCreate(),
          },
        }));
    }
    if (panelView === 'settings') {
      return h('main', { style: panelUi.main },
        renderSettings({
          h, loading: settingsLoading, degraded: settingsDegraded, notice: settingsNotice, error: settingsError, busy: settingsBusy,
          inspect: settingsInspect, versions: settingsVersions, localAccess: connection, modelOptions: MODEL_OPTIONS,
          instance: { configured, agentId: config?.agentId || '', version: settingsInspect?.runtime?.version || '', status: settingsInspect?.status || (configured ? '运行中' : '未开通'), editable: configured },
          draft: settingsDraft, closeAssistant,
          actions: {
            onModelChange: value => setSettingsDraft(previous => ({ ...previous, model: value })),
            onPromptChange: value => setSettingsDraft(previous => ({ ...previous, prompt: value })),
            onAddEnv: () => setSettingsDraft(previous => ({ ...previous, environmentVariables: [...(previous.environmentVariables || []), { key: '', value: '', sensitive: false, saved: false, dirty: true }] })),
            onRemoveEnv: index => setSettingsDraft(previous => {
              const rows = [...(previous.environmentVariables || [])];
              const [removed] = rows.splice(index, 1);
              if (removed?.saved && removed?.key) setEnvDeletes(deletes => deletes.includes(removed.key) ? deletes : [...deletes, removed.key]);
              return { ...previous, environmentVariables: rows };
            }),
            onEnvChange: (index, patch) => setSettingsDraft(previous => ({
              ...previous,
              environmentVariables: (previous.environmentVariables || []).map((row, at) => at === index ? { ...row, ...patch, dirty: true } : row),
            })),
            onDiagnostics: () => setLocalAccessOpen(false),
            onRevokeLocal: () => { void revokeLocalAccess(); },
            onOpenLocalAccess: () => setLocalAccessOpen(true),
            onCheckUpdate: () => { if (settingsVersions?.catalogAvailable) setSettingsNotice('云端有可升级版本，升级入口暂未接入面板'); },
            onCloseStart: () => setCloseAssistant({ open: true, text: '', busy: false, error: '', closedNotice: closeAssistant.closedNotice }),
            onCloseText: value => setCloseAssistant(previous => ({ ...previous, text: value })),
            onCloseCancel: () => setCloseAssistant(previous => ({ ...previous, open: false, text: '', error: '' })),
            onCloseConfirm: () => void closeAssistantNow(),
          },
        }));
    }
    if (panelView === 'detail') {
      return h('main', { style: panelUi.main },
        renderBotDetail({
          h, loading: detailLoading, degraded: detailDegraded, notice,
          bot: detail?.bot || (selectedBotId ? botSummary(selectedBotId) : null),
          memory: detail?.memory || null,
          capabilities: detail?.capabilities || [],
          computer: detail?.computer || null,
          modelOptions: MODEL_OPTIONS,
          manageMemory, showAllMemory, modelBusy, deleteConfirm,
          actions: {
            onChangeModel: model => void changeBotModel(model),
            onToggleManageMemory: () => setManageMemory(value => !value),
            onToggleAllMemory: () => setShowAllMemory(value => !value),
            onDeleteMemory: id => void deleteMemory(id),
            onAddCapability: () => setNotice('添加能力入口暂未接入面板，可在 MCP 服务里配置'),
            onOpenComputer: openCloudComputer,
            onDeleteStart: () => setDeleteConfirm({ open: true, text: '', busy: false, error: '' }),
            onDeleteCancel: () => setDeleteConfirm({ open: false, text: '', busy: false, error: '' }),
            onDeleteText: value => setDeleteConfirm(previous => ({ ...previous, text: value, error: '' })),
            onDeleteConfirm: () => void submitDeleteBot(),
          },
        }));
    }
    if (panelView === 'chat') {
      if (!configured) return renderOnboarding();
      return h('div', { style: { flex: '1 1 0px', minHeight: 0, minWidth: 0, display: 'flex', position: 'relative' } },
        h(PersonalAssistantConversation, {
          key: `${scope?.botId || 'default'}:${chatSessionId || 'auto'}`,
          React: R, request: scopedRequest, scope, markdown: clientMarkdown,
          initialSessionId: chatSessionId, onBack: () => setPanelView('list'),
          onOpenComputer: openCloudComputer,
          revokedAt: localRevokedAt,
          connectionDot: dotNode,
        }));
    }
    if (panelView === 'desktop') {
      return h('div', { style: { flex: '1 1 0px', minHeight: 0, minWidth: 0, display: 'flex', position: 'relative' } },
        h(PersonalAssistantPanel, {
          request: panelRequest, variant: 'page', connectOnMount: true, embedded: true,
          connectionDot: dotNode, onBack: () => setPanelView('chat'),
        }));
    }
    // list
    if (!configured) return renderOnboarding();
    return h('main', { style: panelUi.main },
      renderBotsList({
        h, connection, loading: overviewLoading, degraded: overviewDegraded, notice,
        bots, active: overview?.active || [], recent: overview?.recent || [], counts: overview?.counts || null,
        showAllActivity, historyOpen, historyLoading, historyError, sessions,
        createBot,
        actions: {
          onEnter: botId => openChat(botId),
          onOpenBot: botId => openDetail(botId),
          onOpenChat: botId => openChat(botId),
          onOpenDetail: botId => openDetail(botId),
          onOpenMemory: botId => openDetail(botId),
          onOpenComputer: openCloudComputer,
          onOpenSettings: openSettings,
          onOpenLocalAccess: () => setLocalAccessOpen(true),
          onToggleActivity: () => setShowAllActivity(value => !value),
          onToggleHistory: toggleHistory,
          onOpenSession: sessionId => openHistorySession(sessionId),
          onOpenShortcut: kind => setNotice(kind === 'memories' ? '记忆入口请在 Bot 详情里管理' : '该入口暂未接入面板，后续版本提供'),
          onApprove: approvalId => setNotice(approvalId ? '审批入口暂未接入面板，请在 DSH Host 的待办里处理' : '暂时没有待确认的操作'),
          onCreateBot: () => setCreateBot({ open: true, name: '', busy: false, error: '' }),
          onOpenHistoryItem: sessionId => openHistorySession(sessionId),
        },
      }),
      // 新建 Bot 的内联对话框：画板没有这一块，沿用卡片视觉，避免跳页。
      createBot.open ? h('div', { role: 'dialog', 'aria-label': '新建 Bot', style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(23,32,44,0.18)', zIndex: 40, padding: 24 } },
        h('div', { style: { width: '100%', maxWidth: 360, background: PANEL_TOKENS.surface, border: `1px solid ${PANEL_TOKENS.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 18px 40px rgba(23,32,44,0.18)' } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '新建 Bot'),
          h('div', { style: { fontSize: 11, color: PANEL_TOKENS.inkMuted, lineHeight: 1.7 } }, '新 Bot 有独立的模型、记忆与能力，共用同一台云电脑。'),
          h('input', {
            value: createBot.name, 'aria-label': 'Bot 名称', placeholder: '例如：文档助理', autoFocus: true,
            onChange: event => setCreateBot(previous => ({ ...previous, name: String(event?.target?.value ?? ''), error: '' })),
            style: { fontSize: 12, padding: '7px 9px', borderRadius: 8, border: `1px solid ${PANEL_TOKENS.border}`, font: 'inherit' },
          }),
          createBot.error ? h('div', { role: 'alert', style: { fontSize: 11, color: PANEL_TOKENS.danger } }, createBot.error) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            panelButton({ h, label: '取消', variant: 'ghost', onClick: () => setCreateBot({ open: false, name: '', busy: false, error: '' }) }),
            panelButton({ h, label: createBot.busy ? '创建中…' : '创建', variant: 'primary', disabled: createBot.busy || !createBot.name.trim(), onClick: () => void submitCreateBot() })))) : null);
  };

  const popover = renderLocalAccess({
    h, open: localAccessOpen, connection, status: connection,
    selectedScopes: connection.authorized ? (connection.scopes.length ? connection.scopes : localScopes) : localScopes,
    riskConfirm: connection.authorized ? connection.riskConfirm : riskConfirmDraft,
    busy: localBusy, error: localError, notice: localNotice,
    actions: {
      onToggleScope: id => setLocalScopes(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]),
      onToggleRisk: () => setRiskConfirmDraft(value => !value),
      onGrant: () => void grantLocalAccess(),
      onRevoke: () => void revokeLocalAccess(),
      onOpenLocalSettings: () => setNotice('请在这台 Mac 的 系统设置 › 隐私与安全性 里调整 DSH Host 的权限'),
    },
  });

  return h('section', { 'data-personal-assistant-shell': 'true', 'data-panel-view': panelView, style: { ...panelUi.page, position: 'relative' } },
    h('style', null, SHELL_KEYFRAMES),
    renderHeader(),
    h('div', {
      'data-pa-body': 'true',
      style: { flex: '1 1 0px', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', ...(localAccessOpen ? { opacity: 0.32, pointerEvents: 'none' } : {}) },
    }, renderBody()),
    localAccessOpen ? h('button', {
      type: 'button', 'aria-label': '关闭本机授权弹层', tabIndex: -1,
      onClick: () => setLocalAccessOpen(false),
      style: { position: 'absolute', inset: 0, border: 'none', background: 'transparent', cursor: 'default', zIndex: 20 },
    }) : null,
    popover);
}

/** 可切换的模型目录：Host 侧 bot.model.update 不限制取值，这里只给常见档位。 */
const MODEL_OPTIONS = Object.freeze(['deepseek-v4.1-flash-1017', 'deepseek-v4.1-pro']);

const settingsStyle = {
  page: { padding: '2px 2px 28px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 700, fontSize: 13, color: 'var(--dsw-alias-label-primary, #17202c)' },
  title: { margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' },
  lede: { margin: 0, color: 'var(--dsw-alias-label-secondary, #536174)', fontSize: 13, lineHeight: 1.7 },
  card: { border: ui.border, borderRadius: 12, overflow: 'hidden' },
  row: { display: 'flex', gap: 16, padding: '12px 14px', borderTop: '1px solid var(--dsw-alias-border-default, #d8dee8)', alignItems: 'flex-start' },
  rowFirst: { display: 'flex', gap: 16, padding: '12px 14px', alignItems: 'flex-start' },
  label: { width: 116, flex: 'none', color: 'var(--dsw-alias-label-secondary, #536174)', fontSize: 13, lineHeight: 1.7 },
  value: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.7, overflowWrap: 'anywhere' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  button: { ...ui, borderRadius: 8, padding: '6px 11px', cursor: 'pointer', font: 'inherit', fontSize: 13 },
  note: { color: 'var(--dsw-alias-label-secondary, #536174)', fontSize: 12, lineHeight: 1.7 },
  badge: { display: 'inline-block', borderRadius: 999, padding: '1px 8px', fontSize: 12, lineHeight: 1.7 },
  badgeOk: { background: 'color-mix(in srgb, #067647 12%, transparent)', color: '#067647' },
  badgeIdle: { background: 'color-mix(in srgb, #946200 14%, transparent)', color: '#946200' },
  badgeError: { background: 'color-mix(in srgb, #b42318 12%, transparent)', color: '#b42318' },
  dangerButton: { ...ui, borderRadius: 8, padding: '6px 11px', cursor: 'pointer', font: 'inherit', fontSize: 13,
    color: '#b42318', border: '1px solid color-mix(in srgb, #b42318 35%, transparent)', background: 'transparent' },
  confirmBox: { border: '1px solid color-mix(in srgb, #b42318 30%, transparent)', borderRadius: 12, padding: '12px 14px',
    display: 'flex', flexDirection: 'column', gap: 10, background: 'color-mix(in srgb, #b42318 4%, transparent)' },
  dangerInput: { ...ui, border: '1px solid var(--dsw-alias-border-default, #d8dee8)', borderRadius: 8, padding: '6px 9px',
    font: 'inherit', fontSize: 12, width: '100%', maxWidth: 360, boxSizing: 'border-box' },
  danger: { ...ui, borderRadius: 8, padding: '6px 11px', cursor: 'pointer', font: 'inherit', fontSize: 13,
    color: '#fff', border: '1px solid #b42318', background: '#b42318' },
  dangerDisabled: { ...ui, borderRadius: 8, padding: '6px 11px', cursor: 'not-allowed', font: 'inherit', fontSize: 13,
    color: '#fff', border: '1px solid color-mix(in srgb, #b42318 35%, transparent)', background: 'color-mix(in srgb, #b42318 35%, transparent)' },
  success: { color: '#067647', fontSize: 12, lineHeight: 1.7 },
  input: { ...ui, border: '1px solid var(--dsw-alias-border-default, #d8dee8)', borderRadius: 8, padding: '6px 9px',
    font: 'inherit', fontSize: 12, width: '100%', maxWidth: 360, boxSizing: 'border-box' },
  textarea: { ...ui, border: '1px solid var(--dsw-alias-border-default, #d8dee8)', borderRadius: 8, padding: '6px 9px',
    font: 'inherit', fontSize: 12, width: '100%', minHeight: 76, resize: 'vertical', boxSizing: 'border-box' },
  envRow: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' },
  envKey: { ...ui, border: '1px solid var(--dsw-alias-border-default, #d8dee8)', borderRadius: 8, padding: '5px 8px',
    font: 'inherit', fontSize: 12, width: 190, boxSizing: 'border-box' },
  envValue: { ...ui, border: '1px solid var(--dsw-alias-border-default, #d8dee8)', borderRadius: 8, padding: '5px 8px',
    font: 'inherit', fontSize: 12, width: 220, boxSizing: 'border-box' },
  tinyButton: { ...ui, borderRadius: 8, padding: '4px 8px', cursor: 'pointer', font: 'inherit', fontSize: 12 },
};

/** 设置页里的「个人助理」一节：状态、连接自检、能力与记忆位置。 */
export function PersonalAssistantSettings({ request, openComputer = null } = {}) {
  const R = clientReact || globalThis.React;
  if (!R) return '设置页尚未就绪，请重新打开 DSH Host';
  const { createElement: h, useEffect, useState, useCallback } = R;
  const [config, setConfig] = useState(null);
  const [bots, setBots] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [closing, setClosing] = useState(false);
  const [closedNotice, setClosedNotice] = useState('');
  const [settings, setSettings] = useState(null);
  const [versions, setVersions] = useState(null);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [version, setVersion] = useState('');
  const [envRows, setEnvRows] = useState([]);
  const [envDeletes, setEnvDeletes] = useState([]);
  const [settingsError, setSettingsError] = useState('');
  const [settingsNotice, setSettingsNotice] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [binding, setBinding] = useState(null);
  const [bindingBusy, setBindingBusy] = useState('');

  const check = useCallback(async () => {
    setChecking(true); setError('');
    const started = Date.now();
    try {
      const current = await request('personal-assistant.configuration');
      setConfig(current);
      emitConfigurationChanged(current);
      if (current?.configured) setBinding(null);
      else setBinding(await request('personal-assistant.desktop.status').catch(() => null));
      if (current?.configured) {
        const directory = await request('personal-assistant.bots.list');
        setBots(Array.isArray(directory?.bots) ? directory.bots : []);
        try {
          const snapshot = await request('personal-assistant.settings.inspect');
          setSettings(snapshot);
          setModel(snapshot?.model || '');
          setPrompt(snapshot?.prompt || '');
          setVersion(snapshot?.runtime?.version || '');
          setEnvRows((snapshot?.environmentVariables || []).map(row => ({ ...row, saved: true, dirty: false })));
          setEnvDeletes([]);
          setSettingsError('');
          const catalog = await request('personal-assistant.settings.versions',
            { currentVersion: snapshot?.runtime?.version || '' }).catch(reason => {
              setSettingsError(reason?.message || '暂时读不到可升级的版本'); return null;
            });
          setVersions(catalog);
        } catch (reason) {
          setSettings(null); setVersions(null);
          setSettingsError(reason?.message || '读取云端配置失败');
        }
      } else { setBots([]); setSettings(null); setVersions(null); }
      setCheckedAt(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${Date.now() - started} ms`);
    } catch (reason) {
      setError(reason?.message || '连接检查失败');
      setCheckedAt(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 失败`);
    } finally { setChecking(false); }
  }, [request]);

  const runBinding = useCallback(async action => {
    if (bindingBusy) return;
    setBindingBusy(action); setError('');
    try { await request(`personal-assistant.desktop.${action}`); await check(); }
    catch (reason) { setError(reason?.message || '操作失败，请稍后重试'); }
    finally { setBindingBusy(''); }
  }, [bindingBusy, check, request]);

  const agentId = config?.agentId || '';
  const canConfirm = Boolean(agentId) && confirmText.trim() === agentId;
  const closeAssistant = useCallback(async () => {
    if (!canConfirm) return;
    setClosing(true); setError('');
    try {
      await request('personal-assistant.desktop.destroy', { confirmAgentId: agentId });
      emitConfigurationChanged({ configured: false });
      setConfirming(false); setConfirmText('');
      setClosedNotice('个人助理已关闭：云端实例已删除，关联的云资源订单正在释放，本机绑定已清除。');
      setConfig({ configured: false }); setBots([]);
      setCheckedAt('');
    } catch (reason) {
      const message = String(reason?.message || '');
      setError(/更新 DSH Host|云连接服务/iu.test(message) ? '当前 DSH Host 版本还不支持关闭个人助理，请更新 DSH Host 后重试。' : (message || '关闭个人助理失败，请稍后重试'));
    } finally { setClosing(false); }
  }, [agentId, canConfirm, request]);

  const updateEnvRow = (index, patch) => setEnvRows(rows => rows.map((row, at) => at === index ? { ...row, ...patch, dirty: true } : row));
  const addEnvRow = () => setEnvRows(rows => [...rows, { key: '', value: '', sensitive: false, saved: false, dirty: true }]);
  const removeEnvRow = index => {
    const row = envRows[index];
    if (!row) return;
    setEnvRows(rows => rows.filter((_, at) => at !== index));
    if (row.saved && row.key) setEnvDeletes(keys => keys.includes(row.key) ? keys : [...keys, row.key]);
  };
  const editable = settings?.recordSource === 'host';
  const saveSettings = useCallback(async () => {
    if (!editable || settingsBusy) return;
    setSettingsBusy(true); setSettingsError(''); setSettingsNotice('');
    try {
      const environmentVariables = envRows.filter(row => row.dirty === true || row.saved !== true)
        .map(row => ({ key: String(row.key || '').trim(), value: String(row.value || ''), sensitive: row.sensitive === true }));
      await request('personal-assistant.settings.update', {
        model: model.trim(), prompt, runtimeVersion: version,
        environmentVariables, deleteKeys: envDeletes,
      });
      setSettingsNotice(`已提交云端更新（版本 ${version}），个人助理正在应用新配置，通常 1–2 分钟完成，期间云电脑会短暂重连。`);
      setEnvDeletes([]);
      try {
        const snapshot = await request('personal-assistant.settings.inspect');
        setSettings(snapshot);
        setModel(snapshot?.model || '');
        setPrompt(snapshot?.prompt || '');
        setVersion(snapshot?.runtime?.version || version);
        setEnvRows((snapshot?.environmentVariables || []).map(row => ({ ...row, saved: true, dirty: false })));
      } catch { /* the submit already succeeded; the next check refreshes */ }
    } catch (reason) {
      setSettingsError(reason?.message || '保存配置失败，请稍后重试');
    } finally { setSettingsBusy(false); }
  }, [editable, envDeletes, envRows, model, prompt, request, settingsBusy, version]);

  useEffect(() => { void check(); }, [check]);

  const configured = config?.configured === true;
  const status = config === null ? '检查中' : configured ? '已开通' : '尚未开通';
  const statusStyle = { ...settingsStyle.badge, ...(config === null ? settingsStyle.badgeIdle : configured ? settingsStyle.badgeOk : settingsStyle.badgeIdle) };
  const line = (label, value, first = false) => h('div', { style: first ? settingsStyle.rowFirst : settingsStyle.row },
    h('div', { style: settingsStyle.label }, label), h('div', { style: settingsStyle.value }, value));
  const guidance = configured ? null : unconfiguredGuidance(binding);
  const guidanceCard = guidance ? h('div', { 'data-personal-assistant-onboarding': 'true', style: settingsStyle.card },
    h('div', { style: { ...settingsStyle.rowFirst, flexDirection: 'column', gap: 8, alignItems: 'stretch' } },
      h('div', { style: { fontSize: 15, fontWeight: 600 } }, guidance.title),
      h('div', { style: settingsStyle.note }, guidance.detail),
      h('div', { style: settingsStyle.actions },
        guidance.actions.map(action => h('button', {
          key: action.id, disabled: Boolean(bindingBusy),
          style: action.primary ? settingsStyle.button : { ...settingsStyle.button, background: 'transparent' },
          onClick: () => action.id === 'check' ? void check() : void runBinding(action.id),
        }, bindingBusy === action.id ? '处理中…' : action.label))))) : null;

  const envSensitiveStyle = { ...settingsStyle.note, display: 'inline-flex', gap: 4, alignItems: 'center' };
  const envActionsStyle = { ...settingsStyle.actions, marginTop: 6 };
  const saveAreaStyle = { display: 'flex', flexDirection: 'column', gap: 8 };
  const renderSettings = () => {
    if (!settings) {
      return h('div', { style: settingsStyle.card },
        line('云端配置', h('div', { style: settingsStyle.note },
          settingsBusy ? '读取中…' : (settingsError || '暂时读不到云端配置；请点下方“检查连接”重试')), true));
    }
    if (settings.recordSource !== 'host') {
      return h('div', { style: settingsStyle.card },
        line('云端配置', h('div', { style: settingsStyle.note },
          '这个个人助理是用旧版 DSH Host 创建的，本机没有记录它的配置清单，暂时不能在线修改。可以关闭后重新创建；等云端平台提供读取接口后即可直接编辑。'), true));
    }
    const versionControl = versions && versions.catalogAvailable
      ? h('select', { style: settingsStyle.input, value: version, disabled: settingsBusy, 'aria-label': '运行时版本',
          onChange: event => setVersion(String(event?.target?.value ?? '')) },
          versions.versions.map(item => h('option', { key: item.version, value: item.version },
            item.version === settings.runtime?.version ? `${item.version}（当前）` : item.version)))
      : h('div', { style: settingsStyle.note },
          `${settings.runtime?.version || version || '未知版本'} · 云端还没有发布可升级版本`);
    const envEditor = h('div', null,
      envRows.length
        ? envRows.map((row, index) => h('div', { key: `env-${index}`, style: settingsStyle.envRow },
            h('input', { style: settingsStyle.envKey, value: row.key, placeholder: 'KEY', 'aria-label': '环境变量名',
              disabled: settingsBusy || row.saved === true,
              onChange: event => updateEnvRow(index, { key: String(event?.target?.value ?? '') }) }),
            h('input', { style: settingsStyle.envValue, value: row.value, 'aria-label': '环境变量值',
              type: row.sensitive === true ? 'password' : 'text', disabled: settingsBusy,
              placeholder: row.saved === true && row.sensitive === true ? '已保存（留空不修改）' : 'VALUE',
              onChange: event => updateEnvRow(index, { value: String(event?.target?.value ?? '') }) }),
            h('label', { style: envSensitiveStyle },
              h('input', { type: 'checkbox', checked: row.sensitive === true, disabled: settingsBusy,
                onChange: event => updateEnvRow(index, { sensitive: event?.target?.checked === true }) }), '敏感'),
            h('button', { style: settingsStyle.tinyButton, disabled: settingsBusy, onClick: () => removeEnvRow(index) }, '删除')))
        : h('div', { style: settingsStyle.note }, '还没有配置环境变量'),
      h('div', { style: envActionsStyle },
        h('button', { style: settingsStyle.tinyButton, disabled: settingsBusy, onClick: addEnvRow }, '添加变量'),
        h('span', { style: settingsStyle.note }, '已保存的敏感值不会回显，留空表示不修改；删除后保存生效')));
    const saveArea = h('div', { style: saveAreaStyle },
      settingsNotice ? h('div', { style: settingsStyle.success }, settingsNotice) : null,
      settingsError ? h('div', { style: { ...settingsStyle.note, color: '#b42318' } }, settingsError) : null,
      h('div', { style: settingsStyle.actions },
        h('button', { style: settingsStyle.button, disabled: settingsBusy, onClick: () => void saveSettings() },
          settingsBusy ? '正在保存…' : '保存配置'),
        h('span', { style: settingsStyle.note }, '保存会提交一次云端更新，由云端滚动应用')));
    return h('div', { style: settingsStyle.card },
      line('云端配置', h('div', { style: settingsStyle.note },
        '模型、系统提示词、运行时版本和环境变量保存在云端实例。保存时提交一次云端更新，由云端滚动应用到实例，不需要本机重启。'), true),
      settings.detailAvailable === false
        ? line('说明', h('div', { style: settingsStyle.note },
            settings.detailNote || '云端平台暂时没有返回实例详情，下面显示的是本机记录的配置；环境变量详情暂时不可见。'))
        : null,
      line('模型', h('input', { style: settingsStyle.input, value: model, disabled: settingsBusy,
        placeholder: '例如 deepseek-v4.1-flash-1017', 'aria-label': '模型名称',
        onChange: event => setModel(String(event?.target?.value ?? '')) })),
      line('系统提示词', h('textarea', { style: settingsStyle.textarea, value: prompt, disabled: settingsBusy,
        'aria-label': '系统提示词', onChange: event => setPrompt(String(event?.target?.value ?? '')) })),
      line('运行时版本', versionControl),
      line('环境变量', envEditor),
      line('保存', saveArea));
  };

  return h('section', { 'data-personal-assistant-settings': 'true', style: settingsStyle.page },
    h('div', { 'data-window-drag': '' },
      h('h1', { style: settingsStyle.title }, '个人助理'),
      h('p', { style: { ...settingsStyle.lede, marginTop: 6 } }, '云端持续运行的助理，带一台独立云电脑。关掉窗口它也在工作；对话与云电脑在左侧「个人助理」页。')),
    error ? h('div', { role: 'alert', style: { ...settingsStyle.note, color: '#b42318', background: 'color-mix(in srgb, #b42318 8%, transparent)', border: '1px solid color-mix(in srgb, #b42318 25%, transparent)', borderRadius: 10, padding: '9px 12px' } }, error) : null,
    guidanceCard,
    h('div', { style: settingsStyle.card },
      line('状态', h('span', null, h('span', { style: statusStyle }, status), checkedAt ? h('span', { style: settingsStyle.note }, `　上次检查 ${checkedAt}`) : null), true),
      line('云端实例', config?.agentId ? h('span', { style: settingsStyle.mono }, config.agentId) : h('span', { style: settingsStyle.note }, configured ? '未返回实例标识' : '开通后由 DSH Host 绑定')),
      line('网关', config?.gatewayUrl ? h('span', { style: settingsStyle.mono }, config.gatewayUrl) : h('span', { style: settingsStyle.note }, '由 DSH Host Host 配置')),
      line('助理连接', h('span', { style: settingsStyle.note }, bots === null ? '检查中' : bots.length ? '已连接你的助理' : '助理尚未就绪')),
      line('记忆', h('div', null, h('div', { style: settingsStyle.mono }, '/workspace/assistant-state'),
        h('div', { style: settingsStyle.note }, '记忆、会话与定时任务随云电脑持久保存，换设备也在'))),
      line('云端能力', h('div', null,
        h('div', null, '默认开启：云端命令执行、云端浏览器'),
        h('div', { style: settingsStyle.note }, '都跑在隔离工作区：读不到本机文件与凭证，不能访问内网与本机地址；敏感操作会先请你确认'))),
      line('插件版本', h('span', { style: settingsStyle.note }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`))),
    configured ? renderSettings() : null,
    configured || closedNotice ? h('div', { style: settingsStyle.card },
      line('关闭个人助理', h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: settingsStyle.note }, '关闭会删除云端实例（云电脑 Pod）和云端助理数据，并释放关联的云资源订单；本机绑定也会一并清除，之后可重新创建。'),
        closedNotice ? h('div', { style: settingsStyle.success }, closedNotice) : null,
        confirming
          ? h('div', { style: settingsStyle.confirmBox },
            h('div', { style: { ...settingsStyle.note, color: '#b42318' } }, '此操作不可撤销。请输入上方「云端实例」的标识以确认关闭：'),
            h('input', {
              style: settingsStyle.dangerInput, value: confirmText, placeholder: agentId || 'ar-…',
              'aria-label': '输入云端实例标识以确认关闭', disabled: closing,
              onChange: event => setConfirmText(String(event?.target?.value ?? '')),
            }),
            h('div', { style: settingsStyle.actions },
              h('button', { style: canConfirm && !closing ? settingsStyle.danger : settingsStyle.dangerDisabled, disabled: !canConfirm || closing, onClick: () => void closeAssistant() },
                closing ? '正在关闭…' : '确认关闭个人助理'),
              h('button', { style: settingsStyle.button, disabled: closing, onClick: () => { setConfirming(false); setConfirmText(''); } }, '取消')))
          : h('div', { style: settingsStyle.actions },
            h('button', { style: settingsStyle.dangerButton, disabled: !configured || closing, onClick: () => { setConfirming(true); setConfirmText(''); setClosedNotice(''); } }, '关闭个人助理'),
            h('span', { style: settingsStyle.note }, configured ? '需要输入实例标识二次确认' : '当前没有已开通的个人助理'))), true)) : null,
    h('div', { style: settingsStyle.actions },
      h('button', { style: settingsStyle.button, disabled: checking, onClick: () => void check() }, checking ? '正在检查…' : '检查连接'),
      h('span', { style: settingsStyle.note }, '检查会读取开通状态并拉取一次助理列表，不会启动云电脑')));
}

export function PersonalAssistantPanelIcon({ size } = {}) {
  const R = clientReact;
  const edge = Number(size) > 0 ? Number(size) : 16;
  if (!R?.createElement) return '助';
  return R.createElement('svg', {
    width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
  },
  R.createElement('path', { d: 'M3.4 3.2h9.2a1.3 1.3 0 0 1 1.3 1.3H7.7l-2.9 2.3v-2.3H3.4a1.3 1.3 0 0 1-1.3-1.3V4.5a1.3 1.3 0 0 1 1.3-1.3z' }),
  R.createElement('path', { d: 'M8.1 5.6l.62 1.46 1.46.62-1.46.62L8.1 9.76l-.62-1.46-1.46-.62 1.46-.62z' }));
}
export function PersonalAssistantComputerTabGlyph({ size } = {}) {
  const R = clientReact;
  const edge = Number(size) > 0 ? Number(size) : 16;
  if (!R?.createElement) return null;
  return R.createElement('svg', {
    width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
    style: { display: 'block', flex: '0 0 auto' },
  },
  R.createElement('rect', { x: 2.2, y: 3.4, width: 11.6, height: 7.4, rx: 1.4 }),
  R.createElement('path', { d: 'M6.6 13.4h2.8' }),
  R.createElement('path', { d: 'M8 10.8v2.6' }));
}

export function PersonalAssistantComputerTabTitle() {
  const R = clientReact;
  const glyph = PersonalAssistantComputerTabGlyph({ size: 15 });
  if (!R?.createElement || !glyph) return '云电脑';
  return R.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', lineHeight: 1 } },
    glyph, R.createElement('span', null, '云电脑'));
}
export function apply(ctx) {
  if (!ctx?.slots?.inject || !ctx.slots.register) throw new TypeError('Personal Assistant client requires the public DSH slots service');
  const request = async (operation, payload = {}) => {
    if (!ctx.connection?.rpc?.call) throw new PersonalAssistantGatewayUnavailableError();
    const result = await ctx.connection.rpc.call('/api', 'personal-assistant', { operation, payload });
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || 'DSH Host Host 请求失败'), { code: result?.error?.code, status: result?.error?.details?.status, closeCode: result?.error?.details?.closeCode });
    return result.value;
  };
  // 注册一律走作用域助手：任一条注册失败只降级该入口，绝不让插件激活整体失败（激活失败会导致 DSH Host 重置 profile）。
  const scope = (factory, label) => {
    try {
      const run = () => factory();
      if (typeof ctx.effect === 'function') return ctx.effect(run, label);
      return run();
    } catch (error) {
      try { console.warn(`[personal-assistant] ${label} 注册失败`, error); } catch {}
      return undefined;
    }
  };

  const sessions = ctx.sessions || ctx.get?.('sessions');
  const uiWorkspace = ctx.uiWorkspace || ctx.get?.('uiWorkspace');
  const uiConversation = ctx.uiConversation || ctx.get?.('uiConversation');
  storedPersonalAssistantSessionId();
  let openingSession;
  let currentPersonalAssistantSessionId = '';
  const activatePersonalAssistantSession = sessionId => {
    const id = String(sessionId || '').trim();
    if (!id) return;
    // Session creation and the local Controller projection are asynchronous.
    // Retry activation briefly while the normal Session binding catches up.
    // DSH may finish restoring the Session chrome after openSession returns;
    // keep the public binding authoritative for a few seconds without
    // reaching into the host DOM or clicking a foreign Chat tab.
    let remaining = 120;
    const activate = () => {
      try {
        const binding = uiConversation?.binding?.(id);
        if (!binding || typeof binding.activate !== 'function') throw new Error('session binding pending');
        binding.activate(PERSONAL_ASSISTANT_VIEW_ID);
        return true;
      } catch { return false; }
    };
    if (activate()) return;
    const retry = () => {
      if (activate() || --remaining <= 0) return;
      globalThis.setTimeout?.(retry, 25);
    };
    globalThis.setTimeout?.(retry, 0);
  };
  const openAndActivatePersonalAssistantSession = sessionId => {
    const id = String(sessionId || '').trim();
    if (!id) return;
    // Open first so DSH mounts the Session surface, then select the PA view.
    persistPersonalAssistantView(id);
    uiWorkspace?.openSession?.(id);
    activatePersonalAssistantSession(id);
  };
  const openPersonalAssistantSession = () => {
    if (openingSession) return openingSession;
    openingSession = (async () => {
      // The global sidebar may have rendered from a cached Session list while
      // the launcher is already clickable. Refresh once before choosing the
      // presentation Session so we do not accidentally create a fresh blank
      // Session when a reusable non-blank Session is already available.
      const refreshSessions = sessions?.refresh?.();
      if (refreshSessions && typeof refreshSessions.catch === 'function') await refreshSessions.catch(() => {});
      const list = sessions?.list?.getSnapshot?.();
      const stored = currentPersonalAssistantSessionId || storedPersonalAssistantSessionId();
      const existing = stored && list?.byId?.[stored];
      // A Session created in this same Host lifetime may not have reached the
      // list projection yet. Keep reusing it while the projection catches up;
      // a persisted id from an earlier lifetime still requires list evidence.
      if (stored && existing?.removed !== true && (currentPersonalAssistantSessionId || existing)) {
        currentPersonalAssistantSessionId = stored;
        personalAssistantDshSessions.add(stored);
        openAndActivatePersonalAssistantSession(stored);
        return stored;
      }
      if (stored) forgetPersonalAssistantSessionId(stored);

      // Never borrow the currently selected Studio/绘画/普通对话 Session. The
      // PA presentation gets its own DSH Session so switching products cannot
      // replace the PA view with the host's ordinary Chat view.
      let sessionId = '';
      if (typeof sessions?.create === 'function') sessionId = String(await sessions.create({}) || '');
      else if (typeof uiWorkspace?.openWorkspace === 'function') {
        await uiWorkspace.openWorkspace(null, created => { sessionId = String(created || ''); });
      }
      if (!sessionId) throw new Error('DSH Host 未返回个人助理会话标识');
      currentPersonalAssistantSessionId = sessionId;
      rememberPersonalAssistantSessionId(sessionId);
      persistPersonalAssistantView(sessionId);
      openAndActivatePersonalAssistantSession(sessionId);
      return sessionId;
    })().finally(() => { openingSession = undefined; });
    return openingSession;
  };

  // The PA view is a normal DSH Session target.  Opening the computer from
  // this view therefore uses the Session-owned right sidebar instead of the
  // legacy global panel surface.
  scope(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: PERSONAL_ASSISTANT_VIEW_ID, order: -10, label: '个人助理',
  }, props => PersonalAssistantSessionView({ ...props, request, sidebarRight: ctx.sidebarRight }))), 'personal-assistant: conversation view');
  scope(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: -20,
    select: owner => owner?.session?.sessionId && personalAssistantDshSessions.has(owner.session.sessionId)
      ? { sessionId: owner.session.sessionId } : null,
  }, PersonalAssistantComposerPlaceholder)), 'personal-assistant: conversation composer');
  scope(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PERSONAL_ASSISTANT_PANEL_ID, inject: () => ({ openSession: openPersonalAssistantSession }),
  }, PersonalAssistantSessionLauncher)), 'personal-assistant: session launcher');
  scope(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PERSONAL_ASSISTANT_PANEL_ID, order: 90, label: '个人助理',
  }, PersonalAssistantPanelIcon)), 'personal-assistant: sidebar row');
  // DSH Host 设置页里的「个人助理」一节（原产品页被去重后留下的位置）。
  scope(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: `${PERSONAL_ASSISTANT_PANEL_ID}-settings`, order: 196, label: '个人助理',
    inject: () => ({ request }),
  }, PersonalAssistantSettings)), 'personal-assistant: settings section');
  // 普通会话标签页仍可注册；全局个人助理页面使用原生 panel surface，不创建本地会话。
  const registerComputerTab = () => {
    if (typeof ctx.inject !== 'function') return;
    scope(() => ctx.inject(['sidebarRightTabs'], (sub) => {
      const cleanups = [];
      const add = (dispose) => { if (typeof dispose === 'function') cleanups.push(dispose); };
      try {
        const tabs = sub.sidebarRightTabs;
        if (tabs === undefined || typeof tabs.register !== 'function') return undefined;
        add(tabs.register({
          id: PERSONAL_ASSISTANT_COMPUTER_TAB,
          kind: PERSONAL_ASSISTANT_COMPUTER_TAB,
          title: () => '云电脑',
          guide: [{
            order: 20,
            title: () => '云电脑',
            description: () => '个人助理的云端电脑画面，可获取控制权',
          }],
        }));
        add(sub.slots.inject('sidebar.right.pane.tab', () => sub.slots.register({
          name: 'sidebar.right.pane.tab', key: PERSONAL_ASSISTANT_COMPUTER_TAB, inject: () => ({ request }),
        }, props => PersonalAssistantPanel({ ...props, variant: 'computer' }))));
        add(sub.slots.inject('sidebar.right.pane.tab.title', () => sub.slots.register({
          name: 'sidebar.right.pane.tab.title', key: PERSONAL_ASSISTANT_COMPUTER_TAB,
        }, PersonalAssistantComputerTabTitle)));
      } catch (error) {
        try { console.warn('[personal-assistant] 右侧栏注册失败', error); } catch {}
      }
      return () => { for (const dispose of cleanups.reverse()) dispose(); };
    }), 'personal-assistant: right tab');
  };
  registerComputerTab();
}
export const createClientPlugin = createPersonalAssistantClient;
