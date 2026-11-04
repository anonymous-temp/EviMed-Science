import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { geoCoverageDifference } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { GeoService } from "../src/geoService.mjs";
import { measureRound } from "../src/geoMetricsJob.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { seedGeoProject } from "./helpers/geoMeasureFixtures.mjs";
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
let database, isolated, store, measure;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "geoprovenance");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  store = new GeoStore({ database }); await store.ready();
  measure = new GeoMeasureStore(database); await measure.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); });

test("real calculated trends share frozen coverage across project, list, engine and group reads", { skip: !url }, async () => {
  const userId = "provenance-owner", geoId = "provenance-geo";
  await seedGeoProject(database, { id: geoId, userId, projectId: "provenance-project", engines: ["deepseek"],
    groups: [{ id: "provenance-group", pool: "P2" }],
    questions: Array.from({ length: 35 }, (_, index) => ({ id: `provenance-q-${index}`, groupId: "provenance-group", text: `Question ${index}` })) });
  for (const [index, day] of ["2026-11-01", "2026-11-02"].entries()) {
    const round = `provenance-round-${index}`;
    await database.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,set_version,engines,status,planned,done,sample_date,started_at,finished_at,surface)
      VALUES ($1,$2,$3,$4,1,ARRAY['deepseek'],'done',35,35,$5::text::date,$5::text::timestamptz,$5::text::timestamptz,'{"mode":"web","newChat":true}')`, [round,userId,geoId,index ? "weekly" : "baseline",day]);
    await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
      SELECT $1||q.id,$2,$3,$1,q.id,'deepseek',$4,'valid','A preserved synthetic answer','{"mode":"web","newChat":true}'
      FROM evimed_geo.questions q WHERE q.geo_project_id=$3`, [round,userId,geoId,day]);
    await database.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,parser_version,judge_extract,checks,brands,failure_mode,mentions_ours)
      SELECT s.id,$2,$3,$4,'test-parser','{"rubricVersion":"test-rubric"}','{"judgementCoverage":{"status":"complete"}}','[]','omitted',false
      FROM evimed_geo.snapshots s WHERE s.round_id=$1`, [round,userId,geoId,day]);
    await measureRound({ store: measure, now: () => new Date(`${day}T12:00:00Z`) },round);
  }
  const service = new GeoService({ store, config: { geoEnabled:true, geoAudience:"all", geoTimeZone:"Asia/Shanghai" } });
  const user = { id:userId };
  const project = await service.projectView(user,geoId);
  const trend = project.overview.metrics.find(metric => metric.key === "gvi").trend;
  assert.equal(trend.length,2);
  assert.equal(typeof trend[0].coverage,"string");
  assert.equal(geoCoverageDifference(trend[0].coverage,trend[1].coverage).comparable,true);
  const listed = (await service.listProjects(user)).projects.find(project => project.id === geoId);
  assert.deepEqual(listed.headline.gvi.trend,trend.map(point => point.value));
  assert.deepEqual(listed.headline.gvi.trendCoverage,trend.map(point => point.coverage));
  const watch = await service.monitoring(user,geoId);
  assert.deepEqual(watch.series.find(line => line.key === "gvi").points.map(({date,value,coverage}) => ({date,value,coverage})),trend.map(({date,value,coverage}) => ({date,value,coverage})));
  assert.ok(watch.byEngine[0].points.every(point => typeof point.coverage === "string"));
  await database.query(`UPDATE evimed_geo.facts SET judge_extract='{"rubricVersion":"rejudged-current-facts"}',brands='[{"name":"changed","ours":true,"count":1}]' WHERE geo_project_id=$1`,[geoId]);
  const after = (await service.projectView(user,geoId)).overview.metrics.find(metric => metric.key === "gvi").trend;
  assert.deepEqual(after,trend,"later fact rejudgment cannot change the stored comparison basis");
  await database.query(`UPDATE evimed_geo.metrics SET value=value+1 WHERE geo_project_id=$1 AND metric_id='M-19' AND scope='project' AND round_id='provenance-round-1'`,[geoId]);
  const changed = (await service.projectView(user,geoId)).overview.metrics.find(metric => metric.key === "gvi").trend;
  assert.equal(changed[1].coverage,null,"a persisted value that no longer matches its generation is not comparable");
});
