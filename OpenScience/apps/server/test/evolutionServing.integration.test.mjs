// The serving composition of 循证进化 on a real ledger, because no release had ever run it before the one that carries it, with no switch back: what it does with
// everything the full composition left behind (retired jobs and events, delivered cards), what it continues, that it reaches no model, that its history reads, and that
// what it writes at a rate has a bound. The last test boots the whole control plane once.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments, ProductJobs } from '../src/productStore.mjs';
import { NotificationService } from '../src/notificationService.mjs';
import { createEvolutionServing } from '../src/evolutionServing.mjs';
import { RETIRED_EVOLUTION_JOBS, quarantineRetiredEvolutionJobs } from '../src/evolutionRetiredJobs.mjs';
import { migrateUsageLedger } from '../src/usagePersistence.mjs';
import { maintenanceAllowsClaims } from '../src/maintenanceService.mjs';
import { createWebApiApp } from '../src/server.mjs';
import { HttpError, sendError } from '../src/security.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) { const parsed = new URL(url); assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { timeout: 120_000, skip: !url && 'A disposable localhost test database is required' };
const owner = `serving_owner_${randomUUID()}`, researcher = `serving_researcher_${randomUUID()}`;
const noModel = () => { throw new Error('The serving composition reached the network.'); };
/** @type {any} */ let database, documents, jobs, notifications, serving, dataDir, realFetch;
const ids = { retiredEvent: 'evolution-event-retired', feedback: 'feedback-event', gap: 'gap-event', tool: 'evolution-tool-published', harmReview: 'evolution-harm-review-x',
  harmCard: 'evolution-decision-harm', experimentCard: 'evolution-decision-experiment', notDue: 'evolution-decision-not-due', dossier: 'evolution-dossier-old', mission: 'evolution-mission-old' };

const fakeStore = {
  /** @param {string} id */ userById: async (id) => ([owner, researcher].includes(id) ? { id } : null),
  /** @param {any} user @param {string} id */ projectFor: async (user, id) => ({ id, userId: user.id }),
  /** @param {any} user @param {string} id */ requireProject: async (user, id) => ({ id, userId: user.id, workspaceDir: dataDir }),
  /** @param {any} req */ ensureSessionUser: async (req) => ({ user: { id: req.headers['x-test-user'] ?? owner } }),
  assertCsrf: async () => {},
};
const jobRows = async () => (await database.query('SELECT kind,status,result,error,idempotency_key,payload FROM evimed_product.jobs WHERE user_id=$1', [owner])).rows;
const claimable = async () => Number((await database.query("SELECT count(*)::integer AS n FROM evimed_product.jobs WHERE user_id=$1 AND status IN ('queued','running') AND run_after<=clock_timestamp() AND kind=ANY($2::text[])",
  [owner, [...serving.worker.kinds]])).rows[0].n);
const drain = async () => { for (let round = 0; round < 40; round++) { await serving.worker.tick(); if (!await claimable()) return; } assert.fail('The worker did not drain its queue.'); };
/** @param {string} id */
const doc = (id, userId = owner) => documents.get(userId, 'knowledge', id);

