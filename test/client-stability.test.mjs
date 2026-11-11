/**
 * 交互稳定性验收：视图切换/重挂载不白屏、不报错、不堆积轮询与定时器；
 * RPC 失败可降级并在重试后恢复；重开面板首屏用缓存回显（stale-while-revalidate）。
 *
 * 说明：这里用「真实组件 + 假 React / 假 WS / 计数定时器」跑真实 effect，
 * 断言的是「卸载后还有没有活跃定时器、有没有新请求」，不是函数是否存在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantPanel, PersonalAssistantShell, PERSONAL_ASSISTANT_CONFIGURATION_EVENT, setClientReactRuntime, localBuildLabel } from '../src/client/index.mjs';
import { PersonalAssistantConversation } from '../src/client/conversation.mjs';

/* ----------------------------- 夹具 ----------------------------- */

function fakeReact() {
  let cursor = 0, tree = null, dirty = false;
  const hooks = [];
  const pending = [];
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((value, index) => value !== before[index]);
  const element = (type, props, ...children) => {
    const next = props || {};
    if (next.ref && !next.ref.current) {
      next.ref.current = {
        blur() {}, focus() {}, style: {}, appendChild() {}, removeChild() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
        getContext: () => ({ clearRect() {}, drawImage() {} }),
        setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
      };
    }
    return { type, props: next, children: children.flat() };
  };
  const R = {
    createElement: element,
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; dirty = true; }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!hooks[index] || changed(hooks[index].deps, deps)) hooks[index] = { deps, callback };
      return hooks[index].callback;
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!hooks[index] || changed(hooks[index].deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const slot = hooks[index];
      if (slot && !changed(slot.deps, deps)) return;
      hooks[index] = { deps, cleanup: null };
      pending.push(() => {
        if (typeof slot?.cleanup === 'function') slot.cleanup();
        const cleanup = effect();
        hooks[index].cleanup = typeof cleanup === 'function' ? cleanup : null;
      });
    },
  };
  R.useLayoutEffect = R.useEffect;
  return {
    R,
    /** 渲染一次并执行本轮新注册的 effect。 */
    render(component, props) {
      cursor = 0; dirty = false;
      tree = component({ React: R, ...props });
      for (const run of pending.splice(0)) run();
      return tree;
    },
    get dirty() { return dirty; },
    /** 反复「渲染 → flush 微任务」直到状态稳定。 */
    async settle(component, props, rounds = 16) {
      for (let round = 0; round < rounds; round += 1) {
        if (dirty || round === 0 || !tree) this.render(component, props);
        else this.render(component, props);
        await new Promise(resolve => setImmediate(resolve));
      }
      this.render(component, props);
      return tree;
    },
    /** 执行全部 effect cleanup（等价组件卸载）。 */
    unmount() {
      for (const slot of hooks) {
        if (slot && typeof slot.cleanup === 'function') { const cleanup = slot.cleanup; slot.cleanup = null; cleanup(); }
      }
    },
    nodes() { return nodesOf(tree); },
    text() { return textOf(tree); },
    find(predicate) { return nodesOf(tree).find(predicate); },
  };
}

const nodesOf = node => {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(node.children || []).flatMap(nodesOf)];
};
const textOf = node => {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  return (node.children || []).map(textOf).join(' ');
};
const buttonsWith = (view, label) => view.nodes().filter(node => node.type === 'button' && textOf(node).includes(label));

/** 统计活跃的 setTimeout/setInterval：卸载后必须归零。 */
function trackTimers(t) {
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const active = new Map();
  let seq = 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const id = ++seq;
    active.set(id, saved.setTimeout(() => { active.delete(id); callback(...args); }, delay));
    return id;
  };
  globalThis.clearTimeout = id => {
    if (!active.has(id)) return;
    saved.clearTimeout(active.get(id));
    active.delete(id);
  };
  globalThis.setInterval = (callback, delay, ...args) => {
    const id = ++seq;
    active.set(id, saved.setInterval(callback, delay, ...args));
    return id;
  };
  globalThis.clearInterval = id => {
    if (!active.has(id)) return;
    saved.clearInterval(active.get(id));
    active.delete(id);
  };
  t.after(() => {
    for (const handle of active.values()) { try { saved.clearInterval(handle); saved.clearTimeout(handle); } catch { /* 忽略 */ } }
    active.clear();
    Object.assign(globalThis, saved);
  });
  return { activeCount: () => active.size };
}

