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

test('明确 idle 信号保留 WS，停止抓帧续租；恢复只读时不再申请控制', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let parked = false;
  const desktop = bridge(t, { request: (path, body) => {
    if (path.endsWith('/session')) return { sessionId: 'desktop-1', readOnly: false, idleMode: 'suspend', idleTimeoutMs: 60000 };
    if (path.endsWith('/idle')) { parked = true; return { sessionId: 'desktop-1', idle: true }; }
    if (path.endsWith('/resume')) { parked = false; return { sessionId: 'desktop-1', readOnly: true, controllable: false, idleMode: 'suspend', idleTimeoutMs: 60000 }; }
  }, capture: () => { if (parked) throw failure(409, 'DESKTOP_SESSION_IDLE'); return { unchanged: true, seq: 1 }; } });
  desktop.send({ type: 'open', botId: 'writer', taskId: 't', mode: 'control' }); await flush();
  t.mock.timers.tick(60001); await flush();
  assert.equal(desktop.socket.ended, undefined);
  assert.ok(desktop.messages().some(v => v.type === 'idle'));
  assert.equal(desktop.calls.filter(v => v.path === '/broker/desktop/close').length, 0);
  const count = desktop.calls.length;
  t.mock.timers.tick(90000); await flush();
  assert.equal(desktop.calls.length, count, 'idle sends no frames or lease renewals');
  const acquired = desktop.calls.filter(v => v.path.endsWith('/acquire')).length;
  desktop.send({ type: 'resume', mode: 'read', activity: true }); await flush();
  assert.equal(desktop.calls.filter(v => v.path.endsWith('/acquire')).length, acquired);
  assert.equal(desktop.messages().filter(v => v.type === 'ready').at(-1).readOnly, true);
});

test('空闲后的控制冲突保留会话并恢复只读，重放 input 仍被 409 拒绝', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let acquisitions = 0;
  const desktop = bridge(t, { request: (path, body) => {
    if (path.endsWith('/acquire')) { if (++acquisitions > 1) throw failure(409, 'COMPUTER_LEASE_CONFLICT'); }
    if (path.endsWith('/session')) return { sessionId: 'desktop-1', readOnly: false, idleMode: 'suspend', idleTimeoutMs: 60000 };
    if (path.endsWith('/resume')) { assert.equal(body.leaseId, undefined); return { sessionId: 'desktop-1', readOnly: true, idleMode: 'suspend', idleTimeoutMs: 60000 }; }
  } });
  desktop.send({ type: 'open', botId: 'writer', taskId: 't', mode: 'control' }); await flush();
  t.mock.timers.tick(60001); await flush();
  desktop.send({ type: 'input', event: { type: 'text', text: 'must-not-run' } }); await flush();
  assert.equal(desktop.messages().find(v => v.code === 'DESKTOP_SESSION_IDLE').status, 409);
  assert.equal(desktop.calls.some(v => v.path.endsWith('/input')), false);
  desktop.send({ type: 'resume', mode: 'control', activity: true }); await flush();
  assert.equal(desktop.socket.ended, undefined);
  assert.equal(desktop.messages().find(v => v.code === 'COMPUTER_LEASE_CONFLICT').status, 409);
  assert.equal(desktop.messages().filter(v => v.type === 'ready').at(-1).readOnly, true);
});

test('空闲后恢复控制取得新租约并保留会话，外部任务租约不随桌面空闲撤销', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let acquisitions = 0;
  const desktop = bridge(t, { request: (path, body) => {
    if (path.endsWith('/acquire')) return { lease: { leaseId: `lease-${++acquisitions}` } };
    if (path.endsWith('/session') || path.endsWith('/resume')) return { sessionId: 'desktop-1', readOnly: false, idleMode: 'suspend', idleTimeoutMs: 60000 };
  } });
  desktop.send({ type: 'open', botId: 'writer', taskId: 't', mode: 'control' }); await flush();
  t.mock.timers.tick(60001); await flush();
  desktop.send({ type: 'resume', mode: 'control', activity: true }); await flush();
  assert.equal(desktop.calls.find(v => v.path.endsWith('/resume')).body.leaseId, 'lease-2');
  assert.equal(desktop.messages().filter(v => v.type === 'ready').at(-1).sessionId, 'desktop-1');
  desktop.send({ type: 'input', event: { type: 'text', text: 'ok' } }); await flush();
  assert.equal(desktop.calls.find(v => v.path.endsWith('/input')).body.leaseId, 'lease-2');
  const external = bridge(t, { request: path => path.endsWith('/session') ? { sessionId: 'external-view', readOnly: false, idleMode: 'suspend', idleTimeoutMs: 60000 } : undefined });
  external.send({ type: 'open', botId: 'writer', taskId: 'job', mode: 'control', leaseId: 'job-owned' }); await flush();
  t.mock.timers.tick(60001); await flush();
  assert.equal(external.calls.some(v => v.path.endsWith('/release')), false);
  assert.equal(external.messages().find(v => v.type === 'idle').leaseReleased, false);
});

