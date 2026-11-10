/**
 * Host-side personal-assistant desktop adapter.
 *
 * The standalone `@kingsoftcloud/agentkit-personal-assistant` DSH plugin keeps
 * its own credentials only in development hosts. Inside a DSH Host the plugin asks
 * this service for the account's bound cloud instance and for one-shot desktop
 * tickets, so the gateway API key never enters the plugin, the page, a URL or
 * the logs. See `docs/host-cloud-capability-v1.md` for the generic Host contract.
 *
 * Ownership: Host-only module. It never exposes the credential through RPC,
 * HTTP or plugin return values, and every failure carries `status` (or
 * `details.status`) so the plugin can keep a truthful error state.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const FORMAT = 'agentkit.personal-assistant-binding/v1';
const SERVICE = 'agentkitPersonalAssistantDesktop';
const PROTOCOL = 'agentkit.personal-assistant.desktop.v1';
const WS_PATH = 'personal-assistant/desktop/ws';
const DIRECTORY_BOT_ID = '__directory__';
const TICKET = /^[A-Za-z0-9_-]{32,512}$/u;
const AGENT_ID = /^ar-[A-Za-z0-9-]{4,120}$/u;
const BOT_ID = /^[A-Za-z0-9._:-]{1,64}$/u;
const MAX_TICKET_SECONDS = 60;
const RUNTIME_VERSION = /^\d+\.\d+\.\d+$/u;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/u;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const MAX_ENV_VALUE = 4096;
const MAX_ENV_VARIABLES = 64;
const MAX_MANIFEST_BYTES = 16 * 1024;
const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';
const DEFAULT_PROMPT = '请用中文完成用户任务。只使用提供的云电脑工具，不得假装已经执行。';
// The platform publishes each environment's managed-runtime catalog in its
// client bootstrap config. The Host reads the same document the server resolves
// from, so the version picker can never invent an undeployable version.
const RUNTIME_CATALOG_KEY = 'runtime.catalog';

const fail = (code, message, status = 409, details = {}) => Object.assign(new Error(message), { code, status, details });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';

/** Parse the recorded managed-runtime declaration. A binding written by an
 * older Host build (or adopted before the manifest was kept locally) simply
 * has no record; callers must treat that as "configuration unknown" instead of
 * silently rewriting the instance with guessed defaults. */
function parseManifest(value) {
  const source = text(value);
  if (!source) return null;
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) return null;
  let doc;
  try { doc = parseYaml(source); } catch { return null; }
  if (!record(doc)) return null;
  const runtime = record(doc.runtime) ? doc.runtime : {};
  return {
    name: text(doc.name), framework: text(doc.framework), artifactType: text(doc.artifact_type),
    model: text(doc.model), prompt: typeof doc.prompt === 'string' ? doc.prompt : '',
    runtimeName: text(runtime.name), runtimeVersion: text(runtime.version),
  };
}

/** The canonical declaration the platform requires for a ManagedRuntime
 * update. Field order mirrors the PA contract so manifest digests stay stable
 * between create and configure. */
function buildManifest({ name, version, model, prompt }) {
  const doc = {
    name,
    framework: 'personal-assistant',
    artifact_type: 'ManagedRuntime',
    ...(model ? { model } : {}),
    prompt: prompt ?? DEFAULT_PROMPT,
    runtime: { name: 'personal-assistant', version },
  };
  const source = stringifyYaml(doc);
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw fail('ASSISTANT_SETTINGS_MANIFEST_TOO_LARGE', '个人助理配置清单过大，请缩短提示词后重试', 400);
  }
  return source;
}

/** Keep only the fields a page may edit; never accept credential-shaped
 * platform fields from the page. Environment variables carrying secrets are
 * flagged sensitive so the platform stores them like kernel-managed secrets. */
