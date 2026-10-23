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
  const planned = await readGeoSelection(store, other, { from: "2026-10-02", to: "2026-10-02" });
  assert.equal(planned.rounds.length, 0, "a planned round without observations is not a dated measurement");
  assert.equal(planned.selection.timeCoverage.plannedRounds, 1);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status,asked_at)
    VALUES ('bounded-dated',$1,$2,'r-bounded','deepseek','failed','2026-10-01T16:30:00Z')`, [user.id, other.id]);
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
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status,asked_at)
    SELECT 'history-observation-' || n,$1,$2,'history-' || n,'deepseek','failed',date '2026-10-03' + n
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

test("legacy metric preservation never substitutes full-round aggregates for a filtered selection", options, async () => {
  const legacy = await store.createProject({ userId: user.id, projectId: "legacy-scope-project", engines: ["deepseek", "kimi"], coverageDays: 90 });
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,sample_date,finished_at)
    VALUES ('legacy-scope-round',$1,$2,'baseline','done',1,'2026-10-01','2026-10-01')`, [user.id, legacy.id]);
  await store.query(`INSERT INTO evimed_geo.metrics (id,user_id,geo_project_id,round_id,scope,engine,metric_id,status,value,denominator)
    VALUES ('legacy-deepseek',$1,$2,'legacy-scope-round','engine','deepseek','M-01','ok',50,100),
    ('legacy-kimi',$1,$2,'legacy-scope-round','engine','kimi','M-01','ok',50,100)`, [user.id, legacy.id]);
  for (const filter of [{}, { round: "legacy-scope-round" }]) {
    const view = await service.runtimeRead(legacy, "metrics", filter);
    assert.equal(view.total, 2, "a whole historical round remains available with its unknown method");
    assert.ok(view.items.every((entry) => entry.cell.value === 50 && entry.cell.methodVersion === null));
  }
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status,asked_at)
    VALUES ('legacy-day-one',$1,$2,'legacy-scope-round','deepseek','failed','2026-10-01T00:00Z'),
    ('legacy-day-two',$1,$2,'legacy-scope-round','kimi','failed','2026-10-02T00:00Z')`, [user.id, legacy.id]);
  for (const filter of [{ engines: ["deepseek"] }, { pools: ["P4"] }, { groupIds: ["missing-group"] }, { clientTags: ["missing-tag"] }, { from: "2026-10-01", to: "2026-10-01" }]) {
    const view = await service.runtimeRead(legacy, "metrics", { ...filter, limit: 50 });
    assert.ok(view.items.every((entry) => entry.cell.value !== 50), "unavailable scoped observations cannot inherit a stored whole-round value");
    if (filter.engines) assert.ok(view.items.every((entry) => entry.engine == null || entry.engine === "deepseek"));
    const replayed = await service.runtimeRead(legacy, "metrics", { selectionRef: view.selection.reference, limit: 50 });
    assert.deepEqual(replayed.items, view.items);
  }
});

test("default source context selects its six rounds before enforcing history resource limits", options, async () => {
  for (const roundCount of [121, 7]) {
    const historic = await store.createProject({ userId: user.id, projectId: `source-history-${roundCount}`, engines: ["deepseek"], coverageDays: 90 });
    const sourceId = `source-history-${roundCount}`;
    await store.query(`INSERT INTO evimed_geo.sources (id,user_id,geo_project_id,domain,name) VALUES ($1,$2,$3,'example.com','Example')`, [sourceId, user.id, historic.id]);
    await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,sample_date,finished_at)
      SELECT $1 || n,$2,$3,'weekly','done',date '2026-01-01' + n,date '2026-01-01' + n FROM generate_series(0,$4::integer) n`,
    [`history-limit-${roundCount}-`, user.id, historic.id, roundCount - 1]);
    await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status,asked_at)
      SELECT 'context-' || $1 || n,$2,$3,$1 || n,'deepseek','failed',date '2026-01-01' + n FROM generate_series(0,$4::integer) n`,
    [`history-limit-${roundCount}-`, user.id, historic.id, roundCount - 1]);
    await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status,asked_at)
      SELECT $1 || n,$2,$3,$4,'deepseek','failed','2026-01-01' FROM generate_series(1,20001) n`,
    [`old-history-${roundCount}-`, user.id, historic.id, `history-limit-${roundCount}-0`]);
    const detail = await service.source(user, historic.id, sourceId);
    assert.equal(detail.history.length, 6);
    assert.equal(detail.history.at(-1).roundId, `history-limit-${roundCount}-${roundCount - 1}`);
    assert.equal(detail.history.some((entry) => entry.roundId === `history-limit-${roundCount}-0`), false);
    await assert.rejects(service.source(user, historic.id, sourceId, { from: "2026-01-01", to: "2026-12-31" }), (error) => error.status === 422);
  }
});

