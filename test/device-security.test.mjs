import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtempSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {WebSocket} from 'ws';
import {Accounts} from '../src/accounts.mjs';
import {startServer} from '../src/server.mjs';
import {identity,headers,wsProof} from './identity-helper.mjs';
class Rpc extends EventEmitter{async start(){}async close(){this.emit('disconnected');}}
const password='local-test-password';
async function setup(t){const root=mkdtempSync(path.join(os.tmpdir(),'codex-trusted-device-')),workspace=path.join(root,'workspace'),dataDir=path.join(root,'state');mkdirSync(workspace);const accounts=new Accounts(dataDir);await accounts.set('owner',password);let service;
 const start=async()=>{service=await startServer({port:0,dataDir,roots:[workspace],rpc:new Rpc()});return service;};await start();t.after(()=>service.close());const key=identity();
 async function call(route,{method='GET',body,raw,token='',key:signer=key,proof}={}){const bytes=raw??(body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body)));const h=proof??headers(signer,service.address,method,route,bytes,token);const r=await fetch(service.address+route,{method,headers:{...h,...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},body:method==='GET'?undefined:bytes});return{status:r.status,data:await r.json()};}
 const login=(signer=key)=>call('/api/login',{method:'POST',key:signer,body:{username:'owner',password,publicKey:signer.publicKey,deviceName:'same phone name'}});
 return{get service(){return service;},accounts,key,call,login,start,async approve(signer=key){const r=service.security.lookup(service.security.publicKey(signer.publicKey).fingerprint);service.security.approve(r.fingerprint,service.security.code(r.fingerprint),accounts.current().generation);return r.fingerprint;}};
}
test('password alone never authorizes a new device; local approval and matching private key are both required',async t=>{
 const s=await setup(t);const pending=await s.login();assert.equal(pending.status,202);assert.ok(pending.data.verificationCode);assert.equal(pending.data.token,undefined);
 const r=s.service.security.list()[0];assert.throws(()=>s.service.security.approve(r.fingerprint,'WRONG-CODE',s.accounts.current().generation));
 assert.equal((await s.call('/admin/auth-changed',{method:'POST'})).status,403);
 await s.approve();const login=await s.login();assert.equal(login.status,201);const token=login.data.token;
 assert.equal((await s.call('/api/status',{token})).status,200);
 assert.equal((await s.call('/api/status',{token,proof:{}})).status,403);
 const impostor=identity();assert.equal((await s.login(impostor)).status,202);
 assert.equal((await s.call('/api/status',{token,key:impostor})).status,403);
 const legacy=await s.call('/api/login',{method:'POST',body:{username:'owner',password}});assert.equal(legacy.status,403);
});
test('signed requests reject modified paths, bodies, hosts, expired timestamps and replays across restart',async t=>{
 const s=await setup(t);await s.login();await s.approve();const token=(await s.login()).data.token;
 const proof=headers(s.key,s.service.address,'GET','/api/status',Buffer.alloc(0),token);
 assert.equal((await s.call('/api/status',{token,proof})).status,200);
 assert.equal((await s.call('/api/status',{token,proof})).status,409);
 assert.equal((await s.call('/api/devices',{token,proof:headers(s.key,s.service.address,'GET','/api/status',Buffer.alloc(0),token)})).status,403);
 assert.equal((await s.call('/api/status',{token,proof:headers(s.key,s.service.address,'GET','/api/status',Buffer.alloc(0),token,{host:'phishing.example'})})).status,403);
 assert.equal((await s.call('/api/status',{token,proof:headers(s.key,s.service.address,'GET','/api/status',Buffer.alloc(0),token,{time:Date.now()-360000})})).status,403);
 const target='/api/uploads';assert.equal((await s.call(target,{method:'POST',token,raw:Buffer.from('tampered'),proof:headers(s.key,s.service.address,'POST',target,Buffer.from('original'),token)})).status,403);
 const security=s.service.security;const data={token,method:'GET',host:'stable.example',path:'/api/status',body:Buffer.alloc(0)};const h=headers(s.key,'https://stable.example','GET',data.path,data.body,token);const signed={...data,time:h['x-device-time'],nonce:h['x-device-nonce'],signature:h['x-device-signature']};security.proof(s.key.publicKey,signed);
 await s.service.close();await s.start();assert.throws(()=>s.service.security.proof(s.key.publicKey,signed),e=>e.code==='DEVICE_REPLAY');assert.equal((await s.call('/api/status',{token})).status,200);
});
test('WebSocket also requires device proof, and revocation stops HTTP and live data',async t=>{
 const s=await setup(t);await s.login();const fingerprint=await s.approve();const token=(await s.login()).data.token;const url=s.service.address.replace('http:','ws:')+'/events';
 const bad=new WebSocket(url);bad.on('error',()=>{});await once(bad,'open');bad.send(JSON.stringify({type:'auth',token,after:0}));assert.equal((await once(bad,'close'))[0],4001);
 const ws=new WebSocket(url);ws.on('error',()=>{});const messages=[];ws.on('message',b=>messages.push(JSON.parse(b)));await once(ws,'open');ws.send(JSON.stringify(wsProof(s.key,s.service.address,token)));await new Promise(r=>setTimeout(r,30));assert.ok(messages.some(e=>e.type==='authenticated'));
 s.service.security.revoke(fingerprint);const closed=once(ws,'close');s.service.bridge.event('must-not-leak',{private:'test'});assert.equal((await closed)[0],4003);assert.equal(messages.some(e=>e.type==='must-not-leak'),false);assert.equal((await s.call('/api/status',{token})).status,401);assert.equal((await s.login()).status,403);
});
