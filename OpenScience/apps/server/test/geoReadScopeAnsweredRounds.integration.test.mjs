// The empty-round class (2026-10-25) in the v3 read scope: with the probe host down a round can close having heard no answer.
// Main fixed the measurement, the spine and the sources base so such a round is never measured, never the latest or the
// baseline, never counted by the sources page; the scoped reads v3 added chose "the latest round" again without that filter, so
// after one empty week the sources, groups, diagnosis, the overview and the home list read zero.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { measureRound } from "../src/geoMetricsJob.mjs";
import { readGeoSelection } from "../src/geoReadScope.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const user = { id: "answered-owner" };
let database, store, measure, isolated, project, service;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geoanswered");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database }); measure = new GeoMeasureStore(database);
  await measure.ready(); await store.ready();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'GEO test','development')", [user.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'answered-project','GEO test',1048576)", [user.id]);
  project = await store.createProject({ userId: user.id, projectId: "answered-project", engines: ["deepseek"], coverageDays: 90, product: { brandName: "Ours" } });
  service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  await store.query(`INSERT INTO evimed_geo.question_groups (id,user_id,geo_project_id,set_version,pool,name) VALUES ('g1',$1,$2,1,'P2','Group one')`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.questions (id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured)
    VALUES ('q1',$1,$2,'g1',1,'P2','Which brand?',true)`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.sources (id,user_id,geo_project_id,domain,name,kind,layer) VALUES ('source1',$1,$2,'example.com','Example','medical','owned')`, [user.id, project.id]);
  // The baseline heard an answer that cites the site and names us.
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at,created_at,surface)
    VALUES ('r-answered',$1,$2,'baseline','done',1,'{deepseek}','2026-10-01','2026-10-01T03:00:00Z','2026-10-01','{"mode":"web"}')`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations)
    VALUES ('s-answered',$1,$2,'r-answered','q1','deepseek','2026-10-01T01:00:00Z','valid','Ours works.','{"mode":"web"}','[{"url":"https://example.com/a","domain":"example.com","inBody":true}]')`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.facts (snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,statements,checks,retrieval_triggered,judge_extract)
    VALUES ('s-answered',$1,$2,'2026-10-01T02:00:00Z','[{"name":"Ours","ours":true,"count":1}]',true,'[{"text":"Known","verdict":"correct"}]',
      '{"judgementCoverage":{"status":"complete"}}',true,'{"valueBasisVersion":1,"valueCoverage":[{"status":"expressed","findingId":"f1"}]}')`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.probe_jobs (id,user_id,geo_project_id,round_id,question_id,engine,status,snapshot_id)
    VALUES ('j-answered',$1,$2,'r-answered','q1','deepseek','done','s-answered')`, [user.id, project.id]);
  await measureRound({ store: measure, now: () => new Date("2026-10-01T04:00:00Z") }, "r-answered");
  // This week's re-measure closed with the probe host down: its one ask failed, nothing valid or refused.
  await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at,created_at,surface)
    VALUES ('r-empty',$1,$2,'weekly','partial',1,'{deepseek}',NULL,'2026-10-08T03:00:00Z','2026-10-08','{"mode":"web"}')`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations)
    VALUES ('s-empty',$1,$2,'r-empty','q1','deepseek','2026-10-08T01:00:00Z','failed',NULL,'{"mode":"web"}','[]')`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.probe_jobs (id,user_id,geo_project_id,round_id,question_id,engine,status,error_code,snapshot_id)
    VALUES ('j-empty',$1,$2,'r-empty','q1','deepseek','failed','geo_probe_unavailable','s-empty')`, [user.id, project.id]);
});
after(async () => { await database?.close(); await isolated?.drop(); });

test("the unscoped selection and its history pass over a finished round that heard no answer", options, async () => {
  const selected = await readGeoSelection(store, project, {});
  assert.deepEqual(selected.rounds.map((round) => round.id), ["r-answered"], "the latest reading is the round that heard an answer");
  assert.equal(selected.rows.length, 1);
  const history = await readGeoSelection(store, project, {}, { history: true, historyLimit: 6, persist: false });
  assert.deepEqual(history.rounds.map((round) => round.id), ["r-answered"], "an empty round takes no slot of the history context");
  const explicit = await readGeoSelection(store, project, { round: "r-empty" });
  assert.deepEqual(explicit.rounds.map((round) => round.id), ["r-empty"], "a round named explicitly is still read as asked");
});

test("sources, groups, diagnosis, overview, home list and value coverage read the answered round, not the empty week", options, async () => {
  const sources = await service.sources(user, project.id);
  const site = sources.sources.find((row) => row.domain === "example.com");
  assert.deepEqual([site?.cited, site?.mentionsOurs], [{ deepseek: 1 }, 1], "every site at zero after an empty week");
  const diagnosis = await service.diagnosis(user, project.id);
  assert.equal(diagnosis.round?.id, "r-answered");
  const overview = await service.projectView(user, project.id);
  const mention = overview.overview.metrics.find((entry) => entry.key === "mention");
  assert.equal(mention?.cell?.value, 100, "the overview's mention reads the answered round");
  const groups = await service.clusters(user, project.id);
  assert.deepEqual([groups.selection.roundIds, groups.selection.counts.returned], [["r-answered"], 1], "the groups read the answered round's answer");
  const home = await service.listProjects(user);
  assert.equal(home.projects.find((entry) => entry.id === project.id)?.headline.mention.value, 100, "the home row keeps the last measured headline");
  const coverage = await store.valueCoverage(project.id, {});
  assert.equal(coverage.counts.reduce((sum, row) => sum + row.n, 0), 1, "value coverage reads the latest round that heard an answer");
});
