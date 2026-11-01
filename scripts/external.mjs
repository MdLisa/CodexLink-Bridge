import {spawn} from 'node:child_process';
import http from 'node:http';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync,existsSync,appendFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {StringDecoder} from 'node:string_decoder';
import {readConfig,decryptToken} from './tunnel-config.mjs';
import {configureTunnel} from './configure-tunnel.mjs';
const dir=process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge');
const stateFile=path.join(dir,'external.json'),logFile=path.join(dir,'external-tunnel.log');
function state(){try{return JSON.parse(readFileSync(stateFile,'utf8'));}catch{return null;}}
async function alive(s){try{if(!s)return false;const u=new URL(s.control);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')return false;const h=await fetch(s.control+'/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());return h.instanceId===s.instanceId;}catch{return false;}}
function show(s){console.log((s.mode==='fixed'?'固定':'临时')+'外网地址：'+s.url);console.log('电脑后台和外网入口都需保持运行。关闭启动窗口不会停止外网。');if(s.mode==='fixed')console.log('首次连接后，请在 Cloudflare 将此域名的服务地址设置为 '+s.origin+'；HTTP Host Header 保持默认。');else console.log('每次重新创建外网入口，地址都会变化。');}
function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
async function stopExisting(s){
 const r=await fetch(s.control+'/stop',{method:'POST',headers:{'x-external-admin':s.adminSecret},signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('关闭外网失败。');
 for(let i=0;i<100;i++){if(state()?.instanceId!==s.instanceId)return;await delay(100);}throw Error('正在关闭，请稍后查看状态。');
}
async function worker(){
 mkdirSync(dir,{recursive:true});const runtime=JSON.parse(readFileSync(path.join(dir,'runtime.json'),'utf8'));
 const u=new URL(runtime.address);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw Error('电脑后台地址不正确。');
 const origin='http://127.0.0.1:'+u.port;
 const h=await fetch(origin+'/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());if(h.instanceId!==runtime.instanceId||!h.ready)throw Error('请先启动电脑后台，并确认 Codex 在线。');
 for(const [route,method,expected]of [['/api/threads','GET',401],['/admin/stop','POST',403]]){const r=await fetch(origin+route,{method,signal:AbortSignal.timeout(5000)});if(r.status!==expected)throw Error('后台访问保护检查未通过，外网未开启。');}
 const config=readConfig(dir),token=config?decryptToken(config):null;
 const instanceId=randomUUID(),secret=randomBytes(32).toString('base64url');let child,closing=false,timer;
 const s={pid:process.pid,instanceId,adminSecret:secret,control:null,url:null,origin,mode:config?'fixed':'quick',configId:config?.id||null,createdAt:new Date().toISOString()};
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/health'&&req.method==='GET'){res.end(JSON.stringify({instanceId,ready:Boolean(s.url)}));return;}if(req.url==='/stop'&&req.method==='POST'&&equal(req.headers['x-external-admin']||'',secret)){res.end('{"stopping":true}');setImmediate(stop);return;}res.writeHead(403);res.end('{"error":"forbidden"}');});
 async function stop(){if(closing)return;closing=true;clearTimeout(timer);if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);}try{if(state()?.instanceId===instanceId)unlinkSync(stateFile);}catch{}server.close();}
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});s.control='http://127.0.0.1:'+server.address().port;writeFileSync(stateFile,JSON.stringify(s,null,2));
 const exe=fileURLToPath(new URL('../tools/cloudflared.exe',import.meta.url));if(!existsSync(exe)){await stop();throw Error('缺少 cloudflared.exe。');}
 appendFileSync(logFile,'\n--- '+s.createdAt+' ---\n');
 const env={...process.env};for(const key of ['TUNNEL_TOKEN','TUNNEL_TOKEN_FILE','TUNNEL_LOGFILE','TUNNEL_LOG_DIRECTORY','TUNNEL_LOGLEVEL'])delete env[key];
 if(token)env.TUNNEL_TOKEN=token;
 const args=['tunnel','--no-autoupdate','--protocol','http2','--metrics','127.0.0.1:0','--loglevel','info',...(config?['run']:['--url',origin])];
 child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env});
 let output='';let registered=false;
 function line(raw){
  const text=token?raw.replaceAll(token,'[hidden]'):raw;appendFileSync(logFile,text);output=(output+text).slice(-65536);
  const url=config?'https://'+config.hostname:output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];if(/Registered tunnel connection/i.test(output))registered=true;
  if(url&&registered&&!s.url){s.url=url;writeFileSync(stateFile,JSON.stringify(s,null,2));clearTimeout(timer);console.log('External tunnel ready: '+s.url);}
 }
 for(const stream of [child.stdout,child.stderr]){
  const decoder=new StringDecoder('utf8');let pending='',discard=false;
  stream.on('data',b=>{pending+=decoder.write(b);let i;while((i=pending.indexOf('\n'))>=0){const next=pending.slice(0,i+1);pending=pending.slice(i+1);if(!discard)line(next);discard=false;}if(pending.length>262144){pending='';discard=true;}});
  stream.on('end',()=>{pending+=decoder.end();if(pending&&!discard)line(pending);});
 }
 child.on('error',()=>{appendFileSync(logFile,'\nTunnel process could not start.\n');stop();});child.on('exit',()=>stop());
 timer=setTimeout(()=>{appendFileSync(logFile,'\nTunnel startup timed out\n');stop();},90000);
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
async function main(){
 let command=process.argv[2]||'status';if(command==='worker'){await worker();return;}
 if(command==='configure'){if(!await configureTunnel(dir))return;command='start';}
 let s=state(),running=await alive(s);
 if(command==='stop'){if(!running){console.log('外网入口当前未运行。');return;}await stopExisting(s);console.log('外网入口已关闭，电脑后台继续运行。');return;}
 if(command==='status'){if(running&&s.url)show(s);else console.log(running?'外网入口正在连接。':'外网入口当前未运行。');return;}
 if(command!=='start')throw Error('可用操作：start / status / stop / configure');
 const config=readConfig(dir);
 if(running&&(s.configId||null)!==(config?.id||null)){await stopExisting(s);running=false;s=null;}
 if(!running){mkdirSync(dir,{recursive:true});const log=openSync(path.join(dir,'external-manager.log'),'a');const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'worker'],{detached:true,windowsHide:true,stdio:['ignore',log,log],env:{...process.env}});closeSync(log);let spawnError;child.on('error',e=>spawnError=e);child.unref();
  for(let i=0;i<200;i++){if(spawnError)throw spawnError;s=state();running=await alive(s);if(running&&s.url)break;await delay(500);}
 }
 if(!running||!s?.url)throw Error('外网入口尚未就绪，请查看 '+logFile);show(s);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
