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
 async history(id,params={}){await this.historyGate?.();this.lastHistory=params;const turns=[...(this.chats.get(id)||[])].reverse(),offset=Number(params.cursor)||0,limit=params.limit||20;return{data:turns.slice(offset,offset+limit),nextCursor:offset+limit<turns.length?String(offset+limit):null};}
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

test('phone chat-only mode removes project metadata and forbids coding chats, computer tools, takeover and self-upgrade',async t=>{
 const s=await setup(t),p=await s.phone(),normal=await s.phone();assert.equal((await s.set(p,'chat_only')).status,200);const status=(await p.call('/api/status')).data;assert.equal(status.approvalsReviewer,'chat_only');assert.deepEqual(status.workspaces,[]);assert.deepEqual(status.projectAccess.roots,[]);assert.equal(status.capabilities.files,true);assert.equal(status.capabilities.desktopTakeover,false);assert.ok(!JSON.stringify(status).includes(s.workspace));
 for(const [route,method,body]of [['/api/threads/coding','GET'],['/api/threads/coding/history','GET'],['/api/threads/coding/acquire','POST',{}],['/api/threads/coding/release','POST',{}],['/api/threads/coding/takeover/prepare','POST',{}],['/admin/device-approvals','POST',{approvalsReviewer:'user'}]])assert.equal((await p.call(route,{method,body})).status,403,route);
 assert.equal((await p.call('/api/threads',{method:'POST',body:{name:'bad',cwd:s.workspace}})).status,400);const chat=(await s.create(p)).data;assert.equal((await s.submit(p,chat.id,'math',{config:{shell_tool:true}})).status,400);await s.submit(p,chat.id);await until(()=>s.service.store.jobs(chat.id)[0]?.state==='completed');assert.equal((await p.call(`/api/threads/${chat.id}/history`)).data.turns[0].items[1].text,'safe answer');
 assert.deepEqual((await p.call('/api/threads')).data.threads.map(c=>c.id),[chat.id]);assert.equal((await normal.call(`/api/threads/${chat.id}`)).status,403);const privateJob=s.service.store.jobs(chat.id)[0];assert.equal((await normal.call('/api/jobs/'+privateJob.id)).status,403);assert.equal((await normal.call('/api/jobs/'+privateJob.id+'/cancel',{method:'POST',body:{}})).status,403);assert.equal(s.rpc.calls.filter(c=>c.method==='turn/start').length,0);
});
test('chat-only file uploads are parsed, owner/mode isolated, idempotent and shown as original attachments',async t=>{
 const s=await setup(t),a=await s.phone(),b=await s.phone(),normal=await s.phone();
 const upload=(p,id,name,text,revision)=>p.call('/api/files?'+new URLSearchParams({id,name,mime:'text/plain',...(revision?{modeRevision:revision}:{})}),{method:'POST',bytes:Buffer.from(text)});
 const old=randomUUID();assert.equal((await upload(a,old,'old.txt','operate private')).status,201);
 await s.set(a,'chat_only');await s.set(b,'chat_only');const chat=(await s.create(a)).data,other=(await s.create(b)).data;
 const revision=(await a.call('/api/status')).data.executionSettings.modeRevision,id=randomUUID();
 assert.equal((await upload(a,id,'notes.txt','文件内容：苹果 42',revision)).status,201);
 assert.equal((await upload(a,id,'notes.txt','文件内容：苹果 42',revision)).status,201);
 assert.equal((await upload(a,id,'notes.txt','changed',revision)).status,400);
 assert.equal((await upload(b,id,'notes.txt','文件内容：苹果 42')).status,403);
 assert.equal((await s.submit(a,chat.id,'read',{fileIds:[old]})).status,403);
 assert.equal((await s.submit(b,other.id,'steal',{fileIds:[id]})).status,403);
 const message={messageId:randomUUID(),text:'',fileIds:[id],modeRevision:revision};
 assert.equal((await a.call(`/api/threads/${chat.id}/messages`,{method:'POST',body:message})).status,202);
 await until(()=>s.service.store.jobs(chat.id)[0]?.state==='completed');
 const runtime=s.engines.find(e=>e.device.device_key===a.fingerprint).runtime;
 assert.deepEqual(runtime.inputs[0].documents,[{name:'notes.txt',text:'文件内容：苹果 42'}]);
 assert.equal((await a.call(`/api/threads/${chat.id}/messages`,{method:'POST',body:message})).data.duplicate,true);assert.equal(runtime.inputs.length,1);
 const history=(await a.call(`/api/threads/${chat.id}/history`)).data,wire=JSON.stringify(history);assert.equal(history.turns[0].items[0].files[0].name,'notes.txt');assert.ok(!wire.includes('苹果 42'));assert.ok(!wire.includes(s.dataDir));
 assert.equal((await normal.call(`/api/threads/${chat.id}/history`)).status,403);
 assert.equal((await upload(a,randomUUID(),'unsupported.exe','MZ')).status,400);
 assert.equal((await s.submit(a,chat.id,'too many',{fileIds:Array(9).fill(id)})).status,400);
 await a.login();assert.equal((await s.submit(a,chat.id,'again',{fileIds:[id]})).status,202);await until(()=>s.service.store.jobs(chat.id).every(j=>j.state==='completed'));
 await s.restart();assert.equal((await a.call(`/api/threads/${chat.id}/messages`,{method:'POST',body:message})).data.duplicate,true);
 await s.set(a,'user');assert.equal((await s.submit(a,'coding','wrong mode',{fileIds:[id]})).status,403);
 assert.equal((await upload(a,randomUUID(),'stale.txt','text',revision)).status,409);assert.equal(s.rpc.turns.length,0);
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

const sharedRoot='/api/shared-chats/threads';
const grant=(s,p,enabled=true)=>s.local('/admin/shared-chats',{fingerprint:p.fingerprint,generation:s.accounts.current().generation,enabled});
test('original message timestamps remain identical through own, shared and restarted history reads',async t=>{
 const s=await setup(t),v=await s.phone(),p=await s.phone();await s.set(p,'chat_only');await grant(s,v);const c=(await s.create(p)).data;
 await s.submit(p,c.id);await until(()=>s.service.store.jobs(c.id)[0]?.state==='completed');
 const native=s.engines[0].runtime.chats.get(c.id)[0].items;
 native[0].startedAtMs=1793635200000;native[1].startedAtMs=1793635201000;native[1].completedAtMs=1793635260000;
 for(const read of [()=>p.call(`/api/threads/${c.id}/history`),()=>v.call(`${sharedRoot}/${c.id}/history`)]){
  const items=(await read()).data.turns[0].items;assert.equal(items[0].startedAtMs,native[0].startedAtMs);assert.equal(items[1].completedAtMs,native[1].completedAtMs);
 }
 await s.restart();assert.equal((await v.call(`${sharedRoot}/${c.id}/history`)).data.turns[0].items[1].completedAtMs,1793635260000);
});
test('shared viewing is opt-in, PC-admin-only, and persists without changing legacy phone endpoints',async t=>{
 const s=await setup(t),viewer=await s.phone(),source=await s.phone();await s.set(viewer,'chat_only');await s.set(source,'chat_only');
 const own=(await s.create(viewer)).data,other=(await s.create(source)).data;
 assert.equal((await viewer.call('/api/status')).data.sharedChatAccess.enabled,false);
 assert.equal((await viewer.call(sharedRoot)).status,403);
 assert.equal((await viewer.call('/admin/shared-chats',{method:'POST',body:{fingerprint:viewer.fingerprint,generation:s.accounts.current().generation,enabled:true}})).status,403);
 assert.equal((await grant(s,viewer)).status,200);
 assert.deepEqual((await viewer.call('/api/threads')).data.threads.map(c=>c.id),[own.id]);
 assert.deepEqual((await source.call('/api/threads')).data.threads.map(c=>c.id),[other.id]);
 const listed=(await viewer.call(sharedRoot)).data.threads;assert.equal(listed.length,1);assert.equal(listed[0].id,other.id);assert.equal(listed[0].control,'sharedReadOnly');assert.equal(listed[0].owner.name,'test phone');assert.equal(listed[0].owner.code,source.fingerprint.slice(-8).toUpperCase());assert.ok(!JSON.stringify(listed).includes(source.fingerprint));
 assert.equal((await viewer.call(`/api/threads/${other.id}/history`)).status,403);
 await viewer.login();assert.equal((await viewer.call(sharedRoot)).status,200);await s.restart();assert.equal((await viewer.call('/api/status')).data.sharedChatAccess.enabled,true);
 await s.set(viewer,'user');assert.equal((await viewer.call(sharedRoot)).status,200);assert.deepEqual((await viewer.call('/api/threads')).data.threads.map(c=>c.id),['coding']);
 assert.equal((await source.call(sharedRoot)).status,403);assert.equal((await grant(s,viewer,false)).status,200);assert.equal((await viewer.call(sharedRoot)).status,403);
});

test('shared history paginates and only exposes images bound to that chat; old uploads remain owner-only',async t=>{
 const s=await setup(t),v=await s.phone(),p=await s.phone();await s.set(p,'chat_only');await grant(s,v);const c=(await s.create(p)).data,other=(await s.create(p)).data;
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]);
 const upload=(await p.call('/api/uploads',{method:'POST',bytes:png})).data,unused=(await p.call('/api/uploads',{method:'POST',bytes:png})).data;
 await s.submit(p,c.id,'first',{attachmentIds:[upload.id]});await until(()=>s.service.store.jobs(c.id)[0]?.state==='completed');await s.submit(p,c.id,'second');await until(()=>s.service.store.jobs(c.id).every(j=>j.state==='completed'));
 const history=(await v.call(`${sharedRoot}/${c.id}/history?limit=1`)).data;assert.equal(history.turns.length,1);assert.equal(history.nextCursor,'1');
 const older=(await v.call(`${sharedRoot}/${c.id}/history?limit=1&cursor=1`)).data;assert.ok(JSON.stringify(older).includes(upload.id));assert.ok(!JSON.stringify(older).includes(s.dataDir));assert.equal(s.engines[0].runtime.lastHistory.readOnly,true);
 const image=await v.call(`${sharedRoot}/${c.id}/images/${upload.id}`);assert.equal(image.status,200);assert.deepEqual(image.data,png);
 for(const route of [`/api/uploads/${upload.id}`,`${sharedRoot}/${other.id}/images/${upload.id}`,`${sharedRoot}/${c.id}/images/${unused.id}`,`${sharedRoot}/coding/images/${upload.id}`])assert.equal((await v.call(route)).status,403,route);
 assert.equal((await p.call(`/api/uploads/${upload.id}`)).status,200);assert.equal((await p.call(`/api/threads/${c.id}/history`)).status,200);
});

