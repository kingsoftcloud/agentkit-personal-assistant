/**
 * 「设置」视图（重新设计 DEMO：实例 / 本机授权 / 模型 / 提示词 / 环境变量 / 运行时 / 关闭）。
 *
 * 纯函数：草稿 draft 与保存由 index.mjs 持有；这里只渲染与派发 onXxx 回调。
 * 敏感值不回显：已保存的敏感变量显示掩码，留空表示不修改。
 */

import { badge, button, connectionStateOf, CONNECTION_COPY, emptyState, group, icon, iconButton, link, menu, modelNote, row, section, skeletonRows, switchControl } from './ui.mjs';

function instanceSection({ h, instance, inspect }) {
  const configured = instance?.configured === true;
  const statusText = String(inspect?.status || instance?.status || (configured ? '运行中' : '未开通'));
  return section({ h, title: '实例', children: group({ h, children: [
    row({ h, key: 'id', children: [
      h('div', { key: 'body', className: 'pa-grow' },
        h('div', { className: 'pa-row-title' }, '个人助理', badge({ h, label: statusText, tone: /运行|就绪|正常/u.test(statusText) ? 'success' : configured ? 'neutral' : 'warn', dot: true })),
        h('div', { className: 'pa-cap pa-mono pa-ellipsis', style: { fontSize: 12 } }, configured ? `实例 ${instance?.agentId || '未知'}` : '开通后可在这里管理云端配置')),
      instance?.version ? h('span', { key: 'version', className: 'pa-cap' }, `云端版本 ${instance.version}`) : null,
    ] }),
  ] }) });
}

function localSection({ h, localAccess, actions }) {
  const state = connectionStateOf(localAccess);
  const authorized = state === 'authorized';
  return section({ h, title: '本机授权', children: group({ h, children: row({ h, children: [
    h('div', { key: 'body', className: 'pa-grow' },
      h('div', { className: 'pa-row-title' }, '允许助理控制本机', badge({ h, label: CONNECTION_COPY[state], tone: authorized ? 'success' : state === 'connected' ? 'warn' : 'neutral', dot: true })),
      h('div', { className: 'pa-cap' }, '发起新会话、操作本地窗口与文件；高风险操作前先问你')),
    link({ h, key: 'detail', label: '详情', onClick: () => actions.onOpenLocalAccess?.() }),
    switchControl({ h, checked: authorized, disabled: state === 'offline', label: '允许助理控制本机', onChange: next => (next ? actions.onOpenLocalAccess?.() : actions.onRevokeLocal?.()) }),
  ] }) }) });
}

function modelSection({ h, draft, modelOptions, editable, menuOpen, actions }) {
  const options = Array.isArray(modelOptions) ? modelOptions.filter(Boolean) : [];
  const current = draft?.model || options[0] || '';
  return section({ h, title: '模型', children: group({ h, visible: true, children: h('span', { className: 'pa-anchor block' },
    h('button', {
      type: 'button', className: 'pa-row click pa-select', 'aria-label': '模型', 'aria-haspopup': 'listbox', 'aria-expanded': menuOpen ? 'true' : 'false', disabled: !editable || options.length === 0,
      onClick: () => actions.onToggleModelMenu?.(),
    },
    h('span', { className: 'pa-grow' }, h('span', { className: 'pa-mono', style: { display: 'block' } }, current || '默认模型'), h('span', { className: 'pa-cap', style: { display: 'block' } }, modelNote(current))),
    icon(h, 'chevD', { size: 14, color: 'var(--pa-ink-3)' })),
    menuOpen ? menu({ h, className: 'full', role: 'listbox', 'aria-label': '选择模型', items: options.map(option => ({ id: option, label: option, mono: true, detail: modelNote(option), checked: option === current, onClick: () => { actions.onModelChange?.(option); actions.onToggleModelMenu?.(false); } })) }) : null) }) });
}

function promptSection({ h, draft, editable, actions }) {
  return section({ h, title: '系统提示词', right: h('span', { className: 'pa-cap' }, '保存后对所有 Bot 生效'), children: h('textarea', {
    className: 'pa-textarea', 'aria-label': '系统提示词', rows: 5, value: draft?.prompt || '', disabled: !editable,
    placeholder: '例如：回答简洁，优先给结论；涉及付费或删除操作先确认。',
    onChange: event => actions.onPromptChange?.(String(event?.target?.value ?? '')),
  }) });
}

