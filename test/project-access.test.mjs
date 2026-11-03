import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {WebSocket} from 'ws';
import {Accounts} from '../src/accounts.mjs';
import {Store} from '../src/store.mjs';
import {DeviceSecurity} from '../src/device-security.mjs';
import {ProjectAccess,permits,validateScope} from '../src/project-access.mjs';
import {startServer} from '../src/server.mjs';
import {identity,headers,wsProof,approve} from './identity-helper.mjs';

const tick=()=>new Promise(r=>setTimeout(r,35));
async function waitForAuth(events){const deadline=Date.now()+5000;while(!events.some(e=>e.type==='authenticated')&&Date.now()<deadline)await tick();assert.ok(events.some(e=>e.type==='authenticated'));}
const closers=new Map();
function scratch(t){const root=mkdtempSync(path.join(os.tmpdir(),'codex-projects-'));t.after(async()=>{await closers.get(root)?.();closers.delete(root);if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('codex-projects-'))throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});return root;}
class Rpc extends EventEmitter{
 constructor(){super();this.threads=new Map();this.calls=[];this.starts=[];this.responses=[];}
 async start(){} async close(){}
 async request(method,p){this.calls.push({method,p});
  if(method==='thread/list')return{data:[...this.threads.values()],nextCursor:null};
  if(method==='thread/read'){await this.beforeRead?.(p);const thread=this.threads.get(p.threadId);if(!thread)throw Error('not found');return{thread};}
  if(method==='thread/start'){const thread={id:'new-'+this.threads.size,cwd:p.cwd,name:'new'};this.threads.set(thread.id,thread);return{thread};}
  if(method==='thread/resume'||method==='thread/name/set')return{};
  if(method==='thread/turns/list')return{data:[],nextCursor:null};
  if(method==='turn/start'){this.starts.push(p);return{turn:{id:'turn-'+this.starts.length}};}
  if(method==='turn/interrupt')return{};
  throw Error('Unexpected '+method);
 }
 respond(id,value){this.responses.push({id,value});}reject(){}
}
async function setup(t){
 const root=scratch(t),a=path.join(root,'A'),b=path.join(root,'B'),c=path.join(root,'A-sibling'),child=path.join(a,'child');for(const dir of [a,b,c,child])mkdirSync(dir,{recursive:true});
 const dataDir=path.join(root,'state'),accounts=new Accounts(dataDir);await accounts.set('owner','project-scope-test-password');const rpc=new Rpc();
 for(const [id,cwd] of Object.entries({a,b,c,child}))rpc.threads.set(id,{id,cwd,name:id});
 let service=await startServer({port:0,dataDir,roots:[a],rpc});closers.set(root,()=>service.close());let admin=JSON.parse(readFileSync(path.join(dataDir,'runtime.json'),'utf8')).adminToken;
 async function phone(){const key=identity(),fingerprint=approve(service,key,accounts.current().generation);let token,deviceId;
  const call=async(route,{method='GET',body,raw}={})=>{const wire=raw??(body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body)));const r=await fetch(service.address+route,{method,headers:{...headers(key,service.address,method,route,wire,route==='/api/login'?'':token||''),...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:method==='GET'?undefined:wire});return{status:r.status,data:r.headers.get('content-type')?.includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer())};};
  async function login(){const r=await call('/api/login',{method:'POST',body:{username:'owner',password:'project-scope-test-password',publicKey:key.publicKey,deviceName:'same name'}});token=r.data.token;deviceId=r.data.device.id;return r;}
  await login();return{key,fingerprint,call,login,get token(){return token;},get deviceId(){return deviceId;}};
 }
 const set=(phone,policy)=>fetch(service.address+'/admin/project-access',{method:'POST',headers:{'content-type':'application/json','x-bridge-admin':admin},body:JSON.stringify({...policy,fingerprint:phone.fingerprint,generation:accounts.current().generation})});
 return{root,a,b,c,child,dataDir,accounts,rpc,get service(){return service;},phone,set,get admin(){return admin;},async restart(roots=[a]){await service.close();service=await startServer({port:0,dataDir,roots,rpc});admin=JSON.parse(readFileSync(path.join(dataDir,'runtime.json'),'utf8')).adminToken;}};
}
const dirs=(...roots)=>({mode:'directories',roots});

