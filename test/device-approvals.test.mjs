import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {WebSocket} from 'ws';
import {Accounts} from '../src/accounts.mjs';
import {Store} from '../src/store.mjs';
import {DeviceSecurity} from '../src/device-security.mjs';
import {DeviceApprovals} from '../src/device-approvals.mjs';
import {setExecutionSettings} from '../src/execution-settings.mjs';
import {startServer} from '../src/server.mjs';
import {identity,headers,wsProof,approve} from './identity-helper.mjs';

const tick=()=>new Promise(r=>setTimeout(r,35));
const closers=new Map();
function scratch(t){const root=mkdtempSync(path.join(os.tmpdir(),'codex-device-approvals-'));t.after(async()=>{await closers.get(root)?.();closers.delete(root);if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('codex-device-approvals-'))throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});return root;}
class Rpc extends EventEmitter{
 calls=[];starts=[];responses=[];threads=new Map();
 async start(){}async close(){}
 async request(method,p){this.calls.push({method,p});
  if(method==='thread/start'){const thread={id:'thread-'+this.threads.size,cwd:p.cwd};this.threads.set(thread.id,thread);return{thread};}
  if(method==='thread/read')return{thread:this.threads.get(p.threadId)};
  if(method==='thread/resume'||method==='thread/name/set'||method==='thread/unsubscribe')return{};
  if(method==='thread/list')return{data:[...this.threads.values()],nextCursor:null};
  if(method==='turn/start'){const id='turn-'+(this.starts.length+1);this.starts.push({...p,id});return{turn:{id}};}
  if(method==='turn/interrupt')return{};
  throw Error('Unexpected '+method);
 }
 finish(thread){const turn=this.starts.filter(x=>x.threadId===thread).at(-1);this.emit('notification',{method:'turn/completed',params:{threadId:thread,turn:{id:turn.id,status:'completed'}}});}
 respond(id,result){this.responses.push({id,result});}reject(id,error){this.responses.push({id,error});}
}
async function setup(t){const root=scratch(t),workspace=path.join(root,'project'),dataDir=path.join(root,'state');mkdirSync(workspace);const accounts=new Accounts(dataDir);await accounts.set('owner','approval-test-password');const rpc=new Rpc();rpc.threads.set('shared',{id:'shared',cwd:workspace});let service=await startServer({port:0,dataDir,roots:[workspace],rpc});closers.set(root,()=>service.close());
 async function phone(){const key=identity(),fingerprint=approve(service,key,accounts.current().generation);let token;
  async function call(route,{method='GET',body}={}){const bytes=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));const response=await fetch(service.address+route,{method,headers:{...headers(key,service.address,method,route,bytes,route==='/api/login'?'':token||''),...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:method==='GET'?undefined:bytes});return{status:response.status,data:await response.json()};}
  async function login(){token=(await call('/api/login',{method:'POST',body:{username:'owner',password:'approval-test-password',deviceName:'same name',publicKey:key.publicKey}})).data.token;}
  await login();return{key,fingerprint,call,login,get token(){return token;}};
 }
 async function set(p,reviewer){const runtime=JSON.parse(readFileSync(path.join(dataDir,'runtime.json'),'utf8'));return fetch(service.address+'/admin/device-approvals',{method:'POST',headers:{'x-bridge-admin':runtime.adminToken,'content-type':'application/json'},body:JSON.stringify({fingerprint:p.fingerprint,generation:accounts.current().generation,approvalsReviewer:reviewer})});}
 async function socket(p){const ws=new WebSocket(service.address.replace('http:','ws:')+'/events');t.after(()=>ws.terminate());const events=[];ws.on('message',b=>events.push(JSON.parse(b)));await once(ws,'open');ws.send(JSON.stringify(wsProof(p.key,service.address,p.token)));await tick();return{ws,events};}
 return{root,workspace,dataDir,rpc,accounts,phone,set,socket,get service(){return service;},async restart(){await service.close();service=await startServer({port:0,dataDir,roots:[workspace],rpc});}};
}
const submit=(p,id,thread='shared',extra={})=>p.call('/api/threads/'+thread+'/messages',{method:'POST',body:{messageId:id,text:'test',...extra}});

