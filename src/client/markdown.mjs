/**
 * 极简 Markdown 渲染：只覆盖模型回答里真正常见的语法，不引入第三方依赖。
 *
 * 支持：围栏代码块、行内代码、粗体、斜体、链接、无序/有序列表、引用、标题、
 * 分隔线、段落内换行。已知限制：不解析表格、嵌套列表、HTML（一律按文本转义显示）。
 */

const FENCE = /^```\s*([\w+#.-]*)\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const UL = /^\s*[-*+]\s+(.*)$/u;
const OL = /^\s*(\d{1,3})[.)]\s+(.*)$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/u;

/** 把 Markdown 源码切成块；纯函数，方便单测。 */
export function parseMarkdown(source) {
  const text = typeof source === 'string' ? source.replace(/\r\n?/gu, '\n') : '';
  const lines = text.split('\n');
  const blocks = [];
  let index = 0;
  const flushParagraph = buffer => {
    if (buffer.length === 0) return;
    blocks.push({ type: 'paragraph', text: buffer.join('\n') });
    buffer.length = 0;
  };
  const paragraph = [];
  while (index < lines.length) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const body = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index])) { body.push(lines[index]); index += 1; }
      index += 1; // 跳过收尾围栏（缺失时按到文末处理）
      blocks.push({ type: 'code', lang: fence[1] || '', text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') { flushParagraph(paragraph); index += 1; continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1; continue;
    }
    if (RULE.test(line)) { flushParagraph(paragraph); blocks.push({ type: 'rule' }); index += 1; continue; }
    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph(paragraph);
      const body = [quote[1]];
      index += 1;
      while (index < lines.length && QUOTE.test(lines[index])) { body.push(QUOTE.exec(lines[index])[1]); index += 1; }
      blocks.push({ type: 'quote', text: body.join('\n') });
      continue;
    }
    const bullet = UL.exec(line), ordered = OL.exec(line);
    if (bullet || ordered) {
      flushParagraph(paragraph);
      const list = { type: ordered ? 'ordered' : 'unordered', items: [], start: ordered ? Number(ordered[1]) : 1 };
      while (index < lines.length) {
        const current = UL.exec(lines[index]), numbered = OL.exec(lines[index]);
        if (!current && !numbered) break;
        list.items.push((current ? current[1] : numbered[2]).trim());
        index += 1;
      }
      blocks.push(list);
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph(paragraph);
  return blocks;
}

/** 行内语法：先按转义字符切分，再逐段套用 `code` / **bold** / *italic* / [text](url)。 */
export function parseInline(source) {
  const text = typeof source === 'string' ? source : '';
  const nodes = [];
  const pushText = value => { if (value) nodes.push({ type: 'text', text: value }); };
  let rest = text;
  while (rest.length > 0) {
    const code = /^`([^`]+)`/u.exec(rest);
    if (code) { nodes.push({ type: 'code', text: code[1] }); rest = rest.slice(code[0].length); continue; }
    const bold = /^\*\*([^*\n]+)\*\*/u.exec(rest) || /^__([^_\n]+)__/u.exec(rest);
    if (bold) { nodes.push({ type: 'strong', text: bold[1] }); rest = rest.slice(bold[0].length); continue; }
    const italic = /^\*([^*\s][^*\n]*)\*/u.exec(rest) || /^_([^_\s][^_\n]*)_/u.exec(rest);
    if (italic) { nodes.push({ type: 'em', text: italic[1] }); rest = rest.slice(italic[0].length); continue; }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/u.exec(rest);
    if (link) { nodes.push({ type: 'link', text: link[1], href: link[2] }); rest = rest.slice(link[0].length); continue; }
    const next = rest.slice(1).search(/[`*_[\]\n]/u);
    const take = next < 0 ? rest.length : next + 1;
    pushText(rest.slice(0, take));
    rest = rest.slice(take);
  }
  // 相邻纯文本合并，避免不成对的 * / _ 被切成多个片段（渲染结果等价，便于断言与调试）。
  return nodes.reduce((merged, node) => {
    const last = merged[merged.length - 1];
    if (node.type === 'text' && last && last.type === 'text') merged[merged.length - 1] = { type: 'text', text: last.text + node.text };
    else merged.push(node);
    return merged;
  }, []);
}

/** 渲染为 React 元素树；`h` 是 createElement，`styles` 由视图传入。 */
export function renderMarkdown(h, source, styles = {}) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return null;
  const inline = (text, keyPrefix) => parseInline(text).map((node, order) => {
    const key = `${keyPrefix}-i${order}`;
    if (node.type === 'code') return h('code', { key, style: styles.inlineCode }, node.text);
    if (node.type === 'strong') return h('strong', { key }, node.text);
    if (node.type === 'em') return h('em', { key }, node.text);
    if (node.type === 'link') return h('a', { key, href: node.href, target: '_blank', rel: 'noreferrer noopener', style: styles.link }, node.text);
    return h('span', { key }, node.text);
  });
  return blocks.map((block, order) => {
    const key = `b${order}`;
    if (block.type === 'code') return h('pre', { key, style: styles.codeBlock }, h('code', null, block.text));
    if (block.type === 'heading') return h('div', { key, style: { ...styles.heading, ...(block.level <= 2 ? styles.headingStrong : null) } }, inline(block.text, key));
    if (block.type === 'rule') return h('hr', { key, style: styles.rule });
    if (block.type === 'quote') return h('blockquote', { key, style: styles.quote }, inline(block.text, key));
    if (block.type === 'unordered' || block.type === 'ordered') {
      const tag = block.type === 'ordered' ? 'ol' : 'ul';
      return h(tag, { key, style: styles.list, start: block.type === 'ordered' && block.start !== 1 ? block.start : undefined },
        block.items.map((item, position) => h('li', { key: `${key}-l${position}` }, inline(item, `${key}-l${position}`))));
    }
    return h('p', { key, style: styles.paragraph }, inline(block.text, key));
  });
}
