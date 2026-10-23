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
