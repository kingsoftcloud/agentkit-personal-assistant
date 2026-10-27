/**
 * 客户端排队的行为用例：助手思考中再发消息不能失败、不能丢。
 *
 * 用假 React 钩子驱动真实组件（与 conversation-layout.test.mjs 同一套最小运行时），
 * 断言全在「RPC 调用次数/参数」「渲染出来的节点」上，不碰真实网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantConversation } from '../src/client/conversation.mjs';

const busyError = () => Object.assign(new Error('session has an active turn'), { code: 'DSH_SESSION_BUSY', status: 409 });

function conversation(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hooks = [], pendingEffects = [], requests = [];
  let cursor = 0, dirty = true, tree;
  // 宿主侧状态：turns 决定"本轮是否还在进行"，submitError 用来模拟服务端 409。
  const state = { turns: [], submitError: null, submitted: [] };
  const changed = (before, after) => !before || before.length !== after.length || after.some((value, i) => value !== before[i]);
  const R = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() }; },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ||= { current: initial }; },
    useCallback(callback, deps) { const i = cursor++; if (changed(hooks[i]?.deps, deps)) hooks[i] = { deps, callback }; return hooks[i].callback; },
    useEffect(effect, deps) { const i = cursor++; if (changed(hooks[i]?.deps, deps)) { const previous = hooks[i]; hooks[i] = { deps }; pendingEffects.push(() => { previous?.cleanup?.(); hooks[i].cleanup = effect(); }); } },
  };
  const request = async (operation, payload) => {
    requests.push({ operation, payload });
    if (operation.endsWith('.sessions.list')) return { sessions: [{ sessionId: 'queue-session' }] };
    if (operation.endsWith('.session.snapshot')) return { cursor: 0, messages: options.history || [], turns: [] };
    if (operation.endsWith('.session.events')) return { cursor: requests.length, events: [], turns: state.turns };
    if (operation.endsWith('.turn.submit')) {
      if (state.submitError) { const error = state.submitError; state.submitError = null; throw error; }
      state.submitted.push(payload.text);
      return { turnId: `turn-${state.submitted.length}` };
    }
    if (operation.endsWith('.file.upload')) return { path: `/tmp/${payload.name}`, name: payload.name, mediaType: 'text/plain', bytes: 1 };
    return {};
  };
  const render = () => { cursor = 0; dirty = false; tree = PersonalAssistantConversation({ React: R, request }); for (const effect of pendingEffects.splice(0)) effect(); };
  const settle = async () => { for (let i = 0; i < 30; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } return tree; };
  const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  const all = () => nodes(tree);
  const byLabel = label => all().find(node => node.props['aria-label'] === label);
  const textOf = node => (Array.isArray(node.children) ? node.children : []).filter(child => typeof child === 'string');
  t.after(() => { for (const hook of hooks) hook?.cleanup?.(); });
  return {
    settle,
    requests,
    state,
    tick: async ms => { t.mock.timers.tick(ms); await settle(); },
    type: async value => { all().find(node => node.type === 'textarea').props.onChange({ target: { value } }); await settle(); },
    // Enter 与点击发送等价：测试里走点击，避免键盘事件的冒泡差异。
    // 队列非空时按钮文案会变成「发送消息（排队中 N 条）」，所以按前缀找。
    send: async () => { all().find(node => String(node.props['aria-label'] || '').startsWith('发送消息'))?.props.onClick?.(); await settle(); },
    setDraft: async value => { all().find(node => node.type === 'textarea').props.onChange({ target: { value } }); await settle(); },
    draft: () => all().find(node => node.type === 'textarea').props.value,
    placeholder: () => all().find(node => node.type === 'textarea').props.placeholder,
    sendButton: () => all().find(node => String(node.props['aria-label'] || '').startsWith('发送消息')),
    queued: () => all().filter(node => String(node.props['aria-label'] || '').startsWith('撤回排队消息')),
    queuedTexts: () => all().filter(node => String(node.props['aria-label'] || '').startsWith('撤回排队消息')).length,
    hasText: fragment => all().some(node => textOf(node).some(value => String(value).includes(fragment))),
    setTurns: turns => { state.turns = turns; },
    failNextSubmit: () => { state.submitError = busyError(); },
    submits: () => requests.filter(row => row.operation.endsWith('.turn.submit')),
    submitted: () => state.submitted,
  };
}

/** 让组件进入 ready，并把「助理正在思考」这一轮开起来。 */
async function thinking(view) {
  view.setTurns([{ turnId: 'turn-0', status: 'running' }]);
  await view.tick(200);
  await view.tick(600);
}

async function endTurn(view) {
  view.setTurns([]);
  await view.tick(600);
  await view.tick(400);
}

