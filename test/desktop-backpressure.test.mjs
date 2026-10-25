import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopSocketWriter, DESKTOP_MAX_PENDING_BYTES } from '../runtime/desktop-ws.mjs';

test('慢客户端阻止继续取帧，drain 后恢复，控制消息也不能无限排队', () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writableLength = 0;
  socket.write = packet => { socket.writableLength += packet.length; return false; };
  socket.destroy = () => { socket.destroyed = true; };
  const writer = createDesktopSocketWriter(socket);
  assert.equal(writer.ready, true);
  assert.equal(writer.write(Buffer.alloc(300 * 1024)), true);
  assert.equal(writer.ready, false);
  socket.writableLength = 0;
  socket.emit('drain');
  assert.equal(writer.ready, true);
  socket.writableLength = DESKTOP_MAX_PENDING_BYTES - 10;
  assert.equal(writer.write(Buffer.alloc(11)), false);
  assert.equal(socket.destroyed, true);
  assert.equal(writer.ready, false);
  writer.dispose();
  assert.equal(socket.listenerCount('drain'), 0);
});
