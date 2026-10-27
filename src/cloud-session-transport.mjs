import { randomUUID } from 'node:crypto';

const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

/** 独立于桌面画面的云会话连接；只使用 Host 签发的 Agent/Bot control 票据。 */
export function createCloudSessionTransport({ issueTicket, WebSocketImpl, ca, timeoutMs = 15_000 }) {
  const connections = new Map();
  async function connect(scope, signal) {
    const key = JSON.stringify([scope.agentId, scope.botId]);
    if (connections.has(key)) return connections.get(key);
    const promise = (async () => {
      const ticket = await issueTicket({ ...scope, mode: 'control' }, signal);
      if (typeof WebSocketImpl !== 'function') throw fail('PERSONAL_ASSISTANT_CLOUD_SESSION_UNAVAILABLE', '云端会话连接组件不可用');
      return new Promise((resolve, reject) => {
        let socket, opened = false, idle;
        const pending = new Map();
        const error = () => fail('PERSONAL_ASSISTANT_CLOUD_SESSION_UNAVAILABLE', '云端会话连接中断；请核对发送状态后重试');
        const invalidate = failure => {
          clearTimeout(idle); clearTimeout(openTimer);
          if (connections.get(key) === promise) connections.delete(key);
          for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure); }
          pending.clear();
          if (!opened) reject(failure);
        };
        const touch = () => { clearTimeout(idle); idle = setTimeout(() => socket.close(1000, 'session idle'), 300_000); idle.unref?.(); };
        const openTimer = setTimeout(() => { invalidate(error()); socket?.close(); }, timeoutMs);
        openTimer.unref?.();
        try { socket = new WebSocketImpl(ticket.wsUrl, ['agentkit.personal-assistant.desktop.v1', `agentkit.desktop.ticket.${ticket.ticket}`], { ca }); }
        catch { invalidate(error()); return; }
        socket.onopen = () => {
          opened = true; clearTimeout(openTimer); touch();
          resolve({
            close: () => { invalidate(error()); socket.close(1000, 'Host disposed'); },
            request(operation, payload, signal) {
              if (socket.readyState !== 1) return Promise.reject(error());
              const requestId = randomUUID();
              return new Promise((resolve, reject) => {
                const finish = (failure, value) => { const entry = pending.get(requestId); if (!entry) return; pending.delete(requestId); clearTimeout(entry.timer); signal?.removeEventListener('abort', abort); failure ? reject(failure) : resolve(value); };
                const abort = () => finish(fail('PERSONAL_ASSISTANT_REQUEST_ABORTED', '请求已取消；已提交的云端任务会继续运行', 499));
                if (signal?.aborted) { reject(signal.reason || error()); return; }
                const timer = setTimeout(() => finish(fail('PERSONAL_ASSISTANT_CLOUD_SESSION_TIMEOUT', '云端响应超时；发送结果待确认，请勿重复创建任务', 504)), timeoutMs);
                timer.unref?.();
                pending.set(requestId, { timer, reject: failure => finish(failure), resolve: value => finish(null, value) });
                signal?.addEventListener('abort', abort, { once: true });
                touch();
                try { socket.send(JSON.stringify({ type: 'session.request', requestId, agentId: scope.agentId, botId: scope.botId, operation, payload })); }
                catch { finish(error()); }
              });
            },
          });
        };
        socket.onmessage = event => {
          let value; try { value = JSON.parse(String(event.data)); } catch { return; }
          if (value.type === 'error') {
            const failure = fail(value.code === 'DESKTOP_MESSAGE_UNSUPPORTED' ? 'PERSONAL_ASSISTANT_CLOUD_SESSION_UPGRADE_REQUIRED' : value.code || 'PERSONAL_ASSISTANT_CLOUD_SESSION_UNAVAILABLE', value.code === 'DESKTOP_MESSAGE_UNSUPPORTED' ? '当前云端版本不支持对话，请升级云端助理；不会使用本机执行' : '云端拒绝会话请求', value.status || 409);
            invalidate(failure); socket.close(); return;
          }
          if (value.type !== 'session.response') return;
          const entry = pending.get(value.requestId);
          if (!entry) return;
          if (value.agentId !== scope.agentId || value.botId !== scope.botId) { entry.reject(fail('PERSONAL_ASSISTANT_AGENT_MISMATCH', '云端会话身份不一致', 403)); return; }
          if (value.ok) entry.resolve(value.value);
          else entry.reject(fail(value.error?.code || 'PERSONAL_ASSISTANT_CLOUD_SESSION_FAILED', value.error?.message || '云端会话请求失败', value.error?.status || 503));
        };
        socket.onclose = () => invalidate(error());
        socket.onerror = () => { invalidate(error()); try { socket.close(); } catch {} };
      });
    })();
    connections.set(key, promise);
    try { return await promise; } catch (error) { if (connections.get(key) === promise) connections.delete(key); throw error; }
  }
  return {
    async request(scope, operation, payload, signal) { return (await connect(scope, signal)).request(operation, payload, signal); },
    dispose() { for (const connection of connections.values()) void connection.then(value => value.close()).catch(() => {}); connections.clear(); },
  };
}