test("view dates use the observation day when a selected round has no sample date", options, async () => {
  const undated = await store.createProject({ userId: user.id, projectId: "undated-view-project", engines: ["deepseek"], coverageDays: 90 });
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,started_at,created_at,finished_at)
    VALUES ('undated-view-round',$1,$2,'baseline','done','2026-10-01T16:30:00Z','2026-10-01T14:00:00Z','2026-10-01T17:00:00Z')`, [user.id, undated.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status,asked_at)
    VALUES ('undated-view-observation',$1,$2,'undated-view-round','deepseek','failed','2026-10-01T16:30:00Z')`, [user.id, undated.id]);
  for (const [timeZone, date] of [["Asia/Shanghai", "2026-10-02"], ["America/New_York", "2026-10-01"]]) {
    const scope = { from: date, to: date, timeZone };
    const overview = await service.projectView(user, undated.id, scope);
    assert.equal(overview.overview.metrics[0].trend[0].date, date);
    const diagnosis = await service.diagnosis(user, undated.id, scope);
    assert.equal(diagnosis.round.sampleDate, date);
    const monitoring = await service.monitoring(user, undated.id, scope);
    assert.equal(monitoring.series[0].points[0].date, date);
  }
});

test("sample dates retain their civil day in every requested time zone", options, async () => {
  for (const timeZone of ["Asia/Shanghai", "America/New_York"]) {
    const scope = { round: "r1", timeZone };
    const diagnosis = await service.diagnosis(user, project.id, scope);
    assert.equal(diagnosis.round.sampleDate, "2026-10-01");
    const monitoring = await service.monitoring(user, project.id, scope);
    assert.equal(monitoring.series[0].points[0].date, "2026-10-01");
  }
});

