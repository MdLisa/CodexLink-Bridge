import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {appendFileSync,mkdirSync,existsSync} from 'node:fs';
import {startManager} from './gui-server.mjs';
import {Management,redact} from './management.mjs';

if(Number(process.versions.node.split('.')[0])<24)throw Error('需要 Node.js 24 或更新版本。');
if(process.platform!=='win32')throw Error('图形控制台目前仅支持 Windows。');
const management=new Management();
// Repair an already-enabled startup entry after the application folder was moved.
try{management.repairStartup();}catch{}
// Opening the window does not start/stop a connection or enable/disable startup.
const manager=await startManager({management});
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const nativeHost=process.env.CODEXLINK_WINDOW_HOST||fileURLToPath(new URL('../CodexLink.exe',import.meta.url));
const child=spawn(existsSync(nativeHost)?nativeHost:powershell,existsSync(nativeHost)?['--window']:['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('gui.ps1',import.meta.url))],{
 windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,CODEXLINK_CONTROL_ADDRESS:manager.address,CODEXLINK_CONTROL_TOKEN:manager.token,CODEXLINK_CONTROL_DATA:management.dir}
});
child.stderr.setEncoding('utf8');child.stderr.on('data',message=>{try{mkdirSync(management.dir,{recursive:true});appendFileSync(path.join(management.dir,'gui.log'),redact(message));}catch{}});
child.once('error',async()=>{await manager.close();process.exitCode=1;});
child.once('exit',async(code)=>{await manager.close();process.exitCode=code||0;});
