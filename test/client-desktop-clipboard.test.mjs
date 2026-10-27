/**
 * 云电脑剪贴板（面板侧）：本地 ⇄ 云端的编排、WS 请求通道与两个可见入口。
 * 云端 desktop-ws 尚未合入时，超时兜底必须给准确提示，不能假装成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DesktopClipboardControls,
  MAX_CLIPBOARD_BYTES,
  clipboardFriendlyError,
  clipboardTextOf,
  copyCloudClipboard,
  createClipboardChannel,
  isPasteShortcut,
  pasteShortcutEvents,
  pasteToCloud,
  readLocalClipboard,
  writeLocalClipboard,
} from '../src/client/components/desktop-clipboard.mjs';

const clipboardError = (code, message) => Object.assign(new Error(message || code), { code });
const collect = () => { const messages = []; return { messages, notify: message => messages.push(message) }; };

test('云端桌面是 Linux：粘贴快捷键固定 Control_L+v，host 是 macOS 也不发 Command', () => {
  assert.deepEqual(pasteShortcutEvents().map(event => `${event.action}:${event.key}`),
    ['down:Control_L', 'down:v', 'up:v', 'up:Control_L']);
  assert.ok(Object.isFrozen(pasteShortcutEvents()));
});

test('只听 ⌘V / Ctrl+V；裸 v、带 Shift、输入法组合期间都不抢', () => {
  assert.equal(isPasteShortcut({ key: 'v', metaKey: true, preventDefault() {} }), true);
  assert.equal(isPasteShortcut({ key: 'V', ctrlKey: true }), true);
  assert.equal(isPasteShortcut({ key: 'v' }), false);
  assert.equal(isPasteShortcut({ key: 'v', ctrlKey: true, shiftKey: true }), false);
  assert.equal(isPasteShortcut({ key: 'v', metaKey: true, altKey: true }), false);
  assert.equal(isPasteShortcut({ key: 'v', metaKey: true, isComposing: true }), false);
  assert.equal(isPasteShortcut({ key: 'v', metaKey: true, nativeEvent: { isComposing: true } }), false);
  assert.equal(isPasteShortcut(null), false);
});

test('浏览器拒绝读本地剪贴板时给可照做的中文提示，不抛英文原文', async () => {
  assert.equal(await readLocalClipboard({ clipboard: { readText: async () => '待粘贴' } }), '待粘贴');
  await assert.rejects(readLocalClipboard({ clipboard: { readText: async () => { throw new Error('NotAllowedError'); } } }),
    /浏览器不允许读取剪贴板，请点「粘贴」按钮再试/);
  await assert.rejects(readLocalClipboard({ clipboard: {} }), /当前环境不允许读取剪贴板/);
  let written = '';
  await writeLocalClipboard('复制回来的', { clipboard: { writeText: async text => { written = text; } } });
  assert.equal(written, '复制回来的');
  await assert.rejects(writeLocalClipboard('x', { clipboard: { writeText: async () => { throw new Error('denied'); } } }),
    /浏览器不允许写入剪贴板/);
});

test('粘贴 = 读本地 → 写云端 → 合成 Ctrl+V → 提示成功', async () => {
  const { messages, notify } = collect();
  const calls = [];
  const result = await pasteToCloud({
    readLocal: async () => '来自本机的文字',
    writeCloud: async text => { calls.push(['writeCloud', text]); return { written: true }; },
    sendKeys: events => { calls.push(['sendKeys', events.map(event => event.key)]); return true; },
    notify,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    ['writeCloud', '来自本机的文字'],
    ['sendKeys', ['Control_L', 'v', 'v', 'Control_L']],
  ]);
  assert.deepEqual(messages, ['已粘贴到云电脑']);
});

test('本地剪贴板为空/超 64KiB/被拒绝时不写云端，并保留内容不被静默丢掉', async () => {
  const empty = collect();
  const writes = [];
  assert.deepEqual(await pasteToCloud({ readLocal: async () => '', writeCloud: async text => { writes.push(text); }, notify: empty.notify }),
    { ok: false, code: 'CLIPBOARD_EMPTY' });
  assert.deepEqual(empty.messages, ['本地剪贴板是空的，没有可粘贴的内容']);

  const denied = collect();
  const deniedResult = await pasteToCloud({
    readLocal: async () => { throw clipboardError('CLIPBOARD_READ_DENIED', '浏览器不允许读取剪贴板，请点「粘贴」按钮再试'); },
    writeCloud: async text => { writes.push(text); }, notify: denied.notify,
  });
  assert.equal(deniedResult.ok, false);
  assert.match(denied.messages[0], /浏览器不允许读取剪贴板/);

  const oversize = collect();
  assert.equal((await pasteToCloud({ readLocal: async () => 'x'.repeat(MAX_CLIPBOARD_BYTES + 1), writeCloud: async () => {}, notify: oversize.notify })).code, 'CLIPBOARD_TOO_LARGE');
  assert.match(oversize.messages[0], /64 KiB/);
  assert.deepEqual(writes, []);
});

test('只读旁观时按键发不出去：内容已到云端剪贴板，但明确提示还差接管', async () => {
  const { messages, notify } = collect();
  const result = await pasteToCloud({
    readLocal: async () => '文字',
    writeCloud: async () => ({ written: true }),
    sendKeys: () => false,
    notify,
  });
  assert.deepEqual(result, { ok: true, code: 'CLIPBOARD_KEY_NOT_SENT' });
  assert.match(messages[0], /没有控制权/);
  assert.match(messages[0], /Ctrl\+V/);
});

test('复制 = 读云端 → 写本地 → 提示成功；云端空/失败都有明确提示', async () => {
  const ok = collect();
  const written = [];
  const result = await copyCloudClipboard({
    readCloud: async () => ({ text: '云端的文字' }),
    writeLocal: async text => { written.push(text); },
    notify: ok.notify,
  });
  assert.deepEqual(result, { ok: true, text: '云端的文字' });
  assert.deepEqual(written, ['云端的文字']);
  assert.deepEqual(ok.messages, ['已复制到本地']);

  const empty = collect();
  assert.equal((await copyCloudClipboard({ readCloud: async () => ({ text: '' }), writeLocal: async () => {}, notify: empty.notify })).code, 'CLIPBOARD_EMPTY');
  assert.match(empty.messages[0], /云电脑剪贴板是空的/);

  const denied = collect();
  assert.equal((await copyCloudClipboard({
    readCloud: async () => { throw clipboardError('COMPUTER_LEASE_REQUIRED', 'COMPUTER_LEASE_REQUIRED'); },
    writeLocal: async () => {}, notify: denied.notify,
  })).ok, false);
  assert.equal(denied.messages[0], '需要先点画面接管云电脑，才能读写云端剪贴板');
});

test('clipboardRead 返回 { text } 与裸字符串都能处理，错误码翻译成中文', () => {
  assert.equal(clipboardTextOf({ text: 'a' }), 'a');
  assert.equal(clipboardTextOf('b'), 'b');
  assert.equal(clipboardTextOf(null), '');
  assert.equal(clipboardFriendlyError(clipboardError('DESKTOP_READ_ONLY')), '需要先点画面接管云电脑，才能读写云端剪贴板');
  assert.equal(clipboardFriendlyError(clipboardError('DESKTOP_SESSION_NOT_FOUND')), '云电脑已空闲或断开，请先恢复画面再试');
  assert.equal(clipboardFriendlyError(clipboardError('CLIPBOARD_TEXT_TOO_LARGE')), '剪贴板内容超过 64 KiB，云电脑剪贴板放不下');
  assert.equal(clipboardFriendlyError({ message: 'socket closed' }), 'socket closed');
  assert.equal(clipboardFriendlyError({}), '剪贴板操作失败，请重试');
});

test('WS 通道按 requestId 关联回复；读/写都走同一契约', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const channel = createClipboardChannel({ send: message => { sent.push(message); return true; } });
  const reading = channel.read();
  const writing = channel.write('写进云端');
  assert.deepEqual(sent.map(message => message.type), ['clipboard.read', 'clipboard.write']);
  assert.equal(sent[1].text, '写进云端');
  assert.match(sent[0].requestId, /^[A-Za-z0-9_-]{1,80}$/);
  assert.notEqual(sent[0].requestId, sent[1].requestId);

  assert.equal(channel.accept({ type: 'clipboard.response', requestId: sent[0].requestId, ok: true, value: { text: '云端的' } }), true);
  assert.deepEqual(await reading, { text: '云端的' });
  channel.accept({ type: 'clipboard.response', requestId: sent[1].requestId, ok: true, value: { written: true } });
  assert.deepEqual(await writing, { written: true });
  assert.equal(channel.size, 0);
  assert.equal(channel.accept({ type: 'frame', seq: 1 }), false, '非剪贴板消息不消费');
  assert.equal(channel.accept({ type: 'clipboard.response', requestId: 'unknown', ok: true }), false);
});

test('handoff 会话按 input 的约定带上 controlEpoch；没有控制代次时不塞字段', async () => {
  const withEpoch = [];
  const channel = createClipboardChannel({ send: message => { withEpoch.push(message); return true; }, controlEpoch: () => 7 });
  const reading = channel.read();
  channel.accept({ type: 'clipboard.response', requestId: withEpoch[0].requestId, ok: true, value: { text: '' } });
  await reading;
  assert.equal(withEpoch[0].controlEpoch, 7);

  const withoutEpoch = [];
  const plain = createClipboardChannel({ send: message => { withoutEpoch.push(message); return true; } });
  const writing = plain.write('x');
  plain.accept({ type: 'clipboard.response', requestId: withoutEpoch[0].requestId, ok: true, value: { written: true } });
  await writing;
  assert.equal('controlEpoch' in withoutEpoch[0], false);
});

test('旧版云端不认 clipboard 消息：5 秒超时给「版本较旧」提示，不转圈、不假装成功', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = createClipboardChannel({ send: () => true });
  const reading = channel.read();
  t.mock.timers.tick(5000);
  await assert.rejects(reading, error => {
    assert.equal(error.code, 'CLIPBOARD_TIMEOUT');
    assert.match(error.message, /云端助理版本较旧，剪贴板通道未启用（重新部署后可用）/);
    return true;
  });
  assert.equal(channel.size, 0);
});

test('socket 未连接时立即失败；连接关闭时在途请求全部失败', async () => {
  const channel = createClipboardChannel({ send: () => false });
  await assert.rejects(channel.read(), { code: 'CLIPBOARD_UNAVAILABLE' });
  assert.equal(channel.size, 0);

  const pending = createClipboardChannel({ send: () => true });
  const reading = pending.read(); const writing = pending.write('x');
  pending.rejectAll();
  await assert.rejects(reading, { code: 'CLIPBOARD_CLOSED' });
  await assert.rejects(writing, { code: 'CLIPBOARD_CLOSED' });
  assert.equal(pending.size, 0);
});

test('错误回复保留云端错误码，供中文化使用', async () => {
  const sent = [];
  const channel = createClipboardChannel({ send: message => { sent.push(message); return true; } });
  const reading = channel.read();
  channel.accept({ type: 'clipboard.response', requestId: sent[0].requestId, ok: false, error: { code: 'COMPUTER_LEASE_REQUIRED', message: 'lease required', status: 409 } });
  await assert.rejects(reading, error => {
    assert.equal(error.code, 'COMPUTER_LEASE_REQUIRED');
    assert.equal(clipboardFriendlyError(error), '需要先点画面接管云电脑，才能读写云端剪贴板');
    return true;
  });
});

/** 极简 React 运行时：这个组件只用到 createElement/useState/useRef。 */
function renderControls(t, props = {}) {
  const hooks = [], record = { toasts: [] }; let cursor = 0, dirty = true, tree;
  const R = {
    createElement(type, elementProps, ...children) { return { type, props: elementProps || {}, children: children.flat() }; },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ||= { current: initial }; },
  };
  const render = () => { cursor = 0; dirty = false; tree = DesktopClipboardControls({ React: R, ...props, notify: props.notify || (message => record.toasts.push(message)) }); };
  const settle = async () => { for (let i = 0; i < 20; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } return tree; };
  const all = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(all)] : [];
  render();
  return {
    settle, record,
    button: label => all(tree).find(node => node.type === 'button' && node.props['aria-label'] === label),
    flatText: () => all(tree).map(node => (Array.isArray(node.children) ? node.children : []).filter(child => typeof child === 'string')).flat().join(' '),
  };
}

