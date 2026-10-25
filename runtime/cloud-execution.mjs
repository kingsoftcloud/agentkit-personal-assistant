/** Confined command and program execution for a managed cloud assistant. */
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

export const CLOUD_BASH_TOOL = 'cloud_bash';
export const CLOUD_RUN_CODE_TOOL = 'cloud_run_code';
export const CLOUD_EXECUTION_SCHEMA = 'assistant-cloud-execution/v1';
const CODE_LANGUAGES = Object.freeze(['javascript', 'python']);
const DEFAULT_TIMEOUT_MS = 120_000, MAX_TIMEOUT_MS = 300_000;
const MAX_COMMAND_BYTES = 16 * 1024, MAX_CODE_BYTES = 64 * 1024, OUTPUT_BYTES = 64 * 1024;
const SYSTEM_BINDINGS = Object.freeze([
  ['/usr', '/usr'], ['/etc/ssl', '/etc/ssl'], ['/etc/passwd', '/etc/passwd'], ['/etc/group', '/etc/group'],
  ['/etc/hosts', '/etc/hosts'], ['/etc/nsswitch.conf', '/etc/nsswitch.conf'], ['/etc/resolv.conf', '/etc/resolv.conf'],
  ['/etc/ca-certificates', '/etc/ca-certificates'], ['/etc/ca-certificates.conf', '/etc/ca-certificates.conf'],
]);
// The Landlock launcher is read-only allow-list based: it grants read access to
// the system roots below and write access only to the workspace, a shared temp
// root and /dev/null. /proc is deliberately NOT granted: the confined child is
// spawned by the Host, and a readable /proc would expose Host credentials
// through /proc/<host-pid>/environ.
const LANDLOCK_READ_ONLY = Object.freeze(['/usr', '/etc', '/dev/urandom']);
// No shared /tmp: the confined child writes temp files inside its own
// workspace subdirectory so nothing it creates is visible to the Host.
const LANDLOCK_READ_WRITE = Object.freeze(['/dev/null']);
const LANDLOCK_LAUNCHER_RELATIVE = Object.freeze([
  'node_modules', '@deepseek-ai', 'node-addon-system-linux-x64', 'bin', 'landlock-run',
]);
const CLOUD_ENVIRONMENT = Object.freeze([
  ['PATH', '/usr/local/bin:/usr/bin:/bin'], ['TMPDIR', '.cloud-exec-tmp'], ['LANG', 'C.UTF-8'], ['LC_ALL', 'C.UTF-8'],
  ['TERM', 'dumb'], ['PYTHONDONTWRITEBYTECODE', '1'], ['NODE_OPTIONS', '--max-old-space-size=512'],
  ['AGENTKIT_CLOUD_EXECUTION', '1'],
]);
const NAMESPACE_ARGS = Object.freeze(['--user', '--map-root-user', '--net', '--pid', '--fork', '--ipc', '--uts', '--kill-child']);
const LANDLOCK_INFORMATIONAL = 'landlock-run: partial enforcement (older Landlock ABI)';
const fail = (message, code = 'ASSISTANT_CLOUD_EXEC_REFUSED') => Object.assign(new Error(message), { code });

function checkedWorkspace(workspaceRoot) {
  const root = resolve(workspaceRoot);
  let info;
  try { info = statSync(root); } catch { throw fail('云端执行需要可用的专属工作区'); }
  if (!info.isDirectory() || realpathSync(root) !== root) throw fail('云端执行工作区不是规范目录');
  return root;
}

function installRoots(env) {
  const roots = [];
  if (typeof env.AGENTKIT_INSTALLATION === 'string' && isAbsolute(env.AGENTKIT_INSTALLATION)) roots.push(env.AGENTKIT_INSTALLATION);
  // The DSH Host owns the image's fixed installation; its own entry script
  // identifies the runtime root without importing any Host-internal module.
  const entry = process.argv[1];
  if (typeof entry === 'string' && isAbsolute(entry)) {
    const marker = `${sep}node_modules${sep}`;
    const at = entry.indexOf(marker);
    if (at > 0) roots.push(entry.slice(0, at));
  }
  roots.push('/opt/agentkit/runtime');
  return [...new Set(roots)];
}

