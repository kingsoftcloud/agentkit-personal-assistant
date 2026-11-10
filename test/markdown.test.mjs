import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInline, parseMarkdown, renderMarkdown } from '../src/client/markdown.mjs';

test('块解析：标题、列表、代码块与段落', () => {
  const blocks = parseMarkdown([
    '### 今日待办',
    '',
    '- 写周报',
    '- review PR',
    '',
    '1. 第一步',
    '2. 第二步',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '收尾段落第一行',
    '第二行',
  ].join('\n'));
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'unordered', 'ordered', 'code', 'paragraph']);
  assert.equal(blocks[0].level, 3);
  assert.deepEqual(blocks[1].items, ['写周报', 'review PR']);
  assert.deepEqual(blocks[2].items, ['第一步', '第二步']);
  assert.equal(blocks[3].text, 'const a = 1;');
  assert.equal(blocks[3].lang, 'js');
  assert.equal(blocks[4].text, '收尾段落第一行\n第二行');
});

test('块解析：引用、分隔线与未闭合围栏', () => {
  const blocks = parseMarkdown('> 引用一句\n> 第二行\n\n---\n\n```\n没有收尾');
  assert.deepEqual(blocks.map(block => block.type), ['quote', 'rule', 'code']);
  assert.equal(blocks[0].text, '引用一句\n第二行');
  assert.equal(blocks[2].text, '没有收尾');
});

test('块解析：GFM 表格和列对齐', () => {
  const blocks = parseMarkdown([
    '| 项目 | 数量 | 备注 |',
    '| :--- | ---: | :---: |',
    '| **模型** | 2 | `稳定` |',
    '| 浏览器 | 1 | 可用 |',
  ].join('\n'));
  assert.deepEqual(blocks, [{
    type: 'table',
    headers: ['项目', '数量', '备注'],
    alignments: ['left', 'right', 'center'],
    rows: [['**模型**', '2', '`稳定`'], ['浏览器', '1', '可用']],
  }]);
  const escaped = parseMarkdown('| 名称 | 说明 |\n| --- | --- |\n| A\\|B | 保留\\*号 |')[0];
  assert.deepEqual(escaped.rows, [['A|B', '保留\\*号']]);
});

test('行内解析：粗体、斜体、行内代码与链接', () => {
  assert.deepEqual(parseInline('**粗** *斜* `码` [链接](https://example.com)').map(node => node.type), ['strong', 'text', 'em', 'text', 'code', 'text', 'link']);
  const link = parseInline('[文档](https://example.com/a)').find(node => node.type === 'link');
  assert.equal(link.href, 'https://example.com/a');
});

test('行内解析：非 Markdown 文本原样保留', () => {
  assert.deepEqual(parseInline('a * b = 2, 价格 3*4'), [{ type: 'text', text: 'a * b = 2, 价格 3*4' }]);
});

test('渲染：把块映射成元素树，链接带安全属性', () => {
  const h = (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.flat() });
  const tree = renderMarkdown(h, '**重点**\n\n```\ncode\n```\n\n[外链](https://example.com)', {});
  assert.deepEqual(tree.map(node => node.tag), ['p', 'pre', 'p']);
  const link = tree[2].children.find(node => node.tag === 'a');
  assert.equal(link.props.href, 'https://example.com');
  assert.equal(link.props.rel, 'noreferrer noopener');
  assert.equal(link.props.target, '_blank');
});

test('渲染：表格使用 thead/tbody，并在单元格中保留行内 Markdown', () => {
  const h = (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.flat() });
  const tree = renderMarkdown(h, '| 项目 | 结果 |\n| --- | :---: |\n| **模型** | `通过` |', {});
  assert.equal(tree[0].tag, 'div');
  assert.equal(tree[0].children[0].tag, 'table');
  const table = tree[0].children[0];
  assert.equal(table.children[0].tag, 'thead');
  assert.equal(table.children[1].tag, 'tbody');
  assert.equal(table.children[0].children[0].children[1].props.style.textAlign, 'center');
  assert.equal(table.children[1].children[0].children[0].children[0].tag, 'strong');
  assert.equal(table.children[1].children[0].children[1].children[0].tag, 'code');
});
