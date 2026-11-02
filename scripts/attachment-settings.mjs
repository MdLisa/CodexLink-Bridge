import {createInterface} from 'node:readline/promises';
import {mkdirSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {configuredFileRoot} from '../src/files.mjs';
const data=process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge');
if(!process.stdin.isTTY)throw Error('请在控制台的设置菜单中修改附件目录。');
const rl=createInterface({input:process.stdin,output:process.stdout});
try{
 console.log('当前附件目录：'+configuredFileRoot(data));
 const input=(await rl.question('输入新附件目录（完整路径，回车取消）：')).trim().replace(/^"(.*)"$/,'$1');
 if(input){if(!path.isAbsolute(input))throw Error('请填写完整目录路径。');mkdirSync(input,{recursive:true});mkdirSync(data,{recursive:true});const temp=path.join(data,'attachments-config.'+randomUUID()+'.tmp');try{writeFileSync(temp,JSON.stringify({directory:path.resolve(input)}),{flag:'wx'});renameSync(temp,path.join(data,'attachments-config.json'));}finally{rmSync(temp,{force:true});}console.log('已保存。下次停止并启动连接后，新上传附件使用此目录；原附件保留在原位置。');}
}catch(e){console.error(e.message);process.exitCode=1;}finally{rl.close();}
