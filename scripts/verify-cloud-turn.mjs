import assert from 'node:assert/strict';
const secrets=[process.env.AGENTKIT_RUNTIME_TOKEN,process.env.AGENTKIT_MODEL_API_KEY].filter(Boolean);
const print=v=>{let s=JSON.stringify(v);for(const secret of secrets)s=s.split(secret).join('[REDACTED]');console.log(s);};
const base='http://127.0.0.1:8080';
const request=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${process.env.AGENTKIT_RUNTIME_TOKEN}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok){print({event:'request-failed',status:r.status,data});throw Error(`HTTP ${r.status}`);}return{status:r.status,data};};
const session=await request('/v1/sessions',{botId:'default',title:'Studio关闭后的云端真实回合验收'});print({event:'session-created',...session});
const sessionId=session.data.sessionId;
const receipt=await request(`/v1/sessions/${sessionId}/turns`,{botId:'default',input:'请只回复 PA_CLOUD_20261025_OK，不要调用任何工具。'});print({event:'turn-accepted',...receipt});
for(let i=0;i<120;i++){
 const {data}=await request(`/v1/sessions/${sessionId}/turns?botId=default`);const turn=data.turns.find(t=>t.turnId===receipt.data.turnId);
 if(turn&&['completed','failed','cancelled'].includes(turn.status)){
  print({event:'turn-finished',turn});const messages=await request(`/v1/sessions/${sessionId}/messages?botId=default`);print({event:'final-messages',...messages});
  assert.equal(turn.status,'completed');assert.ok(messages.data.messages.some(m=>m.role==='assistant'&&m.content.includes('PA_CLOUD_20261025_OK')));process.exit(0);
 }
 if(i%10===0)print({event:'turn-running',elapsedSeconds:i,turnId:receipt.data.turnId,status:turn?.status});
 await new Promise(resolve=>setTimeout(resolve,1000));
}
throw Error('cloud turn did not finish in 120 seconds');
