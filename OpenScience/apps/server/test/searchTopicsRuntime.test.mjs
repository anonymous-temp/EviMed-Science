import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createTopicsHandler } from '../../../packages/search-topics/src/topics.mjs';
import { loadConfig } from '../src/config.mjs';
import { RuntimeManager, buildRuntimeLaunchPlan, syncRuntimeDshProfile } from '../src/runtimeManager.mjs';
import { searchTopicsSource, projectSearchTopics, SEARCH_TOPICS_TOKEN_FILE, searchTopicsQuery, supportsSearchTopicRecommendations } from '../src/searchTopicsRuntime.mjs';
import { createSearchTopicsRoutes } from '../src/searchTopicsRoutes.mjs';
import { createInventoryRoutes } from '../src/inventoryRoutes.mjs';
import { createRuntimeController } from '../src/runtimeControllerServer.mjs';
import { RuntimeControllerClient } from '../src/runtimeControllerClient.mjs';
import { HttpError } from '../src/security.mjs';

const feed = () => ({ schemaVersion: 1, updatedAt: null, source: { kind: 'curated', label: 'Example topics', isExample: true },
  categories: { literature: [{ id: 'example', query: 'Hypertension', description: 'Example research topic' }], guidelines: [], drugs: [], trials: [] } });

async function fixture(t) {
  const root = await realpath(await mkdtemp('/tmp/evt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.openscience', 'search-topics'), file = path.join(directory, 'topics.json');
  const projectRoot = path.join(root, 'users', 'alice', 'projects', 'paper');
  const project = { id: 'paper', userId: 'alice', rootDir: projectRoot, workspaceDir: path.join(projectRoot, 'workspace'), runtimeDir: path.join(projectRoot, 'runtime') };
  await mkdir(directory, { recursive: true }); await mkdir(project.workspaceDir, { recursive: true });
  await writeFile(file, JSON.stringify(feed()));
  const config = { dataDir: root, searchTopicsEnabled: true, runtimeSandboxMode: 'docker', runtimeContainerBin: '/usr/bin/false',
    runtimeContainerImage: 'example:topics', runtimeTransport: 'unix', runtimeNetworkMode: 'none', runtimeCpuLimit: '1', runtimeMemoryLimit: '1g',
    runtimePidsLimit: 64, production: false, deepseekModel: 'deepseek-flash', deepseekProviderEnabled: false,
    modelGatewayInternalUrl: 'http://127.0.0.1:8787/internal/model/v1', runtimeProxyConnectTimeoutMs: 1000 };
  return { root, project, config, directory, file };
}

test('search topics default off and require an operator-owned regular source at the configured data location', async t => {
  const saved = process.env.OPEN_SCIENCE_SEARCH_TOPICS_ENABLED;
  try {
    delete process.env.OPEN_SCIENCE_SEARCH_TOPICS_ENABLED;
    assert.equal(loadConfig().searchTopicsEnabled, false);
    process.env.OPEN_SCIENCE_SEARCH_TOPICS_ENABLED = 'true';
    assert.equal(loadConfig().searchTopicsEnabled, true);
    assert.equal(loadConfig({ searchTopicsEnabled: false }).searchTopicsEnabled, false);
  } finally { if (saved === undefined) delete process.env.OPEN_SCIENCE_SEARCH_TOPICS_ENABLED; else process.env.OPEN_SCIENCE_SEARCH_TOPICS_ENABLED = saved; }
  const f = await fixture(t);
  assert.deepEqual(searchTopicsSource(f.config), { directory: f.directory, file: f.file });
  assert.equal(searchTopicsSource({ ...f.config, searchTopicsEnabled: false }), null);
  assert.equal(searchTopicsSource({ ...f.config, runtimeSandboxMode: 'agentbay' }), null);
  await rename(f.file, `${f.file}.saved`); await symlink(`${f.file}.saved`, f.file);
  assert.equal(searchTopicsSource(f.config), null, 'a replaced source cannot follow a symbolic link');
});

test('a supported image mounts the source directory read-only and carries only paths, while an old image stays disabled', async t => {
  const f = await fixture(t);
  const plan = buildRuntimeLaunchPlan(f.config, f.project, 12345, { installedSearchTopicsVersion: '0.2.0' });
  assert.ok(plan.args.includes(`type=bind,src=${f.directory},dst=/opt/evimed/search-topics-data,readonly`));
  assert.ok(plan.args.includes('EVIMED_SEARCH_TOPICS_ENABLED=1'));
  assert.ok(plan.args.includes('EVIMED_SEARCH_TOPICS_FILE=/opt/evimed/search-topics-data/topics.json'));
  assert.ok(plan.args.includes('EVIMED_SEARCH_TOPICS_TOKEN_FILE=/runtime/dsh-home/search-topics.token'));
  assert.equal(plan.searchTopics.file, f.file);
  const volume = buildRuntimeLaunchPlan({ ...f.config, runtimeDataVolume: 'topics-data' }, f.project, 12345, { installedSearchTopicsVersion: '0.2.0' });
  assert.ok(volume.args.includes('type=volume,src=topics-data,dst=/opt/evimed/search-topics-data,volume-subpath=.openscience/search-topics,readonly'));
  for (const config of [f.config, { ...f.config, searchTopicsEnabled: false }]) {
    const old = buildRuntimeLaunchPlan(config, f.project, 12345, { installedSearchTopicsVersion: '' });
    assert.equal(old.searchTopics, null); assert.ok(old.args.includes('EVIMED_SEARCH_TOPICS_ENABLED=0'));
    assert.equal(old.args.some(arg => arg.includes('EVIMED_SEARCH_TOPICS_TOKEN_FILE=')), false);
    assert.equal(old.args.some(arg => arg.includes('dst=/opt/evimed/search-topics-data')), false);
  }
  const obsolete = buildRuntimeLaunchPlan(f.config, f.project, 12345, { installedSearchTopicsVersion: '0.1.0' });
  assert.equal(obsolete.searchTopics, null, 'an old installed plugin cannot claim the source-backed contract');
  assert.ok(obsolete.args.includes('EVIMED_SEARCH_TOPICS_ENABLED=0'));
});

test('recommendations require the installed provenance contract rather than an arbitrary version label', () => {
  for (const version of ['0.2.0', '0.2.1', '0.3.0', '1.0.0']) assert.equal(supportsSearchTopicRecommendations(version), true, version);
  for (const version of ['', '0.1.0', '0.1.99', '0.2.0-rc.1', 'garbage', '00.2.0', null]) {
    assert.equal(supportsSearchTopicRecommendations(version), false, String(version));
  }
});

test('bootstrap mints a separate private credential for each runtime launch without handing it to public configuration', async t => {
  const f = await fixture(t);
  const plan = buildRuntimeLaunchPlan(f.config, f.project, 12345, { installedSearchTopicsVersion: '0.2.0' });
  const first = await syncRuntimeDshProfile(f.config, f.project, plan);
  const tokenFile = path.join(plan.dshHomeDir, SEARCH_TOPICS_TOKEN_FILE), token = (await readFile(tokenFile, 'utf8')).trim();
  assert.match(token, /^[a-f0-9]{96}$/); assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(first).includes(token), false);
  assert.equal((await readFile(path.join(plan.dshHomeDir, '.credentials.yaml'), 'utf8')).includes(token), false);
  await syncRuntimeDshProfile(f.config, f.project, plan);
  assert.notEqual((await readFile(tokenFile, 'utf8')).trim(), token);
});

