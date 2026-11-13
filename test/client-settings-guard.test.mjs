import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSettings } from '../src/client/views/settings.mjs';

/** 极简 h：只要够渲染纯视图树，便于按 props 断言。 */
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) });

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}

const modelSelect = tree => findAll(tree, node => node.props?.['aria-label'] === '模型')[0];

/** 收集整棵视图树里的文本（含 props 里的说明文案）。 */
function textOf(node, parts = []) {
  if (node === null || node === undefined || node === false) return parts;
  if (typeof node === 'string' || typeof node === 'number') { parts.push(String(node)); return parts; }
  if (typeof node !== 'object') return parts;
  for (const child of node.children || []) textOf(child, parts);
  return parts;
}

test('旧版 Host 实例（recordSource=missing）在设置页保持只读，并给出说明', () => {
  const tree = renderSettings({
    h,
    inspect: { recordSource: 'missing', status: 'RUNNING' },
    instance: { configured: true, status: '运行中' },
    draft: { model: 'deepseek-v4.1-flash-1017', prompt: '' },
  });
  const select = modelSelect(tree);
  assert.ok(select, '设置页必须渲染模型选择器');
  assert.equal(select.props.disabled, true, '没有 Host 配置清单时不能在线修改模型');
  assert.match(textOf(tree).join(''), /旧版 DSH Host/u, '必须提示只读原因');
});

test('Host 写下的配置清单（recordSource=host）可以编辑', () => {
  const tree = renderSettings({
    h,
    inspect: { recordSource: 'host', status: 'RUNNING' },
    instance: { configured: true, status: '运行中' },
    draft: { model: 'deepseek-v4.1-flash-1017', prompt: '' },
    modelOptions: [{ value: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1' }],
  });
  assert.equal(modelSelect(tree)?.props.disabled, false, 'recordSource=host 时应当可编辑');
});

test('保存设置的提示文案（notice）必须渲染出来', () => {
  const notice = '已提交云端更新，通常 1–2 分钟完成，期间云电脑可能短暂重连。';
  const tree = renderSettings({
    h,
    inspect: { recordSource: 'host', status: 'RUNNING' },
    instance: { configured: true },
    draft: { model: '', prompt: '' },
    notice,
  });
  const statusTexts = findAll(tree, node => node.props?.role === 'status' || node.props?.role === 'alert')
    .map(node => textOf(node).join(''))
    .join('\n');
  assert.match(statusTexts, /已提交云端更新/u, 'notice 不能被丢弃，否则保存成功后没有任何反馈');
});