/** Locate the Landlock launcher shipped next to the Host installation. */
export function resolveLandlockLauncher({ env = process.env } = {}) {
  const explicit = env.AGENTKIT_LANDLOCK;
  if (typeof explicit === 'string' && explicit) return isAbsolute(explicit) && existsSync(explicit) ? explicit : undefined;
  for (const root of installRoots(env)) {
    const candidate = join(root, ...LANDLOCK_LAUNCHER_RELATIVE);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const probeCache = new Map();

function cachedProbe(key, probe) {
  if (probeCache.has(key)) return probeCache.get(key);
  const verdict = Boolean(probe());
  probeCache.set(key, verdict);
  return verdict;
}

/** Run the confined argv once and report whether the kernel actually enforced it. */
export function probeSandbox({ sandbox, run = spawnSync, timeoutMs = 5000 } = {}) {
  if (!sandbox?.path) return false;
  if (sandbox.kind === 'bwrap') {
    // 必须走与正式执行相同的挂载和 namespace；仅 ro-bind / + true
    // 会漏掉 AppArmor 拒绝 /proc 挂载，造成“探测绿、执行失败”。
    let workspace;
    try {
      workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pa-bwrap-probe-')));
      const planned = planCloudExecution({ sandbox: { ...sandbox, available: true }, workspaceRoot: workspace,
        argv: ['/bin/true'], timeoutMs });
      const result = run(planned.file, planned.args, { timeout: timeoutMs, stdio: 'ignore', env: planned.env, cwd: workspace });
      return result?.status === 0;
    } catch { return false; }
    finally { if (workspace) rmSync(workspace, { recursive: true, force: true }); }
  }
  if (sandbox.kind === 'landlock') {
    if (!sandbox.guard || !sandbox.unshare) return false;
    // 真正执行工作区 chmod/ftruncate，同时验证 namespace、Landlock、通知
    // listener、读取子进程参数及 pidfd_getfd；不把静态能力探测当成可运行。
    let workspace;
    try {
      workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pa-guard-probe-')));
      const planned = planCloudExecution({ sandbox: { ...sandbox, available: true }, workspaceRoot: workspace,
        argv: ['/usr/bin/python3', '-c', 'import os,sys; p=sys.argv[1]+"/probe"; f=os.open(p,os.O_CREAT|os.O_RDWR,0o600); os.chmod(p,0o600); os.ftruncate(f,0); os.close(f)', workspace], timeoutMs });
      const result = run(planned.file, planned.args, { timeout: timeoutMs, stdio: 'ignore', env: planned.env, cwd: workspace });
      return result?.status === 0;
    } catch { return false; }
    finally { if (workspace) rmSync(workspace, { recursive: true, force: true }); }
  }
  return false;
}

/**
 * Resolve the confiner used for every cloud execution. bubblewrap keeps the
 * strongest isolation (private mounts, hidden Host state); the Landlock
 * launcher is the fallback for kernels or runtime policies where bwrap cannot
 * create its mount namespace. A backend is only reported usable after it
 * proved enforcement once; execution never degrades to an unconfined child.
 */
export function resolveCloudSandbox({ platform = process.platform, env = process.env, bwrapPath, landlockPath, unsharePath, guardPath, probe = probeSandbox } = {}) {
  if (platform !== 'linux') return { available: false, reason: '该运行环境没有可用的 Linux 执行沙箱' };
  const bwrap = bwrapPath || env.AGENTKIT_BWRAP || '/usr/bin/bwrap';
  if (isAbsolute(bwrap) && existsSync(bwrap)) {
    const sandbox = { available: true, kind: 'bwrap', path: bwrap, isolation: 'namespaces' };
    if (cachedProbe(`bwrap:${bwrap}`, () => probe({ sandbox }))) return sandbox;
  }
  const launcher = landlockPath || resolveLandlockLauncher({ env });
  const unshare = unsharePath || env.AGENTKIT_UNSHARE || '/usr/bin/unshare';
  const guard = guardPath || env.AGENTKIT_TERMINAL_GUARD || '/usr/local/lib/agentkit/terminal-guard';
  if (launcher && isAbsolute(unshare) && existsSync(unshare) && isAbsolute(guard) && existsSync(guard)) {
    const sandbox = { available: true, kind: 'landlock', path: launcher, unshare, guard, isolation: 'landlock+seccomp+namespaces' };
    if (cachedProbe(`landlock:${launcher}:${guard}:${unshare}`, () => probe({ sandbox }))) return sandbox;
  }
  return { available: false, reason: '运行环境没有可用的隔离后端：bubblewrap 与 Landlock 沙盒启动器均不可用' };
}

function timeoutOf(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) throw fail('超时时间必须在 1 秒到 300 秒之间');
  return value;
}

function boundedText(input, limit, label) {
  if (typeof input !== 'string' || !input.trim()) throw fail(`${label}不能为空`);
  if (Buffer.byteLength(input, 'utf8') > limit) throw fail(`${label}超过云端执行上限`);
  return input;
}

function cloudEnvironment(root) {
  // Temporary files belong to the confined workspace, never to a shared /tmp
  // that the Host also writes: TMPDIR is resolved below the owned root.
  return Object.fromEntries([['HOME', root], ...CLOUD_ENVIRONMENT.map(([name, value]) => [name, name === 'TMPDIR' ? join(root, value) : value])]);
}

/**
 * Build one confined invocation. bubblewrap mounts a private root; Landlock
 * runs the launcher inside fresh user/pid/ipc/uts/net namespaces with an
 * allow-list filesystem policy, so both backends keep the child offline and
 * bound to the workspace.
 */
export function planCloudExecution({ sandbox, workspaceRoot, argv, timeoutMs }) {
  const root = checkedWorkspace(workspaceRoot);
  if (!sandbox?.available) throw fail(sandbox?.reason || '云端执行沙箱不可用');
  if (sandbox.kind === 'bwrap') {
    const args = ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net'];
    for (const [source, target] of SYSTEM_BINDINGS) args.push('--ro-bind-try', source, target);
    for (const [target, source] of [['/bin', 'usr/bin'], ['/sbin', 'usr/sbin'], ['/lib', 'usr/lib'], ['/lib64', 'usr/lib64']]) {
      args.push('--symlink', source, target);
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var/tmp');
    args.push('--bind', root, root, '--chdir', root, '--hostname', 'agentkit-cloud-exec', '--clearenv');
    for (const [key, value] of [['PATH', '/usr/local/bin:/usr/bin:/bin'], ['HOME', root], ...CLOUD_ENVIRONMENT]) {
      args.push('--setenv', key, value);
    }
    args.push('--', ...argv);
    return { file: sandbox.path, args, env: {}, cwd: root, timeoutMs };
  }
  if (sandbox.kind === 'landlock') {
    if (!isAbsolute(sandbox.unshare || '') || !existsSync(sandbox.unshare)) throw fail('云端执行沙箱不可用：缺少 unshare');
    if (!isAbsolute(sandbox.guard || '') || !existsSync(sandbox.guard)) throw fail('云端执行沙箱不可用：缺少 seccomp 补偿层');
    // supervisor 必须留在外层 PID/user namespace，才能安全读取通知所属
    // tracee 的参数并原子复制 FD；只有实际工具位于全新的 namespaces 内。
    const args = ['--workspace', root, '--', sandbox.unshare, ...NAMESPACE_ARGS, sandbox.guard, '--child', '--', sandbox.path];
    for (const path of LANDLOCK_READ_ONLY) args.push('--ro', path);
    for (const path of LANDLOCK_READ_WRITE) args.push('--rw', path);
    args.push('--rw', root, '--', ...argv);
    return { file: sandbox.guard, args, env: cloudEnvironment(root), cwd: root, timeoutMs };
  }
  throw fail('云端执行沙箱不可用：未知的隔离后端');
}

function appendBounded(chunks, chunk, state, label, cap = OUTPUT_BYTES) {
  if (state.bytes >= cap) { state.truncated = true; return; }
  const room = cap - state.bytes, slice = chunk.subarray(0, room);
  chunks.push(slice); state.bytes += slice.length;
  if (slice.length < chunk.length) state.truncated = true;
  state[label] = true;
}

/** Drop the launcher's informational verdict line so tool output stays the command's own. */
function cleanStderr(text) {
  return text.split('\n').filter(line => line !== LANDLOCK_INFORMATIONAL).join('\n');
}

/**
 * One confined executor per managed Agent. It refuses to start when the image
 * cannot confine the child; no call falls back to the Host shell or environment.
 */
export function createCloudExecutor({ workspaceRoot, sandbox, spawn = spawnChild, limits = {}, platform = process.platform, env = process.env } = {}) {
  const root = checkedWorkspace(workspaceRoot);
  const confiner = sandbox === undefined ? resolveCloudSandbox({ platform, env }) : sandbox;
  const running = new Set();
  let disposed = false;
  const outputCap = limits.outputBytes ?? OUTPUT_BYTES;
  const maxTimeout = limits.maxTimeoutMs ?? MAX_TIMEOUT_MS;

  function plan(argv, timeoutMs) {
    return planCloudExecution({ sandbox: confiner, workspaceRoot: root, argv, timeoutMs });
  }

  async function run(argv, { timeoutMs, signal } = {}) {
    if (disposed) throw fail('云端执行已关闭');
    if (!confiner?.available) throw fail(confiner?.reason || '云端执行沙箱不可用');
    const planned = plan(argv, Math.min(timeoutOf(timeoutMs), maxTimeout));
    if (typeof planned.env?.TMPDIR === 'string') {
      try { mkdirSync(planned.env.TMPDIR, { recursive: true }); }
      catch (error) { throw fail(`云端执行临时目录不可用: ${error.code || 'mkdir-error'}`); }
    }
    return await new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(planned.file, planned.args, { cwd: planned.cwd, env: planned.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { rejectPromise(fail(`云端执行启动失败: ${error.code || 'spawn-error'}`)); return; }
      running.add(child);
      const out = [], err = [];
      const stdoutState = { bytes: 0, truncated: false }, stderrState = { bytes: 0, truncated: false };
      let timedOut = false, aborted = false, settled = false, timer, killTimer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(killTimer); running.delete(child);
        if (signal && removeAbort) signal.removeEventListener('abort', onAbort);
        if (error) rejectPromise(error); else resolvePromise(value);
      };
      const kill = () => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        // A killed child normally reports close immediately; this guard keeps a
        // wedged process from hanging the tool call forever.
        if (killTimer === undefined) killTimer = setTimeout(() => {
          if (aborted) finish(fail('云端执行已取消', 'ASSISTANT_CLOUD_EXEC_ABORTED'));
          else if (timedOut) finish(fail(`云端执行超过 ${Math.round(planned.timeoutMs / 1000)} 秒，进程组已终止`, 'ASSISTANT_CLOUD_EXEC_TIMEOUT'));
        }, 3000);
      };
      const onAbort = () => { aborted = true; kill(); };
      const removeAbort = signal ? (signal.addEventListener('abort', onAbort, { once: true }), onAbort) : undefined;
      if (signal?.aborted) onAbort();
      timer = setTimeout(() => { timedOut = true; kill(); }, planned.timeoutMs);
      child.stdout.on('data', chunk => appendBounded(out, chunk, stdoutState, 'stdout', outputCap));
      child.stderr.on('data', chunk => appendBounded(err, chunk, stderrState, 'stderr', outputCap));
      child.on('error', error => finish(fail(`云端执行进程错误: ${error.code || 'spawn-error'}`)));
      child.on('close', (code, signalName) => {
        if (aborted) return finish(fail('云端执行已取消', 'ASSISTANT_CLOUD_EXEC_ABORTED'));
        if (timedOut) return finish(fail(`云端执行超过 ${Math.round(planned.timeoutMs / 1000)} 秒，进程组已终止`, 'ASSISTANT_CLOUD_EXEC_TIMEOUT'));
        const decode = chunks => Buffer.concat(chunks).toString('utf8');
        const stderr = decode(err);
        finish(null, { exitCode: typeof code === 'number' ? code : -1, signal: signalName || '',
          stdout: decode(out), stderr: confiner.kind === 'landlock' ? cleanStderr(stderr) : stderr,
          stdoutTruncated: stdoutState.truncated || stdoutState.bytes >= outputCap, stderrTruncated: stderrState.truncated,
          timeoutMs: planned.timeoutMs });
      });
    });
  }

  return {
    available: Boolean(confiner?.available),
    reason: confiner?.reason,
    sandbox: confiner,
    backend: confiner?.kind,
    runBash({ command, timeoutMs } = {}, options) {
      const text = boundedText(command, MAX_COMMAND_BYTES, '命令');
      return run(['/bin/bash', '-c', text], { ...options, timeoutMs });
    },
    runCode({ language, code, timeoutMs } = {}, options) {
      if (!CODE_LANGUAGES.includes(language)) throw fail('云端脚本仅支持 JavaScript 或 Python');
      const text = boundedText(code, MAX_CODE_BYTES, '脚本');
      return language === 'javascript'
        ? run(['/usr/local/bin/node', '--input-type=module', '-e', text], { ...options, timeoutMs })
        : run(['/usr/bin/python3', '-c', text], { ...options, timeoutMs });
    },
    dispose() { disposed = true; for (const child of running) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } running.clear(); },
  };
}

