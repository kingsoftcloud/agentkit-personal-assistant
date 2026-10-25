import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createRuntime, name } from '../src/index.mjs';
import { DshSessionControllerUnavailableError } from '../src/dsh-session-bridge.mjs';
import {
  apply as applyClient,
  createPersonalAssistantClient,
  PersonalAssistantGatewayUnavailableError,
  PersonalAssistantPanel,
  PersonalAssistantPanelIcon,
  PERSONAL_ASSISTANT_CLIENT_DEFAULTS,
  PERSONAL_ASSISTANT_PANEL_ID,
  inject as clientInject,
} from '../src/client/index.mjs';
import { mapDisplayPoint, nextPollDelay, framePayload, isInputEventWritable } from '../src/client/desktop-view.mjs';

test('host entry is disabled and has no implicit Computer connection', () => {
  const runtime = apply({ kind: 'test-context' }, { bots: [{ botId: 'writer', systemPromptRevision: 'w1' }] });
  assert.equal(name, '@kingsoftcloud/agentkit-personal-assistant');
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.computerBroker.connected(), false);
  assert.equal(runtime.registry.require('writer').systemPromptRevision, 'w1');
});

test('client adapter requires an explicit gateway', async () => {
  const client = createPersonalAssistantClient();
  assert.throws(() => client.listBots(), PersonalAssistantGatewayUnavailableError);
  assert.equal(createRuntime(null, { enabled: true }).enabled, true);
});

test('host bridge admits a turn through the public DSH Session Controller', async () => {
  const calls = [];
  const promptSections = [];
  const agent = { ctx: { on() {}, get(name) { return name === 'systemPrompt' ? { section: section => promptSections.push(section) } : name === 'tools' ? { restrict: filter => assert.deepEqual(filter, { allow: [] }), guard() {} } : undefined; } } };
  const controller = {
    async projections() { return undefined; },
    async create(request) { calls.push({ op: 'create', request }); },
    async resolveAgent() { return { agent }; },
    async prompt(request) { calls.push({ op: 'prompt', request }); return { accepted: true }; },
  };
  const runtime = createRuntime({ sessionController: controller }, {
    profileId: 'profile-1',
    bots: [{ botId: 'researcher', systemPromptRevision: 'r1', systemPrompt: 'You are a research assistant.', agentPreset: 'researcher-preset' }],
  });
  const result = await runtime.submitTurn({ botId: 'researcher', sessionId: 'session-1', input: 'open the browser' });
  assert.equal(result.execution, 'dsh-session-controller');
  assert.equal(calls[0].request.agentPreset, 'researcher-preset');
  assert.equal(calls[1].request.content[0].text, 'open the browser');
  assert.equal(calls[1].request.mode, 'queue');
  assert.equal(promptSections[0].text, 'You are a research assistant.');
});

test('host bridge fails closed when DSH Session Controller is absent', async () => {
  const runtime = createRuntime({});
  await assert.rejects(() => runtime.submitTurn({ botId: 'researcher', sessionId: 'session-1', input: 'hello' }), DshSessionControllerUnavailableError);
});

test('client exposes broker-backed browser and terminal operations without auto-connect', async () => {
  const requests = [];
  const client = createPersonalAssistantClient({ profileId: 'profile-1', gateway: { request: async (operation, payload) => { requests.push({ operation, payload }); return { ok: true }; } } });
  client.selectBot('researcher');
  await client.browserOpen('https://example.com');
  await client.browserSnapshot();
  await client.cloudBash('printf ok');
  await client.cloudRunCode('python', 'print(1)');
  assert.deepEqual(requests.map(item => item.payload.action), ['open', 'snapshot', 'terminal.exec', 'terminal.exec']);
  assert.equal(requests[0].payload.profileId, 'profile-1');
  assert.equal(requests[2].payload.args.language, 'shell');
});

test('client desktop ticket and frame operations stay on the gateway RPC boundary', async () => {
  const requests = [];
  const client = createPersonalAssistantClient({ profileId: 'profile-1', gateway: { request: async (operation, payload) => { requests.push({ operation, payload }); return { ok: true }; } } });
  client.selectBot('researcher');
  await client.desktop.ticket({ mode: 'control' });
  await client.desktop.frame({ sessionId: 'session-1', afterSeq: 4 });
  await client.desktop.input({ sessionId: 'session-1', event: { type: 'keyDown', key: 'Tab' } });
  await client.desktop.close({ sessionId: 'session-1' });
  assert.deepEqual(requests.map(item => item.operation), [
    'personal-assistant.desktop.ticket', 'personal-assistant.desktop.frame',
    'personal-assistant.desktop.input', 'personal-assistant.desktop.session.close',
  ]);
  assert.equal(requests[0].payload.botId, 'researcher');
  assert.equal(requests.every(item => !Object.hasOwn(item.payload, 'token')), true);
});