test('view permission never permits sending, cancellations, approvals or coding access, and does not start empty chats',async t=>{
 const s=await setup(t),v=await s.phone(),p=await s.phone();await s.set(v,'chat_only');await s.set(p,'chat_only');await grant(s,v);const c=(await s.create(p)).data;
 const runtime=s.engines[0].runtime,originalHistory=runtime.history;runtime.history=()=>{throw Error('Empty shared draft must not load a runtime');};assert.deepEqual((await v.call(`${sharedRoot}/${c.id}/history`)).data.turns,[]);runtime.history=originalHistory;
 await s.submit(p,c.id,'question');await until(()=>s.service.chatOnly.requests.size===1);const req=(await p.call('/api/status')).data.requests[0],job=s.service.store.jobs(c.id)[0];
 for(const suffix of ['messages','acquire','release','takeover/prepare','name'])assert.equal((await v.call(`${sharedRoot}/${c.id}/${suffix}`,{method:'POST',body:{text:'steal'}})).status,403);
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await v.call(`${sharedRoot}/${c.id}`,{method,body:{name:'changed'}})).status,403);
 for(const route of [`/api/threads/${c.id}/messages`,`/api/jobs/${job.id}/cancel`,`/api/requests/${req.id}/respond`])assert.equal((await v.call(route,{method:'POST',body:{messageId:randomUUID(),text:'no',answers:{q:{answers:['2']}}}})).status,403,route);
 assert.equal((await v.call(`${sharedRoot}/coding/history`)).status,403);assert.equal(s.rpc.turns.length,0);assert.equal(runtime.inputs.length,1);assert.equal(s.service.chatOnly.requests.size,1);
 assert.equal((await p.call(`/api/requests/${req.id}/respond`,{method:'POST',body:{answers:{q:{answers:['2']}}}})).status,200);
});

