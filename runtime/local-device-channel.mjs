import { randomUUID, createHash } from 'node:crypto';
import { LOCAL_FILE_ACTIONS, validateLocalWrite } from '../src/local-file-contract.mjs';
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(value);

/** Authenticated Bot channel, one online lease per physical Host and grant. */
export function createLocalDeviceService({ stateStore, now = Date.now, pollMs = 20_000, leaseMs = 45_000, timeoutMs = 30_000 }) {
  const devices = new Map(), pending = new Map();
  const keyOf = (botId, deviceId) => `${botId}:${deviceId}`;
  const save = row => stateStore.mutate('local-operations', rows => {
    const previous = rows.find(item => item.requestId === row.requestId);
    if (previous) Object.assign(previous, row); else rows.push(row);
    while (rows.length > 1000) {
      const index = rows.findIndex(item => !['queued', 'running'].includes(item.status));
      if (index < 0) break;
      rows.splice(index, 1);
    }
  });
  const ready = stateStore.mutate('local-operations', rows => {
    for (const row of rows) if (['queued', 'running'].includes(row.status)) Object.assign(row, { status: 'interrupted', finishedAt: now() });
  });
  const publicDevice = device => ({ deviceId: device.deviceId, name: device.name, roots: device.roots, scopes: device.scopes, connected: device.expiresAt > now() });
  const list = botId => [...devices.values()].filter(device => device.botId === botId && device.expiresAt > now()).map(publicDevice);
  function current(botId, input) {
    const device = devices.get(keyOf(botId, input.deviceId));
    if (!device || device.expiresAt <= now() || device.grantId !== input.grantId || device.connectionId !== input.connectionId) throw fail('LOCAL_DEVICE_OFFLINE', '本机连接或授权已失效');
    return device;
  }
  async function settle(job, error, value) {
    if (!pending.delete(job.command.requestId)) return;
    clearTimeout(job.timer);
    try {
      await save({ requestId: job.command.requestId, status: error ? 'failed' : 'completed', finishedAt: now(),
        ...(error ? { error: error.code || 'LOCAL_READ_FAILED' } : { resultSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') }) });
      error ? job.reject(error) : job.resolve(value);
    } catch (storageError) { job.reject(storageError); }
  }
  function revoke(device) {
    devices.delete(keyOf(device.botId, device.deviceId));
    device.wake?.();
    for (const job of pending.values()) if (job.device === device) void settle(job, job.delivered && job.command.action === 'file.write'
      ? fail('LOCAL_WRITE_UNCONFIRMED', '授权已撤销；重新授权后可读取文件核对这次写入结果', 409)
      : fail('LOCAL_GRANT_REVOKED', '本机授权已撤销', 403));
  }
  async function handle(botId, operation, input) {
    await ready;
    if (operation === 'capabilities') return { fileWrite: true };
    if (operation === 'list') return { devices: list(botId) };
    if (!validId(input.deviceId) || !validId(input.grantId)) throw fail('LOCAL_DEVICE_INVALID', '设备或授权标识无效', 400);
    if (operation === 'revoke') {
      const device = devices.get(keyOf(botId, input.deviceId));
      if (device?.grantId === input.grantId) revoke(device);
      return { revoked: true };
    }
    if (!validId(input.connectionId)) throw fail('LOCAL_DEVICE_INVALID', '连接标识无效', 400);
    if (operation === 'register') {
      if (input.scopes?.length !== 1 || input.scopes[0] !== 'file.read' || !Array.isArray(input.roots) || !input.roots.length || input.roots.length > 8
        || input.roots.some(root => !validId(root.id) || typeof root.name !== 'string' || root.name.length > 255)) throw fail('LOCAL_GRANT_INVALID', '本机授权范围无效', 400);
      const key = keyOf(botId, input.deviceId), previous = devices.get(key);
      if (previous && previous.expiresAt > now() && previous.connectionId !== input.connectionId) throw fail('LOCAL_DEVICE_BUSY', '此设备已有在线连接');
      if (previous) revoke(previous);
      devices.set(key, { botId, deviceId: input.deviceId, grantId: input.grantId, connectionId: input.connectionId,
        name: String(input.name || '本机').slice(0, 128), roots: input.roots.map(({ id, name, writable }) => ({ id, name, writable: writable === true })),
        scopes: input.roots.some(root => root.writable === true) ? ['file.read', 'file.write'] : ['file.read'], queue: [], expiresAt: now() + leaseMs });
      return { connected: true, protocol: 'personal-assistant-local-read/v1' };
    }
    const device = current(botId, input);
    device.expiresAt = now() + leaseMs;
    if (operation === 'poll') {
      if (device.polling) throw fail('LOCAL_POLL_CONFLICT', '此连接已有等待中的请求');
      device.polling = true;
      try {
        if (!device.queue.length) await new Promise(resolve => {
          const timer = setTimeout(() => { device.wake = undefined; resolve(); }, pollMs);
          device.wake = () => { clearTimeout(timer); device.wake = undefined; resolve(); };
        });
        current(botId, input);
        const command = device.queue.shift() || null;
        const job = command && pending.get(command.requestId);
        if (!job) return { command: null };
        job.delivered = true;
        await save({ requestId: command.requestId, status: 'running', startedAt: now() });
        return { command };
      } finally { device.polling = false; }
    }
    if (operation === 'result') {
      const job = pending.get(input.requestId);
      if (!job) return { accepted: false, reason: 'request-ended' };
      if (job.device !== device) throw fail('LOCAL_RESULT_SCOPE', '结果与执行设备不匹配', 403);
      // A 64 KiB UTF-8 file can expand up to six times in JSON (control characters).
      // Leave envelope headroom below the shared 1 MiB socket limit.
      if (Buffer.byteLength(JSON.stringify(input.value ?? input.error ?? null)) > 416 * 1024) {
        await settle(job, fail('LOCAL_RESULT_LIMIT', '本机结果超过大小限制', 413));
        return { accepted: false, reason: 'result-size-limit' };
      }
      await settle(job, input.ok === true ? null : fail(input.error?.code || 'LOCAL_READ_FAILED', input.error?.message || '本机读取失败'), input.value);
      return { accepted: true };
    }
    throw fail('LOCAL_OPERATION_UNSUPPORTED', '本机操作不支持', 404);
  }
  async function execute(botId, input) {
    await ready;
    if (input.action === 'devices') return { devices: list(botId) };
    if (!LOCAL_FILE_ACTIONS.includes(input.action)) throw fail('LOCAL_ACTION_UNSUPPORTED', '当前不支持此本机文件操作', 400);
    const device = devices.get(keyOf(botId, input.deviceId));
    if (!device || device.expiresAt <= now()) throw fail('LOCAL_DEVICE_OFFLINE', '该设备不在线或授权已变更，请重新查询本轮在线设备');
    const root = device.roots.find(root => root.id === input.rootId);
    if (!root) throw fail('LOCAL_ROOT_DENIED', '目录不在授权范围内', 403);
    if (typeof input.path !== 'string' || input.path.length > 4096) throw fail('LOCAL_PATH_INVALID', '需要授权目录内的相对路径', 400);
    const writing = input.action === 'file.write';
    if (writing) {
      if (!root.writable) throw fail('LOCAL_WRITE_DENIED', '该目录只读，写入需要单独授权', 403);
      validateLocalWrite(input);
    }
    if ([...pending.values()].filter(job => job.device === device).length >= 8) throw fail('LOCAL_DEVICE_BUSY', '此设备已有多个等待的文件操作');
    const command = { requestId: randomUUID(), grantId: device.grantId, action: input.action, rootId: input.rootId, path: input.path };
    if (writing) Object.assign(command, { text: input.text, expectedSha256: input.expectedSha256 });
    await save({ requestId: command.requestId, botId, deviceId: device.deviceId, grantId: device.grantId, action: input.action, status: 'queued', createdAt: now() });
    return new Promise((resolve, reject) => {
      const job = { command, device, resolve, reject };
      job.timer = setTimeout(() => {
        device.queue = device.queue.filter(item => item.requestId !== command.requestId);
        void settle(job, writing && job.delivered
          ? fail('LOCAL_WRITE_UNCONFIRMED', '尚未确认本机写入结果。先读取文件核对，再决定是否重试', 504)
          : fail(writing ? 'LOCAL_WRITE_TIMEOUT' : 'LOCAL_READ_TIMEOUT', '本机未及时返回，请核对设备状态', 504));
      }, timeoutMs);
      pending.set(command.requestId, job); device.queue.push(command); device.wake?.();
    });
  }
  return { ready, handle, execute,
    hasGrant: (botId, scope = 'file.read') => list(botId).some(device => device.scopes.includes(scope)),
    dispose() { for (const device of [...devices.values()]) revoke(device); } };
}
