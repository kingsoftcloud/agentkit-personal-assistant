import { CLOUD_BROWSER_TOOL_NAMES, CLOUD_EXECUTION_TOOL_NAMES, CLOUD_DESKTOP_TOOL_NAMES } from './cloud-computer-tools.mjs';

export const PA_SAFE_TOOL_NAMES = Object.freeze([...CLOUD_BROWSER_TOOL_NAMES, ...CLOUD_EXECUTION_TOOL_NAMES, ...CLOUD_DESKTOP_TOOL_NAMES, 'assistant_schedule', 'bot_memory_search', 'bot_memory_save', 'bot_plan_update']);
const safe = new Set(PA_SAFE_TOOL_NAMES);

/** deny 优先；空 allowlist 是零权限。任何 Bot 配置都不能扩大固定 PA 安全面。 */
export function personalAssistantToolDecision(policy, name) {
  if (!safe.has(name)) return { allowed: false, code: 'PERSONAL_ASSISTANT_HOST_TOOL_FORBIDDEN' };
  if (!policy || !['allowlist', 'denylist'].includes(policy.mode) || !['allow', 'deny', 'requireApproval'].every(key => Array.isArray(policy[key]) && policy[key].every(value => typeof value === 'string'))) {
    return { allowed: false, code: 'BOT_TOOL_POLICY_INVALID' };
  }
  if (policy.deny.includes(name) || (policy.mode === 'allowlist' && !policy.allow.includes(name))) return { allowed: false, code: 'BOT_TOOL_POLICY_DENIED' };
  return { allowed: true, requireApproval: policy.requireApproval.includes(name) };
}

const guidance = {
  PERSONAL_ASSISTANT_HOST_TOOL_FORBIDDEN: '此工具不属于云电脑或 Bot 私有能力，禁止调用 Host 工具。',
  BOT_TOOL_POLICY_INVALID: 'Bot 工具策略无效；请由用户检查 mode、allow、deny 和 requireApproval。',
  BOT_TOOL_POLICY_DENIED: '当前 Bot 的工具策略禁止此调用；请由用户检查该 Bot 的允许/拒绝名单。',
  BOT_TOOL_APPROVAL_REQUIRED: '当前执行没有一次性宿主批准；请通过宿主批准通道重新发起调用。',
  BOT_TOOL_APPROVAL_UNAVAILABLE: '宿主批准通道不可用，工具未执行；请配置能够答复此云端会话的真实批准通道后重试。',
  BOT_TOOL_APPROVAL_REJECTED: '宿主拒绝了本次调用，工具未执行；需要新的明确批准才能重试。',
  BOT_TOOL_APPROVAL_CANCELLED: '批准请求或工具调用已取消，工具未执行；需要重新发起调用。',
  BOT_TOOL_APPROVAL_TIMEOUT: '批准请求在 30 秒内没有完成，工具未执行；请连接批准通道后重新发起调用。',
};
export const policyReason = code => `${code}: ${guidance[code] || '工具未获授权。'}`;
export const policyDenial = code => ({ kind: 'deny', reason: policyReason(code), info: { name: 'PersonalAssistantPolicyError', code, reason: guidance[code] } });

/** 只消费真实 DSH approval.request 的闭集结果，超时与取消不能产生授权。 */
export async function requestBotToolApproval({ agent, execution, approval, timeoutMs = 30_000 }) {
  if (typeof approval?.request !== 'function') return { granted: false, code: 'BOT_TOOL_APPROVAL_UNAVAILABLE' };
  if (execution.signal?.aborted) return { granted: false, code: 'BOT_TOOL_APPROVAL_CANCELLED' };
  const deadline = new AbortController();
  const signal = execution.signal ? AbortSignal.any([execution.signal, deadline.signal]) : deadline.signal;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => { deadline.abort(); resolve('timeout'); }, timeoutMs); });
  let onAbort;
  const cancelled = execution.signal ? new Promise(resolve => { onAbort = () => resolve('cancelled'); execution.signal.addEventListener('abort', onAbort, { once: true }); }) : undefined;
  const request = Promise.resolve().then(() => approval.request({ agent: execution.agent || agent, toolName: execution.name,
    callId: execution.callId, reason: '此 Bot 的 requireApproval 要求当前工具调用获得一次性批准。', signal })).catch(() => 'unavailable');
  let outcome;
  try { outcome = await Promise.race([request, timeout, ...(cancelled ? [cancelled] : [])]); }
  finally { clearTimeout(timer); if (onAbort) execution.signal.removeEventListener('abort', onAbort); }
  if (deadline.signal.aborted) return { granted: false, code: 'BOT_TOOL_APPROVAL_TIMEOUT' };
  if (signal.aborted && outcome !== 'timeout') return { granted: false, code: 'BOT_TOOL_APPROVAL_CANCELLED' };
  if (outcome === 'allowed-once') return { granted: true };
  return { granted: false, code: ({ rejected: 'BOT_TOOL_APPROVAL_REJECTED', cancelled: 'BOT_TOOL_APPROVAL_CANCELLED', timeout: 'BOT_TOOL_APPROVAL_TIMEOUT' })[outcome] || 'BOT_TOOL_APPROVAL_UNAVAILABLE' };
}