test('legacy reviewer is snapshotted per identity, survives default changes and resets with account generation',t=>{
 const root=scratch(t),store=new Store(root);closers.set(root,()=>store.close());const security=new DeviceSecurity(store),key=identity();const d=security.enroll(key.publicKey,'phone','old');security.approve(d.fingerprint,security.code(d.fingerprint),'old');let fallback='auto_review';const settings=new DeviceApprovals(store,()=>fallback);
 const device={device_key:d.fingerprint,auth_generation:'old'};assert.equal(settings.get(device).approvalsReviewer,'auto_review');fallback='user';assert.equal(new DeviceApprovals(store,()=>fallback).get(device).approvalsReviewer,'auto_review');
 assert.throws(()=>settings.set(d.fingerprint,'old','never'));assert.equal(settings.get(device).approvalsReviewer,'auto_review');
 store.db.prepare('UPDATE device_approvals SET reviewer=?').run('accept-all');assert.throws(()=>settings.get(device),e=>e.code==='APPROVAL_SETTINGS_INVALID');
 security.enroll(key.publicKey,'phone','new');security.approve(d.fingerprint,security.code(d.fingerprint),'new');assert.equal(settings.get({device_key:d.fingerprint,auth_generation:'new'}).approvalsReviewer,'user');assert.throws(()=>settings.get(device));
});

test('two phones use separate reviewers for creation, resume, concurrent turns and loaded chats',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();await s.set(q,'auto_review');
 const a=(await p.call('/api/threads',{method:'POST',body:{}})).data,b=(await q.call('/api/threads',{method:'POST',body:{}})).data;
 assert.deepEqual(s.rpc.calls.filter(x=>x.method==='thread/start').map(x=>x.p.approvalsReviewer),['user','auto_review']);
 await Promise.all([submit(p,'manual-first',a.id),submit(q,'automatic-first',b.id)]);await tick();
 assert.equal(s.rpc.starts.find(x=>x.threadId===a.id).approvalsReviewer,'user');assert.equal(s.rpc.starts.find(x=>x.threadId===b.id).approvalsReviewer,'auto_review');
 await submit(q,'shared-auto');await tick();assert.equal(s.rpc.calls.find(x=>x.method==='thread/resume').p.approvalsReviewer,'auto_review');
 s.rpc.finish('shared');await tick();await submit(p,'shared-manual');await tick();assert.equal(s.rpc.starts.at(-1).approvalsReviewer,'user');assert.equal(s.rpc.starts.at(-1).approvalPolicy,'on-request');
 for(const turn of s.rpc.starts){assert.equal('sandboxPolicy' in turn,false);assert.equal('permissions' in turn,false);assert.equal(turn.approvalPolicy,'on-request');}
 assert.equal((await p.call('/api/status')).data.approvalsReviewer,'user');assert.equal((await q.call('/api/status')).data.approvalsReviewer,'auto_review');
});

test('queued tasks keep submission snapshots while setting changes affect only new messages',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();await submit(p,'active-manual');await tick();await s.set(p,'auto_review');
 const queued=(await submit(p,'queued-automatic')).data.job;await s.set(p,'user');const other=(await submit(q,'queued-other-phone')).data.job;
 assert.equal(queued.approvalsReviewer,'auto_review');assert.equal(other.approvalsReviewer,'user');assert.equal(s.rpc.starts.length,1);
 s.rpc.finish('shared');await tick();assert.equal(s.rpc.starts.at(-1).approvalsReviewer,'auto_review');
 s.rpc.finish('shared');await tick();assert.equal(s.rpc.starts.at(-1).approvalsReviewer,'user');
 const duplicate=(await submit(p,'queued-automatic')).data;assert.equal(duplicate.duplicate,true);assert.equal(duplicate.job.approvalsReviewer,'auto_review');
});

test('approval requests and replay belong to the submitting phone even within the same project',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone(),one=await s.socket(p),two=await s.socket(q);await submit(p,'owner-task');await tick();
 const turn=s.rpc.starts.at(-1);s.rpc.emit('request',{id:77,method:'item/commandExecution/requestApproval',params:{threadId:'shared',turnId:turn.id,command:'owner command'}});await tick();
 const req=(await p.call('/api/status')).data.requests[0];assert.equal((await q.call('/api/status')).data.requests.length,0);assert.ok(one.events.some(e=>e.type==='request.created'));assert.ok(!two.events.some(e=>e.type==='request.created'));
 const replay=await s.socket(q);assert.ok(!replay.events.some(e=>e.type==='request.created'));
 assert.ok(!one.events.some(e=>'audienceKey' in e));assert.equal('deviceKey' in req,false);
 assert.equal((await q.call('/api/requests/'+req.id+'/respond',{method:'POST',body:{decision:'accept'}})).status,403);
 await s.set(p,'auto_review');await tick();assert.equal(s.rpc.responses.length,0);assert.equal(s.service.store.jobs('shared')[0].approvals_reviewer,'user');
 assert.ok(one.events.some(e=>e.type==='settings.changed'));assert.ok(!two.events.some(e=>e.type==='settings.changed'));
 assert.equal((await p.call('/api/requests/'+req.id+'/respond',{method:'POST',body:{decision:'decline'}})).status,200);await tick();assert.ok(!two.events.some(e=>e.type==='request.resolved'));
 s.rpc.emit('request',{id:78,method:'item/tool/requestUserInput',params:{threadId:'shared',turnId:turn.id,questions:[{id:'question',question:'Choose a value'}]}});await tick();
 const question=(await p.call('/api/status')).data.requests[0];assert.equal((await q.call('/api/status')).data.requests.length,0);
 const answer={answers:{question:{answers:['chosen']}}};assert.equal((await q.call('/api/requests/'+question.id+'/respond',{method:'POST',body:answer})).status,403);
 await p.login();assert.equal((await p.call('/api/requests/'+question.id+'/respond',{method:'POST',body:answer})).status,200);assert.equal(s.rpc.responses.length,2);
});

