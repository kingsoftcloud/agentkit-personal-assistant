import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

test('real broker binds lease acquire/renew/release to Bot and task', async t => {
  const portHolder = createServer();
  await new Promise(resolve => portHolder.listen(0, '127.0.0.1', resolve));
  const port = portHolder.address().port;
  await new Promise(resolve => portHolder.close(resolve));
  const child = spawn(process.execPath, ['runtime/computer-agentd.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, AGENTKIT_DESKTOP_MODE: '0', COMPUTER_HOST: '127.0.0.1', COMPUTER_PORT: String(port), USER_ID: 'u', ASSISTANT_ID: 'a', COMPUTER_ID: 'c' }, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode !== null) return; child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let count = 0; count < 100; count++) { try { ready = (await fetch(`${base}/health`)).ok; } catch {} if (ready) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(ready, true);
  const identity = { userId: 'u', assistantId: 'a', computerId: 'c', botId: 'b1', taskId: 'task1' };
  const post = async (path, data) => { const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...identity, ...data }) }); return { status: response.status, data: await response.json() }; };
  const first = await post('/broker/lease/acquire', { ttlMs: 60000, idempotencyKey: 'first', leaseId: 'caller-controlled-id' });
  assert.equal(first.status, 200);
  assert.notEqual(first.data.lease.leaseId, 'caller-controlled-id');
  const leaseId = first.data.lease.leaseId;
  assert.equal((await post('/broker/lease/acquire', { ttlMs: 60000, idempotencyKey: 'first' })).data.lease.leaseId, leaseId);
  assert.equal((await post('/broker/lease/acquire', { botId: 'b2', taskId: 'task2' })).status, 409);
  assert.equal((await post('/broker/lease/renew', { botId: 'b2', leaseId })).status, 409);
  assert.equal((await post('/broker/desktop/session', { botId: 'b2', leaseId })).status, 409);
  assert.equal((await post('/broker/action', { botId: 'b2', leaseId, action: 'stop' })).status, 409);
  assert.equal((await post('/broker/lease/release', { botId: 'b2', leaseId })).data.released, false);
  assert.equal((await post('/broker/lease/renew', { leaseId })).status, 200);
  assert.equal((await post('/broker/lease/release', { leaseId })).data.released, true);
  assert.equal((await post('/broker/lease/acquire', { botId: 'b2', taskId: 'task2' })).status, 200);
});
