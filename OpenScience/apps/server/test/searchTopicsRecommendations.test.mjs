import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { validateFeed } from '@evimed/dsh-search-topics/contract';
import { SEARCH_TOPICS_MAX_BYTES as MAX_FEED_BYTES } from '../src/searchTopicsRuntime.mjs';
import { SearchTopicsRecommendations, SEARCH_TOPICS_CANDIDATES_SQL, selectSearchTopics, trialRecommendationCandidates } from '../src/searchTopicsRecommendations.mjs';
import { createSearchTopicsRoutes } from '../src/searchTopicsRoutes.mjs';

const NOW = new Date('2026-10-30T08:00:00.000Z');
const CATEGORIES = ['literature', 'guidelines', 'drugs', 'trials'];
const reference = (id = 'paper-1', overrides = {}) => ({ id, title: 'Published medical development', url: `https://example.org/evidence/${id}`,
  source: 'Medical journal', publishedAt: '2026-10-29T08:00:00.000Z', timelineAt: '2026-10-29T08:00:00.000Z', datePrecision: 'instant', ...overrides });
const candidate = (tagId, overrides = {}) => ({ category: 'literature', tag_id: tagId, name: `Disease ${tagId}`, event_count: 5,
  source_count: 7, activity: 3, latest_at: '2026-10-29T08:00:00.000Z', event_keys: [`event:${tagId}`], sources: [reference(`paper-${tagId}`)], ...overrides });

async function fixture(t) {
  const root = await realpath(await mkdtemp('/tmp/search-topics-recommendations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { version: 1, candidateCalls: 0, transactions: 0, fail: false, lock: true, rows: CATEGORIES.filter(category => category !== 'trials').map((category, index) => candidate(index + 1, { category })), delay: null,
    trialCalls: 0, trialFail: false, trialRows: [{ id: 'NCT12345678', title: 'Interventional registered study', conditions: ['Hypertension'], updatedDate: '2026-10-29',
      url: 'https://clinicaltrials.gov/study/NCT12345678' }] };
  const database = {
    async query(sql) {
      if (state.fail) throw new Error('private source password must never be returned');
      if (sql.includes('SELECT key, value')) return { rows: [{ key: 'content_version', value: state.version }, { key: 'tags_version', value: 1 }] };
      if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: state.lock }] };
      if (sql === SEARCH_TOPICS_CANDIDATES_SQL) {
        state.candidateCalls++;
        if (state.delay) await state.delay;
        return { rows: state.rows };
      }
      return { rows: [] };
    },
    async transaction(work) { state.transactions++; return work(database); },
    withoutTransactionClient(work) { return work(); },
  };
  let now = new Date(NOW);
  const service = new SearchTopicsRecommendations({ database, config: { dataDir: root }, now: () => now,
    trialSource: { read: async () => { state.trialCalls++; if (state.trialFail) throw new Error('Registry read failed'); return { records: state.trialRows }; } } });
  return { root, state, service, setNow: value => { now = new Date(value); }, read: async () => JSON.parse(await readFile(service.file, 'utf8')) };
}

test('ranking uses real activity and source breadth with stable ties, and avoids repeated evidence sets', () => {
  const rows = [candidate(6, { activity: 2 }), candidate(4, { event_keys: ['shared'] }), candidate(3, { event_keys: ['shared'] }),
    candidate(2, { activity: 3, source_count: 9 }), candidate(1, { activity: 5 }), candidate(9, { category: 'drugs', activity: 50 })];
  const result = selectSearchTopics(rows, NOW);
  assert.deepEqual(result.literature.map(row => row.id), ['frontier-literature-1', 'frontier-literature-2', 'frontier-literature-3', 'frontier-literature-6']);
  assert.equal(result.drugs[0].id, 'frontier-drugs-9');
  assert.equal(result.literature[0].basis.sourceCount, 7, 'independent institutions can outnumber distinct events');
  assert.equal(result.literature[0].basis.eventCount, 5);
});

