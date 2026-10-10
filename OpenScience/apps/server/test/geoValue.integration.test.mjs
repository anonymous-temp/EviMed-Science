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
