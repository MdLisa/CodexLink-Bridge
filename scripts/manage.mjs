import {spawn} from 'node:child_process';
import {readFileSync,mkdirSync,openSync,closeSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const args=process.argv.slice(2),command=args[0]||'status';
const value=(k,f)=>{const i=args.indexOf(k);if(i>=0&&!args[i+1])throw Error(k+' 缺少参数');return i>=0?args[i+1]:f;};
const dataDir=path.resolve(value('--data-dir',process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge')));
const runtimeFile=path.join(dataDir,'runtime.json');
function state(){try{const s=JSON.parse(readFileSync(runtimeFile,'utf8'));const u=new URL(s.address);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error();return s;}catch{return null;}}
async function health(s){if(!s)return null;try{const r=await fetch(s.address+'/health',{signal:AbortSignal.timeout(1500)});const h=await r.json();return h.service==='codex-phone-bridge'&&h.instanceId===s.instanceId?h:null;}catch{return null;}}
async function main(){
 let s=state(),h=await health(s);
 if(command==='stop'){
   if(!h){console.log('后台当前未运行。');return;}
   const r=await fetch(s.address+'/admin/stop',{method:'POST',headers:{'x-bridge-admin':s.adminToken},signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('停止后台失败。');
   for(let i=0;i<300;i++){if(state()?.instanceId!==s.instanceId){console.log('后台已停止，聊天已交回。');return;}await delay(100);}throw Error('后台仍在关闭，请稍后查看状态。');
 }
 if(command==='status'){console.log(h?'后台正在运行：'+s.address+'\n项目范围：'+s.roots.join('、'):'后台当前未运行。');return;}
 if(command!=='start')throw Error('可用操作：start / stop / status');
 if(!h){
   mkdirSync(dataDir,{recursive:true});const out=openSync(path.join(dataDir,'后台日志.txt'),'a');
   const server=fileURLToPath(new URL('../src/server.mjs',import.meta.url));
   const workspace=path.resolve(value('--workspace',process.cwd()));if(!existsSync(workspace))throw Error('项目目录不存在。');
   const child=spawn(process.execPath,[server,'--data-dir',dataDir,'--workspace',workspace,'--host',value('--host','127.0.0.1'),'--port',value('--port','18766')],{cwd:workspace,detached:true,windowsHide:true,stdio:['ignore',out,out],env:{...process.env}});closeSync(out);
   let error;child.on('error',e=>{error=e;});child.unref();
   for(let i=0;i<150;i++){if(error)throw error;s=state();h=await health(s);if(h)break;await delay(100);}
   if(!h)throw Error('启动未完成，请查看 '+path.join(dataDir,'后台日志.txt'));
 }
 console.log('后台已启动：'+s.address);console.log('项目范围：'+s.roots.join('、'));if(value('--host','127.0.0.1')==='0.0.0.0'){const port=new URL(s.address).port;for(const entries of Object.values(os.networkInterfaces()))for(const a of entries||[])if(a.family==='IPv4'&&!a.internal)console.log('局域网候选地址：http://'+a.address+':'+port);}console.log('登录方式：账号密码。首次使用请打开 控制台.cmd，在设置中配置账号密码。');console.log('状态目录：'+dataDir);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