function normalizeSettingsInput(input) {
  if (!record(input)) throw fail('ASSISTANT_SETTINGS_INPUT_INVALID', '配置参数无效', 400);
  const model = input.model === undefined ? undefined : text(input.model);
  if (model !== undefined && !MODEL_NAME.test(model)) {
    throw fail('ASSISTANT_SETTINGS_MODEL_INVALID', '模型名称无效（只能是字母、数字、点、冒号、斜线）', 400);
  }
  const prompt = input.prompt === undefined ? undefined : String(input.prompt);
  if (prompt !== undefined && prompt.length > 8_000) {
    throw fail('ASSISTANT_SETTINGS_PROMPT_TOO_LARGE', '提示词不能超过 8000 个字符', 400);
  }
  const version = input.runtimeVersion === undefined ? undefined : text(input.runtimeVersion);
  if (version !== undefined && !RUNTIME_VERSION.test(version)) {
    throw fail('ASSISTANT_SETTINGS_VERSION_INVALID', '运行时版本号格式无效', 400);
  }
  let variables;
  if (input.environmentVariables !== undefined) {
    if (!Array.isArray(input.environmentVariables) || input.environmentVariables.length > MAX_ENV_VARIABLES) {
      throw fail('ASSISTANT_SETTINGS_ENV_INVALID', `环境变量最多 ${MAX_ENV_VARIABLES} 项`, 400);
    }
    const keys = new Set();
    variables = input.environmentVariables.map(item => {
      if (!record(item)) throw fail('ASSISTANT_SETTINGS_ENV_INVALID', '环境变量格式无效', 400);
      const key = text(item.key ?? item.Key);
      const value = item.value ?? item.Value ?? '';
      if (!ENV_KEY.test(key)) throw fail('ASSISTANT_SETTINGS_ENV_INVALID', `环境变量名无效：${key || '（空）'}`, 400);
      if (keys.has(key)) throw fail('ASSISTANT_SETTINGS_ENV_INVALID', `环境变量重复：${key}`, 400);
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE) {
        throw fail('ASSISTANT_SETTINGS_ENV_INVALID', `环境变量 ${key} 的值无效或过长`, 400);
      }
      keys.add(key);
      const sensitive = item.sensitive === true || item.IsSensitive === true;
      return { key, value, sensitive };
    });
  }
  const deleteKeys = input.deleteKeys === undefined ? undefined : input.deleteKeys;
  if (deleteKeys !== undefined) {
    if (!Array.isArray(deleteKeys) || deleteKeys.length > MAX_ENV_VARIABLES) {
      throw fail('ASSISTANT_SETTINGS_ENV_INVALID', '要删除的环境变量数量无效', 400);
    }
    for (const key of deleteKeys) {
      if (typeof key !== 'string' || !ENV_KEY.test(key)) throw fail('ASSISTANT_SETTINGS_ENV_INVALID', `要删除的环境变量名无效：${key || '（空）'}`, 400);
    }
  }
  return { model, prompt, version, variables, deleteKeys };
}

/** Platform errors for a PA update are currently indistinguishable from a
 * generic 400 for the page; translate the known preprod limits into an action
 * the user (and support) can act on. */
function settingsFailure(error) {
  const message = text(error?.message) || '云端没有接受这次配置更新，请稍后再试';
  const rawStatus = Number(error?.status ?? error?.details?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 503;
  if (/ManagedRuntime requires Framework|requires Framework=/u.test(message)) {
    return fail('ASSISTANT_SETTINGS_UNSUPPORTED', '当前云端平台版本还不支持个人助理的配置更新（平台只开放了 DSH 类实例），等平台发布个人助理支持后即可保存', 409);
  }
  if (/AgentRuntime not found|请求的资源不存在/u.test(message)) {
    return fail('ASSISTANT_SETTINGS_UNAVAILABLE', '云端还没有接好这个个人助理的更新通道，请稍后再试；实例本身仍在正常运行', 503);
  }
  if (Number(error?.status) === 404 || /not found|not exist|未找到/iu.test(message)) {
    return fail('ASSISTANT_SETTINGS_NOT_FOUND', '云端找不到这个个人助理实例，请重新连接或重新创建', 409);
  }
  return fail('ASSISTANT_SETTINGS_FAILED', message.slice(0, 240), status);
}

const compareVersions = (left, right) => {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) { if (a[index] !== b[index]) return a[index] - b[index]; }
  return 0;
};

/** Accept both `{Data:{...}}` and `{data:{...}}` action envelopes. */
const actionData = value => record(value?.data) ? value.data : record(value?.Data) ? value.Data : value;

/** Mask a GetAgent environment row for the page: values of sensitive keys never
 * leave the Host, only the fact that the key is set. */
function publicEnvironmentRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(record).map(row => {
    const key = text(row.Key ?? row.key);
    const sensitive = row.IsSensitive === true || row.isSensitive === true;
    return { key, sensitive, value: sensitive ? '' : String(row.Value ?? row.value ?? '') };
  }).filter(row => ENV_KEY.test(row.key));
}

