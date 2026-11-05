import {mkdirSync,realpathSync,lstatSync,openSync,fstatSync,readSync,closeSync,writeFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {BridgeError} from './bridge.mjs';
import {fileId,safeFilename} from './files.mjs';

export const GENERATED_LIMIT=20*1024*1024;
export const EXPORT_INSTRUCTIONS='文件交付约定：用户要求生成可下载的文档时，把最终文件放在当前项目的 codex-exports 子目录中（可创建子目录），在最终回复用 Markdown 链接交付，如 [方案](codex-exports/方案.docx)。支持 pdf/docx/xlsx/pptx/txt/md/csv/png/jpg/jpeg/webp，单文件最多20 MiB。只交付用户要求的文件，不复制凭据、配置或其他私密文件。不要声称手机已下载或已保存。';
const types={'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
const digest=b=>createHash('sha256').update(b).digest('hex');
const inside=(root,file)=>{const r=path.relative(root,file);return r!==''&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};

export class GeneratedFilePermissions {
 constructor(store,currentGeneration){this.db=store.db;this.currentGeneration=currentGeneration;this.db.exec('CREATE TABLE IF NOT EXISTS device_generated_files(fingerprint TEXT PRIMARY KEY,generation TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))');}
 view(fingerprint,generation){return this.db.prepare('SELECT enabled FROM device_generated_files WHERE fingerprint=? AND generation=?').get(fingerprint,generation)?.enabled===1;}
 get(device){const d=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(device.device_key);if(!d||d.status!=='approved'||d.generation!==device.auth_generation||this.currentGeneration()!==d.generation)throw new BridgeError(401,'AUTH_INVALID','设备批准已失效。');return this.view(d.fingerprint,d.generation);}
 set(fingerprint,generation,enabled){const d=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(fingerprint);if(!d||d.status!=='approved'||d.generation!==generation||generation!==this.currentGeneration()||typeof enabled!=='boolean')throw new BridgeError(400,'INVALID_DOWNLOAD_SETTING','请选择已批准的手机和有效的下载权限。');this.db.prepare('INSERT INTO device_generated_files VALUES(?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET generation=excluded.generation,enabled=excluded.enabled').run(fingerprint,generation,enabled?1:0);return enabled;}
}

// Only explicit assistant links into this thread's export folder become deliveries.
// The folder is an intentional export boundary, never an arbitrary PC path reader.
export function exportCandidates(text,cwd){
 const root=path.join(cwd,'codex-exports'),out=[];
 for(const m of String(text).matchAll(/\[[^\]\r\n]{0,200}\]\(\s*(<[^>\r\n]+>|[^\r\n)]+)\s*\)/g)){
  try{let link=m[1].trim();if(link.startsWith('<'))link=link.slice(1,-1);link=decodeURIComponent(link);if(link.includes('\0')||/^[a-z][a-z0-9+.-]*:/i.test(link)&&!path.isAbsolute(link)||link.startsWith('\\\\'))continue;
   const file=path.resolve(cwd,link);if(inside(root,file)&&types[path.extname(file).toLowerCase()]&&!out.includes(file))out.push(file);
  }catch{}if(out.length>=8)break;
 }return out;
}
function checkedPath(root,file){
 if(!inside(root,file))throw Error('outside');
 let current=root;if(lstatSync(current).isSymbolicLink()||realpathSync(current)!==root)throw Error('link');
 for(const part of path.relative(root,file).split(path.sep)){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('link');}
 if(realpathSync(file)!==file)throw Error('link');
}
function readBounded(file,root){
 checkedPath(root,file);const fd=openSync(file,'r');
 try{const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1)throw Error('not a regular independent file');if(before.size>GENERATED_LIMIT)throw new BridgeError(413,'GENERATED_TOO_LARGE','文件超过 20 MB，请压缩或拆分。');
  const buf=Buffer.alloc(Math.min(GENERATED_LIMIT+1,before.size+1));let n=0,count;while(n<buf.length&&(count=readSync(fd,buf,n,buf.length-n,null))>0)n+=count;
  const after=fstatSync(fd);checkedPath(root,file);const current=lstatSync(file);if(n>GENERATED_LIMIT)throw new BridgeError(413,'GENERATED_TOO_LARGE','文件超过 20 MB，请压缩或拆分。');if(n!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||current.nlink!==1)throw Error('file changed');return buf.subarray(0,n);
 }finally{closeSync(fd);}
}
export class GeneratedFiles {
 constructor(store,dataDir){this.db=store.db;mkdirSync(path.join(dataDir,'generated-files'),{recursive:true});this.root=realpathSync(path.join(dataDir,'generated-files'));this.active=new Map();
  this.db.exec('CREATE TABLE IF NOT EXISTS generated_files(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,item_key TEXT NOT NULL,workspace TEXT NOT NULL,source TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,UNIQUE(thread_id,item_key,source))');
 }
 view(r){return{id:r.id,name:r.name,mime:r.mime,size:r.size,sha256:r.sha256,available:true};}
 register(threadId,itemKey,cwd,file){
  const existing=this.db.prepare('SELECT * FROM generated_files WHERE thread_id=? AND item_key=? AND source=?').get(threadId,itemKey,file);if(existing)return this.view(existing);
  const root=path.join(realpathSync(cwd),'codex-exports');let body;
  try{body=readBounded(file,root);}catch(e){return{name:safeFilename(path.basename(file)),size:0,available:false,error:e.code==='GENERATED_TOO_LARGE'?e.message:'文件不可用，可能尚未生成、已删除或不符合交付规则。'};}
  const used=this.db.prepare('SELECT COALESCE(SUM(size),0) AS size,COUNT(*) AS count FROM generated_files').get();
  if(used.size+body.length>1024*1024*1024||used.count>=2000)return{name:safeFilename(path.basename(file)),size:body.length,available:false,error:'电脑交付存储已满，请联系管理员整理。'};
  const r={id:randomUUID(),thread_id:threadId,item_key:itemKey,workspace:cwd,source:file,name:safeFilename(path.basename(file)),mime:types[path.extname(file).toLowerCase()],size:body.length,sha256:digest(body)};
  const target=path.join(this.root,r.id);writeFileSync(target,body,{flag:'wx'});
  try{this.db.prepare('INSERT INTO generated_files VALUES(?,?,?,?,?,?,?,?,?)').run(r.id,r.thread_id,r.item_key,r.workspace,r.source,r.name,r.mime,r.size,r.sha256);}catch(e){unlinkSync(target);throw e;}return this.view(r);
 }
 decorate(history,threadId,cwd){for(const turn of history.turns)for(const item of turn.items)if(item.type==='agentMessage'&&turn.storedStatus==='completed')item.generatedFiles=exportCandidates(item.text,cwd).map(file=>this.register(threadId,turn.id+':'+item.id,cwd,file));return history;}
 record(id){const r=fileId(id)?this.db.prepare('SELECT * FROM generated_files WHERE id=?').get(id):null;if(!r)throw new BridgeError(404,'GENERATED_NOT_FOUND','文件不存在或已不可用。');return r;}
 body(record){try{const file=path.join(this.root,record.id),body=readBounded(file,this.root);if(body.length!==record.size||digest(body)!==record.sha256)throw Error();return body;}catch{throw new BridgeError(404,'GENERATED_NOT_FOUND','文件副本不可用，请重新生成。');}}
 acquire(key){const total=[...this.active.values()].reduce((a,b)=>a+b,0);if((this.active.get(key)||0)>=2||total>=8)throw new BridgeError(429,'DOWNLOAD_BUSY','同时下载的文件过多，请稍后重试。');this.active.set(key,(this.active.get(key)||0)+1);let done=false;return()=>{if(!done){done=true;const n=this.active.get(key)-1;if(n)this.active.set(key,n);else this.active.delete(key);}};}
}
