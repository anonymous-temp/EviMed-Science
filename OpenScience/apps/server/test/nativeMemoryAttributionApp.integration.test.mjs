import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeAppIntegration } from './helpers/nativeAppFixture.mjs';
const {options,fixture}=nativeAppIntegration();

test('the owned profile API preserves an unclassified person-bearing note as private unconfirmed context',options,async t=>{
  const f=await fixture(t);f.seed('notes/person-constraint.md','Patient declined transfusion for religious reasons; assistant proposed discussing alternatives.',{type:'notes'});
  const response=await fetch(`${f.base}/api/memory/profile`,{headers:f.headers});assert.equal(response.status,200);
  const record=(await response.json()).data.records.find(row=>row.nativeType==='notes');assert.ok(record);assert.match(record.value,/declined transfusion/);
  assert.equal(record.origin,'unknown');assert.equal(record.confidence,null);assert.equal(record.attribution.confirmed,false);assert.equal(record.sourcePrivacy.classification,'unclassified');
});

test('native capsule preview retains useful uncertain content and requires a digest choice without changing its attribution',options,async t=>{
  const f=await fixture(t);f.seed('notes/person-constraint.md','Patient declined transfusion for religious reasons.',{type:'notes'});
  const capsule=await f.app.capsuleService.ownCapsule(f.user.id,{create:true});
  const previewFor=async input=>{const response=await fetch(`${f.base}/api/capsules/${capsule.id}/exports/preview`,{method:'POST',headers:f.headers,body:JSON.stringify(input)});assert.equal(response.status,200);return (await response.json()).data;};
  const preview=await previewFor({scopes:['workstyle','+knowledge']});
  const entry=preview.entries.find(row=>row.content.includes('declined transfusion'));assert.ok(entry,'source-labeled context remains selectable rather than disappearing with the old explicit-only filter');
  assert.equal(entry.included,false);assert.equal(entry.requiresSelection,true);assert.equal(entry.origin,'unknown');assert.equal(entry.attribution.confirmed,false);assert.equal(entry.sourcePrivacy.classification,'unclassified');
  const selected=await previewFor({scopes:['workstyle','+knowledge'],includePrivateEntries:[{id:entry.id,sha256:entry.sha256}]});
  const kept=selected.entries.find(row=>row.id===entry.id);assert.equal(kept.included,true);assert.equal(kept.attribution.confirmed,false);assert.equal(kept.sourcePrivacy.classification,'unclassified');
});