// The Host tool registry only accepts a single type per property (type arrays
// are rejected at registration), so signal absence is encoded explicitly.
function outputSchema() {
  return { type: 'object', properties: {
    exitCode: { type: 'number' }, signal: { type: 'string' },
    stdout: { type: 'string' }, stderr: { type: 'string' },
    stdoutTruncated: { type: 'boolean' }, stderrTruncated: { type: 'boolean' }, timeoutMs: { type: 'number' },
  }, required: ['exitCode', 'signal', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated', 'timeoutMs'], additionalProperties: false };
}

const renderOutput = (_args, value) => [{ type: 'text', text: `exit ${value.exitCode}${value.signal ? ` (${value.signal})` : ''}\n${value.stdout}${value.stderr}` }];

/** Register the confined tools for one managed Agent. Names are admitted only while the grant is active. */
export function registerAssistantCloudExecutionTools({ agent, workspaceRoot, executor = createCloudExecutor({ workspaceRoot }), previous }) {
  const tools = agent.ctx.get('tools');
  if (!tools?.register) throw fail('云端执行需要原生工具注册表');
  if (previous) { previous.executor.dispose(); for (const dispose of previous.disposers) dispose(); }
  if (!executor.available) throw fail(executor.reason || '云端执行沙箱不可用', 'ASSISTANT_CLOUD_EXECUTION_UNAVAILABLE');
  const bash = {
    name: CLOUD_BASH_TOOL, description: 'Run one shell command inside this assistant\'s confined cloud workspace. No network, no host credentials, no paths outside the workspace.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command'], additionalProperties: false },
    output: { schema: outputSchema(), render: renderOutput },
    execute: (args, exec) => executor.runBash(args, { signal: exec.signal }),
  };
  const code = {
    name: CLOUD_RUN_CODE_TOOL, description: 'Run one bounded JavaScript or Python program inside this assistant\'s confined cloud workspace. No network, no host credentials, no paths outside the workspace.',
    parameters: { type: 'object', properties: { language: { type: 'string', enum: [...CODE_LANGUAGES] }, code: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['language', 'code'], additionalProperties: false },
    output: { schema: outputSchema(), render: renderOutput },
    execute: (args, exec) => executor.runCode(args, { signal: exec.signal }),
  };
  const disposers = [tools.register(bash), tools.register(code)].filter(Boolean);
  return { names: [CLOUD_BASH_TOOL, CLOUD_RUN_CODE_TOOL], definitions: [bash, code], executor, disposers };
}
