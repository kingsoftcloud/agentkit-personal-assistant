import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createComputerBrokerClient, createHttpComputerBrokerTransport } from '../src/computer-broker.mjs';
import { createComputerToolset } from '../src/cloud-computer-tools.mjs';
import { BotRegistry } from '../src/bot-registry.mjs';
import { createPersonalAssistantStateStore } from '../src/persistent-state.mjs';
import { createCloudSessionChannel } from './cloud-session-channel.mjs';
import { attachDesktopWebSocket } from './desktop-ws.mjs';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createScheduleManager } from '../src/schedule-manager.mjs';
import { createCloudFileStore } from '../src/cloud-files.mjs';

export async function startAssistantRuntime({ runtime, env = process.env, argv = [] } = {}) {
const values = new Map();
for (let index = 0; index < argv.length; index += 1) {
  const key = argv[index];
  if (!key.startsWith('--')) continue;
  values.set(key.slice(2), argv[index + 1]?.startsWith('--') ? '' : (argv[++index] ?? ''));
}
const required = name => {
  const value = values.get(name) || env[name.toUpperCase().replaceAll('-', '_')];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const assistantId = required('assistant-id');
const computerId = required('computer-id');
const userId = required('user-id');
const brokerEndpoint = env.COMPUTER_BROKER_URL || required('computer-broker');
const host = env.AGENTKIT_RUNTIME_HOST || '0.0.0.0';
const port = Number(env.AGENTKIT_RUNTIME_PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid runtime port');
const capabilities = String(values.get('capabilities') || env.AGENTKIT_PERSONAL_ASSISTANT_CAPABILITIES || '').split(',').map(item => item.trim()).filter(Boolean);
const workspace = values.get('workspace') || env.WORKSPACE_PATH || env.AGENTKIT_WORKSPACE_DIR || '/workspace';
const artifacts = values.get('artifacts') || env.AGENTKIT_ARTIFACTS_DIR || `${workspace}/files`;
const state = values.get('state') || env.ASSISTANT_STATE_PATH || env.AGENTKIT_STATE_DIR || `${workspace}/.agentkit/state`;
const runtimeToken = env.AGENTKIT_RUNTIME_TOKEN || '';
const registryPath = values.get('bot-registry') || env.BOT_REGISTRY_PATH;
await mkdir(workspace, { recursive: true, mode: 0o700 });
await mkdir(artifacts, { recursive: true, mode: 0o750 });
await mkdir(state, { recursive: true, mode: 0o700 });
const stateStore = await createPersonalAssistantStateStore(state).init();
const cloudFiles = createCloudFileStore(`${workspace}/workspace`);
let bots = [];
if (registryPath) {
  const parsed = JSON.parse(await readFile(registryPath, 'utf8'));
  bots = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.bots) ? parsed.bots : []);
}
const registry = runtime?.registry ?? new BotRegistry({ profileId: assistantId, bots });
const turnBridge = runtime?.turnBridge;
turnBridge?.setMemoryProvider?.(botId => stateStore.memory(botId), (botId, value) => stateStore.putMemory({ ...value, botId }));
turnBridge?.setSessionOwnerResolver?.(async sessionId => (await stateStore.read('sessions')).find(row => row.sessionId === sessionId)?.botId);

const broker = createComputerBrokerClient({ transport: createHttpComputerBrokerTransport({ baseUrl: brokerEndpoint }) });

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};
const readBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(Object.assign(error, { code: 'INVALID_JSON' })); }
  });
  request.on('error', reject);
});
const requireRuntimeToken = request => {
  const authorization = String(request.headers.authorization || '');
  if (!runtimeToken || authorization !== `Bearer ${runtimeToken}`) throw Object.assign(new Error('runtime token required'), { code: 'RUNTIME_UNAUTHORIZED', status: 401 });
};
const brokerDesktopRequest = async (path, body) => {
  const result = await fetch(`${brokerEndpoint}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, userId, assistantId, computerId }) });
  const payload = await result.json().catch(() => ({ error: 'COMPUTER_BROKER_INVALID_RESPONSE' }));
  if (!result.ok) throw Object.assign(new Error(payload.error || 'computer broker request failed'), { code: payload.error || 'COMPUTER_BROKER_REQUEST_FAILED', status: result.status });
  return payload;
};
const brokerDesktopFrameBinary = async body => {
  const result = await fetch(`${brokerEndpoint}/broker/desktop/frame-binary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, userId, assistantId, computerId }) });
  if (!result.ok) { const payload = await result.json().catch(() => ({})); throw Object.assign(new Error(payload.error || 'computer frame failed'), { code: payload.error || 'COMPUTER_FRAME_FAILED', status: result.status }); }
  return { unchanged: result.headers.get('x-desktop-unchanged') === '1', seq: Number(result.headers.get('x-desktop-seq') || 0), width: Number(result.headers.get('x-desktop-width') || 1280), height: Number(result.headers.get('x-desktop-height') || 800), bytes: Number(result.headers.get('x-desktop-bytes') || 0), nextFrameDelayMs: Number(result.headers.get('x-desktop-next-frame-delay-ms') || 80), data: Buffer.from(await result.arrayBuffer()) };
};
const botIdOf = value => {
  const botId = String(value ?? '').trim();
  if (!botId) throw Object.assign(new Error('botId is required'), { code: 'BOT_REQUIRED' });
  registry.require(botId);
  return botId;
};
const taskIdOf = value => {
  const taskId = String(value ?? 'runtime-action').trim();
  if (!taskId || taskId.length > 128) throw Object.assign(new Error('taskId is invalid'), { code: 'TASK_INVALID' });
  return taskId;
};
const actionToolName = value => {
  const tool = String(value ?? '').trim();
  const allowed = new Set([
    'cloud_browser_open', 'cloud_browser_snapshot', 'cloud_browser_click',
    'cloud_browser_type', 'cloud_browser_press', 'cloud_browser_screenshot',
    'cloud_browser_download', 'cloud_browser_close', 'cloud_bash', 'cloud_run_code',
  ]);
  if (!allowed.has(tool)) throw Object.assign(new Error('unsupported personal assistant tool'), { code: 'TOOL_UNSUPPORTED' });
  return tool;
};
const computerStatus = async body => broker.status({ userId, assistantId, botId: botIdOf(body.botId), computerId });
const computerAction = async body => {
  const botId = botIdOf(body.botId);
  const tool = actionToolName(body.tool || body.name);
  const taskId = taskIdOf(body.taskId);
  const toolset = createComputerToolset({ broker, userId, assistantId, botId, computerId, taskId });
  try { return await toolset.executeRaw(tool, body.args || {}, { taskId }); }
  finally { await toolset.dispose(); }
};
// A deterministic, side-effect-free broker smoke: status, lease acquisition,
// and the close action all cross the localhost broker. `cloud_browser_close`
// does not launch a browser and therefore works even on a fresh Computer Pod.
const computerSmoke = async body => {
  const botId = botIdOf(body.botId);
  const taskId = taskIdOf(body.taskId || 'broker-smoke');
  const status = await broker.status({ userId, assistantId, botId, computerId });
  const toolset = createComputerToolset({ broker, userId, assistantId, botId, computerId, taskId });
  try {
    const action = await toolset.executeRaw('cloud_browser_close', {}, { taskId });
    return { status, action, smoke: 'passed' };
  } finally {
    await toolset.dispose();
  }
};

