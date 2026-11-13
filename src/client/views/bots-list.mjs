/**
 * 「总览」视图（重新设计 DEMO：Bot 列表 / 正在发生 / 快捷入口 / 历史会话）。
 *
 * 纯函数：只接收 index.mjs 归一化后的 overview 数据与回调，不发请求。
 * 首次进入（loading 且还没有任何数据）先渲染骨架，数据到后整块替换。
 */

import { avatar, badge, button, cx, dotGlyph, emptyState, group, icon, moreRow, row, section, skeletonRows } from './ui.mjs';

const STATUS_TEXT = { running: '运行中', idle: '空闲', offline: '离线' };

export function statusBadge({ h, status }) {
  if (status === 'running') return badge({ h, label: STATUS_TEXT.running, tone: 'success', dot: true, pulse: true });
  return badge({ h, label: STATUS_TEXT[status] || STATUS_TEXT.idle });
}

function botRow({ h, bot, actions }) {
  const primary = bot.role === 'primary';
  return row({
    h, className: 'click', role: 'button', tabIndex: 0, 'data-pa-bot-row': bot.id,
    onClick: () => actions.onOpenDetail?.(bot.id),
    onKeyDown: event => { if (event?.key === 'Enter') actions.onOpenDetail?.(bot.id); },
    children: [
      avatar({ h, key: 'avatar', name: bot.name, soft: !primary }),
      h('div', { key: 'body', className: 'pa-grow' },
        h('div', { className: 'pa-row-title' }, h('span', { className: 'pa-ellipsis' }, bot.name), primary ? badge({ h, label: '主助理' }) : null, statusBadge({ h, status: bot.status })),
        h('div', { className: 'pa-sub pa-ellipsis' }, `${bot.model || '默认模型'} · 记忆 ${bot.memoryCount || 0} · 能力 ${bot.capabilityCount || 0}`)),
      button({ h, key: 'chat', label: '对话', variant: primary ? 'primary' : 'secondary', size: 'sm', ariaLabel: `与${bot.name}对话`, 'data-pa-stat': primary ? '对话' : undefined, onClick: event => { event?.stopPropagation?.(); actions.onEnter?.(bot.id); } }),
      icon(h, 'chevR', { size: 14, color: 'var(--pa-ink-4)' }),
    ],
  });
}

function activityRow({ h, item, actions }) {
  if (item.kind === 'approval') {
    return row({ h, key: item.id, className: 'attention', 'data-pa-activity': 'approval', children: [
      h('span', { key: 'icon', className: 'pa-row-icon', style: { color: 'var(--pa-warn)' } }, icon(h, 'warn')),
      h('div', { key: 'body', className: 'pa-grow' },
        h('div', { className: 'pa-ellipsis pa-strong' }, item.title),
        h('div', { className: 'pa-cap pa-ellipsis', style: { color: 'var(--pa-warn)' } }, item.detail || '不可撤销 · 30 秒内不确认会自动取消')),
      button({ h, key: 'action', label: '去确认', size: 'sm', onClick: () => actions.onApprove?.(item.approvalId) }),
    ] });
  }
  const turn = item.kind === 'turn';
  const done = item.kind === 'turn' || item.status !== 'failed';
  const detail = item.detail || (turn
    ? `${item.botName ? `${item.botName} · ` : ''}正在云电脑上执行`
    : [item.botName, item.at].filter(Boolean).join(' · '));
  return row({
    h, key: item.id, as: 'button', 'data-pa-activity': turn ? 'turn' : done ? 'done' : 'failed',
    onClick: () => actions.onOpenChat?.(item.botId),
    children: [
      h('span', { key: 'icon', className: 'pa-row-icon' }, turn ? dotGlyph({ h, tone: 'accent', pulse: true }) : done ? icon(h, 'check', { color: 'var(--pa-ok)' }) : icon(h, 'warn', { color: 'var(--pa-danger)' })),
      h('span', { key: 'title', className: cx('pa-grow', 'pa-ellipsis', turn && 'pa-strong') }, item.title),
      detail ? h('span', { key: 'detail', className: 'pa-cap pa-hide-mid', style: { flex: 'none', whiteSpace: 'nowrap', ...(turn ? { color: 'var(--pa-accent)' } : {}) } }, detail) : null,
      icon(h, 'chevR', { size: 14, color: 'var(--pa-ink-4)' }),
    ],
  });
}

function shortcutTile({ h, id, name, label, detail, onClick }) {
  return h('button', { key: id, type: 'button', className: 'pa-tile', 'data-pa-shortcut': id, onClick },
    h('span', { className: 'pa-tile-ic' }, icon(h, name)),
    h('span', { className: 'pa-grow' },
      h('span', { className: 'pa-strong', style: { display: 'block' } }, label),
      h('span', { className: 'pa-cap', style: { display: 'block' } }, detail)));
}

