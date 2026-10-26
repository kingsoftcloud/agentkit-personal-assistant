import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startCdpTransport, launchChromium } from '../runtime/cloud-browser-cdp.mjs';

class OpenSocket extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  close() { this.dispatchEvent(new Event('close')); }
}
class FailedSocket extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
  close() {}
}
async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-private-profile-'));
  await writeFile(join(directory, 'sentinel'), 'private-fixture');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('持久配置必须显式给绝对目录，不能把自动临时目录意外保留', async () => {
  await assert.rejects(launchChromium({ preserveUserDataDir: true }), { code: 'ASSISTANT_BROWSER_PROFILE_INVALID' });
  await assert.rejects(startCdpTransport({ preserveUserDataDir: true }), { code: 'ASSISTANT_BROWSER_PROFILE_INVALID' });
});

for (const preserveUserDataDir of [false, true]) {
  test(`${preserveUserDataDir ? '持久桌面' : '普通临时'}配置在 dispose 和连接失败后的清理契约`, async t => {
    for (const failConnect of [false, true]) {
      const userDataDir = await profile(t);
      const options = { userDataDir, preserveUserDataDir, endpoint: 'ws://127.0.0.1:9999/devtools/browser/fixture', WebSocketImpl: failConnect ? FailedSocket : OpenSocket };
      if (failConnect) await assert.rejects(startCdpTransport(options), { code: 'ASSISTANT_BROWSER_CDP_UNAVAILABLE' });
      else await (await startCdpTransport(options)).dispose();
      if (preserveUserDataDir) assert.equal(await readFile(join(userDataDir, 'sentinel'), 'utf8'), 'private-fixture');
      else await assert.rejects(readFile(join(userDataDir, 'sentinel')), { code: 'ENOENT' });
    }
  });
}

test('持久配置启动只清过期端口文件，不删除其他配置或 SingletonLock', async t => {
  const userDataDir = await profile(t);
  await writeFile(join(userDataDir, 'DevToolsActivePort'), '9999\n/devtools/browser/stale\n');
  await writeFile(join(userDataDir, 'SingletonLock'), 'owned-fixture-do-not-remove');
  let stalePresent;
  const child = new EventEmitter(); child.pid = undefined; child.exitCode = null; child.stderr = new EventEmitter();
  const launched = await launchChromium({ chromium: '/fixture/chromium', userDataDir, preserveUserDataDir: true,
    spawn() { stalePresent = existsSync(join(userDataDir, 'DevToolsActivePort')); writeFileSync(join(userDataDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fresh\n'); return child; },
  });
  assert.equal(stalePresent, false); assert.equal(launched.endpoint.port, 9333);
  assert.equal(await readFile(join(userDataDir, 'SingletonLock'), 'utf8'), 'owned-fixture-do-not-remove');
  assert.equal(await readFile(join(userDataDir, 'sentinel'), 'utf8'), 'private-fixture');
});

test('自有旧 child 未退出时，第二次启动不得清端口元数据或争抢同一个 profile', async t => {
  const userDataDir = await profile(t), child = new EventEmitter();
  child.pid = 12345; child.exitCode = null; child.stderr = new EventEmitter();
  await launchChromium({ chromium: '/fixture/chromium', userDataDir, preserveUserDataDir: true,
    spawn() { writeFileSync(join(userDataDir, 'DevToolsActivePort'), '9333\n/devtools/browser/live\n'); return child; },
  });
  try {
    await assert.rejects(launchChromium({ chromium: '/fixture/chromium', userDataDir, preserveUserDataDir: true, spawn() { assert.fail('不能启动第二个 Chromium'); } }), { code: 'ASSISTANT_BROWSER_PROCESS_STILL_RUNNING' });
    assert.equal(await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8'), '9333\n/devtools/browser/live\n');
  } finally { child.exitCode = 0; child.emit('exit', 0); }
});

test('持久配置连接失败先 kill 并等自己的 child 退出，再允许调用方恢复目录', async t => {
  const userDataDir = await profile(t), child = new EventEmitter();
  child.pid = 12345; child.exitCode = null; child.signalCode = null; child.stderr = new EventEmitter();
  let killed, settled = false;
  const killedEvent = new Promise(resolve => { killed = resolve; });
  const pending = startCdpTransport({ chromium: '/fixture/chromium', userDataDir, preserveUserDataDir: true, WebSocketImpl: FailedSocket,
    spawn() { writeFileSync(join(userDataDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fresh\n'); return child; },
    kill(pid) { assert.equal(pid, 12345); killed(); },
  });
  const rejected = assert.rejects(pending.finally(() => { settled = true; }), { code: 'ASSISTANT_BROWSER_CDP_UNAVAILABLE' });
  await killedEvent; await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false, '不能 kill 后立刻返回并让新进程争抢同一 profile');
  child.exitCode = 137; child.emit('exit', 137);
  await rejected;
  assert.equal(await readFile(join(userDataDir, 'sentinel'), 'utf8'), 'private-fixture');
});

test('持久配置 dispose 等正常退出落盘，停止失败的拒绝不会被第二次调用吞掉', async t => {
  for (const canExit of [true, false]) {
    const userDataDir = await profile(t), child = new EventEmitter();
    child.pid = 12345; child.exitCode = null; child.signalCode = null; child.stderr = new EventEmitter();
    let kills = 0;
    class Socket extends OpenSocket {
      close() { super.close(); if (canExit) setTimeout(() => { child.exitCode = 0; child.emit('exit', 0); }, 20); }
    }
    const transport = await startCdpTransport({ chromium: '/fixture/chromium', userDataDir, preserveUserDataDir: true, WebSocketImpl: Socket,
      spawn() { writeFileSync(join(userDataDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fresh\n'); return child; },
      kill() { kills++; throw Object.assign(new Error('fixture signal denied'), { code: 'EPERM' }); },
    });
    const pending = transport.dispose();
    assert.equal(transport.dispose(), pending, '并发和失败重入必须共享同一个停止结果');
    if (canExit) { await pending; assert.equal(kills, 0); }
    else { await assert.rejects(pending, { code: 'ASSISTANT_BROWSER_PROCESS_STILL_RUNNING' }); await assert.rejects(transport.dispose(), { code: 'ASSISTANT_BROWSER_PROCESS_STILL_RUNNING' }); assert.equal(kills, 1); }
    assert.equal(await readFile(join(userDataDir, 'sentinel'), 'utf8'), 'private-fixture');
  }
});
