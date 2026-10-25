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
import { mapDisplayPoint, normalizeDisplay } from './desktop-view.mjs';
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
const keyNames = { Control: 'Control_L', Meta: 'Super_L', Alt: 'Alt_L', Shift: 'Shift_L', Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'BackSpace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'space' };

export function PersonalAssistantPanel({ request, initialBotId = '' } = {}) {
  const R = clientReact || globalThis.React;
  if (!R) return '个人助理页面尚未就绪，请重新打开';
  const { createElement: h, useEffect, useRef, useState } = R;
  const [config, setConfig] = useState(null);
  const [bots, setBots] = useState([]);
  const [directoryError, setDirectoryError] = useState('');
  const [botId, setBotId] = useState(initialBotId);
  const [phase, setPhase] = useState('loading');
  const [notice, setNotice] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [fps, setFps] = useState(0);
  const [full, setFull] = useState(false);
  const canvasRef = useRef(null), inputRef = useRef(null), viewRef = useRef(null);
  const state = useRef({ mounted: true, socket: null, generation: 0, session: null, display: { width: 1280, height: 800 }, readOnly: true, botId, config: null, reconnect: null, firstFrame: null, receivedSeq: -1, pendingFrame: null, decoding: false, frames: 0, lastMove: 0, pressed: new Set(), buttons: new Set(), composition: false, retries: 0, taskId: '', mode: 'control', frameMetadata: null, reconnectAllowed: false });
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
          if (!current.mounted || job.generation !== current.generation || job.seq < current.receivedSeq || !canvasRef.current) continue;
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
  const open = async (mode = 'control', reconnecting = false) => {
    const current = state.current;
    const selected = String(current.botId || '').trim();
    if (!current.config?.configured) { setPhase('unconfigured'); return; }
    if (!selected || !current.bots?.some(bot => bot.botId === selected)) { setNotice('请先选择可用的助理'); return; }
    close(false);
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
          current.receivedSeq = meta.seq; current.pendingFrame = { bytes, seq: meta.seq, generation }; void drawLatest(); return;
        }
        let value; try { value = JSON.parse(event.data); } catch { return; }
        if (value.type === 'ready') {
          current.session = value.sessionId; current.readOnly = Boolean(value.readOnly); current.display = normalizeDisplay(value.display);
          setReadOnly(current.readOnly); setNotice('云电脑已连接，正在准备桌面画面'); return;
        }
        if (value.type === 'frame') { if (!value.unchanged) current.frameMetadata = value; return; }
        if (value.type === 'closed') { if (value.retryable !== true) ended(value); return; }
        if (value.type === 'error') {
          setNotice(value.message || value.code || '云电脑请求失败');
          if (Number(value.status) === 409 && mode === 'control' && !current.session) { void open('read'); return; }
          if ([404, 409].includes(Number(value.status)) || value.code === 'DESKTOP_SESSION_NOT_FOUND') ended(value);
          else if (!current.session) { setPhase('error'); close(false); }
        }
      };
      socket.onerror = () => { if (valid()) setNotice('桌面通道暂时断开，正在重连'); };
      socket.onclose = event => {
        if (!valid()) return;
        current.session = null; clearTimeout(current.firstFrame); current.firstFrame = null;
        if (!current.reconnectAllowed || event.code === 1000) { ended(); return; }
        if (document.hidden) { setPhase('hidden'); return; }
        const count = ++current.retries; setAttempt(count);
        if (count > 5) { current.reconnectAllowed = false; setPhase('error'); setNotice('无法连接云电脑，请检查实例状态或网络后重试'); return; }
        setPhase('reconnecting'); current.reconnect = setTimeout(() => { void open(mode, true); }, Math.min(8000, 1000 * 2 ** (count - 1)));
      };
    } catch (error) { if (current.mounted && generation === current.generation) { setPhase('error'); setNotice(failure(error)); } }
  };
  const refreshConnection = async signal => {
    close(false); setPhase('loading'); setNotice(''); setDirectoryError('');
    try {
      const value = await rpc('personal-assistant.configuration');
      if (signal?.aborted || !state.current.mounted) return;
      state.current.config = value; setConfig(value);
      if (!value.configured) { state.current.bots = []; setBots([]); setBotId(''); setPhase('unconfigured'); return; }
      const result = await rpc('personal-assistant.bots.list');
      if (signal?.aborted || !state.current.mounted) return;
      if (result.directoryAvailable !== true) throw Object.assign(new Error('directory unavailable'), { code: 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE', status: 409 });
      const available = publicBotDirectory(result.bots);
      state.current.bots = available; setBots(available);
      const selected = available.some(bot => bot.botId === state.current.botId) ? state.current.botId : available[0]?.botId || '';
      state.current.botId = selected; setBotId(selected); setPhase(available.length ? 'idle' : 'empty');
    } catch (error) {
      if (signal?.aborted || !state.current.mounted) return;
      state.current.bots = []; setBots([]); setBotId(''); setPhase('directory-error');
      setDirectoryError(failure(error));
    }
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
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', blur); document.addEventListener('fullscreenchange', fullscreen);
    return () => { current.mounted = false; controller.abort(); close(false); clearInterval(interval); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', blur); document.removeEventListener('fullscreenchange', fullscreen); };
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
  const stateText = { loading: '正在检查助理状态', idle: '准备连接', unconfigured: '个人助理尚未开通', empty: '暂时没有可用助理', 'directory-error': '暂时无法读取助理列表', connecting: '正在启动云电脑', readonly: '只读旁观', ready: '正在控制云电脑', reconnecting: '正在恢复连接', hidden: '画面已暂停', closed: '桌面连接已结束', error: '连接暂时不可用' }[phase];
  const buttonStyle = { ...ui, borderRadius: 6, padding: '7px 12px', cursor: 'pointer', font: 'inherit' };
  const active = ['ready', 'readonly', 'hidden', 'reconnecting'].includes(phase);
  const selectable = bots.length > 0;
  const emptyTitle = phase === 'unconfigured' ? '开通后，在这里连接你的个人助理' : phase === 'empty' ? '助理正在准备中' : phase === 'directory-error' ? '暂时无法读取助理列表' : '正在检查助理状态';
  const emptyDetail = phase === 'unconfigured' ? '开通完成后，即可在这里连接专属云电脑。' : phase === 'empty' ? '云端初始化完成后，可用助理会显示在这里。' : phase === 'directory-error' ? directoryError : '请稍候';
  return h('section', { 'data-personal-assistant-panel': 'true', style: { ...ui, border: 'none', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', fontSize: 13 } },
    h('header', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: 12, borderBottom: ui.border } },
      h('strong', { style: { fontWeight: 500, marginRight: 8 } }, '个人助理'),
      selectable ? h('label', null, '当前助理 ', h('select', { 'aria-label': '当前助理', value: botId, onChange: event => { close(); setBotId(event.target.value); }, style: { ...ui, borderRadius: 6, padding: '6px 8px', maxWidth: 220 } }, bots.map(bot => h('option', { key: bot.botId, value: bot.botId }, bot.displayName)))) : null,
      selectable ? h('button', { style: buttonStyle, disabled: phase === 'connecting', onClick: () => void open('control') }, readOnly && phase === 'readonly' ? '申请控制' : active ? '重新连接' : '连接云电脑') : null,
      selectable ? h('button', { style: buttonStyle, disabled: phase === 'connecting', onClick: () => void open('read') }, '只读旁观') : null,
      active || phase === 'connecting' ? h('button', { style: buttonStyle, onClick: () => { close(); setNotice(''); } }, '断开连接') : null,
      active ? h('button', { style: buttonStyle, onClick: () => { if (document.fullscreenElement) void document.exitFullscreen(); else void viewRef.current?.requestFullscreen(); } }, full ? '退出全屏' : '全屏') : null,
      active ? h('span', { role: 'status', 'aria-live': 'polite', style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-secondary, #536174)' } }, stateText) : null),
    phase === 'readonly' ? h('div', { role: 'alert', style: { background: '#fff0d6', color: '#763c00', padding: '8px 12px' } }, '当前为只读旁观，鼠标和键盘输入不会发送；可申请控制') : null,
    active && notice ? h('div', { role: 'status', style: { padding: '8px 12px' } }, notice) : null,
    h('div', { ref: viewRef, style: { position: 'relative', flex: 1, minHeight: 240, background: active || phase === 'connecting' ? '#10151e' : 'transparent' } },
      h('canvas', { ref: canvasRef, 'aria-label': '云电脑桌面', tabIndex: active ? 0 : -1, onPointerDown: pointer, onPointerUp: pointer, onPointerCancel: releasePointer, onLostPointerCapture: releasePointer, onPointerMove: event => { if (Date.now() - state.current.lastMove < 34) return; state.current.lastMove = Date.now(); input({ type: 'pointermove', ...point(event) }); }, onContextMenu: event => event.preventDefault(), onWheel: event => { event.preventDefault(); input({ type: 'wheel', deltaY: event.deltaY / 100, deltaX: event.deltaX / 100 }); }, onKeyDown: key, onKeyUp: key, style: { width: '100%', height: '100%', display: 'block', visibility: active ? 'visible' : 'hidden', pointerEvents: active ? 'auto' : 'none', touchAction: 'none', cursor: readOnly ? 'default' : 'crosshair' } }),
      !active ? h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center', ...(phase === 'connecting' ? { color: '#e8edf5' } : {}) } },
        h('h2', { style: { margin: 0, fontSize: 20, fontWeight: 500 } }, selectable ? stateText : emptyTitle),
        h('p', { style: { margin: 0, maxWidth: 380, lineHeight: 1.7, color: phase === 'connecting' ? '#b8c1d1' : 'var(--dsw-alias-label-secondary, #536174)' } }, selectable ? notice || '连接后即可使用云端桌面，关闭面板会释放本次控制。' : emptyDetail),
        !selectable && phase !== 'loading' ? h('button', { style: buttonStyle, onClick: () => void refreshConnection() }, '检查开通状态') : null) : null,
      h('input', { ref: inputRef, 'aria-label': '云电脑文本输入', autoComplete: 'off', disabled: !active || readOnly, tabIndex: -1, style: { position: 'absolute', width: 1, height: 1, opacity: 0, left: 0, top: 0 }, onKeyDown: key, onKeyUp: key, onCompositionStart: () => { state.current.composition = true; }, onCompositionEnd: event => { state.current.composition = false; const text = event.currentTarget.value; event.currentTarget.value = ''; if (text) input({ type: 'text', text }); }, onInput: event => { if (state.current.composition || event.nativeEvent?.isComposing) return; const text = event.currentTarget.value; event.currentTarget.value = ''; if (text) input({ type: 'text', text }); } })),
    h('footer', { style: { display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 12, padding: '7px 12px', color: 'var(--dsw-alias-label-secondary, #536174)', borderTop: ui.border } },
      h('details', null, h('summary', { style: { cursor: 'pointer' } }, '诊断'),
        h('div', { style: { paddingTop: 8, lineHeight: 1.8, overflowWrap: 'anywhere' } }, h('div', null, `云端实例：${config?.agentId || '未开通'}`), h('div', null, `助理标识：${botId || '未选择'}`), h('div', null, `画面帧率：${fps} fps`), h('div', null, '快捷键会转发到云电脑；Esc 优先退出全屏'))),
      h('small', { 'data-personal-assistant-build': PERSONAL_ASSISTANT_CLIENT_BUILD, style: { opacity: 0.75 } }, `构建 ${PERSONAL_ASSISTANT_CLIENT_BUILD}`)));

}
export function PersonalAssistantPanelIcon() { return '助'; }
export function apply(ctx) {
  if (!ctx?.slots?.inject || !ctx.slots.register) throw new TypeError('Personal Assistant client requires the public DSH slots service');
  const request = async (operation, payload = {}) => {
    if (!ctx.connection?.rpc?.call) throw new PersonalAssistantGatewayUnavailableError();
    const result = await ctx.connection.rpc.call('/api', 'personal-assistant', { operation, payload });
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || 'Studio Host 请求失败'), { code: result?.error?.code, status: result?.error?.details?.status });
    return result.value;
  };
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PERSONAL_ASSISTANT_PANEL_ID, inject: () => ({ request }) }, PersonalAssistantPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PERSONAL_ASSISTANT_PANEL_ID, order: 90, label: '个人助理' }, PersonalAssistantPanelIcon));
}
export const createClientPlugin = createPersonalAssistantClient;
