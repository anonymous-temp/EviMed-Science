import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { measureRound } from "../src/geoMetricsJob.mjs";
import { readGeoSelection, readGeoSelectionErrors } from "../src/geoReadScope.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
let database, store, measure, isolated, project, service;
const user = { id: "scope-owner" };

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geoscopes");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database }); measure = new GeoMeasureStore(database);
  await measure.ready(); await store.ready();
  project = await store.createProject({ userId: user.id, projectId: "scope-project", engines: ["deepseek", "kimi", "doubao"], coverageDays: 90, product: { brandName: "Ours" } });
  service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  await store.query(`INSERT INTO evimed_geo.question_groups (id,user_id,geo_project_id,set_version,pool,name) VALUES ('g1',$1,$2,1,'P2','Group one'),('g2',$1,$2,1,'P3','Group two')`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.questions (id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured)
    VALUES ('q1',$1,$2,'g1',1,'P2','Which brand?',true),('q2',$1,$2,'g2',1,'P3','What works?',true)`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.sources (id,user_id,geo_project_id,domain,name,kind,layer) VALUES ('source1',$1,$2,'example.com','Example','medical','owned')`, [user.id, project.id]);
  for (const [round, date] of [["r1", "2026-10-01"], ["r2", "2026-10-02"]]) {
    await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at,created_at,surface)
      VALUES ($1,$2,$3,'baseline','done',1,'{deepseek,kimi,doubao}',$4::date,$4::date + interval '3 hours',$4::date,'{"mode":"web"}')`, [round,user.id,project.id,date]);
    for (const [question, engine] of [["q1","deepseek"],["q1","kimi"],["q2","deepseek"],["q2","kimi"],["q1","doubao"]]) {
      const id = `${round}-${question}-${engine}`;
      const mentioned = round === "r2" || engine === "deepseek";
      await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations)
        VALUES ($1,$2,$3,$4,$5,$6,$7::date,'valid','Original answer','{"mode":"web"}','[{"url":"https://example.com/a","domain":"example.com","inBody":true}]')`, [id,user.id,project.id,round,question,engine,date]);
      await store.query(`INSERT INTO evimed_geo.facts (snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,statements,checks,retrieval_triggered)
        VALUES ($1,$2,$3,$4::date,$5::jsonb,$6,'[{"text":"Known","verdict":"correct"}]','{"judgementCoverage":{"status":"complete"}}',true)`,
      [id,user.id,project.id,date,JSON.stringify(mentioned ? [{name:"Ours",ours:true,count:1}] : []),mentioned]);
    }
    await store.query(`INSERT INTO evimed_geo.probe_jobs (id,user_id,geo_project_id,round_id,question_id,engine,status,error_code)
      VALUES ($1,$2,$3,$4,'q1','doubao','skipped','engine_paused')`, [`job-${round}`,user.id,project.id,round]);
    await measureRound({ store: measure, now: () => new Date(`${date}T04:00:00Z`) }, round);
  }
  for (const [id, snapshot, type, severity, statement] of [["e1","r1-q1-deepseek","number","S3","Earlier mistake"],
    ["e2","r2-q1-deepseek","number","S3","Dose mistake"],["e3","r2-q2-kimi","number","S1","Other mistake"]]) {
    await store.query(`INSERT INTO evimed_geo.errors (id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,error_type,severity,statement)
      VALUES ($1,$2,$3,$1,$4,$5,$6,$6,$7,$8,$9)`, [id,user.id,project.id,snapshot.endsWith("kimi")?"kimi":"deepseek",snapshot.includes("q1")?"q1":"q2",snapshot,type,severity,statement]);
  }
});
after(async () => { await database?.close(); await isolated?.drop(); });

test("old-round recount never replaces the latest headline and histories stay in observation order", options, async () => {
  await measureRound({ store: measure, now: () => new Date("2026-10-23T00:00:00Z") }, "r1");
  const view = await service.projectView(user, project.id);
  assert.equal(view.overview.metrics.find((entry) => entry.key === "mention").cell.value, 100);
  assert.deepEqual(view.overview.metrics.find((entry) => entry.key === "mention").trend.map((point) => point.date), ["2026-10-01","2026-10-02"]);
});

test("inclusive scoped reads preserve repeated observations and exclude paused engines", options, async () => {
  const selected = await readGeoSelection(store, project, { from: "2026-10-01", to: "2026-10-02", pools: ["P2"] });
  const cell = selected.computed.cells.find((entry) => entry.scope === "project" && entry.metricId === "M-01S" && entry.variant === null);
  assert.equal(cell.denominator, 4);
  assert.equal(cell.value, 75);
  assert.equal(selected.selection.counts.questions, 1);
  assert.equal(selected.selection.counts.observations, 2);
  assert.equal(selected.selection.counts.skippedEngineAnswers, 2);
  assert.equal(cell.snapshotIds.length, 4);
  const restored = await readGeoSelection(store, project, { selectionRef: selected.selection.reference });
  assert.equal(restored.selection.dataRevision, selected.selection.dataRevision);
  await assert.rejects(readGeoSelection(store, { ...project, userId: "other" }, { selectionRef: selected.selection.reference }), (error) => error.status === 404);
  assert.equal((await readGeoSelection(store, project, { clientTags: ["not-invented"] })).rows.length, 0);
});