test("unfiltered histories use the observation start day after a cross-day queue wait", options, async () => {
  const queued = await store.createProject({ userId: user.id, projectId: "queued-date-project", engines: ["deepseek"], coverageDays: 90 });
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,started_at,created_at,finished_at)
    VALUES ('queued-date-round',$1,$2,'baseline','done','2026-10-01T16:30:00Z','2026-10-01T14:00:00Z','2026-10-01T17:00:00Z')`, [user.id, queued.id]);
  await store.query(`INSERT INTO evimed_geo.metrics (id,user_id,geo_project_id,round_id,scope,metric_id,rival,status,value,computed_at)
    VALUES ('queued-date-mention',$1,$2,'queued-date-round','project','M-01S',NULL,'ok',50,'2026-10-04'),
      ('queued-date-rival',$1,$2,'queued-date-round','project','M-16','Other','ok',50,'2026-10-04')`, [user.id, queued.id]);
  const view = await service.monitoring(user, queued.id);
  assert.equal(view.series.find((entry) => entry.key === "mention").points[0].date, "2026-10-02");
  assert.equal(view.rivals[0].points[0].date, "2026-10-02");
});

test("GVI comparisons reject a changed measurable component basis even for identical answers", options, async () => {
  const composite = await store.createProject({ userId: user.id, projectId: "gvi-basis-project", engines: ["deepseek"], coverageDays: 90, product: { brandName: "Ours" } });
  await store.query(`INSERT INTO evimed_geo.question_groups (id,user_id,geo_project_id,set_version,pool,name) VALUES ('gvi-basis-group',$1,$2,1,'P2','Group')`, [user.id, composite.id]);
  await store.query(`INSERT INTO evimed_geo.questions (id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured)
    SELECT 'gvi-basis-q-' || n,$1,$2,'gvi-basis-group',1,'P2','Which brand ' || n,true FROM generate_series(1,40) n`, [user.id, composite.id]);
  for (const [roundId, date, coverage] of [["gvi-basis-before", "2026-10-01", "partial"], ["gvi-basis-after", "2026-10-02", "complete"]]) {
    await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at,surface)
      VALUES ($1,$2,$3,'baseline','done',1,'{deepseek}',$4::date,$4::date,'{"mode":"web"}')`, [roundId, user.id, composite.id, date]);
    await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
      SELECT $1 || '-' || n,$2,$3,$1,'gvi-basis-q-' || n,'deepseek',$4::date,'valid','Identical answer','{"mode":"web"}' FROM generate_series(1,40) n`, [roundId, user.id, composite.id, date]);
    await store.query(`INSERT INTO evimed_geo.facts (snapshot_id,user_id,geo_project_id,judged_at,brands,first_ours,position_ours,recommended_ours,mentions_ours,retrieval_triggered,statements,checks)
      SELECT $1 || '-' || n,$2,$3,$4::date,'[{"name":"Ours","ours":true,"count":1}]',true,1,true,true,false,
      '[{"text":"Correct","verdict":"correct"}]',jsonb_build_object('judgementCoverage',jsonb_build_object('status',$5::text)) FROM generate_series(1,40) n`, [roundId, user.id, composite.id, date, coverage]);
  }
  const filter = { from: "2026-10-02", to: "2026-10-02", compareFrom: "2026-10-01", compareTo: "2026-10-01" };
  const result = await readGeoSelection(store, composite, filter);
  const gvi = result.comparison.cells.find((cell) => cell.metricId === "M-19" && cell.scope === "project");
  assert.notEqual(gvi.current.value, gvi.previous.value, "different measurable ingredients still retain their actual values");
  assert.equal(gvi.comparable, false);
  assert.equal(gvi.delta, null);
  await store.query(`UPDATE evimed_geo.facts SET checks = '{"judgementCoverage":{"status":"complete"}}' WHERE snapshot_id LIKE 'gvi-basis-before-%'`);
  const equal = (await readGeoSelection(store, composite, filter)).comparison.cells.find((cell) => cell.metricId === "M-19" && cell.scope === "project");
  assert.equal(equal.comparable, true);
  assert.equal(equal.delta, 0);
});

test("date ranges select actual answer occurrences across midnight without dating unknown observations", options, async () => {
  const timed = await store.createProject({ userId: user.id, projectId: "occurrence-date-project", engines: ["deepseek"], coverageDays: 90 });
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,sample_date,started_at,created_at,finished_at)
    VALUES ('occurrence-round',$1,$2,'baseline','done','2026-10-01','2026-10-01T12:00Z','2026-10-01T12:00Z','2026-10-02T01:00Z')`, [user.id, timed.id]);
  for (const [suffix, askedAt] of [["first", "2026-10-01T15:59:59Z"], ["second", "2026-10-01T16:00:00Z"], ["unknown", null]]) {
    await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status,asked_at)
      VALUES ($1,$2,$3,'occurrence-round','deepseek','failed',$4)`, [`occurrence-${suffix}`, user.id, timed.id, askedAt]);
  }
  for (const [date, suffix] of [["2026-10-01", "first"], ["2026-10-02", "second"]]) {
    const scope = { from: date, to: date };
    const selected = await readGeoSelection(store, timed, scope);
    assert.deepEqual(selected.rows.map((row) => row.snapshotId), [`occurrence-${suffix}`]);
    assert.equal(selected.selection.timeCoverage.unknownTime, 1);
    assert.equal(selected.selection.timeCoverage.basis, "answer_asked_at");
    const diagnosis = await service.diagnosis(user, timed.id, scope);
    assert.equal(diagnosis.round.sampleDate, date);
    assert.equal((await service.monitoring(user, timed.id, scope)).series[0].points[0].date, date);
  }
  const whole = await readGeoSelection(store, timed, { round: "occurrence-round" });
  assert.equal(whole.rows.length, 3, "an explicit round without dates still includes undated records");
  assert.equal(whole.selection.timeCoverage.unknownTime, 1);
  const ny = await readGeoSelection(store, timed, { from: "2026-10-01", to: "2026-10-01", timeZone: "America/New_York" });
  assert.equal(ny.rows.length, 2);
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,sample_date)
    VALUES ('occurrence-unplaced-round',$1,$2,'baseline','done','2026-10-01')`, [user.id, timed.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status)
    VALUES ('occurrence-unplaced',$1,$2,'occurrence-unplaced-round','deepseek','failed')`, [user.id, timed.id]);
  const withContext = await readGeoSelection(store, timed, { from: "2026-10-01", to: "2026-10-01" });
  assert.equal(withContext.selection.timeCoverage.unknownTime, 2);
  assert.equal(withContext.selection.timeCoverage.plannedRounds, 2);
  const replayed = await readGeoSelection(store, timed, { selectionRef: withContext.selection.reference });
  assert.equal(replayed.selection.dataRevision, withContext.selection.dataRevision, "unplaced schedule context must be stable when the observed rounds are frozen");
});

test("observation caps apply after engine and question-dimension filters", options, async () => {
  const wide = await store.createProject({ userId: user.id, projectId: "filtered-cap-project", engines: ["deepseek", "kimi"], coverageDays: 90 });
  await store.query(`INSERT INTO evimed_geo.question_groups (id,user_id,geo_project_id,set_version,pool,name)
    VALUES ('cap-g1',$1,$2,1,'P2','First'),('cap-g2',$1,$2,1,'P3','Second')`, [user.id, wide.id]);
  await store.query(`INSERT INTO evimed_geo.questions (id,user_id,geo_project_id,group_id,set_version,pool,text)
    VALUES ('cap-q1',$1,$2,'cap-g1',1,'P2','First?'),('cap-q2',$1,$2,'cap-g2',1,'P3','Second?')`, [user.id, wide.id]);
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,sample_date,finished_at)
    VALUES ('filtered-cap-round',$1,$2,'baseline','done',1,'2026-10-01','2026-10-01')`, [user.id, wide.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at)
    SELECT 'filtered-cap-many-' || n,$1,$2,'filtered-cap-round','cap-q2','kimi','failed','2026-10-01T00:00Z' FROM generate_series(1,20001) n`, [user.id, wide.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at)
    VALUES ('filtered-cap-one',$1,$2,'filtered-cap-round','cap-q1','deepseek','failed','2026-10-02T00:00Z')`, [user.id, wide.id]);
  await assert.rejects(readGeoSelection(store, wide), (error) => error.status === 422);
  for (const scope of [{ engines: ["deepseek"] }, { groupIds: ["cap-g1"] }, { pools: ["P2"] }, { from: "2026-10-02", to: "2026-10-02" }]) {
    const selected = await readGeoSelection(store, wide, scope);
    assert.deepEqual(selected.rows.map((row) => row.snapshotId), ["filtered-cap-one"]);
  }
});

