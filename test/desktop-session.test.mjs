import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDesktopController as createDesktopControllerWithWmProbe, createMjpegFrameParser } from '../runtime/desktop-session.mjs';

function fakeProcess() { const p = new EventEmitter(); p.exitCode = null; p.killed = false; p.kill = () => { p.killed = true; p.exitCode = 0; p.emit('exit', 0); }; return p; }
const readyWindowProperties = '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400001\n_NET_ACTIVE_WINDOW(WINDOW): window id # 0x800002\n';
// 采集/输入等用例的假桌面已就绪；启动竞态用例直接使用原始控制器和受控 EWMH 响应。
function createDesktopController(options) {
  return createDesktopControllerWithWmProbe({ ...options, exec: (file, ...args) => file === 'xprop'
    ? Promise.resolve({ stdout: readyWindowProperties }) : options.exec(file, ...args) });
}

test('X11 可连接但 WM 尚未发布活动窗口时，不得提前返回可操作桌面', async () => {
  let ready = false, resolved = false, started;
  const launched = new Promise(resolve => { started = resolve; });
  const controller = createDesktopControllerWithWmProbe({
    readWindowBindings: async () => Buffer.from('OnDesktop Mouse1 :HideMenus\n'),
    spawn(file) { if (file === 'fluxbox') started(); return fakeProcess(); },
    exec: async file => ({ stdout: file === 'xprop'
      ? ready ? readyWindowProperties : '_NET_ACTIVE_WINDOW:  no such atom on any window.\n'
      : '' }),
  });
  const opening = controller.openSession({ identity: {} }).then(value => { resolved = true; return value; });
  try {
    await launched;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(resolved, false, 'Xvfb/Fluxbox 进程存在不能代替 WM/EWMH 就绪');
    ready = true;
    const session = await opening;
    assert.ok(session.sessionId);
  } finally { ready = true; await opening.catch(() => {}); await controller.dispose(); }
});

test('WM 存在但活动窗口为空时超时失败，清理桌面后允许重新启动', async () => {
  let ready = false; const children = [];
  const controller = createDesktopControllerWithWmProbe({
    windowManagerReadyTimeoutMs: 120,
    readWindowBindings: async () => Buffer.from('OnDesktop Mouse1 :HideMenus\n'),
    spawn(file) { const child = fakeProcess(); children.push({ file, child }); return child; },
    exec: async file => ({ stdout: file === 'xprop' ? ready ? readyWindowProperties
      : '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400001\n_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n' : '' }),
  });
  try {
    await assert.rejects(controller.openSession({ identity: {} }), { code: 'DESKTOP_WINDOW_MANAGER_UNAVAILABLE', status: 503 });
    assert.equal(controller.stats().sessions, 0);
    assert.ok(children.every(({ child }) => child.killed), '失败后不能保留半启动的桌面');
    ready = true;
    assert.ok((await controller.openSession({ identity: {} })).sessionId);
    assert.equal(children.filter(({ file }) => file === 'Xvfb').length, 2);
  } finally { await controller.dispose(); }
});

for (const mode of ['exit', 'error']) {
  test(`Fluxbox 启动${mode === 'exit' ? '退出' : '报错'}必须失败，不能继续返回桌面 ready`, async () => {
    const children = [];
    const controller = createDesktopControllerWithWmProbe({
      windowManagerReadyTimeoutMs: 120,
      readWindowBindings: async () => Buffer.from('OnDesktop Mouse1 :HideMenus\n'),
      spawn(file) {
        const child = fakeProcess(); children.push(child);
        if (file === 'fluxbox') queueMicrotask(() => {
          if (mode === 'exit') { child.exitCode = 1; child.emit('exit', 1); }
          else child.emit('error', Object.assign(new Error('spawn fluxbox ENOENT'), { code: 'ENOENT' }));
        });
        return child;
      },
      exec: async file => ({ stdout: file === 'xprop' ? readyWindowProperties : '' }),
    });
    try {
      await assert.rejects(controller.openSession({ identity: {} }), { code: 'DESKTOP_WINDOW_MANAGER_UNAVAILABLE', status: 503 });
      assert.equal(controller.stats().sessions, 0);
      assert.ok(children.every(child => child.exitCode !== null || child.killed));
    } finally { await controller.dispose(); }
  });
}