const urlOf = request => new URL(request.url || '/', `http://${host}:${port}`);
const stateBotId = value => botIdOf(value);
const sessionCreate = async body => {
  const botId = stateBotId(body.botId);
  return stateStore.createSession({ botId, title: body.title, metadata: body.metadata });
};
const memoryWrite = async body => {
  const botId = stateBotId(body.botId);
  return stateStore.putMemory({ botId, key: body.key, content: body.content, metadata: body.metadata });
};
const scheduleWrite = async body => {
  const botId = stateBotId(body.botId);
  if (!turnBridge?.available) throw Object.assign(new Error('cloud DSH Session Controller unavailable'), { code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE', status: 503 });
  const input = String(body.input ?? body.metadata?.input ?? '').trim();
  if (!input || Buffer.byteLength(input) > 64 * 1024) throw Object.assign(new Error('schedule input is required'), { code: 'SCHEDULE_INPUT_REQUIRED' });
  if (!Number.isSafeInteger(body.runAt) || body.runAt <= Date.now()) throw Object.assign(new Error('schedule must be in the future'), { code: 'SCHEDULE_INVALID' });
  const sessionId = body.sessionId || (await stateStore.createSession({ botId, title: `定时任务：${body.scheduleId}` })).sessionId;
  await requireSession(botId, sessionId);
  const row = await stateStore.putSchedule({ botId, scheduleId: body.scheduleId, runAt: body.runAt, metadata: { ...body.metadata, input, sessionId, generation: randomUUID() } });
  await patchSchedule(row, { status: 'pending' });
  armSchedule(row);
  return { ...row, status: 'pending' };
};
const sessionResource = pathname => {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)\/(messages|turns)$/u);
  return match ? { sessionId: decodeURIComponent(match[1]), resource: match[2] } : null;
};
const messageWrite = async (body, sessionId) => {
  const botId = stateBotId(body.botId);
  await requireSession(botId, sessionId);
  return stateStore.appendMessage({ botId, sessionId, role: body.role, content: body.content, metadata: body.metadata });
};
const requireSession = async (botId, sessionId) => {
  if (!(await stateStore.sessions(botId)).some(item => item.sessionId === sessionId)) throw Object.assign(new Error('session not found for Bot'), { code: 'SESSION_NOT_FOUND', status: 404 });
};
const updateTurn = (turnId, patch) => stateStore.mutate('turns', rows => {
  const row = rows.find(item => item.turnId === turnId);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  return row;
});
const pendingTurns = new Set();
const submissionLocks = new Map();
const scheduler = runtime?.scheduleManager ?? createScheduleManager();
const scheduleKey = row => `task-${createHash('sha256').update(JSON.stringify([row.botId, row.scheduleId])).digest('hex')}`;
const patchSchedule = (record, patch) => stateStore.mutate('schedules', rows => {
  const row = rows.find(item => item.botId === record.botId && item.scheduleId === record.scheduleId);
  if (!row || row.metadata?.generation !== record.metadata?.generation) return null;
  Object.assign(row, patch);
  return row;
});
function armSchedule(row) {
  scheduler.scheduleOnce({ scheduleId: scheduleKey(row), runAt: Math.min(Math.max(Date.now() + 1, row.nextRunAt), Date.now() + 2_147_483_647), task: async () => {
    try {
      if (row.nextRunAt > Date.now()) { armSchedule(row); return; }
      const claimed = await patchSchedule(row, { status: 'running', startedAt: new Date().toISOString() });
      if (!claimed) return;
      const receipt = await turnWrite({ botId: row.botId, input: row.metadata.input, metadata: { scheduleId: row.scheduleId } }, row.metadata.sessionId);
      await Promise.allSettled([...pendingTurns]);
      const turn = (await stateStore.turns(row.botId, row.metadata.sessionId)).find(item => item.turnId === receipt.turnId);
      await patchSchedule(row, { status: turn?.status === 'completed' ? 'completed' : 'failed', turnId: receipt.turnId, finishedAt: new Date().toISOString(), error: turn?.error || null });
      console.info(JSON.stringify({ event: 'personal-assistant.schedule.finished', botId: row.botId, scheduleId: row.scheduleId, turnId: receipt.turnId, status: turn?.status || 'failed' }));
    } catch (error) { await patchSchedule(row, { status: 'failed', error: error.code || 'SCHEDULE_EXECUTION_FAILED' }); }
  } });
}
const turnWrite = async (body, sessionId) => {
  const key = JSON.stringify([body.botId, sessionId]);
  const previous = submissionLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => submitCloudTurn(body, sessionId));
  submissionLocks.set(key, current);
  try { return await current; } finally { if (submissionLocks.get(key) === current) submissionLocks.delete(key); }
};
// 一轮对话的观察上限：DSH 侧的工具/长命令可能跑很久，5 分钟会把正常任务误判成超时，
// 进而在会话里留下永久的 failed turn（面板一直显示“任务失败：DSH_TURN_TIMEOUT”）。
const TURN_OBSERVE_TIMEOUT_MS = 30 * 60_000;
// 同一会话的轮次串行执行：上一轮真正结束（含 DSH turn/end）后才提交下一轮，
// 而不是把“上一轮还在跑”的用户消息记成 DSH_SESSION_BUSY 的失败任务。
const sessionTurnChains = new Map();
const sessionChainKey = (botId, sessionId) => `${botId}\u0000${sessionId}`;

