import { invariant } from '@kingsoftcloud/agentkit-harness-core';

/** Separate screenshot observer; it is never a conversation model selection. */
export function nativeVisionProfileId(record) {
  const id = record.spec?.bindings?.visionModelProfileId;
  if (id === undefined || id === null) return null;
  invariant(typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 256,
    'host_native_vision_model_binding_invalid');
  invariant(record.spec?.runtime?.type === 'harness', 'host_native_vision_runtime_invalid');
  return id;
}