function spyConsole(t) {
  const messages = [];
  const original = console.error;
  console.error = (...args) => { messages.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  return messages;
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  key(type, options) { const capture = typeof options === 'boolean' ? options : Boolean(options?.capture); return `${type}:${capture}`; }
  addEventListener(type, listener, options = {}) {
    if (typeof listener !== 'function') return;
    const key = this.key(type, options);
    const list = this.listeners.get(key) || [];
    if (!list.includes(listener)) list.push(listener);
    this.listeners.set(key, list);
  }
  removeEventListener(type, listener, options = {}) {
    const list = this.listeners.get(this.key(type, options));
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }
  listenerCount(type) {
    let total = 0;
    for (const [key, list] of this.listeners) if (key.startsWith(`${type}:`)) total += list.length;
    return total;
  }
  /** 测试里模拟 window blur / document visibilitychange：按注册顺序派发给所有监听器。 */
  dispatchEvent(event) {
    const type = typeof event === 'string' ? event : event.type;
    for (const [key, list] of this.listeners) {
      if (!key.startsWith(`${type}:`)) continue;
      for (const listener of [...list]) listener(event);
    }
    return true;
  }
}

/** 面板需要的浏览器外壳：document/window/WebSocket；不提供 ResizeObserver（可选依赖）。 */
function installPanelDom(t) {
  const saved = Object.fromEntries(['document', 'window', 'WebSocket', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  // Node 原生 EventTarget 对 capture=true 的 removeEventListener 不生效（浏览器正常），
  // 用自实现的事件目标，才能真实校验「卸载后监听器归零」。
  const document = new FakeEventTarget(); document.hidden = false;
  const windowObj = new FakeEventTarget();
  class FakeSocket {
    static instances = [];
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; this.closed = false; this.closeCalls = [];
      FakeSocket.instances.push(this);
    }
    send(data) { this.sent.push(data); return true; }
    close(code, reason) { this.closed = true; this.closeCalls.push({ code, reason }); this.readyState = 3; }
  }
  Object.assign(globalThis, {
    document, window: windowObj, WebSocket: FakeSocket,
    requestAnimationFrame: callback => { callback(0); return 1; }, cancelAnimationFrame: () => {},
  });
  delete globalThis.ResizeObserver;
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { document, window: windowObj, FakeSocket };
}

const panelRequest = ({ ticketFailure = 0 } = {}) => {
  let tickets = 0;
  const requests = [];
  const request = async operation => {
    requests.push(operation);
    if (operation.endsWith('.configuration')) return { configured: true, agentId: 'ar-test', botId: 'writer' };
    if (operation.endsWith('.bots.list')) return { directoryAvailable: true, primaryBotId: 'writer', bots: [{ botId: 'writer', displayName: '写作助理' }] };
    if (operation.endsWith('.desktop.ticket')) {
      tickets += 1;
      if (tickets <= ticketFailure) throw Object.assign(new Error('ticket unavailable'), { code: 'PERSONAL_ASSISTANT_TICKET_FAILED', status: 502 });
      return { wsUrl: 'wss://gw.example/personal-assistant/desktop/ws', ticket: `ticket-${tickets}`, readOnly: false };
    }
    return {};
  };
  return { request, requests, ticketCount: () => tickets };
};

/* ----------------------------- 用例 ----------------------------- */

test('会话页连续挂载/卸载 20 次：每次卸载监听归零，之后不再发起 session.events', async t => {
  const sessionValues = new Map();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: {
      getItem: key => (sessionValues.has(key) ? sessionValues.get(key) : null),
      setItem: (key, value) => sessionValues.set(key, String(value)),
      removeItem: key => sessionValues.delete(key),
    },
  });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  });
  const timers = trackTimers(t);
  const errors = spyConsole(t);
  const requests = [];
  const request = async operation => {
    requests.push(operation);
    if (operation.endsWith('.sessions.list')) return { sessions: [{ sessionId: 'session-1', title: '历史会话' }] };
    if (operation.endsWith('.session.snapshot')) return { cursor: 0, messages: [], turns: [] };
    if (operation.endsWith('.session.events')) return { cursor: 0, events: [], turns: [] };
    return {};
  };

  for (let cycle = 1; cycle <= 20; cycle += 1) {
    const view = fakeReact();
    await view.settle(PersonalAssistantConversation, { request, scope: { agentId: 'ar-test', botId: 'writer' } });
    assert.ok(view.nodes().length > 3, `第 ${cycle} 次挂载应有可读内容，不能白屏`);
    assert.equal(errors.length, 0, `第 ${cycle} 次挂载出现控制台错误：${errors.join('\n')}`);
    assert.ok(timers.activeCount() > 0, `第 ${cycle} 次挂载应启动会话轮询（否则用例没有覆盖到轮询）`);
    view.unmount();
    assert.equal(timers.activeCount(), 0, `第 ${cycle} 次卸载后仍有活跃定时器/轮询`);
  }

  const eventsBefore = requests.filter(operation => operation.endsWith('.session.events')).length;
  await new Promise(resolve => setTimeout(resolve, 260));
  const eventsAfter = requests.filter(operation => operation.endsWith('.session.events')).length;
  assert.equal(eventsAfter, eventsBefore, '组件已卸载，不能再继续轮询 session.events');
  assert.equal(errors.length, 0);
});

test('云电脑面板连续连接并卸载 20 次：每次 socket 关闭、定时器归零、无控制台错误', async t => {
  const dom = installPanelDom(t);
  const timers = trackTimers(t);
  const errors = spyConsole(t);
  const fake = panelRequest();

  for (let cycle = 1; cycle <= 20; cycle += 1) {
    const view = fakeReact();
    setClientReactRuntime(view.R);
    await view.settle(PersonalAssistantPanel, { request: fake.request, variant: 'page' });
    assert.ok(view.nodes().length > 3, `第 ${cycle} 次挂载应有可读内容`);
    const connect = buttonsWith(view, '连接云电脑')[0];
    assert.ok(connect, `第 ${cycle} 次挂载应能点「连接云电脑」（phase=${view.find(node => node.props?.['data-panel-view']) ? 'panel' : '?'}）`);
    connect.props.onClick();
    await view.settle(PersonalAssistantPanel, { request: fake.request, variant: 'page' });

    assert.equal(dom.FakeSocket.instances.length, cycle, '每次连接只建立一条云桌面 WS');
    const socket = dom.FakeSocket.instances.at(-1);
    socket.readyState = 1;
    socket.onopen?.();
    await view.settle(PersonalAssistantPanel, { request: fake.request, variant: 'page' });
    assert.ok(socket.sent.some(message => String(message).includes('"type":"open"')), 'socket 打开后要发 open');

    view.unmount();
    assert.equal(socket.closed, true, `第 ${cycle} 次卸载必须关闭云桌面 WS`);
    assert.deepEqual(socket.closeCalls[0]?.code, 1000);
    assert.equal(timers.activeCount(), 0, `第 ${cycle} 次卸载后仍有活跃定时器`);
    assert.equal(dom.document.listenerCount('pointerdown'), 0, `第 ${cycle} 次卸载后 pointerdown 监听器未移除`);
    assert.equal(dom.document.listenerCount('visibilitychange'), 0, `第 ${cycle} 次卸载后 visibilitychange 监听器未移除`);
    assert.equal(errors.length, 0, `第 ${cycle} 次连接出现控制台错误：${errors.join('\n')}`);
    setClientReactRuntime(undefined);
  }
  assert.equal(dom.FakeSocket.instances.length, 20);
  assert.equal(fake.ticketCount(), 20, '重开面板不能重复申请多余 ticket');
});

