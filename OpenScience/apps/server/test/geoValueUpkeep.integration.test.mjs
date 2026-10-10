// The value profiles' upkeep on a real PostgreSQL (G10c): a project keeps its latest versions and its milestones — the versions another
// stored object points to, and the first of each calendar month — and the rest are pruned, a bounded number a tick, counted.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GEO_VALUE_REFERENCES, createGeoValueUpkeep, pruneGeoValueProfiles } from "../src/geoValueUpkeep.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>>} */
let isolated;
/** @type {ControlPlaneDatabase} */
let database;
/** @type {GeoStore} */
let store;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "upkeep");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  store = new GeoStore({ database });
  await store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); });

const fresh = () => store.createProject({ userId: "alice", projectId: randomUUID(), engines: ["deepseek"], coverageDays: 90 });
/** The versions a project's profile holds, oldest first. @param {string} id */
const held = async (id) => (await store.query("SELECT version FROM evimed_geo.value_profiles WHERE geo_project_id = $1 ORDER BY version", [id])).rows.map((/** @type {any} */ row) => Number(row.version));
/** Write `count` versions, each adding a finding, and return the version the last one is. @param {string} id @param {number} count */
async function grow(id, count) {
  let last = 0;
  for (let index = 0; index < count; index += 1) last = (await store.writeValue("alice", id, { findings: [{ id: `f${last + 1}`, statement: `Finding ${last + 1}` }] })).version;
  return last;
}
/** Date the versions: 1–8 in August, 9–18 in September, the rest in October (midday UTC, well inside each month in any zone the module uses). @param {string} id */
const dateByMonth = (id) => store.query(`UPDATE evimed_geo.value_profiles SET created_at = (CASE WHEN version <= 8 THEN '2026-08-10T12:00:00Z' WHEN version <= 18
  THEN '2026-09-10T12:00:00Z' ELSE '2026-10-10T12:00:00Z' END)::timestamptz + make_interval(mins => version) WHERE geo_project_id = $1`, [id]);
const RULES = { keep: 20, limit: 1_000, timeZone: "Asia/Shanghai" };
const range = (/** @type {number} */ from, /** @type {number} */ to) => Array.from({ length: to - from + 1 }, (_unused, index) => from + index);

test("a project keeps its latest twenty versions, the first of each calendar month and every version a stored object points to; the rest are pruned", options, async () => {
  const project = await fresh();
  await grow(project.id, 40);
  // The research result the profile itself holds names the version its request was made on (12); version 41 is where it was recorded.
  await store.writeValue("alice", project.id, { researchResults: [{ id: "r1", status: "available", basisVersion: 12 }] });
  await dateByMonth(project.id);
  assert.equal((await held(project.id)).length, 41);
  // One stored object of each kind points to a version. Every kind in the table is represented: the table is what the statement is built from.
  const round = `gr_${randomUUID()}`;
  await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,ref) VALUES($1,'alice',$2,'baseline','done',$3::jsonb)",
    [round, project.id, JSON.stringify({ evaluationBasis: { value: { version: 3, data: {} } } })]);
  const snapshot = `gs_${randomUUID()}`;
  await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,engine,asked_at) VALUES($1,'alice',$2,$3,'deepseek',now())", [snapshot, project.id, round]);
  await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,judge_extract) VALUES($1,'alice',$2,now(),$3::jsonb)",
    [snapshot, project.id, JSON.stringify({ valueBasisVersion: 5, valueCoverage: [] })]);
  await store.query("INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,value_context) VALUES($1,'alice',$2,$3::jsonb)", [`ga_${randomUUID()}`, project.id, JSON.stringify({ basisVersion: 6 })]);
  await store.query("INSERT INTO evimed_geo.schedule_marks(geo_project_id,key,user_id,kind,state,detail) VALUES($1,'run:research:abc','alice','run','done',$2::jsonb)",
    [project.id, JSON.stringify({ purpose: "research", basisVersion: 7 })]);
  await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,value_context) VALUES($1,'alice',$2,1,$3::jsonb)", [`ggr_${randomUUID()}`, project.id, JSON.stringify({ basisVersion: 2 })]);
  await store.query("INSERT INTO evimed_geo.sources(id,user_id,geo_project_id,domain,value_context) VALUES($1,'alice',$2,'jksb.com.cn',$3::jsonb)", [`gsrc_${randomUUID()}`, project.id, JSON.stringify({ basisVersion: 4 })]);
  assert.deepEqual(GEO_VALUE_REFERENCES.map((reference) => reference.table).sort(), ["articles", "facts", "question_groups", "rounds", "schedule_marks", "sources"],
    "a reference added to the table needs a row in this test");

  const pruned = await pruneGeoValueProfiles(store, project.id, RULES);
  // Not kept: neither among the latest 22–41, nor a month's first (1, 9, 19), nor pointed to (2–7, and 12 by the research result).
  assert.deepEqual(pruned, [8, ...range(10, 11), ...range(13, 18), 20, 21]);
  assert.deepEqual(await held(project.id), [...range(1, 7), 9, 12, 19, ...range(22, 41)]);
  assert.deepEqual(await pruneGeoValueProfiles(store, project.id, RULES), [], "a second pass finds nothing more");
  assert.equal((await store.latestValue(project.id)).version, 41, "the latest is what a reader gets");
});

