import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopTool } from '../src/desktop-tools.mjs';
import { createWorkspaceTool } from '../src/workspace-tools.mjs';
import { registerAutomationTools } from '../src/automation-tools.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('桌面工具返回实际模型图片附件，文本模型在取帧前明确拒绝', async () => {
  const calls = [], saved = [];
  const image = { attachmentId: 'att-test', mediaType: 'image/jpeg', bytes: 3, width: 1280, height: 800 };
  let modalities = ['text'];
  const agent = { options: { provider: 'cloud', model: 'chosen' }, ctx: { get: name => name === 'attachments' ? {
    saveImage: async value => { saved.push(value); return image; },
  } : { resolveModelInfo: async (provider, model) => { assert.equal(provider, 'cloud'); assert.equal(model, 'chosen'); return { inputModalities: modalities }; } } } };
  const tool = createDesktopTool({ agent, action: async (...args) => { calls.push(args); return { image: { ...image, data: Buffer.from([1, 2, 3]).toString('base64') } }; } });
  await assert.rejects(tool.execute({ action: 'screenshot' }), /不支持图片/);
  assert.equal(calls.length, 0);
  modalities = ['text', 'image'];
  const value = await tool.execute({ action: 'screenshot' });
  assert.deepEqual(saved[0].data, Buffer.from([1, 2, 3]));
  assert.deepEqual(tool.output.render({}, value).at(-1), { type: 'image', attachment: image });
  assert.equal(calls[0][0], 'desktop.capture');
});

test('工作区文件内容作为数据传入，中文与引号不改变程序，拒绝路径越界', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-workspace-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const tool = createWorkspaceTool({ action: async (name, args) => {
    calls.push(name);
    const result = spawnSync('python3', ['-c', args.code], { cwd: root, encoding: 'utf8' });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  } });
  const text = "你好 😀 '); import os; raise Exception('not code')";
  await tool.execute({ action: 'write', path: 'skills/demo/SKILL.md', text });
  assert.equal(JSON.parse((await tool.execute({ action: 'read', path: 'skills/demo/SKILL.md' })).result).text, text);
  assert.deepEqual(JSON.parse((await tool.execute({ action: 'skills' })).result).skills, ['skills/demo/SKILL.md']);
  await assert.rejects(tool.execute({ action: 'read', path: '../../private' }), /workspace/);
  assert.equal(calls.length, 3);
});

test('日程工具固定 Bot 归属，拒绝未声明时区，并调用真实调度服务适配器', async () => {
  let tool, received;
  registerAutomationTools({ agent: { ctx: { get: () => ({ register: value => { tool = value; } }) } }, botId: 'owner', service: () => async value => { received = value; return { accepted: true }; } });
  await assert.rejects(tool.execute({ action: 'create', runAt: '2026-10-27T12:00:00', input: 'task' }), /timezone/);
  await tool.execute({ action: 'create', runAt: '2026-10-27T12:00:00+08:00', input: 'task', botId: 'other' });
  assert.equal(received.botId, 'owner');
  assert.equal(received.runAt, Date.parse('2026-10-27T04:00:00Z'));
});

test('拖拽中途失败仍释放按钮，非法坐标不发送输入', async () => {
  const events = [];
  const tool = createDesktopTool({ action: async (_name, { event }) => {
    events.push(event);
    if (event.type === 'pointermove' && event.x === 200) throw new Error('interrupted');
    return { accepted: true };
  } });
  await assert.rejects(tool.execute({ action: 'click', x: 1280, y: 0 }), /coordinates/);
  assert.equal(events.length, 0);
  await assert.rejects(tool.execute({ action: 'drag', x: 100, y: 100, toX: 200, toY: 200 }), /interrupted/);
  assert.deepEqual(events.at(-1), { type: 'button', button: 1, action: 'up' });
});
