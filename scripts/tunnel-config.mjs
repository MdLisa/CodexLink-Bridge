import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export function hostnameFrom(input){
 const value=String(input).trim();
 let u;try{u=new URL(value.includes('://')?value:'https://'+value);}catch{throw Error('请输入域名，例如 codex.example.com。');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!u.hostname.includes('.')||!/^[a-z0-9.-]+$/i.test(u.hostname)||u.hostname.length>253||u.hostname.split('.').some(x=>!x||x.length>63||! /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(x)))throw Error('请输入 HTTPS 域名，不带路径、端口或账号。');
 return u.hostname.toLowerCase();
}
export function tokenFrom(input){
 const value=String(input).trim();
 const m=value.match(/^(?:(?:"[^"\r\n]*cloudflared\.exe"|cloudflared(?:\.exe)?)\s+(?:service\s+install|tunnel\s+run\s+--token)\s+)?["']?([A-Za-z0-9_+/=-]{80,8192})["']?$/i);
 let details;try{if(!m)throw Error();details=JSON.parse(Buffer.from(m[1],'base64').toString('utf8'));}catch{throw Error('没有识别到完整隧道凭据。请点击网页命令右侧的复制按钮，再粘贴完整命令。');}
 if(!/^[a-f0-9]{32}$/i.test(details.a||'')||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(details.t||'')||typeof details.s!=='string'||Buffer.from(details.s,'base64').length<16)throw Error('隧道凭据格式不正确，请重新复制网页上的完整命令。');
 return {token:m[1],tunnelId:details.t};
}
function dpapi(action,input){
 if(process.platform!=='win32')throw Error('固定隧道配置目前需要 Windows。');
 const operation=action==='protect'?'Protect':'Unprotect';
 const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
 const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const r=spawnSync(exe,['-NoProfile','-NonInteractive','-Command',script],{input:Buffer.from(input).toString('base64'),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:65536});
 if(r.error||r.status!==0||!r.stdout.trim())throw Error(action==='protect'?'Windows 未能加密保存隧道凭据，没有修改配置。':'无法解密隧道凭据，请用原 Windows 用户运行，或重新设置固定外网。');
 return Buffer.from(r.stdout.trim(),'base64');
}
export function readConfig(dir){
 const file=path.join(dir,'fixed-tunnel.json');if(!existsSync(file))return null;
 let c;try{c=JSON.parse(readFileSync(file,'utf8'));}catch{throw Error('固定外网配置无法读取，请重新运行“设置固定外网.cmd”。');}
 if(c.version!==1||!c.id||!c.tokenProtected||hostnameFrom(c.hostname)!==c.hostname)throw Error('固定外网配置不完整，请重新设置。');
 return c;
}
export function saveConfig(dir,hostname,token){
 const parsed=tokenFrom(token),c={version:1,id:randomUUID(),hostname:hostnameFrom(hostname),tunnelId:parsed.tunnelId,tokenProtected:dpapi('protect',Buffer.from(parsed.token,'utf8')).toString('base64')};
 mkdirSync(dir,{recursive:true});const temp=path.join(dir,`fixed-tunnel.${process.pid}.${randomUUID()}.tmp`);
 try{writeFileSync(temp,JSON.stringify(c,null,2),{flag:'wx',mode:0o600});renameSync(temp,path.join(dir,'fixed-tunnel.json'));}finally{rmSync(temp,{force:true});}
 return c;
}
export function decryptToken(config){const token=dpapi('unprotect',Buffer.from(config.tokenProtected,'base64')).toString('utf8');return tokenFrom(token).token;}
