import test from 'node:test';
import assert from 'node:assert/strict';
import { checkObservation, observationFixtures } from './observation-recall.mjs';
import { recallDigest } from '../../../apps/server/src/memoryRecallReceipt.mjs';

test('twenty cases resolve to original snapshot rows or named historical checkpoints', async () => {
  const cases = await observationFixtures();
  assert.equal(cases.length,20);
  assert.equal(new Set(cases.map(c=>c.qid)).size,20);
  const counts = Object.fromEntries(['once','preference','withdrawn','shared'].map(kind => [kind,cases.filter(c=>c.kind===kind).length]));
  assert.deepEqual(counts,{once:10,preference:5,withdrawn:3,shared:2});
  assert.equal(cases.filter(c=>c.bodyHash).length,15);
  assert.equal(cases.filter(c=>c.missing).length,5);
});

test('a label, answer-specific review and negative proof are independent', async () => {
  const [f] = await observationFixtures();
  const hit = {uri:'viking://user/test/memories/'+f.file, abstract:f.quote};
  const a = {qid:f.qid,question:f.question,answer:'A single recorded choice.',toolCalls:[]};
  const set = () => { a.toolCalls = [{name:'search',blocks:[JSON.stringify({memories:[hit]})]}]; };
  set();
  assert.equal(checkObservation(f,a,null).reason,'once_label_missing');
  hit.abstract='[seen once — observed choice, not a standing preference]\n'+f.quote; set();
  const review={qid:f.qid,reviewer:'fixture reviewer',evidence:'recorded response',answerHash:recallDigest(a.answer),correct:true};
  assert.equal(checkObservation(f,a,review).outcome,'pass');
  assert.equal(checkObservation(f,{...a,answer:'Changed'},review).outcome,'unknown');
  assert.equal(checkObservation({...f,kind:'withdrawn'},a,review).outcome,'fail');
});
