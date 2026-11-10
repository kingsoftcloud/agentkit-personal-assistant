/**
 * 「Bot 详情」视图（画板 04 BotDetail.dc.html）。
 *
 * 纯函数：模型、记忆、能力、云电脑数据由 index.mjs 拉取后传入；
 * 记忆管理模式、删除二次确认等交互状态同样由 index.mjs 持有，视图只负责渲染与回调。
 */

import { TOKENS, badge, button, card, emptyState, infoIcon, listRow, monitorIcon, noticeBar, sectionHeader, skeletonBlock, skeletonCard, styles, warningIcon } from './ui.mjs';

const ROLE_TEXT = { primary: '主助理', custom: 'Bot' };
const STATUS_TEXT = { running: '运行中', idle: '空闲', offline: '离线' };

const modelDetail = bot => {
  const value = String(bot?.modelDetail || '').trim();
  return value || '支持工具调用 · 上下文 128K';
};

function profile({ h, bot }) {
  const meta = [
    bot.createdAt ? `创建于 ${bot.createdAt}` : '',
    bot.lastActiveAt ? `最近活跃 ${bot.lastActiveAt}` : '',
    '关掉 DSH Host 也会继续工作',
  ].filter(Boolean).join(' · ');
  return h('section', { style: { display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 12, borderBottom: `1px solid ${TOKENS.border}` } },
    h('span', { 'aria-hidden': 'true', style: { ...styles.avatar, width: 44, height: 44, fontSize: 16 } }, [...String(bot.name || '助')][0] || '助'),
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontSize: 12, color: TOKENS.inkSoft, lineHeight: 1.7 } }, bot.description || '常驻云端的个人助理，负责日常事务、资料整理与产出。'),
      h('div', { style: { fontSize: 11, color: TOKENS.inkMuted, lineHeight: 1.7 } }, meta)));
}

function modelSection({ h, bot, modelOptions, busy, actions }) {
  const options = Array.isArray(modelOptions) ? modelOptions.filter(Boolean) : [];
  const canSwitch = options.length > 1 && !busy;
  return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    sectionHeader({ h, title: '模型', meta: '切换后从下一条消息生效' }),
    h('div', { style: { ...styles.card, display: 'flex', alignItems: 'center', gap: 10, padding: 12 } },
      monitorIcon({ h, size: 16, color: TOKENS.inkSoft }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { ...styles.mono, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bot.model || '默认模型'),
        h('div', { style: { ...styles.note } }, modelDetail(bot))),
      button({
        h, label: busy === 'model' ? '切换中…' : '切换', variant: 'ghost',
        disabled: !canSwitch, title: canSwitch ? `可选：${options.join('、')}` : '暂时没有可切换的模型',
        onClick: () => actions.onChangeModel?.(options[(options.indexOf(bot.model) + 1) % options.length]),
      })));
}

function memorySection({ h, memory, manage, showAll, actions }) {
  const items = Array.isArray(memory?.items) ? memory.items : [];
  const count = Number.isFinite(Number(memory?.count)) ? Number(memory.count) : items.length;
  const visible = showAll ? items : items.slice(0, 5);
  return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
      h('span', { style: styles.sectionTitle }, '记忆', h('span', { style: { fontWeight: 400, color: TOKENS.inkMuted } }, ` · ${count} 条`)),
      button({ h, label: manage ? '完成' : '管理', variant: 'link', style: { fontSize: 12, color: TOKENS.inkSoft, padding: '2px 4px' }, disabled: items.length === 0, onClick: () => actions.onToggleManageMemory?.() })),
    items.length === 0
      ? card({ h, children: emptyState({ h, title: '还没有记忆', detail: '对话中确认过的偏好会沉淀在这里，可随时删除。' }) })
      : h('div', { style: { ...styles.card } },
        visible.map((item, index) => listRow({
          h, first: index === 0,
          children: [
            h('span', { key: 'dot', 'aria-hidden': 'true', style: { flex: 'none', width: 5, height: 5, borderRadius: 999, background: TOKENS.skeletonStrong } }),
            h('span', { key: 'text', style: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.text || ''),
            item.scope ? h('span', { key: 'scope', style: styles.meta }, item.scope) : null,
            manage ? button({ h, key: 'delete', label: '删除', variant: 'link', style: { fontSize: 11, color: TOKENS.danger, padding: '2px 4px' }, onClick: () => actions.onDeleteMemory?.(item.id) }) : null,
          ],
        })),
        items.length > 5 ? h('div', { style: { display: 'flex', justifyContent: 'center', padding: '6px 0' } },
          button({ h, label: showAll ? '收起' : `展开全部 ${items.length} 条`, variant: 'link', style: { fontSize: 11 }, onClick: () => actions.onToggleAllMemory?.() })) : null));
}

function capabilitySection({ h, capabilities, actions }) {
  const items = Array.isArray(capabilities) ? capabilities : [];
  return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
      h('span', { style: styles.sectionTitle }, '能力', h('span', { style: { fontWeight: 400, color: TOKENS.inkMuted } }, ` · ${items.length} 项`)),
      button({ h, label: '添加', variant: 'link', style: { fontSize: 12, color: TOKENS.inkSoft, padding: '2px 4px' }, onClick: () => actions.onAddCapability?.() })),
    items.length === 0
      ? card({ h, children: emptyState({ h, title: '还没有配置能力', detail: '内置能力默认可用，也可以接入 MCP 服务。' }) })
      : h('div', { style: styles.card },
        items.map((item, index) => listRow({
          h, first: index === 0,
          children: [
            h('span', { key: 'label', style: { flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.label || item.id || '能力'),
            item.status === 'error'
              ? badge({ h, key: 'status', label: '异常', tone: 'danger' })
              : badge({ h, key: 'source', label: item.source === 'mcp' ? 'MCP' : '内置', tone: item.source === 'mcp' ? 'accent' : 'neutral' }),
          ],
        }))));
}

