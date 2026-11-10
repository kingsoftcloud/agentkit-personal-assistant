/**
 * 本机授权状态机与持久化（个人助理面板 07 本机授权）。
 *
 * 「连接」与「授权」是两件事：connected 只表示 Host 还能拿到 DSH Host 的云连接服务；
 * authorized 才表示用户允许助理在本机执行 local-control.* 操作。未授权时任何
 * local-control.* 都必须被 Host 拒绝，不能依赖 UI 置灰。
 *
 * 授权记录只包含 scope 列表、风险确认开关与时间戳，不含凭据；持久化走
 * persistent-state 的 local-access 集合。状态目录不可用时退化为进程内状态：
 * 授权在本次会话内有效，重启后回到未授权（宁可重新问一次，也不静默放宽）。
 */

/** 所有本机控制类 operation 的统一前缀；未授权时一律 403。 */
export const LOCAL_CONTROL_OPERATION_PREFIX = 'personal-assistant.local-control.';
export const LOCAL_ACCESS_NOT_AUTHORIZED = 'PERSONAL_ASSISTANT_LOCAL_NOT_AUTHORIZED';
export const LOCAL_ACCESS_SCOPE_INVALID = 'PERSONAL_ASSISTANT_LOCAL_ACCESS_SCOPE_INVALID';
export const LOCAL_ACCESS_INVALID = 'PERSONAL_ASSISTANT_LOCAL_ACCESS_INVALID';
export const LOCAL_ACCESS_STATE_COLLECTION = 'local-access';
/** 契约里允许授予的本机能力；grant 只接受这个集合的子集。 */
export const LOCAL_ACCESS_SCOPES = Object.freeze(['session.create', 'window.input', 'file.read-write']);
const STATE_VERSION = 1;
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

/** local-control.* 是授权前置校验的命名空间，不属于面板白名单。 */
export function isLocalControlOperation(operation) {
  return typeof operation === 'string' && operation.startsWith(LOCAL_CONTROL_OPERATION_PREFIX);
}

function normalizeScopes(value) {
  if (!Array.isArray(value)) throw fail(LOCAL_ACCESS_INVALID, '本机授权范围格式错误', 400);
  const scopes = [];
  for (const item of value) {
    const text = String(item ?? '').trim();
    if (!LOCAL_ACCESS_SCOPES.includes(text)) throw fail(LOCAL_ACCESS_SCOPE_INVALID, '本机授权范围包含未知能力', 400);
    if (!scopes.includes(text)) scopes.push(text);
  }
  return scopes;
}

function normalizeRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.version !== STATE_VERSION) return undefined;
  if (typeof row.authorized !== 'boolean') return undefined;
  const raw = Array.isArray(row.scopes) ? row.scopes : [];
  const scopes = raw.filter(item => LOCAL_ACCESS_SCOPES.includes(item));
  // 存档里出现未知 scope 说明格式不兼容：整条作废比悄悄收窄权限更安全。
  if (scopes.length !== raw.length) return undefined;
  const stamp = value => typeof value === 'string' ? value.slice(0, 40) : null;
  return Object.freeze({
    authorized: row.authorized,
    scopes: Object.freeze(scopes),
    riskConfirm: row.riskConfirm === true,
    grantedAt: row.authorized ? stamp(row.grantedAt) : null,
    revokedAt: stamp(row.revokedAt),
  });
}

const UNAUTHORIZED_RECORD = Object.freeze({
  authorized: false,
  scopes: Object.freeze([]),
  riskConfirm: false,
  grantedAt: null,
  revokedAt: null,
});

export class LocalAccess {
  /**
   * @param {object} options
   * @param {object|null} [options.stateStore] persistent-state 实例；null 表示只存在内存
   * @param {() => boolean|Promise<boolean>} [options.probeConnection] DSH Host 连接可用性探测
   * @param {() => Date|number} [options.now] 时间源（测试可注入）
   * @param {string} [options.platform] 覆盖 process.platform（测试可注入）
   * @param {string} [options.hostVersion] DSH Host 版本；拿不到时为空串
   */
  constructor({ stateStore = null, probeConnection, now, platform, hostVersion } = {}) {
    this.stateStore = stateStore ?? null;
    this.probeConnection = typeof probeConnection === 'function' ? probeConnection : () => true;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.platform = String(platform ?? (typeof process === 'object' ? process.platform : '') ?? '').slice(0, 32);
    this.hostVersion = typeof hostVersion === 'string' ? hostVersion.slice(0, 40) : '';
    this.record = UNAUTHORIZED_RECORD;
    /** 授权撤销时要中止的本机任务（由 local-control 处理函数通过 controlSignal() 领取）。 */
    this.controllers = new Set();
    this.ready = undefined;
  }

