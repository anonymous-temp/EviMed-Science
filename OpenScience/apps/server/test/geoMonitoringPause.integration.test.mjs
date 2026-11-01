// What the monitoring view says while measurement cannot run (2026-10-25: the probe host had been unreachable for six days, every
// round closed with nothing asked, and the page went on naming the next re-measure and counting the empty rounds): which of the
// project's engines the probe's breaker holds, since when as the stored answers show it, no next re-measure while nothing can be
// asked or the owner has paused the project, and a round that heard no answer neither in 「本周」 nor in the step rail's count.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoService, geoMeasurementPause } from "../src/geoService.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {GeoStore} */
let store;
/** @type {{ drop: () => Promise<void> } | null} */
let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geopause");
  database = new ControlPlaneDatabase({ databaseUrl: /** @type {any} */ (isolated).url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  await store.ready();
});

after(async () => {
  await database?.close();
  await isolated?.drop();
});

const CONFIG = { geoEnabled: true, geoAudience: "all", geoTimeZone: "Asia/Shanghai", geoProbeUrl: "http://127.0.0.1:9" };

test("the pause is read from the probe's state: held engines, every probe engine while the host is down, the inclusion channel apart", () => {
  const now = new Date("2026-10-25T08:00:00Z");
  const probe = (/** @type {string[]} */ paused, hostPausedUntil = 0) => ({ breaker: { paused: () => paused }, hostPausedUntil });
  const engines = ["deepseek", "kimi"];
  assert.deepEqual(geoMeasurementPause({ engines, probe: null, config: CONFIG, now }), { state: "measuring", engines: [] }, "nothing known, nothing paused");
  assert.deepEqual(geoMeasurementPause({ engines, probe: probe(["deepseek", "doubao"]), config: CONFIG, now }), { state: "measuring", engines: ["deepseek"] });
  assert.deepEqual(geoMeasurementPause({ engines, probe: probe(["kimi", "deepseek"]), config: CONFIG, now }), { state: "paused", engines: ["deepseek", "kimi"] });
  assert.deepEqual(geoMeasurementPause({ engines, probe: probe([], now.getTime() + 60_000), config: CONFIG, now }), { state: "paused", engines });
  assert.deepEqual(geoMeasurementPause({ engines, probe: probe([]), config: { ...CONFIG, geoProbeUrl: "" }, now }), { state: "measuring", engines: [] },
    "an unconfigured probe is the queue's wait, not a pause");
  assert.deepEqual(geoMeasurementPause({ engines: [...engines, "baidu"], probe: probe([], now.getTime() + 60_000), config: { ...CONFIG, geoInclusionEngines: ["baidu"] }, now }),
    { state: "measuring", engines }, "Baidu is asked through the inclusion channel, not the probe host");
});

