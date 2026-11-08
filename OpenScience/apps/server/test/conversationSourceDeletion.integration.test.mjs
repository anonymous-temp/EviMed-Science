import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { ConversationSourceDeletionLedger } from '../src/conversationSourceDeletionPersistence.mjs';
const native=nativeIntegration(),options=native.options;
async function fixture(...args){const f=await native.fixture(...args);await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Source fixture',1048576)",[f.userId]);return {...f,projectCreatedAt:(await f.database.query("SELECT created_at::text AS stamp FROM evimed_control.projects WHERE user_id=$1 AND id='default'",[f.userId])).rows[0].stamp};}

test('source cleanup removes only its attributed memory lines, scrubs undo history and preserves unrelated bytes', options, async t => {
  const f=await fixture(t), uri=`${f.root}/profile.md`, body='# Profile\n- Source A preference.\n- Independent B preference.';
  f.seed('profile.md',body,{type:'profile'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'profile',body});
  const a=await f.overlay.addRevision({userId:f.userId,uri,memoryType:'profile',change:'added',actor:'engine',after:'# Profile\n- Source A preference.',engineSession:'dsh-a',archiveUri:`viking://user/${f.engineUser}/sessions/dsh-a/history/archive_001`,projectId:'default'});
  await f.overlay.syncOrigins(f.userId,uri,{before:'',after:'# Profile\n- Source A preference.',origin:{revisionId:a.id,engineSession:'dsh-a',projectId:'default'}});
  await f.overlay.syncOrigins(f.userId,uri,{before:'# Profile\n- Source A preference.',after:body,origin:{engineSession:'dsh-b',projectId:'default'}});
  const result=await f.store.removeConversationSource(f.userId,'default',['a']);
  assert.ok(result.length>0);
  assert.equal(await f.sessions.read(f.userId,uri),'# Profile\n- Independent B preference.');
  assert.ok((await f.overlay.revisionsOf(f.userId,uri)).every(row=>![row.before,row.after].filter(Boolean).some(text=>text.includes('Source A preference.'))));
});

test('durable deletion intents have no owner cascade and cannot delete a reused project identity', options, async t => {
  const f=await fixture(t), ledger=new ConversationSourceDeletionLedger(f.database);
  await ledger.migrate();
  const row={id:crypto.randomUUID(),userId:f.userId,projectId:'default',accountCreatedAt:'2026-01-01T00:00:00Z',projectCreatedAt:'2026-01-01T00:00:00Z',rootSessionId:'a',sessionIds:['a'],frozen:{root:{id:'a'}}};
  await ledger.put(row);
  await f.database.query('DELETE FROM evimed_control.users WHERE id=$1',[f.userId]);
  assert.ok((await ledger.pending()).some(r=>r.id===row.id));
  await assert.rejects(ledger.assertIdentity(row),{status:404});
});

test('a replay of the deleted source retains its source fence and cannot leave source lines or replay work behind', options, async t => {
  const f=await fixture(t), original=await f.commitConversation('a',[{role:'user',text:'Private source.'}],{projectId:'default'});
  const replay=await f.commitConversation('replay',[{role:'user',text:'Private source.'}],{projectId:'default',engineSession:'evimed-replay-source'});
  await f.overlay.markReplayed(f.userId,original.archive_uri,replay.archive_uri);
  const uri=f.seed('profile.md','# Profile\n- Private replay preference.',{type:'profile'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'profile',body:'# Profile\n- Private replay preference.'});
  await f.overlay.syncOrigins(f.userId,uri,{before:'',after:'# Profile\n- Private replay preference.',origin:{engineSession:replay.session,archiveUri:replay.archive_uri,projectId:'default'}});
  const ledger=new ConversationSourceDeletionLedger(f.database);
  const ownerStamp=(await f.database.query('SELECT created_at::text AS stamp FROM evimed_control.users WHERE id=$1',[f.userId])).rows[0].stamp;
  await ledger.put({id:crypto.randomUUID(),userId:f.userId,projectId:'default',accountCreatedAt:ownerStamp,projectCreatedAt:f.projectCreatedAt,rootSessionId:'session_a',sessionIds:['session_a'],frozen:{root:{id:'session_a'}},memoryUserRoot:f.sessions.userRoot(f.userId)});
  assert.ok((await ledger.hiddenMemoryUris(f.userId)).includes(uri));
  await f.store.removeConversationSource(f.userId,'default',['session_a']);
  assert.equal(await f.sessions.read(f.userId,uri),null);
  assert.equal((await f.overlay.commit(f.userId,replay.archive_uri)).state,'abandoned');
});

test('the native worker checks a source tombstone before recreating a failed archive as a replay', options, async t => {
  const f=await fixture(t), archive=await f.commitConversation('a',[{role:'user',text:'Private old source.'}],{projectId:'default'});
  await f.overlay.failCommit(f.userId,archive.archive_uri,{error:'synthetic failure',nextAttemptAt:f.now()});
  f.overlay.sourceDeletion={ledger:{get:async(_project,sessionId)=>sessionId==='session_a'?{cleanup:'pending'}:null}};
  const before=f.stub.sessions.size;
  await f.worker.processCommits({userId:f.userId});
  assert.equal((await f.overlay.commit(f.userId,archive.archive_uri)).state,'abandoned');
  assert.equal(f.stub.sessions.size,before);
});

test('worker-ingested ordinary profile and preferences retain source authority while their display project remains null', options, async t => {
  const f=await fixture(t,{extract:({user})=>({adds:[{uri:`viking://user/${user}/memories/profile.md`,memory_type:'profile',after:'# Profile\n- Ordinary profile source.'},{uri:`viking://user/${user}/memories/preferences/source.md`,memory_type:'preferences',after:'# Preferences\n- Ordinary preference source.'}]})});
  const archive=await f.commitConversation('a',[{role:'user',text:'Use ordinary profile and preference sources.'}],{projectId:'default'});
  await f.worker.processCommits({userId:f.userId});
  const profile=`${f.root}/profile.md`, preference=`${f.root}/preferences/source.md`;
  assert.equal((await f.overlay.file(f.userId,profile)).projectId,null);
  const ledger=new ConversationSourceDeletionLedger(f.database), stamp=(await f.database.query('SELECT created_at::text AS stamp FROM evimed_control.users WHERE id=$1',[f.userId])).rows[0].stamp;
  await ledger.put({id:crypto.randomUUID(),userId:f.userId,projectId:'default',accountCreatedAt:stamp,projectCreatedAt:f.projectCreatedAt,rootSessionId:'session_a',sessionIds:['session_a'],frozen:{root:{id:'session_a'}},memoryUserRoot:f.sessions.userRoot(f.userId)});
  assert.deepEqual(new Set(await ledger.hiddenMemoryUris(f.userId)),new Set([profile,preference]));
  await f.store.removeConversationSource(f.userId,'default',['session_a']);
  assert.equal(await f.sessions.read(f.userId,profile),null);assert.equal(await f.sessions.read(f.userId,preference),null);
  assert.equal((await f.overlay.commit(f.userId,archive.archive_uri)).state,'abandoned');
});

test('deleted source history is scrubbed after another source replaces the current line', options, async t => {
  const f=await fixture(t), uri=f.seed('profile.md','# Profile\n- Independent current B.',{type:'profile'});
  const a=await f.commitConversation('a',[{role:'user',text:'Old source A.'}],{projectId:'default'});
  await f.overlay.addRevision({userId:f.userId,uri,memoryType:'profile',change:'added',actor:'engine',after:'# Profile\n- Private historical A.',engineSession:a.session,archiveUri:a.archive_uri,projectId:null});
  await f.overlay.addRevision({userId:f.userId,uri,memoryType:'profile',change:'updated',actor:'engine',before:'# Profile\n- Private historical A.',after:'# Profile\n- Independent current B.',engineSession:'dsh-b',projectId:null});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'profile',body:'# Profile\n- Independent current B.'});
  await f.overlay.syncOrigins(f.userId,uri,{before:'',after:'# Profile\n- Independent current B.',origin:{engineSession:'dsh-b',projectId:'default'}});
  await f.store.removeConversationSource(f.userId,'default',['session_a']);
  assert.equal(await f.sessions.read(f.userId,uri),'# Profile\n- Independent current B.');
  assert.ok((await f.overlay.revisionsOf(f.userId,uri)).every(row=>![row.before,row.after].filter(Boolean).some(text=>text.includes('Private historical A.'))));
});

