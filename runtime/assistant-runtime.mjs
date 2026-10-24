import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createComputerBrokerClient, createHttpComputerBrokerTransport } from '../src/computer-broker.mjs';
import { createComputerToolset } from '../src/cloud-computer-tools.mjs';
import { BotRegistry } from '../src/bot-registry.mjs';
import { createPersonalAssistantStateStore } from '../src/persistent-state.mjs';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--')) continue;
  values.set(key.slice(2), process.argv[index + 1]?.startsWith('--') ? '' : (process.argv[++index] ?? ''));
}
const required = name => {
  const value = values.get(name) || process.env[name.toUpperCase().replaceAll('-', '_')];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const assistantId = required('assistant-id');
const computerId = required('computer-id');
const userId = required('user-id');
const brokerEndpoint = required('computer-broker');
const host = process.env.AGENTKIT_RUNTIME_HOST || '0.0.0.0';
const port = Number(process.env.AGENTKIT_RUNTIME_PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid runtime port');
const capabilities = String(values.get('capabilities') || process.env.AGENTKIT_PERSONAL_ASSISTANT_CAPABILITIES || '').split(',').map(item => item.trim()).filter(Boolean);
const workspace = values.get('workspace') || process.env.WORKSPACE_PATH || process.env.AGENTKIT_WORKSPACE_DIR || '/workspace';
const artifacts = values.get('artifacts') || process.env.AGENTKIT_ARTIFACTS_DIR || `${workspace}/files`;
const state = values.get('state') || process.env.ASSISTANT_STATE_PATH || process.env.AGENTKIT_STATE_DIR || `${workspace}/.agentkit/state`;
const registryPath = values.get('bot-registry') || process.env.BOT_REGISTRY_PATH;
await mkdir(workspace, { recursive: true, mode: 0o700 });
await mkdir(artifacts, { recursive: true, mode: 0o750 });
await mkdir(state, { recursive: true, mode: 0o700 });
const stateStore = await createPersonalAssistantStateStore(state).init();
let bots = [];
if (registryPath) {
  const parsed = JSON.parse(await readFile(registryPath, 'utf8'));
  bots = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.bots) ? parsed.bots : []);
}
const registry = new BotRegistry({ profileId: assistantId, bots });

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

const server = createServer(async (request, response) => {
  try {
    const url = urlOf(request);
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/readyz')) return send(response, 200, { status: 'ok', assistantId, computerId, userId, bots: registry.list().length, capabilities, workspace, artifacts, state });
    if (request.method === 'GET' && url.pathname === '/v1/bots') return send(response, 200, { bots: registry.list() });
    if (request.method === 'GET' && url.pathname === '/v1/sessions') return send(response, 200, { sessions: await stateStore.sessions(stateBotId(url.searchParams.get('botId'))) });
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
    if (url.pathname === '/v1/sessions') return send(response, 201, await sessionCreate(body));
    if (url.pathname === '/v1/memory') return send(response, 201, await memoryWrite(body));
    if (url.pathname === '/v1/schedules') return send(response, 201, await scheduleWrite(body));
    return send(response, 404, { error: 'not_found' });
  } catch (error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 400;
    return send(response, status, { error: error?.code || error?.message || 'PERSONAL_ASSISTANT_RUNTIME_FAILED' });
  }
});
server.listen(port, host);
const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
