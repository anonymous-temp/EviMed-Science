import test from 'node:test';
import assert from 'node:assert/strict';
import { armEnv, loadPairs, examOrder, profileBlocksOf } from './design.mjs';
test('twelve authored corrections cover four kinds without exposing the correction to exams', async () => {
  const {manifest,pairs,controls}=await loadPairs();
  assert.equal(pairs.length,12); assert.equal(new Set(pairs.map(p=>p.kind)).size,4); assert.equal(controls.length,6);
  assert.equal(new Set([...pairs,...controls].map(p=>p.id)).size,18);
  for(const p of pairs) {
    assert.notEqual(p.learning.initial,p.exam); assert.ok(p.learning.correction.length>100);
    assert.ok(!p.exam.includes(p.learning.correction)); assert.ok(p.behavior.principle && p.behavior.positive && p.behavior.negative && p.quality);
    assert.equal(manifest.items.find(i=>i.id===p.id).reviewed,true);
  }
  for(let rep=1;rep<=3;rep++) assert.equal(new Set(examOrder(pairs,controls,rep).map(p=>p.id)).size,18);
});
test('profile evidence comes from the actual content block, not a tool schema or an escaped proxy',()=>{
  const block='<openviking-context source="profile">\nUse CSV.\n</openviking-context>';
  assert.deepEqual(profileBlocksOf([{messages:[{role:'user',content:[{type:'text',text:block}]}]}]),[block]);
  assert.deepEqual(profileBlocksOf([{messages:[{role:'user',content:'No context'}],tools:[{description:block}]}]),[]);
});
test('arms keep isolation on and separate memory from learning without reverting correction precedence',()=>{
  for(const a of 'ABCD')assert.equal(armEnv(a).OPEN_SCIENCE_MEMORY_RUNTIME_LOCK_ISOLATION_ENABLED,'true');
  assert.equal(armEnv('A').OPEN_SCIENCE_OPENVIKING_URL,'');
  assert.equal(armEnv('B').OPEN_SCIENCE_MEMORY_ENABLED,'true');
  assert.equal(armEnv('B').OPEN_SCIENCE_LEARNING_ENABLED,'false');
  assert.equal(armEnv('C').OPEN_SCIENCE_LEARNING_ENABLED,'true');
  const c=armEnv('C'),d=armEnv('D');
  assert.deepEqual(Object.keys(d).filter(k=>d[k]!==c[k]).sort(),['OPEN_SCIENCE_METHOD_CARD_EVIDENCE_ENABLED','OPEN_SCIENCE_METHOD_OFFICIAL_IN_LOOP_ENABLED','OPEN_SCIENCE_METHOD_PYRAMID_ENABLED']);
  assert.throws(()=>armEnv('E'));
});
