import test from 'node:test';
import assert from 'node:assert/strict';
import { restrictPersonalAssistantToolScope } from '../src/bot-tool-scope.mjs';

test('PA 的 scoped 守卫拒绝原生执行和子代理，呈现仅保留电脑/私有工具，不写全局上下文', async () => {
  let guard, filter;
  const tools = { restrict: value => assert.deepEqual(value, { allow: [] }), guard: value => { guard = value; } };
  restrictPersonalAssistantToolScope({ ctx: { get: name => name === 'tools' ? tools : undefined, on: (name, handler) => { if (name === 'system-prompt/assemble') filter = handler; } } }, 'writer', { getPolicy: () => ({ mode: 'denylist', allow: [], deny: [], requireApproval: [] }) });
  for (const name of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'subagent', 'subagent_fork', 'skill', 'run_code']) assert.match(guard({ name }), /^PERSONAL_ASSISTANT_HOST_TOOL_FORBIDDEN:/u);
  assert.equal(guard({ name: 'cloud_bash' }), undefined);
  assert.equal(guard({ name: 'bot_memory_save' }), undefined);
  const result = await filter({}, {}, async () => ({ sections: ['unchanged'], tools: ['bash', 'subagent', 'cloud_bash', 'bot_memory_search'].map(name => ({ name })) }));
  assert.deepEqual(result.tools.map(row => row.name), ['cloud_bash', 'bot_memory_search']);
  assert.deepEqual(result.sections, ['unchanged']);
});
