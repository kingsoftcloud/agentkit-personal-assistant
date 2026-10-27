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
 */

import { renderMarkdown } from './markdown.mjs';

const EMPTY_HINT = '有什么可以帮你？';
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

/** 与 DSH 原生对话框一致的发送箭头。 */
const sendGlyph = h => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M12 19V5M5 12l7-7 7 7' }));
const plusGlyph = h => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true },
  h('path', { d: 'M12 5v14M5 12h14' }));
const closeGlyph = h => h('svg', { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', 'aria-hidden': true },
  h('path', { d: 'M6 6l12 12M18 6L6 18' }));

export function PersonalAssistantConversation({ React: R, request, scope, onOpenComputer = null } = {}) {
  if (!R) return '个人助理对话尚未就绪，请重新打开';
  const { createElement: h, useCallback, useEffect, useRef, useState } = R;
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState('');
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

  const call = useCallback(async (operation, payload = {}) => {
    if (typeof request !== 'function') throw new Error('Studio Host 尚未连接');
    return request(operation, payload);
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
    cursorRef.current = 0;
    followLatestRef.current = true;
    setMessages([]);
    try {
      const snapshot = await call('personal-assistant.session.snapshot', { sessionId: id });
      if (!aliveRef.current || sessionRef.current !== id || generation !== generationRef.current) return;
      cursorRef.current = Number(snapshot?.cursor) || 0;
      const history = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
      setMessages(history.map((message, index) => ({
        id: text(message?.id) || `history-${index}`,
        role: text(message?.role) || 'assistant',
        text: text(message?.text),
        done: true,
      })));
      setAwaiting(snapshot.turns?.some(turn => ['queued', 'running'].includes(turn.status)) || false);
      setPhase('ready');
    } catch (failure) {
      if (!aliveRef.current || generation !== generationRef.current) return;
      setPhase('error');
      setError(failure?.message || '无法读取会话内容');
    }
  }, [call]);

  const bootstrap = useCallback(async () => {
    setPhase('loading');
    setError('');
    if (!aliveRef.current) return;
    try {
      const listed = await call('personal-assistant.sessions.list');
      if (!aliveRef.current) return;
      const available = Array.isArray(listed?.sessions) ? listed.sessions : [];
      setSessions(available);
      if (available.length > 0) { await openSession(text(available[0].sessionId)); return; }
      const created = await call('personal-assistant.session.create', {});
      if (!aliveRef.current) return;
      const createdId = text(created?.sessionId);
      setSessions(createdId ? [{ sessionId: createdId, title: text(created?.title) || '新会话' }] : []);
      await openSession(createdId);
    } catch (failure) {
      if (!aliveRef.current) return;
      setPhase('error');
      setError(failure?.message || '会话通道暂时不可用');
    }
  }, [call, openSession]);

  useEffect(() => {
    aliveRef.current = true;
    void bootstrap();
    return () => {
      aliveRef.current = false;
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    };
  }, [bootstrap]);

  // 事件增量：宿主侧按 cursor 返回增量，空增量也要前进 cursor。
  useEffect(() => {
    if (phase !== 'ready' || !sessionId) return undefined;
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
          mergeEvents(page.turns.filter(turn => ['failed', 'interrupted', 'cancelled'].includes(turn.status)).map(turn => ({ type: 'step', id: `turn-status-${turn.turnId}`, text: `任务${turn.status === 'failed' ? '失败' : '已中断'}：${turn.error || '请检查任务状态后重试'}` })));
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
  }, [phase, sessionId, call, mergeEvents, openSession]);

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

  const header = h('header', { style: styles.header },
    h('h1', { style: styles.title }, '个人助理'),
    h('span', { style: styles.status }, phase === 'ready' ? '云端常驻，关掉窗口也会继续' : phase === 'loading' ? '正在连接…' : '连接不可用'),
    h('span', { style: styles.spacer }),
    onOpenComputer ? h('button', { type: 'button', onClick: onOpenComputer, 'aria-label': '打开云电脑侧栏', title: '打开或重新打开云电脑侧栏', style: { ...styles.ghost, display: 'inline-flex', alignItems: 'center', gap: 6 } }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }), h('path', { d: 'M8 21h8M12 17v4' })), '云电脑') : null);

  return h('section', { 'data-personal-assistant-conversation': 'true', style: styles.page, onClick: async event => {
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
    h('style', null, '@keyframes pa-awaiting { 0%, 100% { opacity: 0.35 } 50% { opacity: 1 } }'),
    error && messages.length > 0 ? h('div', { role: 'alert', style: { padding: '8px 16px', background: '#fff0d6' } }, error) : null,
    h('div', { ref: scrollerRef, 'data-personal-assistant-messages': 'true', style: styles.scroller, onScroll: event => {
      const element = event.currentTarget;
      followLatestRef.current = element.scrollHeight - element.clientHeight - element.scrollTop < 64;
    } },
      h('div', { style: styles.thread },
        messages.length === 0 ? h('div', { style: { ...styles.status, paddingTop: 40, textAlign: 'center' } },
          phase === 'error' ? h('div', { style: { ...styles.centeredInner, margin: '0 auto' } },
            h('strong', null, '暂时连不上个人助理'), h('span', null, error || '请稍后重试'),
            h('button', { style: styles.ghost, onClick: () => void bootstrap() }, '重试'))
            : phase === 'loading' ? '正在连接个人助理…' : EMPTY_HINT) : null,
        messages.map(message => {
          if (message.role === 'step') return h('div', { key: message.id, style: styles.step }, `· ${message.text}`);
          const mine = message.role === 'user';
          return h('div', { key: message.id, style: mine ? styles.rowUser : styles.row },
            h('span', { style: styles.who }, mine ? '你' : '助理'),
            h('div', { style: mine ? styles.bubbleUser : styles.bubble },
              mine ? (message.text || '…') : (renderMarkdown(h, message.text || '', styles) || '…')),
            message.status === 'failed' ? h('button', { onClick: () => void submit(outboxRef.current.get(message.clientTurnId)), disabled: sending }, `${message.failure} · 重试发送`) : null);
        }),
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
