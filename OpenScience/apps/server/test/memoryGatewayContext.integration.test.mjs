import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { GeoNativeMemoryRemember } from '../src/geoNativeMemoryRemember.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { OpenVikingClient } from '../src/openVikingClient.mjs';
import { OPENVIKING_PROJECT_MEMORY_TYPES } from '../src/openVikingLayout.mjs';
import { createMemoryGatewayHandler, MEMORY_GATEWAY_PATH } from '../src/memoryGateway.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { startOpenVikingStub } from './helpers/openVikingStub.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function fixture(t, { capsuleSearch = null, gatewayTimeoutMs = 4000 } = {}) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'memorygatewaycontext');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'memory-gateway-context-'));
  const accounts = new PostgresStore(loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', databasePoolMax: 1 }));
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  await accounts.createUser('owner', 'fixture-password', 'Owner');
  const owner = await accounts.userById('owner');
  await accounts.createProject(owner, 'project-b', 'B'); await accounts.createProject(owner, 'ordinary', 'Ordinary');
  const a = await accounts.requireProject(owner, 'default'), b = await accounts.requireProject(owner, 'project-b'), ordinary = await accounts.requireProject(owner, 'ordinary');
  const geo = new GeoStore({ database: accounts.database }); await geo.ready();
  for (const project of [a, b]) await geo.createProject({ userId: owner.id, projectId: project.id, engines: ['deepseek'], coverageDays: 30 });
  const documents = new ProductDocuments(accounts.database), policies = new GeoSharedContext({ database: accounts.database, documents });
  const stub = await startOpenVikingStub(t);
  const sessions = new OpenVikingSessions(new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: 'evimed' }));
  const contexts = new GeoNativeMemoryContext({ database: accounts.database, documents, policies, sessions,
    proveCapture: async (_context, session) => session === 'dsh-root' ? { rootSessionId: 'root', rootProofRefs: ['trusted-primary'], runtimeGeneration: 'generation-1' } : null });
  const commits = [], noted = [], forgotten = [];
  const overlay = { configured: true, account: async () => null, noteRegistered: async () => {}, sensitiveUris: async () => [],
    noteSession: async (...args) => { noted.push(args); }, recordCommit: async row => { commits.push(row); }, commit: async (_owner, uri) => commits.find(row => row.archiveUri === uri) ?? null };
  const journal = new GeoNativeMemoryRemember({ contexts, overlay });
  const admission = { admit: async () => ({ native: true, learn: true, recall: true, learnReason: null, recallReason: null, sessionId: null }) };
  const handler = createMemoryGatewayHandler({ config: { ovNativeMemoryEnabled: true, memoryEnabled: true, memoryGatewayTimeoutMs:gatewayTimeoutMs }, sessions, admission, overlay,
    runtimeManager: { assertActiveEviMedWorkloadToken: async token => {
      if (![a.id, b.id, ordinary.id].includes(token)) throw new Error('Unknown workload');
      return { userId: owner.id, projectId: token };
    }, runtimeGeneration: () => 'generation-1' }, store: accounts,
    memoryContexts: contexts, rememberJournal: journal, capsuleSearch,
    memoryTool: { forget: async (user, project, uri, options) => { forgotten.push({ user, project, uri, options }); return { removed: true }; } } });
  const server = createServer((req, res) => { void handler(req, res); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}${MEMORY_GATEWAY_PATH}`;
  const call = async (project, method, path, body) => {
    const result = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${project.id}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await result.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: result.status, json, text };
  };
  return { owner, accounts, documents, contexts, sessions, a, b, ordinary, stub, handler, commits, noted, forgotten, call, overlay };
}

test('one native entrance passes the bound project policy to capsule selection and retains ordinary recall', options, async t => {
  const called = [];
  const f = await fixture(t, { capsuleSearch: async input => { called.push(input); return input.contextPolicy?.kind === 'geo-project' ? [{content:'Authorized project capsule fact'}] : [{ content: 'Private account capsule fact' }]; } });
  const search = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'work facts' } } };
  const shared = await f.call(f.a, 'POST', '/mcp', search);
  assert.equal(shared.status, 200); assert.doesNotMatch(shared.text, /Private account capsule/);
  assert.match(shared.text,/Authorized project capsule fact/);
  assert.equal(called[0].contextPolicy.controlProjectId,f.a.id);
  const owned = await f.call(f.ordinary, 'POST', '/mcp', search);
  assert.equal(owned.status, 200); assert.match(owned.text, /Private account capsule fact/);
  assert.deepEqual(called.map(input=>input.project.id), [f.a.id,f.ordinary.id]);
});

test('unnamed startup recall uses the project namespace and initializes six types while ordinary personal recall remains available', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a), b = await f.contexts.forProject(f.b);
  f.stub.seedMemory(f.sessions.engineUser(f.owner.id), 'profile.md', 'PERSONAL PROFILE');
  f.stub.seedMemory(a.namespaceId, 'project_facts/a.md', 'PROJECT A FACT');
  f.stub.seedMemory(b.namespaceId, 'project_facts/b.md', 'PROJECT B FACT');
  f.stub.seedMemory(a.namespaceId, 'profile.md', 'UNEXPECTED PROFILE');
  f.stub.seedMemory(a.namespaceId, 'preferences/private.md', 'UNEXPECTED PREFERENCE');
  const result = await f.call(f.a, 'POST', '/api/v1/search/search', { mode: 'context', query: '' });
  assert.equal(result.status, 200); assert.match(result.text, /PROJECT A FACT/);
  assert.doesNotMatch(result.text, /PERSONAL|PROJECT B|UNEXPECTED/);
  assert.deepEqual(f.stub.users.get(a.namespaceId).memoryTypes.slice().sort(), [...OPENVIKING_PROJECT_MEMORY_TYPES].sort());
  const profile = await f.call(f.a, 'GET', `/api/v1/content/read?uri=${encodeURIComponent(`${a.userRoot}/memories/profile.md`)}`);
  assert.equal(profile.status, 404);
  const ordinary = await f.call(f.ordinary, 'POST', '/api/v1/search/search', { mode: 'context', query: '' });
  assert.match(ordinary.text, /PERSONAL PROFILE/);
  assert.equal((await f.call(f.b, 'GET', '/api/v1/system/status')).json.result.user, b.namespaceId);
});

test('capture proof precedes engine writes and equal engine ids in two projects never enter the legacy session ledger', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a), b = await f.contexts.forProject(f.b);
  await f.call(f.a, 'POST', '/api/v1/sessions', { session_id: 'dsh-unknown' });
  await f.call(f.a, 'POST', '/api/v1/sessions/dsh-unknown/messages', { role: 'user', content: 'Not associated' });
  assert.equal(f.stub.sent('POST', '/api/v1/sessions').length, 0);
  assert.equal((await f.call(f.a, 'GET', '/api/v1/sessions/dsh-unknown')).json.result.message_count, 0);
  for (const project of [f.a, f.b]) {
    assert.equal((await f.call(project, 'POST', '/api/v1/sessions', { session_id: 'dsh-root' })).status, 200);
    assert.equal((await f.call(project, 'POST', '/api/v1/sessions/dsh-root/messages', { role: 'user', content: project.id })).status, 200);
    assert.equal((await f.call(project, 'POST', '/api/v1/sessions/dsh-root/commit', {})).status, 200);
  }
  assert.equal(f.noted.length, 0); assert.equal(f.commits.length, 2);
  assert.deepEqual(new Set(f.commits.map(row => row.archiveUri.split('/sessions/')[0])), new Set([a.userRoot, b.userRoot]));
  assert.equal((await f.contexts.session(a, 'dsh-root')).payload.namespaceId, a.namespaceId);
  const count = f.stub.requests.length;
  await assert.rejects(f.handler.commitSession({ user: f.owner, project: f.b, engineSessionId: 'dsh-root', context: a }), error => error.code === 'memory_scope_denied');
  assert.equal(f.stub.requests.length, count);
});

test('shared reads and forget validate canonical namespace before using the existing memory-page handler', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a), b = await f.contexts.forProject(f.b);
  const own = f.stub.seedMemory(a.namespaceId, 'project_facts/a.md', 'Readable current project');
  const foreign = f.stub.seedMemory(b.namespaceId, 'project_facts/b.md', 'Other project');
  assert.match((await f.call(f.a, 'GET', `/api/v1/content/read?uri=${encodeURIComponent('viking://~/memories/project_facts/a.md')}`)).text, /Readable current project/);
  for (const uri of [foreign, `${a.userRoot}/memories/%2e%2e/profile.md`, `${a.userRoot}/sessions/dsh-unknown/history/archive_001/messages.jsonl`]) {
    const before = f.stub.sent('GET', '/api/v1/content/read').length;
    const result = await f.call(f.a, 'GET', `/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
    assert.equal(result.status, 403); assert.equal(f.stub.sent('GET', '/api/v1/content/read').length, before);
  }
  const forget = uri => f.call(f.a, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forget', arguments: { uri } } });
  await forget(foreign); assert.equal(f.forgotten.length, 0);
  const result = await forget(own); assert.equal(result.status, 200); assert.equal(f.forgotten.length, 1);
  assert.equal(f.forgotten[0].options.context.namespaceId, a.namespaceId);
  assert.equal(f.forgotten[0].project.id, f.a.id);
});