test('evidence projection rejects private addresses and future/out-of-window rows, and distinguishes observed dates', () => {
  const source = reference('observed', { publishedAt: '2026-11-01T00:00:00.000Z', datePrecision: 'inferred' });
  const rows = [candidate(1, { sources: [reference('private', { url: 'http://127.0.0.1/private' }), reference('future', { timelineAt: '2026-11-01T00:00:00.000Z' }), source] }),
    candidate(2, { sources: [reference('old', { timelineAt: '2026-09-01T00:00:00.000Z' })] })];
  const topics = selectSearchTopics(rows, NOW).literature;
  assert.equal(topics.length, 1);
  assert.deepEqual(topics[0].basis.sources.map(row => row.id), ['observed']);
  assert.equal(topics[0].basis.sources[0].publishedAt, null);
  assert.equal(topics[0].basis.sources[0].dateBasis, 'observed');
  const clamped = selectSearchTopics([candidate(3, { sources: [reference('clock-skew', {
    publishedAt: '2026-10-29T09:00:00.000Z', timelineAt: '2026-10-29T08:00:00.000Z',
  })] })], NOW).literature[0].basis.sources[0];
  assert.equal(clamped.publishedAt, null, 'a source time ahead of its normalized visible time is not represented as a known publication');
  assert.equal(clamped.dateBasis, 'observed');
});

test('one atomic publication covers four categories and concurrent requests share a refresh', async t => {
  const f = await fixture(t);
  let release;
  f.state.delay = new Promise(resolve => { release = resolve; });
  const first = f.service.ensureCurrent(), second = f.service.ensureCurrent();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(a.stale, false); assert.equal(f.state.candidateCalls, 1);
  const feed = validateFeed(await f.read());
  assert.deepEqual(Object.keys(feed.categories), CATEGORIES);
  assert.equal(feed.source.isExample, false); assert.equal(feed.source.kind, 'provider');
  assert.equal(feed.recommendation.generatedAt, NOW.toISOString());
  assert.ok(CATEGORIES.every(category => feed.categories[category].length === 1));
  assert.deepEqual(await readdir(f.service.directory), ['topics.json'], 'a successful publication leaves no partial generation');
});

test('fresh generations are reused, content changes invalidate them, and the clock refreshes after five minutes', async t => {
  const f = await fixture(t);
  await f.service.ensureCurrent(); await f.service.ensureCurrent();
  assert.equal(f.state.candidateCalls, 1);
  assert.equal(f.state.trialCalls, 1, 'a cache hit does not requery the public registry');
  f.state.version++;
  f.state.rows[0].name = 'New published topic';
  await f.service.ensureCurrent();
  assert.equal(f.state.candidateCalls, 2); assert.equal((await f.read()).categories.literature[0].query, 'New published topic');
  f.setNow('2026-10-30T08:05:01.000Z');
  await f.service.ensureCurrent(); assert.equal(f.state.candidateCalls, 3);
});

test('a temporary failure serves only a real generation for at most 24 hours with explicit stale status', async t => {
  const f = await fixture(t);
  await f.service.ensureCurrent(); const bytes = await readFile(f.service.file, 'utf8');
  f.state.fail = true;
  assert.equal((await f.service.ensureCurrent()).stale, true);
  assert.equal(await readFile(f.service.file, 'utf8'), bytes, 'a failure does not overwrite the last real generation');
  f.setNow('2026-10-31T08:00:01.000Z');
  await assert.rejects(f.service.ensureCurrent(), error => error.code === 'evimed_search_topics_unavailable' && !error.message.includes('password'));
});

test('an example source is never a recovery fallback and an empty real corpus is honestly empty', async t => {
  const f = await fixture(t);
  await mkdir(f.service.directory, { recursive: true });
  const example = { schemaVersion: 1, updatedAt: null, source: { kind: 'curated', label: 'Example topics', isExample: true },
    categories: Object.fromEntries(CATEGORIES.map(category => [category, []])) };
  await writeFile(f.service.file, JSON.stringify(example)); f.state.fail = true;
  await assert.rejects(f.service.ensureCurrent(), { code: 'evimed_search_topics_unavailable' });
  f.state.fail = false; f.state.rows = []; f.state.trialRows = [];
  await f.service.ensureCurrent();
  const real = await f.read(); assert.equal(real.source.isExample, false); assert.equal(real.recommendation.dataThrough, null);
  assert.ok(Object.values(real.categories).every(rows => rows.length === 0));
});

