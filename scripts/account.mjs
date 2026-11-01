import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import {readFileSync,existsSync} from 'node:fs';
import {Accounts} from '../src/accounts.mjs';

const dir=process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge');
async function main(){
 if(!process.stdin.isTTY)throw Error('请打开“控制台.cmd”，进入“设置与手机审批 → 设置账号密码”。');
 const accounts=new Accounts(dir),old=accounts.current();
 console.log('账号密码只保存在这台电脑；设置或重置后，旧手机登录将失效。');
 if(old)console.log('当前账号：'+old.username);
 let muted=false;
 const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
 const rl=createInterface({input:process.stdin,output,terminal:true});
 try{
  const username=(await rl.question('账号（回车使用 '+(old?.username||'codex')+'）：')).trim()||old?.username||'codex';
  console.log('密码至少 8 个字符，可以使用短句；输入时不会显示。');
  process.stdout.write('新密码：');muted=true;const password=await rl.question('');muted=false;console.log();
  process.stdout.write('再输一次：');muted=true;const repeated=await rl.question('');muted=false;console.log();
  if(password!==repeated)throw Error('两次输入的密码不同，没有修改。');
  const runtimeFile=path.join(dir,'runtime.json');let runtime;
  if(existsSync(runtimeFile)){
   runtime=JSON.parse(readFileSync(runtimeFile,'utf8'));const u=new URL(runtime.address);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw Error('后台管理地址不正确。');
   const check=await fetch(runtime.address+'/admin/account-ready',{headers:{'x-bridge-admin':runtime.adminToken},signal:AbortSignal.timeout(3000)});
   if(!check.ok)throw Error('请先启动最新版电脑后台，再设置账号密码。');
  }
  await accounts.set(username,password);
  if(runtime)try{await fetch(runtime.address+'/admin/auth-changed',{method:'POST',headers:{'x-bridge-admin':runtime.adminToken},signal:AbortSignal.timeout(3000)});}catch{}
  console.log('账号密码已设置：'+username+'。请在手机使用新账号密码登录。');
 }finally{muted=false;rl.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