import { withNativeMemoryWrite } from '../src/nativeMemoryWriteFence.mjs';
test('account-native exclusion defers same-owner writers while preserving independent owners and resumes after cleanup',options,async t=>{
  const f=await fixture(t);let release,entered;
  const waiting=new Promise(resolve=>release=resolve), inside=new Promise(resolve=>entered=resolve);
  const exclusive=withNativeMemoryWrite(f.database,f.userId,async()=>{entered();await waiting;},{exclusive:true});
  await inside;
  await assert.rejects(withNativeMemoryWrite(f.database,f.userId,async()=>assert.fail('must not write')),{code:'memory_source_cleanup_busy'});
  assert.equal(await withNativeMemoryWrite(f.database,'independent-owner',async()=>true),true);
  release();await exclusive;assert.equal(await withNativeMemoryWrite(f.database,f.userId,async()=>true),true);
});

test('a changed mixed body is deferred and retried without overwriting a concurrent independent addition',options,async t=>{
  const f=await fixture(t),uri=f.seed('profile.md','# Profile\n- Source A.\n- Independent B.',{type:'profile'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'profile',body:'# Profile\n- Source A.\n- Independent B.'});
  await f.overlay.syncOrigins(f.userId,uri,{after:'# Profile\n- Source A.\n- Independent B.',origin:{engineSession:'dsh-a',projectId:'default'}});
  const rawFiles=f.store.rawFiles.bind(f.store);let changed=false;
  f.store.rawFiles=async(...args)=>{const files=await rawFiles(...args);if(!changed){changed=true;await f.sessions.replace(f.userId,uri,'# Profile\n- Source A.\n- Independent B.\n- Independent C.');}return files;};
  await assert.rejects(f.store.removeConversationSource(f.userId,'default',['a']),{code:'memory_source_body_changed'});
  assert.match(await f.sessions.read(f.userId,uri),/Independent C/);
});

