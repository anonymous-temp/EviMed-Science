// Flywheel F24 (2026-10-06): what the frontier feed knows about a study's subject reaches the study through the module's own tick.
// The first test is the one the rest hang on — a frozen analysis plan is never touched: new evidence for a card of a study whose plan
// has frozen is labelled, noticed, read by a run the study's programme sends, and written as a version beside the frozen one, with
// the seal, the study's current card and its recomputation exactly as they were. Then the same news for a study that has not frozen
// (taken in as any edit of a card is), the run that may not start (the label and the notice stand, nothing else happens), the trial
// events as candidates that are never precedents, and the bound and the switch.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";

import { createEntityVocabulary } from "../src/entityVocabulary.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { HttpError } from "../src/security.mjs";
import { createSourceChanges } from "../src/sourceChanges.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { createVcrFrontierEvents, registryOfId, trialEventOf } from "../src/vcrFrontierEvents.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { createVcrNotifier } from "../src/vcrNotify.mjs";
import { VcrOrchestrator } from "../src/vcrOrchestrator.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { skipWithoutDatabase, startVcr } from "./helpers/vcrFlywheelFixture.mjs";

/** @type {Awaited<ReturnType<typeof startVcr>>} */
let fixture;
/** @type {any} */ let sourceChanges;
/** @type {any} */ let orchestrator;
/** @type {any} */ let consumer;
/** @type {any[]} */ const notices = [];
/** @type {any[]} */ const dispatches = [];
/** @type {{ refuse: string | null }} */ const dispatcher = { refuse: null };
/** @type {{ recomputes: any[] }} */ const spy = { recomputes: [] };
const now = () => new Date();
const USER = "u-fe";
const ENTITIES = ["drug:osimertinib", "disease:nsclc"];
const EVIDENCE_PARAMETER = "median_time";

before(async () => {
  if (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL) return;
  fixture = await startVcr({ label: "vcrfe", withFrontier: true, users: [USER],
    config: { vcrFrontierEventsEnabled: true, vcrFrontierEventsStudiesPerTick: 10, vcrFrontierEventsWindowDays: 30, vcrStudyCpuBudget: 1_000_000 } });
  await insertSource(fixture.database, "nejm");
  await insertSource(fixture.database, "fda-news", { lane: "regulatory", source_type: "regulator" });
  const { vcr, database } = fixture;
  sourceChanges = createSourceChanges({ documents: new ProductDocuments(database), ownerUserId: PLATFORM_PUBLISHER_USER_ID });
  const notifier = createVcrNotifier({ notifications: { create: async (userId, input) => { notices.push({ userId, ...input }); return { id: `n${notices.length}` }; } }, store: vcr.store });
  orchestrator = new VcrOrchestrator({
    store: vcr.store, jobs: vcr.jobs, config: { vcrEnabled: true, vcrLeaseMs: 900_000 }, notifier, seal: vcr.seal, now,
    dispatchRun: async (request) => {
      if (dispatcher.refuse) throw new HttpError(402, dispatcher.refuse, "The allowance does not cover this run.");
      dispatches.push(request);
      return { runId: `run-${dispatches.length}`, sessionId: `session-${dispatches.length}`, status: "running" };
    },
  });
  const recompute = orchestrator.recomputeAfterChange.bind(orchestrator);
  orchestrator.recomputeAfterChange = async (input) => { spy.recomputes.push(input); return recompute(input); };
  consumer = createVcrFrontierEvents({
    store: vcr.store, entityVocabulary: createEntityVocabulary({ database, enabled: true }), sourceChanges,
    orchestrator: () => orchestrator, notifier: () => notifier, levers: { studiesPerTick: 10, windowDays: 30 }, now,
  });
});
after(async () => { await fixture?.close(); });