test('revocation and source mode changes are checked again after an in-flight history read',async t=>{
 const s=await setup(t),v=await s.phone(),p=await s.phone();await s.set(p,'chat_only');await grant(s,v);const c=(await s.create(p)).data;await s.submit(p,c.id);await until(()=>s.service.store.jobs(c.id)[0]?.state==='completed');
 const runtime=s.engines[0].runtime;
 async function gated(change){let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);runtime.historyGate=async()=>{entered();await gate;};const read=v.call(`${sharedRoot}/${c.id}/history`);await ready;await change();release();const result=await read;runtime.historyGate=null;assert.equal(result.status,403);assert.ok(!JSON.stringify(result.data).includes('safe answer'));}
 await gated(()=>grant(s,v,false));await grant(s,v);await gated(()=>s.set(p,'user'));assert.equal((await v.call(sharedRoot)).data.threads.length,0);assert.equal((await v.call(`${sharedRoot}/${c.id}/history`)).status,403);
 await s.set(p,'chat_only');assert.equal((await v.call(sharedRoot)).data.threads.length,1);s.service.security.revoke(p.fingerprint);assert.equal((await v.call(sharedRoot)).data.threads.length,0);
 s.service.security.revoke(v.fingerprint);s.service.security.approve(v.fingerprint,s.service.security.code(v.fingerprint),s.accounts.current().generation);await v.login();assert.equal((await v.call('/api/status')).data.sharedChatAccess.enabled,false);
});

