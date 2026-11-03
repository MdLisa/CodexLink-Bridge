import path from 'node:path';
import {lstat,realpath,readFile,open} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';

export const UPDATE_PREFIX='/updates/android/';
export const APK_NAME=/^CodexLink-[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]*-[a-f0-9]{16}\.apk$/;
export const MAX_APK_BYTES=200*1024*1024;
export function validateRelease(j){
  if(j?.schemaVersion!==1||j.packageName!=='com.xukaizhe.codexlink'||!Number.isSafeInteger(j.versionCode)||j.versionCode<1||j.versionCode>2147483647||
    typeof j.versionName!=='string'||!/^\d+\.\d+\.\d+$/.test(j.versionName)||!Number.isSafeInteger(j.size)||j.size<1||j.size>MAX_APK_BYTES||
    typeof j.sha256!=='string'||!/^[a-f0-9]{64}$/.test(j.sha256)||typeof j.notes!=='string'||j.notes.length>8000||
    !Number.isSafeInteger(j.minSdk)||j.minSdk<26||j.minSdk>2147483647||typeof j.file!=='string'||!APK_NAME.test(j.file)||
    j.file!==`CodexLink-${j.versionName}-${j.versionCode}-${j.sha256.slice(0,16)}.apk`||
    j.downloadUrl!==`https://codex.shbj.site${UPDATE_PREFIX}${j.file}`)throw Error('Invalid Android release');
  return j;
}
async function safeFile(dir,name){
  const root=await realpath(dir),file=path.join(root,name),s=await lstat(file);
  if(!s.isFile()||s.isSymbolicLink()||path.dirname(await realpath(file))!==root)throw Error('Invalid update file');
  return file;
}
// Only these public distribution routes bypass device login. No upload or directory listing.
export async function serveAndroidUpdate(req,res,url,dir){
  if(!url.pathname.startsWith(UPDATE_PREFIX))return false;
  const fail=(status,message)=>{res.writeHead(status,{'content-type':'application/json;charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({error:message}));};
  if(!['GET','HEAD'].includes(req.method)){res.setHeader('allow','GET, HEAD');fail(405,'Method not allowed');return true;}
  const name=url.pathname.slice(UPDATE_PREFIX.length);
  if(url.search||(name!=='latest.json'&&!APK_NAME.test(name))){fail(404,'Update not found');return true;}
  let handle;
  try{
    if(name==='latest.json'){
      const file=await safeFile(dir,name);if((await lstat(file)).size>32768)throw Error('Manifest too large');
      const release=validateRelease(JSON.parse(await readFile(file,'utf8')));
      const apk=await safeFile(dir,release.file);if((await lstat(apk)).size!==release.size)throw Error('Release incomplete');
      const body=JSON.stringify(release);
      res.writeHead(200,{'content-type':'application/json;charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store','x-content-type-options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:body);
    }else{
      const file=await safeFile(dir,name);handle=await open(file,'r');const stat=await handle.stat();
      if(!stat.isFile()||stat.size<1||stat.size>MAX_APK_BYTES)throw Error('Invalid APK size');
      res.writeHead(200,{'content-type':'application/vnd.android.package-archive','content-length':stat.size,'content-disposition':`attachment; filename="${name}"`,'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'});
      if(req.method==='HEAD')res.end();else await pipeline(handle.createReadStream({autoClose:false}),res);
    }
  }catch{if(!res.headersSent)fail(404,'Update unavailable');else res.destroy();}
  finally{await handle?.close().catch(()=>{});}
  return true;
}