/** A study of the account about `ENTITIES`, with the precedent NCT02296125 and a card taken from its verified control-arm median. */
async function studyWithCard({ name, intendedUse = "exploratory", entityKeys = ENTITIES }) {
  const { vcr, write } = fixture;
  const study = await vcr.store.createStudy({ userId: USER, projectId: `prj-${name}`, name, question: "二线 NSCLC 的 PFS", dataTier: "T0", intendedUse });
  await vcr.store.query("UPDATE evimed_vcr.studies SET entity_keys = $2::text[] WHERE id = $1", [study.id, entityKeys]);
  await write(study, "precedent", [{ registryId: "NCT02296125", endpointKeys: { "Median Progression Free Survival (PFS) (Months)": "pfs-blinded" },
    armRoles: { "SoC EGFR-TKI (Global Cohort)": "control", "Osimertinib 80 mg (Global Cohort)": "treatment" } }]);
  const [item] = (await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: EVIDENCE_PARAMETER, verifiedOnly: true })).filter((row) => row.arm_role === "control");
  const card = { key: "control_pfs", name: "对照组中位 PFS", sourceKind: "external_evidence", parameter: EVIDENCE_PARAMETER, evidenceIds: [item.id] };
  const written = await write(study, "assumption", [card]);
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  // News is what appeared after the card version was written: the tests date their items a millisecond after it.
  const createdAt = (await vcr.store.assumptions(study.id)).find((entry) => entry.key === card.key).createdAt;
  return { study, card, evidenceId: item.id, newsAt: new Date(Date.parse(createdAt) + 1).toISOString() };
}

/** One feed item the way the pipeline leaves one, with the columns the entity match reads. */
async function feedItem(overrides) {
  const at = overrides.at ?? new Date().toISOString();
  const { id } = await insertItem(fixture.database, { sourceId: "nejm", timelineAt: at, visibleAt: at, ...overrides.row });
  await fixture.database.query("UPDATE evimed_frontier.items SET registry_ids = $2::text[], entity_keys = $3::text[] WHERE id = $1",
    [id, overrides.registryIds ?? [], overrides.entityKeys ?? ENTITIES]);
  return id;
}

/** The runtime's write as the evidence-refresh run makes it: the gateway's own path, reserved for the dispatch the orchestrator named. */
function runWrites(study, items, dispatchId) {
  const { vcr } = fixture;
  return vcrRuntimeWrite({
    store: vcr.store, service: vcr.service, orchestrator, study, what: "assumption", items,
    evidence: vcr.evidence, evidenceStore: vcr.evidenceStore, matchStore: vcr.matchStore, matching: vcr.matching, seal: vcr.seal,
    dataPlane: null, documents: null, report: () => {}, caller: { runtimeRunId: dispatchId },
  });
}

const refreshMarks = (studyId) => fixture.vcr.store.rows("SELECT key, state, dispatch_id, detail FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND key LIKE 'run:evidence-refresh:%'", [studyId]);

