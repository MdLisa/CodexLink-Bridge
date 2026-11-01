import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync,writeFileSync,readFileSync,appendFileSync,existsSync,statSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {stateDir,startupCancelled} from './startup-settings.mjs';
import {startWithRetry} from './autostart-retry.mjs';

const scripts=path.dirname(fileURLToPath(import.meta.url));
const logFile=path.join(stateDir,'autostart.log'),lockFile=path.join(stateDir,'autostart.lock');
function log(message){
 mkdirSync(stateDir,{recursive:true});
 if(existsSync(logFile)&&statSync(logFile).size>524288)writeFileSync(logFile,readFileSync(logFile,'utf8').slice(-131072));
 appendFileSync(logFile,`[${new Date().toISOString()}] ${message}\n`);
}
function acquire(startedAt){
 mkdirSync(stateDir,{recursive:true});
 const owner={id:randomUUID(),pid:process.pid,startedAt,bootTime:Date.now()-os.uptime()*1000};
 for(let attempt=0;attempt<2;attempt++){
  try{const fd=openSync(lockFile,'wx');try{writeFileSync(fd,JSON.stringify(owner));}finally{closeSync(fd);}return owner;}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   let prior;try{prior=JSON.parse(readFileSync(lockFile,'utf8'));}catch{}
   let alive=false;try{if(prior?.pid){process.kill(prior.pid,0);alive=true;}}catch{}
   // A network wait may last indefinitely. Keep its lock for the current boot.
   if(alive&&(prior.bootTime?Math.abs(owner.bootTime-prior.bootTime)<120000:startedAt-prior.startedAt<10*60*1000))return null;
   rmSync(lockFile,{force:true});
  }
 }
 return null;
}
async function runAttempt(startedAt){
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(scripts,'console.mjs'),'--start-on-login',String(startedAt)],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env},timeout:135000});
  let output='';const collect=b=>{output=(output+b.toString('utf8')).slice(-8192);};child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.once('error',()=>reject(Error('无法运行连接程序。')));
  child.once('close',code=>code===0?resolve():reject(Error(output.trim()||'连接程序未能启动。')));
 });
}
async function main(){
 const startedAt=Date.now(),owner=acquire(startedAt);if(!owner)return;
 try{
  log('准备自动启动，等待登录后的网络就绪。');await pause(15000);
  const ok=await startWithRetry({runAttempt:()=>runAttempt(startedAt),isCancelled:()=>startupCancelled(startedAt),pause,log});
  if(!ok&&!startupCancelled(startedAt))process.exitCode=1;
 }finally{try{if(JSON.parse(readFileSync(lockFile,'utf8')).id===owner.id)rmSync(lockFile,{force:true});}catch{}}
}
main().catch(e=>{log('自动启动失败：'+e.message);process.exitCode=1;});