function computerSection({ h, computer, actions }) {
  const usage = computer?.usage || null;
  return h('section', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 } },
    h('div', { style: { ...styles.card, padding: 12, display: 'flex', flexDirection: 'column', gap: 3 } },
      h('span', { style: { fontSize: 11, color: TOKENS.inkMuted, letterSpacing: '0.04em' } }, '云电脑'),
      h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500 } },
        computer?.connected ? '已连接' : '未连接',
        computer?.resolution ? h('span', { style: { fontWeight: 400, color: TOKENS.inkMuted } }, computer.resolution) : null)),
    h('div', { style: { ...styles.card, padding: 12, display: 'flex', flexDirection: 'column', gap: 3 } },
      h('span', { style: { fontSize: 11, color: TOKENS.inkMuted, letterSpacing: '0.04em' } }, '本周用量'),
      h('span', { style: { fontSize: 12, fontWeight: 500 } }, usage ? `${usage.tokens || '—'} tokens · ${usage.hours || '—'} 小时` : '暂无数据')));
}

function deleteSection({ h, bot, confirm, actions }) {
  const canConfirm = Boolean(bot?.name) && String(confirm?.text || '').trim() === bot.name;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: `1px solid ${TOKENS.border}` } },
    confirm?.open
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px', borderRadius: 12, background: 'color-mix(in srgb, #b42318 4%, transparent)', border: '1px solid color-mix(in srgb, #b42318 30%, transparent)' } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.7, color: TOKENS.danger } },
          warningIcon({ h, size: 14, color: TOKENS.danger }),
          h('span', null, `删除后不可恢复。请输入「${bot?.name || ''}」确认：`)),
        h('input', {
          value: confirm?.text || '', placeholder: bot?.name || '', 'aria-label': '输入 Bot 名称以确认删除',
          disabled: Boolean(confirm?.busy), onChange: event => actions.onDeleteText?.(String(event?.target?.value ?? '')),
          style: { ...styles.mono, fontSize: 12, padding: '6px 9px', borderRadius: 8, border: `1px solid ${TOKENS.border}`, width: '100%', maxWidth: 360, boxSizing: 'border-box' },
        }),
        confirm?.error ? h('div', { role: 'alert', style: { ...styles.note, color: TOKENS.danger } }, confirm.error) : null,
        h('div', { style: { display: 'flex', gap: 8 } },
          button({ h, label: confirm?.busy ? '正在删除…' : '确认删除', variant: 'primary', disabled: !canConfirm || Boolean(confirm?.busy), onClick: () => actions.onDeleteConfirm?.(), style: { background: TOKENS.danger } }),
          button({ h, label: '取消', variant: 'ghost', disabled: Boolean(confirm?.busy), onClick: () => actions.onDeleteCancel?.() })))
      : h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
        h('span', { style: { fontSize: 11, color: TOKENS.inkMuted } }, '删除只移除这个 Bot，云电脑与工作区文件会保留'),
        button({ h, label: '删除 Bot', variant: 'link', style: { fontSize: 12, color: TOKENS.danger, padding: 4 }, onClick: () => actions.onDeleteStart?.() })));
}

function detailSkeleton({ h }) {
  return h('div', { 'data-pa-detail-skeleton': 'true', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    skeletonCard({ h, rows: 2, pad: 16 }),
    skeletonBlock({ h, width: 64, height: 12 }),
    skeletonCard({ h, rows: 2, pad: 12 }),
    skeletonBlock({ h, width: 88, height: 12 }),
    skeletonCard({ h, rows: 4, pad: 12 }));
}

export function renderBotDetail({
  h, loading = false, degraded = false, notice = '', bot = null,
  memory = null, capabilities = [], computer = null, modelOptions = [],
  manageMemory = false, showAllMemory = false, modelBusy = '',
  deleteConfirm = { open: false, text: '', busy: false, error: '' },
  actions = {},
} = {}) {
  if (loading && !bot) return detailSkeleton({ h });
  if (!bot) return emptyState({ h, title: '暂时读不到 Bot 详情', detail: '云端没有返回这个 Bot 的数据，请返回列表后重试。' });
  return [
    noticeBar({ h, text: degraded ? '部分数据暂不可用：详情接口没有返回，下面展示的是列表里的概要信息。' : notice, tone: degraded ? 'warn' : 'neutral' }),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('span', { style: { fontSize: 14, fontWeight: 600 } }, bot.name),
      badge({ h, label: ROLE_TEXT[bot.role] || 'Bot' }),
      badge({ h, label: STATUS_TEXT[bot.status] || '空闲', tone: bot.status === 'running' ? 'success' : 'neutral', dot: bot.status === 'running' })),
    profile({ h, bot }),
    modelSection({ h, bot, modelOptions, busy: modelBusy, actions }),
    memorySection({ h, memory, manage: manageMemory, showAll: showAllMemory, actions }),
    capabilitySection({ h, capabilities, actions }),
    computerSection({ h, computer, actions }),
    h('div', { style: { flex: '1 1 auto', minHeight: 8 } }),
    deleteSection({ h, bot, confirm: deleteConfirm, actions }),
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11, color: TOKENS.inkMuted, lineHeight: 1.7 } },
      infoIcon({ h, size: 12 }),
      h('span', null, '模型、记忆与能力各自独立；切换模型只影响之后的新消息，不改正在运行的任务。')),
  ];
}
