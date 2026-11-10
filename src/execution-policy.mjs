/** Response-only diagnostics. A runtime declares its policy; a client can only narrow it. */
export const UNATTENDED_EXECUTION_POLICY = Object.freeze({
  format: 'agentkit.execution-policy/v1', permissionMode: 'read-only',
  approvalPolicy: 'never', approvalSource: 'runtime-policy',
});

/** Ordered from least to most privileged; indexes are the comparison ranks. */
export const EXECUTION_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);
export const CLOUD_EXECUTION_POLICY_CAPABILITY = 'cloud-execution-policy/v1';
export const DEFAULT_CLOUD_EXECUTION_MODE = 'workspace-write';
export const DEFAULT_CLOUD_EXECUTION_MAX = 'danger-full-access';

/** Missing, future or malformed modes remain unknown. */
export function readExecutionMode(value) {
  return typeof value === 'string' && EXECUTION_MODES.includes(value) ? value : null;
}

export function executionModeRank(mode) {
  const rank = EXECUTION_MODES.indexOf(readExecutionMode(mode) || '');
  return rank < 0 ? Number.POSITIVE_INFINITY : rank;
}

export function executionModesUpTo(maximum) {
  const rank = executionModeRank(maximum);
  return Number.isFinite(rank) ? EXECUTION_MODES.slice(0, rank + 1) : [];
}

/** A requested mode may only narrow the deployed runtime ceiling. */
export function clampExecutionMode(requested, maximum) {
  const mode = readExecutionMode(requested), ceiling = readExecutionMode(maximum) || UNATTENDED_EXECUTION_POLICY.permissionMode;
  if (!mode) return ceiling;
  return executionModeRank(mode) <= executionModeRank(ceiling) ? mode : ceiling;
}

export function cloudExecutionPolicy(mode) {
  return Object.freeze({ format: 'agentkit.execution-policy/v1',
    permissionMode: readExecutionMode(mode) || UNATTENDED_EXECUTION_POLICY.permissionMode,
    approvalPolicy: 'never', approvalSource: 'runtime-policy' });
}

/** Missing, future or malformed wire values remain unknown. */
export function readExecutionPolicy(value) {
  if (!value || value.format !== 'agentkit.execution-policy/v1'
    || !readExecutionMode(value.permissionMode)
    || !['ask', 'never'].includes(value.approvalPolicy)
    || value.approvalSource !== 'runtime-policy') return null;
  return { format: value.format, permissionMode: value.permissionMode,
    approvalPolicy: value.approvalPolicy, approvalSource: value.approvalSource };
}
