import assert from 'node:assert/strict';
import test from 'node:test';
import { historyChunks, historySearchText, MemoryHistoryLimitError } from '../src/memoryHistory.mjs';
// a provider-key shape for the masking checks, built at run time so the source holds no credential literal
const FAKE_PROVIDER_KEY = ['sk', 'abcdefghijklmnop' + 'qrstuvwxyz123456'].join('-');

test('history keeps only sanitized user and assistant text with source dates, roles and adjacent turns', () => {
  const chunks = historyChunks([
    { role: 'system', content: 'system instruction' },
    { role: 'user', content: `Kidney project: reach Alice at alice@example.org, token ${FAKE_PROVIDER_KEY}`, created_at: '2026-11-01T10:00:00Z' },
    { role: 'tool', content: 'secret tool result' },
    { role: 'assistant', parts: [{ type: 'text', text: 'I suggest checking the trial design.' }, { type: 'tool_call', text: 'do not keep' }] },
    { role: 'user', content: '<evimed-brief>injected context</evimed-brief>' },
  ]);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].messages.map(m => m.sourceRole), ['user', 'assistant']);
  assert.equal(chunks[0].messages[0].date, '2026-11-01T10:00:00.000Z');
  assert.equal(chunks[0].messages[1].date, null);
  assert.equal(chunks[0].messages[1].confirmed, false);
  assert.ok(chunks[0].text.includes('alice@example.org'));
  assert.doesNotMatch(chunks[0].text, /abcdefghijklmnopqrstuvwxyz|tool result|injected context|do not keep/);
});

test('exchange chunks are bounded and carry adjacent context without promoting it to confirmed fact', () => {
  const chunks = historyChunks(Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `topic ${i}: ${'x'.repeat(900)}` })));
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every(c => c.text.length <= 6000 && c.messages.length <= 6));
  assert.ok(chunks.every(c => c.messages.every(m => m.contextOnly === true && m.confirmed === false)));
  assert.ok(chunks.some((c, i) => i > 0 && c.messages.some(m => chunks[i - 1].messages.some(p => p.index === m.index))));
});

test('history prose names dates, speaker, link and historical context; unknown time stays unknown', () => {
  const text = historySearchText([{ conversationTitle: 'Kidney trial', conversationUrl: '/app/projects/p?session=session_a', messages: [{ sourceRole: 'assistant', date: null, text: 'Maybe use a crossover design.', contextOnly: true, confirmed: false }] }]);
  assert.match(text, /Kidney trial/); assert.match(text, /assistant/); assert.match(text, /unknown/); assert.match(text, /\/app\/projects/);
  assert.match(text, /context|历史/);
});


test('source-count, fragment and chunk capacity failures have a dedicated local error type', () => {
  const isLimit = limit => error => error instanceof MemoryHistoryLimitError && error.limit === limit;
  assert.throws(() => historyChunks(Array.from({length:1001},()=>({role:'user',content:'A normal message.'}))),isLimit('source_messages'));
  assert.throws(() => historyChunks([{role:'user',content:'界'.repeat(1_800_001)}]),isLimit('fragments'));
  assert.throws(() => historyChunks(Array.from({length:1000},(_,index)=>({role:index%2?'assistant':'user',content:'A normal message.'}))),isLimit('chunks'));
  assert.ok(!(new Error('memory_history_archive_too_large') instanceof MemoryHistoryLimitError));
});

