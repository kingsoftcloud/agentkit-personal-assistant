/**
 * 「Bot 列表」视图（画板 03 Bots.dc.html）。
 *
 * 纯函数：只接收 index.mjs 归一化后的 overview 数据与回调，不发请求。
 * 首次进入（loading 且还没有任何数据）先渲染骨架，数据到后整块替换。
 */

import { TOKENS, badge, button, card, chevronDownIcon, chevronRightIcon, divider, dotGlyph, emptyState, formatElapsed, noticeBar, skeletonBlock, skeletonCard, starIcon, styles, checkIcon, warningIcon, calendarIcon, folderIcon } from './ui.mjs';

const STATUS_TEXT = { running: '运行中', idle: '空闲', offline: '离线' };
const COMPUTER_TEXT = { connected: '已连接', idle: '空闲', offline: '未连接' };
const initials = name => [...String(name || '助').trim()][0] || '助';

function botAvatar({ h, name, size = 36, soft = false }) {
  return h('span', {
    'aria-hidden': 'true',
    style: {
      ...styles.avatar, width: size, height: size, fontSize: size >= 36 ? 14 : 12,
      background: soft ? TOKENS.avatarSoft : TOKENS.ink, color: soft ? TOKENS.avatarInk : '#ffffff',
    },
  }, initials(name));
}

function statusBadge({ h, status }) {
  const tone = status === 'running' ? 'success' : 'neutral';
  return badge({ h, label: STATUS_TEXT[status] || '空闲', tone, dot: tonelessDot(status) });
}
const tonelessDot = status => status !== 'running';

function primaryCard({ h, bot, actions }) {
  return card({ h, style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 14 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
      botAvatar({ h, name: bot.name, size: 36 }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, bot.name),
          bot.role === 'primary' ? badge({ h, label: '主助理' }) : null,
          statusBadge({ h, status: bot.status })),
        h('div', { style: { ...styles.meta, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          `${bot.model || '默认模型'} · 关掉 Studio 也会继续工作`)),
      button({ h, label: '进入', variant: 'primary', ariaLabel: `进入${bot.name}`, onClick: () => actions.onEnter?.(bot.id), icon: chevronRightIcon({ h, size: 10, color: '#ffffff' }) })),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, paddingTop: 14, borderTop: `1px solid ${TOKENS.border}` } },
      stat({ h, label: '记忆', value: `${bot.memoryCount || 0} 条偏好`, onClick: () => actions.onOpenMemory?.(bot.id) }),
      stat({ h, label: '能力', value: `${bot.capabilityCount || 0} 项已启用`, onClick: () => actions.onOpenDetail?.(bot.id) }),
      stat({ h, label: '云电脑', value: COMPUTER_TEXT[bot.computer] || '未连接', tone: bot.computer === 'connected' ? 'success' : 'inherit', onClick: () => actions.onOpenComputer?.(bot.id) })));
}

function stat({ h, label, value, tone = 'inherit', onClick = null }) {
  return h('a', {
    href: '#', 'data-pa-stat': label, onClick: event => { event.preventDefault(); onClick?.(); },
    style: { display: 'flex', flexDirection: 'column', gap: 3, padding: 8, borderRadius: 8, color: TOKENS.ink, textDecoration: 'none' },
  },
  h('span', { style: { fontSize: 11, color: TOKENS.inkMuted, letterSpacing: '0.04em' } }, label),
  h('span', { style: { fontSize: 13, fontWeight: 500, color: tone === 'success' ? TOKENS.success : TOKENS.ink } }, value));
}

function otherBots({ h, bots, actions }) {
  if (!bots.length) return null;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
      h('span', { style: styles.sectionTitle }, '其他 Bot'),
      h('span', { style: styles.meta }, '模型、记忆、能力各自独立')),
    bots.map(bot => h('a', {
      key: bot.id, href: '#', 'data-pa-bot-row': bot.id,
      onClick: event => { event.preventDefault(); actions.onOpenBot?.(bot.id); },
      style: { display: 'flex', alignItems: 'center', gap: 10, padding: 12, border: `1px solid ${TOKENS.border}`, borderRadius: 12, color: TOKENS.ink, textDecoration: 'none' },
    },
    botAvatar({ h, name: bot.name, size: 30, soft: true }),
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { fontSize: 13, fontWeight: 600 } }, bot.name),
        badge({ h, label: STATUS_TEXT[bot.status] || '空闲' })),
      h('div', { style: { ...styles.meta, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        `${bot.model || '默认模型'} · 记忆 ${bot.memoryCount || 0} 条 · 能力 ${bot.capabilityCount || 0} 项`)),
    chevronRightIcon({ h, size: 12 }))));
}