test('a competing publisher never causes a second write and may serve the prior real generation', async t => {
  const f = await fixture(t);
  await f.service.ensureCurrent(); const bytes = await readFile(f.service.file, 'utf8');
  f.state.version++; f.state.lock = false;
  assert.equal((await f.service.ensureCurrent()).stale, true);
  assert.equal(f.state.candidateCalls, 1); assert.equal(await readFile(f.service.file, 'utf8'), bytes);
});

test('publication refuses symbolic links in source files and directory components', async t => {
  const f = await fixture(t);
  await mkdir(f.service.directory, { recursive: true });
  const outside = path.join(f.root, 'outside.json'); await writeFile(outside, '{}');
  await symlink(outside, f.service.file);
  await assert.rejects(f.service.ensureCurrent(), { code: 'evimed_search_topics_unavailable' });
  assert.equal(await readFile(outside, 'utf8'), '{}');
  await rm(f.service.directory, { recursive: true });
  await symlink(f.root, f.service.directory);
  await assert.rejects(f.service.ensureCurrent(), { code: 'evimed_search_topics_unavailable' });
});

test('all published responses respect the byte budget while retained topics keep real counts and citations', async t => {
  const f = await fixture(t);
  f.state.rows = CATEGORIES.filter(category => category !== 'trials').flatMap(category => Array.from({ length: 12 }, (_, index) => candidate(index + 1, { category,
    event_keys: [`event:${category}:${index}`], sources: Array.from({ length: 3 }, (_, n) => reference(`paper-${index}-${n}`, {
      url: `https://example.org/${'a'.repeat(1900)}/${index}/${n}`, title: 'Evidence '.repeat(25).trim(), source: 'Journal '.repeat(15).trim(),
    })) })));
  await f.service.ensureCurrent();
  const bytes = await readFile(f.service.file); assert.ok(bytes.length <= MAX_FEED_BYTES);
  const feed = validateFeed(JSON.parse(bytes.toString()));
  for (const category of CATEGORIES) for (const topic of feed.categories[category]) {
    assert.equal(topic.basis.eventCount, category === 'trials' ? 1 : 5); assert.equal(topic.basis.sourceCount, category === 'trials' ? 1 : 7); assert.ok(topic.basis.sources.length >= 1);
  }
});

test('authentication and project access precede publication, and the route exposes recovery status', async () => {
  const calls = [], user = { id: 'alice' }, project = { id: 'paper' };
  const store = { ensureSessionUser: async () => { calls.push('auth'); return { user }; }, assertCsrf: async () => calls.push('csrf'),
    requireProject: async () => { calls.push('project'); return project; } };
  const handler = createSearchTopicsRoutes({ store, ensureCurrent: async () => { calls.push('publish'); return { stale: true, generatedAt: NOW.toISOString(), corpusVersion: 'version' }; },
    runtimeManager: { searchTopicsFor: async () => { calls.push('runtime'); return { source: { kind: 'provider', isExample: false },
      recommendation: { stale: false, generatedAt: NOW.toISOString(), corpusVersion: 'version' } }; } } });
  const req = Readable.from([]); req.url = '/api/projects/paper/evimed-search/topics?category=literature'; req.method = 'GET';
  let body; const res = { setHeader() {}, writeHead() {}, end(bytes) { body = JSON.parse(String(bytes)); } };
  await handler(req, res); assert.deepEqual(calls, ['auth', 'csrf', 'project', 'publish', 'runtime']); assert.equal(body.data.recommendation.stale, true);
  calls.length = 0; store.requireProject = async () => { throw new Error('denied'); };
  await assert.rejects(handler(req, res), /denied/u); assert.equal(calls.includes('publish'), false);
});

