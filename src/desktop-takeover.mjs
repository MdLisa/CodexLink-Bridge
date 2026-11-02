import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

export class TakeoverError extends Error{constructor(code,message,status=409){super(message);this.status=status;this.code=code;}}
export class TakeoverPermissions{
 constructor(store,currentGeneration){this.db=store.db;this.currentGeneration=currentGeneration;this.db.exec('CREATE TABLE IF NOT EXISTS device_takeover(fingerprint TEXT PRIMARY KEY,generation TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))');}
 view(fingerprint,generation){const r=this.db.prepare('SELECT * FROM device_takeover WHERE fingerprint=?').get(fingerprint);return Boolean(r&&r.generation===generation&&r.enabled===1);}
 get(device){const d=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(device.device_key);if(!d||d.status!=='approved'||d.generation!==device.auth_generation||this.currentGeneration()!==d.generation)throw new TakeoverError('AUTH_INVALID','设备批准已失效。',401);return this.view(d.fingerprint,d.generation);}
 set(fingerprint,generation,enabled){const d=this.db.prepare('SELECT * FROM trusted_devices WHERE fingerprint=?').get(fingerprint);if(!d||d.generation!==generation||generation!==this.currentGeneration()||typeof enabled!=='boolean')throw new TakeoverError('INVALID_TAKEOVER_SETTING','设备或接管设置无效。',400);this.db.prepare('INSERT INTO device_takeover VALUES(?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET generation=excluded.generation,enabled=excluded.enabled').run(fingerprint,generation,enabled?1:0);return enabled;}
 require(device){if(!this.get(device))throw new TakeoverError('TAKEOVER_DENIED','这台手机未获准退出电脑端，请在电脑设备管理中开启接管权限。',403);}
}

export class WindowsDesktopController{
 constructor({protectedPids=()=>[],platform=process.platform,spawnProcess=spawn}={}){this.protectedPids=protectedPids;this.supported=platform==='win32';this.spawnProcess=spawnProcess;}
 async invoke(action,desktops){
  if(!this.supported)throw new TakeoverError('TAKEOVER_UNSUPPORTED','此试用版只支持 Windows 商店版 Codex。');
  const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const helper=fileURLToPath(new URL('../scripts/desktop-control.ps1',import.meta.url));
  return new Promise((resolve,reject)=>{
   const child=this.spawnProcess(exe,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Action',action],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',settled=false;
   const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);};
   const timer=setTimeout(()=>{child.kill();fail(new TakeoverError('DESKTOP_CLOSE_TIMEOUT','电脑端退出检查超时。未强制终止桌面进程，请刷新原会话确认状态。'));},25000);
   child.on('error',()=>fail(new TakeoverError('DESKTOP_CONTROL_FAILED','无法启动电脑端接管辅助程序。')));
   child.stdout.setEncoding('utf8');child.stdout.on('data',b=>{output+=b;if(output.length>128*1024){child.kill();fail(new TakeoverError('DESKTOP_CONTROL_FAILED','电脑端识别结果异常。'));}});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
   child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);let result;try{result=JSON.parse(output.replace(/^\uFEFF/,'').trim());}catch{}
    if(code!==0||!result||result.error){
     const messages={DESKTOP_CHANGED:'电脑端进程发生变化，请重新准备接管。',DESKTOP_NOT_INTERACTIVE:'电脑已锁屏或当前桌面不可操作，请先解锁电脑再接管。',DESKTOP_QUIT_UNAVAILABLE:'没有找到可执行退出命令的 Codex 窗口，请先从托盘打开电脑端。',DESKTOP_FOCUS_FAILED:'无法激活电脑端 Codex 窗口，未发送退出快捷键，请在电脑端检查。',DESKTOP_QUIT_INPUT_FAILED:'未能安全发送退出命令，请检查电脑是否有弹窗、按键未松开或权限不一致。',DESKTOP_EXIT_TIMEOUT:'已发送退出程序命令，但电脑端后台仍未退出；会话尚未释放，没有强制结束进程。'};
     const known=action==='close'&&messages[result?.errorCode];reject(new TakeoverError(known?result.errorCode:'DESKTOP_CONTROL_FAILED',known||(action==='close'?'电脑端未能正常退出；没有强制关闭，请重新检查。':'无法可靠识别可退出的 Windows 商店版 Codex，请在电脑检查安装和后台启动方式。')));return;
    }resolve(result);
   });
   child.stdin.end(JSON.stringify({bridgePid:process.pid,protectedPids:this.protectedPids().filter(Number.isSafeInteger),desktops}));
  });
 }
 async inspect(){const result=await this.invoke('inspect');if(!Array.isArray(result.desktops)||!result.desktops.length)throw new TakeoverError('DESKTOP_NOT_FOUND','没有找到能安全退出的电脑端 Codex。请检查是否由其他 CLI 占用，或后台是否从桌面版内部启动。');if(result.desktops.some(d=>!d.closable))throw new TakeoverError('DESKTOP_NOT_CLOSABLE','电脑端没有可正常关闭的窗口，不能安全自动退出。');return result.desktops;}
 async close(desktops){const result=await this.invoke('close',desktops);if(result.closed!==true)throw new TakeoverError('DESKTOP_CONTROL_FAILED','未能确认电脑端已退出。');}
}