test('恢复取租约期间断开会释放晚到租约，不重新启动桌面', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let acquisitions = 0, acquired;
  const desktop = bridge(t, { request: path => {
    if (path.endsWith('/acquire') && ++acquisitions > 1) return new Promise(resolve => { acquired = resolve; });
    if (path.endsWith('/session')) return { sessionId: 'desktop-1', readOnly: false, idleMode: 'suspend', idleTimeoutMs: 60000 };
  } });
  desktop.send({ type: 'open', botId: 'writer', taskId: 't', mode: 'control' }); await flush();
  t.mock.timers.tick(60001); await flush();
  desktop.send({ type: 'resume', mode: 'control', activity: true }); await flush();
  desktop.socket.destroy(); acquired({ lease: { leaseId: 'late-lease' } }); await flush();
  assert.equal(desktop.calls.some(v => v.path.endsWith('/resume')), false);
  assert.ok(desktop.calls.some(v => v.path.endsWith('/release') && v.body.leaseId === 'late-lease'));
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
  const saved = Object.fromEntries(['document', 'window', 'WebSocket', 'createImageBitmap', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new EventTarget(), window = new EventTarget(); document.hidden = false;
  const sockets = [], requests = [], hooks = [], effects = [], drawn = [], drawRects = [], observers = []; let cursor = 0, tree;
  let displayRect = options.rect || { left: 0, top: 0, width: 1280, height: 800 };
  class WebSocket {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen?.({}); }
    message(value) { this.onmessage?.({ data: typeof value === 'object' && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value }); }
    closed(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
    close(code = 1000) { this.closed(code); }
  }
  class ResizeObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} }
  Object.assign(globalThis, { document, window, WebSocket, ResizeObserver, requestAnimationFrame: callback => setTimeout(callback, 16), cancelAnimationFrame: clearTimeout, createImageBitmap: async () => ({ close() {} }) });
  const request = async (operation, payload) => {
    requests.push({ operation, payload });
    if (operation.endsWith('.configuration')) return { configured: options.configured !== false, agentId: 'ar-test' };
    if (operation.endsWith('.bots.list')) { if (options.directoryError) throw options.directoryError; return { features: options.features || [], bots: options.bots || [{ botId: 'writer', displayName: '写作助理' }], directoryAvailable: true }; }
    return { ticket: 'short-lived-ticket', wsUrl: 'wss://gateway.invalid/desktop' };
  };
  const fakeReact = {
    createElement(type, props, ...children) {
      if (props?.ref && !props.ref.current) props.ref.current = {
        blur() {}, focus() {}, contains: target => target?.insideDesktop === true, style: {}, setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {}, getBoundingClientRect: () => displayRect,
        getContext: () => ({ clearRect() {}, drawImage(bitmap, ...rect) { drawn.push(bitmap); drawRects.push(rect); } }),
      };
      return { type, props: props || {}, children: children.flat() };
    },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }]; },
    useEffect(effect, deps) { const index = cursor++; if (!hooks[index]) { hooks[index] = { deps }; effects.push(() => { hooks[index].cleanup = effect(); }); } },
  };
  setClientReactRuntime(fakeReact);
  const render = () => { cursor = 0; tree = PersonalAssistantPanel({ request, initialBotId: 'writer', variant: options.variant, nativeFullscreen: options.nativeFullscreen }); for (const effect of effects.splice(0)) effect(); return tree; };
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
  const unmount = () => { for (const hook of hooks) if (typeof hook?.cleanup === 'function') { hook.cleanup(); hook.cleanup = undefined; } };
  const resize = rect => { displayRect = rect; for (const observer of observers) observer.callback(); };
  return { sockets, requests, document, drawn, drawRects, resize, click, render, unmount, nodes: () => all(render()), text: () => text(render()), visibleText: () => visibleText(render()), tickets: () => requests.filter(value => value.operation.endsWith('.ticket')) };
}
async function connectPanel(panel, mode = 'read') {
  await flush(); panel.click(mode === 'read' ? '只读旁观' : '连接云电脑'); await flush();
  const socket = panel.sockets.at(-1); socket.open();
  socket.message({ type: 'ready', sessionId: 'desktop-1', readOnly: mode === 'read', display: { width: 1280, height: 800 } });
  socket.message({ type: 'frame', seq: 1, width: 1280, height: 800 }); socket.message(new ArrayBuffer(8)); await flush();
  return socket;
}

