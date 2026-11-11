/**
 * 「首次创建」分阶段进度视图（画板 02 Create.dc.html）。
 *
 * 纯函数：stage/stages/elapsedMs/estimatedRemainingMs 由 index.mjs 轮询
 * personal-assistant.create.status 后注入；收起状态由 shell 持有（收起即停止轮询、保留状态）。
 */

import { TOKENS, button, card, checkCircleIcon, checkIcon, formatDuration, formatRemaining, infoIcon, spinnerIcon, styles, warningIcon } from './ui.mjs';

/** Host create.status 的 stage 取值与画板文案的对应关系。 */
export const CREATE_STAGE_META = Object.freeze([
  { id: 'instance', label: '创建云端实例', detail: '准备云端资源' },
  { id: 'runtime', label: '启动工作环境', detail: '正在安装运行时与基础工具' },
  { id: 'computer', label: '连接云电脑', detail: '等待上一步完成' },
  { id: 'assistant', label: '准备助理', detail: '写入默认记忆与能力' },
]);

const STAGE_INDEX = Object.freeze(CREATE_STAGE_META.reduce((map, stage, index) => ({ ...map, [stage.id]: index }), {}));

/** 把 Host 的 stage/stages 归一化成画板需要的四行；Host 只给 stage 时按顺序推导。 */
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

const stageIcon = ({ h, status }) => {
  if (status === 'done') {
    return h('span', { style: { flex: 'none', width: 20, height: 20, borderRadius: 999, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, #067647 12%, transparent)' } }, checkIcon({ h, size: 11 }));
  }
  if (status === 'active') return h('span', { style: { flex: 'none', width: 20, height: 20, borderRadius: 999, display: 'grid', placeItems: 'center' } }, spinnerIcon({ h, size: 14 }));
  if (status === 'failed') return h('span', { style: { flex: 'none', width: 20, height: 20, borderRadius: 999, display: 'grid', placeItems: 'center' } }, warningIcon({ h, size: 14, color: TOKENS.danger }));
  return h('span', { style: { flex: 'none', width: 20, height: 20, borderRadius: 999, display: 'grid', placeItems: 'center' } },
    h('span', { 'aria-hidden': 'true', style: { width: 7, height: 7, borderRadius: 999, border: `1.5px solid ${TOKENS.skeletonStrong}` } }));
};

function progressCard({ h, stages, elapsedMs, failed }) {
  const done = stages.filter(stage => stage.status === 'done').length;
  const percent = failed ? Math.min(100, Math.round(done / stages.length * 100)) : Math.round(done / stages.length * 100);
  const current = stages.find(stage => stage.status === 'active') || stages.find(stage => stage.status === 'failed') || stages.find(stage => stage.status === 'pending');
  return card({ h, style: { width: '100%', maxWidth: 460, overflow: 'hidden' } },
    h('div', { 'aria-hidden': 'true', style: { height: 3, background: TOKENS.divider } },
      h('div', { style: { width: `${Math.max(3, percent)}%`, height: '100%', background: failed ? TOKENS.danger : TOKENS.accent, transition: 'width .4s ease' } })),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px' } },
      stageIcon({ h, status: failed ? 'failed' : current?.status || 'active' }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontSize: 13, fontWeight: 500, color: TOKENS.ink } }, failed ? '开通没有完成' : current?.label || '正在准备个人助理'),
        h('div', { style: { fontSize: 11, color: failed ? TOKENS.danger : TOKENS.inkMuted, lineHeight: 1.6 } }, failed ? current?.detail || '请稍后重试' : current?.detail || '云端正在准备资源')),
      h('span', { style: { flex: 'none', fontSize: 11, color: failed ? TOKENS.danger : TOKENS.accent, fontVariantNumeric: 'tabular-nums' } },
        failed ? '失败' : `已用时 ${formatDuration(elapsedMs)}`)));
}

function collapsedCard({ h, stages, elapsedMs, percent, onExpand }) {
  const active = stages.find(stage => stage.status === 'active') || stages.find(stage => stage.status === 'pending') || stages[stages.length - 1];
  return card({ h, style: { padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 } },
    spinnerIcon({ h, size: 14 }),
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontSize: 12, fontWeight: 600 } }, active?.label || '正在创建'),
      h('div', { style: { ...styles.note, fontVariantNumeric: 'tabular-nums' } }, `已用时 ${formatDuration(elapsedMs)} · 预计还需 ${formatRemaining(remainingOf(percent))}`)),
    button({ h, label: '展开', variant: 'ghost', style: { height: 28, padding: '0 10px' }, onClick: onExpand }));
}

