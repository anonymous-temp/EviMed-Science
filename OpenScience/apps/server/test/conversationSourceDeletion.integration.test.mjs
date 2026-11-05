import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { ConversationSourceDeletionLedger } from '../src/conversationSourceDeletionPersistence.mjs';
const { options, fixture } = nativeIntegration();

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
  await ledger.put({id:crypto.randomUUID(),userId:f.userId,projectId:'default',accountCreatedAt:ownerStamp,projectCreatedAt:ownerStamp,rootSessionId:'session_a',sessionIds:['session_a'],frozen:{root:{id:'session_a'}},memoryUserRoot:f.sessions.userRoot(f.userId)});
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
  await ledger.put({id:crypto.randomUUID(),userId:f.userId,projectId:'default',accountCreatedAt:stamp,projectCreatedAt:stamp,rootSessionId:'session_a',sessionIds:['session_a'],frozen:{root:{id:'session_a'}},memoryUserRoot:f.sessions.userRoot(f.userId)});
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
