import assert from 'node:assert/strict';
const base='http://127.0.0.1:8787';
const identity={userId:process.env.USER_ID,assistantId:process.env.ASSISTANT_ID,computerId:process.env.COMPUTER_ID};
for(const path of ['/health','/v1/status']){const r=await fetch(base+path);const body=await r.json();console.log(JSON.stringify({test:path,status:r.status,body}));assert.equal(r.status,200);}
const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...identity,...body})});return{status:r.status,body:await r.json()};};
const first={botId:'default',taskId:'cloud-acceptance-owner',ttlMs:10000,idempotencyKey:'cloud-acceptance-owner'};
const second={botId:'researcher',taskId:'cloud-acceptance-observer',ttlMs:10000,idempotencyKey:'cloud-acceptance-observer'};
const acquired=await post('/broker/lease/acquire',first);console.log(JSON.stringify({test:'first-bot-acquire',status:acquired.status,leasePresent:!!acquired.body.lease?.leaseId}));assert.equal(acquired.status,200);
try{const conflict=await post('/broker/lease/acquire',second);console.log(JSON.stringify({test:'second-bot-conflict',...conflict}));assert.equal(conflict.status,409);}finally{const released=await post('/broker/lease/release',{...first,leaseId:acquired.body.lease.leaseId});console.log(JSON.stringify({test:'first-bot-release',...released}));assert.equal(released.body.released,true);}
const next=await post('/broker/lease/acquire',second);console.log(JSON.stringify({test:'second-bot-acquire-after-release',status:next.status,leasePresent:!!next.body.lease?.leaseId}));assert.equal(next.status,200);await post('/broker/lease/release',{...second,leaseId:next.body.lease.leaseId});
