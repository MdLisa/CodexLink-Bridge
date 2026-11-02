import {readFileSync,mkdirSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function reviewerValue(value){
  if(!['user','auto_review'].includes(value))throw Error('审批方式只能是手动审批或帮我批准。');
  return value;
}
export function executionSettings(dataDir){
  let text;try{text=readFileSync(path.join(dataDir,'execution-settings.json'),'utf8');}
  catch(e){if(e.code==='ENOENT')return{approvalsReviewer:'user'};throw e;}
  let value;try{value=JSON.parse(text);}catch{throw Error('审批设置文件格式不正确，请在控制台重新设置。');}
  return{approvalsReviewer:reviewerValue(value?.approvalsReviewer)};
}
export function setExecutionSettings(dataDir,reviewer){
  const value={approvalsReviewer:reviewerValue(reviewer)};
  mkdirSync(dataDir,{recursive:true});const temporary=path.join(dataDir,`execution-settings.${randomUUID()}.tmp`);
  try{writeFileSync(temporary,JSON.stringify(value,null,2),{flag:'wx'});renameSync(temporary,path.join(dataDir,'execution-settings.json'));}
  finally{rmSync(temporary,{force:true});}
  return value;
}
export function reviewerLabel(reviewer){return reviewerValue(reviewer)==='auto_review'?'帮我批准（官方自动审查）':'手动审批';}
