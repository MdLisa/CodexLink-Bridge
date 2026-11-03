import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,unlinkSync,openSync,closeSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRelease} from '../src/android-updates.mjs';

export function inspectApk(apk,sdk){
  apk=path.resolve(apk);sdk=path.resolve(sdk);
  const tools=path.join(sdk,'build-tools'),version=readdirSync(tools).filter(v=>/^\d+(\.\d+)+$/.test(v)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
  if(!version)throw Error('Android SDK build-tools not found');
  const build=path.join(tools,version),java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin','java.exe'):'java';
  const cert=execFileSync(java,['-jar',path.join(build,'lib','apksigner.jar'),'verify','--verbose','--print-certs',apk],{encoding:'utf8'});
  const signers=[...cert.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]+)$/gm)].map(m=>m[1]).sort();
  if(!signers.length)throw Error('No APK signing certificate');
  // Windows aapt cannot reliably open absolute paths containing non-ASCII characters.
  const badging=execFileSync(path.join(build,process.platform==='win32'?'aapt.exe':'aapt'),['dump','badging',path.basename(apk)],{cwd:path.dirname(apk),encoding:'utf8',maxBuffer:8*1024*1024});
  const pkg=badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m),min=badging.match(/^sdkVersion:'(\d+)'/m);
  if(!pkg||!min)throw Error('Cannot read APK metadata');
  return {packageName:pkg[1],versionCode:Number(pkg[2]),versionName:pkg[3],minSdk:Number(min[1]),signers};
}

export function publishRelease({apk,trustedApk,notes,dir,inspect}){
  mkdirSync(dir,{recursive:true});const lock=path.join(dir,'.publish.lock'),fd=openSync(lock,'wx');
  let temp;
  try{
    const original=inspect(trustedApk),info=inspect(apk);
    if(original.packageName!=='com.xukaizhe.codexlink'||info.packageName!==original.packageName||JSON.stringify(info.signers)!==JSON.stringify(original.signers))throw Error('APK package or signing certificate differs from trusted APK');
    if(info.versionCode<=original.versionCode)throw Error('APK must be newer than trusted APK');
    const latest=path.join(dir,'latest.json');
    if(existsSync(latest)&&info.versionCode<=validateRelease(JSON.parse(readFileSync(latest,'utf8'))).versionCode)throw Error('Version code must increase; refusing downgrade or duplicate release');
    const bytes=readFileSync(apk),sha256=createHash('sha256').update(bytes).digest('hex'),file=`CodexLink-${info.versionName}-${info.versionCode}-${sha256.slice(0,16)}.apk`;
    const release=validateRelease({schemaVersion:1,packageName:info.packageName,versionCode:info.versionCode,versionName:info.versionName,minSdk:info.minSdk,notes,size:bytes.length,sha256,file,downloadUrl:`https://codex.shbj.site/updates/android/${file}`});
    const target=path.join(dir,file);
    if(existsSync(target)){if(!readFileSync(target).equals(bytes))throw Error('Immutable APK already exists with different content');}
    else{temp=path.join(dir,randomUUID()+'.tmp');writeFileSync(temp,bytes,{flag:'wx'});renameSync(temp,target);temp=undefined;}
    temp=path.join(dir,randomUUID()+'.tmp');writeFileSync(temp,JSON.stringify(release,null,2)+'\n',{flag:'wx'});renameSync(temp,latest);temp=undefined;
    return release;
  }finally{if(temp&&existsSync(temp))unlinkSync(temp);closeSync(fd);unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),arg=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
    const sdk=arg('--sdk')||process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT;
    if(!sdk||!arg('--apk')||!arg('--notes-file'))throw Error('Usage: node scripts/publish-android-update.mjs --sdk <Android SDK> --apk <new.apk> --notes-file <UTF-8.txt> [--trusted-apk <old.apk>]');
    const root=fileURLToPath(new URL('../',import.meta.url));
    const release=publishRelease({apk:path.resolve(arg('--apk')),trustedApk:path.resolve(arg('--trusted-apk')||path.join(root,'CodexLink-0.9.2.apk')),notes:readFileSync(arg('--notes-file'),'utf8').replace(/^\uFEFF/,'').trim(),dir:path.join(root,'updates','android'),inspect:p=>inspectApk(p,sdk)});
    console.log(`Published Android ${release.versionName} (${release.versionCode}) locally.\n${release.downloadUrl}\nRestart the backend once if it does not yet support update routes.`);
  }catch(e){console.error(e.message);process.exitCode=1;}
}