test("a frozen analysis plan is never touched: the news is labelled, a run reads it, and the version lands beside the frozen one", skipWithoutDatabase, async () => {
  const { vcr } = fixture;
  const { study, card, evidenceId, newsAt } = await studyWithCard({ name: "frozen", intendedUse: "specified_analysis" });
  // The plan freezes with the card at version 1 — what the seal's hash covers.
  const frozen = await vcr.seal.freezePlan({ studyId: study.id, actor: "orchestrator",
    plan: { intendedUse: "specified_analysis", comparator: { route: "external" }, endpoint: { kind: "time_to_event" }, assumptions: [{ key: card.key, version: 1 }] } });
  assert.ok(frozen.planFrozenAt, "the study's analysis plan is frozen");
  const before = { seal: (await vcr.store.studyById(study.id)).outcomeSeal, card: (await vcr.store.assumptions(study.id)).find((entry) => entry.key === card.key), stale: await vcr.store.staleMarks(study.id) };
  assert.equal(before.card.version, 1);

  // News: a results report of the very trial the card stands on, newer than the card.
  const itemId = await feedItem({ registryIds: ["NCT02296125"], at: newsAt, row: { title: "Final overall survival of NCT02296125", evidenceType: "rct" } });
  await consumer.tick();

  const signals = (await consumer.signalsFor(study.id)).get(card.key);
  assert.equal(signals.open.length, 1, "the card reads 「有新证据」");
  assert.deepEqual([signals.open[0].cause, signals.open[0].itemId], ["new_results", itemId]);
  const notice = notices.filter((entry) => entry.source.id.startsWith(`${study.id}/`)).at(-1);
  assert.equal(notice.userId, USER);
  assert.match(notice.body, /冻结/, "the notice says the plan is frozen and stays so");
  const [mark] = await refreshMarks(study.id);
  assert.equal(mark.state, "pending", "the programme is asked for a run, by a key that names the news");
  assert.deepEqual(mark.detail.keys, [card.key]);
  assert.match(mark.detail.brief, /NCT02296125/);

  // The programme dispatches it as any run: the evidence capability, a reason that names the line.
  await orchestrator.advance(study.id);
  assert.equal(dispatches.at(-1).capabilityId, "vcr-evidence");
  assert.equal(dispatches.at(-1).reason, "vcr:evidence-refresh");
  const dispatchId = dispatches.at(-1).dispatchId;

  // The run extracts and the platform writes the card from the verified value: the version is written, and only beside the frozen one.
  spy.recomputes.length = 0;
  const wrote = await runWrites(study, [{ ...card, evidenceIds: [evidenceId] }], dispatchId);
  assert.equal(wrote.ok, true, JSON.stringify(wrote.issues));
  assert.equal(spy.recomputes.length, 0, "no change of the plan's inputs is announced");
  const now1 = (await vcr.store.assumptions(study.id)).find((entry) => entry.key === card.key);
  assert.equal(now1.version, 1, "the card the study works from is still the frozen version");
  const versions = await vcr.store.assumptionVersions(study.id, card.key);
  assert.deepEqual(versions.map((entry) => [entry.version, entry.afterFreeze]), [[2, true], [1, false]], "the new version is visible beside it, marked as written after the freeze");
  assert.deepEqual(await vcr.store.staleMarks(study.id), before.stale, "nothing is stale");
  assert.deepEqual((await vcr.store.studyById(study.id)).outcomeSeal, before.seal, "the seal — its time, its hash, its version — is as it was");
  assert.equal((await vcr.evidenceStore.latestAssumption({ studyId: study.id, key: card.key })).version, 1, "every reader of the current card skips it");

  // The run ends; the next scan closes the label and the page says the version came after the freeze.
  await orchestrator.onRunFinished({ userId: USER, id: study.projectId }, { id: "run-1", dispatchId, status: "succeeded" });
  await consumer.tick();
  const after = (await consumer.signalsFor(study.id)).get(card.key);
  assert.equal(after.open.length, 0);
  assert.equal(after.afterFreeze, 2);

  // Control: the same card written by an ordinary writer — not the run the platform sent — is a new current version and is announced,
  // which for a frozen study is the existing behaviour (a changed input is a new freeze). The flag is the run's alone.
  const ordinary = await runWrites(study, [{ ...card, evidenceIds: [evidenceId] }], "vcr-ordinary-conversation");
  assert.equal(ordinary.ok, true);
  assert.equal((await vcr.store.assumptions(study.id)).find((entry) => entry.key === card.key).version, 3);
  assert.equal(spy.recomputes.length, 1);
});

test("a study whose plan has not frozen takes the version as any edit of a card is taken", skipWithoutDatabase, async () => {
  const { vcr } = fixture;
  const { study, card, evidenceId, newsAt } = await studyWithCard({ name: "thawed" });
  await feedItem({ registryIds: ["NCT02296125"], at: newsAt, row: { title: "Primary analysis of NCT02296125", evidenceType: "rct" }, entityKeys: ["drug:osimertinib"] });
  await consumer.tick();
  assert.equal((await consumer.signalsFor(study.id)).get(card.key).open.length, 1);
  assert.doesNotMatch(notices.filter((entry) => entry.source.id.startsWith(`${study.id}/`)).at(-1).body, /冻结/);
  await orchestrator.advance(study.id);
  const dispatchId = dispatches.at(-1).dispatchId;
  spy.recomputes.length = 0;
  await runWrites(study, [{ ...card, evidenceIds: [evidenceId] }], dispatchId);
  assert.equal((await vcr.store.assumptions(study.id)).find((entry) => entry.key === card.key).version, 2, "the new version is the study's card");
  assert.equal(spy.recomputes.length, 1, "and what stands on the card is recomputed by the programme's own rule");
  assert.equal((await vcr.store.assumptionVersions(study.id, card.key)).length, 2, "the old version stays readable");
  await orchestrator.onRunFinished({ userId: USER, id: study.projectId }, { id: "run-x", dispatchId, status: "succeeded" });
  await consumer.tick();
  const closed = (await consumer.signalsFor(study.id)).get(card.key);
  assert.deepEqual([closed.open.length, closed.afterFreeze, closed.versioned], [0, null, 2]);
});

