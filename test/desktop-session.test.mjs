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