test("dated trends pool actual day buckets across rounds and preserve exact day-member continuations", options, async () => {
  const daily = await store.createProject({ userId: user.id, projectId: "daily-occurrence-project", engines: ["deepseek"], coverageDays: 90 });
  await store.query(`INSERT INTO evimed_geo.question_groups (id,user_id,geo_project_id,set_version,pool,name) VALUES ('daily-g',$1,$2,1,'P2','Daily')`, [user.id, daily.id]);
  await store.query(`INSERT INTO evimed_geo.questions (id,user_id,geo_project_id,group_id,set_version,pool,text)
    VALUES ('daily-q1',$1,$2,'daily-g',1,'P2','One?'),('daily-q2',$1,$2,'daily-g',1,'P2','Two?')`, [user.id, daily.id]);
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at,surface)
    VALUES ('daily-r1',$1,$2,'baseline','done',1,'{deepseek}','2026-10-01','2026-10-02','{"mode":"web"}'),
    ('daily-r2',$1,$2,'weekly','done',1,'{deepseek}','2026-10-01','2026-10-02','{"mode":"web"}')`, [user.id, daily.id]);
  for (const [id, round, question, askedAt, mentioned] of [["daily-a","daily-r1","daily-q1","2026-10-01T15:59Z",true],
    ["daily-b","daily-r1","daily-q2","2026-10-01T16:01Z",false], ["daily-c","daily-r2","daily-q1","2026-10-01T15:00Z",false],
    ["daily-d","daily-r2","daily-q2","2026-10-01T15:01Z",false]]) {
    await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,surface)
      VALUES ($1,$2,$3,$4,$5,'deepseek','valid',$6,'{"mode":"web"}')`, [id,user.id,daily.id,round,question,askedAt]);
    await store.query(`INSERT INTO evimed_geo.facts (snapshot_id,user_id,geo_project_id,judged_at,brands,checks)
      VALUES ($1,$2,$3,'2026-10-03',$4::jsonb,'{"judgementCoverage":{"status":"complete"}}')`,
    [id,user.id,daily.id,JSON.stringify(mentioned ? [{name:"Ours",ours:true,count:1}] : [])]);
  }
  const scope = { from: "2026-10-01", to: "2026-10-02" };
  const monitoring = await service.monitoring(user, daily.id, scope);
  const points = monitoring.series.find((entry) => entry.key === "mention").points;
  assert.deepEqual(points.map((point) => [point.date, point.n, point.k]), [["2026-10-01",3,1],["2026-10-02",1,0]]);
  assert.deepEqual(points[0].roundIds.sort(), ["daily-r1","daily-r2"]);
  for (const point of points) {
    const detail = await service.runtimeRead(daily, "snapshots", { selectionRef: point.members.selectionRef, member: point.members.metric, limit: 50 });
    assert.equal(detail.total, point.n);
    assert.equal(point.members.metric.observationDate, point.date);
  }
  const overview = await service.projectView(user, daily.id, scope);
  assert.deepEqual(overview.overview.metrics.find((entry) => entry.key === "mention").trend, points);
  const wholeRound = await service.monitoring(user, daily.id, { round: "daily-r1" });
  const wholePoint = wholeRound.series.find((entry) => entry.key === "mention").points[0];
  assert.equal(wholePoint.members.selectionRef, wholeRound.selection.reference);
  const wholeDetail = await service.runtimeRead(daily, "snapshots", { selectionRef: wholePoint.members.selectionRef, member: wholePoint.members.metric });
  assert.equal(wholeDetail.total, wholePoint.n);
});

