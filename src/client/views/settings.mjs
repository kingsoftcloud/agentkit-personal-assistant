/**
 * 「设置」视图（画板 08 Settings.dc.html）。
 *
 * 纯函数：模型、提示词、环境变量的编辑草稿由 index.mjs 持有（draft），
 * 视图只回传 onChange 事件；保存动作在 shell 页头的「保存」按钮上。
 */

import { TOKENS, badge, button, card, chevronDownIcon, divider, emptyState, infoIcon, listRow, noticeBar, sectionHeader, skeletonBlock, skeletonCard, styles, warningIcon } from './ui.mjs';

const PROMPT_LIMIT = 8000;

const localAccessCopy = local => {
  const authorized = local?.authorized === true;
  return {
    label: authorized ? '已授权' : '未授权',
    tone: authorized ? 'success' : 'warn',
    detail: authorized
      ? '助理可在本机发起新会话、操作本地窗口与文件；高风险操作前会先问你。'
      : '未授权。授权后助理才能在本机发起会话、操作窗口与文件；连接不等于授权。',
  };
};

function instanceSection({ h, instance, inspect, actions }) {
  const configured = inspect?.configured === true || instance?.configured === true;
  const parts = [instance?.agentId ? `实例 ${instance.agentId}` : '', instance?.version ? `云端版本 ${instance.version}` : '', inspect?.status || instance?.status || ''].filter(Boolean);
  return card({ h, style: { padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 } },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { fontSize: 13, fontWeight: 600 } }, '个人助理'),
        badge({ h, label: configured ? '已开通' : '未开通', tone: configured ? 'success' : 'warn' })),
      h('div', { style: { ...styles.note, lineHeight: 1.8, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, parts.join(' · ') || '开通后可在这里管理云端配置')),
    button({ h, label: '诊断', variant: 'ghost', style: { height: 30, padding: '0 10px' }, onClick: () => actions.onDiagnostics?.() }));
}

function localAccessSection({ h, localAccess, actions }) {
  const copy = localAccessCopy(localAccess);
  return card({ h, style: { padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 } },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { fontSize: 12, fontWeight: 600 } }, '控制本机'),
        badge({ h, label: copy.label, tone: copy.tone })),
      h('div', { style: { ...styles.note, lineHeight: 1.8, marginTop: 2 } }, copy.detail)),
    localAccess?.authorized
      ? button({ h, label: '取消授权', variant: 'danger', style: { height: 30, padding: '0 10px', flex: 'none' }, onClick: () => actions.onRevokeLocal?.() })
      : button({ h, label: '去授权', variant: 'ghost', style: { height: 30, padding: '0 10px', flex: 'none' }, onClick: () => actions.onOpenLocalAccess?.() }));
}

function modelSection({ h, draft, modelOptions, editable, busy, actions }) {
  const options = Array.isArray(modelOptions) ? modelOptions.filter(Boolean) : [];
  return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    sectionHeader({ h, title: '模型', meta: '影响新消息，正在运行的任务不受影响' }),
    h('div', { style: { position: 'relative' } },
      h('select', {
        value: draft?.model || '', disabled: !editable || Boolean(busy), 'aria-label': '模型',
        onChange: event => actions.onModelChange?.(String(event?.target?.value ?? '')),
        style: {
          ...styles.mono, width: '100%', height: 44, padding: '0 32px 0 12px', boxSizing: 'border-box',
          border: `1px solid ${TOKENS.border}`, borderRadius: 10, background: TOKENS.surface, color: TOKENS.ink,
          fontSize: 12, cursor: editable ? 'pointer' : 'not-allowed', appearance: 'none',
        },
      }, options.length
        ? options.map(option => h('option', { key: option, value: option }, option))
        : h('option', { value: draft?.model || '' }, draft?.model || '默认模型')),
      h('span', { 'aria-hidden': 'true', style: { position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' } }, chevronDownIcon({ h, size: 12 }))));
}

function promptSection({ h, draft, editable, busy, actions }) {
  const value = String(draft?.prompt || '');
  return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } },
      h('span', { style: styles.sectionTitle }, '提示词'),
      h('span', { style: { ...styles.meta, fontVariantNumeric: 'tabular-nums' } }, `${value.length} / ${PROMPT_LIMIT}`)),
    h('textarea', {
      value, disabled: !editable || Boolean(busy), maxLength: PROMPT_LIMIT, 'aria-label': '系统提示词', rows: 4,
      onChange: event => actions.onPromptChange?.(String(event?.target?.value ?? '')),
      style: {
        width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, resize: 'vertical', minHeight: 76,
        border: `1px solid ${TOKENS.border}`, background: TOKENS.surface, color: TOKENS.avatarInk, font: 'inherit', fontSize: 12, lineHeight: 1.8,
      },
    }));
}

