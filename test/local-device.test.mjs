import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonalAssistantStateStore} from '../src/persistent-state.mjs';
import {createLocalAccess} from '../src/local-access.mjs';
import {createLocalDeviceService} from '../runtime/local-device-channel.mjs';
import {createCloudSessionChannel} from '../runtime/cloud-session-channel.mjs';
import {BotRegistry} from '../src/bot-registry.mjs';

async function setup(t) {
 const root=await mkdtemp(join(tmpdir(),'pa-local-device-'));
 const local=await createPersonalAssistantStateStore(join(root,'local')).init();
 const cloud=await createPersonalAssistantStateStore(join(root,'cloud')).init();
 const devices=createLocalDeviceService({stateStore:cloud,pollMs:100,timeoutMs:2000});
 const registry=new BotRegistry({bots:[{botId:'default',systemPromptRevision:'v1'},{botId:'other',systemPromptRevision:'v1'}]});
 const channel=createCloudSessionChannel({assistantId:'ar-local-test',stateStore:cloud,registry,localDevices:devices});
 const target={agentId:'ar-local-test',botId:'default'};
 const access=createLocalAccess({stateStore:local,getTarget:async()=>target,transport:async(scope,operation,payload)=>channel({...scope,operation,payload})});
 const directory=join(root,'documents');await mkdir(directory);await writeFile(join(directory,'proof.txt'),'local file evidence');await writeFile(join(root,'private.txt'),'outside secret');
 t.after(async()=>{access.dispose();devices.dispose();await new Promise(resolve=>setTimeout(resolve,120));await rm(root,{recursive:true,force:true})});
 return {root,directory,local,cloud,access,devices,target,channel};
}

test('cloud channel executes a real Host read only in the explicitly granted directory and Bot',async t=>{
 const {access,devices,cloud,directory,target,root}=await setup(t);
 const status=await access.grant({scopes:['file.read'],roots:[directory],target});
 assert.equal(status.connected,true);
 const [device]=(await devices.execute('default',{action:'devices'})).devices;
 const input={action:'file.read',deviceId:device.deviceId,rootId:device.roots[0].id,path:'proof.txt'};
 const value=await devices.execute('default',input);assert.equal(value.text,'local file evidence');
 const receipt=(await cloud.read('local-operations')).find(row=>row.requestId===value.requestId);
 assert.equal(receipt.status,'completed');assert.match(receipt.resultSha256,/^[a-f0-9]{64}$/);
 await assert.rejects(devices.execute('other',input),{code:'LOCAL_DEVICE_OFFLINE'});
 await assert.rejects(devices.execute('default',{...input,path:'../private.txt'}),{code:'LOCAL_PATH_DENIED'});
 await symlink(join(root,'private.txt'),join(directory,'escape.txt'));
 await assert.rejects(devices.execute('default',{...input,path:'escape.txt'}),{code:'LOCAL_PATH_DENIED'});
 await access.revoke();
 await assert.rejects(access.execute({...input,grantId:status.grantId}),{code:'PERSONAL_ASSISTANT_LOCAL_NOT_AUTHORIZED'});
 await assert.rejects(devices.execute('default',input),{code:'LOCAL_DEVICE_OFFLINE'});
 assert.equal((await access.status()).authorized,false);
});

test('old placeholder grants do not authorize the real local executor',async t=>{
 const {local}=await setup(t);
 await local.mutate('local-access',rows=>rows.push({version:1,authorized:true,scopes:['file.read-write']}));
 const access=createLocalAccess({stateStore:local});
 assert.equal((await access.status()).authorized,false);
 await assert.rejects(access.grant({scopes:['window.input'],roots:[]}),{code:'PERSONAL_ASSISTANT_LOCAL_ACCESS_SCOPE_INVALID'});
 access.dispose();
});
