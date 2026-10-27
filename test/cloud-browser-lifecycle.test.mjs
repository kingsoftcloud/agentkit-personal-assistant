import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createCloudBrowser } from '../runtime/cloud-browser.mjs';

async function fixture(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'pa-browser-lifecycle-'));
  const transports = [], commands = [];
  let targetNumber = 0;
  const transportFactory = async () => {
    const page = { url: 'about:blank', title: 'Example Domain' };
    const targets = new Set();
    const transport = { disposed: false, page, targets, connection: {
      closed: false,
      async send(method, params) {
        commands.push({ method, params });
        await options.onSend?.(method, params);
        if (method === 'Target.createTarget') { page.url = params.url; const targetId = `target-${++targetNumber}`; targets.add(targetId); return { targetId }; }
        if (method === 'Target.getTargetInfo') {
          if (!targets.has(params.targetId)) throw Object.assign(new Error('No target with given id found'), { code: 'ASSISTANT_BROWSER_CDP_ERROR' });
          return { targetInfo: { targetId: params.targetId } };
        }
        if (method === 'Target.closeTarget') { targets.delete(params.targetId); return {}; }
        if (method === 'Target.attachToTarget') return { sessionId: `page-${transports.length}` };
        // 桌面模式会确认目标真的落在窗口里；默认假桌面窗口存在，个别用例用
        // windowless 选项模拟“进程还在但没有窗口”的残留状态。
        if (method === 'Browser.getWindowForTarget') {
          // windowlessTransports 表示前 N 个浏览器实例处于“进程在、窗口没了”的状态。
          if (transports.length <= (options.windowlessTransports || 0)) throw Object.assign(new Error('Target does not have a browser window'), { code: 'ASSISTANT_BROWSER_CDP_ERROR' });
          return { windowId: 1, bounds: { left: 520, top: 90, width: 740, height: 620, windowState: options.windowState || 'normal' } };
        }
        if (method === 'Page.navigate') { page.url = params.url; return {}; }
        if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.readyState' ? 'complete'
          : params.expression.includes('performance.getEntries') ? []
            : params.expression.includes('getBoundingClientRect') ? { found: true, left: 20, top: 30, width: 40, height: 50 }
              : { ...page, text: 'visible browser', links: [] } } };
        return {};
      },
    }, async dispose() { this.disposed = true; this.connection.closed = true; } };
    transports.push(transport); return transport;
  };
  const browser = createCloudBrowser({ workspace, env: { AGENTKIT_CHROMIUM: process.execPath, AGENTKIT_DESKTOP_MODE: '1' }, transportFactory, ...options });
  t.after(async () => { await browser.dispose(); await rm(workspace, { recursive: true, force: true }); });
  return { browser, transports, commands };
}

test('可见桌面十二分钟无 CDP 操作后仍保留浏览器和最后页面', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { browser, transports, commands } = await fixture(t, { idleTimeoutMs: 60_000 });
  await browser.open('https://example.com/?retained=desktop');
  t.mock.timers.tick(12 * 60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transports.length, 1); assert.equal(transports[0].disposed, false);
  assert.equal(commands.some(command => command.method === 'Browser.close'), false);
  assert.equal((await browser.snapshot()).url, 'https://example.com/?retained=desktop');
});

test('CDP 异常断开后在同一浏览器管理器恢复最后合法 URL，不回到空白页', async t => {
  const { browser, transports, commands } = await fixture(t);
  await browser.open('https://example.com/?recover=last-visible-page');
  transports[0].connection.closed = true;
  const view = await browser.openDesktopWindow();
  assert.equal(view.url, 'https://example.com/?recover=last-visible-page');
  assert.equal(transports[0].disposed, true); assert.equal(transports.length, 2);
  assert.deepEqual(commands.filter(command => command.method === 'Target.createTarget').map(command => command.params.url),
    ['about:blank', 'https://example.com/?recover=last-visible-page']);
  assert.equal((await browser.snapshot()).url, view.url);
});

test('人工导航后的快照更新最后已知 URL，异常恢复不回到旧工具地址', async t => {
  const { browser, transports, commands } = await fixture(t);
  await browser.open('https://example.com/?old=tool');
  transports[0].page.url = 'https://example.org/?new=human';
  assert.equal((await browser.snapshot()).url, 'https://example.org/?new=human');
  transports[0].connection.closed = true;
  assert.equal((await browser.openDesktopWindow()).url, 'https://example.org/?new=human');
  assert.equal(commands.filter(command => command.method === 'Target.createTarget').at(-1).params.url, 'https://example.org/?new=human');
});

