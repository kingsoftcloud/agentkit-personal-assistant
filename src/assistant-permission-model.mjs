/** New assistant workspace authority. Native DSH still owns tools and approval audit. */
import { existsSync, lstatSync, realpathSync, opendirSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { registerAssistantWorkspaceTools } from './assistant-workspace-tools.mjs';
import { createAssistantWorkspaceAttachmentCopies } from './assistant-workspace-attachments.mjs';
import { createCloudExecutor, registerAssistantCloudExecutionTools, resolveCloudSandbox } from './assistant-cloud-execution.mjs';
import { registerAssistantCloudBrowserTools, resolveCloudBrowser } from './assistant-cloud-browser.mjs';

export const ASSISTANT_PERMISSION_PROFILE = 'workspace-managed/v1';
// The Host, the DSH Host picker and this model all speak the same three tiers as
// the native sandbox; only the middle tier is the managed default.
export const FULL_ACCESS_PROFILE = 'full-access/v1';
export const ASSISTANT_PERMISSION_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);
const ROUTINE = Object.freeze(['read', 'read_image', 'write', 'edit', 'glob', 'grep']);
// Public read-only web access. The native tools already use the Host's
// address-pinned provider: HTTP(S) only, no credentials in URLs, bounded
// timeout and output, same-origin redirects, and private/loopback addresses
// refused after resolution. The policy adds an independent early refusal so an
// obviously internal target never reaches a provider.
const WEB_TOOLS = Object.freeze(['web_search', 'web_fetch']);
// DSH's shipped DeepSeek search provider resolves DEEPSEEK_API_KEY at each
// search. Without that credential web_fetch still reaches public pages, but
// advertising web_search would claim a capability the runtime cannot execute.
export function availableWebTools(env = {}) {
  return WEB_TOOLS.filter(name => name !== 'web_search' || String(env.DEEPSEEK_API_KEY || '').trim() !== '');
}
const WEB_FETCH_MAX_URL_LENGTH = 2048;
const PRIVATE_IPV4 = /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|198\.(?:18|19)\.|192\.0\.[02]\.|22[4-9]\.|2[3-5]\d\.)/u;
const PRIVATE_SUFFIXES = Object.freeze(['.localhost', '.local', '.internal', '.lan', '.home.arpa']);
const SESSION_TOOLS = Object.freeze(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']);
// The only grant that changes the managed tool surface in this release. Browser
// and local-bridge grants stay unknown until their capability ships.
const CLOUD_GRANTS = Object.freeze(['code-execution', 'browser']);
const normalizeGrants = value => {
  const list = Array.isArray(value) ? value : [];
  return Object.freeze(CLOUD_GRANTS.filter(name => list.includes(name)));
};
const liveGuards = new WeakMap();
const SENSITIVE = new Set(['external-send', 'payment', 'destructive-delete', 'account-permission']);
const fail = message => Object.assign(new Error(message), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE', status: 503 });
const inside = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path)); };
const legacy = Object.freeze({ profile: 'legacy-read-only/v1', permission: 'read-only', approval: 'never', managed: false });

function expectedWorkspaceBase(env) {
  if (!env.AGENTKIT_HOME || !env.DSH_HOME) return null;
  const root = dirname(resolve(env.AGENTKIT_HOME));
  return resolve(env.AGENTKIT_HOME) === join(root, 'agentkit') && resolve(env.DSH_HOME) === join(root, 'dsh')
    ? join(root, 'assistant-workspaces') : null;
}

/**
 * Synchronous bootstrap fence, before presets or restored timer work become
 * executable. It grants nothing and performs no filesystem I/O. Agent-scoped
 * denial survives disposal of this installing plugin and is handed off only
 * after the permission model has installed its replacement denial.
 */
