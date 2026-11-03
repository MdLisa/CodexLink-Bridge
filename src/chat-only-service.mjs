import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,existsSync,lstatSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {BridgeError,digest,jobView,itemView} from './bridge.mjs';
import {ChatOnlyRuntime} from './chat-only.mjs';

const key=d=>d.device_key+':'+d.auth_generation;
const owner=j=>({device_key:j.device_key,auth_generation:j.auth_generation});
export class ChatOnlyService extends EventEmitter{
 constructor({store,dataDir,validOwner,imageFile,requireImage,runtimeFactory,refreshAuth,exe}){
  super();Object.assign(this,{store,dataDir,validOwner,imageFile,requireImage});this.runtimes=new Map();this.workers=new Map();this.requests=new Map();this.cancelled=new Set();this.closing=false;
  const privateRoot=path.resolve(dataDir,'phone-chat-runtime');
  const credentialsRoot=path.join(privateRoot,'chat-only');if(existsSync(credentialsRoot)&&!lstatSync(credentialsRoot).isSymbolicLink())for(const entry of readdirSync(credentialsRoot,{withFileTypes:true})){if(!entry.isDirectory()||!/^[a-f0-9]{64}$/.test(entry.name))continue;const home=path.join(credentialsRoot,entry.name,'home'),auth=path.resolve(home,'auth.json');if(!auth.startsWith(credentialsRoot+path.sep)||!existsSync(home)||lstatSync(home).isSymbolicLink())continue;if(existsSync(auth)&&!lstatSync(auth).isSymbolicLink())unlinkSync(auth);}
  this.runtimeFactory=runtimeFactory||(async(d)=>{try{await refreshAuth();}catch{throw new BridgeError(503,'CHAT_LOGIN_REFRESH','无法刷新 Codex 登录，请在电脑重新登录后重试；不会回退为操作模式。');}return new ChatOnlyRuntime({dataRoot:privateRoot,identity:key(d),exe,accessOnly:true});});
  store.db.exec('CREATE TABLE IF NOT EXISTS chat_only_threads(id TEXT PRIMARY KEY,device_key TEXT NOT NULL,generation TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)');
 }
 assert(d){if(this.closing||!this.validOwner(d))throw new BridgeError(403,'MODE_CHANGED','设备权限或聊天模式已改变，请刷新后重试。');}
 audience(d){return{deviceKey:d.device_key,generation:d.auth_generation,executionMode:'chat_only'};}
 event(type,data,d){const event=this.store.event(type,data,null,this.audience(d));this.emit('event',event);}
 owns(id,d){const t=this.store.db.prepare('SELECT * FROM chat_only_threads WHERE id=?').get(id);return t?.device_key===d.device_key&&t?.generation===d.auth_generation;}
 info(id,d){this.assert(d);const t=this.store.db.prepare('SELECT * FROM chat_only_threads WHERE id=?').get(id);if(!this.owns(id,d))throw new BridgeError(403,'CHAT_THREAD_DENIED','仅聊天模式只能访问本设备独立的聊天。');return t;}
 view(t){return{id:t.id,name:t.name,cwd:'仅聊天',createdAt:t.created_at,updatedAt:t.updated_at,control:'chatOnly'};}
 list(cursor,d){this.assert(d);const offset=cursor?Number(cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new BridgeError(400,'INVALID_CURSOR','聊天分页无效。');const rows=this.store.db.prepare('SELECT * FROM chat_only_threads WHERE device_key=? AND generation=? ORDER BY updated_at DESC,id LIMIT 51 OFFSET ?').all(d.device_key,d.auth_generation,offset);return{threads:rows.slice(0,50).map(t=>this.view(t)),nextCursor:rows.length>50?String(offset+50):null};}
 async runtime(d,rotate=false){this.assert(d);const id=key(d);let pending=this.runtimes.get(id);if(pending){const runtime=await pending;if(rotate&&runtime.authExpiring?.()){await runtime.close();this.runtimes.delete(id);pending=null;}}
  if(!pending){pending=(async()=>{const r=await this.runtimeFactory(d);r.on('notification',m=>this.notification(d,m));r.on('question',q=>this.question(d,r,q));await r.start();return r;})();this.runtimes.set(id,pending);pending.catch(()=>{if(this.runtimes.get(id)===pending)this.runtimes.delete(id);});}
  const runtime=await pending;this.assert(d);return runtime;
 }
 async create(body,d){this.assert(d);if(Object.keys(body).some(k=>k!=='name')||body.name!==undefined&&(typeof body.name!=='string'||body.name.length>100))throw new BridgeError(400,'CHAT_CONFIG_DENIED','仅聊天不接受电脑目录或工具配置。');const r=await this.runtime(d),chat=await r.create();this.assert(d);const time=Date.now()/1000|0;this.store.db.prepare('INSERT INTO chat_only_threads VALUES(?,?,?,?,?,?)').run(chat.id,d.device_key,d.auth_generation,body.name?.trim()||'仅聊天',time,time);return this.view(this.info(chat.id,d));}
 item(item,threadId,turnId){if(item?.type==='userMessage'){const job=this.store.jobForTurn(threadId,turnId);if(job){const p=JSON.parse(job.payload);return{type:'userMessage',id:item.id,content:[...(p.text?[{type:'text',text:p.text}]:[]),...p.attachmentIds.map(id=>({type:'image',attachment:true,image:{id,mime:this.store.upload(id)?.mime,available:Boolean(this.imageFile(id))}}))]};}}
  if(item?.type==='webSearch')return{type:'webSearch',id:item.id,status:item.status,query:item.query||''};return ['agentMessage','userMessage'].includes(item?.type)?itemView(item):null;
 }
 async history(id,params,d){this.info(id,d);const r=await this.runtime(d);if(!params.readOnly&&!this.store.db.prepare('SELECT 1 FROM jobs WHERE thread_id=? LIMIT 1').get(id))r.allowUnsentRecovery?.(id);const result=await r.history(id,params);this.assert(d);return{turns:(result.data||[]).map(t=>({id:t.id,storedStatus:t.status,items:(t.items||[]).map(i=>this.item(i,id,t.id)).filter(Boolean)})),nextCursor:result.nextCursor||null,liveStateFromHistory:false};}
 async enqueue(id,body,d){this.info(id,d);const{messageId,text='',attachmentIds=[],fileIds=[]}=body;if(Object.keys(body).some(k=>!['messageId','text','attachmentIds','fileIds','modeRevision'].includes(k))||typeof messageId!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(messageId)||typeof text!=='string'||text.length>64000||!Array.isArray(attachmentIds)||attachmentIds.length>8||attachmentIds.some(i=>typeof i!=='string')||!Array.isArray(fileIds)||fileIds.length||!text.trim()&&!attachmentIds.length)throw new BridgeError(400,'CHAT_MESSAGE_DENIED','仅聊天只允许文字和最多 8 张主动发送的图片。');
  for(const image of attachmentIds){this.requireImage(image,d);if(!this.imageFile(image))throw new BridgeError(400,'UPLOAD_NOT_FOUND','图片不存在或已删除。');}
  const payload={text,attachmentIds},hash=digest(JSON.stringify(payload)),old=this.store.existing(id,messageId);if(old){if(old.payload_hash!==hash)throw new BridgeError(409,'MESSAGE_ID_CONFLICT','消息编号已用于不同内容。');return{job:jobView(old),duplicate:true};}
  this.assert(d);const job=this.store.insertJob({id:randomUUID(),threadId:id,messageId,hash,payload,deviceKey:d.device_key,authGeneration:d.auth_generation,approvalsReviewer:'chat_only'});this.store.db.prepare("UPDATE jobs SET execution_mode='chat_only' WHERE id=?").run(job.id);this.store.db.prepare('UPDATE chat_only_threads SET updated_at=? WHERE id=?').run(Date.now()/1000|0,id);for(const image of attachmentIds)this.store.bindAttachment(image,id,'chat_only');this.event('job.updated',jobView(job),d);this.pump(d);return{job:jobView(job),duplicate:false};
 }
 jobs(id,d){this.info(id,d);return this.store.jobs(id).map(jobView);}
 job(id,d){this.assert(d);const j=this.store.job(id);if(j?.execution_mode!=='chat_only'||j.device_key!==d.device_key||j.auth_generation!==d.auth_generation)throw new BridgeError(403,'CHAT_JOB_DENIED','不能访问其他模式或设备的任务。');this.info(j.thread_id,d);return j;}
 requestsFor(d){this.assert(d);return[...this.requests.values()].filter(q=>key(q.device)===key(d)).map(q=>q.view);}
 async respond(id,body,d){this.assert(d);const q=this.requests.get(id);if(!q||key(q.device)!==key(d))throw new BridgeError(403,'CHAT_REQUEST_DENIED','这个提问不属于本设备。');q.runtime.answer(q.rpcId,body.answers);this.requests.delete(id);this.event('request.resolved',{id,threadId:q.view.threadId},d);const job=this.current(d);if(job)this.event('job.updated',jobView(this.store.updateJob(job.id,'running')),d);return{resolved:true};}
 current(d){return this.store.db.prepare("SELECT * FROM jobs WHERE execution_mode='chat_only' AND device_key=? AND auth_generation=? AND state IN ('starting','running','waitingApproval') ORDER BY rowid LIMIT 1").get(d.device_key,d.auth_generation);}
 question(d,r,q){if(!this.validOwner(d))return;const job=this.current(d);if(!job||job.thread_id!==q.threadId)return;const id=randomUUID(),view={id,method:'item/tool/requestUserInput',threadId:q.threadId,turnId:q.turnId,questions:q.questions};this.requests.set(id,{device:d,runtime:r,rpcId:q.id,view});this.event('job.updated',jobView(this.store.updateJob(job.id,'waitingApproval')),d);this.event('request.created',view,d);}
 notification(d,m){if(!this.validOwner(d))return;const p=m.params||{},job=this.current(d);if(!job||job.thread_id!==p.threadId)return;if(m.method==='turn/started'){this.event('job.updated',jobView(this.store.updateJob(job.id,'running',{turnId:p.turn.id})),d);}
  if(m.method==='item/agentMessage/delta')this.event('thread.event',{method:m.method,threadId:p.threadId,turnId:p.turnId,itemId:p.itemId,delta:p.delta},d);
  else if(m.method==='item/completed'){const item=this.item(p.item,p.threadId,p.turnId);if(item)this.event('thread.event',{method:m.method,threadId:p.threadId,turnId:p.turnId,item},d);}
 }
 pump(d){const id=key(d);if(this.closing||this.workers.has(id))return;const work=this.run(d).finally(()=>this.workers.delete(id));this.workers.set(id,work);work.catch(()=>{});}
 async run(d){while(!this.closing){const job=this.store.queued('chat_only').find(j=>key(owner(j))===key(d));if(!job)return;
   try{this.assert(d);this.info(job.thread_id,d);this.event('job.updated',jobView(this.store.updateJob(job.id,'starting')),d);const r=await this.runtime(d,true);this.assert(d);if(!this.store.db.prepare('SELECT 1 FROM jobs WHERE thread_id=? AND id<>? LIMIT 1').get(job.thread_id,job.id))r.allowUnsentRecovery?.(job.thread_id);if(this.cancelled.has(job.id))throw new BridgeError(409,'CHAT_CANCELLED','任务已停止。');const p=JSON.parse(job.payload);const images=p.attachmentIds.map(id=>{this.requireImage(id,d);const image=this.imageFile(id);if(!image)throw new BridgeError(400,'UPLOAD_NOT_FOUND','图片已删除。');return readFileSync(image.file);});const result=await r.ask(job.thread_id,{text:p.text,images});this.event('job.updated',jobView(this.store.updateJob(job.id,'completed',{turnId:result.turnId})),d);
   }catch(e){this.event('job.updated',jobView(this.store.updateJob(job.id,this.closing||this.cancelled.has(job.id)?'interrupted':'failed',{error:e.code==='RPC_TIMEOUT'?'响应丢失，请检查历史记录，不会自动重发。':e.status||e.code?.startsWith('CHAT_')?e.message:'仅聊天后台失败，请检查电脑登录或重启后台；不会回退为操作模式。'})),d);}
   finally{this.cancelled.delete(job.id);for(const [id,q]of this.requests)if(q.view.threadId===job.thread_id){this.requests.delete(id);this.event('request.resolved',{id,threadId:job.thread_id},d);}}
  }}
 async cancel(id,d){const job=this.job(id,d);if(job.state==='queued'){const result=this.store.updateJob(id,'cancelled');this.event('job.updated',jobView(result),d);return jobView(result);}if(['starting','running','waitingApproval'].includes(job.state)){this.cancelled.add(id);const r=await this.runtime(d);await r.interrupt(job.thread_id);}return jobView(this.store.job(id));}
 start(){for(const job of this.store.queued('chat_only'))this.pump(owner(job));}
 async closeOwner(d){const id=key(d),pending=this.runtimes.get(id);this.runtimes.delete(id);if(pending){const r=await pending.catch(()=>null);await r?.close();}await this.workers.get(id);}
 async reconcile(){for(const j of this.store.queued('chat_only'))if(!this.validOwner(owner(j)))this.store.updateJob(j.id,'failed',{error:'设备权限或模式已改变，排队任务已取消。'});for(const id of [...this.runtimes.keys()]){const split=id.lastIndexOf(':'),d={device_key:id.slice(0,split),auth_generation:id.slice(split+1)};if(!this.validOwner(d))await this.closeOwner(d);}}
 async close(){this.closing=true;await Promise.allSettled([...this.runtimes.values()].map(async p=>(await p).close()));await Promise.allSettled([...this.workers.values()]);this.runtimes.clear();this.requests.clear();}
}
