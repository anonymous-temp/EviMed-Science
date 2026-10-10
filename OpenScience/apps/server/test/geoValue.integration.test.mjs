import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { GeoOrchestrator } from "../src/geoOrchestrator.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
import { geoValueSourceReplaced } from "../src/geoValueStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
let isolated, database, store;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "value");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  store = new GeoStore({ database });
  await store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); });
const fresh = () => store.createProject({ userId: "alice", projectId: randomUUID(), engines: ["deepseek"], coverageDays: 90 });
const write = (project, what, data) => geoRuntimeWrite({ store, project, what, body: { data } });

test("semantic observations respect real profile, group, audience and engine boundaries", options, async () => {
  const project = await fresh();
  await store.writeValue("alice", project.id, { findings: [{ id: "f1", statement: "Conditions matter" }] });
  await store.writeValue("alice", project.id, { findings: [{ id: "f1", limitations: "New applicability condition" }] });
  const groups = await write(project, "questions", { groups: [
    { name: "Caregiver", pool: "P3", audience: "caregiver", questions: [{ text: "How much burden?", kind: "typical" }] },
    { name: "Pharmacist", pool: "P2", audience: "pharmacist", questions: [{ text: "Which monitoring?", kind: "typical" }] },
  ] });
  const round = `gr_${randomUUID()}`;
  await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status) VALUES($1,'alice',$2,'baseline','done')", [round, project.id]);
  for (const [index, engine, question, version] of [[0, "deepseek", groups.questionIds[0][0], 2], [1, "kimi", groups.questionIds[0][0], 2],
    [2, "deepseek", groups.questionIds[1][0], 2], [3, "deepseek", groups.questionIds[0][0], 1]]) {
    const snapshot = `gs_${randomUUID()}`;
    await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,engine,question_id,asked_at) VALUES($1,'alice',$2,$3,$4,$5,now())",
      [snapshot, project.id, round, engine, question]);
    await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,judge_extract) VALUES($1,'alice',$2,now(),$3::jsonb)",
      [snapshot, project.id, JSON.stringify({ valueBasisVersion: version, valueCoverage: [{ findingId: "f1", status: index === 0 ? "represented" : "contradicted" }] })]);
  }
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const current = await service.valueOf(project, { groupId: groups.ids[0], audience: "caregiver", engine: "deepseek" });
  assert.equal(current.coverage.assessed, 1);
  assert.equal(current.coverage.value, 100);
  assert.equal(current.observations[0].basisVersion, 2);
  const historical = await service.valueOf(project, { version: 1, groupId: groups.ids[0], audience: "caregiver", engine: "deepseek" });
  assert.equal(historical.coverage.assessed, 1);
  assert.equal(historical.coverage.value, 0);
  assert.equal(historical.observations[0].basisVersion, 1);
});

test("a finding written with a key alone is stored under it as its id, and an amendment with an empty list changes nothing (D-09, D-10)", options, async () => {
  const project = await fresh();
  const first = await store.writeValue("alice", project.id, { findings: [{ key: "eff-adults", statement: "keyed only", groupIds: ["g1"] }] });
  assert.equal(first.changed, true);
  assert.deepEqual((await store.latestValue(project.id)).data.findings.map((/** @type {any} */ finding) => [finding.id, finding.key, finding.groupIds]), [["eff-adults", "eff-adults", ["g1"]]]);
  // The judge is shown it, and a round's frozen basis carries it.
  const context = await new GeoMeasureStore(database).projectContext(project.id);
  assert.deepEqual(context?.value?.data?.findings?.map((/** @type {any} */ finding) => finding.id), ["eff-adults"]);
  // An amendment by key with an empty list keeps the links, adds no version, and one with a list replaces them.
  const kept = await store.writeValue("alice", project.id, { findings: [{ key: "eff-adults", groupIds: [] }] });
  assert.equal(kept.changed, false, "no change, no new version");
  assert.equal(kept.version, first.version);
  const runtime = await write(project, "value", { findings: [{ id: "eff-adults", groupIds: [], limitations: "adults only" }] });
  assert.equal(runtime.ok, true);
  const amended = (await store.latestValue(project.id)).data.findings;
  assert.deepEqual(amended.map((/** @type {any} */ finding) => [finding.id, finding.groupIds, finding.limitations]), [["eff-adults", ["g1"], "adults only"]]);
  await store.writeValue("alice", project.id, { findings: [{ id: "eff-adults", groupIds: ["g2"] }] });
  assert.deepEqual((await store.latestValue(project.id)).data.findings[0].groupIds, ["g2"]);
});

