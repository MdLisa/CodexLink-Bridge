import http from 'node:http';
import {randomBytes,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync,openSync,closeSync,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {WebSocketServer,WebSocket} from 'ws';
import {FileUploads} from './files.mjs';
import {extractDocument} from './chat-documents.mjs';
import {executionSettings,defaultDeviceSettings,reviewerValue} from './execution-settings.mjs';
import {ProjectAccess,permits,validateScope} from './project-access.mjs';
import {DeviceApprovals,validateReviewer} from './device-approvals.mjs';
import {ChatOnlyService} from './chat-only-service.mjs';
import {SharedChatPermissions,SharedChatReader} from './shared-chats.mjs';
import {TakeoverPermissions,TakeoverManager,WindowsDesktopController} from './desktop-takeover.mjs';
import {Store,now} from './store.mjs';
import {RpcClient} from './rpc.mjs';
import {DeviceSecurity} from './device-security.mjs';
import {Accounts} from './accounts.mjs';
import {Bridge,BridgeError,digest,jobView} from './bridge.mjs';
import {serveAndroidUpdate} from './android-updates.mjs';
import {GeneratedFilePermissions,GeneratedFiles,GENERATED_LIMIT,EXPORT_INSTRUCTIONS} from './generated-files.mjs';
export const VERSION='0.12.0';
function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
function imageMime(b){if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';if(b.length>=4&&b[0]===255&&b[1]===216&&b[2]===255)return'image/jpeg';if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return'image/webp';if(b.length>=10&&/^GIF8[79]a$/.test(b.toString('ascii',0,6)))return'image/gif';return null;}
async function readBody(req,max){if(req.deviceBody){if(req.deviceBody.length>max)throw new BridgeError(413,'BODY_TOO_LARGE','上传内容太大。');return req.deviceBody;}if(Number(req.headers['content-length'])>max)throw new BridgeError(413,'BODY_TOO_LARGE','上传内容太大。');let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>max)throw new BridgeError(413,'BODY_TOO_LARGE','上传内容太大。');chunks.push(b);}req.deviceBody=Buffer.concat(chunks);return req.deviceBody;}
async function jsonBody(req){if(!(req.headers['content-type']||'').startsWith('application/json'))throw new BridgeError(415,'JSON_REQUIRED','请使用 JSON 请求。');try{const b=await readBody(req,1024*1024);const r=JSON.parse(b.toString('utf8'));if(!r||typeof r!=='object'||Array.isArray(r))throw Error();return r;}catch(e){if(e instanceof BridgeError)throw e;throw new BridgeError(400,'INVALID_JSON','请求内容格式不正确。');}}
function requiredString(s,label,max=200){if(typeof s!=='string'||!s.trim()||s.length>max)throw new BridgeError(400,'INVALID_FIELD',label+'格式不正确。');return s;}
function takeLock(dir){
  const file=path.join(dir,'bridge.lock');
  try{const fd=openSync(file,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:now()}));closeSync(fd);return()=>{try{const v=JSON.parse(readFileSync(file,'utf8'));if(v.pid===process.pid)unlinkSync(file);}catch{}};}
  catch(e){if(e.code!=='EEXIST')throw e;let lock;try{lock=JSON.parse(readFileSync(file,'utf8'));}catch{throw Error('后台数据目录已有锁文件，请检查是否有另一份服务正在运行。');}try{process.kill(lock.pid,0);}catch(err){if(err.code==='ESRCH'){unlinkSync(file);return takeLock(dir);}throw err;}throw Error('该后台已经在运行，请使用已有服务。');}
}
export async function startServer(options={}){
  const dataDir=path.resolve(options.dataDir||process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge'));
  const roots=(options.roots||[process.cwd()]).map(p=>path.resolve(p));mkdirSync(dataDir,{recursive:true});const unlock=takeLock(dataDir);
  let store,bridge,server,wss,takeover,chatOnly,closed=false,service;
  const pendingSockets=new Set(),transitions=new Set(),inflight=new Map();let pairingTimer,heartbeat,chatTimer;
  const instanceId=randomUUID(),adminToken=randomBytes(32).toString('base64url'),runtimeFile=path.join(dataDir,'runtime.json');
  try{
    store=new Store(dataDir);const uploadDir=path.join(dataDir,'uploads');mkdirSync(uploadDir,{recursive:true});
    const reviewer=options.approvalsReviewer===undefined?()=>executionSettings(dataDir).approvalsReviewer:()=>reviewerValue(options.approvalsReviewer);reviewer();
    const accounts=new Accounts(dataDir),security=new DeviceSecurity(store);
    const projectAccess=new ProjectAccess(store,roots,()=>accounts.current()?.generation);
    const phoneReviewer=options.approvalsReviewer===undefined?()=>defaultDeviceSettings(dataDir).approvalsReviewer:reviewer;
    const deviceApprovals=new DeviceApprovals(store,phoneReviewer,()=>accounts.current()?.generation);
    const mode=d=>deviceApprovals.get(d).approvalsReviewer==='chat_only'?'chat_only':'operate';
    for(const j of store.queued())if(j.device_key&&!j.approvals_reviewer){try{store.snapshotReviewer(j.id,deviceApprovals.get({device_key:j.device_key,auth_generation:j.auth_generation}).approvalsReviewer);}catch{store.updateJob(j.id,'failed',{error:'原提交手机的审批配置已失效，排队任务未执行。'});}}
    const rpc=options.rpc||new RpcClient({exe:options.codexExe});bridge=new Bridge({rpc,store,roots,uploadDir,files:new FileUploads(store,dataDir),accessResolver:d=>projectAccess.get(d),approvalResolver:d=>{if(transitions.has(d.device_key))throw new BridgeError(409,'MODE_CHANGING','手机模式正在切换，请稍后重试。');return deviceApprovals.get(d);},approvalPolicy:options.approvalPolicy||'on-request',approvalsReviewer:reviewer});
    const takeoverPermissions=new TakeoverPermissions(store,()=>accounts.current()?.generation);
    const sharedChatPermissions=new SharedChatPermissions(store,()=>accounts.current()?.generation);
    const generatedPermissions=new GeneratedFilePermissions(store,()=>accounts.current()?.generation),generatedFiles=new GeneratedFiles(store,dataDir);
    bridge.deliveryInstructions=EXPORT_INSTRUCTIONS;bridge.exportInstructions=d=>d&&mode(d)==='operate'&&generatedPermissions.get(d)?EXPORT_INSTRUCTIONS:'';
    const downloadAllowed=d=>mode(d)==='operate'&&generatedPermissions.get(d);
    function requireDownload(d){if(!downloadAllowed(d))throw new BridgeError(403,'GENERATED_DENIED','这台手机未获准下载生成文件，或当前处于仅聊天模式。');}
    const desktopController=options.desktopController||new WindowsDesktopController({protectedPids:()=>[process.pid,rpc.proc?.pid].filter(Number.isSafeInteger)});
    const allowedOrigins=new Set(options.allowedOrigins||[]);let address;
    function attachmentAllowed(id,device){const current=mode(device),owner=store.attachmentOwner(id);if(current==='chat_only'||owner?.execution_mode==='chat_only')return Boolean(current==='chat_only'&&owner?.execution_mode==='chat_only'&&owner.device_key===device.device_key&&owner.generation===device.auth_generation);const scope=projectAccess.get(device),threads=store.attachmentThreads(id);if(threads.length)return threads.some(t=>permits(scope,t.workspace));return Boolean(owner&&owner.device_key===device.device_key&&owner.generation===device.auth_generation);}
    function requireAttachment(id,device){if(!attachmentAllowed(id,device))throw new BridgeError(403,'ATTACHMENT_DENIED','这个附件不在该手机允许访问的范围内。');}
    bridge.attachmentAccess=requireAttachment;
    function requestAllowed(r,device){const cwd=bridge.metadata.get(r.threadId)?.cwd;return Boolean(mode(device)==='operate'&&cwd&&bridge.allowed(cwd,device)&&r.deviceKey===device.device_key&&r.generation===device.auth_generation);}
    function validDevice(d){return Boolean(d&&accounts.current()?.generation===d.auth_generation&&store.activeDevice(d.id)&&security.approved(d.device_key,d.auth_generation));}
    takeover=new TakeoverManager({bridge,permissions:takeoverPermissions,controller:desktopController,validDevice:d=>validDevice(d)&&mode(d)==='operate'});
    chatOnly=new ChatOnlyService({store,dataDir,exe:options.codexExe,runtimeFactory:options.chatRuntimeFactory,refreshAuth:()=>rpc.request('account/read',{refreshToken:true}),validOwner:d=>{try{return !transitions.has(d.device_key)&&accounts.current()?.generation===d.auth_generation&&security.approved(d.device_key,d.auth_generation)&&mode(d)==='chat_only';}catch{return false;}},imageFile:id=>bridge.imageFile(id),files:bridge.files,requireImage:requireAttachment});
    const sharedChats=new SharedChatReader({store,chatOnly,permissions:sharedChatPermissions,validViewer:validDevice});
    function resolveDevice(hash){const d=store.auth(hash);return validDevice(d)?d:null;}
    function auth(req){const h=req.headers.authorization;if(typeof h!=='string'||!h.startsWith('Bearer '))throw new BridgeError(401,'AUTH_REQUIRED','请先登录。');const device=resolveDevice(digest(h.slice(7)));if(!device)throw new BridgeError(401,'AUTH_INVALID','登录已失效，请重新输入账号密码登录。');return device;}
    function originAllowed(req){const origin=req.headers.origin;if(!origin)return true;return allowedOrigins.has(origin)||origin===address||origin===address?.replace('127.0.0.1','localhost');}
    function reply(res,status,value){res.writeHead(status,{'content-type':'application/json;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify({...value,serverTime:Date.now()}));}
    server=http.createServer(async(req,res)=>{
      try{
        if(!originAllowed(req))throw new BridgeError(403,'ORIGIN_DENIED','不允许此网页来源访问后台。');
        const u=new URL(req.url,'http://localhost');const parts=u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if(await serveAndroidUpdate(req,res,u,options.updatesDir||path.resolve(fileURLToPath(new URL('../updates/android/',import.meta.url)))))return;
        if(req.method==='GET'&&u.pathname==='/health'){reply(res,200,{service:'codex-phone-bridge',version:VERSION,ready:bridge.online,authMode:'password',deviceSecurity:true,localDeviceManagement:true,deviceAuthority:req.headers.host,accountConfigured:Boolean(accounts.current()),instanceId});return;}
        if(req.method==='POST'&&u.pathname==='/admin/stop'){
          const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
          if(!local||!equal(req.headers['x-bridge-admin']||'',adminToken))throw new BridgeError(403,'ADMIN_REQUIRED','只能通过本机管理程序停止后台。');
          reply(res,200,{stopping:true});setImmediate(()=>service?.close().catch(e=>options.onError?.(e)));return;
        }
        if(u.pathname==='/admin/devices'){
          if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!equal(req.headers['x-bridge-admin']||'',adminToken))throw new BridgeError(403,'ADMIN_REQUIRED','只能在本机管理手机。');
          if(req.method!=='POST')throw new BridgeError(405,'METHOD_NOT_ALLOWED','请求方式不正确。');
          const b=await jsonBody(req),d=security.lookup(b.fingerprint);
          if(!d||d.generation!==b.generation||b.generation!==accounts.current()?.generation)throw new BridgeError(400,'INVALID_DEVICE','设备请求已失效，请刷新列表。');
          if(b.action==='note'){security.note(d.fingerprint,d.generation,b.note);reply(res,200,{updated:true});return;}
          if(b.action==='approve'){
            if(d.status==='approved')throw new BridgeError(400,'INVALID_DEVICE','该手机已批准，请刷新列表。');
            projectAccess.initialize(d.fingerprint,d.generation);deviceApprovals.initialize(d.fingerprint,d.generation);
            security.approve(d.fingerprint,b.code,d.generation);reply(res,200,{approved:true});return;
          }
          if(!['delete','revoke'].includes(b.action))throw new BridgeError(400,'INVALID_ACTION','设备操作无效。');
          if(transitions.has(d.fingerprint)||inflight.get(d.fingerprint)||takeover.running||store.db.prepare("SELECT 1 FROM jobs WHERE device_key=? AND state IN ('starting','running','waitingApproval') LIMIT 1").get(d.fingerprint))throw new BridgeError(409,'TASK_PENDING','该手机还有运行中的任务或请求，请先停止或等待完成，再重试。');
          transitions.add(d.fingerprint);
          try{
            for(const j of store.queued(null))if(j.device_key===d.fingerprint)store.updateJob(j.id,'cancelled',{error:'设备已移除或撤销，排队任务已取消。'});
            await chatOnly.closeOwner({device_key:d.fingerprint,auth_generation:d.generation});
            if(b.action==='delete')security.forget(d.fingerprint,d.generation);else security.revoke(d.fingerprint);
            for(const ws of wss.clients)if(ws.device?.device_key===d.fingerprint)ws.close(4003,'Device removed');
            reply(res,200,{updated:true});return;
          }finally{transitions.delete(d.fingerprint);}
        }
        if(u.pathname==='/admin/project-access'){
          if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!equal(req.headers['x-bridge-admin']||'',adminToken))throw new BridgeError(403,'ADMIN_REQUIRED','只能在电脑控制台修改手机项目范围。');
          if(req.method!=='POST')throw new BridgeError(405,'METHOD_NOT_ALLOWED','请求方式不正确。');
          const b=await jsonBody(req);if(b.generation!==accounts.current()?.generation)throw new BridgeError(400,'INVALID_DEVICE','设备请求已失效。');const policy=validateScope(b);
          for(const id of bridge.active.values()){const j=store.job(id);if(j.device_key===b.fingerprint&&!permits(policy,bridge.metadata.get(j.thread_id)?.cwd))throw new BridgeError(409,'TASK_PENDING','该手机还有新范围外的任务正在执行，请先停止或等待任务结束，再修改范围。');}
          const updated=projectAccess.set(b.fingerprint,b.generation,policy);
          for(const j of store.queued())if(j.device_key===b.fingerprint&&!permits(updated,bridge.metadata.get(j.thread_id)?.cwd)){bridge.event('job.updated',jobView(store.updateJob(j.id,'failed',{error:'手机项目范围已变更，排队任务已取消。'})));}
          for(const ws of wss.clients)if(ws.device?.device_key===b.fingerprint){send(ws,{type:'access.changed',data:{}});ws.close(4009,'Project access changed');}
          reply(res,200,{projectAccess:updated});return;
        }
        if(u.pathname==='/admin/device-approvals'){
          if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!equal(req.headers['x-bridge-admin']||'',adminToken))throw new BridgeError(403,'ADMIN_REQUIRED','只能在电脑控制台修改手机操作审批。');
          if(req.method!=='POST')throw new BridgeError(405,'METHOD_NOT_ALLOWED','请求方式不正确。');
          const b=await jsonBody(req);if(b.generation!==accounts.current()?.generation)throw new BridgeError(400,'INVALID_DEVICE','设备请求已失效。');
          const selection=validateReviewer(b.approvalsReviewer),previous=deviceApprovals.view(b.fingerprint,b.generation).approvalsReviewer,switchMode=(previous==='chat_only')!==(selection==='chat_only');
          if(transitions.has(b.fingerprint))throw new BridgeError(409,'MODE_CHANGING','手机模式正在切换。');
          if(switchMode&&(inflight.get(b.fingerprint)||takeover.running||store.db.prepare("SELECT 1 FROM jobs WHERE device_key=? AND state IN ('starting','running','waitingApproval') LIMIT 1").get(b.fingerprint)))throw new BridgeError(409,'TASK_PENDING','请先停止或等待该手机任务结束，再切换仅聊天模式；若手机正在刷新请稍后重试。');
          if(switchMode)transitions.add(b.fingerprint);
          try{
           if(switchMode){for(const j of store.queued(null))if(j.device_key===b.fingerprint)store.updateJob(j.id,'cancelled',{error:'聊天模式已切换，旧模式排队任务已取消。'});await chatOnly.closeOwner({device_key:b.fingerprint,auth_generation:b.generation});}
           const updated=deviceApprovals.set(b.fingerprint,b.generation,selection);
           for(const ws of wss.clients)if(ws.device?.device_key===b.fingerprint){send(ws,{type:'settings.changed',data:{...updated,modeChanged:switchMode}});if(switchMode)ws.close(4009,'Chat mode changed');}
           reply(res,200,{executionSettings:updated});return;
          }finally{transitions.delete(b.fingerprint);}
        }
        if(u.pathname==='/admin/generated-files'){
          if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!equal(req.headers['x-bridge-admin']||'',adminToken))throw new BridgeError(403,'ADMIN_REQUIRED','只能在电脑设备管理中授权文档下载。');
          if(req.method!=='POST')throw new BridgeError(405,'METHOD_NOT_ALLOWED','请求方式不正确。');
          const b=await jsonBody(req),enabled=generatedPermissions.set(b.fingerprint,b.generation,b.enabled);
          for(const ws of wss.clients)if(ws.device?.device_key===b.fingerprint)send(ws,{type:'generated-files.settings.changed',data:{enabled}});
          reply(res,200,{enabled});return;
        }
        if(u.pathname==='/admin/shared-chats'){
          if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!equal(req.headers['x-bridge-admin']||'',adminToken))throw new BridgeError(403,'ADMIN_REQUIRED','只能在电脑设备管理中授权查看其他手机会话。');
          if(req.method!=='POST')throw new BridgeError(405,'METHOD_NOT_ALLOWED','请求方式不正确。');
          const b=await jsonBody(req),updated=sharedChatPermissions.set(b.fingerprint,b.generation,b.enabled);
          for(const ws of wss.clients)if(ws.device?.device_key===b.fingerprint)send(ws,{type:'shared-chat.settings.changed',data:updated});
          reply(res,200,{sharedChatAccess:updated});return;
        }
        if(u.pathname==='/admin/desktop-takeover'){
          if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!equal(req.headers['x-bridge-admin']||'',adminToken))throw new BridgeError(403,'ADMIN_REQUIRED','只能在电脑设备管理中授权桌面接管。');
          if(req.method!=='POST')throw new BridgeError(405,'METHOD_NOT_ALLOWED','请求方式不正确。');
          const b=await jsonBody(req);const enabled=takeoverPermissions.set(b.fingerprint,b.generation,b.enabled);
          for(const ws of wss.clients)if(ws.device?.device_key===b.fingerprint)send(ws,{type:'takeover.settings.changed',data:{enabled}});
          reply(res,200,{enabled});return;
        }
        if(u.pathname==='/admin/account-ready'||u.pathname==='/admin/auth-changed'){
          const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
          if(!local||!equal(req.headers['x-bridge-admin']||'',adminToken))throw new BridgeError(403,'ADMIN_REQUIRED','仅允许本机设置账号。');
          if(u.pathname==='/admin/account-ready'&&req.method==='GET'){reply(res,200,{ready:true});return;}
          if(u.pathname==='/admin/auth-changed'&&req.method==='POST'){for(const ws of wss.clients)if(ws.device&&!validDevice(ws.device))ws.close(4003,'Account changed');await chatOnly.reconcile();reply(res,200,{updated:true});return;}
          throw new BridgeError(405,'METHOD_NOT_ALLOWED','请求方式不正确。');
        }
        if(u.pathname==='/api/pair')throw new BridgeError(410,'PASSWORD_LOGIN_REQUIRED','配对码已取消，请更新手机应用，使用账号密码登录。');
        if(req.method==='POST'&&u.pathname==='/api/login'){
          const b=await jsonBody(req);const account=await accounts.verify(b.username,b.password);
          const publicKey=security.proof(b.publicKey,{token:'',method:'POST',host:req.headers.host,path:req.url,time:req.headers['x-device-time'],nonce:req.headers['x-device-nonce'],signature:req.headers['x-device-signature'],body:req.deviceBody});
          const registration=security.enroll(publicKey.encoded,b.deviceName,account.generation);
          if(registration.status==='revoked')throw new BridgeError(403,'DEVICE_REVOKED','这台手机已被撤销，请在电脑上重新批准。');
          if(registration.status!=='approved'){reply(res,202,{approvalRequired:true,verificationCode:security.code(publicKey.fingerprint),message:'请在电脑打开 CodexLink 控制台 → 手机设备，核对码一致后批准，再回手机点击登录。'});return;}
          const name=typeof b.deviceName==='string'?b.deviceName.trim().slice(0,80):'安卓手机';const token=randomBytes(32).toString('base64url'),id=randomUUID();
          projectAccess.initialize(publicKey.fingerprint,account.generation);deviceApprovals.initialize(publicKey.fingerprint,account.generation);store.addDevice(id,name||'安卓手机',digest(token),account.generation,publicKey.fingerprint);reply(res,201,{device:{id,name:name||'安卓手机'},token});return;
        }
        const device=auth(req);
        if(transitions.has(device.device_key))throw new BridgeError(409,'MODE_CHANGING','手机模式正在切换，请稍后刷新。');
        inflight.set(device.device_key,(inflight.get(device.device_key)||0)+1);let counted=true;const finished=()=>{if(counted){counted=false;inflight.set(device.device_key,Math.max(0,(inflight.get(device.device_key)||0)-1));}};res.once('finish',finished);res.once('close',finished);
        const requestBody=await readBody(req,req.method==='GET'?0:10*1024*1024);
        security.proof(security.lookup(device.device_key).public_key,{token:req.headers.authorization.slice(7),method:req.method,host:req.headers.host,path:req.url,time:req.headers['x-device-time'],nonce:req.headers['x-device-nonce'],signature:req.headers['x-device-signature'],body:requestBody});
        if(parts[0]!=='api')throw new BridgeError(404,'NOT_FOUND','接口不存在。');
        const chatMode=mode(device)==='chat_only';
        if(req.method==='GET'&&parts[1]==='generated-files'&&parts.length===3){
          requireDownload(device);const record=generatedFiles.record(parts[2]);await bridge.info(record.thread_id,device);bridge.check(record.workspace,device);requireDownload(device);
          const release=generatedFiles.acquire(device.device_key);res.once('finish',release);res.once('close',release);
          const body=generatedFiles.body(record);requireDownload(device);
          res.writeHead(200,{'content-type':record.mime,'content-length':body.length,'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(record.name),'cache-control':'private, no-store','x-content-type-options':'nosniff','x-content-sha256':record.sha256});res.end(body);return;
        }
        if(req.method==='GET'&&u.pathname==='/api/status'){const settings=deviceApprovals.get(device),scope=chatMode?{mode:'chat_only',roots:[],revision:'chat_only:'+settings.modeRevision}:projectAccess.get(device);reply(res,200,{version:VERSION,online:chatMode?true:bridge.online,projectAccess:scope,executionSettings:settings,sharedChatAccess:{supported:true,...sharedChatPermissions.get(device)},desktopTakeover:{enabled:!chatMode&&takeoverPermissions.get(device),supported:!chatMode&&desktopController.supported},workspaces:chatMode?[]:scope.mode==='all'?bridge.roots:scope.roots,deviceId:device.id,approvalsReviewer:settings.approvalsReviewer,generatedFiles:{supported:true,enabled:downloadAllowed(device),limitBytes:GENERATED_LIMIT},capabilities:{chatOnly:true,perDeviceProjects:true,perDeviceApprovals:true,desktopTakeover:!chatMode,text:true,images:true,files:true,fileLimitBytes:10*1024*1024,historyRefresh:true,queue:true,approvals:!chatMode,computerUse:false,liveDesktopTakeover:false},requests:chatMode?chatOnly.requestsFor(device):[...bridge.requests.values()].filter(r=>requestAllowed(r,device)).map(r=>bridge.requestView(r))});return;}
        if(parts[1]==='shared-chats'){
          sharedChats.require(device);
          if(req.method!=='GET')throw new BridgeError(403,'SHARED_CHAT_READ_ONLY','其他手机会话仅支持查看，不能发送消息或操作任务。');
          if(parts[2]==='threads'){
            if(parts.length===3){reply(res,200,sharedChats.list(u.searchParams.get('cursor'),device));return;}
            if(parts.length===4){reply(res,200,sharedChats.info(parts[3],device));return;}
            if(parts.length===5&&parts[4]==='history'){reply(res,200,await sharedChats.history(parts[3],{cursor:u.searchParams.get('cursor'),limit:Number(u.searchParams.get('limit'))||20},device));return;}
            if(parts.length===6&&parts[4]==='images'){
              const {upload,file}=sharedChats.image(parts[3],parts[5],device);res.writeHead(200,{'content-type':upload.mime,'content-length':upload.size,'cache-control':'no-store','x-content-type-options':'nosniff'});const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);return;
            }
          }
          throw new BridgeError(404,'NOT_FOUND','只读查看接口不存在。');
        }
        if(req.method==='GET'&&u.pathname==='/api/devices'){reply(res,200,{devices:store.devices().filter(d=>{const target=store.activeDevice(d.id);return validDevice(target)&&target.device_key===device.device_key;})});return;}
        if(req.method==='DELETE'&&parts.length===3&&parts[1]==='devices'){
          if(store.activeDevice(parts[2])?.device_key!==device.device_key)throw new BridgeError(403,'DEVICE_DENIED','手机只能移除自己的连接，其他设备请在电脑管理。');
          if(!store.revoke(parts[2]))throw new BridgeError(404,'DEVICE_NOT_FOUND','设备不存在或已撤销。');for(const ws of wss.clients)if(ws.device?.id===parts[2])ws.close(4003,'Device revoked');reply(res,200,{revoked:true});return;
        }
        if(chatMode&&parts[1]!=='uploads'&&parts[1]!=='files'){
         if(parts[1]==='threads'){
          const id=parts[2],action=parts[3];
          if(parts.length===2&&req.method==='GET'){reply(res,200,chatOnly.list(u.searchParams.get('cursor'),device));return;}
          if(parts.length===2&&req.method==='POST'){reply(res,201,await chatOnly.create(await jsonBody(req),device));return;}
          if(parts.length===3&&req.method==='GET'){reply(res,200,chatOnly.view(chatOnly.info(id,device)));return;}
          if(parts.length===4&&action==='history'&&req.method==='GET'){reply(res,200,await chatOnly.history(id,{cursor:u.searchParams.get('cursor'),limit:Number(u.searchParams.get('limit'))||20},device));return;}
          if(parts.length===4&&action==='messages'&&req.method==='POST'){const b=await jsonBody(req);if(b.modeRevision!==undefined&&b.modeRevision!==deviceApprovals.get(device).modeRevision)throw new BridgeError(409,'MODE_CHANGED','消息所属的聊天模式已改变，请刷新后重新输入。');reply(res,202,await chatOnly.enqueue(id,b,device));return;}
          if(parts.length===4&&action==='jobs'&&req.method==='GET'){reply(res,200,{jobs:chatOnly.jobs(id,device)});return;}
         }
         if(parts[1]==='jobs'&&parts.length===3&&req.method==='GET'){reply(res,200,jobView(chatOnly.job(parts[2],device)));return;}
         if(parts[1]==='jobs'&&parts.length===4&&parts[3]==='cancel'&&req.method==='POST'){reply(res,200,await chatOnly.cancel(parts[2],device));return;}
         if(parts[1]==='requests'&&parts.length===4&&parts[3]==='respond'&&req.method==='POST'){reply(res,200,await chatOnly.respond(parts[2],await jsonBody(req),device));return;}
         throw new BridgeError(403,'CHAT_OPERATION_DENIED','仅聊天模式不允许访问电脑项目、文件、操作审批或桌面接管。');
        }
        if(!chatMode&&!bridge.online)throw new BridgeError(503,'CODEX_OFFLINE','Codex 连接已中断，请在电脑上重新启动后台；已提交任务不会自动重复执行。');
        if(!chatMode&&parts[1]==='threads'&&parts[2]&&store.db.prepare('SELECT 1 FROM chat_only_threads WHERE id=?').get(parts[2]))throw new BridgeError(403,'CHAT_THREAD_DENIED','这个独立聊天仅能在本设备的仅聊天模式中访问。');
        if(parts[0]!=='api')throw new BridgeError(404,'NOT_FOUND','接口不存在。');
        if(parts[1]==='threads'){
          if(parts.length===5&&parts[3]==='takeover'&&parts[4]==='prepare'&&req.method==='POST'){reply(res,200,await takeover.prepare(parts[2],device));return;}
          if(parts.length===4&&parts[3]==='takeover'&&req.method==='POST'){const b=await jsonBody(req);requiredString(b.confirmationId,'接管确认',100);await bridge.info(parts[2],device);reply(res,202,takeover.confirm(parts[2],b.confirmationId,device));return;}
          if(parts.length===5&&parts[3]==='takeover'&&req.method==='GET'){reply(res,200,await takeover.status(parts[2],parts[4],device));return;}
          if(parts.length===2&&req.method==='GET'){reply(res,200,await bridge.list(u.searchParams.get('cursor'),device));return;}
          if(parts.length===2&&req.method==='POST'){const b=await jsonBody(req);if(b.cwd!==undefined)requiredString(b.cwd,'项目目录',1000);if(b.name!==undefined)requiredString(b.name,'聊天名称',100);reply(res,201,await bridge.create(b,device));return;}
          if(parts.length===3&&req.method==='GET'){reply(res,200,bridge.threadView(await bridge.info(parts[2],device)));return;}
          if(parts.length===4&&parts[3]==='history'&&req.method==='GET'){const history=await bridge.history(parts[2],{cursor:u.searchParams.get('cursor'),limit:Number(u.searchParams.get('limit'))||20},device);if(downloadAllowed(device)){const thread=await bridge.info(parts[2],device);if(downloadAllowed(device))generatedFiles.decorate(history,parts[2],thread.cwd);}reply(res,200,history);return;}
          if(parts.length===4&&parts[3]==='messages'&&req.method==='POST'){const b=await jsonBody(req);if(b.modeRevision!==undefined&&b.modeRevision!==deviceApprovals.get(device).modeRevision)throw new BridgeError(409,'MODE_CHANGED','消息所属的聊天模式已改变，请刷新后重新输入。');reply(res,202,await bridge.enqueue(parts[2],b,device));return;}
          if(parts.length===4&&parts[3]==='acquire'&&req.method==='POST'){await bridge.acquire(parts[2],device);reply(res,200,{acquired:true});return;}
          if(parts.length===4&&parts[3]==='release'&&req.method==='POST'){if(takeover.running)throw new BridgeError(409,'TAKEOVER_BUSY','接管正在进行，请完成后再交回电脑。');reply(res,200,await bridge.release(parts[2],device));return;}
          if(parts.length===4&&parts[3]==='jobs'&&req.method==='GET'){await bridge.info(parts[2],device);reply(res,200,{jobs:store.jobs(parts[2]).map(jobView)});return;}
        }
        if(parts[1]==='jobs'&&parts.length===3&&req.method==='GET'){const j=store.job(parts[2]);if(!j)throw new BridgeError(404,'JOB_NOT_FOUND','任务不存在。');if(j.execution_mode==='chat_only')throw new BridgeError(403,'CHAT_JOB_DENIED','独立聊天任务仅能在本设备的仅聊天模式中访问。');await bridge.info(j.thread_id,device);reply(res,200,jobView(j));return;}
        if(parts[1]==='jobs'&&parts.length===4&&parts[3]==='cancel'&&req.method==='POST'){if(store.job(parts[2])?.execution_mode==='chat_only')throw new BridgeError(403,'CHAT_JOB_DENIED','独立聊天任务仅能在本设备的仅聊天模式中访问。');reply(res,200,await bridge.cancel(parts[2],device));return;}
        if(parts[1]==='requests'&&parts.length===4&&parts[3]==='respond'&&req.method==='POST'){const b=await jsonBody(req),r=bridge.requests.get(parts[2]);if(!r)throw new BridgeError(409,'REQUEST_EXPIRED','请求已结束。');await bridge.info(r.threadId,device);if(!requestAllowed(r,device))throw new BridgeError(403,'APPROVAL_OWNER_REQUIRED','只能由提交该任务的手机处理此请求。');reply(res,200,bridge.respond(parts[2],b));return;}
        if(parts[1]==='files'&&parts.length===2&&req.method==='POST'){
          if(u.searchParams.has('modeRevision')&&u.searchParams.get('modeRevision')!==deviceApprovals.get(device).modeRevision)throw new BridgeError(409,'MODE_CHANGED','文件所属的聊天模式已改变，请刷新后重试。');
          if(chatMode){try{await extractDocument(u.searchParams.get('name')||'',requestBody);chatOnly.assert(device);}catch(e){throw new BridgeError(400,'CHAT_FILE_INVALID',e.message);}}
          const id=u.searchParams.get('id');if(store.fileUpload(id))requireAttachment(id,device);let file;try{file=bridge.files.save({id,name:u.searchParams.get('name'),mime:u.searchParams.get('mime'),body:requestBody});}catch(e){throw new BridgeError(400,'INVALID_FILE',e.message);}store.ownAttachment(file.id,device,chatMode?'chat_only':'operate');reply(res,201,file);return;
        }
        if(parts[1]==='uploads'&&parts.length===2&&req.method==='POST'){
          const body=await readBody(req,10*1024*1024);const mime=imageMime(body);if(!mime)throw new BridgeError(415,'IMAGE_REQUIRED','仅支持 PNG、JPEG、WebP 和 GIF 图片。');
          const id=randomUUID();writeFileSync(path.join(uploadDir,id),body,{flag:'wx'});const upload={id,mime,size:body.length,sha256:digest(body)};store.addUpload(upload);store.ownAttachment(id,device,chatMode?'chat_only':'operate');reply(res,201,{...upload,url:'/api/uploads/'+id});return;
        }
        if(parts[1]==='uploads'&&parts.length===3&&req.method==='GET'){
          requireAttachment(parts[2],device);
          const image=bridge.imageFile(parts[2]);if(!image)throw new BridgeError(404,'UPLOAD_NOT_FOUND','图片已不可用，电脑上的原图可能已删除。');const {upload,file}=image;res.writeHead(200,{'content-type':upload.mime,'content-length':upload.size,'cache-control':'no-store','x-content-type-options':'nosniff'});const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);return;
        }
        throw new BridgeError(404,'NOT_FOUND','接口不存在。');
      }catch(e){if(!res.headersSent)reply(res,e.status||500,{error:{code:e.code||'INTERNAL_ERROR',message:e.status||e.rpcCode?e.message:'后台处理失败，请在电脑上检查服务状态。'}});else res.destroy();options.onError?.(e);}
    });
    server.requestTimeout=30000;server.headersTimeout=15000;server.on('clientError',(_e,s)=>s.destroy());
    wss=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
    server.on('upgrade',(req,socket,head)=>{let u;try{u=new URL(req.url,'http://localhost');}catch{socket.destroy();return;}if(u.pathname!=='/events'||u.search||!originAllowed(req)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
    const send=(ws,value)=>{if(ws.readyState===WebSocket.OPEN){if(ws.device&&!validDevice(ws.device)){ws.close(4003,'Login expired');return;}if(ws.device&&value.seq){if(value.audienceKey&&(value.audienceKey!==ws.device.device_key||value.audienceGeneration!==ws.device.auth_generation))return;if(value.type.startsWith('request.')&&!value.audienceKey)return;try{const current=mode(ws.device);if((value.executionMode||'operate')!==current)return;if(current==='chat_only'){if(!value.audienceKey)return;}else{const scope=projectAccess.get(ws.device);if(value.type!=='server.status'&&(!value.workspace||!permits(scope,value.workspace)))return;}}catch{ws.close(4009,'Access unavailable');return;}}if(ws.bufferedAmount>2*1024*1024){ws.close(4008,'Refresh required');return;}const {workspace,audienceKey,audienceGeneration,executionMode,...wire}=value;ws.send(JSON.stringify(wire));}};
    wss.on('connection',(ws,req)=>{
      pendingSockets.add(ws);ws.isAlive=true;const timer=setTimeout(()=>ws.close(4001,'Authentication required'),5000);
      ws.on('pong',()=>{ws.isAlive=true;});ws.on('error',()=>{});ws.on('close',()=>{clearTimeout(timer);pendingSockets.delete(ws);});
      function authenticate(token,after=0,proof={}){const d=resolveDevice(digest(token||''));if(!d){ws.close(4001,'Invalid credentials');return;}try{security.proof(security.lookup(d.device_key).public_key,{token,method:'WS',host:req.headers.host,path:'/events',time:proof.deviceTime,nonce:proof.deviceNonce,signature:proof.deviceSignature,body:Buffer.from(String(after))});}catch{ws.close(4001,'Device proof required');return;}ws.device=d;clearTimeout(timer);const range=store.eventRange();if(after&&range.first&&after<range.first-1){send(ws,{type:'refresh.required',data:{reason:'eventGap'}});}else for(const e of store.events(after))send(ws,e);send(ws,{type:'authenticated',data:{deviceId:d.id,lastSeq:range.last||0}});}

      ws.on('message',raw=>{let m;try{m=JSON.parse(raw);}catch{ws.close(4002,'Invalid JSON');return;}if(!ws.device){if(m.type!=='auth'||typeof m.token!=='string'||(m.after!==undefined&&(!Number.isSafeInteger(m.after)||m.after<0))){ws.close(4001,'Authentication required');return;}authenticate(m.token,m.after||0,m);}else if(m.type==='ping')send(ws,{type:'pong',data:{time:now()}});});
    });
    bridge.on('event',e=>{for(const ws of wss.clients)if(ws.device)send(ws,e);});
    chatOnly.on('event',e=>{for(const ws of wss.clients)if(ws.device)send(ws,e);});
    heartbeat=setInterval(()=>{for(const ws of wss.clients){if(ws.device&&!validDevice(ws.device)){ws.close(4003,'Login expired');continue;}if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30000);heartbeat.unref();
    await bridge.start();
    chatOnly.start();let reconciling=false;chatTimer=setInterval(async()=>{if(reconciling||closed)return;reconciling=true;try{await chatOnly.reconcile();}catch(e){options.onError?.(e);}finally{reconciling=false;}},1000);chatTimer.unref();
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port??18766,options.host||'127.0.0.1',resolve);});
    const port=server.address().port;address='http://'+(options.host==='0.0.0.0'?'127.0.0.1':options.host||'127.0.0.1')+':'+port;
    try{unlinkSync(path.join(dataDir,'本机配对码.json'));}catch{} 
    writeFileSync(runtimeFile,JSON.stringify({pid:process.pid,instanceId,address,adminToken,roots},null,2));
    service={address,port,bridge,store,dataDir,security,projectAccess,deviceApprovals,takeoverPermissions,takeover,chatOnly,sharedChatPermissions,sharedChats,async close(){if(closed)return;closed=true;clearInterval(pairingTimer);clearInterval(heartbeat);clearInterval(chatTimer);for(const ws of wss.clients)ws.terminate();await takeover.close();await chatOnly.close();await new Promise(resolve=>server.close(resolve));await bridge.close();store.close();try{if(JSON.parse(readFileSync(runtimeFile,'utf8')).instanceId===instanceId)unlinkSync(runtimeFile);}catch{}unlock();}};return service;
  }catch(e){clearInterval(pairingTimer);clearInterval(heartbeat);clearInterval(chatTimer);try{for(const ws of wss?.clients||[])ws.terminate();server?.close();await takeover?.close();await chatOnly?.close();await bridge?.close();}catch{}try{store?.close();}catch{}unlock();throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);const value=(k,fallback)=>{const i=args.indexOf(k);return i>=0?args[i+1]:fallback;};
  const roots=[];for(let i=0;i<args.length;i++)if(args[i]==='--workspace'&&args[i+1])roots.push(args[++i]);
  let service;try{service=await startServer({host:value('--host','127.0.0.1'),port:Number(value('--port',18766)),dataDir:value('--data-dir'),roots:roots.length?roots:undefined,approvalPolicy:value('--approval-policy','on-request'),allowedOrigins:(process.env.BRIDGE_ALLOWED_ORIGINS||'').split(',').filter(Boolean)});console.log('电脑连接程序已启动：'+service.address);console.log('项目范围：'+service.bridge.roots.join('、'));console.log('登录方式：账号密码。首次使用请运行 设置账号密码.cmd');}catch(e){console.error('启动失败：'+e.message);process.exitCode=1;}
  if(service){let ending=false;const stop=async()=>{if(ending)return;ending=true;await service.close();};process.on('SIGINT',stop);process.on('SIGTERM',stop);}
}
