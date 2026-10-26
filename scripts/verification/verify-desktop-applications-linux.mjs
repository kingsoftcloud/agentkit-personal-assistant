/**
 * 仅在全新一次性 Linux 容器中验证真实 dock 点击、文件管理器与进程清理。
 * 禁止在正在运行的云端 Pod 执行；已有 :99 桌面时会在写文件前拒绝启动。
 * 截图为显式验收产物，不记录视频流。此结果不替代目标 AppArmor 证明。
 */
import assert from 'node:assert/strict';import {execFile as cb} from 'node:child_process';import {promisify} from 'node:util';import {readFile,readdir,writeFile,mkdir,access} from 'node:fs/promises';
import {createComputerAgentServer} from '../../runtime/computer-agentd.mjs';import {createDesktopController} from '../../runtime/desktop-session.mjs';
const args=process.argv.slice(2), index=args.indexOf('--evidence');
const evidence=index<0?'/tmp/pa-desktop-app-evidence':args[index+1];
assert.equal(process.platform,'linux','仅用于一次性 Linux 容器');
try { await access('/tmp/.X11-unix/X99'); throw new Error('检测到现有 :99 桌面，禁止启动第二套验收桌面'); } catch(error) { if(error.code!=='ENOENT')throw error; }
await mkdir(evidence,{recursive:true});
const exec=promisify(cb),delay=ms=>new Promise(r=>setTimeout(r,ms)),env={...process.env,DISPLAY:':99',AGENTKIT_DESKTOP_MODE:'1',AGENTKIT_WORKSPACE_DIR:'/workspace',COMPUTER_PORT:'0',USER_ID:'local-proof',ASSISTANT_ID:'local-proof',COMPUTER_ID:'local-proof'};
process.env.AGENTKIT_DESKTOP_MODE='1';process.env.DISPLAY=':99';
const identity={userId:'local-proof',assistantId:'local-proof',computerId:'local-proof',botId:'local-proof',taskId:'local-proof'};let desktop;const service=createComputerAgentServer({env,desktopFactory:options=>(desktop=createDesktopController(options))});const report={scope:'本地 Linux 依赖probe+候选源码，非最终镜像/目标AppArmor',checks:[]};
const ps=async()=>{const a=[];for(const p of await readdir('/proc'))if(/^\d+$/.test(p)){try{const state=await readFile(`/proc/${p}/status`,'utf8');if(/^State:\s+Z/m.test(state))continue;const comm=(await readFile(`/proc/${p}/comm`,'utf8')).trim(),args=(await readFile(`/proc/${p}/cmdline`,'utf8')).split('\0').filter(Boolean);if(args.length&&(['Xvfb','fluxbox','xterm','tint2','thunar','dbus-daemon','xfconfd'].includes(comm)||(comm==='chromium'&&!args.some(s=>s.startsWith('--type=')))))a.push({pid:+p,comm,args})}catch{}}return a};
const wait=async(fn,label,timeout=6000)=>{const end=Date.now()+timeout;while(Date.now()<end){try{const r=await fn();if(r)return r}catch{}await delay(50)}throw new Error('timeout '+label)};
const geometry=async id=>Object.fromEntries((await exec('xdotool',['getwindowgeometry','--shell',id],{env})).stdout.trim().split('\n').map(x=>x.split('=')));
const window=async pattern=>{let ids;try{ids=(await exec('xdotool',['search','--onlyvisible','--class',pattern],{env})).stdout.trim().split('\n')}catch{return null}for(const id of ids){const g=await geometry(id);if(+g.WIDTH>=300&&+g.HEIGHT>=200)return{id,geometry:g,name:(await exec('xdotool',['getwindowname',id],{env})).stdout.trim()}}return null};
let port,leaseId,sessionId;
const post=async(path,payload={},status=200)=>{const r=await fetch(`http://127.0.0.1:${port}/broker/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...identity,leaseId,sessionId,...payload})});const b=await r.json();assert.equal(r.status,status,JSON.stringify(b));return b};
const click=async(x,y)=>{for(const event of [{type:'pointermove',x,y},{type:'button',button:1,action:'down',x,y},{type:'button',button:1,action:'up'}])await post('desktop/input',{event},202)};
try{
 await writeFile('/workspace/PA_VISIBLE_FILE.txt','本地真实文件管理器验收\n');service.listen();await service.whenReady;port=service.server.address().port;
 leaseId=(await post('lease/acquire')).lease.leaseId;sessionId=(await post('desktop/session')).sessionId;
 const dockId=await wait(async()=>{try{return(await exec('xdotool',['search','--onlyvisible','--name','^AgentKit Dock$'],{env})).stdout.trim().split('\n')[0]}catch{return null}},'dock visible');const dg=await geometry(dockId);report.dockGeometry=dg;
 await exec('import',['-display',':99','-window','root',evidence+'/dock-three-apps.png'],{env});
 const initial=await ps(),oldChrome=initial.find(x=>x.comm==='chromium');assert.ok(oldChrome);report.initialProcesses=initial;
 const positions={browser:{x:+dg.X+32,y:+dg.Y+27},terminal:{x:+dg.X+82,y:+dg.Y+27},files:{x:+dg.X+132,y:+dg.Y+27}};
 await click(positions.files.x,positions.files.y);const files=await wait(()=>window('Thunar'),'visible workspace folder');report.fileWindow=files;assert.match(files.name,/workspace/i);await delay(300);await exec('import',['-display',':99','-window','root',evidence+'/workspace-file-manager.png'],{env});report.checks.push({name:'真实点击文件入口打开 /workspace 并显示目录',passed:true});
 await click(positions.terminal.x,positions.terminal.y);await wait(async()=>{const id=(await exec('xdotool',['getactivewindow'],{env})).stdout.trim();return(await exec('xprop',['-display',':99','-id',id,'WM_CLASS'],{env})).stdout.includes('XTerm')},'terminal focus');report.checks.push({name:'真实点击终端入口复用现有终端',passed:true});
 await click(positions.browser.x,positions.browser.y);await wait(async()=>{const id=(await exec('xdotool',['getactivewindow'],{env})).stdout.trim();return(await exec('xdotool',['getwindowname',id],{env})).stdout.includes('Chromium')},'browser focus');assert.equal((await ps()).find(x=>x.comm==='chromium').pid,oldChrome.pid);report.checks.push({name:'真实点击浏览器入口复用受管 Chromium 主进程',passed:true,pid:oldChrome.pid});
 let fileWindow=files;
 for(let n=0;n<10;n++){
  await exec('xdotool',['windowclose',fileWindow.id],{env});await wait(async()=>!desktop.stats().fileManagerRunning,'file manager exit');
  await click(positions.files.x,positions.files.y);fileWindow=await wait(()=>window('Thunar'),'file reopen');const current=await ps();for(const comm of ['Xvfb','tint2','thunar'])assert.equal(current.filter(x=>x.comm===comm).length,1,comm+' duplicated');
 }
 report.checks.push({name:'文件管理器连续开关十次，Xvfb/tint2/thunar 始终各一个',passed:true});
 await click(positions.browser.x,positions.browser.y);await wait(async()=>{const id=(await exec('xdotool',['getactivewindow'],{env})).stdout.trim();return(await exec('xprop',['-display',':99','-id',id,'WM_CLASS'],{env})).stdout.includes('Chromium')},'browser foreground before close');const chromeWindow=await window('Chromium');assert.ok(chromeWindow);report.beforeBrowserClose=chromeWindow;await exec('import',['-display',':99','-window','root',evidence+'/before-browser-close.png'],{env});await click(+chromeWindow.geometry.X + +chromeWindow.geometry.WIDTH - 20,+chromeWindow.geometry.Y + 20);await wait(async()=>!await window('Chromium'),'actual browser close button');await click(positions.browser.x,positions.browser.y);const reopened=await wait(()=>window('Chromium'),'managed browser reopen');const after=await ps();assert.equal(after.filter(x=>x.comm==='chromium').length,1);report.checks.push({name:'浏览器关窗后从同一入口恢复，仍仅一个受管主进程',passed:true,beforePid:oldChrome.pid,afterPid:after.find(x=>x.comm==='chromium').pid,window:reopened});
 await post('desktop/close');report.parkedStats=desktop.stats();assert.equal(report.parkedStats.dockRunning,true);assert.equal(report.parkedStats.fileManagerRunning,true);report.checks.push({name:'关闭观察保留 dock、文件管理器与原桌面',passed:true});
 report.beforeDispose=await ps();await service.close();await delay(200);report.afterDispose=await ps();assert.equal(report.afterDispose.length,0,JSON.stringify(report.afterDispose));report.checks.push({name:'dispose 清理 X/WM/dock/终端/浏览器及私有DBus进程组',passed:true});report.passed=true;
}catch(e){report.passed=false;report.error={message:e.message,stack:e.stack};console.error(e);await service.close().catch(()=>{});process.exitCode=1}finally{await writeFile(evidence+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error,dockGeometry:report.dockGeometry,fileWindow:report.fileWindow},null,2))}
