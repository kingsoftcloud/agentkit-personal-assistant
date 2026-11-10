/**
 * 云电脑双向剪贴板的验收用例：回声去重、超长文本策略、连续粘贴、静默失败与权限降级。
 * 与 test/client-desktop-clipboard.test.mjs 的分工：
 * 那边跑基础编排；这里跑「两端来回」与 64 KiB 边界等验收口径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIPBOARD_ECHO_WINDOW_MS,
  MAX_CLIPBOARD_BYTES,
  clipboardFriendlyError,
  copyCloudClipboard,
  createClipboardChannel,
  createClipboardEchoGuard,
  pasteToCloud,
  truncateUtf8,
} from '../src/client/components/desktop-clipboard.mjs';

const clipboardError = (code, message) => Object.assign(new Error(message || code), { code });
const collect = () => { const messages = []; return { messages, notify: message => messages.push(message) }; };
const freshGuard = (now = () => 1_000_000) => createClipboardEchoGuard({ now });

test('粘贴后立刻复制到同一文本：不把回声写回本机，并提示没有新内容', async () => {
  const guard = freshGuard();
  const writes = [];
  await pasteToCloud({
    readLocal: async () => '同一段文本',
    writeCloud: async () => ({ written: true }),
    sendKeys: () => true,
    notify: () => {},
    echoGuard: guard,
  });
  const copied = collect();
  const result = await copyCloudClipboard({
    readCloud: async () => ({ text: '同一段文本' }),
    writeLocal: async text => { writes.push(text); },
    notify: copied.notify,
    echoGuard: guard,
  });
  assert.deepEqual(writes, [], '读回刚写入的内容不能覆盖本机剪贴板');
  assert.deepEqual(copied.messages, ['云电脑剪贴板里还是本机刚粘贴的内容，没有可复制的新内容']);
  assert.equal(result.ok, true);
  assert.equal(result.echoed, true);
  assert.equal(result.text, '同一段文本');
});

test('复制云端的不同文本仍然写回本机：回声守卫不误杀真正的复制', async () => {
  const guard = freshGuard();
  await pasteToCloud({
    readLocal: async () => '粘贴的内容',
    writeCloud: async () => ({ written: true }),
    sendKeys: () => true,
    echoGuard: guard,
  });
  const writes = [];
  const copied = collect();
  const result = await copyCloudClipboard({
    readCloud: async () => '云端应用里选中的另一段文字',
    writeLocal: async text => { writes.push(text); },
    notify: copied.notify,
    echoGuard: guard,
  });
  assert.deepEqual(writes, ['云端应用里选中的另一段文字']);
  assert.deepEqual(copied.messages, ['已复制到本地']);
  assert.equal(result.echoed, undefined);
});

test('回声窗口过期后相同文本会重新写回本机', async () => {
  let now = 1_000_000;
  const guard = createClipboardEchoGuard({ now: () => now });
  await pasteToCloud({
    readLocal: async () => '同一段文本',
    writeCloud: async () => ({ written: true }),
    sendKeys: () => true,
    echoGuard: guard,
  });
  now += CLIPBOARD_ECHO_WINDOW_MS + 1;
  const writes = [];
  const copied = collect();
  const result = await copyCloudClipboard({
    readCloud: async () => '同一段文本',
    writeLocal: async text => { writes.push(text); },
    notify: copied.notify,
    echoGuard: guard,
  });
  assert.deepEqual(writes, ['同一段文本'], '超过窗口后用户可能真的复制了同一段文本，不能一直拦截');
  assert.deepEqual(copied.messages, ['已复制到本地']);
  assert.equal(result.echoed, undefined);
});

test('连续三次粘贴不同文本：各自写云端并按顺序合成 Ctrl+V', async () => {
  const guard = freshGuard();
  const writes = [];
  const keyBatches = [];
  for (const text of ['第一段', '第二段', '第三段']) {
    const result = await pasteToCloud({
      readLocal: async () => text,
      writeCloud: async value => { writes.push(value); },
      sendKeys: events => { keyBatches.push(events.map(event => `${event.action}:${event.key}`)); return true; },
      echoGuard: guard,
    });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(writes, ['第一段', '第二段', '第三段'], '连续粘贴不能被合并或丢弃');
  assert.equal(keyBatches.length, 3);
  for (const batch of keyBatches) {
    assert.deepEqual(batch, ['down:Control_L', 'down:v', 'up:v', 'up:Control_L']);
  }
});

test('粘贴 64 KiB 边界：正好 64 KiB 允许，多 1 字节拒绝且不写云端', async () => {
  const exact = 'a'.repeat(MAX_CLIPBOARD_BYTES);
  const allowedWrites = [];
  const allowed = await pasteToCloud({
    readLocal: async () => exact,
    writeCloud: async text => { allowedWrites.push(text); },
    sendKeys: () => true,
    echoGuard: freshGuard(),
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowedWrites.length, 1);
  assert.equal(allowedWrites[0].length, MAX_CLIPBOARD_BYTES);

  const rejectedWrites = [];
  const rejectedMessages = collect();
  const rejected = await pasteToCloud({
    readLocal: async () => `${exact}b`,
    writeCloud: async text => { rejectedWrites.push(text); },
    sendKeys: () => true,
    notify: rejectedMessages.notify,
    echoGuard: freshGuard(),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'CLIPBOARD_TOO_LARGE');
  assert.deepEqual(rejectedWrites, [], '超限内容不能先写一半再被云端拒绝');
  assert.match(rejectedMessages.messages[0], /超过 64 KiB/);
});

test('云端内容超过 64 KiB：按 UTF-8 边界截断后写本机，并明确提示只复制了前 64 KiB', async () => {
  const long = '汉'.repeat(30_000); // 90000 字节，超过 64 KiB
  const writes = [];
  const copied = collect();
  const result = await copyCloudClipboard({
    readCloud: async () => long,
    writeLocal: async text => { writes.push(text); },
    notify: copied.notify,
    echoGuard: freshGuard(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(writes.length, 1);
  assert.ok(Buffer.byteLength(writes[0], 'utf8') <= MAX_CLIPBOARD_BYTES);
  assert.ok(Buffer.byteLength(writes[0], 'utf8') > MAX_CLIPBOARD_BYTES - 4, '只截掉边界上的半个字符，不多截');
  assert.equal(writes[0].endsWith('汉'), true, '不能产生半个汉字');
  assert.equal(writes[0].includes('\uFFFD'), false);
  assert.match(copied.messages[0], /超过 64 KiB，已复制前 64 KiB/);
  assert.equal(truncateUtf8('a'.repeat(10), 5), 'aaaaa');
  assert.equal(truncateUtf8('汉', 2), '', '放不下一个完整字符时返回空串而不是坏字符');
});

test('写入云端成功但合成 Ctrl+V 抛错：明确提示需要手动粘贴，不静默假成功', async () => {
  const messages = [];
  const result = await pasteToCloud({
    readLocal: async () => '需要粘贴的文字',
    writeCloud: async () => ({ written: true }),
    sendKeys: () => { throw new Error('input channel blocked'); },
    notify: message => messages.push(message),
    echoGuard: freshGuard(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'CLIPBOARD_KEY_FAILED');
  assert.match(messages[0], /已写入云电脑剪贴板/);
  assert.match(messages[0], /请手动在云桌面粘贴/);
});

test('权限/占用失败端到端：通道回复 403/409 时粘贴与复制都给出可照做的提示', async () => {
  const channelWith = code => {
    const sent = [];
    const channel = createClipboardChannel({
      send: message => {
        sent.push(message);
        channel.accept({ type: 'clipboard.response', requestId: message.requestId, ok: false, error: { code, message: code, status: 409 } });
        return true;
      },
    });
    return { channel, sent };
  };

  const pasteChannel = channelWith('DESKTOP_READ_ONLY');
  const pasteMessages = collect();
  const pasted = await pasteToCloud({
    readLocal: async () => '文字',
    writeCloud: text => pasteChannel.channel.write(text),
    sendKeys: () => true,
    notify: pasteMessages.notify,
    echoGuard: freshGuard(),
  });
  assert.equal(pasted.ok, false);
  assert.equal(pasted.code, 'CLIPBOARD_WRITE_FAILED');
  assert.equal(pasteMessages.messages[0], '需要先点画面接管云电脑，才能读写云端剪贴板');
  assert.equal(pasteChannel.sent.length, 1);
  assert.equal(pasteChannel.sent[0].type, 'clipboard.write');
  assert.equal(pasteChannel.channel.size, 0, '失败后不能留下在途请求');

  const copyChannel = channelWith('DESKTOP_CONTROL_EPOCH_CHANGED');
  const copyMessages = collect();
  const copyWrites = [];
  const copied = await copyCloudClipboard({
    readCloud: () => copyChannel.channel.read(),
    writeLocal: async text => { copyWrites.push(text); },
    notify: copyMessages.notify,
    echoGuard: freshGuard(),
  });
  assert.equal(copied.ok, false);
  assert.equal(copied.code, 'CLIPBOARD_READ_FAILED');
  assert.equal(copyMessages.messages[0], '需要先点画面接管云电脑，才能读写云端剪贴板');
  assert.deepEqual(copyWrites, []);
  assert.equal(copyChannel.channel.size, 0);
});

test('Host 剪贴板错误码有可照做的中文：超长/不可用/超时/未连接都不显示技术原文', () => {
  assert.equal(clipboardFriendlyError(clipboardError('PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE', '本机剪贴板暂时不可用')),
    '剪贴板内容超过 64 KiB，无法同步到本机');
  assert.equal(clipboardFriendlyError(clipboardError('PERSONAL_ASSISTANT_CLIPBOARD_UNAVAILABLE')),
    '本机剪贴板暂时不可用，请稍后重试或手动复制');
  assert.equal(clipboardFriendlyError(clipboardError('CLIPBOARD_TIMEOUT')),
    '云端助理版本较旧，剪贴板通道未启用（重新部署后可用）');
  assert.equal(clipboardFriendlyError(clipboardError('CLIPBOARD_UNAVAILABLE')),
    '云电脑尚未连接，剪贴板暂不可用');
});
