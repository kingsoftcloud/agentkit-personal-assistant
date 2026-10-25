import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createComputerBrokerClient, createHttpComputerBrokerTransport } from '../src/computer-broker.mjs';
import { createComputerToolset } from '../src/cloud-computer-tools.mjs';
import { BotRegistry } from '../src/bot-registry.mjs';
import { createPersonalAssistantStateStore } from '../src/persistent-state.mjs';
import { attachDesktopWebSocket } from './desktop-ws.mjs';
import { pathToFileURL } from 'node:url';

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
let bots = [];
if (registryPath) {
  const parsed = JSON.parse(await readFile(registryPath, 'utf8'));
  bots = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.bots) ? parsed.bots : []);
}
const registry = runtime?.registry ?? new BotRegistry({ profileId: assistantId, bots });
const turnBridge = runtime?.turnBridge;

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
  return { unchanged: result.headers.get('x-desktop-unchanged') === '1', seq: Number(result.headers.get('x-desktop-seq') || 0), width: Number(result.headers.get('x-desktop-width') || 1280), height: Number(result.headers.get('x-desktop-height') || 800), bytes: Number(result.headers.get('x-desktop-bytes') || 0), data: Buffer.from(await result.arrayBuffer()) };
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
  return stateStore.putSchedule({ botId, scheduleId: body.scheduleId, runAt: body.runAt, metadata: body.metadata });
};
const sessionResource = pathname => {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)\/(messages|turns)$/u);
  return match ? { sessionId: decodeURIComponent(match[1]), resource: match[2] } : null;
};
const messageWrite = async (body, sessionId) => {
  const botId = stateBotId(body.botId);
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
const turnWrite = async (body, sessionId) => {
  const botId = stateBotId(body.botId);
  await requireSession(botId, sessionId);
  if (!turnBridge?.available) throw Object.assign(new Error('cloud DSH Session Controller unavailable'), { code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE', status: 503 });
  const turn = await stateStore.createTurn({ botId, sessionId, input: body.input, metadata: body.metadata });
  const message = await stateStore.appendMessage({ botId, sessionId, role: 'user', content: body.input, metadata: { turnId: turn.turnId } });
  try {
    const receipt = await turnBridge.submitTurn({ botId, sessionId, input: body.input, requestId: turn.turnId });
    await updateTurn(turn.turnId, { status: 'running', execution: receipt.execution, requestId: receipt.requestId });
    const pending = turnBridge.waitForTurn({ botId, sessionId, requestId: receipt.requestId }).then(async result => {
      for (const content of result.messages) await stateStore.appendMessage({ botId, sessionId, role: 'assistant', content, metadata: { turnId: turn.turnId, execution: receipt.execution } });
      await updateTurn(turn.turnId, { status: result.status, result: result.messages.join('\n'), error: result.error || null });
      console.info(JSON.stringify({ event: 'personal-assistant.turn.finished', botId, sessionId, turnId: turn.turnId, status: result.status }));
    }).catch(error => updateTurn(turn.turnId, { status: 'failed', error: error.code || error.message }));
    pendingTurns.add(pending);
    void pending.finally(() => pendingTurns.delete(pending));
    return { ...turn, status: 'running', messageId: message.messageId, ...receipt };
  } catch (error) {
    await updateTurn(turn.turnId, { status: 'failed', error: error.code || error.message });
    throw error;
  }
};

const server = createServer(async (request, response) => {
  try {
    const url = urlOf(request);
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/readyz')) return send(response, turnBridge?.available ? 200 : 503, { status: turnBridge?.available ? 'ready' : 'dsh-unavailable', assistantId, computerId, bots: registry.list().length, dshSessionController: turnBridge?.available === true, capabilities });
    requireRuntimeToken(request);
    if (request.method === 'GET' && url.pathname === '/v1/bots') return send(response, 200, { bots: registry.list() });
    if (request.method === 'GET' && url.pathname === '/v1/sessions') return send(response, 200, { sessions: await stateStore.sessions(stateBotId(url.searchParams.get('botId'))) });
    if (request.method === 'GET' && sessionResource(url.pathname)?.resource === 'messages') {
      const resource = sessionResource(url.pathname);
      return send(response, 200, { messages: await stateStore.messages({ botId: stateBotId(url.searchParams.get('botId')), sessionId: resource.sessionId }) });
    }
    if (request.method === 'GET' && sessionResource(url.pathname)?.resource === 'turns') {
      const resource = sessionResource(url.pathname);
      return send(response, 200, { turns: await stateStore.turns(stateBotId(url.searchParams.get('botId')), resource.sessionId) });
    }
    if (request.method === 'GET' && url.pathname === '/v1/memory') return send(response, 200, { memories: await stateStore.memory(stateBotId(url.searchParams.get('botId')), url.searchParams.get('query') || '') });
    if (request.method === 'GET' && url.pathname === '/v1/schedules') return send(response, 200, { schedules: await stateStore.schedules(stateBotId(url.searchParams.get('botId'))) });
    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/schedules/')) {
      const removed = await stateStore.removeSchedule(stateBotId(url.searchParams.get('botId')), decodeURIComponent(url.pathname.slice('/v1/schedules/'.length)));
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
attachDesktopWebSocket({ server, runtimeToken, assistantId, brokerDesktopRequest, brokerDesktopFrameBinary, botIdOf, taskIdOf });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
return { server, stateStore, waitForIdle: () => Promise.allSettled([...pendingTurns]), close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 没有真实 DSH Host 注入时 readiness 明确为 503，禁止伪造回合。
  const handle = await startAssistantRuntime({ argv: process.argv.slice(2) });
  const close = () => void handle.close().then(() => process.exit(0));
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
