/**
 * 「首次创建」分阶段进度视图（重新设计 DEMO：居中步骤卡 + 进度条）。
 *
 * 纯函数：stage/stages/elapsedMs/estimatedRemainingMs 由 index.mjs 轮询
 * personal-assistant.create.status 后注入；收起状态由 shell 持有（收起即停止轮询、保留状态）。
 */

import { button, cx, formatDuration, formatRemaining, group, icon, link, row } from './ui.mjs';

/** Host create.status 的 stage 取值与文案的对应关系。 */
export const CREATE_STAGE_META = Object.freeze([
  { id: 'instance', label: '创建云端实例', detail: '准备云端资源' },
  { id: 'runtime', label: '启动工作环境', detail: '正在安装运行时与基础工具' },
  { id: 'computer', label: '连接云电脑', detail: '等待上一步完成' },
  { id: 'assistant', label: '准备助理', detail: '写入默认记忆与能力' },
]);

const STAGE_INDEX = Object.freeze(CREATE_STAGE_META.reduce((map, stage, index) => ({ ...map, [stage.id]: index }), {}));

/** 把 Host 的 stage/stages 归一化成四行；Host 只给 stage 时按顺序推导。 */
export function resolveCreateStages(status) {
  const current = String(status?.stage || '');
  const currentIndex = STAGE_INDEX[current] ?? (current === 'done' ? CREATE_STAGE_META.length : 0);
  const provided = Array.isArray(status?.stages) ? status.stages : null;
  return CREATE_STAGE_META.map((stage, index) => {
    const incoming = provided?.find(row => String(row?.id) === stage.id) || null;
    let state = incoming?.status;
    if (!['done', 'active', 'pending', 'failed'].includes(state)) {
      if (current === 'done') state = 'done';
      else if (current === 'failed') state = index < currentIndex ? 'done' : index === currentIndex ? 'failed' : 'pending';
      else if (index < currentIndex) state = 'done';
      else if (index === currentIndex) state = current ? 'active' : 'pending';
      else state = 'pending';
    }
    return { ...stage, status: state, detail: incoming?.detail || stage.detail };
  });
}

function stepGlyph({ h, status, index }) {
  if (status === 'done') return h('span', { className: 'pa-step-num done' }, icon(h, 'check', { size: 12 }));
  if (status === 'failed') return h('span', { className: 'pa-step-num failed' }, icon(h, 'close', { size: 11 }));
  if (status === 'active') return h('span', { className: 'pa-step-num now' }, icon(h, 'spinner', { size: 12, className: 'pa-spin' }));
  return h('span', { className: 'pa-step-num' }, String(index + 1));
}

function stageRow({ h, stage, index }) {
  const active = stage.status === 'active';
  return row({ h, key: stage.id, compact: true, 'data-pa-stage': stage.id, 'data-pa-stage-status': stage.status, children: [
    stepGlyph({ h, status: stage.status, index }),
    h('span', { key: 'label', className: cx('pa-grow', active && 'pa-strong'), style: stage.status === 'pending' ? { color: 'var(--pa-ink-3)' } : stage.status === 'failed' ? { color: 'var(--pa-danger)' } : null }, stage.label),
    h('span', { key: 'detail', className: 'pa-cap pa-hide-mid' }, stage.status === 'done' ? '已完成' : stage.status === 'failed' ? '失败' : stage.detail),
  ] });
}

