/**
 * 中文剪贴板乱码的字节级证据夹具。
 *
 * 用一个「假 xclip」shell 脚本把 X11 selection 的 stdin/stdout 原始字节落盘，
 * 但它下面跑的是真实的 desktop-ws → computer-agentd → desktop-session 代码路径：
 *   面板 WS 帧 → broker HTTP body → agentd JSON → desktop-session → xclip stdin 字节
 *
 * 每一跳都断言中文字节数组与 UTF-8 编码完全一致（中文/emoji/四字节字符），
 * 并把「旧实现会变成 ����」的读方向缺陷固化成回归用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn as spawnChild, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter, once } from 'node:events';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopController, DESKTOP_CLIPBOARD_MAX_BYTES, utf8Bytes } from '../runtime/desktop-session.mjs';
import { createComputerAgentServer } from '../runtime/computer-agentd.mjs';
import { attachDesktopWebSocket } from '../runtime/desktop-ws.mjs';

const execFileAsync = promisify(execFile);
const RUNTIME_TOKEN = 'local-test-token-at-least-24-characters';
const readyWindowProperties = '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400001\n_NET_ACTIVE_WINDOW(WINDOW): window id # 0x800002\n';
const LOCALES = 'C\nC.utf8\nPOSIX\nzh_CN.utf8\nen_US.utf8\n';

/** 假 xclip：不转码、不加换行，字节原样进出——这正是 xclip 0.13 对纯文本的实际行为。 */
const FAKE_XCLIP = [
  '#!/bin/sh',
  'state="$CLIP_STATE_DIR"',
  'mode=in',
  'target=""',
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "-target" ]; then target="$arg"; fi',
  '  case "$arg" in',
  '    -out|-o) mode=out ;;',
  '  esac',
  '  prev="$arg"',
  'done',
  'if [ "$mode" = out ]; then',
  '  if [ "$target" = TARGETS ]; then',
  '    if [ -f "$state/targets.txt" ]; then cat "$state/targets.txt"; else printf "%s\\n" TARGETS UTF8_STRING; fi',
  '    exit 0',
  '  fi',
  '  if [ -f "$state/clip.bin" ]; then cat "$state/clip.bin"; exit 0; fi',
  '  echo "Error: target $target not available" >&2',
  '  exit 1',
  'fi',
  'cat > "$state/clip.bin"',
  'trap "exit 0" TERM INT',
  'while :; do sleep 0.05; done',
  '',
].join('\n');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeProcess() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.killed = true;
    child.emit('exit', 0);
    child.emit('close', 0);
  };
  return child;
}

/** 单帧 WS 编码；支持 FIN/opcode 组合，用于 TCP 半包与 RFC 6455 分片用例。 */
function encodeFrame(input, { fin = true, opcode = 1 } = {}) {
  const payload = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input), 'utf8');
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  const first = (fin ? 0x80 : 0x00) | opcode;
  let header;
  if (payload.length < 126) header = Buffer.from([first, 0x80 | payload.length]);
  else if (payload.length < 65536) header = Buffer.from([first, 0xfe, payload.length >> 8, payload.length & 255]);
  else { header = Buffer.alloc(10); header[0] = first; header[1] = 0xff; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, mask, masked]);
}

async function connect(port) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/v1/desktop/ws',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Protocol': 'agentkit.personal-assistant.desktop.v1',
        authorization: `Bearer ${RUNTIME_TOKEN}`,
      },
    });
    req.once('error', reject);
    req.once('response', response => { response.resume(); resolve({ status: response.statusCode }); });
    req.once('upgrade', (response, socket) => {
      const messages = [];
      let buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          let size = buffer[1] & 0x7f; let offset = 2;
          if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
          else if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + size) return;
          const payload = Buffer.from(buffer.subarray(offset, offset + size));
          buffer = buffer.subarray(offset + size);
          if (opcode === 1) messages.push({ payload, value: JSON.parse(payload.toString('utf8')) });
        }
      });
      const next = async predicate => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const frame = messages.find(item => predicate(item.value));
          if (frame) return frame;
          await sleep(5);
        }
        throw new Error(`WebSocket response timed out; saw ${JSON.stringify(messages.map(item => item.value))}`);
      };
      resolve({ status: response.statusCode, socket, messages, next, send: value => socket.write(encodeFrame(value)) });
    });
    req.end();
  });
}

/**
 * 真实 desktop-session + 假 xclip 二进制。
 * 只把 `xclip` 换成落盘脚本；Xvfb/Fluxbox/xdpyinfo/xprop/locale 全部走注入夹具，
 * 不碰真实 X11，也不会污染开发机剪贴板。
 */
