import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductDocuments } from '../src/productStore.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { nativeFileId } from '../src/nativeMemoryStore.mjs';
import { nativeAppIntegration } from './helpers/nativeAppFixture.mjs';
const { options, fixture } = nativeAppIntegration();

test('owned source DELETE is wired through durable state, source privacy, metadata admission and pending status', options, async t => {
  const {app,base,headers,user,stub,engineUser}=await fixture(t);
  const project=await app.store.requireProject(await app.store.userById(user.id),'default');
  await app.researchSessions.put(project,'source_a',{mode:'open-domain'});
  await app.researchSessions.put(project,'independent_b',{mode:'open-domain'});
  const uri=stub.seedMemory(engineUser,'profile.md','# Profile\n- Private source A.\n- Independent B.',{type:'profile'});
  const overlay=app.nativeMemory.overlay;
  await overlay.upsertFile({userId:user.id,uri,memoryType:'profile',body:'# Profile\n- Private source A.\n- Independent B.'});
  const initialArchive=`${app.nativeMemory.sessions.userRoot(user.id)}/sessions/dsh-source_a/history/archive_001`;
  await overlay.recordCommit({userId:user.id,archiveUri:initialArchive,engineSession:'dsh-source_a',projectId:'default',origin:'gateway',state:'completed'});
  await overlay.addRevision({userId:user.id,uri,memoryType:'profile',change:'added',actor:'engine',after:'# Profile\n- Private source A.',engineSession:'dsh-source_a',archiveUri:initialArchive,projectId:null});
  await overlay.syncOrigins(user.id,uri,{before:'',after:'# Profile\n- Private source A.',origin:{engineSession:'dsh-source_a',projectId:'default'}});
  await overlay.syncOrigins(user.id,uri,{before:'# Profile\n- Private source A.',after:'# Profile\n- Private source A.\n- Independent B.',origin:{engineSession:'dsh-independent_b',projectId:'default'}});
  const documents=new ProductDocuments(app.store.database), capsule=await app.capsuleService.ownCapsule(user.id,{create:true});
  const snapshots=[];
  for(const text of ['Private source A.','Independent B.']) snapshots.push((await documents.createBatch(user.id,[{kind:'preferences',id:crypto.randomUUID(),payload:{recordType:'capsule-snapshot',capsuleId:capsule.id,status:'active',sourceEntries:[{id:`${nativeFileId(uri)}_${lineFingerprint(text).slice(0,12)}`,revision:1,sha256:'a'.repeat(64)}]}}]))[0]);
  const sourceRun=await app.agentRuns.start(project,{sessionId:'source_a'});
  await app.agentRuns.closeProject(project);
  const events=app.runtimeEventPump.runEvents;
  events.publish(sourceRun.id,'run/event',{text:'source event before deletion'});
  const sourceStream=await fetch(`${base}/api/runs/${sourceRun.id}/events`,{headers});
  app.runtimeManager.captureConversationSource=async()=>({root:{id:'source_a',createdAt:1,cwd:'/workspace',isSeeded:false},sessions:[{id:'source_a'}],generation:'synthetic-fixture'});
  let physical=false;
  app.runtimeManager.purgeConversationSource=async()=>{if(physical)await app.runtimeManager.stop(project);return {sourceRemoved:physical,reason:physical?null:'runtime_busy'};};
  const target=`${base}/api/projects/default/conversations/source_a/source`;
  const removed=await fetch(target,{method:'DELETE',headers});
  assert.equal(removed.status,202); const result=(await removed.json()).data;
  assert.equal(result.sourceRemoved,false); assert.equal(result.cleanup,'pending');
  await sourceStream.text();
  assert.equal(events.channel(sourceRun.id).buffer.length,0);
  assert.equal((await fetch(`${base}/api/runs/${sourceRun.id}/events?since=0`,{headers})).status,404);
  assert.equal((await documents.get(user.id,'preferences',snapshots[0].id)).payload.status,'revoked');
  assert.equal((await documents.get(user.id,'preferences',snapshots[1].id)).payload.status,'active','an independent B-only profile snapshot stays in force');
  assert.deepEqual((await app.researchSessions.list(project)).map(row=>row.sessionId),['independent_b']);
  await assert.rejects(app.researchSessions.put(project,'source_a',{mode:'open-domain'}),{status:404});
  assert.deepEqual(await app.nativeMemory.files(user.id),[],'source-bearing native file is hidden while cleanup waits');
  assert.ok((await overlay.sensitiveUris(user.id)).includes(uri),'native recall uses the same immediate source privacy fence');
  assert.equal((await fetch(`${base}/api/projects/unknown/conversations/source_a/source`,{method:'DELETE',headers})).status,404);
  await app.sourceDeletion.drain(); assert.equal((await (await fetch(target,{headers})).json()).data.cleanup,'pending');
  const waiting=(await app.sourceDeletion.ledger.database.query("SELECT next_attempt_at FROM evimed_source_deletion.conversations WHERE cleanup='pending' AND next_attempt_at IS NOT NULL")).rows.length;
  assert.ok(waiting>0,'a cleanup that could not finish waits out a backoff');
  await app.sourceDeletion.ledger.database.query("UPDATE evimed_source_deletion.conversations SET next_attempt_at=NULL WHERE cleanup='pending'");
  physical=true; await app.sourceDeletion.drain();
  const completed=(await (await fetch(target,{headers})).json()).data;
  assert.equal(completed.sourceRemoved,true);assert.equal(completed.cleanup,'complete',JSON.stringify(completed));
  const kept=await app.nativeMemory.files(user.id);assert.equal(kept.length,1);assert.equal(kept[0].body,'# Profile\n- Independent B.');
  const revived='# Profile\n- Private source A.\n- Independent B.',freshArchive=`${app.nativeMemory.sessions.userRoot(user.id)}/sessions/dsh-independent_b/history/archive_001`;
  await overlay.recordCommit({userId:user.id,archiveUri:freshArchive,engineSession:'dsh-independent_b',projectId:'default',origin:'gateway',state:'completed'});
  stub.files.set(`${freshArchive}/messages.jsonl`,JSON.stringify({role:'user',content:'Private source A.',created_at:new Date().toISOString()}));
  await app.nativeMemory.sessions.replace(user.id,uri,revived);
  await app.nativeMemoryWorker.ingest(await overlay.commit(user.id,freshArchive),{operations:{updates:[{uri,before:'# Profile\n- Independent B.',after:revived}]}});
  const independent=(await app.nativeMemory.records(user.id)).find(record=>record.value==='Private source A.');assert.ok(independent,'a later independent source may restate the same fact');
  app.nativeMemory.rejectionJudge={same:async({candidates})=>({same:new Map(candidates.flatMap((candidate,index)=>{const matchedRemoval=candidate.removed.find(line=>line.text.toLowerCase()===candidate.text.toLowerCase());return matchedRemoval?[[index,matchedRemoval.fingerprint]]:[];})),stated:new Set()})};
  await app.nativeMemory.remove(user.id,independent.id,{keepText:true});await app.nativeMemory.undo(user.id,independent.id);
  await app.store.database.query("UPDATE evimed_source_deletion.conversations SET updated_at=clock_timestamp()-interval '2 minutes' WHERE user_id=$1",[user.id]);
  await app.sourceDeletion.drain();assert.equal(await app.nativeMemory.sessions.read(user.id,uri),revived,'source sweeps preserve independent restatement and ordinary undo');

});