test('legacy device ranges are snapshotted, survive default changes and fail closed on corrupt policy',t=>{
 const root=scratch(t),a=path.join(root,'A'),b=path.join(root,'B');mkdirSync(a);mkdirSync(b);const store=new Store(path.join(root,'state'));closers.set(root,()=>store.close());
 const security=new DeviceSecurity(store),key=identity(),record=security.enroll(key.publicKey,'legacy','generation');security.approve(record.fingerprint,security.code(record.fingerprint),'generation');
 new ProjectAccess(store,[a]);const access=new ProjectAccess(store,[b]),device={device_key:record.fingerprint,auth_generation:'generation'};
 assert.deepEqual(access.get(device).roots,[a]);assert.equal(permits(access.get(device),b),false);
 store.db.prepare('UPDATE device_project_access SET policy=?').run('{broken');assert.throws(()=>access.get(device));
});

test('two phones get independent directory lists, child access and all-directory mode across relogin',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();assert.deepEqual((await p.call('/api/status')).data.projectAccess.roots,[s.a]);
 assert.equal((await s.set(q,dirs(s.b))).status,200);
 assert.deepEqual((await p.call('/api/threads')).data.threads.map(x=>x.id),['a','child']);
 assert.deepEqual((await q.call('/api/threads')).data.threads.map(x=>x.id),['b']);
 const scope=(await q.call('/api/status')).data.projectAccess;await q.login();assert.deepEqual((await q.call('/api/status')).data.projectAccess,scope);
 assert.equal((await s.set(p,dirs(s.a,s.b))).status,200);assert.deepEqual((await p.call('/api/threads')).data.threads.map(x=>x.id),['a','b','child']);
 assert.equal((await s.set(q,{mode:'all',roots:[]})).status,200);assert.equal((await q.call('/api/threads')).data.threads.length,4);
 assert.equal((await q.call('/api/threads',{method:'POST',body:{cwd:s.c}})).status,201);
 assert.equal((await p.call('/api/threads',{method:'POST',body:{cwd:s.c}})).status,403);
 const created=await p.call('/api/threads',{method:'POST',body:{cwd:s.b}});assert.equal(created.status,201);
 assert.equal((await q.call('/api/threads',{method:'POST',body:{cwd:path.join(s.root,'missing')}})).status,403);
});

test('directory prefix, traversal and junction escapes do not widen phone access',async t=>{
 const s=await setup(t),p=await s.phone();
 assert.equal((await p.call('/api/threads/c')).status,403);
 assert.equal((await p.call('/api/threads',{method:'POST',body:{cwd:path.join(s.a,'..','B')}})).status,403);
 const link=path.join(s.a,'outside');symlinkSync(s.b,link,process.platform==='win32'?'junction':'dir');
 assert.equal(permits(dirs(s.a),link),false);
 assert.throws(()=>validateScope(dirs('relative')));assert.throws(()=>validateScope(dirs()));
 assert.throws(()=>validateScope({mode:'all',roots:[s.a]}));
});

test('scope checks cover loaded chats, histories, jobs, cancellation and approval responses',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();await s.set(q,dirs(s.b));
 const task=(await p.call('/api/threads/a/messages',{method:'POST',body:{messageId:'scope-message-001',text:'test'}})).data.job;await tick();
 s.rpc.emit('request',{id:44,method:'item/commandExecution/requestApproval',params:{threadId:'a',turnId:s.service.store.job(task.id).turn_id,command:'private command'}});
 const req=(await p.call('/api/status')).data.requests[0];assert.equal((await q.call('/api/status')).data.requests.length,0);
 for(const route of ['/api/threads/a','/api/threads/a/history','/api/threads/a/jobs','/api/jobs/'+task.id])assert.equal((await q.call(route)).status,403,route);
 for(const route of ['/api/threads/a/acquire','/api/threads/a/release','/api/jobs/'+task.id+'/cancel','/api/requests/'+req.id+'/respond'])assert.equal((await q.call(route,{method:'POST',body:{decision:'accept'}})).status,403,route);
 assert.equal((await q.call('/api/threads/a/messages',{method:'POST',body:{messageId:'forbidden-message',text:'test'}})).status,403);assert.equal(s.rpc.starts.length,1);assert.equal(s.rpc.responses.length,0);
});

