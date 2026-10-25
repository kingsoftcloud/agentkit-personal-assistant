import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCloudExecutor } from '../runtime/cloud-execution.mjs';

// 仅在目标 Linux 容器显式执行；本地 macOS 单元测试不能替代这条验收。
test('真实 Linux 沙箱允许工作区执行并拒绝凭据、联网、ABI1 截断与 x32 绕过', {
  skip: process.env.AGENTKIT_SANDBOX_LIVE !== '1',
}, async t => {
  assert.equal(process.platform, 'linux');
  assert.ok(process.env.AGENTKIT_SANDBOX_TEST_ROOT, '需要显式给定容器工作区测试目录');
  const root = await realpath(await mkdtemp(join(process.env.AGENTKIT_SANDBOX_TEST_ROOT, '.pa-confiner-live-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'pa-confiner-outside-')));
  const sentinel = join(outside, 'sentinel');
  await writeFile(sentinel, 'outside-must-stay-intact');
  const executor = createCloudExecutor({ workspaceRoot: root });
  t.after(async () => { executor.dispose(); await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });
  assert.equal(executor.available, true, executor.reason);
  assert.equal(executor.sandbox.isolation, 'landlock+seccomp+namespaces');
  const shell = await executor.runBash({ command: "printf BASH_OK; python3 -c 'print(2+3)'" });
  assert.equal(shell.exitCode, 0, shell.stderr);
  assert.equal(shell.stdout, 'BASH_OK5\n');
  const js = await executor.runCode({ language: 'javascript', code: 'console.log(3+4)' });
  assert.equal(js.exitCode, 0, js.stderr);
  assert.equal(js.stdout, '7\n');
  const python = await executor.runCode({ language: 'python', code: `
import os,socket,subprocess,ctypes,json
outside=${JSON.stringify(sentinel)}
workspace=${JSON.stringify(join(root, 'legal.txt'))}
with open(workspace,'w') as f: f.write('合法工作区写入')
assert open(workspace).read() == '合法工作区写入'
results={}
def denied(label,call,allowed_errors):
 try: call()
 except OSError as e:
  assert e.errno in allowed_errors, (label,e.errno)
  results[label]=e.errno
 else: raise AssertionError(label+' unexpectedly allowed')
denied('outside_read',lambda:open(outside).read(),[13])
denied('outside_write',lambda:open(outside,'w'),[13])
denied('outside_truncate',lambda:os.truncate(outside,0),[1])
denied('outside_chmod',lambda:os.chmod(outside,0o777),[1])
denied('outside_utime',lambda:os.utime(outside,None),[1])
denied('host_proc_read',lambda:open('/proc/${process.pid}/environ').read(),[13])
denied('tcp_socket',lambda:socket.socket(socket.AF_INET,socket.SOCK_STREAM),[1])
denied('unix_socket',lambda:socket.socket(socket.AF_UNIX,socket.SOCK_STREAM),[1])
with open(workspace,'r+') as f: denied('ftruncate',lambda:os.ftruncate(f.fileno(),0),[1])
assert open(workspace).read() == '合法工作区写入'
if os.uname().machine == 'x86_64':
 child=subprocess.run(['/usr/bin/python3','-c','import ctypes;ctypes.CDLL(None).syscall(0x40000000|39)'])
 assert child.returncode == -31, child.returncode
 results['x32_signal']='SIGSYS'
print(json.dumps(results,sort_keys=True))
` });
  assert.equal(python.exitCode, 0, python.stderr);
  const evidence = JSON.parse(python.stdout);
  assert.equal(evidence.outside_truncate, 1);
  assert.equal(evidence.host_proc_read, 13);
  assert.equal(evidence.x32_signal, 'SIGSYS');
  assert.equal(await readFile(sentinel, 'utf8'), 'outside-must-stay-intact');
  t.diagnostic(`真实内核拒绝证据：${python.stdout.trim()}`);
});