test('pending source deletion suppresses replaced history and its private snapshot while preserving current B and unrelated undo',options,async t=>{
  const {app,base,headers,user,stub,engineUser}=await fixture(t),project=await app.store.requireProject(await app.store.userById(user.id),'default');
  await app.researchSessions.put(project,'old_a',{mode:'open-domain'});
  const uri=stub.seedMemory(engineUser,'profile.md','# Profile\n- Independent current B.',{type:'profile'}),overlay=app.nativeMemory.overlay;
  const archive=`${app.nativeMemory.sessions.userRoot(user.id)}/sessions/dsh-old_a/history/archive_001`;
  await overlay.recordCommit({userId:user.id,archiveUri:archive,engineSession:'dsh-old_a',projectId:'default',origin:'gateway',state:'completed'});
  await overlay.addRevision({userId:user.id,uri,memoryType:'profile',change:'added',actor:'engine',after:'# Profile\n- Private historical A.',engineSession:'dsh-old_a',archiveUri:archive,projectId:null});
  await overlay.addRevision({userId:user.id,uri,memoryType:'profile',change:'updated',actor:'engine',before:'# Profile\n- Private historical A.',after:'# Profile\n- Independent current B.',engineSession:'dsh-b',projectId:null});
  await overlay.upsertFile({userId:user.id,uri,memoryType:'profile',body:'# Profile\n- Independent current B.'});
  await overlay.syncOrigins(user.id,uri,{after:'# Profile\n- Independent current B.',origin:{engineSession:'dsh-b',projectId:'default'}});
  const documents=new ProductDocuments(app.store.database),capsule=await app.capsuleService.ownCapsule(user.id,{create:true});
  const [snapshot]=await documents.createBatch(user.id,[{kind:'preferences',id:crypto.randomUUID(),payload:{recordType:'capsule-snapshot',capsuleId:capsule.id,status:'active',sourceEntries:[{id:`${nativeFileId(uri)}_${lineFingerprint('Private historical A.').slice(0,12)}`,revision:1,sha256:'b'.repeat(64)}]}}]);
  app.runtimeManager.captureConversationSource=async(_p,id)=>({root:{id,createdAt:1,cwd:'/workspace',isSeeded:false},sessions:[{id}]});
  app.runtimeManager.purgeConversationSource=async()=>({sourceRemoved:false,reason:'runtime_busy'});
  const response=await fetch(`${base}/api/projects/default/conversations/old_a/source`,{method:'DELETE',headers});assert.equal(response.status,202);
  assert.equal((await documents.get(user.id,'preferences',snapshot.id)).payload.status,'revoked');
  const records=await app.nativeMemory.records(user.id);assert.ok(records.some(row=>row.value==='Independent current B.'));
  assert.doesNotMatch(JSON.stringify(records),/Private historical A/);
  await assert.rejects(app.nativeMemory.undo(user.id,nativeFileId(uri)),{code:'memory_source_deleted'});
  const other=stub.seedMemory(engineUser,'notes/independent.md','Independent forgotten note.',{type:'notes'});
  const file=(await app.nativeMemory.files(user.id)).find(row=>row.uri===other);
  await app.nativeMemory.forgetFile(user.id,file,{keepText:true});await app.nativeMemory.undo(user.id,nativeFileId(other));
  assert.equal(await app.nativeMemory.sessions.read(user.id,other),'Independent forgotten note.');
});

