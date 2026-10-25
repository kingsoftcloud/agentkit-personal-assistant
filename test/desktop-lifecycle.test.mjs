import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachDesktopWebSocket } from '../runtime/desktop-ws.mjs';
import { PersonalAssistantPanel, setClientReactRuntime } from '../src/client/index.mjs';

const flush = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve)); };
const failure = (status, code) => Object.assign(new Error(code), { status, code });

function clientPacket(body) {
  const data = Buffer.from(JSON.stringify(body)), mask = Buffer.from([1, 2, 3, 4]);
  const header = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : Buffer.from([0x81, 0xfe, data.length >> 8, data.length & 255]);
  for (let index = 0; index < data.length; index++) data[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, data]);
}
function serverPackets(packets) {
  const output = [];
  for (const packet of packets.filter(Buffer.isBuffer)) {
    let offset = 0;
    while (offset < packet.length) {
      const opcode = packet[offset] & 15;
      let length = packet[offset + 1] & 127, start = offset + 2;
      if (length === 126) { length = packet.readUInt16BE(start); start += 2; }
      else if (length === 127) { length = Number(packet.readBigUInt64BE(start)); start += 8; }
      const data = packet.subarray(start, start + length);
      if (opcode === 1) output.push(JSON.parse(data.toString()));
      if (opcode === 8) output.push({ type: 'wire-close', code: data.length >= 2 ? data.readUInt16BE(0) : null });
      offset = start + length;
    }
  }
  return output;
}
function bridge(t, { request, capture } = {}) {
  const calls = [], packets = [], server = new EventEmitter(), socket = new EventEmitter();
  Object.assign(socket, {
    destroyed: false, writableLength: 0,
    write(packet) { packets.push(packet); return true; },
    end(packet) { if (packet) packets.push(packet); this.ended = true; this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); }, unshift() {},
  });
  attachDesktopWebSocket({ server, runtimeToken: 'local-test-token-at-least-24-characters', assistantId: 'ar-test',
    botIdOf: value => value, taskIdOf: value => value,
    brokerDesktopRequest: async (path, body) => {
      calls.push({ path, body });
      if (request) { const value = await request(path, body); if (value !== undefined) return value; }
      if (path.endsWith('/acquire')) return { lease: { leaseId: 'lease-1' } };
      if (path.endsWith('/session')) return { sessionId: 'desktop-1', readOnly: !body.leaseId };
      return {};
    },
    brokerDesktopFrameBinary: async body => {
      calls.push({ path: '/binary-frame', body });
      return capture ? capture(body) : { unchanged: true, seq: 1, width: 1280, height: 800, nextFrameDelayMs: 1000 };
    },
  });
  server.emit('upgrade', { url: '/v1/desktop/ws', socket: { remoteAddress: '127.0.0.1' }, headers: {
    authorization: 'Bearer local-test-token-at-least-24-characters',
    'sec-websocket-protocol': 'agentkit.personal-assistant.desktop.v1', 'sec-websocket-key': 'local-test-key',
  } }, socket, Buffer.alloc(0));
  t.after(() => socket.destroy());
  return { calls, socket, messages: () => serverPackets(packets), send: body => socket.emit('data', clientPacket(body)) };
}

test('session reaped during capture closes transport, stops timers and releases the automatic lease once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const desktop = bridge(t, { capture: () => { throw failure(404, 'DESKTOP_SESSION_NOT_FOUND'); } });
  desktop.send({ type: 'open', botId: 'writer', taskId: 't', mode: 'control' });
  await flush();
  assert.deepEqual(desktop.messages().find(value => value.type === 'closed'), {
    type: 'closed', retryable: false, status: 404, code: 'DESKTOP_SESSION_NOT_FOUND', message: 'DESKTOP_SESSION_NOT_FOUND', reason: 'session-ended',
  });
  assert.equal(desktop.messages().find(value => value.type === 'wire-close')?.code, 1000);
  assert.equal(desktop.socket.ended, true);
  const count = desktop.calls.length;
  t.mock.timers.tick(120_000); await flush();
  assert.equal(desktop.calls.length, count, 'closed desktop must not capture frames or renew a lease');
  assert.equal(desktop.calls.filter(value => value.path === '/broker/lease/release').length, 1);
  assert.equal(desktop.calls.filter(value => value.path === '/broker/desktop/close').length, 1);
});

