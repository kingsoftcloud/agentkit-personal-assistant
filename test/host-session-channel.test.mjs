import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostSessionChannel } from '../src/host-session-channel.mjs';
import { createPersonalAssistantHostGateway, registerPersonalAssistantHostGateway } from '../src/host-gateway.mjs';
import { apply } from '../src/index.mjs';

/** 假 DSH sessionController：只实现会话通道用到的公开方法，事件数组由测试直接 append。 */
function fakeSessionController(options = {}) {
  const calls = [];
  const state = {
    items: options.items ?? [],
    events: options.events ?? [],
    failures: options.failures ?? {},
    create: options.create,
    rename: options.rename,
    prompt: options.prompt,
  };
  const guard = operation => {
    const failure = state.failures[operation];
    if (failure) throw failure;
  };
  return {
    calls,
    state,
    async list(request, signal) {
      calls.push({ op: 'list', request, signal });
      guard('list');
      return { items: state.items };
    },
    async inspect(sessionId, signal) {
      calls.push({ op: 'inspect', sessionId, signal });
      guard('inspect');
      return { meta: { id: sessionId }, inheritedEventCount: 0, events: state.events.slice() };
    },
    async create(request) {
      calls.push({ op: 'create', request });
      guard('create');
      return state.create ? state.create(request) : { sessionId: request.sessionId };
    },
    async rename(request) {
      calls.push({ op: 'rename', request });
      guard('rename');
      return state.rename ? state.rename(request) : { title: request.title, seq: state.events.length };
    },
    async prompt(request, signal) {
      calls.push({ op: 'prompt', request, signal });
      guard('prompt');
      return state.prompt ? state.prompt(request) : { accepted: true };
    },
  };
}

const userEvent = (seq, text) => ({ seq, type: 'user/message', time: 1_700_000_000_000 + seq, data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `r${seq}` } } });
const assistantEvent = (seq, text) => ({ seq, type: 'assistant/message', time: 1_700_000_000_000 + seq, data: { message: { content: [{ type: 'text', text }] } } });
const titleEvent = (seq, title) => ({ seq, type: 'session/title', time: 1_700_000_000_000 + seq, data: { title, messageSeqs: [], source: { kind: 'user' } } });
const toolEvent = seq => ({ seq, type: 'tool/result', time: 1_700_000_000_000 + seq, data: { toolCallId: `call-${seq}`, content: 'TOOL-SECRET-OUTPUT', isError: false } });
const failing = code => Object.assign(new Error(`upstream ${code}`), { code });

test('会话列表只暴露个人助理命名空间并白名单字段', async () => {
  const controller = fakeSessionController({
    items: [
      { sessionId: 'pa-aaa', updatedAt: 30, projections: { values: { title: '出差计划', inbox: { secret: 'TOOL-SECRET-OUTPUT' } } }, cwd: '/Users/me/private' },
      { sessionId: 'studio-unrelated', updatedAt: 20, projections: { values: { title: '用户在 Studio 里的其它会话' } } },
      { sessionId: 'pa-bbb', updatedAt: 10, projections: { values: { title: null } } },
      { sessionId: 'pa-ccc', updatedAt: 5 },
    ],
  });
  const channel = createHostSessionChannel({ sessionController: controller });
  const { sessions } = await channel.listSessions();
  assert.deepEqual(sessions, [
    { sessionId: 'pa-aaa', title: '出差计划', updatedAt: 30 },
    { sessionId: 'pa-bbb', title: null, updatedAt: 10 },
    { sessionId: 'pa-ccc', title: null, updatedAt: 5 },
  ]);
  assert.deepEqual(controller.calls[0].request, {});
  const wire = JSON.stringify(sessions);
  assert.equal(wire.includes('studio-unrelated'), false);
  assert.equal(wire.includes('private'), false);
  assert.equal(wire.includes('inbox'), false);
  // 临时工作区的会话属于测试/试跑，不能出现在真实面板里。
  const temp = createHostSessionChannel({ sessionController: fakeSessionController({
    items: [
      { sessionId: 'pa-tmp1', updatedAt: 90, cwd: '/tmp/pa-iso' },
      { sessionId: 'pa-tmp2', updatedAt: 80, cwd: '/private/var/tmp/x' },
      { sessionId: 'pa-real', updatedAt: 10, cwd: '/Users/me/project' },
    ],
  }) });
  assert.deepEqual((await temp.listSessions()).sessions.map(item => item.sessionId), ['pa-real']);

  const capped = createHostSessionChannel({ sessionController: controller, maxSessions: 1 });
  assert.equal((await capped.listSessions()).sessions.length, 1);

  const custom = createHostSessionChannel({ sessionController: controller, sessionIdPrefix: 'assistant:' });
  assert.deepEqual(await custom.listSessions(), { sessions: [] });
  assert.throws(() => createHostSessionChannel({ sessionController: controller, maxEventsPerRead: 0 }), TypeError);
});