function historySection({ h, open, loading, error, sessions, actions }) {
  return section({ h, key: 'history', children: group({ h, children: [
    row({
      h, key: 'toggle', as: 'button', compact: true, 'data-pa-history-toggle': open ? 'open' : 'closed', 'aria-expanded': open ? 'true' : 'false',
      onClick: () => actions.onToggleHistory?.(),
      children: [
        h('span', { key: 'icon', className: 'pa-row-icon' }, icon(h, 'clock')),
        h('span', { key: 'label', className: 'pa-grow pa-strong' }, '历史会话'),
        h('span', { key: 'count', className: 'pa-cap' }, sessions.length ? `${sessions.length} 个` : (open ? '' : '按需打开')),
        icon(h, open ? 'chevD' : 'chevR', { size: 14, color: 'var(--pa-ink-4)' }),
      ],
    }),
    open && loading ? skeletonRows({ h, rows: 3 }) : null,
    open && !loading && error ? row({ h, key: 'error', compact: true, children: [h('span', { className: 'pa-grow pa-sub', style: { color: 'var(--pa-danger)' } }, error), button({ h, label: '重试', size: 'sm', onClick: () => actions.onToggleHistory?.(true) })] }) : null,
    open && !loading && !error && sessions.length === 0 ? row({ h, key: 'empty', compact: true, children: h('span', { className: 'pa-sub' }, '还没有历史会话') }) : null,
    open && !loading && !error ? sessions.map(item => row({
      h, key: item.id, as: 'button', compact: true, onClick: () => actions.onOpenSession?.(item.id),
      children: [h('span', { key: 'pad', className: 'pa-row-icon' }), h('span', { key: 'title', className: 'pa-grow pa-ellipsis' }, item.title || item.id), item.at ? h('span', { key: 'at', className: 'pa-cap' }, item.at) : null],
    })) : null,
  ] }) });
}

function listSkeleton({ h }) {
  return h('div', { 'data-pa-list-skeleton': 'true', className: 'pa-page-inner' },
    section({ h, key: 'bots', title: 'Bot', children: group({ h, children: skeletonRows({ h, rows: 2, widths: ['38%', '52%'] }) }) }),
    section({ h, key: 'activity', title: '正在发生', children: group({ h, children: skeletonRows({ h, rows: 3 }) }) }));
}

export function renderBotsList({
  h, loading = false, degraded = false, notice = '',
  bots = [], active = [], recent = [], counts = null, showAllActivity = false,
  historyOpen = false, historyLoading = false, historyError = '', sessions = [],
  actions = {},
} = {}) {
  const list = Array.isArray(bots) ? bots.filter(bot => bot && bot.id) : [];
  const running = list.filter(bot => bot.status === 'running').length;
  const empty = !loading && list.length === 0;
  const rows = [...(active || []), ...(recent || [])];
  const visible = showAllActivity ? rows : rows.slice(0, 4);
  const memories = counts?.memories ?? list.reduce((sum, bot) => sum + (Number(bot.memoryCount) || 0), 0);
  if (loading && list.length === 0) return h('div', { className: 'pa-page' }, listSkeleton({ h }));
  return h('div', { className: 'pa-page', 'data-pa-scroll': 'home' }, h('div', { className: 'pa-page-inner' },
    degraded ? h('div', { className: 'pa-note', role: 'status' }, icon(h, 'info', { size: 16, style: { marginTop: 2 } }), h('span', null, '云端概览暂不可用，下面是本地缓存的概要')) : null,
    section({ h, key: 'bots', title: 'Bot', count: `${list.length} 个 Bot · ${running} 个运行中`, children: empty
      ? group({ h, children: emptyState({ h, title: '还没有可用的 Bot', detail: '创建第一个 Bot 后即可开始对话', action: button({ h, label: '新建 Bot', variant: 'primary', size: 'sm', icon: icon(h, 'plus', { size: 14 }), onClick: () => actions.onCreateBot?.() }) }) })
      : group({ h, children: list.map(bot => botRow({ h, key: bot.id, bot, actions })) }) }),
    empty ? null : section({ h, key: 'activity', title: '正在发生', children: group({ h, children: rows.length === 0
      ? emptyState({ h, title: '暂时没有正在进行的任务', detail: '助理在云端执行的任务会实时显示在这里' })
      : [...visible.map(item => activityRow({ h, item, actions })), rows.length > 4 ? moreRow({ h, label: showAllActivity ? '收起' : `查看全部 ${rows.length} 条`, onClick: () => actions.onToggleActivity?.() }) : null] }) }),
    empty ? null : section({ h, key: 'shortcuts', title: '快捷入口', children: h('div', { className: 'pa-tiles' },
      shortcutTile({ h, id: 'schedules', name: 'calendar', label: '日程与自动化', detail: counts?.schedules ? `${counts.schedules} 个定时任务` : '定时任务', onClick: () => actions.onOpenShortcut?.('schedules') }),
      shortcutTile({ h, id: 'memories', name: 'star', label: '记忆', detail: memories ? `${memories} 条偏好` : '长期偏好', onClick: () => actions.onOpenShortcut?.('memories') }),
      shortcutTile({ h, id: 'files', name: 'folder', label: '工作区文件', detail: counts?.files ? `${counts.files} 个文件` : '云端文件', onClick: () => actions.onOpenShortcut?.('files') })) }),
    empty ? null : historySection({ h, open: historyOpen, loading: historyLoading, error: historyError, sessions, actions }),
  ));
}
