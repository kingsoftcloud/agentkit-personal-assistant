import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const active = value => ['submitting', 'updating', 'verifying', 'unknown'].includes(value?.status);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

/** Persists the request receipt, then verifies the running process through its authenticated channel. */
export function createRuntimeUpgrade({ path, inspect, versions, update, probe, now = Date.now }) {
  let submitting, writes = Promise.resolve();
  async function read() {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function save(value, observed = false) {
    const pending = writes.then(async () => {
      if (observed) {
        const latest = await read();
        if (latest?.operationId !== value.operationId || !active(latest)) return latest;
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path);
      return value;
    });
    writes = pending.catch(() => {});
    return pending;
  }
  async function status(_input = {}, signal) {
    const operation = await read();
    if (!operation) return null;
    const current = await inspect({}, signal);
    if (current.agentId !== operation.agentId) return null;
    if (!active(operation)) return operation;
    let observed;
    try { observed = await probe({ agentId: operation.agentId, botId: operation.botId }, signal); }
    catch { /* A rolling instance may not accept a channel yet; no successful probe means no success. */ }
    if (observed?.ready === true && observed.version === operation.targetVersion
      && current.runtime?.version === operation.targetVersion && current.runtime?.imageDigest === operation.targetImage) {
      return save({ ...operation, status: 'succeeded', observedVersion: observed.version, runtimeInstanceId: observed.runtimeInstanceId, finishedAt: now(), error: '' }, true);
    }
    const expired = now() - operation.startedAt > 15 * 60_000;
    return save({ ...operation, status: expired ? 'needs-attention' : 'verifying',
      observedVersion: observed?.version || '', runtimeInstanceId: observed?.runtimeInstanceId || '',
      error: expired ? '尚未确认目标运行时就绪，请查看云端实例状态；不会自动重复升级或删除重建' : '' }, true);
  }
  async function start(input, signal) {
    if (submitting) throw fail('UPGRADE_BUSY', '升级请求正在提交');
    const run = (async () => {
      const previous = await status({}, signal);
      if (active(previous)) throw fail('UPGRADE_BUSY', '当前实例已有升级等待确认');
      const current = await inspect({}, signal), catalog = await versions({}, signal);
      if (input.agentId && input.agentId !== current.agentId) throw fail('ASSISTANT_AGENT_MISMATCH', '当前助理已改变，请重新检查更新');
      if (!current.detailAvailable) throw fail('UPGRADE_DETAIL_REQUIRED', '无法读取当前云端版本，请稍后重试');
      if (current.runtime.version !== input.expectedVersion) throw fail('UPGRADE_VERSION_CHANGED', '云端版本已改变，请重新检查更新');
      const target = catalog.versions.find(row => row.version === input.runtimeVersion);
      if (!target || target.image !== input.imageDigest || !/@sha256:[a-f0-9]{64}$/u.test(target.image)) throw fail('UPGRADE_CATALOG_CHANGED', '目标镜像不在当前发布目录，请重新检查更新');
      if (!catalog.upgrades?.some(row => row.version === target.version)) throw fail('UPGRADE_TARGET_INVALID', '请选择比当前版本更新的运行时');
      const operation = await save({ operationId: randomUUID(), agentId: current.agentId, botId: input.botId,
        previousVersion: current.runtime.version, previousImage: current.runtime.imageDigest,
        targetVersion: target.version, targetImage: target.image, startedAt: now(), status: 'submitting' });
      try {
        await update({ agentId: current.agentId, runtimeVersion: target.version, expectedVersion: current.runtime.version }, signal);
        return save({ ...operation, status: 'updating' }, true);
      } catch (error) {
        await save({ ...operation, status: error.status >= 400 && error.status < 500 ? 'failed' : 'unknown', error: error.message }, true);
        throw error;
      }
    })();
    submitting = run;
    try { return await run; } finally { submitting = undefined; }
  }
  return { start, status };
}
