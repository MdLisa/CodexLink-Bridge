import {createPublicKey,createHash,verify,randomUUID} from 'node:crypto';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const authority=h=>String(h||'').toLowerCase().replace(/:(80|443)$/,'');
export function signingText({token='',method,host,path,time,nonce,body=Buffer.alloc(0)}){
 return ['codex-device-v1',sha(token),method,authority(host),path,String(time),nonce,sha(body)].join('\n');
}
export class DeviceSecurityError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const deny=(message='设备签名无效，请更新应用或重新登录。')=>new DeviceSecurityError(403,'DEVICE_PROOF_INVALID',message);
export class DeviceSecurity{
 constructor(store){this.store=store;this.db=store.db;this.nonces=new Map();
  this.db.exec(`CREATE TABLE IF NOT EXISTS trusted_devices(fingerprint TEXT PRIMARY KEY,public_key TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,generation TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS device_nonces(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS device_notes(fingerprint TEXT PRIMARY KEY,generation TEXT NOT NULL,note TEXT NOT NULL);`);
 }
 publicKey(encoded){try{if(typeof encoded!=='string'||encoded.length>256)throw Error();const key=createPublicKey({key:Buffer.from(encoded,'base64'),format:'der',type:'spki'});if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error();const der=key.export({format:'der',type:'spki'});return{key,encoded:der.toString('base64'),fingerprint:sha(der)};}catch{throw deny();}}
 code(fingerprint){return fingerprint.slice(0,16).toUpperCase().match(/.{4}/g).join('-');}
 lookup(fingerprint){return this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(fingerprint);}
 approved(fingerprint,generation){const r=this.lookup(fingerprint);return Boolean(r&&r.status==='approved'&&r.generation===generation);}
 enroll(encoded,name,generation){const p=this.publicKey(encoded),old=this.lookup(p.fingerprint);if(old&&old.generation===generation)return old;
  if(this.db.prepare("SELECT count(*) AS n FROM trusted_devices WHERE status='pending' AND generation=?").get(generation).n>=10)throw new DeviceSecurityError(429,'APPROVAL_QUEUE_FULL','等待批准的手机过多，请在电脑上处理。');
  this.db.prepare('INSERT INTO trusted_devices VALUES(?,?,?,\'pending\',?,?) ON CONFLICT(fingerprint) DO UPDATE SET name=excluded.name,status=\'pending\',generation=excluded.generation,created_at=excluded.created_at').run(p.fingerprint,p.encoded,String(name||'安卓手机').replace(/[\x00-\x1f\x7f]/g,'').slice(0,80),generation,new Date().toISOString());return this.lookup(p.fingerprint);
 }
 list(){return this.db.prepare('SELECT d.*,COALESCE(n.note,\'\') AS note FROM trusted_devices d LEFT JOIN device_notes n ON n.fingerprint=d.fingerprint AND n.generation=d.generation ORDER BY d.created_at DESC').all().map(r=>({...r,code:this.code(r.fingerprint)}));}
 note(fingerprint,generation,note){
  const d=this.lookup(fingerprint);if(!d||d.generation!==generation)throw new DeviceSecurityError(400,'INVALID_DEVICE','设备请求已失效，请刷新列表。');
  if(typeof note!=='string'||[...note].length>80||/[\x00-\x1f\x7f]/.test(note))throw new DeviceSecurityError(400,'INVALID_NOTE','备注最多 80 个字符，不能包含换行或控制字符。');
  this.db.prepare('INSERT INTO device_notes VALUES(?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET generation=excluded.generation,note=excluded.note').run(fingerprint,generation,note.trim());
 }
 forget(fingerprint,generation){
  const d=this.lookup(fingerprint);if(!d||d.generation!==generation)throw new DeviceSecurityError(400,'INVALID_DEVICE','设备请求已失效，请刷新列表。');
  if(this.db.prepare("SELECT 1 FROM jobs WHERE device_key=? AND state IN ('starting','running','waitingApproval') LIMIT 1").get(fingerprint))throw new DeviceSecurityError(409,'TASK_PENDING','该手机仍有任务正在执行，请先停止或等待任务结束。');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare("UPDATE jobs SET state='cancelled',error='设备已删除，排队任务已取消。',updated_at=? WHERE device_key=? AND state='queued'").run(new Date().toISOString(),fingerprint);
   this.db.prepare('DELETE FROM devices WHERE device_key=?').run(fingerprint);
   for(const table of ['device_notes','device_project_access','device_approvals','device_takeover','device_chat_viewer'])if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))this.db.prepare('DELETE FROM '+table+' WHERE fingerprint=?').run(fingerprint);
   this.db.prepare('DELETE FROM trusted_devices WHERE fingerprint=?').run(fingerprint);
   // Keep replay proofs until their normal expiry, and retain chat/attachment ownership.
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 approve(fingerprint,code,generation){const r=this.lookup(fingerprint);if(!r||r.generation!==generation||code.toUpperCase().replaceAll('-','')!==this.code(fingerprint).replaceAll('-',''))throw Error('核对码不匹配或请求已失效，没有批准。');this.db.prepare("UPDATE trusted_devices SET status='approved' WHERE fingerprint=?").run(fingerprint);}
 revoke(fingerprint){this.db.prepare("UPDATE trusted_devices SET status='revoked' WHERE fingerprint=?").run(fingerprint);this.db.prepare('UPDATE devices SET revoked_at=? WHERE device_key=?').run(new Date().toISOString(),fingerprint);if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_chat_viewer'").get())this.db.prepare('DELETE FROM device_chat_viewer WHERE fingerprint=?').run(fingerprint);}
 proof(encoded,{signature,...data}){
  const p=this.publicKey(encoded),time=Number(data.time),nonce=data.nonce;
  if(!Number.isSafeInteger(time)||Math.abs(Date.now()-time)>180000)throw deny('手机时间与电脑相差较大，请打开系统自动时间后重试。');
  if(typeof nonce!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(nonce)||typeof signature!=='string'||signature.length>256)throw deny();
  let ok=false;try{ok=verify('sha256',Buffer.from(signingText(data)),p.key,Buffer.from(signature,'base64'));}catch{}if(!ok)throw deny();
  const id=p.fingerprint+':'+nonce;
  this.db.prepare('DELETE FROM device_nonces WHERE expires_at<?').run(Date.now());
  if(this.db.prepare('SELECT 1 FROM device_nonces WHERE id=?').get(id))throw new DeviceSecurityError(409,'DEVICE_REPLAY','请求已处理，请刷新后重试。');
  if(this.db.prepare('SELECT count(*) AS n FROM device_nonces').get().n>=10000)throw new DeviceSecurityError(429,'DEVICE_BUSY','设备验证繁忙，请稍后重试。');
  this.db.prepare('INSERT INTO device_nonces VALUES(?,?)').run(id,time+180000);return p;
 }
}