test('client maps durable session, memory, and schedule operations to the public gateway', async () => {
  const requests = [];
  const client = createPersonalAssistantClient({ gateway: { request: async (operation, payload) => { requests.push({ operation, payload }); return { ok: true }; } } });
  client.selectBot('researcher');
  await client.createSession({ title: 'Plan' });
  await client.listSessions();
  await client.listMessages('session-1');
  await client.appendMessage('session-1', { role: 'user', content: 'hello' });
  await client.listTurns('session-1');
  await client.submitTurn('session-1', { input: 'continue' });
  await client.remember({ key: 'project', content: 'marker' });
  await client.searchMemory('marker');
  await client.createSchedule({ scheduleId: 'review', runAt: 123 });
  await client.listSchedules();
  await client.deleteSchedule('review');
  assert.deepEqual(requests.map(item => item.operation), [
    'personal-assistant.sessions.create', 'personal-assistant.sessions.list',
    'personal-assistant.sessions.messages.list', 'personal-assistant.sessions.messages.append',
    'personal-assistant.sessions.turns.list', 'personal-assistant.sessions.turns.submit',
    'personal-assistant.memory.upsert', 'personal-assistant.memory.search',
    'personal-assistant.schedules.create', 'personal-assistant.schedules.list',
    'personal-assistant.schedules.delete',
  ]);
  assert.equal(requests[0].payload.botId, 'researcher');
  assert.equal(requests.find(item => item.operation === 'personal-assistant.memory.upsert').payload.key, 'project');
});


test('public DSH client entry registers a closed main panel and sidebar row', () => {
  const entries = [];
  const ctx = {
    slots: {
      inject(name, factory) {
        entries.push(factory());
        assert.ok(['main', 'sidebar.panellist'].includes(name));
      },
      register(definition, component) {
        return { definition, component };
      },
    },
  };
  applyClient(ctx);
  assert.deepEqual(clientInject, ['slots', 'connection']);
  assert.deepEqual(entries.map(entry => entry.definition.name), ['main', 'sidebar.panellist']);
  assert.equal(entries[0].definition.key, PERSONAL_ASSISTANT_PANEL_ID);
  assert.equal(entries[1].definition.id, PERSONAL_ASSISTANT_PANEL_ID);
  assert.equal(entries[0].component(), '请启用 Personal Assistant 插件并配置云网关');
  assert.equal(entries[1].component(), 'PA');
  assert.deepEqual(PERSONAL_ASSISTANT_CLIENT_DEFAULTS, { enabled: false, autoConnect: false });
});

test('letterboxed desktop keeps ten grid coordinates within two pixels', () => {
  const rect = { left: 15, top: 20, width: 1000, height: 800 };
  const scale = 1000 / 1280;
  const top = rect.top + (rect.height - 800 * scale) / 2;
  for (let index = 1; index <= 10; index += 1) {
    const expected = { x: index * 100, y: (index % 7 + 1) * 100 };
    const actual = mapDisplayPoint({ clientX: rect.left + expected.x * scale, clientY: top + expected.y * scale, rect });
    assert.ok(Math.abs(actual.x - expected.x) <= 2);
    assert.ok(Math.abs(actual.y - expected.y) <= 2);
  }
});

test('desktop client maps display coordinates and drops oversized/stale frames', () => {
  assert.deepEqual(mapDisplayPoint({ clientX: 50, clientY: 25, rect: { left: 0, top: 0, width: 640, height: 400 } }), { x: 100, y: 50 });
  assert.equal(framePayload({ seq: 1, format: 'jpeg', width: 1280, height: 800, bytes: 300 * 1024, data: 'YQ==' }).seq, 1);
  assert.equal(framePayload({ seq: 2, bytes: 300 * 1024 + 1, data: 'YQ==' }), null);
  assert.equal(nextPollDelay({ lastInputAt: Date.now() - 10_001 }), 1_000);
  assert.equal(nextPollDelay({ lastInputAt: Date.now() }), 100);
  assert.equal(isInputEventWritable({ connected: true, readOnly: false }), true);
  assert.equal(isInputEventWritable({ connected: true, readOnly: true }), false);
});

test('client apply rejects a context without the public DSH slots service', () => {
  assert.throws(() => applyClient({}), /public DSH slots service/);
});
