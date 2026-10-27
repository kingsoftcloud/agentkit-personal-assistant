import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantWorkbench, AssistantNativeRightbar } from '../src/client/native-workbench.mjs';

function fixture() {
  const registrations = [], surfaces = new Set(), opens = [];
  const sidebarRight = {
    registerPanelSurface(id) { assert.equal(surfaces.has(id), false); surfaces.add(id); return () => surfaces.delete(id); },
    openPanelTab(panelId, kind) { assert.equal(surfaces.has(panelId), true); opens.push({ panelId, kind }); },
    setPanelExpanded(panelId, expanded) { opens.push({ panelId, expanded }); },
  };
  const slots = {
    inject(name, factory) { const entry = { name, registration: factory(), removed: false }; registrations.push(entry); return () => { entry.removed = true; }; },
    register(definition, component) { return { definition, component }; },
  };
  const workbench = createAssistantWorkbench({ sidebarRight, slots });
  return { workbench, registrations, surfaces, opens };
}

test('云电脑只贡献 root tab 内容，布局和生命周期交给原生服务，不覆盖 rightbar', () => {
  const h = fixture();
  assert.equal(h.workbench.available, true);
  assert.deepEqual(h.registrations.map(value => value.name), ['sidebar.right.panel.tab']);
  assert.equal(h.registrations[0].registration.definition.key, 'personal-assistant-computer');
  assert.deepEqual([...h.surfaces], ['personal-assistant']);
  h.workbench.dispose();
  assert.equal(h.registrations[0].removed, true); assert.equal(h.surfaces.size, 0);
});

test('唯一云端绑定传入原生工作面板，重开与收起只操作同一面板', () => {
  const h = fixture(), scope = { agentId: 'ar-cloud', botId: 'default', sessionId: 'cloud-session' }, request = () => {};
  assert.throws(() => h.workbench.bind({ agentId: 'ar-cloud' }, request), /尚未连接/u);
  h.workbench.bind(scope, request);
  assert.deepEqual(h.workbench.getSnapshot().binding.scope, scope);
  assert.equal(h.workbench.getSnapshot().binding.request, request);
  h.workbench.collapse(); h.workbench.open();
  assert.deepEqual(h.opens, [
    { panelId: 'personal-assistant', kind: 'personal-assistant-computer' },
    { panelId: 'personal-assistant', expanded: false },
    { panelId: 'personal-assistant', kind: 'personal-assistant-computer' },
  ]);
  h.workbench.dispose();
});

test('原生 tab 向电脑内容透传云端身份、可见与全屏状态，不生成布局容器', () => {
  const h = fixture(); h.workbench.bind({ agentId: 'ar-cloud', botId: 'default', sessionId: 'cloud-session' }, () => {});
  const React = { createElement: (type, props) => ({ type, props }), useSyncExternalStore: (_listen, read) => read() };
  const Panel = () => {};
  const value = AssistantNativeRightbar({ React, workbench: h.workbench, Panel, active: true, fullscreen: true });
  assert.equal(value.type, Panel); assert.equal(value.props.nativeFullscreen, true);
  assert.equal(value.props.agentId, 'ar-cloud'); assert.equal(value.props.initialSessionId, 'cloud-session');
  assert.equal(AssistantNativeRightbar({ React, workbench: h.workbench, Panel, active: false }), null);
  h.workbench.dispose();
});

test('旧宿主无原生 root panel 能力时明确要求更新，不退回固定双栏', () => {
  const workbench = createAssistantWorkbench({});
  assert.equal(workbench.available, false);
  assert.match(workbench.unavailableReason, /原生侧栏组件需要更新/u);
  assert.throws(() => workbench.bind({ agentId: 'ar-cloud', botId: 'default' }, () => {}), { code: 'PERSONAL_ASSISTANT_NATIVE_SIDEBAR_REQUIRED' });
  workbench.dispose();
});
