/**
 * 对话稳定性回归：校准失败、轮询失败、cursor 失效、会话切换竞态、发送超时。
 *
 * 全部用「真实组件 + 假 React / 假云端会话通道 / 假 localStorage / 假定时器」驱动：
 * 失败与恢复由可控 promise 与定时器推进，不依赖 sleep 碰运气。
 *
 * 假通道按云端 `runtime/cloud-session-channel.mjs` 的真实契约实现：
 * cursor 是消息数组下标，snapshot 返回 `{messages, cursor, turns}`，events 返回
 * `{events, cursor, done, turns}`，turn.submit 按 clientTurnId 幂等。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantConversation } from '../src/client/conversation.mjs';

const STORAGE_PREFIX = 'agentkit.personal-assistant.current-session.v1';
const SNAPSHOT_VERSION = 1;
const SCOPE = { agentId: 'ar-test', botId: 'writer' };

const timeoutError = () => Object.assign(new Error('云端响应超时；发送结果待确认，请勿重复创建任务'), {
  code: 'PERSONAL_ASSISTANT_CLOUD_SESSION_TIMEOUT', status: 504,
});
const unavailableError = () => Object.assign(new Error('云端会话连接中断；请核对发送状态后重试'), {
  code: 'PERSONAL_ASSISTANT_CLOUD_SESSION_UNAVAILABLE', status: 503,
});
const staleError = () => Object.assign(new Error('会话日志已更新，请重新同步'), { code: 'SESSION_CURSOR_STALE', status: 409 });

/* ----------------------------- 假宿主存储 ----------------------------- */

const pointerKey = scope => `${STORAGE_PREFIX}:${encodeURIComponent(scope.agentId)}:${encodeURIComponent(scope.botId)}`;
const snapshotKey = (scope, sessionId) => `${pointerKey(scope)}:snapshot:${encodeURIComponent(sessionId)}`;
const cachedSnapshot = (scope, sessionId, messages) => JSON.stringify({
  version: SNAPSHOT_VERSION, sessionId, savedAt: 1,
  messages: messages.map(row => ({ id: row.id, role: row.role, text: row.text })),
});

