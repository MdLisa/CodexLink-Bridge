import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {WebSocket} from 'ws';
import {startServer} from '../src/server.mjs';
import {Accounts} from '../src/accounts.mjs';
import {identity,headers,wsProof,approve} from './identity-helper.mjs';

const tick=()=>new Promise(r=>setTimeout(r,30));
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick();}throw Error('Timed out waiting for state');}
class Rpc extends EventEmitter{
 calls=[];turns=[];
 async start(){}async close(){}
 async request(method,p){this.calls.push({method,p});if(method==='thread/read'){await this.gate?.();return{thread:{id:p.threadId,cwd:this.cwd}};}if(method==='thread/list')return{data:[{id:'coding',cwd:this.cwd,name:'private coding chat'}]};if(['thread/resume','thread/unsubscribe'].includes(method))return{};if(method==='turn/start'){const id=randomUUID();this.turns.push({...p,id});return{turn:{id}};}throw Error('Unexpected normal RPC '+method);}
 respond(){}reject(){}
 finish(){const t=this.turns.at(-1);this.emit('notification',{method:'turn/completed',params:{threadId:t.threadId,turn:{id:t.id,status:'completed'}}});}
}
class Runtime extends EventEmitter{
 chats=new Map();pending=new Map();closed=false;inputs=[];
 constructor(chats){super();if(chats)this.chats=chats;}
 async start(){this.closed=false;}authExpiring(){return false;}
 async create(){const chat={id:randomUUID()};this.chats.set(chat.id,[]);return chat;}
 async history(id){return{data:this.chats.get(id)||[],nextCursor:null};}
 async ask(id,input){this.inputs.push(input);const turnId=randomUUID();this.emit('notification',{method:'turn/started',params:{threadId:id,turn:{id:turnId}}});
  const finish=()=>{const items=[{type:'userMessage',id:randomUUID(),content:[{type:'text',text:input.text}]},{type:'agentMessage',id:randomUUID(),text:'safe answer'}];this.chats.get(id).push({id:turnId,status:'completed',items});for(const item of items)this.emit('notification',{method:'item/completed',params:{threadId:id,turnId,item}});return{text:'safe answer',turnId};};
  if(input.text==='hold'||input.text==='question')return new Promise((resolve,reject)=>{this.pending.set(id,{reject,resolve:()=>resolve(finish())});if(input.text==='question')this.emit('question',{id:'local-question',threadId:id,turnId,questions:[{id:'q',question:'Which number?'}]});});return finish();
 }
 answer(){for(const [id,p]of this.pending){this.pending.delete(id);p.resolve();}}
 async interrupt(id){this.pending.get(id)?.reject(Object.assign(Error('stopped'),{code:'CHAT_CLOSED'}));this.pending.delete(id);}
 async close(){this.closed=true;for(const id of [...this.pending.keys()])await this.interrupt(id);}
}
async function setup(t){const root=mkdtempSync(path.join(os.tmpdir(),'codex-chat-api-')),workspace=path.join(root,'workspace'),dataDir=path.join(root,'data');mkdirSync(workspace);const accounts=new Accounts(dataDir);await accounts.set('owner','chat-api-test-password');const rpc=new Rpc();rpc.cwd=workspace;const engines=[],storage=new Map();const options={port:0,dataDir,roots:[workspace],rpc,chatRuntimeFactory:async d=>{const k=d.device_key+':'+d.auth_generation;if(!storage.has(k))storage.set(k,new Map());const runtime=new Runtime(storage.get(k));engines.push({device:d,runtime});return runtime;}};let service=await startServer(options);
 t.after(async()=>{await service.close();if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('codex-chat-api-'))throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});
 async function local(route,body){const admin=JSON.parse(readFileSync(path.join(dataDir,'runtime.json'),'utf8')).adminToken;const response=await fetch(service.address+route,{method:'POST',headers:{'x-bridge-admin':admin,'content-type':'application/json'},body:JSON.stringify(body)});return{status:response.status,data:await response.json()};}
 async function phone(){const key=identity(),fingerprint=approve(service,key,accounts.current().generation);let token;
  async function call(route,{method='GET',body,bytes}={}){const payload=bytes||Buffer.from(body===undefined?'':JSON.stringify(body));const response=await fetch(service.address+route,{method,headers:{...headers(key,service.address,method,route,payload,route==='/api/login'?'':token||''),...(token?{authorization:'Bearer '+token}:{}),...(method==='GET'?{}:{'content-type':bytes?'application/octet-stream':'application/json'})},body:method==='GET'?undefined:payload});const raw=Buffer.from(await response.arrayBuffer());return{status:response.status,data:response.headers.get('content-type')?.includes('application/json')?JSON.parse(raw):raw};}
  async function login(){token=(await call('/api/login',{method:'POST',body:{username:'owner',password:'chat-api-test-password',deviceName:'phone',publicKey:key.publicKey}})).data.token;}await login();return{key,fingerprint,call,login,get token(){return token;}};
 }
 const set=(p,approvalsReviewer)=>local('/admin/device-approvals',{fingerprint:p.fingerprint,generation:accounts.current().generation,approvalsReviewer});
 const create=p=>p.call('/api/threads',{method:'POST',body:{name:'private math'}});
 const submit=(p,threadId,text='math',extra={})=>p.call(`/api/threads/${threadId}/messages`,{method:'POST',body:{messageId:randomUUID(),text,...extra}});
 async function socket(p){const ws=new WebSocket(service.address.replace('http:','ws:')+'/events'),events=[];t.after(()=>ws.terminate());ws.on('message',b=>events.push(JSON.parse(b)));await once(ws,'open');ws.send(JSON.stringify(wsProof(p.key,service.address,p.token)));await until(()=>events.some(e=>e.type==='authenticated'));return{ws,events};}
 return{root,workspace,dataDir,get service(){return service;},rpc,engines,accounts,phone,local,set,create,submit,socket,async restart(){await service.close();service=await startServer(options);}};
}

