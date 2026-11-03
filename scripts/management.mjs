import {spawn} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync,rmSync,openSync,readSync,closeSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';
import {Accounts} from '../src/accounts.mjs';
import {DeviceSecurity} from '../src/device-security.mjs';
import {ProjectAccess,validateScope,directory} from '../src/project-access.mjs';
import {DeviceApprovals,validateReviewer} from '../src/device-approvals.mjs';
import {TakeoverPermissions} from '../src/desktop-takeover.mjs';
import {SharedChatPermissions} from '../src/shared-chats.mjs';
import {defaultDeviceSettings,setExecutionSettings,defaultReviewerValue} from '../src/execution-settings.mjs';
import {configuredFileRoot} from '../src/files.mjs';
import {startupSetting,cancelPendingStartup,startupCancelled,repairStartupLocation} from './startup-settings.mjs';
import {saveConfig,readConfig} from './tunnel-config.mjs';

const scripts=path.dirname(fileURLToPath(import.meta.url));
export const defaultDataDir=()=>process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge');
export function readJson(dir,name){try{return JSON.parse(readFileSync(path.join(dir,name),'utf8'));}catch{return null;}}
export function saveJson(dir,name,value){
 mkdirSync(dir,{recursive:true});const temporary=path.join(dir,name+'.'+randomUUID()+'.tmp');
 try{writeFileSync(temporary,JSON.stringify(value,null,2),{flag:'wx'});renameSync(temporary,path.join(dir,name));}finally{rmSync(temporary,{force:true});}
}
function localAddress(value){try{const u=new URL(value);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash?u.origin:null;}catch{return null;}}
async function health(address){try{if(!localAddress(address))return null;const r=await fetch(address+'/health',{signal:AbortSignal.timeout(1800),redirect:'error'});return r.ok?await r.json():null;}catch{return null;}}
export function runScript(file,args,dir){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[path.join(scripts,file),...args],{windowsHide:true,env:{...process.env,BRIDGE_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let output='',settled=false;
 const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(output.trim());};
 const timer=setTimeout(()=>{child.kill();finish(Error('操作超时，请刷新状态并查看诊断日志。'));},135000);
 for(const stream of [child.stdout,child.stderr]){stream.setEncoding('utf8');stream.on('data',text=>{output=(output+text).slice(-65536);});}
 child.on('error',()=>finish(Error('管理程序无法启动，请检查 Node.js 和程序文件。')));child.on('close',code=>finish(code===0?null:Error(output.trim()||'操作失败，请查看日志。')));
});}
export function redact(text){return String(text)
 .replace(/("(?:adminToken|adminSecret|tokenProtected|access_token|refresh_token|id_token|password|token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,'$1"[已隐藏]"')
 .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9_.~+/=-]+/gi,'$1[已隐藏]')
 .replace(/((?:--token|TUNNEL_TOKEN)\s*[=:\s]\s*)["']?[^\s"']+/gi,'$1[已隐藏]')
 .replace(/((?:["']?(?:adminToken|adminSecret|tokenProtected|access_token|refresh_token|id_token|password|token)["']?)\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi,'$1[已隐藏]')
 .replace(/(\bpassword\s*[:=]\s*)[^\r\n]*/gi,'$1[已隐藏]')
 .replace(/\beyJ[A-Za-z0-9_+/=-]{60,}\b/g,'[已隐藏的凭据]');}

export class Management{
 constructor({dir=defaultDataDir(),run=runScript,startup=startupSetting}={}){this.dir=path.resolve(dir);this.run=(file,args)=>run(file,args,this.dir);this.startup=startup;this.busy=false;this.startupCache=null;}
 options(){const saved=readJson(this.dir,'console-settings.json'),runtime=readJson(this.dir,'runtime.json');let port=18766;try{port=Number(new URL(runtime.address).port)||port;}catch{}return{workspace:saved?.workspace||runtime?.roots?.[0]||path.join(os.homedir(),'Documents','Codex'),port:Number.isInteger(saved?.port)&&saved.port>0&&saved.port<65536?saved.port:port};}
 async overview(){
  const runtime=readJson(this.dir,'runtime.json'),external=readJson(this.dir,'external.json'),fixed=readJson(this.dir,'fixed-tunnel.json');
  const [backendHealth,tunnelHealth]=await Promise.all([health(runtime?.address),health(external?.control)]);
  const backend=Boolean(runtime&&backendHealth?.service==='codex-phone-bridge'&&backendHealth.instanceId===runtime.instanceId),tunnel=Boolean(external&&tunnelHealth?.instanceId===external.instanceId&&tunnelHealth.ready);
  return{backend,online:backend&&backendHealth.ready===true,tunnel,address:external?.url||(fixed?.hostname?'https://'+fixed.hostname:''),runtime:backend?{roots:runtime.roots,address:runtime.address,version:backendHealth.version}:null,instanceId:backend?runtime.instanceId:null};
 }
 devices(){
  const account=new Accounts(this.dir).current();if(!account)return[];
  const store=new Store(this.dir);
  try{const security=new DeviceSecurity(store),exists=table=>Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
   const row=(table,d)=>exists(table)?store.db.prepare('SELECT * FROM '+table+' WHERE fingerprint=? AND generation=?').get(d.fingerprint,d.generation):null;
   return security.list().filter(d=>d.generation===account.generation).map(d=>{
    let scope;try{scope=JSON.parse(row('device_project_access',d)?.policy||'null');}catch{}
    return{fingerprint:d.fingerprint,generation:d.generation,name:d.name,note:d.note,code:d.code,status:d.status,createdAt:d.created_at,
     scope:scope||{mode:'directories',roots:[this.options().workspace]},reviewer:row('device_approvals',d)?.reviewer||defaultDeviceSettings(this.dir).approvalsReviewer,
     takeover:row('device_takeover',d)?.enabled===1,viewer:row('device_chat_viewer',d)?.enabled===1,
     activeTasks:Number(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE device_key=? AND state IN ('starting','running','waitingApproval')").get(d.fingerprint).n)};
   });
  }finally{store.close();}
 }
 async state(){
  const connection=await this.overview(),account=new Accounts(this.dir).current();let startup=null,startupError='',devices=[],deviceError='';
  try{if(!this.startupCache||this.startupCache.until<Date.now())this.startupCache={value:this.startup(),until:Date.now()+30000};startup=this.startupCache.value;}catch{startupError='无法读取开机自启状态';}
  try{devices=this.devices();}catch{deviceError='设备配置暂时无法读取，请查看本机日志或刷新。';}
  return{version:'0.10.2',...connection,busy:this.busy,settings:{...this.options(),attachments:configuredFileRoot(this.dir),username:account?.username||'',defaultReviewer:defaultDeviceSettings(this.dir).approvalsReviewer,hostname:readJson(this.dir,'fixed-tunnel.json')?.hostname||'',fixedConfigured:Boolean(readJson(this.dir,'fixed-tunnel.json')),startup:startup?.enabled??null,startupError},devices,deviceError};
 }
 assertOffline(){if(existsSync(path.join(this.dir,'runtime.json'))||existsSync(path.join(this.dir,'bridge.lock')))throw Error('后台状态无法确认，请从原控制台停止后台或完成更新后重试；没有离线改写权限。');}
 async admin(route,body,{optional=false}={}){
  const runtime=readJson(this.dir,'runtime.json');if(!runtime){if(optional){this.assertOffline();return null;}throw Error('电脑后台尚未启动。');}
  const h=await health(runtime.address);if(!localAddress(runtime.address)||h?.instanceId!==runtime.instanceId||h?.service!=='codex-phone-bridge')throw Error('无法确认当前后台身份，请先检查或停止后台。');
  if(route==='/admin/devices'&&!h.localDeviceManagement)throw Error('当前运行的是旧版后台，请在“概览”停止并启动连接，再管理设备备注、批准或删除。');
  const r=await fetch(runtime.address+route,{method:body===undefined?'GET':'POST',headers:{'x-bridge-admin':runtime.adminToken,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)});
  const result=await r.json();if(!r.ok)throw Error(result.error?.message||'当前后台不支持此操作，请重启更新后的后台。');return result;
 }
 async device(action,b){
  const account=new Accounts(this.dir).current(),d=this.devices().find(d=>d.fingerprint===b.fingerprint&&d.generation===b.generation);
  if(!account||!d)throw Error('设备请求已失效，请刷新后重新选择。');
  const data={fingerprint:d.fingerprint,generation:d.generation};let route='/admin/devices',body={...data,action};
  if(action==='scope'){const scope=validateScope(b.scope);route='/admin/project-access';body={...data,...scope};}
  else if(action==='reviewer'){route='/admin/device-approvals';body={...data,approvalsReviewer:validateReviewer(b.reviewer)};}
  else if(action==='takeover'||action==='viewer'){if(typeof b.enabled!=='boolean')throw Error('权限设置无效。');route=action==='takeover'?'/admin/desktop-takeover':'/admin/shared-chats';body={...data,enabled:b.enabled};}
  else if(action==='note')body.note=b.note;
  else if(action==='approve'){if(b.code!==d.code)throw Error('请核对手机上的核对码。');body.code=b.code;}
  else if(!['delete','revoke'].includes(action))throw Error('设备操作无效。');
  const result=await this.admin(route,body,{optional:true});if(result)return;
  const store=new Store(this.dir);try{
   const security=new DeviceSecurity(store),current=()=>new Accounts(this.dir).current()?.generation;
   if(action==='note')security.note(d.fingerprint,d.generation,b.note);
   else if(action==='delete')security.forget(d.fingerprint,d.generation);
   else if(action==='revoke'){if(d.activeTasks)throw Error('该手机仍有任务正在执行。');for(const j of store.queued(null))if(j.device_key===d.fingerprint)store.updateJob(j.id,'cancelled',{error:'设备已撤销。'});security.revoke(d.fingerprint);}
   else if(action==='scope')new ProjectAccess(store,[directory(this.options().workspace)],current).set(d.fingerprint,d.generation,b.scope);
   else if(action==='reviewer'){
    const approvals=new DeviceApprovals(store,()=>defaultDeviceSettings(this.dir).approvalsReviewer,current),old=approvals.view(d.fingerprint,d.generation).approvalsReviewer;
    if((old==='chat_only')!==(b.reviewer==='chat_only')){if(d.activeTasks)throw Error('请先停止或等待该手机任务结束。');for(const j of store.queued(null))if(j.device_key===d.fingerprint)store.updateJob(j.id,'cancelled',{error:'聊天模式已切换。'});}
    approvals.set(d.fingerprint,d.generation,b.reviewer);
   }else if(action==='takeover')new TakeoverPermissions(store,current).set(d.fingerprint,d.generation,b.enabled);
   else if(action==='viewer')new SharedChatPermissions(store,current).set(d.fingerprint,d.generation,b.enabled);
   else if(action==='approve'){
    new ProjectAccess(store,[directory(this.options().workspace)],current).initialize(d.fingerprint,d.generation);
    new DeviceApprovals(store,()=>defaultDeviceSettings(this.dir).approvalsReviewer,current).initialize(d.fingerprint,d.generation);
    security.approve(d.fingerprint,b.code,d.generation);
   }
  }finally{store.close();}
 }
 async start({autoStartedAt=0,onProgress=()=>{}}={}){
  if(!autoStartedAt)cancelPendingStartup(this.dir);
  const check=()=>{if(autoStartedAt&&startupCancelled(autoStartedAt,this.dir))throw Error('本次自动启动已取消。');};check();
  const selected=this.options();directory(selected.workspace);saveJson(this.dir,'console-settings.json',selected);
  onProgress('正在启动电脑后台……');await this.run('manage.mjs',['start','--workspace',selected.workspace,'--host','0.0.0.0','--port',String(selected.port)]);check();
  onProgress('正在连接外网……');await this.run('external.mjs',['start']);check();
 }
 async stop({onProgress=()=>{}}={}){cancelPendingStartup(this.dir);saveJson(this.dir,'console-settings.json',this.options());onProgress('正在关闭外网……');await this.run('external.mjs',['stop']);onProgress('正在停止电脑后台……');await this.run('manage.mjs',['stop']);}
 async action(action,b={}){
  if(this.busy)throw Error('上一项操作仍在进行，请等待完成。');this.busy=true;
  try{
   if(action==='start')await this.start();
   else if(action==='stop')await this.stop();
   else if(action==='restart'){await this.stop();await this.start();}
   else if(action.startsWith('device.'))await this.device(action.slice(7),b);
   else if(action==='settings'){
    const workspace=directory(b.workspace),port=Number(b.port);if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口必须为 1～65535。');
    if(typeof b.attachments!=='string'||!path.isAbsolute(b.attachments))throw Error('附件目录需要填写完整路径。');
    defaultReviewerValue(b.defaultReviewer);
    const attachments=path.resolve(b.attachments);mkdirSync(attachments,{recursive:true});if(!statSync(attachments).isDirectory())throw Error('附件目录无效。');
    saveJson(this.dir,'console-settings.json',{workspace,port});saveJson(this.dir,'attachments-config.json',{directory:attachments});setExecutionSettings(this.dir,b.defaultReviewer);
   }else if(action==='account'){
    if(b.password!==b.repeated)throw Error('两次密码不一致。');await this.admin('/admin/account-ready',undefined,{optional:true});await new Accounts(this.dir).set(b.username,b.password);await this.admin('/admin/auth-changed',{}, {optional:true});
   }else if(action==='startup'){
    if(typeof b.enabled!=='boolean')throw Error('自启设置无效。');saveJson(this.dir,'console-settings.json',this.options());this.startup(b.enabled?'enable':'disable');this.startupCache=null;
   }else if(action==='tunnel')saveConfig(this.dir,b.hostname,b.command);
   else if(action==='quickTunnel'){readConfig(this.dir);rmSync(path.join(this.dir,'fixed-tunnel.json'),{force:true});}
   else if(action==='checkPublic'){
    const state=await this.overview();if(!state.backend||!state.tunnel||!state.address)throw Error('请先启动手机连接。');
    const r=await fetch(state.address+'/health',{redirect:'error',signal:AbortSignal.timeout(8000)}),h=await r.json();
    if(!r.ok||h.instanceId!==state.instanceId||!h.ready||h.deviceSecurity!==true||h.deviceAuthority!==new URL(state.address).host)throw Error('外网校验未通过，请检查域名路由和网络。');return{message:'外网可到达本机后台，访问保护已开启。'};
   }else throw Error('未知的管理操作。');
   return{message:action==='tunnel'||action==='quickTunnel'?'已保存；重启连接后应用外网设置。':action==='settings'?'已保存；目录与端口将在重启连接后生效。':'操作已完成。'};
  }finally{this.busy=false;}
 }
 logs(){return['后台日志.txt','external-manager.log','external-tunnel.log','gui.log'].map(name=>{
  const file=path.join(this.dir,name);if(!existsSync(file))return{name,text:'暂无日志'};
  let fd;try{fd=openSync(file,'r');const size=statSync(file).size,length=Math.min(size,24000),buffer=Buffer.alloc(length);readSync(fd,buffer,0,length,size-length);return{name,text:redact(buffer.toString('utf8'))};}catch{return{name,text:'日志暂时无法读取'};}finally{if(fd!==undefined)closeSync(fd);}
 });}
 repairStartup(){repairStartupLocation();}
}
