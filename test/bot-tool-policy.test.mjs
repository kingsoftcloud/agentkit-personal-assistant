import test from 'node:test';
import assert from 'node:assert/strict';
import { personalAssistantToolDecision, requestBotToolApproval } from '../src/bot-tool-policy.mjs';
import { restrictPersonalAssistantToolScope } from '../src/bot-tool-scope.mjs';

const policy = patch => ({ mode: 'allowlist', allow: ['bot_memory_search', 'bot_memory_save'], deny: [], requireApproval: [], ...patch });
function scope(getPolicy, approval, timeoutMs) {
  let guard; const handlers = new Map();
  const tools = { restrict() {}, guard(value) { guard = value; } };
  const agent = { ctx: { get: name => name === 'tools' ? tools : name === 'approval' ? approval : undefined, on: (name, callback) => handlers.set(name, callback) } };
  restrictPersonalAssistantToolScope(agent, 'writer', { getPolicy, approvalTimeoutMs: timeoutMs });
  return { agent, guard: execution => guard(execution), pre: (execution, next = async () => ({ kind: 'allow' })) => handlers.get('tools/pre-execute')(execution, next), result: execution => handlers.get('tools/result')(execution), filter: () => handlers.get('system-prompt/assemble')({}, {}, async () => ({ tools: ['bot_memory_search', 'bot_memory_save', 'cloud_bash', 'bash'].map(name => ({ name })) })) };
}
const execution = (patch = {}) => ({ name: 'bot_memory_save', token: Symbol('server-owned-execution'), callId: 'same-model-call-id', signal: new AbortController().signal, ...patch });

test('allowlist/denylist 按精确工具名称执行，deny 优先，空 allowlist 不授予权限', () => {
  assert.equal(personalAssistantToolDecision(policy(), 'bot_memory_search').allowed, true);
  assert.equal(personalAssistantToolDecision(policy({ allow: [] }), 'bot_memory_search').allowed, false);
  assert.equal(personalAssistantToolDecision(policy({ deny: ['bot_memory_save'] }), 'bot_memory_save').allowed, false);
  assert.equal(personalAssistantToolDecision(policy({ mode: 'denylist', deny: ['bot_memory_save'] }), 'cloud_bash').allowed, true);
  assert.equal(personalAssistantToolDecision(policy({ mode: 'denylist' }), 'bash').code, 'PERSONAL_ASSISTANT_HOST_TOOL_FORBIDDEN');
  assert.equal(personalAssistantToolDecision(policy({ mode: 'invalid' }), 'cloud_bash').code, 'BOT_TOOL_POLICY_INVALID');
});

test('伪造调用即使跳过 pre-execute 也被最终 guard 拒绝，并按每 Bot 当前策略过滤模型工具', async () => {
  let current = policy({ deny: ['bot_memory_save'] });
  const h = scope(() => current);
  assert.match(h.guard(execution()), /^BOT_TOOL_POLICY_DENIED:/u);
  assert.deepEqual((await h.filter()).tools.map(row => row.name), ['bot_memory_search']);
  current = policy({ mode: 'denylist', deny: ['bot_memory_search'] });
  assert.match(h.guard(execution({ name: 'bot_memory_search' })), /^BOT_TOOL_POLICY_DENIED:/u);
  assert.equal(h.guard(execution()), undefined);
});

test('requireApproval 缺服务/无答复者/拒绝/异常都 fail-closed，并提供可操作错误', async () => {
  for (const approval of [undefined, { request: async () => 'unavailable' }, { request: async () => 'rejected' }, { request: async () => 'approved' }, { request: async () => { throw Error('must-not-leak'); } }]) {
    const h = scope(() => policy({ requireApproval: ['bot_memory_save'] }), approval);
    const value = await h.pre(execution());
    assert.equal(value.kind, 'deny');
    assert.match(value.info.code, /^BOT_TOOL_APPROVAL_(UNAVAILABLE|REJECTED)$/u);
    assert.ok(!value.reason.includes('must-not-leak'));
  }
});

test('只有宿主 allowed-once 放行当前 token 一次；重试、重放、同 callId 新 token 不能继承', async () => {
  let asks = 0;
  const h = scope(() => policy({ requireApproval: ['bot_memory_save'] }), { request: async request => { asks++; assert.equal(request.toolName, 'bot_memory_save'); return 'allowed-once'; } });
  const first = execution();
  assert.match(h.guard(first), /^BOT_TOOL_APPROVAL_REQUIRED:/u);
  assert.equal((await h.pre(first)).kind, 'allow'); assert.equal(asks, 1);
  assert.equal(h.guard(first), undefined);
  assert.match(h.guard(first), /^BOT_TOOL_APPROVAL_REQUIRED:/u);
  const retry = execution(); assert.match(h.guard(retry), /^BOT_TOOL_APPROVAL_REQUIRED:/u);
  assert.equal((await h.pre(retry)).kind, 'allow'); assert.equal(asks, 2);
  h.result(retry); assert.match(h.guard(retry), /^BOT_TOOL_APPROVAL_REQUIRED:/u);
});

test('批准等待期间策略撤权仍由最终 guard 拒绝，不覆盖上游拒绝', async () => {
  let resolve, current = policy({ requireApproval: ['bot_memory_save'] });
  const h = scope(() => current, { request: () => new Promise(r => { resolve = r; }) });
  const exec = execution(); const pending = h.pre(exec);
  while (!resolve) await Promise.resolve();
  current = policy({ deny: ['bot_memory_save'] }); resolve('allowed-once'); await pending;
  assert.match(h.guard(exec), /^BOT_TOOL_POLICY_DENIED:/u);
  current = policy({ requireApproval: ['bot_memory_save'] });
  const upstream = { kind: 'deny', reason: 'upstream-denied' };
  assert.equal(await h.pre(execution(), async () => upstream), upstream);
});

test('非审批调用在最终 guard 前新增 requireApproval 时也必须重新取得批准', async () => {
  let current = policy();
  const h = scope(() => current);
  const exec = execution();
  assert.equal((await h.pre(exec)).kind, 'allow');
  current = policy({ requireApproval: ['bot_memory_save'] });
  assert.match(h.guard(exec), /^BOT_TOOL_APPROVAL_REQUIRED:/u);
  const invalid = scope(() => { throw Error('registry-unavailable'); });
  assert.match(invalid.guard(execution()), /^BOT_TOOL_POLICY_INVALID:/u);
});

test('批准超时/调用取消及时失败，迟到的 allowed-once 不会补发授权', async () => {
  let resolve;
  const h = scope(() => policy({ requireApproval: ['bot_memory_save'] }), { request: () => new Promise(r => { resolve = r; }) }, 10);
  const exec = execution(); const denied = await h.pre(exec);
  assert.equal(denied.info.code, 'BOT_TOOL_APPROVAL_TIMEOUT'); resolve('allowed-once'); await Promise.resolve();
  assert.match(h.guard(exec), /^BOT_TOOL_APPROVAL_REQUIRED:/u);
  const abort = new AbortController(); const waiting = requestBotToolApproval({ agent: h.agent, execution: execution({ signal: abort.signal }), approval: { request: () => new Promise(() => {}) } });
  abort.abort(); assert.equal((await waiting).code, 'BOT_TOOL_APPROVAL_CANCELLED');
});
