import test from 'node:test';
import assert from 'node:assert/strict';
import { lexicalAudit, serializeRecordedTool, requestFromPack } from './read-classes.mjs';

test('replay does not invent a successful absent source or expose withdrawn prose', () => {
  const call = serializeRecordedTool({ name: 'mcp__openviking__search', args: { query: 'past' }, blocks: [JSON.stringify({ memories: [] })] });
  assert.match(call.blocks.join('\n'), /completion_not_in_recorded_trace/);
  assert.ok(call.gaps.length);
  const withdrawn = serializeRecordedTool({ name: 'mcp__openviking__search', args: { query: 'past' }, blocks: [JSON.stringify({ memories: [], history: [{ withdrawn: true, messages: [{ text: 'DO-NOT-REVEAL' }], conversationTitle: 'DO-NOT-REVEAL' }] })] });
  assert.doesNotMatch(withdrawn.blocks.join('\n'), /DO-NOT-REVEAL/);
  assert.match(withdrawn.blocks.join('\n'), /withdrawn/);
  const ordinary = requestFromPack({ item: { qid: 'control' }, answer: { qid: 'control', question: 'What is 2 + 2?', asOf: '2026-11-17', toolCalls: [], opening: {}, model: {} }, gold: { question: { expect: { mustContain: ['4'] } } } }, 'fixture');
  assert.equal(ordinary.toolCalls.length, 0);
  assert.equal(ordinary.messages.length, 2, 'no forced memory lookup for an ordinary question');
  assert.doesNotMatch(JSON.stringify(ordinary.messages), /mustContain/);
});

test('lexical evidence proves only literal admission, never unknown vector rank', () => {
  const [audit] = lexicalAudit([{ sessionId: 's1', messages: [{ role: 'assistant', content: 'I suggested 2:3:3.' }] }], [{ kind: 'recorded_query', query: '方案比例（2:3:3）？' }]);
  assert.equal(audit.oldLiteralHits, 0);
  assert.equal(audit.newLiteralHits, 1);
  assert.equal(audit.fullCorpusRecall, 'requires_lab');
});

test('the source variant replays supplied materials with zero memories and never recovers a cut quote from gold', () => {
  const pack = { answer: {qid:'g9-dev-poison-005-q1',question:'Which history?',asOf:'2026-11-17',opening:{},
    toolCalls:[]}, gold:{runtimeQuestion:{materials:[{kind:'paste',text:'Supplied history',title:'Example'}],
    expect:{mustContain:['HIDDEN_GOLD']}}} };
  const {messages} = requestFromPack(pack,'fixture',null,'g1121-src');
  const material = JSON.parse(JSON.parse(messages.find(m => m.role === 'tool').content).text)[0];
  assert.equal(material.source.kind,'pasted_material');
  assert.equal(material.source.subject,'unknown');
  assert.doesNotMatch(JSON.stringify(messages),/HIDDEN_GOLD/);
  const tool = serializeRecordedTool({ name:'search', blocks:[JSON.stringify({memories:[],history:[{
    conversationTitle:'Historical',messages:[{sourceRole:'user',text:'A cut clause'}]}]})]},true);
  assert.doesNotMatch(tool.blocks.join(' '),/A cut clause/);
  assert.match(tool.blocks.join(' '),/complete original/);
});

test('a database lookup carried by read_material keeps its own external source in frozen replay', () => {
  const material = { kind: 'tool', title: 'Drug database lookup', text: 'Patient record: no known allergy.' };
  const pack = { answer: { qid: 'case-q1', question: 'What should I report?', asOf: '2026-11-17', opening: {},
    toolCalls: [{ name: 'skill', blocks: ['skill body'] }] }, gold: { runtimeQuestion: { materials: [material] } } };
  const { messages } = requestFromPack(pack, 'fixture', null, 'g1121-src');
  const [carrier, skill] = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  const [entry] = JSON.parse(carrier.text);
  assert.equal(carrier.source.tool, 'read_material');
  assert.equal(entry.text, material.text);
  assert.equal(entry.source.tool, material.title);
  assert.match(entry.source.label, /External material returned by Drug database lookup/);
  assert.equal(entry.source.personalFact, false);
  assert.equal(skill.source.tool, 'skill');
});
