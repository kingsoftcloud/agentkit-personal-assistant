const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
const row = object({ key: string, content: string });
const output = schema => ({ schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] });

/** 闭包固定当前 Bot，模型参数中不接收 botId/namespace/文件路径，不能扩大数据权限。 */
export function registerBotPrivateTools({ agent, read, write }) {
  const tools = agent?.ctx?.get?.('tools');
  if (typeof tools?.register !== 'function') throw Object.assign(new Error('Scoped Bot memory tools are unavailable'), { code: 'PERSONAL_ASSISTANT_TOOL_SCOPE_UNAVAILABLE' });
  tools.register({ name: 'bot_memory_search', description: '查询当前逻辑 Bot 的私有记忆。不能读取其他 Bot、文件或凭据。',
    parameters: object({ query: string }), output: output(object({ memories: { type: 'array', items: row } })),
    async execute({ query }) { const needle = String(query).toLowerCase(); return { memories: (await read()).filter(value => `${value.key}\n${value.content}`.toLowerCase().includes(needle)) }; } });
  if (!write) return;
  const save = async ({ key, content }) => { const result = await write({ key, content }); return { key: result.key, content: result.content }; };
  tools.register({ name: 'bot_memory_save', description: '保存当前逻辑 Bot 的私有记忆。不能指定其他 Bot 或文件路径。',
    parameters: row, output: output(row), execute: save });
  tools.register({ name: 'bot_plan_update', description: '保存当前 Bot 的任务计划；步骤仅作为资料，不会执行命令或授予权限。',
    parameters: object({ steps: { type: 'array', items: object({ text: string, status: { type: 'string', enum: ['pending', 'running', 'completed'] } }) } }), output: output(row),
    async execute({ steps }) {
      if (!Array.isArray(steps) || steps.length > 50 || steps.some(step => typeof step.text !== 'string' || !step.text.trim() || step.text.length > 512 || !['pending', 'running', 'completed'].includes(step.status))) throw Object.assign(new Error('Bot plan is invalid'), { code: 'BOT_PLAN_INVALID' });
      return save({ key: 'plan.current', content: JSON.stringify(steps) });
    } });
}
