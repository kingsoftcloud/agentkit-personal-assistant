/** 仅传输目录展示字段；系统提示词、工具策略与凭据不进入浏览器。 */
export const DIRECTORY_BOT_ID = '__directory__';
export function publicBotDirectory(rows) {
  if (!Array.isArray(rows) || rows.length > 128) throw new TypeError('助理目录格式无效');
  const seen = new Set();
  return rows.map(row => {
    const botId = String(row?.botId || '').trim();
    const displayName = String(row?.displayName || botId).trim();
    if (!botId || botId.length > 64 || /[\u0000-\u001f]/u.test(botId) || botId === DIRECTORY_BOT_ID || seen.has(botId) || !displayName || displayName.length > 256) throw new TypeError('助理目录格式无效');
    seen.add(botId);
    return { botId, displayName: botId === 'default' && displayName === 'Personal Assistant' ? '默认助理' : botId === 'researcher' && displayName === 'Researcher' ? '研究助理' : displayName };
  });
}

/** 系统确定唯一绑定；不把内部逻辑 Bot 变成用户必须选择的产品分类。 */
export function resolveAssistantBotId(rows, boundBotId = '') {
  const bots = publicBotDirectory(rows);
  const bound = String(boundBotId || '').trim();
  const selected = bound ? bots.find(bot => bot.botId === bound)
    : bots.find(bot => bot.botId === 'default') || (bots.length === 1 ? bots[0] : undefined);
  if (!selected) throw Object.assign(new Error('云端助理绑定尚未就绪，请稍后重试'), { code: 'PERSONAL_ASSISTANT_BINDING_UNAVAILABLE' });
  return selected.botId;
}
