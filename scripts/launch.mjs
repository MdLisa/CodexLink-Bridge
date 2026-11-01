import {createInterface} from 'node:readline/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
if(Number(process.versions.node.split('.')[0])<24){console.error('需要 Node.js 24 或更新版本。');process.exit(1);}
const args=process.argv.slice(2);
if(args[0]==='start'){
 const input=createInterface({input:process.stdin,output:process.stdout});
 const answer=await input.question('请输入允许手机操作的项目目录，直接回车使用 Documents\\Codex：');input.close();
 const workspace=answer.trim().replace(/^"(.*)"$/,'$1')||path.join(os.homedir(),'Documents','Codex');args.push('--workspace',workspace,'--host','0.0.0.0');
}
const external=args[0]?.startsWith('external-');if(external)args[0]=args[0].slice(9);
const r=spawnSync(process.execPath,[fileURLToPath(new URL(external?'./external.mjs':args[0]==='account'?'./account.mjs':args[0]==='devices'?'./devices.mjs':'./manage.mjs',import.meta.url)),...args],{windowsHide:true,stdio:'inherit'});if(r.error)console.error(r.error.message);process.exitCode=r.status??1;