test('原生云电脑自动旁观；首击等待控制确认再注入，点外释放不关闭通道', async t => {
  const panel = panelHarness(t, { variant: 'native-tab', features: ['desktop-handoff/v1'] }); await flush();
  assert.equal(panel.tickets().at(-1).payload.mode, 'control', '签票本身不占租约');
  const viewer = panel.sockets.at(-1); viewer.open(); assert.equal(viewer.sent[0].mode, 'observe');
  viewer.message({ type: 'ready', sessionId: 'viewer', readOnly: true, controlAvailable: true, controlEpoch: 0, display: { width: 1280, height: 800 } });
  viewer.message({ type: 'frame', seq: 1, width: 1280, height: 800 }); viewer.message(new ArrayBuffer(8)); await flush();
  const canvas = panel.nodes().find(node => node.type === 'canvas');
  canvas.props.onPointerDown({ type: 'pointerdown', pointerId: 1, button: 0, clientX: 300, clientY: 200, preventDefault() {} });
  canvas.props.onPointerUp({ type: 'pointerup', pointerId: 1, button: 0, clientX: 300, clientY: 200, preventDefault() {} });
  assert.equal(viewer.sent.at(-1).type, 'control.acquire'); assert.equal(viewer.sent.some(v => v.type === 'input'), false);
  viewer.message({ type: 'control', readOnly: false, controlAvailable: true, controlEpoch: 1 }); await flush();
  assert.deepEqual(viewer.sent.filter(v => v.type === 'input').map(v => v.event), [
    { type: 'button', action: 'down', button: 1, x: 300, y: 200 }, { type: 'button', action: 'up', button: 1, x: 300, y: 200 },
  ]);
  panel.document.dispatchEvent(new Event('pointerdown'));
  assert.equal(viewer.sent.at(-1).type, 'control.release');
  viewer.message({ type: 'control', readOnly: true, controlAvailable: true, controlEpoch: 2 });
  assert.equal(panel.sockets.length, 1); assert.equal(viewer.readyState, 1);
  assert.match(panel.text(), /点画面即可接管/u);
});