test("typed error summaries precede pagination and native reads share the selection", options, async () => {
  const selected = await readGeoSelection(store, project, { round: "r2" });
  const errors = await readGeoSelectionErrors(store, project, selected, { errorLimit: 1 });
  assert.equal(errors.page.total, 2);
  assert.equal(errors.rows.length, 1);
  assert.equal(errors.summary.byType.number, 2);
  const matching = await readGeoSelectionErrors(store, project, selected, { errorSearch: "Dose", errorSeverities: ["S3"] });
  assert.equal(matching.page.total, 1);
  assert.equal(matching.rows[0].id, "e2");
  const view = await service.diagnosis(user, project.id, { round: "r2", pools: ["P2"], errorLimit: 1 });
  assert.equal(view.errorPage.total, 1);
  const native = await service.runtimeRead(project, "diagnosis", { selectionRef: view.selection.reference });
  assert.equal(native.selection.dataRevision, view.selection.dataRevision);
  assert.deepEqual(native.byEngine, view.byEngine);
});

test("source list and detail use the same selection and all engine metrics have histories", options, async () => {
  const scope = { from: "2026-10-01", to: "2026-10-02", engines: ["deepseek"], pools: ["P2"] };
  const view = await service.sources(user, project.id, scope);
  const detail = await service.source(user, project.id, "source1", scope);
  assert.equal(view.sources[0].cited.deepseek, 2);
  assert.equal(detail.counts.cited, 2);
  assert.equal(view.selection.dataRevision, detail.selection.dataRevision);
  const monitoring = await service.monitoring(user, project.id, scope);
  assert.ok(monitoring.byEngine[0].metrics.some((entry) => entry.metricId === "M-06" && entry.points.length === 2));
  await assert.rejects(service.projectView({ id: "other" }, project.id, scope), (error) => error.status === 404);
});

test("comparisons use common immutable questions and remain observational with unknown consumer versions", options, async () => {
  const selected = await readGeoSelection(store, project, { from: "2026-10-02", to: "2026-10-02", compareFrom: "2026-10-01", compareTo: "2026-10-01", pools: ["P2"] });
  assert.equal(selected.comparison.comparable, true);
  assert.equal(selected.comparison.causal, false);
  assert.equal(selected.comparison.consumerModelVersion, "unknown");
  const mention = selected.comparison.cells.find((entry) => entry.scope === "project" && entry.metricId === "M-01S" && !entry.variant);
  assert.deepEqual([mention.previous.denominator, mention.current.denominator], [2, 2]);
  const separate = await readGeoSelection(store, project, { from: "2026-10-02", to: "2026-10-02", compareFrom: "2026-10-01", compareTo: "2026-10-01", comparisonMode: "separate" });
  assert.equal(separate.comparison.comparable, false);
  assert.ok(separate.comparison.cells.every((entry) => entry.delta === null));
});

test("an exact member continuation reads the cell denominator and stale references cannot silently change data", options, async () => {
  const selected = await readGeoSelection(store, project, { round: "r2", pools: ["P2"] });
  const accuracy = selected.computed.cells.find((entry) => entry.scope === "project" && entry.metricId === "M-06");
  const first = await service.runtimeRead(project, "snapshots", { selectionRef: selected.selection.reference, member: accuracy.members.metric, limit: 1 });
  assert.equal(first.total, accuracy.denominator);
  assert.equal(first.items.length, 1);
  assert.equal(first.more, true);
  const next = await service.runtimeRead(project, "snapshots", { selectionRef: selected.selection.reference, member: accuracy.members.metric, offset: first.nextOffset, limit: 1 });
  assert.notEqual(first.items[0].id, next.items[0].id);
  assert.equal(next.more, false);
  await store.query(`UPDATE evimed_geo.facts SET statements = '[{"text":"Changed","verdict":"wrong"}]' WHERE snapshot_id = 'r2-q1-deepseek'`);
  await assert.rejects(readGeoSelection(store, project, { selectionRef: selected.selection.reference }), (error) => error.status === 409 && error.code === "geo_read_filter_invalid");
});

