import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !databaseUrl && "local PostgreSQL required", timeout: 60_000 };
const execute = promisify(execFile);
const child = process.env.OPEN_SCIENCE_GEO_CALENDAR_TEST_CHILD;

test("measurement DATEs retain their calendar day in UTC and Asia/Shanghai", options, async (t) => {
  if (!child) {
    // Each process uses the driver's normal DATE parser in its own timezone and
    // owns a database. The integration inventory runs both cases on every CI run.
    for (const zone of ["UTC", "Asia/Shanghai"]) {
      await t.test(zone, async () => {
        const environment = { ...process.env, TZ: zone, OPEN_SCIENCE_GEO_CALENDAR_TEST_CHILD: "1" };
        delete environment.NODE_TEST_CONTEXT;
        try {
          const result = await execute(process.execPath, ["--test", fileURLToPath(import.meta.url)], {
            env: environment,
            timeout: 50_000,
          });
          assert.match(result.stdout, /calendar probe passed:/, "the child must execute its database assertions");
        } catch (error) {
          assert.fail(`${zone}: ${error.stdout ?? ""}\n${error.stderr ?? error.message}`);
        }
      });
    }
    return;
  }
  assert.ok(["UTC", "Asia/Shanghai"].includes(process.env.TZ));
  const isolated = await createGeoTestDatabase(databaseUrl, "geocalendar");
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  try {
    const store = new GeoMeasureStore(database);
    await store.ready();
    await database.query(`INSERT INTO evimed_geo.projects (id,user_id,project_id,product,competitors,engines)
      VALUES ('calendar','calendar-user','calendar-project','{}','[]',ARRAY['deepseek'])`);
    const dates = ["2024-02-29", "2025-12-31", "2026-01-01", "2026-09-01"];
    const timestamps = { createdAt: "2026-08-31T16:00:00.123Z", startedAt: "2026-08-31T16:01:00.456Z", finishedAt: "2026-08-31T16:02:00.789Z" };
    for (const [index, date] of dates.entries()) {
      const id = `dated-${index}`;
      await database.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,set_version,status,sample_date,created_at,started_at,finished_at)
        VALUES ($1,'calendar-user','calendar',$2,1,'done',$3::date,'2026-09-01T00:00:00.123+08:00','2026-09-01T00:01:00.456+08:00','2026-09-01T00:02:00.789+08:00')`,
      [id, index === 0 ? "baseline" : "weekly", date]);
      await store.writeMetrics({ roundId: id, geoProjectId: "calendar", userId: "calendar-user", computedAt: new Date(timestamps.finishedAt),
        rows: ["pilot", "control"].map(arm => ({ scope: "arm", arm, pool: "P2", metricId: "M-01", value: 25, numerator: 1, denominator: 4, status: "ok", dataType: "measured" })) });
      const round = await store.round(id);
      assert.equal(round.sampleDate, date, "round reads a calendar DATE, not a UTC instant");
      for (const [field, expected] of Object.entries(timestamps)) assert.equal(round[field], expected, `${field} retains timestamp semantics`);
    }
    await database.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,set_version,status)
      VALUES ('undated','calendar-user','calendar','baseline',2,'done')`);
    assert.equal((await store.round("undated")).sampleDate, null);
    assert.equal((await store.round("undated")).startedAt, null);
    assert.equal(await store.round("missing"), null);
    const key = { geoProjectId: "calendar", setVersion: 1 };
    const series = await store.armSeries({ ...key, metricId: "M-01", pool: "P2" });
    for (const arm of ["pilot", "control"]) assert.deepEqual(series[arm].map(point => point.date), dates);
    assert.deepEqual((await store.armRounds(key)).map(round => round.date), dates);
    assert.equal(await store.baselineDate("calendar", 1), dates[0]);
    assert.equal(await store.baselineDate("calendar", 2), null);
    assert.deepEqual(await store.armRounds({ ...key, setVersion: 2 }), []);
    assert.deepEqual(await store.armSeries({ ...key, setVersion: 2, metricId: "M-01", pool: "P2" }), { pilot: [], control: [] });
    t.diagnostic(`calendar probe passed: ${process.env.TZ}`);
  } finally {
    try { await database.close(); }
    finally { await isolated.drop(); }
  }
});