test('shared native remember uses the verified journal and duplicate client ids cannot overwrite each other', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a);
  const request = text => ({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'remember', arguments: { messages: [{ role: 'user', content: text }] } } });
  const result = await f.call(f.a, 'POST', '/mcp', [request('Remember the first project fact'), request('Remember the second project fact')]);
  assert.equal(result.status, 200); assert.deepEqual(result.json.map(item => item.id), [8, 8]);
  const rows = (await f.documents.list(f.owner.id, 'geo-plan-context', { filter: { recordType: 'geo-native-memory-operation' } })).items;
  assert.equal(rows.length, 2); assert.equal(rows.every(row => row.payload.state === 'accepted' && row.payload.ledgerState === 'recorded'), true);
  assert.equal(new Set(f.stub.sent('POST', '/mcp').map(row => row.body.id)).size, 2);
  assert.equal(f.commits.length, 2); assert.equal(f.commits.every(row => row.archiveUri.startsWith(`${a.userRoot}/`)), true);
  const remembered = rows[0].payload.sessionId;
  const before = f.stub.sent('POST', `/api/v1/sessions/${remembered}/messages`).length;
  await f.call(f.a, 'POST', `/api/v1/sessions/${remembered}/messages`, { role: 'user', content: 'Cannot append by guessing the tool session' });
  assert.equal(f.stub.sent('POST', `/api/v1/sessions/${remembered}/messages`).length, before);
});

