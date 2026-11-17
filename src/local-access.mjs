/** Host-owned directory grants and the authenticated cloud worker. No shell or GUI authority. */
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { chmod, link, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LOCAL_FILE_ACTIONS, LOCAL_FILE_BYTES, validateLocalWrite } from './local-file-contract.mjs';

export const LOCAL_CONTROL_OPERATION_PREFIX = 'personal-assistant.local-control.';
export const LOCAL_ACCESS_NOT_AUTHORIZED = 'PERSONAL_ASSISTANT_LOCAL_NOT_AUTHORIZED';
export const LOCAL_ACCESS_SCOPE_INVALID = 'PERSONAL_ASSISTANT_LOCAL_ACCESS_SCOPE_INVALID';
export const LOCAL_ACCESS_INVALID = 'PERSONAL_ASSISTANT_LOCAL_ACCESS_INVALID';
export const LOCAL_ACCESS_STATE_COLLECTION = 'local-access';
export const LOCAL_ACCESS_SCOPES = Object.freeze(['file.read']);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export const isLocalControlOperation = operation => typeof operation === 'string' && operation.startsWith(LOCAL_CONTROL_OPERATION_PREFIX);
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function readLocalText(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > LOCAL_FILE_BYTES) throw fail('LOCAL_FILE_LIMIT', '当前只支持不超过 64 KiB 的文本文件', 413);
    const bytes = Buffer.alloc(LOCAL_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > LOCAL_FILE_BYTES) throw fail('LOCAL_FILE_LIMIT', '文件超过 64 KiB', 413);
    const content = bytes.subarray(0, length);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(content), bytes: length, sha256: sha256(content), mode: info.mode & 0o777 };
  } finally { await file.close(); }
}

