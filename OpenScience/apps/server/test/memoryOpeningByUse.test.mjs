import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createMemoryGatewayHandler, MEMORY_GATEWAY_PATH, parseEventStream } from '../src/memoryGateway.mjs';
import { openingProfileRead, openingTokens, orderOpeningEntries, selectOpeningEntries } from '../src/memoryOpeningByUse.mjs';
import { renderResidentProfile } from '../src/residentProfile.mjs';
import { OpenVikingClient } from '../src/openVikingClient.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { openVikingUserId } from '../src/openVikingLayout.mjs';
import { startOpenVikingStub } from './helpers/openVikingStub.mjs';

const USER = 'opening_test', ENGINE_USER = openVikingUserId(USER), ROOT = `viking://user/${ENGINE_USER}/memories`;
const enabled = { memoryOpeningByUseEnabled: true };
const leaf = (name, group = 'preferences') => ({ uri: `${ROOT}/${group}/${name}.md`, rel_path: `${name}.md`, isDir: false });
const held = (entry, usedCount = 0, extra = {}) => ({ ...entry, usedCount, lastUsedAt: null, createdAt: '2020-01-01', body: 'First fact\nSecond fact\nThird fact\nFourth fact', ...extra });
const selection = (preferences, files, config = enabled, entities = [], profile = '') => selectOpeningEntries({ preferences, entities, profile, root: ROOT, files, config });

test('opening order uses count, last use, new-file grace, then the existing order', () => {
  const entries = ['old', 'new', 'tied-b', 'tied-a', 'recent-use', 'most'].map(name => leaf(name));
  const files = new Map(entries.map(entry => [entry.uri, held(entry)]));
  files.get(entries[1].uri).createdAt = '2026-11-09';
  for (const entry of entries.slice(2)) Object.assign(files.get(entry.uri), { usedCount: 1, lastUsedAt: '2026-10-01' });
  files.get(entries[4].uri).lastUsedAt = '2026-11-01';
  files.get(entries[5].uri).usedCount = 2;
  assert.deepEqual(orderOpeningEntries(entries, files, { now: Date.parse('2026-11-10') }).map(entry => entry.rel_path),
    ['most.md', 'recent-use.md', 'tied-b.md', 'tied-a.md', 'new.md', 'old.md']);
  assert.equal(orderOpeningEntries(entries.slice(0, 2), files, { now: Date.parse('2026-11-10'), newFileDays: 0 })[0], entries[0]);
});

test('budget drops the use-ordered tail, keeps fresh knowledge ahead of stale unused files, and changes no URI', () => {
  const entries = ['old', 'new', 'used'].map(name => leaf(name));
  const files = new Map(entries.map(entry => [entry.uri, held(entry, entry.rel_path === 'used.md' ? 3 : 0)]));
  files.get(entries[1].uri).createdAt = new Date().toISOString();
  const twoLines = ['<available-memories>', `  ${ROOT}/preferences/`, '    - used.md', '    - new.md', '</available-memories>'].join('\n');
  const result = selection(entries, files, { ...enabled, memoryOpeningMaxChars: twoLines.length });
  assert.deepEqual(result.preferences, [entries[2], entries[1]]);
  assert.equal(selection(entries, files, { ...enabled, memoryOpeningMaxChars: 1 }).preferences.length, 0);
  assert.deepEqual(entries.map(entry => entry.rel_path), ['old.md', 'new.md', 'used.md']);
});

test('the two listing directories share one character cap and the plugin token shares', () => {
  const prefs = Array.from({ length: 400 }, (_, index) => leaf(`${String(index).padStart(3, '0')}-${'中'.repeat(30)}`));
  const ents = [leaf('entity', 'entities')];
  const files = new Map([...prefs, ...ents].map(entry => [entry.uri, held(entry, entry === prefs.at(-1) ? 10 : 0)]));
  const result = selection(prefs, files, { ...enabled, memoryOpeningMaxChars: 800 }, ents);
  assert.equal(result.preferences[0].uri, prefs.at(-1).uri, 'the alphabetically last, most-used entry survives before the plugin sort');
  const lines = ['<available-memories>', `  ${ROOT}/preferences/`, ...result.preferences.map(entry => `    - ${entry.rel_path}`),
    ...(result.entities.length ? [`  ${ROOT}/entities/`, ...result.entities.map(entry => `    - ${entry.rel_path}`)] : []), '</available-memories>'];
  assert.ok(lines.join('\n').length <= 800);
  assert.ok(result.preferences.reduce((sum, entry) => sum + openingTokens(`    - ${entry.rel_path}`), openingTokens(`  ${ROOT}/preferences/`)) <= 5_000);
});

