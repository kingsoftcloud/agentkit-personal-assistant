/** 闭包固定 Bot；任务由云端持久调度器执行，关闭 Studio 不影响触发。 */
export function registerAutomationTools({ agent, botId, service }) {
  agent.ctx.get('tools').register({
    name: 'assistant_schedule',
    description: 'Create/list/cancel a persistent one-off cloud task. Convert the user time using their timezone; runAt must include a timezone offset. The cloud DSH executes input even after Studio closes. Never create a task without the user asking for it.',
    parameters: { type: 'object', required: ['action'], additionalProperties: false, properties: {
      action: { type: 'string', enum: ['create', 'list', 'cancel'] }, scheduleId: { type: 'string' }, runAt: { type: 'string' }, input: { type: 'string' },
    } },
    output: { schema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value.result }] },
    async execute(args) {
      const current = service();
      if (!current) throw new Error('云端调度服务尚未就绪');
      if (!['create', 'list', 'cancel'].includes(args.action)) throw new TypeError('unsupported schedule action');
      if (args.action === 'create' && (typeof args.runAt !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/u.test(args.runAt))) throw new TypeError('runAt must contain a timezone');
      return { result: JSON.stringify(await current({ ...args, botId, runAt: args.action === 'create' ? Date.parse(args.runAt) : undefined })) };
    },
  });
}
