import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {hostnameFrom,tokenFrom,readConfig,saveConfig} from './tunnel-config.mjs';

export async function configureTunnel(dir){
 if(!process.stdin.isTTY)throw Error('请打开“控制台.cmd”，进入“设置与手机审批 → 设置固定外网”。');
 const old=readConfig(dir),defaultHost=old?.hostname||process.env.BRIDGE_PUBLIC_HOSTNAME||'';let muted=false;
 const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
 const rl=createInterface({input:process.stdin,output,terminal:true});
 try{
  console.log('设置固定外网：只保存隧道配置，不修改后台密码或手机批准记录。');
  const prompt=defaultHost?`固定域名（回车使用 ${defaultHost}）：`:'固定域名（例如 codex.example.com）：';
  const host=hostnameFrom((await rl.question(prompt)).trim()||defaultHost);
  console.log('请复制 Cloudflare 网页上 cloudflared.exe service install 开头的完整命令。');
  console.log('在下面粘贴后按回车；输入内容不会显示，也不会执行这条安装命令。');
  process.stdout.write('粘贴完整命令：');muted=true;const input=await rl.question('');muted=false;console.log();
  if(!input.trim()){console.log('已取消，原配置未修改。');return null;}
  const {token}=tokenFrom(input);const c=saveConfig(dir,host,token);
  console.log('已保存固定域名：https://'+c.hostname);
  console.log('隧道凭据已由当前 Windows 用户加密保存。正在连接隧道……');
  return c;
 }finally{muted=false;rl.close();}
}
