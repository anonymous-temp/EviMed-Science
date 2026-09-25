// The 循证 GEO schema against a real PostgreSQL: every table of the build spec
// created once and again as a no-op, the constraints other packages rely on,
// and the two deletion paths — content and measurements go with a project or
// an account, money stays, and so do the screenshots another snapshot still
// shows — and every read held to the statement timeout.
//
// Its own database (test/helpers/geoTestDatabase.mjs): it drops the schema and
// counts across it, which no suite sharing a database may do.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GEO_SCHEMA, GEO_TABLES, migrateGeo } from "../src/geoPersistence.mjs";
import { geoScreenshotFile } from "../src/geoScreenshots.mjs";
import { GeoStore, deleteGeoProjectRows, deleteGeoUserRows, removeGeoScreenshotFiles } from "../src/geoStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase[]} */
const opened = [];
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
const open = () => {
  const database = new ControlPlaneDatabase({ databaseUrl: isolated?.url ?? databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  opened.push(database);
  return database;
};

before(async () => {
  if (databaseUrl) isolated = await createGeoTestDatabase(databaseUrl, "geopersist");
});

/** Every table, column, index and constraint of the schema, as PostgreSQL holds them. @param {any} database */
async function inventory(database) {
  const tables = await database.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [GEO_SCHEMA]);
  const columns = await database.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = $1 ORDER BY 1, 2`, [GEO_SCHEMA]);
  const indexes = await database.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY 1`, [GEO_SCHEMA]);
  const constraints = await database.query(`SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 ORDER BY 1`, [GEO_SCHEMA]);
  return { tables: tables.rows.map((row) => row.table_name), columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows };
}

const SHARED = "5".repeat(64);
const ONLY_MINE = "6".repeat(64);
const run = randomBytes(4).toString("hex");
/** A name unique to this run. @param {string} name */
const own = (name) => `${name}-${run}`;

after(async () => {
  for (const database of opened) await database.close();
  await isolated?.drop();
});

test("the migration creates every table of the build spec and a second run changes nothing", options, async () => {
  const first = open();
  const result = await migrateGeo(first);
  assert.deepEqual(result.tables, GEO_TABLES);
  const created = await inventory(first);
  assert.equal(created.tables.length, 25, created.tables.join());
  assert.deepEqual([...created.tables].sort(), [...GEO_TABLES].sort());
  // The columns other packages code against, spot-checked per side.
  const has = (/** @type {string} */ table, /** @type {string} */ column) => created.columns.some((row) => row.table_name === table && row.column_name === column);
  for (const [table, column] of [["projects", "steps"], ["projects", "budget"], ["claims", "elements"], ["question_sets", "locked_at"],
    ["questions", "is_measured"], ["rounds", "surface"], ["probe_jobs", "lease_until"], ["snapshots", "screenshot_sha256"], ["facts", "failure_mode"],
    ["errors", "cited_source"], ["metrics", "ci_high"], ["strategy", "layout"], ["targets", "budget_cny"], ["sources", "market"],
    ["articles", "protected_sha256"], ["media", "price_history"], ["media_outcomes", "cited"], ["orders", "vendor_order_nid"],
    ["order_events", "to_state"], ["ledger", "amount_cny"], ["topups", "balance_after"], ["reconciliations", "diff"],
    ["journeys", "data"], ["placement_plans", "data"],
    // The metrics package's additions: M-11/M-12's extractions, and a cell's variant, rival and reason.
    ["facts", "red_flag_expected"], ["facts", "red_flag_hits"], ["facts", "safety_terms_hit"],
    ["metrics", "variant"], ["metrics", "rival"], ["metrics", "reason"]]) {
    assert.ok(has(table, column), `${table}.${column} is missing`);
  }
  // Every tenant table carries a user id; the platform's own do not.
  for (const table of GEO_TABLES) {
    const platform = ["media", "media_outcomes", "order_events", "topups", "reconciliations"].includes(table);
    assert.equal(has(table, "user_id"), !platform, `${table}: user_id`);
  }
  assert.ok(created.indexes.some((row) => row.indexname === "geo_metrics_lookup_idx" && /geo_project_id, metric_id, computed_at/.test(row.indexdef)));

  // A second process — a new database object, so no cache answers — finds nothing to do.
  const second = open();
  await migrateGeo(second);
  assert.deepEqual(await inventory(second), created);
  // And the same object answers from its cache.
  assert.equal(await migrateGeo(first), result);
});

test("a GEO project is one per control-plane project per account, and two accounts may name theirs alike", options, async () => {
  const database = open();
  const store = new GeoStore({ database });
  const one = await store.createProject({ userId: own("alice"), projectId: "wegovy", engines: ["deepseek"], coverageDays: 90 });
  const other = await store.createProject({ userId: own("bob"), projectId: "wegovy", engines: ["deepseek"], coverageDays: 90 });
  assert.notEqual(one.id, other.id);
  await assert.rejects(store.createProject({ userId: own("alice"), projectId: "wegovy", engines: ["deepseek"], coverageDays: 90 }), { code: "23505" });
  assert.equal((await store.projectByControlProject(own("alice"), "wegovy"))?.id, one.id);
  assert.equal(await store.getProject(own("bob"), one.id), null, "another account's project is not found");
  // Defaults are the spec's: tier 2, active, all eight steps none.
  assert.equal(one.tier, "2");
  assert.equal(one.status, "active");
  assert.deepEqual(Object.values(one.steps).map((step) => step.status), Array(8).fill("none"));
});