test('窗口管理器逐字复制系统默认绑定，并使用独立 HOME 而非继承旧配置', async () => {
  const defaults = Buffer.from('# 完整系统默认值\nOnTitlebar Mouse1 :MacroCmd {Raise} {Focus} {ActivateTab}\nMod4 c :Exec xcalc\n');
  let reads = 0, launched;
  const controller = createDesktopController({
    readWindowBindings: async path => { assert.equal(path, '/etc/X11/fluxbox/keys'); reads++; return defaults; },
    spawn(file, args, options) { if (file === 'fluxbox') launched = { args, options }; return fakeProcess(); },
    exec: async () => ({ stdout: '' }),
  });
  try {
    const first = await controller.openSession({ identity: {} });
    assert.equal(reads, 1);
    const home = launched.options.env.HOME;
    assert.notEqual(home, process.env.HOME);
    assert.deepEqual(await readFile(join(home, '.fluxbox', 'keys')), defaults, '不能用内嵌最小集替代镜像的完整默认绑定');
    const config = await readFile(join(home, 'init'), 'utf8');
    assert.ok(config.includes(`session.keyFile: ${join(home, '.fluxbox', 'keys')}`));
    assert.ok(config.includes('session.screen0.clickRaises: true'));
    const style = await readFile(join(home, 'style'), 'utf8');
    for (const name of ['menu.title.font', 'menu.frame.font', 'menu.hilite.font', 'window.font', 'toolbar.clock.font', 'toolbar.workspace.font']) {
      assert.match(style, new RegExp(`${name}: Noto Sans CJK SC-`));
    }
    assert.equal(launched.options.env.LANG, 'C.UTF-8');
    assert.equal(launched.options.env.LC_ALL, 'C.UTF-8');
    controller.closeSession(first.sessionId);
    await controller.openSession({ identity: {} });
    assert.equal(reads, 1, '同一桌面启动期间不重复准备窗口管理器');
  } finally { await controller.dispose(); }
});

test('只有系统绑定文件缺失才回退到最小集，其他读取错误必须失败且可再次初始化', async () => {
  let code = 'ENOENT', reads = 0, launched;
  const controller = createDesktopController({
    readWindowBindings: async () => { reads++; throw Object.assign(new Error('fixture read failed'), { code }); },
    spawn(file, args, options) { if (file === 'fluxbox') launched = options; return fakeProcess(); },
    exec: async () => ({ stdout: '' }),
  });
  try {
    await controller.openSession({ identity: {} });
    assert.equal(reads, 1);
    const keys = await readFile(join(launched.env.HOME, '.fluxbox', 'keys'), 'utf8');
    assert.ok(keys.includes('Mod1 Tab :NextWindow'));
    assert.ok(keys.includes('OnTitlebar Mouse1'));
  } finally { await controller.dispose(); }

  let readable = false, managers = 0;
  const denied = createDesktopController({
    readWindowBindings: async () => {
      if (!readable) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
      return Buffer.from('Mod4 c :Exec xcalc\n');
    },
    spawn(file) { if (file === 'fluxbox') managers++; return fakeProcess(); },
    exec: async () => ({ stdout: '' }),
  });
  try {
    await assert.rejects(denied.openSession({ identity: {} }), error => error.code === 'EACCES');
    assert.equal(managers, 0, '不能掩盖权限错误后启动不完整配置');
    readable = true;
    await denied.openSession({ identity: {} });
    assert.equal(managers, 1);
  } finally { await denied.dispose(); }
});

