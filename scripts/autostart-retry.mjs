export async function startWithRetry({runAttempt,isCancelled,pause,log,attempts=Infinity,delayMs=60000}){
 for(let attempt=1;attempt<=attempts;attempt++){
  if(isCancelled()){log('本次自动启动已取消。');return false;}
  try{await runAttempt();if(isCancelled()){log('本次自动启动已取消。');return false;}log('后台和外网已启动。');return true;}
  catch(e){if(isCancelled()){log('本次自动启动已取消。');return false;}log(`第 ${attempt} 次启动未完成：${String(e.message).slice(0,3000)}`);}
  if(attempt<attempts)await pause(delayMs);
 }
 log('自动重试已结束；可在控制台查看状态或手动启动。');return false;
}
