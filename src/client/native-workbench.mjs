/** 插件级云电脑复用 DSH Frame + DockKit；不创建或借用本地执行会话。 */
export const ASSISTANT_COMPUTER_KIND = 'personal-assistant-computer';
export const ASSISTANT_PANEL_ID = 'personal-assistant';
let dockRuntime;
export function setClientDockRuntime(runtime) { dockRuntime = runtime; }
const labels = Object.freeze({
  emptyPane: '打开云电脑，查看助理的操作', splitPane: '拆分面板', splitPaneDisabled: '已达到面板数量上限',
  splitPaneNarrow: '面板宽度不足', closeTab: '关闭标签页', addTab: '打开云电脑', dockFloat: '停靠到右侧栏',
  closeFloat: '关闭浮动面板', dropZone: { center: '移到这里', left: '停靠到左侧', right: '停靠到右侧', top: '停靠到上方', bottom: '停靠到下方' },
});
const intentNames = ['focusTab','focusPane','splitPane','addTab','closeTab','duplicateTab','floatTab','unfloatPane','placeTab','dropTab','moveFloat','resizeFloat','resizeSplit'];

export function createAssistantWorkbench({ layout, slots, panelId = ASSISTANT_PANEL_ID, DockKit = dockRuntime } = {}) {
  if (!layout?.panelInfo?.subscribe || !slots?.inject || !DockKit?.DockController || !DockKit?.DockLayout) return null;
  const listeners = new Set();
  let controller, unsubscribeController, binding, snapshot, shadow, disposed = false;
  const emit = () => { snapshot = Object.freeze({ controller, binding, dock: controller?.getSnapshot() }); for (const listener of [...listeners]) listener(); };
  const makeTab = id => ({ id, kind: ASSISTANT_COMPUTER_KIND, contentId: ASSISTANT_COMPUTER_KIND, title: '云电脑' });
  const ensureController = () => {
    if (controller) return;
    controller = new DockKit.DockController({ makeInitialTab: makeTab, makePaneTab: makeTab });
    unsubscribeController = controller.subscribe(() => {
      const state = controller.getSnapshot().state;
      if (Object.keys(state.tabs).length === 0 && state.expanded) controller.setExpanded(false);
      emit();
    });
    emit();
  };
  const api = {
    DockKit, layout,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    bind(scope, request) {
      if (disposed) throw new Error('云电脑工作面板已关闭');
      if (!scope?.agentId || !scope?.botId || typeof request !== 'function') throw new Error('云端助理尚未连接');
      const changed = binding && (binding.scope.agentId !== scope.agentId || binding.scope.botId !== scope.botId);
      if (changed) { unsubscribeController?.(); controller = undefined; }
      binding = { scope: Object.freeze({ ...scope }), request }; ensureController(); emit();
      api.open();
    },
    open() {
      if (!binding || disposed) return;
      ensureController();
      controller.openContent({ contentId: ASSISTANT_COMPUTER_KIND, kind: ASSISTANT_COMPUTER_KIND, title: '云电脑' });
      controller.setExpanded(true);
    },
    collapse() { controller?.setExpanded(false); },
    dispose() {
      disposed = true; unsubscribePanel(); shadow?.(); shadow = undefined; unsubscribeController?.();
      listeners.clear(); layout.closeRightbar();
    },
  };
  // single 槽的公开 shadowing 契约：只在个人助理页接管 rightbar，退出即恢复原有会话侧栏。
  const syncPanel = () => {
    const active = layout.panelInfo.getSnapshot().activePanelId === panelId;
    if (active && !shadow) {
      shadow = slots.inject('rightbar', () => slots.register({ name: 'rightbar', priority: -90, inject: () => ({ workbench: api }) }, props => api.render(props)));
    } else if (!active && shadow) { shadow(); shadow = undefined; layout.closeRightbar(); }
  };
  const unsubscribePanel = layout.panelInfo.subscribe(syncPanel);
  emit(); syncPanel();
  return api;
}

export function AssistantNativeRightbar({ React: R, workbench, Panel, width = 500, viewportWidth = 1440, canShow = true }) {
  const { createElement: h, useSyncExternalStore, useLayoutEffect } = R;
  const value = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const state = value.dock?.state;
  const fullscreen = viewportWidth < 768 || state?.mode === 'fullscreen';
  const shown = Boolean(value.binding && state?.expanded);
  const surfaceVisible = Boolean(value.binding && (state?.expanded || state?.floats.length));
  useLayoutEffect(() => {
    if (shown && (canShow || fullscreen)) workbench.layout.openRightbar(!fullscreen || viewportWidth >= 768, fullscreen);
    else workbench.layout.closeRightbar();
    return () => workbench.layout.closeRightbar();
  }, [workbench, shown, fullscreen, canShow, viewportWidth]);
  if (!value.binding || !state) return null;
  const intents = Object.fromEntries(intentNames.map(name => [name, (...args) => value.controller[name](...args)]));
  const props = {
    state, canSplit: value.dock.canSplit, hideSplitWhenBlocked: true, dropZones: 'horizontal',
    intents, labels, active: surfaceVisible, keepMounted: () => false, canAddTab: () => false,
    renderTab: () => h(Panel, { key: `${value.binding.scope.agentId}:${value.binding.scope.botId}`, request: value.binding.request, initialBotId: value.binding.scope.botId, variant: 'native-tab' }),
    chrome: h('button', { 'aria-label': '收起云电脑侧栏', title: '收起侧栏', onClick: () => workbench.collapse(), style: { background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: '4px 8px' } }, '⇥'),
  };
  return h('aside', {
    'data-personal-assistant-native-rightbar': 'true', 'aria-label': '个人助理云电脑侧栏',
    style: { position: fullscreen ? 'fixed' : 'absolute', top: 0, right: 0, bottom: 0, width: fullscreen ? '100vw' : width, display: surfaceVisible ? 'flex' : 'none', flexDirection: 'column', pointerEvents: 'none', zIndex: fullscreen ? 40 : 10, background: 'var(--dsw-alias-bg-base, #fff)', borderLeft: '1px solid var(--dsw-alias-border-default, #d8dee8)', '--dsh-dockkit-dock-layer': 10, '--dsh-dockkit-float-layer': 60 },
  }, h(workbench.DockKit.DockLayout, props));
}
