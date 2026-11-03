import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {EventEmitter,once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {request,createServer} from 'node:http';
import {WebSocket} from 'ws';
import {Store} from '../src/store.mjs';
import {Accounts} from '../src/accounts.mjs';
import {DeviceSecurity} from '../src/device-security.mjs';
import {startServer} from '../src/server.mjs';
import {Management,saveJson,redact} from '../scripts/management.mjs';
import {startManager} from '../scripts/gui-server.mjs';
import {identity,headers,wsProof} from './identity-helper.mjs';

async function fixture(t){
 const root=mkdtempSync(path.join(os.tmpdir(),'codex-management-')),dir=path.join(root,'data'),workspace=path.join(root,'workspace');mkdirSync(workspace);
 const closers=[];t.after(async()=>{for(const close of closers.reverse())await close();if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('codex-management-'))throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});
 const accounts=new Accounts(dir),account=await accounts.set('owner','management-test-password');saveJson(dir,'console-settings.json',{workspace,port:18766});
 const store=new Store(dir),security=new DeviceSecurity(store),key=identity(),d=security.enroll(key.publicKey,'original phone',account.generation);store.close();
 const calls=[],management=new Management({dir,run:async(file,args)=>calls.push({file,args}),startup:()=>({enabled:false})});
 return{root,dir,workspace,accounts,account,key,d,calls,management,closers};
}
test('local notes survive reload without changing phone names or exposing credentials',async t=>{
 const s=await fixture(t),data={fingerprint:s.d.fingerprint,generation:s.account.generation};
 await s.management.action('device.note',{...data,note:'  妹妹的手机  '});const state=await s.management.state();
 assert.equal(state.devices[0].note,'妹妹的手机');assert.equal(state.devices[0].name,'original phone');
 const serialized=JSON.stringify(state);for(const secret of ['public_key','token_hash','salt','adminToken','management-test-password'])assert.ok(!serialized.includes(secret));
 await assert.rejects(()=>s.management.action('device.note',{...data,note:'bad\nnote'}));
 const reopened=new Management({dir:s.dir,startup:()=>({enabled:false})});assert.equal(reopened.devices()[0].note,'妹妹的手机');
});
test('forget removes sessions and policy, cancels queued jobs, retains history and requires fresh approval',async t=>{
 const s=await fixture(t),data={fingerprint:s.d.fingerprint,generation:s.account.generation};
 await s.management.action('device.approve',{...data,code:s.management.devices()[0].code});
 await s.management.action('device.note',{...data,note:'备用机'});await s.management.action('device.reviewer',{...data,reviewer:'chat_only'});
 await s.management.action('device.takeover',{...data,enabled:true});await s.management.action('device.viewer',{...data,enabled:true});
 const store=new Store(s.dir),security=new DeviceSecurity(store);store.addDevice('old-login','phone','old-token-hash',s.account.generation,s.d.fingerprint);
 store.db.exec('CREATE TABLE chat_only_threads(id TEXT PRIMARY KEY,device_key TEXT,generation TEXT,name TEXT,created_at INTEGER,updated_at INTEGER)');store.db.prepare('INSERT INTO chat_only_threads VALUES(?,?,?,?,?,?)').run('history',s.d.fingerprint,s.account.generation,'preserved',1,1);
 const job=store.insertJob({id:randomUUID(),threadId:'history',messageId:'queued-message',hash:'hash',payload:{text:'wait'},deviceKey:s.d.fingerprint,authGeneration:s.account.generation});
 store.ownAttachment('kept-image',{device_key:s.d.fingerprint,auth_generation:s.account.generation},'chat_only');
 store.db.prepare('INSERT INTO device_nonces VALUES(?,?)').run(s.d.fingerprint+':replay-proof',Date.now()+100000);
 await s.management.action('device.delete',data);assert.equal(s.management.devices().length,0);assert.equal(store.auth('old-token-hash'),undefined);assert.equal(store.job(job.id).state,'cancelled');
 assert.ok(store.db.prepare('SELECT 1 FROM chat_only_threads').get());assert.ok(store.attachmentOwner('kept-image'));assert.ok(store.db.prepare('SELECT 1 FROM device_nonces').get());
 for(const table of ['device_notes','device_project_access','device_approvals','device_takeover','device_chat_viewer'])assert.equal(store.db.prepare('SELECT count(*) AS n FROM '+table).get().n,0);
 const enrolled=security.enroll(s.key.publicKey,'same phone again',s.account.generation);assert.equal(enrolled.status,'pending');store.close();
 const pending=s.management.devices()[0];assert.equal(pending.note,'');assert.equal(pending.reviewer,'user');assert.equal(pending.takeover,false);assert.equal(pending.viewer,false);
 await s.management.action('device.approve',{...data,code:pending.code});assert.equal(s.management.devices()[0].status,'approved');
});
test('active tasks and uncertain backend identity prevent offline deletion',async t=>{
 const s=await fixture(t),data={fingerprint:s.d.fingerprint,generation:s.account.generation};const store=new Store(s.dir);
 const job=store.insertJob({id:randomUUID(),threadId:'thread',messageId:'active-message',hash:'hash',payload:{},deviceKey:s.d.fingerprint,authGeneration:s.account.generation});store.updateJob(job.id,'running');
 await assert.rejects(()=>s.management.action('device.delete',data),/任务/);assert.equal(s.management.devices().length,1);store.updateJob(job.id,'completed');store.close();
 saveJson(s.dir,'bridge.lock',{pid:1});await assert.rejects(()=>s.management.action('device.delete',data),/后台状态/);assert.equal(s.management.devices().length,1);
});
test('settings validate directories and reviewers before saving and redact diagnostic secrets',async t=>{
 const s=await fixture(t);await assert.rejects(()=>s.management.action('settings',{workspace:'relative',port:18766,attachments:s.workspace,defaultReviewer:'user'}));
 assert.equal(s.management.options().workspace,s.workspace);
 await s.management.action('settings',{workspace:s.workspace,port:19000,attachments:s.workspace,defaultReviewer:'auto_review'});assert.equal(s.management.options().port,19000);
 const secret='super-secret-value';writeFileSync(path.join(s.dir,'后台日志.txt'),`Authorization: Bearer ${secret}\n{"access_token":"${secret}","password":"${secret}"}\ncloudflared --token ${secret}`);
 assert.ok(!JSON.stringify(s.management.logs()).includes(secret));assert.ok(!redact('adminToken='+secret).includes(secret));assert.equal(s.calls.length,0);
 assert.ok(!redact('{"password":"a long private phrase"}').includes('private phrase'));assert.ok(!redact('password=a long private phrase').includes('private phrase'));
});
test('GUI and CLI lifecycle preserves service order, automatic-start cancellation and operation locking',async t=>{
 const s=await fixture(t);await s.management.action('start');assert.deepEqual(s.calls.map(c=>[c.file,c.args[0]]),[['manage.mjs','start'],['external.mjs','start']]);
 await s.management.action('stop');assert.deepEqual(s.calls.slice(2).map(c=>[c.file,c.args[0]]),[['external.mjs','stop'],['manage.mjs','stop']]);assert.equal(s.management.options().workspace,s.workspace);
 await assert.rejects(()=>s.management.start({autoStartedAt:Date.now()-1000}),/已取消/);
 let release;const gate=new Promise(resolve=>release=resolve);const blocking=new Management({dir:s.dir,startup:()=>({enabled:false}),run:()=>gate});const first=blocking.action('start');await assert.rejects(()=>blocking.action('stop'),/上一项操作/);release();await first;
});
test('GUI manager requires an independent secret, rejects browser origins and exposes no wildcard bind',async t=>{
 const fake={state:async()=>({version:'test'}),logs:()=>[],action:async()=>({message:'done'})};const server=await startManager({management:fake});t.after(()=>server.close());
 assert.equal(new URL(server.address).hostname,'127.0.0.1');
 assert.equal((await fetch(server.address+'/state')).status,403);
 const auth={'x-codexlink-control':server.token};assert.equal((await fetch(server.address+'/state',{headers:{...auth,origin:server.address}})).status,403);
 const wrongHost=await new Promise((resolve,reject)=>{const req=request(server.address+'/state',{headers:{...auth,host:'attacker.test'}},r=>{r.resume();resolve(r.statusCode)});req.on('error',reject);req.end();});assert.equal(wrongHost,403);
 assert.deepEqual(await(await fetch(server.address+'/state',{headers:auth})).json(),{version:'test'});
 assert.equal((await fetch(server.address+'/action',{method:'POST',headers:{...auth,'content-type':'application/json'},body:'broken'})).status,400);
 assert.equal((await fetch(server.address+'/action',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({action:'test',data:{}})})).status,200);
});
test('old backend features fail clearly without bypassing the live backend',async t=>{
 const s=await fixture(t),instanceId=randomUUID();const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'codex-phone-bridge',version:'0.9.1',instanceId,ready:true}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));s.closers.push(()=>new Promise(resolve=>server.close(resolve)));
 saveJson(s.dir,'runtime.json',{address:'http://127.0.0.1:'+server.address().port,instanceId,adminToken:'local-test-admin',roots:[s.workspace]});
 await assert.rejects(()=>s.management.action('device.note',{fingerprint:s.d.fingerprint,generation:s.account.generation,note:'must not save'}),/旧版后台/);assert.equal(s.management.devices()[0].note,'');
});
class Rpc extends EventEmitter{async start(){}async close(){this.emit('disconnected');}async request(method,p){if(method==='thread/read'){await this.gate?.();return{thread:{id:p.threadId,cwd:this.cwd}};}return{data:[]};}}
test('saving a chat-only phone default isolates new phones and preserves existing modes across restart',async t=>{
 const s=await fixture(t),data={fingerprint:s.d.fingerprint,generation:s.account.generation};await s.management.action('device.approve',{...data,code:s.management.devices()[0].code});
 await s.management.action('settings',{workspace:s.workspace,port:18766,attachments:s.workspace,defaultReviewer:'chat_only'});
 assert.equal((await s.management.state()).settings.defaultReviewer,'chat_only');assert.equal(s.management.devices()[0].reviewer,'user');
 let service=await startServer({port:0,dataDir:s.dir,roots:[s.workspace],rpc:new Rpc()});s.closers.push(()=>service.close());
 const key=identity(),phone=service.security.enroll(key.publicKey,'new chat phone',s.account.generation);
 await s.management.action('device.approve',{fingerprint:phone.fingerprint,generation:s.account.generation,code:service.security.code(phone.fingerprint)});
 async function status(signer){const body=Buffer.from(JSON.stringify({username:'owner',password:'management-test-password',deviceName:'phone',publicKey:signer.publicKey}));const login=await fetch(service.address+'/api/login',{method:'POST',headers:{...headers(signer,service.address,'POST','/api/login',body,''),'content-type':'application/json'},body});assert.equal(login.status,201);const {token}=await login.json();return(await fetch(service.address+'/api/status',{headers:{...headers(signer,service.address,'GET','/api/status',Buffer.alloc(0),token),authorization:'Bearer '+token}})).json();}
 const check=async()=>{const next=await status(key),existing=await status(s.key);assert.equal(next.executionSettings.approvalsReviewer,'chat_only');assert.deepEqual(next.workspaces,[]);assert.equal(next.capabilities.files,false);assert.equal(existing.executionSettings.approvalsReviewer,'user');assert.equal(service.bridge.reviewSettings().approvalsReviewer,'user');};
 await check();await service.close();service=await startServer({port:0,dataDir:s.dir,roots:[s.workspace],rpc:new Rpc()});await check();
});
test('online management invalidates old HTTP and socket sessions; re-enrollment needs approval',async t=>{
 const s=await fixture(t),rpc=new Rpc();rpc.cwd=s.workspace;const service=await startServer({port:0,dataDir:s.dir,roots:[s.workspace],rpc});s.closers.push(()=>service.close());
 const admin=JSON.parse(readFileSync(path.join(s.dir,'runtime.json'),'utf8')).adminToken;
 async function call(route,{method='GET',body,token=''}={}){const bytes=Buffer.from(body===undefined?'':JSON.stringify(body));const r=await fetch(service.address+route,{method,headers:{...headers(s.key,service.address,method,route,bytes,route==='/api/login'?'':token),...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},body:method==='GET'?undefined:bytes});return{status:r.status,data:await r.json()};}
 async function local(body,secret=admin){const r=await fetch(service.address+'/admin/devices',{method:'POST',headers:{'x-bridge-admin':secret,'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,data:await r.json()};}
 const data={fingerprint:s.d.fingerprint,generation:s.account.generation};assert.equal((await local({...data,action:'delete'},'bad-secret')).status,403);
 await s.management.action('device.approve',{...data,code:service.security.code(s.d.fingerprint)});
 const login=()=>call('/api/login',{method:'POST',body:{username:'owner',password:'management-test-password',deviceName:'phone',publicKey:s.key.publicKey}});
 const token=(await login()).data.token;assert.ok(token);const ws=new WebSocket(service.address.replace('http:','ws:')+'/events');ws.on('error',()=>{});await once(ws,'open');const authenticated=once(ws,'message');ws.send(JSON.stringify(wsProof(s.key,service.address,token)));await authenticated;
 await s.management.action('device.note',{...data,note:'local only'});assert.equal(service.security.list()[0].note,'local only');assert.ok(!JSON.stringify((await call('/api/devices',{token})).data).includes('local only'));
 const active=service.store.insertJob({id:randomUUID(),threadId:'thread',messageId:'running-task',hash:'hash',payload:{},deviceKey:s.d.fingerprint,authGeneration:s.account.generation});service.store.updateJob(active.id,'running');try{await assert.rejects(()=>s.management.action('device.delete',data),/任务/);}finally{service.store.updateJob(active.id,'completed');}
 let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);rpc.gate=async()=>{entered();await gate;};const read=call('/api/threads/ongoing',{token});await ready;
 try{await assert.rejects(()=>s.management.action('device.delete',data),/任务/);}finally{release();await read;rpc.gate=null;}
 const closed=once(ws,'close');await s.management.action('device.delete',data);assert.equal((await closed)[0],4003);assert.equal((await call('/api/status',{token})).status,401);assert.equal((await login()).status,202);assert.equal(service.security.list()[0].status,'pending');
 await s.management.action('device.approve',{...data,code:service.security.code(s.d.fingerprint)});assert.equal((await call('/api/status',{token})).status,401);assert.equal((await login()).status,201);
 assert.ok(existsSync(path.join(s.dir,'bridge.sqlite')));
});