test("closed vocabularies are CHECKed where the spec closes them", options, async () => {
  const database = open();
  const store = new GeoStore({ database });
  const carol = own("carol");
  const project = await store.createProject({ userId: carol, projectId: "checks", engines: ["kimi"], coverageDays: 30 });
  const refused = async (/** @type {string} */ sql, /** @type {unknown[]} */ values) => {
    await assert.rejects(database.query(sql, values), { code: "23514" }, sql);
  };
  await refused(`UPDATE evimed_geo.projects SET tier = '4' WHERE id = $1`, [project.id]);
  await refused(`UPDATE evimed_geo.projects SET status = 'gone' WHERE id = $1`, [project.id]);
  await refused(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind) VALUES ($2, $3, $1, 'hourly')`, [project.id, own("r-x"), carol]);
  await refused(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, scope, metric_id, status) VALUES ($2, $3, $1, 'project', 'M-01', 'zero')`,
    [project.id, own("m-x"), carol]);
  await refused(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, scope, metric_id, status, data_type)
    VALUES ($2, $3, $1, 'project', 'M-01', 'ok', 'guessed')`, [project.id, own("m-y"), carol]);
  await refused(`INSERT INTO evimed_geo.errors (id, user_id, geo_project_id, fingerprint, engine, severity) VALUES ($2, $3, $1, 'f', 'kimi', 'S9')`,
    [project.id, own("e-x"), carol]);
  await refused(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, state) VALUES ($2, $3, $1, 'teleported')`, [project.id, own("o-x"), carol]);
  await refused(`INSERT INTO evimed_geo.ledger (id, kind, amount_cny) VALUES ($1, 'gift', 1)`, [own("l-x")]);
  // A round's surface defaults to the spec's web / not deep / new chat.
  const roundId = own("r-ok");
  await database.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind) VALUES ($2, $3, $1, 'baseline')`, [project.id, roundId, carol]);
  const round = (await database.query(`SELECT surface, status, planned FROM evimed_geo.rounds WHERE id = $1`, [roundId])).rows[0];
  assert.deepEqual(round.surface, { mode: "web", deep: false, newChat: true, city: null });
  assert.equal(round.status, "queued");
  // One probe job per round × question × engine × repeat.
  await database.query(`INSERT INTO evimed_geo.probe_jobs (id, user_id, round_id, geo_project_id, question_id, engine) VALUES ($2, $3, $4, $1, 'q1', 'kimi')`,
    [project.id, own("j1"), carol, roundId]);
  await assert.rejects(database.query(`INSERT INTO evimed_geo.probe_jobs (id, user_id, round_id, geo_project_id, question_id, engine)
    VALUES ($2, $3, $4, $1, 'q1', 'kimi')`, [project.id, own("j2"), carol, roundId]), { code: "23505" });
});

test("deleting a project takes its content and measurements, keeps its money, and touches no one else's", options, async () => {
  const database = open();
  const store = new GeoStore({ database });
  const mine = await store.createProject({ userId: own("dave"), projectId: "p-del", engines: ["deepseek"], coverageDays: 90 });
  const theirs = await store.createProject({ userId: own("erin"), projectId: "p-del", engines: ["deepseek"], coverageDays: 90 });
  for (const project of [mine, theirs]) {
    await store.upsertClaims(project.userId, project.id, [{ claimKey: "c1", statement: "s", quote: "q", sourceRef: "label" }]);
    await store.writeQuestionSet(project.userId, project.id, { groups: [{ pool: "P1", name: "g", questions: [{ text: "问", isMeasured: true }] }] });
    await database.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind) VALUES ($1, $2, $3, 'baseline')`, [`r-${project.id}`, project.userId, project.id]);
    await database.query(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, status, screenshot_sha256)
      VALUES ($1, $2, $3, $4, 'valid', $5)`, [`s-${project.id}`, project.userId, `r-${project.id}`, project.id, SHARED]);
    await database.query(`INSERT INTO evimed_geo.facts (snapshot_id, user_id, geo_project_id, failure_mode) VALUES ($1, $2, $3, 'omitted')`,
      [`s-${project.id}`, project.userId, project.id]);
    await database.query(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, state) VALUES ($1, $2, $3, 'settled')`, [`o-${project.id}`, project.userId, project.id]);
    await database.query(`INSERT INTO evimed_geo.order_events (id, order_id, from_state, to_state) VALUES ($1, $2, 'verified', 'settled')`, [`oe-${project.id}`, `o-${project.id}`]);
    await database.query(`INSERT INTO evimed_geo.ledger (id, user_id, geo_project_id, order_id, kind, amount_cny) VALUES ($1, $2, $3, $4, 'settle', 88.5)`,
      [`l-${project.id}`, project.userId, project.id, `o-${project.id}`]);
  }
  // One more answer of mine with a screenshot only it shows.
  await database.query(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, status, screenshot_sha256)
    VALUES ($1, $2, $3, $4, 'valid', $5)`, [`s2-${mine.id}`, mine.userId, `r-${mine.id}`, mine.id, ONLY_MINE]);
  const count = async (/** @type {string} */ table, /** @type {string} */ id) =>
    Number((await database.query(`SELECT count(*)::integer AS n FROM evimed_geo.${table} WHERE geo_project_id = $1`, [id])).rows[0].n);
  const removed = await database.transaction((client) => deleteGeoProjectRows(client, own("dave"), "p-del"));
  assert.deepEqual(removed, { projects: 1, screenshots: [ONLY_MINE] }, "the shared screenshot is still another snapshot's");
  assert.equal(await store.getProject(own("dave"), mine.id), null);
  for (const table of ["claims", "question_sets", "question_groups", "questions", "rounds", "snapshots", "facts"]) {
    assert.equal(await count(table, mine.id), 0, `${table} kept a deleted project's row`);
    assert.equal(await count(table, theirs.id), 1, `${table} lost another account's row`);
  }
  assert.equal(await count("orders", mine.id), 1, "an order is money and outlives its project");
  assert.equal(await count("ledger", mine.id), 1, "a ledger row outlives its project");
  assert.equal((await database.query(`SELECT count(*)::integer AS n FROM evimed_geo.order_events WHERE order_id = $1`, [`o-${mine.id}`])).rows[0].n, 1);
  assert.ok(await store.getProject(own("erin"), theirs.id));

  // Deleting an account takes every GEO row of it, money excepted — and the screenshot it was the last to show.
  assert.deepEqual(await database.transaction((client) => deleteGeoUserRows(client, own("erin"))), { projects: 1, screenshots: [SHARED] });
  assert.equal(await store.getProject(own("erin"), theirs.id), null);
  assert.equal(await count("claims", theirs.id), 0);
  assert.equal(await count("orders", theirs.id), 1);
});

