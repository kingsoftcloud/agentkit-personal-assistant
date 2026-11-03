/**
 * 「本机授权」弹层（画板 07 LocalAccess.dc.html）。
 *
 * 纯函数：授权状态、作用域草稿、高风险确认草稿都由 index.mjs 持有；
 * 视图只渲染并回传选择，不直接调用 local-access.* RPC。
 *
 * 口径（契约第 2、3.2 章）：连接不等于授权；connected 决定是否可以授权，
 * authorized 决定是否已授权；未授权时任何本地控制入口必须禁用。
 */

import { TOKENS, badge, button, checkIcon, divider, infoIcon, monitorIcon, styles, switchControl } from './ui.mjs';

/** 可授权的作用域：与 Host local-access.grant 接受的子集一一对应。 */
export const LOCAL_ACCESS_SCOPES = Object.freeze([
  { id: 'session.create', label: '发起新会话' },
  { id: 'window.input', label: '操作本地窗口（点击、输入、快捷键）' },
  { id: 'file.read-write', label: '读写本地文件（仅限你选择的目录）' },
]);

const RISK_LABEL = '高风险操作前先问我';

function scopeRow({ h, checked, disabled, label, onToggle }) {
  return h('button', {
    type: 'button', role: 'checkbox', 'aria-checked': checked ? 'true' : 'false', disabled,
    onClick: disabled || typeof onToggle !== 'function' ? undefined : onToggle,
    style: {
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 0, border: 'none', background: 'transparent',
      color: checked ? TOKENS.avatarInk : TOKENS.inkFaint, font: 'inherit', fontSize: 11, lineHeight: 1.7, textAlign: 'left',
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.75 : 1,
    },
  },
  checked
    ? checkIcon({ h, size: 11, color: TOKENS.success })
    : h('span', { 'aria-hidden': 'true', style: { flex: 'none', width: 11, height: 11, borderRadius: 999, border: `1.5px solid ${TOKENS.skeletonStrong}` } }),
  label);
}

export function renderLocalAccess({
  h, open = false, connection = null, status = null, selectedScopes = [], riskConfirm = true,
  busy = '', error = '', notice = '', actions = {},
} = {}) {
  if (!open) return null;
  const connected = status?.connected === true || connection?.connected === true;
  const authorized = status?.authorized === true || connection?.authorized === true;
  const busyOn = Boolean(busy);
  const selected = new Set((Array.isArray(selectedScopes) ? selectedScopes : status?.scopes || []).map(value => String(value)));
  const host = status?.host || {};
  const hostMeta = [host.platform, host.studioVersion ? `Studio ${host.studioVersion}` : ''].filter(Boolean).join(' · ') || '本机 Studio';
  const grantedAt = status?.grantedAt || '';
  const toggleScope = id => {
    if (authorized || busyOn || typeof actions.onToggleScope !== 'function') return;
    actions.onToggleScope(id);
  };
  return h('div', {
    role: 'dialog', 'aria-label': '本机授权', 'data-local-access-popover': open ? 'open' : 'closed',
    style: {
      position: 'absolute', top: 58, right: 12, zIndex: 30, width: 344, boxSizing: 'border-box',
      background: TOKENS.surface, border: `1px solid ${TOKENS.border}`, borderRadius: 12, padding: 14,
      display: 'flex', flexDirection: 'column', gap: 12,
      boxShadow: '0 18px 40px rgba(23,32,44,0.16), 0 2px 8px rgba(23,32,44,0.06)',
    },
  },
  h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
    h('span', { 'aria-hidden': 'true', style: { flex: 'none', width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: TOKENS.surface2, border: `1px solid ${TOKENS.skeleton}` } },
      monitorIcon({ h, size: 15, color: TOKENS.inkSoft })),
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontSize: 13, fontWeight: 600 } }, '本机 Studio'),
      h('div', { style: styles.note }, hostMeta)),
    badge({ h, label: connected ? '已连接' : '未连接', tone: connected ? 'success' : 'warn' })),
  divider({ h }),
  switchControl({
    h, checked: authorized, disabled: busyOn || !connected,
    label: '控制本机',
    description: '允许助理在本机 Studio 发起新会话、操作本地窗口与文件。',
    onChange: next => { if (next) actions.onGrant?.(); else actions.onRevoke?.(); },
  }),
  h('ul', { style: { display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: '10px 12px', borderRadius: 10, background: TOKENS.surface3, listStyle: 'none' } },
    LOCAL_ACCESS_SCOPES.map(scope => h('li', { key: scope.id, style: { margin: 0 } },
      scopeRow({ h, checked: authorized ? selected.has(scope.id) : selected.has(scope.id), disabled: authorized || busyOn, label: scope.label, onToggle: () => toggleScope(scope.id) }))),
    h('li', { key: 'risk', style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, lineHeight: 1.7, color: riskConfirm ? TOKENS.avatarInk : TOKENS.inkFaint } },
      h('button', {
        type: 'button', role: 'checkbox', 'aria-checked': riskConfirm ? 'true' : 'false', 'aria-label': RISK_LABEL,
        disabled: busyOn, onClick: busyOn ? undefined : () => actions.onToggleRisk?.(),
        style: { display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'transparent', padding: 0, color: 'inherit', font: 'inherit', fontSize: 11, cursor: busyOn ? 'default' : 'pointer' },
      }, riskConfirm ? checkIcon({ h, size: 11 }) : h('span', { 'aria-hidden': 'true', style: { width: 11, height: 11, borderRadius: 999, border: `1.5px solid ${TOKENS.skeletonStrong}` } }), RISK_LABEL))),
  authorized
    ? button({ h, label: busy === 'revoke' ? '正在取消…' : '取消授权', variant: 'danger', disabled: busyOn, onClick: () => actions.onRevoke?.(), style: { width: '100%', height: 34, fontWeight: 500 } })
    : button({ h, label: busy === 'grant' ? '正在授权…' : '授权本机控制', variant: 'primary', disabled: busyOn || !connected, title: connected ? '' : '本机尚未连接，无法授权', onClick: () => actions.onGrant?.(), style: { width: '100%', height: 34, fontWeight: 500 } }),
  h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 6 } },
    infoIcon({ h, size: 12 }),
    h('div', { style: { flex: 1, minWidth: 0, fontSize: 11, color: TOKENS.inkMuted, lineHeight: 1.7 } }, '取消后，正在运行的本机任务会立即中止；云端会话与记忆不受影响。')),
  error ? h('div', { role: 'alert', style: { ...styles.note, color: TOKENS.danger } }, error) : null,
  notice ? h('div', { role: 'status', style: { ...styles.note, color: TOKENS.success } }, notice) : null,
  h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 10, borderTop: `1px solid ${TOKENS.divider}` } },
    h('span', { style: { fontSize: 11, color: TOKENS.inkMuted } }, grantedAt ? `授权于 ${grantedAt}` : '尚未授权'),
    button({ h, label: '打开本机设置', variant: 'link', style: { fontSize: 11 }, onClick: () => actions.onOpenLocalSettings?.() })));
}
