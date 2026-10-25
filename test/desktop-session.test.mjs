import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDesktopController, createMjpegFrameParser } from '../runtime/desktop-session.mjs';

function fakeProcess() { const p = new EventEmitter(); p.exitCode = null; p.killed = false; p.kill = () => { p.killed = true; p.exitCode = 0; p.emit('exit', 0); }; return p; }

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
