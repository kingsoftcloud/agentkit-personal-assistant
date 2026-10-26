/** 在真实 Linux/X11 中验证输入与窗口保留；不替代目标 Pod/AppArmor 验收。 */
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopController } from '../../runtime/desktop-session.mjs';
import { createCloudBrowser } from '../../runtime/cloud-browser.mjs';

const execFile = promisify(execFileCallback), args = process.argv.slice(2);
const argument = (name, fallback) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; };
const observerMs = Number(argument('--observer-ms', 180_000));
const parkMs = Number(argument('--park-ms', 720_000));
assert.ok(Number.isFinite(observerMs) && observerMs >= 0 && Number.isFinite(parkMs) && parkMs >= 0);
const evidence = argument('--evidence', '/tmp/pa-desktop-evidence');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const workspace = await mkdtemp(join(tmpdir(), 'pa-real-input-'));
await mkdir(evidence, { recursive: true });
process.env.AGENTKIT_DESKTOP_MODE = '1';
const desktop = createDesktopController(), browser = createCloudBrowser({ workspace });
const report = { environment: '本地 Linux 容器，非预发目标 AppArmor', startedAt: new Date().toISOString(), observerMs, parkMs, checks: [] };
const pass = (name, data = {}) => { const check = { name, passed: true, ...data }; report.checks.push(check); console.log(JSON.stringify(check)); };
const waitFile = async (path, bytes = 1) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { const value = await readFile(path); if (value.length >= bytes) return value; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  throw new Error(`terminal did not create ${path}`);
};
const processList = async () => {
  const found = [];
  for (const pid of await readdir('/proc')) if (/^\d+$/.test(pid)) {
    try {
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      if (/(?:^|\/)(?:Xvfb|fluxbox|xterm|chromium)$/.test(argv[0])) found.push({ pid: Number(pid), binary: argv[0], argv });
    } catch { /* 已结束的子进程无需采集。 */ }
  }
  return found;
};
try {
  report.appArmor = (await readFile('/proc/self/attr/current', 'utf8').catch(() => 'unavailable')).trim();
  const session = await desktop.openSession({ identity: { userId: 'local-proof', assistantId: 'local-proof', computerId: 'local-proof' }, controllable: true, leaseId: 'local-proof' });
  const input = event => desktop.input({ sessionId: session.sessionId, event });
  const text = value => input({ type: 'text', text: value });
  const key = value => input({ type: 'key', key: value });
  await input({ type: 'button', action: 'down', button: 1, x: 120, y: 140 });
  await input({ type: 'button', action: 'up', button: 1 });
  await key('ctrl+c');
  const typedFile = join(workspace, 'typed');
  await text(`cat > ${typedFile}`); await key('Enter'); await delay(100);
  const ascii = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(3).slice(0, 100);
  const chinese = '你好云电脑'.repeat(10);
  for (const value of [ascii, chinese]) { await Promise.all([...value].map(character => text(character))); await key('Enter'); }
  await key('ctrl+d');
  const received = (await waitFile(typedFile, Buffer.byteLength(`${ascii}\n${chinese}\n`))).toString('utf8');
  assert.equal(received, `${ascii}\n${chinese}\n`);
  pass('100 ASCII 与 50 中文快速输入逐字一致，Enter 正常', { asciiCharacters: ascii.length, chineseCharacters: [...chinese].length, utf8Bytes: Buffer.byteLength(received) });

  const backspaceFile = join(workspace, 'backspace');
  await text('printf %s ABCX'); await key('Backspace'); await text(` > ${backspaceFile}`); await key('Enter');
  assert.equal((await waitFile(backspaceFile, 3)).toString(), 'ABC');
  pass('Backspace 正常，不与前后 text 乱序');

  const bad = join(workspace, 'ctrlc-failed'), good = join(workspace, 'ctrlc-ok');
  await text(`sleep 30; touch ${bad}`); await key('Enter'); await delay(100); await key('ctrl+c');
  await text(`printf ok > ${good}`); await key('Enter');
  assert.equal((await waitFile(good, 2)).toString(), 'ok');
  await assert.rejects(readFile(bad), { code: 'ENOENT' });
  pass('Ctrl+C 中断终端程序，后续输入继续执行');

  const completion = join(workspace, 'completion'); await mkdir(completion);
  await writeFile(join(completion, 'unique-entry'), 'fixture');
  const tabFile = join(workspace, 'tab');
  await text(`printf %s ${completion}/uni`); await key('Tab'); await text(` > ${tabFile}`); await key('Enter');
  assert.equal((await waitFile(tabFile, Buffer.byteLength(join(completion, 'unique-entry')))).toString(), join(completion, 'unique-entry'));
  pass('Tab 在真实终端完成文件名补全');

  const escapeFile = join(workspace, 'escape');
  await text(`stty -icanon -echo; dd bs=1 count=1 of=${escapeFile}; stty sane`); await key('Enter'); await delay(100); await key('Escape');
  assert.deepEqual(await waitFile(escapeFile), Buffer.from([27]));
  pass('Esc 到达真实终端，字节为 27');

  const font = await execFile('fc-match', ['Noto Sans CJK SC', '--format=%{family}\n']);
  assert.match(font.stdout, /Noto Sans CJK SC/);
  // xterm 字体度量可能把右侧撑满；左侧 10px 一定在窗口外的根桌面。
  await input({ type: 'button', action: 'click', button: 3, x: 10, y: 500 });
  await delay(250);
  await execFile('import', ['-display', process.env.DISPLAY || ':99', '-window', 'root', join(evidence, 'menu-chinese.png')]);
  pass('菜单中文字体已解析，显式截图已保存', { font: font.stdout.trim(), screenshot: 'menu-chinese.png' });
  await key('Escape');

  await browser.openDesktopWindow();
  await desktop.frameBinary({ sessionId: session.sessionId });
  const initial = await processList();
  for (const binary of ['Xvfb', 'fluxbox', 'xterm', 'chromium']) assert.ok(initial.some(value => value.binary.split('/').at(-1) === binary), `missing real process: ${binary}`);
  await writeFile(join(evidence, 'processes-before.json'), JSON.stringify(initial, null, 2));
  console.log(JSON.stringify({ waiting: '旁观保活', milliseconds: observerMs }));
  await delay(observerMs);
  assert.equal(desktop.getSession(session.sessionId)?.idle, false);
  assert.equal(desktop.stats().xserverRunning, true);
  assert.ok((await desktop.frameBinary({ sessionId: session.sessionId })).bytes > 0);
  pass('真实计时旁观不休眠且仍出帧', { elapsedMs: observerMs });
  desktop.closeSession(session.sessionId);
  console.log(JSON.stringify({ waiting: '无观察者保留窗口', milliseconds: parkMs }));
  await delay(parkMs);
  assert.equal(desktop.stats().collectorRunning, false);
  const reopened = await desktop.openSession({ identity: {} });
  const retained = await processList();
  await writeFile(join(evidence, 'processes-after.json'), JSON.stringify(retained, null, 2));
  const windows = initial.filter(value => /(?:^|\/)(?:Xvfb|fluxbox|xterm)$/.test(value.binary) || (/(?:^|\/)chromium$/.test(value.binary) && !value.argv.some(arg => arg.startsWith('--type='))));
  for (const child of windows) assert.ok(retained.some(value => value.pid === child.pid), `window process restarted: ${child.binary} ${child.pid}`);
  assert.ok((await desktop.frameBinary({ sessionId: reopened.sessionId })).bytes > 0);
  await execFile('import', ['-display', process.env.DISPLAY || ':99', '-window', 'root', join(evidence, 'retained-windows.png')]);
  pass('无观察者后恢复仍为原 X11/WM/终端/Chromium 进程', { elapsedMs: parkMs, preservedPids: windows.map(value => value.pid), screenshot: 'retained-windows.png' });
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = { code: error.code, message: error.message, stack: error.stack };
  console.error(error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await browser.dispose(); await desktop.dispose(); await rm(workspace, { recursive: true, force: true });
  console.log(`REPORT_JSON ${JSON.stringify(report)}`);
}