test('非桌面浏览器仍按原有超时关闭，显式关闭不会恢复旧页面', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { browser, transports, commands } = await fixture(t, { env: { AGENTKIT_CHROMIUM: process.execPath }, idleTimeoutMs: 1000 });
  await browser.open('https://example.com/');
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(transports[0].disposed, true);
  assert.ok(commands.some(command => command.method === 'Browser.close'));
  await assert.rejects(browser.snapshot(), { code: 'ASSISTANT_BROWSER_NOT_OPEN' });
});

test('每次 CDP 写操作前执行控制权钩子，拒绝后不会发送任何输入', async t => {
  let humanControlled = false; const checks = [];
  const { browser, commands } = await fixture(t, { beforeCommand: async command => {
    checks.push(command);
    if (humanControlled) throw Object.assign(new Error('人类正在控制云电脑'), { status: 409, code: 'COMPUTER_USER_CONTROLLED' });
  } });
  await browser.open('https://example.com/');
  assert.ok(checks.some(command => command.method === 'Page.navigate' && command.scope === 'page'));
  humanControlled = true;
  await assert.rejects(browser.type({ text: 'must not appear' }), { status: 409, code: 'COMPUTER_USER_CONTROLLED' });
  assert.equal(commands.some(command => command.method === 'Input.insertText'), false);
  assert.equal(checks.at(-1).method, 'Input.insertText');
});

test('已被人类接管的旧调用不能先重建浏览器再被权限钩子拒绝', async t => {
  let humanControlled = false;
  const { browser, transports, commands } = await fixture(t, { beforeCommand: async () => {
    if (humanControlled) throw Object.assign(new Error('人类正在控制云电脑'), { status: 409, code: 'COMPUTER_USER_CONTROLLED' });
  } });
  humanControlled = true;
  await assert.rejects(browser.open('https://example.com/'), { status: 409 });
  assert.equal(transports.length, 0, '未授权调用不能启动 Chromium 或创建窗口');
  humanControlled = false;
  await browser.open('https://example.com/?retained=before-revoke');
  transports[0].connection.closed = true;
  humanControlled = true;
  await assert.rejects(browser.snapshot(), { status: 409 });
  assert.equal(transports.length, 1, '旧 agent 不能在新控制者工作时重建已断开的浏览器');
  assert.equal(commands.filter(command => command.method === 'Target.createTarget').length, 1);
});

for (const blockingMethod of ['Target.closeTarget', 'Browser.close']) {
  test(`工具关闭停在 ${blockingMethod} ACK 时接管，不能继续关闭/kill 用户浏览器`, async t => {
    let humanControlled = false, reached, proceed;
    const barrier = new Promise(resolve => { proceed = resolve; });
    const blocked = new Promise(resolve => { reached = resolve; });
    const { browser, transports, commands } = await fixture(t, {
      beforeCommand: async () => { if (humanControlled) throw Object.assign(new Error('用户控制中'), { status: 409, code: 'COMPUTER_USER_CONTROLLED' }); },
      onSend: async method => { if (method === blockingMethod && !humanControlled) { reached(); await barrier; } },
    });
    await browser.open('https://example.com/?keep=browser');
    const closing = browser.close();
    const refused = assert.rejects(closing, { status: 409, code: 'COMPUTER_USER_CONTROLLED' });
    try {
      await blocked;
      humanControlled = true;
      await browser.releaseInput();
      proceed(); await refused;
      assert.equal(transports[0].disposed, false, '工具取消后不能 orphan/kill 仍活着的 transport');
      assert.equal(commands.filter(command => command.method === 'Browser.close').length, blockingMethod === 'Browser.close' ? 1 : 0);
      humanControlled = false;
      assert.equal((await browser.snapshot()).url, 'https://example.com/?keep=browser', '被拒绝的关闭不能清空 URL 或 transport 引用');
    } finally { proceed(); }
  });
}