before(async () => {
  if (!url) return;
  dataDir = await mkdtemp(path.join(tmpdir(), 'evimed-evolution-serving-'));
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Operator','development'),($2,'Researcher','development')", [owner, researcher]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576),($2,'research','Research',1048576)", [owner, researcher]);
  await migrateUsageLedger(database);
  documents = new ProductDocuments(database); jobs = new ProductJobs(database); notifications = new NotificationService(database);
  serving = createEvolutionServing({ config: { evolutionEnabled: true, operatorUsers: [owner], dataDir, maxJsonBytes: 262144, evolutionLeaseMs: 60_000, evolutionSignalRetentionDays: 30 }, store: fakeStore, documents, jobs, database,
    notifications, registry: { list: () => [] }, runtimeManager: {}, agentRuns: {}, autopilot: null, dataSemantics: { get: async () => null }, controller: { evolutionAdmissionAvailable: async () => ({ executor: null }) },
    canRun: (client) => (client ? maintenanceAllowsClaims(client) : database.transaction(maintenanceAllowsClaims)) });
  // What the full composition left behind: every retired kind queued, one of them with a lease that has expired.
  for (const kind of RETIRED_EVOLUTION_JOBS) await jobs.enqueue(owner, kind, { seeded: true }, { idempotencyKey: `seed:${kind}`, projectId: 'evimed-evolution' });
  // A retired event, queued; and what serving still consumes.
  const { service } = serving;
  await service.save('event', ids.retiredEvent, { id: 'frontier:9', type: 'frontier-publication', status: 'queued', paper: { title: 'kept for the lab' } }, null, owner);
  await service.enqueue('event', { eventId: ids.retiredEvent, eventOwnerId: owner }, ids.retiredEvent);
  await service.ingestEvent({ id: ids.gap, type: 'runtime-gap', userId: researcher, projectId: 'research', gapCode: 'method-implementation', code: 'method-implementation', track: 'M' });
  await service.ingestEvent({ id: 'evaluation-gap:1', type: 'evaluation-gap', track: 'M', gapCode: 'method-missing', userId: researcher, projectId: 'research' });
  // A delivered card of each kind, past its due date, and one not yet due.
  const past = new Date(Date.now() - 60_000).toISOString();
  const card = (category, subjectId, options, conservative) => ({ category, subjectId, title: 'card', body: 'body', options, recommended: options[0].id, conservative, decisionClass: 'C', status: 'pending', history: [], overridden: false, deliveredAt: past, cardDay: past.slice(0, 10) });
  await service.save('tool', ids.tool, { name: 'Published tool', status: 'active', validationLevel: 'V2', track: 'M', capabilityIds: ['meta-analysis'], parentToolIds: [], createdAt: past });
  await service.save('maintenance-review', ids.harmReview, { kind: 'sequential-harm', parentToolIds: [ids.tool], status: 'pending' });
  // Written before 2026-10-26: `keep` stored as conservative. An unanswered harm alarm takes the protective retirement all the same.
  await service.save('decision', ids.harmCard, { ...card('tool-retire', ids.harmReview, [{ id: 'retire', label: 'Retire', operation: 'maintenance-retire' }, { id: 'keep', label: 'Keep', operation: 'keep' }], 'keep'), dueAt: past });
  await service.save('decision', ids.experimentCard, { ...card('tool-repair', 'evolution-release-review-x', [{ id: 'repair', label: 'Repair', operation: 'maintenance-repair' }, { id: 'merge', label: 'Merge', operation: 'maintenance-merge' }], 'repair'), dueAt: past });
  await service.save('decision', ids.notDue, { ...card('tool-repair', 'evolution-release-review-y', [{ id: 'repair', label: 'Repair', operation: 'maintenance-repair' }, { id: 'keep', label: 'Keep', operation: 'keep' }], 'keep'), dueAt: new Date(Date.now() + 3_600_000).toISOString() });
  for (const id of [ids.harmCard, ids.experimentCard]) await service.enqueue('decision', { decisionId: id }, `expire:${id}`);
  await service.enqueue('digest', { day: '2026-11-04' }, 'daily-digest:2026-11-04');
  await service.enqueue('maintain', { metricsMonth: '2026-10', metricsOnly: true }, 'serving-metrics:2026-10');
  await service.enqueue('maintain', { month: '2026-09', metricsMonth: '2026-09' }, 'monthly-v2:2026-09');
  await service.enqueue('self-check', { userId: researcher, projectId: 'research', datasetId: 'ds', toolId: ids.tool, waiterId: 'none', sourceEventId: 'x' }, 'check:none');
  // History the GET routes read.
  await service.save('dossier', ids.dossier, { title: 'old dossier', status: 'planned' });
  await service.save('mission', ids.mission, { moduleId: 'frontier', status: 'done' });
  // A processed event past its date and its job, a processed historical event with no date, a signal past its date, and a row at a rate from before.
  await service.save('event', 'evolution-event-due', { id: 'due', type: 'runtime-gap', status: 'processed', projectId: 'research', retainUntil: past }, null, researcher);
  await service.enqueue('event', { eventId: 'evolution-event-due', eventOwnerId: researcher }, 'evolution-event-due');
  await database.query("UPDATE evimed_product.jobs SET status='succeeded',finished_at=clock_timestamp() WHERE idempotency_key='evolution:evolution-event-due'");
  await service.save('event', 'evolution-event-historical', { id: 'old', type: 'runtime-gap', status: 'processed', projectId: 'research' }, null, researcher);
  await service.save('signal', 'evolution-signal-due', { kind: 'unmet-demand', moduleId: 'tools', codes: {}, projectId: 'research', retainUntil: past }, null, researcher);
  await service.save('signal', 'evolution-signal-historical', { kind: 'unmet-demand', moduleId: 'tools', codes: {}, projectId: 'research' }, null, researcher);
  await service.save('module-observation', 'evolution-module-observation-historical', { moduleId: 'frontier', kind: 'screened-out', counts: {} });
  realFetch = globalThis.fetch;
  globalThis.fetch = noModel;
});
after(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  await serving?.worker.close();
  if (database) { await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])', [[owner, researcher]]); await database.close(); }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('maintenance holds the quarantine, and the worker claims nothing while it does', options, async () => {
  assert.equal(await quarantineRetiredEvolutionJobs(database, owner, { admission: () => false }), 0);
  assert.equal((await jobRows()).filter((row) => RETIRED_EVOLUTION_JOBS.includes(row.kind) && row.status === 'queued').length, RETIRED_EVOLUTION_JOBS.length, 'nothing was cancelled');
  await database.query("INSERT INTO evimed_product.maintenance_lease(singleton,request_id,requested_at,expires_at,durable_hold) VALUES (true,$1,clock_timestamp(),clock_timestamp()+interval '1 hour',false)", [randomUUID()]);
  try {
    assert.equal(await quarantineRetiredEvolutionJobs(database, owner), 0, 'refused during maintenance');
    assert.equal(await serving.worker.tick(), null, 'the worker claims nothing');
  } finally { await database.query('DELETE FROM evimed_product.maintenance_lease'); }
  assert.equal((await jobRows()).filter((row) => row.status === 'running' || (RETIRED_EVOLUTION_JOBS.includes(row.kind) && row.status !== 'queued')).length, 0, 'nothing moved');
});