test('required project privacy filters cannot be displaced and native list does not reveal excluded filenames', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a);
  f.stub.seedMemory(a.namespaceId, 'profile.md', 'EXCLUDED PROFILE');
  f.stub.seedMemory(a.namespaceId, 'preferences/private-owner-note.md', 'EXCLUDED PREFERENCE');
  f.stub.seedMemory(a.namespaceId, 'project_facts/public.md', 'VISIBLE PROJECT FACT');
  const result = await f.call(f.a, 'POST', '/api/v1/search/search', { mode: 'context', query: '', exclude_uris: Array.from({ length: 200 }, (_, n) => `viking://unused/${n}`) });
  assert.equal(result.status, 200); assert.match(result.text, /VISIBLE PROJECT FACT/); assert.doesNotMatch(result.text, /EXCLUDED/);
  const listing = await f.call(f.a, 'POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list', arguments: { uri: `${a.userRoot}/memories`, recursive: true } } });
  assert.match(listing.text, /public.md/); assert.doesNotMatch(listing.text, /profile.md|private-owner-note/);
  f.overlay.sensitiveUris = async () => { throw new Error('Privacy state unavailable'); };
  const before = f.stub.sent('POST', '/api/v1/search/search').length;
  assert.equal((await f.call(f.a, 'POST', '/api/v1/search/search', { query: '' })).status, 503);
  assert.equal(f.stub.sent('POST', '/api/v1/search/search').length, before);
});