test('RPC 失败可降级恢复：desktop.ticket 首次失败后仍显示可操作界面，重试可进入就绪', async t => {
  const dom = installPanelDom(t);
  const errors = spyConsole(t);
  const fake = panelRequest({ ticketFailure: 1 });
  const view = fakeReact();
  setClientReactRuntime(view.R);
  t.after(() => setClientReactRuntime(undefined));

  await view.settle(PersonalAssistantPanel, { request: fake.request, variant: 'page' });
  const first = buttonsWith(view, '连接云电脑')[0];
  first.props.onClick();
  await view.settle(PersonalAssistantPanel, { request: fake.request, variant: 'page' });
  assert.equal(fake.ticketCount(), 1);
  assert.equal(dom.FakeSocket.instances.length, 0, 'ticket 失败不能留下半条连接');
  assert.ok(view.nodes().length > 3, '失败后界面仍在，不能白屏');
  assert.ok(buttonsWith(view, '连接云电脑').length >= 1, '失败后要保留可重试入口');

  buttonsWith(view, '连接云电脑')[0].props.onClick();
  await view.settle(PersonalAssistantPanel, { request: fake.request, variant: 'page' });
  assert.equal(fake.ticketCount(), 2);
  assert.equal(dom.FakeSocket.instances.length, 1, '重试成功后建立连接');
  view.unmount();
  assert.equal(dom.FakeSocket.instances[0].closed, true);
  assert.equal(errors.length, 0, `降级恢复不应产生控制台错误：${errors.join('\n')}`);
});

test('外壳视图连续切换 20 轮（列表↔详情↔设置↔本机授权）：每步有内容、无报错、卸载后定时器归零', async t => {
  const shellStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (shellStorage) Object.defineProperty(globalThis, 'localStorage', shellStorage);
    else delete globalThis.localStorage;
  });
  const timers = trackTimers(t);
  const errors = spyConsole(t);
  const requests = [];
  const request = async operation => {
    requests.push(operation);
    if (operation.endsWith('.configuration')) return { configured: true, agentId: 'ar-test', botId: 'writer' };
    if (operation.endsWith('.local-access.status')) return { connected: true, authorized: true, scopes: [], riskConfirm: true, grantedAt: '2026-01-01T00:00:00Z', host: { name: 'studio' } };
    if (operation.endsWith('.bots.list')) return { directoryAvailable: true, primaryBotId: 'writer', bots: [{ botId: 'writer', displayName: '写作助理' }] };
    if (operation.endsWith('.bots.overview')) throw new Error('overview unavailable');
    if (operation.endsWith('.bot.detail')) throw new Error('detail unavailable');
    if (operation.endsWith('.settings.inspect')) throw new Error('settings unavailable');
    return {};
  };
  const view = fakeReact();
  setClientReactRuntime(view.R);
  t.after(() => setClientReactRuntime(undefined));
  const mountShell = () => view.settle(PersonalAssistantShell, { request, initialBotId: 'writer' });
  await mountShell();
  assert.ok(view.text().includes('写作助理'), '列表视图要有 Bot 名称');
  assert.equal(view.find(node => node.props?.['data-pa-diagnostics'] === 'true'), undefined, '主面板不应固定占用诊断页脚');
  const viewOf = () => view.find(node => node.props?.['data-panel-view'])?.props['data-panel-view'];

  for (let cycle = 1; cycle <= 20; cycle += 1) {
    // 列表 → 设置 → 列表
    buttonsWith(view, '设置')[0].props.onClick();
    await mountShell();
    assert.equal(viewOf(), 'settings', `第 ${cycle} 轮设置页`);
    assert.ok(view.nodes().length > 3);

    view.find(node => node.props?.['aria-label'] === '返回').props.onClick();
    await mountShell();
    assert.equal(viewOf(), 'list', `第 ${cycle} 轮返回列表`);

    // 列表 → 详情 → 列表：单 Bot 时列表是主卡片，点「能力」进入详情
    view.find(node => node.props?.['data-pa-stat'] === '能力').props.onClick({ preventDefault() {} });
    await mountShell();
    assert.equal(viewOf(), 'detail', `第 ${cycle} 轮详情页`);
    assert.ok(view.nodes().length > 3);

    view.find(node => node.props?.['aria-label'] === '返回').props.onClick();
    await mountShell();
    assert.equal(viewOf(), 'list', `第 ${cycle} 轮详情返回列表`);

    // 本机授权弹层开/关
    view.find(node => node.props?.['data-connection-dot']).props.onClick();
    await mountShell();
    assert.equal(view.find(node => node.props?.['data-local-access-popover'] === 'open')?.props?.['aria-label'], '本机授权');
    view.find(node => node.props?.['aria-label'] === '关闭本机授权弹层').props.onClick();
    await mountShell();
    assert.equal(view.find(node => node.props?.['data-local-access-popover'] === 'open'), undefined);

    assert.equal(errors.length, 0, `第 ${cycle} 轮切换出现控制台错误：${errors.join('\n')}`);
  }
  view.unmount();
  assert.equal(timers.activeCount(), 0, '卸载后不能残留定时器');
  assert.equal(errors.length, 0);
});

