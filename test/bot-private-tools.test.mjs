import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBotPrivateTools } from '../src/bot-private-tools.mjs';

test('Bot 私有工具不接受文件路径或身份扩权，计划只保存数据', async () => {
  const tools = new Map(), writes = [];
  registerBotPrivateTools({ agent: { ctx: { get: () => ({ register: definition => tools.set(definition.name, definition) }) } },
    read: async () => [{ key: 'project', content: 'own-private-data' }], write: async value => { writes.push(value); return value; } });
  assert.deepEqual([...tools.keys()], ['bot_memory_search', 'bot_memory_save', 'bot_plan_update']);
  const query = tools.get('bot_memory_search');
  assert.equal(query.parameters.additionalProperties, false);
  assert.deepEqual(await query.execute({ query: 'private' }), { memories: [{ key: 'project', content: 'own-private-data' }] });
  await tools.get('bot_memory_save').execute({ key: 'project', content: 'safe', botId: 'foreign', path: '/data/private' });
  assert.deepEqual(writes[0], { key: 'project', content: 'safe' });
  await tools.get('bot_plan_update').execute({ steps: [{ text: '只记录计划', status: 'pending' }] });
  assert.equal(writes[1].key, 'plan.current');
  await assert.rejects(tools.get('bot_plan_update').execute({ steps: [{ text: '', status: 'execute-shell' }] }), { code: 'BOT_PLAN_INVALID' });
});