test('inventory checks never start a runtime and do not mistake a live old image for an active installation', async t => {
  const f = await fixture(t), manager = Object.create(RuntimeManager.prototype);
  manager.config = f.config; manager.runtimes = new Map();
  manager.inspectRuntimeImage = async () => ({ searchTopicsVersion: '0.2.0' });
  manager.start = async () => { throw new Error('inventory must not start'); };
  assert.equal(await manager.searchTopicsAvailable(f.project), true);
  manager.runtimes.set(manager.key(f.project), { searchTopics: null });
  assert.equal(await manager.searchTopicsAvailable(f.project), false);
  manager.runtimes.set(manager.key(f.project), { searchTopics: { version: '0.2.0', file: f.file } });
  assert.equal(await manager.searchTopicsAvailable(f.project), true);
  manager.runtimes.set(manager.key(f.project), { searchTopics: { version: '0.1.0', file: f.file } });
  assert.equal(await manager.searchTopicsAvailable(f.project), false, 'a live old image is not ready for recommendations');
  manager.runtimes.clear(); manager.inspectRuntimeImage = async () => ({ imageId: 'old' });
  assert.equal(await manager.searchTopicsAvailable(f.project), false);
  manager.inspectRuntimeImage = async () => ({ searchTopicsVersion: '0.1.0' });
  assert.equal(await manager.searchTopicsAvailable(f.project), false);
  manager.inspectRuntimeImage = async () => { throw new Error('private implementation diagnostic'); };
  assert.equal(await manager.searchTopicsAvailable(f.project), false);
});

