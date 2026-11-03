/**
 * 交互稳定性验收：视图切换/重挂载不白屏、不报错、不堆积轮询与定时器；
 * RPC 失败可降级并在重试后恢复；重开面板首屏用缓存回显（stale-while-revalidate）。
 *
 * 说明：这里用「真实组件 + 假 React / 假 WS / 计数定时器」跑真实 effect，
 * 断言的是「卸载后还有没有活跃定时器、有没有新请求」，不是函数是否存在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantPanel, PersonalAssistantShell, setClientReactRuntime } from '../src/client/index.mjs';
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