const trackTurnWork = promise => {
  pendingTurns.add(promise);
  void promise.catch(() => {}).finally(() => pendingTurns.delete(promise));
};

const buildTurnContent = async (body, botId, sessionId) => {
  const content = [{ type: 'text', text: body.input }];
  for (const attachment of body.attachments || []) {
    const data = await cloudFiles.attachment({ botId, sessionId, path: attachment.path });
    // 只有明确的图像附件进入模型图片通道；其他文件由工作区工具读取处理。
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mediaType)) {
      const store = runtime?.ctx?.get?.('attachments');
      if (!store?.saveImage) throw Object.assign(new Error('云端图片附件服务不可用'), { status: 503 });
      const ref = await store.saveImage({ data, mediaType: attachment.mediaType, name: attachment.name });
      content.push({ type: 'image', attachment: ref });
    }
  }
  return content;
};

// bridge 的 busy 标记在 waitForTurn 的 finally 里释放，链式排队后理论上不会撞上；
// 仍保留短重试兜底（例如云端 DSH 内部还有未归位的旧 turn）。
const submitWithBusyRetry = async args => {
  for (let attempt = 0; ; attempt += 1) {
    try { return await turnBridge.submitTurn(args); }
    catch (error) {
      if (error?.code !== 'DSH_SESSION_BUSY' || attempt >= 20) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
};

const observeTurn = async ({ botId, sessionId, turn, clientTurnId, receipt }) => {
  const result = await turnBridge.waitForTurn({ botId, sessionId, requestId: receipt.requestId, timeoutMs: TURN_OBSERVE_TIMEOUT_MS, onProgress: progress => updateTurn(turn.turnId, { progress }) });
  for (const content of result.messages) await stateStore.appendMessage({ botId, sessionId, role: 'assistant', content, metadata: { turnId: turn.turnId, ...(clientTurnId ? { clientTurnId } : {}), execution: receipt.execution } });
  await updateTurn(turn.turnId, { status: result.status, result: result.messages.join('\n'), error: result.error || null });
  console.info(JSON.stringify({ event: 'personal-assistant.turn.finished', botId, sessionId, turnId: turn.turnId, status: result.status }));
};

const executeTurn = async ({ botId, sessionId, body, turn, clientTurnId }) => {
  try {
    const content = await buildTurnContent(body, botId, sessionId);
    const receipt = await submitWithBusyRetry({ botId, sessionId, input: body.input, parts: content, requestId: turn.turnId });
    await updateTurn(turn.turnId, { status: 'running', execution: receipt.execution, requestId: receipt.requestId });
    await observeTurn({ botId, sessionId, turn, clientTurnId, receipt });
  } catch (error) {
    await updateTurn(turn.turnId, { status: 'failed', error: error.code || error.message });
    throw error;
  }
};

const submitCloudTurn = async (body, sessionId) => {
  const botId = stateBotId(body.botId);
  await requireSession(botId, sessionId);
  if (!turnBridge?.available) throw Object.assign(new Error('cloud DSH Session Controller unavailable'), { code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE', status: 503 });
  const clientTurnId = body.metadata?.clientTurnId;
  if (clientTurnId) {
    const existing = (await stateStore.turns(botId, sessionId)).find(row => row.metadata?.clientTurnId === clientTurnId);
    if (existing) {
      if (existing.input !== body.input) throw Object.assign(new Error('同一发送标识不能改变内容'), { code: 'CLIENT_TURN_CONFLICT', status: 409 });
      return existing;
    }
  }
  const turn = await stateStore.createTurn({ botId, sessionId, input: body.input, metadata: body.metadata });
  const message = await stateStore.appendMessage({ botId, sessionId, role: 'user', content: body.input, metadata: { turnId: turn.turnId, ...(clientTurnId ? { clientTurnId } : {}) } });
  const key = sessionChainKey(botId, sessionId);
  const previous = sessionTurnChains.get(key);
  if (previous) {
    // 上一轮还没结束：保留 queued 状态，等它完成后再提交，不产生失败任务。
    const queued = previous.catch(() => {}).then(() => executeTurn({ botId, sessionId, body, turn, clientTurnId }));
    sessionTurnChains.set(key, queued);
    void queued.catch(() => {}).finally(() => { if (sessionTurnChains.get(key) === queued) sessionTurnChains.delete(key); });
    trackTurnWork(queued);
    return { ...turn, status: 'queued', messageId: message.messageId };
  }
  // 会话空闲：立即提交，保持原有“提交即返回 running + requestId”的接口语义。
  let receipt;
  try { receipt = await submitWithBusyRetry({ botId, sessionId, input: body.input, parts: await buildTurnContent(body, botId, sessionId), requestId: turn.turnId }); }
  catch (error) {
    await updateTurn(turn.turnId, { status: 'failed', error: error.code || error.message });
    throw error;
  }
  await updateTurn(turn.turnId, { status: 'running', execution: receipt.execution, requestId: receipt.requestId });
  const observed = observeTurn({ botId, sessionId, turn, clientTurnId, receipt }).catch(error => updateTurn(turn.turnId, { status: 'failed', error: error.code || error.message }));
  sessionTurnChains.set(key, observed);
  void observed.finally(() => { if (sessionTurnChains.get(key) === observed) sessionTurnChains.delete(key); });
  trackTurnWork(observed);
  return { ...turn, status: 'running', messageId: message.messageId, ...receipt };
};

// 尚未开始的任务可恢复；中断时不自动重放未知结果，避免重复执行操作。
await stateStore.mutate('turns', rows => {
  for (const row of rows) if (row.status === 'running' || row.status === 'queued') Object.assign(row, { status: 'interrupted', error: 'RUNTIME_PROCESS_INTERRUPTED', updatedAt: new Date().toISOString() });
});
for (const row of await stateStore.read('schedules')) {
  if (row.status === 'running') await patchSchedule(row, { status: 'interrupted', error: 'SCHEDULE_PROCESS_INTERRUPTED' });
  else if ((!row.status || row.status === 'pending') && row.metadata?.input && row.metadata?.sessionId) armSchedule(row);
}
runtime?.setAutomationService?.(async args => {
  const botId = stateBotId(args.botId);
  if (args.action === 'list') return { schedules: await stateStore.schedules(botId) };
  if (args.action === 'create') return scheduleWrite({ botId, scheduleId: args.scheduleId || randomUUID(), runAt: args.runAt, input: args.input });
  if (typeof args.scheduleId !== 'string') throw new TypeError('scheduleId is required');
  const row = (await stateStore.schedules(botId)).find(row => row.scheduleId === args.scheduleId);
  if (row?.status === 'running') throw Object.assign(new Error('任务已开始执行，不能伪报取消'), { status: 409 });
  if (row) { scheduler.cancel(scheduleKey(row)); await patchSchedule(row, { status: 'cancelled' }); }
  return { cancelled: Boolean(row) };
});

const server = createServer(async (request, response) => {
  try {
    const url = urlOf(request);
    if (request.method === 'GET' && ['/health', '/ready', '/readyz'].includes(url.pathname)) return send(response, turnBridge?.available === true ? 200 : 503, { status: turnBridge?.available === true ? 'ready' : 'dsh-unavailable', assistantId, computerId, bots: registry.list().length, dshSessionController: turnBridge?.available === true, capabilities });
    requireRuntimeToken(request);
    if (request.method === 'GET' && url.pathname === '/v1/bots') return send(response, 200, { bots: registry.list() });
    if (request.method === 'GET' && url.pathname === '/v1/sessions') return send(response, 200, { sessions: await stateStore.sessions(stateBotId(url.searchParams.get('botId'))) });
    if (request.method === 'GET' && sessionResource(url.pathname)?.resource === 'messages') {
      const resource = sessionResource(url.pathname);
      const botId = stateBotId(url.searchParams.get('botId')); await requireSession(botId, resource.sessionId);
      return send(response, 200, { messages: await stateStore.messages({ botId, sessionId: resource.sessionId }) });
    }
    if (request.method === 'GET' && sessionResource(url.pathname)?.resource === 'turns') {
      const resource = sessionResource(url.pathname);
      const botId = stateBotId(url.searchParams.get('botId')); await requireSession(botId, resource.sessionId);
      return send(response, 200, { turns: await stateStore.turns(botId, resource.sessionId) });
    }
    if (request.method === 'GET' && url.pathname === '/v1/memory') return send(response, 200, { memories: await stateStore.memory(stateBotId(url.searchParams.get('botId')), url.searchParams.get('query') || '') });
    if (request.method === 'GET' && url.pathname === '/v1/schedules') return send(response, 200, { schedules: await stateStore.schedules(stateBotId(url.searchParams.get('botId'))) });
    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/schedules/')) {
      const botId = stateBotId(url.searchParams.get('botId')), scheduleId = decodeURIComponent(url.pathname.slice('/v1/schedules/'.length));
      scheduler.cancel(scheduleKey({ botId, scheduleId }));
      const removed = await stateStore.removeSchedule(botId, scheduleId);
      return send(response, 200, { removed });
    }
    if (request.method !== 'POST') return send(response, 404, { error: 'not_found' });
    const body = await readBody(request);
    if (url.pathname === '/v1/computer/status') return send(response, 200, await computerStatus(body));
    if (url.pathname === '/v1/computer/action') return send(response, 200, await computerAction(body));
    if (url.pathname === '/v1/computer/smoke') return send(response, 200, await computerSmoke(body));
    if (url.pathname === '/v1/computer/desktop/session') { requireRuntimeToken(request); return send(response, 200, await brokerDesktopRequest('/broker/desktop/session', { botId: botIdOf(body.botId), taskId: taskIdOf(body.taskId), leaseId: body.leaseId || undefined })); }
    if (url.pathname === '/v1/computer/desktop/frame') { requireRuntimeToken(request); return send(response, 200, await brokerDesktopRequest('/broker/desktop/frame', { sessionId: body.sessionId, afterSeq: body.afterSeq })); }
    if (url.pathname === '/v1/computer/desktop/input') { requireRuntimeToken(request); return send(response, 202, await brokerDesktopRequest('/broker/desktop/input', { sessionId: body.sessionId, botId: botIdOf(body.botId), taskId: taskIdOf(body.taskId), leaseId: body.leaseId, event: body.event })); }
    if (url.pathname === '/v1/computer/desktop/close') { requireRuntimeToken(request); return send(response, 200, await brokerDesktopRequest('/broker/desktop/close', { sessionId: body.sessionId })); }
    if (url.pathname === '/v1/sessions') return send(response, 201, await sessionCreate(body));
    if (sessionResource(url.pathname)?.resource === 'messages') return send(response, 201, await messageWrite(body, sessionResource(url.pathname).sessionId));
    if (sessionResource(url.pathname)?.resource === 'turns') return send(response, 202, await turnWrite(body, sessionResource(url.pathname).sessionId));
    if (url.pathname === '/v1/memory') return send(response, 201, await memoryWrite(body));
    if (url.pathname === '/v1/schedules') return send(response, 201, await scheduleWrite(body));
    return send(response, 404, { error: 'not_found' });
  } catch (error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 400;
    return send(response, status, { error: error?.code || error?.message || 'PERSONAL_ASSISTANT_RUNTIME_FAILED' });
  }
});
attachDesktopWebSocket({ server, runtimeToken, assistantId, brokerDesktopRequest, brokerDesktopFrameBinary, botIdOf, taskIdOf, listBots: () => registry.list(), sessionRequest: createCloudSessionChannel({ assistantId, computerId, stateStore, registry, sessionCreate, turnWrite, scheduleWrite, cloudFiles }) });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
return { server, stateStore, waitForIdle: () => Promise.allSettled([...pendingTurns]), close: () => { scheduler.dispose(); return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 没有真实 DSH Host 注入时 readiness 明确为 503，禁止伪造回合。
  const handle = await startAssistantRuntime({ argv: process.argv.slice(2) });
  const close = () => void handle.close().then(() => process.exit(0));
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