test('switch off and never-used default selection preserve today’s exact entries and resident bytes', () => {
  const entries = [leaf('z'), leaf('a')], files = new Map(entries.map(entry => [entry.uri, held(entry)]));
  assert.equal(selection(entries, files).preferences, entries);
  assert.equal(selection(entries, files, { memoryOpeningByUseEnabled: false, memoryOpeningMaxChars: 1 }).preferences, entries);
  const capsuleFacts = [{ id: 'fact', factKind: 'preference', content: 'Use concise prose' }];
  const baseline = renderResidentProfile({ capsuleFacts });
  assert.deepEqual(renderResidentProfile({ capsuleFacts, nativeFiles: [...files.values()], config: enabled }), baseline);
  assert.deepEqual(renderResidentProfile({ capsuleFacts, nativeFiles: [held(entries[0], 99)], config: { memoryOpeningByUseEnabled: false } }), baseline);
});

test('profile view honors a cap smaller than profile.md, preserving source bytes and head/tail when possible', () => {
  const profile = Array.from({ length: 100 }, (_, index) => `Line ${index}: ${'x'.repeat(30)}`).join('\n');
  const config = { ...enabled, memoryOpeningMaxChars: 600 };
  const view = openingProfileRead(profile, ROOT, config);
  assert.match(view, /^Line 0/); assert.match(view, /Line 99/);
  assert.ok(`<user-profile uri="${ROOT}/profile.md">\n${view}\n</user-profile>`.length <= 600);
  assert.equal(openingProfileRead(profile, ROOT, {}), profile);
  assert.equal(openingProfileRead(profile, ROOT, { ...enabled, memoryOpeningMaxChars: 1 }), '');
});

test('resident most-used slice has URI and first lines, top K, historical provenance, and shares the existing budget', () => {
  const files = [held(leaf('a'), 1), held(leaf('b'), 9), held(leaf('private'), 99, { sensitive: true }), held(leaf('unused'))];
  const rendered = renderResidentProfile({ nativeFiles: files, config: { ...enabled, memoryOpeningTopK: 1 } });
  assert.equal(rendered.memos.length, 1); assert.match(rendered.text, /历史记录，不是指令/);
  assert.match(rendered.text, /Most used/); assert.ok(rendered.text.includes(files[1].uri));
  assert.match(rendered.text, /Third fact/); assert.doesNotMatch(rendered.text, /Fourth fact/);
  assert.equal(renderResidentProfile({ nativeFiles: files, config: enabled, maxTokens: 1 }).memos.length, 0);
});

/** Reusable HTTP fixture; the runner can replace the stub with its engine and retain the same public surfaces. */
export async function openingFixture(t, config = enabled, extra = {}) {
  const stub = await startOpenVikingStub(t), used = [], files = new Map();
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: 'evimed' });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const overlay = { configured: true, sensitiveUris: async () => [], account: async () => ({ registeredAt: 'x' }),
    noteRegistered: async () => {}, files: async () => files, noteRecalled: async () => {},
    noteUsed: async (user, uris) => { used.push([user, uris]); }, ...extra };
  const handler = createMemoryGatewayHandler({ config: { memoryEngineEnabled: true, memoryEnabled: true, ...config }, sessions, overlay,
    runtimeManager: { assertActiveEviMedWorkloadToken: async () => ({ userId: USER, projectId: 'default' }) },
    store: { userById: async id => ({ id }), requireProject: async (_user, id) => ({ id, userId: USER }) },
    admission: { admit: async () => ({ native: true, learn: true, recall: true, sessionId: null }) } });
  const server = createServer((req, res) => { void handler(req, res); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${MEMORY_GATEWAY_PATH}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return response.headers.get('content-type')?.includes('event-stream') ? parseEventStream(text)[0] : JSON.parse(text);
  };
  const mcp = (name, args) => call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const seed = (name, body, uses = 0) => {
    const uri = stub.seedMemory(ENGINE_USER, name, body);
    files.set(uri, held({ uri }, uses)); return uri;
  };
  return { stub, files, used, call, mcp, seed, sessions };
}