test('桌面初始化超过首次清理周期时不会被误判为空闲', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 1_700_000_000_000;
  let ready;
  const readiness = new Promise(resolve => { ready = resolve; });
  const display = fakeProcess();
  const controller = createDesktopController({
    now: () => clock,
    spawn: file => file === 'Xvfb' ? display : fakeProcess(),
    exec: async file => { if (file === 'xdpyinfo') await readiness; return { stdout: '' }; },
  });
  const opening = controller.openSession({ identity: {} });
  try {
    clock += 1500;
    t.mock.timers.tick(1500);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(display.killed, false, '启动未满空闲期限，清理器不得终止 Xvfb');
    ready();
    const session = await opening;
    assert.equal(controller.getSession(session.sessionId)?.sessionId, session.sessionId);
    assert.equal(controller.stats().xserverRunning, true);
  } finally {
    ready();
    await opening.catch(() => {});
    await controller.dispose();
  }
});

test('desktop session captures in memory and rejects read-only input', async () => {
  let now = 1_000; const calls = []; const controller = createDesktopController({ now: () => now, spawn: (...args) => { calls.push(['spawn', ...args]); return fakeProcess(); }, exec: async (file, args) => { calls.push([file, ...args]); return { stdout: file === 'import' ? Buffer.from('jpeg') : Buffer.alloc(0) }; }, capture: async () => Buffer.from('jpeg') });
  const readonly = await controller.openSession({ identity: { userId: 'u', assistantId: 'a', computerId: 'c' } });
  assert.equal(readonly.readOnly, true);
  const frame = await controller.frame({ sessionId: readonly.sessionId });
  assert.equal(frame.format, 'jpeg'); assert.equal(frame.bytes, 4); assert.equal(Buffer.from(frame.data, 'base64').toString(), 'jpeg');
  await assert.rejects(() => controller.input({ sessionId: readonly.sessionId, event: { type: 'button', action: 'click', button: 1 } }), error => error.code === 'COMPUTER_LEASE_REQUIRED' && error.status === 409);
  const writable = await controller.openSession({ identity: { userId: 'u', assistantId: 'a', computerId: 'c' }, controllable: true, leaseId: 'lease', taskId: 'task' });
  await controller.input({ sessionId: writable.sessionId, event: { type: 'button', action: 'click', button: 1, x: 10, y: 20 } });
  assert.ok(calls.some(call => call[0] === 'xdotool' && call.includes('mousemove')));
  controller.closeSessionsForLease('lease');
  assert.equal(controller.getSession(writable.sessionId), undefined);
  controller.dispose();
});

test('desktop frame idle response is bounded and has no disk path', async () => {
  let now = 1_000; let captures = 0; const controller = createDesktopController({ now: () => now, spawn: () => fakeProcess(), exec: async () => ({ stdout: Buffer.alloc(0) }), capture: async () => { captures += 1; return Buffer.from('jpeg'); } });
  const session = await controller.openSession({ identity: { userId: 'u', assistantId: 'a', computerId: 'c' } });
  const first = await controller.frame({ sessionId: session.sessionId }); now += 1100; const idle = await controller.frame({ sessionId: session.sessionId, afterSeq: first.seq });
  assert.equal(captures, 2); assert.equal(idle.path, undefined); assert.equal(idle.format, 'jpeg');
  controller.dispose();
});

