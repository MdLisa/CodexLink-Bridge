import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/store.mjs';
import {Accounts} from '../src/accounts.mjs';
import {GeneratedFiles,exportCandidates,GENERATED_LIMIT} from '../src/generated-files.mjs';
import {startServer} from '../src/server.mjs';
import {identity,headers,approve} from './identity-helper.mjs';

const closers=new Map();
function scratch(t){const root=mkdtempSync(path.join(os.tmpdir(),'codex-deliveries-'));t.after(async()=>{await closers.get(root)?.();closers.delete(root);if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('codex-deliveries-'))throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});return root;}
function files(t){const root=scratch(t),cwd=path.join(root,'project');mkdirSync(path.join(cwd,'codex-exports'),{recursive:true});const store=new Store(path.join(root,'state'));closers.set(root,()=>store.close());return{root,cwd,store,files:new GeneratedFiles(store,path.join(root,'state')),file:path.join(cwd,'codex-exports','方案.docx')};}
test('only explicit assistant export-folder links with supported extensions are candidates',t=>{
 const {cwd,file}=files(t);const text='[方案](codex-exports/%E6%96%B9%E6%A1%88.docx) [副本](<codex-exports/有 空格.pdf>) [相同](codex-exports/方案.docx) [密钥](codex-exports/private.key) [外部](../secret.txt) [越界](codex-exports/../secret.txt) [同名前缀](codex-exports-other/a.pdf) [网络](https://example.com/codex-exports/a.pdf) [注释](codex-exports/a.pdf%00.txt)';
 assert.deepEqual(exportCandidates(text,cwd),[file,path.join(cwd,'codex-exports','有 空格.pdf')]);
});
test('snapshots are immutable, bound to turn/item/thread and persist independently of originals',t=>{
 const s=files(t);writeFileSync(s.file,'original');const first=s.files.register('thread','turn:item',s.cwd,s.file);writeFileSync(s.file,'edited');
 assert.equal(s.files.register('thread','turn:item',s.cwd,s.file).id,first.id);assert.equal(s.files.body(s.files.record(first.id)).toString(),'original');
 const second=s.files.register('thread','next:item',s.cwd,s.file);assert.notEqual(second.id,first.id);assert.equal(s.files.body(s.files.record(second.id)).toString(),'edited');
 assert.equal(new GeneratedFiles(s.store,path.join(s.root,'state')).body(s.files.record(first.id)).toString(),'original');
 writeFileSync(path.join(s.files.root,first.id),'tampered');assert.throws(()=>s.files.body(s.files.record(first.id)),{code:'GENERATED_NOT_FOUND'});
 assert.throws(()=>s.files.record('../secret'),{code:'GENERATED_NOT_FOUND'});
});
test('exact 20 MiB is accepted; larger and missing files produce unavailable cards without copies',t=>{
 const s=files(t);writeFileSync(s.file,Buffer.alloc(GENERATED_LIMIT));const boundary=s.files.register('thread','boundary',s.cwd,s.file);assert.equal(boundary.size,GENERATED_LIMIT);assert.equal(boundary.available,true);
 writeFileSync(s.file,Buffer.alloc(GENERATED_LIMIT+1));assert.match(s.files.register('thread','oversized',s.cwd,s.file).error,/20 MB/);
 assert.equal(s.files.register('thread','missing',s.cwd,path.join(s.cwd,'codex-exports','missing.pdf')).available,false);
 assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM generated_files').get().n,1);
});
test('junctions, hard links, sibling paths and unfinished turns cannot export private files',t=>{
 const s=files(t),outside=path.join(s.root,'private');mkdirSync(outside);writeFileSync(path.join(outside,'secret.txt'),'SECRET');symlinkSync(outside,path.join(s.cwd,'codex-exports','linked'),'junction');
 for(const candidate of [path.join(s.cwd,'codex-exports','linked','secret.txt'),path.join(outside,'secret.txt')])assert.equal(s.files.register('t','i',s.cwd,candidate).available,false);
 linkSync(path.join(outside,'secret.txt'),path.join(s.cwd,'codex-exports','hard.txt'));assert.equal(s.files.register('t','hard',s.cwd,path.join(s.cwd,'codex-exports','hard.txt')).available,false);
 writeFileSync(s.file,'document');const history={turns:[{id:'turn',storedStatus:'inProgress',items:[{id:'item',type:'agentMessage',text:'[方案](codex-exports/方案.docx)'}]}]};s.files.decorate(history,'t',s.cwd);assert.equal(history.turns[0].items[0].generatedFiles,undefined);
});
test('download concurrency is bounded and release is idempotent',t=>{
 const {files:f}=files(t),one=f.acquire('a'),two=f.acquire('a');assert.throws(()=>f.acquire('a'),{status:429});one();one();const three=f.acquire('a');two();three();assert.equal(f.active.size,0);
 const releases=Array.from({length:8},(_,i)=>f.acquire(String(i)));assert.throws(()=>f.acquire('another'),{status:429});releases.forEach(release=>release());assert.equal(f.active.size,0);
});
class Rpc extends EventEmitter {
 constructor(cwd){super();this.cwd=cwd;this.status='completed';this.text='[方案](codex-exports/方案.docx)';}
 async start(){}async close(){}
 async request(method,p){if(method==='thread/read'){await this.beforeRead?.();return{thread:{id:p.threadId,cwd:this.cwd}};}if(method==='thread/turns/list')return{data:[{id:'turn',status:this.status,items:[{id:'item',type:'agentMessage',text:this.text}]}]};if(method==='thread/list')return{data:[]};throw Error(method);}
}
async function server(t){
 const root=scratch(t),cwd=path.join(root,'project'),dataDir=path.join(root,'state');mkdirSync(path.join(cwd,'codex-exports'),{recursive:true});writeFileSync(path.join(cwd,'codex-exports','方案.docx'),'PRIVATE DOCUMENT');const accounts=new Accounts(dataDir);await accounts.set('owner','test-delivery-password');const rpc=new Rpc(cwd);let service=await startServer({port:0,dataDir,roots:[cwd],rpc});closers.set(root,()=>service.close());
 const admin=async(route,body)=>{const runtime=JSON.parse(readFileSync(path.join(dataDir,'runtime.json'),'utf8'));return fetch(service.address+route,{method:'POST',headers:{'content-type':'application/json','x-bridge-admin':runtime.adminToken},body:JSON.stringify(body)});};
 async function phone(){const key=identity(),fingerprint=approve(service,key,accounts.current().generation);let token='';const call=async(route,body)=>{const method=body?'POST':'GET',wire=body?Buffer.from(JSON.stringify(body)):Buffer.alloc(0);return fetch(service.address+route,{method,headers:{...headers(key,service.address,method,route,wire,route==='/api/login'?'':token),...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},body:body?wire:undefined});};token=(await(await call('/api/login',{username:'owner',password:'test-delivery-password',publicKey:key.publicKey,deviceName:'phone'})).json()).token;return{fingerprint,call,data:{fingerprint,generation:accounts.current().generation}};}
 return{cwd,rpc,accounts,phone,admin,get service(){return service;},async restart(){await service.close();service=await startServer({port:0,dataDir,roots:[cwd],rpc});}};
}
test('signed downloads require independent authorization and current project scope; anonymous URLs never serve files',async t=>{
 const s=await server(t),p=await s.phone(),q=await s.phone();assert.equal((await p.call('/api/status')).status,200);
 let history=await(await p.call('/api/threads/thread/history')).json();assert.equal(history.turns[0].items[0].generatedFiles,undefined);
 assert.equal((await s.admin('/admin/generated-files',{...p.data,enabled:true})).status,200);
 history=await(await p.call('/api/threads/thread/history')).json();const file=history.turns[0].items[0].generatedFiles[0],url='/api/generated-files/'+file.id;assert.equal(file.available,true);
 assert.equal((await fetch(s.service.address+url)).status,401);assert.equal((await q.call(url)).status,403);
 const downloaded=await p.call(url);assert.equal(downloaded.status,200);assert.equal(await downloaded.text(),'PRIVATE DOCUMENT');assert.match(downloaded.headers.get('cache-control'),/no-store/);assert.match(downloaded.headers.get('content-disposition'),/attachment/);
 assert.equal((await s.admin('/admin/generated-files',{...q.data,enabled:true})).status,200);
 const sibling=path.join(path.dirname(s.cwd),'other');mkdirSync(sibling);await s.admin('/admin/project-access',{...q.data,mode:'directories',roots:[sibling]});assert.equal((await q.call(url)).status,403);
 await s.restart();assert.equal((await p.call(url)).status,200);
 await s.admin('/admin/generated-files',{...p.data,enabled:false});assert.equal((await p.call(url)).status,403);
});
test('chat-only mode always denies downloads, and revocation clears grants even after reapproval',async t=>{
 const s=await server(t),p=await s.phone();await s.admin('/admin/generated-files',{...p.data,enabled:true});const history=await(await p.call('/api/threads/thread/history')).json(),id=history.turns[0].items[0].generatedFiles[0].id;
 await s.admin('/admin/device-approvals',{...p.data,approvalsReviewer:'chat_only'});assert.equal((await p.call('/api/generated-files/'+id)).status,403);assert.equal((await(await p.call('/api/status')).json()).generatedFiles.enabled,false);
 await s.admin('/admin/device-approvals',{...p.data,approvalsReviewer:'user'});assert.equal((await p.call('/api/generated-files/'+id)).status,200);
 s.service.security.revoke(p.fingerprint);assert.equal((await p.call('/api/generated-files/'+id)).status,401);assert.equal(s.service.store.db.prepare('SELECT * FROM device_generated_files WHERE fingerprint=?').get(p.fingerprint),undefined);
});
test('revoking a grant during thread lookup blocks the in-flight download and hides delivery metadata',async t=>{
 const s=await server(t),p=await s.phone();await s.admin('/admin/generated-files',{...p.data,enabled:true});const history=await(await p.call('/api/threads/thread/history')).json(),id=history.turns[0].items[0].generatedFiles[0].id;
 s.rpc.beforeRead=async()=>{s.rpc.beforeRead=null;await s.admin('/admin/generated-files',{...p.data,enabled:false});};
 assert.equal((await p.call('/api/generated-files/'+id)).status,403);
 await s.admin('/admin/generated-files',{...p.data,enabled:true});let reads=0;s.rpc.beforeRead=async()=>{if(++reads===2){s.rpc.beforeRead=null;await s.admin('/admin/generated-files',{...p.data,enabled:false});}};
 const after=await(await p.call('/api/threads/thread/history')).json();assert.equal(after.turns[0].items[0].generatedFiles,undefined);
});
