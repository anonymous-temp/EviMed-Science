// The platform's evidence programme's base (evidence-flywheel B7, 2026-10-05): the usage purpose `evidence`, its own daily budget and slot,
// the internal project `evimed-evidence` the publisher account owns, and the purpose `evidence-upkeep` that stays the owner's own money.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID, USAGE_PURPOSES } from "@evimed/domain";
import { createEvidenceBudget, evidenceBudgetMetricFamilies } from "../src/evidenceBudget.mjs";
import { EVIDENCE_PROJECT_ID, ensureEvidenceProject, isInternalProjectOf } from "../src/internalProjects.mjs";
import { createStore } from "../src/store.mjs";
import { UNCAPPED_USAGE_PURPOSES, UsageLedger } from "../src/usageLedger.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
/** @type {any} */ let isolated, store, ledger, dataDir;
const researcher = "evidence-programme-researcher";
const noon = new Date("2026-10-05T05:00:00.000Z"); // 13:00 in the feed's day (Asia/Shanghai)
const programme = (/** @type {Record<string, any>} */ over = {}) => ({ evidenceProgrammeEnabled: true, evidenceProgrammeDailyBudgetCny: 30, evidenceProgrammeMaxConcurrency: 1, frontierTimeZone: "Asia/Shanghai", ...over });