test('从 Bot 详情打开云电脑时把自动连接和嵌入模式传给桌面页', async t => {
  const dom = installPanelDom(t);
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  t.after(() => {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
  });
  const requests = [];
  const request = async operation => {
    requests.push(operation);
    if (operation.endsWith('.configuration')) return { configured: true, agentId: 'ar-detail', botId: 'writer' };
    if (operation.endsWith('.local-access.status')) return { connected: true, authorized: true, scopes: [], riskConfirm: true, grantedAt: null };
    if (operation.endsWith('.bots.list')) return { directoryAvailable: true, primaryBotId: 'writer', bots: [{ botId: 'writer', displayName: '写作助理' }] };
    if (operation.endsWith('.bots.overview')) return { bots: [{ id: 'writer', name: '写作助理', role: 'primary', status: 'running', computer: 'connected' }], active: [], recent: [], counts: null };
    if (operation.endsWith('.bot.detail')) return { bot: { id: 'writer', name: '写作助理', role: 'primary', status: 'running' }, memory: { count: 0, items: [] }, capabilities: [], computer: { connected: true, resolution: '1280×800' } };
    if (operation.endsWith('.desktop.ticket')) return { wsUrl: 'wss://gw.example/personal-assistant/desktop/ws', ticket: 'ticket-detail', readOnly: false };
    return {};
  };
  const view = fakeReact();
  setClientReactRuntime(view.R);
  t.after(() => setClientReactRuntime(undefined));
  t.after(() => view.unmount());
  const mount = () => view.settle(PersonalAssistantShell, { request, initialBotId: 'writer' });

  await mount();
  view.find(node => node.props?.['data-pa-stat'] === '能力').props.onClick({ preventDefault() {} });
  await mount();
  assert.ok(buttonsWith(view, '打开云电脑')[0], 'Bot 详情必须提供云电脑入口');
  buttonsWith(view, '打开云电脑')[0].props.onClick();
  await mount();

  assert.equal(view.find(node => node.props?.['data-panel-view'])?.props['data-panel-view'], 'desktop');
  const panel = view.find(node => node.type === PersonalAssistantPanel);
  assert.equal(panel?.props.connectOnMount, true, '外壳进入桌面页时必须要求自动连接');
  assert.equal(panel?.props.embedded, true, '外壳进入桌面页时必须隐藏重复 chrome');
  assert.match(view.text(), /云电脑/u);
  view.unmount();
  assert.equal(dom.FakeSocket.instances.length, 0, '假 React 不递归执行子组件 effect，本用例只校验外壳传参');
});

test('嵌入式云电脑页自动申请 ticket 且只渲染桌面内容', async t => {
  const dom = installPanelDom(t);
  const fake = panelRequest();
  const view = fakeReact();
  setClientReactRuntime(view.R);
  t.after(() => setClientReactRuntime(undefined));
  t.after(() => view.unmount());

  await view.settle(PersonalAssistantPanel, { request: fake.request, variant: 'page', connectOnMount: true, embedded: true });
  assert.equal(fake.ticketCount(), 1, '嵌入式桌面页应在挂载后立即申请 ticket');
  assert.equal(view.nodes().filter(node => node.type === 'details').length, 0, '嵌入式桌面页不能再渲染诊断页脚');
  view.unmount();
  assert.equal(dom.FakeSocket.instances.length, 1);
});

test('全局设置连接完成后，已挂载外壳同步配置并绑定云电脑工作面板', async t => {
  const dom = installPanelDom(t);
  const errors = spyConsole(t);
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, length: 0, key: () => null },
  });
  t.after(() => {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
  });
  let configured = false;
  const bindings = [];
  const request = async operation => {
    if (operation.endsWith('.configuration')) return configured ? { configured: true, agentId: 'ar-settings', botId: 'writer' } : { configured: false };
    if (operation.endsWith('.desktop.status')) return { configured: false, reason: 'needs-create', candidates: [] };
    if (operation.endsWith('.local-access.status')) return { connected: true, authorized: false, scopes: [], riskConfirm: true, grantedAt: null };
    if (operation.endsWith('.bots.list')) return { directoryAvailable: true, primaryBotId: 'writer', bots: [{ botId: 'writer', displayName: '写作助理' }] };
    if (operation.endsWith('.bots.overview')) return { bots: [{ id: 'writer', name: '写作助理', role: 'primary', status: 'idle', computer: 'connected' }], active: [], recent: [], counts: null };
    return {};
  };
  const nativeWorkbench = { available: true, bind(scope) { bindings.push(scope); }, open() {} };
  const view = fakeReact();
  setClientReactRuntime(view.R);
  t.after(() => setClientReactRuntime(undefined));
  await view.settle(PersonalAssistantShell, { request, nativeWorkbench });
  assert.match(view.text(), /开通个人助理/u);

  configured = true;
  dom.window.dispatchEvent({ type: PERSONAL_ASSISTANT_CONFIGURATION_EVENT, detail: { configured: true, agentId: 'ar-settings' } });
  await view.settle(PersonalAssistantShell, { request, nativeWorkbench });
  assert.match(view.text(), /写作助理/u);
  assert.deepEqual(bindings.at(-1), { agentId: 'ar-settings', botId: 'writer' });
  view.unmount();
  assert.equal(dom.window.listenerCount(PERSONAL_ASSISTANT_CONFIGURATION_EVENT), 0);
  assert.equal(errors.length, 0, errors.join('\n'));
});