test('trial recommendations group genuine updated NCT records and reuse active disease aliases', () => {
  const study = (id, conditions, updatedDate = '2026-10-29') => ({ id, conditions, updatedDate, title: 'Registered clinical study',
    url: `https://clinicaltrials.gov/study/${id}` });
  const vocabulary = { byName: value => ['Type 2 diabetes', 'Diabetes Mellitus, Type 2'].includes(value)
    ? { id: 9, name: '2型糖尿病', kind: 'disease', state: 'active' } : null };
  const result = trialRecommendationCandidates({ records: [study('NCT12345678', ['Type 2 diabetes', 'Diabetes Mellitus, Type 2']),
    study('NCT12345679', ['Diabetes Mellitus, Type 2']), study('NCT12345678', ['Type 2 diabetes']),
    study('PREPARE-2026CN1', ['Type 2 diabetes']), study('NCT12345670', ['Older condition'], '2026-09-01')] }, NOW, vocabulary);
  assert.equal(result.length, 1); assert.equal(result[0].name, '2型糖尿病'); assert.equal(result[0].event_count, 2);
  assert.equal(result[0].source_count, 1);
  const topics = selectSearchTopics(result, NOW).trials;
  assert.equal(topics.length, 1); assert.equal(topics[0].basis.sources[0].dateBasis, 'updated');
  assert.equal(topics[0].basis.sources[0].publishedAt, null);
  assert.ok(topics[0].description.includes('2项试验更新'));
});

test('a public registry outage keeps the prior real generation explicitly stale and never publishes an empty substitute', async t => {
  const f = await fixture(t);
  f.state.trialRows = [{ id: 'NCT12345678', title: 'Registered study', conditions: ['Hypertension'], updatedDate: '2026-10-29',
    url: 'https://clinicaltrials.gov/study/NCT12345678' }];
  await f.service.ensureCurrent(); const before = await readFile(f.service.file, 'utf8');
  f.setNow('2026-10-30T08:06:00.000Z'); f.state.trialFail = true;
  assert.equal((await f.service.ensureCurrent()).stale, true); assert.equal(await readFile(f.service.file, 'utf8'), before);
  assert.ok((await f.read()).categories.trials.some(row => row.query === 'Hypertension'));
  assert.equal(f.state.transactions, 1, 'the failed external fetch never holds a database transaction');
});

test('a pre-interventional mixed-study snapshot cannot return as stale during a registry outage', async t => {
  const f = await fixture(t);
  await f.service.ensureCurrent();
  const old = await f.read();
  assert.match(old.recommendation.corpusVersion, /^clinicaltrials-v2-interventional:[a-f0-9]{64}$/u);
  old.recommendation.corpusVersion = old.recommendation.corpusVersion.split(':')[1];
  await writeFile(f.service.file, JSON.stringify(old));
  f.state.trialFail = true;
  await assert.rejects(f.service.ensureCurrent(), { code: 'evimed_search_topics_unavailable' });
});

test('the project route retries a publication race once and refuses examples or mismatched generations', async () => {
  const req = Readable.from([]); req.url = '/api/projects/paper/evimed-search/topics?category=literature'; req.method = 'GET';
  const store = { ensureSessionUser: async () => ({ user: {} }), assertCsrf: async () => {}, requireProject: async () => ({}) };
  let reads = 0, writes = 0, body;
  const handler = createSearchTopicsRoutes({ store, ensureCurrent: async () => ({ generatedAt: NOW.toISOString(), corpusVersion: String(++writes), stale: false }),
    runtimeManager: { searchTopicsFor: async () => ({ source: { kind: 'provider', isExample: false },
      recommendation: { generatedAt: NOW.toISOString(), corpusVersion: String(++reads + (reads === 1 ? 1 : 0)), stale: false } }) } });
  const res = { setHeader() {}, writeHead() {}, end(bytes) { body = JSON.parse(String(bytes)); } };
  await handler(req, res); assert.equal(reads, 2); assert.equal(body.data.recommendation.corpusVersion, '2');
  const example = createSearchTopicsRoutes({ store, ensureCurrent: async () => ({ generatedAt: NOW.toISOString(), corpusVersion: '1', stale: false }),
    runtimeManager: { searchTopicsFor: async () => ({ source: { kind: 'curated', isExample: true }, recommendation: null }) } });
  await assert.rejects(example(req, res), { code: 'evimed_search_topics_unavailable' });
});
