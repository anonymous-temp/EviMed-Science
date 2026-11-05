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
