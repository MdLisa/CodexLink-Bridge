import {createInterface} from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import {executionSettings,setExecutionSettings,reviewerLabel} from '../src/execution-settings.mjs';

const dataDir=process.env.BRIDGE_DATA_DIR||path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexPhoneBridge');
async function main(){
  console.log('新手机默认操作审批：'+reviewerLabel(executionSettings(dataDir).approvalsReviewer));
  console.log('1. 手动审批\n2. 帮我批准（官方自动审查）\n0. 取消');
  console.log('帮我批准会审查权限申请并决定允许或拒绝，部分情况仍需你处理。原有文件和联网限制保持不变。');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  let choice;try{choice=(await rl.question('请选择：')).trim();}finally{rl.close();}
  if(!choice||choice==='0')return;
  if(!['1','2'].includes(choice))throw Error('请输入菜单中的数字，没有修改。');
  const value=setExecutionSettings(dataDir,choice==='2'?'auto_review':'user');
  console.log('已保存：'+reviewerLabel(value.approvalsReviewer)+'。');
  console.log('仅作为尚未初始化审批配置的手机的默认值；已配置手机、排队任务、运行中的任务和已弹出的审批保持原样。修改某台手机请使用“设置手机操作审批”。');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