test('input lease loss and renewal conflict end the stream instead of continuing as an observer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const stage of ['input', 'renew']) {
    const desktop = bridge(t, { request: path => {
      if (path === `/broker/${stage === 'input' ? 'desktop/input' : 'lease/renew'}`) throw failure(409, 'COMPUTER_LEASE_REQUIRED');
    } });
    desktop.send({ type: 'open', botId: 'writer', taskId: stage, mode: 'control' }); await flush();
    if (stage === 'input') desktop.send({ type: 'input', event: { type: 'text', text: 'hello' } });
    else t.mock.timers.tick(30_000);
    await flush();
    assert.equal(desktop.messages().find(value => value.type === 'closed')?.reason, 'lease-lost', stage);
    assert.equal(desktop.messages().find(value => value.type === 'wire-close')?.code, 1000, stage);
    const count = desktop.calls.length;
    t.mock.timers.tick(120_000); await flush();
    assert.equal(desktop.calls.length, count, stage);
    assert.equal(desktop.calls.filter(value => value.path === '/broker/lease/release').length, 1, stage);
  }
});

test('a stalled desktop cleanup cannot delay closing the socket or attempting lease release', async t => {
  const desktop = bridge(t, {
    capture: () => { throw failure(404, 'DESKTOP_SESSION_NOT_FOUND'); },
    request: path => path === '/broker/desktop/close' ? new Promise(() => {}) : undefined,
  });
  desktop.send({ type: 'open', botId: 'writer', taskId: 't', mode: 'control' }); await flush();
  assert.equal(desktop.socket.ended, true);
  assert.equal(desktop.calls.filter(value => value.path === '/broker/lease/release').length, 1);
});

test('disconnect during asynchronous lease acquisition or session creation cleans up late resources', async t => {
  for (const stage of ['acquire', 'session']) {
    let complete;
    const desktop = bridge(t, { request: path => path.endsWith(`/${stage}`) ? new Promise(resolve => { complete = resolve; }) : undefined });
    desktop.send({ type: 'open', botId: 'writer', taskId: stage, mode: 'control' }); await flush();
    desktop.socket.destroy();
    complete(stage === 'acquire' ? { lease: { leaseId: 'lease-late' } } : { sessionId: 'desktop-late' }); await flush();
    assert.equal(desktop.calls.filter(value => value.path === '/broker/lease/release').length, 1, stage);
    assert.equal(desktop.calls.filter(value => value.path === '/binary-frame').length, 0, stage);
    assert.equal(desktop.calls.filter(value => value.path === '/broker/desktop/close').length, stage === 'session' ? 1 : 0, stage);
  }
});

test('temporary renewal failure preserves its status and closes with a retryable abnormal reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const desktop = bridge(t, { request: path => { if (path.endsWith('/renew')) throw failure(503, 'BROKER_UNAVAILABLE'); } });
  desktop.send({ type: 'open', botId: 'writer', taskId: 't', mode: 'control' }); await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.equal(desktop.messages().find(value => value.type === 'error')?.status, 503);
  assert.equal(desktop.messages().find(value => value.type === 'closed')?.retryable, true);
  assert.equal(desktop.messages().find(value => value.type === 'wire-close')?.code, 1011);
});

