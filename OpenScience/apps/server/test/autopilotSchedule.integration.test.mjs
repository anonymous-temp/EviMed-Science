import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments, ProductJobs } from '../src/productStore.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { AutopilotService } from '../src/autopilotService.mjs';
import { AutopilotWorker } from '../src/autopilotWorker.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && 'Local test Postgres is not configured' };
const owner = `scheduler_${randomUUID()}`;
let database;
let isolated;
let documents;
let jobs;
let service;
let now = new Date('2026-09-30T06:00:00Z');
before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "autoschedule");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Scheduler test','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Scheduler project',1000000)", [owner]);
  documents = new ProductDocuments(database);
  jobs = new ProductJobs(database);
  service = new AutopilotService({ documents, jobs, now: () => now });
});
after(async () => {
  if (!database) return;
  await database.query('DELETE FROM evimed_control.users WHERE id=$1', [owner]);
  await database.close();
  await isolated.drop();
});
async function agenda(schedule = { kind: 'daily', timeZone: 'UTC', time: '07:35' }) {
  now = new Date('2026-09-30T06:00:00Z');
  let row = await service.create(owner, { projectId: 'project-test', title: 'Schedule test', prompt: 'Preserve the full instruction.',
    taskTypes: ['evidence-update'], schedule,
    dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8 });
  row = await service.start(owner, row.id, { expectedRevision: row.revision });
  now = new Date('2026-09-30T07:35:00Z');
  return row;
}
async function counts(id) {
  const result = await database.query(`SELECT
    (SELECT count(*)::int FROM evimed_product.documents WHERE user_id=$1 AND kind='episode' AND payload->>'agendaId'=$2) episodes,
    (SELECT count(*)::int FROM evimed_product.jobs WHERE user_id=$1 AND kind='episode' AND payload->>'agendaId'=$2) jobs`, [owner, id]);
  return result.rows[0];
}