test('创建请求未返回时也要持续轮询进度并推进已用时', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  let creating = false;
  let resolveCreate;
  const createPending = new Promise(resolve => { resolveCreate = resolve; });
  const requests = [];
  const request = async operation => {
    requests.push(operation);
    if (operation.endsWith('.configuration')) return { configured: false };
    if (operation.endsWith('.local-access.status')) return { connected: false, authorized: false };
    if (operation.endsWith('.desktop.status')) return { configured: false, reason: 'needs-create', candidates: [] };
    if (operation.endsWith('.desktop.create')) { creating = true; return createPending; }
    if (operation.endsWith('.create.status')) return creating
      ? {
        stage: 'instance', elapsedMs: 0,
        stages: [{ id: 'instance', status: 'active', detail: '正在创建云端实例' }],
        estimatedRemainingMs: 148_000,
      }
      : { stage: 'instance', stages: [{ id: 'instance', status: 'pending', detail: '' }], elapsedMs: 0, estimatedRemainingMs: 0 };
    return {};
  };
  const view = fakeReact();
  setClientReactRuntime(view.R);
  t.after(() => setClientReactRuntime(undefined));

  await view.settle(PersonalAssistantShell, { request });
  const create = buttonsWith(view, '开通个人助理')[0];
  assert.ok(create, '未开通页面应提供开通按钮');
  create.props.onClick();
  await view.settle(PersonalAssistantShell, { request });
  assert.match(view.text(), /正在为你准备个人助理/u);

  t.mock.timers.tick(1_000);
  await view.settle(PersonalAssistantShell, { request });
  assert.ok(requests.some(operation => operation.endsWith('.create.status')), '创建请求未返回时也要读取 create.status');
  assert.match(view.text(), /已用时 00:01/u, 'Host 未返回已用时时，进度页也应按本地起点推进计时');

  resolveCreate({ configured: true, agentId: 'ar-created' });
  await view.settle(PersonalAssistantShell, { request });
  view.unmount();
});

test('重新挂载个人助理页时恢复进行中的创建状态，而不是回到开通引导', async t => {
  let creating = true;
  const requests = [];
  const request = async operation => {
    requests.push(operation);
    if (operation.endsWith('.configuration')) return { configured: false };
    if (operation.endsWith('.local-access.status')) return { connected: false, authorized: false };
    if (operation.endsWith('.desktop.status')) return { configured: false, reason: 'needs-create', candidates: [] };
    if (operation.endsWith('.create.status')) return creating
      ? { stage: 'instance', elapsedMs: 4_000, stages: [{ id: 'instance', status: 'active', detail: '正在创建云端实例' }], estimatedRemainingMs: 146_000 }
      : { stage: 'done', instanceId: 'ar-created', stages: [{ id: 'instance', status: 'done', detail: '已完成' }], elapsedMs: 5_000, estimatedRemainingMs: 0 };
    if (operation.endsWith('.desktop.create')) return { configured: true, agentId: 'ar-created' };
    return {};
  };
  const first = fakeReact();
  setClientReactRuntime(first.R);
  t.after(() => setClientReactRuntime(undefined));
  await first.settle(PersonalAssistantShell, { request });
  first.unmount();

  const reopened = fakeReact();
  setClientReactRuntime(reopened.R);
  await reopened.settle(PersonalAssistantShell, { request });
  assert.ok(requests.some(operation => operation.endsWith('.create.status')), '重新挂载时应恢复读取创建状态');
  assert.match(reopened.text(), /正在为你准备个人助理/u, '进行中创建不能回到开通引导');
  assert.doesNotMatch(reopened.text(), /开通个人助理.*检查开通状态/u);
  creating = false;
  reopened.unmount();
});

test('进度读取暂时没有响应时，开通计时仍继续', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  let creating = false;
  const pending = new Promise(() => {});
  const request = async operation => {
    if (operation.endsWith('.configuration')) return { configured: false };
    if (operation.endsWith('.desktop.status')) return { configured: false, reason: 'needs-create' };
    if (operation.endsWith('.desktop.create')) { creating = true; return pending; }
    if (operation.endsWith('.create.status') && creating) return pending;
    return {};
  };
  const view = fakeReact();
  setClientReactRuntime(view.R);
  t.after(() => setClientReactRuntime(undefined));
  await view.settle(PersonalAssistantShell, { request });
  buttonsWith(view, '开通个人助理')[0].props.onClick();
  await view.settle(PersonalAssistantShell, { request });
  t.mock.timers.tick(3_000);
  await view.settle(PersonalAssistantShell, { request });
  assert.match(view.text(), /已用时 00:03/u);
  view.unmount();
});

test('重试不会被上次的失败状态打断，当前开通返回成功后退出进度页', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  let configured = false;
  let resolve;
  const create = new Promise(done => { resolve = done; });
  const request = async operation => {
    if (operation.endsWith('.configuration')) return { configured, agentId: 'ar-current' };
    if (operation.endsWith('.desktop.create')) return create;
    if (operation.endsWith('.create.status')) return { stage: 'failed', error: '上次开通失败', elapsedMs: 10_000 };
    if (operation.endsWith('.bots.list')) return { directoryAvailable: true, bots: [] };
    return {};
  };
  const view = fakeReact();
  setClientReactRuntime(view.R);
  t.after(() => setClientReactRuntime(undefined));
  await view.settle(PersonalAssistantShell, { request });
  buttonsWith(view, '重试')[0].props.onClick();
  await view.settle(PersonalAssistantShell, { request });
  t.mock.timers.tick(2_000);
  await view.settle(PersonalAssistantShell, { request });
  assert.match(view.text(), /已用时 00:02/u, '旧失败不能盖住当前的计时');
  configured = true;
  resolve({ configured: true, agentId: 'ar-current' });
  await view.settle(PersonalAssistantShell, { request });
  assert.doesNotMatch(view.text(), /创建个人助理失败|正在为你准备个人助理/u);
  view.unmount();
});