test('only controller-proven native namespace copies are cleaned and equal ids in another project survive',options,async t=>{
  const {app,base,headers,user,stub}=await fixture(t),owner=await app.store.userById(user.id),project=await app.store.requireProject(owner,'default');
  const {GeoStore}=await import('../src/geoStore.mjs'),geo=new GeoStore({database:app.store.database});await geo.ready();
  const colleague=await app.store.createUser(`source-copy-colleague-${crypto.randomUUID().slice(0,8)}`,'synthetic-source-copy-password','Colleague');
  const register=async(projectId)=>{const item=await geo.createProject({userId:user.id,projectId,engines:['deepseek'],coverageDays:30});await geo.addMember({geoId:item.id,userId:colleague.id,role:'editor',invitedBy:user.id});return app.nativeMemory.memoryContexts.forProject(await app.store.requireProject(owner,projectId));};
  const shared=await register('default');await app.store.createProject(owner,'other','Independent project');const other=await register('other');
  const personal=(await app.nativeMemory.memoryContexts.all(user.id)).find(view=>view.kind==='owned'),overlay=app.nativeMemory.overlay;
  const entries=[];
  for(const [view,rel,type,source,kept] of [[personal,'profile.md','profile','Personal source A.','Personal independent B.'],[shared,'project_facts/source.md','project_facts','Shared source A.','Shared independent B.']]){
    const uri=stub.seedMemory(view.namespaceId,rel,`# Facts\n- ${source}\n- ${kept}`,{type});
    await overlay.upsertFile({userId:user.id,uri,memoryType:type,body:`# Facts\n- ${source}\n- ${kept}`,projectId:type==='profile'?null:'default'});
    await overlay.syncOrigins(user.id,uri,{after:`# Facts\n- ${source}`,origin:{engineSession:'dsh-source_a',projectId:'default'}});
    await overlay.syncOrigins(user.id,uri,{before:`# Facts\n- ${source}`,after:`# Facts\n- ${source}\n- ${kept}`,origin:{engineSession:'dsh-b',projectId:'default'}});entries.push({view,uri,kept});
  }
  const otherUri=stub.seedMemory(other.namespaceId,'project_facts/source.md','Independent equal-id source.',{type:'project_facts'});
  await overlay.upsertFile({userId:user.id,uri:otherUri,memoryType:'project_facts',body:'Independent equal-id source.',projectId:'other'});
  await overlay.syncOrigins(user.id,otherUri,{after:'Independent equal-id source.',origin:{engineSession:'dsh-source_a',projectId:'other'}});
  const root={id:'source_a',createdAt:1,cwd:'/workspace',isSeeded:false};
  app.runtimeManager.captureConversationSource=async()=>({root,sessions:[root],copies:[{contextReference:null,memoryNamespaceId:null,root,sessions:[root]},{contextReference:{id:'trusted-fixture-context'},memoryNamespaceId:shared.namespaceId,root,sessions:[root]}]});
  app.runtimeManager.purgeConversationSource=async()=>({sourceRemoved:true,removedSessionIds:['source_a']});
  assert.equal((await fetch(`${base}/api/projects/default/conversations/source_a/source`,{method:'DELETE',headers})).status,202);
  const row=await app.sourceDeletion.ledger.get(project,'source_a');assert.deepEqual(new Set(row.nativeRoots),new Set([personal.userRoot,shared.userRoot]));
  await app.sourceDeletion.drain();const status=await app.sourceDeletion.status(project,'source_a');assert.equal(status.cleanup,'complete',JSON.stringify(status));
  for(const entry of entries)assert.equal(await entry.view.sessions.read(user.id,entry.uri),`# Facts\n- ${entry.kept}`);
  assert.equal(await other.sessions.read(user.id,otherUri),'Independent equal-id source.');
});