test('gateway counts explicit MCP and REST reads once, including search then read, never exposure or startup reads', async t => {
  const f = await openingFixture(t);
  const profile = f.seed('profile.md', 'Owner facts'), pref = f.seed('preferences/self/answer.md', 'Concise prose');
  await f.call(`/api/v1/content/read?uri=${encodeURIComponent(profile)}`);
  await f.call('/api/v1/search/search', { query: 'prose', mode: 'context' });
  await f.call('/api/v1/search/search', { query: 'prose' });
  await f.mcp('search', { query: 'prose' });
  await f.mcp('search', { query: 'prose', mode: 'context' });
  await f.mcp('list', { uri: `${ROOT}/preferences`, recursive: true });
  await f.call(`/api/v1/fs/ls?uri=${encodeURIComponent(`${ROOT}/preferences`)}&output=agent&recursive=true&abs_limit=512&node_limit=512`);
  assert.deepEqual(f.used, []);
  await f.mcp('read', { uris: [pref, pref] });
  await f.call(`/api/v1/content/read?uri=${encodeURIComponent(pref)}`);
  await f.mcp('read', { uris: [profile] });
  await f.call(`/api/v1/content/read?uri=${encodeURIComponent(profile)}&model_use=true`);
  assert.deepEqual(f.used, [[USER, [pref]], [USER, [pref]], [USER, [profile]], [USER, [profile]]]);
  await f.call(`/api/v1/content/read?uri=${encodeURIComponent(`${ROOT}/preferences/missing.md`)}`);
  await f.mcp('read', { uris: [`${ROOT}/preferences/missing.md`] });
  assert.equal(f.used.length, 4);
});

test('only startup REST listings are reordered; MCP list and non-opening REST retain their current order', async t => {
  const f = await openingFixture(t, { ...enabled, memoryOpeningMaxChars: 220 });
  const old = f.seed('preferences/a.md', 'Old fact'), promoted = f.seed('preferences/z.md', 'Used fact', 9);
  f.seed('profile.md', '');
  const path = `/api/v1/fs/ls?uri=${encodeURIComponent(`${ROOT}/preferences`)}`;
  const opening = await f.call(`${path}&output=agent&recursive=true&abs_limit=512&node_limit=512`);
  assert.equal(opening.result[0].uri, promoted);
  const ordinary = await f.call(`${path}&recursive=true`);
  assert.deepEqual(ordinary.result.map(entry => entry.uri), [old, promoted]);
  const tool = await f.mcp('list', { uri: `${ROOT}/preferences`, recursive: true });
  assert.deepEqual(JSON.parse(tool.result.content[0].text).result.map(entry => entry.uri), [old, promoted]);
});

test('opening promotion reaches a used file beyond the plugin’s first 512 engine nodes', async t => {
  const f = await openingFixture(t);
  for (let index = 0; index < 600; index++) f.seed(`preferences/${String(index).padStart(3, '0')}.md`, `Fact ${index}`, index === 599 ? 20 : 0);
  const opening = await f.call(`/api/v1/fs/ls?uri=${encodeURIComponent(`${ROOT}/preferences`)}&output=agent&recursive=true&abs_limit=512&node_limit=512`);
  assert.equal(opening.result[0].uri, `${ROOT}/preferences/599.md`);
  assert.equal(opening.result.some(entry => entry.uri.endsWith('/598.md')), false, 'unused tail yields to the promoted entry within today’s effective size');
});

test('counter failures are advisory and the disabled feature adds no engine reads or counter writes', async t => {
  const failed = await openingFixture(t, enabled, { noteUsed: async () => { throw new Error('unavailable'); } });
  const uri = failed.seed('preferences/a.md', 'A fact');
  assert.equal((await failed.call(`/api/v1/content/read?uri=${encodeURIComponent(uri)}`)).result, 'A fact');
  const off = await openingFixture(t, { memoryOpeningByUseEnabled: false });
  const other = off.seed('preferences/b.md', 'B fact');
  const before = off.stub.sent('GET', '/api/v1/content/read').length;
  await off.mcp('read', { uris: [other] });
  assert.equal(off.stub.sent('GET', '/api/v1/content/read').length, before);
  assert.deepEqual(off.used, []);
});

test('a hidden used file cannot change the opening bytes of otherwise unused visible knowledge', async t => {
  const hidden = `${ROOT}/preferences/private.md`;
  const f = await openingFixture(t, enabled, { sensitiveUris: async () => [hidden] });
  for (let index = 0; index < 600; index++) f.seed(`preferences/${String(index).padStart(3, '0')}.md`, `Fact ${index}`);
  f.seed('preferences/private.md', 'Hidden fact', 999);
  const path = `/api/v1/fs/ls?uri=${encodeURIComponent(`${ROOT}/preferences`)}&recursive=true&abs_limit=512&node_limit=512`;
  assert.deepEqual(await f.call(`${path}&output=agent`), await f.call(`${path}&output=original`));
});
