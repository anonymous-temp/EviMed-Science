// Whose money keeps an evidence zone current (evidence-flywheel §3.3, B6, 2026-10-05).
//
// Until now `automation()` checked that the caller owned the zone and nothing about who they were, so any account in the frontier audience
// could switch on AI upkeep of its zone and have it paid from the platform's frontier budget. These tests hold the fix through the real
// editor, the real usage ledger and the real research allowance: official zones keep running on the platform's budget exactly as before;
// every other zone's model calls are booked to its owner under `evidence-upkeep`, count against the owner's caps and are charged to
// the owner; an owner with no allowance has the job set aside by name, and the platform never pays in their place.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID, researchMoneyUnits } from "@evimed/domain";
import { evidenceHash } from "../src/evidenceCardContent.mjs";
import { EvidenceEditorial, isOfficialZone } from "../src/evidenceEditorial.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { EvimedCreditsService } from "../src/evimedCreditsService.mjs";
import { SIMULATED_INCARNATION_SQL, SimulatedWallet, simulatedPayerId } from "../src/evimedCreditsSimulator.mjs";
import { FrontierEditor } from "../src/frontierEditor.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { EVIDENCE_PROJECT_ID, ensureEvidenceProject } from "../src/internalProjects.mjs";
import { createStore } from "../src/store.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
/** @type {any} */ let isolated, db, store, ledger, service, dataDir;
const operator = { id: "upkeep-operator" };
const frontierOwner = { userId: operator.id, projectId: "evimed-frontier" };
const DOCUMENT = "The randomized trial observed benefit in adults with kidney disease. Population was restricted to adults.";
const creditsConfig = { evimedCreditsEnabled: true, evimedCreditsSimulated: true, evimedCreditsPerCny: 1, researchBillingEnabled: true };
const editorConfig = { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", frontierModel: "deepseek-flash", deepseekBaseUrl: "https://api.deepseek.com", production: false };

/** @type {{ calls: string[], fail: string | null }} */
let model;
let frontierReads = 0;
/** What the provider answers: one canned JSON per kind of call, a priced usage block, and a record of which calls were made. */
async function deepseek(/** @type {any} */ _endpoint, /** @type {any} */ init) {
  const messages = JSON.parse(init.body).messages;
  const kind = /Decide whether/.test(messages[0].content) ? "target" : /independent AI evidence reviewer/.test(messages[0].content) ? "review" : "card";
  model.calls.push(kind);
  const answer = model.fail === kind ? { nonsense: true } : kind === "target" ? { cardId: null }
    : kind === "review" ? { findings: [] }
      : { title: "Kidney trial", summary: "Benefit in adults", body: "The source reports benefit in adults.", limitations: "Adult population only.",
        content: { question: "What did the trial find?", answer: "Benefit in adults.", population: "Adults" } };
  const payload = { id: `cmpl-${randomUUID()}`, choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3000, completion_tokens: 400, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 2000 } };
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "upkeepbilling");
  dataDir = await mkdtemp(join(tmpdir(), "evidence-upkeep-"));
  store = createStore({ stateStore: "postgres", databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000, dataDir, maxProjectBytes: 1_048_576 });
  db = store.database;
  await migrateFrontier(db, { dimension: 1024 });
  // The marking the zone module adds (`evidence_zones.kind`, plan B1): this build's tests make it themselves.
  await db.query("ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'user'");
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Operator','development')", [operator.id]);
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','Frontier',1048576)", [operator.id]);
  service = new EvidenceZoneService({ database: db });
  await service.ready();
  ledger = new UsageLedger(db);
  await migrateUsageLedger(db);
  // Both billing rules activate now, so a job that starts from now on is under the exact rule (evimedCreditsPlatform.integration.test.mjs).
  const seed = new EvimedCreditsService({ config: creditsConfig, database: db, client: null, simulator: new SimulatedWallet({ database: db }) });
  await seed.ready();
  await db.query("DELETE FROM evimed_credits.research_policy");
  await db.query("DELETE FROM evimed_credits.billing_policies");
  await seed.ready();
});
after(async () => {
  await store?.close();
  await isolated?.drop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones,evimed_frontier.items,evimed_frontier.sources CASCADE");
  // Each test reads the whole ledger for "who was booked", so it starts with none: the platform's rows from the test before are not this one's.
  await db.query("DELETE FROM evimed_credits.research_task_requests");
  await db.query("DELETE FROM evimed_usage.model_requests");
  model = { calls: [], fail: null };
  frontierReads = 0;
});

