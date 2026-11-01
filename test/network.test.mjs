import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codexEnvironment} from '../src/network.mjs';
test('Windows manual proxy is inherited without changing parent environment or explicit proxy choices',()=>{
 const original={CODEX_THREAD_ID:'desktop',PATH:'test'};
 const readRegistry=k=>({ProxyEnable:'0x1',ProxyServer:'http=127.0.0.1:7897;https=127.0.0.1:7898'}[k]);
 const env=codexEnvironment(original,{platform:'win32',readRegistry});
 assert.equal(env.HTTP_PROXY,'http://127.0.0.1:7897');assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7898');assert.equal(env.CODEX_THREAD_ID,undefined);assert.equal(original.CODEX_THREAD_ID,'desktop');assert.equal(original.HTTP_PROXY,undefined);
 const explicit=codexEnvironment({HTTPS_PROXY:'http://my-proxy'},{platform:'win32',readRegistry:()=>{throw Error('must not read');}});assert.equal(explicit.HTTPS_PROXY,'http://my-proxy');
 assert.equal(codexEnvironment(original,{platform:'win32',readRegistry:()=> '0x0'}).HTTPS_PROXY,undefined);
});
