/**
 * 中文剪贴板乱码的单元回归：解码链、locale 选择、selection target 约束、Host 侧参数。
 *
 * 这些用例不依赖 X11 / 系统剪贴板，覆盖字节级夹具（clipboard-utf8-fidelity.test.mjs）
 * 不方便覆盖的分支：镜像 locale 缺失、String target 语义、Windows PowerShell 传参。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import {
  DESKTOP_CLIPBOARD_MAX_BYTES,
  DESKTOP_CLIPBOARD_TARGET,
  clipboardOwnerArgs,
  createDesktopController,
  decodeClipboardBuffer,
  pickDesktopLocale,
  utf8Bytes,
} from '../runtime/desktop-session.mjs';
import { createPersonalAssistantHostGateway, decodeClipboardBytes, windowsClipboardReadArgs, windowsClipboardWriteArgs } from '../src/host-gateway.mjs';

const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // GBK「中文」
const LATIN1_CAFE = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // latin1「café」

test('selection 字节按 UTF-8 → GB18030 → latin1 解码：非 UTF-8 中文不再变成 U+FFFD', () => {
  const valid = decodeClipboardBuffer(utf8Bytes('中文 😀 𐍈'));
  assert.equal(valid.text, '中文 😀 𐍈');
  assert.equal(valid.encoding, 'utf8');
  // 旧实现 Buffer.toString('utf8') 的结果：4 个替换字符，原文不可恢复——这就是用户看到的「����」。
  assert.equal(Buffer.from(GBK_ZHONGWEN).toString('utf8'), '����');
  const gbk = decodeClipboardBuffer(GBK_ZHONGWEN);
  assert.equal(gbk.text, '中文');
  assert.equal(gbk.encoding, 'gb18030');
  const latin1 = decodeClipboardBuffer(LATIN1_CAFE);
  assert.equal(latin1.text, 'café');
  assert.equal(latin1.encoding, 'latin1');
  const junk = decodeClipboardBuffer(Buffer.from([0xff, 0xff, 0x81]));
  assert.equal(junk.encoding, 'latin1');
  assert.equal(junk.text.includes('\uFFFD'), false, '兜底解码也不能产生替换字符');
  assert.equal(decodeClipboardBuffer(Buffer.alloc(0)).text, '');
  // BOM 是正文，不能被解码器吞掉（与 Buffer.toString('utf8') 行为一致）。
  assert.equal(decodeClipboardBuffer(utf8Bytes('\uFEFF中文')).text, '\uFEFF中文');
});

test('locale 探测：有 zh_CN.UTF-8 用中文，没有就退回 C.UTF-8，绝不写死不存在的 locale', () => {
  assert.deepEqual({ ...pickDesktopLocale(['C', 'C.utf8', 'POSIX', 'en_US.utf8', 'zh_CN.utf8']) }, { locale: 'zh_CN.UTF-8', source: 'zh_CN' });
  assert.deepEqual({ ...pickDesktopLocale(['C', 'C.UTF-8', 'POSIX']) }, { locale: 'C.UTF-8', source: 'C.UTF-8' });
  assert.deepEqual({ ...pickDesktopLocale(['C', 'POSIX', 'en_US.utf8']) }, { locale: 'en_US.utf8', source: 'utf8-fallback' });
  // 镜像只有 ASCII locale：保持原假设（与改动前一致），并标记 missing 供排障定位。
  assert.deepEqual({ ...pickDesktopLocale(['C', 'POSIX']) }, { locale: 'zh_CN.UTF-8', source: 'missing' });
  // 探测不到（没有 locale 命令/输出为空）时不能擅自换掉用户环境。
  assert.deepEqual({ ...pickDesktopLocale([]) }, { locale: 'zh_CN.UTF-8', source: 'assumed' });
  assert.deepEqual({ ...pickDesktopLocale(['', '  ']) }, { locale: 'zh_CN.UTF-8', source: 'assumed' });
});

test('selection owner 只提供一个 UTF8_STRING target：不使用逗号列表或 0.13 不存在的 -alt-text', () => {
  assert.equal(DESKTOP_CLIPBOARD_TARGET, 'UTF8_STRING');
  for (const display of [':99', ':0.0']) {
    const args = clipboardOwnerArgs(display);
    assert.equal(args.filter(value => value === '-target').length, 1);
    assert.equal(args[args.indexOf('-target') + 1], 'UTF8_STRING');
    // xclip 的 -target 是单个 X atom 名：'UTF8_STRING,STRING' 会被 XInternAtom 当成一个
    // 不存在的 atom 创建，TARGETS 里只剩这个名字，所有应用粘贴静默失效。
    assert.equal(args.some(value => value.includes(',')), false);
    // -alt-text 只在 xclip git master 存在，镜像里的 0.13 会直接报错退出。
    assert.equal(args.includes('-alt-text'), false);
    assert.equal(args.includes('-quiet'), true);
    assert.equal(args.includes(display), true);
  }
});

test('Host 本机剪贴板字节同样按 UTF-8 → GB18030 → latin1 解码', () => {
  assert.equal(decodeClipboardBytes(GBK_ZHONGWEN), '中文');
  assert.equal(decodeClipboardBytes(LATIN1_CAFE), 'café');
  assert.equal(decodeClipboardBytes('已经是字符串'), '已经是字符串');
  assert.equal(decodeClipboardBytes(Buffer.from([0xff, 0xff])).includes('\uFFFD'), false);
  assert.equal(decodeClipboardBytes(Buffer.alloc(0)), '');
  assert.equal(decodeClipboardBytes(undefined), '');
});

test('Host 读取本机剪贴板用 encoding:buffer，GBK 字节还原成中文而不是 U+FFFD', async () => {
  const seen = [];
  const gateway = createPersonalAssistantHostGateway(
    { gatewayUrl: 'https://gateway.example/', agentId: 'ar-real', apiKey: 'host-only-secret' },
    { env: {}, clipboardExecFile: async (file, args, options) => { seen.push({ file, args, options }); return { stdout: GBK_ZHONGWEN }; } },
  );
  assert.deepEqual(await gateway.request('personal-assistant.clipboard.read'), { text: '中文' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.encoding, 'buffer', '必须以原始字节读取，不能默认 utf8 硬解');
});

test('Windows 剪贴板命令不再拼接字符串：UTF-16LE base64 传参 + 单引号转义', () => {
  const value = "中文 it's $HOME `tick` \"quoted\"";
  const args = windowsClipboardWriteArgs(value);
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(args.length, 4);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.equal(script, "Set-Clipboard -Value '中文 it''s $HOME `tick` \"quoted\"'");
  // base64 里不可能出现中文：中文没有经过任何 shell 解析。
  assert.equal(args[3].includes('中'), false);
  const readArgs = windowsClipboardReadArgs();
  assert.ok(readArgs.includes('-Command'));
  assert.match(String(readArgs.at(-1)), /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/u);
  assert.match(String(readArgs.at(-1)), /Get-Clipboard -Raw/u);
});

test('64 KiB 口径在字节层把中文算作 3 字节，面板/云端/Host 三处常量一致', () => {
  assert.equal(DESKTOP_CLIPBOARD_MAX_BYTES, 64 * 1024);
  assert.equal(utf8Bytes('中').length, 3);
  assert.equal(utf8Bytes('😀').length, 4);
  assert.equal(Buffer.byteLength('a'.repeat(DESKTOP_CLIPBOARD_MAX_BYTES), 'utf8'), DESKTOP_CLIPBOARD_MAX_BYTES);
  assert.ok(Buffer.byteLength('中'.repeat(Math.ceil(DESKTOP_CLIPBOARD_MAX_BYTES / 3)), 'utf8') > DESKTOP_CLIPBOARD_MAX_BYTES);
});

const readyWindowProperties = '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400001\n_NET_ACTIVE_WINDOW(WINDOW): window id # 0x800002\n';
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

const desktopController = localeOutput => {
  const environments = [];
  const controller = createDesktopController({
    display: ':99', terminal: false, applications: false,
    spawn(file, args, options) { environments.push({ file, env: options?.env }); return fakeProcess(); },
    exec: async file => {
      if (file === 'locale') return localeOutput();
      if (file === 'xprop') return { stdout: readyWindowProperties };
      return { stdout: '' };
    },
    readWindowBindings: async () => '',
  });
  return { controller, environments };
};

test('镜像缺 zh_CN.UTF-8 时桌面子进程改用 C.UTF-8，且显式锁定 LC_CTYPE、保留中文翻译', async () => {
  const { controller, environments } = desktopController(() => ({ stdout: 'C\nC.utf8\nPOSIX\n' }));
  try {
    await controller.ensureDisplay();
    assert.ok(environments.length >= 2, '至少拉起 Xvfb 与窗口管理器');
    for (const { file, env } of environments) {
      assert.equal(env.LANG, 'C.UTF-8', `${file} 必须使用镜像里真实存在的 UTF-8 locale`);
      assert.equal(env.LC_CTYPE, 'C.UTF-8', `${file} 必须显式锁定字符集，不能被继承的 LC_CTYPE 覆盖`);
      assert.equal(env.LANGUAGE, 'zh_CN:zh', '界面翻译仍保留中文');
      assert.equal(env.LC_ALL, undefined);
    }
    assert.equal(controller.stats().locale, 'C.UTF-8');
    assert.equal(controller.stats().localeSource, 'C.UTF-8');
    assert.equal((await controller.openSession({ identity: {} })).locale, 'C.UTF-8');
  } finally { await controller.dispose(); }
});

test('镜像有 zh_CN.UTF-8 时保持中文 locale；locale 探测失败则维持原假设', async () => {
  const zh = desktopController(() => ({ stdout: 'C\nC.utf8\nPOSIX\nzh_CN.utf8\n' }));
  try {
    await zh.controller.ensureDisplay();
    assert.equal(zh.controller.stats().locale, 'zh_CN.UTF-8');
    assert.equal(zh.controller.stats().localeSource, 'zh_CN');
    assert.equal(zh.environments[0].env.LANG, 'zh_CN.UTF-8');
    assert.equal(zh.environments[0].env.LC_CTYPE, 'zh_CN.UTF-8');
  } finally { await zh.controller.dispose(); }
  const unknown = desktopController(() => { throw Object.assign(new Error('spawn locale ENOENT'), { code: 'ENOENT' }); });
  try {
    await unknown.controller.ensureDisplay();
    assert.equal(unknown.controller.stats().locale, 'zh_CN.UTF-8', '探测失败不能擅自改变用户环境');
    assert.equal(unknown.controller.stats().localeSource, 'assumed');
  } finally { await unknown.controller.dispose(); }
});