test('a source version restored by an earlier ordinary undo is still removed after its origin row was pruned',options,async t=>{
  const f=await fixture(t),uri=f.seed('profile.md','# Profile\n- Source A restored.',{type:'profile'}),archive=await f.commitConversation('a',[{role:'user',text:'Source A restored.'}],{projectId:'default'});
  await f.overlay.addRevision({userId:f.userId,uri,memoryType:'profile',change:'added',actor:'engine',after:'# Profile\n- Source A restored.',engineSession:archive.session,archiveUri:archive.archive_uri,projectId:null});
  await f.overlay.addRevision({userId:f.userId,uri,memoryType:'profile',change:'restored',actor:'user',after:'# Profile\n- Source A restored.',reason:'undo',projectId:null});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'profile',body:'# Profile\n- Source A restored.'});
  await f.store.removeConversationSource(f.userId,'default',['session_a']);
  assert.equal(await f.sessions.read(f.userId,uri),null);
});

test('a consolidation that rewrites source text without lineage defers native cleanup instead of claiming semantic erasure',options,async t=>{
  const f=await fixture(t,{extract:({user})=>({adds:[{uri:`viking://user/${user}/memories/preferences/source.md`,memory_type:'preferences',after:'Original private A fact.'}]})});
  await f.commitConversation('a',[{role:'user',text:'Original private A fact.'}],{projectId:'default'});await f.worker.processCommits({userId:f.userId});
  const uri=`${f.root}/preferences/source.md`;
  await f.sessions.replace(f.userId,uri,'A reworded private fact with independent B.');
  await f.worker.ingestConsolidation(f.userId,{taskId:'synthetic-consolidation-task',updates:[uri]});
  await assert.rejects(f.store.removeConversationSource(f.userId,'default',['session_a']),{code:'memory_source_lineage_unverified'});
  assert.equal(await f.sessions.read(f.userId,uri),'A reworded private fact with independent B.');
});

test('interleaved native extraction diffs attribute only their own additions before source cleanup',options,async t=>{
  const f=await fixture(t,{extract:({user,session})=>session.endsWith('_a')?{adds:[{uri:`viking://user/${user}/memories/profile.md`,memory_type:'profile',after:'# Profile\n- Source A.'}]}:{updates:[{uri:`viking://user/${user}/memories/profile.md`,memory_type:'profile',before:'# Profile\n- Source A.',after:'# Profile\n- Source A.\n- Independent C.'}]}});
  await f.commitConversation('a',[{role:'user',text:'Source A.'}],{projectId:'default'});await f.commitConversation('b',[{role:'user',text:'Independent C.'}],{projectId:'default'});
  await f.worker.processCommits({userId:f.userId});const uri=`${f.root}/profile.md`,origins=await f.overlay.originsOf(f.userId,[uri]);
  assert.equal(origins.get(uri).get((await import('../src/nativeMemoryOverlay.mjs')).lineFingerprint('Independent C.')).engineSession,'dsh-session_b');
  await f.store.removeConversationSource(f.userId,'default',['session_a']);assert.equal(await f.sessions.read(f.userId,uri),'# Profile\n- Independent C.');
});