test('the first ticks cancel every retired job with its prior status, close the retired event, and carry out what serving can', options, async () => {
  await drain();
  const rows = await jobRows();
  for (const kind of RETIRED_EVOLUTION_JOBS) {
    const row = rows.find((item) => item.kind === kind && item.idempotency_key === `seed:${kind}`);
    assert.equal(row.status, 'canceled', kind);
    assert.equal(row.result.rsiCutover.priorStatus, 'queued', kind);
    assert.equal(row.error.code, 'evolution_offline_only', kind);
  }
  assert.ok(serving.worker.counters.quarantined >= RETIRED_EVOLUTION_JOBS.length);

  const retired = await doc(ids.retiredEvent);
  assert.equal(retired.payload.status, 'closed');
  assert.equal(retired.payload.closedReason, 'retired-to-lab');
  assert.equal(retired.payload.paper.title, 'kept for the lab', 'kept whole for the lab');

  const events = await serving.service.list('event', researcher);
  const gap = events.find((row) => row.payload.id === ids.gap);
  assert.equal(gap.payload.status, 'processed');
  assert.ok(Date.parse(gap.payload.retainUntil) > Date.now(), 'it carries the date it may go');
  const lapsed = events.find((row) => row.payload.id === 'evaluation-gap:1');
  assert.equal(lapsed.payload.status, 'closed', 'nothing publishes this type any more: a queued one closes');
  assert.equal(lapsed.payload.closedReason, 'retired-to-lab');
  const leads = await serving.service.list('lead');
  assert.deepEqual(leads.map((row) => [row.payload.source, row.payload.gapCode]), [['runtime-failure', 'method-implementation']], 'a lead is recorded for the lab');

  // Every serving kind was claimed and finished; nothing failed.
  for (const kind of ['evolution-event', 'evolution-decision', 'evolution-digest', 'evolution-maintain', 'evolution-self-check']) {
    const own = rows.filter((row) => row.kind === kind);
    assert.ok(own.length > 0, kind);
    assert.ok(own.every((row) => row.status === 'succeeded'), `${kind}: ${JSON.stringify(own.map((row) => [row.status, row.error]))}`);
  }
  assert.equal(serving.worker.counters.failed, 0);
  assert.equal(serving.worker.counters.housekeepingFailed, 0);
  assert.ok(await doc('evolution-monthly-metrics-2026-10'), 'the metrics-only month');
  assert.ok(await doc('evolution-monthly-metrics-2026-09'), 'a pass queued before the cut keeps its identity and runs the figures only');
  assert.ok(await doc('evolution-digest-2026-11-04'), 'the digest');
});

