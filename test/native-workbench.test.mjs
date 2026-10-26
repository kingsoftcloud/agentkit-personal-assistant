import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantWorkbench } from '../src/client/native-workbench.mjs';

class Controller {
  constructor({makeInitialTab}) { this.listeners=new Set();this.state={tabs:{one:makeInitialTab('one')},floats:[],expanded:false};this.publish(); }
  publish(){this.snapshot={state:{...this.state},canSplit:true};for(const listener of this.listeners)listener();}
  getSnapshot=()=>this.snapshot;
  subscribe=listener=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  setExpanded(expanded){this.state={...this.state,expanded};this.publish();}
  openContent(tab){if(!Object.keys(this.state.tabs).length)this.state={...this.state,tabs:{one:{...tab,id:'one'}}};this.publish();}
  closeTab(){this.state={...this.state,tabs:{}};this.publish();}
}
function fixture(){
  const listeners=new Set(),registrations=[];let activePanelId=null;
  const layout={panelInfo:{getSnapshot:()=>({activePanelId}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},closeRightbar(){}};
  const slots={inject(name,factory){const entry={name,registration:factory(),removed:false};registrations.push(entry);return()=>{entry.removed=true;};},register(definition,component){return {definition,component};}};
  const workbench=createAssistantWorkbench({layout,slots,DockKit:{DockController:Controller,DockLayout(){}}});
  return {workbench,registrations,select(id){activePanelId=id;for(const fn of listeners)fn();}};
}

test('原生 rightbar 仅在个人助理页挂载，切走恢复原会话侧栏，不创建本地会话',()=>{
 const h=fixture();assert.equal(h.registrations.length,0);
 h.select('personal-assistant');assert.equal(h.registrations.length,1);
 assert.equal(h.registrations[0].registration.definition.name,'rightbar');
 assert.equal(h.registrations[0].registration.definition.priority,-90);
 h.select('overview');assert.equal(h.registrations[0].removed,true);
 h.select('personal-assistant');assert.equal(h.registrations.length,2);
 h.workbench.dispose();assert.equal(h.registrations[1].removed,true);
});

test('云端唯一绑定穿过原生工作面板，关最后标签释放栏位，重开只恢复同一电脑',()=>{
 const h=fixture(),scope={agentId:'ar-cloud',botId:'default'},request=()=>{};
 assert.throws(()=>h.workbench.bind({agentId:'ar-cloud'},request),/尚未连接/u);
 h.workbench.bind(scope,request);
 const first=h.workbench.getSnapshot();assert.equal(first.dock.state.expanded,true);
 assert.equal(first.binding.request,request);assert.deepEqual(first.binding.scope,scope);
 assert.equal(Object.keys(first.dock.state.tabs).length,1);
 first.controller.closeTab('one');assert.equal(h.workbench.getSnapshot().dock.state.expanded,false);
 h.workbench.open();const restored=h.workbench.getSnapshot();assert.equal(restored.dock.state.expanded,true);
 assert.deepEqual(restored.binding.scope,scope);assert.equal(Object.keys(restored.dock.state.tabs).length,1);
 h.workbench.dispose();
});

test('宿主缺少公开 Frame/DockKit 时明确不可用，不退回固定双栏或本机会话',()=>{
 assert.equal(createAssistantWorkbench({}),null);
});