test("a database that never ran the module deletes projects exactly as before", options, async () => {
  const database = open();
  // The schema's absence, seen from inside a transaction that is rolled back:
  // the other test files sharing this database never see it gone.
  const rollback = new Error("rollback");
  await assert.rejects(database.transaction(async (client) => {
    await client.query(`DROP SCHEMA IF EXISTS ${GEO_SCHEMA} CASCADE`);
    assert.deepEqual(await deleteGeoProjectRows(client, "anyone", "any"), { projects: 0, screenshots: [] });
    assert.deepEqual(await deleteGeoUserRows(client, "anyone"), { projects: 0, screenshots: [] });
    throw rollback;
  }), (error) => error === rollback);
  assert.deepEqual(await deleteGeoProjectRows(null, "anyone", "any"), { projects: 0, screenshots: [] }, "a file store has no client and no rows");
  assert.equal((await database.query(`SELECT to_regclass('evimed_geo.projects') IS NOT NULL AS present`)).rows[0].present, true);
});

test("an orphaned screenshot file is removed from disk; a missing one is no error", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "geo-screenshots-"));
  try {
    const kept = "7".repeat(64);
    for (const sha of [ONLY_MINE, kept]) {
      await mkdir(path.dirname(geoScreenshotFile(dataDir, sha)), { recursive: true });
      await writeFile(geoScreenshotFile(dataDir, sha), "png");
    }
    const reports = /** @type {string[]} */ ([]);
    assert.equal(await removeGeoScreenshotFiles(dataDir, [ONLY_MINE, SHARED], (code) => reports.push(code)), 2);
    await assert.rejects(stat(geoScreenshotFile(dataDir, ONLY_MINE)), { code: "ENOENT" });
    assert.ok(await stat(geoScreenshotFile(dataDir, kept)), "a screenshot not named is left alone");
    assert.deepEqual(reports, []);
    assert.equal(await removeGeoScreenshotFiles(dataDir, ["not-a-sha"], (code) => reports.push(code)), 0);
    assert.equal(reports.length, 1, "a name that is not a sha256 is reported, never turned into a path");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("every GEO read runs under the store's statement timeout", options, async () => {
  const database = open();
  const store = new GeoStore({ database, statementTimeoutMs: 200 });
  await store.ready();
  const started = Date.now();
  await assert.rejects(store.query("SELECT pg_sleep(3)"), { code: "57014" }, "a read that outlives the timeout is cancelled");
  assert.ok(Date.now() - started < 2_500);
  assert.deepEqual((await store.query("SELECT 1 AS one")).rows, [{ one: 1 }]);
  assert.throws(() => new GeoStore({ database, statementTimeoutMs: 0 }), TypeError);
});
