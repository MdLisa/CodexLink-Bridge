import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Management,redact} from './management.mjs';

export async function startManager({management=new Management(),token=randomBytes(32).toString('base64url')}={}){
 let address;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  const reply=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
  try{
   const supplied=Buffer.from(String(req.headers['x-codexlink-control']||'')),expected=Buffer.from(token);
   if(req.headers.origin||req.headers.host!==new URL(address).host||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply(403,{error:'只允许本机控制台访问。'});
   if(req.method==='GET'&&req.url==='/state')return reply(200,await management.state());
   if(req.method==='GET'&&req.url==='/logs')return reply(200,{logs:management.logs()});
   if(req.method==='POST'&&req.url==='/action'){
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return reply(415,{error:'请求格式无效。'});
    let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>65536)return reply(413,{error:'请求内容过大。'});chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'请求格式无效。'});}
    if(typeof body?.action!=='string'||!body.data||typeof body.data!=='object'||Array.isArray(body.data))return reply(400,{error:'管理操作无效。'});
    return reply(200,await management.action(body.action,body.data));
   }
   reply(404,{error:'管理接口不存在。'});
  }catch(e){reply(400,{error:redact(e.message||'操作未完成。')});}
 });
 server.requestTimeout=150000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});address='http://127.0.0.1:'+server.address().port;
 return{address,token,close:()=>new Promise(resolve=>server.close(resolve))};
}
