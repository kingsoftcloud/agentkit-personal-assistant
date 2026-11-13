/**
 * 「Bot 详情」视图（重新设计 DEMO：身份 / 模型 / 记忆 / 能力 / 资源 / 删除）。
 *
 * 纯函数：模型、记忆、能力、云电脑数据由 index.mjs 拉取后传入；
 * 记忆管理模式、模型菜单、删除二次确认等交互状态同样由 index.mjs 持有。
 */

import { avatar, badge, button, emptyState, group, icon, iconButton, link, menu, modelNote, moreRow, row, section, skeletonBlock, skeletonRows } from './ui.mjs';
import { statusBadge } from './bots-list.mjs';

const CAPABILITY_ICON = { computer: 'monitor', files: 'folder', workspace: 'folder', calendar: 'calendar', browser: 'globe', mcp: 'bolt' };
const capabilityIcon = item => {
  const key = `${item?.id || ''} ${item?.label || ''}`.toLowerCase();
  if (/computer|云电脑|desktop/u.test(key)) return 'monitor';
  if (/file|文件|workspace|工作区/u.test(key)) return 'folder';
  if (/calendar|日历|日程|schedule/u.test(key)) return 'calendar';
  if (/browser|浏览器|web/u.test(key)) return 'globe';
  return CAPABILITY_ICON[item?.source] || 'bolt';
};

function identity({ h, bot, actions }) {
  const meta = [bot.createdAt ? `创建于 ${bot.createdAt}` : '', bot.lastActiveAt ? `最近活跃 ${bot.lastActiveAt}` : ''].filter(Boolean).join(' · ');
  return h('div', { className: 'pa-identity' },
    avatar({ h, name: bot.name, size: 's48', soft: bot.role !== 'primary' }),
    h('div', { className: 'pa-grow' },
      h('h1', null, bot.name, bot.role === 'primary' ? badge({ h, label: '主助理' }) : null, statusBadge({ h, status: bot.status })),
      h('p', { className: 'pa-sub' }, bot.description || '常驻云端的个人助理，负责日常事务、资料整理与产出。'),
      meta ? h('p', { className: 'pa-cap' }, meta) : null),
    button({ h, label: '对话', variant: 'primary', icon: icon(h, 'chat', { size: 14 }), onClick: () => actions.onOpenChat?.(bot.id) }));
}

function modelSection({ h, bot, modelOptions, busy, menuOpen, actions }) {
  const options = Array.isArray(modelOptions) ? modelOptions.filter(Boolean) : [];
  const canSwitch = options.length > 0 && !busy;
  return section({ h, title: '模型', right: h('span', { className: 'pa-cap' }, '下一条消息生效'), children: group({ h, visible: true, children: row({ h, children: [
    h('div', { key: 'body', className: 'pa-grow' },
      h('div', { className: 'pa-mono pa-ellipsis' }, bot.model || '默认模型'),
      h('div', { className: 'pa-cap' }, bot.modelDetail || modelNote(bot.model))),
    h('span', { key: 'switch', className: 'pa-anchor' },
      button({ h, label: busy === 'model' ? '切换中…' : '切换', size: 'sm', disabled: !canSwitch, pressed: menuOpen, title: canSwitch ? '' : '暂时没有可切换的模型', icon: null, onClick: () => actions.onToggleModelMenu?.() }, ),
      menuOpen ? menu({ h, className: 'right', 'aria-label': '选择模型', items: options.map(option => ({ id: option, label: option, mono: true, detail: modelNote(option), checked: option === bot.model, onClick: () => actions.onChangeModel?.(option) })) }) : null),
  ] }) }) });
}

function memorySection({ h, memory, manage, showAll, actions }) {
  const items = Array.isArray(memory?.items) ? memory.items : [];
  const count = Number.isFinite(Number(memory?.count)) ? Number(memory.count) : items.length;
  const visible = showAll ? items : items.slice(0, 5);
  return section({ h, title: '记忆', count: `${count} 条`, right: items.length ? link({ h, label: manage ? '完成' : '管理', onClick: () => actions.onToggleManageMemory?.() }) : null, children: group({ h, children: items.length === 0
    ? emptyState({ h, title: '还没有记忆', detail: '对话中确认过的偏好会沉淀在这里' })
    : [
      ...visible.map(item => row({ h, key: item.id, compact: true, children: [
        h('i', { key: 'dot', className: 'pa-dot' }),
        h('span', { key: 'text', className: 'pa-grow pa-ellipsis' }, item.text || ''),
        item.scope ? h('span', { key: 'scope', className: 'pa-cap' }, item.scope) : null,
        manage ? iconButton({ h, key: 'delete', name: 'trash', size: 'sm', iconSize: 14, label: '删除这条记忆', style: { color: 'var(--pa-danger)' }, onClick: () => actions.onDeleteMemory?.(item.id) }) : null,
      ] })),
      items.length > 5 ? moreRow({ h, label: showAll ? '收起' : `展开全部 ${items.length} 条`, onClick: () => actions.onToggleAllMemory?.() }) : null,
    ] }) });
}

function capabilitySection({ h, capabilities, actions }) {
  const items = Array.isArray(capabilities) ? capabilities : [];
  return section({ h, title: '能力', count: `${items.length} 项`, right: link({ h, label: '添加', onClick: () => actions.onAddCapability?.() }), children: group({ h, children: items.length === 0
    ? emptyState({ h, title: '还没有配置能力', detail: '内置能力默认可用，也可以接入 MCP 服务' })
    : items.map((item, index) => row({ h, key: item.id || index, compact: true, children: [
      h('span', { key: 'icon', className: 'pa-row-icon' }, icon(h, capabilityIcon(item))),
      h('span', { key: 'label', className: 'pa-grow pa-ellipsis' }, item.label || item.id || '能力'),
      item.status === 'error' ? badge({ h, label: '异常', tone: 'danger' }) : badge({ h, label: item.source === 'mcp' ? 'MCP' : '内置', tone: item.source === 'mcp' ? 'accent' : 'neutral' }),
    ] })) }) });
}

