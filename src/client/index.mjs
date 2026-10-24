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

export const inject = Object.freeze(['slots', 'remote']);
export const PERSONAL_ASSISTANT_PANEL_ID = 'personal-assistant';
export const PERSONAL_ASSISTANT_CLIENT_DEFAULTS = Object.freeze({ enabled: false, autoConnect: false });
const DISPLAY = Object.freeze({ width: 1280, height: 800 });
const ACTIVE_POLL_MS = 100;
const IDLE_POLL_MS = 1_000;
const IDLE_AFTER_MS = 10_000;

function reactRuntime() {
  // DSH injects React into the browser evaluator; the guarded fallback keeps
  // node-side manifest/loader smoke tests importable without a DOM.
  return typeof React === 'object' && React ? React : globalThis.React;
}

function mapPoint(event, canvas, display) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(display.width - 1, Math.round((event.clientX - rect.left) * display.width / rect.width))),
    y: Math.max(0, Math.min(display.height - 1, Math.round((event.clientY - rect.top) * display.height / rect.height))),
  };
}

function isConflict(error) {
  return Number(error?.status || error?.statusCode || error?.httpStatus) === 409
    || String(error?.code || error?.error || '').toUpperCase().includes('LEASE_CONFLICT')
    || String(error?.message || '').includes('409');
}

function frameMime(frame) {
  const format = String(frame?.format || 'image/jpeg').toLowerCase();
  return format === 'webp' || format === 'image/webp' ? 'image/webp' : 'image/jpeg';
}

function drawFrame(canvas, frame, display) {
  const data = String(frame?.data || '');
  const seq = Number(frame?.seq);
  const bytes = Number(frame?.bytes);
  if (!data || !Number.isSafeInteger(seq) || seq < 0 || (Number.isFinite(bytes) && bytes > 300 * 1024)) return false;
  const image = new Image();
  image.onload = () => {
    const dpr = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#111827';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / display.width, canvas.height / display.height);
    const width = Math.round(display.width * scale);
    const height = Math.round(display.height * scale);
    context.drawImage(image, Math.round((canvas.width - width) / 2), Math.round((canvas.height - height) / 2), width, height);
  };
  image.src = `data:${frameMime(frame)};base64,${data}`;
  return true;
}