test('明确休眠保留窗口和会话、停止采集并释放桌面自动租约，恢复须绑定新租约', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 1000; const processes = [], released = [];
  const controller = createDesktopController({ now: () => clock, idleTimeoutMs: 1000,
    spawn(file) { const p = fakeProcess(); processes.push({ file, p }); return p; },
    exec: async () => ({ stdout: '' }), capture: async () => Buffer.from('jpeg'),
    onIdle: async owner => released.push(owner),
  });
  try {
    const opened = await controller.openSession({ identity: { userId: 'u' }, botId: 'writer', taskId: 't', controllable: true, leaseId: 'old', releaseLeaseOnIdle: true });
    await controller.frameBinary({ sessionId: opened.sessionId });
    await controller.suspendSession(opened.sessionId);
    const idle = controller.getSession(opened.sessionId);
    assert.ok(idle, 'idle is not session deletion'); assert.equal(idle.idle, true); assert.equal(idle.controllable, false); assert.equal(idle.leaseId, null);
    assert.equal(controller.stats().xserverRunning, true); assert.equal(processes.find(x => x.file === 'fluxbox').p.killed, false);
    assert.deepEqual(released, [{ sessionId: opened.sessionId, botId: 'writer', taskId: 't', leaseId: 'old', releaseLeaseOnIdle: true }]);
    await assert.rejects(controller.frameBinary({ sessionId: opened.sessionId }), { code: 'DESKTOP_SESSION_IDLE', status: 409 });
    await assert.rejects(controller.input({ sessionId: opened.sessionId, event: { type: 'text', text: 'forbidden' } }), { status: 409 });
    await controller.resumeSession({ sessionId: opened.sessionId, controllable: true, leaseId: 'new', releaseLeaseOnIdle: true });
    assert.equal(controller.getSession(opened.sessionId).leaseId, 'new');
    assert.equal(controller.getSession(opened.sessionId).idle, false);
    assert.equal(processes.filter(x => x.file === 'Xvfb').length, 1, 'resume keeps original windows');
    assert.equal((await controller.frameBinary({ sessionId: opened.sessionId })).bytes, 4);
  } finally { await controller.dispose(); }
});

test('空闲记录保留期到期后删除，已过期会话不能恢复', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 1000;
  const controller = createDesktopController({ now: () => clock, idleTimeoutMs: 1000, idleRetentionMs: 2000, spawn: fakeProcess, exec: async () => ({ stdout: '' }) });
  try {
    const opened = await controller.openSession({ identity: {}, botId: 'writer', taskId: 't' });
    await controller.suspendSession(opened.sessionId);
    assert.equal(controller.getSession(opened.sessionId).idle, true);
    clock += 2001; t.mock.timers.tick(2000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.getSession(opened.sessionId), undefined);
    await assert.rejects(controller.resumeSession({ sessionId: opened.sessionId }), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
  } finally { await controller.dispose(); }
});

test('旁观三分钟不休眠、关闭观察后十二分钟再开仍复用 X11 和原窗口', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 1000; const children = [], idle = [];
  const controller = createDesktopController({ now: () => clock, idleTimeoutMs: 60_000,
    spawn(file, args, options) { const child = fakeProcess(); children.push({ file, args, options, child }); return child; },
    exec: async () => ({ stdout: '' }), capture: async () => Buffer.from('same-desktop'), onIdle: owner => idle.push(owner),
  });
  try {
    const observer = await controller.openSession({ identity: {} });
    assert.equal(observer.idleMode, 'retain-desktop');
    clock += 3 * 60_000; t.mock.timers.tick(3 * 60_000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.getSession(observer.sessionId).idle, false);
    assert.deepEqual(idle, []);
    assert.equal((await controller.frameBinary({ sessionId: observer.sessionId })).data.toString(), 'same-desktop');
    controller.closeSession(observer.sessionId);
    clock += 12 * 60_000; t.mock.timers.tick(12 * 60_000); await new Promise(resolve => setImmediate(resolve));
    assert.ok(children.every(({ child }) => !child.killed), '没有观察者只能停采集，不能销毁窗口');
    await controller.openSession({ identity: {} });
    for (const file of ['Xvfb', 'fluxbox', 'xterm']) assert.equal(children.filter(child => child.file === file).length, 1);
    const terminal = children.find(child => child.file === 'xterm');
    assert.ok(terminal.args.includes('Noto Sans Mono CJK SC'));
    assert.ok(terminal.args.some(value => value.includes('Shift <Key>Insert')));
    assert.equal(terminal.options.env.LANG, 'C.UTF-8');
    assert.equal(terminal.options.env.LC_ALL, 'C.UTF-8');
  } finally { await controller.dispose(); }
});