function activityRow({ h, item, actions }) {
  if (item.kind === 'approval') {
    return h('a', {
      key: item.id, href: '#', 'data-pa-activity': 'approval',
      onClick: event => { event.preventDefault(); actions.onApprove?.(item.approvalId); },
      style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderRadius: 8, background: '#fff0d6', color: TOKENS.ink, textDecoration: 'none' },
    },
    warningIcon({ h, size: 14, color: TOKENS.warn }),
    activityText({ h, item, detailStyle: { color: TOKENS.warn } }),
    h('span', { style: { flex: 'none', height: 28, padding: '0 10px', display: 'inline-flex', alignItems: 'center', border: '1px solid #e0c894', borderRadius: 8, background: '#ffffff', fontSize: 12, color: TOKENS.warn } }, '去确认'));
  }
  if (item.kind === 'turn') {
    return h('a', {
      key: item.id, href: '#', 'data-pa-activity': 'turn',
      onClick: event => { event.preventDefault(); actions.onOpenChat?.(item.botId); },
      style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderRadius: 8, background: TOKENS.surface2, color: TOKENS.ink, textDecoration: 'none' },
    },
    dotGlyph({ h, tone: 'success' }),
    activityText({ h, item }),
    h('span', { style: { flex: 'none', fontSize: 11, color: TOKENS.success } }, '进行中'));
  }
  const done = item.status !== 'failed';
  return h('a', {
    key: item.id, href: '#', 'data-pa-activity': done ? 'done' : 'failed',
    onClick: event => { event.preventDefault(); actions.onOpenChat?.(item.botId); },
    style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderRadius: 8, color: TOKENS.ink, textDecoration: 'none' },
  },
  done ? checkIcon({ h, size: 14, color: TOKENS.success }) : warningIcon({ h, size: 14, color: TOKENS.warn }),
  activityText({ h, item }));
}

function activityText({ h, item, detailStyle = null }) {
  return h('div', { style: { flex: 1, minWidth: 0 } },
    h('div', { style: { fontSize: 13, fontWeight: item.kind === 'approval' || item.kind === 'turn' ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
    h('div', { style: { ...styles.meta, ...(detailStyle || {}), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, activityDetail({ item })));
}

function activityDetail({ item }) {
  if (item.detail) return item.detail;
  if (item.kind === 'turn') {
    const who = item.botName ? `${item.botName}正在云电脑上执行` : '正在云电脑上执行';
    return item.elapsedMs ? `${who} · 已运行 ${formatElapsed(item.elapsedMs)}` : who;
  }
  if (item.kind === 'approval') return '不可撤销 · 30 秒内不确认会自动取消';
  return item.botName ? `${item.botName} · ${item.at || ''}`.trim() : (item.at || '');
}

function activitySection({ h, active, recent, showAll, actions }) {
  const rows = [...(active || []), ...(recent || [])];
  const visible = showAll ? rows : rows.slice(0, 4);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, flex: '1 1 auto', minHeight: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
      h('span', { style: styles.sectionTitle }, '正在发生'),
      rows.length > 4 ? button({ h, label: showAll ? '收起' : '全部', variant: 'link', style: { fontSize: 12, color: TOKENS.inkSoft, padding: '2px 4px' }, onClick: () => actions.onToggleActivity?.() }) : null),
    rows.length === 0
      ? emptyState({ h, title: '暂时没有正在进行的任务', detail: '助理在云端执行的任务会实时显示在这里。' })
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, visible.map(item => activityRow({ h, item, actions }))));
}

function shortcuts({ h, counts, actions }) {
  const cards = [
    { id: 'schedules', icon: calendarIcon, label: '日程与自动化', detail: counts?.schedules ? `${counts.schedules} 个定时任务` : '定时任务' },
    { id: 'memories', icon: starIcon, label: '记忆', detail: counts?.memories ? `${counts.memories} 条偏好` : '长期偏好' },
    { id: 'files', icon: folderIcon, label: '工作区文件', detail: counts?.files ? `${counts.files} 个文件` : '云端文件' },
  ];
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 } },
    cards.map(item => h('a', {
      key: item.id, href: '#', 'data-pa-shortcut': item.id,
      onClick: event => { event.preventDefault(); actions.onOpenShortcut?.(item.id); },
      style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 12, border: `1px solid ${TOKENS.border}`, borderRadius: 10, color: TOKENS.ink, textDecoration: 'none' },
    },
    item.icon({ h, size: 16 }),
    h('span', { style: { fontSize: 12 } }, item.label),
    h('span', { style: { fontSize: 11, color: TOKENS.inkMuted, lineHeight: 1.5 } }, item.detail))));
}