test("date-only bounds include the local final day and oversized computation asks for a smaller range", options, async () => {
  const other = await store.createProject({ userId: user.id, projectId: "bounded-project", engines: ["deepseek"], coverageDays: 90 });
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,created_at,started_at,finished_at)
    VALUES ('r-bounded',$1,$2,'baseline','done','2026-10-01T16:30:00Z','2026-10-01T16:30:00Z','2026-10-01T17:00:00Z')`, [user.id,other.id]);
  assert.equal((await readGeoSelection(store, other, { from: "2026-10-02", to: "2026-10-02" })).rounds.length, 1);
  assert.equal((await readGeoSelection(store, other, { from: "2026-10-01", to: "2026-10-01" })).rounds.length, 0);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status)
    SELECT 'bounded-' || n, $1, $2, 'r-bounded', 'deepseek', 'failed' FROM generate_series(1,20001) n`, [user.id,other.id]);
  await assert.rejects(readGeoSelection(store, other, { round: "r-bounded" }), (error) => error.status === 422 && /shorter date range/u.test(error.message));
});

test("a diagnosis keeps its error page on the selection snapshot during a concurrent correction", options, async () => {
  const original = store.query.bind(store);
  let corrected = false;
  store.query = async (sql, params) => {
    if (!corrected && sql.includes("SELECT e.status, e.severity")) {
      corrected = true;
      await database.pool.query("UPDATE evimed_geo.errors SET statement = 'Concurrent correction' WHERE id = 'e2'");
    }
    return original(sql, params);
  };
  try {
    const result = await service.diagnosis(user, project.id, { round: "r2" });
    assert.equal(corrected, true);
    assert.equal(result.errors.find((error) => error.id === "e2").statement, "Dose mistake");
    await assert.rejects(readGeoSelection(store, project, { selectionRef: result.selection.reference }), (error) => error.status === 409);
  } finally {
    store.query = original;
    await store.query("UPDATE evimed_geo.errors SET statement = 'Dose mistake' WHERE id = 'e2'");
  }
});

test("default cluster detail answers belong to the same round as its selection", options, async () => {
  await store.query(`INSERT INTO evimed_geo.question_sets (geo_project_id, user_id, version) VALUES ($1,$2,1)`, [project.id, user.id]);
  await store.query("UPDATE evimed_geo.snapshots SET asked_at = '2026-10-23T00:00:00Z' WHERE id = 'r1-q1-deepseek'");
  try {
    const result = await service.cluster(user, project.id, "g1");
    assert.deepEqual(result.selection.roundIds, ["r2"]);
    const answers = result.questions.flatMap((question) => question.answers);
    assert.ok(answers.length > 0);
    assert.ok(answers.every((answer) => answer.snapshotId.startsWith("r2-")), "a newer timestamp on an old round must not escape the selected round");
    assert.ok(answers.every((answer) => answer.engine !== "doubao"), "paused engines cannot reappear in detail");
  } finally {
    await store.query("UPDATE evimed_geo.snapshots SET asked_at = '2026-10-01T00:00:00Z' WHERE id = 'r1-q1-deepseek'");
  }
});

test("default group readings expose the same exact membership as the selected measurement", options, async () => {
  const view = await service.clusters(user, project.id);
  const group = view.groups.find((entry) => entry.id === "g1");
  assert.equal(group.mention.members.exact, true);
  assert.ok(group.mention.snapshotIds.every((id) => id.startsWith("r2-")));
});

test("source history includes every round selected by an explicit date range", options, async () => {
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at)
    SELECT 'history-' || n,$1,$2,'weekly','done',1,'{deepseek}',date '2026-10-03' + n,date '2026-10-03' + n
    FROM generate_series(0,4) n`, [user.id, project.id]);
  const result = await service.source(user, project.id, "source1", { from: "2026-10-01", to: "2026-10-07" });
  assert.equal(result.selection.roundIds.length, 7);
  assert.equal(result.history.length, 7);
});

test("comparison sides retain independently replayable exact member selections", options, async () => {
  await store.query(`INSERT INTO evimed_geo.questions (id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured)
    VALUES ('q-extra',$1,$2,'g1',1,'P2','Extra question?',true)`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
    VALUES ('r2-extra',$1,$2,'r2','q-extra','deepseek','2026-10-02','refusal','Cannot answer','{"mode":"web"}')`, [user.id, project.id]);
  for (const mode of ["common", "separate"]) {
    const view = await readGeoSelection(store, project, { from: "2026-10-02", to: "2026-10-02", compareFrom: "2026-10-01", compareTo: "2026-10-01", comparisonMode: mode });
    const entry = view.comparison.cells.find((cell) => cell.scope === "engine" && cell.engine === "deepseek" && cell.metricId === "M-20" && cell.variant === "refusal");
    for (const side of ["current", "previous"]) {
      const metric = entry[side];
      assert.ok(metric.members.selectionRef);
      assert.notEqual(metric.members.selectionRef, view.selection.reference);
      const restored = await readGeoSelection(store, project, { selectionRef: metric.members.selectionRef });
      const detail = await service.runtimeRead(project, "snapshots", { selectionRef: metric.members.selectionRef, member: metric.members.metric, limit: 50 });
      assert.equal(detail.total, metric.members.total);
      assert.deepEqual(detail.items.map((item) => item.id).sort(), metric.snapshotIds.slice().sort());
      assert.equal(restored.rows.some((row) => row.snapshotId === "r2-extra"), side === "current" && mode === "separate");
    }
  }
});

