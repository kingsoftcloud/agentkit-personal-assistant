/**
 * 助理正文渲染：有宿主原生 MarkdownText 时走原生，没有时退回自带解析器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAssistantBody } from '../src/client/conversation.mjs';

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });

test('宿主提供 MarkdownText 时用原生渲染，并带上代码块/脚注文案', () => {
  const MarkdownText = function MarkdownText() {};
  const source = '| # | 仓库 |\n| - | - |\n| 1 | dsh |';
  const tree = renderAssistantBody(h, source, {}, { MarkdownText });
  assert.equal(tree.type, MarkdownText);
  assert.equal(tree.props.text, source);
  assert.deepEqual(tree.props.labels.code.toolbarLabels, { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' });
  assert.equal(tree.props.labels.code.copyLabel, '复制');
  assert.equal(tree.props.labels.footnotes, '脚注');
});

test('宿主没有原生渲染器时退回自带解析，表格按原样文本、不抛错', () => {
  const tree = renderAssistantBody(h, '**重点**\n\n- 一\n- 二', {}, undefined);
  assert.ok(Array.isArray(tree));
  assert.deepEqual(tree.map(node => node.type), ['p', 'ul']);
});

test('模块存在但没导出 MarkdownText 时同样退回自带解析', () => {
  const tree = renderAssistantBody(h, '普通正文', {}, {});
  assert.ok(Array.isArray(tree));
  assert.deepEqual(tree.map(node => node.type), ['p']);
});

test('空正文不渲染空原生块，退回省略号', () => {
  assert.equal(renderAssistantBody(h, '', {}, undefined), '…');
  const tree = renderAssistantBody(h, '', {}, { MarkdownText: function MarkdownText() {} });
  assert.equal(tree.props.text, '');
});
