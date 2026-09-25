// The headline numbers of 「循证 GEO」 come from full measurements only: a
// baseline, a weekly re-measure or a single step's round. A sentinel (ten
// questions on two engines), a post-publication check, a confirmation or a
// noise round measures a sliver, and its project-scope rows must never
// replace the headline, the overview's four blocks or the trend lines.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoService } from "../src/geoService.mjs";
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
  isolated = await createGeoTestDatabase(databaseUrl, "geohead");
  database = new ControlPlaneDatabase({ databaseUrl: /** @type {any} */ (isolated).url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  await store.ready();
});

after(async () => {
  await database?.close();
  await isolated?.drop();
});

test("sentinel, post-publication, confirmation and noise rounds never replace the headline, the overview or the trend", options, async () => {
  const userId = `u-${randomUUID().slice(0, 8)}`;
  const project = await store.createProject({ userId, projectId: "p1", engines: ["deepseek", "kimi"], coverageDays: 90, product: { brandName: "玛仕度肽" } });
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all", geoTimeZone: "Asia/Shanghai" } });
  let minute = 0;
  /** @param {string} kind @param {string} day @param {number} gvi @param {number} mention */
  const round = async (kind, day, gvi, mention) => {
    minute += 1;
    const id = `r-${kind}-${day}`;
    const at = new Date(Date.parse(`${day}T02:00:00Z`) + minute * 60_000).toISOString();
    await database.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, status, planned, done, sample_date, finished_at)
      VALUES ($1, $2, $3, $4, 'done', 10, 10, $5::date, $6)`, [id, userId, project.id, kind, day, at]);
    for (const [metricId, value, scope, engine] of /** @type {const} */ ([["M-19", gvi, "project", null], ["M-01S", mention, "project", null],
      ["M-01", mention, "engine", "deepseek"]])) {
      await database.query(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, round_id, scope, engine, metric_id, status, value, numerator,
          denominator, computed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ok', $8, 30, 100, $9)`,
      [`m-${id}-${metricId}-${scope}`, userId, project.id, id, scope, engine, metricId, value, at]);
    }
  };
  await round("baseline", "2026-09-20", 30, 18);
  await round("weekly", "2026-09-28", 35, 22);
  // Later, and therefore "latest" by time: slivers of the question set.
  await round("sentinel", "2026-09-29", 90, 90);
  await round("post_publication", "2026-09-30", 95, 95);
  await round("confirm", "2026-10-01", 97, 97);
  await round("noise", "2026-10-02", 99, 99);
  const user = { id: userId };

  const listed = (await service.listProjects(user)).projects[0];
  assert.equal(listed.headline.gvi.value, 35, "the headline is the latest full measurement");
  assert.deepEqual(listed.headline.gvi.trend, [30, 35]);
  assert.equal(listed.headline.mention.value, 22);

  const view = await service.projectView(user, project.id);
  const blocks = Object.fromEntries(view.overview.metrics.map((entry) => [entry.key, entry]));
  assert.equal(blocks.gvi.cell.value, 35);
  assert.equal(blocks.mention.cell.value, 22);
  assert.deepEqual(blocks.gvi.trend.map((point) => [point.date, point.value]), [["2026-09-20", 30], ["2026-09-28", 35]]);

  const monitoring = await service.monitoring(user, project.id);
  assert.deepEqual(monitoring.series.find((series) => series.key === "gvi")?.points.map((point) => point.value), [30, 35]);
  assert.deepEqual(monitoring.byEngine.find((line) => line.engine === "deepseek")?.points.map((point) => point.value), [18, 22],
    "an engine's line is drawn from full measurements too");
});
