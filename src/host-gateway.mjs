/** 通过 DSH 已鉴权 Connection RPC 转接到固定云网关；凭据始终留在 Host。 */
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DIRECTORY_BOT_ID, publicBotDirectory } from './client/bot-directory.mjs';
import { createCloudSessionTransport } from './cloud-session-transport.mjs';
import { BotRegistry, loadBotRegistry, publicMemoryItems } from './bot-registry.mjs';
import { createPersonalAssistantStateStore } from './persistent-state.mjs';
import { createLocalAccess, isLocalControlOperation } from './local-access.mjs';
/**
 * 云网关会拒掉 Node 内置（undici）WebSocket：握手成功后立即 1006 断开且不带关闭帧，
 * 面板只能看到「连接暂时不可用」。实测同一张 ticket 下浏览器、Python websockets 与 `ws`
 * 包均正常，因此这里优先解析 Node 原生 `ws`（DSH Host 自带），再回退全局 WebSocket。
 * 解析顺序：DSH Host 入口所在包 → 插件所在包及其上级 → 云端固定安装路径。
 */
const resolveDefaultWebSocket = () => {
  for (const base of [process.argv[1], import.meta.url, new URL('../../', import.meta.url).href, '/opt/agentkit/dsh-runtime/node_modules/']) {
    if (!base) continue;
    try {
      const loaded = createRequire(base)('ws');
      const Impl = loaded?.WebSocket ?? loaded?.default ?? loaded;
      if (typeof Impl === 'function') return Impl;
    } catch {}
  }
  return globalThis.WebSocket;
};
const DEFAULT_WEBSOCKET = resolveDefaultWebSocket();
const ENDPOINT = '/api/personal-assistant';
// 所有会话操作必须经过云端绑定和具名 Bot 的签名 control 票据。
const SESSION_OPERATIONS = Object.freeze([
  'personal-assistant.sessions.list',
  'personal-assistant.session.create',
  'personal-assistant.session.snapshot',
  'personal-assistant.session.events',
  'personal-assistant.turn.submit',
  'personal-assistant.schedule.create',
  'personal-assistant.file.upload',
  'personal-assistant.file.download',
]);
const BINDING_OPERATIONS = Object.freeze([
  // The host owns the cloud account, instance selection and credential.
  // These operations never accept a credential from the page: they only drive
  // discovery, credential recovery and creation inside the Host Host.
  'personal-assistant.desktop.status',
  'personal-assistant.desktop.connect',
  'personal-assistant.desktop.create',
  'personal-assistant.desktop.disconnect',
  'personal-assistant.desktop.destroy',
  // The Assistant's own reachable settings. The page never talks to the cloud
  // control plane; The host validates and submits every change.
  'personal-assistant.settings.inspect',
  'personal-assistant.settings.update',
  'personal-assistant.settings.versions',
]);
const BINDING_METHODS = Object.freeze({
  'personal-assistant.desktop.status': 'status',
  'personal-assistant.desktop.connect': 'connect',
  'personal-assistant.desktop.create': 'create',
  'personal-assistant.desktop.disconnect': 'disconnect',
  'personal-assistant.desktop.destroy': 'destroy',
  'personal-assistant.settings.inspect': 'settings',
  'personal-assistant.settings.update': 'settingsUpdate',
  'personal-assistant.settings.versions': 'settingsVersions',
});
// 这些写操作会改变 Host 侧的实例或绑定（创建/切换/断开/关闭/更新配置），必须绕过
// binding 缓存重新读取，否则「刚创建或刚切换的实例」会被几毫秒前的旧绑定吃掉。
const BINDING_REFRESH_OPERATIONS = new Set([
  'personal-assistant.desktop.create',
  'personal-assistant.desktop.connect',
  'personal-assistant.desktop.disconnect',
  'personal-assistant.desktop.destroy',
  'personal-assistant.settings.update',
]);
const AGENT_ID = /^ar-[A-Za-z0-9-]{4,120}$/u;
const BOT_ID = /^[a-z][a-z0-9._-]{0,63}$/u;
// 面板新增的本机数据操作：不经过云端会话通道。云目录/状态目录不可用时降级返回，
// 不阻断面板；只有本机授权与写操作会明确报错。
const LOCAL_OPERATIONS = new Set([
  'personal-assistant.bots.overview',
  'personal-assistant.bot.detail',
  'personal-assistant.bot.create',
  'personal-assistant.bot.delete',
  'personal-assistant.bot.memory.delete',
  'personal-assistant.bot.model.update',
  'personal-assistant.local-access.status',
  'personal-assistant.local-access.grant',
  'personal-assistant.local-access.revoke',
  'personal-assistant.create.status',
]);
// 创建进度只观测 Host 真正能看到的阶段：Host 的 create 是一个整体 RPC，
// 内部 runtime/computer/assistant 阶段无法逐段回报，因此不伪造中间态。
const CREATE_STAGES = Object.freeze([
  Object.freeze({ id: 'instance', detail: '云端实例已创建' }),
  Object.freeze({ id: 'runtime', detail: '运行时已初始化' }),
  Object.freeze({ id: 'computer', detail: '云电脑已就绪' }),
  Object.freeze({ id: 'assistant', detail: '助理已上线' }),
]);
const CREATE_ESTIMATED_MS = 90_000;
const BOT_COLLECTION = 'bots';
const OPERATIONS = new Set(['personal-assistant.configuration', 'personal-assistant.bots.list', 'personal-assistant.desktop.ticket',
  // 本机剪贴板只能由 Host 进程读写：Host 的 Electron 渲染器没有 clipboard-read/
  // clipboard-write 权限，navigator.clipboard 在面板里一律被拒，⌘C/⌘V 就成了空操作。
  'personal-assistant.clipboard.read', 'personal-assistant.clipboard.write',
  ...BINDING_OPERATIONS, ...SESSION_OPERATIONS, ...LOCAL_OPERATIONS]);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const CLIPBOARD_MAX_BYTES = 64 * 1024;
