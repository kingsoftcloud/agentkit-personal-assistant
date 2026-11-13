/**
 * 个人助理面板的公共视图件（按重新设计 DEMO / 设计规范）。
 *
 * 约定：
 * - 本文件与同目录的视图文件都是纯函数：`renderXxx({ h, ... })` 只返回 vnode；
 *   不发请求、不读写 localStorage、不持有状态，数据与回调统一由 index.mjs 注入。
 * - 样式只用 theme.mjs 里的 pa-* 类名；颜色/字号/圆角统一在那里定义。
 */

import { cx, icon } from './theme.mjs';

export { cx, icon };

/** 旧视图/测试仍引用的颜色常量：保留给 index.mjs 的少数内联场景。 */
export const TOKENS = Object.freeze({
  ink: 'var(--pa-ink)', inkSoft: 'var(--pa-ink-2)', inkMuted: 'var(--pa-ink-3)', inkFaint: 'var(--pa-ink-4)',
  border: 'var(--pa-line)', divider: 'var(--pa-line-soft)', surface: 'var(--pa-bg)', surface2: 'var(--pa-fill-1)', surface3: 'var(--pa-bg-sunken)', subtle: 'var(--pa-fill-1)',
  success: 'var(--pa-ok)', warn: 'var(--pa-warn)', danger: 'var(--pa-danger)', accent: 'var(--pa-accent)',
  skeleton: 'var(--pa-fill-2)', skeletonStrong: 'var(--pa-ink-4)', avatarSoft: 'var(--pa-accent-soft)', avatarInk: 'var(--pa-accent)',
});

/** 三态圆点的唯一判定口径：连接不等于授权。 */
export function connectionStateOf(connection) {
  const connected = connection?.connected === true;
  const authorized = connection?.authorized === true;
  if (!connected) return 'offline';
  return authorized ? 'authorized' : 'connected';
}

export const CONNECTION_COPY = Object.freeze({ authorized: '本机已授权', connected: '本机未授权', offline: '本机未连接' });
const CONNECTION_TITLE = Object.freeze({
  authorized: '本机已授权，点击查看授权范围或取消授权',
  connected: '本机已连接但未授权，点击请求授权',
  offline: '本机未连接，点击重新检查连接',
});
const CONNECTION_TONE = Object.freeze({ authorized: 'ok', connected: 'warn', offline: '' });

export function dotGlyph({ h, tone = '', pulse = false }) {
  const cls = tone === 'success' ? 'ok' : tone === 'muted' || tone === 'neutral' ? '' : tone;
  return h('i', { 'aria-hidden': 'true', className: cx('pa-dot', cls, pulse && 'pulse') });
}

/** 页头右侧的本机状态 chip（三态圆点 + 文案），点击打开本机授权弹层。 */
export function connectionDot({ h, connection = null, onOpen = null, open = false, showLabel = true }) {
  const state = connectionStateOf(connection);
  return h('button', {
    type: 'button', className: 'pa-chip', 'data-connection-dot': state, 'aria-expanded': open ? 'true' : 'false',
    title: CONNECTION_TITLE[state], 'aria-label': CONNECTION_COPY[state], onClick: onOpen || undefined, 'data-window-drag-recall': '',
  }, dotGlyph({ h, tone: CONNECTION_TONE[state] }), showLabel ? h('span', { className: 'pa-hide-narrow' }, CONNECTION_COPY[state]) : null);
}

const BUTTON_CLASS = { primary: 'pa-btn-primary', secondary: 'pa-btn-secondary', ghost: 'pa-btn-ghost', danger: 'pa-btn-danger', dangerFill: 'pa-btn-danger-fill', subtle: 'pa-btn-secondary' };

export function button({ h, label = '', onClick = null, variant = 'secondary', size = '', disabled = false, busy = false, busyLabel = '处理中…', icon: leading = null, title = '', ariaLabel = '', type = 'button', className = '', pressed = null, ...rest }) {
  if (variant === 'link') return link({ h, label, onClick, disabled, title, ariaLabel, className, icon: leading, ...rest });
  return h('button', {
    type, title: title || undefined, 'aria-label': ariaLabel || undefined,
    className: cx('pa-btn', BUTTON_CLASS[variant] || BUTTON_CLASS.secondary, size === 'sm' && 'pa-btn-sm', size === 'lg' && 'pa-btn-lg', className),
    disabled: Boolean(disabled || busy), 'aria-pressed': pressed == null ? undefined : (pressed ? 'true' : 'false'),
    onClick: disabled || busy ? undefined : onClick, ...rest,
  }, leading, busy ? busyLabel : label);
}

export function link({ h, label = '', onClick = null, disabled = false, title = '', ariaLabel = '', tone = '', className = '', icon: leading = null, ...rest }) {
  return h('button', {
    type: 'button', title: title || undefined, 'aria-label': ariaLabel || undefined, disabled: Boolean(disabled),
    className: cx('pa-link', tone, className), onClick: disabled ? undefined : onClick, ...rest,
  }, leading, label);
}

export function iconButton({ h, name, label = '', onClick = null, disabled = false, size = '', title = '', pressed = null, className = '', iconSize = 16, ...rest }) {
  return h('button', {
    type: 'button', 'aria-label': label || title || undefined, title: title || label || undefined, disabled: Boolean(disabled),
    'aria-pressed': pressed == null ? undefined : (pressed ? 'true' : 'false'),
    className: cx('pa-icon-btn', size, className), onClick: disabled ? undefined : onClick, ...rest,
  }, icon(h, name, { size: iconSize }));
}