function envRow({ h, item, index, editable, actions }) {
  const saved = item?.saved === true;
  const sensitive = item?.sensitive === true;
  const masked = saved && sensitive && !item?.dirty;
  return row({ h, key: item?.id || index, compact: true, 'data-pa-env-row': String(index), style: { gap: 8 }, children: [
    h('input', {
      key: 'key', className: 'pa-input sm pa-mono', 'aria-label': `变量名 ${index + 1}`, placeholder: 'KEY', value: item?.key || '', disabled: !editable || saved,
      style: { flex: '0 0 38%', minWidth: 0 }, spellCheck: false,
      onChange: event => actions.onEnvChange?.(index, { key: String(event?.target?.value ?? '').trim() }),
    }),
    h('input', {
      key: 'value', className: 'pa-input sm pa-mono', 'aria-label': `变量值 ${index + 1}`, placeholder: masked ? '•••••••• （留空不修改）' : 'VALUE', value: item?.value || '', disabled: !editable,
      type: sensitive ? 'password' : 'text', style: { flex: '1 1 0px', minWidth: 0 }, spellCheck: false, autoComplete: 'off',
      onChange: event => actions.onEnvChange?.(index, { value: String(event?.target?.value ?? '') }),
    }),
    h('button', {
      key: 'sensitive', type: 'button', className: 'pa-tag', 'aria-pressed': sensitive ? 'true' : 'false', title: sensitive ? '敏感值：保存后不回显' : '标记为敏感', disabled: !editable,
      style: { cursor: 'pointer', ...(sensitive ? { background: 'var(--pa-warn-soft)', color: 'var(--pa-warn)' } : {}) },
      onClick: () => actions.onEnvChange?.(index, { sensitive: !sensitive }),
    }, icon(h, 'lock', { size: 11 }), '敏感'),
    iconButton({ h, key: 'remove', name: 'close', size: 'sm', iconSize: 14, label: `删除变量 ${item?.key || index + 1}`, disabled: !editable, onClick: () => actions.onRemoveEnv?.(index) }),
  ] });
}

function envSection({ h, draft, editable, actions }) {
  const rows = Array.isArray(draft?.environmentVariables) ? draft.environmentVariables : [];
  return section({ h, title: '环境变量', count: rows.length ? `${rows.length} 个` : null, right: link({ h, label: '添加', icon: icon(h, 'plus', { size: 14 }), disabled: !editable, onClick: () => actions.onAddEnv?.() }), children: group({ h, children: rows.length === 0
    ? emptyState({ h, title: '还没有配置环境变量', detail: '变量会随实例下发；敏感值保存后不回显' })
    : rows.map((item, index) => envRow({ h, item, index, editable, actions })) }) });
}

function runtimeSection({ h, instance, versions, busy, actions }) {
  const list = Array.isArray(versions?.versions) ? versions.versions : [];
  const upgradable = versions?.catalogAvailable === true && list.length > 0;
  return section({ h, title: '运行时', children: group({ h, children: row({ h, children: [
    h('div', { key: 'body', className: 'pa-grow' },
      h('div', { className: 'pa-row-title' }, instance?.version ? `v${String(instance.version).replace(/^v/u, '')}` : '未知版本', upgradable ? badge({ h, label: '有新版本', tone: 'accent' }) : null),
      h('div', { className: 'pa-cap' }, upgradable ? '云端有可升级的运行时版本' : '云端还没有发布可升级版本')),
    button({ h, key: 'check', label: '检查更新', size: 'sm', busy: busy === 'versions', busyLabel: '检查中…', onClick: () => actions.onCheckUpdate?.() }),
  ] }) }) });
}

