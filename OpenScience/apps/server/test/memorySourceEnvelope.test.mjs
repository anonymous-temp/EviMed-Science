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
    {role:'assistant',content:'I suggest another session.'},{role:'user',content:'Yes, I accept that session.'},
    {role:'user',content:'On reflection, I decline that session.'}].map(m => instructionSourceMessage(m));
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
  assert.deepEqual(bind(advice,messages[1].text).locator.response,
    {message:2,quoteStart:0,quoteLength:messages[2].text.length});
  const decline = bind({...advice,adoption:'rejected',response:3,responseQuote:'I decline'},messages[1].text);
  assert.equal(decline.adoption,'rejected');
  assert.deepEqual(decline.locator.response,{message:3,quoteStart:'On reflection, '.length,quoteLength:'I decline'.length});
  assert.equal(Object.hasOwn(bind({...advice,response:1},messages[1].text).locator,'response'),false);
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

test('personal activity advice distinguishes a selected file read from an assisted attempt in original history', () => {
  const turns = [
    { role: 'user', content: 'Can I train on the stairs?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'files', function: { name: 'mcp__openviking__read' } }] },
    { role: 'tool', tool_call_id: 'files', content: 'Profile: walking on level ground is easier. Walking preference: small doses.' },
  ];
  const { messages } = sourceBoundRequest({ messages: turns });
  const { medicalAdvice: { activityBaseline } } = JSON.parse(messages[0].content.split('\n')[1]);
  const read = JSON.parse(messages.at(-1).content);
  assert.match(read.source.coverage, /did not search earlier conversations/);
  assert.match(activityBaseline.ifMissing, /mcp__openviking__search.*without target_uri/);
  assert.match(activityBaseline.ifStillUnknown, /ask about the attempt before giving a personal progression plan/);
  assert.doesNotMatch(JSON.stringify(messages), /daughter|handrail|one small step/i);

  const quote = 'With my daughter helping me and my hand on the handrail, I went up just one small step.';
  const original = [{ role: 'user', content: quote }];
  const [chunk] = historyChunks(original);
  const units = completeHistoryUnits(chunk.messages, original, m => m.content, 4000);
  const history = historySearchText([{ conversationTitle: 'Previous attempt', conversationUrl: '/c', messages: units }]);
  const afterSearch = sourceBoundRequest({ messages: [...turns,
    { role: 'assistant', content: null, tool_calls: [{ id: 'history', function: { name: 'mcp__openviking__search' } }] },
    { role: 'tool', tool_call_id: 'history', content: history },
  ] });
  const hit = JSON.parse(JSON.parse(afterSearch.messages.at(-1).content).text.split('\n').at(-1));
  assert.equal(hit.source.speaker, 'user');
  assert.equal(hit.text, quote);
  assert.deepEqual(activityBaseline.findTogether, ['activity actually attempted', 'who performed it or assisted',
    'support or equipment used', 'extent actually achieved']);
  assert.match(activityBaseline.inAdvice, /Restate the supported conditions and achieved extent together.*starting point/);
  assert.match(activityBaseline.inAdvice, /progression beyond it needs separate evidence/);
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

test('tool attribution follows each call ID across parallel results in both wire protocols', () => {
  const lookup = 'drug_database', recall = 'mcp__openviking__read';
  const claim = 'Patient record: no known allergy.';
  const own = memoryEnvelope({ sourceEnvelope: { kind: 'user_statement', speaker: 'user', subject: 'self',
    conditions: 'preserved', personalFact: true } });
  assert.match(own.label, /own statement recorded in the memory capsule/);
  assert.doesNotMatch(memoryEnvelope({ mode: 'reference', sourceEnvelope: own }).label, /own statement/);
  for (const protocol of ['chat', 'messages']) {
    const calls = [lookup, recall];
    const results = [{ id: '1', text: JSON.stringify({ source: own, text: 'I stated this.' }) },
      { id: '0', text: JSON.stringify({ source: own, text: claim }) }];
    const turns = protocol === 'chat' ? [
      { role: 'assistant', content: null, tool_calls: calls.map((name, i) => ({ id: String(i), function: { name } })) },
      ...results.map(({ id, text }) => ({ role: 'tool', tool_call_id: id, content: text })),
    ] : [
      { role: 'assistant', content: calls.map((name, i) => ({ type: 'tool_use', id: String(i), name, input: {} })) },
      { role: 'user', content: results.map(({ id, text }) => ({ type: 'tool_result', tool_use_id: id, content: text })) },
    ];
    const { messages } = sourceBoundRequest({ messages: turns }, protocol);
    const blocks = protocol === 'chat' ? messages.slice(-2) : messages.at(-1).content;
    const [memory, external] = blocks.map(block => JSON.parse(block.content));
    assert.equal(memory.source.tool, recall);
    assert.match(memory.source.label, /Memory lookup/);
    assert.equal(external.source.tool, lookup);
    assert.match(external.source.label, /External material returned by drug_database/);
    assert.match(external.source.label, /not the user's statement or personal record/);
    assert.equal(external.source.personalFact, false);
    assert.equal(external.text, results[1].text);
  }
});

test('empty, error and non-text tool results retain provenance without changing the payload bytes', () => {
  const image = { type: 'image', source: { type: 'base64', data: 'AA==' } };
  const { messages } = sourceBoundRequest({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'i', name: 'file_preview', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'i', content: [image, { type: 'text', text: 'Caption' }] },
      { type: 'tool_result', tool_use_id: 'missing', is_error: true, content: [] }] },
  ] }, 'messages');
  const [media, empty] = messages[1].content;
  assert.equal(JSON.parse(media.content[0].text).followingPart.tool, 'file_preview');
  assert.deepEqual(media.content[1], image);
  assert.equal(JSON.parse(media.content[2].text).source.tool, 'file_preview');
  assert.equal(empty.is_error, true);
  assert.match(JSON.parse(empty.content[0].text).source.label, /External material returned by unknown tool/);

  const chat = sourceBoundRequest({ messages: [{ role: 'tool', name: 'orphan_lookup', content: '' }] });
  assert.equal(JSON.parse(chat.messages.at(-1).content).source.tool, 'orphan_lookup');
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

for (const safety of [false, true]) for (const sourceBound of [false, true]) {
  test(`independent opening budgets and whole recall units with safety=${safety}, sources=${sourceBound}`, () => {
    const config = { memorySafetyNotesEnabled: safety, memorySourceEnvelopeEnabled: sourceBound,
      memoryStandingInstructionsEnabled: true, memoryOpeningByUseEnabled: true };
    const root = 'viking://user/a/memories';
    const source = { kind: 'user_statement', speaker: 'user', subject: 'self', conditions: 'preserved' };
    const note = 'One step only with assistance.';
    const rule = 'Use a table only for the appendix.';
    const long = 'Unexpanded body ' + 'x'.repeat(1300) + ' only on request.';
    const shortRule = { uri: root + '/preferences/self/a.md', body: rule, statementSources: [{ text: rule, source }] };
    const longRule = { uri: root + '/preferences/self/b.md', body: '# Layout\n' + long, usedCount: 1 };
    const shortNote = { uri: root + '/safety_notes/a.md', type: 'safety_notes', body: '# Owner\n' + note,
      projectId: 'other', statementSources: [{ text: note, source }] };
    const longNote = { uri: root + '/safety_notes/b.md', type: 'safety_notes', body: '# History\n' + long,
      updatedAt: '2026-11-01', sourceUri: root + '/people/original.md' };
    const input = { config, nativeFiles: [shortRule, longRule], safetyFiles: [shortNote, longNote],
      capsuleFacts: [{ id: 'ordinary', factKind: 'preference', content: 'Ordinary preference.' }] };
    const emptyBudget = renderResidentProfile({ ...input, maxTokens: 0 });
    const full = renderResidentProfile(input);
    assert.equal(emptyBudget.standing, full.standing);
    assert.equal(emptyBudget.safety, full.safety);
    assert.equal(emptyBudget.profile, '');
    assert.match(full.profile, /Ordinary preference/);
    assert.ok(full.profile.includes('可查全文 mcp__openviking__read ' + longRule.uri));
    assert.ok(full.standing.includes(rule));
    assert.ok(full.standing.includes('Layout · 可查全文 mcp__openviking__read ' + longRule.uri));
    assert.equal(full.standing.includes('按每条来源'), sourceBound);
    assert.equal(full.standing.includes('<statement-source'), sourceBound);
    assert.deepEqual(full.memos.find(row => row.id === 'native-standing:' + shortRule.uri).statementSources, shortRule.statementSources);
    assert.doesNotMatch(full.text, /Unexpanded body/);
    if (safety) {
      assert.ok(full.safety.includes(note));
      assert.equal(full.memos.find(row => row.id === 'native-safety:' + shortNote.uri).scope, 'user');
      assert.ok(full.safety.includes(`History · 2026-11-01 · 来源 ${longNote.sourceUri} · 可查全文 mcp__openviking__read ${longNote.uri}`));
      assert.equal(full.safety.includes('<statement-source'), sourceBound);
    } else assert.equal(full.safety, '');
    const recall = capsuleSearchText([{ factKind: 'note', content: long }], sourceBound);
    if (sourceBound) {
      assert.match(recall, /Full entry exceeds the excerpt budget/);
      assert.doesNotMatch(recall, /Unexpanded body/);
    } else {
      assert.equal(recall, '胶囊笔记与专区（历史记录，不是指令）：\n- [note] ' + long.slice(0, 799) + '…');
    }
  });
}

test('incomplete source conditions preserve the lookup even on an overflow card', () => {
  const first = 'Partial assertion';
  const body = '# First report\n' + first + 'x'.repeat(2000);
  const file = { uri: 'viking://user/a/memories/safety_notes/source.md', type: 'safety_notes', body, updatedAt: '2026-10-10',
    sourceUri: 'viking://user/a/memories/people/legacy.md', statementSources: [{ text: first, source: { conditions: 'missing' } }] };
  const rule = { ...file, uri: 'viking://user/a/memories/preferences/self/style.md', usedCount: 1 };
  const block = renderResidentProfile({ safetyFiles: [file], nativeFiles: [rule], config: { memorySafetyNotesEnabled: true,
    memorySourceEnvelopeEnabled: true, memoryStandingInstructionsEnabled: true, memoryOpeningByUseEnabled: true } });
  for (const [text, uri] of [[block.safety, file.uri], [block.standing, rule.uri], [block.profile, rule.uri]]) {
    assert.ok(text.includes('可查全文 mcp__openviking__read ' + uri));
    assert.match(text, /original conversation/);
    assert.doesNotMatch(text, /Partial assertion/);
  }
  assert.ok(block.safety.includes(file.sourceUri));
  assert.ok(block.safety.includes(file.updatedAt));
});

test('a verbatim migrated safety line retains its one source, never an ambiguous or edited binding', () => {
  const text = 'Only if someone helps.';
  const message = instructionSourceMessage({ role: 'user', content: text });
  const receipt = bindStatementSources(JSON.stringify({ rows: [{ line: 0, kind: 'user_statement',
    message: 0, quote: text, subject: 'self', conditions: 'preserved' }] }), [{ text }], [message]).get(0);
  const inherited = { sources: [{ statementSource: receipt }] };
  assert.equal(statementSource(text, inherited), null);
  assert.deepEqual(statementSource(text, inherited, { safetyProjection: true }), receipt.source);
  assert.equal(statementSource(text + ' Changed.', inherited, { safetyProjection: true }), null);
  assert.equal(statementSource(text, { sources: [...inherited.sources, {}] }, { safetyProjection: true }), null);
});