for (const kind of ['mouse', 'key']) {
  test(`CDP ${kind} down ACK 未返回时接管，先完成清理 up 再让人类输入`, async t => {
    let humanControlled = false, reached, proceed;
    const barrier = new Promise(resolve => { proceed = resolve; });
    const blocked = new Promise(resolve => { reached = resolve; });
    const { browser, commands } = await fixture(t, {
      beforeCommand: async () => { if (humanControlled) throw Object.assign(new Error('用户控制中'), { status: 409, code: 'COMPUTER_USER_CONTROLLED' }); },
      onSend: async (method, params) => {
        if (params.type === (kind === 'mouse' ? 'mousePressed' : 'rawKeyDown')) { reached(); await barrier; }
      },
    });
    await browser.open('https://example.com/');
    const operation = kind === 'mouse' ? browser.click({ selector: '#target' }) : browser.press({ key: 'Enter' });
    const refused = assert.rejects(operation, { status: 409, code: 'COMPUTER_USER_CONTROLLED' });
    try {
      await blocked; humanControlled = true;
      const cleaned = await browser.releaseInput();
      assert.equal(kind === 'mouse' ? cleaned.releasedButtons : cleaned.releasedKeys, 1);
      const types = commands.filter(command => command.method.startsWith('Input.dispatch')).map(command => command.params.type);
      assert.deepEqual(types, kind === 'mouse' ? ['mousePressed', 'mouseReleased'] : ['rawKeyDown', 'keyUp']);
      proceed(); await refused;
      assert.equal(commands.filter(command => command.params.type === (kind === 'mouse' ? 'mouseReleased' : 'keyUp')).length, 1,
        '旧回合不得在清理后再发一个 up 抬起人类的新手势');
    } finally { proceed(); }
  });
}

test('CDP 清理 up 失败不忘记 held 状态，显式重试成功后才允许交接', async t => {
  let failRelease = true, reached, proceed;
  const barrier = new Promise(resolve => { proceed = resolve; });
  const blocked = new Promise(resolve => { reached = resolve; });
  const { browser } = await fixture(t, { onSend: async (_method, params) => {
    if (params.type === 'mousePressed') { reached(); await barrier; }
    if (params.type === 'mouseReleased' && failRelease) throw new Error('fixture cleanup failed');
  } });
  await browser.open('https://example.com/');
  const clicking = browser.click({ selector: '#target' });
  const refused = assert.rejects(clicking, { status: 409 });
  try {
    await blocked;
    await assert.rejects(browser.releaseInput(), { code: 'ASSISTANT_BROWSER_INPUT_RELEASE_FAILED', status: 503 });
    failRelease = false;
    assert.equal((await browser.releaseInput()).releasedButtons, 1);
    proceed(); await refused;
  } finally { proceed(); }
});

test('已通过异步权限钩子但尚未真正发送的旧命令仍会被本地代次封住', async t => {
  let checks = 0, reached, proceed;
  const barrier = new Promise(resolve => { proceed = resolve; });
  const blocked = new Promise(resolve => { reached = resolve; });
  const { browser, commands } = await fixture(t, { beforeCommand: async command => {
    if (command.method === 'Input.insertText' && ++checks === 2) { reached(); await barrier; }
  } });
  await browser.open('https://example.com/');
  const typing = browser.type({ text: 'stale' });
  const refused = assert.rejects(typing, { status: 409 });
  try {
    await blocked; await browser.releaseInput(); proceed(); await refused;
    assert.equal(commands.some(command => command.method === 'Input.insertText'), false);
  } finally { proceed(); }
});