test('重开面板状态一致：上次概览缓存先回显，网络恢复后换成真实数据', async t => {
  const storage = new Map();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
  });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  });
  const cached = {
    at: 1,
    value: {
      bots: [{ id: 'writer', name: '缓存里的写作助理', role: 'primary', status: 'idle', memoryCount: 0, capabilityCount: 0, computer: 'offline' }],
      active: [], recent: [], counts: null, degraded: true,
    },
  };
  storage.set('personal-assistant.cache.overview', JSON.stringify(cached));

  // 第一次「打开」：网络全部挂起，界面必须先用缓存回显，而不是白屏。
  const hanging = fakeReact();
  setClientReactRuntime(hanging.R);
  t.after(() => setClientReactRuntime(undefined));
  const hangRequest = () => new Promise(() => {});
  await hanging.settle(PersonalAssistantShell, { request: hangRequest, initialBotId: 'writer' }, 4);
  assert.ok(hanging.nodes().length > 3, '网络挂起时也不能白屏');
  assert.match(hanging.text(), /个人助理/u);
  assert.match(hanging.text(), /1 个 Bot/u, '缓存里的概览计数要先回显');
  hanging.unmount();

  // 第二次「打开」：网络恢复，真实目录数据替换缓存内容。
  const requests = [];
  const request = async operation => {
    requests.push(operation);
    if (operation.endsWith('.configuration')) return { configured: true, agentId: 'ar-test', botId: 'writer' };
    if (operation.endsWith('.local-access.status')) return { connected: true, authorized: false, scopes: [], riskConfirm: true, grantedAt: null, host: null };
    if (operation.endsWith('.bots.list')) return { directoryAvailable: true, primaryBotId: 'writer', bots: [{ botId: 'writer', displayName: '真实写作助理' }] };
    if (operation.endsWith('.bots.overview')) return { bots: [{ id: 'writer', name: '真实写作助理', role: 'primary' }], active: [], recent: [], counts: { schedules: 1, memories: 0, files: 0 }, degraded: false };
    return {};
  };
  const view = fakeReact();
  setClientReactRuntime(view.R);
  await view.settle(PersonalAssistantShell, { request, initialBotId: 'writer' });
  assert.ok(view.text().includes('真实写作助理'), '网络恢复后显示真实数据');
  assert.ok(requests.some(operation => operation.endsWith('.bots.overview')), '缓存只是回显，仍要重新拉取概览');
  const cachedAfter = JSON.parse(storage.get('personal-assistant.cache.overview'));
  assert.equal(cachedAfter.value.bots[0]?.name, '真实写作助理', '新数据要回写缓存，下次重开才能一致');
  view.unmount();
});

/* --------------------- E7 面板层：Host 413 不回退浏览器 --------------------- */

const clipboardTooLarge = () => Object.assign(new Error('本机剪贴板内容超过 64 KiB，无法读取'), { code: 'PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE', status: 413 });

/** 挂载面板并进入 active 态（剪贴板提示只在 active 时渲染）。 */
async function mountActivePanel(t, { readError, writeError, variant = 'computer' } = {}) {
  const dom = installPanelDom(t);
  const navigatorReads = [];
  const navigatorWrites = [];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: {
      clipboard: {
        readText: async () => { navigatorReads.push('read'); return '浏览器剪贴板里的内容'; },
        writeText: async text => { navigatorWrites.push(text); },
      },
    },
  });
  t.after(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  });
  const errors = spyConsole(t);
  const requests = [];
  const request = async operation => {
    requests.push(operation);
    if (operation.endsWith('.configuration')) return { configured: true, agentId: 'ar-test', botId: 'writer' };
    if (operation.endsWith('.bots.list')) return { directoryAvailable: true, primaryBotId: 'writer', bots: [{ botId: 'writer', displayName: '写作助理' }] };
    if (operation.endsWith('.desktop.ticket')) return { wsUrl: 'wss://gw.example/personal-assistant/desktop/ws', ticket: 'ticket-clipboard', readOnly: false };
    if (operation === 'personal-assistant.clipboard.read' && readError) throw readError;
    if (operation === 'personal-assistant.clipboard.write' && writeError) throw writeError;
    return {};
  };
  const view = fakeReact();
  setClientReactRuntime(view.R);
  // 断言失败也要卸载：剪贴板提示的 4s 定时器由卸载清理，否则进程会带着未清句柄不退出。
  t.after(() => view.unmount());
  t.after(() => setClientReactRuntime(undefined));
  // computer 变体（侧栏）与 page 变体（整页桌面 tab）都要覆盖；剪贴板提示两者都应显示。
  const mount = () => view.settle(PersonalAssistantPanel, { request, variant });
  await mount();
  // computer 变体在配置就绪后会自动建连；page 变体需要点「连接云电脑」。
  if (!dom.FakeSocket.instances.length) {
    const connect = buttonsWith(view, '重新连接')[0] || buttonsWith(view, '连接云电脑')[0];
    assert.ok(connect, `${variant} 变体应提供建连入口`);
    connect.props.onClick();
    await mount();
  }
  const socket = dom.FakeSocket.instances.at(-1);
  assert.ok(socket, `${variant} 变体应完成建连`);
  socket.readyState = 1;
  socket.onopen?.();
  await mount();
  // 可重连的关闭会切到 reconnecting（active 态），提示条才会渲染出来。
  socket.onclose?.({ code: 4000 });
  await mount();
  const input = view.find(node => node.props?.['aria-label'] === '云电脑文本输入');
  return { dom, view, requests, errors, input, socket, navigatorReads, navigatorWrites, mount };
}