test('native source cleanup refuses a cross-incarnation raw session alias before touching retained files',options,async t=>{
  const f=await fixture(t),source=await f.commitConversation('a',[{role:'user',text:'Replacement source.'}],{projectId:'default'}),prior=f.projectCreatedAt;
  await f.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id='default'",[f.userId]);
  const replacement=(await f.database.query("SELECT created_at::text AS stamp FROM evimed_control.projects WHERE user_id=$1 AND id='default'",[f.userId])).rows[0].stamp;
  await f.database.query('UPDATE evimed_memory.native_commits SET project_created_at=$2 WHERE user_id=$1',[f.userId,replacement]);
  await assert.rejects(f.store.removeConversationSource(f.userId,'default',['session_a'],{projectCreatedAt:prior}),{code:'memory_source_lineage_unverified'});
  assert.ok(f.stub.sessions.has(`${f.engineUser}/${source.session}`));
  assert.equal((await f.overlay.commit(f.userId,source.archive_uri)).state,'pending');
});

test('a new source never deletes a retained legacy personal origin with an unproved project incarnation',options,async t=>{
  const f=await fixture(t),uri=f.seed('profile.md','# Profile\n- Historical independent preference.',{type:'profile'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'profile',body:'# Profile\n- Historical independent preference.'});
  await f.overlay.syncOrigins(f.userId,uri,{after:'# Profile\n- Historical independent preference.',origin:{engineSession:'dsh-same',projectId:'default',projectCreatedAt:null,at:'2020-01-01T00:00:00Z'}});
  await assert.rejects(f.store.removeConversationSource(f.userId,'default',['same'],{projectCreatedAt:f.projectCreatedAt}),{code:'memory_source_lineage_unverified'});
  assert.equal(await f.sessions.read(f.userId,uri),'# Profile\n- Historical independent preference.');
});

test('an old exact-epoch failed native archive remains source-deleted after its project is replaced',options,async t=>{
  const f=await fixture(t),archive=await f.commitConversation('a',[{role:'user',text:'Old source.'}],{projectId:'default'}),ledger=new ConversationSourceDeletionLedger(f.database);
  const owner=(await f.database.query('SELECT created_at::text AS stamp FROM evimed_control.users WHERE id=$1',[f.userId])).rows[0].stamp;
  await ledger.put({id:crypto.randomUUID(),userId:f.userId,projectId:'default',accountCreatedAt:owner,projectCreatedAt:f.projectCreatedAt,rootSessionId:'session_a',sessionIds:['session_a'],frozen:{root:{id:'session_a'}},memoryUserRoot:f.sessions.userRoot(f.userId)});
  await f.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id='default'",[f.userId]);
  await f.overlay.failCommit(f.userId,archive.archive_uri,{error:'synthetic failure',nextAttemptAt:f.now()});f.overlay.sourceDeletion={ledger};
  const before=f.stub.sessions.size;await f.worker.processCommits({userId:f.userId});
  assert.equal((await f.overlay.commit(f.userId,archive.archive_uri)).state,'abandoned');assert.equal(f.stub.sessions.size,before);
  assert.equal(await f.overlay.projectEpochOfSession(f.userId,archive.session),null,'a retained old binding is not a current archive authority');
});

test('a completed native diff arriving behind its source fence records cleanup lineage without replay or normal learning',options,async t=>{
  const f=await fixture(t,{extract:({user})=>({adds:[{uri:`viking://user/${user}/memories/preferences/source.md`,memory_type:'preferences',after:'Private source A.'}]})}),source=await f.commitConversation('a',[{role:'user',text:'Private source A.'}],{projectId:'default'}),ledger=new ConversationSourceDeletionLedger(f.database);
  const owner=(await f.database.query('SELECT created_at::text AS stamp FROM evimed_control.users WHERE id=$1',[f.userId])).rows[0].stamp;
  await ledger.put({id:crypto.randomUUID(),userId:f.userId,projectId:'default',accountCreatedAt:owner,projectCreatedAt:f.projectCreatedAt,rootSessionId:'session_a',sessionIds:['session_a'],frozen:{root:{id:'session_a'}},memoryUserRoot:f.sessions.userRoot(f.userId)});f.overlay.sourceDeletion={ledger,redactRevisions:async(_user,rows)=>rows};
  f.worker.observations={promote:async()=>assert.fail('deleted sources cannot promote learning')};f.worker.history={ingestArchive:async()=>assert.fail('deleted source cannot reindex history')};
  await f.worker.processCommits({userId:f.userId});const settled=await f.overlay.commit(f.userId,source.archive_uri);
  assert.equal(settled.state,'abandoned');assert.ok(settled.nativeIngestedAt);assert.equal(await f.overlay.hasUnprovenNativeWrites(f.userId),false);
  await f.store.removeConversationSource(f.userId,'default',['session_a'],{projectCreatedAt:f.projectCreatedAt});
  assert.equal(await f.sessions.read(f.userId,`${f.root}/preferences/source.md`),null);
});