test('思考中再发消息只入队，不打 turn.submit、不报 DSH_SESSION_BUSY', async t => {
  const view = conversation(t);
  await view.settle();
  await view.setDraft('第一条');
  await view.send();
  assert.deepEqual(view.submitted(), ['第一条']);
  await thinking(view);
  assert.match(view.placeholder(), /本轮进行中/);

  await view.setDraft('第二条');
  await view.send();
  assert.deepEqual(view.submitted(), ['第一条'], '忙碌时不能直接提交');
  assert.equal(view.submits().length, 1);
  assert.ok(view.hasText('已排队，本轮结束后发送'));
  assert.match(view.sendButton().props['aria-label'], /排队中 1 条/);
  assert.ok(!view.hasText('DSH_SESSION_BUSY'), '排队路径不能让用户看到服务端 409');
  assert.equal(view.draft(), '', '入队后清空输入框，内容转到排队气泡里');
});

test('本轮结束后自动发出队首，连续多条按顺序串行发出', async t => {
  const view = conversation(t);
  await view.settle();
  await view.setDraft('第一条');
  await view.send();
  await thinking(view);

  await view.setDraft('第二条');
  await view.send();
  await view.setDraft('第三条');
  await view.send();
  await view.setDraft('第四条');
  await view.send();
  assert.deepEqual(view.submitted(), ['第一条']);
  assert.equal(view.queuedTexts(), 3);

  await endTurn(view);
  assert.deepEqual(view.submitted(), ['第一条', '第二条'], '一轮只发队首一条');
  assert.equal(view.queuedTexts(), 2);

  await endTurn(view);
  assert.deepEqual(view.submitted(), ['第一条', '第二条', '第三条']);
  assert.equal(view.queuedTexts(), 1);

  await endTurn(view);
  assert.deepEqual(view.submitted(), ['第一条', '第二条', '第三条', '第四条']);
  assert.equal(view.queuedTexts(), 0);
  assert.equal(view.sendButton().props['aria-label'], '发送消息');
});

test('排队消息可逐条撤回，撤回后不会再被发出', async t => {
  const view = conversation(t);
  await view.settle();
  await view.setDraft('第一条');
  await view.send();
  await thinking(view);
  await view.setDraft('要撤回的甲');
  await view.send();
  await view.setDraft('要撤回的乙');
  await view.send();
  assert.equal(view.queuedTexts(), 2);

  view.queued()[0].props.onClick();
  await view.settle();
  assert.equal(view.queuedTexts(), 1);
  assert.ok(!view.hasText('要撤回的甲'));

  await endTurn(view);
  assert.deepEqual(view.submitted(), ['第一条', '要撤回的乙']);
  assert.equal(view.queuedTexts(), 0);
});

test('客户端误判空闲时服务端 409 不丢消息：回到队首退避重发', async t => {
  const view = conversation(t);
  await view.settle();
  await view.setDraft('第一条');
  await view.send();
  await thinking(view);
  await view.setDraft('兜底重试的消息');
  await view.send();
  assert.equal(view.queuedTexts(), 1);

  view.setTurns([]);
  await view.tick(600);
  view.failNextSubmit();
  await view.tick(400);
  assert.deepEqual(view.submitted(), ['第一条'], '409 不能变成发送失败');
  assert.equal(view.queuedTexts(), 1, '消息仍在队列里');
  assert.ok(!view.hasText('重试发送'), '不能在列表里留下失败气泡');
  assert.ok(view.hasText('仍在处理上一轮'));

  await view.tick(1500);
  assert.deepEqual(view.submitted(), ['第一条', '兜底重试的消息']);
  assert.equal(view.queuedTexts(), 0);
});

test('空闲直发撞上 409 时自动转为排队重试，不把消息判失败', async t => {
  const view = conversation(t);
  await view.settle();
  await view.setDraft('抢跑的消息');
  view.failNextSubmit();
  await view.send();
  assert.deepEqual(view.submitted(), []);
  assert.equal(view.queuedTexts(), 1);
  assert.equal(view.draft(), '', '内容已转到排队气泡，不重复占着输入框');
  assert.ok(view.hasText('仍在处理上一轮'));

  await view.tick(1500);
  assert.deepEqual(view.submitted(), ['抢跑的消息']);
  assert.equal(view.queuedTexts(), 0);
});

test('队列非空时拦截一次刷新（队列只在内存里，不落盘）', async t => {
  const listeners = new Set();
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener: (name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });

  const view = conversation(t);
  await view.settle();
  await view.setDraft('第一条');
  await view.send();
  await thinking(view);
  await view.setDraft('刷新前排队');
  await view.send();
  assert.equal(listeners.size, 1, '有排队消息时注册 beforeunload');

  let prevented = false;
  for (const listener of listeners) listener({ preventDefault() { prevented = true; }, returnValue: '' });
  assert.equal(prevented, true);

  view.queued()[0].props.onClick();
  await view.settle();
  assert.equal(listeners.size, 0, '队列清空后撤掉刷新拦截');
});

test('同会话重建（cursor 失效）不清空排队，跨会话才丢弃', async t => {
  const view = conversation(t);
  await view.settle();
  await view.setDraft('第一条');
  await view.send();
  await thinking(view);
  await view.setDraft('队首消息');
  await view.send();
  assert.equal(view.queuedTexts(), 1);
  // cursor 失效只会以同一个 sessionId 重新 openSession，队列必须保留下来继续等本轮结束。
  await view.tick(600);
  assert.equal(view.queuedTexts(), 1);
});