test("when the run may not start, the label and the notice stand and no version is made", skipWithoutDatabase, async () => {
  const { vcr } = fixture;
  const { study, card, newsAt } = await studyWithCard({ name: "refused" });
  await feedItem({ registryIds: ["NCT02296125"], at: newsAt, row: { title: "Subgroup results of NCT02296125", evidenceType: "rct" } });
  const dispatched = dispatches.length;
  dispatcher.refuse = "insufficient_balance";
  try {
    await consumer.tick();
    const result = await orchestrator.advance(study.id);
    assert.equal(result.deferred, "insufficient_balance");
  } finally { dispatcher.refuse = null; }
  assert.equal(dispatches.length, dispatched, "no run went out");
  assert.equal((await consumer.signalsFor(study.id)).get(card.key).open.length, 1, "the card stays labelled");
  assert.equal(notices.some((entry) => entry.source.id === `${study.id}/data`), true, "and the notice stands");
  assert.equal((await vcr.store.assumptionVersions(study.id, card.key)).length, 1, "no version was made");
  assert.equal((await refreshMarks(study.id))[0].state, "pending", "the same rules ask again when the allowance returns");

  // A paused study asks for nothing at all: the label and the notice are all there is, and the study is not asked to do anything.
  const paused = await studyWithCard({ name: "paused" });
  await feedItem({ registryIds: ["NCT02296125"], at: paused.newsAt, row: { title: "Final analysis of NCT02296125 for the paused study", evidenceType: "rct" } });
  await vcr.store.query("UPDATE evimed_vcr.studies SET status = 'paused' WHERE id = $1", [paused.study.id]);
  await consumer.tick();
  assert.deepEqual(await refreshMarks(paused.study.id), []);
  assert.equal((await consumer.signalsFor(paused.study.id)).get(paused.card.key).open.length, 1, "the paused study's card is labelled all the same");
  assert.equal(notices.some((entry) => entry.source.id === `${paused.study.id}/data`), true);
});

test("a retraction or a new version recorded for a source of the card labels it, once", skipWithoutDatabase, async () => {
  const { study, card } = await studyWithCard({ name: "changed", entityKeys: ["drug:unrelated"] });
  await sourceChanges.record("reg:NCT02296125", { kind: "new_version", date: "2026-10-01" }, { assertedBy: "registry" });
  await consumer.tick();
  const [label] = (await consumer.signalsFor(study.id)).get(card.key).open;
  assert.equal(label.cause, "source_new_version");
  assert.equal(label.itemId, null);
  const marks = (await refreshMarks(study.id)).length;
  await consumer.tick();
  assert.equal((await consumer.signalsFor(study.id)).get(card.key).open.length, 1, "the same news is not raised twice");
  assert.equal((await refreshMarks(study.id)).length, marks, "and asks for one run");
});

test("trial events become candidates that are never precedents; a record the library holds is not raised again", skipWithoutDatabase, async () => {
  const { vcr } = fixture;
  const study = await vcr.store.createStudy({ userId: USER, projectId: "prj-candidates", name: "candidates", question: "q", dataTier: "T0" });
  await vcr.store.query("UPDATE evimed_vcr.studies SET entity_keys = $2::text[] WHERE id = $1", [study.id, ["drug:candidatumab"]]);
  const keys = ["drug:candidatumab"];
  const registered = await feedItem({ registryIds: ["NCT05550001"], entityKeys: keys, row: { title: "Registration of NCT05550001", evidenceType: "other", flags: ["registry-unpublished"], sourceType: "journal" } });
  const results = await feedItem({ registryIds: ["NCT05550002"], entityKeys: keys, row: { title: "Results of NCT05550002", evidenceType: "rct", doi: "10.1000/cand.results" } });
  const label = await feedItem({ registryIds: [], entityKeys: keys, row: { title: "Label change for candidatumab", lane: "regulatory", sourceId: "fda-news", sourceType: "regulator", evidenceType: "regulatory-decision" } });
  const opinion = await feedItem({ registryIds: [], entityKeys: keys, row: { title: "An opinion about candidatumab", evidenceType: "review-opinion" } });
  const held = await feedItem({ registryIds: ["NCT02296125"], entityKeys: keys, row: { title: "Registration of the study the account already holds", evidenceType: "other", flags: ["registry-unpublished"] } });
  // The library already holds NCT02296125 (the registry fixture answers it): the account fetched it through the evidence write.
  await fixture.write(study, "precedent", [{ registryId: "NCT02296125" }]);
  await consumer.tick();
  const candidates = await consumer.candidatesFor(USER, { studyId: study.id });
  assert.deepEqual(candidates.map((entry) => [entry.frontierItemId, entry.event]).sort(),
    [[registered, "registration"], [results, "results"], [label, "label_change"]].sort(), "only trial events, and not the record the library holds");
  assert.equal(candidates.every((entry) => entry.candidate === true), true);
  assert.deepEqual(candidates.find((entry) => entry.frontierItemId === registered)?.registryId, "NCT05550001");
  assert.equal(candidates.find((entry) => entry.frontierItemId === results)?.doi, "10.1000/cand.results");
  assert.equal(candidates.some((entry) => [opinion, held].includes(entry.frontierItemId)), false);

  // Never a precedent: the library has none of them, and the account's list reads them apart.
  const library = await vcr.evidenceStore.listPrecedents({ userId: USER });
  assert.equal(library.some((row) => ["NCT05550001", "NCT05550002"].includes(row.registry_id)), false);
  const page = await vcr.service.precedents({ id: USER }, {});
  assert.equal(Array.isArray(page.precedents), true);

  // Idempotent: a second tick over the same feed raises nothing new.
  const raised = consumer.counters.candidates;
  await consumer.tick();
  assert.equal(consumer.counters.candidates, raised);
  // The existing path accepts one: fetching its record through the evidence write makes it a precedent, and it leaves the candidates.
  const accepted = await fixture.write(study, "precedent", [{ registryId: "NCT02296125" }]);
  assert.equal(accepted.ok, true);
  assert.equal((await consumer.candidatesFor(USER, { studyId: study.id })).length, 3, "NCT02296125 was never one; the three still wait for the evidence write");
});