test('unproven consolidation lineage keeps native cleanup pending and quarantines controlled recall/export without erasing B',options,async t=>{
  const {app,base,headers,user,stub,engineUser}=await fixture(t),root=app.nativeMemory.sessions.userRoot(user.id),overlay=app.nativeMemory.overlay;
  await app.store.requireProject(await app.store.userById(user.id),'default');
  const uri=stub.seedMemory(engineUser,'preferences/source.md','Original private A fact.',{type:'preferences'}),archive=`${root}/sessions/dsh-a/history/archive_001`;
  await overlay.recordCommit({userId:user.id,archiveUri:archive,engineSession:'dsh-a',projectId:'default',origin:'gateway',state:'completed'});
  await overlay.addRevision({userId:user.id,uri,memoryType:'preferences',change:'added',actor:'engine',after:'Original private A fact.',engineSession:'dsh-a',archiveUri:archive,projectId:null});
  await overlay.upsertFile({userId:user.id,uri,memoryType:'preferences',body:'Original private A fact.'});
  await overlay.syncOrigins(user.id,uri,{after:'Original private A fact.',origin:{engineSession:'dsh-a',archiveUri:archive,projectId:'default'}});
  await app.nativeMemory.sessions.replace(user.id,uri,'Reworded private A combined with independent B.');
  await app.nativeMemoryWorker.ingestConsolidation(user.id,{taskId:'synthetic-consolidation-source-task',updates:[uri]});
  app.runtimeManager.captureConversationSource=async()=>({root:{id:'a',createdAt:1,cwd:'/workspace',isSeeded:false},sessions:[{id:'a'}]});
  app.runtimeManager.purgeConversationSource=async()=>({sourceRemoved:true,removedSessionIds:['a']});
  assert.equal((await fetch(`${base}/api/projects/default/conversations/a/source`,{method:'DELETE',headers})).status,202);
  await app.sourceDeletion.drain();const project=await app.store.requireProject(await app.store.userById(user.id),'default'),status=await app.sourceDeletion.status(project,'a');
  assert.equal(status.sourceRemoved,true);assert.equal(status.cleanup,'pending');assert.equal(status.reason,'native_lineage_unverified');
  assert.deepEqual(await app.nativeMemory.files(user.id),[]);assert.ok((await overlay.sensitiveUris(user.id)).includes(root));
  await assert.rejects(app.nativeMemory.exportPack(user.id),{code:'memory_source_cleanup_busy'});
  await assert.rejects(app.sourceDeletion.assertSnapshotSourcesAvailable(user.id,[{id:nativeFileId(uri),nativeSource:{engine:'native'}}]),{code:'memory_source_lineage_unverified'});
  assert.equal(await app.nativeMemory.sessions.read(user.id,uri),'Reworded private A combined with independent B.');
});