export function installAssistantStartupGuard(ctx, env = {}) {
  const base = expectedWorkspaceBase(env);
  if (!base) return () => {};
  const install = agent => {
    const cwd = agent?.session?.header?.cwd;
    if (!agent?.session?.id?.startsWith('assistant-') || typeof cwd !== 'string') return;
    const suffix = relative(base, cwd).split(sep);
    if (suffix.length !== 2 || !/^[a-f0-9]{64}$/.test(suffix[0]) || suffix[1] !== 'files' || cwd !== join(base, ...suffix)) return;
    if (liveGuards.has(agent)) return;
    const tools = agent.ctx?.get('tools');
    if (typeof tools?.guard !== 'function') throw fail('Managed Agent cannot start without a native monotonic guard');
    const release = tools.guard(() => 'Assistant workspace permissions are awaiting trusted Host initialization');
    liveGuards.set(agent, { retire: release });
  };
  const listener = ctx.on('agent/created', ({ agent }) => install(agent));
  const scan = scope => { for (const agent of scope.get('agents')?.list?.() || []) install(agent); };
  scan(ctx); // Already-live services must be fenced synchronously, not next tick.
  if (typeof ctx.inject === 'function') ctx.inject(['tools', 'agents'], scope => { scan(scope); });
  return listener;
}

/**
 * Managed workspace authority is the default. A hosted harness Agent that can
 * only read cannot do any work at all, so an omitted or unknown profile now
 * resolves to the managed model instead of the legacy read-only one. An
 * explicit ``legacy-read-only/v1`` (or the bare ``read-only`` permission)
 * remains the opt-out for deployments that must not create workspaces.
 */
export function selectAssistantPermissionProfile(value) {
  return selectAssistantPermissionMode(value) === 'read-only' ? legacy.profile : ASSISTANT_PERMISSION_PROFILE;
}

/**
 * Three tiers, matching the native sandbox modes and the DSH Host picker:
 * read-only (view), workspace-write (managed default) and danger-full-access.
 * An explicit read-only stays the opt-out; anything else defaults to the
 * managed workspace so a hosted harness Agent can actually do work.
 */
export function selectAssistantPermissionMode(value) {
  const requested = typeof value === 'string' ? value.trim() : '';
  if (requested === legacy.profile || requested === legacy.permission || requested === 'read-only') return 'read-only';
  if (requested === FULL_ACCESS_PROFILE || requested === 'full-access' || requested === 'danger-full-access') return 'danger-full-access';
  return 'workspace-write';
}

function checkedPath(root, input) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(input)) return false;
  const target = resolve(root, input);
  if (!inside(root, target) || realpathSync(root) !== root) return false;
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // New assistant tools cannot create links. Reject aliases supplied by an
    // external writer instead of allowing them to borrow workspace authority.
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) return false;
  }
  return true;
}

function checkedSearchTree(root, input) {
  if (!checkedPath(root, input)) return false;
  const pending = [{ path: resolve(root, input), depth: 0 }]; let count = 0;
  while (pending.length) {
    const { path, depth } = pending.pop();
    if (++count > 10000 || depth > 64) return false;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) return false;
    if (info.isDirectory()) {
      const directory = opendirSync(path);
      try {
        for (let entry; (entry = directory.readSync()) !== null;) {
          if (count + pending.length >= 10000) return false;
          pending.push({ path: join(path, entry.name), depth: depth + 1 });
        }
      } finally { directory.closeSync(); }
    }
  }
  return true;
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/gu, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return PRIVATE_IPV4.test(host);
  if (host.includes(':')) return host === '::1' || /^(?:f[cd]|fe[89ab]|ff)/u.test(host);
  return false;
}

