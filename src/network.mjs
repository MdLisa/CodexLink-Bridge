import {execFileSync} from 'node:child_process';
// Respect explicit environment settings; otherwise mirror Windows' existing manual proxy.
export function codexEnvironment(source=process.env,{platform=process.platform,readRegistry}={}){
 const env={...source};delete env.CODEX_THREAD_ID;
 if(platform!=='win32'||Object.keys(env).some(k=>/^(https?_proxy|all_proxy)$/i.test(k)&&env[k]))return env;
 const read=readRegistry||((name)=>{const text=execFileSync('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings','/v',name],{encoding:'utf8',windowsHide:true,timeout:3000,stdio:['ignore','pipe','ignore']});return text.match(new RegExp(name+'\\s+REG_\\w+\\s+(.+)'))?.[1]?.trim();});
 try{
  if(Number(read('ProxyEnable'))!==1)return env;const raw=read('ProxyServer');if(!raw)return env;
  const mapped=raw.includes('=')?Object.fromEntries(raw.split(';').map(s=>s.split('='))):{http:raw,https:raw};
  const url=s=>s?/^https?:\/\//i.test(s)?s:'http://'+s:undefined;
  if(mapped.http)env.HTTP_PROXY=url(mapped.http);if(mapped.https||mapped.http)env.HTTPS_PROXY=url(mapped.https||mapped.http);
  env.NO_PROXY=env.NO_PROXY||env.no_proxy||'localhost,127.0.0.1,::1';
 }catch{ /* No manual system proxy is configured or registry access is unavailable. */ }
 return env;
}
