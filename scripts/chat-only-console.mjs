import {createInterface} from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import {ChatOnlyRuntime} from '../src/chat-only.mjs';
if(process.argv.includes('--check-startup')){console.log(`Node.js ${process.versions.node}：仅聊天测试入口可以启动。`);process.exit(0);}
const rl=createInterface({input:process.stdin,output:process.stdout});
const runtime=new ChatOnlyRuntime({dataRoot:process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge'),identity:'local-chat-only-stage-one-trial'});
console.log('仅聊天后台试验：这是独立的测试聊天，不会接管电脑或手机已有会话。');
console.log('允许联网和解题；没有电脑文件、命令、修改文件、电脑操作或子代理工具。输入 /exit 退出。');
runtime.on('delta',d=>process.stdout.write(d.text));
runtime.on('question',async q=>{const answers={};for(const item of q.questions||[])answers[item.id]={answers:[await rl.question('\n'+item.question+' ')]};runtime.answer(q.id,answers);});
try{await runtime.start();const chat=await runtime.create();while(true){const text=await rl.question('\n你：');if(text.trim()==='/exit')break;if(!text.trim())continue;process.stdout.write('Codex：');try{await runtime.ask(chat.id,{text});console.log();}catch(e){console.log('\n'+e.message);}}}
catch(e){console.error('仅聊天后台未能启动：'+e.message);process.exitCode=1;}
finally{await runtime.close();rl.close();}