test('phone chat-only mode removes project metadata and forbids coding chats, file tools, takeover and self-upgrade',async t=>{
 const s=await setup(t),p=await s.phone(),normal=await s.phone();assert.equal((await s.set(p,'chat_only')).status,200);const status=(await p.call('/api/status')).data;assert.equal(status.approvalsReviewer,'chat_only');assert.deepEqual(status.workspaces,[]);assert.deepEqual(status.projectAccess.roots,[]);assert.equal(status.capabilities.files,false);assert.equal(status.capabilities.desktopTakeover,false);assert.ok(!JSON.stringify(status).includes(s.workspace));
 for(const [route,method,body]of [['/api/threads/coding','GET'],['/api/threads/coding/history','GET'],['/api/threads/coding/acquire','POST',{}],['/api/threads/coding/release','POST',{}],['/api/threads/coding/takeover/prepare','POST',{}],['/api/files?id='+randomUUID(),'POST',{}],['/admin/device-approvals','POST',{approvalsReviewer:'user'}]])assert.equal((await p.call(route,{method,body})).status,403,route);
 assert.equal((await p.call('/api/threads',{method:'POST',body:{name:'bad',cwd:s.workspace}})).status,400);const chat=(await s.create(p)).data;assert.equal((await s.submit(p,chat.id,'math',{config:{shell_tool:true}})).status,400);await s.submit(p,chat.id);await until(()=>s.service.store.jobs(chat.id)[0]?.state==='completed');assert.equal((await p.call(`/api/threads/${chat.id}/history`)).data.turns[0].items[1].text,'safe answer');
 assert.deepEqual((await p.call('/api/threads')).data.threads.map(c=>c.id),[chat.id]);assert.equal((await normal.call(`/api/threads/${chat.id}`)).status,403);const privateJob=s.service.store.jobs(chat.id)[0];assert.equal((await normal.call('/api/jobs/'+privateJob.id)).status,403);assert.equal((await normal.call('/api/jobs/'+privateJob.id+'/cancel',{method:'POST',body:{}})).status,403);assert.equal(s.rpc.calls.filter(c=>c.method==='turn/start').length,0);
});
test('restricted chats and images belong to one device and mode, survive relogin and cannot reuse coding uploads',async t=>{
 const s=await setup(t),a=await s.phone(),b=await s.phone();const png=Buffer.from([137,80,78,71,13,10,26,10,...Array(20).fill(0)]);const old=(await a.call('/api/uploads',{method:'POST',bytes:png})).data;await s.set(a,'chat_only');await s.set(b,'chat_only');const chat=(await s.create(a)).data;
 assert.equal((await s.submit(a,chat.id,'image',{attachmentIds:[old.id]})).status,403);const image=(await a.call('/api/uploads',{method:'POST',bytes:png})).data;assert.equal((await b.call('/api/uploads/'+image.id)).status,403);assert.equal((await b.call(`/api/threads/${chat.id}`)).status,403);assert.equal((await b.call('/api/threads')).data.threads.length,0);
 await s.submit(a,chat.id,'image',{attachmentIds:[image.id]});await until(()=>s.service.store.jobs(chat.id)[0]?.state==='completed');assert.deepEqual(s.engines[0].runtime.inputs[0].images[0],png);await a.login();assert.equal((await a.call('/api/uploads/'+image.id)).status,200);assert.equal((await a.call('/api/threads')).data.threads[0].id,chat.id);
 assert.equal((await s.set(a,'user')).status,200);assert.equal((await a.call('/api/uploads/'+image.id)).status,403);assert.equal((await a.call('/api/threads/'+chat.id)).status,403);assert.equal(s.engines[0].runtime.closed,true);
});
test('switching modes refuses active work and in-flight reads and cancels old queued coding tasks',async t=>{
 const s=await setup(t),p=await s.phone();let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);s.rpc.gate=async()=>{entered();await gate;};const read=p.call('/api/threads/coding');await ready;assert.equal((await s.set(p,'chat_only')).status,409);release();await read;s.rpc.gate=null;
 await s.submit(p,'coding','work');await until(()=>s.rpc.turns.length===1);await s.submit(p,'coding','queued');assert.equal((await s.set(p,'chat_only')).status,409);s.service.bridge.online=false;s.rpc.finish();await until(()=>s.service.bridge.active.size===0);const queued=s.service.store.queued()[0];assert.ok(queued);assert.equal((await s.set(p,'chat_only')).status,200);assert.equal(s.service.store.job(queued.id).state,'cancelled');s.service.bridge.online=true;
});
test('chat tasks stay isolated through live/replayed events; questions are owner-only and do not approve operations',async t=>{
 const s=await setup(t),a=await s.phone(),b=await s.phone(),normal=await s.phone();await s.set(a,'chat_only');await s.set(b,'chat_only');const chat=(await s.create(a)).data,sa=await s.socket(a),sb=await s.socket(b),sn=await s.socket(normal);
 await s.submit(a,chat.id,'question');await until(()=>s.service.chatOnly.requests.size===1);const request=(await a.call('/api/status')).data.requests[0];assert.equal(request.method,'item/tool/requestUserInput');assert.equal((await b.call(`/api/requests/${request.id}/respond`,{method:'POST',body:{answers:{q:{answers:['2']}}}})).status,403);assert.equal((await a.call(`/api/requests/${request.id}/respond`,{method:'POST',body:{answers:{q:{answers:['2']}}}})).status,200);await until(()=>s.service.store.jobs(chat.id)[0]?.state==='completed');await tick();assert.ok(sa.events.some(e=>e.data?.threadId===chat.id));for(const socket of [sb,sn])assert.ok(!socket.events.some(e=>JSON.stringify(e).includes(chat.id)));
 s.service.bridge.event('thread.event',{threadId:'coding',method:'item/agentMessage/delta',delta:'PC_PRIVATE_CANARY'});await tick();assert.ok(!sa.events.some(e=>JSON.stringify(e).includes('PC_PRIVATE_CANARY')));const replay=await s.socket(b);assert.ok(!replay.events.some(e=>JSON.stringify(e).includes(chat.id)));for(const event of sa.events)assert.equal('audienceKey' in event||'workspace' in event||'executionMode' in event,false);
});
test('revoking a device stops its private worker and closes its runtime without repeating jobs',async t=>{
 const s=await setup(t),p=await s.phone();await s.set(p,'chat_only');const chat=(await s.create(p)).data;await s.submit(p,chat.id,'hold');await until(()=>s.service.chatOnly.current({device_key:p.fingerprint,auth_generation:s.accounts.current().generation})?.state==='running');assert.equal((await s.set(p,'user')).status,409);s.service.security.revoke(p.fingerprint);await s.local('/admin/auth-changed',{});assert.equal(s.engines[0].runtime.closed,true);assert.equal((await p.call('/api/status')).status,401);assert.equal(s.engines[0].runtime.inputs.length,1);
});

