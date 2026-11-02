import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
export const now=()=>new Date().toISOString();
export class Store {
  constructor(dir){
    mkdirSync(dir,{recursive:true});this.db=new DatabaseSync(path.join(dir,'bridge.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT,token_hash TEXT UNIQUE,created_at TEXT,revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,mime TEXT,size INTEGER,sha256 TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS bridge_threads(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,thread_id TEXT,message_id TEXT,payload_hash TEXT,payload TEXT,state TEXT,turn_id TEXT,error TEXT,created_at TEXT,updated_at TEXT,UNIQUE(thread_id,message_id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT,data TEXT,created_at TEXT);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS file_uploads(id TEXT PRIMARY KEY,name TEXT,mime TEXT,size INTEGER,sha256 TEXT,root TEXT,created_at TEXT)');
    if(!this.db.prepare('PRAGMA table_info(devices)').all().some(c=>c.name==='auth_generation'))this.db.exec('ALTER TABLE devices ADD COLUMN auth_generation TEXT');
    if(!this.db.prepare('PRAGMA table_info(devices)').all().some(c=>c.name==='device_key'))this.db.exec('ALTER TABLE devices ADD COLUMN device_key TEXT');
    for(const column of ['device_key','auth_generation','approvals_reviewer'])if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name===column))this.db.exec('ALTER TABLE jobs ADD COLUMN '+column+' TEXT');
    for(const table of ['jobs','events'])if(!this.db.prepare('PRAGMA table_info('+table+')').all().some(c=>c.name==='execution_mode'))this.db.exec("ALTER TABLE "+table+" ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'operate'");
    if(!this.db.prepare('PRAGMA table_info(events)').all().some(c=>c.name==='workspace'))this.db.exec('ALTER TABLE events ADD COLUMN workspace TEXT');
    for(const column of ['audience_key','audience_generation'])if(!this.db.prepare('PRAGMA table_info(events)').all().some(c=>c.name===column))this.db.exec('ALTER TABLE events ADD COLUMN '+column+' TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS attachment_owners(id TEXT PRIMARY KEY,device_key TEXT,generation TEXT); CREATE TABLE IF NOT EXISTS attachment_threads(id TEXT,thread_id TEXT,workspace TEXT,PRIMARY KEY(id,thread_id))');
    if(!this.db.prepare('PRAGMA table_info(attachment_owners)').all().some(c=>c.name==='execution_mode'))this.db.exec("ALTER TABLE attachment_owners ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'operate'");
  }
  activeDevice(id){return this.db.prepare('SELECT id,auth_generation,device_key FROM devices WHERE id=? AND revoked_at IS NULL').get(id);}
  recover(){this.db.prepare("UPDATE jobs SET state='needsReview',error=?,updated_at=? WHERE state IN ('starting','running','waitingApproval') OR (state='queued' AND device_key IS NULL)").run('连接意外中断或旧任务缺少设备归属，请检查聊天记录；系统不会自动重做该任务。',now());}
  addDevice(id,name,hash,generation=null,deviceKey=null){this.db.prepare('INSERT INTO devices(id,name,token_hash,created_at,revoked_at,auth_generation,device_key) VALUES(?,?,?,?,NULL,?,?)').run(id,name,hash,now(),generation,deviceKey);}
  auth(hash){return this.db.prepare('SELECT id,name,created_at,auth_generation,device_key FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(hash);}
  devices(){return this.db.prepare('SELECT id,name,created_at,revoked_at FROM devices ORDER BY created_at').all();}
  revoke(id){return this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(),id).changes;}
  addUpload(u){this.db.prepare('INSERT INTO uploads VALUES(?,?,?,?,?)').run(u.id,u.mime,u.size,u.sha256,now());}
  upload(id){return this.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);}
  fileUpload(id){return this.db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id);}
  addFileUpload(r){this.db.prepare('INSERT INTO file_uploads VALUES(?,?,?,?,?,?,?)').run(r.id,r.name,r.mime,r.size,r.sha256,r.root,now());}
  jobForTurn(thread,turn){return this.db.prepare('SELECT * FROM jobs WHERE thread_id=? AND turn_id=? ORDER BY rowid LIMIT 1').get(thread,turn);}
  ownThread(id){this.db.prepare('INSERT OR IGNORE INTO bridge_threads VALUES(?)').run(id);}
  isOwnThread(id){return Boolean(this.db.prepare('SELECT 1 FROM bridge_threads WHERE id=?').get(id));}
  existing(thread,id){return this.db.prepare('SELECT * FROM jobs WHERE thread_id=? AND message_id=?').get(thread,id);}
  job(id){return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);}
  insertJob(j){const t=now();this.db.prepare('INSERT INTO jobs(id,thread_id,message_id,payload_hash,payload,state,turn_id,error,created_at,updated_at,device_key,auth_generation,approvals_reviewer) VALUES(?,?,?,?,?,\'queued\',NULL,NULL,?,?,?,?,?)').run(j.id,j.threadId,j.messageId,j.hash,JSON.stringify(j.payload),t,t,j.deviceKey??null,j.authGeneration??null,j.approvalsReviewer??null);return this.job(j.id);}
  snapshotReviewer(id,reviewer){this.db.prepare('UPDATE jobs SET approvals_reviewer=? WHERE id=? AND approvals_reviewer IS NULL').run(reviewer,id);return this.job(id).approvals_reviewer;}
  ownAttachment(id,device,mode='operate'){this.db.prepare('INSERT OR IGNORE INTO attachment_owners(id,device_key,generation,execution_mode) VALUES(?,?,?,?)').run(id,device.device_key,device.auth_generation,mode);}
  attachmentOwner(id){return this.db.prepare('SELECT * FROM attachment_owners WHERE id=?').get(id);}
  bindAttachment(id,thread,workspace){this.db.prepare('INSERT INTO attachment_threads VALUES(?,?,?) ON CONFLICT(id,thread_id) DO UPDATE SET workspace=excluded.workspace').run(id,thread,workspace);}
  attachmentThreads(id){return this.db.prepare('SELECT workspace FROM attachment_threads WHERE id=?').all(id);}
  updateJob(id,state,{turnId,error}={}){this.db.prepare('UPDATE jobs SET state=?,turn_id=COALESCE(?,turn_id),error=?,updated_at=? WHERE id=?').run(state,turnId??null,error??null,now(),id);return this.job(id);}
  jobs(thread){return thread?this.db.prepare('SELECT * FROM jobs WHERE thread_id=? ORDER BY created_at DESC LIMIT 100').all(thread):this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100').all();}
  queued(mode='operate'){return mode===null?this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY rowid").all():this.db.prepare("SELECT * FROM jobs WHERE state='queued' AND execution_mode=? ORDER BY rowid").all(mode);}
  next(thread){return this.db.prepare("SELECT * FROM jobs WHERE thread_id=? AND state='queued' ORDER BY rowid LIMIT 1").get(thread);}
  event(type,data,workspace=null,audience={}){const time=now(),executionMode=audience.executionMode||'operate';const r=this.db.prepare('INSERT INTO events(type,data,created_at,workspace,audience_key,audience_generation,execution_mode) VALUES(?,?,?,?,?,?,?)').run(type,JSON.stringify(data),time,workspace,audience.deviceKey??null,audience.generation??null,executionMode);const seq=Number(r.lastInsertRowid);if(seq%100===0)this.db.prepare('DELETE FROM events WHERE seq<?').run(seq-5000);return{seq,type,data,time,workspace,audienceKey:audience.deviceKey??null,audienceGeneration:audience.generation??null,executionMode};}
  events(after=0){return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 5001').all(after).map(r=>({seq:r.seq,type:r.type,data:JSON.parse(r.data),time:r.created_at,workspace:r.workspace,audienceKey:r.audience_key,audienceGeneration:r.audience_generation,executionMode:r.execution_mode}));}
  eventRange(){return this.db.prepare('SELECT min(seq) AS first,max(seq) AS last FROM events').get();}
  close(){this.db.close();}
}
