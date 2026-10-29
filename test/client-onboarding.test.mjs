/**
 * 未开通个人助理时的引导：配置接口失败也要给出开通/复用入口，
 * 而不是一句「暂时无法连接云端助理」把用户堵死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantPanel, setClientReactRuntime, unconfiguredGuidance } from '../src/client/index.mjs';

const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };
const fail = (status, code) => Object.assign(new Error(code), { status, code });

function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const saved = Object.fromEntries(['document', 'window', 'WebSocket', 'createImageBitmap', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new EventTarget(), window = new EventTarget(); document.hidden = false;
  class WebSocket { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } }
  class ResizeObserver { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} }
  Object.assign(globalThis, { document, window, WebSocket, ResizeObserver, requestAnimationFrame: callback => setTimeout(callback, 16), cancelAnimationFrame: clearTimeout, createImageBitmap: async () => ({ close() {} }) });
  const hooks = [], effects = [], requests = []; let cursor = 0, tree;
  const request = async (operation, payload) => {
    requests.push({ operation, payload });
    if (operation.endsWith('.configuration')) { if (options.configurationError) throw options.configurationError; return options.configuration ?? { configured: false }; }
    if (operation.endsWith('.desktop.status')) { if (options.statusError) throw options.statusError; return options.status ?? { configured: false, reason: 'needs-create', candidates: [] }; }
    if (operation.endsWith('.desktop.create') || operation.endsWith('.desktop.connect')) return { configured: true };
    return {};
  };
  const fakeReact = {
    createElement(type, props, ...children) {
      if (props?.ref && !props.ref.current) props.ref.current = { blur() {}, focus() {}, style: {}, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }), getContext: () => ({ clearRect() {}, drawImage() {} }) };
      return { type, props: props || {}, children: children.flat() };
    },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }]; },
    useEffect(effect) { const index = cursor++; if (!hooks[index]) { hooks[index] = {}; effects.push(() => { hooks[index].cleanup = effect(); }); } },
  };
  setClientReactRuntime(fakeReact);
  const render = () => { cursor = 0; tree = PersonalAssistantPanel({ request, variant: 'page' }); for (const effect of effects.splice(0)) effect(); return tree; };
  const all = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(all)] : [];
  const text = node => typeof node === 'string' ? node : (node?.children || []).map(text).join('');
  render();
  t.after(() => {
    for (const hook of hooks) hook?.cleanup?.();
    setClientReactRuntime(undefined);
    for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  return { requests, all: () => all(render()), text: () => text(render()), buttons: () => all(render()).filter(node => node.type === 'button').map(text) };
}

test('needs-create：配置接口失败也走开通引导，并回落到 desktop.status', async t => {
  const panel = harness(t, { configurationError: fail(403, 'PERSONAL_ASSISTANT_TICKET_REFUSED'), status: { configured: false, reason: 'needs-create', candidates: [] } });
  await flush();
  const nodes = panel.all();
  assert.ok(nodes.some(node => node.props?.['data-personal-assistant-onboarding'] === 'true'), '引导页已渲染');
  assert.match(panel.text(), /开通个人助理/);
  assert.doesNotMatch(panel.text(), /暂时无法连接云端助理/);
  assert.ok(panel.requests.some(call => call.operation.endsWith('.desktop.status')), '回落读取绑定快照');
});

test('已发现实例：只提供复用连接，不再引导创建', async t => {
  const panel = harness(t, { configurationError: fail(503, 'PERSONAL_ASSISTANT_STUDIO_UNAVAILABLE'), status: { configured: false, reason: 'needs-create', candidates: [{ agentId: 'ar-abc', name: '旧助理' }] } });
  await flush();
  assert.match(panel.text(), /发现已开通的个人助理/);
  assert.ok(panel.buttons().includes('连接已发现的个人助理'), '复用连接是唯一主操作');
  assert.ok(!panel.buttons().includes('开通个人助理'), '已有实例时不再给开通入口');
});

test('读不到状态：引导重新检查，创建降为二次确认，避免重复创建', async t => {
  const panel = harness(t, { configurationError: fail(401, 'PERSONAL_ASSISTANT_TICKET_REFUSED'), statusError: fail(503, 'PERSONAL_ASSISTANT_STUDIO_UNAVAILABLE') });
  await flush();
  assert.match(panel.text(), /暂时读不到开通状态/);
  assert.match(panel.text(), /检查开通状态/);
  assert.doesNotMatch(panel.text(), /暂时无法连接云端助理/);
});

test('guidance 文案与动作矩阵', () => {
  assert.equal(unconfiguredGuidance({ reason: 'needs-create' }).actions[0].id, 'create');
  assert.equal(unconfiguredGuidance({ candidates: [{ agentId: 'ar-1' }] }).actions[0].id, 'connect');
  assert.equal(unconfiguredGuidance({ reason: 'credential-unavailable' }).actions[0].id, 'connect');
  const unknown = unconfiguredGuidance({ reason: 'unavailable', detail: '网关不可达' });
  assert.equal(unknown.tone, 'retry');
  assert.ok(unknown.actions.some(action => action.id === 'create' && action.primary === false));
  assert.equal(unconfiguredGuidance(undefined).actions[0].id, 'check');
});
