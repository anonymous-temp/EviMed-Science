import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeRecallReceipt, recallDigest, recallOperation, recallRunAt, recallTurn } from '../src/memoryRecallReceipt.mjs';

test('two lookups share a reference, a read and an edit remain distinct, retries are idempotent', () => {
  const item = { uri: 'memory:x', text: 'private wording', source: 'memory-file' };
  const make = (id, entry, items) => recallOperation({ id, entry, query: 'private query', items, at: '2026-11-10T00:00:00Z' });
  const calls = [make('1','mcp.search',[item,item]), make('2','mcp.search',[item]), make('3','mcp.read',[item]), make('4','mcp.read',[{ ...item, text:'changed' }])];
  const r = mergeRecallReceipt(null, calls);
  assert.equal(r.references.length, 3);
  assert.deepEqual(r.operations.map(op => op.refs), [[0],[0],[1],[2]]);
  assert.equal(r.references[0].contentHash, recallDigest(item.text));
  assert.deepEqual(mergeRecallReceipt(r, calls), r);
  assert.doesNotMatch(JSON.stringify(r), /private wording|private query/);
});

test('attempts, actual results and transcript completeness distinguish the lookup chain', () => {
  const turn = { complete:true, searchCalls:0 };
  const op = recallOperation({ id:'1',entry:'mcp.search',coverage:{ history:{state:'empty'} } });
  assert.equal(mergeRecallReceipt(null, [], turn).state,'not_searched');
  assert.equal(mergeRecallReceipt(null, [], { ...turn, complete:false }).state,'unknown');
  assert.equal(mergeRecallReceipt(null, [], { ...turn, searchCalls:1 }).state,'incomplete');
  assert.equal(mergeRecallReceipt(null,[op],turn).state,'empty');
  assert.equal(mergeRecallReceipt(null,[{...op,coverage:{history:'unavailable'}}],turn).state,'incomplete');
  const run = {id:'r',sessionId:'s',question:'new',nativeTurn:{startSeq:4}};
  const message = (seq, text) => ({ role:'assistant',seq,turnStartSeq:seq-1,parts:[{type:'text',text}] });
  const summary = recallTurn(run,[{sessionId:'s',transcript:{sessionId:'s',messages:[message(2,'old'),message(5,'new answer')]}}],true);
  assert.deepEqual(summary.answer,{seq:5,contentHash:recallDigest('new answer')});
});

test('a finished run can receive a delayed receipt only inside its own unique interval', () => {
  const r = {id:'one',sessionId:'s',startedAt:'2026-11-10',finishedAt:'2026-11-11'};
  const at = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(recallRunAt([r],'s',at),r);
  for (const [runs,session,ts] of [[[r,r],'s',at],[[r],'other',at],[[r],null,at],[[r],'s',at+86400000]]) assert.equal(recallRunAt(runs,session,ts),null);
});
