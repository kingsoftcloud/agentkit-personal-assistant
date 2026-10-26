import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopSocketWriter, DESKTOP_MAX_PENDING_BYTES, createCloudSessionSocketWriter, CLOUD_SESSION_MAX_PENDING_BYTES } from '../runtime/desktop-ws.mjs';

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

test('独立文件会话容纳512KiB响应，慢连接仍有1MiB上限；桌面维持两帧上限', () => {
  const socket = new EventEmitter();
  socket.destroyed = false; socket.writableLength = 0;
  socket.write = packet => { socket.writableLength += packet.length; return false; };
  socket.destroy = () => { socket.destroyed = true; };
  const packet = Buffer.from(JSON.stringify({ data: Buffer.alloc(512 * 1024).toString('base64') }));
  assert.ok(packet.length > DESKTOP_MAX_PENDING_BYTES);
  const writer = createCloudSessionSocketWriter(socket);
  assert.equal(writer.write(packet), true);
  assert.equal(writer.ready, false);
  socket.writableLength = CLOUD_SESSION_MAX_PENDING_BYTES - 1;
  assert.equal(writer.write(Buffer.alloc(2)), false);
  assert.equal(socket.destroyed, true);
  writer.dispose(); assert.equal(socket.listenerCount('drain'), 0);
});