test("a round of eight thousand observations comes back as exact counts and twenty observations, the ones that say something first (D-08)", options, async () => {
  // 400 judged answers with 20 findings each were 2.87 MB of observations in every reply, and the runtime's client refuses past 4.
  const project = await fresh();
  await store.writeValue("alice", project.id, { findings: Array.from({ length: 20 }, (_, index) => ({ id: `f${index}`, statement: `Finding ${index}` })) });
  const round = `gr_${randomUUID()}`;
  await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status) VALUES($1,'alice',$2,'baseline','done')", [round, project.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,engine,asked_at)
    SELECT 'gs_' || $4 || g, 'alice', $1, $2, CASE WHEN g % 2 = 0 THEN 'deepseek' ELSE 'kimi' END, now() - make_interval(secs => g) FROM generate_series(1, $3::integer) g`,
  [project.id, round, 400, round]);
  // Even-numbered findings do not apply to the question; the odd ones are judged partly represented, and the first fifth of the answers were judged
  // against an older profile (basis 1) than the rest (basis 2).
  await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,judge_extract)
    SELECT 'gs_' || $3 || g, 'alice', $1, now(), jsonb_build_object('valueBasisVersion', CASE WHEN g <= 80 THEN 1 ELSE 2 END, 'rubricVersion', 'rubric-7', 'valueCoverage',
      (SELECT jsonb_agg(jsonb_build_object('findingId', 'f' || f, 'status', CASE WHEN f % 2 = 0 THEN 'not_applicable' ELSE 'partial' END, 'quote', 'q', 'reason', 'r') ORDER BY f)
        FROM generate_series(0, 19) f))
    FROM generate_series(1, $2::integer) g`, [project.id, 400, round]);
  await store.writeValue("alice", project.id, { findings: [{ id: "f0", limitations: "newer" }] });
  await store.writeValue("alice", project.id, { findings: [{ id: "f0", limitations: "newer still" }] });
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const value = await service.valueOf(project);
  assert.equal(value.version, 3);
  assert.equal(value.coverage.basisVersion, 2, "the newest basis the round used, never two mixed");
  assert.equal(value.observationsTotal, 320 * 20, "320 answers on basis 2, twenty observations each");
  assert.deepEqual([value.coverage.assessed, value.coverage.partial, value.coverage.notApplicable, value.coverage.represented], [3200, 3200, 3200, 0], "exact counts over every observation");
  assert.equal(value.observations.length, 20);
  assert.ok(value.observations.every((observation) => observation.status === "partial" && observation.basisVersion === 2 && observation.rubricVersion === "rubric-7"),
    "the observations that say something first; the ones that do not apply only when there are no others");
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 30_000, "the reply no longer grows with the round");
  const newest = value.observations.map((observation) => Date.parse(observation.askedAt));
  assert.deepEqual([...newest].sort((a, b) => b - a), newest, "the most recent answers first");
  // A version asked for is read only against itself, and so is its sample.
  const older = await service.valueOf(project, { version: 1 });
  assert.equal(older.coverage.basisVersion, 1);
  assert.equal(older.observationsTotal, 80 * 20);
  assert.ok(older.observations.length === 20 && older.observations.every((observation) => observation.basisVersion === 1));
  // The scope filters count what they scope.
  const kimi = await service.valueOf(project, { engine: "kimi" });
  assert.equal(kimi.observationsTotal, 160 * 20);
  assert.ok(kimi.observations.every((observation) => observation.engine === "kimi"));
  // A round whose observations all do not apply: they are the sample, there being no others, and the rate is unknown, never zero.
  const quiet = await fresh();
  await store.writeValue("alice", quiet.id, { findings: [{ id: "f1", statement: "Unrelated to these questions" }] });
  const quietRound = `gr_${randomUUID()}`;
  await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status) VALUES($1,'alice',$2,'weekly','done')", [quietRound, quiet.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,engine,asked_at) VALUES ($1,'alice',$2,$3,'kimi',now())`, [`gs_${quietRound}`, quiet.id, quietRound]);
  await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,judge_extract) VALUES ($1,'alice',$2,now(),$3::jsonb)`,
    [`gs_${quietRound}`, quiet.id, JSON.stringify({ valueBasisVersion: 1, valueCoverage: Array.from({ length: 30 }, () => ({ findingId: "f1", status: "not_applicable" })) })]);
  const none = await service.valueOf(quiet);
  assert.deepEqual([none.observationsTotal, none.observations.length, none.coverage.assessed, none.coverage.value], [30, 20, 0, null]);
});

test("backend owns versions, merges concurrent partial work, and isolates readers", options, async () => {
  const project = await fresh();
  await Promise.all([write(project, "value", { findings: [{ id: "f1", statement: "Conflicting effectiveness evidence" }] }),
    write(project, "value", { scope: { audience: "caregiver" }, findings: [{ id: "f2", statement: "Affordability unknown" }] })]);
  const profile = await store.latestValue(project.id);
  assert.equal(profile.version, 2);
  assert.equal(profile.data.findings.length, 2);
  assert.equal((await store.writeValue("alice", project.id, {})).changed, false);
  assert.equal((await store.latestValue(project.id, 1)).data.findings.length, 1);
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  assert.equal((await service.value({ id: "alice" }, project.id)).coverage.value, null);
  await assert.rejects(service.value({ id: "bob" }, project.id), { code: "geo_project_not_found" });
});

test("small incomplete question sets and rich audience/decision context remain usable", options, async () => {
  const project = await fresh();
  const result = await write(project, "questions", { groups: [{ name: "Administration burden", pool: "P3", audience: "caregiver",
    valueContext: { findingIds: ["f1"], decision: "continue treatment", evidenceOrigin: "inferred" },
    questions: [{ text: "Can a caregiver administer this?", kind: "typical", isMeasured: true }] }] });
  assert.equal(result.ok, true);
  assert.equal((await store.questionMap(project.id, result.version))[0].valueContext.decision, "continue treatment");
  const locked = await write(project, "lock_questions", {});
  assert.equal(locked.ok, true);
  assert.equal(locked.measuredCount, 1);
  assert.ok(locked.issues.every(issue => issue.code === "notice"));
  const journey = await write(project, "journey", { decisions: [{ question: "Switch after intolerance?", alternatives: ["adjust", "switch"], basis: "hypothesis" }] });
  assert.equal(journey.ok, true);
  assert.equal((await store.latestJourney(project.id)).data.decisions.length, 1);
});

test("research uses existing dispatch, deduplicates, preserves a failed result and explicitly retries with a new dispatch id", options, async () => {
  const project = await fresh();
  const request = { capabilityId: "adr-analysis", question: "Does the reported signal establish incidence?" };
  const one = await store.requestResearch("alice", project.id, request);
  const two = await store.requestResearch("alice", project.id, request);
  assert.equal(one.request.id, two.request.id);
  const dispatched = [];
  const orchestrator = new GeoOrchestrator({ store, config: {}, dispatchRun: async input => {
    dispatched.push(input); return { runId: `r${dispatched.length}`, sessionId: `s${dispatched.length}`, status: "running" };
  } });
  await orchestrator.advance(project.id);
  assert.equal(dispatched[0].capabilityId, "adr-analysis");
  await orchestrator.advance(project.id);
  assert.equal(dispatched.length, 1);
  await store.writeValue("alice", project.id, { findings: [{ statement: "Signal observed; incidence unknown", dimension: "safety" }] });
  await orchestrator.onRunFinished({ userId: "alice", id: project.projectId }, { id: "r1", dispatchId: dispatched[0].dispatchId, status: "failed" });
  assert.equal((await store.researchRequests(project.id))[0].status, "failed");
  assert.equal((await store.latestValue(project.id)).data.findings.length, 1);
  await store.requestResearch("alice", project.id, { ...request, retry: true });
  await orchestrator.advance(project.id);
  assert.equal(dispatched.length, 2);
  assert.notEqual(dispatched[0].dispatchId, dispatched[1].dispatchId);
});

test("a project holds a limited number of research tasks open; a task already open is never refused and a finished one frees its place (D-06)", options, async () => {
  // Forty distinct requests were all accepted, each a billed specialist run.
  const project = await fresh();
  const ask = (index, extra = {}) => store.requestResearch("alice", project.id, { capabilityId: "adr-analysis", question: `Question ${index}`, ...extra });
  const accepted = [];
  for (let index = 0; index < 5; index += 1) accepted.push(await ask(index));
  assert.ok(accepted.every((entry) => entry.request && entry.notice === null && !entry.capped), "five places by default");
  const sixth = await ask(5);
  assert.deepEqual([sixth.request, sixth.capped], [null, true]);
  assert.match(sixth.notice ?? "", /already has 5 research tasks queued or running \(the limit is 5\)/);
  assert.equal((await store.researchRequests(project.id)).length, 5, "nothing was queued");
  // The same task asked again is the same task, at the limit as well.
  const again = await ask(2);
  assert.equal(again.request?.id, accepted[2].request.id);
  assert.equal(again.capped, undefined);
  // A running task still holds its place; a finished one frees it.
  await store.query(`UPDATE evimed_geo.schedule_marks SET state = 'running' WHERE geo_project_id = $1 AND key = $2`, [project.id, accepted[0].request.id]);
  assert.equal((await ask(6)).capped, true);
  await store.query(`UPDATE evimed_geo.schedule_marks SET state = 'done' WHERE geo_project_id = $1 AND key = $2`, [project.id, accepted[0].request.id]);
  assert.ok((await ask(6)).request, "a place is free");
  // Asking again for a finished task is a new open one: refused while the limit is held, accepted once there is room.
  assert.equal((await ask(0, { retry: true })).capped, true);
  await store.query(`UPDATE evimed_geo.schedule_marks SET state = 'failed' WHERE geo_project_id = $1 AND key = $2`, [project.id, accepted[1].request.id]);
  const retried = await ask(0, { retry: true });
  assert.equal(retried.request?.status, "pending", "room for the retry of the finished one");
  // The limit is a deployment's: a smaller one, and none at all.
  const small = await fresh();
  const askSmall = (index) => geoRuntimeWrite({ store, project: small, what: "research", researchMaxOpen: 2,
    body: { data: { capabilityId: "adr-analysis", question: `Small ${index}` } } });
  assert.deepEqual([(await askSmall(0)).ok, (await askSmall(1)).ok], [true, true]);
  const refused = await askSmall(2);
  assert.deepEqual([refused.ok, refused.capped, refused.research], [false, true, null]);
  assert.deepEqual(refused.issues.map((issue) => issue.code), ["notice"]);
  const none = await fresh();
  const closed = await geoRuntimeWrite({ store, project: none, what: "research", researchMaxOpen: 0, body: { data: { capabilityId: "adr-analysis", question: "Any" } } });
  assert.deepEqual([closed.ok, closed.capped], [false, true]);
  assert.match(closed.issues[0].message, /queues no research/);
  // Two requests made together cannot both take the last place.
  const race = await fresh();
  const results = await Promise.all(Array.from({ length: 8 }, (_unused, index) =>
    store.requestResearch("alice", race.id, { capabilityId: "adr-analysis", question: `Race ${index}` }, { maxOpen: 3 })));
  assert.equal(results.filter((entry) => entry.request).length, 3);
  assert.equal(results.filter((entry) => entry.capped).length, 5);
});

test("a research task the allowance refuses does not hold the programme's own steps back (D-07)", options, async () => {
  // A mark refused for a reason of its own (a balance under that specialist's estimate) was tried first on every tick, and the tick
  // ended with it: three ticks attempted only meta-analysis and never geo-insight, although the evidence step was requested.
  const project = await fresh();
  await store.setStep(project.id, "evidence", { requested: true, status: "queued" });
  await store.requestResearch("alice", project.id, { capabilityId: "meta-analysis", question: "Pooled effect in adults" });
  const calls = [];
  const orchestrator = new GeoOrchestrator({ store, config: {}, dispatchRun: async (input) => {
    calls.push(input.capabilityId);
    if (input.capabilityId === "meta-analysis") throw Object.assign(new Error("balance"), { code: "credits_insufficient_for_capability" });
    return { runId: `r${calls.length}`, sessionId: "s", status: "running" };
  } });
  const first = await orchestrator.advance(project.id);
  assert.deepEqual(calls, ["meta-analysis", "geo-insight"], "research keeps its place in the order; the programme is tried in the same tick");
  assert.equal(first.dispatched?.runId, "r2");
  assert.equal(first.deferred, "credits_insufficient_for_capability", "and the refusal is still reported");
  assert.equal((await store.researchRequests(project.id))[0].status, "pending", "the task waits for its balance, not for a person");
  // The programme's run holds the one slot, so the refused task is not tried again until it ends.
  await orchestrator.advance(project.id);
  assert.deepEqual(calls, ["meta-analysis", "geo-insight"]);
  // A refusal of the programme's own step still ends the tick: the steps after it depend on it.
  const waiting = await fresh();
  await store.setStep(waiting.id, "evidence", { requested: true, status: "queued" });
  await store.setStep(waiting.id, "journey", { requested: true, status: "queued" });
  const refused = [];
  const refusing = new GeoOrchestrator({ store, config: {}, dispatchRun: async (input) => {
    refused.push(input.capabilityId);
    throw Object.assign(new Error("balance"), { code: "credits_insufficient_for_capability" });
  } });
  const outcome = await refusing.advance(waiting.id);
  assert.equal(refused.length, 1, "one programme attempt a tick");
  assert.equal(outcome.deferred, "credits_insufficient_for_capability");
});

test("population change versions a claim; retraction never resurrects an older active claim; frozen rounds keep their basis", options, async () => {
  const project = await fresh();
  const claim = { claimKey: "benefit", statement: "Effect in the studied population", quote: "Adults were enrolled", sourceRef: "trial", population: "Adults" };
  const first = await store.upsertClaims("alice", project.id, [claim]);
  const second = await store.upsertClaims("alice", project.id, [{ ...claim, population: "Adults with prior therapy" }]);
  assert.equal(first[0].version, 1);
  assert.equal(second[0].version, 2);
  const measure = new GeoMeasureStore(database);
  const context = await measure.projectContext(project.id);
  assert.equal(context.claims[0].population, "Adults with prior therapy");
  const roundId = `gr_${randomUUID()}`;
  await database.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,ref) VALUES ($1,'alice',$2,'baseline',$3::jsonb)`,
    [roundId, project.id, JSON.stringify({ evaluationBasis: { claims: context.claims, value: context.value, careFlags: context.careFlags } })]);
  await store.upsertClaims("alice", project.id, [{ ...claim, status: "retired" }]);
  assert.equal((await measure.projectContext(project.id)).claims.length, 0);
  assert.equal((await measure.projectContext(project.id, roundId)).claims[0].version, 2);
});