function installStorage(t, entries = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map(Object.entries(entries));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: {
      getItem: key => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  return values;
}

/* ----------------------------- 假云端会话通道 ----------------------------- */

function fakeHost() {
  const state = {
    sessions: [{ sessionId: 's1' }],
    createdSessionId: 's2',
    /** @type {Array<{messageId: string, role: string, text: string, metadata?: object}>} */
    messages: [],
    /** @type {Array<{turnId: string, status: string, error?: string, progress?: object, metadata?: object}>} */
    turns: [],
    submitted: [],
    requests: [],
    failures: new Map(),
    hangs: new Map(),
    seq: 0,
  };

  const messageEvent = (row, seq) => ({
    type: 'message', id: row.messageId, messageId: row.messageId, seq,
    role: row.role, text: row.text, done: true,
    ...(row.metadata?.clientTurnId ? { clientTurnId: row.metadata.clientTurnId } : {}),
  });
  const turnRows = () => state.turns.slice(-20).map(row => ({
    turnId: row.turnId, status: row.status, error: row.error, progress: row.progress,
    clientTurnId: row.metadata?.clientTurnId,
  }));

  const handlers = {
    'sessions.list': () => ({ sessions: state.sessions.map(row => ({ ...row })) }),
    'session.create': () => {
      const id = state.createdSessionId;
      if (!state.sessions.some(row => row.sessionId === id)) state.sessions.push({ sessionId: id });
      return { sessionId: id };
    },
    'session.snapshot': payload => ({
      sessionId: payload.sessionId,
      epoch: payload.sessionId,
      messages: state.messages.map((row, index) => messageEvent(row, index)),
      cursor: state.messages.length,
      turns: turnRows(),
    }),
    'session.events': payload => {
      const cursor = Number(payload.cursor) || 0;
      // 与云端一致的失效语义：游标超过日志长度说明日志被重写。
      if (cursor > state.messages.length) throw staleError();
      const page = state.messages.slice(cursor, cursor + 100);
      return {
        sessionId: payload.sessionId,
        epoch: payload.sessionId,
        events: page.map((row, index) => messageEvent(row, cursor + index)),
        cursor: cursor + page.length,
        done: cursor + page.length >= state.messages.length,
        turns: turnRows(),
      };
    },
    'turn.submit': payload => {
      state.submitted.push(payload);
      // 云端按 clientTurnId 幂等：重试用同一标识时返回原来那一轮，不重复落库。
      const existing = state.messages.find(row => row.metadata?.clientTurnId === payload.clientTurnId);
      if (existing) return { turnId: existing.metadata.turnId };
      const turnId = `turn-${state.turns.length + 1}`;
      state.messages.push({ messageId: `m-${++state.seq}`, role: 'user', text: payload.text, metadata: { clientTurnId: payload.clientTurnId, turnId } });
      state.turns.push({ turnId, status: 'running', metadata: { clientTurnId: payload.clientTurnId } });
      return { turnId };
    },
  };

  const opOf = operation => String(operation).replace(/^personal-assistant\./u, '');
  const fail = (op, error, { sideEffect = false } = {}) => {
    const list = state.failures.get(op) || [];
    list.push({ error, sideEffect });
    state.failures.set(op, list);
  };
  const defer = op => {
    const holder = {};
    holder.promise = new Promise((resolve, reject) => {
      holder.resolve = value => resolve(value);
      holder.reject = reason => reject(reason);
    });
    const list = state.hangs.get(op) || [];
    list.push(holder);
    state.hangs.set(op, list);
    return holder;
  };

  const request = (operation, payload = {}) => {
    const op = opOf(operation);
    state.requests.push({ operation: op, payload });
    const failures = state.failures.get(op);
    if (failures?.length) {
      const entry = failures.shift();
      // 发送超时经常是「云端已经接受，只是响应丢了」：先落库再报错，逼客户端靠事件自愈。
      if (entry.sideEffect) {
        try { handlers[op]?.(payload); } catch { /* 忽略 */ }
      }
      return Promise.reject(entry.error);
    }
    const hangs = state.hangs.get(op);
    if (hangs?.length) return hangs.shift().promise;
    return Promise.resolve(handlers[op]?.(payload) ?? {});
  };

  return {
    state,
    request,
    fail,
    defer,
    pushMessage: (role, text, metadata) => state.messages.push({ messageId: `m-${++state.seq}`, role, text, metadata }),
    completeTurn: text => {
      const turn = state.turns.at(-1);
      if (turn) turn.status = 'completed';
      if (text) state.messages.push({ messageId: `m-${++state.seq}`, role: 'assistant', text });
    },
  };
}

/* ----------------------------- 假 React 运行时 ----------------------------- */

function conversation(t, host, { scope = SCOPE, initialSessionId = '' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hooks = [], pendingEffects = [];
  let cursor = 0, dirty = true, tree;
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((value, index) => value !== before[index]);

  const R = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; dirty = true; }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!hooks[index] || changed(hooks[index].deps, deps)) hooks[index] = { deps, callback };
      return hooks[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (hooks[index] && !changed(hooks[index].deps, deps)) return;
      const previous = hooks[index];
      hooks[index] = { deps, cleanup: null };
      pendingEffects.push(() => {
        if (typeof previous?.cleanup === 'function') previous.cleanup();
        const cleanup = effect();
        hooks[index].cleanup = typeof cleanup === 'function' ? cleanup : null;
      });
    },
  };

  const render = () => {
    cursor = 0; dirty = false;
    tree = PersonalAssistantConversation({ React: R, request: host.request, scope, initialSessionId });
    for (const run of pendingEffects.splice(0)) run();
  };
  const flush = async (rounds = 10) => { for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setImmediate(resolve)); };
  const settle = async (rounds = 30) => {
    for (let index = 0; index < rounds; index += 1) {
      if (dirty) render();
      else if (index === 0) render();
      await new Promise(resolve => setImmediate(resolve));
    }
    render();
    return tree;
  };

  const nodesOf = node => (node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(nodesOf)] : []);
  const all = () => nodesOf(tree);
  const textOf = node => (node && typeof node === 'object'
    ? (node.children || []).map(child => (typeof child === 'string' ? child : textOf(child))).join(' ')
    : '');
  const byLabel = label => all().find(node => node.props?.['aria-label'] === label);

  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    for (const hook of hooks) {
      if (typeof hook?.cleanup === 'function') { const cleanup = hook.cleanup; hook.cleanup = null; cleanup(); }
    }
  };
  t.after(unmount);

  return {
    settle,
    flush,
    unmount,
    tree: () => tree,
    nodes: all,
    text: () => textOf(tree),
    hasText: fragment => textOf(tree).includes(fragment),
    requestsOf: op => host.state.requests.filter(row => row.operation === op),
    type: async value => {
      all().find(node => node.type === 'textarea').props.onChange({ target: { value } });
      await settle();
    },
    send: async () => {
      byLabel('发送消息')?.props.onClick?.();
      await settle();
    },
    newSession: () => all().find(node => node.props?.['aria-label'] === '新建会话')?.props.onClick?.(),
    tick: async ms => { t.mock.timers.tick(ms); await settle(); },
    draft: () => all().find(node => node.type === 'textarea').props.value,
  };
}

