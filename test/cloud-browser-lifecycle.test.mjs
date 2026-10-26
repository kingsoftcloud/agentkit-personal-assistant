import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCloudBrowser } from '../runtime/cloud-browser.mjs';

async function fixture(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'pa-browser-lifecycle-'));
  const transports = [], commands = [];
  const transportFactory = async () => {
    const page = { url: 'about:blank', title: 'Example Domain' };
    const transport = { disposed: false, page, connection: {
      closed: false,
      async send(method, params) {
        commands.push({ method, params });
        if (method === 'Target.createTarget') { page.url = params.url; return { targetId: `target-${transports.length}` }; }
        if (method === 'Target.attachToTarget') return { sessionId: `page-${transports.length}` };
        if (method === 'Page.navigate') { page.url = params.url; return {}; }
        if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.readyState' ? 'complete'
          : params.expression.includes('performance.getEntries') ? [] : { ...page, text: 'visible browser', links: [] } } };
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
