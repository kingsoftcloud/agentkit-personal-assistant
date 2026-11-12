import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { apply, createRuntime, name } from '../src/index.mjs';
import { DshSessionControllerUnavailableError } from '../src/dsh-session-bridge.mjs';
import {
  apply as applyClient,
  createPersonalAssistantClient,
  PersonalAssistantGatewayUnavailableError,
  PersonalAssistantPanel,
  PersonalAssistantPanelIcon,
  setClientReactRuntime,
  PERSONAL_ASSISTANT_CLIENT_DEFAULTS,
  PERSONAL_ASSISTANT_COMPUTER_TAB,
  PERSONAL_ASSISTANT_PANEL_ID,
  PERSONAL_ASSISTANT_VIEW_ID,
  inject as clientInject,
} from '../src/client/index.mjs';
import { mapDisplayPoint, nextPollDelay, framePayload, isInputEventWritable, mergeWheel, WHEEL_PIXEL_STEP } from '../src/client/desktop-view.mjs';

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

test('client maps durable session and memory operations to the public gateway', async () => {
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
  assert.deepEqual(requests.map(item => item.operation), [
    'personal-assistant.session.create', 'personal-assistant.sessions.list',
    'personal-assistant.sessions.messages.list', 'personal-assistant.sessions.messages.append',
    'personal-assistant.sessions.turns.list', 'personal-assistant.sessions.turns.submit',
    'personal-assistant.memory.upsert', 'personal-assistant.memory.search',
  ]);
  // Host 白名单从来没有复数 schedules operation，客户端不再暴露这三个死方法（E4）。
  assert.equal('createSchedule' in client, false);
  assert.equal('listSchedules' in client, false);
  assert.equal('deleteSchedule' in client, false);
  assert.equal(requests[0].payload.botId, 'researcher');
  assert.equal(requests.find(item => item.operation === 'personal-assistant.memory.upsert').payload.key, 'project');
});


test('public DSH client entry registers a Session launcher and sidebar row', () => {
  const entries = [];
  const ctx = {
    sidebarRight: { openTab(kind) { opened.push(kind); } },
    effect(factory) { return factory(); },
    get() { return undefined; },
    slots: {
      inject(name, factory) {
        entries.push(factory());
        assert.ok(['conversation.view', 'conversation.composer', 'main', 'sidebar.panellist', 'settings.section'].includes(name));
        return () => {};
      },
      register(definition, component) {
        return { definition, component };
      },
    },
  };
  applyClient(ctx);
  assert.deepEqual(clientInject, ['slots', 'connection', 'sidebarRight', 'uiWorkspace', 'workspaces', 'sessions', 'uiConversation']);
  assert.deepEqual(entries.map(entry => entry.definition.name), ['conversation.view', 'conversation.composer', 'main', 'sidebar.panellist', 'settings.section']);
  assert.equal(entries[0].definition.id, PERSONAL_ASSISTANT_VIEW_ID);
  assert.equal(entries[1].component({ session: { sessionId: 'other' } }), null);
  assert.equal(entries[2].definition.key, PERSONAL_ASSISTANT_PANEL_ID);
  assert.equal(entries[2].component(), '正在打开个人助理会话…');
  assert.equal(entries[3].definition.id, PERSONAL_ASSISTANT_PANEL_ID);
  assert.equal(entries[3].component(), '助');
  assert.equal(entries[4].definition.id, `${PERSONAL_ASSISTANT_PANEL_ID}-settings`);
  assert.equal(entries[4].definition.label, '个人助理');
  assert.deepEqual(PERSONAL_ASSISTANT_CLIENT_DEFAULTS, { enabled: false, autoConnect: false });
});