/* ----------------------------- 用例 ----------------------------- */

test('快照请求超时：缓存先回显，退避自动重试校准后恢复增量轮询', async t => {
  installStorage(t, {
    [pointerKey(SCOPE)]: 's1',
    [snapshotKey(SCOPE, 's1')]: cachedSnapshot(SCOPE, 's1', [{ id: 'm-0', role: 'assistant', text: '缓存里的旧历史' }]),
  });
  const host = fakeHost();
  host.pushMessage('assistant', '缓存里的旧历史');
  host.fail('session.snapshot', timeoutError());
  host.fail('session.snapshot', timeoutError());
  const view = conversation(t, host);
  await view.settle();

  assert.ok(view.hasText('缓存里的旧历史'), '校准失败时缓存内容必须留在屏幕上，不能白屏');
  assert.equal(view.hasText('暂时连不上个人助理'), false, '有缓存时不能整页报错');

  // 第一次退避 400ms 后自动重试（仍失败），第二次退避 1000ms。
  host.pushMessage('assistant', '校准后的历史');
  await view.tick(400);
  await view.tick(1000);
  assert.ok(view.requestsOf('session.snapshot').length >= 3, `快照失败必须自动重试，实际 ${view.requestsOf('session.snapshot').length} 次`);
  assert.ok(view.hasText('校准后的历史'), '重试成功后要用云端快照校准');

  await view.tick(200);
  host.pushMessage('assistant', '恢复后的在线回复');
  await view.tick(600);
  assert.ok(view.requestsOf('session.events').length > 0, '校准成功后必须启动增量轮询');
  assert.ok(view.hasText('恢复后的在线回复'), '校准恢复后要继续收增量，不能停在旧内容');
});

test('会话目录暂时不可用：自动重试后进入会话，不永久停在报错页', async t => {
  installStorage(t, {});
  const host = fakeHost();
  host.fail('sessions.list', unavailableError());
  const view = conversation(t, host);
  await view.settle();

  assert.match(view.text(), /暂时连不上个人助理/u, '首次失败仍要给可读报错');
  await view.tick(400);
  await view.tick(200);
  assert.ok(view.requestsOf('sessions.list').length >= 2, '目录失败要自动重试');
  assert.equal(view.nodes().find(node => node.props?.['data-session-id'])?.props['data-session-id'], 's1', '重试成功后要进入会话');
  assert.ok(view.requestsOf('session.events').length > 0, '恢复后轮询必须启动');
});

