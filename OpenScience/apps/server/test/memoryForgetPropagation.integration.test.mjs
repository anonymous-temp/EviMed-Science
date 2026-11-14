// Real PostgreSQL rejection -> history -> native/capsule/method readers. Only the external engine is a fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { withAccountExportSnapshot } from '../src/accountExport.mjs';
import { CapsuleService } from '../src/capsuleService.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { NativeMemoryStore } from '../src/nativeMemoryStore.mjs';
import { createMemoryForgetReader } from '../src/memoryForgetPropagation.mjs';

const { fixture, options } = nativeIntegration();
test('statement forget withdraws three existing derived stores and their alternate readers; undo restores them', options, async t => {
  const f = await fixture(t), statement = 'My old project is M-41633.';
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Test',1048576)", [f.userId]);
  const project = {userId:f.userId,id:'default'};
  const contexts = new GeoNativeMemoryContext({database:f.database,documents:null,sessions:f.sessions,
    policies:{forProject:async()=>({kind:'owned'}),policiesForOwner:async()=>[]},settingsForOwner:id=>f.memorySettings.settings(id)});
  const context = await contexts.forProject(project);
  const ledger = new MemoryHistoryLedger({database:f.database,overlay:f.overlay,client:f.sessions.client});
  const history = new MemoryHistory({config:{...f.config,memoryHistorySearchEnabled:true},ledger,contexts,
    resolveSource:async commit=>({projectId:'default',projectCreatedAt:context.projectCreatedAt,sessionId:commit.engineSession?.slice(4),conversationTitle:'Test'}),
    eligible:async()=>true,admitMessage:async()=>true});
  const store = new NativeMemoryStore({sessions:f.sessions,overlay:f.overlay,memoryContexts:contexts,forgetTargetsEnabled:true});
  store.history = history;
  const archive = await f.commitConversation('propagation',[{role:'user',text:statement}],{projectId:'default'});
  await history.ingestArchive({userId:f.userId,projectId:'default',engineSession:archive.session,archiveUri:archive.archive_uri},context);
  const recallHistory = () => history.search({user:{id:f.userId},project,query:'M-41633',limit:5});
  assert.match(JSON.stringify(await recallHistory()),/M-41633/);
  f.seed('notes/propagation.md',statement,{type:'notes'});
  await store.files(f.userId); // Warm the native body cache before the withdrawal.
  const documents = new ProductDocuments(f.database), capsules = new CapsuleService(documents);
  const capsule = await capsules.ownCapsule(f.userId,{create:true});
  await capsules.addEntry(f.userId,capsule.id,{factKind:'preference',layer:'knowledge',content:statement,origin:'explicit',status:'approved'});
  await documents.put(f.userId,'method','propagated-method',{status:'approved',body:'A paraphrased procedure without the original wording',
    provenance:{sourceProjectId:'default',archiveUri:archive.archive_uri}},{expectedRevision:0});
  const allowed = createMemoryForgetReader({context:async()=>context,rejected:(scope,texts)=>ledger.rejected(scope,texts),
    sourcesRejected:(scope,refs)=>ledger.derivedSourcesRejected(scope,refs),resolveRun:async()=>null,
    resolveMethod:async(_user,id)=>(await f.database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='method' AND id=$2",[f.userId,id])).rows[0]??null});
  documents.memoryForgetReader = allowed;
  f.overlay.memoryForgetBody = (userId,fileUri,body)=>history.fenceNativeBody(context,fileUri,body);
  assert.equal((await capsules.profileFacts(f.userId,'default',['preference'])).length,1);
  assert.ok(await documents.get(f.userId,'method','propagated-method'));
  await store.forget({id:f.userId},project,null,{statement});
  assert.deepEqual(await recallHistory(),[]);
  assert.doesNotMatch(JSON.stringify(await store.files(f.userId)),/M-41633/);
  assert.deepEqual(await capsules.profileFacts(f.userId,'default',['preference']),[]);
  assert.deepEqual((await capsules.recall(f.userId,{query:'M-41633',projectId:'default'})).items,[]);
  assert.equal(await documents.get(f.userId,'method','propagated-method'),null);
  assert.deepEqual((await documents.list(f.userId,'method',{fields:{status:true}})).items,[],'a projection cannot drop the source dependency before checking it');
  assert.deepEqual(await documents.history(f.userId,'method','propagated-method'),[]);
  assert.deepEqual(await documents.search(f.userId,'fact','M-41633'),[]);
  const identity = (await f.database.query('SELECT created_at::text AS "accountCreatedAt" FROM evimed_control.users WHERE id=$1',[f.userId])).rows[0];
  const exported = await withAccountExportSnapshot(f.database,{id:f.userId,...identity},f.config,async snapshot=>JSON.parse(snapshot.data.toString()),
    {memoryForgetReader:allowed,nativeMemory:{contexts}});
  assert.doesNotMatch(JSON.stringify(exported.documents),/M-41633|A paraphrased procedure/);
  assert.doesNotMatch(JSON.stringify(exported.revisions),/M-41633|A paraphrased procedure/);
  const forgotten = await store.forgotten(f.userId);
  await store.undo(f.userId,forgotten[0].id);
  assert.match(JSON.stringify(await store.files(f.userId)),/M-41633/);
  assert.equal((await capsules.profileFacts(f.userId,'default',['preference'])).length,1);
  assert.ok(await documents.get(f.userId,'method','propagated-method'));
});

// FT12: withdrawal is exactly as wide as its evidence. A conversation that also said other things is not withdrawn
// by a statement forget of one remark; deleting that source conversation still withdraws everything derived from it.
test('FT12 a statement forget leaves derived records of the same conversation that do not say it; deleting the conversation withdraws them', options, async t => {
  const f = await fixture(t), statement = 'My old project is M-41633.', allergy = 'I am allergic to penicillin.';
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Test',1048576)", [f.userId]);
  const project = {userId:f.userId,id:'default'};
  const contexts = new GeoNativeMemoryContext({database:f.database,documents:null,sessions:f.sessions,
    policies:{forProject:async()=>({kind:'owned'}),policiesForOwner:async()=>[]},settingsForOwner:id=>f.memorySettings.settings(id)});
  const context = {...await contexts.forProject(project), projectId:'default'};
  const ledger = new MemoryHistoryLedger({database:f.database,overlay:f.overlay,client:f.sessions.client});
  const history = new MemoryHistory({config:{...f.config,memoryHistorySearchEnabled:true},ledger,contexts,
    resolveSource:async commit=>({projectId:'default',projectCreatedAt:context.projectCreatedAt,sessionId:commit.engineSession?.slice(4),conversationTitle:'Test'}),
    eligible:async()=>true,admitMessage:async()=>true});
  const store = new NativeMemoryStore({sessions:f.sessions,overlay:f.overlay,memoryContexts:contexts,forgetTargetsEnabled:true});
  store.history = history;
  const archive = await f.commitConversation('mixed',[{role:'user',text:statement},{role:'user',text:allergy}],{projectId:'default'});
  await history.ingestArchive({userId:f.userId,projectId:'default',engineSession:archive.session,archiveUri:archive.archive_uri},context);
  const uri = f.seed('notes/mixed.md',`- ${statement}\n- ${allergy}`,{type:'notes'});
  await f.overlay.syncOrigins(f.userId,uri,{after:`- ${statement}\n- ${allergy}`,origin:{archiveUri:archive.archive_uri,engineSession:archive.session,projectId:'default'}});
  const documents = new ProductDocuments(f.database), capsules = new CapsuleService(documents);
  const capsule = await capsules.ownCapsule(f.userId,{create:true});
  await capsules.addEntry(f.userId,capsule.id,{factKind:'preference',layer:'knowledge',content:allergy,origin:'explicit',status:'approved'});
  await capsules.addEntry(f.userId,capsule.id,{factKind:'preference',layer:'knowledge',content:statement,origin:'explicit',status:'approved'});
  await documents.put(f.userId,'method','mixed-method',{status:'approved',body:'A paraphrased procedure without the original wording',
    provenance:{sourceProjectId:'default',archiveUri:archive.archive_uri}},{expectedRevision:0});
  documents.memoryForgetReader = createMemoryForgetReader({context:async()=>context,hasWithdrawals:scope=>ledger.hasWithdrawals(scope),
    rejected:(scope,texts)=>ledger.rejected(scope,texts),sourcesRejected:(scope,refs)=>ledger.derivedSourcesRejected(scope,refs),
    conversationsDeleted:scope=>ledger.conversationsDeleted(scope),resolveRun:async()=>null,resolveMethod:async()=>null});
  f.overlay.memoryForgetBody = (_userId,fileUri,body)=>history.fenceNativeBody(context,fileUri,body);
  await store.forget({id:f.userId},project,null,{statement});
  const facts = JSON.stringify(await capsules.profileFacts(f.userId,'default',['preference']));
  assert.match(facts,/allergic to penicillin/);
  assert.doesNotMatch(facts,/M-41633/);
  assert.ok(await documents.get(f.userId,'method','mixed-method'),'the conversation also said other things: no evidence the method depends on the remark');
  const native = JSON.stringify(await store.files(f.userId));
  assert.match(native,/allergic to penicillin/);
  assert.doesNotMatch(native,/M-41633/);
  await history.removeConversation(context,archive.session.slice(4));
  assert.equal(await documents.get(f.userId,'method','mixed-method'),null,'the person deleted the whole source');
  assert.doesNotMatch(JSON.stringify(await capsules.profileFacts(f.userId,'default',['preference'])),/M-41633/);
  assert.doesNotMatch(JSON.stringify(await store.files(f.userId)),/allergic to penicillin|M-41633/,'the native line from the deleted conversation goes too');
});