test('PA main launcher creates a dedicated DSH Session and activates the PA view', async () => {
  const entries = [];
  const activations = [];
  const conversationViews = [];
  const opened = [];
  let created = 0;
  const slots = {
    inject(_name, factory) { entries.push(factory()); return () => {}; },
    register(definition, component) { return { definition, component }; },
  };
  const ctx = {
    sidebarRight: { openTab() {} },
    sessions: {
      list: { getSnapshot: () => ({ byId: {} }) },
      async create() { assert.fail('PA should prefer the DSH UI workspace creation path'); },
    },
    uiWorkspace: {
      async openWorkspace(workspace, prepare) { assert.equal(workspace, null); created += 1; prepare(`dsh-session-${created}`); },
      openSession(id) { opened.push(id); },
    },
    uiConversation: {
      views: { register(definition) { conversationViews.push(definition); return () => {}; } },
      binding(id) { return { activate(view) { activations.push({ id, view }); } }; },
    },
    effect(factory) { return factory(); },
    get() { return undefined; },
    slots,
  };
  applyClient(ctx);
  const main = entries.find(entry => entry.definition.name === 'main');
  const openSession = main.definition.inject().openSession;
  assert.equal(await openSession(), 'dsh-session-1');
  assert.deepEqual(conversationViews.map(view => view.target), [PERSONAL_ASSISTANT_VIEW_ID]);
  assert.equal(conversationViews[0].isActive(true), true);
  assert.deepEqual(activations, [{ id: 'dsh-session-1', view: PERSONAL_ASSISTANT_VIEW_ID }]);
  assert.deepEqual(opened, ['dsh-session-1']);
  // The second call reuses the dedicated PA Session, never an arbitrary active Session.
  ctx.sessions.list.getSnapshot = () => ({ byId: { 'dsh-session-1': { removed: false } } });
  assert.equal(await openSession(), 'dsh-session-1');
  assert.equal(created, 1);
  assert.equal(opened.length, 2);
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

test('Session surface package declares the DSH UI services it injects', async () => {
  const packageJson = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../personal-assistant.plugin.json'), 'utf8'));
  const inject = packageJson.dsh?.client?.inject || [];
  for (const name of ['@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-workspace']) {
    assert.ok(inject.includes(name), `${name} must be declared for the PA Session surface`);
  }
  assert.equal(manifest.version, packageJson.version, 'plugin manifest and npm package versions must match');
});

test('右侧栏云电脑标签页与设置页注册在插件作用域内，卸载即撤销', () => {
  const effectDisposers = [];
  const injected = [];
  const tabTypes = [];
  const opened = [];
  const slots = {
    inject(name, factory) { injected.push(factory()); return () => {}; },
    register(definition, component) { return { definition, component }; },
  };
  const sub = {
    slots,
    sidebarRightTabs: { register(definition) { tabTypes.push(definition); return () => {}; } },
    sidebarRight: { openTab(kind) { opened.push(kind); } },
  };
  const ctx = {
    sidebarRight: { openTab(kind) { opened.push(kind); } },
    effect(factory) { const dispose = factory(); assert.equal(typeof dispose, 'function'); effectDisposers.push(dispose); return dispose; },
    inject(names, factory) { return factory(sub); },
    slots,
  };
  applyClient(ctx);

  assert.equal(tabTypes.length, 1);
  assert.equal(tabTypes[0].id, PERSONAL_ASSISTANT_COMPUTER_TAB);
  assert.equal(tabTypes[0].kind, PERSONAL_ASSISTANT_COMPUTER_TAB);
  assert.equal(tabTypes[0].title(), '云电脑');
  assert.equal(tabTypes[0].guide.length, 1);
  assert.equal(tabTypes[0].guide[0].title(), '云电脑');
  assert.deepEqual(injected.map(entry => entry.definition.name), [
    'conversation.view', 'conversation.composer', 'main', 'sidebar.panellist', 'settings.section', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title',
  ]);
  assert.equal(injected[5].definition.key, PERSONAL_ASSISTANT_COMPUTER_TAB);
  assert.equal(injected[6].component(), '云电脑');
  assert.equal(typeof injected[2].definition.inject().openSession, 'function');
  assert.equal(injected[0].definition.id, PERSONAL_ASSISTANT_VIEW_ID);
  assert.deepEqual(opened, []);
  assert.equal(effectDisposers.length, 6);
});


test('个人助理侧栏图标是SVG，两条路径，不退回纯文本占位', () => {
  setClientReactRuntime({ createElement: (type, props, ...children) => ({ type, props, children }) });
  try {
    const icon = PersonalAssistantPanelIcon({ size: 20 });
    assert.equal(icon.type, 'svg'); assert.equal(icon.props.viewBox, '0 0 16 16'); assert.equal(icon.props.width, 20);
    assert.equal(icon.children.length, 2); assert.ok(icon.children.every(child => child.type === 'path'));
  } finally { setClientReactRuntime(undefined); }
});

test('滚轮按像素累计成刻度：鼠标一格 = 1 次滚动，余数跨帧保留', () => {
  const notch = mergeWheel({ x: 0, y: 0 }, { deltaY: WHEEL_PIXEL_STEP });
  assert.deepEqual(notch.clicks, { deltaX: 0, deltaY: 1 });
  assert.deepEqual(notch.pending, { x: 0, y: 0 });
  // 触控板碎事件：40 + 40 + 40 → 只有第三次凑满一格才发 1 次，余数 20 留到下一帧。
  let pending = { x: 0, y: 0 };
  const clicks = [];
  for (const deltaY of [40, 40, 40]) { const merged = mergeWheel(pending, { deltaY }); pending = merged.pending; clicks.push(merged.clicks.deltaY); }
  assert.deepEqual(clicks, [0, 0, 1]);
  assert.deepEqual(pending, { x: 0, y: 20 });
  // 反向滚动按负刻度发，方向不丢。
  const up = mergeWheel({ x: 0, y: 0 }, { deltaY: -250 });
  assert.deepEqual(up.clicks, { deltaX: 0, deltaY: -2 });
  assert.deepEqual(up.pending, { x: 0, y: -50 });
  // 水平滚轮同样累计；没有像素时不产生滚动。
  assert.deepEqual(mergeWheel({ x: 0, y: 0 }, { deltaX: 120 }).clicks, { deltaX: 1, deltaY: 0 });
  assert.deepEqual(mergeWheel({ x: 0, y: 0 }, {}).clicks, { deltaX: 0, deltaY: 0 });
  assert.deepEqual(mergeWheel().clicks, { deltaX: 0, deltaY: 0 });
});