/** An account with a default project, a wallet of `startCredits`, and the research allowance service over it. */
async function account(label, startCredits = 200, serviceConfig = {}) {
  const id = `upkeep_${label}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$2,'development')", [id, label]);
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [id]);
  const wallet = new SimulatedWallet({ database: db, startCredits, signupGiftDays: 30, monthlyGift: 0 });
  const credits = new EvimedCreditsService({ config: { ...creditsConfig, ...serviceConfig }, database: db, client: null, usageLedger: ledger, simulator: wallet });
  await credits.ready();
  const incarnation = (await db.query(`SELECT ${SIMULATED_INCARNATION_SQL} AS incarnation FROM evimed_control.users u WHERE u.id=$1`, [id])).rows[0].incarnation;
  return { id, user: { id }, credits, balance: async () => (await wallet.snapshot(simulatedPayerId(id, incarnation))).balance };
}

/** A zone owned by `ownerId` with automation on and one frontier item to discover, so a tick makes the three model calls. */
async function zoneWithWork(ownerId, { kind = "user", title = "Kidney trials" } = {}) {
  const zone = (await service.save({ id: ownerId }, { title, state: "published" })).zone;
  if (kind !== "user") await db.query("UPDATE evimed_frontier.evidence_zones SET kind=$2 WHERE id=$1", [zone.id, kind]);
  await db.query(`INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run)
    VALUES($1,true,'kidney','{journal}',24,1)`, [zone.id]);
  await insertSource(db, `journal-${zone.id.slice(0, 8)}`);
  await insertItem(db, { sourceId: `journal-${zone.id.slice(0, 8)}`, title: "Kidney trial of an adult population" });
  return (await db.query("SELECT * FROM evimed_frontier.evidence_zones WHERE id=$1", [zone.id])).rows[0];
}

/** The zone editor over the real editor and ledger; `credits` and `ensureProject` are the deployment's wiring. */
function worker({ credits = null, ensureProject = (/** @type {string} */ userId) => ensureEvidenceProject(store, userId), editorOverrides = {}, ...rest } = {}) {
  const editor = new FrontierEditor({ ...editorConfig, ...editorOverrides }, { usageLedger: ledger, owner: frontierOwner, fetchImpl: /** @type {any} */ (deepseek) });
  return new EvidenceEditorial({
    database: db, service, editor, credits, ensureProject, isOperator: (/** @type {string} */ id) => id === operator.id,
    budget: async () => { frontierReads += 1; return { state: "ok" }; },
    readSource: async () => ({ text: DOCUMENT, coverage: "abstract", receipt: { sha256: evidenceHash(DOCUMENT) } }),
    ...rest,
  });
}
const rows = async (/** @type {string} */ sql, /** @type {any[]} */ values = []) => (await db.query(sql, values)).rows;
const requestsOf = (/** @type {string} */ userId) => rows("SELECT user_id,project_id,run_id,purpose,status,actual_cost::text AS cost FROM evimed_usage.model_requests WHERE user_id=$1 ORDER BY created_at", [userId]);
const jobOf = async (/** @type {string} */ zoneId) => (await rows("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1", [zoneId]))[0];
const units = (/** @type {unknown} */ value) => researchMoneyUnits(String(value));

test("which zone is the platform's: the publisher's own, or one marked official", () => {
  assert.equal(isOfficialZone({ user_id: PLATFORM_PUBLISHER_USER_ID, kind: "user" }), true, "ownership alone makes it the platform's");
  assert.equal(isOfficialZone({ user_id: "someone", kind: "official" }), true);
  assert.equal(isOfficialZone({ user_id: "someone", kind: "user" }), false);
  assert.equal(isOfficialZone({ user_id: "someone" }), false, "a build without the marking is every zone's owner's");
  assert.equal(isOfficialZone(null), false);
});

test("an account's zone is kept current on its owner's money: booked to them, under evidence-upkeep, and charged through their allowance", options, async () => {
  const owner = await account("charged");
  const zone = await zoneWithWork(owner.id);
  const editorial = worker({ credits: owner.credits });
  const before = await owner.balance();
  await editorial.tick();
  assert.deepEqual(model.calls, ["target", "card", "review"], "the job ran its three model steps");
  assert.equal((await jobOf(zone.id)).state, "completed");
  // Every call is the owner's, in the owner's own evidence project, under one scope the allowance can sum — and none is the feed's.
  const booked = await requestsOf(owner.id);
  assert.equal(booked.length, 3);
  assert.deepEqual([...new Set(booked.map((row) => row.purpose))], ["evidence-upkeep"]);
  assert.deepEqual([...new Set(booked.map((row) => row.project_id))], [EVIDENCE_PROJECT_ID]);
  assert.equal(new Set(booked.map((row) => row.run_id)).size, 1);
  assert.match(booked[0].run_id, /^evup_[0-9a-f]{32}$/);
  assert.deepEqual(await requestsOf(operator.id), [], "nothing reached the operator's internal frontier project");
  assert.equal(frontierReads, 0, "the platform's frontier budget was never consulted for an account's zone");
  // Charged exactly what the three calls cost, once, on the owner's statement under its own line.
  const spent = booked.reduce((sum, row) => sum + units(row.cost), 0n);
  assert.ok(spent > 0n);
  const after = await owner.balance();
  assert.equal(units(before) - units(after), spent, "the owner's balance fell by what the calls cost, to the last 1e-8");
  const line = (await owner.credits.statements(owner.id)).items.find((item) => item.runId === booked[0].run_id);
  assert.deepEqual([line?.status, line?.title], ["settled", "证据专区更新 · Kidney trials"], "under its own line, never 「深度研究」");
  assert.equal(units(line?.amount), spent);
  assert.deepEqual([editorial.counters.ownerJobs, editorial.counters.officialJobs, editorial.counters.charged, editorial.counters.waived], [1, 0, 1, 0]);
  // And once: the run is over, so asking again settles nothing more.
  await editorial.settleUpkeep({ id: "x" }, null);
  assert.equal(units(await owner.balance()), units(after));
});

test("an official zone keeps running on the platform's frontier budget exactly as before", options, async () => {
  const publisherZone = await zoneWithWork(PLATFORM_PUBLISHER_USER_ID, { kind: "official", title: "Kidney official" });
  const marked = await zoneWithWork(operator.id, { kind: "official", title: "Kidney marked" });
  assert.equal(publisherZone.user_id, PLATFORM_PUBLISHER_USER_ID);
  const editorial = worker();
  await editorial.tick();
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()");
  await editorial.tick();
  assert.equal(model.calls.length, 6, "both official zones were kept current");
  const booked = await requestsOf(operator.id);
  assert.equal(booked.length, 6);
  assert.deepEqual([...new Set(booked.map((row) => row.purpose))], ["frontier"], "the feed's own purpose");
  assert.deepEqual([...new Set(booked.map((row) => row.project_id))], ["evimed-frontier"]);
  assert.deepEqual([...new Set(booked.map((row) => row.run_id))], [null], "no scope: the platform's spend is not billed to anyone");
  assert.deepEqual(await requestsOf(PLATFORM_PUBLISHER_USER_ID), []);
  assert.ok(frontierReads >= 6, "the frontier budget governed each model step");
  assert.deepEqual([editorial.counters.officialJobs, editorial.counters.ownerJobs, editorial.counters.charged], [2, 0, 0]);
  assert.equal(marked.user_id, operator.id);
  // The platform's budget still stops an official zone, as it always did.
  await zoneWithWork(PLATFORM_PUBLISHER_USER_ID, { kind: "official", title: "Kidney waiting" });
  const stopped = worker({ budget: async () => ({ state: "exhausted" }) });
  await stopped.tick();
  assert.equal(model.calls.length, 6, "an exhausted frontier budget makes an official zone wait");
});

test("an owner with no allowance causes no source read at all: the allowance is asked before anything is read, every time the job comes back", options, async () => {
  const owner = await account("broke-reads", 0);
  const zone = await zoneWithWork(owner.id);
  /** @type {string[]} */
  const reads = [];
  const editorial = worker({ credits: owner.credits, deferralMs: 1, readSource: async (/** @type {string} */ address) => { reads.push(address); return { text: DOCUMENT, coverage: "abstract", receipt: { sha256: evidenceHash(DOCUMENT) } }; } });
  for (let round = 0; round < 3; round += 1) {
    await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()");
    await editorial.tick();
  }
  assert.deepEqual(reads, [], "no source was read for an owner who cannot pay");
  assert.deepEqual(model.calls, []);
  const job = await jobOf(zone.id);
  assert.deepEqual([job.state, job.last_error, job.attempts], ["pending", "evidence_upkeep_no_allowance", 0]);
  assert.ok(editorial.counters.deferredNoAllowance >= 1);
  // The control: an official zone is the platform's and reads as it always did, with no allowance asked.
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()+interval '1 day' WHERE zone_id=$1", [zone.id]);
  await zoneWithWork(PLATFORM_PUBLISHER_USER_ID, { kind: "official", title: "Kidney official reads" });
  await editorial.tick();
  assert.ok(reads.length > 0, "the platform's own zone is read");
});

test("an owner with no allowance has the job set aside by name; nothing runs, nothing is booked, and the platform pays nothing", options, async () => {
  const owner = await account("broke", 0);
  const zone = await zoneWithWork(owner.id);
  const editorial = worker({ credits: owner.credits, deferralMs: 3_600_000 });
  await editorial.tick();
  assert.deepEqual(model.calls, [], "no model call was made");
  const job = await jobOf(zone.id);
  assert.deepEqual([job.state, job.last_error, job.attempts], ["pending", "evidence_upkeep_no_allowance", 0], "set aside, and the attempt it cost is given back");
  assert.ok(new Date(job.available_at).getTime() > Date.now() + 3_000_000, "asked again later, not on the next tick");
  assert.deepEqual(await requestsOf(owner.id), []);
  assert.deepEqual(await requestsOf(operator.id), [], "the feed's budget paid for nothing either");
  assert.equal(frontierReads, 0);
  // The owner reads it where they manage the zone's updates.
  const status = await editorial.automation(owner.user, zone.id);
  assert.equal(status.automation.lastError, "evidence_upkeep_no_allowance");
  assert.equal(status.recent[0].lastError, "evidence_upkeep_no_allowance");
  assert.deepEqual(status.billing, { payer: "owner", official: false, purpose: "evidence-upkeep" });
  assert.deepEqual([editorial.counters.deferredNoAllowance, editorial.counters.failed], [1, 0], "a wait, not a failure");
  // Once the owner has an allowance the same job runs, and is charged to them.
  await owner.credits.operatorGrant(owner.id, { requestId: `grant-${randomUUID()}`, source: "compensation", amount: "50" });
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp() WHERE id=$1", [job.id]);
  await editorial.tick();
  assert.deepEqual(model.calls, ["target", "card", "review"]);
  assert.equal((await jobOf(zone.id)).state, "completed");
  assert.ok(units(await owner.balance()) < units("50"), "and now it is charged to them");
});

test("an owner's own cap holds their upkeep too, and it waits by the cap's own code without spending the platform's money", options, async () => {
  const owner = await account("capped");
  const zone = await zoneWithWork(owner.id);
  // A cap far below one call's reservation: the ledger refuses the first request, as it would for the owner's own run.
  const editorial = worker({ credits: owner.credits, editorOverrides: { userDailySpendLimit: 0.0001 } });
  await editorial.tick();
  const job = await jobOf(zone.id);
  assert.deepEqual([job.state, job.last_error, job.attempts], ["pending", "usage_budget_exceeded", 0]);
  assert.deepEqual(model.calls, [], "the provider was never asked");
  assert.deepEqual(await requestsOf(operator.id), []);
  assert.equal(frontierReads, 0);
  assert.deepEqual([editorial.counters.deferredCap, editorial.counters.failed], [1, 0]);
  // Without a cap the same job runs.
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp() WHERE id=$1", [job.id]);
  await worker({ credits: owner.credits }).tick();
  assert.equal((await jobOf(zone.id)).state, "completed");
});

test("where billing is off the owner's upkeep is still attributed to them and capped, never the platform's", options, async () => {
  const owner = await account("unbilled");
  const zone = await zoneWithWork(owner.id);
  await worker({ credits: null }).tick();
  const booked = await requestsOf(owner.id);
  assert.equal(booked.length, 3);
  assert.deepEqual([...new Set(booked.map((row) => row.purpose))], ["evidence-upkeep"]);
  assert.deepEqual(await requestsOf(operator.id), []);
  assert.equal((await jobOf(zone.id)).state, "completed");
  // And the owner's cap still applies.
  const second = await account("unbilled-capped");
  const capped = await zoneWithWork(second.id, { title: "Kidney capped" });
  await worker({ credits: null, editorOverrides: { userDailySpendLimit: 0.0001 } }).tick();
  assert.equal((await jobOf(capped.id)).last_error, "usage_budget_exceeded");
  assert.deepEqual(await requestsOf(second.id), []);
});

test("a deployment that cannot say whose project to book to waits rather than let the platform pay", options, async () => {
  const owner = await account("unattributable");
  const zone = await zoneWithWork(owner.id);
  const editorial = worker({ credits: owner.credits, ensureProject: null });
  await editorial.tick();
  assert.deepEqual(model.calls, []);
  assert.equal((await jobOf(zone.id)).last_error, "evidence_budget_wait");
  assert.deepEqual(await requestsOf(operator.id), []);
});

test("a job that ends without delivering is recorded against the owner and not charged, the rule a failed run follows", options, async () => {
  const owner = await account("failed");
  const zone = await zoneWithWork(owner.id);
  model.fail = "review";
  const editorial = worker({ credits: owner.credits });
  const before = await owner.balance();
  await editorial.tick();
  assert.deepEqual(model.calls, ["target", "card", "review"]);
  assert.notEqual((await jobOf(zone.id)).state, "completed");
  const booked = await requestsOf(owner.id);
  assert.equal(booked.length, 3, "what the failed attempt cost is on the owner's account, in the ledger, visible");
  assert.equal(units(await owner.balance()), units(before), "but a failed attempt is not charged");
  assert.deepEqual([editorial.counters.charged, editorial.counters.waived], [0, 1], "it is counted as recorded and waived, not as a charge");
  const settlement = (await rows("SELECT run_id,charge_basis FROM evimed_credits.settlements WHERE user_id=$1", [owner.id]))[0];
  assert.deepEqual([settlement.run_id, settlement.charge_basis], [booked[0].run_id, "not_charged"], "and the line says it was recorded and waived");
  // The retry is a new execution with a scope of its own.
  model.fail = null;
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp() WHERE zone_id=$1", [zone.id]);
  await editorial.tick();
  assert.equal(new Set((await requestsOf(owner.id)).map((row) => row.run_id)).size, 2);
});

test("who may manage a zone's updates: its owner, or an operator for an official zone whose owner cannot sign in", options, async () => {
  const owner = await account("manager");
  const stranger = await account("stranger");
  const mine = await zoneWithWork(owner.id);
  const official = await zoneWithWork(PLATFORM_PUBLISHER_USER_ID, { kind: "official", title: "Kidney official" });
  const editorial = worker({ credits: owner.credits });
  const settings = { enabled: true, query: "kidney", sourceTypes: ["journal"], intervalHours: 24, maxCardsPerRun: 1 };
  const refusal = (/** @type {string} */ code) => (/** @type {any} */ error) => error?.code === code;
  await assert.rejects(editorial.automation(stranger.user, official.id, { ...settings, expectedRevision: official.revision }, "PUT"), refusal("evidence_owner_required"));
  await assert.rejects(editorial.automation(operator, mine.id, { ...settings, expectedRevision: mine.revision }, "PUT"), refusal("evidence_owner_required"), "an operator does not manage an account's own zone");
  const platform = await editorial.automation(operator, official.id, { ...settings, expectedRevision: official.revision }, "PUT");
  assert.deepEqual(platform.billing, { payer: "platform", official: true, purpose: "frontier" }, "enabling updates on an official zone says the platform pays");
  const own = await editorial.automation(owner.user, mine.id, { ...settings, expectedRevision: mine.revision }, "PUT");
  assert.deepEqual(own.billing, { payer: "owner", official: false, purpose: "evidence-upkeep" }, "enabling updates on an account's zone says it is billed to the owner");
  assert.equal((await editorial.automation(owner.user, mine.id)).billing.payer, "owner", "and the owner is told before they switch it on");
});

test("the editor books a call to whoever it is told to: the owner's account with no platform limits, or the feed's", async () => {
  /** @type {any[]} */
  const calls = [];
  const callModel = async (/** @type {any} */ _deps, /** @type {any} */ call) => { calls.push(call); return { choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] }; };
  const editor = new FrontierEditor(editorConfig, { owner: frontierOwner, callModel });
  await editor.evidenceReview({ title: "t" });
  await editor.evidenceReview({ title: "t" }, { userId: "owner-1", projectId: EVIDENCE_PROJECT_ID, purpose: "evidence-upkeep", runId: "evup_1" });
  assert.deepEqual([calls[0].purpose, calls[0].userId, calls[0].projectId, calls[0].limits], ["frontier", operator.id, "evimed-frontier", { daily: 0, weekly: 0 }]);
  assert.deepEqual([calls[1].purpose, calls[1].userId, calls[1].projectId, calls[1].runId, calls[1].limits], ["evidence-upkeep", "owner-1", EVIDENCE_PROJECT_ID, "evup_1", undefined],
    "an account's call carries its own account's caps: no limits override");
  // A billed call needs only the provider; the feed's owner is not its business.
  const ownerless = new FrontierEditor(editorConfig, { owner: null, callModel });
  assert.equal(ownerless.available, false);
  assert.equal(ownerless.providerReady, true);
  await ownerless.evidenceReview({ title: "t" }, { userId: "owner-1", projectId: EVIDENCE_PROJECT_ID, purpose: "evidence-upkeep", runId: "evup_2" });
  await assert.rejects(ownerless.evidenceReview({ title: "t" }), { code: "frontier_editor_unavailable" });
});
