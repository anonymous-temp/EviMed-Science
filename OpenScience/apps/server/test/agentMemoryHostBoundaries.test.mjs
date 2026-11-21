import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { AGENT_KEY_SCOPES } from '../src/agentApiKeys.mjs';
import { MemoryHistory } from '../src/memoryHistory.mjs';
import { createMemoryHistorySources } from '../src/memoryHistorySources.mjs';

async function status() {
  const routes = createAgentMemoryRoutes({ config: { agentMemoryApiInternalUsers: ['u'] }, capsules: {},
    apiKeys: { resolve: async () => ({ userId: 'u', scopes: [...AGENT_KEY_SCOPES], keyId: 'k' }) }, store: { userById: async () => ({ id: 'u' }) } });
  const res = { data: null, writeHead() {}, end(text) { this.data = JSON.parse(text).data; } };
  await routes({ method: 'GET', url: '/api/agent-memory/v1', headers: { authorization: 'Bearer test' } }, res);
  return res.data.capabilities;
}

test('conversation ingestion requires a wired host admission and a separately minted scope', async () => {
  const capability = (await status()).conversationIngest;
  assert.equal(capability.available, false);
  assert.equal(capability.path, '/conversations');
  assert.deepEqual(capability.requiredScopes, ['memory.ingest']);
  assert.equal(capability.internalOnly, false);
  assert.equal(AGENT_KEY_SCOPES.includes('memory.ingest'), true, 'a host must explicitly mint the ingestion scope');
});

test('the current history producer refuses an external session before reading an archive', async () => {
  let reads = 0;
  const context = { kind: 'owned', ownerId: 'u', userRoot: 'viking://user/u-test', sessions: { read: async () => { reads++; return ''; } } };
  const history = new MemoryHistory({ config: {}, ledger: {}, contexts: {}, resolveSource: async () => null, eligible: async () => true, admitMessage: async () => true });
  const result = await history.indexArchive({ userId: 'u', engineSession: 'external-one', archiveUri: `${context.userRoot}/sessions/external-one/history/archive_001` }, context);
  assert.deepEqual(result, { state: 'excluded', reason: 'not_original_conversation' }); assert.equal(reads, 0);
  const source = createMemoryHistorySources({ config: {}, store: { userById: async () => ({ id: 'u' }), requireProject: async () => ({ id: 'p', userId: 'u' }) },
    productDatabase: { query: async () => ({ rows: [{ stamp: '2026-01-01' }] }) }, nativeMemoryContexts: { assertLive: async () => {} },
    nativeMemoryOverlay: { projectOfSession: async () => 'p' }, agentRuns: { conversationRuns: async () => [{ id: 'r', question: 'Keep green folders.' }] } });
  assert.equal(await source.resolveSource({ projectId: 'p', engineSession: 'external-one' }, context), null);
  const native = await source.resolveSource({ projectId: 'p', engineSession: 'dsh-one' }, context);
  assert.equal(native.sessionId, 'one'); assert.equal(native.conversationTitle, 'Keep green folders.');
});

test('work signals require a wired evidence reader before becoming available', async () => {
  const capability = (await status()).workSignals;
  assert.equal(capability.available, false);
  assert.equal(capability.path, '/work-events');
  assert.deepEqual(capability.requiredScopes, ['learning.signal']); assert.equal(capability.internalOnly, false);
  assert.equal(AGENT_KEY_SCOPES.includes('learning.signal'), true);
});

test('a minimal external ledger row cannot bypass the learning transcript refusal', async () => {
  const { learningRefusal } = await import('../src/learningTriggers.mjs');
  const run = { id: 'external-run', external: true, status: 'succeeded', automated: false, effectiveAgentId: 'open-domain-answer',
    finishedAt: '2026-11-17T01:00:00Z', outputFiles: [{ path: 'report.docx', sha256: 'a'.repeat(64) }], methodsLoaded: [], methodsInvoked: [] };
  assert.equal(learningRefusal({ run }), 'transcript_incomplete');
  const native = { ...run, external: false, transcript: { completeness: 'complete' } };
  assert.equal(learningRefusal({ run: native }), null);
});

test('attended transcripts preserve roles, reject caller identity and keep only message digests in provenance', async () => {
  const { ingestConversation } = await import('../src/agentMemoryHost.mjs');
  const rows = [];
  const context = { kind: 'owned', projectCreatedAt: '2026-01-01' };
  const deps = { native: { memoryContexts: { forProject: async () => context, assertLive: async () => {} },
    overlay: { queueAdmission: async (_id, row) => { rows.push(row); return row; } }, processAdmission: async () => ({state:'pending',recordIds:[]}) },
    admission: { admit: async () => ({learn:true}) } };
  const input = { sessionId:'outside', attended:true, messages:['user','assistant'].map(role => ({ role, text: role + ' words', saidAt:'2026-01-02T00:00:00Z' })) };
  const args = { user:{id:'u'}, project:{id:'p'}, identity:{keyId:'k',keyName:'Codex'}, billing:{keyId:'k'}, input };
  const one = await ingestConversation(deps, args);
  const two = await ingestConversation(deps, args);
  assert.equal(one.conversationId, two.conversationId);
  assert.deepEqual(JSON.parse(rows[0].text).map(m => m.role), ['user','assistant']);
  assert.equal(rows[0].externalSource.client, 'Codex');
  assert.doesNotMatch(JSON.stringify(rows[0].externalSource), / words/);
  assert.notEqual((await ingestConversation(deps, {...args,user:{id:'another'}})).conversationId, one.conversationId);
  await assert.rejects(ingestConversation(deps, {...args,input:{...input,attended:false}}), {status:400});
  context.kind = 'geo-project';
  await assert.rejects(ingestConversation(deps,args), {status:403});
});