function closeSection({ h, instance, closeAssistant, actions }) {
  const expected = String(instance?.agentId || '').trim();
  const canConfirm = expected && String(closeAssistant?.text || '').trim() === expected;
  if (closeAssistant?.closedNotice) {
    return section({ h, children: group({ h, children: row({ h, children: h('span', { className: 'pa-sub' }, closeAssistant.closedNotice) }) }) });
  }
  return section({ h, children: group({ h, danger: true, children: closeAssistant?.open
    ? h('div', { className: 'pa-confirm' },
      h('div', { className: 'pa-confirm-text' }, icon(h, 'warn', { size: 16, style: { marginTop: 3 } }), h('span', null, '此操作不可撤销，会释放云端实例与云电脑。输入实例标识确认关闭：')),
      h('input', {
        className: 'pa-input pa-mono', value: closeAssistant?.text || '', placeholder: expected, 'aria-label': '输入云端实例标识以确认关闭', style: { maxWidth: 360 },
        disabled: Boolean(closeAssistant?.busy), onChange: event => actions.onCloseText?.(String(event?.target?.value ?? '')),
      }),
      closeAssistant?.error ? h('div', { role: 'alert', className: 'pa-cap', style: { color: 'var(--pa-danger)' } }, closeAssistant.error) : null,
      h('div', { style: { display: 'flex', gap: 8 } },
        button({ h, label: closeAssistant?.busy ? '正在关闭…' : '确认关闭个人助理', variant: 'dangerFill', size: 'sm', disabled: !canConfirm || Boolean(closeAssistant?.busy), onClick: () => actions.onCloseConfirm?.() }),
        button({ h, label: '取消', variant: 'ghost', size: 'sm', disabled: Boolean(closeAssistant?.busy), onClick: () => actions.onCloseCancel?.() })))
    : row({ h, children: [
      h('div', { key: 'body', className: 'pa-grow' }, h('div', { className: 'pa-strong' }, '关闭个人助理'), h('div', { className: 'pa-cap' }, '释放云端实例与云电脑，Bot 与记忆一并删除')),
      button({ h, key: 'action', label: '关闭', variant: 'danger', size: 'sm', disabled: !instance?.configured, onClick: () => actions.onCloseStart?.() }),
    ] }) }) });
}

export function renderSettings({
  h, loading = false, degraded = false, notice = '', error = '', busy = '',
  inspect = null, instance = null, localAccess = null, draft = null, modelOptions = [], versions = null,
  modelMenuOpen = false,
  closeAssistant = { open: false, text: '', busy: false, error: '', closedNotice: '' },
  actions = {},
} = {}) {
  if (loading && !inspect) {
    return h('div', { className: 'pa-page' }, h('div', { 'data-pa-settings-skeleton': 'true', className: 'pa-page-inner' },
      section({ h, key: 'instance', title: '实例', children: group({ h, children: skeletonRows({ h, rows: 1 }) }) }),
      section({ h, key: 'model', title: '模型', children: group({ h, children: skeletonRows({ h, rows: 1 }) }) }),
      section({ h, key: 'env', title: '环境变量', children: group({ h, children: skeletonRows({ h, rows: 2 }) }) })));
  }
  const editable = instance?.editable !== false && instance?.configured === true && Boolean(inspect);
  const legacy = instance?.configured === true && !inspect && !loading;
  return h('div', { className: 'pa-page', 'data-pa-scroll': 'settings' }, h('div', { className: 'pa-page-inner' },
    error ? h('div', { role: 'alert', className: 'pa-note danger' }, icon(h, 'warn', { size: 16, style: { marginTop: 2 } }), h('span', null, error)) : null,
    legacy ? h('div', { role: 'status', className: 'pa-note' }, icon(h, 'info', { size: 16, style: { marginTop: 2 } }), h('span', null, '这个个人助理是用旧版 DSH Host 创建的，本机没有配置清单，暂时不能在线修改模型、提示词与环境变量。')) : null,
    degraded && !legacy ? h('div', { role: 'status', className: 'pa-note' }, icon(h, 'info', { size: 16, style: { marginTop: 2 } }), h('span', null, '云端设置暂不可用，下面显示的是本地缓存')) : null,
    instanceSection({ h, instance, inspect }),
    localSection({ h, localAccess, actions }),
    modelSection({ h, draft, modelOptions, editable, menuOpen: modelMenuOpen, actions }),
    promptSection({ h, draft, editable, actions }),
    envSection({ h, draft, editable, actions }),
    runtimeSection({ h, instance, versions, busy, actions }),
    closeSection({ h, instance, closeAssistant, actions }),
  ));
}
