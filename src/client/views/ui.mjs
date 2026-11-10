/**
 * 个人助理面板的公共视图件：连接状态圆点、分区卡片、行、开关、按钮、骨架块、空状态。
 *
 * 约定（对齐 docs/prototype-implementation-plan.md 第 1、2、4 章）：
 * - 本文件与同目录的视图文件都是纯函数：`renderXxx({ h, ... })` 只返回 vnode；
 *   不发请求、不读写 localStorage、不持有状态，数据与回调统一由 index.mjs 注入。
 * - 颜色优先取 DSH token，回退值取画板实际色值（designs/personal-assistant-panel）。
 */

export const TOKENS = Object.freeze({
  ink: 'var(--dsw-alias-label-primary, #17202c)',
  inkSoft: 'var(--dsw-alias-label-secondary, #536174)',
  inkMuted: 'var(--dsw-alias-label-tertiary, #76808e)',
  inkFaint: '#9aa4b2',
  border: 'var(--dsw-alias-border-default, #d8dee8)',
  divider: '#eef1f6',
  surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  surface2: 'var(--dsw-alias-bg-layer-2, #f4f6fa)',
  surface3: '#f7f9fc',
  subtle: '#f1f3f6',
  success: '#067647',
  warn: '#946200',
  danger: '#b42318',
  accent: '#2f6bff',
  skeleton: '#e5e9f0',
  skeletonStrong: '#c8cfda',
  avatarSoft: '#eef2fb',
  avatarInk: '#33415a',
});

const soft = value => `color-mix(in srgb, ${value} 12%, transparent)`;

const TONE_COLOR = { success: TOKENS.success, warn: TOKENS.warn, danger: TOKENS.danger, accent: TOKENS.accent, muted: TOKENS.inkMuted, neutral: TOKENS.inkSoft };

export const styles = {
  page: { flex: '1 1 0px', height: '100%', maxHeight: '100%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', boxSizing: 'border-box', background: TOKENS.surface, color: TOKENS.ink, fontSize: 13 },
  header: { flex: 'none', height: 52, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: `1px solid ${TOKENS.border}`, boxSizing: 'border-box' },
  main: { flex: '1 1 0px', minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: 16, padding: 16, boxSizing: 'border-box' },
  card: { flex: 'none', border: `1px solid ${TOKENS.border}`, borderRadius: 12, background: TOKENS.surface, overflow: 'hidden', boxSizing: 'border-box' },
  cardPad: { padding: 16 },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' },
  rowDivider: { borderTop: `1px solid ${TOKENS.divider}` },
  title: { margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: TOKENS.inkSoft },
  meta: { fontSize: 11, color: TOKENS.inkMuted },
  body: { fontSize: 12, lineHeight: 1.7, color: TOKENS.inkSoft },
  note: { fontSize: 11, lineHeight: 1.7, color: TOKENS.inkMuted },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  badge: { display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, padding: '1px 7px', fontSize: 11, lineHeight: 1.7, whiteSpace: 'nowrap' },
  avatar: { flex: 'none', borderRadius: 999, display: 'grid', placeItems: 'center', background: TOKENS.ink, color: '#ffffff' },
  chevron: { flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: TOKENS.inkMuted },
};

/** 三态圆点的唯一判定口径：连接不等于授权。 */
export function connectionStateOf(connection) {
  const connected = connection?.connected === true;
  const authorized = connection?.authorized === true;
  if (!connected) return 'offline';
  return authorized ? 'authorized' : 'connected';
}

export const CONNECTION_COPY = Object.freeze({
  authorized: '本机已授权',
  connected: '本机未授权',
  offline: '本机未连接',
});

const CONNECTION_TITLE = Object.freeze({
  authorized: '本机已授权，点击查看授权范围或取消授权',
  connected: '本机已连接但未授权，点击请求授权',
  offline: '本机未连接，点击重新检查连接',
});