const CLIPBOARD_TIMEOUT_MS = 2000;
/** 本机剪贴板命令的原始字节按 UTF-8 → GB18030 → latin1 逐级解码，和云端 selection 读取同一口径。 */
const CLIPBOARD_ENCODINGS = Object.freeze(['utf-8', 'gb18030']);
export function decodeClipboardBytes(value) {
  if (typeof value === 'string') return value;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  if (!buffer.length) return '';
  for (const encoding of CLIPBOARD_ENCODINGS) {
    // ignoreBOM:true 与 Buffer.toString('utf8') 一致：合法 BOM 属于正文，不能被吞掉。
    try { return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { /* 该编码解释不了这份字节，继续回退 */ }
  }
  // latin1 逐字节映射：内容仍然可逆，且不会出现 U+FFFD 这种不可恢复的替换字符。
  return buffer.toString('latin1');
}
/**
 * Windows PowerShell 5.1 把 stdout 重定向时按系统代码页（中文为 CP936）编码，
 * 直接按 UTF-8 读会把中文变成乱码；显式把 OutputEncoding 切成 UTF-8。
 */
export const windowsClipboardReadArgs = () => Object.freeze(['-NoProfile', '-NonInteractive', '-Command',
  // 设置输出编码失败（个别重定向/宿主组合会抛「句柄无效」）不能让整条读取挂掉：
  // 包一层 try 后即便退回系统代码页，decodeClipboardBytes 的 GB18030 回退也能还原中文。
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }; Get-Clipboard -Raw']);
/**
 * 写回使用 -EncodedCommand（UTF-16LE base64）。原来的 `Set-Clipboard -Value ${JSON.stringify(text)}`
 * 是拼一条 PowerShell 命令行：文本里的双引号、反引号、$ 变量会被 PowerShell 解释，
 * 中文虽然能过，但引号和 $ 会把内容写坏。单引号串 + '' 转义 + base64 传参不再经过任何 shell 解析。
 */
export const windowsClipboardWriteArgs = value => Object.freeze(['-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(`Set-Clipboard -Value '${String(value ?? '').replace(/'/gu, "''")}'`, 'utf16le').toString('base64')]);
/**
 * macOS 的 pbpaste/pbcopy 在没有显式文本编码时按 **MacRoman** 读写剪贴板：
 * 中文读出来逐字变成「????」，写进去则变成「‰Ω†Â•Ω」，而剪贴板里 utf8/ut16 口味
 * 本身是好的——两个命令自洽、和原生应用却对不上，用户看到的就是复制粘贴全乱码。
 * 这两个命令都尊重 __CF_USER_TEXT_ENCODING：0x1F5 是系统脚本槽位，
 * 0x08000100 是 kCFStringEncodingUTF8，钉死成 UTF-8 后两个方向都正常。
 */
const DARWIN_CLIPBOARD_ENCODING = '0x1F5:0x08000100:0';
const darwinClipboardEnv = () => ({ ...process.env, __CF_USER_TEXT_ENCODING: DARWIN_CLIPBOARD_ENCODING });
const runClipboardReader = promisify(execFile);
// execFile 在 stdout 超过 maxBuffer 时抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER；它说明「内容太大」，
// 而不是「剪贴板坏了」，必须映射成 413 让面板给出「超过 64 KiB」的可照做提示。
const isClipboardTooLarge = error => error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxbuffer/iu.test(String(error?.message || ''));
/** Host 是普通 Node 进程：直接调系统剪贴板命令，不依赖浏览器权限。 */
async function readHostClipboard({ execFileImpl = runClipboardReader } = {}) {
  // encoding:'buffer'：剪贴板命令吐的是原始字节，先按字节收下来再决定用哪种字符集解码。
  // 用默认 encoding:'utf8' 会把 GBK/latin1 字节直接替换成 U+FFFD，中文就丢了。
  const options = { timeout: CLIPBOARD_TIMEOUT_MS, maxBuffer: CLIPBOARD_MAX_BYTES, windowsHide: true, encoding: 'buffer' };
  try {
    if (process.platform === 'darwin') {
      // 不带 env 的话 pbpaste 会把中文按 MacRoman 输出成一串「?」，直接丢字。
      const { stdout } = await execFileImpl('/usr/bin/pbpaste', [], { ...options, env: darwinClipboardEnv() });
      return { text: decodeClipboardBytes(stdout) };
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileImpl('powershell.exe', windowsClipboardReadArgs(), options);
      return { text: decodeClipboardBytes(stdout).replace(/\r\n$/u, '') };
    }
    try {
      const { stdout } = await execFileImpl('wl-paste', ['--no-newline'], options);
      return { text: decodeClipboardBytes(stdout) };
    } catch (error) {
      // 超长是内容问题，换 xclip 也一样超；直接上抛给外层映射 413，不误报「不可用」。
      if (isClipboardTooLarge(error)) throw error;
      // 显式要 UTF8_STRING：不写就依赖 xclip 的默认 target，不同版本行为不一致。
      const { stdout } = await execFileImpl('xclip', ['-selection', 'clipboard', '-o', '-target', 'UTF8_STRING'], options);
      return { text: decodeClipboardBytes(stdout) };
    }
  } catch (error) {
    if (isClipboardTooLarge(error)) throw fail('PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE', '本机剪贴板内容超过 64 KiB，无法读取', 413);
    throw fail('PERSONAL_ASSISTANT_CLIPBOARD_UNAVAILABLE', '本机剪贴板暂时不可用', 503);
  }
}
function pipeToClipboardWriter(command, args, value, { env } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => { child.kill?.('SIGKILL'); finish(new Error('clipboard write timeout')); }, CLIPBOARD_TIMEOUT_MS);
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, ...(env ? { env } : {}) });
    child.once('error', error => finish(error));
    child.once('exit', code => finish(code === 0 ? null : new Error(`clipboard writer exited ${code}`)));
    child.stdin?.end(value);
  });
}
async function writeHostClipboard(text, { execFileImpl = runClipboardReader } = {}) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') > CLIPBOARD_MAX_BYTES) throw fail('PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE', '剪贴板内容超过 64 KiB', 413);
  try {
    // 写方向同理：不带 env 时 pbcopy 会把 UTF-8 当成 MacRoman 存进去，
    // 原生应用粘出来就是「‰Ω†Â•Ω」。
    if (process.platform === 'darwin') return await pipeToClipboardWriter('/usr/bin/pbcopy', [], value, { env: darwinClipboardEnv() });
    if (process.platform === 'win32') {
      await execFileImpl('powershell.exe', windowsClipboardWriteArgs(value), { timeout: CLIPBOARD_TIMEOUT_MS, windowsHide: true });
      return;
    }
    try {
      return await pipeToClipboardWriter('wl-copy', [], value);
    } catch {
      // stdin 用 utf8 写入；显式 target 让旧版/新版 xclip 都把字节标成 UTF8_STRING。
      return await pipeToClipboardWriter('xclip', ['-selection', 'clipboard', '-target', 'UTF8_STRING'], value);
    }
  } catch {
    throw fail('PERSONAL_ASSISTANT_CLIPBOARD_UNAVAILABLE', '本机剪贴板暂时不可用', 503);
  }
}
const safeCloseCode = value => Number.isInteger(value) && value >= 1000 && value <= 4999 ? value : undefined;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const requireSessionId = value => {
  const text = String(value ?? '').trim();
  if (!SESSION_ID.test(text)) throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '会话标识无效');
  return text;
};
import { createSystemFetch, trustedCAs } from './system-fetch.mjs';

/**
 * 面板本机状态的落盘目录：优先显式配置，其次云端运行时同款环境变量，
 * 最后跟随 workspace（与 runtime 默认 `<workspace>/.agentkit/state` 一致）。
 * 拿不到时返回空串 → 记忆/授权退化为进程内状态，不阻塞面板。
 */
function resolveStateRoot(config, env) {
  for (const candidate of [config.statePath, env.ASSISTANT_STATE_PATH, env.AGENTKIT_STATE_DIR, env.PERSONAL_ASSISTANT_STATE_PATH]) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }
  const workspace = String(config.workspace ?? env.WORKSPACE_PATH ?? '').trim();
  return workspace ? join(workspace, '.agentkit', 'state') : '';
}

/**
 * 把面板在本机新建/改过/删除的 Bot 覆盖到配置 registry 上。
 * 只接受合法 botId 与白名单字段；单条损坏时跳过，不影响其它 Bot。
 */
function applyPersistedBots(registry, rows, deletedBots = new Set()) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const botId = String(row.botId ?? '').trim();
    if (!BOT_ID.test(botId)) continue;
    if (row.deleted === true) { registry.remove(botId); deletedBots.add(botId); continue; }
    if (registry.has(botId)) {
      if (typeof row.model === 'string' && row.model.trim()) {
        try { registry.setModel(botId, row.model); } catch { /* 单个覆盖无效时保留配置值 */ }
      }
      continue;
    }
    try {
      registry.upsert({
        botId,
        displayName: typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName.trim().slice(0, 120) : botId,
        systemPromptRevision: `local:${botId}`,
        role: 'custom',
        ...(typeof row.model === 'string' && row.model.trim() ? { model: row.model } : {}),
        ...(typeof row.createdAt === 'string' && row.createdAt.trim() ? { createdAt: row.createdAt } : {}),
      });
    } catch { /* 忽略无法归一化的本地行 */ }
  }
}

/** 本机 Bot 覆盖/新建/删除的持久化；状态目录不可用时静默降级为内存。 */
async function persistBotRow(stateStore, row) {
  if (!stateStore) return false;
  try {
    await stateStore.mutate(BOT_COLLECTION, rows => {
      const index = rows.findIndex(item => item && typeof item === 'object' && item.botId === row.botId);
      if (index < 0) rows.push(row); else rows[index] = { ...rows[index], ...row };
      return true;
    });
    return true;
  } catch {
    return false;
  }
}

function requireBotId(value) {
  const text = String(value ?? '').trim();
  if (!BOT_ID.test(text)) throw fail('PERSONAL_ASSISTANT_BOT_INVALID', '助理标识无效', 400);
  return text;
}

// Generic host adapter name. The plugin may run in Host or another DSH
// host; no host product name is part of this runtime contract.
export const PERSONAL_ASSISTANT_DESKTOP_SERVICE = 'agentkitPersonalAssistantDesktop';

// 默认走系统信任链：内网/预发网关的证书不在 Node 内置 CA 里，直接 fetch 会 "fetch failed"。
const defaultFetchImpl = createSystemFetch();
export function createPersonalAssistantHostGateway(config = {}, { env = process.env, fetchImpl = defaultFetchImpl, WebSocketImpl = DEFAULT_WEBSOCKET, getHostDesktop = () => undefined, sessionChannel, cloudSessionTransport, bindingCacheMs = 0, botRegistry, stateStore, localAccess, platform, hostVersion, clipboardExecFile } = {}) {
  const agentId = String(config.agentId ?? env.AGENTKIT_PERSONAL_ASSISTANT_AGENT_ID ?? '').trim();
  const rawUrl = String(config.gatewayUrl ?? env.AGENTKIT_PERSONAL_ASSISTANT_GATEWAY_URL ?? '').trim();
  const apiKey = String(config.apiKey ?? env.AGENTKIT_PERSONAL_ASSISTANT_GATEWAY_API_KEY ?? '').trim();
  let base;
  if (rawUrl) {
    try {
      base = new URL(rawUrl.endsWith('/') ? rawUrl : `${rawUrl}/`);
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
      const allowHttp = config.allowInsecureHttp === true || env.AGENTKIT_PERSONAL_ASSISTANT_ALLOW_HTTP_GATEWAY === '1';
      if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && (local || allowHttp)))) throw new Error('untrusted URL');
    } catch { throw fail('PERSONAL_ASSISTANT_GATEWAY_INVALID', '云网关地址无效；预发 HTTP 需由 Host 显式允许'); }
  }
  const configured = Boolean(base && agentId && apiKey);
  let hostSeen = false;
  // binding 缓存：面板每次打开都会串行读 5 次 configuration（configuration、bots.list 内部
  // 签票、sessions.list、session.snapshot、session.events），而 Host 的绑定在 2s 内基本
  // 稳定。这里缓存短 TTL 的公开绑定并合并并发请求（防 stampede）。缓存内容只有
  // { configured, agentId, host: hostService }，绝不缓存凭据或票据。
  // 默认关闭（直接构造 gateway 的调用方，含测试，保持“每次向 Host 确认绑定”的旧语义）；
  // 生产注册路径 registerPersonalAssistantHostGateway 显式开启。
  const bindingCacheTtlMs = Number.isFinite(bindingCacheMs) && bindingCacheMs > 0 ? bindingCacheMs : 0;
  let cachedBinding;
  let pendingBinding;
  // 代际号：清缓存时递增。慢的在途 configuration 若在清缓存之后才返回，它的结果
  // 已经过期（期间可能发生了创建/切换），不能把旧绑定重新写回缓存。
  let bindingGeneration = 0;
  const clearBindingCache = () => { bindingGeneration += 1; cachedBinding = undefined; pendingBinding = undefined; };
  // 服务可晚于本插件加载，也可随 Host 卸载；缓存绑定但不缓存凭据。
  async function callHost(service, method, input, signal) {
    try { return await service[method](input, signal || AbortSignal.timeout(10_000)); }
    catch (error) {
      const rawStatus = Number(error?.status ?? error?.details?.status);
      const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 503;
      // 原始异常可能包含上游 HTTP 头或凭据，不能进入页面 RPC。
      throw fail(status >= 500 ? 'PERSONAL_ASSISTANT_HOST_UNAVAILABLE' : 'PERSONAL_ASSISTANT_TICKET_REFUSED', 'Host 暂时无法授权云电脑连接，请检查实例状态与云端登录', status);
    }
  }
  async function binding(signal, fresh = false) {
    let hostService;
    try { hostService = getHostDesktop(); }
    catch { clearBindingCache(); throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', 'Host 云连接服务暂时不可用', 503); }
    if (hostService == null) {
      // Host 卸载或服务消失必须立刻生效：静态配置分支本来就不用打 RPC，不缓存。
      clearBindingCache();
      if (hostSeen) throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', 'Host 云连接服务已卸载，请重新打开 Host', 503);
      // 独立开发 Host 的显式连接仍可用；Host 拒绝/卸载时绝不降级到此分支。
      return { configured, agentId, host: undefined };
    }
    hostSeen = true;
    // 服务对象被替换（晚加载/重载）时，旧缓存里的 Host 服务引用不能继续用。
    if (cachedBinding && cachedBinding.value.host !== hostService) clearBindingCache();
    if (!fresh && cachedBinding && Date.now() - cachedBinding.at < bindingCacheTtlMs) return cachedBinding.value;
    // 并发合并：同一时刻只向 Host 打一次 configuration，其余请求共享同一个 promise。
    if (!fresh && pendingBinding) return pendingBinding;
    if (typeof hostService.configuration !== 'function' || typeof hostService.issueTicket !== 'function') {
      clearBindingCache();
      throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', '请更新 Host 云连接服务', 503);
    }
    const pending = (async () => {
      const generation = bindingGeneration;
      const value = await callHost(hostService, 'configuration', agentId ? { agentId } : {}, signal);
      if (!plain(value) || typeof value.configured !== 'boolean' || (value.configured && (typeof value.agentId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/u.test(value.agentId)))) throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', 'Host 返回的实例绑定无效', 502);
      const result = { configured: value.configured, agentId: value.configured ? value.agentId : undefined, host: hostService };
      if (bindingCacheTtlMs > 0 && bindingGeneration === generation) cachedBinding = { at: Date.now(), value: result };
      return result;
    })();
    pendingBinding = pending;
    try { return await pending; }
    catch (error) {
      // 任何一次绑定读取失败都立即失效：下一次请求必须重新向 Host 确认。
      clearBindingCache();
      throw error;
    } finally { if (pendingBinding === pending) pendingBinding = undefined; }
  }
  function publicHostTicket(value, input) {
    let ws;
    try { ws = new URL(value?.wsUrl); } catch {}
    const local = ws && ['127.0.0.1', 'localhost', '[::1]'].includes(ws.hostname);
    const allowHttp = config.allowInsecureHttp === true || env.AGENTKIT_PERSONAL_ASSISTANT_ALLOW_HTTP_GATEWAY === '1';
    const remaining = Date.parse(value?.expiresAt) - Date.now();
    if (!plain(value) || !/^[A-Za-z0-9_-]{32,512}$/u.test(String(value.ticket || ''))
      || value.agentId !== input.agentId || value.botId !== input.botId || value.readOnly !== (input.mode === 'read')
      || value.protocol !== 'agentkit.personal-assistant.desktop.v1' || !Number.isFinite(remaining) || remaining <= 0 || remaining > 60_000
      || !ws || ws.username || ws.password || ws.search || ws.hash || ws.pathname !== '/personal-assistant/desktop/ws'
      || (ws.protocol !== 'wss:' && !(ws.protocol === 'ws:' && (local || allowHttp)))
      || (value.leaseId != null && (typeof value.leaseId !== 'string' || value.leaseId.length > 256))) throw fail('PERSONAL_ASSISTANT_TICKET_INVALID', 'Host 返回的桌面授权格式错误', 502);
    return { ticket: value.ticket, expiresAt: value.expiresAt, agentId: input.agentId, botId: input.botId,
      wsUrl: ws.href, protocol: value.protocol, leaseId: value.leaseId ?? null, readOnly: input.mode === 'read' };
  }
  const cloudSessions = cloudSessionTransport ?? createCloudSessionTransport({
    issueTicket: (scope, signal) => request('personal-assistant.desktop.ticket', scope, signal),
    WebSocketImpl, ca: trustedCAs(),
  });
  function publicBindingStatus(value) {
    if (!plain(value) || typeof value.configured !== 'boolean') throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', 'Host 返回的绑定状态无效', 502);
    const reason = typeof value.reason === 'string' ? value.reason.slice(0, 80) : '';
    const candidates = Array.isArray(value.candidates) ? value.candidates.filter(row => plain(row) && typeof row.agentId === 'string' && AGENT_ID.test(row.agentId))
      .slice(0, 20).map(row => ({ agentId: row.agentId, name: typeof row.name === 'string' ? row.name.slice(0, 80) : '',
        status: typeof row.status === 'string' ? row.status.slice(0, 32) : '', createdAt: typeof row.createdAt === 'string' ? row.createdAt.slice(0, 40) : '' })) : [];
    // The credential never reaches the page; only the public binding shape does.
    return { configured: value.configured, agentId: value.configured && typeof value.agentId === 'string' ? value.agentId : undefined,
      mode: 'host', reason, candidates };
  }
  function publicBinding(value) {
    if (!plain(value) || typeof value.configured !== 'boolean' || (value.configured && (typeof value.agentId !== 'string' || !AGENT_ID.test(value.agentId))))
      throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', 'Host 返回的绑定结果无效', 502);
    return { configured: value.configured, agentId: value.configured ? value.agentId : undefined, mode: 'host' };
  }
  const settingsText = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  /** Settings are whitelisted field by field for the same reason tickets are:
   * the page must never receive anything the Host did not mean to publish. */
  function publicSettings(value) {
    if (!plain(value) || typeof value.configured !== 'boolean' || !plain(value.runtime)) throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', 'Host 返回的配置格式无效', 502);
    const environmentVariables = Array.isArray(value.environmentVariables) ? value.environmentVariables.filter(plain)
      .filter(row => typeof row.key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(row.key))
      .slice(0, 64).map(row => ({ key: row.key, sensitive: row.sensitive === true,
        value: row.sensitive === true ? '' : settingsText(row.value, 4096) })) : [];
    return {
      configured: value.configured,
      agentId: value.configured && typeof value.agentId === 'string' && AGENT_ID.test(value.agentId) ? value.agentId : undefined,
      name: settingsText(value.name, 120), description: settingsText(value.description, 300),
      status: settingsText(value.status, 32), deploymentType: settingsText(value.deploymentType, 40),
      runtime: { name: settingsText(value.runtime.name, 60), version: settingsText(value.runtime.version, 40),
        imageDigest: settingsText(value.runtime.imageDigest, 200), updatedAt: settingsText(value.runtime.updatedAt, 40) },
      model: settingsText(value.model, 120),
      prompt: typeof value.prompt === 'string' ? value.prompt.slice(0, 8_000) : '',
      environmentVariables,
      recordSource: value.recordSource === 'host' ? 'host' : 'missing',
    };
  }
  function publicSettingsVersions(value) {
    if (!plain(value) || !Array.isArray(value.versions)) throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', 'Host 返回的版本列表无效', 502);
    const versions = value.versions.filter(plain)
      .filter(row => typeof row.version === 'string' && /^\d+\.\d+\.\d+$/u.test(row.version))
      .slice(0, 200).map(row => ({ version: row.version, image: settingsText(row.image, 200),
        capabilities: Array.isArray(row.capabilities) ? row.capabilities.filter(cap => typeof cap === 'string').slice(0, 20) : [] }));
    return { currentVersion: settingsText(value.currentVersion, 40), versions, catalogAvailable: versions.length > 0 };
  }
  function publicSettingsUpdate(value) {
    if (!plain(value) || value.saved !== true) throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', 'Host 没有确认配置已提交，请稍后重试', 502);
    return { configured: true, saved: true, agentId: typeof value.agentId === 'string' && AGENT_ID.test(value.agentId) ? value.agentId : undefined,
      version: settingsText(value.version, 40), status: settingsText(value.status, 32) || 'updating' };
  }

  // —— 面板本机数据（Bot 概览/详情、本机授权、创建进度）——
  // 这些数据不经过云端会话通道：Bot 元数据来自配置 registry 与本地覆盖，记忆/会话
  // 计数来自 profile 状态目录；云目录不可达时只降级（degraded:true），不阻断面板。
  const stateRoot = resolveStateRoot(config, env);
  let servicesPromise;
  const ensureServices = () => {
    if (!servicesPromise) servicesPromise = createHostServices();
    return servicesPromise;
  };

  function hostConnected() {
    try {
      const hostService = getHostDesktop();
      return Boolean(hostService && typeof hostService.configuration === 'function' && typeof hostService.issueTicket === 'function');
    } catch { return false; }
  }

  async function createHostServices() {
    const profileId = String(config.profileId ?? agentId ?? 'default').trim() || 'default';
    let registry;
    let registryError = false;
    try { registry = botRegistry ?? loadBotRegistry({ bots: config.bots, env, profileId }); }
    catch { registryError = true; registry = new BotRegistry({ profileId }); }
    let store = stateStore ?? null;
    if (!store && stateRoot) {
      try { store = await createPersonalAssistantStateStore(stateRoot).init(); } catch { store = null; }
    }
    const access = localAccess ?? createLocalAccess({
      stateStore: store,
      probeConnection: () => hostConnected(),
      platform: String(platform ?? process.platform),
      hostVersion: String(hostVersion ?? config.hostVersion ?? env.DSH_HOST_VERSION ?? ''),
    });
    if (typeof access.load === 'function') await access.load();
    const deletedBots = new Set();
    if (store) {
      try { applyPersistedBots(registry, await store.read(BOT_COLLECTION), deletedBots); }
      catch { /* 覆盖数据损坏时退回配置 registry */ }
    }
    return Object.freeze({ registry, stateStore: store, localAccess: access, registryError, deletedBots, localDegraded: !store });
  }

  async function readLocalState(store) {
    if (!store) return { available: false, memory: [], turns: [], schedules: 0 };
    try {
      const [memory, turns, schedules] = await Promise.all([
        store.read('memory'), store.read('turns'), store.read('schedules'),
      ]);
      return {
        available: true,
        memory: Array.isArray(memory) ? memory : [],
        turns: Array.isArray(turns) ? turns : [],
        schedules: Array.isArray(schedules) ? schedules.length : 0,
      };
    } catch {
      return { available: false, memory: [], turns: [], schedules: 0 };
    }
  }

  /** 目录返回 id/名称，registry 提供角色/模型/能力；两边都没有的字段留空而不是编造。 */
  function buildOverviewBots(services, directory, memoryRows) {
    const counts = new Map();
    for (const row of memoryRows) {
      const id = String(row?.botId ?? '');
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const directoryById = new Map();
    for (const item of directory) directoryById.set(item.botId, item);
    const result = [];
    const seen = new Set();
    for (const bot of services.registry.list()) {
      if (services.deletedBots.has(bot.botId)) continue;
      const known = directoryById.get(bot.botId);
      let capabilities = [];
      try { capabilities = services.registry.capabilities(bot.botId); } catch { capabilities = []; }
      result.push({
        id: bot.botId,
        name: known?.displayName || bot.displayName,
        role: services.registry.roleOf(bot.botId),
        status: bot.status ?? 'idle',
        model: bot.model ?? '',
        memoryCount: counts.get(bot.botId) ?? 0,
        capabilityCount: capabilities.length,
        computer: bot.metadata?.computer === 'connected' ? 'connected' : 'idle',
      });
      seen.add(bot.botId);
    }
    for (const item of directory) {
      if (seen.has(item.botId) || services.deletedBots.has(item.botId)) continue;
      result.push({
        id: item.botId, name: item.displayName, role: result.length === 0 ? 'primary' : 'custom',
        status: 'idle', model: '', memoryCount: counts.get(item.botId) ?? 0, capabilityCount: 0, computer: 'idle',
      });
      seen.add(item.botId);
    }
    return result;
  }

  async function publicOverview(services, signal) {
    const local = await readLocalState(services.stateStore);
    let directory = [];
    let degraded = services.localDegraded || services.registryError || !local.available;
    try {
      const current = await binding(signal);
      if (current.configured) directory = (await readBotDirectory(current, signal)).bots;
      else degraded = true;
    } catch { degraded = true; }
    const active = [];
    const recent = [];
    for (const turn of local.turns) {
      if (!turn || typeof turn !== 'object') continue;
      const botId = String(turn.botId ?? '');
      const title = typeof turn.metadata?.title === 'string' && turn.metadata.title.trim()
        ? turn.metadata.title.trim().slice(0, 120) : String(turn.input ?? '').trim().slice(0, 120);
      if (turn.status === 'queued' || turn.status === 'running') {
        active.push({ kind: 'turn', botId, title, detail: turn.status === 'running' ? '正在执行' : '排队中' });
      } else if (turn.status === 'completed' || turn.status === 'failed') {
        recent.push({ id: String(turn.turnId ?? ''), title, status: turn.status === 'completed' ? 'done' : 'failed', at: String(turn.updatedAt ?? '') });
      }
    }
    active.splice(8);
    recent.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    recent.splice(8);
    return {
      bots: buildOverviewBots(services, directory, local.memory),
      active,
      recent,
      counts: { schedules: local.schedules, memories: local.memory.length, files: 0 },
      ...(degraded ? { degraded: true } : {}),
    };
  }

  async function publicBotDetail(services, payload, signal) {
    const botId = requireBotId(payload.botId);
    let degraded = services.localDegraded || services.registryError;
    let configured = false;
    try {
      configured = (await binding(signal)).configured === true;
      if (!configured) degraded = true;
    } catch { degraded = true; }
    let describe;
    try { describe = services.registry.describe(botId); } catch { describe = undefined; }
    if (!describe) {
      // 本机没有这个 Bot 时退回云目录确认它是否存在；目录不可达则降级返回而不是报错。
      if (!configured) throw fail('PERSONAL_ASSISTANT_BOT_NOT_FOUND', '当前助理不存在或已被删除', 404);
      try {
        const listing = await readBotDirectory(await binding(signal), signal);
        if (services.deletedBots.has(botId)) throw fail('PERSONAL_ASSISTANT_BOT_NOT_FOUND', '当前助理不存在或已被删除', 404);
        const found = listing.bots.find(item => item.botId === botId);
        if (!found) throw fail('PERSONAL_ASSISTANT_BOT_NOT_FOUND', '当前助理不存在或已被删除', 404);
        describe = Object.freeze({ id: botId, name: found.displayName, role: 'custom', status: 'idle', model: '' });
      } catch (error) {
        if (error?.code === 'PERSONAL_ASSISTANT_BOT_NOT_FOUND') throw error;
        degraded = true;
        describe = Object.freeze({ id: botId, name: botId, role: 'custom', status: 'offline', model: '' });
      }
    }
    let createdAt = '';
    let capabilities = [];
    try { createdAt = services.registry.createdAt(botId); capabilities = services.registry.capabilities(botId); } catch { /* 目录里的 Bot 没有本机定义 */ }
    const local = await readLocalState(services.stateStore);
    if (!local.available) degraded = true;
    const items = publicMemoryItems(local.memory.filter(row => row?.botId === botId));
    // 云电脑实时状态属于 broker 侧数据，面板 RPC 不代持租约：拿不到时明确返回 null，不编造。
    return {
      bot: describe,
      memory: { count: items.length, items },
      capabilities,
      computer: null,
      createdAt,
      ...(degraded ? { degraded: true } : {}),
    };
  }

  async function createBot(services, payload) {
    const name = String(payload.name ?? '').trim();
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/u.test(name)) throw fail('PERSONAL_ASSISTANT_BOT_INVALID', '助理名称格式错误', 400);
    let botId;
    do { botId = `bot-${randomUUID().replaceAll('-', '').slice(0, 8)}`; } while (services.registry.has(botId));
    const createdAt = new Date().toISOString();
    services.registry.upsert({ botId, displayName: name, systemPromptRevision: `local:${botId}`, role: 'custom', createdAt });
    await persistBotRow(services.stateStore, { botId, displayName: name, createdAt, deleted: false });
    return { bot: { id: botId, name } };
  }

  async function deleteBot(services, payload) {
    const botId = requireBotId(payload.botId);
    const confirmName = String(payload.confirmName ?? '').trim();
    if (!confirmName) throw fail('PERSONAL_ASSISTANT_BOT_CONFIRM_REQUIRED', '删除助理需要输入名称确认', 400);
    let describe;
    try { describe = services.registry.describe(botId); } catch { describe = undefined; }
    if (!describe) throw fail('PERSONAL_ASSISTANT_BOT_NOT_FOUND', '当前助理不存在或已被删除', 404);
    if (confirmName !== describe.name) throw fail('PERSONAL_ASSISTANT_BOT_CONFIRM_MISMATCH', '确认名称与助理名称不一致', 400);
    services.registry.remove(botId);
    services.deletedBots.add(botId);
    await persistBotRow(services.stateStore, { botId, deleted: true, deletedAt: new Date().toISOString() });
    return { deleted: true };
  }

  async function deleteBotMemory(services, payload) {
    const botId = requireBotId(payload.botId);
    const memoryId = String(payload.memoryId ?? '').trim();
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(memoryId)) throw fail('PERSONAL_ASSISTANT_MEMORY_INVALID', '记忆标识无效', 400);
    if (!services.stateStore) return { deleted: false, degraded: true };
    try {
      const removed = await services.stateStore.removeMemory({ botId, memoryId });
      return removed ? { deleted: true } : { deleted: false };
    } catch {
      return { deleted: false, degraded: true };
    }
  }

  async function updateBotModel(services, payload) {
    const botId = requireBotId(payload.botId);
    const model = String(payload.model ?? '').trim();
    if (!model || model.length > 120 || /[\u0000-\u001f\u007f]/u.test(model)) throw fail('PERSONAL_ASSISTANT_MODEL_INVALID', '模型名称无效', 400);
    try { services.registry.setModel(botId, model); }
    catch { throw fail('PERSONAL_ASSISTANT_BOT_NOT_FOUND', '当前助理不存在或已被删除', 404); }
    await persistBotRow(services.stateStore, { botId, model, updatedAt: new Date().toISOString() });
    return { model };
  }

  async function handleLocalOperation(operation, payload, signal) {
    const services = await ensureServices();
    if (operation === 'personal-assistant.local-access.status') return services.localAccess.status();
    if (operation === 'personal-assistant.local-access.grant') return services.localAccess.grant({ scopes: payload.scopes, riskConfirm: payload.riskConfirm });
    if (operation === 'personal-assistant.local-access.revoke') return services.localAccess.revoke();
    if (operation === 'personal-assistant.create.status') return publicCreateStatus();
    if (operation === 'personal-assistant.bots.overview') return publicOverview(services, signal);
    if (operation === 'personal-assistant.bot.detail') return publicBotDetail(services, payload, signal);
    if (operation === 'personal-assistant.bot.create') return createBot(services, payload);
    if (operation === 'personal-assistant.bot.delete') return deleteBot(services, payload);
    if (operation === 'personal-assistant.bot.memory.delete') return deleteBotMemory(services, payload);
    if (operation === 'personal-assistant.bot.model.update') return updateBotModel(services, payload);
    throw fail('PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE', '当前面板不支持此操作', 404);
  }

  // —— 首次创建进度（只观测 Host 能看到的阶段）——
  let createProgress;
  function beginCreateProgress() {
    createProgress = { startedAt: Date.now(), finishedAt: 0, instanceId: '', stage: 'instance', active: true, error: '' };
  }
  function completeCreateProgress(agentId) {
    if (!createProgress) return;
    createProgress.active = false;
    createProgress.stage = 'done';
    createProgress.instanceId = typeof agentId === 'string' && AGENT_ID.test(agentId) ? agentId : '';
    createProgress.finishedAt = Date.now();
  }
  function failCreateProgress(error) {
    if (!createProgress) return;
    createProgress.active = false;
    createProgress.stage = 'failed';
    createProgress.error = String(error?.message ?? '创建失败').slice(0, 200);
    createProgress.finishedAt = Date.now();
  }
  function publicCreateStatus() {
    if (!createProgress) {
      return {
        instanceId: '', stage: 'instance',
        stages: CREATE_STAGES.map(stage => ({ id: stage.id, status: 'pending', detail: '' })),
        elapsedMs: 0, estimatedRemainingMs: 0,
      };
    }
    const elapsedMs = Math.max(0, (createProgress.finishedAt || Date.now()) - createProgress.startedAt);
    let stages;
    if (createProgress.stage === 'done') {
      stages = CREATE_STAGES.map(stage => ({ id: stage.id, status: 'done', detail: stage.detail }));
    } else if (createProgress.stage === 'failed') {
      stages = CREATE_STAGES.map(stage => stage.id === 'instance'
        ? { id: 'instance', status: 'failed', detail: createProgress.error }
        : { id: stage.id, status: 'pending', detail: '' });
    } else {
      stages = CREATE_STAGES.map(stage => stage.id === 'instance'
        ? { id: 'instance', status: 'active', detail: '正在创建云端实例' }
        : { id: stage.id, status: 'pending', detail: '' });
    }
    return {
      instanceId: createProgress.instanceId,
      stage: createProgress.stage,
      stages,
      elapsedMs,
      estimatedRemainingMs: createProgress.active ? Math.max(0, CREATE_ESTIMATED_MS - elapsedMs) : 0,
      ...(createProgress.stage === 'failed' && createProgress.error ? { error: createProgress.error } : {}),
    };
  }

  /** 目录查询（bots.list 与 bots.overview 共用）：只回传 Bot 身份与名称。 */
  async function readBotDirectory(current, signal) {
    const ticket = await request('personal-assistant.desktop.ticket', { agentId: current.agentId, botId: DIRECTORY_BOT_ID, mode: 'read' }, signal);
    if (typeof WebSocketImpl !== 'function') throw fail('PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE', '暂时无法读取助理列表，请重试', 503);
    const querySignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    return new Promise((resolve, reject) => {
      let socket, settled = false, connected = false;
      const finish = (error, rows) => {
        if (settled) return; settled = true;
        querySignal.removeEventListener('abort', abort);
        try { socket?.close(1000, 'directory complete'); } catch {}
        if (error) reject(error); else resolve(rows);
      };
      const abort = () => finish(fail('PERSONAL_ASSISTANT_DIRECTORY_TIMEOUT', '读取助理列表超时，请重试', 504));
      if (querySignal.aborted) return abort();
      querySignal.addEventListener('abort', abort, { once: true });
      try {
        // 内网网关是自签链：`ws` 需要显式并入系统 CA，否则 onerror 表现为目录不可用。
        socket = new WebSocketImpl(ticket.wsUrl, ['agentkit.personal-assistant.desktop.v1', `agentkit.desktop.ticket.${ticket.ticket}`], { ca: trustedCAs() });
      }
      catch { finish(fail('PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE', '暂时无法读取助理列表，请重试', 502)); return; }
      socket.once?.('unexpected-response', (_request, response) => {
        const status = Number(response.statusCode) || 502;
        response.resume?.();
        finish(fail(status >= 500 ? 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE' : 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED', '云端拒绝读取助理列表，请检查连接授权', status >= 400 ? status : 502));
      });
      socket.onopen = () => { connected = true; socket.send(JSON.stringify({ type: 'bots.list' })); };
      // 未完成握手时的不透明错误可能是鉴权拒绝，不能当作普通目录故障回退。
      socket.onerror = () => finish(fail(connected ? 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE' : 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED', '暂时无法读取助理列表，请检查连接授权后重试', 502));
      socket.onclose = event => {
        const closeCode = safeCloseCode(event?.code);
        const error = fail(!connected || closeCode === 1008 ? 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED' : 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE', `助理目录连接已结束${closeCode ? `（关闭码 ${closeCode}）` : ''}，请重试`, closeCode === 1008 ? 403 : 502);
        // reason 由远端提供，可能含票据或内部信息；仅保留数值关闭码。
        if (closeCode) error.closeCode = closeCode;
        finish(error);
      };
      socket.onmessage = event => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 64 * 1024) throw new Error('invalid directory');
          const value = JSON.parse(event.data);
          if (value.type === 'bots') finish(null, { bots: publicBotDirectory(value.bots), ...(Array.isArray(value.features) && value.features.includes('desktop-handoff/v1') ? { features: ['desktop-handoff/v1'] } : {}) });
          else if (value.type === 'error') {
            if (value.code === 'DESKTOP_MESSAGE_UNSUPPORTED') finish(fail('PERSONAL_ASSISTANT_DIRECTORY_UNSUPPORTED', '当前云端版本尚不支持助理列表', 409));
            else {
              const status = Number(value.status) || 400;
              finish(fail(status >= 500 ? 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE' : 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED', '云端拒绝读取助理列表，请检查连接授权', status));
            }
          }
        } catch { finish(fail('PERSONAL_ASSISTANT_DIRECTORY_INVALID', '助理目录格式不兼容，请更新云端助理后重试', 502)); }
      };
    });
  }

  /** 页面 RPC 的统一入口：只负责打点，具体分发在 dispatch()。打点只含操作名与耗时，
   *  请求参数、绑定信息与凭据都不落日志（先测量后优化，别删）。 */
  // session.events 是 ~600ms 一次的轮询，逐条打点会以 1.7 条/秒淹没 Host 日志；
  // 这里只保留慢请求与约 1/20 采样，既有耗时数据又不刷屏。
  let pollTraceTicks = 0;
  async function request(operation, payload = {}, signal) {
    const startedAt = Date.now();
    let bindingMs = 0;
    try {
      return await dispatch(operation, payload, signal, value => { bindingMs = value; });
    } finally {
      try {
        const totalMs = Date.now() - startedAt;
        const poll = operation === 'personal-assistant.session.events';
        if (poll) pollTraceTicks += 1;
        if (!poll || totalMs >= 300 || pollTraceTicks % 20 === 0) {
          console.info(JSON.stringify({ event: 'personal-assistant.rpc', operation, bindingMs, totalMs }));
        }
      } catch { /* 打点绝不能影响请求本身 */ }
    }
  }

  async function dispatch(operation, payload = {}, signal, onBindingMs = () => {}) {
    if (!plain(payload)) throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '请求参数格式错误');
    // 本机控制类 operation 先做授权校验：未授权一律 403，绝不依赖 UI 置灰。
    // 已授权但尚未实现的操作仍按「不支持」处理，避免把未知操作当成已放行能力。
    if (isLocalControlOperation(operation)) {
      const services = await ensureServices();
      services.localAccess.assertAuthorized();
      throw fail('PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE', '当前面板不支持此操作', 404);
    }
    if (!OPERATIONS.has(operation)) throw fail('PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE', '当前面板不支持此操作', 404);
    // 本机剪贴板不依赖云端绑定，先于 binding() 处理：面板刚打开、账号还没绑定时也能用。
    if (operation === 'personal-assistant.clipboard.read') return readHostClipboard({ execFileImpl: clipboardExecFile });
    if (operation === 'personal-assistant.clipboard.write') {
      if (typeof payload.text !== 'string') throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '剪贴板内容格式错误');
      await writeHostClipboard(payload.text, { execFileImpl: clipboardExecFile });
      return { written: true };
    }
    // 面板本机数据同样不依赖云端绑定：绑定或目录不可达时在内部降级（degraded:true）。
    if (LOCAL_OPERATIONS.has(operation)) return handleLocalOperation(operation, payload, signal);
    // 写操作强制向 Host 重新确认绑定；随后立刻清空缓存，让紧接着的读也读到新实例。
    const refreshBinding = BINDING_REFRESH_OPERATIONS.has(operation);
    const bindingStartedAt = Date.now();
    const current = await binding(signal, refreshBinding);
    onBindingMs(Date.now() - bindingStartedAt);
    if (refreshBinding) clearBindingCache();
    const bindingMethod = BINDING_METHODS[operation];
    if (bindingMethod) {
      if (payload.agentId !== undefined && operation !== 'personal-assistant.desktop.create') {
        if (typeof payload.agentId !== 'string' || !AGENT_ID.test(payload.agentId)) throw fail('PERSONAL_ASSISTANT_AGENT_INVALID', '云端实例标识无效');
      }
      const host = current.host;
      if (!host) throw fail('PERSONAL_ASSISTANT_STANDALONE', '独立安装不支持自动发现；请在 Host 配置中连接云端实例', 409);
      if (typeof host[bindingMethod] !== 'function') throw fail('PERSONAL_ASSISTANT_HOST_UNAVAILABLE', '请更新 Host 云连接服务', 503);
      const created = operation === 'personal-assistant.desktop.create';
      const closing = operation === 'personal-assistant.desktop.destroy';
      if (created) beginCreateProgress();
      if (closing) {
        const confirm = payload.confirmAgentId;
        // Closing frees a paid cloud resource: never accept an implicit target.
        if (typeof confirm !== 'string' || !AGENT_ID.test(confirm)) throw fail('PERSONAL_ASSISTANT_AGENT_INVALID', '关闭个人助理需要再次确认实例标识');
      }
      const settingsWrite = operation === 'personal-assistant.settings.update';
      const settingsRead = operation === 'personal-assistant.settings.inspect' || operation === 'personal-assistant.settings.versions';
      const scoped = created ? AbortSignal.timeout(360_000) : closing ? AbortSignal.timeout(120_000)
        : settingsWrite ? AbortSignal.timeout(120_000) : settingsRead ? AbortSignal.timeout(30_000) : AbortSignal.timeout(15_000);
      const deadline = signal ? AbortSignal.any([signal, scoped]) : scoped;
      const input = closing
        ? { agentId: current.agentId, confirmAgentId: String(payload.confirmAgentId) }
        : settingsWrite
          ? { model: payload.model, prompt: payload.prompt, runtimeVersion: payload.runtimeVersion,
              environmentVariables: payload.environmentVariables, deleteKeys: payload.deleteKeys }
          : operation === 'personal-assistant.settings.versions'
            ? { currentVersion: payload.currentVersion }
            : settingsRead ? {}
              : !created && operation !== 'personal-assistant.desktop.status' && operation !== 'personal-assistant.desktop.disconnect' && payload.agentId
                ? { agentId: String(payload.agentId) } : {};
      let value;
      try { value = await host[bindingMethod](input, deadline); }
      catch (error) {
        if (created) failCreateProgress(error);
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        throw fail(error?.code || 'PERSONAL_ASSISTANT_BINDING_FAILED', String(error?.message || '个人助理连接失败').slice(0, 240), status);
      }
      if (created) completeCreateProgress(value?.agentId);
      if (bindingMethod === 'status') return publicBindingStatus(value);
      if (bindingMethod === 'destroy') return { configured: false, mode: 'host', ...(value?.closed === true ? { closed: true } : {}) };
      if (bindingMethod === 'settings') return publicSettings(value);
      if (bindingMethod === 'settingsVersions') return publicSettingsVersions(value);
      if (bindingMethod === 'settingsUpdate') return publicSettingsUpdate(value);
      return publicBinding(value);
    }
    if (operation === 'personal-assistant.configuration') return {
      configured: current.configured, ...(current.configured ? { agentId: current.agentId } : {}),
      ...(base ? { gatewayUrl: base.origin } : {}),
    };
    if (operation === 'personal-assistant.bots.list') {
      if (!current.configured) return { bots: [], directoryAvailable: false };
      return { ...await readBotDirectory(current, signal), directoryAvailable: true };
    }
    if (!current.configured) throw fail('PERSONAL_ASSISTANT_GATEWAY_UNCONFIGURED', '个人助理尚未绑定云端实例', 409);
    if (payload.agentId && payload.agentId !== current.agentId) throw fail('PERSONAL_ASSISTANT_AGENT_MISMATCH', '云端实例与 Host 绑定不一致', 403);
    const botId = String(payload.botId || '').trim();
    if (!botId || botId.length > 64 || /[\u0000-\u001f]/u.test(botId)) throw fail('PERSONAL_ASSISTANT_BOT_REQUIRED', '请选择已创建的助理');
    if (SESSION_OPERATIONS.includes(operation)) {
      if (botId === DIRECTORY_BOT_ID) throw fail('PERSONAL_ASSISTANT_BOT_REQUIRED', '请选择真实云端助理', 403);
      if (!['personal-assistant.sessions.list', 'personal-assistant.session.create'].includes(operation)) requireSessionId(payload.sessionId);
      if (payload.cursor !== undefined && (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0)) throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '增量游标无效');
      return cloudSessions.request({ agentId: current.agentId, botId }, operation, payload, signal);
    }
    if (payload.mode !== undefined && !['read', 'control'].includes(payload.mode)) throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '桌面访问模式无效');
    if (botId === DIRECTORY_BOT_ID && payload.mode !== 'read') throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '目录授权只能用于只读查询', 403);
    if (current.host) {
      const input = { agentId: current.agentId, botId, mode: payload.mode === 'read' ? 'read' : 'control', ...(payload.leaseId ? { leaseId: String(payload.leaseId) } : {}) };
      try { return publicHostTicket(await callHost(current.host, 'issueTicket', input, signal), input); }
      catch (error) { clearBindingCache(); throw error; }
    }
    const response = await fetchImpl(new URL('IssuePersonalAssistantDesktopTicket', base), {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ AgentId: agentId, BotId: botId, Mode: payload.mode === 'read' ? 'read' : 'control', ...(payload.leaseId ? { LeaseId: String(payload.leaseId) } : {}) }),
      signal: signal || AbortSignal.timeout(10_000), redirect: 'error',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.Code !== 0) throw fail('PERSONAL_ASSISTANT_TICKET_REFUSED', `云网关拒绝连接（${response.status}）${result.Message ? `：${String(result.Message).slice(0, 160)}` : ''}`, response.status >= 400 ? response.status : 400);
    const data = result.Data;
    if (!plain(data) || !/^[A-Za-z0-9_-]{32,512}$/u.test(String(data.Ticket || '')) || data.AgentId !== agentId || data.BotId !== botId || data.WsPath !== 'personal-assistant/desktop/ws') throw fail('PERSONAL_ASSISTANT_TICKET_INVALID', '云网关返回的桌面授权格式错误', 502);
    const ws = new URL(data.WsPath, base);
    ws.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return { ticket: data.Ticket, expiresAt: data.ExpiresAt, agentId, botId, wsUrl: ws.href, protocol: 'agentkit.personal-assistant.desktop.v1', leaseId: data.LeaseId || null, readOnly: payload.mode === 'read' };
  }
  return Object.freeze({
    request,
    dispose: () => {
      // 撤销授权时中止所有本机任务；服务尚未初始化时无需清理。
      try {
        if (servicesPromise) void servicesPromise.then(services => services.localAccess?.dispose?.()).catch(() => {});
      } catch { /* 清理失败不影响卸载 */ }
      cloudSessions.dispose();
    },
  });
}

export function registerPersonalAssistantHostGateway(ctx, config = {}, { sessionChannel, channelOptions, getDesktop } = {}) {
  if (!ctx?.connection?.fetch?.register) return undefined;
  // 生产注册路径开启短 TTL 绑定缓存：一次面板打开会以 5 次串行 configuration 起手，
  // 2s 缓存把它们收敛成 1 次。直接构造 gateway（含单测）默认不缓存，保持逐次确认语义。
  const gateway = createPersonalAssistantHostGateway(config, { getHostDesktop: getDesktop || (() => ctx.get?.(PERSONAL_ASSISTANT_DESKTOP_SERVICE)), bindingCacheMs: 2000 });
  // Connection 的 /api 物理载体先执行 Host/Origin、浏览器鉴权及 owner Peer 校验。
  // 使用公开 exact Fetch 注册表，避免自建服务、抢占 Gateway interceptor 或修改 remotes。
  const unregister = ctx.connection.fetch.register({ path: ENDPOINT, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    let rpcId = 'invalid-request';
    const respond = result => Response.json({ type: 'server-response', rpcId, result }, { headers: { 'cache-control': 'no-store' } });
    try {
      if (request.method !== 'POST') throw fail('PERSONAL_ASSISTANT_METHOD_INVALID', '仅支持 POST 请求', 405);
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail('PERSONAL_ASSISTANT_CONTENT_TYPE_INVALID', '请求必须使用 JSON', 415);
      if (Number(request.headers.get('content-length')) > 768 * 1024) throw fail('PERSONAL_ASSISTANT_REQUEST_TOO_LARGE', '请求过大', 413);
      const text = await request.text(); request.signal.throwIfAborted();
      if (Buffer.byteLength(text) > 768 * 1024) throw fail('PERSONAL_ASSISTANT_REQUEST_TOO_LARGE', '请求过大', 413);
      let body; try { body = JSON.parse(text); } catch { if (Buffer.byteLength(text) > 16_384) throw fail('PERSONAL_ASSISTANT_REQUEST_TOO_LARGE', '请求过大', 413); throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '请求 JSON 格式错误'); }
      if (body?.payload?.operation !== 'personal-assistant.file.upload' && Buffer.byteLength(text) > 16_384) throw fail('PERSONAL_ASSISTANT_REQUEST_TOO_LARGE', '请求过大', 413);
      if (!plain(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(body.rpcId) || body.method !== 'personal-assistant' || !plain(body.payload)) throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '请求格式错误');
      rpcId = body.rpcId;
      // local-control.* 不进入白名单，但要交给网关做授权校验：未授权必须是 403，
      // 而不是在 Connection 层就变成 404。已授权但未实现的仍返回 404。
      if (!OPERATIONS.has(body.payload.operation) && !isLocalControlOperation(body.payload.operation)) throw fail('PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE', '当前面板不支持此操作', 404);
      return respond({ ok: true, value: await gateway.request(body.payload.operation, body.payload.payload ?? {}, request.signal) });
    } catch (error) {
      return respond({ ok: false, error: { code: error.code || 'PERSONAL_ASSISTANT_GATEWAY_FAILED', message: error.message || '云电脑连接失败', details: { status: error.status || 500, ...(safeCloseCode(error.closeCode) ? { closeCode: error.closeCode } : {}) } } });
    }
  } });
  return () => { unregister?.(); gateway.dispose(); };
}