async function writeLocalText(root, candidate, command, check) {
  validateLocalWrite(command);
  const requestedParent = dirname(candidate), parent = await realpath(requestedParent);
  if (!inside(root, parent)) throw fail('LOCAL_PATH_DENIED', '链接指向授权目录之外', 403);
  const destination = join(parent, basename(candidate));
  const temporary = join(parent, `.pa-write-${randomUUID()}`);
  check();
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(command.text); } finally { await file.close(); }
    if (command.expectedSha256 !== undefined) {
      const current = await readLocalText(destination).catch(error => {
        if (error.code === 'ELOOP') throw fail('LOCAL_PATH_DENIED', '不能通过链接修改文件', 403);
        if (error.code !== 'ENOENT') throw error;
      });
      if (current?.sha256 !== command.expectedSha256) throw fail('LOCAL_FILE_CHANGED', '文件已变化，请重新读取再保存', 409);
      await chmod(temporary, current.mode);
    }
    if (await realpath(requestedParent) !== parent) throw fail('LOCAL_PATH_DENIED', '授权目录已变化', 403);
    check();
    if (command.expectedSha256 !== undefined) await rename(temporary, destination);
    else await link(temporary, destination).catch(error => {
      if (error.code !== 'EEXIST') throw error;
      throw fail('LOCAL_FILE_EXISTS', '文件已存在；先读取文件后才能修改', 409);
    });
    return { written: true, bytes: Buffer.byteLength(command.text), sha256: sha256(command.text) };
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

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
  async persist(record = this.record) {
    if (!this.stateStore) throw fail('LOCAL_STATE_UNAVAILABLE', 'Host 未提供授权存储目录', 503);
    await this.stateStore.mutate(LOCAL_ACCESS_STATE_COLLECTION, rows => rows.splice(0, rows.length, record));
  }
  async status() {
    await this.load();
    const { agentId, botId } = this.record.target || {};
    return { available: Boolean(this.transport && this.stateStore), connected: this.connected, authorized: this.authorized,
      scopes: this.record.scopes, roots: this.record.roots.map(({ id, path, writable }) => ({ id, path, writable: writable === true })),
      grantedAt: this.record.grantedAt || null, riskConfirm: true, deviceId: this.record.deviceId,
      target: agentId ? { agentId, botId } : undefined, lastError: this.lastError || '', host: { name: hostname(), platform: this.platform, hostVersion: this.hostVersion } };
  }
  async grant({ scopes, roots, target } = {}) {
    await this.load();
    if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'file.read') throw fail(LOCAL_ACCESS_SCOPE_INVALID, '只支持所选目录的文件访问');
    if (!Array.isArray(roots) || !roots.length || roots.length > 8) throw fail(LOCAL_ACCESS_INVALID, '请选择 1 至 8 个本机目录');
    if (!target?.agentId || !target?.botId || !target?.authority) throw fail(LOCAL_ACCESS_INVALID, '请先确认云账号并选择助理');
    const directories = [];
    for (const input of roots) {
      const selected = typeof input === 'string' ? input : input?.path;
      if (typeof selected !== 'string' || !isAbsolute(selected)) throw fail(LOCAL_ACCESS_INVALID, '请选择本机目录');
      const path = await realpath(selected);
      if (!(await stat(path)).isDirectory()) throw fail(LOCAL_ACCESS_INVALID, '授权路径必须是目录');
      const writable = input?.writable === true;
      if (writable && (dirname(path) === path || inside(path, await realpath(homedir())))) throw fail(LOCAL_ACCESS_INVALID, '请选择具体文件夹，不能授权写入整个用户目录或磁盘根目录');
      const existing = directories.find(root => root.path === path);
      if (existing) {
        if (existing.writable !== writable) throw fail(LOCAL_ACCESS_INVALID, '同一个目录不能设置两种权限');
        continue;
      }
      if (directories.some(root => root.writable !== writable && (inside(root.path, path) || inside(path, root.path)))) {
        throw fail(LOCAL_ACCESS_INVALID, '相互包含的文件夹不能设置不同权限，请选择更具体的文件夹');
      }
      directories.push({ id: this.record.roots.find(root => root.path === path)?.id || randomUUID(), path, writable });
    }
    const previous = this.record;
    const next = { version: 3, deviceId: previous.deviceId, grantId: randomUUID(), authorized: true,
      scopes: ['file.read'], roots: directories, target: { ...target }, grantedAt: this.now().toISOString() };
    await this.persist(next);
    this.stop();
    this.record = next;
    if (previous.target && previous.target.botId !== target.botId) await this.withdraw(previous);
    // A saved grant can connect after an image upgrade or a network outage.
    // Report that grant even if its first connection attempt fails.
    await this.start().catch(() => {});
    return this.status();
  }
  assertAuthorized(grantId = this.record.grantId) {
    if (!this.authorized || grantId !== this.record.grantId) throw fail(LOCAL_ACCESS_NOT_AUTHORIZED, '本机目录尚未授权或授权已撤销', 403);
  }
  async execute(command, signal) {
    const check = () => { signal?.throwIfAborted(); this.assertAuthorized(command.grantId); };
    check();
    if (!LOCAL_FILE_ACTIONS.includes(command.action)) throw fail('LOCAL_ACTION_UNSUPPORTED', '当前不支持此本机操作');
    const root = this.record.roots.find(item => item.id === command.rootId);
    if (!root) throw fail('LOCAL_ROOT_DENIED', '目录不在授权范围内', 403);
    const input = command.path || '.';
    if (typeof input !== 'string' || isAbsolute(input) || input.includes('\0')) throw fail('LOCAL_PATH_INVALID', '请使用授权目录内的相对路径');
    const candidate = resolve(root.path, input);
    if (!inside(root.path, candidate)) throw fail('LOCAL_PATH_DENIED', '路径超出授权目录', 403);
    if (command.action === 'file.write') {
      if (root.writable !== true) throw fail('LOCAL_WRITE_DENIED', '该目录只读，写入需要单独授权', 403);
      return { deviceId: this.record.deviceId, requestId: command.requestId, ...await writeLocalText(root.path, candidate, command, check) };
    }
    const path = await realpath(candidate);
    if (!inside(root.path, path)) throw fail('LOCAL_PATH_DENIED', '链接指向授权目录之外', 403);
    let result;
    if (command.action === 'file.list') {
      const entries = await readdir(path, { withFileTypes: true });
      result = { entries: entries.slice(0, 200).map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'link' })), truncated: entries.length > 200 };
    } else {
      const { text, bytes, sha256 } = await readLocalText(path);
      result = { text, bytes, sha256 };
    }
    check();
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
        roots: this.record.roots.map(({ id, path, writable }) => ({ id, name: basename(path), ...(writable === true ? { writable: true } : {}) })) }, controller.signal);
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
        catch (error) { response = { ok: false, error: { code: error.code || 'LOCAL_FILE_FAILED', message: error.status ? error.message : '本机文件操作未完成' } }; }
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
  async withdraw(record) {
    if (!record.target || !this.transport) return;
    try { await this.transport(record.target, 'personal-assistant.device.revoke', { deviceId: record.deviceId, grantId: record.grantId }, AbortSignal.timeout(5000)); } catch { /* Host already refuses every old request; cloud presence expires. */ }
  }
  async revoke() {
    await this.load();
    const old = this.record;
    this.stop();
    this.record = { version: 3, deviceId: old.deviceId, authorized: false, scopes: [], roots: [] };
    await this.persist();
    await this.withdraw(old);
    return { authorized: false };
  }
  dispose() { this.disposed = true; this.stop(); }
}
export const createLocalAccess = options => new LocalAccess(options);
