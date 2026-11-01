import {createInterface} from 'node:readline/promises';
import {Store} from '../src/store.mjs';
import {Accounts} from '../src/accounts.mjs';
import {DeviceSecurity} from '../src/device-security.mjs';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir=process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge');
async function main(){
 if(!process.stdin.isTTY)throw Error('请打开“控制台.cmd”，进入“设置与手机审批 → 审批 / 撤销手机”。');
 const account=new Accounts(dir).current();if(!account)throw Error('请先设置账号密码。');
 const store=new Store(dir),security=new DeviceSecurity(store),rl=createInterface({input:process.stdin,output:process.stdout});
 try{const devices=security.list().filter(d=>d.generation===account.generation);if(!devices.length){console.log('没有设备请求。请先在手机登录一次，看到核对码后重新进入手机审批菜单。');return;}
  console.log('只批准你正在操作的手机；请核对手机屏幕上的核对码。');
  devices.forEach((d,i)=>console.log(`${i+1}. ${d.name}  ${d.status==='pending'?'等待批准':d.status==='approved'?'已批准':'已撤销'}  核对码：${d.code}`));
  const input=await rl.question('输入设备序号（回车退出）：');if(!input.trim())return;const d=devices[Number(input)-1];if(!d)throw Error('设备序号不正确。');
  console.log(`已选择：${d.name}  核对码：${d.code}`);
  const choice=(await rl.question('核对手机上的码一致后，输入 A 批准；R 撤销（回车取消）：')).trim().toUpperCase();
  if(choice==='A'){security.approve(d.fingerprint,d.code,account.generation);console.log('已批准，请回手机再次点击登录。');}
  else if(choice==='R'){security.revoke(d.fingerprint);console.log('已撤销，该手机不能继续访问。');}
  else return;
  try{const r=JSON.parse(readFileSync(path.join(dir,'runtime.json'),'utf8'));const u=new URL(r.address);if(u.hostname==='127.0.0.1'&&u.protocol==='http:')await fetch(r.address+'/admin/auth-changed',{method:'POST',headers:{'x-bridge-admin':r.adminToken},signal:AbortSignal.timeout(3000)});}catch{}
 }finally{rl.close();store.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