export function badge({ h, label, tone = 'neutral', dot = false, pulse = false, icon: leading = null }) {
  const cls = tone === 'success' ? 'ok' : tone === 'neutral' || tone === 'muted' ? '' : tone;
  return h('span', { className: cx('pa-tag', cls) }, dot ? dotGlyph({ h, tone: cls, pulse }) : null, leading, label);
}

export const initialOf = name => [...String(name || '助').trim()][0] || '助';

export function avatar({ h, name, size = '', soft = false }) {
  return h('span', { 'aria-hidden': 'true', className: cx('pa-avatar', soft && 'soft', size) }, initialOf(name));
}

/** 分区：13/500 灰标题 + 可选计数 + 右侧动作。 */
export function section({ h, title, count = null, right = null, children = null, key = undefined }) {
  return h('section', { key, className: 'pa-sec' },
    title ? h('div', { className: 'pa-sec-head' },
      h('h2', null, title),
      count != null && count !== '' ? h('span', { className: 'pa-count' }, count) : null,
      right ? h('span', { className: 'pa-right' }, right) : null) : null,
    children);
}

export function group({ h, children = null, danger = false, visible = false, className = '', ...rest }) {
  return h('div', { className: cx('pa-group', danger && 'danger', visible && 'visible', className), ...rest }, children);
}

/** 列表行：as='button' 时整行可点。 */
export function row({ h, children = null, as = 'div', compact = false, className = '', onClick = null, ...rest }) {
  return h(as, { className: cx('pa-row', compact && 'compact', className), type: as === 'button' ? 'button' : undefined, onClick: onClick || undefined, ...rest }, children);
}

export function moreRow({ h, label, onClick }) {
  return h('button', { type: 'button', className: 'pa-more', onClick }, label);
}

export function emptyState({ h, title, detail = null, action = null }) {
  return h('div', { role: 'status', className: 'pa-empty' },
    h('span', null, title),
    detail ? h('span', { className: 'pa-cap' }, detail) : null,
    action || null);
}

export function skeletonBlock({ h, width = '100%', height = 12, key = undefined }) {
  return h('span', { key, 'aria-hidden': 'true', 'data-pa-skeleton': 'true', className: 'pa-skeleton', style: { width, height } });
}

export function skeletonRows({ h, rows = 3, widths = ['46%', '34%', '40%'] }) {
  return Array.from({ length: rows }, (_, index) => h('div', { key: index, className: 'pa-skel-row' }, skeletonBlock({ h, width: widths[index % widths.length] })));
}

export function switchControl({ h, checked = false, disabled = false, onChange = null, label = '' }) {
  const on = checked === true;
  return h('button', {
    type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled, className: 'pa-switch',
    onClick: disabled || typeof onChange !== 'function' ? undefined : () => onChange(!on),
  });
}

export function checkGlyph({ h, checked }) {
  return h('span', { className: 'pa-check', 'data-checked': checked ? 'true' : 'false' }, icon(h, 'check', { size: 12 }));
}

/** 下拉菜单项（勾选态）。 */
export function menu({ h, items = [], className = '', label = '', footer = null, ...rest }) {
  return h('div', { className: cx('pa-pop', 'pa-menu', className), 'data-pop-body': 'true', role: 'menu', ...rest },
    label ? h('div', { className: 'pa-menu-label' }, label) : null,
    items.map(item => h('button', {
      key: item.id, type: 'button', role: 'menuitem', className: cx('pa-menu-item', item.on && 'on'), onClick: item.onClick,
    }, item.leading || null,
    h('span', { className: 'pa-grow' }, h('span', { className: cx('pa-ellipsis', item.mono && 'pa-mono'), style: { display: 'block' } }, item.label), item.detail ? h('span', { className: 'pa-cap pa-ellipsis', style: { display: 'block' } }, item.detail) : null),
    item.checked ? h('span', { className: 'pa-ck' }, icon(h, 'check')) : null)),
    footer);
}

export function menuSeparator({ h, key = undefined }) { return h('div', { key, className: 'pa-menu-sep', 'aria-hidden': 'true' }); }

/** 轻提示：3 秒后由外壳清除。 */
export function toast({ h, text = '', tone = '' }) {
  if (!text) return null;
  return h('div', { role: tone === 'danger' ? 'alert' : 'status', 'data-pa-toast': 'true', className: cx('pa-toast', tone) }, text);
}

/** 行内说明（取代各页底部大段说明）。 */
export function note({ h, text, tone = '', icon: name = 'info' }) {
  if (!text) return null;
  return h('div', { role: tone === 'danger' ? 'alert' : 'status', className: cx('pa-note', tone) }, icon(h, name, { size: 16, style: { marginTop: 2 } }), h('span', null, text));
}

/** 毫秒转 mm:ss，创建进度页的「已用时 00:24」。 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatRemaining(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '即将完成';
  const seconds = Math.round(value / 1000);
  if (seconds <= 10) return '不到 10 秒';
  if (seconds <= 60) return `约 ${Math.round(seconds / 10) * 10} 秒`;
  return `约 ${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

/** 模型目录：切换菜单里显示的说明。 */
export const MODEL_NOTES = Object.freeze({
  'deepseek-v4.1-flash-1017': '响应快 · 上下文 128K',
  'deepseek-v4.1-pro': '更强推理 · 上下文 256K',
});
export const modelNote = model => MODEL_NOTES[model] || '支持工具调用';
