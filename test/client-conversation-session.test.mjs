/**
 * 会话恢复与显式新建：避免面板重挂载或云端目录异常时静默换成空会话。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantConversation } from '../src/client/conversation.mjs';

const STORAGE_PREFIX = 'agentkit.personal-assistant.current-session.v1';

function view(t, { listed = { sessions: [{ sessionId: 'old-session', title: '旧会话' }] }, scope = { agentId: 'ar-test', botId: 'default' } } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hooks = [], pendingEffects = [], requests = [];
  let cursor = 0, dirty = true, tree;
  const changed = (before, after) => !before || before.length !== after.length || after.some((value, index) => value !== before[index]);
  const R = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() }; },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; dirty = true; }]; },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useCallback(callback, deps) { const index = cursor++; if (changed(hooks[index]?.deps, deps)) hooks[index] = { deps, callback }; return hooks[index].callback; },
    useEffect(effect, deps) { const index = cursor++; if (changed(hooks[index]?.deps, deps)) { const previous = hooks[index]; hooks[index] = { deps }; pendingEffects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = effect(); }); } },
  };
  const request = async (operation, payload) => {
    requests.push({ operation, payload });
    if (operation.endsWith('.sessions.list')) return listed;
    if (operation.endsWith('.session.create')) return { sessionId: 'new-session', title: '新会话' };
    if (operation.endsWith('.session.snapshot')) return { cursor: 0, messages: [], turns: [] };
    if (operation.endsWith('.session.events')) return { cursor: 0, events: [], turns: [] };
    return {};
  };
  const render = () => { cursor = 0; dirty = false; tree = PersonalAssistantConversation({ React: R, request, scope }); for (const effect of pendingEffects.splice(0)) effect(); };
  const settle = async () => { for (let i = 0; i < 40; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } return tree; };
  const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  const textOf = node => nodes(node).flatMap(item => item.children.filter(child => typeof child === 'string')).join(' ');
  t.after(() => { for (const hook of hooks) hook?.cleanup?.(); });
  return { settle, requests, nodes: () => nodes(tree), text: () => textOf(tree) };
}

function installStorage(t, entries = {}) {
  const previous = globalThis.localStorage;
  const values = new Map(Object.entries(entries));
  globalThis.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  return values;
}

test('会话目录格式异常时不静默创建新会话', async t => {
  const viewState = view(t, { listed: {} });
  await viewState.settle();
  assert.equal(viewState.requests.filter(row => row.operation.endsWith('.session.create')).length, 0);
  assert.match(viewState.text(), /会话目录格式无效/);
});

test('面板重挂载优先恢复当前 Bot 记住的 sessionId，而不是盲选最新会话', async t => {
  installStorage(t, { [`${STORAGE_PREFIX}:ar-test:default`]: 'old-session' });
  const viewState = view(t, { listed: { sessions: [{ sessionId: 'newer-session' }, { sessionId: 'old-session' }] } });
  await viewState.settle();
  const snapshot = viewState.requests.find(row => row.operation.endsWith('.session.snapshot'));
  assert.equal(snapshot?.payload.sessionId, 'old-session');
  assert.equal(viewState.nodes().find(node => node.props['data-session-id'])?.props['data-session-id'], 'old-session');
});

test('已有会话指针但云端返回空目录时不自动造一个新会话', async t => {
  installStorage(t, { [`${STORAGE_PREFIX}:ar-test:default`]: 'lost-session' });
  const viewState = view(t, { listed: { sessions: [] } });
  await viewState.settle();
  assert.equal(viewState.requests.filter(row => row.operation.endsWith('.session.create')).length, 0);
  assert.match(viewState.text(), /历史会话暂时不可见/);
});

test('新会话只能由显式按钮创建，并在创建后打开返回的 sessionId', async t => {
  const viewState = view(t);
  await viewState.settle();
  const button = viewState.nodes().find(node => node.props['aria-label'] === '新建会话');
  assert.ok(button);
  button.props.onClick();
  await viewState.settle();
  assert.equal(viewState.requests.filter(row => row.operation.endsWith('.session.create')).length, 1);
  const snapshots = viewState.requests.filter(row => row.operation.endsWith('.session.snapshot'));
  assert.equal(snapshots.at(-1)?.payload.sessionId, 'new-session');
  assert.equal(viewState.nodes().find(node => node.props['data-session-id'])?.props['data-session-id'], 'new-session');
});