test('an unanswered harm card takes the protective retirement, a card only an experiment could carry out closes once, and one not due stays', options, async () => {
  const harm = await doc(ids.harmCard);
  assert.equal(harm.payload.status, 'executed');
  assert.equal(harm.payload.selected, 'retire');
  const tool = await doc(ids.tool);
  assert.equal(tool.payload.status, 'retired');
  assert.equal(tool.payload.retirement.reason, 'sequential-harm');
  assert.equal(tool.payload.retirement.state, 'complete');

  const closed = await doc(ids.experimentCard);
  assert.equal(closed.payload.status, 'closed');
  assert.equal(closed.payload.closedReason, 'retired-to-lab');
  assert.equal((await serving.decisions.expire(ids.experimentCard)).revision, closed.revision, 'closed once');

  assert.equal((await doc(ids.notDue)).payload.status, 'pending');
  assert.equal((await serving.decisions.expire(ids.notDue)).payload.status, 'pending');
});

test('an operator cannot answer with an option only an experiment could carry out, and answers in words are refused', options, async () => {
  const card = await doc(ids.notDue);
  await assert.rejects(serving.decisions.resolve(ids.notDue, { expectedRevision: card.revision, option: 'repair' }), (error) => error.status === 409 && error.code === 'evolution_offline_only');
  await assert.rejects(serving.decisions.resolve(ids.notDue, { expectedRevision: card.revision, text: 'do what you recommend' }), (error) => error.status === 400);
  assert.equal((await doc(ids.notDue)).payload.status, 'pending');
});

test('the retention pass deletes what is past its date, with the job, and leaves every row that carries none', options, async () => {
  assert.equal(await doc('evolution-event-due', researcher), null);
  assert.equal(await doc('evolution-signal-due', researcher), null);
  assert.equal((await jobRows()).filter((row) => row.idempotency_key === 'evolution:evolution-event-due').length, 0, 'its finished job went with it');
  assert.ok(await doc('evolution-event-historical', researcher), 'a historical row is left as it is');
  assert.ok(await doc('evolution-signal-historical', researcher), 'a historical row is left as it is');
  assert.ok(await doc('evolution-module-observation-historical'), 'a historical row is left as it is');
  assert.ok(serving.worker.counters.recordsDeleted >= 2);
  assert.equal(serving.observe, undefined, 'the frontier pipeline has nothing to write observations to');
});

test('repeating a lead adds an occurrence with a date and writes no revision of the lead', options, async () => {
  const input = { track: 'M', source: 'runtime-failure', gapCode: 'connector', code: 'connector', userId: researcher, projectId: 'research' };
  const first = await serving.service.addLead({ ...input, sourceEventId: 'a' });
  const second = await serving.service.addLead({ ...input, sourceEventId: 'b' });
  assert.equal(await serving.service.addLead({ ...input, sourceEventId: 'b' }).then((row) => row.payload.occurrences), 2, 'one event is one occurrence');
  assert.equal(second.id, first.id);
  assert.equal(second.payload.occurrences, 2);
  assert.equal((await documents.history(owner, 'knowledge', first.id)).length, 1);
  const occurrences = await database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='evolution-lead-occurrence' AND payload->>'leadId'=$2", [researcher, first.id]);
  assert.equal(occurrences.rows.length, 2);
  assert.ok(occurrences.rows.every((row) => Date.parse(row.payload.retainUntil) > Date.now()));
});

