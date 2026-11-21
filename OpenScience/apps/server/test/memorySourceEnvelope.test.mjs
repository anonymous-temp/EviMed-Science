import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceBoundRequest, memoryEnvelope } from '../src/memorySourceEnvelope.mjs';
import { createPasteRangeIndex } from '../src/memoryPasteRanges.mjs';
import { completeHistoryUnits, historyChunks, historySearchText } from '../src/memoryHistory.mjs';
import { compactHistoryMessages, historyLexicalScorer } from '../src/memoryHistoryRetrieval.mjs';
import { capsuleSearchText } from '../src/memoryGateway.mjs';
import { renderResidentProfile, projectCardMemo } from '../src/residentProfile.mjs';
import { openingProfileRead } from '../src/memoryOpeningByUse.mjs';
import { bindStatementSources, statementSource } from '../src/memoryStatementSources.mjs';
import { instructionSourceMessage } from '../src/nativeMemoryInstructionOrigin.mjs';

test('the submitted paste is attributed within the exact account, project, session and unchanged text', () => {
  const index = createPasteRangeIndex(), text = 'Review: no allergy';
  index.record({ userId: 'owner', id: 'p' }, { sessionId: 's', content: [{type:'text', text}] }, [{part:0,spans:[[8,18]]}]);
  for (const scope of [['owner','p','s'], ['other','p','s'], ['owner','q','s'], ['owner','p','t']]) {
    const lookup = value => index.lookup(...scope,value);
    const message = sourceBoundRequest({messages:[{role:'user',content:text}]}, 'chat', lookup).messages.at(-1);
    const unit = JSON.parse(message.content);
    if (scope.join('/') === 'owner/p/s') {
      assert.deepEqual(unit.parts.map(p => [p.source.kind,p.text]), [['user_input','Review: '],['pasted_material','no allergy']]);
      assert.equal(unit.parts[1].source.subject,'unknown');
    } else assert.equal(unit.parts, undefined);
    assert.deepEqual(lookup(text + '!'), []);
  }
});

test('both protocols preserve tools, thinking and image bytes, and attach a checklist with zero memories', () => {
  const content = [{type:'thinking',thinking:'analysis',signature:'signature'}, {type:'tool_use',id:'read',name:'read',input:{}}];
  const image = {type:'image',source:{type:'base64',data:'AA==',media_type:'image/png'}};
  const body = {system:'original',messages:[{role:'assistant',content}, {role:'user',content:[
    {type:'tool_result',tool_use_id:'read',content:'database row'}, image, {type:'text',text:'Summarize “a borrowed claim”.'}]}]};
  const projected = sourceBoundRequest(body,'messages');
  assert.deepEqual(projected.messages[0].content,content);
  const parts = projected.messages[1].content;
  assert.equal(JSON.parse(parts[0].content).source.kind,'tool_result');
  assert.equal(parts[0].tool_use_id,'read');
  assert.equal(JSON.parse(parts[1].text).followingPart.kind,'attachment');
  assert.deepEqual(parts[2], image);
  assert.equal(JSON.parse(parts[3].text).parts[1].source.subject,'unknown');
  assert.match(projected.system,/every applicable option/);
  assert.match(projected.system,/each required field including name and age/);
  const chat = sourceBoundRequest({messages:[{role:'tool',tool_call_id:'q',content:'web page'}, {role:'assistant',content:'My proposal'}]});
  assert.equal(chat.messages[1].tool_call_id,'q');
  assert.equal(JSON.parse(chat.messages[2].content).source.speaker,'assistant');
  assert.equal(JSON.parse(chat.messages[2].content).source.adoption,'unknown');
});

test('a confirmed assertion needs its own source and preserved conditions; acceptance needs a later user quote', () => {
  const messages = [{role:'user',content:'I climbed one step only with assistance.'},
    {role:'assistant',content:'I suggest another session.'},{role:'user',content:'Yes, I accept that session.'}].map(m => instructionSourceMessage(m));
  const bind = (row, text) => {
    const receipts = bindStatementSources(JSON.stringify({rows:[{line:0,...row}]}),[{text}],messages);
    return statementSource(text,{statementSource:receipts.get(0)});
  };
  const assertion = {kind:'user_statement',message:0,quote:messages[0].text,subject:'self',conditions:'preserved'};
  assert.equal(bind(assertion,messages[0].text).personalFact,true);
  assert.equal(bind({...assertion,subject:'unknown'},messages[0].text).personalFact,false);
  assert.equal(bind({...assertion,conditions:'missing'},'I can climb stairs.').personalFact,false);
  const advice = {kind:'assistant_statement',message:1,quote:messages[1].text,subject:'self',conditions:'preserved',adoption:'adopted',response:2,responseQuote:messages[2].text};
  assert.equal(bind(advice,messages[1].text).adoption,'adopted');
  assert.equal(bind({...advice,response:1},messages[1].text).adoption,'unknown');
  assert.equal(bind({...advice,adoption:'not_stated'},messages[1].text).personalFact,false);
  assert.equal(bind({...advice,kind:'user_statement'},messages[1].text),null);
  assert.equal(memoryEnvelope({mode:'reference',origin:'explicit',sourceEnvelope:bind(assertion,messages[0].text)}).subject,'unknown');
});