test('empty SQL receipts do not prove an uncommitted native source session absent',options,async t=>{
  const f=await fixture(t);await f.sessions.createSession(f.userId,'dsh-unrecorded');await f.sessions.addMessage(f.userId,'dsh-unrecorded',{role:'user',content:'Uncommitted private source.'});
  await assert.rejects(f.store.removeConversationSource(f.userId,'default',['unrecorded'],{projectCreatedAt:f.projectCreatedAt}),{code:'memory_source_lineage_unverified'});
  assert.ok(f.stub.sessions.has(`${f.engineUser}/dsh-unrecorded`));
});

test('cleanup-only native ingestion refuses an update without an exact typed before-image',options,async t=>{
  const f=await fixture(t),source=await f.commitConversation('a',[{role:'user',text:'Source A.'}],{projectId:'default'}),commit=await f.overlay.commit(f.userId,source.archive_uri),uri=f.seed('preferences/source.md','Independent B.\nSource A.',{type:'preferences'});
  const malformed={archive_uri:source.archive_uri,operations:{adds:[],updates:[{uri,memory_type:'preferences',after:'Independent B.\nSource A.'}],deletes:[]}};
  await assert.rejects(f.worker.ingest(commit,malformed,{sourceDeleted:true}),{code:'memory_source_lineage_unverified'});
  assert.equal((await f.overlay.originsOf(f.userId,[uri])).get(uri),undefined);assert.equal(await f.sessions.read(f.userId,uri),'Independent B.\nSource A.');
});

