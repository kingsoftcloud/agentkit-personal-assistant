import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopController } from '../runtime/desktop-session.mjs';

function fakeProcess() { const p = new EventEmitter(); p.exitCode = null; p.killed = false; p.kill = () => { p.killed = true; p.exitCode = 0; p.emit('exit', 0); }; return p; }

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
