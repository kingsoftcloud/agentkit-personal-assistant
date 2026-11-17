/** Host-owned directory grants and the authenticated cloud worker. No shell or GUI authority. */
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export const LOCAL_CONTROL_OPERATION_PREFIX = 'personal-assistant.local-control.';
export const LOCAL_ACCESS_NOT_AUTHORIZED = 'PERSONAL_ASSISTANT_LOCAL_NOT_AUTHORIZED';
export const LOCAL_ACCESS_SCOPE_INVALID = 'PERSONAL_ASSISTANT_LOCAL_ACCESS_SCOPE_INVALID';
export const LOCAL_ACCESS_INVALID = 'PERSONAL_ASSISTANT_LOCAL_ACCESS_INVALID';
export const LOCAL_ACCESS_STATE_COLLECTION = 'local-access';
export const LOCAL_ACCESS_SCOPES = Object.freeze(['file.read']);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export const isLocalControlOperation = operation => typeof operation === 'string' && operation.startsWith(LOCAL_CONTROL_OPERATION_PREFIX);
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };

export class LocalAccess {
  constructor({ stateStore, transport, getTarget, platform = process.platform, hostVersion = '', now = () => new Date(), retryMs = 3000 } = {}) {
    Object.assign(this, { stateStore, transport, getTarget, platform, hostVersion, now, retryMs });
    this.record = { version: 3, deviceId: randomUUID(), authorized: false, scopes: [], roots: [] };
    this.connectionId = randomUUID();
    this.connected = false;
    this.disposed = false;
  }
  get authorized() { return this.record.authorized; }
  async load() {
    return this.loading ||= (async () => {
      if (this.stateStore) {
        const row = (await this.stateStore.read(LOCAL_ACCESS_STATE_COLLECTION))[0];
        // Earlier records did not bind the user's cloud account.
        if (row?.version === 3 && typeof row.deviceId === 'string') this.record = row;
      }
      if (this.authorized) void this.start().catch(() => {});
    })();
  }
  async persist() {
    if (!this.stateStore) throw fail('LOCAL_STATE_UNAVAILABLE', 'Host 未提供授权存储目录', 503);
    await this.stateStore.mutate(LOCAL_ACCESS_STATE_COLLECTION, rows => rows.splice(0, rows.length, this.record));
  }
  async status() {
    await this.load();
    const { agentId, botId } = this.record.target || {};
    return { available: Boolean(this.transport && this.stateStore), connected: this.connected, authorized: this.authorized,
      scopes: this.record.scopes, roots: this.record.roots.map(({ id, path }) => ({ id, path })),
      grantedAt: this.record.grantedAt || null, riskConfirm: true, deviceId: this.record.deviceId,
      target: agentId ? { agentId, botId } : undefined, lastError: this.lastError || '', host: { name: hostname(), platform: this.platform, hostVersion: this.hostVersion } };
  }
  async grant({ scopes, roots, target } = {}) {
    await this.load();
    if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'file.read') throw fail(LOCAL_ACCESS_SCOPE_INVALID, '当前仅支持授权目录的只读访问');
    if (!Array.isArray(roots) || !roots.length || roots.length > 8) throw fail(LOCAL_ACCESS_INVALID, '请选择 1 至 8 个本机目录');
    if (!target?.agentId || !target?.botId || !target?.authority) throw fail(LOCAL_ACCESS_INVALID, '请先确认云账号并选择助理');
    const directories = [];
    for (const input of [...new Set(roots)]) {
      if (typeof input !== 'string' || !isAbsolute(input)) throw fail(LOCAL_ACCESS_INVALID, '授权目录必须是绝对路径');
      const path = await realpath(input);
      if (!(await stat(path)).isDirectory()) throw fail(LOCAL_ACCESS_INVALID, '授权路径必须是目录');
      directories.push({ id: randomUUID(), path });
    }
    this.stop();
    this.record = { version: 3, deviceId: this.record.deviceId, grantId: randomUUID(), authorized: true,
      scopes: ['file.read'], roots: directories, target: { ...target }, grantedAt: this.now().toISOString() };
    try { await this.persist(); } catch (error) { this.record.authorized = false; throw error; }
    // A saved grant can connect after an image upgrade or a network outage.
    // Report that grant even if its first connection attempt fails.
    await this.start().catch(() => {});
    return this.status();
  }
  assertAuthorized(grantId = this.record.grantId) {
    if (!this.authorized || grantId !== this.record.grantId) throw fail(LOCAL_ACCESS_NOT_AUTHORIZED, '本机目录尚未授权或授权已撤销', 403);
  }
  async execute(command, signal) {
    this.assertAuthorized(command.grantId);
    if (!['file.list', 'file.read'].includes(command.action)) throw fail('LOCAL_ACTION_UNSUPPORTED', '当前不支持此本机操作');
    const root = this.record.roots.find(item => item.id === command.rootId);
    if (!root) throw fail('LOCAL_ROOT_DENIED', '目录不在授权范围内', 403);
    const input = command.path || '.';
    if (typeof input !== 'string' || isAbsolute(input) || input.includes('\0')) throw fail('LOCAL_PATH_INVALID', '请使用授权目录内的相对路径');
    const candidate = resolve(root.path, input);
    if (!inside(root.path, candidate)) throw fail('LOCAL_PATH_DENIED', '路径超出授权目录', 403);
    const path = await realpath(candidate);
    if (!inside(root.path, path)) throw fail('LOCAL_PATH_DENIED', '链接指向授权目录之外', 403);
    let result;
    if (command.action === 'file.list') {
      const entries = await readdir(path, { withFileTypes: true });
      result = { entries: entries.slice(0, 200).map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'link' })), truncated: entries.length > 200 };
    } else {
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 64 * 1024) throw fail('LOCAL_FILE_LIMIT', '当前只读能力支持不超过 64 KiB 的文本文件', 413);
        const bytes = Buffer.alloc(64 * 1024 + 1);
        let bytesRead = 0;
        while (bytesRead < bytes.length) {
          const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
          if (!chunk.bytesRead) break;
          bytesRead += chunk.bytesRead;
        }
        if (bytesRead > 64 * 1024) throw fail('LOCAL_FILE_LIMIT', '文件超过 64 KiB', 413);
        result = { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)), bytes: bytesRead };
      } finally { await file.close(); }
    }
    signal?.throwIfAborted();
    this.assertAuthorized(command.grantId);
    return { deviceId: this.record.deviceId, requestId: command.requestId, ...result };
  }
  async assertCurrentTarget() {
    const current = await this.getTarget();
    const target = this.record.target;
    if (!target || !current.authority || current.authority !== target.authority || current.agentId !== target.agentId) throw fail('LOCAL_ACCOUNT_CHANGED', '云账号或助理绑定已改变，请重新授权', 403);
  }
  async remote(operation, payload, signal) {
    await this.assertCurrentTarget();
    signal?.throwIfAborted();
    return this.transport(this.record.target, `personal-assistant.device.${operation}`, payload, signal);
  }
  async start() {
    if (!this.authorized || this.disposed) return;
    if (this.starting) return this.starting;
    const controller = this.controller = new AbortController();
    const identity = { deviceId: this.record.deviceId, grantId: this.record.grantId, connectionId: this.connectionId };
    const pending = (async () => {
      await this.remote('register', { ...identity, name: hostname(), scopes: this.record.scopes,
        roots: this.record.roots.map(({ id, path }) => ({ id, name: basename(path) })) }, controller.signal);
      controller.signal.throwIfAborted();
      this.connected = true; this.lastError = '';
      void this.poll(identity, controller);
    })().catch(error => {
      if (this.controller !== controller || controller.signal.aborted) throw error;
      this.lastError = error.message; this.connected = false;
      if (!this.disposed && error.code !== 'LOCAL_ACCOUNT_CHANGED') this.retry = setTimeout(() => { void this.start().catch(() => {}); }, this.retryMs);
      this.retry?.unref?.();
      throw error;
    }).finally(() => { if (this.starting === pending) this.starting = undefined; });
    this.starting = pending;
    return pending;
  }
  async poll(identity, controller) {
    try {
      while (!controller.signal.aborted) {
        const { command } = await this.remote('poll', identity, controller.signal);
        if (!command) continue;
        await this.assertCurrentTarget();
        let response;
        try { response = { ok: true, value: await this.execute(command, controller.signal) }; }
        catch (error) { response = { ok: false, error: { code: error.code || 'LOCAL_READ_FAILED', message: error.status ? error.message : '本机文件读取失败' } }; }
        controller.signal.throwIfAborted();
        await this.remote('result', { ...identity, requestId: command.requestId, ...response }, controller.signal);
      }
    } catch (error) {
      if (this.controller !== controller) return;
      this.connected = false; this.lastError = error.message;
      if (!controller.signal.aborted && !this.disposed && error.code !== 'LOCAL_ACCOUNT_CHANGED') {
        this.retry = setTimeout(() => { void this.start().catch(() => {}); }, this.retryMs); this.retry.unref?.();
      }
    }
  }
  stop() { clearTimeout(this.retry); this.controller?.abort(); this.starting = undefined; this.connected = false; }
  async revoke() {
    await this.load();
    const old = this.record;
    this.stop();
    this.record = { version: 3, deviceId: old.deviceId, authorized: false, scopes: [], roots: [] };
    await this.persist();
    if (old.target && this.transport) {
      try { await this.transport(old.target, 'personal-assistant.device.revoke', { deviceId: old.deviceId, grantId: old.grantId }, AbortSignal.timeout(5000)); } catch { /* Host already refuses every old request; cloud presence expires. */ }
    }
    return { authorized: false };
  }
  dispose() { this.disposed = true; this.stop(); }
}
export const createLocalAccess = options => new LocalAccess(options);
