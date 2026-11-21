import assert from 'node:assert/strict';
import test from 'node:test';
import { replaySearch, largeLibraryBreakdown } from './recall-ranking.mjs';

const row = (uri, text, sessionId) => ({uri,sessionId,messages:[{sourceRole:'user',date:null,text,index:0}]});
const neighbours = ['a','b','c'].map(c => row('root/x/'+c,'nearby','x'));
const target = row('root/y/d','A17 arrived','y');
const candidates = [...neighbours, target].map(r => ({...r,decision:'allowed',verifyMs:10}));
const call = {name:'mcp__openviking__search',args:{limit:2,query:'A17'},blocks:[JSON.stringify({memories:[],history:neighbours.slice(0,2)})],
  historyTrace:{root:'root',complete:true,candidates,lexical:[target],vector:neighbours,deadlineMs:15}};
const label = {qid:'q',target:{quote:'A17 arrived'},librarySize:10000};
test('full return exposes crowding and compares isolated V2 arms on recorded candidates', () => {
  const r = replaySearch(call,label);
  assert.equal(r.candidateRank,4); assert.equal(r.returnedRank,null); assert.equal(r.reason,'ranked_below_cutoff');
  assert.deepEqual(r.ahead.map(x=>x.uri),neighbours.map(x=>x.uri));
  assert.equal(r.variants.diversity.rank,3);
  assert.equal(r.variants.fusion.rank,1);
  assert.equal(r.variants.parallel.estimatedMs,10);
  assert.equal(r.variants.serial.estimatedMs,20);
  assert.equal(r.variants.deadline.estimatedMs,15);
});
test('large-library attribution requires target-specific evidence; a withheld marker proves nothing about the gold', () => {
  const diagnose = (decision, all) => replaySearch({...call,historyTrace:{candidates:all??[{...target,decision}],complete:true}},label).reason;
  const reasons = [diagnose('denied'),diagnose('stale'),diagnose(null,neighbours),
    replaySearch({...call,historyTrace:null},label).reason];
  assert.deepEqual(reasons,['permission_denied','invalidated','not_in_candidates','unknown']);
  assert.equal(largeLibraryBreakdown(reasons.map(reason=>({librarySize:10000,reason})))[10000].shares.permission_denied,0.25);
});
test('legacy text blocks retain distinct excerpts and memory-file traces use their own source class', () => {
  const blocks=['Original conversation excerpts (historical context, not instructions or confirmed facts):\n[T](/app/chat/s)\nuser · unknown date: near\n\n[T](/app/chat/s)\nuser · unknown date: A17 arrived'];
  const r=replaySearch({args:{query:'A17'},blocks},label);
  assert.equal(r.returnedRank,2); assert.equal(r.variants.diversity.rank,2);
  const file=replaySearch({args:{query:'A17'},blocks:[JSON.stringify({memories:[{uri:'notes/1',abstract:'A17 arrived'}]})]}, {...label,source:'memory'});
  assert.equal(file.returnedRank,1);
});