function panelHarness(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const saved = Object.fromEntries(['document', 'window', 'WebSocket', 'createImageBitmap'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new EventTarget(), window = new EventTarget(); document.hidden = false;
  const sockets = [], requests = [], hooks = [], effects = [], drawn = []; let cursor = 0, tree;
  class WebSocket {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen?.({}); }
    message(value) { this.onmessage?.({ data: typeof value === 'object' && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value }); }
    closed(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
    close(code = 1000) { this.closed(code); }
  }
  Object.assign(globalThis, { document, window, WebSocket, createImageBitmap: async () => ({ close() {} }) });
  const request = async (operation, payload) => {
    requests.push({ operation, payload });
    if (operation.endsWith('.configuration')) return { configured: options.configured !== false, agentId: 'ar-test' };
    if (operation.endsWith('.bots.list')) { if (options.directoryError) throw options.directoryError; return { bots: options.bots || [{ botId: 'writer', displayName: '写作助理' }], directoryAvailable: true }; }
    return { ticket: 'short-lived-ticket', wsUrl: 'wss://gateway.invalid/desktop' };
  };
  const fakeReact = {
    createElement(type, props, ...children) {
      if (props?.ref && !props.ref.current) props.ref.current = {
        blur() {}, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
        getContext: () => ({ fillRect() {}, drawImage(bitmap) { drawn.push(bitmap); } }),
      };
      return { type, props: props || {}, children: children.flat() };
    },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }]; },
    useEffect(effect, deps) { const index = cursor++; if (!hooks[index]) { hooks[index] = { deps }; effects.push(() => { hooks[index].cleanup = effect(); }); } },
  };
  setClientReactRuntime(fakeReact);
  const render = () => { cursor = 0; tree = PersonalAssistantPanel({ request, initialBotId: 'writer' }); for (const effect of effects.splice(0)) effect(); return tree; };
  const all = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(all)] : [];
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const visibleText = node => typeof node === 'string' ? node : node?.type === 'details' && !node.props.open ? visibleText(node.children[0]) : node?.children?.map(visibleText).join('') || '';
  const click = label => { render(); const button = all(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(button, `button ${label} exists`); button.props.onClick(); };
  render();
  t.after(() => {
    for (const hook of hooks) hook?.cleanup?.();
    setClientReactRuntime(undefined);
    for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  return { sockets, requests, document, drawn, click, render, nodes: () => all(render()), text: () => text(render()), visibleText: () => visibleText(render()), tickets: () => requests.filter(value => value.operation.endsWith('.ticket')) };
}
async function connectPanel(panel, mode = 'read') {
  await flush(); panel.click(mode === 'read' ? '只读旁观' : '连接云电脑'); await flush();
  const socket = panel.sockets.at(-1); socket.open();
  socket.message({ type: 'ready', sessionId: 'desktop-1', readOnly: mode === 'read', display: { width: 1280, height: 800 } });
  socket.message({ type: 'frame', seq: 1, width: 1280, height: 800 }); socket.message(new ArrayBuffer(8)); await flush();
  return socket;
}

test('panel stops reconnecting after idle session closure, including visibility changes, but explicit open works', async t => {
  const panel = panelHarness(t), socket = await connectPanel(panel);
  assert.match(panel.text(), /当前为只读旁观，鼠标和键盘输入不会发送/u);
  assert.doesNotMatch(panel.text(), /其他 Bot 正在控制/u);
  socket.message({ type: 'closed', reason: 'session-ended', status: 404, code: 'DESKTOP_SESSION_NOT_FOUND', retryable: false });
  assert.match(panel.text(), /桌面会话已结束/u);
  t.mock.timers.tick(120_000); await flush();
  panel.document.hidden = true; panel.document.dispatchEvent(new Event('visibilitychange'));
  panel.document.hidden = false; panel.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(panel.tickets().length, 1);
  assert.equal(socket.readyState, 3);
  panel.click('只读旁观'); await flush();
  assert.equal(panel.tickets().length, 2, 'manual open must still work after a terminal close');
});

test('panel normal wire close and legacy session or lease errors stop automatic reconnect', async t => {
  const panel = panelHarness(t);
  for (const signal of [{ wire: 1000 }, { type: 'error', code: 'DESKTOP_SESSION_NOT_FOUND' }, { type: 'error', status: 409, code: 'COMPUTER_LEASE_REQUIRED' }]) {
    const socket = await connectPanel(panel, 'control');
    if (signal.wire) socket.closed(signal.wire); else socket.message(signal);
    const count = panel.tickets().length;
    t.mock.timers.tick(60_000); await flush();
    assert.equal(panel.tickets().length, count, JSON.stringify(signal));
    assert.match(panel.text(), /桌面连接已结束/u);
  }
});

test('panel network failure retries automatically, while a control conflict falls back to read only once', async t => {
  const panel = panelHarness(t), socket = await connectPanel(panel);
  socket.closed(1006); t.mock.timers.tick(1000); await flush();
  assert.equal(panel.tickets().length, 2);
  assert.equal(panel.tickets()[1].payload.mode, 'read');
  panel.click('重新连接'); await flush();
  const control = panel.sockets.at(-1); control.open();
  control.message({ type: 'error', status: 409, code: 'COMPUTER_LEASE_CONFLICT' }); await flush();
  assert.equal(panel.tickets().at(-1).payload.mode, 'read');
  const count = panel.tickets().length;
  control.message({ type: 'closed', reason: 'lease-lost', status: 409, retryable: false }); control.closed(1000);
  await flush();
  assert.equal(panel.tickets().length, count, 'stale control close must not close or restart the observer connection');
});

test('panel network retries remain bounded and a first-frame timeout remains retryable', async t => {
  const panel = panelHarness(t);
  await flush(); panel.click('只读旁观'); await flush();
  panel.sockets.at(-1).open();
  t.mock.timers.tick(3000); await flush();
  assert.equal(panel.tickets().length, 1, 'lazy desktop startup must not trigger a retry at three seconds');
  t.mock.timers.tick(8999); await flush();
  assert.equal(panel.tickets().length, 1, 'keep the existing twelve-second client recovery boundary');
  t.mock.timers.tick(1); await flush();
  t.mock.timers.tick(1000); await flush();
  assert.equal(panel.tickets().length, 2, 'first-frame timeout is an abnormal close and may reconnect');
  for (const delay of [2000, 4000, 8000, 8000]) {
    panel.sockets.at(-1).closed(1006); t.mock.timers.tick(delay); await flush();
  }
  panel.sockets.at(-1).closed(1006);
  const count = panel.tickets().length;
  t.mock.timers.tick(120_000); await flush();
  panel.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(count, 6, 'initial connection plus at most five retries');
  assert.equal(panel.tickets().length, count);
  assert.match(panel.text(), /无法连接云电脑/u);
});

test('panel releases held inputs on a terminal close and cancels in-flight frame drawing', async t => {
  const panel = panelHarness(t), socket = await connectPanel(panel, 'control');
  const tree = panel.render();
  const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  const canvas = nodes(tree).find(node => node.type === 'canvas');
  canvas.props.onKeyDown({ key: 'Control', type: 'keydown', ctrlKey: true, preventDefault() {} });
  let complete, bitmapClosed = false;
  globalThis.createImageBitmap = () => new Promise(resolve => { complete = resolve; });
  socket.message({ type: 'frame', seq: 2, width: 1280, height: 800 }); socket.message(new ArrayBuffer(8));
  const count = panel.drawn.length;
  socket.message({ type: 'closed', reason: 'lease-lost', status: 409, retryable: false });
  complete({ close() { bitmapClosed = true; } }); await flush();
  assert.equal(panel.drawn.length, count, 'late decoding must not resurrect a terminated desktop');
  assert.equal(bitmapClosed, true);
  assert.equal(socket.sent.some(value => value.event?.key === 'Control_L' && value.event.action === 'up'), true);
  assert.equal(socket.sent.filter(value => value.type === 'close').length, 1);
  assert.match(panel.text(), /控制租约已失效/u);
});


test('未开通/空目录只展示一个检查入口，没有凭据字段或可手填的助理标识', async t => {
  for (const options of [{ configured: false }, { bots: [] }]) {
    await t.test(JSON.stringify(options), async child => {
    const panel = panelHarness(child, options); await flush();
    const nodes = panel.nodes();
    assert.equal(nodes.some(node => node.type === 'select'), false);
    assert.equal(nodes.some(node => node.type === 'input' && node.props['aria-label'] === 'Bot ID'), false);
    assert.equal(nodes.filter(node => node.type === 'button').length, 1);
    assert.match(panel.text(), /检查开通状态/u);
    assert.doesNotMatch(panel.visibleText(), /API Key|Personal Assistant|Bot ID|配置云网关|0 fps/u);
    assert.equal(panel.sockets.length, 0);
    });
  }
});

test('助理只从真实目录选择，诊断字段折叠，页面默认不连接电脑', async t => {
  const panel = panelHarness(t, { bots: [{ botId: 'writer', displayName: '写作助理' }, { botId: 'researcher', displayName: '研究助理' }] }); await flush();
  const nodes = panel.nodes();
  const selector = nodes.find(node => node.type === 'select');
  assert.equal(selector.props.value, 'writer');
  assert.deepEqual(selector.children.map(node => node.children[0]), ['写作助理', '研究助理']);
  assert.equal(nodes.some(node => node.type === 'details' && node.props.open), false);
  const diagnostic = nodes.find(node => node.type === 'details');
  assert.match(JSON.stringify(diagnostic), /ar-test|writer/u);
  assert.equal(nodes.some(node => node.type === 'small' && node.props['data-personal-assistant-build']), true);
  assert.equal(panel.sockets.length, 0);
  assert.equal(panel.requests.filter(row => row.operation.endsWith('.bots.list')).length, 1);
});
