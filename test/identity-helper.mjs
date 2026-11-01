import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {signingText,sha} from '../src/device-security.mjs';
export function identity(){const p=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return{privateKey:p.privateKey,publicKey:p.publicKey.export({format:'der',type:'spki'}).toString('base64')};}
export function headers(key,address,method,target,body=Buffer.alloc(0),token='',extra={}){const data={token,method,host:new URL(address).host,path:target,time:Date.now(),nonce:randomUUID(),body,...extra};return{'x-device-time':String(data.time),'x-device-nonce':data.nonce,'x-device-signature':sign('sha256',Buffer.from(signingText(data)),key.privateKey).toString('base64')};}
export function wsProof(key,address,token,after=0){const h=headers(key,address,'WS','/events',Buffer.from(String(after)),token);return{type:'auth',token,after,deviceTime:h['x-device-time'],deviceNonce:h['x-device-nonce'],deviceSignature:h['x-device-signature']};}
export function approve(service,key,generation){const r=service.security.enroll(key.publicKey,'test phone',generation);service.security.approve(r.fingerprint,service.security.code(r.fingerprint),generation);return r.fingerprint;}