/** 底部「历史会话」：仅按需展开，不作为主视图。 */
function historyEntry({ h, open, loading, error, sessions, actions }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, flex: 'none' } },
    h('button', {
      type: 'button', 'data-pa-history-toggle': open ? 'open' : 'closed', 'aria-expanded': open ? 'true' : 'false',
      onClick: () => actions.onToggleHistory?.(),
      style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', background: 'transparent', color: TOKENS.ink, font: 'inherit', fontSize: 12, cursor: 'pointer', padding: '2px 0' },
    },
    h('span', { style: styles.sectionTitle }, '历史会话'),
    h('span', { style: styles.meta }, sessions.length ? `${sessions.length} 个` : '按需打开'),
    h('span', { style: { flex: 1 } }),
    open ? chevronDownIcon({ h, size: 12 }) : chevronRightIcon({ h, size: 12 })),
    open ? h('div', { style: { ...styles.card, padding: 4 } },
      loading ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8 } },
        skeletonBlock({ h, width: '62%', height: 11, style: { background: TOKENS.skeletonStrong } }),
        skeletonBlock({ h, width: '48%', height: 11, style: { background: TOKENS.skeletonStrong } }),
        skeletonBlock({ h, width: '55%', height: 11, style: { background: TOKENS.skeletonStrong } }))
        : error ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: 8 } },
          h('span', { style: { ...styles.note, color: TOKENS.danger, flex: 1 } }, error),
          button({ h, label: '重试', variant: 'ghost', style: { height: 26, padding: '0 8px' }, onClick: () => actions.onToggleHistory?.(true) }))
          : sessions.length === 0 ? h('div', { style: { ...styles.note, padding: 8 } }, '还没有历史会话')
            : sessions.map((session, index) => h('button', {
              key: session.id || `session-${index}`, type: 'button',
              onClick: () => actions.onOpenSession?.(session.id),
              style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', borderTop: index === 0 ? 'none' : `1px solid ${TOKENS.divider}`, background: 'transparent', color: TOKENS.ink, font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer', padding: '10px 12px' },
            },
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, session.title || session.id),
            session.at ? h('span', { style: styles.meta }, session.at) : null,
            chevronRightIcon({ h, size: 11 })))) : null);
}

/** 骨架屏：与真实布局同构，加载完成不跳版。 */
function listSkeleton({ h }) {
  return h('div', { 'data-pa-list-skeleton': 'true', style: { display: 'flex', flexDirection: 'column', gap: 16 } },
    skeletonCard({ h, rows: 3, pad: 16 }),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      skeletonBlock({ h, width: 96, height: 12 }),
      skeletonCard({ h, rows: 2, pad: 12 })),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      skeletonBlock({ h, width: 72, height: 12 }),
      skeletonCard({ h, rows: 3, pad: 12 })));
}

export function renderBotsList({
  h, connection = null, loading = false, degraded = false, notice = '',
  bots = [], active = [], recent = [], counts = null, showAllActivity = false,
  historyOpen = false, historyLoading = false, historyError = '', sessions = [],
  actions = {},
} = {}) {
  const list = Array.isArray(bots) ? bots.filter(bot => bot && bot.id) : [];
  const primary = list.find(bot => bot.role === 'primary') || list[0] || null;
  const others = list.filter(bot => bot !== primary);
  const empty = !loading && list.length === 0;
  return [
    noticeBar({ h, text: degraded ? '部分数据暂不可用：云端概览没有返回，下面展示的是本地缓存的概要。' : notice, tone: degraded ? 'warn' : 'neutral' }),
    loading && list.length === 0 ? listSkeleton({ h }) : null,
    empty ? emptyState({ h, title: '还没有可用的 Bot', detail: '创建第一个 Bot 后即可开始对话；云端初始化完成后会自动出现在这里。' }) : null,
    primary ? primaryCard({ h, bot: primary, actions }) : null,
    otherBots({ h, bots: others, actions }),
    !empty ? activitySection({ h, active, recent, showAll: showAllActivity, actions }) : null,
    !empty ? shortcuts({ h, counts, actions }) : null,
    !empty ? divider({ h }) : null,
    !empty ? historyEntry({ h, open: historyOpen, loading: historyLoading, error: historyError, sessions, actions }) : null,
  ];
}
