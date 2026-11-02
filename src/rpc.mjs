import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import {existsSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {codexEnvironment} from './network.mjs';
export function findCodex(){
  if(process.env.CODEX_EXE)return process.env.CODEX_EXE;
  for(const dir of (process.env.PATH||'').split(path.delimiter)){
    const p=path.join(dir,process.platform==='win32'?'codex.exe':'codex');if(existsSync(p))return p;
  }
  if(process.platform==='win32'&&process.env.LOCALAPPDATA){
    const root=path.join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin');
    if(existsSync(root)){const files=readdirSync(root).map(n=>path.join(root,n,'codex.exe')).filter(existsSync).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);if(files[0])return files[0];}
  }
  throw new Error('找不到 Codex。请安装并登录 Codex，或在电脑上配置 CODEX_EXE。');
}
export class RpcClient extends EventEmitter {
  constructor({exe=findCodex(),timeout=30000,environment,cwd}={}){super();this.exe=exe;this.timeout=timeout;this.environment=environment;this.cwd=cwd;this.nextId=0;this.pending=new Map();this.closed=false;this.ready=null;this.stderr='';}
  async start(){
    if(this.ready)return this.ready;
    this.ready=this.initialize();return this.ready;
  }
  async initialize(){
    const env=this.environment||codexEnvironment();
    this.proc=spawn(this.exe,['app-server','--listen','stdio://'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env,...(this.cwd?{cwd:this.cwd}:{})});
    this.proc.stdin.on('error',()=>{});
    this.proc.stderr.on('data',b=>{this.stderr=(this.stderr+b.toString()).slice(-4000);});
    this.proc.on('error',e=>this.fail(e));
    this.proc.on('exit',code=>{this.fail(new Error(`Codex 服务已退出 (${code})`));if(!this.restarting)this.emit('disconnected');});
    this.lines=createInterface({input:this.proc.stdout});
    this.lines.on('line',line=>{
      let m;try{m=JSON.parse(line);}catch{return;}
      if(m.id!==undefined&&!m.method){const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);if(m.error){const e=new Error(m.error.message||'Codex 请求失败');e.rpcCode=m.error.code;p.reject(e);}else p.resolve(m.result);}
      else if(m.id!==undefined&&m.method)this.emit('request',m);
      else if(m.method)this.emit('notification',m);
    });
    const result=await this.request('initialize',{clientInfo:{name:'codex_phone_bridge',title:'Codex Phone Bridge',version:'0.1.0'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized',params:{}});return result;
  }
  fail(e){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();}
  send(m){if(!this.proc||this.proc.stdin.destroyed)throw new Error('Codex 连接不可用');this.proc.stdin.write(JSON.stringify(m)+'\n');}
  request(method,params={}){const id=++this.nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);const e=new Error('Codex 请求超时，请检查聊天记录后重试');e.code='RPC_TIMEOUT';reject(e);},this.timeout);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  respond(id,result){this.send({id,result});}
  reject(id,message){this.send({id,error:{code:-32000,message}});}
  async restart(){this.restarting=true;try{await this.close();this.closed=false;this.ready=null;await this.start();}finally{this.restarting=false;}}
  async close(){
    if(this.closed)return;this.closed=true;if(!this.proc)return;
    const proc=this.proc;if(proc.exitCode===null&&proc.signalCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>proc.kill(),3000);const hard=setTimeout(()=>{cleanup();reject(Error('Codex 子进程尚未退出，无法确认聊天已释放。'));},8000);const cleanup=()=>{clearTimeout(timer);clearTimeout(hard);};proc.once('exit',()=>{cleanup();resolve();});proc.stdin.end();});this.lines?.close();
  }
}
