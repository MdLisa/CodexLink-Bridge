import {createInterface} from 'node:readline/promises';
import {Store} from '../src/store.mjs';
import {Accounts} from '../src/accounts.mjs';
import {DeviceSecurity} from '../src/device-security.mjs';
import {ProjectAccess,defaultProjectRoots,validateScope} from '../src/project-access.mjs';
import {DeviceApprovals} from '../src/device-approvals.mjs';
import {executionSettings,reviewerLabel} from '../src/execution-settings.mjs';
import {TakeoverPermissions} from '../src/desktop-takeover.mjs';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir=process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge');
async function main(){
 if(!process.stdin.isTTY)throw Error('请打开“控制台.cmd”，进入“设置与手机审批 → 审批 / 撤销手机”。');
 const account=new Accounts(dir).current();if(!account)throw Error('请先设置账号密码。');
 const store=new Store(dir),security=new DeviceSecurity(store),access=new ProjectAccess(store,defaultProjectRoots(dir),()=>account.generation),rl=createInterface({input:process.stdin,output:process.stdout});
 const approvals=new DeviceApprovals(store,()=>executionSettings(dir).approvalsReviewer,()=>account.generation);
 const takeover=new TakeoverPermissions(store,()=>account.generation);
 const approvalLabel=value=>{if(value==='chat_only')return'仅聊天（允许联网）';try{return reviewerLabel(value);}catch{return'配置损坏，请重新设置';}};
 const label=p=>p.mode==='all'?'所有目录（不限制聊天项目）':p.mode==='directories'&&Array.isArray(p.roots)?p.roots.join('、'):'配置损坏，请重新指定项目范围';
 async function configure(d){
  const current=access.view(d.fingerprint,account.generation);console.log('当前项目范围：'+label(current));
  const mode=(await rl.question('1 指定一个或多个目录；2 所有目录；回车保留当前范围：')).trim();if(!mode)return false;
  let policy;if(mode==='2')policy={mode:'all',roots:[]};else if(mode==='1'){
   const roots=[];console.log('每行输入一个完整目录路径，至少一个；空行结束。');
   while(true){const p=(await rl.question('目录：')).trim().replace(/^"(.*)"$/,'$1');if(!p)break;roots.push(p);}policy=validateScope({mode:'directories',roots});
  }else throw Error('请输入 1 或 2。');
  console.log('将设置为：'+label(policy));if((await rl.question('输入 Y 保存，其他输入取消：')).trim().toUpperCase()!=='Y')return false;
  let runtime;try{runtime=JSON.parse(readFileSync(path.join(dir,'runtime.json'),'utf8'));}catch{}
  if(runtime){const u=new URL(runtime.address);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('后台管理地址无效，请先停止后台。');
   let response;try{response=await fetch(runtime.address+'/admin/project-access',{method:'POST',headers:{'x-bridge-admin':runtime.adminToken,'content-type':'application/json'},body:JSON.stringify({...policy,fingerprint:d.fingerprint,generation:account.generation}),signal:AbortSignal.timeout(5000)});}catch{throw Error('无法连接后台确认运行中的任务，请先停止后台，再修改手机项目范围。');}
   const result=await response.json();if(!response.ok)throw Error(result.error?.message||'保存项目范围失败，请更新电脑后台。');
  }else access.set(d.fingerprint,account.generation,policy);
  console.log('已保存。已登录手机会重新连接并刷新项目范围，无需重启后台。');return true;
 }
 async function configureApprovals(d){
  console.log('当前操作审批：'+approvalLabel(approvals.view(d.fingerprint,account.generation).approvalsReviewer));
  const choice=(await rl.question('1 手动审批；2 帮我批准（官方自动审查）；3 仅聊天（允许联网）；回车保留：')).trim();if(!choice)return;
  if(!['1','2','3'].includes(choice))throw Error('请输入 1、2 或 3，没有修改。');const reviewer=choice==='3'?'chat_only':choice==='2'?'auto_review':'user';
  const switchMode=(approvals.view(d.fingerprint,account.generation).approvalsReviewer==='chat_only')!==(reviewer==='chat_only');
  console.log('将设置为：'+approvalLabel(reviewer)+(switchMode?'。切换前需停止或等待该手机正在运行的任务；旧模式排队任务将取消，手机会切换聊天列表。仅聊天只看本设备独立聊天，不能访问电脑项目、文件或接管桌面。':'。新消息生效；已提交任务保留原审批设置。'));
  if((await rl.question('输入 Y 保存，其他输入取消：')).trim().toUpperCase()!=='Y')return;
  let runtime;try{runtime=JSON.parse(readFileSync(path.join(dir,'runtime.json'),'utf8'));}catch{}
  if(runtime){const u=new URL(runtime.address);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('后台管理地址无效，请先停止后台。');
   let response;try{response=await fetch(runtime.address+'/admin/device-approvals',{method:'POST',headers:{'x-bridge-admin':runtime.adminToken,'content-type':'application/json'},body:JSON.stringify({fingerprint:d.fingerprint,generation:account.generation,approvalsReviewer:reviewer}),signal:AbortSignal.timeout(5000)});}catch{throw Error('无法连接后台保存审批设置，请先停止后台，再设置。');}
   const result=await response.json();if(!response.ok)throw Error(result.error?.message||'保存失败，请更新后台。');
  }else{if(switchMode)for(const j of store.queued(null))if(j.device_key===d.fingerprint)store.updateJob(j.id,'cancelled',{error:'聊天模式已切换，旧模式排队任务已取消。'});approvals.set(d.fingerprint,account.generation,reviewer);}
  console.log('已保存该手机操作审批，无需重新登录或重启后台。');
 }
 async function configureTakeover(d){
  console.log('当前退出电脑端并接管权限：'+(takeover.view(d.fingerprint,account.generation)?'已开启':'未开启'));
  console.log('开启后，这台手机可在明确确认后请求退出整个桌面 Codex，可能中断电脑上的其他任务；不会强制杀进程。只给你信任的手机开启。');
  const choice=(await rl.question('1 开启；2 关闭；回车保留：')).trim();if(!choice)return;if(!['1','2'].includes(choice))throw Error('请输入 1 或 2。');
  const enabled=choice==='1';if((await rl.question('输入 Y 保存，其他输入取消：')).trim().toUpperCase()!=='Y')return;
  let runtime;try{runtime=JSON.parse(readFileSync(path.join(dir,'runtime.json'),'utf8'));}catch{}
  if(runtime){const u=new URL(runtime.address);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('后台管理地址无效。');
   let response;try{response=await fetch(runtime.address+'/admin/desktop-takeover',{method:'POST',headers:{'x-bridge-admin':runtime.adminToken,'content-type':'application/json'},body:JSON.stringify({fingerprint:d.fingerprint,generation:account.generation,enabled}),signal:AbortSignal.timeout(5000)});}catch{throw Error('无法连接后台，请停止后台后再配置。');}
   const result=await response.json();if(!response.ok)throw Error(result.error?.message||'保存失败，请更新后台。');
  }else takeover.set(d.fingerprint,account.generation,enabled);
  console.log(enabled?'已授权此手机退出电脑端并接管。':'已关闭此手机的退出电脑端权限。');
 }
 try{const devices=security.list().filter(d=>d.generation===account.generation);if(!devices.length){console.log('没有设备请求。请先在手机登录一次，看到核对码后重新进入手机审批菜单。');return;}
  console.log('只批准你正在操作的手机；请核对手机屏幕上的核对码。');
  devices.forEach((d,i)=>console.log(`${i+1}. ${d.name}  ${d.status==='pending'?'等待批准':d.status==='approved'?'已批准':'已撤销'}  核对码：${d.code}\n   项目范围：${label(access.view(d.fingerprint,account.generation))}\n   操作审批：${approvalLabel(approvals.view(d.fingerprint,account.generation).approvalsReviewer)}\n   退出电脑端并接管：${takeover.view(d.fingerprint,account.generation)?'已授权':'未授权'}`));
  const input=await rl.question('输入设备序号（回车退出）：');if(!input.trim())return;const d=devices[Number(input)-1];if(!d)throw Error('设备序号不正确。');
  console.log(`已选择：${d.name}  核对码：${d.code}`);
  if(process.argv.includes('--approvals')){await configureApprovals(d);return;}
  const choice=(await rl.question('核对手机上的码一致后，输入 A 批准；P 项目范围；E 操作审批；T 退出电脑端并接管权限；R 撤销（回车取消）：')).trim().toUpperCase();
  if(choice==='A'){await configure(d);await configureApprovals(d);security.approve(d.fingerprint,d.code,account.generation);console.log('已批准，请回手机再次点击登录。');}
  else if(choice==='P'){await configure(d);}
  else if(choice==='E'){await configureApprovals(d);}
  else if(choice==='T'){await configureTakeover(d);}
  else if(choice==='R'){security.revoke(d.fingerprint);console.log('已撤销，该手机不能继续访问。');}
  else return;
  try{const r=JSON.parse(readFileSync(path.join(dir,'runtime.json'),'utf8'));const u=new URL(r.address);if(u.hostname==='127.0.0.1'&&u.protocol==='http:')await fetch(r.address+'/admin/auth-changed',{method:'POST',headers:{'x-bridge-admin':r.adminToken},signal:AbortSignal.timeout(3000)});}catch{}
 }finally{rl.close();store.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