function envSection({ h, draft, editable, busy, actions }) {
  const rows = Array.isArray(draft?.environmentVariables) ? draft.environmentVariables : [];
  return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
      h('span', { style: styles.sectionTitle }, '环境变量'),
      button({ h, label: '添加', variant: 'link', style: { fontSize: 12, color: TOKENS.inkSoft, padding: '2px 4px' }, disabled: !editable || Boolean(busy), onClick: () => actions.onAddEnv?.() })),
    rows.length === 0
      ? card({ h, children: emptyState({ h, title: '还没有配置环境变量', detail: '变量会随实例下发；敏感值不回显，留空表示不修改。' }) })
      : h('div', { style: styles.card },
        rows.map((row, index) => {
          const saved = row.saved === true && row.dirty !== true;
          return listRow({
            h, first: index === 0,
            children: [
              h('span', { key: 'key', style: { flex: 'none', width: 104, ...styles.mono, fontSize: 11, color: TOKENS.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.key || 'KEY'),
              row.saved === true && row.sensitive === true && saved
                ? h('span', { key: 'masked', style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                  h('span', { style: { letterSpacing: '0.12em' } }, '••••••••'),
                  badge({ h, label: '敏感' }))
                : h('input', {
                  key: 'value', value: row.value || '', disabled: !editable || Boolean(busy),
                  placeholder: saved ? '已保存' : 'VALUE', 'aria-label': `环境变量 ${row.key || index}`,
                  onChange: event => actions.onEnvChange?.(index, { value: String(event?.target?.value ?? '') }),
                  style: { flex: 1, minWidth: 0, fontSize: 12, padding: '5px 8px', borderRadius: 8, border: `1px solid ${TOKENS.divider}`, background: TOKENS.surface, color: TOKENS.ink, font: 'inherit' },
                }),
              row.saved !== true && row.sensitive !== true
                ? button({ h, key: 'sensitive', label: '标记敏感', variant: 'link', style: { fontSize: 11, padding: '2px 4px' }, onClick: () => actions.onEnvChange?.(index, { sensitive: true }) })
                : null,
              button({ h, key: 'remove', label: '删除', variant: 'link', disabled: !editable || Boolean(busy), style: { fontSize: 11, color: TOKENS.inkMuted, padding: '2px 4px' }, onClick: () => actions.onRemoveEnv?.(index) }),
            ],
          });
        })));
}

function runtimeSection({ h, inspect, versions, busy, actions }) {
  const runtime = inspect?.runtime || {};
  const detail = [runtime.version || '未知版本', runtime.image ? `镜像 ${runtime.image}` : ''].filter(Boolean).join(' · ');
  const catalog = versions?.catalogAvailable === true && Array.isArray(versions.versions) && versions.versions.length > 0;
  return card({ h, style: { padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 } },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontSize: 12, fontWeight: 600 } }, '运行时'),
      h('div', { style: { ...styles.note, lineHeight: 1.8 } }, detail)),
    button({ h, label: busy === 'versions' ? '检查中…' : '检查更新', variant: 'ghost', style: { height: 30, padding: '0 10px' }, disabled: !catalog || Boolean(busy), title: catalog ? '云端有可升级的运行时版本' : '云端还没有发布可升级版本', onClick: () => actions.onCheckUpdate?.() }));
}

