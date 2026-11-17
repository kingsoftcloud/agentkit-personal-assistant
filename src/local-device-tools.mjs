/** Cloud Agent tool; the Host owns directory enforcement and actual reads. */
export function registerLocalDeviceTools({ agent, botId, service }) {
  agent.ctx.get('tools').register({
    name: 'assistant_local_read',
    description: 'Read the user-authorized local computer. Call devices first for online devices and root IDs; then file.list or file.read with a relative path. Reads run on that computer, not the cloud filesystem. Requires the user to grant a directory in Personal Assistant. No writes, commands or window control.',
    parameters: { type: 'object', required: ['action'], additionalProperties: false, properties: {
      action: { type: 'string', enum: ['devices', 'file.list', 'file.read'] }, deviceId: { type: 'string' }, rootId: { type: 'string' }, path: { type: 'string' },
    } },
    output: { schema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value.result }] },
    async execute(args) {
      const current = service();
      if (!current) throw new Error('本机连接服务尚未就绪');
      return { result: JSON.stringify(await current.execute(botId, args)) };
    },
  });
}
