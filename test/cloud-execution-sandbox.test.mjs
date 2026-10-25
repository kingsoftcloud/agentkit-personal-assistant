import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeSandbox, planCloudExecution, resolveCloudSandbox } from '../runtime/cloud-execution.mjs';

test('Landlock readiness cannot pass when the actual namespace launcher is denied', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pa-readiness-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const sandbox = { kind: 'landlock', path: join(root, 'landlock-run'), unshare: join(root, 'unshare'), guard: join(root, 'terminal-guard') };
  await Promise.all([sandbox.path, sandbox.unshare, sandbox.guard].map(path => writeFile(path, 'fixture')));
  const available = probeSandbox({ sandbox, run(file, args) { calls.push({ file, args }); return { status: 1 }; } });
  assert.equal(available, false);
  assert.equal(calls[0].file, sandbox.guard);
  assert.ok(calls[0].args.includes(sandbox.unshare));
  assert.ok(calls[0].args.includes('--net'));
  assert.ok(calls[0].args.includes('--pid'));
  assert.ok(calls[0].args.includes(sandbox.guard));
});

test('Landlock refuses an execution plan without the seccomp compensation layer', async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'pa-confiner-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const unshare = join(workspace, 'unshare');
  await writeFile(unshare, 'fixture');
  assert.throws(() => planCloudExecution({ workspaceRoot: workspace, sandbox: { available: true, kind: 'landlock', path: '/landlock-run', unshare }, argv: ['/bin/true'], timeoutMs: 1000 }), error => error.code === 'ASSISTANT_CLOUD_EXEC_REFUSED');
});

test('a Landlock fallback requires all three confined execution layers before becoming available', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pa-confiner-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = join(root, 'landlock-run'), unshare = join(root, 'unshare'), guard = join(root, 'terminal-guard');
  await Promise.all([launcher, unshare].map(path => writeFile(path, 'fixture')));
  let probes = 0;
  const options = { platform: 'linux', bwrapPath: join(root, 'missing-bwrap'), landlockPath: launcher, unsharePath: unshare, guardPath: guard, probe() { probes += 1; return true; } };
  assert.equal(resolveCloudSandbox(options).available, false);
  assert.equal(probes, 0);
  await writeFile(guard, 'fixture');
  const sandbox = resolveCloudSandbox(options);
  assert.equal(sandbox.isolation, 'landlock+seccomp+namespaces');
  assert.equal(probes, 1);
  const plan = planCloudExecution({ workspaceRoot: root, sandbox, argv: ['/usr/bin/python3', '-c', 'print(1)'], timeoutMs: 1000 });
  assert.equal(plan.file, guard);
  assert.deepEqual(plan.args.slice(0, 4), ['--workspace', root, '--', unshare]);
  assert.ok(plan.args.includes('--child'));
  assert.ok(plan.args.indexOf(guard) < plan.args.indexOf(launcher));
  assert.ok(plan.args.includes('--net'));
  assert.equal(plan.env.HOME, root);
  assert.equal(plan.env.AGENTKIT_RUNTIME_TOKEN, undefined);
  assert.equal(plan.args.includes('/proc'), false);
});

test('通知代理的就绪探测必须真正执行 chmod 与 FD truncate', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pa-notify-readiness-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = { kind: 'landlock', path: join(root, 'landlock-run'), unshare: join(root, 'unshare'), guard: join(root, 'terminal-guard') };
  await Promise.all([sandbox.path, sandbox.unshare, sandbox.guard].map(path => writeFile(path, 'fixture')));
  const calls = [];
  assert.equal(probeSandbox({ sandbox, run(file, args, options) { calls.push({ file, args, options }); return { status: 0 }; } }), true);
  assert.equal(calls[0].file, sandbox.guard);
  assert.ok(calls[0].args.some(value => value.includes('os.chmod') && value.includes('os.ftruncate')));
  assert.equal(calls[0].options.env.AGENTKIT_RUNTIME_TOKEN, undefined);
});
