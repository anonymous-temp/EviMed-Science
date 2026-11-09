import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
const {options,fixture}=nativeIntegration();

test('unproven native files retain useful owner context without asserting human authorship or factual confidence',options,async t=>{
  const f=await fixture(t);f.seed('notes/clinical-context.md','Assistant suggested considering option A; the patient declined transfusion for religious reasons.',{type:'notes'});
  const profile=await f.store.profile(f.userId),record=profile.records[0];
  assert.match(record.value,/declined transfusion/);assert.equal(record.origin,'unknown');assert.equal(record.confidence,null);assert.equal(record.lastConfirmedAt,null);
  assert.equal(record.attribution.confirmed,false);assert.equal(record.sourcePrivacy.classification,'unclassified');
  assert.ok((await f.store.search(f.userId,'transfusion')).items.some(item=>item.id===record.id),'owner search retains private source context');
});

test('an extracted assistant suggestion is engine-derived context and an unrelated edit does not confirm other profile lines',options,async t=>{
  const f=await fixture(t,{extract:({user})=>({adds:[{uri:`viking://user/${user}/memories/profile.md`,memory_type:'profile',after:'# Profile\n- Assistant suggested a morning review.\n- User works in planning.'}]})});
  await f.commitConversation('a',[{role:'assistant',text:'I suggest a morning review.'},{role:'user',text:'I work in planning.'}]);await f.worker.processCommits({userId:f.userId});
  const before=await f.store.records(f.userId),edited=before.find(row=>row.value.includes('planning'));
  await f.store.update(f.userId,edited.id,{value:'User works in research planning.',expectedVersion:edited.version});
  const records=await f.store.records(f.userId),suggestion=records.find(row=>row.value.includes('suggested'));
  assert.equal(suggestion.origin,'engine');assert.equal(suggestion.confidence,null);assert.equal(suggestion.attribution.confirmed,false);assert.equal(suggestion.lastConfirmedAt,null);
  assert.equal(records.find(row=>row.value.includes('research planning')).origin,'manual');
});

test('import selection and later undo preserve imported attribution without confirming imported claims',options,async t=>{
  const f=await fixture(t,{extract:({user})=>({adds:[{uri:`viking://user/${user}/memories/preferences/imported.md`,memory_type:'preferences',after:'Document A reports a dated measurement; assistant suggested follow-up.'}]})});
  await f.store.rememberImport(f.userId,{ordinary:['Document A reports a dated measurement; assistant suggested follow-up.'],onRequest:[]});await f.worker.processCommits({userId:f.userId});
  const record=(await f.store.records(f.userId))[0];assert.equal(record.origin,'imported');assert.equal(record.attribution.confirmed,false);assert.equal(record.confidence,null);
  await f.store.remove(f.userId,record.id,{keepText:true});await f.store.undo(f.userId,record.id);
  const restored=(await f.store.records(f.userId))[0];assert.equal(restored.origin,'imported');assert.equal(restored.attribution.confirmed,false);
});