test('相邻短英文合并直打，按键是屏障，文本错误仍返回调用方', async () => {
  const calls = [];
  let rejected = false;
  const controller = createDesktopController({ spawn: fakeProcess,
    exec: async (file, args) => { calls.push([file, ...args]); if (file === 'xdotool' && args[0] === 'type' && rejected) throw new Error('fixture typing failure'); return { stdout: '' }; },
  });
  try {
    const opened = await controller.openSession({ identity: {}, controllable: true, leaseId: 'lease' });
    const input = event => controller.input({ sessionId: opened.sessionId, event });
    await Promise.all([input({ type: 'text', text: 'hello' }), input({ type: 'text', text: ' world' }),
      input({ type: 'key', key: 'Enter' }), input({ type: 'text', text: 'next' })]);
    assert.deepEqual(calls.filter(call => call[0] === 'xdotool'), [
      ['xdotool', 'type', '--clearmodifiers', '--delay', '0', '--', 'hello world'],
      ['xdotool', 'keydown', 'Return'], ['xdotool', 'keyup', 'Return'],
      ['xdotool', 'type', '--clearmodifiers', '--delay', '0', '--', 'next'],
    ]);
    rejected = true;
    await assert.rejects(input({ type: 'text', text: 'fail' }), { code: 'DESKTOP_TEXT_INPUT_FAILED' });
  } finally { await controller.dispose(); }
});

test('快速 100 ASCII 与 50 中文文本分别一次粘贴，剪贴板 owner 不重叠', async () => {
  const ascii = '0123456789'.repeat(10), chinese = '你好云电脑'.repeat(10), pasted = [];
  let clipboard, text, owners = 0, maximumOwners = 0;
  const controller = createDesktopController({
    spawn(file) {
      if (file !== 'xclip') return fakeProcess();
      clipboard = fakeProcess(); clipboard.stderr = new EventEmitter(); clipboard.stdin = new EventEmitter();
      clipboard.stdin.end = value => { text = value; owners++; maximumOwners = Math.max(maximumOwners, owners); };
      const kill = clipboard.kill;
      clipboard.kill = () => { if (clipboard.exitCode === null) owners--; kill(); clipboard.emit('close', 0); };
      return clipboard;
    },
    exec: async (file, args) => {
      if (file === 'xclip') { clipboard.stderr.emit('data', Buffer.from('Waiting for selection request number 2\n')); return { stdout: text }; }
      if (file === 'xdotool' && args[0] === 'keydown' && args.includes('v')) { pasted.push(text); clipboard.stderr.emit('data', Buffer.from('Waiting for selection request number 3\n')); }
      return { stdout: '' };
    },
  });
  try {
    const opened = await controller.openSession({ identity: {}, controllable: true, leaseId: 'lease' });
    for (const expected of [ascii, chinese]) await Promise.all([...expected].map(text => controller.input({ sessionId: opened.sessionId, event: { type: 'text', text } })));
    assert.deepEqual(pasted, [ascii, chinese]);
    assert.equal(maximumOwners, 1); assert.equal(owners, 0);
  } finally { await controller.dispose(); }
});

