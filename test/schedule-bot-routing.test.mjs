/**
 * 每 Bot 定时任务投递路由的验收用例。
 *
 * 验收口径（docs/prototype-implementation-plan.md 第 7 章）：
 * - 任务按创建它的 botId 绑定，触发时由该 Bot 发起会话，不串到主助理或其它 Bot；
 * - 多 Bot 并存时各自会话互不干扰；
 * - Bot 被删除后任务不能乱发给别的 Bot；
 * - 云端不可达时只尝试一次、不重复发送（当前无重试，见 docs/verification-report.md §2）。
 *
 * 夹具：真实 startAssistantRuntime + 真实状态目录，只把 turnBridge 和定时器换成可控实现，
 * 这样路由判定（stateStore 按 botId 隔离、requireSession、armSchedule 取 row.botId）都走真实代码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
const TOKEN = 'fixture-schedule-routing-token-at-least-24';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function eventually(read) {
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition did not settle');
}

async function boot(t, { submitTurn } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-schedule-routing-'));
  const timers = new Map();
  const calls = [];
  const registry = new BotRegistry({ bots: BOTS });
  const turnBridge = {
    available: true,
    async submitTurn(value) {
      calls.push(value);
      // 与真实 dsh-session-bridge 一致：Bot 不在注册表里时以 BOT_NOT_FOUND 拒绝，绝不交给别的 Bot。
      if (!registry.list().some(bot => bot.botId === value.botId)) {
        throw Object.assign(new Error(`BOT_NOT_FOUND: ${value.botId}`), { code: 'BOT_NOT_FOUND' });
      }
      if (submitTurn) return submitTurn(value);
      return { accepted: true, execution: 'fixture-bridge', requestId: value.requestId };
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
      COMPUTER_BROKER_URL: 'http://127.0.0.1:8787',
      AGENTKIT_RUNTIME_HOST: '127.0.0.1',
      AGENTKIT_RUNTIME_PORT: String(port),
      AGENTKIT_RUNTIME_TOKEN: TOKEN,
      WORKSPACE_PATH: root,
      ASSISTANT_STATE_PATH: join(root, 'state'),
    },
    runtime: { scheduleManager, registry, turnBridge },
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
  t.after(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, timers, calls, registry, request, fireDue };
}

const createSession = async (fx, botId) => (await fx.request('/v1/sessions', { botId })).body.sessionId;

test('定时任务触发时用创建它的 botId 与该 Bot 会话投递，不退化为主助理', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fx = await boot(t);
  const sessionId = await createSession(fx, 'writer');
  const created = await fx.request('/v1/schedules', {
    botId: 'writer', scheduleId: 'weekly-report', runAt: Date.now() + 1000, sessionId, input: '汇总本周进展',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.botId, 'writer');
  assert.equal(fx.timers.size, 1);

  t.mock.timers.tick(1001);
  await fx.fireDue();
  await eventually(async () => (await fx.request('/v1/schedules?botId=writer')).body.schedules[0]?.status === 'completed');

  assert.equal(fx.calls.length, 1, '一次任务只投递一次');
  const submitted = fx.calls[0];
  assert.equal(submitted.botId, 'writer', '投递必须用创建任务的 Bot，而不是主助理/默认 Bot');
  assert.equal(submitted.sessionId, sessionId, '必须投递到创建时绑定的会话');
  assert.equal(submitted.input, '汇总本周进展');
  assert.match(String(submitted.requestId), /^turn-/u, '投递要走真实 turn，而不是直接调工具');

  const turns = (await fx.request(`/v1/sessions/${sessionId}/turns?botId=writer`)).body.turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'completed');
  assert.equal((await fx.request('/v1/schedules?botId=researcher')).body.schedules.length, 0, '不能给别的 Bot 生成任务');
});

test('同一时刻两个 Bot 的任务各自投递，不串会话', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fx = await boot(t);
  const writerSession = await createSession(fx, 'writer');
  const researcherSession = await createSession(fx, 'researcher');
  const runAt = Date.now() + 1000;
  assert.equal((await fx.request('/v1/schedules', { botId: 'writer', scheduleId: 'same-slot', runAt, sessionId: writerSession, input: '写周报' })).status, 201);
  assert.equal((await fx.request('/v1/schedules', { botId: 'researcher', scheduleId: 'same-slot', runAt, sessionId: researcherSession, input: '查资料' })).status, 201);
  assert.equal(fx.timers.size, 2, '两个 Bot 的同名任务要各自持有定时器');

  t.mock.timers.tick(1001);
  await fx.fireDue();
  await eventually(async () => (await fx.request('/v1/schedules?botId=writer')).body.schedules[0]?.status === 'completed');
  await eventually(async () => (await fx.request('/v1/schedules?botId=researcher')).body.schedules[0]?.status === 'completed');

  assert.equal(fx.calls.length, 2);
  const byBot = new Map(fx.calls.map(call => [call.botId, call]));
  assert.equal(byBot.get('writer').sessionId, writerSession);
  assert.equal(byBot.get('researcher').sessionId, researcherSession);
  assert.equal(byBot.get('writer').input, '写周报');
  assert.equal(byBot.get('researcher').input, '查资料');
  assert.equal((await fx.request(`/v1/sessions/${writerSession}/turns?botId=writer`)).body.turns.length, 1);
  assert.equal((await fx.request(`/v1/sessions/${researcherSession}/turns?botId=researcher`)).body.turns.length, 1);
});

test('任务不能借用其它 Bot 的会话：404 SESSION_NOT_FOUND 且不 arm 定时器', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fx = await boot(t);
  const writerSession = await createSession(fx, 'writer');
  const created = await fx.request('/v1/schedules', {
    botId: 'researcher', scheduleId: 'steal', runAt: Date.now() + 1000, sessionId: writerSession, input: '借用会话',
  });
  assert.equal(created.status, 404);
  assert.equal(created.body.error, 'SESSION_NOT_FOUND');
  assert.equal(fx.timers.size, 0, '创建失败不能留下会触发的定时器');
  assert.equal((await fx.request('/v1/schedules?botId=researcher')).body.schedules.length, 0);
});

test('Bot 被删除后任务不投递给其它 Bot，任务以 BOT_NOT_FOUND 失败且不重发', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fx = await boot(t);
  const writerSession = await createSession(fx, 'writer');
  assert.equal((await fx.request('/v1/schedules', {
    botId: 'writer', scheduleId: 'after-delete', runAt: Date.now() + 1000, sessionId: writerSession, input: '照常汇报',
  })).status, 201);

  fx.registry.remove('writer');
  t.mock.timers.tick(1001);
  await fx.fireDue();
  // Bot 删除后 runtime 的 HTTP 层也会拒绝该 botId（BOT_NOT_FOUND），直接读持久化状态确认任务结局。
  const readSchedules = async () => JSON.parse(await readFile(join(fx.root, 'state', 'schedules.json'), 'utf8'));
  const row = await eventually(async () => {
    const rows = await readSchedules();
    return rows.find(item => item.botId === 'writer' && item.scheduleId === 'after-delete' && item.status !== 'pending');
  });
  assert.equal(row.status, 'failed');
  // 现状：runtime 在 stateBotId() 处就抛出裸 Error('BOT_NOT_FOUND: writer')（无 code），
  // armSchedule 的 catch 只能记成通用 SCHEDULE_EXECUTION_FAILED。语义正确（没有乱发），
  // 但用户/日志里看不到「Bot 已删除」，属于报告 §2.2 G2.1 的降级可读性缺口。
  assert.equal(row.error, 'SCHEDULE_EXECUTION_FAILED');
  assert.deepEqual(fx.calls, [], 'Bot 已删除时连一次 bridge 提交都不应发生，更不能落到别的 Bot');
  assert.equal(fx.timers.size, 0);
  // 再等一拍，确认没有「失败后自动重试」的重复发送（当前实现没有重试，见报告 §2.2）。
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fx.calls.length, 0);
});

test('云端不可达：单次触发只尝试一次并标记失败，不重复发送（当前无重试）', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let attempts = 0;
  const fx = await boot(t, {
    submitTurn: async () => {
      attempts += 1;
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
  });
  const sessionId = await createSession(fx, 'writer');
  assert.equal((await fx.request('/v1/schedules', {
    botId: 'writer', scheduleId: 'cloud-down', runAt: Date.now() + 1000, sessionId, input: '云端不可达时',
  })).status, 201);

  t.mock.timers.tick(1001);
  await fx.fireDue();
  await eventually(async () => (await fx.request('/v1/schedules?botId=writer')).body.schedules[0]?.status === 'failed');

  const row = (await fx.request('/v1/schedules?botId=writer')).body.schedules[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'ECONNREFUSED');
  assert.equal(attempts, 1, '一次触发只能提交一次，幂等底线是不能重复发送');
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.timers.size, 0, '失败后不能留下会自动重发的定时器');
  const turns = (await fx.request(`/v1/sessions/${sessionId}/turns?botId=writer`)).body.turns;
  assert.equal(turns.length, 1, '失败只能留下一条 turn 记录');
  assert.equal(turns[0].status, 'failed');
});

test('任务输入为空或超过 64 KiB：400 且不建会话、不 arm 定时器', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fx = await boot(t);
  for (const input of ['', '   ', 'x'.repeat(64 * 1024 + 1)]) {
    const created = await fx.request('/v1/schedules', { botId: 'writer', scheduleId: `bad-${input.length}`, runAt: Date.now() + 1000, input });
    assert.equal(created.status, 400, `input 长度 ${input.length} 应被拒绝`);
    assert.equal(created.body.error, 'SCHEDULE_INPUT_REQUIRED');
  }
  assert.equal(fx.timers.size, 0);
  assert.deepEqual((await fx.request('/v1/sessions?botId=writer')).body.sessions, [], '非法任务不能顺手建出空会话');
  assert.equal(fx.calls.length, 0);
});