test("the trial event of an item is decided by its own fields, and a registry number by the form its registry writes it in", () => {
  assert.equal(trialEventOf({ registryIds: ["NCT1"], flags: ["registry-unpublished"] }), "registration");
  assert.equal(trialEventOf({ registryIds: ["NCT1"], evidenceType: "rct", flags: [] }), "results");
  assert.equal(trialEventOf({ registryIds: ["NCT1"], evidenceType: "other", flags: ["data-updated"] }), "results");
  assert.equal(trialEventOf({ lane: "regulatory", evidenceType: "regulatory-decision", registryIds: [] }), "label_change");
  assert.equal(trialEventOf({ registryIds: [], evidenceType: "rct", flags: [] }), null, "a trial report that names no registry number is not a trial event of the registry");
  assert.equal(trialEventOf({ registryIds: ["NCT1"], evidenceType: "review-opinion", flags: [] }), null);
  assert.deepEqual(registryOfId("nct05550001"), { registry: "clinicaltrials.gov", registryId: "NCT05550001" });
  assert.deepEqual(registryOfId("ChiCTR2400081234"), { registry: "chictr", registryId: "ChiCTR2400081234" });
  assert.deepEqual(registryOfId("2024-513060-26-00"), { registry: "ctis", registryId: "2024-513060-26-00" });
  assert.equal(registryOfId("ISRCTN12345678"), null);
});

test("a tick looks at a bounded number of studies, the one looked at longest ago first; off, the module composes no consumer", skipWithoutDatabase, async () => {
  const { vcr, database } = fixture;
  const one = createVcrFrontierEvents({ store: vcr.store, entityVocabulary: createEntityVocabulary({ database, enabled: true }), sourceChanges, levers: { studiesPerTick: 1, windowDays: 30 }, now });
  await vcr.store.query("DELETE FROM evimed_vcr.frontier_scans");
  const scans = async () => Number((await vcr.store.one("SELECT count(*)::int AS n FROM evimed_vcr.frontier_scans")).n);
  const total = Number((await vcr.store.one("SELECT count(*)::int AS n FROM evimed_vcr.studies WHERE deleted_at IS NULL AND status = 'active'")).n);
  assert.ok(total >= 3);
  assert.equal((await one.tick()).studies, 1);
  assert.equal(await scans(), 1);
  assert.equal((await one.tick()).studies, 1);
  assert.equal(await scans(), 2, "the second tick takes a study the first did not");

  const off = composeVcr({ config: { vcrEnabled: true, vcrAudience: "all", vcrFrontierEventsEnabled: false, vcrDataPlaneDir: "", vcrEngineUrl: "" }, productDatabase: database });
  assert.equal(off.frontierEvents, null);
  const on = composeVcr({ config: { vcrEnabled: true, vcrAudience: "all", vcrFrontierEventsEnabled: true, vcrDataPlaneDir: "", vcrEngineUrl: "" }, productDatabase: database });
  assert.equal(typeof on.frontierEvents.tick, "function");
});