test('旧 close ACK 未返回时接管，在同一个 Chromium 上立即恢复替代页面', { timeout: 2000 }, async t => {
  const owner = new AsyncLocalStorage();
  let humanControlled = false, reached, proceed, blockedOnce = false;
  const barrier = new Promise(resolve => { proceed = resolve; });
  const blocked = new Promise(resolve => { reached = resolve; });
  t.after(() => proceed());
  const { browser, transports, commands } = await fixture(t, {
    beforeCommand: async () => {
      if (owner.getStore() === 'agent' && humanControlled) throw Object.assign(new Error('用户控制中'), { status: 409, code: 'COMPUTER_USER_CONTROLLED' });
    },
    onSend: async method => { if (method === 'Target.closeTarget' && !blockedOnce) { blockedOnce = true; reached(); await barrier; } },
  });
  const url = 'https://example.com/?restore=handoff';
  await browser.open(url);
  const oldTarget = commands.find(command => command.method === 'Target.attachToTarget').params.targetId;
  const closing = owner.run('agent', () => browser.close());
  const refused = assert.rejects(closing, { status: 409, code: 'COMPUTER_USER_CONTROLLED' });
  await blocked;
  humanControlled = true;
  await browser.releaseInput();
  const opened = await Promise.all([browser.openDesktopWindow(), browser.openDesktopWindow()]);
  assert.deepEqual(opened.map(value => value.url), [url, url]);
  assert.equal(commands.filter(command => command.method === 'Target.createTarget').length, 2, '并发接管只创建一个替代 page');
  const newTarget = commands.filter(command => command.method === 'Target.attachToTarget').at(-1).params.targetId;
  assert.notEqual(oldTarget, newTarget);
  assert.equal(transports[0].targets.size, 2, '不等待旧 close ACK，就能完成新的页面准备');
  assert.equal(transports.length, 1); assert.equal(transports[0].disposed, false);
  proceed(); await refused;
  assert.equal(transports[0].targets.has(oldTarget), false);
  assert.equal(transports[0].targets.has(newTarget), true, '旧 close 的迟到 ACK 不能清掉新 target');
  assert.equal((await browser.snapshot()).url, url);
  assert.equal(commands.some(command => command.method === 'Browser.close'), false);
});

test('人工关掉 page 后只重建当前目标，不重启 Chromium 或丢掉最后 URL', async t => {
  const { browser, transports, commands } = await fixture(t);
  const url = 'https://example.com/?restore=closed-window';
  await browser.open(url);
  const oldTarget = commands.find(command => command.method === 'Target.attachToTarget').params.targetId;
  transports[0].targets.delete(oldTarget);
  assert.equal((await browser.openDesktopWindow()).url, url);
  assert.equal(commands.filter(command => command.method === 'Target.createTarget').length, 2);
  assert.equal(transports.length, 1); assert.equal(transports[0].disposed, false);
  assert.equal(commands.some(command => command.method === 'Browser.close'), false);
});

test('页面探测遇到未知网络错误不能当作目标消失而静默重建', async t => {
  const { browser, commands } = await fixture(t, { onSend: async method => {
    if (method === 'Target.getTargetInfo') throw Object.assign(new Error('fixture CDP network failure'), { code: 'ASSISTANT_BROWSER_CDP_ERROR' });
  } });
  await browser.open('https://example.com/');
  await assert.rejects(browser.openDesktopWindow(), { code: 'ASSISTANT_BROWSER_CDP_ERROR' });
  assert.equal(commands.filter(command => command.method === 'Target.createTarget').length, 1);
});

test('浏览器进程还在但窗口没了时补开新窗口，必要时重启一次自有 Chromium', async t => {
  // 第一个实例是“进程在、窗口没了”的残留状态：新建窗口也不落地，
  // 必须回收并重新拉起，否则点 dock 只会一直等到 WINDOW_UNAVAILABLE。
  const { browser, transports, commands } = await fixture(t, { windowlessTransports: 1 });
  const view = await browser.openDesktopWindow();
  assert.equal(view.url, 'about:blank');
  assert.equal(transports.length, 2, '无窗口残留实例必须被回收并重新拉起');
  assert.equal(transports[0].disposed, true);
  assert.equal(transports[1].disposed, false);
  const recoveries = commands.filter(command => command.method === 'Target.createTarget' && command.params.newWindow === true);
  assert.equal(recoveries.length, 2, '替代页面必须显式开新窗口：只建标签页在无窗口浏览器里也不可见');
  assert.equal(commands.some(command => command.method === 'Browser.close'), false, '不追加多余的 Browser.close');
});

test('窗口仍在但被最小化时不新建窗口也不重启浏览器', async t => {
  // 最小化窗口的 windowId 依然存在，属于桌面层要恢复的可见性，不是浏览器层重开。
  const { browser, transports, commands } = await fixture(t, { windowState: 'minimized' });
  await browser.openDesktopWindow();
  assert.equal(transports.length, 1);
  assert.equal(transports[0].disposed, false);
  assert.equal(commands.filter(command => command.method === 'Target.createTarget').length, 1, '最小化窗口不能触发重复开窗');
});

test('新实例仍拿不到窗口时明确失败，不假装打开成功', async t => {
  const { browser } = await fixture(t, { windowlessTransports: 2 });
  await assert.rejects(browser.openDesktopWindow(), { code: 'ASSISTANT_BROWSER_DESKTOP_WINDOW_UNAVAILABLE' });
});
