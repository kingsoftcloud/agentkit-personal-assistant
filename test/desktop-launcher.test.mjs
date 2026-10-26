import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDesktopLauncherServer, requestDesktopLaunch } from '../runtime/desktop-launcher.mjs';

const raw = (path, text) => new Promise((resolve, reject) => {
  const socket = createConnection(path); let body = '';
  socket.once('connect', () => socket.write(text)); socket.on('error', reject);
  socket.on('data', chunk => { body += chunk; }); socket.once('end', () => resolve(JSON.parse(body)));
});

test('本地应用入口使用私有 socket，仅固定枚举可以到达回调', async () => {
  const called = [];
  const launcher = await createDesktopLauncherServer({ launch: async action => { called.push(action); } });
  try {
    assert.equal((await stat(dirname(launcher.socketPath))).mode & 0o777, 0o700);
    assert.equal((await stat(launcher.socketPath)).mode & 0o777, 0o600);
    for (const action of ['browser', 'terminal', 'files']) await requestDesktopLaunch(launcher.socketPath, action);
    for (const request of [{ v: 1, action: 'browser', url: 'https://example.com' }, { v: 1, action: 'files', path: '/etc' }, { v: 1, action: 'command', command: 'touch /tmp/forbidden' }]) {
      assert.equal((await raw(launcher.socketPath, JSON.stringify(request) + '\n')).code, 'DESKTOP_LAUNCH_INVALID');
    }
    assert.equal((await raw(launcher.socketPath, 'x'.repeat(257) + '\n')).code, 'DESKTOP_LAUNCH_INVALID');
    assert.deepEqual(called, ['browser', 'terminal', 'files']);
  } finally { await launcher.close(); }
});

test('入口超时发出取消信号，关闭不被未完成应用回调阻塞且拒绝后续连接', async () => {
  const errors = [];
  let signal, finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const launcher = await createDesktopLauncherServer({ timeoutMs: 30, onError: error => errors.push(error), launch: async (_, options) => { signal = options.signal; entered(); await new Promise(resolve => { finish = resolve; }); } });
  const pending = requestDesktopLaunch(launcher.socketPath, 'browser');
  await started;
  await assert.rejects(pending, { code: 'DESKTOP_LAUNCH_TIMEOUT' });
  assert.equal(signal.aborted, true);
  assert.deepEqual(errors, [{ action: 'browser', code: 'DESKTOP_LAUNCH_TIMEOUT' }]);
  await launcher.close();
  await assert.rejects(requestDesktopLaunch(launcher.socketPath, 'files'), { code: 'DESKTOP_LAUNCH_UNAVAILABLE' });
  finish();
});

test('主动关闭取消在途入口，晚到回调不能报告成功或重开 socket', async () => {
  let signal, finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const launcher = await createDesktopLauncherServer({ launch: async (_, options) => { signal = options.signal; entered(); await new Promise(resolve => { finish = resolve; }); } });
  const pending = requestDesktopLaunch(launcher.socketPath, 'browser');
  const rejected = assert.rejects(pending, { code: 'DESKTOP_LAUNCH_CLOSED' });
  await started;
  await launcher.close();
  assert.equal(signal.aborted, true);
  await rejected;
  finish();
  await assert.rejects(stat(launcher.socketPath), { code: 'ENOENT' });
});