test('real-time and replay events follow current phone ranges and exclude unattributed events',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();await s.set(q,dirs(s.b));await p.call('/api/threads/a');await q.call('/api/threads/b');
 async function connect(phone,after=0){const ws=new WebSocket(s.service.address.replace('http:','ws:')+'/events');t.after(()=>ws.terminate());const events=[];ws.on('message',b=>events.push(JSON.parse(b)));await once(ws,'open');ws.send(JSON.stringify(wsProof(phone.key,s.service.address,phone.token,after)));await tick();return{ws,events};}
 const one=await connect(p),two=await connect(q);const a=s.service.bridge.event('thread.event',{threadId:'a',private:'A'}),b=s.service.bridge.event('thread.event',{threadId:'b',private:'B'});s.service.bridge.event('unknown',{private:'unattributed'});await tick();
 assert.ok(one.events.some(e=>e.seq===a.seq));assert.ok(!one.events.some(e=>e.seq===b.seq));assert.ok(two.events.some(e=>e.seq===b.seq));assert.ok(!two.events.some(e=>e.seq===a.seq));assert.ok(!one.events.some(e=>e.type==='unknown'));assert.ok(!one.events.some(e=>'workspace' in e));
 const closed=once(one.ws,'close');assert.equal((await s.set(p,dirs(s.b))).status,200);assert.equal((await closed)[0],4009);assert.ok(one.events.some(e=>e.type==='access.changed'));
 const replay=await connect(p);assert.ok(!replay.events.some(e=>e.seq===a.seq));assert.ok(replay.events.some(e=>e.seq===b.seq));
});

test('attachment IDs cannot cross project ranges or expose another phone unsubmitted uploads',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();await s.set(q,dirs(s.b));
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxkAAAAASUVORK5CYII=','base64');
 const upload=(await p.call('/api/uploads',{method:'POST',raw:image})).data;
 assert.equal((await q.call('/api/uploads/'+upload.id)).status,403);
 assert.equal((await q.call('/api/threads/b/messages',{method:'POST',body:{messageId:'stolen-image-001',attachmentIds:[upload.id]}})).status,403);
 await p.call('/api/threads/a/messages',{method:'POST',body:{messageId:'own-image-001',attachmentIds:[upload.id]}});await tick();
 assert.equal((await q.call('/api/uploads/'+upload.id)).status,403);
 await s.set(q,dirs(s.a,s.b));assert.equal((await q.call('/api/uploads/'+upload.id)).status,200);
 const fileId='33333333-1111-2222-3333-444444444444',route='/api/files?id='+fileId+'&name=example.txt&mime=text%2Fplain';await p.call(route,{method:'POST',raw:Buffer.from('example')});
 assert.equal((await q.call(route,{method:'POST',raw:Buffer.from('example')})).status,403);
});

test('only local management can change policy; phone device management is self-only',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();assert.equal((await p.call('/admin/project-access',{method:'POST',body:{fingerprint:p.fingerprint,mode:'all',roots:[]}})).status,403);
 assert.equal((await p.call('/api/devices/'+q.deviceId,{method:'DELETE'})).status,403);
 assert.deepEqual((await p.call('/api/devices')).data.devices.map(x=>x.id),[p.deviceId]);
 assert.equal((await s.set(p,dirs())).status,400);assert.deepEqual((await p.call('/api/status')).data.projectAccess.roots,[s.a]);
});