test('a signal written today carries a date, and a versioned one, withdrawn by its identity, none', options, async () => {
  const base = { userId: researcher, projectId: 'research', moduleId: 'tools', kind: 'unmet-demand', capability: 'unknown', operation: 'unknown', dataShape: 'unknown', reason: 'missing-tool' };
  const plain = await serving.signals.record({ ...base, eventId: 'plain' });
  assert.ok(Date.parse(plain.payload.retainUntil) > Date.now());
  const versioned = await serving.signals.record({ ...base, eventId: 'versioned', sourceRevision: 1, version: 'v1' });
  assert.equal(versioned.payload.retainUntil, undefined);
});

test('a newer revision of a dataset dates the event it replaces; the first has no date', options, async () => {
  const dataset = { userId: researcher, projectId: 'research', datasetId: 'ds-1', type: 'dataset-ready', dataset: { fields: [] } };
  await serving.service.ingestEvent({ ...dataset, id: 'dataset:research:ds-1:1' });
  await drain();
  const [first] = (await serving.service.list('event', researcher, { type: 'dataset-ready', datasetId: 'ds-1' })).filter((row) => row.payload.id.endsWith(':1'));
  assert.equal(first.payload.status, 'processed');
  assert.equal(first.payload.retainUntil, undefined);
  await serving.service.ingestEvent({ ...dataset, id: 'dataset:research:ds-1:2' });
  await drain();
  const after = await serving.service.list('event', researcher, { type: 'dataset-ready', datasetId: 'ds-1' });
  assert.ok(after.find((row) => row.payload.id.endsWith(':1')).payload.retainUntil, 'replaced');
  assert.equal(after.find((row) => row.payload.id.endsWith(':2')).payload.retainUntil, undefined, 'the latest stays');
});

test('the signals handed to GEO\'s outbox have everything the outbox asks for, and aggregate over the ledger', options, async () => {
  for (const member of ['record', 'transition', 'aggregate']) assert.equal(typeof serving.signals[member], 'function', member);
  const summaries = await serving.signals.aggregate();
  assert.ok(summaries.length > 0, 'the signals of this test read as a summary');
  assert.ok(summaries.every((row) => row.payload.scope === 'platform-aggregate' && !JSON.stringify(row.payload).includes(researcher)), 'no account in it');
});

test('a late retry of an older dataset revision never dates the newer one, and is itself dated by it', options, async () => {
  const dataset = { userId: researcher, projectId: 'research', datasetId: 'ds-order', type: 'dataset-ready', dataset: { fields: [] } };
  const older = await serving.service.ingestEvent({ ...dataset, id: 'dataset:research:ds-order:1' });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  const newer = await serving.service.ingestEvent({ ...dataset, id: 'dataset:research:ds-order:2' });
  // Revision 1's job failed; revision 2 is consumed first, and then revision 1's retry.
  await serving.integration.consume(newer.payload);
  await serving.service.save('event', newer.id, { ...newer.payload, status: 'processed' }, await serving.service.get(newer.id, researcher), researcher);
  await serving.integration.consume((await serving.service.get(older.id, researcher)).payload);
  assert.equal((await serving.service.get(newer.id, researcher)).payload.retainUntil, undefined, 'the newest is what `tool-ready` reads');
  assert.ok((await serving.service.get(older.id, researcher)).payload.retainUntil, 'the older one goes, whenever its job finishes');
});

