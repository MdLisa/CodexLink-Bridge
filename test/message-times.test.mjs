import {test} from 'node:test';
import assert from 'node:assert/strict';
import {itemView,messageTimes,Bridge} from '../src/bridge.mjs';
import {ChatOnlyService} from '../src/chat-only-service.mjs';

test('original item times survive sanitized normal, chat-only and shared history views',async()=>{
 const startedAtMs=1793635200000,completedAtMs=startedAtMs+60000;
 const user={id:'u',type:'userMessage',content:[{type:'text',text:'question'}],startedAtMs,completedAtMs};
 const agent={id:'a',type:'agentMessage',text:'answer',startedAtMs,completedAtMs};
 for(const item of [user,agent])assert.deepEqual(messageTimes(itemView(item)),{startedAtMs,completedAtMs});
 const service={store:{jobForTurn:()=>({payload:JSON.stringify({text:'question',attachmentIds:[]})})}};
 assert.equal(ChatOnlyService.prototype.item.call(service,user,'thread','turn').startedAtMs,startedAtMs);
 assert.equal(ChatOnlyService.prototype.item.call(service,agent,'thread','turn').completedAtMs,completedAtMs);
 const bridge={info:async()=>({cwd:'workspace'}),rpc:{request:async()=>({data:[{id:'t',items:[user,agent]}]})},check(){},viewItem:item=>itemView(item)};
 const history=await Bridge.prototype.history.call(bridge,'thread');assert.equal(history.turns[0].items[1].completedAtMs,completedAtMs);
});
test('missing or invalid native times never become a history refresh timestamp',()=>{
 for(const value of [null,undefined,0,-1,1.5,'2026-11-03',Infinity,Number.MAX_SAFE_INTEGER])assert.deepEqual(messageTimes({startedAtMs:value,completedAtMs:value}),{});
 assert.deepEqual(itemView({id:'a',type:'agentMessage',text:'old answer'}),{id:'a',type:'agentMessage',text:'old answer',phase:undefined});
});
