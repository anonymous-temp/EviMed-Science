import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { timeout: 10_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  const owner = `activity_${randomUUID()}`;
  const other = `activity_${randomUUID()}`;
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other]]);
    await database.close();
  });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Activity owner','development'),($2,'Other owner','development')", [owner, other]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'owned','Owned',1048576),($2,'owned','Other',1048576)", [owner, other]);
  let at = new Date("2026-09-06T01:00:00.000Z");
  const now = () => at;
  const documents = new ProductDocuments(database);
  const notifications = new NotificationService(database);
  const makeService = (docs = new ProductDocuments(database)) => new AutopilotService({
    documents: docs, jobs: new ProductJobs(database), notifications, now,
  });
  const service = makeService(documents);
  const agenda = await service.create(owner, { projectId: "owned", title: "Activity integration",
    topics: ["research updates"], taskTypes: ["literature-sentinel"], dailyBudgetCny: 2,
    weeklyBudgetCny: 10, maxEpisodeCny: 1, scheduleHour: 1, timeZone: "UTC" });
  const digest = await service.createDigest(owner, agenda.id, { date: "2026-09-06", episodeIds: ["episode-activity"], costCny: 0,
    claims: [{ id: "claim-one", statement: "A retained finding", type: "direct", tier: "unverified" }] });
  return { database, owner, other, documents, notifications, makeService, service, agenda, digest, setTime: (value) => { at = new Date(value); } };
}

test("Postgres digest and notification services distinguish resolving a notice from viewing its content", options, async (t) => {
  const { owner, other, service, makeService, notifications, agenda, digest, setTime } = await fixture(t);
  const notices = (await notifications.list(owner)).items;
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].source, { type: "digest", id: digest.id });
  await notifications.resolve(owner, notices[0].id, { actionId: "open", expectedRevision: notices[0].revision });
  setTime("2026-09-12T01:00:00.000Z");
  await service.listDigests(owner, { projectId: "owned" });
  await service.getDigest(owner, digest.id);
  const reader = makeService();
  assert.equal((await reader.getDigest(owner, digest.id)).payload.openedAt, null);
  assert.equal((await reader.get(owner, agenda.id)).payload.lastDigestOpenedAt, null);
  await assert.rejects(() => reader.markDigestOpened(other, digest.id), { code: "autopilot_digest_not_found" });
  await service.markDigestOpened(owner, digest.id);
  assert.equal((await reader.getDigest(owner, digest.id)).payload.openedAt, "2026-09-12T01:00:00.000Z");
  assert.equal((await reader.get(owner, agenda.id)).payload.lastDigestOpenedAt, "2026-09-12T01:00:00.000Z");
});

test("the PostgreSQL inactivity guard uses the service activity clock at the exact seven-day boundary", options, async (t) => {
  const { owner, service, agenda, setTime } = await fixture(t);
  await service.start(owner, agenda.id, { expectedRevision: agenda.revision });
  setTime("2026-09-13T00:59:59.999Z");
  assert.equal((await service.checkInactivity(owner, agenda.id)).payload.status, "active");
  setTime("2026-09-13T01:00:00.000Z");
  assert.equal((await service.checkInactivity(owner, agenda.id)).payload.status, "paused");
});

test("a PostgreSQL pause conflict rechecks a digest opened while the inactivity decision was pending", options, async (t) => {
  const { owner, service, makeService, documents, agenda, digest, setTime } = await fixture(t);
  await service.start(owner, agenda.id, { expectedRevision: agenda.revision });
  setTime("2026-09-13T01:00:00.000Z");
  const reached = deferred();
  const release = deferred();
  const put = documents.put.bind(documents);
  let delayed = false;
  let conflicts = 0;
  documents.put = async (...args) => {
    if (args[1] === "agenda" && !delayed) { delayed = true; reached.resolve(); await release.promise; }
    try { return await put(...args); }
    catch (error) { if (error.code === "product_revision_conflict") conflicts++; throw error; }
  };
  const checking = service.checkInactivity(owner, agenda.id);
  await reached.promise;
  try { await makeService().markDigestOpened(owner, digest.id); }
  finally { release.resolve(); }
  const saved = await checking;
  assert.equal(conflicts, 1);
  assert.equal(saved.payload.status, "active");
  assert.equal(saved.payload.enabled, true);
  assert.equal(saved.payload.lastDigestOpenedAt, "2026-09-13T01:00:00.000Z");
});