test('mode revisions reject stale retries even after a full offline round trip back to the same mode',async t=>{
 const s=await setup(t),p=await s.phone();const first=(await p.call('/api/status')).data.executionSettings.modeRevision;await s.set(p,'auto_review');assert.equal((await p.call('/api/status')).data.executionSettings.modeRevision,first);await s.set(p,'chat_only');const second=(await p.call('/api/status')).data.executionSettings.modeRevision;assert.notEqual(second,first);const chat=(await s.create(p)).data;
 assert.equal((await s.submit(p,chat.id,'stale',{modeRevision:first})).status,409);await s.set(p,'user');const third=(await p.call('/api/status')).data.executionSettings.modeRevision;assert.notEqual(third,first);assert.equal((await s.submit(p,'coding','stale',{modeRevision:first})).status,409);assert.equal(s.rpc.turns.length,0);await s.set(p,'chat_only');assert.equal((await s.submit(p,chat.id,'stale',{modeRevision:second})).status,409);
});
test('restart preserves private chats and queued mode, never hands chat work to normal Codex, and deduplicates retry',async t=>{
 const s=await setup(t),p=await s.phone();await s.set(p,'chat_only');const chat=(await s.create(p)).data;const payload={text:'queued math',attachmentIds:[]};const {digest}=await import('../src/bridge.mjs');const job=s.service.store.insertJob({id:randomUUID(),threadId:chat.id,messageId:'restart-private-message',hash:digest(JSON.stringify(payload)),payload,deviceKey:p.fingerprint,authGeneration:s.accounts.current().generation,approvalsReviewer:'chat_only'});s.service.store.db.prepare("UPDATE jobs SET execution_mode='chat_only' WHERE id=?").run(job.id);await s.restart();await until(()=>s.service.store.job(job.id).state==='completed');assert.equal((await p.call('/api/threads')).data.threads[0].id,chat.id);assert.equal(s.rpc.turns.length,0);const duplicate=await p.call(`/api/threads/${chat.id}/messages`,{method:'POST',body:{messageId:'restart-private-message',...payload}});assert.equal(duplicate.data.duplicate,true);assert.equal(s.engines.at(-1).runtime.inputs.length,1);
});
