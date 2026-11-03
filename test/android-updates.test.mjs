import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {createServer,request} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {serveAndroidUpdate,validateRelease,MAX_APK_BYTES} from '../src/android-updates.mjs';
import {publishRelease} from '../scripts/publish-android-update.mjs';
import {startServer} from '../src/server.mjs';
import {EventEmitter} from 'node:events';

function fixture(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'codex-updates-'));
  t.after(()=>{if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('codex-updates-'))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});});
  const old=path.join(dir,'old.apk'),apk=path.join(dir,'new.apk');writeFileSync(old,'old');writeFileSync(apk,'new apk bytes');
  const info={packageName:'com.xukaizhe.codexlink',versionCode:16,versionName:'0.10.0',minSdk:26,signers:['trusted']};
  const inspect=p=>({...info,versionCode:p===old?15:info.versionCode});
  return{dir,old,apk,info,inspect,publish:()=>publishRelease({apk,trustedApk:old,notes:'更新说明',dir,inspect})};
}
function get(port,url,method='GET') {return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:url,method},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end();});}
test('published manifest switches only after an immutable APK exists, and repeat/downgrade is rejected',t=>{
  const f=fixture(t),r=f.publish();assert.deepEqual(JSON.parse(readFileSync(path.join(f.dir,'latest.json'))),r);assert.equal(r.size,readFileSync(path.join(f.dir,r.file)).length);
  assert.throws(f.publish,/increase/);assert.equal(existsSync(path.join(f.dir,'.publish.lock')),false);
  const before=readFileSync(path.join(f.dir,'latest.json'),'utf8');f.info.versionCode=14;assert.throws(f.publish,/newer/);assert.equal(readFileSync(path.join(f.dir,'latest.json'),'utf8'),before);
});
test('publisher rejects mismatched signatures, packages and malformed releases without replacing latest',t=>{
  const f=fixture(t);f.publish();const before=readFileSync(path.join(f.dir,'latest.json'),'utf8');
  for(const info of [{signers:['other']},{packageName:'another.app'},{versionName:'../evil'},{minSdk:1}])assert.throws(()=>publishRelease({apk:f.apk,trustedApk:f.old,notes:'note',dir:f.dir,inspect:p=>({...f.inspect(p),...(p===f.apk?{versionCode:17,...info}:{})})}));
  assert.equal(readFileSync(path.join(f.dir,'latest.json'),'utf8'),before);
});
test('manifest validation rejects oversized APKs, cross-origin URLs, traversal and mismatched hashes',t=>{
  const f=fixture(t),r=f.publish();
  for(const change of [{size:MAX_APK_BYTES+1},{size:0},{downloadUrl:r.downloadUrl.replace('codex.shbj.site','evil.test')},{file:'../account.json'},{sha256:'0'.repeat(64)},{versionCode:16.5},{notes:'x'.repeat(8001)},{versionName:['0.10.0']},{schemaVersion:2}])assert.throws(()=>validateRelease({...r,...change}));
});
test('public GET/HEAD serve only release files, no credentials, with uncached manifest and immutable APKs',async t=>{
  const f=fixture(t),r=f.publish();writeFileSync(path.join(f.dir,'account.json'),'private');
  const server=createServer(async(req,res)=>{if(!await serveAndroidUpdate(req,res,new URL(req.url,'http://localhost'),f.dir)){res.writeHead(401);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const port=server.address().port;
  const manifest=await get(port,'/updates/android/latest.json');assert.equal(manifest.status,200);assert.equal(manifest.headers['cache-control'],'no-store');assert.deepEqual(JSON.parse(manifest.body),r);
  const apk=await get(port,'/updates/android/'+r.file);assert.equal(apk.status,200);assert.equal(apk.body.toString(),'new apk bytes');assert.match(apk.headers['cache-control'],/immutable/);
  const head=await get(port,'/updates/android/'+r.file,'HEAD');assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(Number(head.headers['content-length']),r.size);
  for(const name of ['account.json','latest.json?x=1','%2e%2e%2faccount.json','download.part','.publish.lock',''])assert.equal((await get(port,'/updates/android/'+name)).status,404);
  assert.equal((await get(port,'/updates/android/latest.json','POST')).status,405);assert.equal((await get(port,'/api/status')).status,401);
  writeFileSync(path.join(f.dir,r.file),'incomplete');assert.equal((await get(port,'/updates/android/latest.json')).status,404);
});
test('missing or invalid release information returns an unavailable response without leaking file paths',async t=>{
  const f=fixture(t),server=createServer((req,res)=>serveAndroidUpdate(req,res,new URL(req.url,'http://localhost'),f.dir));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const port=server.address().port;
  for(const text of [null,'not json','x'.repeat(32769),'{}']){if(text!==null)writeFileSync(path.join(f.dir,'latest.json'),text);const r=await get(port,'/updates/android/latest.json');assert.equal(r.status,404);assert.ok(!r.body.toString().includes(f.dir));}
});
test('actual bridge exposes update routes before authentication but keeps chat and management protected',async t=>{
  const f=fixture(t),release=f.publish();
  class Rpc extends EventEmitter {async start(){} async close(){} async request(){return{};}}
  const service=await startServer({port:0,rpc:new Rpc(),dataDir:path.join(f.dir,'state'),roots:[f.dir],updatesDir:f.dir});
  try{
    const manifest=await fetch(service.address+'/updates/android/latest.json');assert.equal(manifest.status,200);assert.deepEqual(await manifest.json(),release);
    assert.equal((await fetch(service.address+'/api/status')).status,401);
    assert.equal((await fetch(service.address+'/admin/devices',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(service.address+'/updates/android/'+release.file,{method:'DELETE'})).status,405);
  }finally{await service.close();}
});