function dangerSection({ h, instance, closeAssistant, actions }) {
  const canConfirm = Boolean(instance?.agentId) && String(closeAssistant?.text || '').trim() === instance.agentId;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    closeAssistant?.closedNotice
      ? noticeBar({ h, text: closeAssistant.closedNotice, tone: 'success' })
      : null,
    closeAssistant?.open
      ? card({ h, style: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, border: '1px solid color-mix(in srgb, #b42318 30%, transparent)', background: 'color-mix(in srgb, #b42318 3%, transparent)' } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.8, color: TOKENS.danger } },
          warningIcon({ h, size: 14, color: TOKENS.danger }),
          h('span', null, '此操作不可撤销。请输入实例标识确认关闭：')),
        h('input', {
          value: closeAssistant?.text || '', placeholder: instance?.agentId || 'ar-…', disabled: Boolean(closeAssistant?.busy),
          'aria-label': '输入云端实例标识以确认关闭', onChange: event => actions.onCloseText?.(String(event?.target?.value ?? '')),
          style: { ...styles.mono, fontSize: 12, padding: '6px 9px', borderRadius: 8, border: `1px solid ${TOKENS.border}`, width: '100%', maxWidth: 360, boxSizing: 'border-box' },
        }),
        closeAssistant?.error ? h('div', { role: 'alert', style: { ...styles.note, color: TOKENS.danger } }, closeAssistant.error) : null,
        h('div', { style: { display: 'flex', gap: 8 } },
          button({ h, label: closeAssistant?.busy ? '正在关闭…' : '确认关闭个人助理', variant: 'primary', disabled: !canConfirm || Boolean(closeAssistant?.busy), onClick: () => actions.onCloseConfirm?.(), style: { background: TOKENS.danger } }),
          button({ h, label: '取消', variant: 'ghost', disabled: Boolean(closeAssistant?.busy), onClick: () => actions.onCloseCancel?.() })))
      : card({ h, style: { padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10, border: '1px solid color-mix(in srgb, #b42318 24%, transparent)', background: '#fef7f6' } },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TOKENS.danger } }, '关闭个人助理'),
          h('div', { style: { fontSize: 11, color: '#8a4a45', lineHeight: 1.8, marginTop: 2 } }, '释放云电脑资源。记忆、会话历史与工作区文件保留 7 天，期间重新开通会接上原来的数据。')),
        button({ h, label: '关闭', variant: 'danger', style: { height: 30, padding: '0 10px', flex: 'none' }, disabled: !instance?.agentId, onClick: () => actions.onCloseStart?.() })),
    h('div', { style: { fontSize: 11, color: TOKENS.inkMuted, lineHeight: 1.8 } }, '关闭需要再次输入实例标识确认，避免误操作释放付费资源。'));
}

function settingsSkeleton({ h }) {
  return h('div', { 'data-pa-settings-skeleton': 'true', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    skeletonCard({ h, rows: 2, pad: 14 }),
    skeletonCard({ h, rows: 2, pad: 14 }),
    skeletonBlock({ h, width: 48, height: 12 }),
    skeletonCard({ h, rows: 1, pad: 12 }));
}

export function renderSettings({
  h, loading = false, degraded = false, notice = '', error = '', busy = '',
  inspect = null, instance = null, localAccess = null, draft = null, modelOptions = [], versions = null,
  closeAssistant = { open: false, text: '', busy: false, error: '', closedNotice: '' },
  actions = {},
} = {}) {
  if (loading && !inspect) return settingsSkeleton({ h });
  const editable = inspect?.recordSource !== 'host' ? false : true;
  return [
    noticeBar({ h, text: error || notice, tone: error ? 'danger' : 'neutral' }),
    noticeBar({ h, text: degraded ? '部分数据暂不可用：云端配置没有返回，编辑可能无法保存。' : '', tone: 'warn' }),
    inspect?.recordSource && inspect.recordSource !== 'host'
      ? noticeBar({ h, text: '这个个人助理是用旧版 DSH Host 创建的，本机没有配置清单，暂时不能在线修改。', tone: 'warn' })
      : null,
    instanceSection({ h, instance, inspect, actions }),
    localAccessSection({ h, localAccess, actions }),
    modelSection({ h, draft: draft || {}, modelOptions, editable, busy, actions }),
    promptSection({ h, draft: draft || {}, editable, busy, actions }),
    envSection({ h, draft: draft || {}, editable, busy, actions }),
    runtimeSection({ h, inspect, versions, busy, actions }),
    h('div', { style: { flex: '1 1 auto', minHeight: 8 } }),
    dangerSection({ h, instance, closeAssistant, actions }),
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11, color: TOKENS.inkMuted, lineHeight: 1.7 } },
      infoIcon({ h, size: 12 }),
      h('span', null, '保存会提交一次云端更新，由云端滚动应用到实例；期间云电脑可能短暂重连。')),
  ];
}