test('新建会话使用个人助理命名空间、注入 Bot 预设并落 durable 标题', async () => {
  const controller = fakeSessionController();
  const channel = createHostSessionChannel({
    sessionController: controller,
    requestIdFactory: () => 'session-42',
    resolveBot: botId => (botId === 'writer' ? { botId: 'writer', agentPreset: 'writer-preset' } : undefined),
    defaultBotId: 'writer',
  });
  const created = await channel.createSession({ title: '  周报草稿  ' });
  assert.deepEqual(created, { sessionId: 'pa-session-42', title: '周报草稿' });
  assert.deepEqual(controller.calls[0], { op: 'create', request: { sessionId: 'pa-session-42', agentPreset: 'writer-preset' } });
  assert.deepEqual(controller.calls[1], { op: 'rename', request: { sessionId: 'pa-session-42', title: '周报草稿' } });

  const plain = await createHostSessionChannel({ sessionController: controller, requestIdFactory: () => 'session-43' }).createSession();
  assert.deepEqual(plain, { sessionId: 'pa-session-43', title: null });
  assert.equal(controller.calls.filter(call => call.op === 'rename').length, 1);

  await assert.rejects(
    channel.createSession({ botId: 'ghost' }),
    { code: 'DSH_SESSION_BOT_INVALID', status: 400 },
  );
  await assert.rejects(
    channel.createSession({ title: 'x'.repeat(513) }),
    { code: 'DSH_SESSION_TITLE_INVALID', status: 400 },
  );
  controller.state.failures.create = failing('gateway/internal');
  await assert.rejects(channel.createSession({}), { code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE', status: 503 });
});

test('提交回合：图片附件转成 image 部件，非法类型与超限图片被丢弃', async () => {
  const controller = fakeSessionController();
  const channel = createHostSessionChannel({ sessionController: controller, requestIdFactory: () => 'turn-img' });
  const png = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;
  const result = await channel.submitTurn({
    sessionId: 'pa-img',
    text: '这张图里有什么',
    attachments: [
      { name: 'shot.png', mimeType: 'image/png', dataUrl: png },
      { name: 'notes.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,aGVsbG8=' },
      { name: 'huge.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(7 * 1024 * 1024)}` },
    ],
  });
  assert.deepEqual(result, { turnId: 'turn-img', sessionId: 'pa-img' });
  const content = controller.calls[0].request.content;
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], { type: 'text', text: '这张图里有什么' });
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].mediaType, 'image/png');
  assert.equal(content[1].name, 'shot.png');
  assert.equal(Buffer.from(content[1].data, 'base64').toString(), 'fake-png-bytes');

  // 只有图片、没有文字也应放行
  await channel.submitTurn({ sessionId: 'pa-img', text: '   ', attachments: [{ mimeType: 'image/png', dataUrl: png }] });
  assert.deepEqual(controller.calls[1].request.content.map(part => part.type), ['image']);
  // 既无文字也无可用图片则报输入非法
  await assert.rejects(channel.submitTurn({ sessionId: 'pa-img', text: '', attachments: [{ mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,aGVsbG8=' }] }), { code: 'DSH_TURN_INPUT_INVALID', status: 400 });
});

test('快照与增量只投递真人消息，宿主注入的上下文不算对话', async () => {
  const controller = fakeSessionController({
    events: [
      userEvent(1, '帮我把周报整理一下'),
      { seq: 2, type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'Current DSH file policy: workspace-write …' }], source: { kind: 'agent-instructions' } } },
      { seq: 3, type: 'user/message', time: 3, data: { content: [{ type: 'text', text: '<system-reminder>skill catalog…</system-reminder>' }], source: { kind: 'skill-catalog' } } },
      assistantEvent(4, '好的，我来整理'),
      { seq: 5, type: 'user/message', time: 5, data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }], source: { kind: 'tool' } } },
    ],
  });
  const channel = createHostSessionChannel({ sessionController: controller, sessionIdPrefix: 'pa-' });
  const snapshot = await channel.getSnapshot({ sessionId: 'pa-x' });
  assert.deepEqual(snapshot.messages.map(message => message.text), ['帮我把周报整理一下', '好的，我来整理']);
  const page = await channel.readEvents({ sessionId: 'pa-x', cursor: 0 });
  assert.deepEqual(page.events.map(event => event.role), ['user', 'assistant']);
});