test("a round freezes the scope, the summary and the findings of the profile, not its research reports (D-02)", options, async () => {
  const project = await fresh();
  const excerpt = "EXCERPT-OF-A-LONG-REPORT ".repeat(240);
  await store.writeValue("alice", project.id, { scope: { population: "adults" }, summary: "Benefit uncertain", findings: [{ id: "f1", statement: "Benefit uncertain" }],
    landscape: [{ id: "l1", statement: "Three alternatives" }], lessons: [{ id: "n1", text: "A lesson" }],
    researchResults: [1, 2, 3, 4].map((index) => ({ id: `run:${index}:pack`, capabilityId: "comprehensive-drug-evaluation", materials: [{ path: `pack/${index}.md`, excerpt }] })) });
  const measure = new GeoMeasureStore(database);
  const context = await measure.projectContext(project.id);
  assert.equal(context.value.version, 1);
  assert.deepEqual(Object.keys(context.value.data), ["scope", "summary", "findings"]);
  assert.deepEqual(context.value.data.findings, [{ id: "f1", statement: "Benefit uncertain" }]);
  assert.ok(JSON.stringify(context.value).length < 500, "the basis a round freezes does not grow with the reports");
  // A round frozen before this change keeps what it froze, whatever it holds.
  const roundId = `gr_${randomUUID()}`;
  const old = { version: 1, data: { findings: [{ id: "f1", statement: "Frozen" }], researchResults: [{ id: "old", materials: [{ excerpt }] }] } };
  await database.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,ref) VALUES ($1,'alice',$2,'baseline',$3::jsonb)`,
    [roundId, project.id, JSON.stringify({ evaluationBasis: { claims: [], value: old, careFlags: [] } })]);
  assert.deepEqual((await measure.projectContext(project.id, roundId)).value, old);
});

test("source replacement marks only linked work and keeps earlier conclusions readable", options, async () => {
  const project = await fresh();
  await store.writeValue("alice", project.id, { findings: [{ id: "f1", statement: "Old source conclusion", sources: [{ sourceId: "src-old" }] },
    { id: "f2", statement: "Unrelated finding", sourceRefs: ["src-other"] }] });
  const event = { userId: "alice", projectId: project.projectId, replaced: { sourceId: "src-old", sha256: "a".repeat(64) },
    by: { sourceId: "src-new", at: "2026-10-09T10:00:00Z" } };
  await geoValueSourceReplaced(store, event);
  await geoValueSourceReplaced(store, event);
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const value = await service.value({ id: "alice" }, project.id);
  assert.equal(value.version, 2);
  assert.deepEqual(value.impacts[0].findingIds, ["f1"]);
  assert.equal(value.data.findings.length, 2);
});

test("the changed sources the page counts are those that reach a finding that stands; the total is kept beside them (D-19)", options, async () => {
  // Every standing change was counted, linked or not: a change that names no finding of the profile, or whose only finding was retired
  // since, stayed in "N sources changed" for good, and nothing resolved it.
  const project = await fresh();
  await store.writeValue("alice", project.id, {
    findings: [{ id: "f1", statement: "Linked", sources: [{ sourceId: "src-a" }] }, { id: "f2", statement: "Retired later", sources: [{ sourceId: "src-b" }] }],
    sourceChanges: [
      { id: "c1", sourceId: "src-a", status: "needs_review" },
      { id: "c2", sourceId: "src-unknown", status: "needs_review" },
      { id: "c3", sourceId: "src-b", status: "needs_review" },
      { id: "c4", sourceId: "src-a", status: "retired" },
    ] });
  await store.writeValue("alice", project.id, { findings: [{ id: "f2", status: "retired" }] });
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const value = await service.value({ id: "alice" }, project.id);
  assert.deepEqual(value.impacts.map((impact) => [impact.change.id, impact.findingIds]), [["c1", ["f1"]]], "only a change that reaches a finding that stands");
  assert.equal(value.impactsTotal, 3, "the standing changes, linked or not, are still counted beside it");
  assert.equal(value.data.sourceChanges.length, 4, "and every change stays in the profile as written");
});

test("article, source and question context round-trips through the views read by later GEO runs", options, async () => {
  const project = await fresh();
  await write(project, "value", { findings: [{ id: "f1", statement: "No comparative safety estimate" }] });
  const groups = await write(project, "questions", { groups: [{ name: "Treatment burden", pool: "P3", valueContext: { findingIds: ["f1"] },
    questions: [{ text: "What monitoring is needed?", kind: "typical" }] }] });
  await store.upsertSources("alice", project.id, [{ domain: "example.org", valueContext: { clinicalBasis: "original trial", retrievalBasis: "not yet observed", sourceFamily: "trial-1" } }]);
  await store.registerArticles("alice", project.id, [{ path: "deliverables/safety/articles/a.md", layer: "popular", groupId: groups.ids[0],
    claimIds: [], gate: "unverified", safety: "clear", valueContext: { findingIds: ["f1"], audience: "caregiver" } }]);
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const articles = await service.articles({ id: "alice" }, project.id);
  assert.equal(articles.articles[0].valueContext.basisVersion, 1);
  assert.deepEqual(articles.articles[0].valueContext.findingIds, ["f1"]);
  assert.equal((await service.sources({ id: "alice" }, project.id)).sources[0].valueContext.retrievalBasis, "not yet observed");
  assert.deepEqual((await service.questions({ id: "alice" }, project.id)).groups[0].valueContext.findingIds, ["f1"]);
  await write(project, "value", { findings: [{ id: "f1", limitations: "A newer source needs review" }] });
  await store.registerArticles("alice", project.id, [{ path: "deliverables/safety/articles/frozen.md", layer: "popular", groupId: groups.ids[0],
    claimIds: [], gate: "unverified", safety: "clear", valueContext: { findingIds: ["f1"], basisVersion: 1 } }]);
  assert.equal((await store.listArticles(project.id)).find(article => article.path.endsWith("frozen.md")).valueContext.basisVersion, 1,
    "publishing an article written against an earlier profile must preserve the declared basis");
});

test("research deduplication respects supplied clinical context; an unavailable method leaves the project usable", options, async () => {
  const project = await fresh();
  const request = { capabilityId: "comprehensive-drug-evaluation", question: "Compare treatment options" };
  const a = await store.requestResearch("alice", project.id, { ...request, context: { population: "adults" } });
  const b = await store.requestResearch("alice", project.id, { ...request, context: { population: "children" } });
  assert.notEqual(a.request.id, b.request.id);
  assert.equal((await store.requestResearch("alice", project.id, { capabilityId: "unavailable", question: "Useful question" })).request, null);
  assert.equal((await write(project, "value", { findings: ["The pediatric question remains unresolved"] })).ok, true);
});

test("a useful strategy without numeric forecasts remains available after a partial run", options, async () => {
  const project = await fresh();
  await store.writeStrategy("alice", project.id, { summary: "Answer the caregiver's monitoring question first. Forecast is unknown." });
  await store.query(`INSERT INTO evimed_geo.schedule_marks (geo_project_id,key,user_id,kind,state,dispatch_id,run_id,detail)
    VALUES ($1,'run:strategy','alice','run','running','geo-partial-strategy','partial-run','{"purpose":"strategy"}'::jsonb)`, [project.id]);
  const orchestrator = new GeoOrchestrator({ store, config: {} });
  await orchestrator.onRunFinished({ userId: "alice", id: project.projectId }, { id: "partial-run", dispatchId: "geo-partial-strategy", status: "failed" });
  assert.equal((await store.getProject("alice", project.id)).steps.sources.status, "minimal");
  assert.match((await store.latestStrategy(project.id)).summary, /Forecast is unknown/);
  assert.equal(await store.latestTargets(project.id), null);
});

test("partial value analysis advances the evidence step without requiring quoteable claims", options, async () => {
  const project = await fresh();
  await store.setStep(project.id, "evidence", { requested: true, status: "running" });
  await store.writeValue("alice", project.id, { findings: ["Caregiver burden is a useful question; comparative evidence is unavailable."] });
  await store.query(`INSERT INTO evimed_geo.schedule_marks (geo_project_id,key,user_id,kind,state,dispatch_id,run_id,detail)
    VALUES ($1,'run:insight','alice','run','running','geo-partial-insight','partial-insight',
    '{"purpose":"insight","scope":[{"step":"evidence","fidelity":"full"}]}'::jsonb)`, [project.id]);
  let dispatched = 0;
  const orchestrator = new GeoOrchestrator({ store, config: {}, dispatchRun: async () => {
    dispatched += 1; return { runId: "explicit-retry", sessionId: "retry-session", status: "running" };
  } });
  await orchestrator.onRunFinished({ userId: "alice", id: project.projectId }, { id: "partial-insight", dispatchId: "geo-partial-insight", status: "failed" });
  assert.equal((await store.getProject("alice", project.id)).steps.evidence.status, "minimal");
  assert.equal((await store.latestValue(project.id)).data.findings.length, 1);
  assert.equal(Number((await store.query("SELECT count(*) AS n FROM evimed_geo.claims WHERE geo_project_id = $1", [project.id])).rows[0].n), 0);
  await orchestrator.advance(project.id);
  assert.equal(dispatched, 0, "a missing claim list alone must not trigger another full analysis");
  await orchestrator.runStep({ id: "alice" }, project, "evidence");
  assert.equal(dispatched, 1, "the researcher can explicitly ask to extend partial work");
});
