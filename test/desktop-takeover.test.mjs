import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Accounts} from '../src/accounts.mjs';
import {startServer} from '../src/server.mjs';
import {TakeoverManager,TakeoverError,WindowsDesktopController} from '../src/desktop-takeover.mjs';
import {identity,headers,approve} from './identity-helper.mjs';

const tick=()=>new Promise(r=>setTimeout(r,25));
class Rpc extends EventEmitter{
 busy=new Set(['original']);calls=[];
 async start(){}async close(){}
 async request(method,p){this.calls.push({method,p});if(method==='thread/read')return{thread:{id:p.threadId,cwd:p.threadId==='outside'?this.outside:this.cwd}};if(method==='thread/resume'){await this.beforeResume?.();if(this.busy.has(p.threadId))throw Error('another active writer');return{};}if(method==='thread/unsubscribe')return{};throw Error('Unexpected '+method);}
}
async function setup(t){
 const root=mkdtempSync(path.join(os.tmpdir(),'codex-takeover-tests-')),workspace=path.join(root,'project'),outside=path.join(root,'outside'),dataDir=path.join(root,'state');mkdirSync(workspace);mkdirSync(outside);
 const accounts=new Accounts(dataDir);await accounts.set('owner','takeover-test-password');const rpc=new Rpc();rpc.cwd=workspace;rpc.outside=outside;
 const controller={supported:true,inspected:0,closed:0,async inspect(){this.inspected++;return[{pid:999,path:'test-only',started:'test-instance',closable:true,backends:[]}];},async close(){this.closed++;await this.beforeClose?.();rpc.busy.clear();}};
 const service=await startServer({port:0,dataDir,roots:[workspace],rpc,desktopController:controller});t.after(async()=>{await service.close();if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('codex-takeover-tests-'))throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});
 async function phone(){const key=identity(),fingerprint=approve(service,key,accounts.current().generation);let token;
  async function call(route,{method='GET',body}={}){const bytes=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));const response=await fetch(service.address+route,{method,headers:{...headers(key,service.address,method,route,bytes,route==='/api/login'?'':token||''),...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:method==='GET'?undefined:bytes});return{status:response.status,data:await response.json()};}
  token=(await call('/api/login',{method:'POST',body:{username:'owner',password:'takeover-test-password',publicKey:key.publicKey,deviceName:'phone'}})).data.token;return{fingerprint,call};
 }
 async function allow(p,enabled=true){const runtime=JSON.parse(readFileSync(path.join(dataDir,'runtime.json'),'utf8'));return fetch(service.address+'/admin/desktop-takeover',{method:'POST',headers:{'x-bridge-admin':runtime.adminToken,'content-type':'application/json'},body:JSON.stringify({fingerprint:p.fingerprint,generation:accounts.current().generation,enabled})});}
 const prepare=(p,id='original')=>p.call('/api/threads/'+id+'/takeover/prepare',{method:'POST',body:{}});
 const confirm=(p,plan,id='original')=>p.call('/api/threads/'+id+'/takeover',{method:'POST',body:{confirmationId:plan.confirmationId}});
 const status=(p,plan,id='original')=>p.call('/api/threads/'+id+'/takeover/'+plan.confirmationId);
 return{service,rpc,controller,phone,allow,prepare,confirm,status};
}

