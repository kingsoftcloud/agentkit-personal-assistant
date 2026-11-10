/** Erase only the receipt-owned, isolated frozen runtime after its writers stop. */
import { lstat, readFile, realpath, rm, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
export async function createAssistantRetirement({ ctx, env }) {
  if (!env.AGENTKIT_HOME || !env.DSH_HOME || !/^[a-f0-9]{64}$/.test(env.AGENTKIT_BUNDLE_SHA256 || '')) return null;
  const root = dirname(resolve(env.AGENTKIT_HOME));
  if (resolve(env.AGENTKIT_HOME) !== join(root, 'agentkit') || resolve(env.DSH_HOME) !== join(root, 'dsh')) return null;
  let receipt;
  try { receipt = JSON.parse(await readFile(join(root, '.agentkit-runtime.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (receipt.format !== 'agentkit.runtime-state/v1' || receipt.bundleSha256 !== env.AGENTKIT_BUNDLE_SHA256 || await realpath(root) !== root) return null;
  for (const name of ['agentkit', 'dsh']) {
    const info = await lstat(join(root, name));
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
  }
  const domains = ctx.get('storageDomain');
  const agents = ctx.get('agents');
  if (typeof domains?.closeAll !== 'function' || typeof agents?.get !== 'function' || typeof agents.list !== 'function') return null;
  const marker = join(root, '.assistant-closed.json');
  let result, pending;
  const persist = async value => { await writeFile(marker + '.next', JSON.stringify(value) + '\n', { mode: 0o600 }); await rename(marker + '.next', marker); };
  return clearMemory => {
    if (result) return Promise.resolve(result);
    if (pending) return pending;
    pending = (async () => {
      await persist({ phase: 'closing', bundleSha256: receipt.bundleSha256 });
      const controller = ctx.get('sessionController'), schedule = ctx.get('schedule');
      // This Host is a dedicated frozen deployment, proven by its boot receipt.
      // Stop timers before cancelling live Agents in that deployment. The
      // durable catalog also includes cold Sessions; cancel does not resume them.
      if (schedule) for (const task of await schedule.catalog()) await schedule.edit({ id: task.id, action: 'delete' });
      const sessions = await controller.list({}, new AbortController().signal);
      for (const item of sessions.items) {
        // Native get/cancel are synchronous: no await may separate this live
        // identity check from dispatch. Real cancellation failures must stop
        // retirement; only an actually absent Agent is safe to skip.
        if (agents.get(item.sessionId)) await controller.cancel({ sessionId: item.sessionId });
      }
      const until = Date.now() + 20000;
      while (agents.list().some(agent => agent.status === 'running')) {
        if (Date.now() >= until) throw fail('ASSISTANT_DELETE_BUSY', '助理任务尚未停止，请稍后重试关闭');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      for (const session of ctx.get('sessions').list()) {
        if (!await ctx.get('sessions').flush(session)) throw fail('ASSISTANT_DELETE_UNCONFIRMED', '会话停止结果尚未确认');
      }
      // Managed workspaces live alongside configuration, never inside it. A
      // replaced top-level directory must stop cleanup before any memory write.
      const workspace = join(root, 'assistant-workspaces');
      const workspaceInfo = await lstat(workspace).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (workspaceInfo && (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() || await realpath(workspace) !== workspace)) throw fail('ASSISTANT_DELETE_SCOPE_INVALID', '助理工作区归属无法核对');
      const memory = await clearMemory();
      // Session.flush owns the event log, not write-behind projection caches.
      // Close the dedicated Host's native domains: reject new cache writes and
      // await every queued durable write before touching their directories.
      await domains.closeAll();
      await ctx.get('sessionPersistence')?.flush();
      // Revalidate immediately before deletion; no caller can supply a path.
      for (const name of ['agentkit', 'dsh', 'assistant-workspaces']) {
        const path = join(root, name), info = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (info && (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path)) throw fail('ASSISTANT_DELETE_SCOPE_INVALID', '专属运行目录归属无法核对');
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(join(root, 'dsh'), { recursive: true, force: true });
      await rm(join(root, 'agentkit'), { recursive: true, force: true });
      result = { deleted: true, historyDeleted: true, memoryDeleted: true, workspaceDeleted: true, memoryCount: memory.count,
        agentId: env.AGENTKIT_RUNTIME_AGENT_ID, buildId: env.AGENTKIT_RUNTIME_BUILD_ID };
      await persist({ phase: 'closed', bundleSha256: receipt.bundleSha256, result });
      return result;
    })().finally(() => { pending = null; });
    return pending;
  };
}