test('source acknowledgment waits for an already-admitted RR account export through its final response handoff',options,async t=>{
  const {app,base,headers,user,stub,engineUser,sessions}=await fixture(t),project=await app.store.requireProject(await app.store.userById(user.id),'default');
  await app.sourceDeletion.ledger.migrate();await app.nativeMemory.overlay.noteRegistered(user.id);stub.seedMemory(engineUser,'profile.md','Private export source A.',{type:'profile'});
  let enterPack,releasePack,enterEnd,releaseEnd,enterPut;
  const packed=new Promise(resolve=>enterPack=resolve),packGate=new Promise(resolve=>releasePack=resolve),ending=new Promise(resolve=>enterEnd=resolve),endGate=new Promise(resolve=>releaseEnd=resolve),putting=new Promise(resolve=>enterPut=resolve);
  const timer=setTimeout(()=>{releasePack();releaseEnd();},10000);timer.unref();t.after(()=>clearTimeout(timer));
  const originalPack=sessions.exportPack.bind(sessions);sessions.exportPack=async(...args)=>{enterPack();await packGate;return originalPack(...args);};
  const order=[];app.server.on('request',(req,res)=>{if(req.url==='/api/account/export'){const end=res.end.bind(res);res.end=(...args)=>{enterEnd();void endGate.then(()=>end(...args));return res;};res.once('finish',()=>order.push('export-handoff'));}if(req.method==='DELETE'&&req.url?.endsWith('/conversations/a/source'))res.once('finish',()=>order.push('delete-ack'));});
  app.runtimeManager.captureConversationSource=async()=>({root:{id:'a',createdAt:1,cwd:'/workspace',isSeeded:false},sessions:[{id:'a'}]});
  const originalPut=app.sourceDeletion.ledger.put.bind(app.sourceDeletion.ledger);app.sourceDeletion.ledger.put=async row=>{enterPut();return originalPut(row);};
  const exported=fetch(`${base}/api/account/export`,{headers}).then(async response=>({status:response.status,bytes:await response.arrayBuffer()}));
  await packed;const deleting=fetch(`${base}/api/projects/default/conversations/a/source`,{method:'DELETE',headers});await putting;
  await new Promise(resolve=>setTimeout(resolve,60));const duringPack=await app.sourceDeletion.ledger.get(project,'a');
  releasePack();await ending;await new Promise(resolve=>setTimeout(resolve,60));const duringHandoff=await app.sourceDeletion.ledger.get(project,'a');
  releaseEnd();const [archive,deleted]=await Promise.all([exported,deleting]);
  assert.equal(archive.status,200);assert.ok(archive.bytes.byteLength>0);assert.equal(deleted.status,202);
  assert.equal(duringPack,null,'the source fence cannot commit inside the old export snapshot');assert.equal(duringHandoff,null,'the old export must finish handing off bytes before deletion is accepted');
  assert.ok(order.indexOf('export-handoff')<order.indexOf('delete-ack'));
});

test('new account and project archives refuse a pending source even without a native pack to collect',options,async t=>{
  const {app,base,headers}=await fixture(t);
  app.runtimeManager.captureConversationSource=async()=>({root:{id:'a',createdAt:1,cwd:'/workspace',isSeeded:false},sessions:[{id:'a'}]});
  app.runtimeManager.purgeConversationSource=async()=>({sourceRemoved:false,reason:'runtime_busy'});
  assert.equal((await fetch(`${base}/api/projects/default/conversations/a/source`,{method:'DELETE',headers})).status,202);
  for(const path of ['/api/account/export','/api/projects/default/export']) {
    const response=await fetch(base+path,{headers});assert.equal(response.status,409);const body=await response.json();assert.equal(body.code,'source_deletion_pending');
  }
});

test('a previously restored source fact is hidden immediately while its source cleanup is still busy',options,async t=>{
  const {app,base,headers,user,stub,engineUser}=await fixture(t),overlay=app.nativeMemory.overlay,root=app.nativeMemory.sessions.userRoot(user.id);
  await app.store.requireProject(await app.store.userById(user.id),'default');
  const uri=stub.seedMemory(engineUser,'profile.md','# Profile\n- Restored private A.',{type:'profile'}),archive=`${root}/sessions/dsh-a/history/archive_001`;
  await overlay.recordCommit({userId:user.id,archiveUri:archive,engineSession:'dsh-a',projectId:'default',origin:'gateway',state:'completed'});
  await overlay.addRevision({userId:user.id,uri,memoryType:'profile',change:'added',actor:'engine',after:'# Profile\n- Restored private A.',engineSession:'dsh-a',archiveUri:archive,projectId:null});
  await overlay.addRevision({userId:user.id,uri,memoryType:'profile',change:'restored',actor:'user',after:'# Profile\n- Restored private A.',reason:'undo',projectId:null});
  await overlay.upsertFile({userId:user.id,uri,memoryType:'profile',body:'# Profile\n- Restored private A.'});
  app.runtimeManager.captureConversationSource=async()=>({root:{id:'a',createdAt:1,cwd:'/workspace',isSeeded:false},sessions:[{id:'a'}]});
  app.runtimeManager.purgeConversationSource=async()=>({sourceRemoved:false,reason:'runtime_busy'});
  assert.equal((await fetch(`${base}/api/projects/default/conversations/a/source`,{method:'DELETE',headers})).status,202);
  assert.deepEqual(await app.nativeMemory.files(user.id),[]);assert.ok((await overlay.sensitiveUris(user.id)).includes(uri));
});

