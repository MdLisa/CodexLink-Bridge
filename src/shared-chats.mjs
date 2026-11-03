import {randomUUID} from 'node:crypto';
import {BridgeError} from './bridge.mjs';

// Independent of operation approvals: viewing never grants tools or coding chat access.
export class SharedChatPermissions {
  constructor(store,currentGeneration) {
    this.db=store.db;this.currentGeneration=currentGeneration;
    this.db.exec('CREATE TABLE IF NOT EXISTS device_chat_viewer(fingerprint TEXT PRIMARY KEY,generation TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),revision TEXT NOT NULL)');
  }
  view(fingerprint,generation) {
    const row=this.db.prepare('SELECT * FROM device_chat_viewer WHERE fingerprint=? AND generation=?').get(fingerprint,generation);
    return {enabled:row?.enabled===1,revision:row?.revision||'disabled'};
  }
  get(device) {
    const row=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(device.device_key);
    if(!row||row.status!=='approved'||row.generation!==device.auth_generation||this.currentGeneration()!==row.generation)throw new BridgeError(401,'AUTH_INVALID','设备批准已失效。');
    return this.view(row.fingerprint,row.generation);
  }
  set(fingerprint,generation,enabled) {
    const row=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(fingerprint);
    if(!row||row.status!=='approved'||row.generation!==generation||generation!==this.currentGeneration()||typeof enabled!=='boolean')throw new BridgeError(400,'INVALID_SHARED_CHAT_SETTING','请选择已批准的手机，并使用有效的查看权限设置。');
    const revision=randomUUID();
    this.db.prepare('INSERT INTO device_chat_viewer VALUES(?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET generation=excluded.generation,enabled=excluded.enabled,revision=excluded.revision').run(fingerprint,generation,enabled?1:0,revision);
    return {enabled,revision};
  }
}

export class SharedChatReader {
  constructor({store,chatOnly,permissions,validViewer}) { Object.assign(this,{store,chatOnly,permissions,validViewer}); }
  require(device) {
    if(!this.validViewer(device))throw new BridgeError(401,'AUTH_INVALID','登录已失效。');
    if(!this.permissions.get(device).enabled)throw new BridgeError(403,'SHARED_CHAT_DENIED','这台手机未获准查看其他手机的仅聊天会话。');
  }
  source(threadId,device) {
    this.require(device);
    const thread=this.store.db.prepare("SELECT t.*,d.name AS owner_name FROM chat_only_threads t JOIN trusted_devices d ON d.fingerprint=t.device_key AND d.generation=t.generation WHERE t.id=? AND t.generation=? AND t.device_key<>? AND d.status='approved'").get(threadId,device.auth_generation,device.device_key);
    const source=thread&&{device_key:thread.device_key,auth_generation:thread.generation};
    if(!source||!this.chatOnly.validOwner(source))throw new BridgeError(403,'SHARED_CHAT_UNAVAILABLE','这个仅聊天会话已不可查看，请刷新列表。');
    return {thread,source};
  }
  view(thread) { return {...this.chatOnly.view(thread),control:'sharedReadOnly',owner:{name:thread.owner_name,code:thread.device_key.slice(-8).toUpperCase()}}; }
  list(cursor,device) {
    this.require(device);const offset=cursor?Number(cursor):0;
    if(!Number.isSafeInteger(offset)||offset<0)throw new BridgeError(400,'INVALID_CURSOR','聊天分页无效。');
    const rows=this.store.db.prepare(`SELECT t.*,d.name AS owner_name FROM chat_only_threads t
      JOIN trusted_devices d ON d.fingerprint=t.device_key AND d.generation=t.generation AND d.status='approved'
      JOIN device_approvals a ON a.fingerprint=t.device_key AND a.generation=t.generation AND a.reviewer='chat_only'
      WHERE t.generation=? AND t.device_key<>? ORDER BY t.updated_at DESC,t.id LIMIT 51 OFFSET ?`).all(device.auth_generation,device.device_key,offset);
    return {threads:rows.slice(0,50).map(t=>this.view(t)),nextCursor:rows.length>50?String(offset+50):null};
  }
  info(id,device) { return this.view(this.source(id,device).thread); }
  async history(id,params,device) {
    const {source}=this.source(id,device);
    // Viewing an untouched draft must not create or recover a conversation for its owner.
    const hasJobs=this.store.db.prepare('SELECT 1 FROM jobs WHERE thread_id=? LIMIT 1').get(id);
    const result=hasJobs?await this.chatOnly.history(id,{...params,readOnly:true},source):{turns:[],nextCursor:null,liveStateFromHistory:false};
    this.source(id,device);return result;
  }
  image(threadId,imageId,device) {
    const {source}=this.source(threadId,device),owner=this.store.attachmentOwner(imageId);
    const binding=this.store.db.prepare("SELECT 1 FROM attachment_threads WHERE id=? AND thread_id=? AND workspace='chat_only'").get(imageId,threadId);
    if(!binding||owner?.execution_mode!=='chat_only'||owner.device_key!==source.device_key||owner.generation!==source.auth_generation)throw new BridgeError(403,'SHARED_IMAGE_DENIED','这张图片不属于可查看的会话。');
    const image=this.chatOnly.imageFile(imageId);
    if(!image)throw new BridgeError(404,'UPLOAD_NOT_FOUND','图片已不可用，电脑上的原图可能已删除。');
    return image;
  }
}
