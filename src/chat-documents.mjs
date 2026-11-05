import {Worker} from 'node:worker_threads';

export const DOCUMENT_TEXT_LIMIT=100000;
export const DOCUMENT_TOTAL_LIMIT=240000;
let active=0;
// Only bytes supplied by the authenticated upload route enter the parser. No paths or URLs.
export async function extractDocument(name,body){
 if(active>=2)throw Error('文件解析繁忙，请稍后重试上传。');
 active++;
 try{return await new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./chat-documents-worker.mjs',import.meta.url),{workerData:{name,body},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:128,stackSizeMb:4}});
  let settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);worker.terminate();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Error('文件解析超时，请拆分文件后重试。')),12000);
  worker.once('message',m=>finish(m.error?Error(m.error):null,m.result));
  worker.once('error',()=>finish(Error('文件无法解析或内容过于复杂，请转换为 TXT 或文字型 PDF。')));
  worker.once('exit',()=>finish(Error('文件解析中断，请转换格式后重试。')));
 });}finally{active--;}
}
