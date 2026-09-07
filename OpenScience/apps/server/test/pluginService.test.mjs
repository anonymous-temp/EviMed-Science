import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  APPLY_PATH_PLUGIN_IDS, PLUGIN_ID, PLUGIN_REGISTRY, PLUGIN_SUPPORT_SNAPSHOT, PLUGIN_VERSION, PluginService,
  exportPluginPayload, pluginAvailability, pluginEntry, pluginRegistryFrom, pluginState,
  projectPluginId, removalConfiguration, validatePluginConfig,
} from '../src/pluginService.mjs';
import { pluginAvailabilityRecord, pluginCompatibilityRow } from '../../../scripts/ops/upstream-compat-matrix.mjs';

const supportFile = new URL('../../../runtime/skills/community/plugin-support.json', import.meta.url);
const support = JSON.parse(readFileSync(supportFile, 'utf8'));
const cite = pluginEntry(PLUGIN_ID);
/** @param {string} id */
const bundle = id => support.communityToolBundles.find(entry => entry.name === id);

test('only the approved binary and bounded integer timeout can be configured', () => {
  assert.deepEqual(validatePluginConfig({ expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000 } }),
    { enabled: true, settings: { timeoutMs: 4000 } });
  for (const input of [
    { expectedRevision: 0, enabled: 'true', settings: { timeoutMs: 4000 } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 1999 } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 15001 } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000.5 } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000, userAgent: 'override' } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000 }, version: '0.3.3' },
  ]) assert.throws(() => validatePluginConfig(input), { status: 400 });
  assert.throws(() => validatePluginConfig({ expectedRevision: 0, enabled: true, settings: { timeoutMs: 6000 } }, 5000), { status: 400 });
});

test('project document identities cannot alias another project', () => {
  assert.notEqual(projectPluginId('a'), projectPluginId('a:dsh-cite'));
});

test('account export projects only the exact supported configuration shape', () => {
  const payload = { schemaVersion: 1, pluginId: 'dsh-cite', binaryVersion: '0.3.2', enabled: false, settings: { timeoutMs: 4000 } };
  assert.deepEqual(exportPluginPayload(payload), payload);
  for (const value of [{ ...payload, token: 'private' }, { ...payload, binaryVersion: '0.3.3' },
    { ...payload, settings: { timeoutMs: 4000, gatewayUrl: 'https://private' } }, { enabled: true }]) {
    assert.throws(() => exportPluginPayload(value), { code: 'account_export_unsupported_state' });
  }
});

// (a) Discovery.
test('the installed set is derived from the recorded community bundle support, not from an id literal', () => {
  const recorded = support.communityToolBundles.filter(entry => entry.status === 'installed');
  assert.ok(recorded.length >= 1, 'the support record must list at least one installed bundle for this test to mean anything');
  assert.deepEqual([...PLUGIN_REGISTRY.keys()].sort(), recorded.map(entry => entry.name).sort());
  for (const entry of recorded) assert.equal(pluginEntry(entry.name).version, entry.version);
  assert.equal(PLUGIN_VERSION, bundle(PLUGIN_ID).version);
  // Bundles the record refuses are not silently configurable.
  for (const rejected of support.communityToolBundles.filter(entry => entry.status !== 'installed')) {
    assert.equal(PLUGIN_REGISTRY.has(rejected.name), false, `${rejected.name} is ${rejected.status}, not installed`);
    assert.throws(() => pluginEntry(rejected.name), { status: 404, code: 'plugin_not_supported' });
  }
  assert.throws(() => pluginEntry('dsh-browse'), { status: 404, code: 'plugin_not_supported' });
});

test('the copy the released image falls back to derives the same registry as the record', () => {
  // `deploy/web/Dockerfile` does not copy `runtime/skills/community/` into the
  // web image, so a released control plane derives its registry from the
  // in-module snapshot. The two must not be allowed to drift: a snapshot that
  // is quietly a release behind would register a version no project runs, and
  // one missing a field the record carries serves that field empty in
  // production only — the tool list did exactly that, visible in dev and in
  // every test here because both read the record. So the comparison is every
  // key of the derived entry, not a list of keys someone remembered.
  const fromRecord = pluginRegistryFrom(support);
  const fromSnapshot = pluginRegistryFrom(PLUGIN_SUPPORT_SNAPSHOT);
  assert.ok(fromSnapshot.size >= 1);
  assert.deepEqual([...fromSnapshot.keys()], [...fromRecord.keys()]);
  for (const [id, entry] of fromRecord) {
    assert.equal(fromSnapshot.get(id).version, entry.version, `${id} version drifted between the record and the shipped snapshot`);
    assert.deepEqual(fromSnapshot.get(id).supportedBinaryVersions, entry.supportedBinaryVersions);
    assert.deepEqual(fromSnapshot.get(id).settings, entry.settings);
    assert.deepEqual(fromSnapshot.get(id).tools, entry.tools, `${id} tools drifted between the record and the shipped snapshot`);
    assert.ok(entry.tools.length > 0, `${id} registers no tools, so this comparison would hold vacuously`);
    assert.deepEqual(fromSnapshot.get(id), entry, `${id} differs between the record and the shipped snapshot`);
  }
});