test('two timer replicas commit exactly one frozen episode, job and occurrence', options, async () => {
  const row = await agenda();
  const results = await Promise.allSettled([service.scheduleDue(owner, row.id), service.scheduleDue(owner, row.id)]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.deepEqual(await counts(row.id), { episodes: 1, jobs: 1 });
  assert.equal((await service.get(owner, row.id)).payload.lastScheduledOccurrence.localDate, '2026-09-30');
  assert.equal(await service.scheduleDue(owner, row.id), null);
});

test('a future first execution waits for real unread results before applying inactivity', options, async () => {
  const row = await agenda({ kind: 'once', timeZone: 'UTC', time: '07:35', date: '2026-10-10' });
  now = new Date('2026-10-10T07:35:00Z');
  const result = await service.scheduleDue(owner, row.id);
  assert.ok(result.episode);
  const current = await service.get(owner, row.id);
  await service.recordOutcome(owner, row.id, { expectedRevision: current.revision,
    episodeId: result.episode.id, status: 'succeeded', gatedClaims: 1 });
  assert.equal((await service.checkInactivity(owner, row.id)).payload.enabled, true);
  await service.createDigest(owner, row.id, { date: '2026-10-10', episodeIds: [result.episode.id], costCny: 0, claims: [] });
  now = new Date('2026-10-18T07:35:00Z');
  assert.equal((await service.checkInactivity(owner, row.id)).payload.status, 'paused');
});

test('timer and compatibility scheduling share identity in both orders and concurrently', options, async () => {
  for (const order of ['timer-first', 'compat-first', 'concurrent']) {
    const row = await agenda();
    const timer = () => service.scheduleDue(owner, row.id);
    const compat = () => service.schedule(owner, row.id, { date: '2026-09-30' });
    if (order === 'concurrent') await Promise.allSettled([timer(), compat()]);
    else if (order === 'timer-first') { await timer(); await compat(); }
    else { await compat(); await timer(); }
    assert.deepEqual(await counts(row.id), { episodes: 1, jobs: 1 }, order);
  }
});

test('resource capacity waits do not consume the attempt budget of an unstarted once job', options, async () => {
  const row = await agenda({ kind: 'once', timeZone: 'UTC', time: '07:35', date: '2026-09-30' });
  const queued = await service.scheduleDue(owner, row.id);
  await database.query("UPDATE evimed_product.jobs SET status='canceled' WHERE user_id=$1 AND id<>$2 AND status='queued'", [owner, queued.job.id]);
  await database.query('UPDATE evimed_product.jobs SET max_attempts=1 WHERE id=$1', [queued.job.id]);
  let capacity = false;
  let checks = 0;
  const worker = new AutopilotWorker({ jobs, service, busyDelayMs: 1000,
    dispatchEpisode: async () => {
      if (!capacity) throw Object.assign(new Error('No work started'), { code: ['runtime_busy', 'runtime_limit_exceeded', 'runtime_capacity_full'][checks++ % 3] });
      return { runId: 'run-resource-ready', sessionId: 'session-resource-ready' };
    } });
  for (let retry = 0; retry < 12; retry++) {
    await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1", [queued.job.id]);
    await worker.tick();
    assert.equal((await jobs.get(owner, queued.job.id)).status, 'queued');
    assert.equal((await jobs.get(owner, queued.job.id)).attempts, 0);
    assert.equal((await service.getEpisode(owner, queued.episode.id)).payload.status, 'queued');
  }
  capacity = true;
  await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1", [queued.job.id]);
  await worker.tick();
  assert.equal((await jobs.get(owner, queued.job.id)).status, 'succeeded');
  assert.equal(await service.scheduleDue(owner, row.id), null);
});

test('date-only compatibility calls cannot invent a second identity after a calendar edit', options, async () => {
  const row = await agenda();
  await service.scheduleDue(owner, row.id);
  const current = await service.get(owner, row.id);
  await service.update(owner, row.id, { expectedRevision: current.revision,
    schedule: { kind: 'daily', timeZone: 'UTC', time: '08:35' } });
  now = new Date('2026-09-30T08:35:00Z');
  const updated = await service.scheduleDue(owner, row.id);
  assert.equal(updated.episode.payload.scheduleVersion, 2);
  await assert.rejects(service.schedule(owner, row.id, { date: '2026-09-30' }), { code: 'autopilot_payload_invalid' });
  assert.deepEqual(await counts(row.id), { episodes: 2, jobs: 2 });
});

for (const point of ['episode', 'job', 'watermark']) {
  test(`a crash after ${point} rolls back every scheduling write and restart recovers once`, options, async () => {
    const row = await agenda();
    const put = documents.put.bind(documents);
    const enqueue = jobs.enqueue.bind(jobs);
    let thrown = false;
    documents.put = async (...args) => {
      const result = await put(...args);
      if (!thrown && args[4]?.transactionClient && (point === 'episode' && args[1] === 'episode' || point === 'watermark' && args[1] === 'agenda')) {
        thrown = true; throw new Error('simulated crash');
      }
      return result;
    };
    jobs.enqueue = async (...args) => {
      const result = await enqueue(...args);
      if (!thrown && point === 'job') { thrown = true; throw new Error('simulated crash'); }
      return result;
    };
    try { await assert.rejects(service.scheduleDue(owner, row.id), /simulated crash/); }
    finally { documents.put = put; jobs.enqueue = enqueue; }
    assert.deepEqual(await counts(row.id), { episodes: 0, jobs: 0 });
    assert.equal((await service.get(owner, row.id)).payload.lastScheduledOccurrence, null);
    await service.scheduleDue(owner, row.id);
    assert.deepEqual(await counts(row.id), { episodes: 1, jobs: 1 });
  });
}

test('a schedule edit before enqueue CAS rolls back the old occurrence and preserves the new instruction', options, async () => {
  const row = await agenda();
  const enqueue = jobs.enqueue.bind(jobs);
  let edited = false;
  jobs.enqueue = async (...args) => {
    const result = await enqueue(...args);
    if (!edited) {
      edited = true;
      const current = await service.get(owner, row.id);
      await service.update(owner, row.id, { expectedRevision: current.revision, prompt: 'New exact instruction',
        schedule: { kind: 'daily', timeZone: 'UTC', time: '08:35' } });
    }
    return result;
  };
  try { await assert.rejects(service.scheduleDue(owner, row.id), { code: 'product_revision_conflict' }); }
  finally { jobs.enqueue = enqueue; }
  assert.deepEqual(await counts(row.id), { episodes: 0, jobs: 0 });
  now = new Date('2026-09-30T08:35:00Z');
  const result = await service.scheduleDue(owner, row.id);
  assert.equal(result.episode.payload.instruction, 'New exact instruction');
  assert.equal(result.episode.payload.scheduleVersion, 2);
});

test('pause during enqueue invalidates the transaction; archived cancellation records remain readable', options, async () => {
  const row = await agenda();
  const enqueue = jobs.enqueue.bind(jobs);
  let paused = false;
  jobs.enqueue = async (...args) => {
    const result = await enqueue(...args);
    if (!paused) {
      paused = true;
      const current = await service.get(owner, row.id);
      await service.stop(owner, row.id, { expectedRevision: current.revision });
    }
    return result;
  };
  try { await assert.rejects(service.scheduleDue(owner, row.id), { code: 'product_revision_conflict' }); }
  finally { jobs.enqueue = enqueue; }
  assert.deepEqual(await counts(row.id), { episodes: 0, jobs: 0 });
  const current = await service.get(owner, row.id);
  await service.archive(owner, row.id, { expectedRevision: current.revision });
  assert.equal((await service.get(owner, row.id)).payload.status, 'stopped');
  await service.reconcileStopWork();
});

test('manual request races share one run and conflicting follow-up retries cannot change a frozen note', options, async () => {
  const row = await agenda();
  const outcomes = await Promise.allSettled([service.runNow(owner, row.id, { requestId: 'click' }), service.runNow(owner, row.id, { requestId: 'click' })]);
  assert.ok(outcomes.some(result => result.status === 'fulfilled'));
  assert.deepEqual(await counts(row.id), { episodes: 1, jobs: 1 });
  await service.runNow(owner, row.id, { requestId: 'click-next' });
  assert.deepEqual(await counts(row.id), { episodes: 2, jobs: 2 });
  assert.equal((await service.get(owner, row.id)).payload.lastScheduledOccurrence, null);
  const notes = await Promise.allSettled([service.followUp(owner, row.id, { requestId: 'note', note: 'First instruction' }),
    service.followUp(owner, row.id, { requestId: 'note', note: 'Different instruction' })]);
  assert.equal(notes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(notes.find(result => result.status === 'rejected').reason.code, 'autopilot_request_conflict');
  assert.deepEqual(await counts(row.id), { episodes: 3, jobs: 3 });
  const accepted = notes.find(result => result.status === 'fulfilled').value;
  const retry = await service.followUp(owner, row.id, { requestId: 'note', note: accepted.episode.payload.followUpNote });
  assert.equal(retry.episode.id, accepted.episode.id);
  assert.equal((await service.get(owner, row.id)).payload.messages.length, 1);
});
