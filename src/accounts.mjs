import {scrypt,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import path from 'node:path';
const derive=promisify(scrypt);
const PARAMS={N:131072,r:8,p:1,maxmem:256*1024*1024};
export class AccountError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
export class Accounts{
 constructor(dir){this.dir=dir;this.file=path.join(dir,'account.json');this.busy=false;this.attempts=0;this.until=0;}
 current(){try{const a=JSON.parse(readFileSync(this.file,'utf8'));if(a.algorithm!=='scrypt-v1'||typeof a.username!=='string'||!a.generation||Buffer.from(a.salt,'base64url').length!==32||Buffer.from(a.hash,'base64url').length!==64)return null;return a;}catch{return null;}}
 async set(username,password){
  if(typeof username!=='string'||!/^[-A-Za-z0-9_.@]{2,64}$/.test(username))throw Error('账号使用 2～64 位英文字母、数字或 _ . @ -。');
  if(typeof password!=='string'||[...password].length<8||password.length>256||!password.trim())throw Error('密码至少 8 个字符，最多 256 个字符，可以使用较长的短句。');
  const salt=randomBytes(32),hash=await derive(password,salt,64,PARAMS);
  const account={username,algorithm:'scrypt-v1',salt:salt.toString('base64url'),hash:hash.toString('base64url'),generation:randomUUID(),updatedAt:new Date().toISOString()};
  mkdirSync(this.dir,{recursive:true});const temp=this.file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(account,null,2),{flag:'wx',mode:0o600});renameSync(temp,this.file);return account;
 }
 async verify(username,password){
  const a=this.current();if(!a)throw new AccountError(503,'ACCOUNT_NOT_CONFIGURED','请先打开电脑控制台 → 连接与设置，设置本机账号密码。');
  if(Date.now()>=this.until){this.attempts=0;this.until=Date.now()+60000;}
  if(this.attempts>=5||this.busy)throw new AccountError(429,'LOGIN_RATE_LIMIT','登录尝试过于频繁，请一分钟后再试。');
  this.attempts++;this.busy=true;
  try{
   if(typeof username!=='string'||typeof password!=='string'||username.length>64||password.length>256)throw new AccountError(401,'LOGIN_INVALID','账号或密码不正确。');
   const hash=await derive(password,Buffer.from(a.salt,'base64url'),64,PARAMS);
   if(!timingSafeEqual(hash,Buffer.from(a.hash,'base64url'))||username!==a.username)throw new AccountError(401,'LOGIN_INVALID','账号或密码不正确。');
   if(this.current()?.generation!==a.generation)throw new AccountError(409,'ACCOUNT_CHANGED','账号刚刚发生变更，请重新登录。');
   this.attempts=0;return a;
  }finally{this.busy=false;}
 }
}