test('Host 读取本机剪贴板返回 413：不退回浏览器剪贴板，面板显示「超过 64 KiB」', async t => {
  const fx = await mountActivePanel(t, { readError: clipboardTooLarge() });
  assert.ok(fx.input, '桌面视图应渲染隐藏输入框来接收粘贴快捷键');
  fx.input.props.onKeyDown({ key: 'v', metaKey: true, type: 'keydown', preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 50));
  await fx.mount();
  assert.ok(fx.requests.includes('personal-assistant.clipboard.read'), '粘贴应先通过 Host 读本机剪贴板');
  assert.deepEqual(fx.navigatorReads, [], 'Host 已明确回 413，不能再退回 navigator.clipboard 把可读原因吞掉');
  assert.match(fx.view.text(), /剪贴板内容超过 64 KiB/u, '应显示可照做的中文提示，而不是浏览器权限错误');
  assert.equal(fx.errors.length, 0, fx.errors.join('\n'));
  fx.view.unmount();
});

test('Host 写入本机剪贴板返回 413：不退回浏览器剪贴板，面板显示「超过 64 KiB」', async t => {
  const fx = await mountActivePanel(t, { writeError: clipboardTooLarge() });
  assert.ok(fx.input, '桌面视图应渲染隐藏输入框来接收复制快捷键');
  fx.input.props.onKeyDown({ key: 'c', metaKey: true, type: 'keydown', preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 220)); // 合成复制按键后有 150ms 窗口
  // ⌘C 现在分两步读：先读复制前的基线，发完合成 Ctrl+C 后再读「变化后的内容」。
  const answered = new Set();
  const allSent = () => fx.socket.sent.map(item => String(item)).map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(Boolean);
  const answerReads = text => {
    let answeredAny = false;
    for (const item of allSent()) {
      if (item.type !== 'clipboard.read' || answered.has(item.requestId)) continue;
      answered.add(item.requestId);
      answeredAny = true;
      fx.socket.onmessage({ data: JSON.stringify({ type: 'clipboard.response', requestId: item.requestId, ok: true, value: { text } }) });
    }
    return answeredAny;
  };
  assert.ok(answerReads('复制前的旧内容'), '⌘C 应先向云桌面请求剪贴板内容');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(answerReads('云端应用里复制的内容'), '合成复制按键后应再读一次云端剪贴板');
  await new Promise(resolve => setTimeout(resolve, 50));
  await fx.mount();
  assert.ok(fx.requests.includes('personal-assistant.clipboard.write'), '复制方向应写 Host 本机剪贴板');
  assert.deepEqual(fx.navigatorWrites, [], 'Host 已明确回 413，不能再退回 navigator.clipboard');
  assert.match(fx.view.text(), /剪贴板内容超过 64 KiB/u, '应显示可照做的中文提示');
  assert.equal(fx.errors.length, 0, fx.errors.join('\n'));
  fx.view.unmount();
});

test('page 变体（整页桌面 tab）Host 读取剪贴板 413：不退回浏览器且显示「超过 64 KiB」', async t => {
  const fx = await mountActivePanel(t, { readError: clipboardTooLarge(), variant: 'page' });
  assert.ok(fx.input, '整页面板也应渲染隐藏输入框来接收粘贴快捷键');
  fx.input.props.onKeyDown({ key: 'v', metaKey: true, type: 'keydown', preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 50));
  await fx.mount();
  assert.ok(fx.requests.includes('personal-assistant.clipboard.read'), '粘贴应先通过 Host 读本机剪贴板');
  assert.deepEqual(fx.navigatorReads, [], 'Host 已明确回 413，page 变体也不能退回 navigator.clipboard');
  assert.match(fx.view.text(), /剪贴板内容超过 64 KiB/u, '整页桌面 tab 里也要能看到可读提示，不能静默');
  assert.equal(fx.errors.length, 0, fx.errors.join('\n'));
  fx.view.unmount();
});

/** 把面板从「已断开重连中」推到「已就绪可控制」：input() 只在这个状态下才转发。 */
async function drivePanelToReady(fx) {
  fx.socket.readyState = 1;
  fx.socket.onopen?.();
  await fx.mount();
  fx.socket.onmessage({ data: JSON.stringify({ type: 'ready', sessionId: 'session-test', readOnly: false, display: { width: 1280, height: 800 } }) });
  await fx.mount();
  return fx;
}

test('按键抬起丢失时必须补发抬起：否则云端 X11 自动重复会疯狂输入', async t => {
  const fx = await drivePanelToReady(await mountActivePanel(t));
  const inputEvents = () => fx.socket.sent
    .map(item => { try { return JSON.parse(String(item)); } catch { return null; } })
    .filter(item => item?.type === 'input' && item.event?.type === 'key');
  // 普通字符走文本通道不转发按键；方向键这类才会走 key 事件。
  fx.input.props.onKeyDown({ key: 'ArrowLeft', type: 'keydown', preventDefault() {} });
  await fx.mount();
  assert.ok(inputEvents().some(item => item.event.action === 'down' && item.event.key === 'Left'), '按下应转发给云桌面');
  // 用户在面板外点了一下：keyup 永远不会到达浏览器，面板必须自己补。
  fx.dom.window.dispatchEvent({ type: 'blur' });
  await fx.mount();
  assert.ok(inputEvents().some(item => item.event.action === 'up' && item.event.key === 'Left'), '失焦必须补发抬起');
  assert.equal(fx.errors.length, 0, fx.errors.join('\n'));
  fx.view.unmount();
});

