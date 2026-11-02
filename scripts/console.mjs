import {createInterface} from 'node:readline/promises';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync,rmSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {configuredFileRoot} from '../src/files.mjs';
import {executionSettings,reviewerLabel} from '../src/execution-settings.mjs';
import {startupSetting,cancelPendingStartup,startupCancelled,repairStartupLocation} from './startup-settings.mjs';

const dir=process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge');
const settingsFile=path.join(dir,'console-settings.json');
const scripts=path.dirname(fileURLToPath(import.meta.url));
function read(name){try{return JSON.parse(readFileSync(path.join(dir,name),'utf8'));}catch{return null;}}
function localAddress(value){try{const u=new URL(value);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'?u.origin:null;}catch{return null;}}
async function health(address){try{if(!address)return null;const r=await fetch(address+'/health',{signal:AbortSignal.timeout(4000),redirect:'error'});if(!r.ok)return null;return await r.json();}catch{return null;}}
function options(){
 const saved=read('console-settings.json'),runtime=read('runtime.json');
 let port=18766;try{port=Number(new URL(runtime.address).port)||18766;}catch{}
 return {workspace:saved?.workspace||runtime?.roots?.[0]||path.join(os.homedir(),'Documents','Codex'),port:Number.isInteger(saved?.port)&&saved.port>0&&saved.port<65536?saved.port:port};
}
function save(value){
 mkdirSync(dir,{recursive:true});const temp=path.join(dir,`console-settings.${randomUUID()}.tmp`);
 try{writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx'});renameSync(temp,settingsFile);}finally{rmSync(temp,{force:true});}
}
async function overview(){
 const runtime=read('runtime.json'),external=read('external.json'),fixed=read('fixed-tunnel.json');
 const [backendHealth,tunnelHealth]=await Promise.all([health(localAddress(runtime?.address)),health(localAddress(external?.control))]);
 const backend=Boolean(runtime&&backendHealth&&backendHealth.service==='codex-phone-bridge'&&backendHealth.instanceId===runtime.instanceId&&backendHealth.ready===true);
 const tunnel=Boolean(external&&tunnelHealth&&tunnelHealth.instanceId===external.instanceId&&tunnelHealth.ready===true);
 const address=external?.url||(fixed?.hostname?'https://'+fixed.hostname:null);
 return {backend,tunnel,address,instanceId:backend?runtime.instanceId:null,runtime,external};
}
async function display(checkPublic=false){
 const s=await overview(),selected=options();
 console.log('电脑后台：'+(s.backend?'运行中':'未启动'));
 console.log('外网入口：'+(s.tunnel?'运行中':'未启动'));
 console.log('手机地址：'+(s.address||'尚未配置'));
 console.log('项目目录：'+selected.workspace);
 console.log('附件目录：'+configuredFileRoot(dir));
 console.log('操作审批：'+reviewerLabel(executionSettings(dir).approvalsReviewer));
 if(s.backend&&s.runtime.roots?.[0]!==selected.workspace)console.log('当前运行目录：'+s.runtime.roots?.[0]+'（新目录将在下次停止并启动后生效）');
 if(checkPublic&&s.backend&&s.tunnel&&s.address){
  console.log('正在检查固定入口是否可达……');
  let expectedHost;try{expectedHost=new URL(s.address).host;}catch{}
  const h=await health(s.address);
  console.log('外网访问：'+(h?.instanceId===s.instanceId&&h.ready&&h.deviceSecurity===true&&h.deviceAuthority===expectedHost?'正常，可到达本机后台':'暂未通过，请检查网络、域名路由或稍后重试'));
 }
 return s;
}
async function ask(prompt){
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{return (await rl.question(prompt)).trim();}finally{rl.close();}
}
async function run(file,args=[],interactive=false){
 if(interactive){
  // Let Windows finish releasing the menu's console read before handing input to a child.
  process.stdin.pause();await new Promise(resolve=>setImmediate(resolve));
  await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[path.join(scripts,file),...args],{windowsHide:true,env:{...process.env},stdio:'inherit'});
   child.once('error',()=>reject(Error('操作无法启动，请检查电脑运行环境。')));
   child.once('close',code=>code===0?resolve():reject(Error('操作未完成，请查看上面的提示。')));
  });return;
 }
 const r=spawnSync(process.execPath,[path.join(scripts,file),...args],{windowsHide:true,env:{...process.env},encoding:'utf8',timeout:130000,maxBuffer:262144});
 if(r.error||r.status!==0)throw Error((r.stderr||r.stdout||r.error?.message||'操作未完成，请查看后台日志。').trim());
}
async function start(autoStartedAt=0){
 if(!autoStartedAt)cancelPendingStartup();
 const checkCancelled=()=>{if(autoStartedAt&&startupCancelled(autoStartedAt))throw Error('本次自动启动已取消。');};
 checkCancelled();
 const value=options();if(!existsSync(value.workspace)||!statSync(value.workspace).isDirectory())throw Error('项目目录不存在，请先到设置里修改目录。');
 save(value);
 console.log('正在启动电脑后台……');await run('manage.mjs',['start','--workspace',value.workspace,'--host','0.0.0.0','--port',String(value.port)]);
 checkCancelled();
 console.log('正在连接外网……');await run('external.mjs',['start']);
 checkCancelled();
 console.log('\n手机连接已启动。');await display();
 console.log('\n现在可以关闭这个窗口；后台和外网会继续运行。');
}
async function stop(){
 cancelPendingStartup();
 // Persist the selected workspace before manage.mjs removes runtime.json.
 save(options());
 console.log('正在关闭外网……');await run('external.mjs',['stop']);
 console.log('正在停止电脑后台……');await run('manage.mjs',['stop']);
 console.log('手机连接已停止。');
}
async function changeWorkspace(){
 const value=options();console.log('当前项目目录：'+value.workspace);
 const input=(await ask('输入新的项目目录（回车取消）：')).replace(/^"(.*)"$/,'$1');if(!input)return;
 if(!path.isAbsolute(input))throw Error('请填写完整的电脑文件夹路径。');
 if(!existsSync(input)||!statSync(input).isDirectory())throw Error('文件夹不存在，没有修改。');
 save({...value,workspace:path.resolve(input)});console.log('项目目录已保存；下次停止并重新启动连接后生效。');
}
async function settings(){
 while(true){
  let startup;try{startup=startupSetting();}catch{}
  console.log('\n设置与手机审批');
  console.log('1. 审批 / 撤销手机');console.log('2. 设置账号密码');console.log('3. 设置固定外网');console.log('4. 修改项目目录');console.log('5. '+(startup?.enabled?'关闭':'开启')+'开机自动启动'+(startup?'':'（状态读取失败）'));console.log('6. 修改电脑附件目录');console.log('7. 设置操作审批（手动 / 帮我批准）');console.log('0. 返回主菜单');
  const choice=await ask('请选择：');if(choice==='0'||choice==='')return;
  try{
   if(choice==='1')await run('devices.mjs',[],true);
   else if(choice==='2')await run('account.mjs',[],true);
   else if(choice==='3'){
    if(!(await overview()).backend)throw Error('请先返回主菜单，选择“启动手机连接”，启动后台后再设置固定外网。');
    await run('external.mjs',['configure'],true);
   }
   else if(choice==='4')await changeWorkspace();
   else if(choice==='6')await run('attachment-settings.mjs',[],true);
   else if(choice==='7')await run('execution-settings.mjs',[],true);
   else if(choice==='5'){
    const current=startupSetting();const result=startupSetting(current.enabled?'disable':'enable');
    console.log(result.enabled?'已开启：登录 Windows 后，后台和外网将在隐藏窗口中自动启动。':'已关闭开机自动启动；当前已运行的连接继续运行。');
   }
   else console.log('请输入菜单中的数字。');
  }catch(e){console.log('\n'+e.message);}
 }
}
async function main(){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('需要 Node.js 24 或更新版本。');
 if(process.argv[2]==='--status'){await display(true);return;}
 if(process.argv[2]==='--start-on-login'){
  const startedAt=Number(process.argv[3]);if(!Number.isFinite(startedAt)||startedAt<=0)throw Error('自动启动参数不正确。');
  await start(startedAt);return;
 }
 if(!process.stdin.isTTY)throw Error('请在电脑上双击“控制台.cmd”。');
 let startupRepairWarning='';
 try{repairStartupLocation();}catch{startupRepairWarning='开机自启位置暂未更新，可在设置中关闭再开启；不影响手动使用。';}
 while(true){
  console.clear();console.log('CodexLink 控制台\n');await display();
  if(startupRepairWarning)console.log(startupRepairWarning);
  console.log('\n1. 启动手机连接（后台 + 外网）');console.log('2. 查看状态与连接地址');console.log('3. 停止手机连接（外网 + 后台，会中断手机任务）');console.log('4. 设置与手机审批');console.log('0. 退出窗口（服务继续运行）');
  const choice=await ask('请选择：');if(choice==='0'||choice==='')return;
  try{
   if(choice==='1')await start();
   else if(choice==='2')await display(true);
   else if(choice==='3')await stop();
   else if(choice==='4'){await settings();continue;}
   else{console.log('请输入菜单中的数字。');}
  }catch(e){console.log('\n'+e.message);}
  await ask('\n按回车返回主菜单……');
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