test('events 拒绝值不是 Error：不产生未捕获异常，轮询不能永久停摆', async t => {
  installStorage(t, { [pointerKey(SCOPE)]: 's1' });
  const rejections = [];
  const onRejection = reason => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));

  const host = fakeHost();
  host.fail('session.events', null);
  host.fail('session.events', 'network down');
  const view = conversation(t, host);
  await view.settle();

  await view.tick(200);   // 轮询 #1：reject(null)
  await view.tick(600);   // 退避中，不再请求
  await view.tick(1200);  // 轮询 #2：reject('network down')
  host.pushMessage('assistant', '恢复后的回复');
  await view.tick(2400);  // 指数退避后轮询 #3 恢复

  assert.deepEqual(rejections, [], '轮询失败不能变成未捕获的 Promise 异常');
  assert.ok(view.requestsOf('session.events').length >= 3, `轮询不能因为一次失败永久停摆，实际 ${view.requestsOf('session.events').length} 次`);
  assert.ok(view.hasText('恢复后的回复'), '轮询恢复后要继续收增量');
});

test('events 连续失败按指数退避重试，恢复后不丢增量', async t => {
  installStorage(t, { [pointerKey(SCOPE)]: 's1' });
  const host = fakeHost();
  host.fail('session.events', unavailableError());
  const view = conversation(t, host);
  await view.settle();

  await view.tick(200);  // 轮询 #1 失败
  const failed = view.requestsOf('session.events').length;
  await view.tick(600);  // 旧实现 600ms 后立刻再打；应退避到 1200ms 之后
  assert.equal(view.requestsOf('session.events').length, failed, '失败后必须退避，不能按正常 600ms 继续打云端');

  host.pushMessage('assistant', '退避后恢复的回复');
  await view.tick(600);  // 累计 1200ms → 重试
  assert.ok(view.requestsOf('session.events').length > failed, '退避结束后必须自动重试，不能永久停摆');
  assert.ok(view.hasText('退避后恢复的回复'), '恢复后要把错过的增量补上');
});

test('cursor 失效重开会话：快照再失败也要自愈，不能永久停在旧内容', async t => {
  installStorage(t, { [pointerKey(SCOPE)]: 's1' });
  const host = fakeHost();
  const view = conversation(t, host);
  await view.settle();

  host.fail('session.events', staleError());   // 下一次增量：游标失效
  host.fail('session.snapshot', timeoutError()); // 重开会话时的快照再失败一次
  host.pushMessage('assistant', '重开会话后读到的新历史');
  await view.tick(200);
  await view.tick(400);
  await view.tick(200);
  host.pushMessage('assistant', '自愈后的增量');
  await view.tick(600);

  assert.ok(view.requestsOf('session.snapshot').length >= 2, '游标失效要重开会话并重试快照');
  assert.ok(view.hasText('重开会话后读到的新历史'), '重开会话后要显示云端最新历史');
  assert.ok(view.hasText('自愈后的增量'), '自愈后必须继续轮询增量');
});

test('发送响应超时（云端其实已接受）：不显示失败气泡，自动重试并认领同一轮', async t => {
  installStorage(t, { [pointerKey(SCOPE)]: 's1' });
  const host = fakeHost();
  const view = conversation(t, host);
  await view.settle();

  await view.type('你好');
  host.fail('turn.submit', timeoutError(), { sideEffect: true });
  await view.send();
  assert.ok(view.hasText('重试发送') === false, '瞬时超时不能显示成失败气泡');
  assert.match(view.text(), /正在处理|排队/u, '发送结果待确认时要保持进行中的反馈');

  await view.tick(1500);  // 退避后自动重试（同一 clientTurnId，云端幂等）
  host.completeTurn('云端其实收到了');
  await view.tick(600);
  await view.tick(600);

  const submits = view.requestsOf('turn.submit');
  assert.ok(submits.length >= 2, `超时后要自动重试，实际 ${submits.length} 次`);
  assert.equal(new Set(submits.map(row => row.payload.clientTurnId)).size, 1, '重试必须复用同一 clientTurnId，避免云端重复建轮');
  assert.ok(view.hasText('云端其实收到了'), '轮次完成后要能看到云端回复');
  assert.equal(view.hasText('重试发送'), false);
});

