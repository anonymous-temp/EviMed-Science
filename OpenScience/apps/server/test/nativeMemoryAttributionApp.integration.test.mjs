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

test('encrypted capsule export and confirmed import preserve original uncertainty and private source lineage',options,async t=>{
  const f=await fixture(t);f.seed('notes/person-constraint.md','Assistant suggested discussing alternatives after a patient declined transfusion.',{type:'notes'});
  const capsule=await f.app.capsuleService.ownCapsule(f.user.id,{create:true}),request=async(route,body,headers=f.headers)=>{const response=await fetch(`${f.base}/api/capsules${route}`,{method:'POST',headers,body:JSON.stringify(body)});assert.ok(response.ok,`${response.status} ${await response.clone().text()}`);return (await response.json()).data;};
  const offered=await request(`/${capsule.id}/exports/preview`,{scopes:['workstyle','+knowledge']}),entry=offered.entries.find(row=>row.content.includes('transfusion'));
  const exported=await request(`/${capsule.id}/exports`,{password:'test-only-attribution-export',scopes:['workstyle','+knowledge'],includePrivateEntries:[{id:entry.id,sha256:entry.sha256}]});
  const preview=await request('/transfers/preview',{archive:exported.archive,password:'test-only-attribution-export'});
  assert.equal(preview.entries[0].origin,'unknown');assert.equal(preview.entries[0].attribution.confirmed,false);assert.equal(preview.entries[0].sourcePrivacy.classification,'unclassified');
  const imported=await request('/transfers/import',{archive:exported.archive,password:'test-only-attribution-export',expectedDigest:preview.archiveSha256,confirmed:true});
  const records=await f.app.capsuleService.entries(f.user.id,imported.id),received=records.items[0].payload;
  assert.equal(received.origin,'imported');assert.equal(received.attribution.confirmed,false);assert.equal(received.sourcePrivacy.classification,'unclassified');
  await f.app.capsuleService.enableReceived(f.user.id,imported.id);
  const ownerRecall=await f.app.capsuleService.recall(f.user.id,{query:'transfusion'});assert.equal(ownerRecall.items[0].sourcePrivacy.classification,'unclassified');
  const {recallForAgent}=await import('../src/agentMemoryRecall.mjs');
  const external=await recallForAgent({capsules:f.app.capsuleService},{user:{id:f.user.id}},{query:'transfusion',methods:'none',capsuleIds:[imported.id]});
  assert.equal(external.items.some(item=>String(item.content).includes('transfusion')),false,'share consent does not authorize external integration recall');

});

test('a trusted resident source receipt survives the run ledger as private original evidence',options,async t=>{
  const f=await fixture(t),owner=await f.app.store.userById(f.user.id),project=await f.app.store.requireProject(owner,'default');
  await f.app.researchSessions.put(project,'source-receipt',{mode:'open-domain'});const run=await f.app.agentRuns.start(project,{sessionId:'source-receipt'});
  try{
    await f.app.agentRuns.recordLearning(project,run.id,{recalledMemories:[{id:'memo',kind:'note',scope:'user',sourcePrivacy:{schemaVersion:1,classification:'private',reasons:['person-context']},originalSources:[{id:'native-source',contentDigest:'a'.repeat(64),sourcePrivacy:{schemaVersion:1,classification:'ordinary',reasons:['bounded-visible-reference']},attribution:{schemaVersion:1,origins:['engine'],confirmed:false}}]}]});
    const stored=(await f.app.agentRuns.list(project)).find(item=>item.id===run.id);assert.equal(stored.sourcePrivacy.classification,'private');assert.equal(stored.originalSources[0].id,'native-source');assert.equal(stored.originalSources[0].attribution.confirmed,false);
  }finally{await f.app.agentRuns.closeProject(project);}
});