test('面板两个入口：粘贴按钮走本地→云端，复制按钮走云端→本地，并显示中文轻提示', async t => {
  const view = renderControls(t, {
    readLocal: async () => '本机文字',
    writeLocal: async () => {},
    readCloud: async () => ({ text: '云端文字' }),
    writeCloud: async () => ({ written: true }),
    sendKeys: () => true,
    toast: '',
  });
  await view.settle();
  assert.ok(view.button('粘贴到云电脑') && view.button('复制云电脑剪贴板'));

  view.button('粘贴到云电脑').props.onClick();
  await view.settle();
  assert.deepEqual(view.record.toasts, ['已粘贴到云电脑']);

  view.button('复制云电脑剪贴板').props.onClick();
  await view.settle();
  assert.deepEqual(view.record.toasts, ['已粘贴到云电脑', '已复制到本地']);
});

test('本地剪贴板读不到时，按钮给出可照做的提示且不调用云端写入', async t => {
  const writes = [];
  const view = renderControls(t, {
    readLocal: async () => { throw clipboardError('CLIPBOARD_READ_DENIED', '浏览器不允许读取剪贴板，请点「粘贴」按钮再试'); },
    writeLocal: async () => {},
    readCloud: async () => ({ text: '' }),
    writeCloud: async text => { writes.push(text); },
    sendKeys: () => true,
    toast: '',
  });
  await view.settle();
  view.button('粘贴到云电脑').props.onClick();
  await view.settle();
  assert.match(view.record.toasts[0], /浏览器不允许读取剪贴板，请点「粘贴」按钮再试/);
  assert.deepEqual(writes, []);
});