test('native personal facts from a replacement project incarnation are never attributed to its old source tombstone',options,async t=>{
  const {app,base,headers,user,stub,engineUser}=await fixture(t),owner=await app.store.userById(user.id),overlay=app.nativeMemory.overlay;
  await app.store.createProject(owner,'reused','Original project');const old=await app.store.requireProject(owner,'reused'),root=app.nativeMemory.sessions.userRoot(user.id);
  const oldUri=stub.seedMemory(engineUser,'preferences/old.md','Old source fact.',{type:'preferences'}),oldArchive=`${root}/sessions/dsh-same/history/archive_001`;
  const oldCommit=await overlay.recordCommit({userId:user.id,archiveUri:oldArchive,engineSession:'dsh-same',projectId:'reused',origin:'gateway',state:'completed'});
  await overlay.upsertFile({userId:user.id,uri:oldUri,memoryType:'preferences',body:'Old source fact.'});
  await overlay.addRevision({userId:user.id,uri:oldUri,memoryType:'preferences',change:'added',actor:'engine',after:'Old source fact.',engineSession:'dsh-same',archiveUri:oldArchive,sourceProjectId:'reused',sourceProjectCreatedAt:oldCommit.projectCreatedAt});
  await overlay.syncOrigins(user.id,oldUri,{after:'Old source fact.',origin:{engineSession:'dsh-same',archiveUri:oldArchive,projectId:'reused',projectCreatedAt:oldCommit.projectCreatedAt}});
  app.runtimeManager.captureConversationSource=async()=>({root:{id:'same',createdAt:1,cwd:'/workspace',isSeeded:false},sessions:[{id:'same'}]});
  app.runtimeManager.purgeConversationSource=async()=>({sourceRemoved:false,reason:'runtime_busy'});
  assert.equal((await fetch(`${base}/api/projects/reused/conversations/same/source`,{method:'DELETE',headers})).status,202);
  await app.store.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id='reused'",[user.id]);
  const replacement=await app.store.requireProject(owner,'reused'),newUri=stub.seedMemory(engineUser,'preferences/new.md','New independent fact.',{type:'preferences'}),newArchive=`${root}/sessions/dsh-same/history/archive_002`;
  const fresh=await overlay.recordCommit({userId:user.id,archiveUri:newArchive,engineSession:'dsh-same',projectId:'reused',origin:'gateway',state:'completed'});
  await overlay.upsertFile({userId:user.id,uri:newUri,memoryType:'preferences',body:'New independent fact.'});
  await overlay.addRevision({userId:user.id,uri:newUri,memoryType:'preferences',change:'added',actor:'engine',after:'New independent fact.',engineSession:'dsh-same',archiveUri:newArchive,sourceProjectId:'reused',sourceProjectCreatedAt:fresh.projectCreatedAt});
  await overlay.syncOrigins(user.id,newUri,{after:'New independent fact.',origin:{engineSession:'dsh-same',archiveUri:newArchive,projectId:'reused',projectCreatedAt:fresh.projectCreatedAt}});
  assert.equal(await app.sourceDeletion.ledger.get(replacement,'same'),null);
  const hidden=await app.sourceDeletion.ledger.hiddenMemoryUris(user.id);assert.ok(hidden.includes(oldUri));assert.equal(hidden.includes(newUri),false);
  assert.ok((await app.nativeMemory.records(user.id)).some(record=>record.value==='New independent fact.'));
  assert.equal((await app.sourceDeletion.ledger.get({...old,sourceProjectCreatedAt:oldCommit.projectCreatedAt},'same')),null,'current SQL authority is not replaced by a stale object');
});