test("a Postgres CAS conflict from a concurrent decision preserves the decision while recording the open", options, async (t) => {
  const { owner, service, makeService, documents, digest } = await fixture(t);
  const reached = deferred();
  const release = deferred();
  const put = documents.put.bind(documents);
  let delayed = false;
  let conflicts = 0;
  documents.put = async (...args) => {
    if (args[1] === "digest" && !delayed) { delayed = true; reached.resolve(); await release.promise; }
    try { return await put(...args); }
    catch (error) { if (error.code === "product_revision_conflict") conflicts++; throw error; }
  };
  const opening = service.markDigestOpened(owner, digest.id);
  await reached.promise;
  try { await makeService().decide(owner, digest.id, { action: "adopt", claimId: "claim-one", note: "Keep this finding" }); }
  finally { release.resolve(); }
  await opening;
  const saved = await makeService().getDigest(owner, digest.id);
  assert.equal(conflicts, 1, "the actual PostgreSQL revision predicate must reject the stale writer");
  assert.equal(saved.payload.decisions[0].note, "Keep this finding");
  assert.equal(saved.payload.openedAt, "2026-09-06T01:00:00.000Z");
});

test("a Postgres activity retry never reenables an agenda concurrently stopped by another service", options, async (t) => {
  const { owner, service, makeService, documents, agenda, digest } = await fixture(t);
  await service.start(owner, agenda.id, { expectedRevision: agenda.revision });
  const reached = deferred();
  const release = deferred();
  const put = documents.put.bind(documents);
  let delayed = false;
  let conflicts = 0;
  documents.put = async (...args) => {
    if (args[1] === "agenda" && !delayed) { delayed = true; reached.resolve(); await release.promise; }
    try { return await put(...args); }
    catch (error) { if (error.code === "product_revision_conflict") conflicts++; throw error; }
  };
  const opening = service.markDigestOpened(owner, digest.id);
  await reached.promise;
  const stopping = makeService();
  try {
    const current = await stopping.get(owner, agenda.id);
    await stopping.stop(owner, agenda.id, { expectedRevision: current.revision });
  } finally { release.resolve(); }
  await opening;
  const saved = await makeService().get(owner, agenda.id);
  assert.equal(conflicts, 1);
  assert.equal(saved.payload.status, "stopped");
  assert.equal(saved.payload.enabled, false);
  assert.equal(saved.payload.lastDigestOpenedAt, "2026-09-06T01:00:00.000Z");
});

test("an interrupted Postgres activity pair recovers through a fresh service instance", options, async (t) => {
  const { owner, service, makeService, documents, agenda, digest } = await fixture(t);
  const put = documents.put.bind(documents);
  documents.put = async (...args) => {
    if (args[1] === "agenda") throw new Error("interrupted before the agenda update");
    return put(...args);
  };
  await assert.rejects(() => service.markDigestOpened(owner, digest.id), /interrupted before the agenda update/);
  const resumed = makeService();
  assert.equal((await resumed.getDigest(owner, digest.id)).payload.openedAt, "2026-09-06T01:00:00.000Z");
  assert.equal((await resumed.get(owner, agenda.id)).payload.lastDigestOpenedAt, null);
  await resumed.decide(owner, digest.id, { action: "reject", claimId: "claim-one", note: "Out of scope" });
  await resumed.markDigestOpened(owner, digest.id);
  const saved = await makeService().getDigest(owner, digest.id);
  assert.equal(saved.payload.decisions[0].action, "reject");
  assert.equal(saved.payload.openedAt, (await makeService().get(owner, agenda.id)).payload.lastDigestOpenedAt);
});