export function renderCreateProgress({
  h, status = null, collapsed = false, diagnosticsOpen = false, notice = '', error = '',
  actions = {},
} = {}) {
  const stages = resolveCreateStages(status);
  const failed = status?.stage === 'failed' || stages.some(stage => stage.status === 'failed');
  const done = status?.stage === 'done';
  const doneCount = stages.filter(stage => stage.status === 'done').length;
  const percent = Math.round(doneCount / stages.length * 100);
  const elapsedMs = Number(status?.elapsedMs) || 0;
  const remaining = Number(status?.estimatedRemainingMs);
  const current = stages.find(stage => stage.status === 'active') || stages.find(stage => stage.status === 'failed') || stages.find(stage => stage.status === 'pending') || stages[stages.length - 1];
  const message = String(error || status?.error || '').trim();

  if (collapsed && !done) {
    return h('div', { className: 'pa-banner', 'data-pa-create-collapsed': 'true' },
      failed ? icon(h, 'warn', { color: 'var(--pa-danger)' }) : icon(h, 'spinner', { className: 'pa-spin', color: 'var(--pa-ink-2)' }),
      h('span', { className: 'pa-grow pa-ellipsis' }, failed ? '创建个人助理失败' : `正在为你准备个人助理 · ${current?.label || '创建中'}`),
      h('span', { className: 'pa-cap pa-num' }, `${doneCount}/${stages.length} · 已用时 ${formatDuration(elapsedMs)}`),
      button({ h, label: failed ? '重试' : '查看详情', size: 'sm', onClick: () => (failed ? actions.onRetry?.() : actions.onExpand?.()) }));
  }

  return h('div', { className: 'pa-center', 'data-pa-create-progress': 'true' }, h('div', { className: 'pa-center-col' },
    h('div', null,
      h('div', { className: 'pa-hero-ic', style: { margin: '0 auto 16px', ...(failed ? { color: 'var(--pa-danger)' } : {}) } }, failed ? icon(h, 'warn', { size: 26 }) : done ? icon(h, 'check', { size: 26 }) : icon(h, 'spinner', { size: 26, className: 'pa-spin' })),
      h('h1', null, done ? '个人助理已就绪' : failed ? '创建个人助理失败' : '正在为你准备个人助理'),
      h('p', { className: 'pa-lede' }, done
        ? '云端实例已经创建完成，正在进入对话。'
        : failed
          ? (message || '云端没有完成创建，可以重试或稍后再试。')
          : `首次开通需要在云端创建一台工作机器，通常需要 1–2 分钟。${Number.isFinite(remaining) && remaining > 0 ? `预计还需 ${formatRemaining(remaining)}。` : ''}`)),
    group({ h, children: [
      h('div', { key: 'progress', className: cx('pa-progress', failed && 'failed') }, h('i', { style: { width: `${done ? 100 : percent}%` } })),
      ...stages.map((stage, index) => stageRow({ h, stage, index })),
      h('div', { key: 'meta', className: 'pa-row compact', style: { justifyContent: 'space-between', color: 'var(--pa-ink-3)', fontSize: 12 } },
        h('span', { className: 'pa-num' }, `已用时 ${formatDuration(elapsedMs)}`),
        link({ h, label: diagnosticsOpen ? '收起详情' : '查看详情', className: 'underline', onClick: () => actions.onDiagnostics?.() })),
    ] }),
    diagnosticsOpen ? h('div', { 'data-pa-create-diagnostics': 'true', className: 'pa-group', style: { width: '100%', padding: '12px 16px', textAlign: 'left', fontSize: 12, lineHeight: '20px', color: 'var(--pa-ink-2)' } },
      h('div', null, `实例：${status?.instanceId || '未知'}`),
      h('div', null, `阶段：${status?.stage || '未知'}`),
      h('div', null, `预计剩余：${Number.isFinite(remaining) ? formatRemaining(remaining) : '未知'}`),
      message ? h('div', { style: { color: 'var(--pa-danger)' } }, message) : null) : null,
    notice ? h('div', { role: 'status', className: 'pa-sub' }, notice) : null,
    h('div', { className: 'pa-actions' },
      failed ? button({ h, label: '重试', variant: 'primary', onClick: () => actions.onRetry?.() }) : null,
      done ? null : button({ h, label: '稍后查看', variant: 'ghost', onClick: () => actions.onCancel?.() })),
    done ? null : h('p', { className: 'pa-cap' }, '可以收起这个面板，创建会在云端继续；下次打开会自动接上，不会重复创建。'),
  ));
}