test('持有 Shift 或鼠标拖拽期间直打不清修饰键，切换控制权清理按住状态', async () => {
  const calls = [];
  const controller = createDesktopController({ spawn: fakeProcess, exec: async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; } });
  try {
    const opened = await controller.openSession({ identity: {}, controllable: true, leaseId: 'old' });
    const input = event => controller.input({ sessionId: opened.sessionId, event });
    await input({ type: 'key', key: 'Shift', action: 'down' });
    await input({ type: 'button', button: 1, action: 'down' });
    await input({ type: 'text', text: 'hello' });
    assert.deepEqual(calls.find(call => call[1] === 'type'), ['xdotool', 'type', '--delay', '0', '--', 'hello']);
    const pending = input({ type: 'text', text: 'obsolete' });
    const refused = assert.rejects(pending, { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
    const observer = await controller.setSessionControl({ sessionId: opened.sessionId });
    await refused;
    assert.equal(observer.readOnly, true); assert.equal(observer.controlEpoch, 1);
    assert.ok(calls.some(call => call[1] === 'mouseup' && call[2] === '1'));
    assert.ok(calls.some(call => call[1] === 'keyup' && call[2] === 'Shift_L'));
    assert.equal(calls.some(call => call.includes('obsolete')), false);
    const control = await controller.setSessionControl({ sessionId: opened.sessionId, controllable: true, leaseId: 'new' });
    assert.equal(control.controlEpoch, 2);
    await assert.rejects(controller.input({ sessionId: opened.sessionId, controlEpoch: 0, event: { type: 'button', button: 1 } }), { status: 409 });
    assert.equal((await controller.input({ sessionId: opened.sessionId, controlEpoch: 2, event: { type: 'button', button: 1 } })).accepted, true);
    assert.equal(controller.stats().sessions, 1);
  } finally { await controller.dispose(); }
});

test('binary frames keep JPEG bytes as Buffer and enforce the frame limit', async () => {
  let bytes = Buffer.from('jpeg');
  const controller = createDesktopController({ spawn: () => fakeProcess(), exec: async () => ({ stdout: '' }), capture: async () => bytes });
  const session = await controller.openSession({ identity: {} });
  const first = await controller.frameBinary({ sessionId: session.sessionId });
  assert.equal(first.data, bytes);
  assert.equal(Buffer.isBuffer(first.data), true);
  bytes = Buffer.alloc(307201);
  await assert.rejects(() => controller.frameBinary({ sessionId: session.sessionId }), error => error.code === 'DESKTOP_FRAME_TOO_LARGE');
  controller.dispose();
});

test('UTF-8 paste sends the paste while its clipboard owner is alive and then reaps it', async () => {
  const text = '你好，云电脑 English 😀', calls = [];
  let clipboard, owned = false;
  const controller = createDesktopController({
    spawn(file, args) {
      if (file !== 'xclip') return fakeProcess();
      clipboard = fakeProcess(); clipboard.stderr = new EventEmitter();
      clipboard.stdin = new EventEmitter();
      clipboard.stdin.end = (value, encoding) => { assert.equal(value, text); assert.equal(encoding, 'utf8'); owned = true; };
      const kill = clipboard.kill;
      clipboard.kill = () => { owned = false; kill(); clipboard.emit('close', 0); };
      assert.ok(args.includes('-quiet'));
      return clipboard;
    },
    async exec(file, args) {
      calls.push([file, ...args]);
      if (file === 'xclip') {
        clipboard.stderr.emit('data', Buffer.from('Waiting for selection request number 2\n'));
        return { stdout: text };
      }
      if (file === 'xdotool' && args[0] === 'keydown' && args.includes('v')) {
        assert.equal(owned, true, 'paste must happen before clipboard owner exits');
        clipboard.stderr.emit('data', Buffer.from('Waiting for selection request number 3\n'));
      }
      return { stdout: '' };
    },
  });
  const session = await controller.openSession({ identity: {}, controllable: true, leaseId: 'l' });
  await controller.input({ sessionId: session.sessionId, event: { type: 'text', text } });
  assert.equal(owned, false);
  assert.ok(calls.some(call => call[0] === 'xdotool' && call.includes('v')));
  assert.ok(calls.every(call => !call.includes('--clearmodifiers')));
  controller.dispose();
});

test('keydown and keyup preserve held modifiers until their own keyup', async () => {
  const calls = [];
  const controller = createDesktopController({ spawn: () => fakeProcess(), exec: async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; } });
  const session = await controller.openSession({ identity: {}, controllable: true, leaseId: 'l' });
  const key = (key, action) => controller.input({ sessionId: session.sessionId, event: { type: 'key', key, action } });
  await key('ctrl+Control', 'down'); await key('ctrl+c', 'down'); await key('ctrl+c', 'up');
  const inputs = calls.filter(call => call[0] === 'xdotool');
  assert.deepEqual(inputs, [['xdotool', 'keydown', 'Control_L'], ['xdotool', 'keydown', 'c'], ['xdotool', 'keyup', 'c']]);
  await key('Control', 'up');
  assert.deepEqual(calls.at(-1), ['xdotool', 'keyup', 'Control_L']);
  controller.dispose();
});