test('原生全屏 Escape 交给宿主，不注入远端，也不自绘断开或全屏按钮', async t => {
  const panel = panelHarness(t, { variant: 'native-tab', nativeFullscreen: true }); await flush();
  const socket = panel.sockets.at(-1); socket.open();
  socket.message({ type: 'ready', sessionId: 'viewer', readOnly: false, display: { width: 1280, height: 800 } });
  socket.message({ type: 'frame', seq: 1 }); socket.message(new ArrayBuffer(8)); await flush();
  const canvas = panel.nodes().find(node => node.type === 'canvas'), before = socket.sent.length;
  let prevented = false;
  canvas.props.onKeyDown({ type: 'keydown', key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, false); assert.equal(socket.sent.length, before);
  assert.equal(panel.nodes().some(node => node.type === 'button' && /全屏|断开/.test(node.children.join(''))), false);
});

test('原生桌面以等比圆角卡片占满可用宽度，控制胶囊在卡片下方正常流', async t => {
  const panel = panelHarness(t, { variant: 'native-tab' }); await flush();
  const socket = panel.sockets.at(-1); socket.open();
  socket.message({ type: 'ready', sessionId: 'viewer', readOnly: true, display: { width: 1280, height: 800 } });
  socket.message({ type: 'frame', seq: 1 }); socket.message(new ArrayBuffer(8)); await flush();
  const nodes = panel.nodes(), root = nodes.find(node => node.props['data-personal-assistant-computer']);
  const layout = nodes.find(node => node.props['data-personal-assistant-desktop-layout']);
  const stack = nodes.find(node => node.props['data-personal-assistant-desktop-stack']);
  const card = nodes.find(node => node.props['data-personal-assistant-desktop-card']);
  const capsule = nodes.find(node => node.props['data-personal-assistant-control-capsule']);
  assert.match(root.props.style.background, /--dsw-alias-bg-base/);
  assert.equal(layout.props.style.overflow, 'auto', '矮栏滚动，不压缩或裁切完整桌面');
  assert.equal(stack.props.style.width, '100%'); assert.equal(stack.props.style.maxWidth, 1280);
  assert.equal(card.props.style.aspectRatio, '1280 / 800'); assert.equal(card.props.style.width, '100%');
  assert.equal(card.props.style.height, undefined); assert.equal(card.props.style.minHeight, undefined);
  assert.ok(card.props.style.borderRadius > 0); assert.equal(card.props.style.padding, undefined);
  assert.equal(stack.children[0], card); assert.equal(stack.children[1], capsule);
  assert.equal(capsule.props.style.position, undefined); assert.equal(capsule.props.style.transform, undefined);
  assert.ok(nodes.some(node => node.props.role === 'alert' && /只读旁观/.test(node.children.join(''))));
  assert.equal(nodes.filter(node => node.type === 'canvas').length, 1);
  assert.equal(nodes.some(node => node.props.style?.position === 'fixed'), false);
});

test('窄卡片首击与原生全屏缩放仍按实际显示rect映射，ResizeObserver重画完整帧', async t => {
  const narrow = { left: 916, top: 240, width: 488, height: 305 };
  const panel = panelHarness(t, { variant: 'native-tab', features: ['desktop-handoff/v1'], rect: narrow }); await flush();
  const socket = panel.sockets.at(-1); socket.open();
  socket.message({ type: 'ready', sessionId: 'viewer', readOnly: true, controlAvailable: true, controlEpoch: 0, display: { width: 1280, height: 800 } });
  socket.message({ type: 'frame', seq: 1 }); socket.message(new ArrayBuffer(8)); await flush();
  const canvas = panel.nodes().find(node => node.type === 'canvas');
  const first = { type: 'pointerdown', pointerId: 1, button: 0, clientX: narrow.left + 320 * narrow.width / 1280, clientY: narrow.top + 240 * narrow.height / 800, preventDefault() {} };
  canvas.props.onPointerDown(first); canvas.props.onPointerUp({ ...first, type: 'pointerup' });
  assert.equal(socket.sent.at(-1).type, 'control.acquire'); assert.equal(socket.sent.some(value => value.type === 'input'), false);
  socket.message({ type: 'control', readOnly: false, controlAvailable: true, controlEpoch: 1 });
  assert.deepEqual(socket.sent.filter(value => value.type === 'input').map(value => value.event), [
    { type: 'button', action: 'down', button: 1, x: 320, y: 240 }, { type: 'button', action: 'up', button: 1, x: 320, y: 240 },
  ]);
  const fullscreen = { left: 160, top: 92, width: 1280, height: 800 };
  panel.resize(fullscreen); await flush();
  assert.deepEqual(panel.drawRects.at(-1), [0, 0, 1280, 800], '缩放后重用已收帧，不把画面拉伸到侧栏高度');
  for (let i = 1; i <= 10; i++) {
    const x = i * 100, y = (i % 7 + 1) * 100;
    canvas.props.onPointerDown({ ...first, clientX: fullscreen.left + x, clientY: fullscreen.top + y });
    canvas.props.onPointerUp({ ...first, type: 'pointerup', clientX: fullscreen.left + x, clientY: fullscreen.top + y });
    const event = socket.sent.at(-1).event;
    assert.ok(Math.abs(event.x - x) <= 2 && Math.abs(event.y - y) <= 2);
  }
  panel.document.dispatchEvent(new Event('pointerdown'));
  assert.equal(socket.sent.at(-1).type, 'control.release', '卡片外的留白仍释放控制');
});

test('rAF 合并的旧移动在新按下前发送，不能迟到后拖回旧坐标', async t => {
  const panel = panelHarness(t, { variant: 'native-tab', features: ['desktop-handoff/v1'] }); await flush();
  const socket = panel.sockets.at(-1); socket.open();
  socket.message({ type: 'ready', sessionId: 'viewer', readOnly: true, controlAvailable: true, controlEpoch: 0 });
  socket.message({ type: 'frame', seq: 1 }); socket.message(new ArrayBuffer(8)); await flush();
  panel.click('接管'); socket.message({ type: 'control', readOnly: false, controlAvailable: true, controlEpoch: 1 });
  const canvas = panel.nodes().find(node => node.type === 'canvas'), before = socket.sent.length;
  canvas.props.onPointerMove({ clientX: 100, clientY: 120 });
  canvas.props.onPointerDown({ type: 'pointerdown', pointerId: 1, button: 0, clientX: 300, clientY: 220, preventDefault() {} });
  t.mock.timers.tick(16); await flush();
  const inputs = socket.sent.slice(before).filter(row => row.type === 'input').map(row => row.event);
  assert.deepEqual(inputs, [{ type: 'pointermove', x: 100, y: 120 }, { type: 'button', action: 'down', button: 1, x: 300, y: 220 }]);
});

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

test('面板空闲保留通道且不自动取票，首个输入等待重新获租约后再发送', async t => {
  const panel = panelHarness(t), socket = await connectPanel(panel, 'control');
  socket.message({ type: 'idle', sessionId: 'desktop-1', leaseReleased: true }); await flush();
  assert.match(panel.text(), /已空闲/u); assert.equal(socket.readyState, 1);
  t.mock.timers.tick(75000); await flush();
  assert.equal(panel.tickets().length, 1);
  const canvas = panel.nodes().find(node => node.type === 'canvas');
  canvas.props.onKeyDown({ type: 'keydown', key: 'Tab', preventDefault() {} }); await flush();
  assert.equal(socket.sent.at(-1).type, 'resume');
  assert.equal(socket.sent.filter(v => v.type === 'input').length, 0, 'first input stays buffered before control is confirmed');
  socket.message({ type: 'ready', sessionId: 'desktop-1', readOnly: false, display: { width: 1280, height: 800 } }); await flush();
  assert.deepEqual(socket.sent.at(-1), { type: 'input', controlEpoch: 0, event: { type: 'key', action: 'down', key: 'Tab' } });
  assert.equal(panel.tickets().length, 1);
});

test('恢复租约冲突时丢弃缓冲输入并留在只读，不后台重复抢占', async t => {
  const panel = panelHarness(t), socket = await connectPanel(panel, 'control');
  socket.message({ type: 'idle', sessionId: 'desktop-1', leaseReleased: true }); await flush();
  panel.click('恢复画面'); await flush();
  socket.message({ type: 'error', status: 409, code: 'COMPUTER_LEASE_CONFLICT', recoverable: true, message: '其他助理正在使用云电脑，已恢复为只读旁观' });
  socket.message({ type: 'ready', sessionId: 'desktop-1', readOnly: true, display: { width: 1280, height: 800 } });
  socket.message({ type: 'frame', seq: 2, width: 1280, height: 800 }); socket.message(new ArrayBuffer(8)); await flush();
  assert.equal(socket.readyState, 1); assert.match(panel.text(), /当前为只读旁观/u);
  assert.equal(socket.sent.filter(v => v.type === 'input').length, 0);
  t.mock.timers.tick(1000); await flush(); assert.equal(panel.tickets().length, 1);
});

test('空闲后的首段中文与 emoji 输入缓冲到 ready 后只发送一次', async t => {
  const panel = panelHarness(t), socket = await connectPanel(panel, 'control');
  socket.message({ type: 'idle', sessionId: 'desktop-1', leaseReleased: true }); await flush();
  const text = '你好，云电脑 English 😀';
  const field = panel.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '云电脑文本输入');
  assert.equal(field.props.disabled, false);
  const target = { value: text };
  field.props.onCompositionStart(); field.props.onCompositionEnd({ currentTarget: target });
  field.props.onInput({ currentTarget: target }); await flush();
  assert.equal(socket.sent.filter(v => v.type === 'input').length, 0);
  socket.message({ type: 'ready', sessionId: 'desktop-1', readOnly: false, display: { width: 1280, height: 800 } }); await flush();
  t.mock.timers.tick(30); await flush();
  assert.deepEqual(socket.sent.filter(v => v.type === 'input'), [{ type: 'input', controlEpoch: 0, event: { type: 'text', text } }]);
});