test('nested and legacy project corrections remain readable and searchable beside private preferences and sensitive files', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a), root = `${a.userRoot}/memories`;
  const nested = f.stub.seedMemory(a.namespaceId, 'preferences/corrections/wording.md', 'VISIBLE NESTED CORRECTION');
  const legacy = f.stub.seedMemory(a.namespaceId, 'corrections/legacy.md', 'VISIBLE LEGACY CORRECTION');
  const sensitive = f.stub.seedMemory(a.namespaceId, 'preferences/corrections/sensitive.md', 'EXCLUDED SENSITIVE CORRECTION');
  const privateFiles = [
    ['profile.md', 'EXCLUDED PROFILE'], ['preferences/owner.md', 'EXCLUDED OWNER PREFERENCE'],
    ['preferences/self/tone.md', 'EXCLUDED SELF PREFERENCE'], ['preferences/corrections-private/secret.md', 'EXCLUDED SIBLING'],
    ['preferences/.hidden.md', 'EXCLUDED HIDDEN PREFERENCE'], ['preferences/.overview.md', 'EXCLUDED PREFERENCES OVERVIEW'],
    ['preferences/.abstract.md', 'EXCLUDED PREFERENCES ABSTRACT'], ['preferences/corrections/.overview.md', 'EXCLUDED CORRECTIONS OVERVIEW'],
    ['preferences/corrections/.abstract.md', 'EXCLUDED CORRECTIONS ABSTRACT'], ['.overview.md', 'EXCLUDED MEMORY OVERVIEW'],
  ].map(([relative, text]) => f.stub.seedMemory(a.namespaceId, relative, text));
  f.overlay.sensitiveUris = async () => [sensitive];
  const tool = (name, args) => f.call(f.a, 'POST', '/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  for (const uri of [nested, legacy]) {
    const result = await f.call(f.a, 'GET', `/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
    assert.equal(result.status, 200); assert.match(result.text, /VISIBLE/);
  }
  for (const uri of [...privateFiles, sensitive, `${root}/preferences`]) {
    const result = await f.call(f.a, 'GET', `/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
    assert.equal(result.status, 404); assert.doesNotMatch(result.text, /EXCLUDED/);
  }
  for (const mode of ['context', undefined]) {
    const result = await f.call(f.a, 'POST', '/api/v1/search/search', { query: '', ...(mode ? { mode } : {}), limit: 50 });
    assert.equal(result.status, 200); assert.match(result.text, /VISIBLE NESTED/); assert.match(result.text, /VISIBLE LEGACY/); assert.doesNotMatch(result.text, /EXCLUDED/);
  }
  const search = await tool('search', { query: '', limit: 20 });
  assert.equal(search.status, 200); assert.match(search.text, /VISIBLE NESTED|wording.md/); assert.match(search.text, /VISIBLE LEGACY|legacy.md/); assert.doesNotMatch(search.text, /EXCLUDED|owner.md|sensitive.md/);
  const read = await tool('read', { uris: [nested, legacy, ...privateFiles, sensitive] });
  assert.match(read.text, /VISIBLE NESTED/); assert.match(read.text, /VISIBLE LEGACY/); assert.doesNotMatch(read.text, /EXCLUDED/);
  for (const uri of [root, `${root}/preferences`, `${root}/preferences/corrections`]) {
    const listing = await tool('list', { uri, recursive: true });
    assert.equal(listing.status, 200); assert.match(listing.text, /wording.md/); assert.doesNotMatch(listing.text, /EXCLUDED|owner.md|sensitive.md|tone.md|secret.md|overview|abstract/);
  }
  const asked = f.stub.sent('POST', '/api/v1/search/search');
  for (const request of asked) {
    assert.equal(request.body.exclude_uris.includes(`${root}/preferences`), false);
    assert.ok(request.body.exclude_uris.includes(`${root}/preferences/self`));
    assert.ok(request.body.exclude_uris.includes(sensitive));
    assert.equal(request.user, a.namespaceId);
  }
  assert.ok(f.stub.requests.every(request => !request.user || request.user === a.namespaceId));
});

