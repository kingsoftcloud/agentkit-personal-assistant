/** Cloud Agent tools; the Host owns directory enforcement and actual I/O. */
export function registerLocalDeviceTools({ agent, botId, service }) {
  const tools = agent.ctx.get('tools');
  const output = { schema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value.result }] };
  const execute = async args => {
    const current = service();
    if (!current) throw new Error('本机连接服务尚未就绪');
    return { result: JSON.stringify(await current.execute(botId, args)) };
  };
  const keys = { deviceId: { type: 'string' }, rootId: { type: 'string' }, path: { type: 'string' } };
  tools.register({
    name: 'assistant_local_read',
    description: 'Read a user-authorized local folder. Call devices in this turn to get live device IDs, root IDs and whether each root is writable. Do not reuse historic IDs. file.list and file.read use a relative path; file.read returns UTF-8 text and its sha256. These are the local files, not cloud files.',
    parameters: { type: 'object', required: ['action'], additionalProperties: false, properties: {
      action: { type: 'string', enum: ['devices', 'file.list', 'file.read'] }, ...keys,
    } },
    output, execute,
  });
  tools.register({
    name: 'assistant_local_write',
    description: 'Create or replace a UTF-8 text file up to 64 KiB inside a folder explicitly marked writable on an online local device. Use assistant_local_read devices to get the current device ID and a writable root ID. For updates, read the file first and pass its sha256 as expectedSha256. Omit it only to create a new file. If a write result is unconfirmed, read the file to check before trying again. Cannot delete files, run commands, or operate windows.',
    parameters: { type: 'object', required: ['deviceId', 'rootId', 'path', 'text'], additionalProperties: false, properties: {
      ...keys, text: { type: 'string' }, expectedSha256: { type: 'string', description: 'The sha256 from reading the current file. Omit only if the file must not exist.' },
    } },
    output, execute: args => execute({ ...args, action: 'file.write' }),
  });
}