export class TakeoverManager{
 constructor({bridge,permissions,controller,validDevice=()=>true,clock=()=>Date.now(),wait=sleep}){Object.assign(this,{bridge,permissions,controller,validDevice,clock,wait});this.operations=new Map();this.running=false;this.stopped=false;}
 authorize(device){if(this.stopped)throw new TakeoverError('BRIDGE_BUSY','后台正在关闭。',503);if(!this.validDevice(device))throw new TakeoverError('AUTH_INVALID','登录已失效。',401);this.permissions.require(device);}
 prune(){for(const [id,op]of this.operations)if(!op.promise&&op.keepUntil<this.clock())this.operations.delete(id);}
 async prepare(threadId,device){
  await this.bridge.info(threadId,device);
  try{await this.bridge.acquire(threadId,device);return{acquired:true,threadId};}catch(e){if(e.code!=='THREAD_BUSY')throw e;}
  this.authorize(device);if(this.running)throw new TakeoverError('TAKEOVER_BUSY','另一项接管正在执行，请稍后刷新。');
  this.prune();if(this.operations.size>=100)throw new TakeoverError('TAKEOVER_BUSY','待确认接管过多，请稍后重试。');
  const desktops=await this.controller.inspect();this.authorize(device);await this.bridge.info(threadId,device);
  const id=randomUUID(),expiresAt=this.clock()+60000;this.operations.set(id,{id,threadId,device,desktops,expiresAt,keepUntil:expiresAt,state:'prepared'});
  return{acquired:false,threadId,confirmationId:id,expiresAt,desktopCount:desktops.length};
 }
 find(id,threadId,device){const op=this.operations.get(id);if(!op||op.threadId!==threadId||op.device.device_key!==device.device_key||op.device.auth_generation!==device.auth_generation)throw new TakeoverError('TAKEOVER_NOT_FOUND','接管确认不存在或不属于本机，请重新准备。',404);return op;}
 view(op){return{operationId:op.id,threadId:op.threadId,state:op.state,error:op.error??null,errorCode:op.errorCode??null,desktopClosed:op.desktopClosed===true};}
 confirm(threadId,id,device){
  this.authorize(device);const op=this.find(id,threadId,device);
  if(op.state!=='prepared')return this.view(op);
  if(op.expiresAt<this.clock())throw new TakeoverError('TAKEOVER_EXPIRED','接管确认已过期，请重新准备。',410);
  if(this.running)throw new TakeoverError('TAKEOVER_BUSY','另一项接管正在执行，请稍后刷新。');
  this.running=true;op.state='checking';op.keepUntil=this.clock()+300000;
  op.promise=this.run(op,device).catch(e=>{op.state='failed';op.error=e.status?e.message:'接管失败，请刷新原会话确认状态。';op.errorCode=e.code||'TAKEOVER_FAILED';}).finally(()=>{this.running=false;op.promise=null;op.keepUntil=this.clock()+300000;});
  return this.view(op);
 }
 async run(op,device){
  await this.bridge.info(op.threadId,device);this.authorize(device);
  try{await this.bridge.acquire(op.threadId,device);op.state='succeeded';return;}catch(e){if(e.code!=='THREAD_BUSY')throw e;}
  await this.bridge.info(op.threadId,device);this.authorize(device);op.state='closingDesktop';await this.controller.close(op.desktops);op.desktopClosed=true;op.state='acquiring';
  for(let attempt=0;attempt<8;attempt++){
   this.authorize(device);
   try{await this.bridge.acquire(op.threadId,device);op.state='succeeded';return;}catch(e){if(e.code!=='THREAD_BUSY')throw e;}
   await this.wait(500);
  }
  throw new TakeoverError('THREAD_BUSY','电脑端已退出，但该会话仍被其他进程占用。没有删除会话锁或复制聊天。');
 }
 async status(threadId,id,device){this.authorize(device);const op=this.find(id,threadId,device);await this.bridge.info(threadId,device);return this.view(op);}
 async close(){this.stopped=true;await Promise.allSettled([...this.operations.values()].map(op=>op.promise).filter(Boolean));}
}