test('shared catalogs paginate without leaking old generations, coding chats, or revoked source devices',async t=>{
 const s=await setup(t),v=await s.phone(),p=await s.phone();await s.set(p,'chat_only');await grant(s,v);const gen=s.accounts.current().generation;
 const insert=s.service.store.db.prepare('INSERT INTO chat_only_threads VALUES(?,?,?,?,?,?)');for(let i=0;i<52;i++)insert.run(randomUUID(),p.fingerprint,gen,'math '+i,i,i);
 insert.run(randomUUID(),p.fingerprint,'old-generation','OLD_PRIVATE_CANARY',0,999);const first=(await v.call(sharedRoot)).data,second=(await v.call(sharedRoot+'?cursor='+first.nextCursor)).data;
 assert.equal(first.threads.length,50);assert.equal(second.threads.length,2);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.threads,...second.threads].map(c=>c.id)).size,52);assert.ok(!JSON.stringify(first).includes('OLD_PRIVATE_CANARY'));assert.equal((await v.call(sharedRoot+'?cursor=NaN')).status,400);
 s.service.sharedChatPermissions.set(v.fingerprint,gen,true);s.service.store.db.prepare('UPDATE device_chat_viewer SET generation=? WHERE fingerprint=?').run('old-generation',v.fingerprint);assert.equal((await v.call(sharedRoot)).status,403);
});

test('privileged viewing still receives no other-device live events, replays, jobs or questions',async t=>{
 const s=await setup(t),v=await s.phone(),p=await s.phone();await s.set(v,'chat_only');await s.set(p,'chat_only');await grant(s,v);const c=(await s.create(p)).data,live=await s.socket(v);
 await s.submit(p,c.id,'question');await until(()=>s.service.chatOnly.requests.size===1);await tick();assert.deepEqual((await v.call('/api/status')).data.requests,[]);assert.ok(!live.events.some(e=>JSON.stringify(e).includes(c.id)));
 const replay=await s.socket(v);assert.ok(!replay.events.some(e=>JSON.stringify(e).includes(c.id)));assert.equal((await v.call(`/api/threads/${c.id}/jobs`)).status,403);assert.equal((await v.call(`${sharedRoot}/${c.id}/jobs`)).status,404);
 const before=live.events.length;await grant(s,v,false);await until(()=>live.events.slice(before).some(e=>e.type==='shared-chat.settings.changed'&&e.data.enabled===false));
});