test('the isolated controller reports the optional installed bundle label without assuming it on old images', async t => {
  const f = await fixture(t), bin = path.join(f.root, 'image-inspector.mjs'), versionFile = path.join(f.root, 'installed-version');
  const { version } = JSON.parse(await readFile(new URL('../../../packages/search-topics/package.json', import.meta.url), 'utf8'));
  await writeFile(versionFile, version);
  await writeFile(bin, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), format = args[args.indexOf('--format') + 1] ?? '';
const version = fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8').trim();
process.stdout.write(format.split('|').map(field => field === '{{.Id}}' ? 'sha256:' + 'a'.repeat(64)
  : field.includes('search-topics.version') ? version : field.includes('runtime.kernel') ? 'dsh' : 'fixture').join('|'));
`, { mode: 0o755 });
  const socketPath = path.join(f.root, 'controller.sock');
  const controller = createRuntimeController({ ...f.config, runtimeContainerBin: bin, runtimeControllerSocket: socketPath });
  await controller.listen(); t.after(() => controller.close());
  const client = new RuntimeControllerClient({ runtimeControllerSocket: socketPath });
  assert.equal((await client.inspectRuntimeImage()).searchTopicsVersion, version);
  await writeFile(versionFile, '<no value>');
  assert.equal((await client.inspectRuntimeImage()).searchTopicsVersion, '');
});

test('the control plane calls the real plugin with its separate credential and observes atomic feed replacements', async t => {
  const f = await fixture(t), manager = Object.create(RuntimeManager.prototype);
  const plan = buildRuntimeLaunchPlan(f.config, f.project, 12345, { installedSearchTopicsVersion: '0.2.0' });
  await syncRuntimeDshProfile(f.config, f.project, plan);
  const tokenFile = path.join(plan.dshHomeDir, SEARCH_TOPICS_TOKEN_FILE);
  const handler = createTopicsHandler({ topicsFile: f.file, tokenFile });
  const seen = [];
  const server = createServer((req, res) => { seen.push(req.headers); void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const runtime = { url: `http://127.0.0.1:${server.address().port}`, cookie: 'browser-secret-must-not-forward',
    searchTopics: { ...plan.searchTopics, tokenFile, tokenRoot: f.project.rootDir } };
  manager.config = f.config; manager.runtimes = new Map([[manager.key(f.project), runtime]]);
  manager.start = async actual => { assert.equal(actual, f.project); return runtime; };
  let active = 0; manager.beginProxy = () => active++; manager.endProxy = () => active--;
  const result = await manager.searchTopicsFor(f.project, { category: 'literature', limit: 3 });
  assert.equal(result.topics[0].query, 'Hypertension'); assert.equal(active, 0);
  assert.equal(seen[0].authorization, `Bearer ${(await readFile(tokenFile, 'utf8')).trim()}`);
  assert.equal(seen[0].cookie, undefined, 'the native plugin needs no browser cookie or provider authorization');
  assert.equal(JSON.stringify(result).includes('Bearer'), false);
  const updated = feed(); updated.categories.literature[0].query = 'Updated topic';
  await writeFile(`${f.file}.next`, JSON.stringify(updated)); await rename(`${f.file}.next`, f.file);
  assert.equal((await manager.searchTopicsFor(f.project, { category: 'literature', limit: 3 })).topics[0].query, 'Updated topic');
  updated.categories.literature[0].description = (await readFile(tokenFile, 'utf8')).trim();
  await writeFile(f.file, JSON.stringify(updated));
  await assert.rejects(manager.searchTopicsFor(f.project, { category: 'literature', limit: 3 }), { code: 'evimed_search_topics_unavailable' });
  await writeFile(f.file, 'invalid');
  await assert.rejects(manager.searchTopicsFor(f.project, { category: 'literature', limit: 3 }), error => error.code === 'evimed_search_topics_unavailable' && !error.message.includes(f.file));
  assert.equal(active, 0);
});