test('legacy mid-message chunks regain the whole checked utterance or carry no quote', () => {
  const text = 'I could get up one step. ' + 'Near the stair. '.repeat(145) + 'Only with my daughter holding me.';
  const original = [{role:'user',content:text,created_at:'2026-11-12'}];
  const [chunk] = historyChunks(original);
  assert.ok(chunk.messages[0].text.length < text.length);
  const units = completeHistoryUnits(chunk.messages, original, m => m.content, 6000);
  assert.deepEqual(units.map(m => m.text),[text]);
  const scorer = historyLexicalScorer([{messages:units}],'step');
  assert.deepEqual(compactHistoryMessages(units,'step',scorer,200,new Set(),true),[]);
  assert.deepEqual(completeHistoryUnits(chunk.messages, original, m => m.content, 200),[]);
  assert.match(historySearchText([{conversationTitle:'Source',conversationUrl:'/c',messages:units}]),/Only with my daughter holding me/);
  assert.equal(units[0].sourceEnvelope.subject,'unknown');
});

test('capsule lines retain their pinned rendering and opening budgets omit oversized units whole', () => {
  const item = {mode:'own',factKind:'note',origin:'assistant',content:'One step, with assistance.'};
  const off = capsuleSearchText([item]), on = capsuleSearchText([item],true);
  assert.equal(off.split('\n')[1], on.split('\n')[2]);
  assert.equal(JSON.parse(on.split('\n')[1]).source.speaker,'assistant');
  const long = 'can climb ' + 'x'.repeat(20100) + ' only if assisted';
  assert.doesNotMatch(capsuleSearchText([{...item,content:long}],true),/can climb/);
  assert.doesNotMatch(openingProfileRead(long,'root',{memorySourceEnvelopeEnabled:true}),/can climb/);
  assert.equal(projectCardMemo('p',[{slot:'goal',text:long}],{sourceBound:true}),null);
  const block = renderResidentProfile({capsuleFacts:[{...item,factKind:'profile',id:'1',content:long}],config:{memorySourceEnvelopeEnabled:true}});
  assert.doesNotMatch(block.profile,/can climb/);
});

test('a truncated extraction with a known missing condition is replaced by a history pointer', async () => {
  const { memoryQuoteUnit } = await import('../src/memorySourceEnvelope.mjs');
  const source = { conditions: 'missing' };
  for (const unit of [memoryQuoteUnit('can climb stairs', source),
    memoryQuoteUnit('can climb stairs', {}, [{text:'can climb stairs',source}])]) {
    assert.doesNotMatch(JSON.stringify(unit), /can climb stairs/);
    assert.match(unit.text, /original conversation/);
  }
});

test('a read of the kernel attachment path stays attached to its file', () => {
  const projected = sourceBoundRequest({messages:[
    {role:'user',content:'[File "paper.pdf" (42 bytes, sha256:0123abcd): verbatim read-only copy saved at "/workspace/paper.pdf".]'},
    {role:'assistant',tool_calls:[{id:'f',function:{name:'read',arguments:'{"path":"/workspace/paper.pdf"}'}}],content:null},
    {role:'tool',tool_call_id:'f',content:'parsed material'}]});
  assert.equal(JSON.parse(projected.messages.at(-1).content).source.kind,'attachment');
});

test('reported labels and borrowed evidence can identify a speaker without certifying personal facts', async () => {
  const { visibleStatementSources } = await import('../src/memoryStatementSources.mjs');
  const [legacy] = visibleStatementSources('- Assistant suggested (not adopted): try a different time',new Map());
  assert.equal(legacy.source.speaker,'assistant');
  assert.equal(legacy.source.personalFact,false);
  assert.equal(legacy.source.adoption,'unknown');
  const msg = instructionSourceMessage({ role:'user',content:'In this document: my aunt tried the steps' });
  msg.parts[0].spans.push({kind:'paste',start:18,end:msg.text.length});
  const row = { line:0,kind:'user_statement',quote:msg.text,subject:'self',conditions:'preserved',message:0 };
  const candidates = [{text:'I tried the steps'}];
  assert.equal(bindStatementSources(JSON.stringify({rows:[row]}),candidates,[msg]).size,0);
  const pasted = bindStatementSources(JSON.stringify({rows:[{...row,kind:'pasted_material',subject:'other'}]}),candidates,[msg]).get(0);
  assert.equal(pasted.source.personalFact,false);
  assert.equal(pasted.source.locator.quoteStart,0);
  assert.equal(statementSource('I TRIED the steps',{statementSource:pasted}),null);
  assert.equal(statementSource(candidates[0].text,{statementSource:pasted,sources:[{}]}),null);
});

test('the additive agent recall quote is complete or null and always retains the original response content', async () => {
  const { nativeRecallSource } = await import('../src/agentMemoryRecall.mjs');
  const source = {kind:'user_statement',speaker:'user',subject:'unknown',conditions:'preserved',personalFact:true};
  const base = {id:'a',scope:'user',status:'active',value:'One step.',quoteUnit:'One step. (as of 2026-11-13)',sourceEnvelope:source};
  const rows = [base,{...base,id:'b',value:'With help. '.repeat(400),quoteUnit:undefined}];
  const native = {search:async () => ({items:rows})};
  const old = await nativeRecallSource(native).recall('owner','step');
  const bound = await nativeRecallSource(native,{sourceBound:true}).recall('owner','step');
  assert.deepEqual(bound.map(row=>row.content),old.map(row=>row.content));
  assert.equal(bound[0].quoteUnit,base.quoteUnit);
  assert.equal(bound[0].sourceEnvelope.personalFact,false);
  assert.equal(bound[1].quoteUnit,null);
});