const remainingOf = percent => Math.max(0, (100 - Math.max(0, Math.min(100, percent))) * 1200);

export function renderCreateProgress({
  h, status = null, collapsed = false, diagnosticsOpen = false, notice = '', error = '',
  actions = {},
} = {}) {
  const stages = resolveCreateStages(status);
  const elapsedMs = Number(status?.elapsedMs) || 0;
  const failed = status?.stage === 'failed' || stages.some(stage => stage.status === 'failed');
  const done = status?.stage === 'done';
  const percent = Math.round(stages.filter(stage => stage.status === 'done').length / stages.length * 100);
  const remaining = Number(status?.estimatedRemainingMs);
  if (collapsed && !done && !failed) {
    return [collapsedCard({ h, stages, elapsedMs, percent, onExpand: () => actions.onExpand?.() })];
  }
  return [
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', paddingTop: 12 } },
      h('span', { 'aria-hidden': 'true', style: { width: 64, height: 64, borderRadius: 999, display: 'grid', placeItems: 'center', background: TOKENS.surface2, border: `1px solid ${TOKENS.skeleton}` } },
        done ? checkCircleIcon({ h, size: 26 }) : failed ? warningIcon({ h, size: 26, color: TOKENS.danger }) : spinnerIcon({ h, size: 26 })),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 460 } },
        h('h1', { style: { margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' } },
          done ? '个人助理已就绪' : failed ? '创建个人助理失败' : '正在为你准备个人助理'),
        h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.7, color: TOKENS.inkSoft } },
          done ? '云端实例已经创建完成，正在进入 Bot 列表。'
            : failed ? (status?.error || error || '云端没有完成创建，可以重试或稍后再试。')
              : '首次开通需要在云端创建一台工作机器，通常需要 1–2 分钟。创建完成后会自动进入对话。'))),
    progressCard({ h, stages, elapsedMs, failed }),
    h('div', { style: { width: '100%', maxWidth: 460, display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 10, background: TOKENS.surface2, color: TOKENS.inkSoft } },
      infoIcon({ h, size: 14 }),
      h('div', { style: { flex: 1, minWidth: 0, fontSize: 11, lineHeight: 1.8 } },
        '可以收起这个面板，创建会在云端继续。下次打开会自动接上，不会重新创建，也不会重复计费。',
        Number.isFinite(remaining) && remaining > 0 ? ` 预计还需 ${formatRemaining(remaining)}。` : '')),
    notice ? h('div', { role: 'status', style: { ...styles.note, color: TOKENS.warn, maxWidth: 460 } }, notice) : null,
    diagnosticsOpen ? h('div', { style: { width: '100%', maxWidth: 460, ...styles.note, textAlign: 'left', background: TOKENS.surface3, border: `1px solid ${TOKENS.divider}`, borderRadius: 10, padding: '10px 12px', lineHeight: 1.8 } },
      h('div', null, `当前阶段：${status?.stage || 'instance'}`),
      h('div', null, `已用时：${formatDuration(elapsedMs)}`),
      h('div', null, `预计剩余：${Number.isFinite(remaining) ? formatRemaining(remaining) : '未知'}`),
      h('div', null, `实例：${status?.instanceId || '创建中'}`)) : null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 16 } },
      button({ h, label: diagnosticsOpen ? '收起详情' : '查看详情', variant: 'link', style: { fontSize: 12, color: TOKENS.inkSoft }, onClick: () => actions.onDiagnostics?.() }),
      h('span', { 'aria-hidden': 'true', style: { width: 1, height: 12, background: TOKENS.skeleton } }),
      failed
        ? button({ h, label: '重试', variant: 'link', style: { fontSize: 12, color: TOKENS.danger }, onClick: () => actions.onRetry?.() })
        : button({ h, label: '稍后查看', variant: 'link', style: { fontSize: 12, color: TOKENS.inkSoft }, onClick: () => actions.onCancel?.() })),
  ];
}
