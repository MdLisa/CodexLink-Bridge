import {identity,headers as signedHeaders,wsProof,approve} from './identity-helper.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,unlinkSync,readdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {after} from 'node:test';
import {WebSocket} from 'ws';
import {Accounts} from '../src/accounts.mjs';
import {startServer} from '../src/server.mjs';

const scratch=mkdtempSync(path.join(os.tmpdir(),'codex-bridge-tests-'));
after(()=>{const resolved=path.resolve(scratch),temp=path.resolve(os.tmpdir());if(path.dirname(resolved)!==temp||!path.basename(resolved).startsWith('codex-bridge-tests-'))throw Error('Invalid test cleanup path');rmSync(resolved,{recursive:true,force:true});});
class FakeRpc extends EventEmitter {
  constructor(cwd){super();this.cwd=cwd;this.threads=new Map();this.starts=[];this.responses=[];this.busy=new Set();this.unsubscribed=[];}
  async start(){return{};}
  async request(method,p){
    if(method==='thread/start'){const id='thread-'+(this.threads.size+1);const t={id,cwd:p.cwd,name:'test'};this.threads.set(id,t);return{thread:t};}
    if(method==='thread/name/set'){this.threads.get(p.threadId).name=p.name;return{};}
    if(method==='thread/read'){const t=this.threads.get(p.threadId);if(!t)throw Error('not found');return{thread:t};}
    if(method==='thread/list')return{data:[...this.threads.values()],nextCursor:null};
    if(method==='thread/turns/list')return{data:[],nextCursor:null};
    if(method==='thread/resume'){if(this.busy.has(p.threadId))throw Error('already has an active writer');return{thread:this.threads.get(p.threadId)};}
    if(method==='thread/unsubscribe'){this.unsubscribed.push(p.threadId);return{status:'unsubscribed'};}
    if(method==='turn/start'){const id='turn-'+(this.starts.length+1);this.starts.push({...p,id});this.emit('notification',{method:'turn/started',params:{threadId:p.threadId,turn:{id}}});return{turn:{id}};}
    if(method==='turn/interrupt'){this.finish(p.threadId,p.turnId,'interrupted');return{};}
    throw Error('Unexpected RPC '+method);
  }
  finish(threadId,turnId,status='completed'){this.emit('notification',{method:'turn/completed',params:{threadId,turn:{id:turnId,status}}});}
  respond(id,value){this.responses.push({id,value});}
  reject(id,message){this.responses.push({id,error:message});}
  async close(){this.emit('disconnected');}
  async restart(){this.restarts=(this.restarts||0)+1;}
}
async function setup(t,{dir,rpc,roots}={}){const root=dir||mkdtempSync(path.join(scratch,'case-'));const workspace=path.join(root,'workspace');mkdirSync(workspace,{recursive:true});rpc??=new FakeRpc(workspace);const accounts=new Accounts(path.join(root,'state'));if(!accounts.current())await accounts.set('tester','phone-bridge-test-password');const service=await startServer({port:0,dataDir:path.join(root,'state'),roots:roots||[workspace],rpc});t.after(()=>service.close());
 let token;let activeKey;async function request(route,{method='GET',body,headers={},raw}={}){if(route==='/api/login')body={...body,publicKey:activeKey.publicKey};const wire=raw??(body===undefined?undefined:JSON.stringify(body));const proof=activeKey?signedHeaders(activeKey,service.address,method,route,wire?Buffer.from(wire):Buffer.alloc(0),route==='/api/login'?'':token||''):{};const r=await fetch(service.address+route,{method,headers:{...proof,...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:raw??(body===undefined?undefined:JSON.stringify(body))});const data=await r.json();return{status:r.status,data};}
 const key=identity();activeKey=key;approve(service,key,accounts.current().generation);
 const pair=await request('/api/login',{method:'POST',body:{username:'tester',password:'phone-bridge-test-password',deviceName:'test phone'}});token=pair.data.token;
 const thread=(await request('/api/threads',{method:'POST',body:{name:'test'}})).data;
 return{service,rpc,request,thread,root,workspace,token,key,deviceId:pair.data.device.id};}
const tick=()=>new Promise(r=>setTimeout(r,20));

test('only the local management secret can stop the service, and shutdown removes runtime state',async t=>{
 const s=await setup(t);const runtime=JSON.parse(readFileSync(path.join(s.service.dataDir,'runtime.json'),'utf8'));
 assert.equal((await s.request('/admin/stop',{method:'POST'})).status,403);
 assert.equal((await s.request('/admin/stop',{method:'POST',headers:{'x-bridge-admin':s.token}})).status,403);
 assert.equal((await s.request('/admin/stop',{method:'POST',headers:{'x-bridge-admin':runtime.adminToken}})).status,200);
 await tick();await tick();assert.throws(()=>readFileSync(path.join(s.service.dataDir,'runtime.json')));
});

test('handoff waits for all phone tasks, recycles Codex, and releases every idle loaded chat',async t=>{
 const s=await setup(t);const second=(await s.request('/api/threads',{method:'POST',body:{name:'second'}})).data;
 const submitted=await s.request('/api/threads/'+s.thread.id+'/messages',{method:'POST',body:{messageId:'handoff-001',text:'hello'}});await tick();
 assert.equal((await s.request('/api/threads/'+second.id+'/release',{method:'POST'})).status,409);
 const job=(await s.request('/api/jobs/'+submitted.data.job.id)).data;s.rpc.finish(s.thread.id,job.turnId);await tick();
 assert.equal((await s.request('/api/threads/'+second.id+'/release',{method:'POST'})).status,200);assert.equal(s.rpc.restarts,1);assert.equal(s.service.bridge.loaded.size,0);
 assert.equal((await s.request('/api/threads/'+s.thread.id+'/acquire',{method:'POST'})).status,200);
});

test('unauthenticated requests never reach Codex; logins issue separate tokens stored as hashes',async t=>{
 const s=await setup(t);const r=await fetch(s.service.address+'/api/threads');assert.equal(r.status,401);assert.equal(s.rpc.starts.length,0);
 const p=await s.request('/api/login',{method:'POST',body:{username:'tester',password:'phone-bridge-test-password',deviceName:'second'}});assert.equal(p.status,201);assert.notEqual(p.data.token,s.token);
 const db=readFileSync(path.join(s.root,'state','bridge.sqlite'));assert.equal(db.includes(Buffer.from(s.token)),false);
 const bad=await s.request('/api/threads',{headers:{origin:'https://untrusted.example'}});assert.equal(bad.status,403);
});
test('same message sent concurrently runs once, content conflicts reject, and queued messages wait for completion',async t=>{
 const s=await setup(t);const endpoint='/api/threads/'+s.thread.id+'/messages';const body={messageId:'message-0001',text:'one'};
 const replies=await Promise.all(Array.from({length:5},()=>s.request(endpoint,{method:'POST',body})));await tick();assert.equal(new Set(replies.map(r=>r.data.job.id)).size,1);assert.equal(s.rpc.starts.length,1);
 const conflict=await s.request(endpoint,{method:'POST',body:{...body,text:'changed'}});assert.equal(conflict.status,409);
 await s.request(endpoint,{method:'POST',body:{messageId:'message-0002',text:'two'}});assert.equal(s.rpc.starts.length,1);
 s.rpc.finish(s.thread.id,s.rpc.starts[0].id);await tick();assert.equal(s.rpc.starts.length,2);
 s.rpc.finish(s.thread.id,s.rpc.starts[1].id);await tick();
});
test('desktop-occupied conversation stays readable and is never silently forked or submitted',async t=>{
 const s=await setup(t);s.rpc.threads.set('desktop-thread',{id:'desktop-thread',cwd:s.workspace,name:'Desktop'});s.rpc.busy.add('desktop-thread');
 assert.equal((await s.request('/api/threads/desktop-thread/history')).status,200);
 const r=await s.request('/api/threads/desktop-thread/messages',{method:'POST',body:{messageId:'busy-msg-001',text:'hello'}});assert.equal(r.status,409);assert.equal(r.data.error.code,'THREAD_BUSY');assert.equal(s.rpc.starts.length,0);assert.equal(s.rpc.threads.size,2);
});
test('approval response reaches only its request, invalid/session-wide grants reject, stale requests expire',async t=>{
 const s=await setup(t);await s.request('/api/threads/'+s.thread.id+'/messages',{method:'POST',body:{messageId:'approval-msg-1',text:'test'}});await tick();
 s.rpc.emit('request',{id:900,method:'item/commandExecution/requestApproval',params:{threadId:s.thread.id,turnId:s.rpc.starts[0].id,itemId:'cmd-1',command:'test-command'}});
 const pending=(await s.request('/api/status')).data.requests[0];assert.equal(pending.command,'test-command');
 const invalid=await s.request('/api/requests/'+pending.id+'/respond',{method:'POST',body:{decision:'acceptForSession'}});assert.equal(invalid.status,400);assert.equal(s.rpc.responses.length,0);
 assert.equal((await s.request('/api/requests/'+pending.id+'/respond',{method:'POST',body:{decision:'decline'}})).status,200);assert.deepEqual(s.rpc.responses[0],{id:900,value:{decision:'decline'}});
 assert.equal((await s.request('/api/requests/'+pending.id+'/respond',{method:'POST',body:{decision:'accept'}})).status,409);
 s.rpc.finish(s.thread.id,s.rpc.starts[0].id);
});
test('cancelling a queued task never invokes Codex; active stop uses its exact turn; release refuses pending work',async t=>{
 const s=await setup(t);const route='/api/threads/'+s.thread.id;const a=(await s.request(route+'/messages',{method:'POST',body:{messageId:'cancel-msg-01',text:'running'}})).data.job;await tick();
 const b=(await s.request(route+'/messages',{method:'POST',body:{messageId:'cancel-msg-02',text:'queued'}})).data.job;
 assert.equal((await s.request(route+'/release',{method:'POST'})).status,409);
 assert.equal((await s.request('/api/jobs/'+b.id+'/cancel',{method:'POST'})).data.state,'cancelled');
 assert.equal((await s.request('/api/jobs/'+a.id+'/cancel',{method:'POST'})).data.state,'interrupted');assert.equal(s.rpc.starts.length,1);
 assert.equal((await s.request(route+'/release',{method:'POST'})).status,200);assert.ok(s.rpc.unsubscribed.includes(s.thread.id));
});
test('uploads reject non-image signatures; workspace boundaries reject sibling directories',async t=>{
 const s=await setup(t);assert.equal((await s.request('/api/uploads',{method:'POST',raw:Buffer.from('<html>'),headers:{'content-type':'image/png'}})).status,415);
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');const r=await s.request('/api/uploads',{method:'POST',raw:image,headers:{'content-type':'application/octet-stream'}});assert.equal(r.status,201);assert.equal(r.data.size,image.length);
 const outside=path.join(s.root,'workspace-other');mkdirSync(outside);assert.equal((await s.request('/api/threads',{method:'POST',body:{cwd:outside}})).status,403);
 const imageTask=await s.request('/api/threads/'+s.thread.id+'/messages',{method:'POST',body:{messageId:'image-msg-01',attachmentIds:[r.data.id]}});assert.equal(imageTask.status,202);await tick();assert.equal(s.rpc.starts[0].input[0].type,'localImage');s.rpc.finish(s.thread.id,s.rpc.starts[0].id);
});

test('historical and live images use protected upload IDs without exposing paths',async t=>{
 const s=await setup(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 const upload=(await s.request('/api/uploads',{method:'POST',raw:png})).data;
 const item={id:'photo-item',type:'userMessage',content:[{type:'text',text:'look at this'},{type:'localImage',path:path.join(s.service.dataDir,'uploads',upload.id)},{type:'localImage',path:path.join(s.workspace,upload.id)},{type:'image',url:'https://untrusted.example/private.png'}]};
 const original=s.rpc.request.bind(s.rpc);s.rpc.request=async(method,p)=>method==='thread/turns/list'?{data:[{id:'old-turn',items:[item]}],nextCursor:null}:original(method,p);
 const history=(await s.request('/api/threads/'+s.thread.id+'/history')).data;
 const content=history.turns[0].items[0].content;
 assert.deepEqual(content[1].image,{id:upload.id,mime:'image/png',size:png.length,available:true});
 assert.equal(content[2].image.available,false);assert.equal(content[2].image.id,undefined);assert.equal(content[3].image.available,false);
 assert.equal(JSON.stringify(history).includes(s.service.dataDir),false);assert.equal(JSON.stringify(history).includes('untrusted.example'),false);
 s.rpc.emit('notification',{method:'item/completed',params:{threadId:s.thread.id,turnId:'old-turn',item}});
 const event=s.service.store.events(0).filter(e=>e.type==='thread.event').at(-1);assert.equal(event.data.item.content[1].image.id,upload.id);
 const route='/api/uploads/'+upload.id;
 const response=await fetch(s.service.address+route,{headers:{authorization:'Bearer '+s.token,...signedHeaders(s.key,s.service.address,'GET',route,Buffer.alloc(0),s.token)}});
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 assert.equal((await fetch(s.service.address+route)).status,401);
 assert.equal((await fetch(s.service.address+route,{headers:{authorization:'Bearer '+s.token}})).status,403);
});

test('preview references survive restart and deleted cached images return an explicit 404',async t=>{
 const a=await setup(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 const upload=(await a.request('/api/uploads',{method:'POST',raw:png})).data;
 const file=path.join(a.service.dataDir,'uploads',upload.id),item={id:'historical-image',type:'userMessage',content:[{type:'localImage',path:file}]};
 await a.service.close();const rpc=new FakeRpc(a.workspace);rpc.threads.set(a.thread.id,{id:a.thread.id,cwd:a.workspace,name:'restored'});
 const request=rpc.request.bind(rpc);rpc.request=async(method,p)=>method==='thread/turns/list'?{data:[{id:'original-turn',items:[item]}],nextCursor:null}:request(method,p);
 const b=await setup(t,{dir:a.root,rpc});
 const route='/api/threads/'+a.thread.id+'/history';
 assert.equal((await b.request(route)).data.turns[0].items[0].content[0].image.available,true);
 unlinkSync(file);
 const gone=(await b.request(route)).data.turns[0].items[0].content[0].image;assert.equal(gone.id,upload.id);assert.equal(gone.available,false);
 const result=await b.request('/api/uploads/'+upload.id);assert.equal(result.status,404);assert.match(result.data.error.message,/图片已不可用/);
});
test('WebSocket requires authentication, replays progress after reconnect, and revoked devices lose access',async t=>{
 const s=await setup(t);const url=s.service.address.replace('http:','ws:')+'/events';
 const noAuth=new WebSocket(url);noAuth.on('error',()=>{});await once(noAuth,'open');noAuth.send(JSON.stringify({type:'ping'}));const [code]=await once(noAuth,'close');assert.equal(code,4001);
 const socket=new WebSocket(url);socket.on('error',()=>{});const messages=[];socket.on('message',b=>messages.push(JSON.parse(b)));await once(socket,'open');socket.send(JSON.stringify(wsProof(s.key,s.service.address,s.token,0)));await tick();assert.ok(messages.some(m=>m.type==='authenticated'));
 const e=s.service.bridge.event('test.progress',{value:1});await tick();assert.ok(messages.some(m=>m.seq===e.seq));socket.close();await once(socket,'close');
 const missed=s.service.bridge.event('test.progress',{value:2});const reconnected=new WebSocket(url);reconnected.on('error',()=>{});const replay=[];reconnected.on('message',b=>replay.push(JSON.parse(b)));await once(reconnected,'open');reconnected.send(JSON.stringify(wsProof(s.key,s.service.address,s.token,e.seq)));await tick();assert.ok(replay.some(m=>m.seq===missed.seq));
 const closed=once(reconnected,'close');assert.equal((await s.request('/api/devices/'+s.deviceId,{method:'DELETE'})).status,200);assert.equal((await closed)[0],4003);assert.equal((await s.request('/api/status')).status,401);
});
test('uncertain work is not automatically repeated after a restart, and duplicate IDs keep their original task',async t=>{
 const a=await setup(t);const p={messageId:'restart-msg-01',text:'side effect'};const j=(await a.request('/api/threads/'+a.thread.id+'/messages',{method:'POST',body:p})).data.job;await tick();
 a.rpc.request=async(method,p)=>{if(method==='turn/interrupt')throw Error('connection lost');return FakeRpc.prototype.request.call(a.rpc,method,p);};await a.service.close();
 const rpc=new FakeRpc(a.workspace);rpc.threads.set(a.thread.id,{id:a.thread.id,cwd:a.workspace,name:'restored'});const b=await setup(t,{dir:a.root,rpc});
 const recovered=(await b.request('/api/jobs/'+j.id)).data;assert.equal(recovered.state,'needsReview');assert.equal(rpc.starts.length,0);
 const duplicate=await b.request('/api/threads/'+a.thread.id+'/messages',{method:'POST',body:p});assert.equal(duplicate.data.duplicate,true);assert.equal(duplicate.data.job.id,j.id);assert.equal(rpc.starts.length,0);
});

test('signed generic file upload preserves bytes, keeps names safe, and retries without duplicates',async t=>{
 const s=await setup(t),id='12345678-1234-1234-1234-123456789abc',body=Buffer.from('hello from a document');
 const route='/api/files?id='+id+'&name='+encodeURIComponent('../任务书?.txt')+'&mime=text%2Fplain';
 const uploaded=await s.request(route,{method:'POST',raw:body});assert.equal(uploaded.status,201);assert.equal(uploaded.data.id,id);assert.equal(uploaded.data.name,'.._任务书_.txt');
 const stored=s.service.store.fileUpload(id);const file=s.service.bridge.files.location(stored);assert.equal(path.dirname(path.dirname(file)),s.service.bridge.files.root);assert.deepEqual(readFileSync(file),body);assert.equal(s.rpc.starts.length,0);
 const retried=await s.request(route,{method:'POST',raw:body});assert.equal(retried.data.id,id);assert.equal(readdirSync(s.service.bridge.files.root).length,1);
 assert.equal((await s.request(route,{method:'POST',raw:Buffer.from('different')})).status,400);
 assert.equal((await fetch(s.service.address+route,{method:'POST',body})).status,401);
 assert.equal((await fetch(s.service.address+route,{method:'POST',body,headers:{authorization:'Bearer '+s.token}})).status,403);
 assert.equal((await s.request('/api/files?id=not-an-id&name=file.txt',{method:'POST',raw:body})).status,400);
});

test('file paths are passed to Codex while history retains safe cards after restart or cache deletion',async t=>{
 const a=await setup(t),id='22345678-1234-1234-1234-123456789abc',pdf=Buffer.from('%PDF-1.4 test document');
 await a.request('/api/files?id='+id+'&name=report.pdf&mime=application%2Fpdf',{method:'POST',raw:pdf});
 const message={messageId:'file-message-0001',text:'summarize this file',attachmentIds:[],fileIds:[id]};
 await a.request('/api/threads/'+a.thread.id+'/messages',{method:'POST',body:message});await tick();
 const input=a.rpc.starts[0].input[0].text,record=a.service.store.fileUpload(id),file=a.service.bridge.files.location(record);
 assert.ok(input.includes(JSON.stringify(file)));assert.ok(input.includes('summarize this file'));assert.deepEqual(readFileSync(file),pdf);
 const item={id:'file-user-item',clientId:message.messageId,type:'userMessage',content:[{type:'text',text:input}]};
 a.rpc.finish(a.thread.id,a.rpc.starts[0].id);await a.service.close();
 const rpc=new FakeRpc(a.workspace);rpc.threads.set(a.thread.id,{id:a.thread.id,cwd:a.workspace,name:'file chat'});const original=rpc.request.bind(rpc);rpc.request=async(method,p)=>method==='thread/turns/list'?{data:[{id:'turn-1',items:[item]}],nextCursor:null}:original(method,p);
 const b=await setup(t,{dir:a.root,rpc});let history=(await b.request('/api/threads/'+a.thread.id+'/history')).data;let view=history.turns[0].items[0];
 assert.equal(view.content[0].text,message.text);assert.equal(view.files[0].name,'report.pdf');assert.equal(view.files[0].available,true);assert.equal(JSON.stringify(history).includes(file),false);
 const duplicate=await b.request('/api/threads/'+a.thread.id+'/messages',{method:'POST',body:message});assert.equal(duplicate.data.duplicate,true);assert.equal(rpc.starts.length,0);
 unlinkSync(file);history=(await b.request('/api/threads/'+a.thread.id+'/history')).data;assert.equal(history.turns[0].items[0].files[0].available,false);
});

test('generic files respect the existing ten-megabyte limit',async t=>{
 const s=await setup(t);const route='/api/files?id=32345678-1234-1234-1234-123456789abc&name=big.bin';
 assert.equal((await s.request(route,{method:'POST',raw:Buffer.alloc(10*1024*1024+1)})).status,413);
 assert.equal(s.service.store.fileUpload('32345678-1234-1234-1234-123456789abc'),undefined);
});