test('real source route drains history outside the transaction and resumes after a crash between history and derived cleanup',options,async t=>{
  const {app,base,headers,user,stub,engineUser}=await fixture(t);
  const project=await app.store.requireProject(await app.store.userById(user.id),'default');
  const context=await app.nativeMemory.memoryContexts.forProject(project),ledger=app.memoryHistory.ledger;
  const uri=stub.seedMemory(engineUser,'notes/source.md','Private F-25429 source.',{type:'notes'});
  const archive=`${context.userRoot}/sessions/dsh-source/history/archive_001`;
  await app.nativeMemory.overlay.upsertFile({userId:user.id,uri,memoryType:'notes',body:'Private F-25429 source.'});
  await app.nativeMemory.overlay.syncOrigins(user.id,uri,{after:'Private F-25429 source.',origin:{engineSession:'dsh-source',archiveUri:archive,projectId:'default'}});
  const other=stub.seedMemory(engineUser,'notes/unrelated space.md','Independent space-named memory.',{type:'notes'});
  await app.nativeMemory.overlay.upsertFile({userId:user.id,uri:other,memoryType:'notes',body:'Independent space-named memory.'});
  ledger.client=context.sessions.client;
  const chunk=`${app.memoryHistory.root(context,{projectId:'default',projectCreatedAt:context.projectCreatedAt})}/${'a'.repeat(24)}/${'b'.repeat(24)}-0.md`;
  const meta={ownerId:user.id,ownerCreatedAt:context.ownerCreatedAt,namespaceId:context.namespaceId,projectId:'default',projectCreatedAt:context.projectCreatedAt,sessionId:'source',archiveUri:archive,uri:chunk,minimumDate:null};
  await ledger.reserve(meta,'test-digest');await ledger.ready(meta);
  await app.memoryHistory.resourcesFor(context).writeHistory(user.id,chunk,'Private history source.');
  app.runtimeManager.captureConversationSource=async()=>({root:{id:'source',createdAt:1,cwd:'/workspace',isSeeded:false},sessions:[{id:'source'}]});
  let crash=true;
  app.runtimeManager.purgeConversationSource=async()=>{if(crash)throw new Error('simulated process interruption');return {sourceRemoved:true,removedSessionIds:['source']};};
  const drain=app.memoryHistory.drainDeletes.bind(app.memoryHistory);
  app.memoryHistory.drainDeletes=async()=>{};
  const target=`${base}/api/projects/default/conversations/source/source`;
  assert.equal((await fetch(target,{method:'DELETE',headers})).status,202);
  app.memoryHistory.drainDeletes=drain;
  await app.sourceDeletion.drain();
  assert.equal((await app.sourceDeletion.status(project,'source')).cleanup,'pending');
  assert.equal(await context.sessions.read(user.id,chunk),null,'history engine deletion completed before the interruption');
  assert.ok((await app.store.database.query('SELECT cleaned_at FROM evimed_memory.history_chunks WHERE uri=$1',[chunk])).rows[0].cleaned_at);
  await app.store.database.query("UPDATE evimed_source_deletion.conversations SET next_attempt_at=NULL WHERE user_id=$1",[user.id]);
  const {ConversationSourceDeletionService}=await import('../src/conversationSourceDeletionService.mjs');
  const resumed=new ConversationSourceDeletionService({...app.sourceDeletion});
  crash=false;await resumed.drain();
  const status=(await (await fetch(target,{headers})).json()).data;
  assert.equal(status.cleanup,'complete',JSON.stringify(status));assert.equal(status.sourceRemoved,true);
  assert.equal(await context.sessions.read(user.id,uri),null);
  assert.equal(await context.sessions.read(user.id,other),'Independent space-named memory.');
});

test('conversation deletion follows exact one-shot remember copies even when only the tool extracted the memory',options,async t=>{
  const {app,base,headers,user,stub,engineUser}=await fixture(t),overlay=app.nativeMemory.overlay;
  const project=await app.store.requireProject(await app.store.userById(user.id),'default');
  const context=await app.nativeMemory.memoryContexts.forProject(project),text='Please remember locker F-25429.';
  app.memoryHistory.ledger.client=context.sessions.client;
  await context.sessions.register(user.id);
  const commits=[];
  for(const name of ['dsh-source','mcp-store-sourcecopy']) {
    stub.sessions.set(`${engineUser}/${name}`,{id:name,user:engineUser,archives:0,commitCount:0,messages:[{role:'user',parts:[{type:'text',text}]}]});
    const result=stub.commitSession(engineUser,name);
    commits.push(await overlay.recordCommit({userId:user.id,engineSession:name,archiveUri:result.archive_uri,projectId:'default',origin:name.startsWith('dsh-')?'gateway':'tool',state:'completed'}));
    await app.memoryHistory.ledger.registerWriteMessages(context,result.archive_uri,[text]);
  }
  const tool=commits[1],uri=stub.seedMemory(engineUser,'notes/tool-only.md',text,{type:'notes'});
  await overlay.upsertFile({userId:user.id,uri,memoryType:'notes',body:text});
  await overlay.addRevision({userId:user.id,uri,memoryType:'notes',change:'added',actor:'engine',after:text,engineSession:tool.engineSession,archiveUri:tool.archiveUri,projectId:'default'});
  await overlay.syncOrigins(user.id,uri,{after:text,origin:{engineSession:tool.engineSession,archiveUri:tool.archiveUri,projectId:'default'}});
  assert.equal(await overlay.conversationOf(user.id,tool.engineSession,tool.archiveUri),'source');
  app.runtimeManager.captureConversationSource=async()=>({root:{id:'source',createdAt:1,cwd:'/workspace',isSeeded:false},sessions:[{id:'source'}]});
  app.runtimeManager.purgeConversationSource=async()=>({sourceRemoved:true,removedSessionIds:['source']});
  assert.equal((await fetch(`${base}/api/projects/default/conversations/source/source`,{method:'DELETE',headers})).status,202);
  await app.sourceDeletion.drain();const status=await app.sourceDeletion.status(project,'source');
  assert.equal(status.cleanup,'complete',JSON.stringify(status));
  assert.equal(await context.sessions.read(user.id,uri),null);
  assert.equal(await context.sessions.read(user.id,`${tool.archiveUri}/messages.jsonl`),null);
  // A later independent restatement cannot inherit the deleted conversation's authority.
  let independent;
  for(const name of ['dsh-independent','mcp-store-independent']) {
    stub.sessions.set(`${engineUser}/${name}`,{id:name,user:engineUser,archives:0,commitCount:0,messages:[{role:'user',parts:[{type:'text',text}]}]});
    const result=stub.commitSession(engineUser,name);
    independent=await overlay.recordCommit({userId:user.id,engineSession:name,archiveUri:result.archive_uri,projectId:'default',origin:name.startsWith('dsh-')?'gateway':'tool',state:'completed'});
    await app.memoryHistory.ledger.registerWriteMessages(context,result.archive_uri,[text]);
  }
  assert.equal(await overlay.conversationOf(user.id,independent.engineSession,independent.archiveUri),'independent');
});