function DesktopPanel({ gateway, profileId = 'default', agentId = '', initialBotId = '', autoConnect = true, allowPollingFallback = false } = {}) {
  const R = reactRuntime();
  if (!R) return 'Personal Assistant is disabled by default. Enable the plugin to connect.';
  const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = R;
  const [bots, setBots] = useState([]);
  const [botId, setBotId] = useState(String(initialBotId || ''));
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  const [phase, setPhase] = useState(gateway?.request ? 'loading' : 'not-connected');
  const [notice, setNotice] = useState('');
  const [frameSeq, setFrameSeq] = useState(-1);
  const [frameCount, setFrameCount] = useState(0);
  const [lastFrameAt, setLastFrameAt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const canvasRef = useRef(null);
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const socketRef = useRef(null);
  const frameMetaRef = useRef(null);
  const firstFrameTimerRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const closingRef = useRef(false);
  const inFlightRef = useRef(false);
  const lastInputRef = useRef(0);
  const lastMoveRef = useRef(0);
  const mountedRef = useRef(true);
  const client = useMemo(() => createPersonalAssistantClient({ gateway, profileId }), [gateway, profileId]);
  const display = session?.display || DISPLAY;
  const readOnly = Boolean(session?.readOnly);
  sessionRef.current = session;
  const connected = Boolean(session?.sessionId && (phase === 'connecting' || phase === 'ready' || phase === 'readonly'));

  const clearStreamTimers = useCallback(() => {
    if (firstFrameTimerRef.current !== null) { globalThis.clearTimeout(firstFrameTimerRef.current); firstFrameTimerRef.current = null; }
    if (reconnectTimerRef.current !== null) { globalThis.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
  }, []);
  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) { globalThis.clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);
  const closeSession = useCallback(async () => {
    stopPolling();
    clearStreamTimers();
    closingRef.current = true;
    try { if (socketRef.current?.readyState === 1) socketRef.current.send(JSON.stringify({ type: 'close' })); socketRef.current?.close?.(1000, 'panel closed'); } catch {}
    socketRef.current = null;
    const current = sessionRef.current;
    setSession(null); setFrameSeq(-1); setPhase(gateway?.request ? 'idle' : 'not-connected');
    if (current?.sessionId && gateway?.request) await client.desktop.close({ sessionId: current.sessionId }).catch(() => {});
  }, [clearStreamTimers, client, gateway, stopPolling]);
  const consumeFrame = useCallback(next => {
    if (!mountedRef.current || !next || Number(next.seq) <= frameSeq) return false;
    if (drawFrame(canvasRef.current, next, display)) {
      if (firstFrameTimerRef.current !== null) { globalThis.clearTimeout(firstFrameTimerRef.current); firstFrameTimerRef.current = null; }
      const seq = Number(next.seq);
      setFrameSeq(seq); setFrameCount(count => count + 1); setLastFrameAt(Date.now());
      setPhase(readOnly ? 'readonly' : 'ready');
      return true;
    }
    return false;
  }, [display, frameSeq, readOnly]);
  const poll = useCallback(async () => {
    const current = session;
    if (socketRef.current?.readyState === 1) return;
    if (current?.sessionId && !current?.allowPollingFallback) return;
    if (!current?.sessionId || inFlightRef.current || (typeof document !== 'undefined' && document.hidden)) return;
    inFlightRef.current = true;
    try {
      const next = await client.desktop.frame({ sessionId: current.sessionId, afterSeq: frameSeq });
      if (!mountedRef.current) return;
      if (next?.unchanged) return;
      const seq = Number(next?.seq);
      if (!Number.isSafeInteger(seq) || seq <= frameSeq) return;
      consumeFrame(next)
    } catch (error) {
      if (mountedRef.current) { setNotice(error?.message || '云电脑画面暂不可用'); setPhase('reconnecting'); }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && session?.sessionId) {
        const delay = Date.now() - lastInputRef.current >= IDLE_AFTER_MS ? IDLE_POLL_MS : ACTIVE_POLL_MS;
        timerRef.current = globalThis.setTimeout(poll, delay);
      }
    }
  }, [client, consumeFrame, frameSeq, session]);
  const openSession = useCallback(async (requestedBotId = botId) => {
    if (!gateway?.request) { setPhase('not-connected'); setNotice('网关未连接'); return; }
    if (!requestedBotId) { setNotice('尚未选择 Bot'); return; }
    stopPolling(); clearStreamTimers(); closingRef.current = false; setNotice(''); setPhase('connecting'); setFrameSeq(-1);
    try {
      const ticketInput = { mode: 'control', taskId: `studio-desktop-${Date.now()}` };
      if (String(agentId || '').trim()) ticketInput.agentId = String(agentId).trim();
      const ticket = await client.desktop.ticket(ticketInput);
      if (!mountedRef.current) return;
      const opened = ticket?.session || ticket;
      const next = { ...opened, display: opened?.display || DISPLAY, botId: requestedBotId, openedAt: Date.now(), allowPollingFallback };
      sessionRef.current = next;
      setSession(next); setPhase(next.readOnly ? 'readonly' : 'connecting'); lastInputRef.current = Date.now();
      const wsUrl = ticket?.wsUrl || ticket?.streamUrl || ticket?.url;
      const ticketValue = ticket?.ticket || ticket?.oneTimeTicket;
      if (!wsUrl || !ticketValue || typeof WebSocket !== 'function') throw new Error('桌面实时通道不可用（缺少一次性 WebSocket ticket）');
      // Gateway returns a short-lived, pre-authorized WSS URL. The runtime
      // token is never placed in a URL; the opaque one-time ticket travels
      // in Sec-WebSocket-Protocol and is consumed by the gateway.
      const protocols = [ticket?.protocol || 'agentkit.personal-assistant.desktop.v1', `agentkit.desktop.ticket.${ticketValue}`];
      const socket = new WebSocket(wsUrl, protocols);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => { if (mountedRef.current) { reconnectAttemptsRef.current = 0; setPhase(next.readOnly ? 'readonly' : 'connecting'); socket.send(JSON.stringify({ type: 'open', botId: requestedBotId, taskId: `studio-desktop-${Date.now()}`, leaseId: next.leaseId })); firstFrameTimerRef.current = globalThis.setTimeout(() => { if (mountedRef.current && frameSeq < 0) { setNotice('首帧超过 3 秒，正在重连…'); try { socket.close(); } catch {} } }, 3_000); } };
      socket.onmessage = event => {
        try {
          if (typeof event.data !== 'string') {
            const meta = frameMetaRef.current;
            if (!meta || !event.data) return;
            const decode = bytes => {
              if (!bytes?.length || bytes.length > 300 * 1024) return;
              let binary = '';
              for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
              consumeFrame({ ...meta, data: globalThis.btoa(binary), bytes: bytes.length });
              frameMetaRef.current = null;
            };
            if (event.data instanceof ArrayBuffer) decode(new Uint8Array(event.data));
            else if (typeof event.data.arrayBuffer === 'function') void event.data.arrayBuffer().then(value => decode(new Uint8Array(value))).catch(() => {});
            return;
          }
          const value = JSON.parse(event.data);
          if (value?.type === 'ready') { setSession(current => ({ ...(current || next), ...value, display: value.display || DISPLAY, botId: requestedBotId })); setPhase(value.readOnly ? 'readonly' : 'ready'); return; }
          if (value?.type === 'frame') { frameMetaRef.current = value; if (value.data) consumeFrame(value); return; }
          if (value?.type === 'state' && value.readOnly !== undefined) { setSession(current => current ? { ...current, readOnly: Boolean(value.readOnly), controllerBotId: value.controllerBotId, leaseId: value.leaseId || current.leaseId } : current); }
          if (value?.type === 'error' && mountedRef.current) { if (Number(value.status) === 409 || String(value.code || '').includes('LEASE')) { setSession(current => current ? { ...current, readOnly: true, controllerBotId: value.controllerBotId } : current); setPhase('readonly'); setNotice('该 Bot 正在控制，你当前为只读'); } else { setNotice(value.message || '桌面实时通道错误'); setPhase('reconnecting'); } }
        } catch { /* malformed frames are dropped, never queued */ }
      };
      socket.onerror = () => { if (mountedRef.current) { setNotice('桌面通道断开，正在重连…'); setPhase('reconnecting'); } };
      socket.onclose = () => {
        if (!mountedRef.current || closingRef.current) return;
        if (sessionRef.current?.sessionId === next.sessionId) setPhase('reconnecting');
        const attempt = reconnectAttemptsRef.current + 1;
        reconnectAttemptsRef.current = attempt;
        if (attempt <= 5) reconnectTimerRef.current = globalThis.setTimeout(() => { void openSession(requestedBotId); }, Math.min(8_000, 2 ** (attempt - 1) * 1_000));
        else { setPhase('error'); setNotice('无法连接云电脑，请重试'); }
      };
      socketRef.current = socket;
    } catch (error) {
      if (mountedRef.current) { setPhase('error'); setNotice(error?.message || '云电脑连接失败'); }
    }
  }, [agentId, allowPollingFallback, botId, client, clearStreamTimers, frameSeq, gateway, poll, profileId, stopPolling]);
  const sendInput = useCallback(async event => {
    if (!session?.sessionId) { setNotice('云电脑尚未连接'); return false; }
    if (readOnly) { setNotice(`Bot ${session.controllerBotId || '其他 Bot'} 正在控制，你当前为只读`); return false; }
    lastInputRef.current = Date.now();
    try {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== 1) { setNotice('桌面通道尚未连接'); return false; }
      socket.send(JSON.stringify({ type: 'input', sessionId: session.sessionId, leaseId: session.leaseId, event }));
      return true;
    } catch (error) { if (isConflict(error)) { setSession(current => current ? { ...current, readOnly: true } : current); setPhase('readonly'); setNotice('该 Bot 正在控制，你当前为只读'); } else setNotice(error?.message || '输入未送达'); return false; }
  }, [client, readOnly, session]);
  const sendMove = useCallback(event => {
    const now = Date.now();
    if (now - lastMoveRef.current < 33) return;
    lastMoveRef.current = now;
    void sendInput(event);
  }, [sendInput]);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; stopPolling(); void closeSession(); }; }, []);
  useEffect(() => {
    if (!gateway?.request) return undefined;
    let alive = true;
    client.listBots().then(result => {
      if (!alive) return;
      const values = Array.isArray(result) ? result : (result?.bots || result?.items || []);
      setBots(values);
      const first = String(botId || values[0]?.botId || values[0]?.id || '').trim();
      if (first) { setBotId(first); if (autoConnect) void openSession(first); }
      else setPhase('idle');
    }).catch(error => { if (alive) { setPhase('error'); setNotice(error?.message || 'Bot 列表暂不可读取'); } });
    return () => { alive = false; };
  }, [autoConnect, client, gateway]);
  useEffect(() => () => { stopPolling(); }, [stopPolling]);

  const onPointer = event => {
    event.preventDefault();
    inputRef.current?.focus?.();
    if (event.type === 'pointerdown') canvasRef.current?.setPointerCapture?.(event.pointerId);
    if (event.type === 'pointerup') canvasRef.current?.releasePointerCapture?.(event.pointerId);
    const point = mapPoint(event, canvasRef.current, display);
    const button = Number(event.button) + 1;
    const payload = event.type === 'pointerup' ? { type: 'button', action: 'up', button, ...point } : event.type === 'pointerdown' ? { type: 'button', action: 'down', button, ...point } : { type: 'pointermove', buttons: event.buttons, ...point };
    void sendInput(payload);
  };
  const statusText = phase === 'not-connected' ? '网关未连接' : phase === 'idle' ? '尚未创建云电脑' : phase === 'loading' ? '正在读取 Bot…' : phase === 'connecting' ? (frameSeq < 0 ? '正在连接云电脑…' : '正在接收画面…') : phase === 'readonly' ? `Bot ${session?.controllerBotId || '其他'} 正在控制，你当前为只读` : phase === 'reconnecting' ? '断线重连中…' : phase === 'error' ? notice || '云电脑连接失败' : '你正在控制';
  const banner = phase === 'readonly' ? h('div', { role: 'alert', style: { background: '#fff3df', color: '#8a4b08', padding: '8px 12px', fontSize: 12 } }, statusText) : null;
  const frameRate = lastFrameAt ? Math.round(frameCount / Math.max(1, (lastFrameAt - (session?.openedAt || lastFrameAt)) / 1000)) : 0;
  const controls = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-default, #e5e7eb)' } },
    h('strong', { style: { fontSize: 14 } }, '云电脑'),
    h('select', { value: botId, disabled: phase === 'connecting', 'aria-label': '选择 Bot', onChange: event => { const next = event.target.value; setBotId(next); void closeSession().then(() => openSession(next)); } }, bots.map(bot => h('option', { key: bot.botId || bot.id, value: bot.botId || bot.id }, bot.displayName || bot.name || bot.botId || bot.id)), !bots.length ? h('option', { value: '' }, '暂无 Bot') : null),
    h('span', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: phase === 'ready' ? '#15803d' : '#64748b' } }, statusText),
    h('span', { style: { marginLeft: 'auto', fontSize: 11, color: '#64748b' } }, `${frameRate || 0} fps`),
    h('button', { type: 'button', onClick: () => void openSession(), disabled: phase === 'connecting' }, '重试'),
    h('button', { type: 'button', onClick: () => { const node = canvasRef.current?.parentElement; if (!node) return; if (node.requestFullscreen) { void node.requestFullscreen(); setFullscreen(true); } } }, fullscreen ? '已全屏' : '全屏'),
  );
  const keyEvent = event => { if (['Tab', 'Escape'].includes(event.key)) event.preventDefault(); const modifiers = [event.ctrlKey || event.metaKey ? 'ctrl' : '', event.altKey ? 'alt' : '', event.shiftKey ? 'shift' : ''].filter(Boolean); const key = [...modifiers, event.key].join('+'); void sendInput({ type: 'key', action: event.type === 'keyup' ? 'up' : 'down', key }); };
  const canvas = h('canvas', { ref: canvasRef, tabIndex: 0, role: 'img', 'aria-label': '云电脑桌面', onPointerMove: event => { event.preventDefault(); if (!canvasRef.current) return; const point = mapPoint(event, canvasRef.current, display); sendMove({ type: 'pointermove', buttons: event.buttons, ...point }); }, onPointerDown: onPointer, onPointerUp: onPointer, onDoubleClick: event => { event.preventDefault(); const point = mapPoint(event, canvasRef.current, display); void sendInput({ type: 'button', action: 'double', button: 1, ...point }); }, onContextMenu: event => { event.preventDefault(); if (!canvasRef.current) return; const point = mapPoint(event, canvasRef.current, display); void sendInput({ type: 'button', action: 'down', button: 3, ...point }).then(ok => ok && sendInput({ type: 'button', action: 'up', button: 3, ...point })); }, onWheel: event => { event.preventDefault(); void sendInput({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY }); }, onKeyDown: keyEvent, onKeyUp: keyEvent, style: { width: '100%', height: '100%', display: 'block', objectFit: 'contain', background: '#111827', cursor: readOnly ? 'not-allowed' : 'crosshair' } });
  useEffect(() => { const listener = () => setFullscreen(Boolean(document.fullscreenElement)); document?.addEventListener?.('fullscreenchange', listener); return () => document?.removeEventListener?.('fullscreenchange', listener); }, []);
  const hiddenInput = h('input', { ref: inputRef, 'aria-label': '云电脑文本输入', style: { position: 'absolute', opacity: 0, pointerEvents: 'none', width: 1, height: 1 }, onInput: event => { if (event.nativeEvent?.isComposing) return; const value = event.currentTarget.value; if (value) { event.currentTarget.value = ''; void sendInput({ type: 'text', text: value }); } }, onCompositionEnd: event => { const value = event.currentTarget.value; event.currentTarget.value = ''; if (value) void sendInput({ type: 'text', text: value }); }, onKeyDown: keyEvent, onKeyUp: keyEvent });
  return h('section', { 'data-personal-assistant-panel': 'true', style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #111827)' } }, controls, banner, notice && phase !== 'readonly' ? h('div', { role: 'status', style: { padding: '6px 12px', color: '#b45309', fontSize: 12 } }, notice) : null, h('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: 12 } }, canvas, hiddenInput));
}

export function PersonalAssistantPanel(props = {}) { return DesktopPanel(props); }
export function PersonalAssistantPanelIcon() { return 'PA'; }

export function apply(ctx) {
  if (!ctx?.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
    throw new TypeError('Personal Assistant client requires the public DSH slots service');
  }
  const gateway = [ctx.gateway, ctx.remote?.gateway, ctx.connection?.gateway].find(value => value && typeof value.request === 'function');
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PERSONAL_ASSISTANT_PANEL_ID },
    props => PersonalAssistantPanel({ ...props, gateway }),
  ));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PERSONAL_ASSISTANT_PANEL_ID, order: 90, label: 'Personal Assistant' },
    PersonalAssistantPanelIcon,
  ));
}

export const createClientPlugin = createPersonalAssistantClient;