test('the version the control plane serves is the version the runtime image installs', () => {
  // `availableUpdate` is a comparison against `installedVersion`, so a record
  // that has drifted from the image does not merely go quiet — it offers an
  // upgrade to something already installed, or hides one that is not. The
  // image's install line is the fact; the record and the snapshot derive from it.
  const dockerfile = readFileSync(new URL('../../../deploy/runtime-dsh/Dockerfile', import.meta.url), 'utf8');
  const installed = [...dockerfile.matchAll(/"dsh-cite@(\d+\.\d+\.\d+[^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(installed, [PLUGIN_VERSION], 'the runtime image installs exactly the recorded dsh-cite version');
});

test('an upgraded build keeps every earlier revision readable', () => {
  // Without this, moving a plugin version would make every saved revision of
  // it unreadable at once — history, account export and the apply worker all
  // go through the same strict projection.
  const upgraded = pluginRegistryFrom({ communityToolBundles: [{ ...bundle(PLUGIN_ID), version: '0.3.4', previousVersions: ['0.3.2'] }] });
  const stored = { schemaVersion: 1, pluginId: PLUGIN_ID, binaryVersion: '0.3.2', enabled: true, settings: { timeoutMs: 4000 } };
  assert.deepEqual(exportPluginPayload(stored, upgraded), stored);
  assert.throws(() => exportPluginPayload({ ...stored, binaryVersion: '0.2.0' }, upgraded), { code: 'account_export_unsupported_state' });
});

test('a bundle the apply path cannot carry is refused, not quietly registered', () => {
  // The failure this prevents is invisible from the browser: `pluginApplyWorker`
  // addresses one document per project by the default id, so a second
  // registered bundle would be configurable, saved, enqueued — and then applied
  // from dsh-cite's document. Registration is capped at what delivery carries.
  const twoInstalled = { communityToolBundles: [bundle(PLUGIN_ID), { name: 'dsh-notes', version: '1.0.0', status: 'installed' }] };
  assert.throws(() => pluginRegistryFrom(twoInstalled), /dsh-notes[\s\S]*apply path[\s\S]*pluginApplyWorker/);
  assert.deepEqual([...PLUGIN_REGISTRY.keys()], [PLUGIN_ID], 'the shipped registry is exactly the deliverable set');
  assert.deepEqual([...APPLY_PATH_PLUGIN_IDS], [PLUGIN_ID]);
});

test('a second installed bundle is discoverable and configurable without changing dsh-cite', () => {
  // The shape of the change that lands a second bundle: widen the set the apply
  // path can carry and everything from the route to the stored document already
  // addresses it by name. Nothing below reaches for a hard-coded id.
  const registry = pluginRegistryFrom(
    { communityToolBundles: [bundle(PLUGIN_ID), { name: 'dsh-notes', version: '1.0.0', status: 'installed' }, bundle('dsh-plugin-translation')] },
    new Set([PLUGIN_ID, 'dsh-notes']),
  );
  assert.deepEqual([...registry.keys()], [PLUGIN_ID, 'dsh-notes']);
  const notes = pluginEntry('dsh-notes', registry);
  // Per-plugin schema stays explicit: a bundle with no declared settings takes
  // no settings at all rather than an open bag.
  assert.deepEqual(validatePluginConfig({ expectedRevision: 0, enabled: false, settings: {} }, 15000, notes), { enabled: false, settings: {} });
  assert.throws(() => validatePluginConfig({ expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000 } }, 15000, notes), { status: 400 });
  assert.equal(projectPluginId('one', 'dsh-notes', registry), 'project:one:dsh-notes');
  assert.throws(() => projectPluginId('one', 'dsh-notes'), { status: 404 }, 'the shipped registry has no such plugin');
  // dsh-cite is untouched by the second registration.
  const citeFromTwo = pluginEntry(PLUGIN_ID, registry);
  assert.deepEqual(citeFromTwo, cite);
  assert.deepEqual(validatePluginConfig({ expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000 } }, 15000, citeFromTwo),
    { enabled: true, settings: { timeoutMs: 4000 } });
  assert.equal(projectPluginId('one'), 'project:one:dsh-cite');
});