test('提交回合：无 Bot 桥时直接 prompt，注入桥时复用 Bot 归属', async () => {
  const controller = fakeSessionController();
  const channel = createHostSessionChannel({ sessionController: controller, requestIdFactory: () => 'turn-1' });
  const submitted = await channel.submitTurn({ sessionId: 'pa-aaa', text: '  帮我看下明天天气 ' });
  assert.deepEqual(submitted, { turnId: 'turn-1', sessionId: 'pa-aaa' });
  assert.deepEqual(controller.calls[0], {
    op: 'prompt',
    request: { sessionId: 'pa-aaa', requestId: 'turn-1', mode: 'queue', content: [{ type: 'text', text: '帮我看下明天天气' }] },
    signal: controller.calls[0].signal,
  });
  // prompt 需要真实 AbortSignal（DSH 会在入口 throwIfAborted），缺省由通道补一个未中止的。
  assert.ok(controller.calls[0].signal instanceof AbortSignal);
  assert.equal(controller.calls[0].signal.aborted, false);

  await assert.rejects(channel.submitTurn({ sessionId: 'pa-aaa', text: '   ' }), { code: 'DSH_TURN_INPUT_INVALID', status: 400 });
  await assert.rejects(channel.submitTurn({ sessionId: 'pa-aaa', text: 'x'.repeat(32 * 1024 + 1) }), { code: 'DSH_TURN_INPUT_INVALID', status: 413 });
  await assert.rejects(channel.submitTurn({ sessionId: '../escape', text: 'hello' }), { code: 'DSH_SESSION_ID_INVALID', status: 400 });
  controller.state.failures.prompt = failing('session/agent-busy');
  await assert.rejects(channel.submitTurn({ sessionId: 'pa-aaa', text: 'again' }), { code: 'DSH_SESSION_BUSY', status: 409 });
  controller.state.prompt = () => ({ accepted: false });
  delete controller.state.failures.prompt;
  await assert.rejects(channel.submitTurn({ sessionId: 'pa-aaa', text: 'again' }), { code: 'DSH_TURN_NOT_ACCEPTED', status: 503 });
});

