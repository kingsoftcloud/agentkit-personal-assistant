import { CLOUD_BROWSER_TOOL_NAMES, CLOUD_EXECUTION_TOOL_NAMES } from './cloud-computer-tools.mjs';

const allowed = new Set([...CLOUD_BROWSER_TOOL_NAMES, ...CLOUD_EXECUTION_TOOL_NAMES, 'bot_memory_search', 'bot_memory_save', 'bot_plan_update']);

/** PA 的唯一工具边界：继承层过滤 + own-layer 服务端守卫 + scoped 模型呈现过滤。 */
export function restrictPersonalAssistantToolScope(agent, botId) {
  const tools = agent?.ctx?.get?.('tools');
  if (typeof tools?.restrict !== 'function' || typeof tools?.guard !== 'function' || typeof agent.ctx.on !== 'function') {
    throw Object.assign(new Error('Personal Assistant requires scoped tool restrictions and guards'), { code: 'PERSONAL_ASSISTANT_TOOL_SCOPE_UNAVAILABLE', status: 503 });
  }
  tools.restrict({ allow: [] });
  tools.guard(execution => {
    if (allowed.has(execution.name)) return undefined;
    console.warn(JSON.stringify({ event: 'personal-assistant.tool.denied', botId, tool: execution.name }));
    return 'PERSONAL_ASSISTANT_HOST_TOOL_FORBIDDEN';
  });
  agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next();
    return { ...result, tools: result.tools.filter(tool => allowed.has(tool.name)) };
  });
}