test('the GET routes read the history; the POST routes of experiments are the ordinary 404; a researcher gets no operator route', options, async () => {
  const server = createServer((req, res) => { serving.routes(req, res).then((handled) => { if (!handled) sendError(res, new HttpError(404, 'not_found', 'Not found.')); }).catch((error) => sendError(res, error)); });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/api/evolution`;
  /** @param {string} route @param {RequestInit} [init] */
  const call = async (route, init = {}) => { const response = await realFetch(`${base}${route}`, init); return { status: response.status, body: await response.json() }; };
  try {
    assert.ok((await call('/decisions')).body.data.some((row) => row.id === ids.harmCard));
    assert.equal((await call(`/decisions/${ids.harmCard}`)).body.data.id, ids.harmCard);
    assert.deepEqual((await call(`/decisions/${ids.notDue}`)).body.data.dueOutcome, { kind: 'option', option: 'keep', label: 'Keep' }, 'the card reads what expiry will do');
    assert.equal((await call(`/decisions/${ids.harmCard}`)).body.data.dueOutcome, null, 'nothing is due on a decided card');
    assert.ok((await call('/dossiers')).body.data.some((row) => row.id === ids.dossier));
    assert.ok((await call('/missions')).body.data.some((row) => row.id === ids.mission));
    assert.deepEqual((await call('/verdicts')).body.data, []);
    assert.deepEqual((await call('/policies')).body.data, []);
    assert.deepEqual((await call('/tools')).body.data, [], 'the tool was retired above');
    assert.equal((await call('/capability-map')).body.data, null);
    assert.deepEqual(Object.keys((await call('/status')).body.data).sort(), ['enabled', 'running']);
    assert.equal((await call('/project-tools?projectId=research')).status, 200);
    for (const route of ['/evaluation-policy', '/tools/x/provenance', '/evaluations/import-existing-methods', '/prospective/x/score', '/prospective/verify-target', '/prospective/register', '/meta-update/register', '/opportunities/adopt']) {
      const answer = await call(route, { method: 'POST', body: '{}' });
      assert.equal(answer.status, 404, route);
      assert.equal(answer.body.code ?? answer.body.error?.code, 'evolution_route_missing', route);
    }
    assert.equal((await call('/evaluation-audit?projectId=research')).status, 404);
    assert.equal((await call('/decisions', { headers: { 'x-test-user': researcher } })).status, 403);
    assert.equal((await call('/project-tools?projectId=research', { headers: { 'x-test-user': researcher } })).status, 200);
  } finally { await new Promise((resolve) => { server.close(resolve); }); }
});

test('the usage ledger holds no request of this composition', options, async () => {
  assert.equal(Number((await database.query('SELECT count(*)::integer AS n FROM evimed_usage.model_requests WHERE user_id=ANY($1::text[])', [[owner, researcher]])).rows[0].n), 0);
});

test('the whole control plane boots with evolution on, composes serving and ticks its worker', options, async () => {
  const isolatedDb = await createGeoTestDatabase(url, 'evoserve');
  const operator = `boot_${randomUUID().replaceAll('-', '')}`;
  const seed = new ControlPlaneDatabase({ databaseUrl: isolatedDb.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  await seed.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Operator','development')", [operator]);
  await seed.close();
  const bootDir = await mkdtemp(path.join(tmpdir(), 'evimed-evolution-boot-'));
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = realFetch;
  const app = createWebApiApp({ dataDir: bootDir, port: 0, runtimeMode: 'mock', devAuth: false, authMode: 'local', bootstrapUser: '', bootstrapPassword: '', stateStore: 'postgres', requireSharedStateStore: true,
    databaseUrl: isolatedDb.url, evolutionEnabled: true, operatorUsers: [operator], rsiOnlineConfigFile: '', evolutionPollMs: 3_600_000 });
  try {
    assert.ok(app.evolution, 'composed');
    assert.equal(typeof app.evolution.loops, 'undefined', 'no experiment member');
    const address = await app.listen(0, '127.0.0.1');
    await app.evolution.service.ensureOwner();
    await app.evolution.worker.tick();
    assert.equal(app.evolution.worker.counters.housekeepingFailed, 0);
    assert.equal((await realFetch(`http://127.0.0.1:${address.port}/evolution/source-requests.json`)).status, 404, 'the plugin defers on the JSON 404');
    const manifest = await realFetch(`http://127.0.0.1:${address.port}/evolution/source-requests.json`);
    assert.match(manifest.headers.get('content-type') ?? '', /application\/json/);
  } finally {
    await app.close();
    globalThis.fetch = fetchBefore;
    await rm(bootDir, { recursive: true, force: true });
    await isolatedDb.drop();
  }
});