test('a plugin id is a closed vocabulary, never a path or a document-id separator', () => {
  for (const name of ['../evil', 'a:b', 'Dsh-Cite', '', 'x'.repeat(80)]) {
    assert.throws(() => pluginRegistryFrom({ communityToolBundles: [{ name, version: '1.0.0', status: 'installed' }] }), /unusable plugin id/);
  }
  assert.throws(() => pluginRegistryFrom({ communityToolBundles: [{ name: 'dsh-notes', version: 'main', status: 'installed' }] }), /version/);
});

// (b) Upgrade: availability is read, never fetched on the request path.
test('a missing, stale or unobserved availability record reads as unknown, never as up to date', () => {
  const now = Date.parse('2026-09-07T00:00:00.000Z');
  const record = (plugins, generatedAt = '2026-09-06T02:00:00.000Z') => ({ schemaVersion: 1, generatedAt, plugins });
  const row = extra => ({ id: PLUGIN_ID, installedVersion: cite.version, available: null, source: 'npm', ...extra });
  for (const [label, value] of [
    ['missing', null],
    ['unparsed', undefined],
    ['wrong schema', { ...record([row({ available: '9.9.9' })]), schemaVersion: 2 }],
    ['stale', record([row({ available: '9.9.9' })], '2026-09-01T02:00:00.000Z')],
    ['undated', { schemaVersion: 1, plugins: [row({ available: '9.9.9' })] }],
    ['recorded ahead of this clock', record([row({ available: '9.9.9' })], '2026-09-07T00:30:00.000Z')],
    ['plugin not in the record', record([{ id: 'dsh-notes', installedVersion: '1.0.0', available: '1.0.0' }])],
    ['recorded against another build', record([row({ installedVersion: '0.0.1', available: '0.0.1' })])],
    ['nothing observed', record([row({ available: null, reason: 'npm unreachable' })])],
  ]) {
    const verdict = pluginAvailability(value, cite, now);
    assert.equal(verdict.state, 'unknown', `${label} must read as unknown`);
    assert.equal(verdict.availableUpdate, null, `${label} must offer no update`);
    assert.notEqual(verdict.state, 'current', `${label} must never read as up to date`);
  }
  assert.deepEqual(pluginAvailability(record([row({ available: cite.version })]), cite, now),
    { state: 'current', checkedAt: '2026-09-06T02:00:00.000Z', reason: 'recorded', availableUpdate: null });
  // The window is 72 hours to the millisecond, in both directions: the job runs
  // nightly, so three missed nights is a silence, and a minute of skew between
  // its host and this one is not.
  const fresh = ts => pluginAvailability(record([row({ available: cite.version })], ts), cite, now).state;
  assert.equal(fresh('2026-09-04T00:00:00.000Z'), 'current', 'exactly 72 hours old is still an observation');
  assert.equal(fresh('2026-09-03T23:59:59.999Z'), 'unknown', 'one millisecond past the window is a silence');
  assert.equal(fresh('2026-09-07T00:00:30.000Z'), 'current', 'ordinary clock skew is not a reason to forget');
  assert.deepEqual(pluginAvailability(record([row({ available: '0.3.4' })]), cite, now),
    { state: 'update-available', checkedAt: '2026-09-06T02:00:00.000Z', reason: 'recorded',
      availableUpdate: { version: '0.3.4', recordedAt: '2026-09-06T02:00:00.000Z', source: 'npm' } });
});