test('按键 2.5 秒没有任何事件就自动抬起：兜住连接抖动丢掉的抬起', async t => {
  const fx = await drivePanelToReady(await mountActivePanel(t));
  const inputEvents = () => fx.socket.sent
    .map(item => { try { return JSON.parse(String(item)); } catch { return null; } })
    .filter(item => item?.type === 'input' && item.event?.type === 'key');
  fx.input.props.onKeyDown({ key: 'ArrowRight', type: 'keydown', preventDefault() {} });
  await fx.mount();
  assert.ok(inputEvents().some(item => item.event.action === 'down' && item.event.key === 'Right'));
  await new Promise(resolve => setTimeout(resolve, 2700));
  await fx.mount();
  assert.ok(inputEvents().some(item => item.event.action === 'up' && item.event.key === 'Right'), '超时未收到抬起时必须自动释放');
  assert.equal(fx.errors.length, 0, fx.errors.join('\n'));
  fx.view.unmount();
});

test('焦点不在输入框时 ⌘C 仍然复制云电脑内容：发一条原子 tap ctrl+c', async t => {
  const fx = await drivePanelToReady(await mountActivePanel(t));
  const before = fx.requests.length;
  // 用户刚点过面板别处，焦点不在隐藏输入框：事件只到 document。
  const event = { type: 'keydown', key: 'c', metaKey: true, target: { tagName: 'DIV' }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  fx.dom.document.dispatchEvent(event);
  await new Promise(resolve => setTimeout(resolve, 40));
  // 云端剪贴板走 WS：先回答复制前的基线读取，复制按键才会发出去。
  const decode = item => { try { return JSON.parse(String(item)); } catch { return null; } };
  const read = fx.socket.sent.map(decode).find(item => item?.type === 'clipboard.read');
  assert.ok(read, '⌘C 应先读取云端剪贴板作为基线');
  fx.socket.onmessage({ data: JSON.stringify({ type: 'clipboard.response', requestId: read.requestId, ok: true, value: { text: '旧内容' } }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  const keys = fx.socket.sent
    .map(item => { try { return JSON.parse(String(item)); } catch { return null; } })
    .filter(item => item?.type === 'input' && item.event?.type === 'key');
  assert.deepEqual(keys.map(item => `${item.event.action}:${item.event.key}`), ['tap:ctrl+c'],
    '复制必须是一条原子事件：拆成多条时云端并发处理会导致乱序与卡键');
  assert.equal(event.defaultPrevented, true, '交给云电脑后要阻止浏览器自己的复制');
  assert.equal(fx.errors.length, 0, fx.errors.join('\n'));
  fx.view.unmount();
});

test('面板自己的输入框里 ⌘C 不抢：保留浏览器原生复制粘贴', async t => {
  const fx = await drivePanelToReady(await mountActivePanel(t));
  const before = fx.requests.length;
  const event = { type: 'keydown', key: 'c', metaKey: true, target: { tagName: 'TEXTAREA' }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  fx.dom.document.dispatchEvent(event);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(fx.requests.slice(before), [], '聊天输入框里的 ⌘C 必须保持原生行为');
  assert.equal(event.defaultPrevented, false);
  assert.equal(fx.errors.length, 0, fx.errors.join('\n'));
  fx.view.unmount();
});

test('构建标记按本机时区显示：UTC 构建串不能让用户看到 8 小时前的时间', () => {
  assert.match(localBuildLabel('2026-11-04T04:44:34.393Z'), /^\d{2}:\d{2}$/u);
  const shown = localBuildLabel('2026-11-04T04:44:34.393Z');
  const local = new Date('2026-11-04T04:44:34.393Z');
  assert.equal(shown, `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`);
  assert.equal(localBuildLabel('开发模式'), '开发模式', '构建串不可解析时原样回退，不能显示 Invalid Date');
});

test('宿主的 ⌘ 键本身绝不转发：Linux 里它等于 Super_L，按住会让之后所有 Ctrl 组合失效', async t => {
  const fx = await drivePanelToReady(await mountActivePanel(t));
  const keyEvents = () => fx.socket.sent
    .map(item => { try { return JSON.parse(String(item)); } catch { return null; } })
    .filter(item => item?.type === 'input' && item.event?.type === 'key');
  fx.input.props.onKeyDown({ key: 'Meta', type: 'keydown', metaKey: true, preventDefault() {} });
  fx.input.props.onKeyUp({ key: 'Meta', type: 'keyup', metaKey: true, preventDefault() {} });
  await fx.mount();
  assert.deepEqual(keyEvents(), [], '⌘/Win 键不能作为 Super_L 发进云桌面');
  assert.equal(fx.errors.length, 0, fx.errors.join('\n'));
  fx.view.unmount();
});

test('⌘ + 字母翻译成一次原子 ctrl+X（Linux 只认 Ctrl），不把 Super 和字母分两条发', async t => {
  const fx = await drivePanelToReady(await mountActivePanel(t));
  const keyEvents = () => fx.socket.sent
    .map(item => { try { return JSON.parse(String(item)); } catch { return null; } })
    .filter(item => item?.type === 'input' && item.event?.type === 'key');
  const event = { key: 'a', type: 'keydown', metaKey: true, preventDefault() { this.defaultPrevented = true; } };
  fx.input.props.onKeyDown(event);
  await fx.mount();
  assert.deepEqual(keyEvents().map(item => `${item.event.action}:${item.event.key}`), ['tap:ctrl+a']);
  assert.equal(event.defaultPrevented, true);
  assert.equal(fx.errors.length, 0, fx.errors.join('\n'));
  fx.view.unmount();
});
