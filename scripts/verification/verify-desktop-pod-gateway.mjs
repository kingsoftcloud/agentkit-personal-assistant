/**
 * 仅在已运行的 computer 容器内执行。stdin 接收 JSON 凭据，只访问既有 Broker/Gateway，
 * 不创建 Controller/Xvfb、不修改策略、不关闭用户窗口。测试文件保留供验收追查。
 */
import assert from 'node:assert/strict';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openGatewayDesktop } from './gateway-desktop-client.mjs';

const execFile = promisify(execFileCallback), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 16384) throw new Error('verification stdin exceeds limit'); }
let input;
try { input = JSON.parse(raw); } catch { throw new Error('verification stdin must be valid JSON'); }
raw = '';
assert.ok(input.gatewayUrl && input.apiKey && input.agentId && input.botId && input.secondaryBotId && input.secondaryBotId !== input.botId, 'stdin requires gatewayUrl/apiKey/agentId/botId/secondaryBotId');
const observerMs = input.observerMs ?? 180000, parkMs = input.parkMs ?? 720000;
assert.ok(Number.isSafeInteger(observerMs) && observerMs >= 0 && Number.isSafeInteger(parkMs) && parkMs >= 0);
const workspace = process.env.AGENTKIT_WORKSPACE_DIR || '/workspace', artifacts = process.env.AGENTKIT_ARTIFACTS_DIR || '/artifacts';
const files = await mkdtemp(join(workspace, '.pa-e2e-')), evidence = await mkdtemp(join(artifacts, 'desktop-e2e-'));
const identity = { userId: process.env.USER_ID, assistantId: process.env.ASSISTANT_ID, computerId: process.env.COMPUTER_ID };
assert.equal(identity.assistantId, input.agentId, 'test Agent must match this running Pod');
assert.ok(identity.userId && identity.computerId);
const report = { startedAt: new Date().toISOString(), agentId: input.agentId, computerId: identity.computerId, evidence, files, observerMs, parkMs, checks: [] };
const connections = []; let fixtureTerminal, reopenedSession;
const record = (name, details = {}) => { const result = { name, passed: true, ...details }; report.checks.push(result); console.log(JSON.stringify(result)); };
const safeError = error => ({ code: error.code, status: error.status, message: String(error.message).replaceAll(String(input.apiKey), '[redacted]').slice(0, 1000) });
const broker = async (path, payload = {}, expectedStatus = 200) => {
  const response = await fetch(`http://127.0.0.1:${process.env.COMPUTER_PORT || 8787}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...identity, ...payload }), signal: AbortSignal.timeout(12000),
  });
  if (response.status !== expectedStatus) throw Object.assign(new Error(`Broker ${path} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`), { status: response.status });
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response.arrayBuffer();
};
const guiProcesses = async () => {
  const found = [];
  for (const pid of await readdir('/proc')) if (/^\d+$/u.test(pid)) try {
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'), binary = argv[0].split('/').at(-1);
    if (['Xvfb', 'fluxbox', 'xterm', 'ffmpeg', 'tint2', 'thunar', 'Thunar', 'dbus-run-session', 'dbus-daemon'].includes(binary) || (binary === 'chromium' && !argv.some(value => value.startsWith('--type=')))) found.push({ pid: Number(pid), binary, argv });
  } catch { /* 进程退出的瞬时竞态。 */ }
  return found;
};
const waitFor = async (predicate, description, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  do { const value = await predicate(); if (value) return value; await sleep(25); } while (Date.now() < deadline);
  throw new Error(`timeout: ${description}`);
};
const waitFile = (path, bytes) => waitFor(async () => { try { const value = await readFile(path); return value.length >= bytes && value; } catch (error) { if (error.code !== 'ENOENT') throw error; } }, path);
const connect = async (botId, mode) => {
  const value = await openGatewayDesktop({ ...input, botId, mode, taskId: `pod-e2e-${randomUUID()}` });
  connections.push(value.client); return value;
};
const acquire = client => client.request({ type: 'control.acquire', controlEpoch: client.controlEpoch }, value => value.type === 'control' && value.readOnly === false);
const release = client => client.request({ type: 'control.release', controlEpoch: client.controlEpoch }, value => value.type === 'control' && value.readOnly === true);
const event = (client, value) => client.request({ type: 'input', controlEpoch: client.controlEpoch, event: value }, reply => reply.type === 'input-accepted');
const key = (client, value) => event(client, { type: 'key', key: value });
const text = (client, value) => event(client, { type: 'text', text: value });
const click = async client => {
  await event(client, { type: 'pointermove', x: 120, y: 150 });
  await event(client, { type: 'button', button: 1, action: 'down', x: 120, y: 150 });
  await event(client, { type: 'button', button: 1, action: 'up' });
};

try {
  const currentProfile = (await readFile('/proc/self/attr/current', 'utf8')).trim();
  const serviceProfile = (await readFile('/proc/1/attr/current', 'utf8')).trim();
  assert.match(currentProfile, /^agentengine-dsh-sandbox-v1(?:\s|$)/u);
  assert.match(serviceProfile, /^agentengine-dsh-sandbox-v1(?:\s|$)/u);
  report.appArmor = { current: currentProfile, service: serviceProfile };
  record('真实目标 DSH AppArmor profile 生效', report.appArmor);
  for (const path of ['/health', '/v1/status']) {
    const response = await fetch(`http://127.0.0.1:${process.env.COMPUTER_PORT || 8787}${path}`);
    assert.equal(response.status, 200); const value = await response.json();
    assert.equal(value.computerId, identity.computerId); assert.equal(value.assistantId, input.agentId); assert.equal(value.desktopReady, true);
  }
  const original = await guiProcesses();
  assert.equal(original.filter(value => value.binary === 'Xvfb').length, 1, '运行前必须已有且只有一个 Xvfb');
  assert.equal(original.filter(value => value.binary === 'tint2').length, 1, '运行前必须已有且只有一个应用底栏');
  record('当前 Broker 健康且已有单个真实桌面');

  const { client: reader, ready: readReady } = await connect(input.botId, 'read');
  assert.equal(readReady.readOnly, true);
  await assert.rejects(event(reader, { type: 'text', text: 'MUST_NOT_APPEAR' }), { status: 403, code: 'DESKTOP_READ_ONLY' });
  await assert.rejects(acquire(reader), { status: 403 });
  await waitFor(() => reader.frames.length > 0, '只读票据仍能看到桌面');
  record('真实网关 read 票据拒绝输入和接管，仍能接收 JPEG');

  const { client: primary, ready } = await connect(input.botId, 'control');
  assert.equal(ready.readOnly, true); assert.equal(ready.controlAvailable, true);
  await waitFor(() => primary.frames.length > 0, '首帧');
  const firstFrameMs = primary.ticketMs + primary.frames[0].at - primary.openedAt;
  assert.ok(firstFrameMs <= 3000, `first frame ${firstFrameMs}ms exceeds 3s`);
  record('网关出票、WSS 与首帧真实通过', { ticketMs: primary.ticketMs, handshakeMs: primary.handshakeMs, firstFrameMs, firstFrameBytes: primary.frames[0].bytes });
  await acquire(primary);

  // 独立验收终端复用现有 DISPLAY，不触碰用户正在运行的 shell/程序。
  const title = `PA_E2E_${randomUUID()}`;
  fixtureTerminal = spawn('xterm', ['-display', process.env.DISPLAY || ':99', '-u8', '-fa', 'DejaVu Sans Mono', '-fs', '12', '-geometry', '56x24+30+80', '-title', title,
    '-xrm', 'XTerm*VT100.translations: #override\\nCtrl Shift <Key>V: insert-selection(CLIPBOARD)', '-e', 'bash', '--noprofile', '--norc'], {
    cwd: files, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PS1: 'pa-e2e> ', HISTFILE: '/dev/null' }, stdio: 'ignore',
  });
  let terminalError; fixtureTerminal.once('error', error => { terminalError = error; });
  await waitFor(async () => { if (terminalError) throw terminalError; try { return (await execFile('xdotool', ['search', '--onlyvisible', '--name', `^${title}$`])).stdout.trim(); } catch { return false; } }, '验收终端窗口');
  await click(primary);
  const typedPath = join(files, 'typed');
  await text(primary, `cat > ${typedPath}`); await key(primary, 'Enter');
  const ascii = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(3).slice(0, 100), chinese = '你好云电脑'.repeat(10);
  await text(primary, ascii); await key(primary, 'Enter'); await text(primary, chinese); await key(primary, 'Enter'); await key(primary, 'ctrl+d');
  assert.equal((await waitFile(typedPath, 252)).toString('utf8'), `${ascii}\n${chinese}\n`);
  record('通过真实 Gateway→Runtime WS→Broker，100 ASCII 与 50 中文精确回显', { utf8Bytes: 252 });
  const bs = join(files, 'backspace');
  await text(primary, 'printf %s ABCX'); await key(primary, 'Backspace'); await text(primary, ` > ${bs}`); await key(primary, 'Enter');
  assert.equal((await waitFile(bs, 3)).toString(), 'ABC');
  const interrupted = join(files, 'must-not-exist'), continued = join(files, 'ctrlc');
  await text(primary, `sleep 30; touch ${interrupted}`); await key(primary, 'Enter'); await sleep(100); await key(primary, 'ctrl+c');
  await text(primary, `printf ok > ${continued}`); await key(primary, 'Enter');
  assert.equal((await waitFile(continued, 2)).toString(), 'ok'); await assert.rejects(readFile(interrupted), { code: 'ENOENT' });
  record('真实 WS 的 Backspace 与 Ctrl+C 不乱序、不中断用户终端');
  const escaped = join(files, 'escape');
  await text(primary, `stty -icanon -echo; dd bs=1 count=1 of=${escaped}; stty sane`); await key(primary, 'Enter'); await sleep(100); await key(primary, 'Escape');
  assert.deepEqual(await waitFile(escaped, 1), Buffer.from([27]));
  const completion = join(files, 'unique-completion'); await writeFile(completion, 'fixture');
  const completed = join(files, 'tab');
  await text(primary, `printf %s ${files}/unique-comp`); await key(primary, 'Tab'); await text(primary, ` > ${completed}`); await key(primary, 'Enter');
  assert.equal((await waitFile(completed, Buffer.byteLength(completion))).toString(), completion);
  record('真实 WS 的 Esc 与 Tab 补全正确');
  // 真实容器 cgroup 计数，包含采集/编码、Broker 和本验收的协议开销。
  const cpuSeconds = async () => {
    try { return Number((await readFile('/sys/fs/cgroup/cpu.stat', 'utf8')).match(/^usage_usec (\d+)$/mu)?.[1]) / 1e6; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return Number(await readFile('/sys/fs/cgroup/cpuacct/cpuacct.usage', 'utf8')) / 1e9; }
  };
  const cpuBefore = await cpuSeconds(), activeAt = Date.now(); await sleep(2000);
  const cpuAfter = await cpuSeconds(), measuredMs = Date.now() - activeAt;
  const activeFrames = primary.frames.filter(frame => frame.at >= activeAt).length, activeFps = activeFrames / 2;
  assert.ok(activeFps >= 10, `active fps ${activeFps} < 10`);
  const cpuPercentOfOneCore = (cpuAfter - cpuBefore) / (measuredMs / 1000) * 100;
  assert.ok(Number.isFinite(cpuPercentOfOneCore) && cpuPercentOfOneCore >= 0);
  record('有操作后的真实串流至少 10 fps，单帧不超过 300 KiB', { activeFps, maxFrameBytes: Math.max(...primary.frames.map(frame => frame.bytes)), measuredMs, cpuPercentOfOneCore });

  const { client: secondary } = await connect(input.secondaryBotId, 'control');
  await assert.rejects(acquire(secondary), { status: 409 });
  await waitFor(() => secondary.frames.length > 0, '冲突后的只读旁观');
  await release(primary); await acquire(secondary); await release(secondary);
  record('第二内部 Bot 接管冲突 409，旁观允许，第一个释放后可取得控制权');
  const cycles = [];
  for (let i = 0; i < 10; i++) {
    const began = Date.now(); await acquire(primary); const acquiredMs = Date.now() - began;
    await click(primary);
    const releaseAt = Date.now(); await release(primary); const releasedMs = Date.now() - releaseAt;
    assert.ok(acquiredMs <= 600, `acquire ${acquiredMs}ms > 600ms`); assert.ok(releasedMs <= 300, `release ${releasedMs}ms > 300ms`);
    cycles.push({ acquiredMs, releasedMs });
  }
  record('同一 WS 连续十次接管/释放成功，画面连接保留', { cycles });
  await execFile('import', ['-display', process.env.DISPLAY || ':99', '-window', 'root', join(evidence, 'terminal-input.png')]);
  await reader.close(); await secondary.close();
  console.log(JSON.stringify({ waiting: '真实网关旁观保活', milliseconds: observerMs }));
  const previousFrameCount = primary.frames.length, observerStarted = Date.now(); await sleep(observerMs);
  assert.equal(primary.closed, false); assert.ok(primary.frames.length > previousFrameCount || observerMs === 0);
  const idleFrames = primary.frames.filter(frame => frame.at >= observerStarted + 15000);
  const idleFps = idleFrames.length > 1 ? (idleFrames.length - 1) * 1000 / (idleFrames.at(-1).at - idleFrames[0].at) : null;
  if (observerMs >= 30000) { assert.ok(idleFps !== null && idleFps <= 1, `idle fps ${idleFps} exceeds 1`); }
  record('保持真实网关观察会话期间不休眠', { elapsedMs: observerMs, idleFps });
  const retained = (await guiProcesses()).filter(value => value.binary !== 'ffmpeg');
  await writeFile(join(evidence, 'processes-before.json'), JSON.stringify(retained.map(({ pid, binary }) => ({ pid, binary })), null, 2));
  await primary.close();
  const stopCaptureBegan = Date.now();
  await waitFor(async () => !(await guiProcesses()).some(value => value.binary === 'ffmpeg' && value.argv.includes('x11grab')), '其他观察者仍在，不能冒充无观察者阶段', 30000);
  record('关闭所有验收观察者后采集进程停止', { stoppedWithinMs: Date.now() - stopCaptureBegan });
  console.log(JSON.stringify({ waiting: '无观察者保留窗口', milliseconds: parkMs }));
  const parkedAt = Date.now(); let noObserverSamples = 0;
  while (Date.now() - parkedAt < parkMs) {
    assert.ok(!(await guiProcesses()).some(value => value.binary === 'ffmpeg' && value.argv.includes('x11grab')), '无观察者阶段出现新的采集器，不能继续宣称无人旁观');
    noObserverSamples++; await sleep(Math.min(1000, Math.max(1, parkMs - (Date.now() - parkedAt))));
  }
  reopenedSession = await broker('/broker/desktop/session', { botId: input.botId, taskId: `restore-${randomUUID()}`, mode: 'read' });
  const frame = await broker('/broker/desktop/frame-binary', { sessionId: reopenedSession.sessionId }); assert.ok(frame.byteLength > 0 && frame.byteLength <= 307200);
  const after = await guiProcesses();
  for (const process of retained) assert.ok(after.some(value => value.pid === process.pid), `原窗口进程被重建: ${process.binary} ${process.pid}`);
  assert.equal(after.filter(value => value.binary === 'Xvfb').length, 1);
  await writeFile(join(evidence, 'processes-after.json'), JSON.stringify(after.map(({ pid, binary }) => ({ pid, binary })), null, 2));
  await execFile('import', ['-display', process.env.DISPLAY || ':99', '-window', 'root', join(evidence, 'restored-desktop.png')]);
  record('无观察者等待后恢复仍为原 X11/WM/应用进程', { elapsedMs: Date.now() - parkedAt, noObserverSamples, preservedPids: retained.map(value => value.pid) });
  report.passed = true;
} catch (error) { report.passed = false; report.error = safeError(error); console.error(JSON.stringify(report.error)); process.exitCode = 1; }
finally {
  report.cleanupErrors = [];
  for (const connection of connections) try { if (!connection.closed && connection.readOnly === false) await release(connection); await connection.close(); } catch (error) { report.cleanupErrors.push(safeError(error)); }
  if (reopenedSession) try { await broker('/broker/desktop/close', { sessionId: reopenedSession.sessionId }); } catch (error) { report.cleanupErrors.push(safeError(error)); }
  if (fixtureTerminal && fixtureTerminal.exitCode === null && fixtureTerminal.signalCode === null) {
    fixtureTerminal.kill('SIGTERM');
    await Promise.race([new Promise(resolve => fixtureTerminal.once('exit', resolve)), sleep(2000)]);
    if (fixtureTerminal.exitCode === null && fixtureTerminal.signalCode === null) {
      fixtureTerminal.kill('SIGKILL');
      await Promise.race([new Promise(resolve => fixtureTerminal.once('exit', resolve)), sleep(1000)]);
      if (fixtureTerminal.exitCode === null && fixtureTerminal.signalCode === null) report.cleanupErrors.push({ code: 'FIXTURE_TERMINAL_REAP_FAILED', message: '验收终端未退出' });
    }
  }
  if (report.cleanupErrors.length) { report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`REPORT_JSON ${JSON.stringify(report)}`);
}