function routeFixture() {
  const user = { id: 'alice' }, project = { id: 'paper', userId: user.id }, calls = [];
  const store = { ensureSessionUser: async (_req, _res, options) => { assert.equal(options.allowDevAuth, false); calls.push('auth'); return { user }; },
    assertCsrf: async () => calls.push('csrf'), requireProject: async (actor, id) => { assert.equal(actor, user); calls.push('project'); if (id !== project.id) throw new HttpError(404, 'project_not_found', 'missing'); return project; } };
  const runtimeManager = { searchTopicsFor: async (actual, query) => { assert.equal(actual, project); calls.push('proxy'); return { category: query.category, topics: [] }; } };
  const handler = createSearchTopicsRoutes({ store, runtimeManager });
  return { handler, store, user, project, calls };
}

async function request(f, url = '/api/projects/paper/evimed-search/topics?category=literature&limit=3', method = 'GET') {
  const req = Readable.from([]); req.url = url; req.method = method; req.headers = {};
  let data; const headers = {}, res = { setHeader: (key, value) => { headers[key] = value; }, writeHead: status => { res.status = status; }, end: bytes => { data = JSON.parse(String(bytes)); } };
  return { handled: await f.handler(req, res), data, headers, status: res.status };
}

test('topic routes enforce session and project access before the native request, with a closed query shape', async () => {
  const f = routeFixture(); const result = await request(f);
  assert.deepEqual(f.calls, ['auth', 'csrf', 'project', 'proxy']); assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'no-store');
  for (const url of ['/api/projects/foreign/evimed-search/topics?category=literature', '/api/projects/paper/evimed-search/topics?category=literature&category=drugs',
    '/api/projects/paper/evimed-search/topics?category=literature&url=http://private', '/api/projects/paper/evimed-search/topics?category=literature&limit=13']) {
    const denied = routeFixture(); await assert.rejects(request(denied, url)); assert.equal(denied.calls.includes('proxy'), false);
  }
  await assert.rejects(request(f, undefined, 'POST'), { status: 405 });
  f.store.ensureSessionUser = async () => { throw new HttpError(401, 'unauthorized', 'login'); };
  await assert.rejects(request(f), { status: 401 });
  assert.equal((await request(routeFixture(), '/something-else')).handled, false);
});

