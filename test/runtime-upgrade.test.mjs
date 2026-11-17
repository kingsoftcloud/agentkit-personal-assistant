import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createRuntimeUpgrade } from '../src/runtime-upgrade.mjs';
import { createAssistantDesktop } from '../src/assistant-desktop.mjs';
const image = 'registry.example/runtime@sha256:' + 'a'.repeat(64);
async function fixture(run) {
 const root = await mkdtemp(join(tmpdir(), 'pa-upgrade-'));
 try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('submission is not success; a restart resumes verification and needs the live runtime', async () => fixture(async root => {
 let version = '0.1.60', observed, writes = 0;
 const options = { path: join(root,'upgrade.json'),
  inspect: async () => ({ agentId:'ar-test', detailAvailable:true, runtime:{version,imageDigest:image} }),
  versions: async () => ({versions:[{version:'0.1.61',image}],upgrades:[{version:'0.1.61',image}]}),
  update: async () => {writes++;version='0.1.61';}, probe:async () => observed };
 const service=createRuntimeUpgrade(options);
 assert.equal((await service.start({runtimeVersion:'0.1.61',imageDigest:image,expectedVersion:'0.1.60',botId:'default'})).status,'updating');
 assert.equal((await service.status()).status,'verifying');
 await assert.rejects(service.start({}),{code:'UPGRADE_BUSY'});
 observed={version:'0.1.60',ready:true,runtimeInstanceId:'old'};
 assert.equal((await createRuntimeUpgrade(options).status()).status,'verifying');
 observed={version:'0.1.61',ready:true,runtimeInstanceId:'new'};
 assert.equal((await createRuntimeUpgrade(options).status()).status,'succeeded');
 assert.equal(writes,1);
 assert.equal(await createRuntimeUpgrade({...options,inspect:async()=>({agentId:'ar-other'})}).status(),null);
}));
test('changed catalog digest refuses a write; uncertain submission is never automatically retried', async () => fixture(async root => {
 let writes=0;
 const options={path:join(root,'upgrade.json'),inspect:async()=>({agentId:'ar-test',detailAvailable:true,runtime:{version:'0.1.60'}}),
 versions:async()=>({versions:[{version:'0.1.61',image}],upgrades:[{version:'0.1.61',image}]}),
 probe:async()=>{throw new Error('offline')},update:async()=>{writes++;throw new Error('network reset')}};
 const service=createRuntimeUpgrade(options),input={runtimeVersion:'0.1.61',imageDigest:image,expectedVersion:'0.1.60',botId:'default'};
 await assert.rejects(service.start({...input,imageDigest:image.replace(/a$/,'b')}),{code:'UPGRADE_CATALOG_CHANGED'});
 assert.equal(writes,0);
 await assert.rejects(service.start(input),/network reset/);
 assert.equal(JSON.parse(await readFile(options.path,'utf8')).status,'unknown');
 await assert.rejects(createRuntimeUpgrade(options).start(input),{code:'UPGRADE_BUSY'});
 assert.equal(writes,1);
}));
test('upgrade uses the complete cloud manifest without requiring a local copy', async () => fixture(async root => {
 const manifest='name: assistant-test\nframework: personal-assistant\nartifact_type: ManagedRuntime\nmodel: model-a\nprompt: keep my prompt\nruntime:\n  name: personal-assistant\n  version: 0.1.60\ncustom:\n  preserved: true\n';
 await writeFile(join(root,'assistant-binding.json'),JSON.stringify({format:'agentkit.personal-assistant-binding/v1',agentId:'ar-test',apiKey:'key',gatewayUrl:'https://gateway.example'}));
 let submitted, versions = { '0.1.45': { image } };
 const service=createAssistantDesktop({storeDir:root,env:{},getDeploymentClient:async()=>({
  forAgent:()=>({get:async()=>({data:{Basic:{Name:'assistant-test'},Deployment:{RuntimeConfig:{Version:'0.1.60',ImageDigest:image},ManagedRuntimeConfig:{Manifest:manifest}}}}),update:async payload=>{submitted=payload}}),
  getBootstrapConfig:async()=>({Data:{Configs:{'runtime.catalog':{'personal-assistant':{versions}}}}}),
 })});
 assert.equal((await service.settings()).recordSource,'cloud');
 assert.deepEqual((await service.settingsVersions()).upgrades,[]);
 await assert.rejects(service.settingsUpdate({runtimeVersion:'0.1.61'}), {code:'UPGRADE_REQUIRED'});
 versions = { '0.1.61': { image } };
 await service.settingsUpgrade({agentId:'ar-test',botId:'default',runtimeVersion:'0.1.61',expectedVersion:'0.1.60',imageDigest:image});
 const parsed=parse(submitted.ManagedRuntimeConfig.Manifest);
 assert.equal(parsed.runtime.version,'0.1.61'); assert.equal(parsed.prompt,'keep my prompt'); assert.equal(parsed.custom.preserved,true);
 assert.equal(submitted.EnvironmentVariablePatch,undefined);
}));

test('a slow cloud settings read cannot recreate a disconnected binding', async () => fixture(async root => {
 const bindingPath = join(root, 'assistant-binding.json');
 await writeFile(bindingPath, JSON.stringify({format:'agentkit.personal-assistant-binding/v1',agentId:'ar-test',apiKey:'key',gatewayUrl:'https://gateway.example'}));
 const requested = Promise.withResolvers();
 const detail = Promise.withResolvers();
 const service = createAssistantDesktop({storeDir:root,env:{},getDeploymentClient:async()=>({
  forAgent:()=>({get:()=>{requested.resolve();return detail.promise;}}),
 })});
 const pending = service.settings(); await requested.promise; await service.disconnect();
 detail.resolve({data:{Basic:{Name:'assistant-test'},Deployment:{ManagedRuntimeConfig:{Manifest:'name: assistant-test\nruntime:\n  name: personal-assistant\n  version: 0.1.60\n'}}}});
 assert.equal((await pending).recordSource,'cloud');
 await assert.rejects(readFile(bindingPath), {code:'ENOENT'});
}));

test('a model edit is admitted by the running instance’s catalog before submitting a rollout', async () => fixture(async root => {
 const manifest='name: assistant-test\nframework: personal-assistant\nartifact_type: ManagedRuntime\nmodel: model-a\nruntime:\n  name: personal-assistant\n  version: 0.2.2\n';
 await writeFile(join(root,'assistant-binding.json'),JSON.stringify({format:'agentkit.personal-assistant-binding/v1',agentId:'ar-test',apiKey:'key',gatewayUrl:'https://gateway.example'}));
 const submitted = [];
 const service=createAssistantDesktop({storeDir:root,env:{},
  listRuntimeModels: async scope => {
   assert.deepEqual(scope,{agentId:'ar-test',botId:'default'});
   return { models: [{id:'model-b',contextWindow:1048576}] };
  },
  getDeploymentClient:async()=>({
   forAgent:()=>({get:async()=>({data:{Basic:{Name:'assistant-test'},Deployment:{ManagedRuntimeConfig:{Manifest:manifest}}}}),update:async payload=>{submitted.push(parse(payload.ManagedRuntimeConfig.Manifest));}}),
  }),
 });
 await assert.rejects(service.settingsUpdate({agentId:'ar-test',botId:'default',model:'stale-model'}),{code:'ASSISTANT_SETTINGS_MODEL_NOT_AVAILABLE'});
 assert.deepEqual(submitted,[]);
 await service.settingsUpdate({agentId:'ar-test',botId:'default',model:'model-b'});
 assert.equal(submitted[0].model,'model-b');
}));