test("a pass spares nothing it should not: a project under the limit, and the latest, are never touched; the bound limits one pass", options, async () => {
  const small = await fresh();
  await grow(small.id, 12);
  assert.deepEqual(await pruneGeoValueProfiles(store, small.id, RULES), [], "twelve versions are under twenty");
  const project = await fresh();
  await grow(project.id, 30);
  await dateByMonth(project.id);
  // Versions 1–10 are the oldest outside the latest twenty (11–30); 1 is the first of August and 9 the first of September.
  assert.deepEqual(await pruneGeoValueProfiles(store, project.id, { ...RULES, limit: 3 }), [2, 3, 4], "oldest first, at most the bound");
  assert.deepEqual(await pruneGeoValueProfiles(store, project.id, { ...RULES, limit: 3 }), [5, 6, 7]);
  assert.deepEqual(await pruneGeoValueProfiles(store, project.id, RULES), [8, 10]);
  assert.deepEqual(await held(project.id), [1, 9, ...range(11, 30)]);
});

test("the month is the module's zone's: a version made late on the 31st UTC is the next month's in Shanghai", options, async () => {
  const project = await fresh();
  await grow(project.id, 25);
  // Version 2 is 23:30 UTC on 31 August = 07:30 on 1 September in Shanghai, so it is September's first there; version 1 is August's.
  await store.query(`UPDATE evimed_geo.value_profiles SET created_at = CASE WHEN version = 1 THEN '2026-08-20T12:00:00Z'::timestamptz
    WHEN version = 2 THEN '2026-08-31T23:30:00Z'::timestamptz ELSE '2026-10-10T12:00:00Z'::timestamptz + make_interval(mins => version) END WHERE geo_project_id = $1`, [project.id]);
  const shanghai = await pruneGeoValueProfiles(store, project.id, RULES);
  assert.equal(shanghai.includes(2), false, "September's first in Shanghai");
  assert.equal(shanghai.includes(1), false, "August's first");
  const utc = await fresh();
  await grow(utc.id, 25);
  await store.query(`UPDATE evimed_geo.value_profiles SET created_at = CASE WHEN version = 1 THEN '2026-08-20T12:00:00Z'::timestamptz
    WHEN version = 2 THEN '2026-08-31T23:30:00Z'::timestamptz ELSE '2026-10-10T12:00:00Z'::timestamptz + make_interval(mins => version) END WHERE geo_project_id = $1`, [utc.id]);
  assert.equal((await pruneGeoValueProfiles(store, utc.id, { ...RULES, timeZone: "UTC" })).includes(2), true, "in UTC version 2 is August's second");
});

test("the loop prunes a bounded number of versions a tick across projects, counts them, and does not look again at a project that gets no new version", options, async () => {
  await store.query("DELETE FROM evimed_geo.value_profiles");
  const first = await fresh();
  const second = await fresh();
  await grow(first.id, 30);
  await grow(second.id, 30);
  const reported = [];
  const upkeep = createGeoValueUpkeep({ store, config: { geoValueKeepVersions: 20, geoValuePrunePerTick: 12, geoTimeZone: "Asia/Shanghai" }, report: (code) => reported.push(code) });
  // Each project holds ten prunable versions beyond the latest twenty and its first (2–10: nine, as all are one month).
  const ids = [first.id, second.id].sort();
  const tick1 = await upkeep.tick();
  assert.deepEqual([tick1.versionsPruned, tick1.projectsPruned], [12, 2], "twelve in all: the first project's nine and three of the second's");
  assert.deepEqual([(await held(ids[0])).length, (await held(ids[1])).length], [21, 27]);
  const tick2 = await upkeep.tick();
  assert.deepEqual([tick2.versionsPruned, tick2.projectsPruned], [6, 1], "what is left of the second project's");
  assert.deepEqual([(await held(ids[0])).length, (await held(ids[1])).length], [21, 21]);
  const tick3 = await upkeep.tick();
  assert.deepEqual([tick3.versionsPruned, tick3.projectsChecked], [0, 0], "both are settled at their latest version: not looked at again");
  await store.writeValue("alice", first.id, { findings: [{ id: "another", statement: "A new version" }] });
  const tick4 = await upkeep.tick();
  assert.deepEqual([tick4.versionsPruned, tick4.projectsChecked], [1, 1], "a new version makes the oldest unkept one prunable, and only that project is looked at");
  assert.deepEqual(upkeep.metrics(), { ticks: 4, projectsChecked: 4, versionsPruned: 19, projectsPruned: 4, watchProjects: 0, watchIdentifiers: 0, changesFlagged: 0,
    changesExtended: 0, projectsFlagged: 0, failures: 0 });
  assert.deepEqual(reported, []);
});

test("a pass that fails is counted and reported and the loop goes on", options, async () => {
  const reported = [];
  const broken = { query: async () => { throw Object.assign(new Error("down"), { code: "57P01" }); }, transaction: async () => { throw new Error("unreached"); } };
  const upkeep = createGeoValueUpkeep({ store: broken, report: (code) => reported.push(code) });
  assert.deepEqual(await upkeep.tick(), { projectsChecked: 0, versionsPruned: 0, projectsPruned: 0, watchProjects: 0, changesFlagged: 0 });
  assert.deepEqual(reported, ["prune:57P01"]);
  assert.equal(upkeep.metrics().failures, 1);
});

test("a version that was pruned is said not to be stored, not read as an empty profile", options, async () => {
  const project = await fresh();
  await grow(project.id, 30);
  await dateByMonth(project.id);
  await pruneGeoValueProfiles(store, project.id, RULES);
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const gone = await service.valueOf(project, { version: 8 });
  assert.deepEqual([gone.version, gone.requestedVersion], [0, 8]);
  assert.match(gone.notice, /Version 8 .* not stored/);
  const kept = await service.valueOf(project, { version: 9 });
  assert.equal(kept.version, 9, "a month's first is still there");
  assert.equal("notice" in kept, false);
  const latest = await service.valueOf(project);
  assert.deepEqual([latest.version, "notice" in latest], [30, false]);
});
