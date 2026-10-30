/**
 * 会话恢复与显式新建：避免面板重挂载或云端目录异常时静默换成空会话。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantConversation } from '../src/client/conversation.mjs';

const STORAGE_PREFIX = 'agentkit.personal-assistant.current-session.v1';

function view(t, { listed = { sessions: [{ sessionId: 'old-session', title: '旧会话' }] }, scope = { agentId: 'ar-test', botId: 'default' }, snapshot, freshScope = false } = {}) {
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
    if (operation.endsWith('.session.snapshot')) return snapshot ? snapshot(payload) : { ...listed, cursor: 0, messages: [], turns: [] };
    if (operation.endsWith('.session.events')) return { cursor: 0, events: [], turns: [] };
    return {};
  };
  const render = () => { cursor = 0; dirty = false; tree = PersonalAssistantConversation({ React: R, request, scope: freshScope ? { ...scope } : scope }); for (const effect of pendingEffects.splice(0)) effect(); };
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

test('会话目录出现重复 sessionId 时不猜选目标，也不创建新会话', async t => {
  const viewState = view(t, { listed: { sessions: [{ sessionId: 'same-session' }, { sessionId: 'same-session' }] } });
  await viewState.settle();
  assert.equal(viewState.requests.filter(row => row.operation.endsWith('.session.snapshot')).length, 0);
  assert.equal(viewState.requests.filter(row => row.operation.endsWith('.session.create')).length, 0);
  assert.match(viewState.text(), /会话目录包含无效会话/);
});

test('面板重挂载优先恢复当前 Bot 记住的 sessionId，而不是盲选最新会话', async t => {
  installStorage(t, { [`${STORAGE_PREFIX}:ar-test:default`]: 'old-session' });
  const viewState = view(t, { listed: { runtimeInstanceId: 'runtime-1', stateStorage: 'state-path', sessions: [{ sessionId: 'newer-session' }, { sessionId: 'old-session' }] } });
  await viewState.settle();
  const snapshot = viewState.requests.find(row => row.operation.endsWith('.session.snapshot'));
  assert.equal(snapshot?.payload.sessionId, 'old-session');
  const root = viewState.nodes().find(node => node.props['data-session-id']);
  assert.equal(root?.props['data-session-id'], 'old-session');
  assert.equal(root?.props['data-runtime-instance-id'], 'runtime-1');
  assert.equal(root?.props['data-state-storage'], 'state-path');
});

test('会话目录超过一个时显示选择器，并在切换后读取目标会话', async t => {
  const viewState = view(t, { listed: { sessions: [{ sessionId: 'latest-session', title: '最近会话' }, { sessionId: 'saved-session', title: '已保存会话' }] } });
  await viewState.settle();
  const selector = viewState.nodes().find(node => node.props['data-personal-assistant-session-selector'] === 'true');
  assert.ok(selector);
  assert.deepEqual(selector.children.map(option => option.children[0]), ['最近会话', '已保存会话']);
  selector.props.onChange({ target: { value: 'saved-session' } });
  await viewState.settle();
  const snapshots = viewState.requests.filter(row => row.operation.endsWith('.session.snapshot'));
  assert.equal(snapshots.at(-1)?.payload.sessionId, 'saved-session');
  assert.equal(viewState.nodes().find(node => node.props['data-session-id'])?.props['data-session-id'], 'saved-session');
});

test('已有会话指针但云端返回空目录时不自动造一个新会话', async t => {
  installStorage(t, { [`${STORAGE_PREFIX}:ar-test:default`]: 'lost-session' });
  const viewState = view(t, { listed: { sessions: [] } });
  await viewState.settle();
  assert.equal(viewState.requests.filter(row => row.operation.endsWith('.session.create')).length, 0);
  assert.match(viewState.text(), /历史会话暂时不可见/);
});

test('记住的会话从非空目录暂时消失时保持指针，不默默切换到其他会话', async t => {
  const values = installStorage(t, { [`${STORAGE_PREFIX}:ar-test:default`]: 'remembered-session' });
  const viewState = view(t, { listed: { sessions: [{ sessionId: 'another-session' }] } });
  await viewState.settle();
  assert.equal(viewState.requests.some(row => row.operation.endsWith('.session.snapshot')), false);
  assert.equal(viewState.requests.some(row => row.operation.endsWith('.session.create')), false);
  assert.equal(values.get(`${STORAGE_PREFIX}:ar-test:default`), 'remembered-session');
  assert.match(viewState.text(), /历史会话暂时不可见/);
});

test('快照返回 SESSION_NOT_FOUND 后重试空目录，仍不清空指针或自动新建', async t => {
  const key = `${STORAGE_PREFIX}:ar-test:default`;
  const values = installStorage(t, { [key]: 'old-session' });
  const listed = { sessions: [{ sessionId: 'old-session' }] };
  const viewState = view(t, { listed, snapshot: () => { throw Object.assign(new Error('当前助理不存在这个会话'), { code: 'SESSION_NOT_FOUND' }); } });
  await viewState.settle();
  assert.equal(values.get(key), 'old-session');
  listed.sessions = [];
  const retry = viewState.nodes().find(node => node.type === 'button' && node.children.includes('重试'));
  retry.props.onClick();
  await viewState.settle();
  assert.equal(viewState.requests.some(row => row.operation.endsWith('.session.create')), false);
  assert.match(viewState.text(), /历史会话暂时不可见/);
});

test('同一 Agent/Bot 的 scope 对象重新渲染时不反复 bootstrap 或换会话', async t => {
  installStorage(t);
  const viewState = view(t, { freshScope: true });
  await viewState.settle();
  assert.equal(viewState.requests.filter(row => row.operation.endsWith('.sessions.list')).length, 1);
  assert.equal(viewState.requests.filter(row => row.operation.endsWith('.session.snapshot')).length, 1);
  assert.equal(viewState.nodes().find(node => node.props['data-session-id'])?.props['data-session-id'], 'old-session');
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

test('会话快照格式异常时不伪装成空会话，也不创建新会话', async t => {
  const viewState = view(t, { snapshot: () => ({ cursor: 'not-a-number', messages: [], turns: [] }) });
  await viewState.settle();
  assert.equal(viewState.requests.filter(row => row.operation.endsWith('.session.create')).length, 0);
  assert.match(viewState.text(), /会话快照格式无效/);
});
