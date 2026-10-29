/** Browser-safe Personal Assistant client and Cloud Computer panel. */

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
    createSession: input => request('personal-assistant.sessions.create', { ...input, botId: input?.botId ?? selectedBotId }),
    listMessages: sessionId => request('personal-assistant.sessions.messages.list', { sessionId, botId: selectedBotId }),
    appendMessage: (sessionId, input) => request('personal-assistant.sessions.messages.append', { sessionId, ...input, botId: input?.botId ?? selectedBotId }),
    listTurns: sessionId => request('personal-assistant.sessions.turns.list', { sessionId, botId: selectedBotId }),
    submitTurn: (sessionId, input) => request('personal-assistant.sessions.turns.submit', { sessionId, ...input, botId: input?.botId ?? selectedBotId }),
    searchMemory: query => request('personal-assistant.memory.search', { query, botId: selectedBotId }),
    remember: input => request('personal-assistant.memory.upsert', { ...input, botId: input?.botId ?? selectedBotId }),
    listSchedules: botId => request('personal-assistant.schedules.list', { botId: botId ?? selectedBotId }),
    createSchedule: input => request('personal-assistant.schedules.create', { ...input, botId: input?.botId ?? selectedBotId }),
    deleteSchedule: scheduleId => request('personal-assistant.schedules.delete', { scheduleId, botId: selectedBotId }),
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

export const inject = Object.freeze(['slots', 'connection', 'sidebarRight']);
export const PERSONAL_ASSISTANT_PANEL_ID = 'personal-assistant';
export const PERSONAL_ASSISTANT_CLIENT_DEFAULTS = Object.freeze({ enabled: false, autoConnect: false });
export const PERSONAL_ASSISTANT_COMPUTER_TAB = 'personal-assistant-computer';
import { fitDesktopBox, mapDisplayPoint, mergeWheel, normalizeDisplay } from './desktop-view.mjs';
import { createDesktopControl } from './desktop-control.mjs';
import { createClipboardChannel, isPasteShortcut, isCopyShortcut, copyCloudClipboard, pasteToCloud, readLocalClipboard, writeLocalClipboard } from './components/desktop-clipboard.mjs';
import { PersonalAssistantConversation } from './conversation.mjs';
import { createAssistantWorkbench, AssistantNativeRightbar } from './native-workbench.mjs';
import { publicBotDirectory, resolveAssistantBotId } from './bot-directory.mjs';
export const PERSONAL_ASSISTANT_CLIENT_BUILD = typeof __PA_CLIENT_BUILD__ === 'string' ? __PA_CLIENT_BUILD__ : '开发模式';
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
 * reason 由 Studio 给出：needs-create（账号下确实没有实例）、credential-unavailable（有实例但
 * 凭证取不到）、unavailable（连状态都读不到，多为 Studio 未登录云端或网关不可达）。
 * 只有确认没有实例时才给「开通」入口——一个子账号一个个人助理，已开通必须复用，避免重复创建；
 * candidates 非空时一律优先连接已发现的实例。
 */
export function unconfiguredGuidance(binding) {
  const reason = typeof binding?.reason === 'string' ? binding.reason : '';
  const candidates = Array.isArray(binding?.candidates) ? binding.candidates.filter(row => typeof row?.agentId === 'string' && row.agentId) : [];
  const check = { id: 'check', label: '检查开通状态' };
  if (candidates.length > 0) return {
    tone: 'reuse', title: '发现已开通的个人助理',
    detail: `账号下已有 ${candidates.length} 个个人助理。一个子账号只需要一个，直接连接即可复用，不会重复创建。`,
    actions: [{ id: 'connect', label: '连接已发现的个人助理', primary: true }, check],
  };
  if (reason === 'needs-create') return {
    tone: 'create', title: '开通个人助理',
    detail: '一个子账号可开通一个个人助理。开通后会得到一位云端持续运行的助理和一台专属云电脑，关掉 Studio 也会继续工作。',
    actions: [{ id: 'create', label: '开通个人助理', primary: true }, check],
  };
  if (reason === 'credential-unavailable') return {
    tone: 'reuse', title: '正在恢复连接凭证',
    detail: '个人助理实例已经在账号下，但云端暂时没有返回连接凭证。重新获取即可复用现有实例，不需要重新开通。',
    actions: [{ id: 'connect', label: '重新获取连接凭证', primary: true }, check],
  };
  const detail = typeof binding?.detail === 'string' && binding.detail ? binding.detail : '';
  return {
    tone: 'retry', title: '暂时读不到开通状态',
    detail: `${detail}请先确认 Studio 已登录云端账号，再重新检查一次；确认账号下确实没有个人助理后再开通，避免重复创建。`,
    actions: [check, { id: 'create', label: '确认未开通后开通', primary: false }],
  };
}