test('disconnect releases held mouse buttons and keys without starting another display', async () => {
  const calls = [];
  const controller = createDesktopController({ spawn: (file) => { calls.push(['spawn', file]); return fakeProcess(); }, exec: async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; } });
  const session = await controller.openSession({ identity: {}, controllable: true, leaseId: 'l' });
  await controller.input({ sessionId: session.sessionId, event: { type: 'button', action: 'down', button: 1, x: 10, y: 10 } });
  await controller.input({ sessionId: session.sessionId, event: { type: 'key', action: 'down', key: 'Shift' } });
  assert.equal(controller.closeSession(session.sessionId), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(call => call[0] === 'xdotool' && call[1] === 'mouseup' && call[2] === '1'));
  assert.ok(calls.some(call => call[0] === 'xdotool' && call[1] === 'keyup' && call[2] === 'Shift_L'));
  assert.equal(calls.filter(call => call[0] === 'spawn' && call[1] === 'Xvfb').length, 1);
  assert.ok(calls.every(call => !call.includes('--sync')));
  controller.dispose();
});

test('MJPEG parser handles marker chunk boundaries and drops oversized frames before the next frame', () => {
  const frames = []; let dropped = 0;
  const parse = createMjpegFrameParser({ maxFrameBytes: 16, onFrame: frame => frames.push(frame), onDrop: () => { dropped += 1; } });
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  parse(jpeg.subarray(0, 1)); parse(jpeg.subarray(1, 5)); parse(jpeg.subarray(5));
  parse(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(32)]));
  parse(Buffer.from([0xff])); parse(Buffer.concat([Buffer.from([0xd9]), jpeg]));
  assert.equal(dropped, 1);
  assert.deepEqual(frames, [jpeg, jpeg]);
});

test('viewers share one in-memory collector and the last viewer closing stops it', async () => {
  const calls = [], jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const controller = createDesktopController({
    spawn(file, args) {
      calls.push(['spawn', file, ...args]);
      const child = fakeProcess();
      if (file === 'ffmpeg') { child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); setImmediate(() => child.stdout.emit('data', jpeg)); }
      return child;
    },
    exec: async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; },
  });
  const first = await controller.openSession({ identity: {} });
  assert.deepEqual((await controller.frameBinary({ sessionId: first.sessionId })).data, jpeg);
  for (let i = 0; i < 10; i++) { const viewer = await controller.openSession({ identity: {} }); await controller.frameBinary({ sessionId: viewer.sessionId }); controller.closeSession(viewer.sessionId); }
  for (const file of ['Xvfb', 'fluxbox', 'ffmpeg']) assert.equal(calls.filter(call => call[0] === 'spawn' && call[1] === file).length, 1);
  assert.equal(calls.some(call => call[0] === 'import'), false);
  assert.ok(calls.find(call => call[1] === 'ffmpeg').includes('pipe:1'));
  assert.equal(controller.stats().capturedFrames, 1);
  controller.closeSession(first.sessionId);
  assert.equal(controller.stats().collectorRunning, false);
  await controller.dispose();
});

test('ten seconds without input reduces delivery to at most one new frame per second', async () => {
  let clock = 1000, captures = 0;
  const controller = createDesktopController({ now: () => clock, spawn: () => fakeProcess(), exec: async () => ({ stdout: '' }), capture: async () => { captures += 1; return Buffer.from('jpeg'); } });
  const s = await controller.openSession({ identity: {} });
  const active = await controller.frameBinary({ sessionId: s.sessionId });
  assert.equal(active.nextFrameDelayMs, 80);
  clock += 10001;
  const idle = await controller.frameBinary({ sessionId: s.sessionId });
  assert.equal(idle.nextFrameDelayMs, 1000);
  clock += 100;
  const cached = await controller.frameBinary({ sessionId: s.sessionId, afterSeq: idle.seq });
  assert.equal(cached.unchanged, true);
  assert.equal(cached.nextFrameDelayMs, 1000);
  assert.equal(captures, 2);
  await controller.dispose();
});