test("engine histories include refusal variants in default and filtered reads", options, async () => {
  for (const filter of [{}, { round: "r2" }]) {
    const view = await service.monitoring(user, project.id, filter);
    const refusal = view.byEngine.find((entry) => entry.engine === "deepseek").metrics.find((entry) => entry.metricId === "M-20" && entry.variant === "refusal");
    assert.ok(refusal);
    assert.ok(refusal.points.some((point) => point.value != null));
  }
});

test("source answer pages and native error filters retain complete scoped totals", options, async () => {
  const first = await service.source(user, project.id, "source1", { round: "r2", answerLimit: 1 });
  assert.equal(first.answers.length, 1);
  assert.equal(first.answerPage.total, 4);
  const second = await service.runtimeRead(project, "sources", { selectionRef: first.selection.reference, sourceId: "source1", answerLimit: 1, answerOffset: first.answerPage.nextOffset });
  assert.equal(second.answerPage.total, 4);
  assert.notEqual(first.answers[0].snapshotId, second.answers[0].snapshotId);
  const errors = await service.runtimeRead(project, "errors", { round: "r2", questionId: "q1", limit: 1 });
  assert.equal(errors.total, 1);
  assert.deepEqual(errors.items.map((error) => error.id), ["e2"]);
});

test("saved selections detect edits to raw answer and question text used by detail readers", options, async () => {
  for (const [table, id, field] of [["snapshots", "r2-q1-deepseek", "answer_text"], ["questions", "q1", "text"]]) {
    const before = (await store.query(`SELECT ${field} AS text FROM evimed_geo.${table} WHERE id = $1`, [id])).rows[0].text;
    const selected = await readGeoSelection(store, project, { round: "r2" });
    await store.query(`UPDATE evimed_geo.${table} SET ${field} = 'Changed detail text' WHERE id = $1`, [id]);
    try {
      await assert.rejects(readGeoSelection(store, project, { selectionRef: selected.selection.reference }), (error) => error.status === 409);
    } finally { await store.query(`UPDATE evimed_geo.${table} SET ${field} = $2 WHERE id = $1`, [id, before]); }
  }
});

test("common comparison does not turn a failed engine into an apparent visibility gain", options, async () => {
  await store.query("UPDATE evimed_geo.snapshots SET status = 'failed' WHERE id = 'r2-q1-kimi'");
  try {
    const view = await readGeoSelection(store, project, { from: "2026-10-02", to: "2026-10-02", compareFrom: "2026-10-01", compareTo: "2026-10-01", pools: ["P2"] });
    const mention = view.comparison.cells.find((cell) => cell.scope === "project" && cell.metricId === "M-01S" && cell.variant === null);
    assert.deepEqual([mention.current.denominator, mention.previous.denominator], [1, 1]);
    assert.equal(mention.current.value, mention.previous.value);
    assert.equal(mention.delta, null, "the tiny fixture remains insufficient for a displayed delta");
  } finally { await store.query("UPDATE evimed_geo.snapshots SET status = 'valid' WHERE id = 'r2-q1-kimi'"); }
});

test("native error question filters precede totals and pagination", options, async () => {
  const errors = await service.runtimeRead(project, "errors", { round: "r2", questionId: "q1", limit: 1 });
  assert.equal(errors.total, 1);
  assert.deepEqual(errors.items.map((error) => error.id), ["e2"]);
});

test("native project and group reads retain comparison DTOs", options, async () => {
  const scope = { from: "2026-10-02", to: "2026-10-02", compareFrom: "2026-10-01", compareTo: "2026-10-01" };
  for (const what of ["project", "clusters"]) assert.ok((await service.runtimeRead(project, what, scope)).comparison);
});

test("claim aggregates include all matching errors before the independent error page", options, async () => {
  const view = await service.diagnosis(user, project.id, { round: "r2", errorLimit: 1 });
  assert.equal(view.errors.length, 1);
  assert.equal(view.byClaim.reduce((sum, claim) => sum + claim.count, 0), 2);
});

test("raw citation coverage distinguishes question subsets without depending on judgement", options, async () => {
  const detail = await service.source(user, project.id, "source1", { from: "2026-10-01", to: "2026-10-02" });
  assert.notEqual(detail.history[0].coverage, detail.history[1].coverage);
});