test('source deletion stays pending after the file is gone until summary maintenance is retried', options, async t => {
  const { app, base, headers, user, stub, engineUser } = await fixture(t);
  const project = await app.store.requireProject(await app.store.userById(user.id), 'default');
  const context = await app.nativeMemory.memoryContexts.forProject(project), overlay = app.nativeMemory.overlay;
  const marker = 'P19-STALE-SOURCE', uri = stub.seedMemory(engineUser, 'notes/deep/source.md', marker, { type: 'notes' });
  const archive = `${context.userRoot}/sessions/dsh-source/history/archive_001`;
  await overlay.upsertFile({ userId: user.id, uri, memoryType: 'notes', body: marker });
  await overlay.syncOrigins(user.id, uri, { after: marker, origin: { engineSession: 'dsh-source', archiveUri: archive, projectId: 'default' } });
  const root = context.sessions.memoryRoot(user.id);
  const directories = [`${root}/notes/deep`, `${root}/notes`, root];
  for (const directory of directories) {
    for (const name of ['.overview.md', '.abstract.md']) stub.files.set(`${directory}/${name}`, marker);
  }
  app.runtimeManager.captureConversationSource = async () => ({ root: { id: 'source', createdAt: 1, cwd: '/workspace', isSeeded: false }, sessions: [{ id: 'source' }], generation: 'synthetic-fixture' });
  app.runtimeManager.purgeConversationSource = async () => ({ sourceRemoved: true, removedSessionIds: ['source'] });
  const sessions = context.sessions;
  // Contexts are recreated on lookup, so fail the shared root client at the maintenance API.
  const client = sessions.rootClient, request = client.request.bind(client);
  let failed = true;
  client.request = async input => {
    if (failed && input.path === '/api/v1/content/reindex') throw Object.assign(new Error('engine unavailable'), { code: 'memory_index_unavailable' });
    return request(input);
  };
  const target = `${base}/api/projects/default/conversations/source/source`;
  assert.equal((await fetch(target, { method: 'DELETE', headers })).status, 202);
  await app.sourceDeletion.drain();
  assert.equal(await sessions.read(user.id, uri), null, 'the destructive operation already reached the engine');
  assert.equal((await app.sourceDeletion.status(project, 'source')).cleanup, 'pending');
  assert.ok((await overlay.pendingSummaryInvalidations(user.id)).length);
  failed = false;
  await app.store.database.query('UPDATE evimed_source_deletion.conversations SET next_attempt_at=NULL WHERE user_id=$1', [user.id]);
  const { ConversationSourceDeletionService } = await import('../src/conversationSourceDeletionService.mjs');
  await new ConversationSourceDeletionService({ ...app.sourceDeletion }).drain();
  assert.equal((await app.sourceDeletion.status(project, 'source')).cleanup, 'complete');
  assert.deepEqual(await overlay.pendingSummaryInvalidations(user.id), []);
  for (const directory of directories) for (const name of ['.overview.md', '.abstract.md']) assert.equal(stub.files.get(`${directory}/${name}`)?.includes(marker) ?? false, false);
});
