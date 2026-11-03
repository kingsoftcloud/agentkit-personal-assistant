/**
 * 定时任务可靠性的验收用例（E1/E2/E3）。
 *
 * 验收口径（docs/prototype-implementation-plan.md 第 7 章，缺口见 docs/verification-report.md §2.2）：
 * - E1 幂等认领：多个 runtime 实例共享同一状态目录时，同一任务到点只能成功投递一次；
 * - E2 退避重试：云端不可达（ECONNREFUSED 等）时有限次重试，重试复用同一个 turn，不重复发送；
 * - E3 Bot 删除：任务挂起为 paused 且保留 BOT_NOT_FOUND，Bot 恢复后由 reconcile 重新 arm。
 *
 * 夹具：真实 startAssistantRuntime + 真实状态目录 + 真实 HTTP；只把 turnBridge 与定时器换成可控实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { BotRegistry } from '../src/bot-registry.mjs';
import { createScheduleManager } from '../src/schedule-manager.mjs';
import { startAssistantRuntime } from '../runtime/assistant-runtime.mjs';

const BOTS = [
  { botId: 'writer', systemPromptRevision: 'w1' },
  { botId: 'researcher', systemPromptRevision: 'r1' },
];
const TOKEN = 'fixture-schedule-resilience-token-24';
const READY_TIMEOUT_MS = 4000;

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read) {
  const until = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < until) {
    const value = await read();
    if (value) return value;
    await sleep(10);
  }
  assert.fail('condition did not settle');
}

const readState = async (root, name) => JSON.parse(await readFile(join(root, 'state', `${name}.json`), 'utf8'));

async function boot(t, root, { submitTurn, retry = { attempts: 3, delaysMs: [0, 0] }, registry, registryPath } = {}) {
  const timers = new Map();
  const calls = [];
  const turnBridge = {
    available: true,
    async submitTurn(value) {
      const receipt = await (submitTurn ? submitTurn(value) : null) ?? { accepted: true, execution: 'fixture-bridge', requestId: value.requestId };
      // 只有真正「交给云端」的尝试才计入 calls；抛错的尝试由 submitTurn 注入实现计数。
      calls.push(value);
      return receipt;
    },
    async waitForTurn() { return { status: 'completed', messages: ['scheduled-result'] }; },
  };
  const scheduleManager = createScheduleManager({
    setTimeoutFn(fn, delay) { const id = {}; timers.set(id, { fn, at: Date.now() + delay }); return id; },
    clearTimeoutFn(id) { timers.delete(id); },
  });
  const port = await freePort();
  const handle = await startAssistantRuntime({
    env: {
      USER_ID: 'u1',
      ASSISTANT_ID: 'assistant-1',
      COMPUTER_ID: 'computer-1',
      COMPUTER_BROKER_URL: `http://127.0.0.1:${await freePort()}`,
      AGENTKIT_RUNTIME_HOST: '127.0.0.1',
      AGENTKIT_RUNTIME_PORT: String(port),
      AGENTKIT_RUNTIME_TOKEN: TOKEN,
      WORKSPACE_PATH: root,
      ASSISTANT_STATE_PATH: join(root, 'state'),
      SCHEDULE_RECONCILE_INTERVAL_MS: '0',
      ...(registryPath ? { BOT_REGISTRY_PATH: registryPath } : {}),
    },
    runtime: { scheduleManager, registry, turnBridge, scheduleRetry: retry, scheduleReconcileIntervalMs: 0 },
  });
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const fireDue = async () => {
    for (const [id, timer] of [...timers]) {
      if (timer.at > Date.now()) continue;
      timers.delete(id);
      await timer.fn();
    }
  };
  return { root, port, timers, calls, handle, request, fireDue };
}

test('两个实例共享状态目录同时到点：只成功投递一次，认领锁与代次轮转挡下重复触发', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-schedule-idempotent-'));
  const started = [];
  t.after(async () => {
    for (const fx of started) await fx.handle.close();
    await rm(root, { recursive: true, force: true });
  });

  const first = await boot(t, root, { registry: new BotRegistry({ bots: BOTS }) });
  started.push(first);
  const sessionId = (await first.request('/v1/sessions', { botId: 'writer' })).body.sessionId;
  const runAt = Date.now() + 700;
  const created = await first.request('/v1/schedules', {
    botId: 'writer', scheduleId: 'overlap-once', runAt, sessionId, input: '同一时刻只发一次',
  });
  assert.equal(created.status, 201);
  const originalGeneration = created.body.metadata.generation;

  // 第二个实例在任务已落盘后启动：boot 恢复会把同一条 pending 任务再 arm 一次，
  // 这正是修复前「两个实例各投一次」的复现条件。
  const second = await boot(t, root, { registry: new BotRegistry({ bots: BOTS }) });
  started.push(second);
  assert.equal(second.timers.size, 1, '第二个实例应从持久化状态恢复并 arm 同一任务');

  await sleep(Math.max(0, runAt - Date.now()) + 80);
  await Promise.all([first.fireDue(), second.fireDue()]);
  await Promise.all([first.handle.waitForIdle(), second.handle.waitForIdle()]);

  const row = await eventually(async () => {
    const rows = await readState(root, 'schedules');
    const current = rows.find(item => item.botId === 'writer' && item.scheduleId === 'overlap-once');
    return current && ['completed', 'failed'].includes(current.status) ? current : null;
  });
  assert.equal(row.status, 'completed');
  // 认领成功后必须轮转代次：旧代次的实例不能再 patch 已完成的任务。
  assert.notEqual(row.metadata.generation, originalGeneration, '认领应轮转代次');
  assert.ok(row.metadata.claimToken, '认领应留下 claimToken 供排障');

  const submissions = [...first.calls, ...second.calls];
  assert.equal(submissions.length, 1, '两个实例同时触发只能有一次成功投递');
  assert.equal(submissions[0].botId, 'writer');
  assert.equal(submissions[0].input, '同一时刻只发一次');
  const turns = (await readState(root, 'turns')).filter(item => item.botId === 'writer');
  assert.equal(turns.length, 1, '重复触发不能多建一条 turn');

  // 再等一拍，确认没有实例在后台补发。
  await sleep(40);
  assert.equal([...first.calls, ...second.calls].length, 1);
});

test('首次 ECONNREFUSED 后按退避重试：第三次成功且只产生一条用户消息、一次成功投递', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-schedule-retry-'));
  let attempts = 0;
  const fx = await boot(t, root, {
    registry: new BotRegistry({ bots: BOTS }),
    retry: { attempts: 3, delaysMs: [0, 0] },
    submitTurn: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), { code: 'ECONNREFUSED' });
      return { accepted: true, execution: 'fixture-bridge', requestId: `turn-${attempts}` };
    },
  });
  t.after(async () => { await fx.handle.close(); await rm(root, { recursive: true, force: true }); });

  const sessionId = (await fx.request('/v1/sessions', { botId: 'writer' })).body.sessionId;
  const runAt = Date.now() + 300;
  assert.equal((await fx.request('/v1/schedules', {
    botId: 'writer', scheduleId: 'cloud-flaky', runAt, sessionId, input: '云端抖动后补投',
  })).status, 201);

  await sleep(Math.max(0, runAt - Date.now()) + 60);
  await fx.fireDue();
  await fx.handle.waitForIdle();

  const row = await eventually(async () => {
    const rows = await readState(root, 'schedules');
    const current = rows.find(item => item.botId === 'writer' && item.scheduleId === 'cloud-flaky');
    return current && ['completed', 'failed'].includes(current.status) ? current : null;
  });
  assert.equal(row.status, 'completed');
  assert.equal(attempts, 3, '首次拒绝后应退避重试，直到成功或到达上限');
  assert.equal(fx.calls.length, 1, '重试复用同一个 turn，成功投递只能记一次');
  const turns = (await readState(root, 'turns')).filter(item => item.botId === 'writer');
  assert.equal(turns.length, 1, '重试不能重复创建 turn');
  assert.equal(turns[0].status, 'completed');
  const userMessages = (await readState(root, 'messages')).filter(item => item.botId === 'writer' && item.role === 'user');
  assert.equal(userMessages.length, 1, '重试不能给会话重复插入用户消息');
});

test('Bot 删除后任务挂起 paused 且保留 BOT_NOT_FOUND，Bot 恢复后 reconcile 重新 arm 并成功投递', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-schedule-paused-'));
  const botsPath = join(root, 'bots.json');
  const writeBots = async bots => writeFile(botsPath, `${JSON.stringify(bots)}\n`);
  await writeBots(BOTS);
  // 用真实 BOT_REGISTRY_PATH 启动：Bot 的删除/恢复只动注册表文件，验证会触发 resume 的不是手工状态改写。
  const fx = await boot(t, root, { registryPath: botsPath, retry: { attempts: 1, delaysMs: [0] } });
  t.after(async () => { await fx.handle.close(); await rm(root, { recursive: true, force: true }); });

  const sessionId = (await fx.request('/v1/sessions', { botId: 'writer' })).body.sessionId;
  const runAt = Date.now() + 300;
  assert.equal((await fx.request('/v1/schedules', {
    botId: 'writer', scheduleId: 'bot-vanished', runAt, sessionId, input: 'Bot 恢复后再投',
  })).status, 201);

  // 到点前删除 Bot：注册表文件里没有 writer，reconcile 后 runtime 的注册表同步删除该 Bot。
  await writeBots([{ botId: 'researcher', systemPromptRevision: 'r1' }]);
  await fx.handle.reconcileSchedules();
  await sleep(Math.max(0, runAt - Date.now()) + 60);
  await fx.fireDue();
  await fx.handle.waitForIdle();

  const paused = await eventually(async () => {
    const rows = await readState(root, 'schedules');
    const current = rows.find(item => item.botId === 'writer' && item.scheduleId === 'bot-vanished');
    return current && current.status !== 'pending' && current.status !== 'running' ? current : null;
  });
  assert.equal(paused.status, 'paused', 'Bot 被删除时任务应挂起为 paused，而不是通用失败');
  assert.equal(paused.error, 'BOT_NOT_FOUND', '错误码要保留 BOT_NOT_FOUND，UI 才能说清是 Bot 被删了');
  assert.equal(fx.calls.length, 0, 'Bot 已删除时不得回退投递给主助理或其它 Bot');
  assert.equal(fx.timers.size, 0, '挂起后不能留下会自动重发的定时器');
  // Bot 删除期间 HTTP 层也给出可读错误码（而不是笼统 400）。
  const listed = await fx.request('/v1/schedules?botId=writer');
  assert.equal(listed.status, 404);
  assert.equal(listed.body.error, 'BOT_NOT_FOUND');

  // 恢复 Bot：只写回注册表文件，然后 reconcile 应把 paused 改回 pending 并重新 arm。
  await writeBots(BOTS);
  await fx.handle.reconcileSchedules();
  const resumed = (await readState(root, 'schedules')).find(item => item.botId === 'writer' && item.scheduleId === 'bot-vanished');
  assert.equal(resumed.status, 'pending');
  assert.equal(resumed.error, null);
  assert.equal(fx.timers.size, 1, '恢复 Bot 后应重新 arm 定时器');

  await sleep(20);
  await fx.fireDue();
  await fx.handle.waitForIdle();
  const completed = await eventually(async () => {
    const rows = await readState(root, 'schedules');
    const current = rows.find(item => item.botId === 'writer' && item.scheduleId === 'bot-vanished');
    return current?.status === 'completed' ? current : null;
  });
  assert.equal(completed.status, 'completed');
  assert.equal(fx.calls.length, 1, '恢复后只投递一次，且投给原 Bot');
  assert.equal(fx.calls[0].botId, 'writer');
});