function gatewayOrigin(value) {
  let url;
  try { url = new URL(text(value)); } catch { throw fail('ASSISTANT_GATEWAY_INVALID', '云网关地址无效', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw fail('ASSISTANT_GATEWAY_INVALID', '云网关必须是 https 根地址', 400);
  }
  return url.origin;
}

export function createAssistantDesktop({ storeDir, fetchImpl = fetch, env = process.env, configuration: configurationSource, getClient, getDeploymentClient } = {}) {
  const file = join(storeDir, 'assistant-binding.json');
  let cached, cacheAt = 0;
  const ttl = 5_000;

  async function readBinding() {
    if (cached && Date.now() - cacheAt < ttl) return cached;
    let raw;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw fail('ASSISTANT_BINDING_CORRUPT', '个人助理绑定无法读取，请重新连接', 500);
        throw fail('ASSISTANT_BINDING_UNREADABLE', '个人助理绑定无法读取', 500);
      }
      cached = null; cacheAt = Date.now(); return null;
    }
    if (!record(raw) || raw.format !== FORMAT || !text(raw.gatewayUrl) || !AGENT_ID.test(text(raw.agentId)) || !text(raw.apiKey))
      throw fail('ASSISTANT_BINDING_CORRUPT', '个人助理绑定无法读取，请重新连接', 500);
    cached = { gatewayUrl: gatewayOrigin(raw.gatewayUrl), agentId: text(raw.agentId), apiKey: text(raw.apiKey), label: text(raw.label),
      manifest: typeof raw.manifest === 'string' ? raw.manifest : '', updatedAt: text(raw.updatedAt) };
    cacheAt = Date.now();
    return cached;
  }

  async function writeBinding(binding) {
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const next = `${file}.${randomUUID()}.next`;
    await writeFile(next, JSON.stringify({ format: FORMAT, gatewayUrl: binding.gatewayUrl, agentId: binding.agentId,
      apiKey: binding.apiKey, label: binding.label || '', manifest: binding.manifest || '', updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    await rename(next, file);
    cached = null; cacheAt = 0;
  }

  async function gatewayTicket(binding, { botId, mode, leaseId }, signal) {
    const body = JSON.stringify({ AgentId: binding.agentId, BotId: botId, Mode: mode === 'read' ? 'read' : 'control',
      ...(leaseId ? { LeaseId: String(leaseId) } : {}) });
    const url = new URL('IssuePersonalAssistantDesktopTicket', binding.gatewayUrl.endsWith('/') ? binding.gatewayUrl : `${binding.gatewayUrl}/`);
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${binding.apiKey}`, 'content-type': 'application/json' },
        body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    } catch (error) {
      if (signal?.aborted) throw fail('ASSISTANT_TICKET_CANCELLED', '桌面授权已取消', 499);
      throw fail('ASSISTANT_GATEWAY_UNREACHABLE', '云网关暂时不可达，请检查网络后重试', 502);
    }
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || !record(payload) || payload.Code !== 0) {
      const status = response.status === 401 || response.status === 403 ? 401 : response.status >= 500 ? 503 : 409;
      throw fail('ASSISTANT_TICKET_REFUSED', response.status === 401 || response.status === 403
        ? '云网关拒绝了实例凭证，请重新连接个人助理'
        : '云网关未能签发桌面授权，请检查实例状态后重试', status);
    }
    return payload.Data;
  }

  function publicTicket(binding, input, data) {
    const expiresAt = Number(data?.ExpiresAt);
    const remaining = expiresAt * 1000 - Date.now();
    if (!record(data) || !TICKET.test(String(data.Ticket || ''))
      || data.AgentId !== input.agentId || data.BotId !== input.botId
      || data.WsPath !== WS_PATH || data.Protocol !== PROTOCOL
      || !Number.isFinite(remaining) || remaining <= 0 || remaining > MAX_TICKET_SECONDS * 1000) {
      throw fail('ASSISTANT_TICKET_INVALID', '云网关返回的桌面授权格式错误', 502);
    }
    const wsUrl = new URL(WS_PATH, `${binding.gatewayUrl}/`);
    wsUrl.protocol = binding.gatewayUrl.startsWith('https:') ? 'wss:' : 'ws:';
    return { ticket: String(data.Ticket), expiresAt: new Date(expiresAt * 1000).toISOString(),
      agentId: input.agentId, botId: input.botId, wsUrl: wsUrl.href, protocol: PROTOCOL,
      leaseId: data.LeaseId ?? input.leaseId ?? null, readOnly: input.mode === 'read' };
  }

  function need(input) {
    if (!record(input)) throw fail('ASSISTANT_TICKET_INPUT_INVALID', '桌面授权参数无效', 400);
    const agentId = text(input.agentId), botId = text(input.botId);
    if (!AGENT_ID.test(agentId)) throw fail('ASSISTANT_AGENT_INVALID', '云端实例标识无效', 400);
    if (!BOT_ID.test(botId)) throw fail('ASSISTANT_BOT_INVALID', '请选择已创建的助理', 400);
    const mode = input.mode === 'read' ? 'read' : 'control';
    const leaseId = input.leaseId === undefined || input.leaseId === null ? null : text(input.leaseId);
    if (leaseId && leaseId.length > 256) throw fail('ASSISTANT_LEASE_INVALID', '桌面租约标识无效', 400);
    return { agentId, botId, mode, leaseId };
  }

  /** Gateway address for the current account environment. Preprod runs the
   * personal-assistant gateway on its own frozen host; production uses the
   * account's configured gateway and never guesses a public host. */
  async function environmentGateway() {
    const configured = text(env.AGENTKIT_PERSONAL_ASSISTANT_GATEWAY_URL);
    if (configured) return gatewayOrigin(configured);
    const source = typeof configurationSource === 'function' ? configurationSource() : configurationSource;
    const { values } = await (await source)?.resolve();
    if (!values) throw fail('ASSISTANT_CLOUD_UNCONFIGURED', '还没有配置云账号，请先在 Host 中完成云账号设置', 409);
    const region = String(values?.cloudRegion || '').toLowerCase();
    // 主预发（agentengine）走 pa-desktop-pre；PA 团队 dev 环境是另一套
    // server/DB，需要时用 AGENTKIT_PERSONAL_ASSISTANT_GATEWAY_URL 覆盖。
    if (region === 'pre-online') return 'https://pa-desktop-pre.agent-pre.kspmas.ksyun.com';
    throw fail('ASSISTANT_GATEWAY_UNCONFIGURED', '当前环境还没有配置个人助理云网关', 409);
  }

  /** The account's own personal-assistant instances, newest first. */
  async function discover(signal) {
    if (typeof getClient !== 'function') return [];
    const client = await getClient();
    const result = await client.action('ListAgents', { Page: 1, PageSize: 100 }, { signal });
    const rows = result?.data?.Agents ?? result?.Agents ?? [];
    return rows.filter(row => record(row) && row.Framework === 'personal-assistant'
      && row.Status === 'RUNNING' && AGENT_ID.test(text(row.AgentId)))
      .sort((left, right) => String(right.CreatedAt || '').localeCompare(String(left.CreatedAt || '')));
  }

  /** Read the created API key out of the platform's create response once. */
  function createdKey(data) {
    if (!record(data)) return '';
    for (const field of ['ApiKey', 'api_key', 'Key', 'key', 'ApiKeyValue']) {
      const value = text(data[field]);
      if (/^[A-Za-z0-9_-]{16,256}$/u.test(value)) return value;
    }
    return '';
  }

  /** Mint a fresh instance key through the platform. Returns '' when the
   * account cannot rotate credentials (deployment environment gap). */
  async function acquireKey(agentId, signal) {
    if (typeof getClient !== 'function') return '';
    const client = await getClient();
    let result;
    try { result = await client.action('CreateAgentApiKey', { AgentId: agentId, Name: 'dsh-host-desktop' }, { signal }); }
    catch { return ''; }
    const data = result?.data ?? result;
    return createdKey(record(data?.Data) ? data.Data : data);
  }

  async function bindingUsable(binding, signal) {
    try {
      const data = await gatewayTicket(binding, { botId: DIRECTORY_BOT_ID, mode: 'read' }, signal);
      return record(data) && TICKET.test(String(data.Ticket || ''));
    } catch (error) {
      // 401/403：凭证被拒。409：网关对「实例已不存在」返回 Code 404（在 gatewayTicket 里映射为
      // 409）——两者都只说明本地这条绑定过期，必须当作不可用继续往下走。若在这里原样抛出，
      // 一条死绑定会让 configuration() 整体失败，页面就看不到「未开通」也无法给出开通引导。
      if ([401, 403, 409].includes(Number(error?.status))) return false;
      throw error;
    }
  }

  /** Resolve, verify and (when the stored key is gone) re-acquire the binding. */
  async function refresh(signal) {
    const agents = await discover(signal).catch(() => []);
    const candidates = agents.map(row => ({ agentId: row.AgentId, name: text(row.Name), status: text(row.Status),
      framework: text(row.Framework), endpoint: text(row.Endpoint), createdAt: text(row.CreatedAt) }));
    const selected = candidates[0] ? agents[0] : null;
    let binding = await readBinding();
    // The account moved to a newer instance: the stored key still belongs to
    // the old one, so fall through to the re-acquisition path.
    if (binding && selected && binding.agentId !== selected.AgentId) binding = null;
    if (binding && await bindingUsable(binding, signal)) return { binding, candidates, reason: '' };
    // The stored key is stale (or belonged to another instance). Never keep it:
    // 留下的死绑定会让之后每次检查都失败，必须在判定为过期时就清掉。
    if (binding) {
      await rm(file, { force: true }).catch(() => {});
      cached = null; cacheAt = 0;
    }
    binding = null;
    if (!selected) return { binding: null, candidates, reason: 'needs-create' };
    const gatewayUrl = await environmentGateway();
    const apiKey = await acquireKey(selected.AgentId, signal);
    if (!apiKey) return { binding: null, candidates, reason: 'credential-unavailable' };
    const next = { gatewayUrl, agentId: selected.AgentId, apiKey, label: text(selected.Name).slice(0, 80) };
    // Prove the fresh key before persisting: a platform gap must not leave a
    // dead credential in the Host store.
    if (!await bindingUsable(next, signal)) return { binding: null, candidates, reason: 'credential-unavailable' };
    await writeBinding(next);
    return { binding: next, candidates, reason: '' };
  }

  async function configuration(input = {}, signal) {
    let resolved;
    try { resolved = await refresh(signal); }
    catch (error) { if (error?.code === 'ASSISTANT_GATEWAY_UNCONFIGURED') return { configured: false }; throw error; }
    if (!resolved.binding) return { configured: false };
    const candidate = text(input?.agentId);
    // A page-supplied agent is only a candidate: report the persisted binding
    // instead of trusting the caller.
    if (candidate && candidate !== resolved.binding.agentId) return { configured: false };
    return { configured: true, agentId: resolved.binding.agentId };
  }

  /** Page-facing snapshot: fetchable without leaking the credential. */
  async function status(input = {}, signal) {
    const resolved = await refresh(signal).catch(error => ({ binding: null, candidates: [], reason: error?.code || 'unavailable' }));
    return { configured: Boolean(resolved.binding), agentId: resolved.binding?.agentId,
      gatewayUrl: resolved.binding?.gatewayUrl, reason: resolved.binding ? '' : resolved.reason,
      candidates: resolved.candidates };
  }

  async function connect(payload = {}, signal) {
    const requested = text(payload.agentId);
    const resolved = await refresh(signal);
    if (requested && resolved.binding && requested !== resolved.binding.agentId) {
      const other = resolved.candidates.find(row => row.agentId === requested);
      if (!other) throw fail('ASSISTANT_AGENT_MISMATCH', '该实例不属于当前账号', 403);
      const gatewayUrl = await environmentGateway();
      const apiKey = await acquireKey(requested, signal);
      if (!apiKey) throw fail('ASSISTANT_CREDENTIAL_UNAVAILABLE', '云端暂时无法为这个实例生成连接凭证，请稍后重试', 503);
      const next = { gatewayUrl, agentId: requested, apiKey, label: text(other.name).slice(0, 80) };
      await writeBinding(next);
      return { configured: true, agentId: requested };
    }
    if (!resolved.binding) {
      if (resolved.reason === 'needs-create') throw fail('ASSISTANT_NOT_CREATED', '账号下还没有可用的个人助理实例', 409);
      throw fail('ASSISTANT_CREDENTIAL_UNAVAILABLE', '云端暂时无法获取实例连接凭证，请稍后重试', 503);
    }
    return { configured: true, agentId: resolved.binding.agentId };
  }

  async function issueTicket(input = {}, signal) {
    const scope = need(input);
    const resolved = await refresh(signal);
    const binding = resolved.binding;
    if (!binding) {
      if (scope.botId === DIRECTORY_BOT_ID) throw fail('ASSISTANT_UNCONFIGURED', '当前账号还没有可用的个人助理实例', 409);
      if (resolved.reason === 'needs-create') throw fail('ASSISTANT_NOT_CREATED', '账号下还没有可用的个人助理实例', 409);
      throw fail('ASSISTANT_CREDENTIAL_UNAVAILABLE', '云端暂时无法获取实例连接凭证，请稍后重试', 503);
    }
    if (scope.agentId !== binding.agentId) throw fail('ASSISTANT_AGENT_MISMATCH', '云端实例与 Host 绑定不一致', 403);
    const data = await gatewayTicket(binding, scope, signal);
    return publicTicket(binding, scope, data);
  }



  /** Create the account's personal assistant through the platform catalog.
   * The managed runtime name mirrors the framework, and the manifest keeps the
   * instance identity in sync with the request. */
  async function create(payload = {}, signal) {
    if (typeof getClient !== 'function' && typeof getDeploymentClient !== 'function')
      throw fail('ASSISTANT_CREATE_UNAVAILABLE', '当前 Host 版本不支持创建个人助理', 503);
    const version = text(env.AGENTKIT_PERSONAL_ASSISTANT_RUNTIME_VERSION) || '0.1.42'; // 与平台 catalog 默认版本保持一致（预发保留 0.1.39-0.1.42）
    const model = text(env.AGENTKIT_PERSONAL_ASSISTANT_MODEL) || DEFAULT_MODEL;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const name = `personal-assistant-${stamp}-${randomUUID().slice(0, 10)}`;
    // Keep the declaration Host writes, so later settings edits can rebuild
    // the exact same instance identity without inventing a new name.
    const manifest = buildManifest({ name, version, model, prompt: DEFAULT_PROMPT });
    const { values } = await (await configurationSource)?.resolve() || {};
    const region = text(values?.cloudRegion) === 'pre-online' ? 'cn-beijing-6' : (text(values?.cloudRegion) || 'cn-beijing-6');
    const request = {
      Name: name, Description: '个人助理', Framework: 'personal-assistant', Region: region,
      DeploymentType: 'ManagedRuntime', AutoPay: true,
      ManagedRuntimeConfig: { RuntimeName: 'personal-assistant', RuntimeVersion: version, Manifest: manifest },
      Resource: { Cpu: 1, Memory: 4 }, Scaling: { MinReplicas: 1, MaxReplicas: 1 },
      Storage: { MountPath: '/data', SizeGi: 20 }, Network: { EnablePublicAccess: true, EnableVpcAccess: false },
      Advanced: { EnableObservability: false, EnvironmentVariables: [{ Key: 'OPENAI_BASE_URL', Value: text(values?.modelBaseUrl) || 'https://kspmas.ksyun.com/v1' }] },
      InstanceId: randomUUID(),
    };
    // 创建必须走产品化动作：Host 通用 client 的动作白名单里没有 CreateAgent，
    // 直接调用会被本地的 ACTION_NOT_ALLOWED 拒绝（与云端无关）。deployment client
    // 才持有 CreateAgentProduct，Host 自己的部署也走这条路。
    let created;
    try {
      if (typeof getDeploymentClient === 'function') {
        created = await (await getDeploymentClient()).createAgent(request, { signal });
      } else {
        created = await (await getClient()).action('CreateAgent', request, { signal });
      }
    } catch (error) {
      // 平台拒绝的原因必须透出来：只报「请稍后再试」会让预发缺口看起来像偶发故障。
      const message = text(error?.message);
      const code = text(error?.code);
      const requestId = text(error?.requestId);
      const hint = code === 'ACTION_NOT_ALLOWED' ? '当前 Host 版本不支持创建个人助理，请升级 Host'
        // 预发控制面对 personal-assistant 的创建还没有放行时返回 404（产品/运行时未注册），
        // 这属于平台侧缺口：给出可以转给平台同事的原始信息，而不是让人反复点重试。
        : Number(error?.status) === 404 ? `云端控制面还没有注册个人助理（平台返回 404），需要平台侧开通后重试：${message}`
        : message.includes('Framework') || Number(error?.status) === 422 ? `云端还不接受个人助理创建：${message}`
        : `云端未能创建个人助理${message ? `：${message}` : ''}${requestId ? `（请求 ${requestId}）` : ''}`;
      throw fail('ASSISTANT_CREATE_UNAVAILABLE', hint, 503);
    }
    const data = created?.data ?? created;
    const agentId = text(data?.AgentId ?? data?.Data?.AgentId ?? data?.Agent?.AgentId);
    // Wait for the instance to become callable before minting its credential.
    const deadline = Date.now() + 300_000;
    let agent = null;
    while (Date.now() < deadline) {
      signal?.throwIfAborted?.();
      const rows = await discover(signal).catch(() => []);
      agent = rows.find(row => (agentId && row.AgentId === agentId) || row.Name === name) || null;
      if (agent) break;
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    if (!agent) throw fail('ASSISTANT_CREATE_TIMEOUT', '个人助理正在创建中，请稍后重试', 504);
    const resolved = await refresh(signal);
    if (!resolved.binding) throw fail('ASSISTANT_CREDENTIAL_UNAVAILABLE', '个人助理已创建，但云端暂时无法获取连接凭证，请稍后重试', 503);
    // Remember the declaration this Host wrote; the platform does not echo it
    // back on GetAgent, and a later settings update must reuse the same name.
    await writeBinding({ ...resolved.binding, manifest });
    return { configured: true, agentId: resolved.binding.agentId };
  }

  async function disconnect() {
    await rm(file, { force: true });
    cached = null; cacheAt = 0;
    return { configured: false };
  }

  /** Read the bound instance's editable configuration.
   *
   * The platform `GetAgent` projection is the source of truth for the
   * deployment status/version and the non-secret environment rows. The model,
   * prompt and instance name live in the managed-runtime declaration, which
   * the platform does not echo today; Host therefore keeps the declaration
   * it wrote in the binding file and reports `recordSource: 'missing'` when an
   * instance predates that record instead of guessing. */
  async function settings(input = {}, signal) {
    const binding = await readBinding();
    const agentId = binding?.agentId;
    if (!AGENT_ID.test(agentId || '')) throw fail('ASSISTANT_NOT_CREATED', '当前没有可用的个人助理，请先开通或连接', 409);
    const manifest = parseManifest(binding.manifest);
    // The platform detail endpoint is the source of truth, but a platform that
    // predates PA support answers 5xx for these instances. Degrade to the
    // declaration Host recorded at create time instead of showing the user a
    // stack-trace-flavoured error on a page that otherwise works.
    const local = {
      configured: true,
      agentId,
      name: manifest?.name || binding.label || '',
      description: '',
      status: 'unknown',
      deploymentType: 'ManagedRuntime',
      runtime: { name: 'personal-assistant', version: manifest?.runtimeVersion || '', imageDigest: '', updatedAt: '' },
      model: manifest?.model || '',
      prompt: manifest?.prompt ?? '',
      environmentVariables: [],
      recordSource: manifest ? 'host' : 'missing',
      detailAvailable: false,
      detailNote: '云端平台暂时没有返回实例详情（预发平台尚未开放个人助理的配置读取），下面显示的是本机记录的创建配置；环境变量详情暂时不可见。',
    };
    if (typeof getDeploymentClient !== 'function') return local;
    let detail;
    try {
      const client = await getDeploymentClient();
      detail = await client.forAgent(agentId).get({}, { signal });
    } catch { return local; }
    const data = actionData(detail);
    if (!record(data) || (data.Code !== undefined && Number(data.Code) !== 0)) return local;
    const basic = record(data.Basic) ? data.Basic : {};
    const deployment = record(data.Deployment) ? data.Deployment : {};
    const runtime = record(deployment.RuntimeConfig) ? deployment.RuntimeConfig : {};
    const advanced = record(data.Advanced) ? data.Advanced : {};
    return {
      ...local,
      name: text(basic.Name) || local.name,
      description: text(basic.Description),
      status: text(basic.Status) || text(basic.Phase),
      deploymentType: text(deployment.DeploymentType) || local.deploymentType,
      runtime: {
        name: text(runtime.Name) || 'personal-assistant',
        version: text(runtime.Version) || local.runtime.version,
        imageDigest: text(runtime.ImageDigest),
        updatedAt: text(basic.UpdatedAt),
      },
      environmentVariables: publicEnvironmentRows(advanced.EnvironmentVariables),
      detailAvailable: true,
      detailNote: '',
    };
  }

  /** Candidate runtime versions published for this environment. The catalog is
   * optional infrastructure: when it is missing the page still shows the
   * instance's current version and explains that no upgrade target is
   * published. */
  async function settingsVersions(input = {}, signal) {
    const binding = await readBinding();
    if (!binding || !AGENT_ID.test(binding.agentId)) throw fail('ASSISTANT_NOT_CREATED', '当前没有可用的个人助理，请先开通或连接', 409);
    const recorded = parseManifest(binding.manifest);
    const currentVersion = text(input.currentVersion) || recorded?.runtimeVersion || '';
    const versions = [];
    if (typeof getDeploymentClient === 'function') {
      try {
        const client = await getDeploymentClient();
        const source = typeof configurationSource === 'function' ? configurationSource() : configurationSource;
        const { values } = await (await source)?.resolve() || {};
        const region = text(values?.cloudRegion) === 'pre-online' ? 'cn-beijing-6' : (text(values?.cloudRegion) || 'cn-beijing-6');
        const result = await client.getBootstrapConfig({ region, runtime: 'personal-assistant' }, { signal });
        const data = actionData(result) || {};
        const configs = record(data.Configs) ? data.Configs : {};
        const pa = record(configs[RUNTIME_CATALOG_KEY]) ? configs[RUNTIME_CATALOG_KEY]['personal-assistant'] : null;
        const catalogVersions = record(pa?.versions) ? pa.versions : null;
        if (catalogVersions) {
          for (const [version, entry] of Object.entries(catalogVersions)) {
            if (!RUNTIME_VERSION.test(version)) continue;
            versions.push({
              version,
              image: text(entry?.image),
              capabilities: Array.isArray(entry?.capabilities) ? entry.capabilities.filter(value => typeof value === 'string').slice(0, 20) : [],
            });
          }
        }
      } catch { /* No catalog is a normal preprod state; the page explains it. */ }
    }
    versions.sort((left, right) => compareVersions(left.version, right.version));
    return {
      currentVersion: RUNTIME_VERSION.test(currentVersion) ? currentVersion : '',
      versions,
      catalogAvailable: versions.length > 0,
    };
  }

  /** Submit one platform update with the user's edited settings.
   *
   * The platform applies model/prompt/version through the managed-runtime
   * declaration and environment variables through its incremental patch, so a
   * single UpdateAgent call covers every setting and the instance rolls only
   * once. The page never restarts the instance itself. */
  async function settingsUpdate(input = {}, signal) {
    const binding = await readBinding();
    if (!binding || !AGENT_ID.test(binding.agentId)) throw fail('ASSISTANT_NOT_CREATED', '当前没有可用的个人助理，请先开通或连接', 409);
    if (typeof getDeploymentClient !== 'function') throw fail('ASSISTANT_SETTINGS_UNAVAILABLE', '当前 Host 版本还不支持个人助理配置', 503);
    const parsed = normalizeSettingsInput(input);
    const recorded = parseManifest(binding.manifest);
    const version = parsed.version || recorded?.runtimeVersion || '';
    if (!RUNTIME_VERSION.test(version)) throw fail('ASSISTANT_SETTINGS_VERSION_REQUIRED', '请先选择个人助理的运行时版本，再保存配置', 400);
    // The platform needs the complete declaration on every PA update. The
    // instance name must not change, so a legacy binding without a recorded
    // manifest fails closed instead of overwriting the instance with guesses.
    const name = recorded?.name || '';
    if (!name) {
      throw fail('ASSISTANT_SETTINGS_MANIFEST_MISSING',
        '这个个人助理是用旧版 Host 创建的，本机没有记录它的配置清单，暂时不能在线修改；可以先关闭再重新创建，等平台提供读取接口后即可直接编辑', 409);
    }
    const model = parsed.model ?? recorded.model ?? DEFAULT_MODEL;
    if (!MODEL_NAME.test(model)) throw fail('ASSISTANT_SETTINGS_MODEL_INVALID', '模型名称无效', 400);
    const prompt = parsed.prompt ?? recorded.prompt ?? DEFAULT_PROMPT;
    const manifest = buildManifest({ name, version, model, prompt });
    const payload = {
      AgentId: binding.agentId,
      ManagedRuntimeConfig: { RuntimeName: 'personal-assistant', RuntimeVersion: version, Manifest: manifest },
    };
    const patch = {};
    if (parsed.variables !== undefined) {
      patch.Upsert = parsed.variables.map(item => ({
        Key: item.key, Value: item.value, ...(item.sensitive ? { IsSensitive: true } : {}),
      }));
    }
    if (parsed.deleteKeys?.length) patch.Delete = [...new Set(parsed.deleteKeys)];
    if (Object.keys(patch).length) payload.EnvironmentVariablePatch = patch;
    let client;
    try { client = await getDeploymentClient(); }
    catch { throw fail('ASSISTANT_SETTINGS_UNAVAILABLE', '暂时无法连接云端控制面，请稍后重试', 503); }
    try { await client.forAgent(binding.agentId).update(payload, { signal }); }
    catch (error) { throw settingsFailure(error); }
    await writeBinding({ ...binding, manifest, label: binding.label });
    return { configured: true, agentId: binding.agentId, version, model, prompt, saved: true, status: 'updating' };
  }

  /** Close the bound cloud assistant for good: remove the managed runtime
   * (the pod), let the platform release the AICP key and the Ding order, then
   * drop the local binding. The page must echo the instance id, so a stale
   * button can never delete a different agent. */
  async function destroy(input = {}, signal) {
    const binding = await readBinding();
    const agentId = binding?.agentId || text(input.agentId);
    if (!AGENT_ID.test(agentId)) throw fail('ASSISTANT_NOT_CREATED', '当前没有可关闭的个人助理', 409);
    const confirmed = text(input.confirmAgentId);
    if (!confirmed) throw fail('ASSISTANT_DELETE_CONFIRMATION_REQUIRED', '关闭个人助理需要再次确认', 409, { agentId });
    if (confirmed !== agentId) throw fail('ASSISTANT_DELETE_CONFIRMATION_REQUIRED', '确认的实例标识与当前绑定不一致，请刷新后重试', 409, { agentId });
    if (typeof getDeploymentClient !== 'function') throw fail('ASSISTANT_DELETE_UNAVAILABLE', '当前 Host 版本不支持关闭个人助理', 503);
    let client;
    try { client = await getDeploymentClient(); }
    catch { throw fail('ASSISTANT_DELETE_UNAVAILABLE', '暂时无法连接云端控制面，请稍后重试', 503); }
    try { await client.forAgent(agentId).remove({ signal }); }
    catch (error) {
      // A missing agent is already closed; everything else keeps the binding so
      // the user can retry the same instance instead of losing the reference.
      if (Number(error?.status) === 404 || /not found|not exist|未找到/iu.test(String(error?.message))) { /* already gone */ }
      else throw fail('ASSISTANT_DELETE_FAILED', String(error?.message || '云端未能关闭个人助理，请稍后重试').slice(0, 240), Number(error?.status) >= 400 && Number(error?.status) <= 599 ? Number(error.status) : 503);
    }
    await rm(file, { force: true });
    cached = null; cacheAt = 0;
    return { configured: false, agentId, closed: true };
  }

  return Object.freeze({ configuration, issueTicket, status, connect, create, disconnect, destroy,
    settings, settingsUpdate, settingsVersions });
}

/** The service shape the standalone plugin consumes via `ctx.get()`. */
export function assistantDesktopService(impl) {
  return Object.freeze({ format: SERVICE, configuration: impl.configuration, issueTicket: impl.issueTicket,
    status: impl.status, connect: impl.connect, create: impl.create, disconnect: impl.disconnect, destroy: impl.destroy,
    settings: impl.settings, settingsUpdate: impl.settingsUpdate, settingsVersions: impl.settingsVersions });
}

export const ASSISTANT_DESKTOP_SERVICE = SERVICE;