const onboardingSteps = tone => tone === 'reuse'
  ? ['确认账号下的个人助理实例', '直接连接即可复用，不会重复创建', '需要看画面或动手时，打开「云电脑」接管']
  : ['登录 Studio 云端账号，开通个人助理（约 1–2 分钟）', '连接后即可在「个人助理」页对话，云端 7×24 运行', '需要看画面或动手时，打开「云电脑」接管'];

const onboardingStyle = {
  page: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: '32px 20px', textAlign: 'center', boxSizing: 'border-box' },
  eyebrow: { fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary, #536174)' },
  title: { margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' },
  detail: { margin: 0, maxWidth: 460, lineHeight: 1.75, color: 'var(--dsw-alias-label-secondary, #536174)' },
  steps: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left', maxWidth: 460 },
  step: { display: 'flex', gap: 10, alignItems: 'flex-start', lineHeight: 1.7 },
  stepIndex: { flex: 'none', width: 20, height: 20, borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: 12, background: 'color-mix(in srgb, currentColor 10%, transparent)' },
  actions: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', marginTop: 4 },
  primary: { ...ui, borderRadius: 8, padding: '8px 16px', cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: 500, border: 'none', background: 'var(--dsw-alias-label-primary, #17202c)', color: 'var(--dsw-alias-bg-layer-1, #fff)' },
  ghost: { ...ui, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', font: 'inherit', fontSize: 13, background: 'transparent' },
  notice: { margin: 0, maxWidth: 460, color: 'var(--dsw-alias-label-secondary, #536174)', fontSize: 12, lineHeight: 1.7 },
  diag: { alignSelf: 'center', color: 'var(--dsw-alias-label-tertiary, #76808e)', fontSize: 11, opacity: 0.8, maxWidth: '100%', overflowWrap: 'anywhere' },
};

const keyNames = { Control: 'Control_L', Meta: 'Super_L', Alt: 'Alt_L', Shift: 'Shift_L', Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'BackSpace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'space' };

export function PersonalAssistantPanel({ request, initialBotId = '', openInSidebar = null, variant = 'page', nativeFullscreen = false } = {}) {
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
  const canvasRef = useRef(null), inputRef = useRef(null), viewRef = useRef(null), cursorRef = useRef(null), stageAreaRef = useRef(null);
  const fullscreenRef = useRef(nativeFullscreen); fullscreenRef.current = nativeFullscreen;
  const state = useRef({ mounted: true, socket: null, generation: 0, frameEpoch: 0, session: null, suspended: false, resuming: false, pendingInputs: [], display: { width: 1280, height: 800 }, readOnly: true, botId, config: null, reconnect: null, firstFrame: null, receivedSeq: -1, pendingFrame: null, decoding: false, frames: 0, lastMove: 0, wheelPending: { x: 0, y: 0 }, wheelFrame: 0, pressed: new Set(), buttons: new Set(), composition: false, retries: 0, taskId: '', mode: 'control', frameMetadata: null, reconnectAllowed: false });
  state.current.botId = botId;
  const rpc = async (operation, payload = {}) => {
    if (typeof request !== 'function') throw new Error('Studio Host 尚未连接');
    return request(operation, payload);
  };
  const send = body => {
    const current = state.current;
    if (current.socket?.readyState !== 1) return false;
    current.socket.send(JSON.stringify(body)); return true;
  };
  const releaseInputs = () => {
    const current = state.current;
    for (const key of current.pressed) controlRef.current?.input({ type: 'key', action: 'up', key });
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
    failed: message => { if (state.current.mounted) setNotice(message); },
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
    const current = state.current; current.reconnectAllowed = false; clearTimers(); releaseControl(); current.generation += 1;
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
  // ⌘C：先把按键原样交给云电脑，让云端应用自己完成“复制”，再取回云端剪贴板。
  // 之前只读剪贴板不转发按键，用户按 ⌘C 等于没复制，还会在输入框里反复触发按键。
  const copyCloudClipboardToLocal = async () => {
    const modifier = /Mac|iPhone|iPad/u.test(String(globalThis.navigator?.platform || '')) ? 'Meta' : 'Control';
    if (!state.current.pressed.has('_copyShortcut')) {
      state.current.pressed.add('_copyShortcut');
      try {
        sendDesktopKeys([
          { type: 'key', action: 'down', key: modifier },
          { type: 'key', action: 'down', key: 'c' },
          { type: 'key', action: 'up', key: 'c' },
          { type: 'key', action: 'up', key: modifier },
        ]);
        await new Promise(resolve => setTimeout(resolve, 150));
      } finally { state.current.pressed.delete('_copyShortcut'); }
    }
    return copyCloudClipboard({ readCloud: () => clipboardRef.current.read(), writeLocal: text => writeHostClipboard(text), notify: clipboardNotify });
  };
  // 本机剪贴板优先走 Host 进程（pbpaste/pbcopy）：Studio 渲染器没有 clipboard 权限，
  // navigator.clipboard 在面板里会被拒，⌘C/⌘V 就成了空操作。旧 Host 不支持时再退回浏览器 API。
  const readHostClipboard = async () => {
    try {
      const value = await rpc('personal-assistant.clipboard.read');
      if (typeof value?.text === 'string') return value.text;
    } catch { /* 旧 Host 没有剪贴板 RPC，退回浏览器剪贴板 */ }
    return readLocalClipboard();
  };
  const writeHostClipboard = async text => {
    try { await rpc('personal-assistant.clipboard.write', { text: String(text ?? '') }); return; }
    catch { /* 同上 */ }
    await writeLocalClipboard(String(text ?? ''));
  };
  const pasteLocalClipboardToCloud = () => pasteToCloud({
    readLocal: () => readHostClipboard(),
    writeCloud: text => clipboardRef.current.write(text),
    sendKeys: sendDesktopKeys,
    notify: clipboardNotify,
  });
  // paste 事件兜底：macOS 上 Electron 的编辑菜单可能先把 ⌘V 吃掉，但浏览器仍会把
  // 剪贴板内容作为 paste 事件交给聚焦的输入框，这里直接把文本写进云电脑剪贴板。
  const pasteTextToCloud = text => pasteToCloud({
    readLocal: async () => String(text ?? ''),
    writeCloud: value => clipboardRef.current.write(value),
    sendKeys: sendDesktopKeys,
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
    current.mode = mode; current.taskId ||= `studio-desktop-${globalThis.crypto.randomUUID()}`;
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
        current.session = null; clearTimeout(current.firstFrame); current.firstFrame = null;
        if (!current.reconnectAllowed || event.code === 1000) { ended(); return; }
        if (document.hidden) { setPhase('hidden'); return; }
        const count = ++current.retries; setAttempt(count);
        if (count > 5) { current.reconnectAllowed = false; setPhase('error'); setNotice('无法连接云电脑，请检查实例状态或网络后重试'); return; }
        setPhase('reconnecting'); current.reconnect = setTimeout(() => { void open(mode, true, current.pendingInputs); }, Math.min(8000, 1000 * 2 ** (count - 1)));
      };
    } catch (error) { if (current.mounted && generation === current.generation) { setPhase('error'); setNotice(failure(error)); } }
  };
  // Studio 负责发现实例、恢复/生成凭证；页面只读取公开状态，绝不接触凭据。
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
      if (selected && ['computer', 'native-tab'].includes(variant)) void open(state.current.handoffSupported ? 'observe' : 'read');
    } catch (error) {
      if (signal?.aborted || !state.current.mounted) return;
      if (Number.isInteger(error?.closeCode) && error.closeCode >= 1000 && error.closeCode <= 4999) setDirectoryCloseCode(error.closeCode);
      state.current.bots = []; setBots([]); setBotId('');
      // 配置接口本身失败（Studio 未登录、网关不可达）时不能直接判死：desktop.status 不抛错，
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
      if (document.hidden) { releaseControl(); send({ type: 'pause' }); }
      else if (current.socket?.readyState === 1) send({ type: 'resume' });
      else if (current.reconnectAllowed && current.config?.configured && current.session === null && current.socket) void open(current.mode, true);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (current.lastDrawnFrame) { current.pendingFrame = current.lastDrawnFrame; void drawLatest(); } }) : null;
    if (canvasRef.current) observer?.observe(canvasRef.current);
    const blur = () => releaseControl();
    const outside = event => { if (!viewRef.current?.contains(event.target)) releaseControl(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', blur); document.addEventListener('pointerdown', outside, true);
    return () => { current.mounted = false; observer?.disconnect(); if (current.pointerFrame) cancelAnimationFrame(current.pointerFrame); if (current.wheelFrame) cancelAnimationFrame(current.wheelFrame); controller.abort(); close(false); clearInterval(interval); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', blur); document.removeEventListener('pointerdown', outside, true); };
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
  const key = event => {
    if (state.current.composition || event.isComposing || event.nativeEvent?.isComposing || event.key === 'Process' || event.key === 'Unidentified') return;
    // 画布上的 ⌘V/Ctrl+V 是"把本地剪贴板贴进云电脑"，不能把裸按键转给 Linux 桌面（它要的是 Ctrl+V）。
    if (isPasteShortcut(event)) { event.preventDefault(); void pasteLocalClipboardToCloud(); return; }
    if (isCopyShortcut(event)) {
      event.preventDefault();
      // 长按/重复的 keydown 不再触发第二次复制。
      if (event.type === 'keydown' && !event.repeat) void copyCloudClipboardToLocal();
      return;
    }
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    // 普通文本只走 input/compositionend，避免同一按键被发送两遍。
    if (event.key.length === 1 && !modified) return;
    if (event.key === 'Escape' && fullscreenRef.current) return;
    event.preventDefault();
    const name = keyNames[event.key] || event.key;
    if (!/^[A-Za-z0-9_]+$/u.test(name)) return;
    if (event.type === 'keydown') { if (!event.repeat && input({ type: 'key', action: 'down', key: name })) state.current.pressed.add(name); }
    else { input({ type: 'key', action: 'up', key: name }); state.current.pressed.delete(name); }
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
  // 右下角胶囊与"诊断"不再占桌面卡片的高度预算：卡片按量出来的可用区域取 contain 尺寸。
  useLayoutEffect(() => {
    if (!computerVariant) return undefined;
    const node = stageAreaRef.current;
    if (!node) return undefined;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const next = fitDesktopBox({ availableWidth: rect.width, availableHeight: rect.height, display: desktopDisplay, maxWidth: 1280 });
      setStageBox(previous => {
        if (!(next.width > 0 && next.height > 0)) return previous ?? null;
        return previous && Math.abs(previous.width - next.width) < 0.5 && Math.abs(previous.height - next.height) < 0.5 ? previous : next;
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [computerVariant, desktopDisplay]);
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
    h('ol', { style: onboardingStyle.steps },
      onboardingSteps(guidance.tone).map((text, index) => h('li', { key: text, style: onboardingStyle.step },
        h('span', { style: onboardingStyle.stepIndex }, String(index + 1)), h('span', null, text)))),
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
      h('div', { ref: stageAreaRef, 'data-personal-assistant-desktop-stack': 'true', style: { width: '100%', maxWidth: 1280, minHeight: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 } }, onboarding || stage),
      active || selectable ? h('div', { 'data-personal-assistant-control-capsule': 'true', role: 'status', 'aria-live': 'polite', style: { flex: 'none', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 6, width: 'fit-content', maxWidth: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-1, #fff)', border: ui.border, boxShadow: '0 1px 4px #10182808', lineHeight: 1.5 } },
        !active && selectable ? h('button', { style: pillStyle, disabled: ['connecting', 'resuming'].includes(phase), onClick: () => void open(state.current.handoffSupported ? 'observe' : 'read') }, phase === 'connecting' ? '正在启动…' : '重新连接') : null,
        active && readOnly ? h('span', { style: { color: secondaryInk, fontSize: 12 } }, controlPhase === 'acquiring' ? '正在接管…' : controlPhase === 'releasing' ? '正在交还…' : '助理正在使用 · 点画面即可接管') : null,
        active && readOnly && controlRef.current.snapshot.available ? h('button', { style: { ...pillStyle, padding: '3px 9px', fontSize: 11 }, onClick: () => controlRef.current.acquire() }, '接管') : null,
        active && !readOnly ? h('span', { style: { color: secondaryInk, fontSize: 12 } }, '您拥有控制权 · 点画面外释放') : null,
        active && notice ? h('span', { style: { color: secondaryInk, fontSize: 12 } }, notice) : null,
        // 剪贴板不再放按钮：面板里只保留 ⌘V 粘贴 / ⌘C 复制与一行状态文字。
        active && clipboardNotice ? h('span', { role: 'status', 'aria-live': 'polite', style: { color: secondaryInk, fontSize: 12 } }, clipboardNotice) : null) : null),
      h('details', { style: { flex: 'none', alignSelf: 'flex-end', color: 'var(--dsw-alias-label-tertiary, #76808e)', fontSize: 11, opacity: 0.8, maxWidth: '100%', overflowWrap: 'anywhere' } }, h('summary', { style: { cursor: 'pointer' } }, '诊断'), h('small', { 'data-personal-assistant-build': PERSONAL_ASSISTANT_CLIENT_BUILD }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`)));
  }
  return h('section', { 'data-personal-assistant-panel': 'true', style: { ...ui, border: 'none', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', fontSize: 13 } },
    h('header', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: 12, borderBottom: ui.border } },
      h('strong', { style: { fontWeight: 500, marginRight: 8 } }, '个人助理'),
      selectable && ['idle', 'closed', 'error'].includes(phase) ? h('button', { style: buttonStyle, onClick: () => void refreshConnection() }, '刷新助理列表') : null,
      typeof openInSidebar === 'function' ? h('button', { style: buttonStyle, onClick: openInSidebar }, '放到右侧栏') : null,
      selectable ? h('button', { style: buttonStyle, disabled: ['connecting', 'resuming'].includes(phase), onClick: () => phase === 'dormant' ? resumeIdle() : void open(state.current.handoffSupported ? 'observe' : 'control') }, phase === 'dormant' ? '恢复画面' : readOnly && phase === 'readonly' ? '申请控制' : active ? '重新连接' : '连接云电脑') : null,
      selectable ? h('button', { style: buttonStyle, disabled: phase === 'connecting', onClick: () => void open('read') }, '只读旁观') : null,
      active ? h('span', { role: 'status', 'aria-live': 'polite', style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-secondary, #536174)' } }, stateText) : null),
    phase === 'readonly' ? h('div', { role: 'alert', style: { background: '#fff0d6', color: '#763c00', padding: '8px 12px' } }, '当前为只读旁观，鼠标和键盘输入不会发送；可申请控制') : null,
    active && notice ? h('div', { role: 'status', style: { padding: '8px 12px' } }, notice) : null,
    onboarding || stage,
    h('footer', { style: { display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 12, padding: '7px 12px', color: 'var(--dsw-alias-label-secondary, #536174)', borderTop: ui.border } },
      h('details', { open: diagnosticsOpen, onToggle: event => setDiagnosticsOpen(event.currentTarget.open) }, h('summary', { style: { cursor: 'pointer' } }, '诊断'),
        directoryCloseCode ? h('div', { style: { paddingTop: 8 } }, `目录连接关闭码：${directoryCloseCode}`) : null,
        h('div', { style: { paddingTop: 8, lineHeight: 1.8, overflowWrap: 'anywhere' } }, h('div', null, `云端实例：${config?.agentId || '未开通'}`), h('div', null, `连接标识：${botId || '未连接'}`), h('div', null, `画面帧率：${fps} fps`), h('div', null, '快捷键会转发到云电脑；Esc 优先退出全屏'))),
      h('small', { 'data-personal-assistant-build': PERSONAL_ASSISTANT_CLIENT_BUILD, style: { opacity: 0.75 } }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`)));
}


/** 主面板：对话式入口，云电脑在右侧栏。 */
export function PersonalAssistantHome({ request, nativeWorkbench } = {}) {
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
    h('ol', { style: onboardingStyle.steps },
      onboardingSteps(guidance.tone).map((text, index) => h('li', { key: text, style: onboardingStyle.step },
        h('span', { style: onboardingStyle.stepIndex }, String(index + 1)), h('span', null, text)))),
    h('div', { style: onboardingStyle.actions },
      guidance.actions.map(action => h('button', {
        key: action.id, disabled: Boolean(bindingBusy),
        style: action.primary ? onboardingStyle.primary : onboardingStyle.ghost,
        onClick: () => action.id === 'check' ? retry(value => value + 1) : runBinding(action.id),
      }, bindingBusy === action.id ? '处理中…' : action.label))),
    error ? h('p', { role: 'alert', style: { ...onboardingStyle.notice, color: '#b42318' } }, error) : null);
  if (!scope) return h('div', { role: 'status', style: { padding: 24 } }, error || '正在连接云端个人助理…', error ? h('button', { onClick: () => retry(value => value + 1) }, '重新连接') : null);
  if (!nativeWorkbench?.available) return h('div', { role: 'alert', style: { padding: 24 } }, '当前宿主尚未提供原生云电脑侧栏，请更新 Studio 后重新打开。');
  return h('div', {
    key: `${scope.agentId}:${scope.botId}`, 'data-personal-assistant-home': 'true',
    'data-agent-id': scope.agentId, 'data-bot-id': scope.botId,
    style: { flex: '1 1 0px', height: '100%', maxHeight: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' },
  }, h(PersonalAssistantConversation, { React: R, request: scopedRequest, scope, markdown: clientMarkdown, onOpenComputer: () => nativeWorkbench.open() }));

}


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
  if (!R) return '设置页尚未就绪，请重新打开 Studio';
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
      setConfirming(false); setConfirmText('');
      setClosedNotice('个人助理已关闭：云端实例已删除，关联的云资源订单正在释放，本机绑定已清除。');
      setConfig({ configured: false }); setBots([]);
      setCheckedAt('');
    } catch (reason) {
      const message = String(reason?.message || '');
      setError(/更新 Studio|云连接服务/iu.test(message) ? '当前 Studio 版本还不支持关闭个人助理，请更新 Studio 后重试。' : (message || '关闭个人助理失败，请稍后重试'));
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
  const editable = settings?.recordSource === 'studio';
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
    if (settings.recordSource !== 'studio') {
      return h('div', { style: settingsStyle.card },
        line('云端配置', h('div', { style: settingsStyle.note },
          '这个个人助理是用旧版 Studio 创建的，本机没有记录它的配置清单，暂时不能在线修改。可以关闭后重新创建；等云端平台提供读取接口后即可直接编辑。'), true));
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
      line('云端实例', config?.agentId ? h('span', { style: settingsStyle.mono }, config.agentId) : h('span', { style: settingsStyle.note }, configured ? '未返回实例标识' : '开通后由 Studio 绑定')),
      line('网关', config?.gatewayUrl ? h('span', { style: settingsStyle.mono }, config.gatewayUrl) : h('span', { style: settingsStyle.note }, '由 Studio Host 配置')),
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
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || 'Studio Host 请求失败'), { code: result?.error?.code, status: result?.error?.details?.status, closeCode: result?.error?.details?.closeCode });
    return result.value;
  };
  // 注册一律走作用域助手：任一条注册失败只降级该入口，绝不让插件激活整体失败（激活失败会导致 Studio 重置 profile）。
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
  const nativeWorkbench = createAssistantWorkbench({ sidebarRight: ctx.sidebarRight, slots: ctx.slots });
  if (nativeWorkbench) {
    nativeWorkbench.render = props => AssistantNativeRightbar({ ...props, React: clientReact || globalThis.React, workbench: nativeWorkbench, Panel: PersonalAssistantPanel });
    scope(() => () => nativeWorkbench.dispose(), 'personal-assistant: native workbench');
  }
  scope(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PERSONAL_ASSISTANT_PANEL_ID, inject: () => ({ request, nativeWorkbench }),
  }, PersonalAssistantHome)), 'personal-assistant: main panel');
  scope(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PERSONAL_ASSISTANT_PANEL_ID, order: 90, label: '个人助理',
  }, PersonalAssistantPanelIcon)), 'personal-assistant: sidebar row');
  // Studio 设置页里的「个人助理」一节（原产品页被去重后留下的位置）。
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
