import {realpathSync,statSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';

export class ProjectAccessError extends Error{constructor(message,status=403,code='WORKSPACE_DENIED'){super(message);this.status=status;this.code=code;}}
const normal=p=>process.platform==='win32'?p.toLowerCase():p;
export function directory(input){
 if(typeof input!=='string'||!path.isAbsolute(input))throw new ProjectAccessError('请输入目录的完整路径。',400,'INVALID_WORKSPACE');
 try{const p=realpathSync(input);if(!statSync(p).isDirectory())throw Error();return p;}catch{throw new ProjectAccessError('目录不存在或无法访问：'+input,400,'INVALID_WORKSPACE');}
}
export function permits(scope,cwd){
 try{const actual=directory(cwd);if(scope.mode==='all')return true;
 return scope.roots.some(root=>{if(normal(directory(root))!==normal(root))return false;const rel=path.relative(root,actual);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));});}catch{return false;}
}
export function validateScope(value){
 if(!value||!['directories','all'].includes(value.mode)||!Array.isArray(value.roots)||value.roots.length>32)throw new ProjectAccessError('请选择指定目录或所有目录。',400,'INVALID_SCOPE');
 if(value.mode==='all'){if(value.roots.length)throw new ProjectAccessError('所有目录模式不接受目录列表。',400,'INVALID_SCOPE');return{mode:'all',roots:[]};}
 if(!value.roots.length)throw new ProjectAccessError('请至少添加一个目录。',400,'INVALID_SCOPE');
 return{mode:'directories',roots:[...new Map(value.roots.map(p=>{const d=directory(p);return[normal(d),d];})).values()]};
}
export function defaultProjectRoots(dataDir){
 const read=name=>{try{return JSON.parse(readFileSync(path.join(dataDir,name),'utf8'));}catch{return null;}};
 return read('runtime.json')?.roots||[read('console-settings.json')?.workspace||path.join(os.homedir(),'Documents','Codex')];
}
export class ProjectAccess{
 constructor(store,roots,currentGeneration){this.store=store;this.db=store.db;this.roots=roots.map(directory);this.currentGeneration=currentGeneration;
  this.db.exec('CREATE TABLE IF NOT EXISTS device_project_access(fingerprint TEXT PRIMARY KEY,generation TEXT NOT NULL,policy TEXT NOT NULL,revision TEXT NOT NULL)');
  // Snapshot legacy devices once, so later default-directory changes do not widen them.
  for(const d of this.db.prepare('SELECT fingerprint,generation FROM trusted_devices').all())this.initialize(d.fingerprint,d.generation);
 }
 initialize(fingerprint,generation){
  const old=this.db.prepare('SELECT generation FROM device_project_access WHERE fingerprint=?').get(fingerprint);
  if(!old||old.generation!==generation)this.write(fingerprint,generation,{mode:'directories',roots:this.roots});
 }
 write(fingerprint,generation,policy){const revision=randomUUID();this.db.prepare('INSERT INTO device_project_access VALUES(?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET generation=excluded.generation,policy=excluded.policy,revision=excluded.revision').run(fingerprint,generation,JSON.stringify(policy),revision);return{...policy,revision};}
 get(identity){
  const d=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(identity.device_key);
  if(!d||d.status!=='approved'||d.generation!==identity.auth_generation||(this.currentGeneration&&this.currentGeneration()!==d.generation))throw new ProjectAccessError('设备批准已失效。',401,'AUTH_INVALID');
  this.initialize(d.fingerprint,d.generation);
  const row=this.db.prepare('SELECT * FROM device_project_access WHERE fingerprint=?').get(d.fingerprint);let policy;
  try{policy=JSON.parse(row.policy);if(!['directories','all'].includes(policy.mode)||!Array.isArray(policy.roots)||policy.roots.some(p=>typeof p!=='string'||!path.isAbsolute(p))||(policy.mode==='directories'&&!policy.roots.length)||(policy.mode==='all'&&policy.roots.length))throw Error();}catch{throw new ProjectAccessError('手机项目范围配置损坏，请在电脑重新设置。');}
  return{...policy,revision:row.revision};
 }
 set(fingerprint,generation,value){const d=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(fingerprint);if(!d||d.generation!==generation)throw new ProjectAccessError('设备请求已失效。',400,'INVALID_DEVICE');return this.write(fingerprint,generation,validateScope(value));}
 view(fingerprint,generation){this.initialize(fingerprint,generation);const row=this.db.prepare('SELECT * FROM device_project_access WHERE fingerprint=?').get(fingerprint);try{return{...JSON.parse(row.policy),revision:row.revision};}catch{return{mode:'invalid',roots:[],revision:row.revision};}}
}