test('切换会话时旧会话的在途增量不能写进新会话，也不能污染新会话游标', async t => {
  installStorage(t, {});
  const host = fakeHost();
  const view = conversation(t, host);
  await view.settle();

  const inFlight = host.defer('session.events');
  await view.tick(200);          // 旧会话 s1 的增量请求挂起
  view.newSession();             // 切到 s2；切换在微任务里推进，但还没重新渲染清理旧 effect
  await view.flush();
  inFlight.resolve({
    sessionId: 's1', cursor: 9,
    events: [{ type: 'message', id: 'm-old', role: 'assistant', text: '旧会话的回复', done: true }],
    turns: [],
  });
  await view.flush();
  await view.settle();
  await view.tick(200);

  assert.equal(view.hasText('旧会话的回复'), false, '旧会话的增量不能出现在新会话里');
  const nextEvents = view.requestsOf('session.events').filter(row => row.payload.sessionId === 's2');
  assert.ok(nextEvents.length > 0, '切换后要继续为新会话轮询');
  assert.ok(nextEvents.every(row => row.payload.cursor === 0), `新会话必须从自己的游标开始，实际 ${JSON.stringify(nextEvents.map(row => row.payload.cursor))}`);
});

test('增量节流写缓存时补一次尾写：最后一轮消息也要落进本地快照', async t => {
  const storage = installStorage(t, {});
  const host = fakeHost();
  const view = conversation(t, host);
  await view.settle();

  host.pushMessage('assistant', '第一轮回复');
  await view.tick(200);
  await view.tick(600);
  host.pushMessage('assistant', '最后一轮回复');
  await view.tick(600);
  await view.tick(1500);

  const raw = storage.get(snapshotKey(SCOPE, 's1'));
  assert.ok(raw, '有消息后必须写本地快照');
  assert.ok(JSON.parse(raw).messages.some(row => row.text === '最后一轮回复'), '节流不能把尾消息永久跳过，重开面板会停在旧内容');
});

test('轮询故障恢复后多轮对话继续：后续消息不会永远卡在排队', async t => {
  installStorage(t, {});
  const host = fakeHost();
  const view = conversation(t, host);
  await view.settle();

  // 第一轮正常完成
  await view.type('第一轮');
  await view.send();
  host.completeTurn('第一轮回复');
  await view.tick(600);
  await view.tick(600);
  assert.ok(view.hasText('第一轮回复'), '第一轮要能看到云端回复');

  // 云端偶发一次非 Error 拒绝（连接重建期间的典型形态），随后恢复
  host.fail('session.events', null);
  await view.tick(600);    // 失败，进入退避
  await view.tick(1200);   // 退避后恢复

  // 第二轮仍要能真正发出去并收到回复
  await view.type('第二轮');
  await view.send();
  host.completeTurn('第二轮回复');
  await view.tick(600);
  await view.tick(600);

  const submits = view.requestsOf('turn.submit');
  assert.equal(submits.length, 2, `第二轮必须真正发出，实际 ${submits.length} 次提交`);
  assert.ok(view.hasText('第二轮回复'), '轮询恢复后多轮对话要能继续');
});

test('卸载后自动重试与轮询一起停下：不再有定时器请求云端', async t => {
  installStorage(t, {});
  const host = fakeHost();
  host.fail('session.snapshot', timeoutError());  // 快照一直失败 → 会挂一个退避重试定时器
  const view = conversation(t, host);
  await view.settle();
  assert.equal(view.requestsOf('session.snapshot').length, 1, '快照失败要安排一次重试');

  view.unmount();
  const before = host.state.requests.length;
  t.mock.timers.tick(60_000);   // 把重试/轮询定时器全部推过到期点
  await view.flush();

  assert.equal(host.state.requests.length, before, '卸载后不能再有任何请求（定时器必须清理）');
});
