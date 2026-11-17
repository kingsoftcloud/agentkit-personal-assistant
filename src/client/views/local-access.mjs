import { badge, button, icon, iconButton } from './ui.mjs';

const folderName = path => path.split(/[/\\]/u).filter(Boolean).at(-1) || path;

function folderRow({ h, root, editing, busy, canWrite, actions }) {
  const name = folderName(root.path);
  return h('li', { key: root.path, className: 'pa-local-folder', title: root.path },
    h('span', { className: 'pa-local-folder-icon' }, icon(h, 'folder', { size: 17 })),
    h('div', { className: 'pa-grow' }, h('div', { className: 'pa-local-folder-name pa-ellipsis' }, name),
      h('div', { className: 'pa-cap pa-ellipsis', dir: 'auto' }, root.path)),
    editing ? h('select', { className: 'pa-local-mode', value: root.writable ? 'write' : 'read',
      'aria-label': `${name} 的权限`, disabled: Boolean(busy), onChange: event => actions.onMode?.(root.path, event.target.value === 'write') },
    h('option', { value: 'read' }, '只读'), h('option', { value: 'write', disabled: !canWrite }, '读写'))
      : badge({ h, label: root.writable ? '读写' : '只读', tone: 'neutral' }),
    editing ? iconButton({ h, name: 'close', size: 'sm', label: `移除 ${name}`, disabled: Boolean(busy), onClick: () => actions.onRemove?.(root.path) }) : null);
}

export function renderLocalAccess({ h, open, connection, draft, canPick, writeSupport, botName, foreign, busy, error, actions }) {
  if (!open) return null;
  const hasGrant = connection?.authorized === true;
  const editing = !hasGrant || draft !== null;
  const roots = editing ? draft || [] : connection.roots || [];
  const canEdit = canPick && !foreign && connection?.available === true && Boolean(botName);
  const waiting = hasGrant && !connection.connected;
  const hostName = connection?.host?.name || '这台电脑';
  return h('div', { role: 'dialog', 'aria-label': '本机授权', 'data-local-access-popover': 'open', 'data-pop-body': 'true', className: 'pa-pop pa-local-pop' },
    h('div', { className: 'pa-local-head' },
      h('span', { className: 'pa-local-ic' }, icon(h, 'laptop', { size: 18 })),
      h('div', { className: 'pa-grow' }, h('div', { className: 'pa-strong' }, '本机文件访问'),
        h('div', { className: 'pa-cap pa-ellipsis' }, [hostName, botName].filter(Boolean).join(' · '))),
      iconButton({ h, name: 'close', size: 'sm', label: '关闭本机授权弹层', onClick: actions.onClose })),
    h('div', { className: 'pa-local-folders' },
      h('div', { className: 'pa-between' }, h('strong', { className: 'pa-local-heading' }, '授权文件夹'),
        hasGrant ? badge({ h, label: foreign ? '授权给其他助理' : waiting ? '已授权 · 等待连接' : '已授权 · 在线', tone: waiting || foreign ? 'warn' : 'success', dot: true }) : null),
      roots.length ? h('ul', { className: 'pa-local-folder-list' }, roots.map(root => folderRow({ h, root, editing, busy, canWrite: writeSupport === true, actions })))
        : h('p', { className: 'pa-local-empty' }, '选择助理可以访问的文件夹。'),
      editing && canPick ? button({ h, label: '选择文件夹…', variant: 'secondary', size: 'sm', icon: icon(h, 'plus', { size: 14 }),
        busy: busy === 'pick', busyLabel: '正在选择…', disabled: !canEdit || roots.length >= 8 || Boolean(busy), onClick: actions.onPick }) : null),
    foreign ? h('p', { className: 'pa-cap' }, '要授权给当前助理，请先撤销原授权。')
      : !canPick && editing ? h('p', { className: 'pa-cap' }, '请在这台电脑的 Studio 桌面端选择文件夹。')
        : editing && writeSupport === false ? h('p', { className: 'pa-cap' }, '当前云端版本支持只读；升级云端运行时后可开启写入。')
          : editing && writeSupport === 'unavailable' ? h('p', { className: 'pa-cap' }, '暂时无法确认写入能力，可以先保存为只读。')
            : editing && roots.some(root => root.writable) ? h('p', { className: 'pa-cap' }, '读写授权允许助理新建和修改该文件夹内的文本文件。') : null,
    waiting && !editing ? h('div', { role: 'status', className: 'pa-cap' }, '授权已保存，连接恢复后助理才能访问。') : null,
    error ? h('div', { role: 'alert', className: 'pa-note danger' }, icon(h, 'warn', { size: 14 }), error) : null,
    h('div', { className: 'pa-local-actions' },
      hasGrant && !editing ? button({ h, label: '撤销授权', variant: 'danger', size: 'sm', busy: busy === 'revoke', busyLabel: '撤销中…', onClick: actions.onRevoke }) : null,
      hasGrant && !editing && !foreign ? button({ h, label: '编辑权限', variant: 'secondary', size: 'sm', disabled: !canEdit || Boolean(busy), onClick: actions.onEdit }) : null,
      editing && hasGrant ? button({ h, label: '取消', variant: 'ghost', size: 'sm', disabled: Boolean(busy), onClick: actions.onCancelEdit }) : null,
      editing && canPick ? button({ h, label: '保存授权', variant: 'primary', size: 'sm', busy: busy === 'grant', busyLabel: '保存中…',
        disabled: !canEdit || !roots.length || Boolean(busy) || (writeSupport !== true && roots.some(root => root.writable)), onClick: actions.onGrant }) : null));
}
