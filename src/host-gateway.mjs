/** 通过 DSH 已鉴权 Connection RPC 转接到固定云网关；凭据始终留在 Host。 */
const ENDPOINT = '/api/personal-assistant';
const OPERATIONS = new Set(['personal-assistant.configuration', 'personal-assistant.bots.list', 'personal-assistant.desktop.ticket']);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export function createPersonalAssistantHostGateway(config = {}, { env = process.env, fetchImpl = fetch } = {}) {
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
  async function request(operation, payload = {}, signal) {
    if (!plain(payload)) throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '请求参数格式错误');
    if (operation === 'personal-assistant.configuration') return {
      configured, agentId, gatewayUrl: base?.href || '',
      botDirectoryAvailable: false,
      note: configured ? '云端尚未提供 Bot 目录，请填写已创建的 Bot ID' : '请先在插件 Host 配置云网关地址、真实 Agent ID 与 API Key',
    };
    if (operation === 'personal-assistant.bots.list') return { bots: [], directoryAvailable: false, note: '云端尚未提供 Bot 目录，请填写已创建的 Bot ID' };
    if (operation !== 'personal-assistant.desktop.ticket') throw fail('PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE', '当前面板不支持此操作', 404);
    if (!configured) throw fail('PERSONAL_ASSISTANT_GATEWAY_UNCONFIGURED', '请先配置云网关连接', 409);
    if (payload.agentId && payload.agentId !== agentId) throw fail('PERSONAL_ASSISTANT_AGENT_MISMATCH', 'Agent ID 与 Host 配置不一致', 403);
    const botId = String(payload.botId || '').trim();
    if (!botId || botId.length > 64) throw fail('PERSONAL_ASSISTANT_BOT_REQUIRED', '请输入已创建的 Bot ID');
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
  return Object.freeze({ request });
}

export function registerPersonalAssistantHostGateway(ctx, config = {}) {
  if (!ctx?.connection?.fetch?.register) return undefined;
  const gateway = createPersonalAssistantHostGateway(config);
  // Connection 的 /api 物理载体先执行 Host/Origin、浏览器鉴权及 owner Peer 校验。
  // 使用公开 exact Fetch 注册表，避免自建服务、抢占 Gateway interceptor 或修改 remotes。
  return ctx.connection.fetch.register({ path: ENDPOINT, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    let rpcId = 'invalid-request';
    const respond = result => Response.json({ type: 'server-response', rpcId, result }, { headers: { 'cache-control': 'no-store' } });
    try {
      if (request.method !== 'POST') throw fail('PERSONAL_ASSISTANT_METHOD_INVALID', '仅支持 POST 请求', 405);
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail('PERSONAL_ASSISTANT_CONTENT_TYPE_INVALID', '请求必须使用 JSON', 415);
      if (Number(request.headers.get('content-length')) > 16_384) throw fail('PERSONAL_ASSISTANT_REQUEST_TOO_LARGE', '请求过大', 413);
      const text = await request.text(); request.signal.throwIfAborted();
      if (Buffer.byteLength(text) > 16_384) throw fail('PERSONAL_ASSISTANT_REQUEST_TOO_LARGE', '请求过大', 413);
      let body; try { body = JSON.parse(text); } catch { throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '请求 JSON 格式错误'); }
      if (!plain(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(body.rpcId) || body.method !== 'personal-assistant' || !plain(body.payload)) throw fail('PERSONAL_ASSISTANT_REQUEST_INVALID', '请求格式错误');
      rpcId = body.rpcId;
      if (!OPERATIONS.has(body.payload.operation)) throw fail('PERSONAL_ASSISTANT_OPERATION_UNAVAILABLE', '当前面板不支持此操作', 404);
      return respond({ ok: true, value: await gateway.request(body.payload.operation, body.payload.payload ?? {}, request.signal) });
    } catch (error) {
      return respond({ ok: false, error: { code: error.code || 'PERSONAL_ASSISTANT_GATEWAY_FAILED', message: error.message || '云电脑连接失败', details: { status: error.status || 500 } } });
    }
  } });
}