async function clipboardFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentkit-clip-fidelity-'));
  const state = join(root, 'state');
  await mkdir(state);
  const script = join(root, 'xclip');
  await writeFile(script, FAKE_XCLIP, { mode: 0o755 });
  const clipboardBytes = async () => { try { return await readFile(join(state, 'clip.bin')); } catch { return Buffer.alloc(0); } };
  const setClipboard = bytes => writeFile(join(state, 'clip.bin'), bytes);
  const setTargets = targets => writeFile(join(state, 'targets.txt'), `${targets.join('\n')}\n`);
  const clipboardSpawns = [];
  const spawn = (file, args, options) => {
    if (file !== 'xclip') return fakeProcess();
    clipboardSpawns.push(args);
    return spawnChild(script, args, { ...options, env: { ...options?.env, CLIP_STATE_DIR: state } });
  };
  const exec = async (file, args, options) => {
    if (file === 'xclip') return execFileAsync(script, args, { ...options, env: { ...options?.env, CLIP_STATE_DIR: state } });
    if (file === 'locale') return { stdout: LOCALES };
    if (file === 'xprop') return { stdout: readyWindowProperties };
    return { stdout: '' };
  };
  const controller = createDesktopController({ display: ':99', terminal: false, applications: false, spawn, exec, readWindowBindings: async () => '' });
  t.after(async () => { await controller.dispose(); await rm(root, { recursive: true, force: true }); });
  return { controller, clipboardBytes, setClipboard, setTargets, clipboardSpawns };
}

