import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopControl } from '../src/client/desktop-control.mjs';

function control(t) {
  const packets = [], errors = [];
  const machine = createDesktopControl({ send: value => { packets.push(value); return true; }, failed: message => errors.push(message) });
  t.after(() => machine.dispose());
  machine.reset({ controlAvailable: true, readOnly: true, controlEpoch: 0 });
  return { machine, packets, errors };
}
test('ten first-click handoffs replay down/move/up exactly once after acknowledgement without reopening a socket', t => {
  const { machine, packets } = control(t);
  for (let i = 0; i < 10; i++) {
    const epoch = i * 2;
    assert.equal(machine.input({ type: 'pointermove', x: 5, y: 5 }), false);
    machine.input({ type: 'button', action: 'down', button: 1, x: 80, y: 90 });
    machine.input({ type: 'pointermove', x: 81, y: 91 });
    machine.input({ type: 'button', action: 'up', button: 1 });
    assert.equal(packets.filter(row => row.type === 'input').length, i * 3);
    machine.accept({ readOnly: false, controlAvailable: true, controlEpoch: epoch + 1 });
    assert.equal(packets.filter(row => row.type === 'input').length, (i + 1) * 3);
    assert.deepEqual(packets.filter(row => row.type === 'input').slice(-3).map(row => row.event.type), ['button', 'pointermove', 'button']);
    assert.ok(packets.filter(row => row.type === 'input').slice(-3).every(row => row.controlEpoch === epoch + 1));
    machine.release(); machine.accept({ readOnly: true, controlAvailable: true, controlEpoch: epoch + 2 });
  }
  assert.equal(packets.filter(row => row.type === 'control.acquire').length, 10);
  assert.equal(packets.filter(row => row.type === 'control.release').length, 10);
  assert.equal(packets.some(row => row.type === 'open' || row.type === 'close'), false);
});
test('clicking outside before acquire finishes cancels buffered input and releases the late grant', t => {
  const { machine, packets } = control(t);
  machine.input({ type: 'button', action: 'down', button: 1 }); machine.release();
  machine.accept({ readOnly: false, controlAvailable: true, controlEpoch: 1 });
  assert.equal(packets.some(row => row.type === 'input'), false);
  assert.deepEqual(packets.at(-1), { type: 'control.release', controlEpoch: 1 });
  machine.accept({ readOnly: true, controlAvailable: true, controlEpoch: 2 });
  assert.equal(machine.snapshot.phase, 'observe');
});
test('read-only authorization, stale acknowledgements and conflicts cannot leak input', t => {
  const { machine, packets } = control(t);
  machine.reset({ controlAvailable: false, readOnly: true, controlEpoch: 8 });
  assert.equal(machine.input({ type: 'text', text: 'blocked' }), false);
  machine.accept({ readOnly: false, controlAvailable: true, controlEpoch: 7 });
  assert.deepEqual(packets, []);
  machine.reset({ controlAvailable: true, readOnly: true, controlEpoch: 8 }); machine.acquire();
  machine.reject({ status: 409, readOnly: true, controlEpoch: 8 });
  assert.equal(machine.snapshot.phase, 'observe'); assert.equal(packets.some(row => row.type === 'input'), false);
});
test('30ms text coalescing flushes before key/pointer/release barriers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { machine, packets } = control(t);
  machine.acquire(); machine.accept({ readOnly: false, controlAvailable: true, controlEpoch: 1 });
  for (const text of 'hello你好') machine.input({ type: 'text', text });
  assert.equal(packets.some(row => row.type === 'input'), false);
  t.mock.timers.tick(30);
  assert.equal(packets.at(-1).event.text, 'hello你好');
  machine.input({ type: 'text', text: 'last' }); machine.input({ type: 'key', action: 'down', key: 'Return' });
  assert.deepEqual(packets.slice(-2).map(row => row.event.type), ['text', 'key']);
  machine.input({ type: 'text', text: 'end' }); machine.release();
  assert.equal(packets.at(-2).event.text, 'end'); assert.equal(packets.at(-1).type, 'control.release');
});
