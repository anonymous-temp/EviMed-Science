import assert from 'node:assert/strict';
import test from 'node:test';
import { vcrOriginalHumanMessages } from '../src/vcrExecutionContext.mjs';
import { vcrPersonStated } from '../src/vcrPersonStated.mjs';

const run = { sessionId:'s1', automated:false, nativeTurn:{startSeq:1}, kernelRequestIds:['request_1'] };
const message = {role:'user',source:'user',seq:2,turnStartSeq:1,parts:[{type:'text',text:'original'}]};
const read = (messages, runs = [run], sessionId = 's1') => vcrOriginalHumanMessages({sessionId,transcript:{sessionId:'s1',messages},runs});

test('original text beyond ledger preview is preserved and bound to the current conversation', () => {
  const text = '研究背景。'.repeat(100)+'随访改为30个月';
  const originals = read([{...message,parts:[{type:'text',text}]}]);
  assert.equal(originals[0].text,text);
  const record = vcrPersonStated({followup:30,nTreat:30},originals,[{origin:'user',field:'followup',value:30,quote:'随访改为30个月',unit:'month',context:'follow-up duration'}]);
  assert.deepEqual(record.paths,['followup']);
  assert.equal(record.bindings[0].source.sessionId,'s1');
});

test('cross-session, automated, assistant and non-human originals cannot become user provenance', () => {
  assert.equal(read([message],[run],'other'),null);
  assert.deepEqual(read([message],[{...run,sessionId:'other'}]),[]);
  assert.deepEqual(read([message],[{...run,automated:true}]),[]);
  assert.deepEqual(read([{...message,role:'assistant'},{...message,source:'automated'},{...message,turnStartSeq:99}]),[]);
  assert.deepEqual(read([{...message,turnStartSeq:99,sourceRequestId:'request_1'}]),[{sessionId:'s1',messageSeq:2,text:'original'}]);
  assert.deepEqual(read([{...message,turnStartSeq:99,sourceRequestId:'other'}]),[]);
});

test('original access is bounded and never falls back to the 160-character ledger question', () => {
  assert.deepEqual(read([],[{...run,question:'preview with 30'}]),[]);
  assert.equal(read([{...message,parts:[{type:'text',text:'x'.repeat(400*1024+1)}]}]),null);
  assert.equal(read([1,2,3].map(seq => ({...message,seq,parts:[{type:'text',text:'x'.repeat(400*1024)}]}))),null);
  assert.deepEqual(read([{...message,parts:[{type:'tool',text:'30 months'}]}]),[]);
});