test('forget origin lookup uses the verified owner namespace without inventing a default project', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const context = { kind: 'owned', ownerId: 'u1', ownerCreatedAt: '2026-01-01', namespaceId: 'u1', userRoot: 'viking://user/u1' };
  const uri = `${context.userRoot}/memories/preferences/format.md`, searched = [], fenced = [];
  const service = new MemoryHistory({ config: { memoryHistorySearchEnabled: true },
    contexts: { forProject: async () => { throw new Error('memory_scope_denied: no default project'); },
      forUri: async (owner, target) => { assert.equal(owner, 'u1'); assert.equal(target, uri); return context; } },
    ledger: { database: { transaction: async run => run({}), withTransactionClient: async (_client, run) => run() },
      overlay: { originsOf: async () => new Map() }, rejectMessages: async (...args) => fenced.push(args) },
    resolveSource: async () => { throw new Error('no fabricated project source'); },
    resourcesFor: () => ({ searchHistory: async (_owner, root) => { searched.push(root); return []; } }) });
  service.ensureSourceCopies = async () => {};
  await service.rejectRemoved(context, { uri, type: 'preferences' }, ['Use metric units.'], null);
  assert.equal(searched.length, 1); assert.equal(fenced.length, 1);
  assert.match(searched[0], /^viking:\/\/user\/u1\/resources\/history\/[a-f0-9]{24}$/);
  await assert.rejects(service.search({ user: { id: 'u1' }, project: { id: 'missing', userId: 'u1' }, query: 'units' }), /memory_scope_denied/);
});

test('deferred scan reads a bounded frozen archive batch, excludes later restatements and retries without partial completion', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const root = 'viking://user/u1', reads = [], finishes = [];
  const scan = { id: 'scan', owner_id: 'u1', owner_created_at: '2026-01-01', namespace_id: 'u1', user_root: root,
    memory_type: 'notes', fingerprint: 'fingerprint', text: 'Use metric units.', cutoff: new Date('2026-11-14'),
    archives: Array.from({ length: 6 }, (_, index) => `${root}/sessions/dsh-${index}/history/archive_001`), cursor: 0, claim: 'lease' };
  let unavailable = true;
  const context = { ownerId: 'u1', ownerCreatedAt: scan.owner_created_at, namespaceId: 'u1', userRoot: root,
    sessions: { read: async (_owner, uri) => { reads.push(uri); return [
      {role:'user',content:'I prefer metric measures.',created_at:'2026-11-01'},
      {role:'user',content:'I prefer metric measures.',created_at:'2026-11-15'},
    ].map(message => JSON.stringify(message)).join('\n'); } } };
  const queued = [scan];
  const ledger = { claimForgetScans: async () => queued.splice(0,1), finishForgetScan: async (...args) => finishes.push(args) };
  const service = new MemoryHistory({ config: {}, ledger, contexts: { forUri: async () => context },
    rejectionJudge: { same: async ({ candidates }) => {
      if (unavailable) throw new Error('offline');
      assert.equal(candidates.length, 1, 'later authorization is outside the frozen withdrawal');
      return { same: new Map([[0,'fingerprint']]) };
    } } });
  await service.drainForgetScans();
  assert.deepEqual(finishes[0], [scan, [], 0, true]);
  unavailable = false; reads.length = 0; queued.push(scan);
  await service.drainForgetScans();
  assert.equal(reads.length, 4);
  assert.equal(finishes[1][1].length, 4);
  assert.equal(finishes[1][2], 4);
  scan.cursor = 4; queued.push(scan);
  await service.drainForgetScans();
  assert.equal(finishes[2][1].length, 2);
  assert.equal(finishes[2][2], 6);
});


test('durable maintenance counts reach worker status and the existing metrics registry', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const { nativeMemoryMetricFamilies } = await import('../src/nativeMemoryMetrics.mjs');
  const maintenance = { summary_rebuilds: 2, forget_scans: 3, forget_scan_retries: 1 };
  const service = new MemoryHistory({ config: {}, ledger: { archiveCoverage: async () => ({ maintenance }) } });
  await service.refreshMaintenance();
  assert.deepEqual(service.status().maintenance, maintenance);
  const gauge = nativeMemoryMetricFamilies().find(family => family.name === 'open_science_native_memory_maintenance_pending');
  assert.deepEqual(Object.fromEntries(gauge.series.map(sample => [sample.labels.kind, sample.value])), maintenance);
});