test('topic results are projected to the public contract and reject malformed upstream cards', () => {
  const value = { schemaVersion: 1, category: 'literature', topics: feed().categories.literature, count: 1, total: 1, updatedAt: null,
    revision: 'f'.repeat(64), source: feed().source, tokenFile: '/private/secret', serviceToken: 'must-not-forward' };
  const result = projectSearchTopics(value, { category: 'literature', limit: 3 });
  assert.equal(JSON.stringify(result).includes('must-not-forward'), false); assert.equal('tokenFile' in result, false);
  for (const patch of [{ count: 2 }, { category: 'drugs' }, { topics: [{ id: 'bad', query: '', description: 'bad' }] }, { revision: 'invalid' }]) {
    assert.throws(() => projectSearchTopics({ ...value, ...patch }, { category: 'literature', limit: 3 }), { code: 'evimed_search_topics_unavailable' });
  }
  assert.deepEqual(searchTopicsQuery(new URLSearchParams('category=guidelines')), { category: 'guidelines', limit: 3 });
});

test('the public projection preserves verifiable corpus references and rejects unsafe or fabricated source facts', () => {
  const at = '2026-10-30T09:00:00.000Z';
  const value = { schemaVersion: 1, category: 'literature', count: 1, total: 1, updatedAt: at, revision: 'a'.repeat(64),
    source: { kind: 'provider', label: 'Collected recent topics', isExample: false },
    recommendation: { algorithm: 'recent-medical-topics-v1', windowDays: 30, generatedAt: at, dataThrough: at, stale: true, corpusVersion: 'corpus-1' },
    topics: [{ id: 'tag-1', query: 'A source-backed topic', description: 'One collected event, three reporting institutions',
      basis: { eventCount: 1, sourceCount: 3, latestAt: at, sources: [{ id: 'reference-1', title: 'A public source',
        url: 'https://example.org/evidence/1', source: 'A reporting institution', publishedAt: null, timelineAt: at, dateBasis: 'observed' }] } }] };
  const projected = projectSearchTopics(value, { category: 'literature', limit: 3 });
  assert.deepEqual(projected.recommendation, value.recommendation);
  assert.deepEqual(projected.topics[0].basis, value.topics[0].basis);
  assert.equal(projected.topics[0].basis.sources[0].publishedAt, null, 'observation is not a publication date');
  for (const change of [
    row => { row.topics[0].basis.sources[0].url = 'http://localhost/private'; },
    row => { row.topics[0].basis.sources[0].url = 'https://credential:secret@example.org/'; },
    row => { delete row.topics[0].basis; },
    row => { row.recommendation.generatedAt = '2026-02-30T09:00:00.000Z'; },
    row => { row.source.isExample = true; },
  ]) {
    const invalid = structuredClone(value); change(invalid);
    assert.throws(() => projectSearchTopics(invalid, { category: 'literature', limit: 3 }), { status: 502, code: 'evimed_search_topics_unavailable' });
  }
});

test('plugin inventory lists topic recommendations only on explicit verified installation facts and propagates authorization failures', async () => {
  const f = routeFixture();
  const inventory = available => ({ ...f, handler: createInventoryRoutes({ store: f.store, pluginService: null, config: {}, searchTopicsAvailable: available }) });
  const rows = result => result.data.data.groups.flatMap(group => group.items);
  assert.equal(rows(await request(inventory(async () => false), '/api/projects/paper/inventory')).some(row => row.id === 'search-topics'), false);
  const on = rows(await request(inventory(async (user, project) => { assert.equal(user, f.user); assert.equal(project, f.project); return true; }), '/api/projects/paper/inventory'));
  assert.equal(on.find(row => row.id === 'search-topics')?.state, 'on');
  assert.equal(rows(await request(inventory(async () => { throw new Error('/private/diagnostic'); }), '/api/projects/paper/inventory')).some(row => row.id === 'search-topics'), false);
  await assert.rejects(request(inventory(async () => { throw new HttpError(403, 'forbidden', 'denied'); }), '/api/projects/paper/inventory'), { status: 403 });
});
