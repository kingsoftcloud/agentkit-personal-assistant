/** 云端持久会话适配层。只由签名 control permit 授权，永不调用本机 Host。 */
export function createCloudSessionChannel({ assistantId, computerId, stateStore, registry, sessionCreate, turnWrite, scheduleWrite }) {
  const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
  const session = async (botId, sessionId) => {
    if (!(await stateStore.sessions(botId)).some(row => row.sessionId === sessionId)) throw fail('SESSION_NOT_FOUND', '当前助理不存在这个会话', 404);
    return sessionId;
  };
  const messages = rows => rows.map((row, seq) => ({ type: 'message', id: row.messageId, messageId: row.messageId, seq, role: row.role, text: row.content, done: true, turnId: row.metadata?.turnId, clientTurnId: row.metadata?.clientTurnId }));
  return async ({ agentId, botId, operation, payload = {} }) => {
    if (agentId !== assistantId) throw fail('PERSONAL_ASSISTANT_AGENT_MISMATCH', '云端实例身份不一致', 403);
    try { registry.require(botId); } catch { throw fail('BOT_NOT_FOUND', '云端不存在该助理', 404); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('CLOUD_SESSION_REQUEST_INVALID', '会话请求格式错误');
    const scope = { agentId: assistantId, botId, computerId, executionTarget: 'cloud' };
    if (operation === 'personal-assistant.sessions.list') return { ...scope, sessions: (await stateStore.sessions(botId)).map(row => ({ sessionId: row.sessionId, title: row.title, updatedAt: Date.parse(row.updatedAt) || 0 })).sort((a, b) => b.updatedAt - a.updatedAt) };
    if (operation === 'personal-assistant.session.create') return { ...scope, ...await sessionCreate({ botId, title: String(payload.title || '').slice(0, 200) }) };
    await session(botId, payload.sessionId);
    if (operation === 'personal-assistant.turn.submit') {
      if (payload.attachments?.length) throw fail('CLOUD_ATTACHMENT_UNSUPPORTED', '当前云端会话暂不支持附件，请先发送文字');
      const text = String(payload.text || '').trim();
      if (!text || Buffer.byteLength(text) > 32 * 1024) throw fail('DSH_TURN_INPUT_INVALID', '请输入不超过 32 KiB 的消息');
      if (!/^[A-Za-z0-9_-]{1,80}$/u.test(String(payload.clientTurnId || ''))) throw fail('CLIENT_TURN_ID_REQUIRED', '发送标识无效');
      return { ...scope, ...await turnWrite({ botId, input: text, metadata: { clientTurnId: payload.clientTurnId } }, payload.sessionId) };
    }
    if (operation === 'personal-assistant.schedule.create') return { ...scope, ...await scheduleWrite({ ...payload, botId }) };
    if (!['personal-assistant.session.snapshot', 'personal-assistant.session.events'].includes(operation)) throw fail('CLOUD_SESSION_OPERATION_UNSUPPORTED', '云端会话操作不支持', 404);
    const rows = await stateStore.messages({ botId, sessionId: payload.sessionId });
    const turns = (await stateStore.turns(botId, payload.sessionId)).slice(-20).map(({ turnId, status, error, metadata }) => ({ turnId, status, error, clientTurnId: metadata?.clientTurnId }));
    if (operation === 'personal-assistant.session.snapshot') {
      const tail = []; let bytes = 0;
      for (const item of messages(rows).reverse().slice(0, 200)) { const size = Buffer.byteLength(JSON.stringify(item)); if (bytes + size > 256 * 1024) break; bytes += size; tail.unshift(item); }
      return { ...scope, sessionId: payload.sessionId, epoch: payload.sessionId, messages: tail, cursor: rows.length, turns };
    }
    const cursor = payload.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw fail('DSH_CURSOR_INVALID', '会话游标无效');
    if (cursor > rows.length || (payload.epoch && payload.epoch !== payload.sessionId)) throw fail('SESSION_CURSOR_STALE', '会话日志已更新，请重新同步', 409);
    const page = messages(rows).slice(cursor, cursor + 100);
    let bytes = 0; const bounded = [];
    for (const item of page) { const size = Buffer.byteLength(JSON.stringify(item)); if (bytes + size > 256 * 1024) break; bytes += size; bounded.push(item); }
    return { ...scope, sessionId: payload.sessionId, epoch: payload.sessionId, events: bounded, cursor: cursor + bounded.length, done: cursor + bounded.length >= rows.length, turns };
  };
}