/** 纯圆点（带外发光开关），供页头与弹层内部复用。 */
export function dotGlyph({ h, tone = 'muted', glow = false, size = 6 }) {
  const color = TONE_COLOR[tone] || TONE_COLOR.muted;
  return h('span', {
    'aria-hidden': 'true',
    style: {
      flex: 'none', width: size, height: size, borderRadius: 999, background: color,
      ...(glow ? { boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 16%, transparent)` } : {}),
    },
  });
}

/**
 * 全局面板页头的连接状态圆点。
 * state ∈ authorized（绿，点击打开授权弹层）/ connected（琥珀+外发光，点击请求授权）/ offline（灰，点击重连）。
 */
export function connectionDot({ h, connection = null, onOpen = null, showLabel = true, style = null }) {
  const state = connectionStateOf(connection);
  const tone = state === 'authorized' ? 'success' : state === 'connected' ? 'warn' : 'muted';
  const color = TONE_COLOR[tone];
  const title = CONNECTION_TITLE[state];
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 5, font: 'inherit', fontSize: 11, lineHeight: 1.7,
    color: TOKENS.inkSoft, whiteSpace: 'nowrap', border: 'none', background: 'transparent', padding: 0,
    cursor: onOpen ? 'pointer' : 'default', ...(style || {}),
  };
  const children = [dotGlyph({ h, tone, glow: state === 'connected' }), showLabel ? h('span', { style: { color: state === 'connected' ? color : undefined } }, CONNECTION_COPY[state]) : null];
  const props = {
    'data-connection-dot': state,
    'data-connection-authorized': connection?.authorized === true ? 'true' : 'false',
    title,
    'aria-label': title,
    style: base,
  };
  if (typeof onOpen !== 'function') return h('span', { ...props, role: 'status' }, children);
  return h('button', { ...props, type: 'button', onClick: onOpen }, children);
}

export function button({ h, label = '', onClick = null, variant = 'ghost', disabled = false, busy = false, busyLabel = '处理中…', title = '', ariaLabel = '', icon = null, type = 'button', style = null, ...rest }) {
  const variants = {
    primary: { border: 'none', background: TOKENS.ink, color: '#ffffff', fontWeight: 500 },
    ghost: { border: `1px solid ${TOKENS.border}`, background: TOKENS.surface, color: TOKENS.ink },
    subtle: { border: '1px solid transparent', background: TOKENS.surface2, color: TOKENS.ink },
    danger: { border: '1px solid color-mix(in srgb, #b42318 32%, transparent)', background: TOKENS.surface, color: TOKENS.danger },
    link: { border: 'none', background: 'transparent', color: TOKENS.accent, padding: 2 },
  };
  const base = { height: 32, padding: '0 12px', borderRadius: 8, fontSize: 12, font: 'inherit', cursor: disabled || busy ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap', ...(variants[variant] || variants.ghost), ...(style || {}) };
  return h('button', {
    type, title: title || undefined, 'aria-label': ariaLabel || undefined,
    disabled: Boolean(disabled || busy),
    onClick: disabled || busy ? undefined : onClick,
    style: disabled ? { ...base, opacity: 0.55 } : base,
    ...rest,
  }, icon, busy ? busyLabel : label);
}

export function iconButton({ h, label = '', onClick = null, disabled = false, size = 32, children = null, title = '', style = null }) {
  return h('button', {
    type: 'button', 'aria-label': label || title || undefined, title: title || undefined, disabled: Boolean(disabled),
    onClick: disabled ? undefined : onClick,
    style: {
      flex: 'none', width: size, height: size, display: 'grid', placeItems: 'center', padding: 0,
      border: `1px solid ${TOKENS.border}`, borderRadius: 8, background: TOKENS.surface,
      color: TOKENS.inkSoft, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, ...(style || {}),
    },
  }, children);
}

export function card(options, ...extraChildren) {
  const { h, children = null, style = null, as = 'section', ...rest } = options || {};
  // 视图里两种写法都出现过（children 属性 / 位置参数），统一在这层兜住，避免内容被静默丢弃。
  const content = children == null && extraChildren.length > 0 ? extraChildren : children;
  return h(as, { style: { ...styles.card, ...(style || {}) }, ...rest }, content);
}

export function cardTitle({ h, title, meta = null, action = null, style = null }) {
  return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, ...(style || {}) } },
    h('span', { style: styles.sectionTitle }, title, meta ? h('span', { style: { fontWeight: 400, color: TOKENS.inkMuted } }, ` · ${meta}`) : null),
    action || null);
}

/** 分区标题行：左侧 12/600 灰标题，右侧淡说明或文字动作。 */
export function sectionHeader({ h, title, meta = null, action = null }) {
  return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
    h('span', { style: styles.sectionTitle }, title),
    action || (meta ? h('span', { style: styles.meta }, meta) : null));
}

export function divider({ h, style = null }) {
  return h('div', { 'aria-hidden': 'true', style: { borderTop: `1px solid ${TOKENS.divider}`, ...(style || {}) } });
}

export function badge({ h, label, tone = 'neutral', dot = false }) {
  const color = TONE_COLOR[tone] || TONE_COLOR.neutral;
  const background = tone === 'neutral' ? TOKENS.subtle : soft(color);
  return h('span', { style: { ...styles.badge, background, color: tone === 'neutral' ? TOKENS.inkSoft : color } },
    dot ? h('span', { 'aria-hidden': 'true', style: { width: 5, height: 5, borderRadius: 999, background: 'currentColor' } }) : null,
    label);
}

/** 开关：用于「控制本机」这类布尔项；未授权时整体置灰。 */
export function switchControl({ h, checked = false, disabled = false, onChange = null, label = '', description = null }) {
  const on = checked === true;
  return h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontSize: 12, fontWeight: 600 } }, label),
      description ? h('div', { style: { ...styles.note, marginTop: 2 } }, description) : null),
    h('button', {
      type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled,
      onClick: disabled || typeof onChange !== 'function' ? undefined : () => onChange(!on),
      style: {
        flex: 'none', marginTop: 2, width: 36, height: 20, borderRadius: 999, border: 'none', padding: 0,
        position: 'relative', background: on ? TOKENS.success : TOKENS.skeletonStrong,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, transition: 'background .15s ease',
      },
    }, h('span', {
      'aria-hidden': 'true',
      style: { position: 'absolute', top: 2, ...(on ? { right: 2 } : { left: 2 }), width: 16, height: 16, borderRadius: 999, background: '#ffffff' },
    })));
}

export function listRow(options, ...extraChildren) {
  const { h, children = null, first = false, style = null, as = 'div', ...rest } = options || {};
  const content = children == null && extraChildren.length > 0 ? extraChildren : children;
  return h(as, { style: { ...styles.row, ...(first ? {} : styles.rowDivider), ...(style || {}) }, ...rest }, content);
}

export function statTile({ h, label, value, tone = 'inherit', style = null }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, padding: 8, borderRadius: 8, minWidth: 0, ...(style || {}) } },
    h('span', { style: { fontSize: 11, color: TOKENS.inkMuted, letterSpacing: '0.04em' } }, label),
    h('span', { style: { fontSize: 13, fontWeight: 500, color: tone === 'inherit' ? TOKENS.ink : (TONE_COLOR[tone] || TOKENS.ink), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, value));
}

export function statsGrid(options, ...extraChildren) {
  const { h, children = null, columns = 3, style = null } = options || {};
  const content = children == null && extraChildren.length > 0 ? extraChildren : children;
  return h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 8, ...(style || {}) } }, content);
}

/** 骨架块：首次进入先画骨架，数据到后替换，不用整页 spinner。 */
export function skeletonBlock({ h, width = '100%', height = 12, radius = 6, style = null }) {
  return h('span', {
    'aria-hidden': 'true', 'data-pa-skeleton': 'true',
    style: { display: 'block', width, height, borderRadius: radius, background: TOKENS.skeleton, animation: 'pa-skeleton 1.4s ease-in-out infinite', ...(style || {}) },
  });
}

export function skeletonCard({ h, rows = 3, pad = 16, style = null }) {
  return card({ h, style, children: h('div', { style: { padding: pad, display: 'flex', flexDirection: 'column', gap: 10 } },
    Array.from({ length: rows }, (_, index) => skeletonBlock({ h, width: index === 0 ? '42%' : `${72 - index * 10}%`, height: index === 0 ? 14 : 11 }))) });
}

export function emptyState({ h, title, detail = null, action = null, style = null }) {
  return h('div', { role: 'status', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '24px 16px', textAlign: 'center', ...(style || {}) } },
    h('span', { style: { fontSize: 12, color: TOKENS.inkSoft } }, title),
    detail ? h('span', { style: { fontSize: 11, color: TOKENS.inkMuted, lineHeight: 1.7 } }, detail) : null,
    action || null);
}

/** 一行提示条：degraded/notice/error 共用，避免各视图各写一套。 */
export function noticeBar({ h, text = '', tone = 'warn', style = null }) {
  if (!text) return null;
  const color = TONE_COLOR[tone] || TONE_COLOR.warn;
  return h('div', { role: tone === 'danger' ? 'alert' : 'status', style: {
    flex: 'none', padding: '8px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.7,
    background: tone === 'danger' ? 'color-mix(in srgb, #b42318 6%, transparent)' : TOKENS.surface2,
    color: tone === 'danger' ? color : TOKENS.inkSoft,
    border: `1px solid ${tone === 'danger' ? 'color-mix(in srgb, #b42318 24%, transparent)' : TOKENS.divider}`,
    ...(style || {}),
  } }, text);
}

/* ---------- 图标：与画板同源的线性图标，尺寸按调用处传 ---------- */

const icon = ({ h, size = 16, viewBox = '0 0 16 16', color = 'currentColor', style = null, children }) => h('svg', {
  'aria-hidden': 'true', width: size, height: size, viewBox, fill: 'none',
  style: { flex: 'none', display: 'block', color, ...(style || {}) },
}, children);

export const chevronRightIcon = ({ h, size = 12, color = TOKENS.inkMuted }) => icon({ h, size, color, children: h('path', { d: 'M4.2 2.4 8 6l-3.8 3.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }) });
export const chevronDownIcon = ({ h, size = 12, color = TOKENS.inkMuted }) => icon({ h, size, color, children: h('path', { d: 'M2.6 4.4 6 7.8l3.4-3.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }) });
export const backIcon = ({ h, size = 14, color = TOKENS.inkSoft }) => icon({ h, size, color, children: h('path', { d: 'M9.8 3.4 5.2 8l4.6 4.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }) });
export const plusIcon = ({ h, size = 12, color = 'currentColor' }) => icon({ h, size, viewBox: '0 0 12 12', color, children: h('path', { d: 'M6 2.2v7.6M2.2 6h7.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }) });
export const checkIcon = ({ h, size = 11, color = TOKENS.success }) => icon({ h, size, viewBox: '0 0 12 12', color, children: h('path', { d: 'M2.6 6.2 4.8 8.4 9.4 3.8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }) });
export const checkCircleIcon = ({ h, size = 20, color = TOKENS.success }) => icon({ h, size, color, children: [
  h('circle', { key: 'c', cx: 8, cy: 8, r: 6.4, stroke: 'currentColor', strokeWidth: 1.3 }),
  h('path', { key: 'p', d: 'M5.2 8.2 7.1 10.1l3.7-4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
] });
export const warningIcon = ({ h, size = 14, color = TOKENS.warn }) => icon({ h, size, color, children: [
  h('path', { key: 't', d: 'M8 2.6 14.2 13.4H1.8L8 2.6Z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }),
  h('path', { key: 'a', d: 'M8 6.6v3.1M8 11.6v.1', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
] });
export const infoIcon = ({ h, size = 12, color = TOKENS.inkMuted }) => icon({ h, size, color, children: [
  h('circle', { key: 'c', cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', strokeWidth: 1.3 }),
  h('path', { key: 'p', d: 'M8 7.2v3.4M8 5.2v.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
] });
export const monitorIcon = ({ h, size = 16, color = TOKENS.inkSoft }) => icon({ h, size, color, children: [
  h('rect', { key: 'r', x: 1.8, y: 2.8, width: 12.4, height: 8.4, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
  h('path', { key: 'b', d: 'M5.6 13.6h4.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
] });
export const calendarIcon = ({ h, size = 16, color = TOKENS.inkSoft }) => icon({ h, size, color, children: [
  h('rect', { key: 'r', x: 2, y: 3.2, width: 12, height: 10.6, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }),
  h('path', { key: 'p', d: 'M2 6.6h12M5.4 1.8v2.6M10.6 1.8v2.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
] });
export const starIcon = ({ h, size = 16, color = TOKENS.inkSoft }) => icon({ h, size, color, children: h('path', { d: 'M8 2.2 9.5 6l3.9.3-3 2.5 1 3.8L8 10.4 4.6 12.6l1-3.8-3-2.5L6.5 6 8 2.2Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }) });
export const folderIcon = ({ h, size = 16, color = TOKENS.inkSoft }) => icon({ h, size, color, children: h('path', { d: 'M1.9 4.6c0-.8.6-1.4 1.4-1.4h2.6l1.3 1.6h5.5c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H3.3c-.8 0-1.4-.6-1.4-1.4V4.6Z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }) });
export const closeIcon = ({ h, size = 10, color = 'currentColor' }) => icon({ h, size, viewBox: '0 0 12 12', color, children: h('path', { d: 'M3 3l6 6M9 3l-6 6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }) });
export const spinnerIcon = ({ h, size = 14, color = TOKENS.accent }) => h('svg', {
  'aria-hidden': 'true', width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
  style: { flex: 'none', animation: 'pa-spin 1.4s linear infinite', transformOrigin: '50% 50%', color },
}, h('path', { d: 'M8 1.8a6.2 6.2 0 1 0 6.2 6.2', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }));

/** 毫秒转 mm:ss，创建进度页的「已用时 00:24」。 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/** 剩余时间档位：具体毫秒数对用户没有意义，按画板口径给区间。 */
export function formatRemaining(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '即将完成';
  const seconds = Math.round(value / 1000);
  if (seconds <= 10) return '不到 10 秒';
  if (seconds <= 60) return `约 ${Math.round(seconds / 10) * 10} 秒`;
  return `约 ${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

/** 秒数/毫秒数这类「已运行」说明，用于列表「正在发生」。 */
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}
