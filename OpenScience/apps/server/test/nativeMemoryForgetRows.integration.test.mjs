// Real PostgreSQL + store/history/undo/export; only the external engine and model are fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { NativeMemoryStore } from '../src/nativeMemoryStore.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { createRejectionJudge } from '../src/nativeMemoryRejections.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { createMemoryForgetReader } from '../src/memoryForgetPropagation.mjs';
import { createOfficialPromotion } from '../src/officialPromotion.mjs';

const {fixture,options} = nativeIntegration();
const fact = 'I swim each Wednesday evening.';
const restated = 'On Wednesday evenings I go swimming.';
const allergy = 'I am allergic to penicillin.';

async function wired(t) {
  const f = await fixture(t);
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Test',1048576)", [f.userId]);
  const project = {userId:f.userId,id:'default'};
  const contexts = new GeoNativeMemoryContext({database:f.database,documents:null,sessions:f.sessions,
    policies:{forProject:async()=>({kind:'owned'}),policiesForOwner:async()=>[]},settingsForOwner:id=>f.memorySettings.settings(id)});
  const context = await contexts.forProject(project);
  const judge = createRejectionJudge({config:{deepseekModel:'fixture',deepseekApiKey:'fixture'},callModel:async (_dependencies,request) => {
    const wire = JSON.parse(request.body.messages[1].content);
    return {choices:[{message:{content:JSON.stringify({same:wire.candidates.flatMap(candidate =>
      candidate.text === restated || candidate.text.includes(fact)
        ? [{candidate:candidate.candidate,removed:candidate.options[0],confidence:0.99}] : []),stated:[]})}}]};
  }});
  f.overlay.deferredSummaryRebuildEnabled = true;
  const ledger = new MemoryHistoryLedger({database:f.database,overlay:f.overlay,client:f.sessions.client});
  const history = new MemoryHistory({config:{memoryHistorySearchEnabled:true,memoryForgetTargetsEnabled:true},ledger,contexts,rejectionJudge:judge,
    resolveSource:async commit=>({projectId:'default',projectCreatedAt:context.projectCreatedAt,sessionId:commit.engineSession?.slice(4),conversationTitle:'Test'}),
    eligible:async()=>true,admitMessage:async()=>true});
  const store = new NativeMemoryStore({sessions:f.sessions,overlay:f.overlay,memoryContexts:contexts,rejectionJudge:judge,forgetTargetsEnabled:true});
  store.history = history;
  history.sweepMemory = scan => store.sweepForgottenMemory(scan);
  f.overlay.memoryForgetBody = (_owner,uri,body)=>history.fenceNativeBody(context,uri,body);
  return {...f,store,history,ledger,context,project};
}

for (const historyScan of [false, true]) test(`AL8c history settles while an independent memory sweep waits for its judge (history=${historyScan})`, options, async t => {
  const f = await wired(t);
  const statement = 'Project M-41633.', fingerprint = lineFingerprint(statement);
  const original = await f.commitConversation('sweep-history', [{role:'user',text:statement,at:'2026-01-01T00:00:00Z'}], {projectId:'default'});
  const ingest = archive => f.history.ingestArchive({userId:f.userId,projectId:'default',engineSession:archive.session,archiveUri:archive.archive_uri}, f.context);
  // This longer line is not an exact copy, so only the sweep judge may remove it.
  f.seed('notes/independent.md', `- ${statement} This project also has an independent safety constraint.`, {type:'notes'});
  f.store.rejectionJudge = { same: async () => { throw new Error('fixture judge unavailable'); } };
  await f.store.forget({id:f.userId}, f.project, null, {statement});
  const scans = async () => (await f.database.query('SELECT * FROM evimed_memory.history_forget_scans WHERE owner_id=$1', [f.userId])).rows;
  assert.equal((await scans())[0].history_scan, false, 'recorded archive fences do not create another history obligation');
  if (historyScan) await f.ledger.queueForgetScan(f.context, 'notes', fingerprint);
  await f.history.drainForgetScans();
  const pending = (await scans())[0];
  assert.equal(pending.state, 'pending');
  assert.equal(pending.history_scan, historyScan);
  assert.equal(pending.cursor, pending.archives.length, 'history progress commits even when the sweep fails');
  assert.equal(pending.attempts, 1);
  assert.ok(pending.next_attempt_at > new Date());
  assert.ok(pending.memory_sweep.candidates.length, 'the unavailable judge leaves real memory-file work pending');
  assert.equal(await f.ledger.forgetArchivePending(f.context, original.archive_uri), false);
  await ingest(original);
  const progress = (await f.database.query('SELECT state,reason,indexed_chunks FROM evimed_memory.history_archives WHERE owner_id=$1 AND archive_uri=$2', [f.userId,original.archive_uri])).rows;
  assert.deepEqual(progress, [{state:'partial',reason:'removed_content',indexed_chunks:0}]);
  await f.history.drainForgetScans();
  assert.equal((await scans())[0].attempts, 1, 'a pass with only backed-off sweep work returns without claiming it');
  const late = await f.commitConversation('sweep-late', [{role:'user',text:statement,at:'2026-01-02T00:00:00Z'}], {projectId:'default'});
  await ingest(late);
  assert.equal(await f.ledger.forgetArchivePending(f.context, late.archive_uri), historyScan,
    'only an independently owed history scan can fence late archive discovery');
  await f.store.undo(f.userId, (await f.store.forgotten(f.userId))[0].id);
  assert.deepEqual(await scans(), [], 'undo cancels both kinds of work');
});