test('ordinary acquisition succeeds without desktop permission or process access',async t=>{
 const s=await setup(t),p=await s.phone();s.rpc.busy.clear();const result=await s.prepare(p);assert.equal(result.data.acquired,true);assert.equal(s.controller.inspected,0);assert.equal(s.controller.closed,0);
});
test('desktop exit is default-denied, local-only to grant, and constrained by project access',async t=>{
 const s=await setup(t),p=await s.phone();assert.equal((await s.prepare(p)).status,403);assert.equal(s.controller.inspected,0);
 assert.equal((await p.call('/admin/desktop-takeover',{method:'POST',body:{enabled:true}})).status,403);
 assert.equal((await s.allow(p,'true')).status,400);assert.equal((await s.allow(p)).status,200);
 assert.equal((await s.prepare(p,'outside')).status,403);assert.equal(s.controller.inspected,0);
});
test('prepare is read-only; confirmed takeover keeps the original ID and never forks or resends messages',async t=>{
 const s=await setup(t),p=await s.phone();await s.allow(p);const plan=(await s.prepare(p)).data;assert.equal(plan.acquired,false);assert.equal(plan.threadId,'original');assert.equal(s.controller.closed,0);assert.equal('desktops' in plan,false);
 assert.equal((await s.confirm(p,plan)).status,202);await tick();const result=(await s.status(p,plan)).data;assert.equal(result.state,'succeeded');assert.equal(result.desktopClosed,true);assert.equal(result.threadId,'original');assert.equal(s.controller.closed,1);
 assert.ok(s.rpc.calls.every(c=>!['thread/start','thread/fork','turn/start'].includes(c.method)));
 assert.equal((await s.confirm(p,plan)).data.state,'succeeded');assert.equal(s.controller.closed,1);
});
test('confirmation is bound to device, generation and thread; revocation prevents desktop exit',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();await s.allow(p);await s.allow(q);const plan=(await s.prepare(p)).data;
 assert.equal((await s.confirm(q,plan)).status,404);assert.equal((await s.confirm(p,plan,'different')).status,404);
 await s.allow(p,false);assert.equal((await s.confirm(p,plan)).status,403);assert.equal(s.controller.closed,0);
});
test('a desktop released between preview and confirmation is acquired without closing it',async t=>{
 const s=await setup(t),p=await s.phone();await s.allow(p);const plan=(await s.prepare(p)).data;s.rpc.busy.clear();await s.confirm(p,plan);await tick();assert.equal((await s.status(p,plan)).data.state,'succeeded');assert.equal(s.controller.closed,0);
});
test('desktop identity changes or graceful-exit failure are reported without force or retry',async t=>{
 const s=await setup(t),p=await s.phone();await s.allow(p);const plan=(await s.prepare(p)).data;
 s.controller.close=async()=>{s.controller.closed++;throw new TakeoverError('DESKTOP_CONTROL_FAILED','desktop changed');};await s.confirm(p,plan);await tick();
 assert.equal((await s.status(p,plan)).data.state,'failed');assert.equal(s.controller.closed,1);await s.confirm(p,plan);assert.equal(s.controller.closed,1);assert.ok(!s.service.bridge.loaded.has('original'));
});
test('concurrent confirmations do not duplicate a desktop close operation',async t=>{
 const s=await setup(t),p=await s.phone();await s.allow(p);const plan=(await s.prepare(p)).data;let release;const gate=new Promise(r=>release=r);s.controller.beforeClose=()=>gate;
 try{await Promise.all([s.confirm(p,plan),s.confirm(p,plan)]);await tick();assert.equal(s.controller.closed,1);}finally{release();}await tick();assert.equal((await s.status(p,plan)).data.state,'succeeded');
});
test('expired confirmations fail before desktop exit',async()=>{
 let now=0;const bridge={async info(){},async acquire(){throw new TakeoverError('THREAD_BUSY','busy');}};let closes=0;
 const manager=new TakeoverManager({bridge,permissions:{require(){}},controller:{async inspect(){return[{}];},async close(){closes++;}},clock:()=>now});const device={device_key:'key',auth_generation:'generation'};
 const plan=await manager.prepare('thread',device);now=60001;assert.throws(()=>manager.confirm('thread',plan.confirmationId,device),e=>e.code==='TAKEOVER_EXPIRED');assert.equal(closes,0);await manager.close();
});
test('scope revoked during an in-flight resume prevents the desktop-close side effect',async t=>{
 const s=await setup(t),p=await s.phone();await s.allow(p);const plan=(await s.prepare(p)).data;let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);s.rpc.beforeResume=async()=>{entered();await gate;};
 await s.confirm(p,plan);await ready;
 s.service.projectAccess.set(p.fingerprint,s.service.security.lookup(p.fingerprint).generation,{mode:'directories',roots:[s.rpc.outside]});release();await tick();
 assert.equal(s.controller.closed,0);assert.equal(s.service.takeover.operations.get(plan.confirmationId).state,'failed');
});
test('unsupported desktop controllers do not attempt any Windows control',async()=>{
 const controller=new WindowsDesktopController({platform:'linux'});assert.equal(controller.supported,false);await assert.rejects(controller.inspect(),e=>e.code==='TAKEOVER_UNSUPPORTED');
});

function helperReply(result,exitCode=1){
 const calls=[];
 const spawnProcess=(exe,args,options)=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{throw Error('Unexpected helper termination');};let input='';
  child.stdin.on('data',data=>input+=data);child.stdin.on('finish',()=>{calls.push({exe,args,options,input:JSON.parse(input)});queueMicrotask(()=>{child.stdout.end(JSON.stringify(result));child.emit('close',exitCode);});});return child;
 };
 return{controller:new WindowsDesktopController({platform:'win32',protectedPids:()=>[123],spawnProcess}),calls};
}
test('Windows quit helper failures explain tray, locked desktop and focus errors without exposing raw output',async()=>{
 for(const code of ['DESKTOP_CHANGED','DESKTOP_NOT_INTERACTIVE','DESKTOP_QUIT_UNAVAILABLE','DESKTOP_FOCUS_FAILED','DESKTOP_QUIT_INPUT_FAILED','DESKTOP_EXIT_TIMEOUT']){
  const {controller,calls}=helperReply({errorCode:code,error:'private process diagnostics'});
  await assert.rejects(controller.close([{pid:456}]),error=>error.code===code&&!error.message.includes('private process diagnostics'));
  assert.equal(calls.length,1);assert.equal(calls[0].args.at(-1),'close');assert.equal(calls[0].options.windowsHide,true);assert.deepEqual(calls[0].input.protectedPids,[123]);
 }
 const {controller}=helperReply({errorCode:'ARBITRARY_ERROR',error:'private process diagnostics'});
 await assert.rejects(controller.close([]),error=>error.code==='DESKTOP_CONTROL_FAILED'&&!error.message.includes('private process diagnostics'));
});
test('Windows helper success is accepted only after the desktop reports a completed exit',async()=>{
 const success=helperReply({closed:true},0);await success.controller.close([{pid:456}]);assert.equal(success.calls.length,1);
 const incomplete=helperReply({closed:false},0);await assert.rejects(incomplete.controller.close([]),error=>error.code==='DESKTOP_CONTROL_FAILED');
});
