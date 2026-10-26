import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantConversation } from '../src/client/conversation.mjs';

function conversation(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hooks = [], pendingEffects = [], requests = [], boxes = [], events = [];
  let cursor = 0, dirty = true, tree, ancestorScrolls = 0;
  const changed = (before, after) => !before || before.length !== after.length || after.some((value, i) => value !== before[i]);
  const R = {
    createElement(type, props, ...children) {
      if (props?.ref && !props.ref.current) {
        let scrollTop = 0;
        const box = { scrollHeight: 3200, clientHeight: 400,
          get scrollTop() { return scrollTop; }, set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
          scrollIntoView() { ancestorScrolls++; },
        };
        props.ref.current = box; boxes.push(box);
      }
      return { type, props: props || {}, children: children.flat() };
    },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ||= { current: initial }; },
    useCallback(callback, deps) { const i = cursor++; if (changed(hooks[i]?.deps, deps)) hooks[i] = { deps, callback }; return hooks[i].callback; },
    useEffect(effect, deps) { const i = cursor++; if (changed(hooks[i]?.deps, deps)) { const previous = hooks[i]; hooks[i] = { deps }; pendingEffects.push(() => { previous?.cleanup?.(); hooks[i].cleanup = effect(); }); } },
  };
  const request = async (operation, payload) => {
    requests.push({ operation, payload });
    if (operation.endsWith('.sessions.list')) return { sessions: [{ sessionId: 'layout-session' }] };
    if (operation.endsWith('.session.snapshot')) {
      if (options.failure) throw new Error('fixture cloud unavailable');
      if (options.pending) return new Promise(() => {});
      return { cursor: 0, messages: Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}`, role: 'assistant', text: '长历史消息'.repeat(40) })), turns: [] };
    }
    if (operation.endsWith('.session.events')) return { cursor: 1, events: events.splice(0), turns: [] };
    if (operation.endsWith('.turn.submit')) return { turnId: 'layout-turn' };
    return {};
  };
  const render = () => { cursor = 0; dirty = false; tree = PersonalAssistantConversation({ React: R, request }); for (const effect of pendingEffects.splice(0)) effect(); };
  const settle = async () => { for (let i = 0; i < 15; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } return tree; };
  const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  t.after(() => { for (const hook of hooks) hook?.cleanup?.(); });
  return { settle, requests, events, boxes, nodes: () => nodes(tree), ancestorScrolls: () => ancestorScrolls };
}

test('长历史只滚动消息区，不滚动宿主或输入框祖先', async t => {
  const view = conversation(t); await view.settle();
  assert.equal(view.ancestorScrolls(), 0, 'scrollIntoView 会滚动全部祖先，不能用于消息跟随');
  const nodes = view.nodes(), messages = nodes.find(node => node.props['data-personal-assistant-messages']);
  const composer = nodes.find(node => node.props['data-personal-assistant-composer']);
  assert.ok(messages && composer); assert.equal(messages.props.ref.current.scrollTop, 2800);
  assert.equal(messages.props.style.minHeight, 0); assert.equal(messages.props.style.overflowY, 'auto');
  assert.equal(composer.props.style.flex, '0 0 auto');
  assert.ok(!messages.children.includes(composer), '输入框不属于消息滚动区');
});

test('读历史时新事件不抢滚动位置，本人发送后回到消息底部且保留输入入口', async t => {
  const view = conversation(t); await view.settle();
  const messageNode = () => view.nodes().find(node => node.props['data-personal-assistant-messages']);
  const box = messageNode().props.ref.current; box.scrollTop = 120;
  messageNode().props.onScroll({ currentTarget: box });
  const field = view.nodes().find(node => node.type === 'textarea'); field.props.onChange({ target: { value: '正在编写的消息' } }); await view.settle();
  box.scrollHeight = 3600; view.events.push({ type: 'message', id: 'later', role: 'assistant', text: '新增回复', done: true });
  t.mock.timers.tick(200); await view.settle();
  assert.equal(box.scrollTop, 120);
  assert.equal(view.nodes().find(node => node.type === 'textarea').props.value, '正在编写的消息');
  view.nodes().find(node => node.props['aria-label'] === '发送消息').props.onClick(); await view.settle();
  assert.equal(box.scrollTop, 3200); assert.equal(view.ancestorScrolls(), 0);
  assert.ok(view.nodes().some(node => node.props['data-personal-assistant-composer']));
});

for (const options of [{ pending: true }, { failure: true }]) test(`云端${options.pending ? '连接中' : '连接失败'}时保留输入框与草稿，只禁止发送`, async t => {
  const view = conversation(t, options); await view.settle();
  assert.ok(view.nodes().some(node => node.props['data-personal-assistant-composer']));
  const field = view.nodes().find(node => node.type === 'textarea');
  field.props.onChange({ target: { value: '离线时继续写的草稿' } }); await view.settle();
  let prevented = false;
  view.nodes().find(node => node.type === 'textarea').props.onKeyDown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, false, '未连接时 Enter 仍可用于编写草稿，不触发发送');
  assert.equal(view.nodes().find(node => node.type === 'textarea').props.value, '离线时继续写的草稿');
  const send = view.nodes().find(node => node.props['aria-label'] === '发送消息');
  assert.equal(send.props.disabled, true); send.props.onClick(); await view.settle();
  assert.equal(view.requests.some(row => row.operation.endsWith('.turn.submit')), false);
});