test('AL8 statement removes profile and independently restated notes without origins; export excludes both and one undo restores both', options, async t => {
  const f = await wired(t);
  const profile = f.seed('profile.md', `- ${fact}\n- I prefer tea.`, {type:'profile'});
  const notes = f.seed('notes/independent.md', `- ${restated}\n- ${allergy}`, {type:'notes'});
  await f.store.files(f.userId);
  assert.equal((await f.overlay.originsOf(f.userId,[profile,notes])).size, 0);
  const result = await f.store.forget({id:f.userId},f.project,null,{statement:fact});
  assert.equal(result.historyScanPending,true);
  assert.doesNotMatch(await f.sessions.read(f.userId,profile), /Wednesday/);
  await f.history.drainForgetScans();
  assert.equal(await f.sessions.read(f.userId,profile), '- I prefer tea.');
  assert.equal(await f.sessions.read(f.userId,notes), `- ${allergy}`);
  assert.deepEqual(await f.ledger.pendingForgetScans(f.userId), []);
  const archive = unzipSync(await f.store.exportPack(f.userId));
  const exported = Object.values(archive).map(bytes=>Buffer.from(bytes).toString()).join('\n');
  assert.doesNotMatch(exported,/Wednesday|swim/);
  assert.match(exported,/prefer tea|allergic to penicillin/);
  const forgotten = await f.store.forgotten(f.userId);
  await f.store.undo(f.userId,forgotten[0].id);
  assert.match(await f.sessions.read(f.userId,profile), /Wednesday/);
  assert.match(await f.sessions.read(f.userId,notes), /Wednesday/);
  assert.deepEqual(await f.overlay.removals(f.userId), []);
});

for (const mode of ['lines','statement']) test(`AL8 an imported memory is reachable by ${mode} forget and the independent sweep`, options, async t => {
  const f = await wired(t);
  const uri = `${f.root}/notes/imported.md`;
  f.stub.extract = () => ({adds:[{uri,after:`- ${fact}\n- ${allergy}`}]});
  await f.store.rememberImport(f.userId,{ordinary:[fact,allergy]});
  await f.worker.processCommits({userId:f.userId});
  f.seed('notes/independent.md',`- ${restated}`,{type:'notes'});
  await f.store.forget({id:f.userId},f.project,mode === 'lines' ? uri : null,
    mode === 'lines' ? {lines:[fact],engineSession:'dsh-active'} : {statement:fact});
  await f.history.drainForgetScans();
  assert.equal(await f.sessions.read(f.userId,uri), `- ${allergy}`);
  assert.equal(await f.sessions.read(f.userId,`${f.root}/notes/independent.md`),null);
  const forgotten = await f.store.forgotten(f.userId);
  assert.ok(forgotten.some(row=>row.value.includes(fact)), 'an attended line removal keeps its undo receipt');
  await f.store.undo(f.userId,forgotten.find(row=>row.value.includes(restated)).id);
  assert.match(await f.sessions.read(f.userId,uri), /Wednesday/);
  assert.match(await f.sessions.read(f.userId,`${f.root}/notes/independent.md`), /Wednesday/);
});

test('AL8 withdrawn private method creates anonymous review on its official copy through the actual reader', options, async t => {
  const f = await wired(t), publisher = await fixture(t);
  const documents = new ProductDocuments(f.database);
  const source = await f.commitConversation('method-source',[{role:'user',text:fact}],{projectId:'default'});
  await f.history.ingestArchive({userId:f.userId,projectId:'default',engineSession:source.session,archiveUri:source.archive_uri},f.context);
  const digest = 'sha256:source-method';
  await documents.put(f.userId,'method','private',{body:'A general de-identified procedure',contentDigest:digest,status:'approved',
    provenance:{sourceProjectId:'default',archiveUri:source.archive_uri}},{expectedRevision:0});
  documents.memoryForgetReader = createMemoryForgetReader({context:async()=>f.context,hasWithdrawals:scope=>f.ledger.hasWithdrawals(scope),
    rejected:(scope,texts)=>f.ledger.rejected(scope,texts),sourcesRejected:(scope,refs)=>f.ledger.derivedSourcesRejected(scope,refs),
    conversationsDeleted:scope=>f.ledger.conversationsDeleted(scope),resolveRun:async()=>null,resolveMethod:async()=>null});
  const id = `official-promoted-${createHash('sha256').update(JSON.stringify([f.userId,f.context.ownerCreatedAt,'private',digest])).digest('hex').slice(0,32)}`;
  await documents.put(publisher.userId,'preferences',id,{recordType:'official-promoted',status:'active',method:{sha:'public',body:'General procedure'}},{expectedRevision:0});
  const promotion = createOfficialPromotion({documents,officialPacks:{publisherId:publisher.userId,publishAll:async()=>[]},
    facts:async()=>({}),judge:async()=>{assert.fail('no provider call');},established:async()=>new Set()});
  await f.store.forget({id:f.userId},f.project,null,{statement:fact});
  assert.equal(await documents.get(f.userId,'method','private'),null);
  await promotion.tick();
  const reviewed = await documents.get(publisher.userId,'preferences',id);
  assert.equal(reviewed.payload.status,'active');
  assert.equal(reviewed.payload.pendingRetirements[0].reason,'source_withdrawn');
  assert.doesNotMatch(JSON.stringify(reviewed.payload.pendingRetirements), /Wednesday|swim|private|nm_/);
});