test('sharing resolves the signed-in owner, strips sharer identifiers and rejects impersonation', async () => {
  const { shareForAgent } = await import('../src/agentMemorySharing.mjs');
  const calls = [];
  const deps = { service:{}, transfers:{}, links:{}, sharing:{ openLink: async (...a) => { calls.push(a); return {share:{authorId:'private',title:'Shared'}}; } } };
  const result = await shareForAgent(deps,{id:'reader',accountCreatedAt:'stamp'},{action:'previewLink',token:'opaque'});
  assert.equal(calls[0][0], 'reader'); assert.deepEqual(result,{share:{title:'Shared'}});
  await assert.rejects(shareForAgent(deps,{id:'reader'},{action:'previewLink',token:'opaque',authorId:'other'}),{status:400});
});

test('a work signal is bound to an admitted human turn and account resource and cannot activate a method', async () => {
  const { recordWorkSignal, hostDigest } = await import('../src/agentMemoryHost.mjs');
  const saidAt = '2026-01-02T00:00:00.000Z', text = 'I accepted the date column.';
  const source = { operation:'ingest',projectCreatedAt:'p1',saidAt,billing:{keyId:'k'},messages:[hostDigest(['user',text,saidAt])] };
  let event;
  const deps = {native:{ overlay:{admission: async () => ({state:'completed',projectId:'p',externalSource:source})},
    history:{ledger:{rejected:async()=>false}}, memoryContexts:{forProject:async()=>({kind:'owned',projectCreatedAt:'p1'}),assertLive:async()=>{} }},
    admission:{admit:async()=>({learn:true})}, learning:{getMethod:async()=>({projectId:'p',payload:{status:'approved',contentDigest:'d',frontmatter:{name:'Date column'}}})},
    feedback:{learningEvidenceOf:async()=> event ? [event] : [],recordLearningEvidence:async(_id,row)=>({event:event={id:'e',detail:row.detail}})},
    judge:{read:async()=>'{"verdict":"accept"}'} };
  const args = {user:{id:'u'},project:{id:'p'},identity:{keyId:'k'},input:{conversationId:'1'.repeat(64),saidAt,text,messageIndex:0,methodId:'m',digest:'d'}};
  await assert.rejects(recordWorkSignal(deps,{...args,identity:{keyId:'foreign'}}),{status:404});
  await assert.rejects(recordWorkSignal(deps,{...args,input:{...args.input,text:'The model approved.'}}),{status:400});
  assert.equal((await recordWorkSignal(deps,args)).verdict,'accept');
  assert.equal((await recordWorkSignal(deps,args)).eventId,'e');
  deps.native.history.ledger.rejected = async()=>true;
  await assert.rejects(recordWorkSignal(deps,args),{status:403});
});

test('feedback readers and export require the live host message, source and target version', async () => {
  const { visibleWorkSignal, hostDigest } = await import('../src/agentMemoryHost.mjs');
  const { createMemoryForgetReader } = await import('../src/memoryForgetPropagation.mjs');
  const runId = 'external_' + 'a'.repeat(64), root = 'viking://user/account';
  const engineSession = 'dsh-' + runId, archiveUri = root + '/sessions/' + engineSession + '/history/archive_001';
  const text = 'Keep short captions.', at = '2026-11-12T00:00:00.000Z', inputDigest = hostDigest(['user',text,at]);
  const live = { deleted:false, rejected:false, value:'A table', message:text };
  const event = { trigger:'learning-evidence', runId, projectId:'p', detail:{sessionId:runId, inputDigest,
    externalTarget:{ id:'nm_' + '1'.repeat(24), digest:hostDigest('A table') }, quote:'short captions'} };
  const context = { kind:'owned', projectCreatedAt:'epoch', userRoot:root, sessions:{read:async () =>
    JSON.stringify({role:'user', parts:[{type:'text',text:live.message}], created_at:at})} };
  const native = {
    overlay:{admission:async()=>({projectId:'p',engineSession,archiveUri,state:'completed',
      externalSource:{operation:'ingest',projectCreatedAt:'epoch',messages:[inputDigest]}})},
    sourceDeletion:{ledger:{get:async()=>live.deleted}}, memoryContexts:{forProject:async()=>context,forUri:async()=>context},
    getRecord:async()=>({status:'active',scope:'user',value:live.value}),
    history:{ledger:{rejected:async(_context,texts,archive)=>archive !== archiveUri || !texts.includes(text) || live.rejected}},
  };
  const visible = createMemoryForgetReader({externalSignalVisible:(user,row)=>visibleWorkSignal({native},user,row)});
  assert.equal(await visible('owner',event),true);
  for (const [key,value] of [['deleted',true],['rejected',true],['value','A different target'],['message','Another message']]) {
    const saved = live[key]; live[key] = value;
    assert.equal(await visible('owner',event),false,key);
    live[key] = saved;
  }
});