/** Early refusal for obviously internal or non-http targets; the provider still pins public addresses. */
function checkedFetchUrl(input) {
  if (typeof input !== 'string' || !input || input.length > WEB_FETCH_MAX_URL_LENGTH) return '联网读取只接受长度合理的公开链接';
  let url;
  try { url = new URL(input); } catch { return '联网读取的链接格式无效'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '联网读取只接受 http 或 https 链接';
  if (url.username || url.password) return '联网读取的链接不能携带账号密码';
  if (isPrivateHost(url.hostname)) return '不能访问本机、内网或保留地址';
  return undefined;
}

async function runtimeRoot(env) {
  if (!env.AGENTKIT_HOME || !env.DSH_HOME || !/^[a-f0-9]{64}$/.test(env.AGENTKIT_BUNDLE_SHA256 || '')) return null;
  const root = dirname(resolve(env.AGENTKIT_HOME));
  if (resolve(env.AGENTKIT_HOME) !== join(root, 'agentkit') || resolve(env.DSH_HOME) !== join(root, 'dsh')) return null;
  try {
    const receipt = JSON.parse(await readFile(join(root, '.agentkit-runtime.json'), 'utf8'));
    if (receipt.format !== 'agentkit.runtime-state/v1' || receipt.bundleSha256 !== env.AGENTKIT_BUNDLE_SHA256 || await realpath(root) !== root) return null;
    for (const name of ['agentkit', 'dsh']) {
      const info = await lstat(join(root, name));
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
    }
    return root;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * Trusted Host composition only: sensitiveTools is an exact tool-definition
 * catalog, never model/client data. Each entry needs name, category and a
 * describe(arguments) function giving the concrete action for one-shot review.
 * This is path containment in a private receipt-owned workspace, not isolation
 * from a hostile process with the same OS identity (see the companion guide).
 */
export async function createAssistantPermissionModel({ ctx, env = {}, profile, agentId, sensitiveTools = [], grants: grantsInput, cloudSandbox, cloudBrowser } = {}) {
  const managedMode = selectAssistantPermissionMode(profile);
  const optedIn = managedMode !== 'read-only';
  const grants = normalizeGrants(grantsInput);
  // Image-level gate: a grant is only meaningful when this runtime can confine
  // the child. The runtime identity advertises nothing in that case.
  const cloudSandboxUsable = (cloudSandbox === undefined ? resolveCloudSandbox({ env }) : cloudSandbox)?.available === true;
  const cloudBrowserUsable = (cloudBrowser === undefined ? resolveCloudBrowser({ env }) : cloudBrowser)?.available === true;
  const webTools = availableWebTools(env);
  const releaseStartup = installAssistantStartupGuard(ctx, env);
  let root = null;
  const expectedRoot = optedIn && env.AGENTKIT_HOME && env.DSH_HOME && /^[a-f0-9]{64}$/.test(env.AGENTKIT_BUNDLE_SHA256 || '')
    ? dirname(resolve(env.AGENTKIT_HOME)) : null;
  const expectedShape = expectedRoot && resolve(env.AGENTKIT_HOME) === join(expectedRoot, 'agentkit') && resolve(env.DSH_HOME) === join(expectedRoot, 'dsh');
  const validation = optedIn ? runtimeRoot(env).then(value => { root = value; }) : Promise.resolve();
  const states = new WeakMap(), staged = new WeakMap(), byId = new Map(), releases = new Set();
  const lifetime = new AbortController();
  let closed = false;
  const base = expectedShape && join(expectedRoot, 'assistant-workspaces');
  const catalog = new Map();
  for (const item of sensitiveTools) {
    if (!item || typeof item.name !== 'string' || !SENSITIVE.has(item.category) || typeof item.describe !== 'function'
      || item.definition?.name !== item.name || typeof item.definition?.execute !== 'function' || ROUTINE.includes(item.name) || WEB_TOOLS.includes(item.name) || SESSION_TOOLS.includes(item.name) || ['bash', 'run_code', 'pwsh', 'terminal'].includes(item.name) || catalog.has(item.name)) throw fail('Invalid sensitive tool catalog');
    catalog.set(item.name, { ...item });
  }
  function location(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || typeof agentId !== 'string' || !agentId) throw fail('Workspace owner is missing');
    return join(base, createHash('sha256').update(JSON.stringify([agentId, sessionId])).digest('hex'));
  }
  async function owned(sessionId) {
    if (!root || !base) return null;
    const home = location(sessionId), cwd = join(home, 'files');
    try {
      const ownerPath = join(home, 'owner.json'), ownerInfo = await lstat(ownerPath);
      if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1 || (ownerInfo.mode & 0o077) !== 0) throw fail('Workspace ownership record is not private');
      const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (owner.profile !== ASSISTANT_PERMISSION_PROFILE || owner.agentId !== agentId || owner.sessionId !== sessionId || owner.bundleSha256 !== env.AGENTKIT_BUNDLE_SHA256) throw fail('Workspace ownership does not match this deployment');
      for (const path of [base, home, cwd]) {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (info.mode & 0o077) !== 0) throw fail('Workspace must remain a private real directory');
      }
      return cwd;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function newSessionCwd(sessionId) {
    if (closed) throw fail('Assistant permission model is closed');
    if (!optedIn) return undefined;
    if (!root || !base) throw fail('Managed permissions require a receipt-owned isolated runtime');
    const existing = await owned(sessionId);
    if (existing) return existing;
    await mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const baseInfo = await lstat(base);
    if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink() || await realpath(base) !== base || (baseInfo.mode & 0o077) !== 0) throw fail('Workspace parent is not private');
    // EEXIST is checked below; do not adopt an arbitrary pre-existing cwd.
    return create(sessionId);
  }
  async function create(sessionId) {
    const home = location(sessionId);
    await mkdir(home, { mode: 0o700 });
    await mkdir(join(home, 'files'), { mode: 0o700 });
    await writeFile(join(home, 'owner.json'), JSON.stringify({ profile: ASSISTANT_PERMISSION_PROFILE, agentId, sessionId, bundleSha256: env.AGENTKIT_BUNDLE_SHA256 }) + '\n', { flag: 'wx', mode: 0o600 });
    return owned(sessionId);
  }
  function stage(agent) {
    if (!base || !agent?.session?.id?.startsWith('assistant-')) return null;
    const home = location(agent.session.id);
    if (agent.session.header.cwd !== join(home, 'files') && !existsSync(join(home, 'owner.json'))) return null;
    if (staged.has(agent)) return staged.get(agent);
    const tools = agent.ctx?.get('tools');
    if (typeof tools?.guard !== 'function') throw fail('Native monotonic tool guard is unavailable');
    const state = { ready: false, guard: undefined, pending: undefined };
    const releaseGuard = tools.guard(exec => state.ready ? state.guard(exec) : 'Assistant workspace permissions are not ready');
    const previous = liveGuards.get(agent);
    liveGuards.set(agent, { retire: () => { state.ready = false; state.releaseListener?.(); releaseGuard(); } });
    previous?.retire(); // New denial is installed before retiring the old gate.
    staged.set(agent, state);
    return state;
  }
  async function configure(agent, created) {
    lifetime.signal.throwIfAborted();
    if (!created) return;
    const approval = ctx.get('approval');
    const presets = ctx.get('permissionPresets');
    if (typeof presets?.set !== 'function') throw fail('Native managed permission initialization failed');
    // This is trusted initialization, not a user-issued permission command.
    try { presets.set(agent.session, managedMode); }
    catch { throw fail('Native managed permission initialization failed'); }
    const applied = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode;
    const effectiveApproval = approval.effectivePolicy(agent.session);
    // Full access has nothing left to approve; the two confined tiers keep the
    // interactive approval policy so sensitive tools still ask first.
    const approvalOk = managedMode === 'danger-full-access' ? effectiveApproval !== undefined : effectiveApproval === 'ask';
    if (applied !== managedMode || !approvalOk) throw fail('Native managed permission initialization failed');
  }
  async function ensure(agent, created = false) {
    if (closed) throw fail('Assistant permission model is closed');
    if (!optedIn) return legacy;
    const state = stage(agent);
    await validation; lifetime.signal.throwIfAborted();
    if (state && !root) throw fail('Managed runtime receipt could not be verified');
    if (state?.pending) await state.pending;
    if (states.has(agent)) { if (!state?.ready) throw fail('Managed permission guard is not ready'); await configure(agent, created); return snapshot(agent); }
    if (!state) {
      if (created) throw fail('A new managed Session must use its own provisioned workspace');
      return legacy;
    }
    state.pending = initialize(agent, state);
    try { await state.pending; await configure(agent, created); return snapshot(agent); }
    catch (error) { state.ready = false; throw error; }
    finally { state.pending = undefined; }
  }
  // The native service owns the official definitions and their original bodies.
  // Resolve on every read/call so late native readiness, scoped replacements and
  // plugin disposal cannot leave a cached name-based grant behind.
  function sessionTool(agent, name) {
    if (!SESSION_TOOLS.includes(name)) return false;
    const tools = agent.ctx?.get('tools'), schedule = agent.ctx?.get('schedule');
    const definition = tools?.get(name, agent);
    return Boolean(definition && typeof schedule?.isToolDefinition === 'function' && schedule.isToolDefinition(definition));
  }
  async function initialize(agent, state) {
    const cwd = await owned(agent?.session?.id);
    lifetime.signal.throwIfAborted();
    if (!cwd || agent?.session?.header?.cwd !== cwd) {
      throw fail('Managed workspace ownership cannot be restored');
    }
    const tools = agent.ctx?.get('tools'), approval = ctx.get('approval'), fs = ctx.get('fs'), directory = ctx.get('workingDirectory');
    if (typeof tools?.guard !== 'function' || typeof tools.get !== 'function' || typeof approval?.request !== 'function'
      || typeof approval.effectivePolicy !== 'function' || !ASSISTANT_PERMISSION_MODES.includes(fs?.sandboxMode)
      || typeof directory?.get !== 'function') throw fail('Native workspace guard services are unavailable');
    const sensitiveCatalog = new Map(catalog);
    for (const item of registerAssistantWorkspaceTools({ agent, workspaceRoot: cwd })) sensitiveCatalog.set(item.name, item);
    for (const item of sensitiveCatalog.values()) if (tools.get(item.name, agent) !== item.definition) throw fail('Sensitive tool definition is not the trusted catalog entry');
    // Cloud execution is a grant, not a per-call approval: the confined child
    // never inherits the Host environment, and revocation disposes it with the
    // same Session binding. A requested grant whose image cannot confine the
    // child stays unregistered instead of failing the whole assistant.
    let cloud, cloudFailure;
    if (grants.includes('code-execution')) {
      const executor = createCloudExecutor({ workspaceRoot: cwd, env, sandbox: cloudSandbox });
      if (executor.available) {
        try { cloud = registerAssistantCloudExecutionTools({ agent, workspaceRoot: cwd, executor }); }
        catch (error) { cloudFailure = error; executor.dispose(); }
      } else { cloudFailure = executor.reason || 'ASSISTANT_CLOUD_EXECUTION_UNAVAILABLE'; executor.dispose(); }
    }
    // Cloud browser is a grant too: the CDP child talks only through the
    // image's egress proxy, and revocation closes the browser with the Session.
    let browsing, browserFailure;
    if (grants.includes('browser') && cloudBrowserUsable) {
      try { browsing = registerAssistantCloudBrowserTools({ agent, workspaceRoot: cwd, env }); }
      catch (error) { browserFailure = error; browsing = undefined; }
    }
    // A grant whose image cannot register the tools stays visible in the Host
    // log: both silent catches previously hid a registry-schema rejection.
    for (const [name, failure] of [['execution', cloudFailure], ['browser', browserFailure]]) {
      if (failure === undefined) continue;
      const detail = `assistant cloud ${name} was not registered: ${typeof failure === 'string' ? failure
        : [failure?.code, failure?.message].filter(Boolean).join(': ') || String(failure)}`;
      try { ctx.get?.('logger')?.warn?.(detail); } catch { /* Logging must never fail the Session. */ }
      // The managed runtime has no logger service in the frozen Host; its
      // stderr is the only durable place a capability refusal can be seen.
      try { process.stderr.write(`[agentkit-personal-assistant] ${detail}\n`); } catch { /* stderr closed */ }
    }
    const cloudNames = new Set([...(cloud?.names || []), ...(browsing?.names || [])]);
    if (cloud) for (const definition of cloud.definitions) if (tools.get(definition.name, agent) !== definition) throw fail('Cloud execution tool definition is not the trusted registration');
    if (browsing) for (const definition of browsing.definitions) if (tools.get(definition.name, agent) !== definition) throw fail('Cloud browser tool definition is not the trusted registration');
    const admitted = new Map([...ROUTINE, ...webTools, ...sensitiveCatalog.keys(), ...cloudNames].map(name => [name, tools.get(name, agent)]).filter(([, definition]) => definition));
    const copies = createAssistantWorkspaceAttachmentCopies({ agent, workspaceRoot: cwd });
    const approved = new WeakSet(); let disposed = false;
    function decision(exec) {
      if (disposed || exec.agent !== agent || exec.signal?.aborted || directory.get(agent.session) !== cwd || agent.session.header.cwd !== cwd) return 'Assistant workspace ownership changed';
      if (exec.arguments?.sandbox_permissions !== undefined) return 'Sandbox escalation requires a separate supported capability';
      if (sessionTool(agent, exec.name)) return undefined;
      if (cloudNames.has(exec.name)) return undefined;
      if (!admitted.has(exec.name) || tools.get(exec.name, agent) !== admitted.get(exec.name)) return 'This tool is not admitted by the assistant workspace policy';
      if (sensitiveCatalog.has(exec.name)) return approval.effectivePolicy(agent.session) === 'ask' ? undefined : 'Sensitive approvals are disabled for this session';
      if (webTools.includes(exec.name)) return exec.name === 'web_fetch' ? checkedFetchUrl(exec.arguments?.url) : undefined;
      const field = ['glob', 'grep'].includes(exec.name) ? 'path' : 'file_path';
      try {
        const input = exec.arguments?.[field] ?? (field === 'path' ? '.' : undefined);
        if (!(field === 'path' ? checkedSearchTree(cwd, input) : checkedPath(cwd, input))) return 'Path is outside the assistant workspace, uses an unsupported link, or exceeds the bounded search tree';
      }
      catch { return 'Assistant workspace path cannot be verified'; }
      return undefined;
    }
    state.guard = exec => decision(exec) || (sensitiveCatalog.has(exec.name) && !approved.delete(exec) ? 'This sensitive action has no live one-shot approval' : undefined);
    const listener = agent.ctx.on('tools/pre-execute', async (exec, next) => {
      const denied = decision(exec); if (denied) return { kind: 'deny', reason: denied };
      const sensitive = sensitiveCatalog.get(exec.name);
      if (!sensitive) return next();
      let reason;
      try { reason = sensitive.describe(exec.arguments, exec); } catch { /* Incomplete details cannot be approved. */ }
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) return { kind: 'deny', reason: 'Concrete action details are unavailable for approval' };
      const outcome = await approval.request({ agent, toolName: exec.name, callId: exec.callId, reason, signal: AbortSignal.any([exec.signal, lifetime.signal]) });
      if (outcome !== 'allowed-once' || exec.signal.aborted) return { kind: 'deny', reason: 'Sensitive action was not approved for this invocation' };
      approved.add(exec);
      return next();
    }, { prepend: true });
    state.releaseListener = listener;
    const release = () => { disposed = true; state.ready = false; listener(); copies.dispose(); cloud?.executor.dispose(); browsing?.browser?.dispose?.(); for (const dispose of [...(cloud?.disposers || []), ...(browsing?.disposers || [])]) dispose(); releases.delete(release); };
    releases.add(release); states.set(agent, { cwd, sensitiveCatalog, copies, cloud, browsing, grants }); byId.set(agent.session.id, agent);
    state.ready = true;
  }

  function snapshot(value) {
    if (closed && optedIn) return { profile: ASSISTANT_PERMISSION_PROFILE, managed: false, permission: 'unavailable', approval: 'unavailable', status: 'closed' };
    const agent = typeof value === 'string' ? byId.get(value) : value;
    if (!agent || !states.has(agent)) return typeof value === 'string' && optedIn
      ? { profile: ASSISTANT_PERMISSION_PROFILE, managed: false, permission: 'unknown', approval: 'unavailable', status: 'awaiting-session-validation' } : legacy;
    const permission = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode;
    const approval = ctx.get('approval')?.effectivePolicy(agent.session);
    const state = states.get(agent), cloud = state.cloud;
    return { profile: ASSISTANT_PERMISSION_PROFILE, managed: true, permission, approval,
      execution: cloud ? 'bounded-cloud-exec/v1' : state.grants.includes('code-execution') ? 'unavailable' : 'fixed-tool-operations',
      arbitraryShell: false, network: state.browsing ? 'public-web-read-only' : cloud ? 'offline' : 'public-web-read-only',
      webTools: webTools.filter(name => agent.ctx.get('tools')?.get?.(name, agent)),
      sessionTools: staged.get(agent)?.ready ? SESSION_TOOLS.filter(name => sessionTool(agent, name)) : [],
      sensitiveTools: [...states.get(agent).sensitiveCatalog.keys()].filter(name => agent.ctx.get('tools').get(name, agent)),
      shellTools: cloud ? [...cloud.names] : [],
      browserTools: state.browsing ? [...state.browsing.names] : [],
      grants: [...state.grants],
      isolation: 'private-runtime-workspace' };
  }
  // The synchronous guard precedes any asynchronous receipt I/O or restored
  // timer work. Disposing this facade leaves denial in place until Agent scope
  // disposal; it never exposes a still-live agent with persisted wider knobs.
  const releaseCreated = base && ctx.on('agent/created', ({ agent }) => {
    if (!stage(agent)) return;
    return ensure(agent).catch(error => { const state = staged.get(agent); if (state) state.ready = false; throw error; });
  });
  const initial = base ? (ctx.get('agents')?.list?.() || []).filter(agent => stage(agent)) : [];
  await validation;
  for (const agent of initial) await ensure(agent);
  return { enabled: optedIn && Boolean(root), newSessionCwd, ensure, snapshot,
    // Static capability facts for the runtime identity document; no Session needed.
    cloudCapabilities: Object.freeze({
      codeExecution: optedIn && Boolean(root) && cloudSandboxUsable && grants.includes('code-execution'),
      browser: optedIn && Boolean(root) && cloudBrowserUsable && grants.includes('browser'),
      network: grants.includes('browser') && cloudBrowserUsable ? 'public-web-read-only' : 'offline',
    }),
    async stageAttachment(agent, ref, bytes) {
      const state = states.get(agent);
      if (closed || !state || !staged.get(agent)?.ready || await owned(agent.session.id) !== state.cwd || agent.session.header.cwd !== state.cwd) throw fail('Attachment workspace ownership cannot be verified');
      if (closed || !staged.get(agent)?.ready) throw fail('Attachment workspace ownership cannot be verified');
      await state.copies.stage(ref, bytes);
    },
    policyOf: agent => snapshot(agent).approval,
    ownsSession: id => { const agent = byId.get(id); return !closed && Boolean(agent && staged.get(agent)?.ready); },
    dispose: () => { closed = true; lifetime.abort(); if (typeof releaseStartup === 'function') releaseStartup(); releaseCreated?.(); for (const release of [...releases]) release(); } };
}