test('空闲前仍在解码的旧帧不能把面板改回控制态', async t => {
  const panel = panelHarness(t), socket = await connectPanel(panel, 'control');
  let decoded;
  globalThis.createImageBitmap = () => new Promise(resolve => { decoded = resolve; });
  socket.message({ type: 'frame', seq: 2, width: 1280, height: 800 }); socket.message(new ArrayBuffer(8)); await flush();
  socket.message({ type: 'idle', sessionId: 'desktop-1', leaseReleased: true });
  decoded({ close() {} }); await flush();
  assert.match(panel.text(), /已空闲/u);
  assert.equal(panel.drawn.length, 1);
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

test('冷启动 3.401 秒及网关慢态 6.072 秒仍在原连接等待，出帧后不再触发首帧重试', async t => {
  for (const elapsed of [3401, 6072]) {
    await t.test(`${elapsed}ms`, async child => {
      const panel = panelHarness(child);
      await flush(); panel.click('连接云电脑'); await flush();
      const socket = panel.sockets.at(-1); socket.open();
      assert.match(panel.text(), /正在启动云电脑/u);
      assert.match(panel.text(), /首次或休眠后连接可能需要数秒/u);
      child.mock.timers.tick(elapsed - 280); await flush();
      assert.equal(socket.readyState, 1);
      assert.equal(panel.tickets().length, 1, 'slow startup does not consume a retry or request another ticket');
      socket.message({ type: 'ready', sessionId: 'cold-desktop', readOnly: false, display: { width: 1280, height: 800 } });
      assert.match(panel.text(), /正在准备桌面画面/u);
      child.mock.timers.tick(280); await flush();
      assert.equal(panel.tickets().length, 1, 'ready metadata still waits for the first JPEG on the same connection');
      socket.message({ type: 'frame', seq: 1, width: 1280, height: 800 }); socket.message(new ArrayBuffer(8)); await flush();
      assert.equal(panel.drawn.length, 1);
      assert.match(panel.text(), /正在控制云电脑/u);
      assert.doesNotMatch(panel.text(), /首次或休眠后|正在准备桌面画面/u);
      child.mock.timers.tick(30_000); await flush();
      assert.equal(panel.tickets().length, 1, 'displayed first frame cancels the old deadline');
      assert.equal(panel.sockets.length, 1);
      assert.equal(socket.readyState, 1);
    });
  }
});

test('只有 ready 元数据没有 JPEG 时仍保留 12 秒截止，不无限等待', async t => {
  const panel = panelHarness(t);
  await flush(); panel.click('只读旁观'); await flush();
  const socket = panel.sockets.at(-1); socket.open();
  t.mock.timers.tick(3000); await flush();
  socket.message({ type: 'ready', sessionId: 'no-frame', readOnly: true, display: { width: 1280, height: 800 } });
  t.mock.timers.tick(8999); await flush();
  assert.equal(panel.tickets().length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(socket.readyState, 3);
  t.mock.timers.tick(1000); await flush();
  assert.equal(panel.tickets().length, 2);
});

test('等待首帧时关闭原生标签会取消截止和重连，旧 ready 不能恢复控制', async t => {
  const panel = panelHarness(t);
  await flush(); panel.click('连接云电脑'); await flush();
  const socket = panel.sockets.at(-1); socket.open();
  t.mock.timers.tick(6000); await flush();
  panel.unmount(); await flush();
  socket.message({ type: 'ready', sessionId: 'late', readOnly: false, display: { width: 1280, height: 800 } });
  t.mock.timers.tick(120_000); await flush();
  assert.equal(panel.tickets().length, 1);
  assert.equal(panel.sockets.length, 1);
  assert.doesNotMatch(panel.text(), /正在控制云电脑|无法连接云电脑/u);
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


test('未开通给出开通引导，空目录只展示一个检查入口，没有凭据字段或可手填的助理标识', async t => {
  for (const options of [{ configured: false }, { bots: [] }]) {
    await t.test(JSON.stringify(options), async child => {
    const panel = panelHarness(child, options); await flush();
    const nodes = panel.nodes();
    assert.equal(nodes.some(node => node.type === 'select'), false);
    assert.equal(nodes.some(node => node.type === 'input' && node.props['aria-label'] === 'Bot ID'), false);
    // 未开通时是引导页：开通 + 检查两个入口；已开通但目录为空时只需要重新检查。
    assert.equal(nodes.filter(node => node.type === 'button').length, options.configured === false ? 2 : 1);
    if (options.configured === false) assert.equal(nodes.some(node => node.props['data-personal-assistant-onboarding'] === 'true'), true);
    assert.match(panel.text(), /检查开通状态/u);
    assert.doesNotMatch(panel.visibleText(), /API Key|Personal Assistant|Bot ID|配置云网关|0 fps/u);
    assert.equal(panel.sockets.length, 0);
    });
  }
});

test('界面不展示助理分类或选择器，系统固定使用宿主绑定', async t => {
  const panel = panelHarness(t, { bots: [{ botId: 'researcher', displayName: '研究助理' }, { botId: 'writer', displayName: '写作助理' }] }); await flush();
  const nodes = panel.nodes();
  assert.equal(nodes.some(node => node.type === 'select'), false);
  assert.doesNotMatch(panel.visibleText(), /写作助理|研究助理|默认助理|Bot ID/u);
  assert.equal(nodes.some(node => node.type === 'details' && node.props.open), false);
  assert.equal(panel.sockets.length, 0);
  panel.click('只读旁观'); await flush();
  assert.equal(panel.tickets().at(-1).payload.botId, 'writer', 'directory order cannot change the binding');
});

test('目录超时、旧协议或绑定消失时不让用户填 Bot ID，也不切换到其它助理', async t => {
  for (const options of [
    { directoryError: failure(502, 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE') },
    { directoryError: failure(504, 'PERSONAL_ASSISTANT_DIRECTORY_TIMEOUT') },
    { directoryError: failure(409, 'PERSONAL_ASSISTANT_DIRECTORY_UNSUPPORTED') },
    { bots: [{ botId: 'researcher', displayName: '研究助理' }] },
  ]) await t.test(JSON.stringify(options), async child => {
    const panel = panelHarness(child, options); await flush();
    assert.equal(panel.nodes().some(node => node.type === 'select'), false);
    assert.equal(panel.nodes().some(node => node.type === 'input' && node.props['aria-label'] === '已有助理标识'), false);
    assert.equal(panel.tickets().length, 0);
    assert.doesNotMatch(panel.visibleText(), /使用此助理|默认助理|研究助理/u);
    assert.ok(panel.nodes().some(node => node.type === 'button'), 'one recovery action remains available');
  });
});

test('目录鉴权失败、格式错误和空目录不伪造默认助理', async t => {
  for (const error of [
    failure(401, 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED'),
    failure(403, 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED'),
    failure(403, 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE'),
    failure(401, 'PERSONAL_ASSISTANT_TICKET_REFUSED'),
    failure(502, 'PERSONAL_ASSISTANT_TICKET_INVALID'),
    failure(502, 'PERSONAL_ASSISTANT_DIRECTORY_INVALID'),
  ]) await t.test(`${error.code}-${error.status}`, async child => {
    const panel = panelHarness(child, { directoryError: error }); await flush();
    assert.equal(panel.nodes().some(node => node.type === 'select'), false);
    assert.equal(panel.nodes().some(node => node.type === 'input' && node.props['aria-label'] === '已有助理标识'), false);
    assert.doesNotMatch(panel.visibleText(), /已使用默认助理/u);
    assert.equal(panel.tickets().length, 0);
  });
});

test('目录 WS 关闭码只出现在折叠诊断，刷新成功后移除', async t => {
  const options = { directoryError: Object.assign(failure(403, 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED'), { closeCode: 1008 }) };
  const panel = panelHarness(t, options); await flush();
  assert.match(panel.text(), /目录连接关闭码：1008/u);
  assert.doesNotMatch(panel.visibleText(), /1008/u);
  options.directoryError = null;
  panel.click('检查开通状态'); await flush();
  assert.doesNotMatch(panel.text(), /目录连接关闭码/u);
});