test('late archive discovery is queued before indexing and an unfinished scan keeps its chunks unpublished', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const root = 'viking://user/u1', archiveUri = `${root}/sessions/dsh-late/history/archive_001`, calls = [];
  const context = { ownerId: 'u1', ownerCreatedAt: '2026-01-01', namespaceId: 'u1', userRoot: root,
    sessions: { read: async () => JSON.stringify({ role: 'user', content: 'An earlier fact.', created_at: '2026-01-02T00:00:00Z' }) } };
  const ledger = {
    registerWriteMessages: async () => {},
    queueLateForgetArchive: async (...args) => calls.push(args), boundRejections: async () => [],
    startArchive: async () => ({ state: 'queued' }), forgetArchivePending: async () => true,
    finishArchive: async (_commit, _context, state, result) => calls.push({ state, ...result }),
  };
  const service = new MemoryHistory({ config: { memoryHistorySearchEnabled: true, memoryForgetTargetsEnabled: true }, ledger });
  service.indexArchive = async () => { throw new Error('unscanned text must not reach indexing'); };
  assert.deepEqual(await service.ingestArchive({ archiveUri, engineSession: 'dsh-late' }, context), { state: 'queued', reason: 'forget_scan_pending' });
  assert.deepEqual(calls[0], [context, archiveUri, '2026-01-02T00:00:00.000Z']);
  assert.deepEqual(calls[1], { state: 'queued', reason: 'forget_scan_pending' });
});

test('native derived reader withdraws pre-existing copies and inherited paraphrases without deleting undo bytes', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const statement = 'My old project is M-41633.', uri = 'viking://user/u1/memories/notes/a.md';
  let removed = true;
  const overlay = {removals:async()=>removed?[{fingerprint:lineFingerprint(statement),text:statement,rejectedAt:'2026-01-01'}]:[],
    originsOf:async()=>new Map([[uri,new Map([[lineFingerprint('A derived preference.'),{archiveUri:'old-archive'}]])]])};
  const history = new MemoryHistory({config:{},contexts:{},ledger:{overlay,derivedSourcesRejected:async(_context,refs)=>removed&&refs.archives.includes('old-archive')}});
  const context = {kind:'owned',ownerId:'u1',namespaceId:'u1'};
  const body = `${statement}\nA derived preference.\nAn independent fact.`;
  assert.equal(await history.fenceNativeBody(context,uri,body),'An independent fact.');
  removed = false;
  assert.equal(await history.fenceNativeBody(context,uri,body),body);
});

test('removed-line syntax never becomes a hard token and token-free facts reach the semantic judge', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const history = new MemoryHistory({ config: {}, contexts: {}, ledger: {} });
  const messages = [{ text: '每周三晚上我去游泳', archiveUri: 'archive' }];
  const calls = [];
  const judge = { same: async request => { calls.push(request); return { same: new Map([[0, 'removed']]) }; } };
  assert.deepEqual(await history.matchRemoved({ ownerId: 'u' }, '1. **Habit:** 每周三晚上去游泳 (as of 2026-11-14)', messages, judge), messages);
  assert.equal(calls[0].candidates[0].removed[0].text, '每周三晚上去游泳');
});

