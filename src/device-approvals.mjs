import {randomUUID} from 'node:crypto';
import {reviewerValue} from './execution-settings.mjs';

export class DeviceApprovalError extends Error{
 constructor(message,status=400,code='INVALID_REVIEWER'){super(message);this.status=status;this.code=code;}
}
export function validateReviewer(value){if(value==='chat_only')return value;try{return reviewerValue(value);}catch{throw new DeviceApprovalError('审批方式只能是手动审批、帮我批准或仅聊天（允许联网）。');}}
export class DeviceApprovals{
 constructor(store,defaultReviewer,currentGeneration){this.db=store.db;this.defaultReviewer=defaultReviewer;this.currentGeneration=currentGeneration;
  this.db.exec('CREATE TABLE IF NOT EXISTS device_approvals(fingerprint TEXT PRIMARY KEY,generation TEXT NOT NULL,reviewer TEXT NOT NULL,revision TEXT NOT NULL)');
  if(!this.db.prepare('PRAGMA table_info(device_approvals)').all().some(c=>c.name==='mode_revision'))this.db.exec('ALTER TABLE device_approvals ADD COLUMN mode_revision TEXT');
  for(const d of this.db.prepare('SELECT fingerprint,generation FROM trusted_devices').all())this.initialize(d.fingerprint,d.generation);
 }
 initialize(fingerprint,generation){const row=this.db.prepare('SELECT * FROM device_approvals WHERE fingerprint=?').get(fingerprint);if(!row||row.generation!==generation)this.write(fingerprint,generation,validateReviewer(this.defaultReviewer()));else if(!row.mode_revision)this.db.prepare('UPDATE device_approvals SET mode_revision=? WHERE fingerprint=?').run(randomUUID(),fingerprint);}
 write(fingerprint,generation,reviewer){const revision=randomUUID(),previous=this.db.prepare('SELECT * FROM device_approvals WHERE fingerprint=?').get(fingerprint),modeRevision=!previous||previous.generation!==generation||(previous.reviewer==='chat_only')!==(reviewer==='chat_only')?randomUUID():previous.mode_revision||randomUUID();this.db.prepare('INSERT INTO device_approvals(fingerprint,generation,reviewer,revision,mode_revision) VALUES(?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET generation=excluded.generation,reviewer=excluded.reviewer,revision=excluded.revision,mode_revision=excluded.mode_revision').run(fingerprint,generation,reviewer,revision,modeRevision);return{approvalsReviewer:reviewer,revision,modeRevision};}
 view(fingerprint,generation){this.initialize(fingerprint,generation);const row=this.db.prepare('SELECT * FROM device_approvals WHERE fingerprint=?').get(fingerprint);return{approvalsReviewer:row.reviewer,revision:row.revision,modeRevision:row.mode_revision};}
 get(device){const d=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(device.device_key);
  if(!d||d.status!=='approved'||d.generation!==device.auth_generation||(this.currentGeneration&&this.currentGeneration()!==d.generation))throw new DeviceApprovalError('设备批准已失效。',401,'AUTH_INVALID');
  const value=this.view(d.fingerprint,d.generation);try{validateReviewer(value.approvalsReviewer);}catch{throw new DeviceApprovalError('手机审批配置损坏，请在电脑重新设置。',403,'APPROVAL_SETTINGS_INVALID');}return value;
 }
 set(fingerprint,generation,reviewer){const d=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(fingerprint);if(!d||d.generation!==generation)throw new DeviceApprovalError('设备请求已失效。');return this.write(fingerprint,generation,validateReviewer(reviewer));}
}
