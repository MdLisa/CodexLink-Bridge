import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export const stateDir=process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge');
const scripts=path.dirname(fileURLToPath(import.meta.url));
export function cancelPendingStartup(){
 mkdirSync(stateDir,{recursive:true});const temp=path.join(stateDir,`startup-cancel.${randomUUID()}.tmp`);
 try{writeFileSync(temp,JSON.stringify({at:Date.now()}),{flag:'wx'});renameSync(temp,path.join(stateDir,'startup-cancel.json'));}finally{rmSync(temp,{force:true});}
}
export function startupCancelled(startedAt){
 try{return JSON.parse(readFileSync(path.join(stateDir,'startup-cancel.json'),'utf8')).at>=startedAt;}catch{return false;}
}
export function repairStartupLocation(){
 const status=startupSetting();if(!status.enabled)return false;
 let saved;try{saved=JSON.parse(readFileSync(path.join(stateDir,'autostart.json'),'utf8'));}catch{}
 const same=(a,b)=>typeof a==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
 if(same(saved?.bridgePath,path.dirname(scripts))&&same(saved?.nodePath,process.execPath))return false;
 startupSetting('enable');return true;
}
export function startupSetting(action='status'){
 if(process.platform!=='win32')throw Error('开机自动启动目前需要 Windows。');
 if(action==='disable')cancelPendingStartup();
 if(action==='enable'){
  const file=path.join(stateDir,'console-settings.json');
  if(!existsSync(file)){
   let runtime;try{runtime=JSON.parse(readFileSync(path.join(stateDir,'runtime.json'),'utf8'));}catch{}
   let port=18766;try{port=Number(new URL(runtime.address).port)||18766;}catch{}
   mkdirSync(stateDir,{recursive:true});writeFileSync(file,JSON.stringify({workspace:runtime?.roots?.[0]||path.join(os.homedir(),'Documents','Codex'),port}),{flag:'wx'});
  }
 }
 const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const r=spawnSync(exe,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(scripts,'startup-settings.ps1'),'-Action',action,'-NodePath',process.execPath,'-BridgePath',path.dirname(scripts),'-DataDir',stateDir],{windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:65536});
 if(r.error||r.status!==0)throw Error('未能'+(action==='enable'?'开启':action==='disable'?'关闭':'读取')+'开机自动启动，请检查当前 Windows 用户权限。');
 try{return JSON.parse(r.stdout.trim());}catch{throw Error('无法读取开机自动启动状态。');}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(startupSetting(process.argv[2]||'status')));}catch(e){console.error(e.message);process.exitCode=1;}
}