/** One model call booked and settled at `cost`. */
async function spend(userId, projectId, purpose, cost, at = noon, extra = {}) {
  const id = randomUUID();
  const reserved = await ledger.reserveModel({
    id, userId, projectId, purpose, model: "deepseek-v4-flash", priceVersion: "evimed-reference-2026-09-05", currency: "CNY",
    requestFingerprint: createHash("sha256").update(id).digest("hex"), estimatedCost: Math.max(cost, 0.01), dailyLimit: 0, weeklyLimit: 0, now: at, ...extra,
  });
  await ledger.settleModel(userId, reserved.id, { usage: { cacheHitTokens: 0, cacheMissTokens: 10, completionTokens: 5 }, actualCost: cost, priced: true });
  return reserved;
}

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "evidenceprogramme");
  dataDir = await mkdtemp(join(tmpdir(), "evidence-programme-"));
  store = createStore({ stateStore: "postgres", databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000, dataDir, maxProjectBytes: 1_048_576 });
  await store.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Researcher','development')", [researcher]);
  await store.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [researcher]);
  ledger = new UsageLedger(store.database);
  await ensureEvidenceProject(store);
  await ensureEvidenceProject(store, researcher);
});
after(async () => {
  await store?.close();
  await isolated?.drop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("the evidence project is made once under the publisher, and again under a researcher, and is the platform's own work in both", options, async () => {
  const user = await store.userById(PLATFORM_PUBLISHER_USER_ID);
  const first = await store.requireProject(user, EVIDENCE_PROJECT_ID);
  assert.equal(first.id, EVIDENCE_PROJECT_ID); assert.equal(first.userId, PLATFORM_PUBLISHER_USER_ID);
  assert.deepEqual(await ensureEvidenceProject(store), { userId: PLATFORM_PUBLISHER_USER_ID, projectId: EVIDENCE_PROJECT_ID });
  assert.equal((await store.database.query("SELECT count(*) AS n FROM evimed_control.projects WHERE id=$1", [EVIDENCE_PROJECT_ID])).rows[0].n, "2", "one for the publisher, one for the researcher, none twice");
  assert.deepEqual(await ensureEvidenceProject(store, researcher), { userId: researcher, projectId: EVIDENCE_PROJECT_ID });
  // Internal for either owner, by name: the researcher's copy never reads as one of their projects.
  for (const userId of [PLATFORM_PUBLISHER_USER_ID, researcher]) assert.equal(isInternalProjectOf({ operatorUsers: [] }, userId, EVIDENCE_PROJECT_ID), true, userId);
  await assert.rejects(ensureEvidenceProject(store, "nobody-here"), { code: "evidence_account_unavailable", status: 503 });
});

test("purpose `evidence` has its own row in the operator's cost report; the report lists every purpose", options, async () => {
  const at = new Date("2034-03-03T00:00:00.000Z");
  await spend(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "evidence", 1.5, at);
  await spend(researcher, EVIDENCE_PROJECT_ID, "evidence-upkeep", 0.25, at);
  const report = await ledger.usageByPurpose({ since: at });
  assert.deepEqual(report.map((row) => row.purpose), [...USAGE_PURPOSES]);
  assert.equal(report.find((row) => row.purpose === "evidence")?.costCny, 1.5, "the programme's money is a line of its own");
  assert.equal(report.find((row) => row.purpose === "evidence-upkeep")?.costCny, 0.25, "and so is an account's own upkeep");
  assert.equal(report.find((row) => row.purpose === "frontier")?.costCny, 0, "neither is folded into the feed's");
  // The database holds the vocabulary: the new purposes are accepted by its CHECK and a made-up one is still refused.
  await assert.rejects(store.database.query("UPDATE evimed_usage.model_requests SET purpose='evidence-gossip' WHERE purpose='evidence'"), (/** @type {any} */ error) => error.code === "23514");
});

test("`evidence` is held by the programme's budget and never by anyone's caps; `evidence-upkeep` is the account's own spend and counts", options, async () => {
  assert.ok(UNCAPPED_USAGE_PURPOSES.includes("evidence"));
  assert.equal(UNCAPPED_USAGE_PURPOSES.includes("evidence-upkeep"), false);
  const at = new Date("2034-04-04T00:00:00.000Z");
  const base = { id: randomUUID(), model: "deepseek-v4-flash", priceVersion: "evimed-reference-2026-09-05", currency: "CNY", estimatedCost: 0.75, dailyLimit: 0.8, weeklyLimit: 0, now: at };
  const ask = (/** @type {string} */ userId, /** @type {string} */ projectId, /** @type {string} */ purpose) => {
    const id = randomUUID();
    return ledger.reserveModel({ ...base, id, userId, projectId, purpose, requestFingerprint: createHash("sha256").update(id).digest("hex") });
  };
  await spend(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "evidence", 0.5, at);
  await spend(researcher, EVIDENCE_PROJECT_ID, "evidence-upkeep", 0.5, at);
  // The publisher's own programme spend is not counted against the cap another call is admitted under...
  assert.equal((await ask(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "kernel")).status, "reserved");
  // ...but a researcher's upkeep is: it is their account's spend, and the next call is refused at their own cap.
  await assert.rejects(ask(researcher, "default", "kernel"), { code: "usage_budget_exceeded", status: 402 });
  await assert.rejects(ask(researcher, EVIDENCE_PROJECT_ID, "evidence-upkeep"), { code: "usage_budget_exceeded", status: 402 }, "the upkeep itself meets the owner's cap");
});

test("the budget counts only the publisher's `evidence` rows of the feed's day, and answers by the frontier's states", options, async () => {
  const budget = createEvidenceBudget({ usageLedger: ledger, config: programme(), now: () => noon });
  const day = new Date("2026-10-05T01:00:00.000Z"); // 09:00 CST, the same day
  await spend(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "evidence", 7, day);
  // None of these is the programme's money today: yesterday's, the feed's, the owner's upkeep, another account's.
  await spend(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "evidence", 100, new Date("2026-10-04T12:00:00.000Z"));
  await spend(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "frontier", 100, day);
  await spend(researcher, EVIDENCE_PROJECT_ID, "evidence-upkeep", 100, day);
  await spend(researcher, "default", "evidence", 100, day);
  const reading = await budget.budget();
  assert.deepEqual({ spentCny: reading.spentCny, budgetCny: reading.budgetCny, remainingCny: reading.remainingCny, state: reading.state, measured: reading.measured },
    { spentCny: 7, budgetCny: 30, remainingCny: 23, state: "ok", measured: true });
  assert.equal(await budget.remainingCny(), 23);
  await spend(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "evidence", 17.5, day);
  assert.equal((await budget.budget()).state, "throttled", "from 80% of the day, as the frontier's budget reads");
  await spend(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "evidence", 6, day);
  const spent = await budget.budget();
  assert.deepEqual([spent.state, spent.remainingCny], ["exhausted", 0]);
  // Tomorrow the day is new.
  const tomorrow = createEvidenceBudget({ usageLedger: ledger, config: programme(), now: () => new Date("2026-10-06T05:00:00.000Z") });
  assert.deepEqual([(await tomorrow.budget()).spentCny, (await tomorrow.budget()).state], [0, "ok"]);
});

test("`reserve` is a question, not a hold: it admits what the day can afford and counts each refusal by reason", options, async () => {
  const day = new Date("2034-05-05T05:00:00.000Z");
  const budget = createEvidenceBudget({ usageLedger: ledger, config: programme({ evidenceProgrammeDailyBudgetCny: 10 }), now: () => day });
  assert.deepEqual(await budget.reserve(7), { granted: true, reason: "ok", remainingCny: 10, state: "ok" });
  await spend(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "evidence", 5, day);
  assert.equal((await budget.reserve(7)).reason, "estimate_exceeds_remaining", "a deep synthesis costs about 7 yuan and the day has 5 left");
  assert.equal((await budget.reserve(4)).granted, true);
  await spend(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID, "evidence", 5, day);
  assert.equal((await budget.reserve(1)).reason, "exhausted");
  const status = budget.status();
  assert.equal(status.counters.granted, 2); assert.equal(status.counters.refused.estimate_exceeds_remaining, 1); assert.equal(status.counters.refused.exhausted, 1);
  // A budget of 0 is no budget, as every spend limit here reads 0.
  const unbounded = createEvidenceBudget({ usageLedger: ledger, config: programme({ evidenceProgrammeDailyBudgetCny: 0 }), now: () => day });
  assert.deepEqual([(await unbounded.budget()).state, await unbounded.remainingCny(), (await unbounded.reserve(1000)).granted], ["ok", null, true]);
});

test("a switch that is off reads no table, and a budget that cannot be read admits nothing", options, async () => {
  let reads = 0;
  const watching = { purposeSpend: async () => { reads += 1; return 0; } };
  const off = createEvidenceBudget({ usageLedger: /** @type {any} */ (watching), config: programme({ evidenceProgrammeEnabled: false }), now: () => noon });
  assert.deepEqual([(await off.budget()).state, await off.remainingCny(), (await off.reserve(1)).reason, off.tryAcquireSlot()], ["off", null, "off", null]);
  assert.equal(reads, 0, "no query while the programme is off");
  const broken = createEvidenceBudget({ usageLedger: /** @type {any} */ ({ purposeSpend: async () => { throw new Error("database down"); } }), config: programme(), now: () => noon });
  const reading = await broken.budget();
  assert.deepEqual([reading.state, reading.measured], ["unavailable", false]);
  assert.equal(await broken.remainingCny(), 0, "unreadable is nothing left, never plenty");
  assert.equal((await broken.reserve(0.01)).reason, "unmeasured");
  assert.equal(broken.status().counters.readFailures >= 2, true);
});

test("the programme works one thing at a time by default, and a slot is returned once", options, async () => {
  const budget = createEvidenceBudget({ usageLedger: ledger, config: programme(), now: () => noon });
  const first = budget.tryAcquireSlot();
  assert.ok(first); assert.equal(budget.tryAcquireSlot(), null, "the second asks while the first holds the only slot");
  first.release(); first.release();
  assert.equal(budget.status().slotsInUse, 0, "releasing twice frees one slot, not two");
  const second = budget.tryAcquireSlot(); assert.ok(second); second.release();
  const wide = createEvidenceBudget({ usageLedger: ledger, config: programme({ evidenceProgrammeMaxConcurrency: 2 }), now: () => noon });
  assert.ok(wide.tryAcquireSlot() && wide.tryAcquireSlot()); assert.equal(wide.tryAcquireSlot(), null);
  assert.deepEqual([budget.status().counters.slotsGranted, budget.status().counters.slotsRefused], [2, 1]);
});

test("every lever has a metric family, and the budget's families read today's state", options, async () => {
  const off = evidenceBudgetMetricFamilies(programme({ evidenceProgrammeEnabled: false }), null);
  const named = (/** @type {any[]} */ families, /** @type {string} */ name) => families.find((family) => family.name === name);
  assert.deepEqual(off.map((family) => family.name).sort(), ["open_science_evidence_programme_enabled", "open_science_evidence_public_indexable", "open_science_evidence_public_web_enabled"]);
  assert.equal(named(off, "open_science_evidence_programme_enabled").series[0].value, 0);
  const budget = createEvidenceBudget({ usageLedger: ledger, config: programme({ evidencePublicWebEnabled: true }), now: () => noon });
  const reading = await budget.budget();
  const on = evidenceBudgetMetricFamilies(programme({ evidencePublicWebEnabled: true }), budget, reading, { officialJobs: 3, ownerJobs: 2, deferredNoAllowance: 1, deferredCap: 0, charged: 1, waived: 1, chargeFailed: 0 });
  assert.equal(named(on, "open_science_evidence_programme_budget_limit_cny").series[0].value, 30);
  assert.equal(named(on, "open_science_evidence_programme_budget_spent_cny").series[0].value, reading.spentCny);
  assert.equal(named(on, "open_science_evidence_programme_concurrency_limit").series[0].value, 1);
  assert.equal(named(on, "open_science_evidence_public_web_enabled").series[0].value, 1);
  assert.equal(named(on, "open_science_evidence_public_indexable").series[0].value, 0, "indexing stays its own, separate lever");
  assert.deepEqual(named(on, "open_science_evidence_upkeep_jobs_total").series, [{ labels: { payer: "platform" }, value: 3 }, { labels: { payer: "owner" }, value: 2 }]);
  assert.deepEqual(named(on, "open_science_evidence_upkeep_deferred_total").series, [{ labels: { reason: "no_allowance" }, value: 1 }, { labels: { reason: "owner_cap" }, value: 0 }]);
});