import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMemoryGatewayHandler, MEMORY_GATEWAY_PATH } from '../src/memoryGateway.mjs';
test('the real memory gateway rejects a cross-project uncommitted native alias before writing its bytes',options,async t=>{
  const f=await fixture(t);await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'other','Other source',1048576)",[f.userId]);
  await f.database.query("UPDATE evimed_control.projects SET created_at=(SELECT created_at FROM evimed_control.projects WHERE user_id=$1 AND id='default') WHERE user_id=$1 AND id='other'",[f.userId]);
  const handler=createMemoryGatewayHandler({config:{memoryEngineEnabled:true,memoryEnabled:true},runtimeManager:{assertActiveEviMedWorkloadToken:async token=>({userId:f.userId,projectId:token})},
    store:{userById:async()=>({id:f.userId}),requireProject:async(_user,id)=>({userId:f.userId,id,name:id,projectCreatedAt:(await f.database.query('SELECT created_at::text AS stamp FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[f.userId,id])).rows[0].stamp})},sessions:f.sessions,overlay:f.overlay,admission:{admit:async()=>({learn:true,recall:true,sessionId:'same'})}});
  const server=createServer((req,res)=>{void handler(req,res,()=>{});});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}${MEMORY_GATEWAY_PATH}`,write=project=>fetch(`${base}/api/v1/sessions/dsh-same/messages`,{method:'POST',headers:{authorization:`Bearer ${project}`,'content-type':'application/json'},body:JSON.stringify({role:'user',content:`Private ${project} bytes.`})});
  assert.equal((await write('default')).status,200);
  await f.overlay.purgeUser(f.userId);await f.sessions.deleteSession(f.userId,'dsh-same');
  assert.equal((await write('default')).status,200);
  assert.equal((await f.database.query('SELECT 1 FROM evimed_memory.native_sessions WHERE user_id=$1 AND engine_session=$2',[f.userId,'dsh-same'])).rows.length,1,'an unchanged project scope re-registers its source after reset');
  assert.equal((await write('other')).status,403);
  assert.equal((await fetch(`${base}/api/v1/sessions/dsh-same`,{headers:{authorization:'Bearer other'}})).status,403,'a foreign project cannot inspect the other native session metadata');
  assert.equal((await fetch(`${base}/api/v1/sessions/dsh-same/commit`,{method:'POST',headers:{authorization:'Bearer other','content-type':'application/json'},body:'{}'})).status,403);
  assert.equal(f.stub.sessions.get(`${f.engineUser}/dsh-same`).messages.length,1);
  assert.equal(await f.overlay.projectOfSession(f.userId,'dsh-same'),'default');
});

test('the native owner fence spans gateway admission through binding and final client effects',options,async t=>{
  const f=await fixture(t);let release,entered,touched=false;
  const gate=new Promise(resolve=>release=resolve),bound=new Promise(resolve=>entered=resolve),note=f.overlay.noteSession.bind(f.overlay);
  f.overlay.noteSession=async(...args)=>{await note(...args);entered();await gate;};
  f.sessions.client.writeAdmission=(userId,operation)=>withNativeMemoryWrite(f.database,userId,operation);
  const handler=createMemoryGatewayHandler({config:{memoryEngineEnabled:true,memoryEnabled:true},runtimeManager:{assertActiveEviMedWorkloadToken:async()=>({userId:f.userId,projectId:'default'})},
    store:{userById:async()=>({id:f.userId}),requireProject:async()=>({userId:f.userId,id:'default',projectCreatedAt:f.projectCreatedAt})},sessions:f.sessions,overlay:f.overlay,admission:{admit:async()=>({learn:true,recall:true,sessionId:'inflight'})}});
  const server=createServer((req,res)=>{void handler(req,res,()=>{});});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const writing=fetch(`http://127.0.0.1:${server.address().port}${MEMORY_GATEWAY_PATH}/api/v1/sessions/dsh-inflight/messages`,{method:'POST',headers:{authorization:'Bearer owner','content-type':'application/json'},body:JSON.stringify({role:'user',content:'In-flight source bytes.'})});
  await bound;
  try{await assert.rejects(withNativeMemoryWrite(f.database,f.userId,async()=>{touched=true;},{exclusive:true}),{code:'memory_source_cleanup_busy'});assert.equal(touched,false);}
  finally{release();await writing;}
  assert.equal((await writing).status,200);assert.equal(await withNativeMemoryWrite(f.database,f.userId,async()=>true,{exclusive:true}),true);
});

test('a deleted conversation with a failed, replayed and abandoned extraction hides none of the account\'s unrelated memory', options, async t => {
  const f=await fixture(t), original=await f.commitConversation('a',[{role:'user',text:'Private source.'}],{projectId:'default'});
  const replay=await f.commitConversation('replay',[{role:'user',text:'Private source.'}],{projectId:'default',engineSession:'evimed-replay-source'});
  await f.overlay.markReplayed(f.userId,original.archive_uri,replay.archive_uri);
  await f.database.query("UPDATE evimed_memory.native_commits SET state='abandoned' WHERE user_id=$1 AND archive_uri=$2",[f.userId,replay.archive_uri]);
  const unrelated=f.seed('profile.md','# Profile\n- Unrelated preference.',{type:'profile'});
  await f.overlay.upsertFile({userId:f.userId,uri:unrelated,memoryType:'profile',body:'# Profile\n- Unrelated preference.'});
  const ledger=new ConversationSourceDeletionLedger(f.database), stamp=(await f.database.query('SELECT created_at::text AS stamp FROM evimed_control.users WHERE id=$1',[f.userId])).rows[0].stamp;
  await ledger.put({id:crypto.randomUUID(),userId:f.userId,projectId:'default',accountCreatedAt:stamp,projectCreatedAt:f.projectCreatedAt,rootSessionId:'session_a',sessionIds:['session_a'],frozen:{root:{id:'session_a'}},memoryUserRoot:f.sessions.userRoot(f.userId)});
  assert.equal((await f.overlay.commit(f.userId,original.archive_uri)).state,'replayed');
  assert.deepEqual(await ledger.hiddenMemoryUris(f.userId),[], 'terminal commits hide neither the root nor an unrelated file');
  assert.equal(await f.overlay.hasUnprovenNativeWrites(f.userId),false,'replayed and abandoned are terminal');
  // A commit genuinely in flight is still unproven.
  await f.commitConversation('b',[{role:'user',text:'Still extracting.'}],{projectId:'default'});
  assert.equal(await f.overlay.hasUnprovenNativeWrites(f.userId),true);
});
