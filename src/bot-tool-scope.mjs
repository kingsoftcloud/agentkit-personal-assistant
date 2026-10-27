import { personalAssistantToolDecision, policyDenial, policyReason, requestBotToolApproval } from './bot-tool-policy.mjs';

/** PA 的唯一工具边界：继承层过滤 + own-layer 服务端守卫 + scoped 模型呈现过滤。 */
export function restrictPersonalAssistantToolScope(agent, botId, { getPolicy = () => ({ mode: 'allowlist', allow: [], deny: [], requireApproval: [] }), approvalTimeoutMs = 30_000 } = {}) {
  const tools = agent?.ctx?.get?.('tools');
  if (typeof tools?.restrict !== 'function' || typeof tools?.guard !== 'function' || typeof agent.ctx.on !== 'function') {
    throw Object.assign(new Error('Personal Assistant requires scoped tool restrictions and guards'), { code: 'PERSONAL_ASSISTANT_TOOL_SCOPE_UNAVAILABLE', status: 503 });
  }
  const granted = new Set();
  const decide = name => { try { return personalAssistantToolDecision(getPolicy(), name); } catch { return { allowed: false, code: 'BOT_TOOL_POLICY_INVALID' }; } };
  tools.restrict({ allow: [] });
  agent.ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = decide(execution.name);
    if (!decision.allowed) return policyDenial(decision.code);
    const upstream = await next();
    if (upstream.kind === 'deny' || upstream.kind === 'cancel' || !decision.requireApproval) return upstream;
    if (!['allow', 'ask'].includes(upstream.kind)) return policyDenial('BOT_TOOL_POLICY_INVALID');
    if (typeof execution.token !== 'symbol') return policyDenial('BOT_TOOL_APPROVAL_REQUIRED');
    const approval = agent.ctx.get('approval');
    const result = await requestBotToolApproval({ agent, execution, approval, timeoutMs: approvalTimeoutMs });
    console.info(JSON.stringify({ event: 'personal-assistant.tool.approval', botId, tool: execution.name, outcome: result.granted ? 'allowed-once' : result.code }));
    if (!result.granted) return policyDenial(result.code);
    granted.add(execution.token);
    // 同一真实批准同时满足已有 ask；不把尚未答复的 ask 转成允许。
    return { kind: 'allow' };
  });
  tools.guard(execution => {
    const decision = decide(execution.name);
    const approvedOnce = granted.delete(execution.token);
    const code = !decision.allowed ? decision.code : decision.requireApproval && !approvedOnce ? 'BOT_TOOL_APPROVAL_REQUIRED' : undefined;
    if (!code) return undefined;
    console.warn(JSON.stringify({ event: 'personal-assistant.tool.denied', botId, tool: execution.name, code }));
    return policyReason(code);
  });
  agent.ctx.on('tools/result', execution => { granted.delete(execution.token); });
  agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next();
    return { ...result, tools: result.tools.filter(tool => decide(tool.name).allowed) };
  });
}
