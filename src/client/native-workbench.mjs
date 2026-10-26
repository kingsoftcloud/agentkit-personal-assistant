/** 云电脑只注册原生 DSH 右侧栏内容，不拥有布局、全屏或本地执行会话。 */
export const ASSISTANT_COMPUTER_KIND = 'personal-assistant-computer';
export const ASSISTANT_PANEL_ID = 'personal-assistant';
const unavailableReason = '当前 Studio 的原生侧栏组件需要更新，请安装本次随插件提供的宿主组件包。';
const unavailable = () => Object.assign(new Error(unavailableReason), { code: 'PERSONAL_ASSISTANT_NATIVE_SIDEBAR_REQUIRED' });

function ComputerTab(props) { return props.workbench.render(props); }

export function createAssistantWorkbench({ sidebarRight, slots, panelId = ASSISTANT_PANEL_ID } = {}) {
  const available = typeof sidebarRight?.registerPanelSurface === 'function'
    && typeof sidebarRight?.openPanelTab === 'function' && typeof sidebarRight?.setPanelExpanded === 'function'
    && typeof slots?.inject === 'function' && typeof slots?.register === 'function';
  const listeners = new Set();
  let binding, disposed = false;
  let snapshot = Object.freeze({ binding: undefined });
  const emit = () => { snapshot = Object.freeze({ binding }); for (const listener of [...listeners]) listener(); };
  const requireAvailable = () => {
    if (!available) throw unavailable();
    if (disposed) throw new Error('云电脑工作面板已关闭');
  };
  let releaseSurface, releaseTab;
  const api = {
    available, unavailableReason: available ? null : unavailableReason,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    bind(scope, request) {
      requireAvailable();
      if (!scope?.agentId || !scope?.botId || typeof request !== 'function') throw new Error('云端助理尚未连接');
      const changed = binding && (binding.scope.agentId !== scope.agentId || binding.scope.botId !== scope.botId);
      if (changed) { releaseSurface(); releaseSurface = sidebarRight.registerPanelSurface(panelId); }
      binding = Object.freeze({ scope: Object.freeze({ ...scope }), request }); emit();
      api.open();
    },
    open() {
      requireAvailable();
      if (binding) sidebarRight.openPanelTab(panelId, ASSISTANT_COMPUTER_KIND);
    },
    collapse() { requireAvailable(); sidebarRight.setPanelExpanded(panelId, false); },
    dispose() {
      if (disposed) return;
      disposed = true; releaseTab?.(); releaseSurface?.(); listeners.clear();
    },
  };
  if (available) {
    releaseSurface = sidebarRight.registerPanelSurface(panelId);
    releaseTab = slots.inject('sidebar.right.panel.tab', () => slots.register({
      name: 'sidebar.right.panel.tab', key: ASSISTANT_COMPUTER_KIND, inject: () => ({ workbench: api }),
    }, ComputerTab));
  }
  return api;
}

/** 仅渲染已授权原生 tab 的内容；窗口与全屏均归 DSH 所有。 */
export function AssistantNativeRightbar({ React: R, workbench, Panel, active = true, fullscreen = false }) {
  const { createElement: h, useSyncExternalStore } = R;
  const value = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  if (!active || !value.binding) return null;
  const { scope, request } = value.binding;
  return h(Panel, { key: `${scope.agentId}:${scope.botId}:${scope.sessionId || ''}`,
    request, initialBotId: scope.botId, initialSessionId: scope.sessionId, agentId: scope.agentId,
    variant: 'native-tab', active, nativeFullscreen: fullscreen });
}
