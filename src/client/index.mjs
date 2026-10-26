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
    desktop,
  });
}

export const inject = Object.freeze(['slots', 'connection']);
export const PERSONAL_ASSISTANT_PANEL_ID = 'personal-assistant';
export const PERSONAL_ASSISTANT_CLIENT_DEFAULTS = Object.freeze({ enabled: false, autoConnect: false });
export const PERSONAL_ASSISTANT_COMPUTER_TAB = 'personal-assistant-computer';
import { mapDisplayPoint, normalizeDisplay } from './desktop-view.mjs';
import { PersonalAssistantConversation } from './conversation.mjs';
import { publicBotDirectory } from './bot-directory.mjs';
export const PERSONAL_ASSISTANT_CLIENT_BUILD = typeof __PA_CLIENT_BUILD__ === 'string' ? __PA_CLIENT_BUILD__ : '开发模式';
const FIRST_FRAME_TIMEOUT_MS = 12_000;
let clientReact;
export function setClientReactRuntime(runtime) { clientReact = runtime; }
const ui = {
  background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #17202c)',
  border: '1px solid var(--dsw-alias-border-default, #d8dee8)',
};
const failure = error => error?.code === 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE' && Number(error?.status) === 409 ? '当前云端版本尚不支持助理列表，请更新云端助理后重试' : '连接暂时不可用，请稍后重试';
const directoryUnsupported = error => Number(error?.status) === 409 && ['PERSONAL_ASSISTANT_DIRECTORY_UNSUPPORTED', 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE'].includes(error?.code);
const canUseDefaultBot = error => ![401, 403].includes(Number(error?.status)) && (
  ['PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE', 'PERSONAL_ASSISTANT_DIRECTORY_TIMEOUT'].includes(error?.code) && Number(error?.status) >= 500 && Number(error?.status) <= 599
);
const keyNames = { Control: 'Control_L', Meta: 'Super_L', Alt: 'Alt_L', Shift: 'Shift_L', Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'BackSpace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'space' };

export function PersonalAssistantPanel({ request, initialBotId = '', openInSidebar = null, variant = 'page', onBotChange = null } = {}) {
  const R = clientReact || globalThis.React;
  if (!R) return '个人助理页面尚未就绪，请重新打开';
  const { createElement: h, useEffect, useRef, useState } = R;
  const [config, setConfig] = useState(null);
  const [bots, setBots] = useState([]);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryCloseCode, setDirectoryCloseCode] = useState(null);
  const [manualBotAvailable, setManualBotAvailable] = useState(false);
  const [manualBotId, setManualBotId] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [botId, setBotId] = useState(initialBotId);
  const [phase, setPhase] = useState('loading');
  const [notice, setNotice] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [fps, setFps] = useState(0);
  const [full, setFull] = useState(false);
  const canvasRef = useRef(null), inputRef = useRef(null), viewRef = useRef(null);
  const state = useRef({ mounted: true, socket: null, generation: 0, frameEpoch: 0, session: null, suspended: false, resuming: false, pendingInputs: [], display: { width: 1280, height: 800 }, readOnly: true, botId, config: null, reconnect: null, firstFrame: null, receivedSeq: -1, pendingFrame: null, decoding: false, frames: 0, lastMove: 0, pressed: new Set(), buttons: new Set(), composition: false, retries: 0, taskId: '', mode: 'control', frameMetadata: null, reconnectAllowed: false });
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
    for (const key of current.pressed) send({ type: 'input', event: { type: 'key', action: 'up', key } });
    for (const button of current.buttons) send({ type: 'input', event: { type: 'button', action: 'up', button } });
    current.pressed.clear(); current.buttons.clear();
  };
  const releasePointer = () => {
    for (const button of state.current.buttons) send({ type: 'input', event: { type: 'button', action: 'up', button } });
    state.current.buttons.clear();
  };
  const clearTimers = () => {
    clearTimeout(state.current.reconnect); clearTimeout(state.current.firstFrame);
    state.current.reconnect = null; state.current.firstFrame = null;
  };
  const close = (announce = true) => {
    const current = state.current; current.reconnectAllowed = false; clearTimers(); releaseInputs(); current.generation += 1;
    try { send({ type: 'close' }); current.socket?.close(1000, 'panel closed'); } catch {}
    current.socket = null; current.session = null; current.pendingFrame = null; current.frameMetadata = null; current.readOnly = true; inputRef.current?.blur();
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
    if (current.readOnly) { setNotice('当前为只读旁观，输入未发送'); return false; }
    return send({ type: 'input', event });
  };
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
          const canvas = canvasRef.current, rect = canvas.getBoundingClientRect();
          const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
          canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr));
          const context = canvas.getContext('2d'), display = current.display;
          const scale = Math.min(canvas.width / display.width, canvas.height / display.height);
          const width = display.width * scale, height = display.height * scale;
          context.fillStyle = '#10151e'; context.fillRect(0, 0, canvas.width, canvas.height);
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
  const open = async (mode = 'control', reconnecting = false, bufferedInputs = []) => {
    const current = state.current;
    const selected = String(current.botId || '').trim();
    if (!current.config?.configured) { setPhase('unconfigured'); return; }
    if (!selected || !current.bots?.some(bot => bot.botId === selected)) { setNotice('请先选择可用的助理'); return; }
    close(false);
    current.pendingInputs = bufferedInputs; current.resuming = bufferedInputs.length > 0;
    const generation = ++current.generation;
    current.reconnectAllowed = true;
    if (!reconnecting) current.retries = 0;
    current.mode = mode; current.taskId ||= `studio-desktop-${Date.now()}`;
    current.receivedSeq = -1; current.frameMetadata = null;
    setPhase(reconnecting ? 'reconnecting' : 'connecting'); setNotice('首次或休眠后连接可能需要数秒，请稍候。');
    try {
      const ticket = await rpc('personal-assistant.desktop.ticket', { agentId: current.config.agentId, botId: selected, mode });
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
          current.session = value.sessionId; current.readOnly = Boolean(value.readOnly); current.display = normalizeDisplay(value.display);
          current.mode = current.readOnly ? 'read' : mode;
          const inputs = current.pendingInputs; current.pendingInputs = [];
          if (!current.readOnly) for (const event of inputs) send({ type: 'input', event });
          else { current.pressed.clear(); current.buttons.clear(); }
          setReadOnly(current.readOnly); setNotice('云电脑已连接，正在准备桌面画面'); return;
        }
        if (value.type === 'idle') { markIdle(value); return; }
        if (value.type === 'frame') { if (!value.unchanged) current.frameMetadata = value; return; }
        if (value.type === 'closed') { if (value.retryable !== true) ended(value); return; }
        if (value.type === 'error') {
          setNotice(value.message || value.code || '云电脑请求失败');
          if (value.recoverable === true && Number(value.status) === 409) {
            if (value.code === 'DESKTOP_SESSION_IDLE') markIdle();
            else { current.pendingInputs = []; current.readOnly = true; current.pressed.clear(); current.buttons.clear(); setReadOnly(true); setPhase('readonly'); }
            return;
          }
          if (Number(value.status) === 409 && mode === 'control' && !current.session) { void open('read'); return; }
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
  const refreshConnection = async signal => {
    close(false); setPhase('loading'); setNotice(''); setDirectoryError(''); setDirectoryCloseCode(null); setManualBotAvailable(false); setManualBotId('');
    let directoryStarted = false;
    try {
      const value = await rpc('personal-assistant.configuration');
      if (signal?.aborted || !state.current.mounted) return;
      state.current.config = value; setConfig(value);
      if (!value.configured) { state.current.bots = []; setBots([]); setBotId(''); setPhase('unconfigured'); return; }
      directoryStarted = true;
      const result = await rpc('personal-assistant.bots.list');
      if (signal?.aborted || !state.current.mounted) return;
      if (result.directoryAvailable !== true) throw Object.assign(new Error('directory unavailable'), { code: 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE', status: 409 });
      const available = publicBotDirectory(result.bots);
      state.current.bots = available; setBots(available);
      const selected = available.some(bot => bot.botId === state.current.botId) ? state.current.botId : available[0]?.botId || '';
      state.current.botId = selected; setBotId(selected); setPhase(available.length ? 'idle' : 'empty');
    } catch (error) {
      if (signal?.aborted || !state.current.mounted) return;
      if (Number.isInteger(error?.closeCode) && error.closeCode >= 1000 && error.closeCode <= 4999) setDirectoryCloseCode(error.closeCode);
      if (directoryStarted && directoryUnsupported(error)) {
        state.current.bots = []; setBots([]); setBotId(''); setPhase('directory-error');
        setManualBotAvailable(true); setManualBotId('default');
        setDirectoryError('可在诊断中指定已有助理后连接；建议使用云端助理 0.1.4 或更新版本。');
        return;
      }
      if (directoryStarted && canUseDefaultBot(error)) {
        const available = publicBotDirectory([{ botId: 'default', displayName: '默认助理' }]);
        state.current.bots = available; state.current.botId = 'default';
        setBots(available); setBotId('default'); setPhase('idle');
        setNotice('暂时无法读取助理列表，已使用默认助理');
        return;
      }
      state.current.bots = []; setBots([]); setBotId(''); setPhase('directory-error');
      setDirectoryError(failure(error));
    }
  };
  const selectManualBot = () => {
    const selected = manualBotId.trim();
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(selected)) { setDirectoryError('请输入有效的已有助理标识；只能使用小写字母开头的字母、数字、点、横线或下划线。'); return; }
    const available = publicBotDirectory([{ botId: selected, displayName: '指定助理' }]);
    state.current.bots = available; state.current.botId = selected;
    setBots(available); setBotId(selected); setPhase('idle'); setDiagnosticsOpen(false);
    setNotice('已选择已有助理；连接时将由云端验证该助理及访问权限。');
  };
  useEffect(() => {
    const current = state.current; current.mounted = true;
    const controller = new AbortController();
    void refreshConnection(controller.signal);
    const interval = setInterval(() => { if (current.mounted) setFps(current.frames); current.frames = 0; }, 1000);
    const visibility = () => {
      if (document.hidden) { releaseInputs(); send({ type: 'pause' }); }
      else if (current.socket?.readyState === 1) send({ type: 'resume' });
      else if (current.reconnectAllowed && current.config?.configured && current.session === null && current.socket) void open(current.mode, true);
    };
    const blur = () => releaseInputs();
    const fullscreen = () => setFull(Boolean(document.fullscreenElement));
    let fullscreenEscapeHeld = false;
    const fullscreenEscape = event => {
      const ownFullscreen = document.fullscreenElement === viewRef.current;
      if (event.key !== 'Escape' || (!ownFullscreen && !fullscreenEscapeHeld)) return;
      // 全屏后焦点可能落在 body；在 document 捕获阶段处理，且不把 Esc 转发到云端。
      event.preventDefault(); event.stopPropagation();
      if (event.type === 'keyup') { fullscreenEscapeHeld = false; return; }
      if (ownFullscreen && !fullscreenEscapeHeld) {
        fullscreenEscapeHeld = true;
        void document.exitFullscreen().catch(() => { if (current.mounted) setNotice('退出全屏失败，请点击退出桌面全屏重试'); });
      }
    };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', blur); document.addEventListener('fullscreenchange', fullscreen);
    const fullscreenKeyOptions = { capture: true };
    document.addEventListener('keydown', fullscreenEscape, fullscreenKeyOptions); document.addEventListener('keyup', fullscreenEscape, fullscreenKeyOptions);
    return () => { current.mounted = false; controller.abort(); close(false); clearInterval(interval); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', blur); document.removeEventListener('fullscreenchange', fullscreen); document.removeEventListener('keydown', fullscreenEscape, fullscreenKeyOptions); document.removeEventListener('keyup', fullscreenEscape, fullscreenKeyOptions); };
  }, [request]);
  const point = event => mapDisplayPoint({ clientX: event.clientX, clientY: event.clientY, rect: canvasRef.current.getBoundingClientRect(), display: state.current.display });
  const pointer = event => {
    event.preventDefault(); const current = state.current, button = [1, 2, 3][event.button] || 1;
    if (event.type === 'pointerdown') { inputRef.current?.focus(); canvasRef.current?.setPointerCapture(event.pointerId); if (input({ type: 'button', action: 'down', button, ...point(event) })) current.buttons.add(button); }
    else { input({ type: 'button', action: 'up', button, ...point(event) }); current.buttons.delete(button); if (canvasRef.current?.hasPointerCapture(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId); }
  };
  const key = event => {
    if (state.current.composition || event.isComposing || event.nativeEvent?.isComposing || event.key === 'Process' || event.key === 'Unidentified') return;
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    // 普通文本只走 input/compositionend，避免同一按键被发送两遍。
    if (event.key.length === 1 && !modified) return;
    if (event.key === 'Escape' && document.fullscreenElement) return;
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
  const emptyTitle = phase === 'unconfigured' ? '开通后，在这里连接你的个人助理' : phase === 'empty' ? '助理正在准备中' : phase === 'directory-error' ? manualBotAvailable ? '当前云端版本暂不支持助理列表' : '暂时无法读取助理列表' : '正在检查助理状态';
  const emptyDetail = phase === 'unconfigured' ? '开通完成后，即可在这里连接专属云电脑。' : phase === 'empty' ? '云端初始化完成后，可用助理会显示在这里。' : phase === 'directory-error' ? directoryError : '请稍候';
  const stage = h('div', { ref: viewRef, style: { position: 'relative', flex: 1, minHeight: 240, background: active || phase === 'connecting' ? '#10151e' : 'transparent' } },
    full ? h('button', { style: { ...buttonStyle, position: 'absolute', top: 12, right: 12, zIndex: 2 }, onClick: () => void document.exitFullscreen() }, '退出桌面全屏') : null,
    ['dormant', 'resuming'].includes(phase) ? h('div', { role: 'status', style: { position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.45)', color: '#fff' } }, phase === 'dormant' ? '已空闲，操作桌面即可恢复' : '正在恢复桌面…') : null,
    h('canvas', { ref: canvasRef, 'aria-label': '云电脑桌面', tabIndex: active ? 0 : -1, onPointerDown: pointer, onPointerUp: pointer, onPointerCancel: releasePointer, onLostPointerCapture: releasePointer, onPointerMove: event => { if (Date.now() - state.current.lastMove < 34) return; state.current.lastMove = Date.now(); input({ type: 'pointermove', ...point(event) }); }, onContextMenu: event => event.preventDefault(), onWheel: event => { event.preventDefault(); input({ type: 'wheel', deltaY: event.deltaY / 100, deltaX: event.deltaX / 100 }); }, onKeyDown: key, onKeyUp: key, style: { width: '100%', height: '100%', display: 'block', visibility: active ? 'visible' : 'hidden', pointerEvents: active ? 'auto' : 'none', touchAction: 'none', cursor: readOnly ? 'default' : 'crosshair' } }),
    !active ? h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center', ...(phase === 'connecting' ? { color: '#e8edf5' } : {}) } },
      h('h2', { style: { margin: 0, fontSize: 20, fontWeight: 500 } }, selectable ? stateText : emptyTitle),
      h('p', { style: { margin: 0, maxWidth: 380, lineHeight: 1.7, color: phase === 'connecting' ? '#b8c1d1' : 'var(--dsw-alias-label-secondary, #536174)' } }, selectable ? notice || '连接后即可使用云端桌面，关闭面板会释放本次控制。' : emptyDetail),
      !selectable && manualBotAvailable ? h('button', { style: buttonStyle, onClick: () => setDiagnosticsOpen(true) }, '选择已有助理') : null,
      !selectable && phase !== 'loading' ? h('button', { style: buttonStyle, onClick: () => void refreshConnection() }, manualBotAvailable ? '刷新助理列表' : '检查开通状态') : null) : null,
    h('input', { ref: inputRef, 'aria-label': '云电脑文本输入', autoComplete: 'off', disabled: !active || (readOnly && !(state.current.mode === 'control' && ['dormant', 'resuming'].includes(phase))), tabIndex: -1, style: { position: 'absolute', width: 1, height: 1, opacity: 0, left: 0, top: 0 }, onKeyDown: key, onKeyUp: key, onCompositionStart: () => { state.current.composition = true; }, onCompositionEnd: event => { state.current.composition = false; const text = event.currentTarget.value; event.currentTarget.value = ''; if (text) input({ type: 'text', text }); }, onInput: event => { if (state.current.composition || event.nativeEvent?.isComposing) return; const text = event.currentTarget.value; event.currentTarget.value = ''; if (text) input({ type: 'text', text }); } }));
  const secondaryInk = 'var(--dsw-alias-label-secondary, #536174)';
  const ghostStyle = { ...buttonStyle, background: 'transparent', color: 'inherit', border: ui.border };
  const pillStyle = { ...buttonStyle, borderRadius: 999, padding: '7px 16px', border: 'none', fontWeight: 500, background: 'var(--dsw-alias-label-primary, #17202c)', color: 'var(--dsw-alias-bg-layer-1, #fff)' };
  if (variant === 'computer') {
    return h('section', { 'data-personal-assistant-computer': 'true', style: { ...ui, border: 'none', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit', fontSize: 13 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: ui.border } },
        h('strong', { style: { fontWeight: 500 } }, '云电脑'),
        h('span', { role: 'status', 'aria-live': 'polite', style: { color: secondaryInk, fontSize: 12 } }, stateText),
        selectable ? h('label', { style: { marginLeft: 'auto', color: secondaryInk, fontSize: 12 } }, '助理 ', h('select', { 'aria-label': '当前助理', value: botId, onChange: event => { close(); setBotId(event.target.value); onBotChange?.(event.target.value); }, style: { ...ui, borderRadius: 6, padding: '4px 8px', maxWidth: 180 } }, bots.map(bot => h('option', { key: bot.botId, value: bot.botId }, bot.displayName)))) : null,
        active ? h('button', { style: ghostStyle, onClick: () => { close(); setNotice(''); } }, '断开') : null,
        active ? h('button', { style: ghostStyle, onClick: () => { if (document.fullscreenElement) void document.exitFullscreen(); else void viewRef.current?.requestFullscreen(); } }, full ? '退出全屏' : '全屏') : null),
      readOnly && active ? h('div', { role: 'alert', style: { background: '#fff0d6', color: '#763c00', padding: '8px 12px' } }, '只读旁观：鼠标和键盘不会发送到云电脑') : null,
      stage,
      h('div', { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, padding: '10px 12px 14px', flexWrap: 'wrap' } },
        !active && selectable ? h('button', { style: pillStyle, disabled: ['connecting', 'resuming'].includes(phase), onClick: () => void open('read') }, phase === 'connecting' ? '正在启动…' : '连接云电脑') : null,
        active && readOnly ? h('button', { style: pillStyle, onClick: () => { if (phase === 'dormant') void resumeIdle(); else void open('control'); } }, phase === 'dormant' ? '继续查看' : '申请控制权') : null,
        active && !readOnly ? h('span', { style: { color: secondaryInk, fontSize: 12 } }, '你正在控制这台云电脑') : null,
        active && notice ? h('span', { style: { color: secondaryInk, fontSize: 12 } }, notice) : null),
      h('small', { 'data-personal-assistant-build': PERSONAL_ASSISTANT_CLIENT_BUILD, style: { padding: '0 12px 10px', color: secondaryInk, opacity: 0.75 } }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`));
  }
  return h('section', { 'data-personal-assistant-panel': 'true', style: { ...ui, border: 'none', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', fontSize: 13 } },
    h('header', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: 12, borderBottom: ui.border } },
      h('strong', { style: { fontWeight: 500, marginRight: 8 } }, '个人助理'),
      selectable ? h('label', null, '当前助理 ', h('select', { 'aria-label': '当前助理', value: botId, onChange: event => { close(); setBotId(event.target.value); onBotChange?.(event.target.value); }, style: { ...ui, borderRadius: 6, padding: '6px 8px', maxWidth: 220 } }, bots.map(bot => h('option', { key: bot.botId, value: bot.botId }, bot.displayName)))) : null,
      selectable && ['idle', 'closed', 'error'].includes(phase) ? h('button', { style: buttonStyle, onClick: () => void refreshConnection() }, '刷新助理列表') : null,
      typeof openInSidebar === 'function' ? h('button', { style: buttonStyle, onClick: openInSidebar }, '放到右侧栏') : null,
      selectable ? h('button', { style: buttonStyle, disabled: ['connecting', 'resuming'].includes(phase), onClick: () => phase === 'dormant' ? resumeIdle() : void open('control') }, phase === 'dormant' ? '恢复画面' : readOnly && phase === 'readonly' ? '申请控制' : active ? '重新连接' : '连接云电脑') : null,
      selectable ? h('button', { style: buttonStyle, disabled: phase === 'connecting', onClick: () => void open('read') }, '只读旁观') : null,
      active || phase === 'connecting' ? h('button', { style: buttonStyle, onClick: () => { close(); setNotice(''); } }, '断开连接') : null,
      active ? h('button', { style: buttonStyle, onClick: () => { if (document.fullscreenElement) void document.exitFullscreen(); else void viewRef.current?.requestFullscreen(); } }, full ? '退出全屏' : '全屏') : null,
      active ? h('span', { role: 'status', 'aria-live': 'polite', style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-secondary, #536174)' } }, stateText) : null),
    phase === 'readonly' ? h('div', { role: 'alert', style: { background: '#fff0d6', color: '#763c00', padding: '8px 12px' } }, '当前为只读旁观，鼠标和键盘输入不会发送；可申请控制') : null,
    active && notice ? h('div', { role: 'status', style: { padding: '8px 12px' } }, notice) : null,
    stage,
    h('footer', { style: { display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 12, padding: '7px 12px', color: 'var(--dsw-alias-label-secondary, #536174)', borderTop: ui.border } },
      h('details', { open: diagnosticsOpen, onToggle: event => setDiagnosticsOpen(event.currentTarget.open) }, h('summary', { style: { cursor: 'pointer' } }, '诊断'),
        directoryCloseCode ? h('div', { style: { paddingTop: 8 } }, `目录连接关闭码：${directoryCloseCode}`) : null,
        manualBotAvailable ? h('div', { style: { paddingTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
          h('label', null, '已有助理标识 ', h('input', { 'aria-label': '已有助理标识', value: manualBotId, maxLength: 64, autoComplete: 'off', spellCheck: false, onChange: event => setManualBotId(event.target.value), style: { ...ui, borderRadius: 6, padding: '6px 8px', maxWidth: 180 } })),
          h('button', { style: buttonStyle, disabled: active || phase === 'connecting', onClick: selectManualBot }, '使用此助理')) : null,
        h('div', { style: { paddingTop: 8, lineHeight: 1.8, overflowWrap: 'anywhere' } }, h('div', null, `云端实例：${config?.agentId || '未开通'}`), h('div', null, `助理标识：${botId || '未选择'}`), h('div', null, `画面帧率：${fps} fps`), h('div', null, '快捷键会转发到云电脑；Esc 优先退出全屏'))),
      h('small', { 'data-personal-assistant-build': PERSONAL_ASSISTANT_CLIENT_BUILD, style: { opacity: 0.75 } }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`)));
}


/** 主面板：对话式入口，云电脑在右侧栏。 */
export function PersonalAssistantHome({ request } = {}) {
  const R = clientReact || globalThis.React;
  if (!R) return '个人助理页面尚未就绪，请重新打开';
  const { createElement: h, useEffect, useState, useCallback } = R;
  const [scope, setScope] = useState(null);
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setScope(null); setError('');
    void (async () => {
      try {
        const config = await request('personal-assistant.configuration');
        if (!config.configured) throw new Error('个人助理尚未开通，请先在设置中连接云端实例');
        const directory = await request('personal-assistant.bots.list');
        const bot = publicBotDirectory(directory.bots)[0];
        if (!bot) throw new Error('云端还没有可用助理，请检查开通状态');
        if (!cancelled) setScope({ agentId: config.agentId, botId: bot.botId });
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
  if (!scope) return h('div', { role: 'status', style: { padding: 24 } }, error || '正在连接云端个人助理…', error ? h('button', { onClick: () => retry(value => value + 1) }, '重新连接') : null);
  return h('div', {
    key: `${scope.agentId}:${scope.botId}`, 'data-personal-assistant-home': 'true',
    'data-agent-id': scope.agentId, 'data-bot-id': scope.botId,
    style: { display: 'flex', height: '100%', minHeight: 0, alignItems: 'stretch' },
  },
  h('div', { style: { flex: '1 1 42%', minWidth: 320, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h(PersonalAssistantConversation, { React: R, request: scopedRequest, scope })),
  h('div', { style: { flex: '1 1 58%', minWidth: 420, minHeight: 0, display: 'flex', flexDirection: 'column', borderLeft: ui.border } },
    h(PersonalAssistantPanel, { request: scopedRequest, initialBotId: scope.botId, variant: 'computer', onBotChange: botId => setScope(current => ({ ...current, botId })) })));

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

  const check = useCallback(async () => {
    setChecking(true); setError('');
    const started = Date.now();
    try {
      const current = await request('personal-assistant.configuration');
      setConfig(current);
      if (current?.configured) {
        const directory = await request('personal-assistant.bots.list');
        setBots(Array.isArray(directory?.bots) ? directory.bots : []);
      } else { setBots([]); }
      setCheckedAt(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${Date.now() - started} ms`);
    } catch (reason) {
      setError(reason?.message || '连接检查失败');
      setCheckedAt(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 失败`);
    } finally { setChecking(false); }
  }, [request]);

  useEffect(() => { void check(); }, [check]);

  const configured = config?.configured === true;
  const status = config === null ? '检查中' : configured ? '已开通' : '尚未开通';
  const statusStyle = { ...settingsStyle.badge, ...(config === null ? settingsStyle.badgeIdle : configured ? settingsStyle.badgeOk : settingsStyle.badgeIdle) };
  const line = (label, value, first = false) => h('div', { style: first ? settingsStyle.rowFirst : settingsStyle.row },
    h('div', { style: settingsStyle.label }, label), h('div', { style: settingsStyle.value }, value));

  return h('section', { 'data-personal-assistant-settings': 'true', style: settingsStyle.page },
    h('div', null,
      h('h1', { style: settingsStyle.title }, '个人助理'),
      h('p', { style: { ...settingsStyle.lede, marginTop: 6 } }, '云端持续运行的助理，带一台独立云电脑。关掉窗口它也在工作；对话与云电脑在左侧「个人助理」页。')),
    error ? h('div', { role: 'alert', style: { ...settingsStyle.note, color: '#b42318', background: 'color-mix(in srgb, #b42318 8%, transparent)', border: '1px solid color-mix(in srgb, #b42318 25%, transparent)', borderRadius: 10, padding: '9px 12px' } }, error) : null,
    h('div', { style: settingsStyle.card },
      line('状态', h('span', null, h('span', { style: statusStyle }, status), checkedAt ? h('span', { style: settingsStyle.note }, `　上次检查 ${checkedAt}`) : null), true),
      line('云端实例', config?.agentId ? h('span', { style: settingsStyle.mono }, config.agentId) : h('span', { style: settingsStyle.note }, configured ? '未返回实例标识' : '开通后由 Studio 绑定')),
      line('网关', config?.gatewayUrl ? h('span', { style: settingsStyle.mono }, config.gatewayUrl) : h('span', { style: settingsStyle.note }, '由 Studio Host 配置')),
      line('助理', bots === null ? h('span', { style: settingsStyle.note }, '尚未读取')
        : bots.length ? bots.map(bot => h('span', { key: bot.botId, style: { display: 'inline-block', marginRight: 6, border: ui.border, borderRadius: 999, padding: '0 9px', fontSize: 12 } }, bot.displayName || bot.botId))
          : h('span', { style: settingsStyle.note }, '未返回可用助理')),
      line('记忆', h('div', null, h('div', { style: settingsStyle.mono }, '/workspace/assistant-state'),
        h('div', { style: settingsStyle.note }, '记忆、会话与定时任务随云电脑持久保存，换设备也在'))),
      line('云端能力', h('div', null,
        h('div', null, '默认开启：云端命令执行、云端浏览器'),
        h('div', { style: settingsStyle.note }, '都跑在隔离工作区：读不到本机文件与凭证，不能访问内网与本机地址；敏感操作会先请你确认'))),
      line('插件版本', h('span', { style: settingsStyle.note }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`))),
    h('div', { style: settingsStyle.actions },
      h('button', { style: settingsStyle.button, disabled: checking, onClick: () => void check() }, checking ? '正在检查…' : '检查连接'),
      h('span', { style: settingsStyle.note }, '检查会读取开通状态并拉取一次助理列表，不会启动云电脑')));
}

export function PersonalAssistantPanelIcon() { return '助'; }
export function PersonalAssistantComputerTabTitle() { return '云电脑'; }
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
  scope(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PERSONAL_ASSISTANT_PANEL_ID, inject: () => ({ request }),
  }, PersonalAssistantHome)), 'personal-assistant: main panel');
  scope(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PERSONAL_ASSISTANT_PANEL_ID, order: 90, label: '个人助理',
  }, PersonalAssistantPanelIcon)), 'personal-assistant: sidebar row');
  // Studio 设置页里的「个人助理」一节（原产品页被去重后留下的位置）。
  scope(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: `${PERSONAL_ASSISTANT_PANEL_ID}-settings`, order: 196, label: '个人助理',
    inject: () => ({ request }),
  }, PersonalAssistantSettings)), 'personal-assistant: settings section');
  // 右侧栏标签页在「有会话」的场景下由 dsh 自己挂载；个人助理是独立页面，
  // sidebarRight.openTab 会报 no session surface is mounted，所以页面内改用左右分栏。
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