test('a line origin is fenced directly even when remember paraphrased the original words', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const root = 'viking://user/u1', uri = `${root}/memories/profile.md`;
  const archiveUri = `${root}/sessions/mcp-store-first/history/archive_001`;
  const original = `${root}/sessions/dsh-first/history/archive_001`;
  const text = '每周三晚上去游泳 (as of 2026-11-14)', fenced = [];
  const context = { ownerId: 'u1', ownerCreatedAt: '2026-01-01', kind: 'owned', namespaceId: 'u1', userRoot: root,
    sessions: { read: async (_owner, path) => JSON.stringify({ role: 'user', content: path.startsWith(original) ? '每周三晚上我去游泳' : 'Go swimming Wednesday evenings.' }) } };
  const history = new MemoryHistory({ config: {}, contexts: {}, ledger: {
    database: { transaction: async run => run({}), withTransactionClient: async (_client, run) => run() },
    overlay: { originsOf: async () => new Map([[uri,new Map([[lineFingerprint(text),{archiveUri}]])]]),
      commit: async () => ({ sourceSession: 'dsh-first' }), removalOrigins: async () => [{archiveUri:original}] },
    rejectMessages: async (_context, _type, _print, messages) => fenced.push(...messages),
  } });
  history.ensureSourceCopies = async () => {};
  await history.rejectRemoved(context, {uri,type:'profile'}, [text], {same:async()=>({same:new Map()})});
  assert.ok(fenced.some(message => message.archiveUri === original && message.text === '每周三晚上我去游泳'));
});

test('a surviving context-only chunk cannot expose a withdrawn message through its conversation title', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const { createHash } = await import('node:crypto');
  const hash = text => createHash('sha256').update(text).digest('hex');
  const context = {ownerId:'u',ownerCreatedAt:'2026-01-01',namespaceId:'u',kind:'owned',userRoot:'viking://user/u'};
  const archive = `${context.userRoot}/sessions/dsh-first/history/archive_001`;
  const fact = '帮我记一下几件个人的事，放进我的个人笔记里：每周三晚上我去游泳；我早上习惯喝黑咖啡；家里的备用钥匙放在蓝色鞋柜第二层；我对青霉素过敏。';
  const messages = [{role:'assistant',content:'Platform project context.',created_at:'2026-01-01T00:00:00Z'}, {role:'user',content:fact}];
  const raw = messages.map(JSON.stringify).join('\n');
  const body = JSON.stringify({messages:historyChunks(messages.slice(0,1))[0].messages});
  const source = {projectId:'default',projectCreatedAt:'2026-01-01',sessionId:'first',conversationTitle:fact.slice(0,48),conversationUrl:'/app/chat/first'};
  let uri;
  const history = new MemoryHistory({config:{memoryHistorySearchEnabled:true},contexts:{forProject:async()=>context},
    resolveSource:async()=>source,eligible:async()=>true,ledger:{
      lookup:async()=>({archive_uri:archive,project_id:'default',project_created_at:source.projectCreatedAt,session_id:'first',digest:hash(body)}),
      archiveSourceHash:async()=>hash(raw),rejected:async(_scope,texts)=>texts.includes(fact),hasWithdrawals:async()=>true,
    },resourcesFor:()=>({searchHistory:async()=>[{uri}],readHistory:async()=>body})});
  context.sessions = {read:async()=>raw};
  uri = `${context.userRoot}/resources/history/${hash(context.ownerCreatedAt).slice(0,24)}/chunk`;
  const hits = await history.search({user:{id:'u'},project:{id:'default'},query:'游泳'}, {includeWithdrawn:true});
  assert.doesNotMatch(historySearchText(hits),/每周三|游泳/);
  assert.match(historySearchText(hits),/withdrawn/);
});

test('a rejected extraction fences the new question/assistant exchange against history resurrection', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const root = 'viking://user/u', archiveUri = `${root}/sessions/dsh-question/history/archive_001`;
  const fenced = [], messages = [{role:'user',content:'我每周哪天去游泳？'},
    {role:'assistant',content:'每周三晚上。早前对话说“每周三晚上我去游泳”，需要我补进笔记吗？'}];
  const context = {ownerId:'u',userRoot:root,kind:'owned',sessions:{read:async()=>messages.map(JSON.stringify).join('\n')}};
  const history = new MemoryHistory({config:{},contexts:{},ledger:{overlay:{removals:async()=>[
    {memoryType:'profile',fingerprint:'swimming',text:'每周三晚上去游泳'},
  ]},rejectMessages:async(_context,_type,_fingerprint,rows)=>fenced.push(...rows)}});
  await history.rejectRelearned(context,archiveUri,['swimming']);
  assert.deepEqual(fenced.map(row=>row.text),messages.map(row=>row.content));
});