test('narrowing refuses active out-of-range tasks and cancels out-of-range queued tasks',async t=>{
 const s=await setup(t),p=await s.phone();await s.set(p,{mode:'all',roots:[]});const task=(await p.call('/api/threads/b/messages',{method:'POST',body:{messageId:'active-scope-001',text:'active'}})).data.job;await tick();
 assert.equal((await s.set(p,dirs(s.a))).status,409);assert.equal((await p.call('/api/status')).data.projectAccess.mode,'all');
 s.rpc.emit('notification',{method:'turn/completed',params:{threadId:'b',turn:{id:s.service.store.job(task.id).turn_id,status:'completed'}}});await tick();
 s.service.store.insertJob({id:'queued-test',threadId:'b',messageId:'queued-scope-001',hash:'hash',payload:{text:'queued',attachmentIds:[]},deviceKey:p.fingerprint,authGeneration:s.accounts.current().generation});
 assert.equal((await s.set(p,dirs(s.a))).status,200);assert.equal(s.service.store.job('queued-test').state,'failed');
 assert.equal((await p.call('/api/threads/b/messages',{method:'POST',body:{messageId:'loaded-bypass-001',text:'forbidden'}})).status,403);
});

test('permissions are rechecked after an in-flight acquire before submission',async t=>{
 const s=await setup(t),p=await s.phone();let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 s.rpc.beforeRead=async()=>{entered();await gate;};
 const pending=p.call('/api/threads/a/messages',{method:'POST',body:{messageId:'race-message-001',text:'race'}});await ready;
 assert.equal((await s.set(p,dirs(s.b))).status,200);release();assert.equal((await pending).status,403);assert.equal(s.rpc.starts.length,0);
});

test('policies, login identities, attachment links and scoped replay persist after restart with a new default',async t=>{
 const s=await setup(t),p=await s.phone(),q=await s.phone();await s.set(q,dirs(s.b));await p.call('/api/threads/a');await q.call('/api/threads/b');
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxkAAAAASUVORK5CYII=','base64');
 const uploaded=(await p.call('/api/uploads',{method:'POST',raw:image})).data;
 const job=(await p.call('/api/threads/a/messages',{method:'POST',body:{messageId:'persist-image-001',attachmentIds:[uploaded.id]}})).data.job;await tick();
 s.rpc.emit('notification',{method:'turn/completed',params:{threadId:'a',turn:{id:s.service.store.job(job.id).turn_id,status:'completed'}}});
 const a=s.service.bridge.event('thread.event',{threadId:'a',private:'A'}),b=s.service.bridge.event('thread.event',{threadId:'b',private:'B'});
 await s.restart([s.b]);assert.deepEqual((await p.call('/api/status')).data.projectAccess.roots,[s.a]);assert.deepEqual((await q.call('/api/status')).data.projectAccess.roots,[s.b]);
 assert.equal((await p.call('/api/uploads/'+uploaded.id)).status,200);assert.equal((await q.call('/api/uploads/'+uploaded.id)).status,403);
 const ws=new WebSocket(s.service.address.replace('http:','ws:')+'/events');t.after(()=>ws.terminate());const events=[];ws.on('message',wire=>events.push(JSON.parse(wire)));await once(ws,'open');ws.send(JSON.stringify(wsProof(p.key,s.service.address,p.token)));await waitForAuth(events);
 assert.ok(events.some(e=>e.seq===a.seq));assert.ok(!events.some(e=>e.seq===b.seq));
});

test('queued execution checks its originating device policy and legacy unattributed queues are not executed',async t=>{
 const s=await setup(t),p=await s.phone();await s.set(p,{mode:'all',roots:[]});
 s.service.store.insertJob({id:'attributed',threadId:'b',messageId:'queue-policy-001',hash:'hash',payload:{text:'test',attachmentIds:[]},deviceKey:p.fingerprint,authGeneration:s.accounts.current().generation});
 s.service.projectAccess.set(p.fingerprint,s.accounts.current().generation,dirs(s.a));await s.service.bridge.pump('b');
 assert.equal(s.service.store.job('attributed').state,'failed');assert.equal(s.rpc.starts.length,0);
 s.service.store.insertJob({id:'legacy',threadId:'a',messageId:'legacy-queue-001',hash:'hash',payload:{text:'legacy',attachmentIds:[]}});
 await s.restart();assert.equal(s.service.store.job('legacy').state,'needsReview');assert.equal(s.rpc.starts.length,0);
});
