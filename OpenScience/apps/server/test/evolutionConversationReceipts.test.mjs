import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationReceipts } from '../../../scripts/ops/evolution-conversation-receipts.mjs';
test('conversation acceptance requires successful and rejected actual pinned calls in their own rounds',()=>{
  const input={userId:'user',projectId:'project',runId:'run',toolId:'tool',digest:'pin',revision:2,index:0};
  const receipt={id:'use',payload:{...input,callId:'server-call',result:{ok:true},resultEvidence:{substantive:true,explicitlyUnsupported:false}}};
  assert.equal(conversationReceipts([receipt],input).passed,true);
  receipt.payload.resultEvidence.substantive=false;assert.equal(conversationReceipts([receipt],input).passed,false);
  receipt.payload.resultEvidence.substantive=true;receipt.payload.resultEvidence.explicitlyUnsupported=true;
  assert.equal(conversationReceipts([receipt],input).passed,false);
  assert.equal(conversationReceipts([receipt],{...input,index:4}).passed,true);
  receipt.payload.resultEvidence.explicitlyUnsupported=false;
  assert.equal(conversationReceipts([receipt],{...input,index:4}).passed,false);
  receipt.payload.result.ok=false;assert.equal(conversationReceipts([receipt],{...input,index:4}).passed,true);
  for(const key of ['userId','projectId','runId','toolId','digest','revision'])assert.equal(conversationReceipts([receipt],{...input,index:4,[key]:'different'}).passed,false);
  delete receipt.payload.callId;assert.equal(conversationReceipts([receipt],{...input,index:4}).passed,false);
  assert.equal(conversationReceipts([],{...input,index:1}).required,false);
});
