/** 通过 DSH 已鉴权 Connection RPC 转接到固定云网关；凭据始终留在 Host。 */
import { createRequire } from 'node:module';
import { DIRECTORY_BOT_ID, publicBotDirectory } from './client/bot-directory.mjs';
import { createCloudSessionTransport } from './cloud-session-transport.mjs';
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
const OPERATIONS = new Set(['personal-assistant.configuration', 'personal-assistant.bots.list', 'personal-assistant.desktop.ticket', ...SESSION_OPERATIONS]);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const safeCloseCode = value => Number.isInteger(value) && value >= 1000 && value <= 4999 ? value : undefined;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const requireSessionId = value => {
  const text = String(value ?? '').trim();
  if (!SESSION_ID.test(text)) throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '会话标识无效');
  return text;
};
import { createSystemFetch, trustedCAs } from './system-fetch.mjs';

export const STUDIO_DESKTOP_SERVICE = 'studioPersonalAssistantDesktop';

// 默认走系统信任链：内网/预发网关的证书不在 Node 内置 CA 里，直接 fetch 会 "fetch failed"。
const defaultFetchImpl = createSystemFetch();
export function createPersonalAssistantHostGateway(config = {}, { env = process.env, fetchImpl = defaultFetchImpl, WebSocketImpl = DEFAULT_WEBSOCKET, getStudioDesktop = () => undefined, sessionChannel, cloudSessionTransport } = {}) {
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
  let studioSeen = false;
  // 服务可晚于本插件加载，也可随 Studio 卸载；不缓存凭据或实例绑定。
  async function callStudio(service, method, input, signal) {
    try { return await service[method](input, signal || AbortSignal.timeout(10_000)); }
    catch (error) {
      const rawStatus = Number(error?.status ?? error?.details?.status);
      const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 503;
      // 原始异常可能包含上游 HTTP 头或凭据，不能进入页面 RPC。
      throw fail(status >= 500 ? 'PERSONAL_ASSISTANT_STUDIO_UNAVAILABLE' : 'PERSONAL_ASSISTANT_TICKET_REFUSED', 'Studio 暂时无法授权云电脑连接，请检查实例状态与云端登录', status);
    }
  }
  async function binding(signal) {
    let studio;
    try { studio = getStudioDesktop(); }
    catch { throw fail('PERSONAL_ASSISTANT_STUDIO_UNAVAILABLE', 'Studio 云连接服务暂时不可用', 503); }
    if (studio != null) {
      studioSeen = true;
      if (typeof studio.configuration !== 'function' || typeof studio.issueTicket !== 'function') throw fail('PERSONAL_ASSISTANT_STUDIO_UNAVAILABLE', '请更新 Studio 云连接服务', 503);
      const value = await callStudio(studio, 'configuration', agentId ? { agentId } : {}, signal);
      if (!plain(value) || typeof value.configured !== 'boolean' || (value.configured && (typeof value.agentId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/u.test(value.agentId)))) throw fail('PERSONAL_ASSISTANT_STUDIO_UNAVAILABLE', 'Studio 返回的实例绑定无效', 502);
      return { configured: value.configured, agentId: value.configured ? value.agentId : undefined, studio };
    }
    if (studioSeen) throw fail('PERSONAL_ASSISTANT_STUDIO_UNAVAILABLE', 'Studio 云连接服务已卸载，请重新打开 Studio', 503);
    // 独立开发 Host 的显式连接仍可用；Studio 拒绝/卸载时绝不降级到此分支。
    return { configured, agentId, studio: undefined };
  }
  function publicStudioTicket(value, input) {
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
      || (value.leaseId != null && (typeof value.leaseId !== 'string' || value.leaseId.length > 256))) throw fail('PERSONAL_ASSISTANT_TICKET_INVALID', 'Studio 返回的桌面授权格式错误', 502);
    return { ticket: value.ticket, expiresAt: value.expiresAt, agentId: input.agentId, botId: input.botId,
      wsUrl: ws.href, protocol: value.protocol, leaseId: value.leaseId ?? null, readOnly: input.mode === 'read' };
  }
  const cloudSessions = cloudSessionTransport ?? createCloudSessionTransport({
    issueTicket: (scope, signal) => request('personal-assistant.desktop.ticket', scope, signal),
    WebSocketImpl, ca: trustedCAs(),
  });
  async function request(operation, payload = {}, signal) {
    if (!plain(payload)) throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '请求参数格式错误');
    if (!OPERATIONS.has(operation)) throw fail('PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE', '当前面板不支持此操作', 404);
    const current = await binding(signal);
    if (operation === 'personal-assistant.configuration') return {
      configured: current.configured, ...(current.configured ? { agentId: current.agentId } : {}),
      ...(base ? { gatewayUrl: base.origin } : {}),
    };
    if (operation === 'personal-assistant.bots.list') {
      if (!current.configured) return { bots: [], directoryAvailable: false };
      const ticket = await request('personal-assistant.desktop.ticket', { agentId: current.agentId, botId: DIRECTORY_BOT_ID, mode: 'read' }, signal);
      if (typeof WebSocketImpl !== 'function') throw fail('PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE', '暂时无法读取助理列表，请重试', 503);
      const querySignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const directory = await new Promise((resolve, reject) => {
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
      return { ...directory, directoryAvailable: true };
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
    if (current.studio) {
      const input = { agentId: current.agentId, botId, mode: payload.mode === 'read' ? 'read' : 'control', ...(payload.leaseId ? { leaseId: String(payload.leaseId) } : {}) };
      return publicStudioTicket(await callStudio(current.studio, 'issueTicket', input, signal), input);
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
  return Object.freeze({ request, dispose: () => cloudSessions.dispose() });
}

export function registerPersonalAssistantHostGateway(ctx, config = {}, { sessionChannel, channelOptions } = {}) {
  if (!ctx?.connection?.fetch?.register) return undefined;
  const gateway = createPersonalAssistantHostGateway(config, { getStudioDesktop: () => ctx.get?.(STUDIO_DESKTOP_SERVICE) });
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
      if (!OPERATIONS.has(body.payload.operation)) throw fail('PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE', '当前面板不支持此操作', 404);
      return respond({ ok: true, value: await gateway.request(body.payload.operation, body.payload.payload ?? {}, request.signal) });
    } catch (error) {
      return respond({ ok: false, error: { code: error.code || 'PERSONAL_ASSISTANT_GATEWAY_FAILED', message: error.message || '云电脑连接失败', details: { status: error.status || 500, ...(safeCloseCode(error.closeCode) ? { closeCode: error.closeCode } : {}) } } });
    }
  } });
  return () => { unregister?.(); gateway.dispose(); };
}
