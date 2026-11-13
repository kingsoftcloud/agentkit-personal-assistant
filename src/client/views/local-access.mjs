/**
 * 本机授权弹层（重新设计 DEMO：页头 chip 下拉的 340px 面板）。
 *
 * 三态：authorized（已授权）/ connected（已连接未授权）/ offline（未连接）。
 * 连接不等于授权：只有 connected 且 authorized 才算可控制本机。
 */

import { CONNECTION_COPY, button, checkGlyph, connectionStateOf, cx, icon, iconButton, link, switchControl } from './ui.mjs';

export const LOCAL_ACCESS_SCOPES = Object.freeze([
  { id: 'session.create', label: '发起新会话' },
  { id: 'window.input', label: '操作本地窗口（点击、输入、快捷键）' },
  { id: 'file.read-write', label: '读写本地文件（仅限你选择的目录）' },
]);

const RISK_LABEL = '高风险操作前先问我';

function scopeRow({ h, checked, disabled, label, onToggle }) {
  return h('button', {
    type: 'button', role: 'checkbox', 'aria-checked': checked ? 'true' : 'false', disabled, className: 'pa-scope',
    onClick: disabled || typeof onToggle !== 'function' ? undefined : onToggle,
  }, checkGlyph({ h, checked }), h('span', { className: cx('pa-grow', !checked && disabled && 'pa-cap') }, label));
}

export function renderLocalAccess({
  h, open = false, connection = null, status = null, selectedScopes = [], riskConfirm = true,
  busy = '', error = '', notice = '', actions = {},
} = {}) {
  if (!open) return null;
  const state = connectionStateOf(connection);
  const authorized = state === 'authorized';
  const offline = state === 'offline';
  const scopes = authorized ? (Array.isArray(status?.scopes) && status.scopes.length ? status.scopes : selectedScopes) : selectedScopes;
  const grantedAt = status?.grantedAt ? new Date(status.grantedAt) : null;
  const grantedText = grantedAt && !Number.isNaN(grantedAt.getTime()) ? `${grantedAt.getMonth() + 1}月${grantedAt.getDate()}日 ${String(grantedAt.getHours()).padStart(2, '0')}:${String(grantedAt.getMinutes()).padStart(2, '0')}` : '';
  const hostName = status?.host?.name || status?.host?.hostname || '';
  const canGrant = !offline && !authorized && scopes.length > 0 && busy !== 'grant';
  const subtitle = offline
    ? '没有检测到这台电脑上的 DSH Host。'
    : authorized
      ? [hostName ? `已连接到 ${hostName}` : '已连接', grantedText ? `${grantedText} 授权` : ''].filter(Boolean).join(' · ')
      : `${hostName ? `已连接到 ${hostName}` : '已连接到这台电脑'} · 尚未授权`;

  return h('div', { role: 'dialog', 'aria-label': '本机授权', 'data-local-access-popover': 'open', 'data-pop-body': 'true', className: 'pa-pop pa-local-pop' },
    h('div', { className: 'pa-local-head' },
      h('span', { className: 'pa-local-ic' }, icon(h, 'laptop', { size: 18 })),
      h('div', { className: 'pa-grow' },
        h('div', { className: 'pa-strong' }, CONNECTION_COPY[state]),
        h('div', { className: 'pa-cap pa-ellipsis' }, subtitle)),
      iconButton({ h, name: 'close', size: 'sm', label: '关闭本机授权弹层', onClick: () => actions.onClose?.() })),
    offline
      ? h('p', { className: 'pa-sub' }, '安装并打开 DSH Host 后，助理才能在这台电脑上发起会话、操作窗口与文件。')
      : [
        h('div', { key: 'switch', className: 'pa-switch-row' },
          h('div', { className: 'pa-grow' },
            h('div', { className: 'pa-strong' }, '允许助理控制本机'),
            h('div', { className: 'pa-cap' }, authorized ? '关闭即撤销授权，进行中的本机操作会停止' : '勾选范围后开启，随时可以关闭')),
          switchControl({ h, checked: authorized, disabled: busy === 'grant' || busy === 'revoke' || (!authorized && !canGrant), label: '允许助理控制本机', onChange: next => (next ? actions.onGrant?.() : actions.onRevoke?.()) })),
        h('div', { key: 'scopes', className: 'pa-scope-list' },
          LOCAL_ACCESS_SCOPES.map(scope => scopeRow({ h, key: scope.id, checked: scopes.includes(scope.id), disabled: authorized || Boolean(busy), label: scope.label, onToggle: () => actions.onToggleScope?.(scope.id) })),
          h('div', { className: 'pa-menu-sep' }),
          scopeRow({ h, checked: riskConfirm !== false, disabled: authorized || Boolean(busy), label: RISK_LABEL, onToggle: () => actions.onToggleRisk?.() })),
      ],
    error ? h('div', { role: 'alert', className: 'pa-note danger' }, icon(h, 'warn', { size: 16, style: { marginTop: 2 } }), h('span', null, error)) : null,
    notice ? h('div', { role: 'status', className: cx('pa-note', /已连接|已授权|成功/u.test(notice) && 'ok') }, icon(h, /已连接|已授权|成功/u.test(notice) ? 'check' : 'info', { size: 16, style: { marginTop: 2 } }), h('span', null, notice)) : null,
    h('div', { className: 'pa-between' },
      link({ h, label: offline ? '重新检查' : '查看本机设置', onClick: () => (offline ? actions.onRefresh?.() : actions.onOpenLocalSettings?.()) }),
      authorized
        ? button({ h, label: '取消授权', variant: 'danger', size: 'sm', busy: busy === 'revoke', busyLabel: '取消中…', onClick: () => actions.onRevoke?.() })
        : offline ? null : button({ h, label: '授权', variant: 'primary', size: 'sm', disabled: !canGrant, busy: busy === 'grant', busyLabel: '授权中…', onClick: () => actions.onGrant?.() })));
}