/** 真实 agentd + 真实 desktop-ws；中间的 broker 只承担「注入 identity」这一步（真实部署由 broker 服务做）。 */
async function cloudFixture(t) {
  const local = await clipboardFixture(t);
  const service = createComputerAgentServer({
    env: { USER_ID: 'u', ASSISTANT_ID: 'a', COMPUTER_ID: 'c', COMPUTER_HOST: '127.0.0.1', COMPUTER_PORT: '0', AGENTKIT_DESKTOP_MODE: '1' },
    desktopFactory: () => local.controller,
    browserFactory: () => ({ available: true, openDesktopWindow: async () => ({}), close: async () => {}, dispose: async () => {} }),
    logger: { info() {}, error() {} },
  });
  service.listen();
  await once(service.server, 'listening');
  await service.whenReady;
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const identity = { userId: 'u', assistantId: 'a', computerId: 'c' };
  const brokerBodies = [];
  const brokerDesktopRequest = async (path, body) => {
    // 这里就是「面板 WS 消息 → broker HTTP 请求体」这一跳：抓下真实发出去的字节。
    const payload = JSON.stringify({ ...identity, ...body });
    brokerBodies.push({ path, bytes: Buffer.from(payload, 'utf8') });
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value?.message || value?.error || 'broker request failed'), { code: value?.error, status: response.status });
    return value;
  };
  const server = createServer();
  attachDesktopWebSocket({
    server, runtimeToken: RUNTIME_TOKEN, assistantId: 'ar-test', env: {},
    botIdOf: value => value || 'b1', taskIdOf: value => value || 't1',
    brokerDesktopRequest,
    brokerDesktopFrameBinary: async () => ({ unchanged: true, seq: 0, width: 1280, height: 800 }),
    listBots: () => [],
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = await connect(server.address().port);
  t.after(() => client.socket?.destroy());
  assert.equal(client.status, 101, 'WS 必须完成 upgrade');
  const open = async () => {
    client.send({ type: 'open', botId: 'writer', taskId: 'task-1', mode: 'control' });
    await client.next(value => value.type === 'ready');
  };
  return { ...local, client, brokerBodies, open };
}

const SAMPLES = Object.freeze([
  '中文复制粘贴',
  '混合 English 中文 😀🚀 → ✓',
  '四字节 𐍈 𝕏 𠀀',
  '组合字符 á ñ e\u0301',
  'ASCII <>&"\\ 制表\t换行\n结尾',
]);

test('desktop-session → xclip 双向：中文/emoji/四字节/组合字符的 stdin 字节与 UTF-8 编码逐字节一致', async t => {
  const { controller, clipboardBytes } = await clipboardFixture(t);
  for (const sample of SAMPLES) {
    const expected = utf8Bytes(sample);
    assert.deepEqual(await controller.writeClipboard(sample), { written: true });
    assert.equal((await clipboardBytes()).toString('hex'), expected.toString('hex'), `写入「${sample}」时 xclip stdin 字节必须与 UTF-8 编码一致`);
    assert.equal(await controller.readClipboard(), sample, `读回「${sample}」必须一字不差`);
    assert.deepEqual(controller.stats().clipboard.write, { bytes: expected.length, target: 'UTF8_STRING' });
    assert.deepEqual(controller.stats().clipboard.read, { bytes: expected.length, encoding: 'utf8', target: 'UTF8_STRING' });
  }
  assert.ok(controller.stats().clipboard.read.bytes > 0);
});

test('desktop-session ← xclip：来源应用只提供 STRING/GBK 时还原中文，不再产生 U+FFFD', async t => {
  const { controller, setClipboard, setTargets } = await clipboardFixture(t);
  await setTargets(['TARGETS', 'STRING']);
  await setClipboard(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); // GBK「中文」
  assert.equal(await controller.readClipboard(), '中文');
  const read = controller.stats().clipboard.read;
  assert.equal(read.encoding, 'gb18030');
  assert.equal(read.target, 'STRING');
  assert.deepEqual([...read.targets], ['TARGETS', 'STRING']);
  assert.equal(read.bytes, 4);
  assert.equal((await controller.readClipboard()).includes('\uFFFD'), false, '中文读回不能再出现替换字符');
  await setClipboard(Buffer.from([0x63, 0x61, 0x66, 0xe9])); // latin1「café」
  assert.equal(await controller.readClipboard(), 'café');
  assert.equal(controller.stats().clipboard.read.encoding, 'latin1');
});

test('WS→HTTP→agentd→desktop 全链路：写方向每一跳字节一致，读方向原样回到面板', async t => {
  const fx = await cloudFixture(t);
  await fx.open();
  const sample = '中文复制粘贴 😀 𐍈 → 云电脑';
  const expected = utf8Bytes(sample);
  const message = { type: 'clipboard.write', requestId: 'clip-write-bytes', text: sample };
  const requestFrame = encodeFrame(message);
  // 面板 send() 走 JSON.stringify：中文必须以原始 UTF-8 字节出现，不能变成 \uXXXX 转义。
  assert.ok(Buffer.from(JSON.stringify(message), 'utf8').includes(expected), 'JSON 序列化必须保留原始 UTF-8 字节');
  fx.client.socket.write(requestFrame);
  const response = await fx.client.next(value => value.type === 'clipboard.response' && value.requestId === 'clip-write-bytes');
  assert.equal(response.value.value?.written, true, response.payload.toString());
  // 跳 1：broker HTTP 请求体
  const actionBody = fx.brokerBodies.filter(item => item.path === '/broker/action').at(-1);
  const parsed = JSON.parse(actionBody.bytes.toString('utf8'));
  assert.equal(parsed.action, 'clipboard.write');
  assert.equal(parsed.args.text, sample);
  assert.equal(utf8Bytes(parsed.args.text).toString('hex'), expected.toString('hex'));
  assert.ok(actionBody.bytes.includes(expected), 'HTTP body 里必须是 UTF-8 字节而不是 \\u 转义');
  // 跳 2：agentd 写入 desktop-session 后，xclip stdin 落盘的字节
  assert.equal((await fx.clipboardBytes()).toString('hex'), expected.toString('hex'));
  // 读方向：xclip 里的字节 → 面板响应帧
  const readFrame = await (async () => {
    fx.client.send({ type: 'clipboard.read', requestId: 'clip-read-bytes' });
    return fx.client.next(value => value.type === 'clipboard.response' && value.requestId === 'clip-read-bytes');
  })();
  assert.equal(readFrame.value.value.text, sample);
  assert.equal(utf8Bytes(readFrame.value.value.text).toString('hex'), expected.toString('hex'));
  assert.ok(readFrame.payload.includes(expected), '响应帧里必须出现原始 UTF-8 字节');
  assert.deepEqual(fx.controller.stats().clipboard.read, { bytes: expected.length, encoding: 'utf8', target: 'UTF8_STRING' });
});

test('WS 帧被 TCP 拆成半包（切在汉字 UTF-8 中间）仍按字节还原', async t => {
  const fx = await cloudFixture(t);
  await fx.open();
  const sample = '半包中文测试 😀';
  const message = { type: 'clipboard.write', requestId: 'clip-half', text: sample };
  const frame = encodeFrame(message);
  const jsonBytes = Buffer.from(JSON.stringify(message), 'utf8');
  const payloadIndex = jsonBytes.indexOf(Buffer.from('半', 'utf8'));
  const headerLength = frame.length - jsonBytes.length - 4;
  const cut = headerLength + 4 + payloadIndex + 1;
  assert.ok(payloadIndex > 0 && cut > 2 && cut < frame.length);
  fx.client.socket.write(frame.subarray(0, cut));
  await sleep(20);
  fx.client.socket.write(frame.subarray(cut));
  const response = await fx.client.next(value => value.type === 'clipboard.response' && value.requestId === 'clip-half');
  assert.equal(response.value.value?.written, true, response.payload.toString());
  assert.equal((await fx.clipboardBytes()).toString('hex'), utf8Bytes(sample).toString('hex'));
});

test('WS 客户端把一条 JSON 拆成 FIN=0 + 续帧（分片边界在汉字中间）仍按字节还原', async t => {
  const fx = await cloudFixture(t);
  await fx.open();
  const sample = '分片中文 😀🚀';
  const message = { type: 'clipboard.write', requestId: 'clip-fragment', text: sample };
  const bytes = Buffer.from(JSON.stringify(message), 'utf8');
  const index = bytes.indexOf(Buffer.from('文', 'utf8')) + 1; // 落在「文」的 3 字节中间
  assert.ok(index > 1 && index < bytes.length);
  fx.client.socket.write(encodeFrame(bytes.subarray(0, index), { fin: false, opcode: 1 }));
  await sleep(10);
  fx.client.socket.write(encodeFrame(bytes.subarray(index), { fin: true, opcode: 0 }));
  const response = await fx.client.next(value => value.type === 'clipboard.response' && value.requestId === 'clip-fragment');
  assert.equal(response.value.value?.written, true, response.payload.toString());
  assert.equal((await fx.clipboardBytes()).toString('hex'), utf8Bytes(sample).toString('hex'));
});

test('64 KiB 边界按字节计算：恰好 65536 字节可写入，超 1 字节 413 且不触碰 xclip', async t => {
  const fx = await cloudFixture(t);
  await fx.open();
  const exact = `${'中'.repeat(21845)}a`; // 21845 × 3 + 1 = 65536 字节
  assert.equal(utf8Bytes(exact).length, DESKTOP_CLIPBOARD_MAX_BYTES);
  fx.client.send({ type: 'clipboard.write', requestId: 'clip-exact', text: exact });
  const accepted = await fx.client.next(value => value.requestId === 'clip-exact');
  assert.equal(accepted.value.value?.written, true, accepted.payload.toString());
  assert.equal((await fx.clipboardBytes()).toString('hex'), utf8Bytes(exact).toString('hex'));
  const spawnsBefore = fx.clipboardSpawns.length;
  const httpBefore = fx.brokerBodies.length;
  const oversized = `${exact}b`;
  assert.equal(utf8Bytes(oversized).length, DESKTOP_CLIPBOARD_MAX_BYTES + 1);
  fx.client.send({ type: 'clipboard.write', requestId: 'clip-over', text: oversized });
  const denied = await fx.client.next(value => value.requestId === 'clip-over');
  assert.equal(denied.value.ok, false, denied.payload.toString());
  assert.equal(denied.value.error.code, 'CLIPBOARD_TEXT_TOO_LARGE');
  assert.equal(denied.value.error.status, 413);
  assert.equal(fx.clipboardSpawns.length, spawnsBefore, '超限必须在触碰 xclip 之前拒绝');
  assert.equal(fx.brokerBodies.length, httpBefore, '超限不能发到 broker');
  assert.equal((await fx.clipboardBytes()).toString('hex'), utf8Bytes(exact).toString('hex'), '拒绝后 selection 内容不变');
});

test('全链路读方向：云端应用只给 GBK STRING 时面板拿到中文而不是「����」', async t => {
  const fx = await cloudFixture(t);
  await fx.setTargets(['TARGETS', 'STRING']);
  await fx.setClipboard(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  await fx.open();
  fx.client.send({ type: 'clipboard.read', requestId: 'clip-gbk' });
  const frame = await fx.client.next(value => value.type === 'clipboard.response' && value.requestId === 'clip-gbk');
  assert.equal(frame.value.value?.text, '中文', frame.payload.toString());
  assert.equal(utf8Bytes(frame.value.value.text).toString('hex'), 'e4b8ade69687');
  assert.equal(frame.value.value.text.includes('\uFFFD'), false);
  assert.deepEqual({ ...fx.controller.stats().clipboard.read }, { bytes: 4, encoding: 'gb18030', target: 'STRING', targets: ['TARGETS', 'STRING'] });
});

test('连续两次写入以最后一次为准，旧 owner 被回收且 selection 字节是最新一份', async t => {
  const { controller, clipboardBytes } = await clipboardFixture(t);
  await controller.writeClipboard('第一份 中文');
  await controller.writeClipboard('第二份 😀');
  assert.equal((await clipboardBytes()).toString('hex'), utf8Bytes('第二份 😀').toString('hex'));
  assert.equal(await controller.readClipboard(), '第二份 😀');
});
