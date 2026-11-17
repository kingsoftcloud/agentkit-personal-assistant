/**
 * 本机目录授权弹层。
 *
 * 三态：authorized（已授权）/ connected（已连接未授权）/ offline（未连接）。
 * 连接不等于授权：只有 connected 且 authorized 才能读取授权目录。
 */

import { CONNECTION_COPY, button, checkGlyph, connectionStateOf, cx, icon, iconButton, link, switchControl } from './ui.mjs';

export const LOCAL_ACCESS_SCOPES = Object.freeze([{ id: 'file.read', label: '只读访问选择的本机目录' }]);

function scopeRow({ h, checked, disabled, label, onToggle }) {
  return h('button', {
    type: 'button', role: 'checkbox', 'aria-checked': checked ? 'true' : 'false', disabled, className: 'pa-scope',
    onClick: disabled || typeof onToggle !== 'function' ? undefined : onToggle,
  }, checkGlyph({ h, checked }), h('span', { className: cx('pa-grow', !checked && disabled && 'pa-cap') }, label));
}

export function renderLocalAccess({
  h, open = false, connection = null, status = null, selectedScopes = [], riskConfirm = true,
  busy = '', error = '', notice = '', rootsDraft = '', targetBotId = '', actions = {},
} = {}) {
  if (!open) return null;
  const state = connectionStateOf(connection);
  const authorized = status?.authorized === true;
  const offline = status?.available === false || (status?.available !== true && state === 'offline');
  const scopes = authorized ? (Array.isArray(status?.scopes) && status.scopes.length ? status.scopes : selectedScopes) : selectedScopes;
  const grantedAt = status?.grantedAt ? new Date(status.grantedAt) : null;
  const grantedText = grantedAt && !Number.isNaN(grantedAt.getTime()) ? `${grantedAt.getMonth() + 1}月${grantedAt.getDate()}日 ${String(grantedAt.getHours()).padStart(2, '0')}:${String(grantedAt.getMinutes()).padStart(2, '0')}` : '';
  const hostName = status?.host?.name || status?.host?.hostname || '';
  const canGrant = !offline && !authorized && Boolean(targetBotId) && scopes.length > 0 && rootsDraft.trim().length > 0 && busy !== 'grant';
  const subtitle = offline
    ? '没有检测到这台电脑上的 DSH Host。'
    : authorized
      ? [hostName, status.connected ? '在线' : '等待连接', grantedText ? `${grantedText} 授权` : ''].filter(Boolean).join(' · ')
      : `${hostName ? `已连接到 ${hostName}` : '已连接到这台电脑'} · 尚未授权`;

  return h('div', { role: 'dialog', 'aria-label': '本机授权', 'data-local-access-popover': 'open', 'data-pop-body': 'true', className: 'pa-pop pa-local-pop' },
    h('div', { className: 'pa-local-head' },
      h('span', { className: 'pa-local-ic' }, icon(h, 'laptop', { size: 18 })),
      h('div', { className: 'pa-grow' },
        h('div', { className: 'pa-strong' }, CONNECTION_COPY[state]),
        h('div', { className: 'pa-cap pa-ellipsis' }, subtitle)),
      iconButton({ h, name: 'close', size: 'sm', label: '关闭本机授权弹层', onClick: () => actions.onClose?.() })),
    offline
      ? h('p', { className: 'pa-sub' }, '当前 Host 尚未提供本机目录连接服务。')
      : [
        h('div', { key: 'switch', className: 'pa-switch-row' },
          h('div', { className: 'pa-grow' },
            h('div', { className: 'pa-strong' }, '允许助理只读访问目录'),
            h('div', { className: 'pa-cap' }, authorized ? '撤销后不再返回本机内容；云端已有结果不会被删除' : '勾选范围后开启，随时可以关闭')),
          switchControl({ h, checked: authorized, disabled: busy === 'grant' || busy === 'revoke' || (!authorized && !canGrant), label: '允许助理只读访问目录', onChange: next => (next ? actions.onGrant?.() : actions.onRevoke?.()) })),
        h('div', { key: 'scopes', className: 'pa-scope-list' },
          h('div', { className: 'pa-cap' }, authorized ? `授权助理：${status.target?.botId || ''}` : targetBotId ? `授权助理：${targetBotId}` : '正在读取云端助理，请稍候'),
          LOCAL_ACCESS_SCOPES.map(scope => scopeRow({ h, key: scope.id, checked: scopes.includes(scope.id), disabled: authorized || Boolean(busy), label: scope.label, onToggle: () => actions.onToggleScope?.(scope.id) })),
          h('label', { className: 'pa-sub' }, '授权目录（绝对路径，每行一个）',
            h('textarea', { className: 'pa-input', rows: 3, 'aria-label': '授权目录', value: authorized ? (status?.roots || []).map(root => root.path).join('\n') : rootsDraft, disabled: authorized || Boolean(busy), onChange: event => actions.onRootsChange?.(event.target.value) })),
          h('div', { className: 'pa-cap' }, '仅列目录和读取文本文件；不会授权写入、命令或窗口控制。')),
        authorized && !status?.connected ? h('div', { key: 'waiting', role: 'status', className: 'pa-note' }, status?.lastError || '授权已保存，正在连接云端') : null,
      ],
    error ? h('div', { role: 'alert', className: 'pa-note danger' }, icon(h, 'warn', { size: 16, style: { marginTop: 2 } }), h('span', null, error)) : null,
    notice ? h('div', { role: 'status', className: cx('pa-note', /已连接|已授权|成功/u.test(notice) && 'ok') }, icon(h, /已连接|已授权|成功/u.test(notice) ? 'check' : 'info', { size: 16, style: { marginTop: 2 } }), h('span', null, notice)) : null,
    h('div', { className: 'pa-between' },
      link({ h, label: offline ? '重新检查' : '查看本机设置', onClick: () => (offline ? actions.onRefresh?.() : actions.onOpenLocalSettings?.()) }),
      authorized
        ? button({ h, label: '取消授权', variant: 'danger', size: 'sm', busy: busy === 'revoke', busyLabel: '取消中…', onClick: () => actions.onRevoke?.() })
        : offline ? null : button({ h, label: '授权', variant: 'primary', size: 'sm', disabled: !canGrant, busy: busy === 'grant', busyLabel: '授权中…', onClick: () => actions.onGrant?.() })));
}