  get authorized() {
    return this.record.authorized === true;
  }

  /** 幂等恢复持久化状态；任何读盘/格式错误都退化为未授权，绝不抛错。 */
  load() {
    if (!this.ready) this.ready = this._restore();
    return this.ready;
  }

  async _restore() {
    if (!this.stateStore) return;
    try {
      const rows = await this.stateStore.read(LOCAL_ACCESS_STATE_COLLECTION);
      const row = Array.isArray(rows) ? rows.find(item => item && typeof item === 'object' && !Array.isArray(item)) : undefined;
      const restored = normalizeRecord(row);
      if (restored) this.record = restored;
    } catch {
      // 状态目录不可读（首次创建、权限、损坏）按未授权处理，面板仍能打开。
    }
  }

  _stamp() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  async _persist() {
    if (!this.stateStore) return false;
    const row = Object.freeze({
      version: STATE_VERSION,
      authorized: this.record.authorized,
      scopes: [...this.record.scopes],
      riskConfirm: this.record.riskConfirm,
      grantedAt: this.record.grantedAt,
      revokedAt: this.record.revokedAt,
      updatedAt: this._stamp(),
    });
    try {
      await this.stateStore.mutate(LOCAL_ACCESS_STATE_COLLECTION, rows => {
        rows.splice(0, rows.length, row);
        return true;
      });
      return true;
    } catch {
      // 配额/权限/磁盘异常：授权在内存生效，重启后需要重新授权。
      return false;
    }
  }

  /** 三态由 UI 组合：authorized + connected=绿，未授权但连接=琥珀，连接不可用=灰。 */
  async status() {
    await this.load();
    let connected = false;
    try { connected = (await this.probeConnection()) === true; } catch { connected = false; }
    return {
      connected,
      authorized: this.record.authorized,
      scopes: [...this.record.scopes],
      riskConfirm: this.record.riskConfirm,
      grantedAt: this.record.grantedAt,
      host: { platform: this.platform, hostVersion: this.hostVersion },
    };
  }

  async grant({ scopes, riskConfirm } = {}) {
    const normalized = normalizeScopes(scopes);
    if (riskConfirm !== undefined && typeof riskConfirm !== 'boolean') {
      throw fail(LOCAL_ACCESS_INVALID, '高风险确认开关格式错误', 400);
    }
    const grantedAt = this._stamp();
    this.record = Object.freeze({
      authorized: true,
      scopes: Object.freeze(normalized),
      riskConfirm: riskConfirm === true,
      grantedAt,
      revokedAt: null,
    });
    await this._persist();
    return { authorized: true, grantedAt };
  }

  async revoke() {
    // 先同步失效并中止在途任务，再落盘：撤销授权不允许存在“还没生效”的窗口。
    this.record = Object.freeze({
      authorized: false,
      scopes: Object.freeze([]),
      riskConfirm: false,
      grantedAt: null,
      revokedAt: this._stamp(),
    });
    for (const controller of [...this.controllers]) {
      try { controller.abort(); } catch { /* 单个任务的中止失败不影响撤销 */ }
    }
    this.controllers.clear();
    await this._persist();
    return { authorized: false };
  }

  /** local-control.* 的前置校验；未授权直接 403。 */
  assertAuthorized() {
    if (!this.record.authorized) throw fail(LOCAL_ACCESS_NOT_AUTHORIZED, '本机尚未授权；请先允许面板控制本机后重试', 403);
    return true;
  }

  /** 供未来的本机控制实现领取中止信号；撤销授权时统一 abort。 */
  controlSignal() {
    const controller = new AbortController();
    if (!this.record.authorized) {
      controller.abort();
      return controller;
    }
    this.controllers.add(controller);
    controller.signal.addEventListener('abort', () => this.controllers.delete(controller), { once: true });
    return controller;
  }

  dispose() {
    for (const controller of [...this.controllers]) {
      try { controller.abort(); } catch { /* ignore */ }
    }
    this.controllers.clear();
  }
}

export function createLocalAccess(options) {
  return new LocalAccess(options);
}