function resourceSection({ h, computer, actions }) {
  const usage = computer?.usage || null;
  return section({ h, title: '资源', children: group({ h, children: h('div', { className: 'pa-kv' },
    h('div', null,
      h('span', { className: 'pa-cap' }, '云电脑'),
      h('span', { className: 'pa-kv-value' },
        computer?.connected ? '已连接' : '未连接',
        computer?.resolution ? h('span', { className: 'pa-cap' }, computer.resolution) : null,
        typeof actions?.onOpenComputer === 'function' ? link({ h, label: '打开云电脑', tone: 'accent', style: { marginLeft: 'auto', fontWeight: 400 }, onClick: () => actions.onOpenComputer?.() }) : null)),
    h('div', null,
      h('span', { className: 'pa-cap' }, '本周用量'),
      h('span', { className: 'pa-kv-value' }, usage ? `${usage.tokens || '—'} tokens · ${usage.hours || '—'} 小时` : '暂无数据'))) }) });
}

function deleteSection({ h, bot, confirm, actions }) {
  const canConfirm = Boolean(bot?.name) && String(confirm?.text || '').trim() === bot.name;
  return section({ h, children: group({ h, danger: true, children: confirm?.open
    ? h('div', { className: 'pa-confirm' },
      h('div', { className: 'pa-confirm-text' }, icon(h, 'warn', { size: 16, style: { marginTop: 3 } }), h('span', null, `删除后不可恢复。输入「${bot?.name || ''}」确认：`)),
      h('input', {
        className: 'pa-input', value: confirm?.text || '', placeholder: bot?.name || '', 'aria-label': '输入 Bot 名称以确认删除', style: { maxWidth: 320 },
        disabled: Boolean(confirm?.busy), onChange: event => actions.onDeleteText?.(String(event?.target?.value ?? '')),
      }),
      confirm?.error ? h('div', { role: 'alert', className: 'pa-cap', style: { color: 'var(--pa-danger)' } }, confirm.error) : null,
      h('div', { style: { display: 'flex', gap: 8 } },
        button({ h, label: confirm?.busy ? '正在删除…' : '确认删除', variant: 'dangerFill', size: 'sm', disabled: !canConfirm || Boolean(confirm?.busy), onClick: () => actions.onDeleteConfirm?.() }),
        button({ h, label: '取消', variant: 'ghost', size: 'sm', disabled: Boolean(confirm?.busy), onClick: () => actions.onDeleteCancel?.() })))
    : row({ h, children: [
      h('div', { key: 'body', className: 'pa-grow' }, h('div', { className: 'pa-strong' }, '删除 Bot'), h('div', { className: 'pa-cap' }, '云电脑与工作区文件会保留')),
      button({ h, key: 'action', label: '删除', variant: 'danger', size: 'sm', onClick: () => actions.onDeleteStart?.() }),
    ] }) }) });
}

function detailSkeleton({ h }) {
  return h('div', { 'data-pa-detail-skeleton': 'true', className: 'pa-page-inner' },
    h('div', { className: 'pa-identity' }, skeletonBlock({ h, width: 48, height: 48 }), h('div', { className: 'pa-grow', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, skeletonBlock({ h, width: '32%', height: 16 }), skeletonBlock({ h, width: '58%' }))),
    section({ h, key: 'model', title: '模型', children: group({ h, children: skeletonRows({ h, rows: 1 }) }) }),
    section({ h, key: 'memory', title: '记忆', children: group({ h, children: skeletonRows({ h, rows: 3 }) }) }));
}

export function renderBotDetail({
  h, loading = false, degraded = false, bot = null,
  memory = null, capabilities = [], computer = null, modelOptions = [],
  manageMemory = false, showAllMemory = false, modelBusy = '', modelMenuOpen = false,
  deleteConfirm = { open: false, text: '', busy: false, error: '' },
  actions = {},
} = {}) {
  if (loading && !bot) return h('div', { className: 'pa-page' }, detailSkeleton({ h }));
  if (!bot) return h('div', { className: 'pa-page' }, emptyState({ h, title: '暂时读不到 Bot 详情', detail: '云端没有返回这个 Bot 的数据，请返回总览后重试', action: button({ h, label: '返回总览', size: 'sm', onClick: () => actions.onBack?.() }) }));
  return h('div', { className: 'pa-page', 'data-pa-scroll': 'detail' }, h('div', { className: 'pa-page-inner' },
    h('button', { type: 'button', className: 'pa-back', 'aria-label': '返回', title: '返回总览', onClick: () => actions.onBack?.() }, icon(h, 'chevL', { size: 14 }), '总览'),
    identity({ h, bot, actions }),
    degraded ? h('div', { className: 'pa-note', role: 'status' }, icon(h, 'info', { size: 16, style: { marginTop: 2 } }), h('span', null, '详情接口暂不可用，下面是总览里的概要')) : null,
    modelSection({ h, bot, modelOptions, busy: modelBusy, menuOpen: modelMenuOpen, actions }),
    memorySection({ h, memory, manage: manageMemory, showAll: showAllMemory, actions }),
    capabilitySection({ h, capabilities, actions }),
    resourceSection({ h, computer, actions }),
    deleteSection({ h, bot, confirm: deleteConfirm, actions }),
  ));
}