test('phone input cannot change reviewer and invalid local settings fail closed',async t=>{
 const s=await setup(t),p=await s.phone();assert.equal((await p.call('/admin/device-approvals',{method:'POST',body:{approvalsReviewer:'auto_review'}})).status,403);
 assert.equal((await s.set(p,'never')).status,400);await submit(p,'no-client-override','shared',{approvalsReviewer:'auto_review',approvalPolicy:'never'});await tick();assert.equal(s.rpc.starts.at(-1).approvalsReviewer,'user');
 s.rpc.finish('shared');await tick();s.service.store.db.prepare('UPDATE device_approvals SET reviewer=? WHERE fingerprint=?').run('broken',p.fingerprint);
 assert.equal((await p.call('/api/status')).status,403);const n=s.rpc.starts.length;assert.equal((await submit(p,'corrupt-reviewer')).status,403);assert.equal(s.rpc.starts.length,n);
});

test('device settings and queued reviewer snapshots survive restart and relogin',async t=>{
 const s=await setup(t),p=await s.phone();await submit(p,'restart-active');await tick();await s.set(p,'auto_review');const queued=(await submit(p,'restart-queued')).data.job;await s.set(p,'user');setExecutionSettings(s.dataDir,'auto_review');
 await s.restart();await tick();assert.equal(s.rpc.starts.at(-1).approvalsReviewer,'auto_review');assert.equal(s.service.store.job(queued.id).approvals_reviewer,'auto_review');
 await p.login();assert.equal((await p.call('/api/status')).data.approvalsReviewer,'user');
});

test('stale turn requests cannot be assigned to a later phone task',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();await submit(p,'old-owner');await tick();const old=s.rpc.starts.at(-1).id;s.rpc.finish('shared');await tick();await submit(q,'new-owner');await tick();
 s.rpc.emit('request',{id:88,method:'item/commandExecution/requestApproval',params:{threadId:'shared',turnId:old,command:'stale'}});
 assert.equal(s.service.bridge.requests.size,0);assert.ok(s.rpc.responses.some(r=>r.id===88&&r.error));
});

test('legacy queued work snapshots the migrated reviewer once on upgrade',async t=>{
 const s=await setup(t),p=await s.phone();setExecutionSettings(s.dataDir,'auto_review');
 s.service.store.insertJob({id:'legacy-queued',threadId:'shared',messageId:'legacy-device-queue',hash:'hash',payload:{text:'legacy',attachmentIds:[]},deviceKey:p.fingerprint,authGeneration:s.accounts.current().generation});
 s.service.store.db.exec('DELETE FROM device_approvals');await s.restart();await tick();
 assert.equal(s.service.store.job('legacy-queued').approvals_reviewer,'auto_review');assert.equal(s.rpc.starts.at(-1).approvalsReviewer,'auto_review');
 setExecutionSettings(s.dataDir,'user');assert.equal((await p.call('/api/status')).data.approvalsReviewer,'auto_review');
});

test('corrupt queued snapshots never reach turn/start',async t=>{
 const s=await setup(t),p=await s.phone();s.service.store.insertJob({id:'bad-snapshot',threadId:'shared',messageId:'bad-device-queue',hash:'hash',payload:{text:'invalid',attachmentIds:[]},deviceKey:p.fingerprint,authGeneration:s.accounts.current().generation,approvalsReviewer:'never'});
 await s.service.bridge.pump('shared');assert.equal(s.service.store.job('bad-snapshot').state,'failed');assert.equal(s.rpc.starts.length,0);
});