test('shared search and list postfilters discard a raced private preference and aggregate metadata before rendering', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a), root = `${a.userRoot}/memories`;
  const correction = f.stub.seedMemory(a.namespaceId, 'preferences/corrections/kept.md', 'VISIBLE CORRECTION');
  const request = f.sessions.rootClient.request.bind(f.sessions.rootClient);
  f.sessions.rootClient.request = async input => {
    if (input.path === '/api/v1/search/search') {
      // The preference appeared after the complete sibling inventory. No old
      // exclusion list can name it, so the result's URI/type must decide.
      f.stub.seedMemory(a.namespaceId, 'preferences/raced.md', 'EXCLUDED RACED PRIVATE FACT');
      const answer = await request(input);
      if (input.body.mode === 'context') {
        answer.result.entries.push({ uri: `${root}/preferences`, detail: 'overview', text: 'EXCLUDED PARENT SUMMARY' });
        answer.result.entries.push({ uri: correction, detail: 'overview', text: 'EXCLUDED AGGREGATE UNDER FILE URI' });
        answer.result.rendered += 'EXCLUDED ORIGINAL RENDERED SUMMARY';
        answer.result.entries[0].privateTitle = 'EXCLUDED EXTRA TITLE';
      } else {
        answer.result.memories.push({ uri: `${root}/preferences`, level: 1, abstract: 'EXCLUDED PARENT SUMMARY' });
        answer.result.privateTitle = 'EXCLUDED EXTRA TITLE';
      }
      return answer;
    }
    const answer = await request(input);
    if (input.path === '/api/v1/fs/ls' && input.query.uri === root) {
      for (const entry of answer.result) entry.abstract = entry.title = 'EXCLUDED DIRECTORY METADATA';
      answer.privateSummary = 'EXCLUDED ENVELOPE SUMMARY';
    }
    return answer;
  };
  const context = await f.call(f.a, 'POST', '/api/v1/search/search', { mode: 'context', query: '', limit: 50 });
  assert.equal(context.status, 200); assert.match(context.text, /VISIBLE CORRECTION/); assert.doesNotMatch(context.text, /EXCLUDED/);
  const search = await f.call(f.a, 'POST', '/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'search', arguments: { query: '', limit: 20 } } });
  assert.match(search.text, /VISIBLE CORRECTION/); assert.doesNotMatch(search.text, /EXCLUDED|raced.md/);
  const listing = await f.call(f.a, 'GET', `/api/v1/fs/ls?uri=${encodeURIComponent(root)}&recursive=true`);
  assert.match(listing.text, /kept.md/); assert.doesNotMatch(listing.text, /EXCLUDED|raced.md/);
});

test('the complete private-preference inventory is paged and fails by name when required exclusions exceed 200', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a), root = `${a.userRoot}/memories`;
  f.stub.seedMemory(a.namespaceId, 'preferences/corrections/kept.md', 'VISIBLE CORRECTION');
  for (let index = 0; index < 125; index++) f.stub.seedMemory(a.namespaceId, `preferences/private-${index}.md`, 'EXCLUDED PRIVATE');
  const result = await f.call(f.a, 'POST', '/api/v1/search/search', { mode: 'context', query: '', limit: 20,
    exclude_uris: Array.from({ length: 200 }, (_, index) => `viking://unused/${index}`) });
  assert.equal(result.status, 200); assert.match(result.text, /VISIBLE CORRECTION/); assert.doesNotMatch(result.text, /EXCLUDED/);
  assert.ok(f.stub.sent('GET', '/api/v1/fs/ls').some(request => request.query.uri === `${root}/preferences` && request.query.offset === '100'));
  for (let index = 125; index < 205; index++) f.stub.seedMemory(a.namespaceId, `preferences/private-${index}.md`, 'EXCLUDED PRIVATE');
  const before = f.stub.sent('POST', '/api/v1/search/search').length;
  const tooMany = await f.call(f.a, 'POST', '/api/v1/search/search', { query: '' });
  assert.equal(tooMany.status, 503); assert.equal(tooMany.json.error.code, 'memory_scope_denied');
  assert.equal(f.stub.sent('POST', '/api/v1/search/search').length, before);
});

