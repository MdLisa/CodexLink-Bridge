import {existsSync,readFileSync,mkdirSync,writeFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const FILE_LIMIT=10*1024*1024;
export const fileId=id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
const hash=b=>createHash('sha256').update(b).digest('hex');
export function safeFilename(input){
 if(typeof input!=='string'||!input.trim()||input.length>255)throw Error('文件名无效或过长。');
 let name=input.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/g,'').trim();
 if(!name||name==='.'||name==='..')name='attachment';
 if(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))name='_'+name;
 if(name.length>160){const ext=path.extname(name).slice(0,20);name=name.slice(0,160-ext.length)+ext;}
 return name;
}
export function configuredFileRoot(dataDir){
 let saved;try{saved=JSON.parse(readFileSync(path.join(dataDir,'attachments-config.json'),'utf8'));}catch{}
 const root=process.env.BRIDGE_ATTACHMENTS_DIR||saved?.directory||path.join(dataDir,'files');
 if(!path.isAbsolute(root))throw Error('附件目录必须是电脑上的完整路径。');return path.resolve(root);
}
export class FileUploads{
 constructor(store,dataDir){this.store=store;this.root=configuredFileRoot(dataDir);mkdirSync(this.root,{recursive:true});this.root=realpathSync(this.root);}
 location(record){return path.join(record.root,record.id,record.name);}
 readable(id){
  const record=fileId(id)?this.store.fileUpload(id):null;if(!record)return null;
  try{const root=realpathSync(record.root),folder=realpathSync(path.join(root,id)),file=realpathSync(this.location(record)),stat=statSync(file);if(path.dirname(folder)!==root||path.basename(folder)!==id||path.dirname(file)!==folder||path.basename(file)!==record.name||!stat.isFile()||stat.size!==record.size||stat.size>FILE_LIMIT)return null;return{record,file};}catch{return null;}
 }
 view(id){const r=fileId(id)?this.store.fileUpload(id):null;return r?{id:r.id,name:r.name,mime:r.mime,size:r.size,available:!!this.readable(id)}:{id,name:'附件已不可用',size:0,available:false};}
 save({id,name,mime,body}){
  if(!fileId(id))throw Error('文件编号无效。');name=safeFilename(name);
  if(body.length>FILE_LIMIT)throw Error('单个文件不能超过 10 MB。');
  mime=typeof mime==='string'&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime)?mime:'application/octet-stream';
  const sha256=hash(body),old=this.store.fileUpload(id);
  if(old){if(old.sha256!==sha256||old.name!==name||old.mime!==mime||old.size!==body.length)throw Error('文件编号已用于其他内容，请重新选择文件。');if(!this.readable(id))throw Error('原附件已不可用，请重新选择文件。');return this.view(id);}
  const folder=path.join(this.root,id);if(!existsSync(folder))mkdirSync(folder);
  if(path.dirname(realpathSync(folder))!==this.root||path.basename(realpathSync(folder))!==id)throw Error('附件保存目录无效。');
  const file=path.join(folder,name);
  try{writeFileSync(file,body,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||realpathSync(file)!==file||statSync(file).size!==body.length||hash(readFileSync(file))!==sha256)throw Error('附件无法保存，请重试。');}
  this.store.addFileUpload({id,name,mime,size:body.length,sha256,root:this.root});return this.view(id);
 }
 prompt(ids){return ids.map(id=>{const r=this.store.fileUpload(id);if(!r)throw Error('附件不存在。');return{name:r.name,path:this.location(r)};});}
}
