import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {executionSettings,setExecutionSettings} from '../src/execution-settings.mjs';
import {startServer} from '../src/server.mjs';

const services=new Map();
function scratch(t){const dir=mkdtempSync(path.join(os.tmpdir(),'codex-review-tests-'));t.after(async()=>{await services.get(dir)?.close();if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('codex-review-tests-'))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});});return dir;}
class Rpc extends EventEmitter{
  calls=[];responses=[];
  async start(){}
  async close(){}
  async request(method,params){this.calls.push({method,params});
    if(method==='thread/start')return{thread:{id:'new-thread',cwd:params.cwd}};
    if(method==='thread/read')return{thread:{id:params.threadId,cwd:this.cwd}};
    if(method==='thread/resume')return{};
    if(method==='turn/start')return{turn:{id:'turn-'+this.calls.length}};
    throw Error('Unexpected method '+method);
  }
  respond(id,result){this.responses.push({id,result});}
  reject(id,message){this.responses.push({id,message});}
}

test('reviewer configuration defaults to manual and rejects invalid or full-access values',t=>{
  const dir=scratch(t);assert.deepEqual(executionSettings(dir),{approvalsReviewer:'user'});
  setExecutionSettings(dir,'auto_review');assert.equal(executionSettings(dir).approvalsReviewer,'auto_review');
  assert.throws(()=>setExecutionSettings(dir,'never'));assert.equal(executionSettings(dir).approvalsReviewer,'auto_review');
  writeFileSync(path.join(dir,'execution-settings.json'),'{broken');assert.throws(()=>executionSettings(dir));
  writeFileSync(path.join(dir,'execution-settings.json'),JSON.stringify({approvalsReviewer:'accept-all'}));assert.throws(()=>executionSettings(dir));
});

test('automatic review applies to new, resumed and already-loaded chats without widening sandbox or autoanswering requests',async t=>{
  const root=scratch(t),dataDir=path.join(root,'state');mkdirSync(dataDir);setExecutionSettings(dataDir,'auto_review');
  const rpc=new Rpc();rpc.cwd=root;
  const service=await startServer({port:0,dataDir,roots:[root],rpc});services.set(root,service);const b=service.bridge;
  const thread=await b.create();let p=rpc.calls.find(c=>c.method==='thread/start').params;
  assert.equal(p.approvalsReviewer,'auto_review');assert.equal(p.approvalPolicy,'on-request');assert.equal(p.sandbox,'workspace-write');
  await b.acquire('existing-thread');p=rpc.calls.find(c=>c.method==='thread/resume').params;
  assert.equal(p.approvalsReviewer,'auto_review');assert.equal(p.approvalPolicy,'on-request');assert.equal('sandbox' in p,false);
  const submitted=await b.enqueue(thread.id,{messageId:'review-test-001',text:'check'});
  await new Promise(r=>setImmediate(r));p=rpc.calls.find(c=>c.method==='turn/start').params;
  assert.equal(p.approvalsReviewer,'auto_review');assert.equal(p.approvalPolicy,'on-request');assert.equal('sandboxPolicy' in p,false);assert.equal('permissions' in p,false);
  const turnId=service.store.job(submitted.job.id).turn_id;
  rpc.emit('request',{id:101,method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId,command:'requires manual fallback'}});
  rpc.emit('request',{id:102,method:'item/tool/requestUserInput',params:{threadId:thread.id,turnId,questions:[]}});
  assert.equal(rpc.responses.length,0);assert.equal(b.requests.size,2);
  rpc.emit('notification',{method:'turn/completed',params:{threadId:thread.id,turn:{id:turnId,status:'completed'}}});
  setExecutionSettings(dataDir,'user');await b.enqueue(thread.id,{messageId:'review-test-002',text:'next'});await new Promise(r=>setImmediate(r));
  p=rpc.calls.filter(c=>c.method==='turn/start').at(-1).params;assert.equal(p.approvalsReviewer,'user');assert.equal('approvalPolicy' in p,false);
  setExecutionSettings(dataDir,'auto_review');assert.equal(b.reviewSettings().approvalsReviewer,'auto_review');
  assert.equal((await fetch(service.address+'/api/status')).status,401);
});