test('explicitly kept neighbouring lines survive an archive fence; later removals invalidate that receipt', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const { retainedRemovalKey } = await import('../src/nativeMemoryRejections.mjs');
  const uri = 'viking://user/u/memories/profile.md', text = '对青霉素过敏 (as of 2026-11-14)';
  const authority = [{fingerprint:lineFingerprint('每周三晚上去游泳'),text:'每周三晚上去游泳',rejectedAt:'2026-11-14'}];
  const held = retainedRemovalKey(uri,text,authority);
  const overlay = {removals:async()=>authority,instructionCheck:async(_owner,key)=>key===held?{retainedAfterRemoval:true}:null,
    originsOf:async()=>new Map([[uri,new Map([[lineFingerprint(text),{archiveUri:'origin'}]])]])};
  const history = new MemoryHistory({config:{},contexts:{},ledger:{overlay,derivedSourcesRejected:async()=>true}});
  const context = {ownerId:'u',kind:'owned'};
  assert.equal(await history.fenceNativeBody(context,uri,`- ${text}`),`- ${text}`);
  authority.push({fingerprint:lineFingerprint(text),text,rejectedAt:'2026-11-15'});
  assert.equal(await history.fenceNativeBody(context,uri,`- ${text}`),null);
});

test('a later user-role question is not a history-read authorization', async () => {
  const { MemoryHistoryLedger } = await import('../src/memoryHistory.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const text = 'My project M-41633', question = 'Was this my project M-41633?';
  const ledger = new MemoryHistoryLedger({overlay:{instructionCheck:async()=>null},database:{query:async sql=>({rows:
    sql.includes('SELECT memory_type,fingerprint,text,rejected_at') ? [{memory_type:'notes',fingerprint:lineFingerprint(text),text,rejected_at:new Date('2026-01-01')}] : []})}});
  ledger.migrate = async () => {};
  assert.equal(await ledger.rejected({ownerId:'u',ownerCreatedAt:'2025-01-01',namespaceId:'u',kind:'owned'},[question],'archive',
    [{role:'user',text:question,created_at:'2099-01-01'}]),true);
});

test('history consumes the write-side assertion receipt for the exact new human source only', async () => {
  const { MemoryHistoryLedger } = await import('../src/memoryHistory.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const { removalRefusals } = await import('../src/nativeMemoryRejections.mjs');
  const text = 'My project M-41633', rejectedAt = '2026-01-01T00:00:00.000Z', checks = new Map();
  const removed = {fingerprint:lineFingerprint(text),text,rejectedAt};
  const source = {role:'user',text:'My project M-41633 is active again.',created_at:'2099-01-01'};
  const overlay = {removals:async()=>[removed],instructionCheck:async(_owner,key)=>checks.get(key),
    recordInstructionCheck:async(_owner,key,value)=>checks.set(key,value)};
  await removalRefusals({userId:'u',overlay,candidates:[{text,sources:[source]}],
    judge:{same:async()=>({same:new Map([[0,removed.fingerprint]]),stated:new Set([0]),witnesses:new Map([[0,0]])})}});
  const ledger = new MemoryHistoryLedger({overlay,database:{query:async sql=>({rows:
    sql.includes('SELECT memory_type,fingerprint,text,rejected_at') ? [{...removed,memory_type:'notes',rejected_at:new Date(rejectedAt)}] : []})}});
  ledger.migrate = async () => {};
  const context = {ownerId:'u',ownerCreatedAt:'2025-01-01',namespaceId:'u',kind:'owned'};
  assert.equal(await ledger.rejected(context,[source.text],'new',[source]),false);
  const quotation = {...source,text:`An earlier conversation said “${source.text}”`};
  assert.equal(await ledger.rejected(context,[quotation.text],'quoted',[quotation]),true);
});


test('an explicit page replacement stays readable only under its current removal authority', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const { retainedRemovalKey } = await import('../src/nativeMemoryRejections.mjs');
  const uri = 'viking://user/u/memories/preferences/answer.md', text = 'Short answers, then detail.';
  const authority = [{ text: 'Short answers.', fingerprint: lineFingerprint('Short answers.'), rejectedAt: '2026-01-01' }];
  const receipts = new Map([[retainedRemovalKey(uri, text, authority), { retainedAfterRemoval: true, explicitEdit: true }]]);
  const overlay = { removals: async () => authority, originsOf: async () => new Map(), instructionCheck: async (_owner, key) => receipts.get(key) };
  const history = new MemoryHistory({ config: {}, ledger: { overlay, derivedSourcesRejected: async () => false } });
  const context = { kind: 'owned', ownerId: 'u' };
  assert.equal(await history.fenceNativeBody(context, uri, text), text);
  authority.push({ text, fingerprint: lineFingerprint(text), rejectedAt: '2026-02-01' });
  assert.equal(await history.fenceNativeBody(context, uri, text), null, 'a later removal invalidates the page receipt');
});

test('history ingestion judges a later human statement even when extraction wrote no memory', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const { removalAssertionKey } = await import('../src/nativeMemoryRejections.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const text = 'Project M-41633.', removal = { text, fingerprint: lineFingerprint(text), rejectedAt: '2026-01-01T00:00:00Z' };
  const receipts = new Map(), asked = [];
  const overlay = { removals: async () => [removal], instructionCheck: async (_owner, key) => receipts.get(key),
    recordInstructionCheck: async (_owner, key, value) => receipts.set(key, value) };
  const ledger = { overlay, bindArchive: async () => true, alreadyIndexed: async () => false, reserve: async () => true, ready: async () => true,
    rejected: async (_context, _texts, _archive, messages) => !receipts.has(removalAssertionKey(null, removal, text, messages[0])) };
  const context = { kind: 'owned', ownerId: 'u', ownerCreatedAt: '2025-01-01', namespaceId: 'u', userRoot: 'viking://user/u' };
  const service = new MemoryHistory({ config: {}, ledger,
    resolveSource: async () => ({ sessionId: 'later', projectId: 'default', projectCreatedAt: '2025-01-01', conversationTitle: 'Test' }),
    eligible: async () => true, admitMessage: async () => true, resourcesFor: () => ({ writeHistory: async () => {} }),
    rejectionJudge: { same: async request => {
      asked.push(request);
      const affirmed = request.said[0] === text;
      return { same: new Map([[0, removal.fingerprint]]), stated: new Set(affirmed ? [0] : []), witnesses: new Map(affirmed ? [[0, 0]] : []) };
    } } });
  const commit = { userId: 'u', engineSession: 'dsh-later', archiveUri: 'viking://user/u/sessions/dsh-later/history/archive_001' };
  for (const message of [
    { role: 'user', content: text, created_at: '2026-02-01T00:00:00Z' },
    { role: 'user', content: 'Did I use project M-41633?', created_at: '2026-02-02T00:00:00Z' },
    { role: 'user', content: 'The earlier chat said "Project M-41633."', created_at: '2026-02-03T00:00:00Z' },
    { role: 'assistant', content: text, created_at: '2026-02-04T00:00:00Z' },
    { role: 'user', content: text, created_at: '2025-12-01T00:00:00Z' },
  ]) {
    const result = await service.indexArchive(commit, context, JSON.stringify(message));
    assert.equal(result.chunks, message.created_at === '2026-02-01T00:00:00Z' ? 1 : 0);
  }
  assert.equal(asked.length, 3, 'only later human messages need an assertion judgement');
});