test('nothing on the plugin request path can reach a host', () => {
  // The whole availability design rests on this: `availableUpdate` is answered
  // from a file a scheduled job wrote, because a control plane that named an
  // external host while answering a browser would put that host's latency and
  // its outage inside a page load, and would leak which deployment asked. The
  // module's own text is the only place that can be checked without a network.
  const source = readFileSync(new URL('../src/pluginService.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('readFile('), 'the availability record is read from disk');
  for (const forbidden of ['fetch(', 'node:http', 'node:https', 'node:net', 'undici', 'XMLHttpRequest']) {
    assert.equal(source.includes(forbidden), false, `pluginService.mjs must not reach a host: found ${forbidden}`);
  }
});

test('the service reads the recorded availability file from disk and nothing else', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'plugin-availability-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plugin-availability.json');
  const service = new PluginService({}, { jobs: {}, availabilityFile: file });
  assert.equal(await service.availabilityRecord(), null, 'an absent file is not an error, it is no record');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), plugins: [] }), 'utf8');
  service.availabilityReadAt = 0;
  assert.equal((await service.availabilityRecord()).schemaVersion, 1);
  await writeFile(file, 'not json', 'utf8');
  service.availabilityReadAt = 0;
  assert.equal(await service.availabilityRecord(), null, 'an unreadable record is unknown, not a crash');
});

test('a plugin state carries the recorded availability and the schema the client must render', () => {
  const state = pluginState(cite, null, { maxTimeoutMs: 6000 });
  assert.equal(state.id, PLUGIN_ID);
  assert.equal(state.binaryVersion, cite.version);
  assert.deepEqual(state.availability, { state: 'unknown', checkedAt: null, reason: 'no-record' });
  assert.equal(state.availableUpdate, null);
  assert.deepEqual(state.settingsSchema, { timeoutMs: { min: 2000, max: 6000 } });
  assert.deepEqual(state.tools, bundle(PLUGIN_ID).tools, 'the tools a bundle registers come from the same record as its version');
  assert.ok(state.tools.length > 0);
  assert.deepEqual(state.desired, { revision: 0, enabled: true, settings: { timeoutMs: 6000 } });
  assert.deepEqual(state.limits, { minTimeoutMs: 2000, maxTimeoutMs: 6000 });
  assert.equal(state.removed, false);
  assert.equal(state.phase, 'saved');
});

test('dsh-cite keeps the apply job it always had, and only a second plugin names itself', async () => {
  // The idempotency key is a hash of the payload, and `rearmFailed` makes an
  // in-flight job for the same key the *same* job. Adding a field to dsh-cite's
  // payload would silently mint a second apply job per save, and the digest
  // below is what makes that visible: it was computed from the payload shape
  // this queue has had since it was written.
  /** @type {any[]} */ const enqueued = [];
  const jobs = { enqueue: async (userId, kind, payload, options) => { enqueued.push({ userId, kind, payload, options }); return { id: `job-${enqueued.length}` }; } };
  const service = new PluginService({}, { jobs });
  const scope = { userId: 'owner', accountCreatedAt: '2026-01-01T00:00:00Z', projectCreatedAt: '2026-01-02T00:00:00Z' };
  await service.enqueue(null, scope, { id: 'one' }, 4, cite);
  assert.deepEqual(enqueued[0].payload, { revision: 4, accountCreatedAt: scope.accountCreatedAt, projectCreatedAt: scope.projectCreatedAt });
  assert.equal(enqueued[0].kind, 'plugin-apply');
  assert.equal(enqueued[0].options.idempotencyKey,
    'plugin-apply:54acd32d0ba17c11b056fe2262ffc5d1fd62029bd8d78fcf08aeb7d957727dab');
  const notes = pluginEntry('dsh-notes', pluginRegistryFrom(
    { communityToolBundles: [{ name: 'dsh-notes', version: '1.0.0', status: 'installed' }] }, new Set(['dsh-notes'])));
  await service.enqueue(null, scope, { id: 'one' }, 4, notes);
  assert.deepEqual(enqueued[1].payload, { revision: 4, accountCreatedAt: scope.accountCreatedAt, projectCreatedAt: scope.projectCreatedAt, pluginId: 'dsh-notes' });
  assert.notEqual(enqueued[1].options.idempotencyKey, enqueued[0].options.idempotencyKey, 'two plugins must not share one apply job');
});

// (c) Uninstall.
test('removal is a disable plus a reset to the default configuration, and says so in the state', () => {
  assert.deepEqual(removalConfiguration(cite, 15000), { enabled: false, settings: { timeoutMs: 15000 } });
  const row = (enabled, timeoutMs, revision = 1) => ({
    revision, phase: 'effective', effective: null, error: null,
    payload: { schemaVersion: 1, pluginId: PLUGIN_ID, binaryVersion: cite.version, enabled, settings: { timeoutMs } },
  });
  assert.equal(pluginState(cite, row(false, 15000)).removed, true);
  assert.equal(pluginState(cite, row(false, 4000)).removed, false, 'a disabled but customised configuration is not a removal');
  assert.equal(pluginState(cite, row(true, 15000)).removed, false);
});

