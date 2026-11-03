import {readFileSync,mkdirSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function reviewerValue(value){
  if(!['user','auto_review'].includes(value))throw Error('审批方式只能是手动审批或帮我批准。');
  return value;
}
export function defaultReviewerValue(value){if(value==='chat_only')return value;return reviewerValue(value);}
function readSettings(dataDir){
  let text;try{text=readFileSync(path.join(dataDir,'execution-settings.json'),'utf8');}
  catch(e){if(e.code==='ENOENT')return undefined;throw e;}
  let value;try{value=JSON.parse(text);}catch{throw Error('审批设置文件格式不正确，请在控制台重新设置。');}
  return value;
}
export function executionSettings(dataDir){
  const value=readSettings(dataDir);return{approvalsReviewer:value===undefined?'user':reviewerValue(value?.approvalsReviewer)};
}
export function defaultDeviceSettings(dataDir){
  const value=readSettings(dataDir);
  return{approvalsReviewer:value===undefined?'user':defaultReviewerValue(value?.defaultDeviceReviewer===undefined?value?.approvalsReviewer:value.defaultDeviceReviewer)};
}
export function setExecutionSettings(dataDir,reviewer){
  defaultReviewerValue(reviewer);
  // Keep the legacy programming reviewer valid for running older backends.
  // chat_only selects a phone execution mode; it is never sent to the coding RPC.
  const value={approvalsReviewer:reviewer==='chat_only'?executionSettings(dataDir).approvalsReviewer:reviewer,defaultDeviceReviewer:reviewer};
  mkdirSync(dataDir,{recursive:true});const temporary=path.join(dataDir,`execution-settings.${randomUUID()}.tmp`);
  try{writeFileSync(temporary,JSON.stringify(value,null,2),{flag:'wx'});renameSync(temporary,path.join(dataDir,'execution-settings.json'));}
  finally{rmSync(temporary,{force:true});}
  return{approvalsReviewer:reviewer};
}
export function reviewerLabel(reviewer){if(reviewer==='chat_only')return'仅聊天（允许联网）';return reviewerValue(reviewer)==='auto_review'?'帮我批准（官方自动审查）':'手动审批';}
