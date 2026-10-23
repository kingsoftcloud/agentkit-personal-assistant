import test from 'node:test';
import assert from 'node:assert/strict';
import { BotRegistry, normalizeBotDefinition } from '../src/bot-registry.mjs';

test('normalizes a Bot with independent prompt, memory, and tool policy', () => {
  const bot = normalizeBotDefinition({
    botId: 'researcher',
    name: 'Researcher',
    systemPromptRevision: 'researcher@1',
    systemPrompt: 'Use citations.',
    toolPolicy: { allow: ['browser.search', 'browser.search'], requireApproval: ['files.write'] },
  }, 'profile-1');
  assert.equal(bot.botId, 'researcher');
  assert.equal(bot.displayName, 'Researcher');
  assert.equal(bot.memoryNamespace, 'assistant:profile-1:bot:researcher');
  assert.deepEqual(bot.toolPolicy.allow, ['browser.search']);
  assert.deepEqual(bot.toolPolicy.requireApproval, ['files.write']);
  assert.ok(Object.isFrozen(bot));
});

test('registry supports multiple logical Bots and stable resolution', () => {
  const registry = new BotRegistry({ profileId: 'user-1' });
  registry.register({ botId: 'researcher', displayName: 'Researcher', systemPromptRevision: 'r1' });
  registry.register({ botId: 'operator', displayName: 'Operator', systemPromptRevision: 'o3', toolPolicy: { mode: 'denylist', deny: ['payments'] } });
  assert.deepEqual(registry.list().map(bot => bot.botId), ['researcher', 'operator']);
  assert.equal(registry.resolve('operator').systemPromptRevision, 'o3');
  assert.equal(registry.resolve('operator').toolPolicy.mode, 'denylist');
  assert.throws(() => registry.register({ botId: 'operator', systemPromptRevision: 'o4' }), /BOT_ALREADY_EXISTS/);
  assert.throws(() => registry.require('missing'), /BOT_NOT_FOUND/);
});

test('registry upsert changes one Bot without changing its peers', () => {
  const registry = new BotRegistry({ bots: [{ botId: 'a', systemPromptRevision: 'a1' }, { botId: 'b', systemPromptRevision: 'b1' }] });
  registry.upsert({ botId: 'a', systemPromptRevision: 'a2' });
  assert.equal(registry.require('a').systemPromptRevision, 'a2');
  assert.equal(registry.require('b').systemPromptRevision, 'b1');
  assert.equal(registry.remove('a'), true);
  assert.equal(registry.has('a'), false);
});

test('rejects malformed Bot definitions', () => {
  assert.throws(() => normalizeBotDefinition({ botId: 'Bad ID', systemPromptRevision: '1' }), /botId/);
  assert.throws(() => normalizeBotDefinition({ botId: 'ok', systemPromptRevision: '' }), /systemPromptRevision/);
  assert.throws(() => normalizeBotDefinition({ botId: 'ok', systemPromptRevision: '1', toolPolicy: { mode: 'open' } }), /allowlist or denylist/);
});