test('removal is idempotent, refuses a stale revision and never regenerates a removal revision', async () => {
  const owner = 'owner';
  const project = { id: 'one', userId: owner };
  let state = pluginState(cite, null, {});
  /** @type {any[]} */ const saved = [];
  const service = new PluginService({}, { jobs: {} });
  service.get = async () => state;
  service.save = async (_owner, _project, input, pluginId) => {
    saved.push([input, pluginId]);
    state = pluginState(cite, {
      revision: input.expectedRevision + 1, phase: 'pending', effective: null, error: null,
      payload: { schemaVersion: 1, pluginId: PLUGIN_ID, binaryVersion: cite.version, enabled: input.enabled, settings: input.settings },
    }, {});
    return state;
  };
  const removed = await service.remove(owner, project, { expectedRevision: 0 }, PLUGIN_ID);
  assert.equal(removed.removed, true);
  assert.equal(removed.desired.revision, 1);
  assert.deepEqual(saved, [[{ expectedRevision: 0, enabled: false, settings: { timeoutMs: 15000 } }, PLUGIN_ID]]);
  // Idempotent: the same removal at the revision it produced writes nothing new.
  const again = await service.remove(owner, project, { expectedRevision: 1 }, PLUGIN_ID);
  assert.equal(again.removed, true);
  assert.equal(again.desired.revision, 1);
  assert.equal(saved.length, 1, 'a repeated removal must not append another revision');
  await assert.rejects(service.remove(owner, project, { expectedRevision: 0 }, PLUGIN_ID), { status: 409, code: 'product_revision_conflict' });
  await assert.rejects(service.remove(owner, project, { expectedRevision: 1, enabled: false }, PLUGIN_ID), { status: 400 });
  await assert.rejects(service.remove(owner, project, { expectedRevision: 1 }, 'dsh-browse'), { status: 404, code: 'plugin_not_supported' });
});

// (d) The nightly matrix's per-plugin lane.
test('a plugin the matrix could not probe is reported as not probed, never as compatible', () => {
  const row = pluginCompatibilityRow(bundle(PLUGIN_ID), { kernel: support.kernel });
  assert.equal(row.plugin, PLUGIN_ID);
  assert.equal(row.loadsAgainstPin, 'not-probed');
  assert.equal(row.verdict, 'not-probed');
  assert.match(row.probeReason, /no plugin probe/i);
  assert.notEqual(row.loadsAgainstPin, 'pass');
  // An explicit probe result is what a green row needs.
  assert.equal(pluginCompatibilityRow(bundle(PLUGIN_ID), { kernel: support.kernel, probe: { loaded: true, reason: 'booted' } }).loadsAgainstPin, 'pass');
  assert.equal(pluginCompatibilityRow(bundle(PLUGIN_ID), { kernel: support.kernel, probe: { loaded: false, reason: 'boom' } }).verdict, 'fails-to-load');
  // A bundle the record already refuses keeps its recorded verdict.
  const refused = pluginCompatibilityRow(bundle('dsh-plugin-translation'), { kernel: support.kernel });
  assert.equal(refused.declaredStatus, 'incompatible');
  assert.equal(refused.loadsAgainstPin, 'not-probed');
});

test('the matrix writes what the service reads: an unobserved plugin version stays unknown on both sides', () => {
  const at = '2026-09-06T02:00:00.000Z';
  const rows = [pluginCompatibilityRow(bundle(PLUGIN_ID), { kernel: support.kernel })];
  const unobserved = pluginAvailabilityRecord(rows, at);
  assert.equal(unobserved.schemaVersion, 1);
  assert.equal(unobserved.generatedAt, at);
  assert.deepEqual(unobserved.plugins.map(entry => [entry.id, entry.installedVersion, entry.available]), [[PLUGIN_ID, cite.version, null]]);
  assert.equal(pluginAvailability(unobserved, cite, Date.parse(at) + 1000).state, 'unknown');
  const observed = pluginAvailabilityRecord([pluginCompatibilityRow(bundle(PLUGIN_ID), { kernel: support.kernel, latest: '0.3.4', latestSource: 'npm' })], at);
  assert.deepEqual(pluginAvailability(observed, cite, Date.parse(at) + 1000).availableUpdate,
    { version: '0.3.4', recordedAt: at, source: 'npm' });
});