test('提交回合经 turnBridge 时携带 Bot 并返回桥上的回合标识', async () => {
  const controller = fakeSessionController();
  const bridged = [];
  const observed = [];
  const turnBridge = {
    available: true,
    async submitTurn(input) {
      bridged.push(input);
      return { accepted: true, requestId: input.requestId };
    },
    waitForTurn(input) {
      observed.push(input);
      return Promise.resolve({ status: 'completed', messages: [] });
    },
  };
  const channel = createHostSessionChannel({
    sessionController: controller,
    turnBridge,
    requestIdFactory: () => 'turn-9',
    resolveBot: botId => (['writer', 'researcher'].includes(botId) ? { botId } : undefined),
    defaultBotId: 'writer',
  });
  assert.deepEqual(await channel.submitTurn({ sessionId: 'pa-aaa', text: '写周报' }), { turnId: 'turn-9', sessionId: 'pa-aaa' });
  assert.equal(bridged[0].botId, 'writer');
  assert.equal(bridged[0].input, '写周报');
  assert.equal(controller.calls.some(call => call.op === 'prompt'), false);
  // busy 标记只在后台观察（waitForTurn）里释放，否则同一会话第二次提交会永久 409。
  assert.deepEqual(observed, [{ botId: 'writer', sessionId: 'pa-aaa', requestId: 'turn-9' }]);

  await channel.submitTurn({ sessionId: 'pa-aaa', botId: 'researcher', text: '查资料' });
  assert.equal(bridged[1].botId, 'researcher');
  await assert.rejects(channel.submitTurn({ sessionId: 'pa-aaa', botId: 'ghost', text: 'hi' }), { code: 'DSH_SESSION_BOT_INVALID', status: 400 });

  // 宿主一个 Bot 都没配置时，对话仍要能用：退回 DSH 会话控制器，而不是把面板堵死。
  const unbotted = createHostSessionChannel({ sessionController: controller, turnBridge, requestIdFactory: () => 'turn-10' });
  const before = controller.calls.filter(call => call.op === 'prompt').length;
  assert.deepEqual(await unbotted.submitTurn({ sessionId: 'pa-aaa', text: 'hi' }), { turnId: 'turn-10', sessionId: 'pa-aaa' });
  assert.equal(controller.calls.filter(call => call.op === 'prompt').length, before + 1);
  assert.deepEqual(controller.calls.filter(call => call.op === 'prompt').at(-1).request.content, [{ type: 'text', text: 'hi' }]);

  const offline = createHostSessionChannel({ sessionController: controller, turnBridge: { available: false, async submitTurn() { throw new Error('must not run'); } } });
  await assert.rejects(offline.submitTurn({ sessionId: 'pa-aaa', botId: 'writer', text: 'hi' }), { code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE', status: 503 });

  const conflicted = createHostSessionChannel({
    sessionController: controller,
    turnBridge: { available: true, async submitTurn() { throw failing('DSH_SESSION_BOT_CONFLICT'); } },
    resolveBot: () => ({ botId: 'writer' }),
    defaultBotId: 'writer',
  });
  await assert.rejects(conflicted.submitTurn({ sessionId: 'pa-aaa', text: 'hi' }), { code: 'DSH_SESSION_BOT_CONFLICT', status: 409 });
});

test('会话快照折叠 durable 标题与消息，且不透传工具内容', async () => {
  const controller = fakeSessionController({
    events: [userEvent(0, '早上好'), assistantEvent(1, '早上好，需要我做什么？'), toolEvent(2), titleEvent(3, '日程梳理')],
  });
  const channel = createHostSessionChannel({ sessionController: controller });
  const snapshot = await channel.getSnapshot({ sessionId: 'pa-aaa' });
  assert.deepEqual(snapshot, {
    sessionId: 'pa-aaa',
    title: '日程梳理',
    messages: [
      { id: 'm-0', role: 'user', text: '早上好', seq: 0 },
      { id: 'm-1', role: 'assistant', text: '早上好，需要我做什么？', seq: 1 },
    ],
    cursor: 4,
  });
  assert.equal(JSON.stringify(snapshot).includes('TOOL-SECRET-OUTPUT'), false);

  controller.state.events = [userEvent(0, '   '), { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool_use', id: 'call-1' }] } } }];
  assert.deepEqual(await channel.getSnapshot({ sessionId: 'pa-bbb' }), { sessionId: 'pa-bbb', title: null, messages: [], cursor: 2 });

  const tailed = createHostSessionChannel({ sessionController: controller, maxSnapshotMessages: 1 });
  const tail = await tailed.getSnapshot({ sessionId: 'pa-bbb' });
  assert.deepEqual(tail.messages, []);

  controller.state.failures.inspect = new Error('session "pa-missing" not found');
  await assert.rejects(channel.getSnapshot({ sessionId: 'pa-missing' }), { code: 'DSH_SESSION_NOT_FOUND', status: 404 });
  controller.state.failures.inspect = failing('SESSION_QUERY_SESSION_NOT_FOUND');
  await assert.rejects(channel.getSnapshot({ sessionId: 'pa-missing' }), { code: 'DSH_SESSION_NOT_FOUND', status: 404 });
});

test('增量事件按 durable 序号前进游标，空增量也推进且不重复投递', async () => {
  const controller = fakeSessionController({ events: [userEvent(0, '你好'), assistantEvent(1, '在的')] });
  const channel = createHostSessionChannel({ sessionController: controller });
  const first = await channel.readEvents({ sessionId: 'pa-aaa', cursor: 0 });
  assert.deepEqual(first, {
    events: [
      { type: 'message', id: 'm-0', role: 'user', text: '你好', done: true, seq: 0 },
      { type: 'message', id: 'm-1', role: 'assistant', text: '在的', done: true, seq: 1 },
    ],
    cursor: 2,
    done: true,
  });
  const idle = await channel.readEvents({ sessionId: 'pa-aaa', cursor: 2 });
  assert.deepEqual(idle, { events: [], cursor: 2, done: true });

  controller.state.events.push(toolEvent(2), assistantEvent(3, '顺带说一句'));
  const incremental = await channel.readEvents({ sessionId: 'pa-aaa', cursor: 2 });
  assert.deepEqual(incremental.events, [{ type: 'message', id: 'm-3', role: 'assistant', text: '顺带说一句', done: true, seq: 3 }]);
  assert.equal(incremental.cursor, 4);
  assert.equal(incremental.done, true);
  assert.equal(await channel.readEvents({ sessionId: 'pa-aaa', cursor: 4 }).then(page => page.events.length), 0);

  await assert.rejects(channel.readEvents({ sessionId: 'pa-aaa', cursor: -1 }), { code: 'DSH_CURSOR_INVALID', status: 400 });
  await assert.rejects(channel.readEvents({ sessionId: 'pa-aaa', cursor: 1.5 }), { code: 'DSH_CURSOR_INVALID', status: 400 });
});

test('内部事件只前进游标不投递，单次增量受条数上限约束且不丢事件', async () => {
  const controller = fakeSessionController({
    events: [toolEvent(0), userEvent(1, '一'), assistantEvent(2, '二'), userEvent(3, '三')],
  });
  const channel = createHostSessionChannel({ sessionController: controller });
  const internals = await channel.readEvents({ sessionId: 'pa-aaa', cursor: 0 });
  // tool/result 不投递，但游标必须越过它，否则客户端会原地打转。
  assert.deepEqual(internals.events.map(event => event.text), ['一', '二', '三']);
  assert.equal(internals.cursor, 4);

  const limited = createHostSessionChannel({ sessionController: controller, maxEventsPerRead: 1 });
  const pageOne = await limited.readEvents({ sessionId: 'pa-aaa', cursor: 0 });
  assert.deepEqual(pageOne.events.map(event => event.text), ['一']);
  assert.equal(pageOne.cursor, 2);
  assert.equal(pageOne.done, false);
  const pageTwo = await limited.readEvents({ sessionId: 'pa-aaa', cursor: pageOne.cursor });
  assert.deepEqual(pageTwo.events.map(event => event.text), ['二']);
  assert.equal(pageTwo.cursor, 3);
  const pageThree = await limited.readEvents({ sessionId: 'pa-aaa', cursor: pageTwo.cursor });
  assert.deepEqual(pageThree.events.map(event => event.text), ['三']);
  assert.equal(pageThree.cursor, 4);
  assert.equal(pageThree.done, true);
});

test('Session Controller 缺失时全部会话操作 fail closed 为 503', async () => {
  for (const channel of [createHostSessionChannel(), createHostSessionChannel({ ctx: {} }), createHostSessionChannel({ ctx: { get() { throw new Error('no service'); } } })]) {
    assert.equal(channel.available, false);
    const unavailable = { code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE', status: 503 };
    await assert.rejects(channel.listSessions(), unavailable);
    await assert.rejects(channel.createSession({}), unavailable);
    await assert.rejects(channel.getSnapshot({ sessionId: 'pa-aaa' }), unavailable);
    await assert.rejects(channel.readEvents({ sessionId: 'pa-aaa', cursor: 0 }), unavailable);
    await assert.rejects(channel.submitTurn({ sessionId: 'pa-aaa', text: 'hi' }), unavailable);
  }
  const partial = createHostSessionChannel({ sessionController: { async list() { return { items: [] }; } } });
  assert.equal(partial.available, false);
  await assert.rejects(partial.getSnapshot({ sessionId: 'pa-aaa' }), { code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE', status: 503 });
  assert.equal(createHostSessionChannel({ sessionController: fakeSessionController() }).available, true);
});

test('面板式流程：新建 → 快照 → 提交 → 按游标轮询直到收齐增量', async () => {
  const controller = fakeSessionController();
  let seq = 0;
  let counter = 0;
  const channel = createHostSessionChannel({
    sessionController: controller,
    requestIdFactory: () => `id-${++counter}`,
    maxEventsPerRead: 1,
  });
  controller.state.prompt = request => {
    controller.state.events.push({ seq: seq++, type: 'user/message', time: 1, data: { content: [{ type: 'text', text: '帮我看下日程' }], source: { kind: 'user', rpcId: request.requestId } } });
    return { accepted: true };
  };
  const created = await channel.createSession({});
  const snapshot = await channel.getSnapshot({ sessionId: created.sessionId });
  assert.deepEqual(snapshot, { sessionId: 'pa-id-1', title: null, messages: [], cursor: 0 });
  const submitted = await channel.submitTurn({ sessionId: created.sessionId, text: '帮我看下日程' });
  assert.equal(submitted.sessionId, 'pa-id-1');

  // 助手消息在本轮处理期间落盘；客户端下一次轮询才应看到它。
  controller.state.events.push({ seq: seq++, type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: '今天下午三点有会' }] } } });

  const seen = [];
  let cursor = snapshot.cursor;
  let done = false;
  for (let round = 0; !done && round < 10; round += 1) {
    const page = await channel.readEvents({ sessionId: created.sessionId, cursor });
    cursor = page.cursor;
    done = page.done;
    seen.push(...page.events.map(event => `${event.role}:${event.text}`));
  }
  assert.deepEqual(seen, ['user:帮我看下日程', 'assistant:今天下午三点有会']);
  assert.equal(done, true);
  assert.equal(cursor, 2);
});

test('网关会话必须绑定云端，注入本地控制器也不能绕过', async () => {
  const controller = fakeSessionController();
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, sessionChannel: createHostSessionChannel({ sessionController: controller }) });
  for (const operation of ['personal-assistant.sessions.list', 'personal-assistant.session.create', 'personal-assistant.session.snapshot', 'personal-assistant.session.events', 'personal-assistant.turn.submit']) {
    await assert.rejects(gateway.request(operation, { sessionId: 'pa-any', botId: 'writer', text: 'hello' }), { code: 'PERSONAL_ASSISTANT_GATEWAY_UNCONFIGURED', status: 409 });
  }
  assert.equal(controller.calls.length, 0);
  gateway.dispose();
});

test('云端代理锁定 Agent/Bot 并原样保留可识别的拒绝，不降级本机', async () => {
  const calls = [];
  const gateway = createPersonalAssistantHostGateway({ gatewayUrl: 'https://gateway.example', agentId: 'ar-test', apiKey: 'test-key' }, { env: {}, cloudSessionTransport: {
    async request(scope, operation, payload) { calls.push({ scope, operation, payload }); throw Object.assign(new Error('cloud offline'), { code: 'CLOUD_UNAVAILABLE', status: 503 }); }, dispose() {},
  } });
  await assert.rejects(gateway.request('personal-assistant.turn.submit', { agentId: 'ar-other', botId: 'writer', sessionId: 's', text: 'hello' }), { status: 403 });
  await assert.rejects(gateway.request('personal-assistant.turn.submit', { botId: 'writer', sessionId: 's', text: 'hello' }), { code: 'CLOUD_UNAVAILABLE', status: 503 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scope, { agentId: 'ar-test', botId: 'writer' });
  gateway.dispose();
});

test('插件入口只注册云端会话代理，不把宿主 sessionController 暴露给面板', async () => {
  let route;
  const controller = fakeSessionController();
  const ctx = { get(name) { return name === 'sessionController' ? controller : undefined; }, effect(fn) { fn(); }, connection: { fetch: { register(value) { route = value; return () => {}; } } } };
  apply(ctx, {});
  const response = await route.fetch(new Request('https://studio.example/api/personal-assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'personal-assistant', payload: { operation: 'personal-assistant.sessions.list', payload: { botId: 'writer' } } }) }));
  assert.equal((await response.json()).result.error.code, 'PERSONAL_ASSISTANT_GATEWAY_UNCONFIGURED');
  assert.equal(controller.calls.length, 0);
});
