/**
 * 个人助理主面板的对话视图。
 *
 * 数据全部走 Studio Host 的 personal-assistant.* RPC：
 *   sessions.list / session.create / session.snapshot / session.events / turn.submit
 * Host 侧通道尚未就绪时，这里只降级为一条可重试的提示，不抛出、不影响插件激活。
 */

import { renderMarkdown } from './markdown.mjs';

const EMPTY_HINT = '有什么可以帮你？';

const styles = {
  page: {
    height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', fontSize: 13,
    color: 'var(--dsw-alias-label-primary, #17202c)', background: 'var(--dsw-alias-bg-layer-1, #fff)',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
    borderBottom: '1px solid var(--dsw-alias-border-default, #d8dee8)', flex: 'none',
  },
  title: { margin: 0, fontSize: 14, fontWeight: 600 },
  status: { color: 'var(--dsw-alias-label-secondary, #536174)', fontSize: 12 },
  spacer: { marginLeft: 'auto' },
  ghost: {
    border: '1px solid var(--dsw-alias-border-default, #d8dee8)', background: 'transparent',
    color: 'inherit', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12,
  },
  scroller: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 16px 8px' },
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
  composer: { flex: 'none', padding: '8px 16px 14px' },
  composerInner: {
    maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-default, #d8dee8)', borderRadius: 16, padding: '10px 10px 8px 12px',
    background: 'var(--dsw-alias-bg-layer-1, #fff)',
  },
  textarea: {
    flex: 1, minHeight: 24, maxHeight: 200, resize: 'none', border: 'none', outline: 'none',
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
  const cursorRef = useRef(0);
  const outboxRef = useRef(new Map());
  const generationRef = useRef(0);
  const aliveRef = useRef(true);
  const bottomRef = useRef(null);
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
    sessionRef.current = id;
    const generation = ++generationRef.current;
    setSessionId(id);
    setPhase('loading');
    setError('');
    cursorRef.current = 0;
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
    return () => { aliveRef.current = false; };
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
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages]);

  const pickFiles = async event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    const loaded = [];
    for (const file of files.slice(0, 4)) {
      if (!file || file.size > 8 * 1024 * 1024) continue;
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

  const submit = async (retryItem = null) => {
    const content = retryItem?.text ?? draft.trim();
    if (!content || sending || !sessionId) return;
    const item = retryItem ?? { clientTurnId: crypto.randomUUID(), text: content, sessionId };
    const localId = `local-user-${item.clientTurnId}`;
    outboxRef.current.set(item.clientTurnId, item);
    setSending(true); setDraft(''); setError(''); setAwaiting(true);
    setMessages(previous => previous.some(row => row.clientTurnId === item.clientTurnId) ? previous.map(row => row.clientTurnId === item.clientTurnId ? { ...row, status: 'pending' } : row) : [...previous, { id: localId, clientTurnId: item.clientTurnId, role: 'user', text: content, done: false, status: 'pending' }]);
    try {
      const receipt = await call('personal-assistant.turn.submit', { sessionId: item.sessionId, text: content, clientTurnId: item.clientTurnId });
      if (!aliveRef.current) return;
      outboxRef.current.delete(item.clientTurnId);
      setMessages(previous => previous.map(row => row.clientTurnId === item.clientTurnId ? { ...row, status: 'accepted', turnId: receipt.turnId } : row));
    } catch (failure) {
      if (!aliveRef.current) return;
      setAwaiting(false);
      setDraft(current => current || content);
      setMessages(previous => previous.map(row => row.clientTurnId === item.clientTurnId ? { ...row, status: 'failed', failure: failure.message || '发送结果待确认，重试将复用原标识' } : row));
    } finally { if (aliveRef.current) setSending(false); }
  };

  const header = h('header', { style: styles.header },
    h('h1', { style: styles.title }, '个人助理'),
    h('span', { style: styles.status }, phase === 'ready' ? '云端常驻，关掉窗口也会继续' : phase === 'loading' ? '正在连接…' : '连接不可用'),
    h('span', { style: styles.spacer }, scope?.botId || ''));

  if (phase === 'loading') {
    return h('section', { style: styles.page }, header, h('div', { style: styles.centered }, h('span', { style: styles.status }, '正在连接个人助理…')));
  }
  if (phase === 'error') {
    return h('section', { style: styles.page }, header,
      h('div', { style: styles.centered }, h('div', { style: styles.centeredInner },
        h('strong', null, '暂时连不上个人助理'),
        h('span', { style: styles.status }, error || '请稍后重试'),
        h('button', { style: styles.ghost, onClick: () => void bootstrap() }, '重试'))));
  }

  return h('section', { style: styles.page }, header,
    h('style', null, '@keyframes pa-awaiting { 0%, 100% { opacity: 0.35 } 50% { opacity: 1 } }'),
    error ? h('div', { role: 'alert', style: { padding: '8px 16px', background: '#fff0d6' } }, error) : null,
    h('div', { style: styles.scroller },
      h('div', { style: styles.thread },
        messages.length === 0 ? h('div', { style: { ...styles.status, paddingTop: 40, textAlign: 'center' } }, EMPTY_HINT) : null,
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
            h('span', { style: styles.pulse }, '正在处理…'))) : null,
        h('div', { ref: bottomRef }))),
    h('div', { style: styles.composer },
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
          placeholder: '给个人助理发消息，Enter 发送，Shift+Enter 换行',
          onChange: event => setDraft(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) { event.preventDefault(); void submit(); }
          },
        }),
        h('div', { style: styles.composerBar },
          h('button', { 'aria-label': '添加附件', style: styles.iconButton, disabled: true, title: '云端附件上传尚未开放', onClick: () => fileRef.current?.click() }, plusGlyph(h)),
          h('input', { ref: fileRef, type: 'file', multiple: true, accept: 'image/*,.txt,.md,.json,.pdf', style: { display: 'none' }, onChange: pickFiles }),
          h('span', { style: styles.spacer }),
          h('button', {
            'aria-label': '发送消息',
            disabled: sending || (!draft.trim() && attachments.length === 0),
            style: sending || (!draft.trim() && attachments.length === 0) ? { ...styles.send, ...styles.sendDisabled } : styles.send,
            onClick: () => void submit(),
          }, sendGlyph(h))))));
}