test("the monitoring view says the measurement is paused, since when, and names no next re-measure; 本周 and the rail count only rounds with answers", options, async () => {
  const userId = `u-${randomUUID().slice(0, 8)}`;
  const project = await store.createProject({ userId, projectId: "p-pause", engines: ["deepseek", "kimi"], coverageDays: 90, product: { brandName: "玛仕度肽" } });
  await store.setStep(project.id, "monitoring", { requested: true, automation: { state: "confirmed", actorId: userId,
    at: new Date().toISOString(), engines: project.engines, coverageDays: project.coverageDays } });
  const service = new GeoService({ store, config: CONFIG });
  const user = { id: userId };
  // A baseline that heard an answer, and this week's re-measure that heard none (its engines paused).
  await database.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, status, planned, done, failed, sample_date, finished_at)
    VALUES ('r-base', $1, $2, 'baseline', 'done', 2, 2, 0, current_date, now() - interval '2 days'),
           ('r-empty', $1, $2, 'weekly', 'partial', 2, 0, 2, NULL, now() - interval '1 hour')`, [userId, project.id]);
  /** @param {string} id @param {string | null} round @param {string} engine @param {string} status @param {string} at */
  const answer = (id, round, engine, status, at) => database.query(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, engine, asked_at, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, userId, round, project.id, engine, at, status]);
  await answer("s-base", "r-base", "deepseek", "valid", "2026-10-18T00:00:00Z");
  await answer("s-k-ok", null, "kimi", "valid", "2026-10-19T00:00:00Z");
  await answer("s-d-1", null, "deepseek", "failed", "2026-10-19T12:00:00Z");
  await answer("s-d-2", null, "deepseek", "failed", "2026-10-20T12:00:00Z");
  await answer("s-k-1", null, "kimi", "suspect", "2026-10-21T00:00:00Z");

  const running = await service.monitoring(user, project.id);
  assert.deepEqual(running.measurement, { state: "measuring", since: null, engines: [] }, "without the probe's state nothing is known to be paused");
  assert.ok(running.next, "a re-measure is named while measurement runs");

  service.probeState = () => ({ breaker: { paused: () => ["deepseek"] }, hostPausedUntil: 0 });
  const partly = await service.monitoring(user, project.id);
  assert.deepEqual(partly.measurement, { state: "measuring", since: "2026-10-19T12:00:00.000Z", engines: ["deepseek"] },
    "DeepSeek out since its first failed ask after its last answer; Kimi still asks");
  assert.ok(partly.next);

  service.probeState = () => ({ breaker: { paused: () => ["deepseek", "kimi"] }, hostPausedUntil: 0 });
  const paused = await service.monitoring(user, project.id);
  assert.deepEqual(paused.measurement, { state: "paused", since: "2026-10-21T00:00:00.000Z", engines: ["deepseek", "kimi"] },
    "nothing can be asked since the last engine stopped");
  assert.equal(paused.next, null, "no re-measure is named while nothing can be asked");

  service.probeState = () => null;
  await database.query(`UPDATE evimed_geo.projects SET status = 'paused' WHERE id = $1`, [project.id]);
  assert.equal((await service.monitoring(user, project.id)).next, null, "nor while the owner has paused the project");
  await database.query(`UPDATE evimed_geo.projects SET status = 'active' WHERE id = $1`, [project.id]);

  const view = await service.projectView(user, project.id);
  const rounds = view.overview.week.filter((/** @type {any} */ item) => item.kind === "round");
  assert.deepEqual(rounds.map((/** @type {any} */ item) => item.ref.roundId), ["r-base"], "no 「每周复测完成，0 次提问」");
  const summaries = await service.spine.stepSummaries(project.id);
  assert.equal(summaries.monitoring?.count, 1, "the rail counts the round that measured, not the empty one");
});

test("a round that heard no answer is neither the spine's latest or baseline round nor the round the sources page counts", options, async () => {
  const userId = `u-${randomUUID().slice(0, 8)}`;
  const project = await store.createProject({ userId, projectId: "p-spine", engines: ["deepseek"], coverageDays: 90, product: { brandName: "玛仕度肽" } });
  const service = new GeoService({ store, config: CONFIG });
  // An empty single-step round first (a diagnosis tried while the engines were paused), then a baseline that heard an answer, then
  // this week's re-measure that heard none.
  await database.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, status, planned, done, failed, sample_date, finished_at)
    VALUES ('rs-step-empty', $1, $2, 'single_step', 'partial', 1, 0, 1, NULL, now() - interval '5 days'),
           ('rs-base', $1, $2, 'baseline', 'done', 1, 1, 0, current_date - 3, now() - interval '3 days'),
           ('rs-week-empty', $1, $2, 'weekly', 'partial', 1, 0, 1, NULL, now() - interval '1 hour')`, [userId, project.id]);
  await database.query(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, engine, asked_at, status, citations)
    VALUES ('ss-base', $1, 'rs-base', $2, 'deepseek', now() - interval '3 days', 'valid', '[{"url":"https://www.dxy.cn/a","domain":"dxy.cn"}]'::jsonb)`,
  [userId, project.id]);
  await database.query(`INSERT INTO evimed_geo.facts (snapshot_id, user_id, geo_project_id, mentions_ours, judged_at) VALUES ('ss-base', $1, $2, true, now())`,
    [userId, project.id]);
  await database.query(`INSERT INTO evimed_geo.sources (id, user_id, geo_project_id, domain, cited, mentions_ours) VALUES ('src-dxy', $1, $2, 'dxy.cn', '{}'::jsonb, 0)`,
    [userId, project.id]);

  const spine = await service.spine.load(project);
  assert.equal(spine.rounds.latest?.id, "rs-base", "the latest reading is the round that heard an answer, not this week's empty one");
  assert.equal(spine.rounds.baseline?.id, "rs-base", "the baseline is the first round that measured, not the empty diagnosis before it");

  const sources = await service.sources({ id: userId }, project.id);
  const dxy = sources.sources.find((/** @type {any} */ row) => row.domain === "dxy.cn");
  assert.deepEqual([dxy?.cited, dxy?.mentionsOurs], [{ deepseek: 1 }, 1], "the sources page counts the latest round with answers, not the empty week (all zero)");
});
