import test from 'node:test';
import assert from 'node:assert/strict';
import {admitMessages,messagesReceipt} from '../messages_budget.mjs';
const target={protocol:'messages',url:'https://api.deepseek.com/anthropic/v1/messages'};
const request={model:'deepseek-flash',max_tokens:32768,stream:true,system:[{type:'text',text:'system'}],messages:[{role:'assistant',content:[{type:'thinking',thinking:'reason',signature:'signed'},{type:'tool_use',id:'call1',name:'read',input:{path:'a'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call1',content:[{type:'text',text:'result'}]}]}],tools:[{name:'read',input_schema:{type:'object'},defer_loading:true}],output_config:{effort:'high'}};
const sse=events=>events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const events=[{type:'message_start',message:{id:'msg1',model:'deepseek-flash',usage:{input_tokens:8,output_tokens:0,cache_read_input_tokens:2,cache_creation_input_tokens:3}}},{type:'message_delta',usage:{output_tokens:5}},{type:'message_stop'}];
test('Messages keeps structured request exact and merges start/delta cache usage',()=>{
 const before=JSON.stringify(request);assert.equal(admitMessages(request,target),request);assert.equal(JSON.stringify(request),before);
 assert.deepEqual(messagesReceipt(sse(events),{stream:true,model:request.model}),{inputTokens:13,outputTokens:5});
});
test('Messages refuses incomplete, error and wrong-identity receipts',()=>{
 for(const e of [events.slice(0,-1),[events[0],{type:'message_stop'}],[...events,{type:'error',error:{message:'secret'}}]])assert.throws(()=>messagesReceipt(sse(e),{stream:true,model:'wrong'}));
 assert.throws(()=>messagesReceipt(sse(events.slice(1)),{stream:true,model:request.model}));
});
test('Messages refuses binary, unknown blocks and invalid scalar types before admission',()=>{
 for(const content of [[{type:'image',source:{data:'binary'}}],[{type:'unknown'}],[{type:'text',text:42}],[{type:'tool_result',tool_use_id:'x',content:[{type:'image'}]}]])assert.throws(()=>admitMessages({...request,messages:[{role:'user',content}]},target),/eval_messages_request_invalid/);
 assert.throws(()=>admitMessages({...request,stream:'true'},target));
 assert.throws(()=>admitMessages(request,{...target,url:'https://attacker/chat/completions'}));
});

test('native tools and stop/name boundaries reject invalid values',()=>{
 assert.throws(()=>admitMessages({...request,messages:[]},target));
 for(const tool of [{name:'bad.name',input_schema:{}},{name:'read',input_schema:{},defer_loading:'true'}])assert.throws(()=>admitMessages({...request,tools:[tool]},target));
 assert.throws(()=>admitMessages({...request,stop_sequences:['x'.repeat(257)]},target));
});