test("frozen observed references survive changes to unrelated current schedule and undated context", options, async () => {
  const selected = await readGeoSelection(store, project, { from: "2026-10-01", to: "2026-10-02" });
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,engines,sample_date)
    VALUES ('unrelated-queue',$1,$2,'weekly','queued',1,'{deepseek}','2026-10-02')`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,engine,status)
    VALUES ('unrelated-undated',$1,$2,'unrelated-queue','deepseek','failed')`, [user.id, project.id]);
  const replay = await readGeoSelection(store, project, { selectionRef: selected.selection.reference });
  assert.equal(replay.selection.reference, selected.selection.reference);
  assert.equal(replay.selection.dataRevision, selected.selection.dataRevision);
  assert.equal(replay.selection.timeCoverage.plannedRounds, selected.selection.timeCoverage.plannedRounds + 1);
  assert.equal(replay.selection.timeCoverage.unknownTime, selected.selection.timeCoverage.unknownTime + 1);
});

test("a dated explicit-round selection with no matching observations replays its empty cohort", options, async () => {
  const selected = await readGeoSelection(store, project, { round: "r1", from: "2026-10-02", to: "2026-10-02" });
  assert.deepEqual(selected.rows, []);
  assert.deepEqual(selected.selection.roundIds, []);
  const replay = await readGeoSelection(store, project, { selectionRef: selected.selection.reference });
  assert.deepEqual(replay.rows, []);
  assert.equal(replay.selection.reference, selected.selection.reference);
  await assert.rejects(readGeoSelection(store, project, { round: "no-such-round", from: "2026-10-02", to: "2026-10-02" }), (error) => error.status === 404);
});
