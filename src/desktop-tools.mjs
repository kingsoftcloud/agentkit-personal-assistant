// 模型只通过 Broker 操作与用户看到的同一桌面；没有本机 shell 或第二个浏览器。
const actions = ['screenshot', 'click', 'double_click', 'right_click', 'type', 'key', 'scroll', 'drag', 'windows', 'focus', 'launch'];
const field = (value, name, max = 16384) => {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > max) throw new TypeError(`${name} is invalid`);
  return value;
};
const point = (args, x = 'x', y = 'y') => {
  if (!Number.isInteger(args[x]) || args[x] < 0 || args[x] >= 1280 || !Number.isInteger(args[y]) || args[y] < 0 || args[y] >= 800) throw new TypeError('coordinates must be desktop pixels within 1280x800');
  return { x: args[x], y: args[y] };
};
export function createDesktopTool({ action, agent } = {}) {
  return {
    name: 'cloud_computer',
    description: 'Operate the entire shared cloud desktop, including browser, terminal and file manager. Use windows/launch/focus or screenshot to inspect, then click/type/key/scroll/drag. Coordinates are 1280x800 desktop pixels. Human takeover pauses new actions until control is returned. Screenshot requires an image-capable cloud model; never pretend to see an image when unavailable.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: actions }, x: { type: 'integer' }, y: { type: 'integer' }, toX: { type: 'integer' }, toY: { type: 'integer' },
      text: { type: 'string' }, key: { type: 'string' }, deltaY: { type: 'integer', minimum: -20, maximum: 20 },
      windowId: { type: 'string' }, application: { type: 'string', enum: ['browser', 'terminal', 'files'] },
    } },
    output: { schema: { type: 'object', required: ['result'], properties: {
      result: { type: 'string' }, image: { type: 'object', required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], properties: {
        attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, name: { type: 'string' },
      } },
    } }, render: (_args, value) => [{ type: 'text', text: value.result }, ...(value.image ? [{ type: 'image', attachment: value.image }] : [])] },
    async execute(args, execution = {}) {
      if (!actions.includes(args.action)) throw new TypeError('unsupported desktop action');
      const send = event => action('desktop.input', { event }, execution);
      if (args.action === 'screenshot') {
        const attachments = agent?.ctx?.get?.('attachments'), llm = agent?.ctx?.get?.('llm');
        const route = execution.agent?.session?.requestHeader?.()?.config;
        const info = await llm?.resolveModelInfo(route?.provider ?? agent?.options?.provider, route?.model ?? agent?.options?.model, execution.signal);
        if (!info?.inputModalities?.includes('image')) throw new Error('当前云端模型不支持图片输入，请使用 windows、页面 snapshot 或切换视觉模型；此回合没有取得或看见截图。');
        if (!attachments?.saveImage) throw new Error('云端图片附件服务尚未就绪');
        const { image } = await action('desktop.capture', {}, execution);
        const data = Buffer.from(image.data, 'base64');
        if (data.length > 307200 || data.length !== image.bytes || image.mediaType !== 'image/jpeg') throw new Error('invalid desktop image');
        const ref = await attachments.saveImage({ data, mediaType: image.mediaType, name: 'cloud-desktop.jpg' });
        return { result: `共享云桌面：${image.width}x${image.height}，坐标与截图一致。`, image: ref };
      }
      let result;
      if (args.action === 'windows') result = await action('desktop.windows', {}, execution);
      else if (args.action === 'focus') result = await action('desktop.focus', { windowId: field(args.windowId, 'windowId', 32) }, execution);
      else if (args.action === 'launch') {
        if (!['browser', 'terminal', 'files'].includes(args.application)) throw new TypeError('unsupported application');
        result = await action('desktop.launch', { application: args.application }, execution);
      } else if (args.action === 'type') result = await send({ type: 'text', text: field(args.text, 'text') });
      else if (args.action === 'key') result = await send({ type: 'key', key: field(args.key, 'key', 64), action: 'tap' });
      else if (args.action === 'scroll') {
        if (!Number.isInteger(args.deltaY) || args.deltaY < -20 || args.deltaY > 20) throw new TypeError('invalid scroll delta');
        await send({ type: 'pointermove', ...point(args) }); result = await send({ type: 'wheel', deltaY: args.deltaY });
      } else {
        const start = point(args);
        await send({ type: 'pointermove', ...start });
        if (args.action === 'drag') {
          const end = point(args, 'toX', 'toY');
          await send({ type: 'button', button: 1, action: 'down', ...start });
          // 接管时 Broker 会关闭旧会话并释放按键；最后一条 up 也必须通过当前租约。
          try { result = await send({ type: 'pointermove', ...end }); }
          finally { await send({ type: 'button', button: 1, action: 'up' }); }
        } else if (args.action === 'double_click') result = await send({ type: 'button', button: 1, action: 'double', ...start });
        else {
          const button = args.action === 'right_click' ? 3 : 1;
          await send({ type: 'button', button, action: 'down', ...start });
          result = await send({ type: 'button', button, action: 'up' });
        }
      }
      return { result: JSON.stringify(result) };
    },
  };
}
