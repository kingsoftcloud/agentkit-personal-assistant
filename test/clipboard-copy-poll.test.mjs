import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCloudClipboard, pasteToCloud, createClipboardEchoGuard } from '../src/client/components/desktop-clipboard.mjs';

const noSleep = async () => {};

/**
 * 用户实测：「浏览器里的正文根本没法复制」。根因是应用把内容发布到 X selection 是异步的，
 * 合成 Ctrl+C 之后立刻读，读到的是旧内容——旧实现会把它当成复制成功写回本机。
 * 这里钉住「读不到变化就明确报没复制」的行为。
 */
test('复制：云端内容变化后才写入本机', async () => {
  const reads = ['旧 的', '旧 的', '网页里选中的中文'];
  const written = [];
  const result = await copyCloudClipboard({
    readCloud: async () => ({ text: reads.shift() ?? '网页里选中的中文' }),
    writeLocal: async text => { written.push(text); },
    previousText: '旧 的',
    sleep: noSleep,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(written, ['网页里选中的中文']);
});

test('复制：云端始终没变化时明确报「没响应复制」，不写本机', async () => {
  const written = [];
  const notices = [];
  let calls = 0;
  const result = await copyCloudClipboard({
    readCloud: async () => { calls += 1; return { text: '复制前的内容' }; },
    writeLocal: async text => { written.push(text); },
    notify: message => notices.push(message),
    previousText: '复制前的内容',
    sleep: noSleep,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CLIPBOARD_NOT_COPIED');
  assert.deepEqual(written, []);
  assert.match(notices.at(-1), /没有响应这次复制/u);
  // 有基线才轮询；至少读过一次并且没有把旧内容当结果。
  assert.ok(calls >= 1);
});

test('复制：没有基线时保持一次读取的老行为', async () => {
  let calls = 0;
  const written = [];
  const result = await copyCloudClipboard({
    readCloud: async () => { calls += 1; return { text: '内容' }; },
    writeLocal: async text => { written.push(text); },
    sleep: noSleep,
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(written, ['内容']);
});

/**
 * 用户实测：「本地往云端粘贴中文就是 ??????????」。云端旧 agentd 会把剪贴板字节按
 * 单一字符集硬解，写进去的中文读回来就变了形。现在写完回读对账，不一致就不粘贴。
 */
test('粘贴：回读一致才合成 Ctrl+V', async () => {
  const sent = [];
  let written = '';
  const result = await pasteToCloud({
    readLocal: async () => '中文粘贴测试',
    writeCloud: async text => { written = text; },
    readCloud: async () => ({ text: '中文粘贴测试' }),
    sendKeys: events => { sent.push(...events); return true; },
    sleep: noSleep,
  });
  assert.equal(result.ok, true);
  assert.equal(written, '中文粘贴测试');
  assert.ok(sent.length > 0);
});

test('粘贴：回读内容被转坏时取消粘贴并给出可读提示', async () => {
  const sent = [];
  const notices = [];
  const result = await pasteToCloud({
    readLocal: async () => '中文粘贴测试',
    writeCloud: async () => {},
    readCloud: async () => ({ text: '??????' }),
    sendKeys: events => { sent.push(...events); return true; },
    notify: message => notices.push(message),
    sleep: noSleep,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CLIPBOARD_ROUNDTRIP_MISMATCH');
  assert.equal(result.actual, '??????');
  assert.deepEqual(sent, [], '读回不一致时不能继续按 Ctrl+V');
  assert.match(notices.at(-1), /转坏|不一致/u);
});

test('粘贴：回读抛错或为空时不阻断流程', async () => {
  for (const readCloud of [async () => { throw Object.assign(new Error('boom'), { code: 'CLIPBOARD_TIMEOUT' }); }, async () => ({ text: '' })]) {
    const sent = [];
    const result = await pasteToCloud({
      readLocal: async () => '中文',
      writeCloud: async () => {},
      readCloud,
      sendKeys: events => { sent.push(...events); return true; },
      sleep: noSleep,
    });
    assert.equal(result.ok, true);
    assert.ok(sent.length > 0);
  }
});

test('粘贴：行尾被云端规范化不算内容变形', async () => {
  const sent = [];
  const result = await pasteToCloud({
    readLocal: async () => 'a\r\nb',
    writeCloud: async () => {},
    readCloud: async () => ({ text: 'a\nb' }),
    sendKeys: events => { sent.push(...events); return true; },
    sleep: noSleep,
  });
  assert.equal(result.ok, true);
  assert.ok(sent.length > 0);
});

test('没有 readCloud 时粘贴行为完全不变', async () => {
  const sent = [];
  const result = await pasteToCloud({
    readLocal: async () => '任意内容',
    writeCloud: async () => {},
    sendKeys: events => { sent.push(...events); return true; },
    sleep: noSleep,
  });
  assert.equal(result.ok, true);
  assert.ok(sent.length > 0);
});

test('回声守卫仍然压过回读对账（同一段刚粘贴的内容不会被写回本机）', async () => {
  const guard = createClipboardEchoGuard({ now: () => 1000 });
  guard.remember('刚粘贴的内容');
  const written = [];
  const result = await copyCloudClipboard({
    readCloud: async () => ({ text: '刚粘贴的内容' }),
    writeLocal: async text => { written.push(text); },
    echoGuard: guard,
    previousText: '复制前的内容',
    sleep: noSleep,
  });
  assert.equal(result.echoed, true);
  assert.deepEqual(written, []);
});