test('project-native list pages all allowed files using raw page offsets and initialization preserves an explicit learning pause', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a);
  await f.contexts.configure(a, { learning: false });
  f.stub.seedMemory(a.namespaceId, 'profile.md', 'Excluded');
  f.stub.seedMemory(a.namespaceId, 'preferences/private.md', 'Excluded');
  for (let index = 0; index < 205; index++) f.stub.seedMemory(a.namespaceId, `project_facts/fact-${String(index).padStart(3, '0')}.md`, `Project fact ${index}`);
  const seen = new Set(); let offset = 0, pages = 0;
  while (pages < 10) {
    const response = await f.call(f.a, 'POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list', arguments: { uri: `${a.userRoot}/memories`, recursive: true, offset, limit: 100 } } });
    assert.equal(response.status, 200);
    const value = JSON.parse(response.json.result.content[0].text); pages++;
    for (const item of value.items) if (!item.isDir) { assert.match(item.uri, /project_facts\/fact-/); assert.equal(seen.has(item.uri), false); seen.add(item.uri); }
    if (!value.hasMore) break;
    assert.ok(value.nextOffset > offset); offset = value.nextOffset;
    assert.ok(pages < 10);
  }
  assert.equal(seen.size, 205); assert.equal(pages, 3);
  assert.equal(f.stub.users.get(a.namespaceId).learning, false);
  assert.deepEqual(f.stub.users.get(a.namespaceId).memoryTypes.slice().sort(), [...OPENVIKING_PROJECT_MEMORY_TYPES].sort());
});

test('a project memory listing can follow its own continuation beyond twenty thousand files', options, async t => {
  const f = await fixture(t), a = await f.contexts.forProject(f.a);
  for (let index = 0; index < 20200; index++) f.stub.seedMemory(a.namespaceId, `project_facts/fact-${String(index).padStart(5, '0')}.md`, 'Project fact');
  let offset = 20000, lastUri = '', pages = 0;
  while (pages < 5) {
    const response = await f.call(f.a, 'POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list', arguments: { uri: `${a.userRoot}/memories`, recursive: true, offset, limit: 100 } } });
    assert.equal(response.status, 200); assert.equal(response.json.error, undefined);
    const value = JSON.parse(response.json.result.content[0].text); pages++;
    lastUri = value.items.at(-1)?.uri ?? lastUri;
    if (!value.hasMore) break;
    assert.ok(value.nextOffset > offset); offset = value.nextOffset; assert.ok(pages < 5);
  }
  assert.match(lastUri, /fact-20199\.md$/); assert.equal(pages, 3);
});


test('optional scoped capsule timeout retains native project search results and does not broaden targets',options,async t=>{
  let calls=0;
  const f=await fixture(t,{gatewayTimeoutMs:250,capsuleSearch:async()=>{calls++;return new Promise(()=>{});}});
  const context=await f.contexts.forProject(f.a);
  f.stub.seedMemory(context.namespaceId,'project_facts/native.md','PROJECT native result');
  const started=Date.now();
  const result=await f.call(f.a,'POST','/api/v1/search/search',{mode:'context',query:'PROJECT'});
  assert.equal(result.status,200);assert.match(result.text,/PROJECT native result/);assert.equal(calls,1);
  assert.ok(Date.now()-started<2000);
  await f.call(f.a,'POST','/api/v1/search/search',{mode:'context',query:'PROJECT',target_uri:`${context.userRoot}/memories/project_facts`});
  assert.equal(calls,1);
});
