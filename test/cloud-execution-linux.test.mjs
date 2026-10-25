import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath, stat, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createCloudExecutor } from '../runtime/cloud-execution.mjs';

// 必须在目标 Linux 容器显式执行；macOS mock 不能替代真实内核及 AppArmor。
test('真实 Linux 沙箱允许工作区 Git、Python 和元数据，并拒绝工作区外修改与联网', {
  skip: process.env.AGENTKIT_SANDBOX_LIVE !== '1',
}, async t => {
  assert.equal(process.platform, 'linux');
  assert.ok(process.env.AGENTKIT_SANDBOX_TEST_ROOT, '需要显式给定容器工作区测试目录');
  const root = await realpath(await mkdtemp(join(process.env.AGENTKIT_SANDBOX_TEST_ROOT, '.pa-confiner-live-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'pa-confiner-outside-')));
  const sentinel = join(outside, 'sentinel');
  await writeFile(sentinel, 'outside-must-stay-intact', { mode: 0o640 });
  const before = await stat(sentinel);
  await symlink(outside, join(root, 'escape'));
  await symlink(sentinel, join(root, 'file-escape'));
  await mkdir(join(root, 'skills/demo'), { recursive: true });
  await writeFile(join(root, 'skills/demo/SKILL.md'), '# 示例技能\n用 Python 计算并输出中文。\n');
  await writeFile(join(root, 'skills/demo/run.sh'), 'set -eu\npython3 -c \'print("技能执行成功", 6*7)\'\n');
  const executor = createCloudExecutor({ workspaceRoot: root });
  t.after(async () => { executor.dispose(); await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });
  assert.equal(executor.available, true, executor.reason);
  assert.equal(executor.sandbox.isolation, 'landlock+seccomp+namespaces');
  const unexpected = join(root, 'must-not-run');
  const rejected = spawnSync(executor.sandbox.guard, ['--workspace', root, '--', '/bin/sh', '-c', `touch '${unexpected}'`]);
  assert.equal(rejected.status, 125);
  await assert.rejects(stat(unexpected), { code: 'ENOENT' });
  const shell = await executor.runBash({ command: "set -eu; printf BASH_OK; python3 -c 'print(2+3)'; git --version; ssh -V 2>&1; bash skills/demo/run.sh" });
  assert.equal(shell.exitCode, 0, shell.stderr);
  assert.match(shell.stdout, /BASH_OK5\n/);
  assert.match(shell.stdout, /git version/);
  assert.match(shell.stdout, /OpenSSH_/);
  assert.match(shell.stdout, /技能执行成功 42/);
  const ssh = await executor.runBash({ command: 'ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=1 -o ConnectionAttempts=1 user@203.0.113.1 true' });
  assert.notEqual(ssh.exitCode, 0);
  assert.match(ssh.stderr, /Operation not permitted/);
  const git = await executor.runBash({ command: 'set -eu; git -c init.defaultBranch=main init repo; cd repo; printf "中文 😀\\n" > hello.txt; git add hello.txt; git -c user.name=terminal-check -c user.email=terminal-check@example.test commit -m initial; git rev-parse --verify HEAD' });
  assert.equal(git.exitCode, 0, git.stderr);
  assert.match(git.stdout, /[a-f0-9]{40}\n$/);
  const js = await executor.runCode({ language: 'javascript', code: 'console.log(3+4)' });
  assert.equal(js.exitCode, 0, js.stderr);
  assert.equal(js.stdout, '7\n');
  const python = await executor.runCode({ language: 'python', code: `
import os,socket,subprocess,ctypes,json,tempfile,threading
outside=${JSON.stringify(sentinel)}
root=${JSON.stringify(root)}
workspace=root+'/legal.txt'
with open(workspace,'w') as f: f.write('123456789')
os.chmod(workspace,0)
os.chmod(workspace,0o600)
os.truncate(workspace,5)
assert open(workspace).read() == '12345'
os.utime(workspace,(100,200))
assert os.stat(workspace).st_mtime_ns == 200000000000
with open(workspace,'r+') as f:
 os.ftruncate(f.fileno(),3)
 os.fchmod(f.fileno(),0o640)
 os.utime(f.fileno(),(300,400))
assert open(workspace).read() == '123'
assert os.stat(workspace).st_mode & 0o777 == 0o640
assert os.stat(workspace).st_mtime_ns == 400000000000
with tempfile.TemporaryFile(dir=root) as f:
 f.write(b'temporary'); f.flush(); os.ftruncate(f.fileno(),2)
 f.seek(0); assert f.read() == b'te'
folder=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
os.chmod('legal.txt',0o600,dir_fd=folder)
os.close(folder)
os.symlink('legal.txt',root+'/inside-link')
os.chmod(root+'/inside-link',0o640)
results={'workspace_metadata':'allowed','git':'committed','skill_script':'executed'}
def denied(label,call,allowed_errors=(1,13,18)):
 try: call()
 except OSError as e:
  assert e.errno in allowed_errors, (label,e.errno)
  results[label]=e.errno
 else: raise AssertionError(label+' unexpectedly allowed')
denied('outside_read',lambda:open(outside).read(),(13,))
denied('outside_write',lambda:open(outside,'w'),(13,))
denied('outside_truncate',lambda:os.truncate(outside,0))
denied('outside_chmod',lambda:os.chmod(outside,0o777))
denied('outside_utime',lambda:os.utime(outside,None))
for name,call in [('symlink_chmod',lambda:os.chmod(root+'/escape/sentinel',0o777)),('symlink_truncate',lambda:os.truncate(root+'/escape/sentinel',0)),('symlink_utime',lambda:os.utime(root+'/escape/sentinel',None))]: denied(name,call)
opath=os.open(outside,os.O_PATH)
denied('outside_fd_chmod',lambda:os.fchmod(opath,0o777))
denied('outside_fd_truncate',lambda:os.ftruncate(opath,0))
os.close(opath)
link_fd=os.open(root+'/file-escape',os.O_PATH|os.O_NOFOLLOW)
denied('symlink_fd_chmod',lambda:os.fchmod(link_fd,0o777),(1,9,13))
os.close(link_fd)
denied('host_proc_read',lambda:open('/proc/${process.pid}/environ').read(),(13,))
denied('tcp_socket',lambda:socket.socket(socket.AF_INET,socket.SOCK_STREAM),(1,))
denied('unix_socket',lambda:socket.socket(socket.AF_UNIX,socket.SOCK_STREAM),(1,))
# 线程发出的通知使用 TID；FD 复制必须定位对应线程组，不得误取其他进程。
failures=[]
def metadata_thread():
 try:
  for i in range(10):
   with open(workspace,'r+') as f: os.ftruncate(f.fileno(),3)
 except BaseException as e: failures.append(repr(e))
threads=[threading.Thread(target=metadata_thread) for _ in range(4)]
for thread in threads: thread.start()
for thread in threads: thread.join()
assert not failures, failures
# 子线程并发复用同一 FD；只有被原子复制且验证属于工作区的对象能被修改。
inside_fd=os.open(workspace,os.O_RDWR)
outside_fd=os.open(outside,os.O_PATH)
race_fd=230
os.dup2(inside_fd,race_fd)
stop=threading.Event()
def replace_fd():
 while not stop.is_set():
  os.dup2(outside_fd,race_fd); os.dup2(inside_fd,race_fd)
worker=threading.Thread(target=replace_fd);worker.start()
try:
 for _ in range(100):
  try: os.fchmod(race_fd,0o600)
  except OSError as e: assert e.errno in (1,9,13),e.errno
finally:
 stop.set();worker.join();os.close(race_fd);os.close(inside_fd);os.close(outside_fd)
results['concurrent_fd_reuse']='contained'
# 同一 pathname 缓冲区并发改写；代理必须只在自己的参数副本上解析与执行。
buffer=ctypes.create_string_buffer(max(len(workspace.encode()),len(outside.encode()))+1)
buffer.value=workspace.encode()
stop=threading.Event()
def replace_path():
 while not stop.is_set():
  buffer.value=outside.encode();buffer.value=workspace.encode()
worker=threading.Thread(target=replace_path);worker.start()
libc=ctypes.CDLL(None,use_errno=True)
try:
 for _ in range(100):
  result=libc.chmod(buffer,0o600)
  if result != 0: assert ctypes.get_errno() in (1,2,13,18),ctypes.get_errno()
finally:
 stop.set();worker.join()
results['concurrent_path_rewrite']='contained'
if os.uname().machine == 'x86_64':
 child=subprocess.run(['/usr/bin/python3','-c','import ctypes;ctypes.CDLL(None).syscall(0x40000000|39)'])
 assert child.returncode == -31, child.returncode
 results['x32_signal']='SIGSYS'
 libc=ctypes.CDLL(None,use_errno=True)
 ctypes.set_errno(0); ring=libc.syscall(425,1,0)
 assert ring == -1 and ctypes.get_errno()==1, (ring,ctypes.get_errno())
 results['io_uring']='EPERM'
 ctypes.set_errno(0)
 changed=libc.syscall(452,ctypes.c_long(-100),ctypes.c_char_p(workspace.encode()),ctypes.c_uint(0o600),ctypes.c_int(0))
 assert changed == 0,(changed,ctypes.get_errno())
 ctypes.set_errno(0)
 escaped=libc.syscall(452,ctypes.c_long(-100),ctypes.c_char_p(outside.encode()),ctypes.c_uint(0o777),ctypes.c_int(0))
 assert escaped == -1 and ctypes.get_errno()==1,(escaped,ctypes.get_errno())
 results['fchmodat2']='workspace-only'
print(json.dumps(results,sort_keys=True))
` });
  assert.equal(python.exitCode, 0, python.stderr);
  const evidence = JSON.parse(python.stdout);
  assert.equal(evidence.workspace_metadata, 'allowed');
  assert.equal(evidence.host_proc_read, 13);
  assert.equal(evidence.x32_signal, 'SIGSYS');
  assert.equal(await readFile(sentinel, 'utf8'), 'outside-must-stay-intact');
  const after = await stat(sentinel);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  t.diagnostic(`真实内核拒绝证据：${python.stdout.trim()}`);
});
