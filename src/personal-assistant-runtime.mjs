/** Cloud assistant facade. DSH owns execution, history, persistence and timers. */
import { executeAssistantSchedule } from './assistant-schedule.mjs';
import { UNATTENDED_EXECUTION_POLICY } from './execution-policy.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readAssistantHistory, readAssistantImage } from './assistant-history-reader.mjs';
import { assistantAttachmentCapabilities, assistantRequestObserved, normalizeAssistantInput,
  prepareAssistantPrompt, readAssistantFile, uploadAssistantAttachment } from './assistant-attachment-runtime.mjs';
import { createAssistantApprovalBridge } from './assistant-approval-bridge.mjs';
import { createAssistantLocalHandoff } from './assistant-local-handoff.mjs';
import { cloudAssistantComposerCapability } from './assistant-interaction-scope.mjs';
import { ASSISTANT_NATIVE_REPRESENTATION, isAssistantNativeOperation } from './contracts/assistant-native.mjs';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);

export function createPersonalAssistantRuntime({ ctx, agentId, buildId, frozen, admit, resources, retirement, identity,
  approvalBridge: injectedApprovalBridge, localHandoff: injectedLocalHandoff, nativeCarrier, permissionModel }) {
  if (frozen.spec?.runtime?.type !== 'dsh-native') return null;
  const controller = ctx.get('sessionController');
  const scopedCancelAvailable = () => typeof ctx.get('agents')?.get === 'function'
    && typeof ctx.get('sessionProjections')?.stateOf === 'function' && typeof controller.cancel === 'function';
  const identified = new WeakSet();
  const installIdentity = agent => {
    if (!identity || !agent.session.id.startsWith('assistant-') || identified.has(agent)) return;
    const prompt = agent.ctx?.get('systemPrompt');
    if (!prompt) throw fail('ASSISTANT_IDENTITY_UNAVAILABLE', '无法加载助理身份', 503);
    ctx.effect(() => agent.ctx.effect(() => prompt.section({ name: 'agentkit:assistant-identity', order: 10300, interpolate: false, text: identity.prompt })), 'agentkit-assistant:identity');
    identified.add(agent);
  };
  if (identity) {
    // Covers restored sessions and official timers before queued model work starts.
    ctx.on('agent/created', ({ agent }) => { installIdentity(agent); });
    for (const agent of ctx.get('agents').list()) installIdentity(agent);
  }
  const memoryBinding = frozen.spec?.bindings?.plugins?.find(item => item.config?.binding?.resource?.kind === 'memory-instance');
  const memoryId = memoryBinding?.config.binding.resource.id || memoryBinding?.config.binding.resource.resourceId;
  const memoryEnabled = Boolean(memoryId) && frozen.spec?.memory?.enabled !== false;
  const lanes = new Map();
  let retiring = false;
  const inFlight = new Set();
  const knownSessionIds = new Set();
  const sessionFor = key => {
    if (!validKey(key)) throw fail('ASSISTANT_CONVERSATION_INVALID', '会话标识无效');
    const id = `assistant-${createHash('sha256').update(JSON.stringify([agentId, buildId, key])).digest('hex').slice(0, 40)}`;
    knownSessionIds.add(id);
    return id;
  };
  const interactionScope = { ctx, hostId: `${agentId}/${buildId}`, ownsSession: id => knownSessionIds.has(id) || permissionModel?.ownsSession?.(id) === true };
  const approvalBridge = injectedApprovalBridge || createAssistantApprovalBridge({ ...interactionScope,
    enabled: Boolean(permissionModel?.enabled && nativeCarrier?.hasLiveSession),
    policyOf: agent => permissionModel?.policyOf(agent) ?? 'never',
    isConnected: sessionId => nativeCarrier?.hasLiveSession(sessionId) === true,
  });
  const localHandoff = injectedLocalHandoff || createAssistantLocalHandoff(interactionScope);
  const disposeInteractions = () => { approvalBridge.dispose(); localHandoff.dispose(); permissionModel?.dispose(); return nativeCarrier?.dispose(); };
  ctx.effect?.(() => disposeInteractions, 'agentkit-assistant:interactions');
  const serialize = (id, work) => {
    const result = (lanes.get(id) || Promise.resolve()).catch(() => {}).then(work);
    lanes.set(id, result);
    void result.finally(() => { if (lanes.get(id) === result) lanes.delete(id); }).catch(() => {});
    return result;
  };
  async function ensure(sessionId, allowCreate = true) {
    if (retiring) throw fail('ASSISTANT_CLOSED', '助理正在关闭，不能继续使用', 410);
    const existing = await controller.projections({ sessionId }, new AbortController().signal);
    if (existing?.kind === 'migration-required') throw fail('ASSISTANT_HISTORY_MIGRATION_REQUIRED', '云端会话需要升级后才能恢复', 409);
    const created = !existing;
    if (created) {
      if (!allowCreate) throw fail('ASSISTANT_ATTACHMENT_EXPIRED', '附件上传凭据已失效或不属于当前会话，请重新选择文件', 409);
      const selected = await admit(agentId, frozen);
      const cwd = await permissionModel?.newSessionCwd(sessionId);
      await controller.create({ sessionId, agentPreset: selected.presetId, ...(cwd ? { cwd } : {}) });
      if (selected.modelSelection) await controller.selectModel({ sessionId, ...selected.modelSelection, saveDefault: false });
    }
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved.error) throw resolved.error;
    installIdentity(resolved.agent);
    const permissions = await permissionModel?.ensure(resolved.agent, created);
    if (permissions?.managed) return resolved.agent;
    // Legacy sessions retain their existing default and are never opted into
    // the new workspace profile merely by reopening the page.
    // Unattended tools retain confinement and cannot wait for a desktop approval.
    // The durable knob, not the preset name, proves confinement. Reapplying the
    // read-only preset would temporarily switch never to ask on every retry.
    const mode = ctx.get('sessionProjections')?.stateOf(resolved.agent.session, 'sandboxMode');
    if (mode !== UNATTENDED_EXECUTION_POLICY.permissionMode) {
      const presets = ctx.get('permissionPresets');
      if (typeof presets?.set !== 'function') throw fail('ASSISTANT_PERMISSION_UNAVAILABLE', '无法设置无人值守权限', 503);
      // Use the official setter; slash commands are attributed to the user.
      try { presets.set(resolved.agent.session, UNATTENDED_EXECUTION_POLICY.permissionMode); }
      catch { throw fail('ASSISTANT_PERMISSION_UNAVAILABLE', '无法设置无人值守权限', 503); }
    }
    ctx.get('approval').setPolicy(resolved.agent, UNATTENDED_EXECUTION_POLICY.approvalPolicy, { actor: 'automation' });
    return resolved.agent;
  }
  async function snapshot(sessionId, payload) {
    const interaction = approvalBridge.snapshot(sessionId);
    const permissions = permissionModel?.snapshot(sessionId) || { profile: 'legacy-read-only/v1', managed: false, permission: 'read-only', approval: 'never' };
    return { ...await readAssistantHistory(controller, sessionId, payload),
      cloudSessionId: sessionId, identity: identity?.read() || null, canEditIdentity: Boolean(identity), memoryEnabled,
      scheduleEnabled: Boolean(ctx.get('schedule')), scheduleManagerEnabled: ['catalog', 'history', 'update', 'delete'].every(key => typeof ctx.get('schedule')?.[key] === 'function'), canClose: Boolean(retirement),
      pendingInteractions: interaction.pending,
      capabilities: {
        composer: nativeCarrier ? { mode: 'durable-cloud', nativeSessionBinding: true, nativeComposer: true, representation: ASSISTANT_NATIVE_REPRESENTATION } : cloudAssistantComposerCapability,
        history: { nativeEvents: true, pagination: true, requestReceipts: true },
        input: { ...assistantAttachmentCapabilities(ctx).input, content: true },
        display: { text: true, tools: true, images: typeof controller.attachment === 'function', files: assistantAttachmentCapabilities(ctx).read, deliverables: 'metadata-only' },
        execution: { location: 'cloud', ...permissions, durableQueue: true, scopedCancel: scopedCancelAvailable() },
        approval: interaction.capabilities, localHandoff: false, localHandoffDetails: localHandoff.capabilities(), fileOpen: false,
      },
    };
  }
  const run = async (operation, payload = {}, { signal } = {}) => {
    if (operation === 'close') {
      if (!retirement) throw fail('ASSISTANT_DELETE_UNAVAILABLE', '此 Host 未提供专属数据删除能力', 409);
      retiring = true;
      await disposeInteractions();
      await Promise.allSettled([...inFlight]);
      return retirement(async () => {
        let count = 0;
        if (!memoryId) return { count };
        const adapter = await resources(), options = { agentId };
        const seen = new Set();
        for (let page = 0; page < 1000; page++) {
          const result = await adapter.listMemory(memoryId, 'host-anonymous', options);
          if (!result.items.length) { if (result.hasMore) throw fail('ASSISTANT_MEMORY_DELETE_UNCONFIRMED', '记忆列表不完整'); return { count }; }
          for (const item of result.items) {
            if (seen.has(item.id)) throw fail('ASSISTANT_MEMORY_DELETE_UNCONFIRMED', '记忆删除结果尚未生效');
            if ((await adapter.deleteMemory(memoryId, 'host-anonymous', item.id, options))?.accepted !== true) throw fail('ASSISTANT_MEMORY_DELETE_UNCONFIRMED', '记忆删除未获确认');
            seen.add(item.id); count++;
          }
        }
        throw fail('ASSISTANT_MEMORY_DELETE_UNCONFIRMED', '记忆较多，请重新核对关闭结果');
      });
    }
    if (retiring) throw fail('ASSISTANT_CLOSED', '助理正在关闭，不能继续使用', 410);
    if (operation === 'identity-update') {
      if (!identity) throw fail('ASSISTANT_IDENTITY_UNAVAILABLE', '请更新云端镜像以保存助理名字和称呼', 409);
      return { identity: await identity.update(payload) };
    }
    const sessionId = sessionFor(payload.conversation === undefined ? 'personal' : payload.conversation);
    if (isAssistantNativeOperation(operation)) {
      if (!nativeCarrier) throw fail('ASSISTANT_NATIVE_UNAVAILABLE', '此云端镜像尚未提供安全的原生会话连接', 409);
      if (operation === 'native-open') {
        if (Object.keys(payload).some(key => key !== 'conversation')) throw fail('ASSISTANT_INPUT_INVALID', '原生会话只能绑定当前助理对话');
        return serialize(sessionId, () => ctx.get('agents').withoutInitiator(async () => {
          signal?.throwIfAborted();
          const agent = await ensure(sessionId);
          if (!await ctx.get('sessions').flush(agent.session)) throw fail('ASSISTANT_PERSISTENCE_UNAVAILABLE', '云端尚未确认保存会话，请重试连接', 503);
          signal?.throwIfAborted();
          // The handle is not a credential. Each subsequent operation is again
          // authenticated by the receipt transport and this exact conversation.
          return nativeCarrier.open({ sessionId, runAssistant: (op, input) => {
            if (!['submit', 'attachment-upload', 'cancel'].includes(op)) throw fail('ASSISTANT_OPERATION_INVALID', '原生会话不支持此写入操作');
            return api(op, { ...input, conversation: payload.conversation ?? 'personal' });
          } });
        }));
      }
      const { conversation: _conversation, ...input } = payload;
      return nativeCarrier.request(sessionId, operation, input, { signal });
    }
    if (operation === 'snapshot') return snapshot(sessionId, payload);
    if (operation === 'approval-decide') return approvalBridge.decide(sessionId, payload);
    if (operation === 'image-read') return readAssistantImage(controller, sessionId, payload.attachmentId);
    if (operation === 'file-read') {
      if (Object.keys(payload).some(key => !['conversation', 'attachmentId'].includes(key))) throw fail('ASSISTANT_INPUT_INVALID', '文件下载仅接受当前会话的附件标识');
      return readAssistantFile(ctx, controller, sessionId, payload.attachmentId);
    }
    if (operation === 'attachment-upload') return serialize(sessionId, () => ctx.get('agents').withoutInitiator(async () => {
      const agent = await ensure(sessionId);
      const receipt = await uploadAssistantAttachment(ctx, agent, payload);
      if (!await ctx.get('sessions').flush(agent.session)) throw fail('ASSISTANT_PERSISTENCE_UNAVAILABLE', '云端未确认保存附件会话，请重新选择文件', 503);
      return receipt;
    }));
    if (operation === 'submit') {
      if (!validKey(payload.requestId)) throw fail('ASSISTANT_INPUT_INVALID', '请输入有效的请求标识');
      const input = normalizeAssistantInput(payload);
      return serialize(sessionId, () => ctx.get('agents').withoutInitiator(async () => {
        const agent = await ensure(sessionId, input.content.every(part => part.type === 'text'));
        let prepared;
        try { prepared = await prepareAssistantPrompt(ctx, agent, input.content, permissionModel?.snapshot(agent)?.managed
          ? { stageFile: (ref, bytes) => permissionModel.stageAttachment(agent, ref, bytes) } : {}); }
        catch (error) {
          // New staged inputs use native admission without rereading old pages.
          // A consumed/lost receipt can acknowledge only the exact durable request.
          if (payload.content === undefined || !await assistantRequestObserved(controller, sessionId, payload.requestId, input.fingerprint)) throw error;
        }
        if (prepared) {
          const binding = prepared.imageReceipts.length ? ctx.get('fileUploads').bindPrompt(agent, prepared.imageReceipts, payload.requestId) : null;
          try {
            await controller.prompt({ sessionId, requestId: payload.requestId, mode: 'queue',
              requestFingerprint: input.fingerprint, content: prepared.content,
              clientTimeZone: input.timezone }, new AbortController().signal);
            binding?.commit();
          } catch (error) {
            if (error?.code === 'session/request-conflict') throw fail('ASSISTANT_REQUEST_CONFLICT', '请求标识已用于另一条消息，请刷新核对原消息', 409);
            throw error;
          } finally { binding?.[Symbol.dispose](); }
        }
        // Acceptance is sent only after DSH's persistence backend acknowledges.
        // A client disconnect never cancels this cloud-owned Agent.
        if (!await ctx.get('sessions').flush(agent.session)) throw fail('ASSISTANT_PERSISTENCE_UNAVAILABLE', '云端未确认保存，请先刷新会话核对提交结果', 503);
        return { accepted: true, requestId: payload.requestId, sessionId };
      }));
    }
    if (operation === 'cancel-turn') {
      if (!Number.isSafeInteger(payload.turn) || payload.turn < 1 || !Number.isSafeInteger(payload.turnStartSeq) || payload.turnStartSeq < 0 || Object.is(payload.turnStartSeq, -0)) {
        throw fail('ASSISTANT_CANCEL_TARGET_INVALID', '请刷新后选择要停止的任务');
      }
      if (!scopedCancelAvailable()) throw fail('ASSISTANT_CANCEL_UNAVAILABLE', '此云端版本暂不支持安全停止指定任务，请更新云端运行环境', 409);
      // Native stateOf/get/cancel are synchronous public APIs. No await or queue
      // boundary may separate this identity check from cancellation: a later
      // queued turn must never inherit an earlier turn's Stop click.
      const live = ctx.get('agents').get(sessionId);
      if (!live) return { accepted: false, reason: 'turn-changed' };
      const boundary = ctx.get('sessionProjections').stateOf(live.session, 'turnBoundary');
      if (boundary?.lastTurn !== payload.turn || boundary?.openTurnStartSeq !== payload.turnStartSeq) return { accepted: false, reason: 'turn-changed' };
      return controller.cancel({ sessionId });
    }
    // Compatibility for older clients. New clients exclusively use cancel-turn.
    if (operation === 'cancel') return controller.cancel({ sessionId });
    if (operation.startsWith('schedule-')) return executeAssistantSchedule({ schedule: ctx.get('schedule'), operation, payload, sessionId, ensure, serialize, signal });
    if (operation.startsWith('memory-')) {
      if (!memoryId || frozen.spec?.memory?.enabled === false) throw fail('ASSISTANT_MEMORY_UNAVAILABLE', '请给助理绑定并启用云端记忆库', 503);
      const adapter = await resources();
      const options = { agentId };
      // Same partition as the existing DSH resource bridge; one dedicated
      // deployment belongs to one personal assistant, never a shared tenant.
      if (operation === 'memory-list') return adapter.listMemory(memoryId, 'host-anonymous', options);
      if (operation === 'memory-save') {
        if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000) throw fail('ASSISTANT_MEMORY_INVALID', '记忆内容须为 1 至 4000 字');
        // Each explicit fact is a complete ingestion batch. Reusing an already
        // flushed ingestion Session can acknowledge later facts without extracting
        // them. Keep the assistant's real Session and memory partition unchanged.
        const ingestionSessionId = `${sessionId}:manual-memory:${randomUUID()}`;
        return adapter.writeMemory(memoryId, 'host-anonymous', [{ role: 'user', content: `请记住：${payload.text}` }], { ...options, sessionId: ingestionSessionId, flush: true });
      }
      if (operation === 'memory-delete' || operation === 'memory-update') {
        const { items } = await adapter.listMemory(memoryId, 'host-anonymous', options);
        if (!items.some(item => item.id === payload.id)) throw fail('ASSISTANT_MEMORY_NOT_FOUND', '请刷新记忆列表后再操作', 404);
        if (operation === 'memory-delete') return adapter.deleteMemory(memoryId, 'host-anonymous', payload.id, options);
        if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000) throw fail('ASSISTANT_MEMORY_INVALID', '记忆内容须为 1 至 4000 字');
        return adapter.updateMemory(memoryId, 'host-anonymous', payload.id, payload.text, options);
      }
    }
    throw fail('ASSISTANT_OPERATION_INVALID', '不支持的助理操作', 404);
  };
  const api = (operation, payload, options) => {
    const pending = run(operation, payload, options);
    if (operation !== 'close') { inFlight.add(pending); void pending.finally(() => inFlight.delete(pending)).catch(() => {}); }
    return pending;
  };
  Object.defineProperty(api, 'scopedCancelSupported', { get: scopedCancelAvailable });
  api.nativeCarrierSupported = Boolean(nativeCarrier);
  api.managedPermissionsSupported = Boolean(permissionModel?.enabled && nativeCarrier?.hasLiveSession);
  api.cloudExecutionSupported = permissionModel?.cloudCapabilities?.codeExecution === true;
  api.cloudBrowserSupported = permissionModel?.cloudCapabilities?.browser === true;
  api.disconnectInteractions = sessionId => approvalBridge.disconnect(sessionId);
  api.dispose = disposeInteractions;
  api.imageReadSupported = typeof controller.attachment === 'function';
  Object.defineProperty(api, 'attachmentUploadSupported', { get: () => assistantAttachmentCapabilities(ctx).input.attachments });
  api.contentSupported = true;
  api.approvalBridgeSupported = true;
  Object.defineProperty(api, 'fileReadSupported', { get: () => assistantAttachmentCapabilities(ctx).read });
  api.deletionSupported = Boolean(retirement);
  api.identitySupported = Boolean(identity);
  Object.defineProperty(api, 'scheduleManagerSupported', { get: () => ['catalog', 'history', 'update', 'delete'].every(key => typeof ctx.get('schedule')?.[key] === 'function') });
  api.retiring = () => retiring;
  return api;
}
