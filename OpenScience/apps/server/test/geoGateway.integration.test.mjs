// The runtime's GEO tools end to end against the real DDL: what a run writes
// through `/internal/geo/v1/write` is what it — and the project's pages — read
// back, answer text is cut at 4,000 characters, and a read pages at 50.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GEO_GATEWAY_PATH, createGeoGatewayHandler } from "../src/geoGateway.mjs";
import { GEO_ANSWER_TEXT_LIMIT, GeoService } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const run = randomBytes(4).toString("hex");
const USER = `runtime-${run}`;
const PROJECT = `p-gw-${run}`;
const config = { geoEnabled: true, geoAudience: "all", operatorUsers: [], geoPreviewUsers: [], geoTimeZone: "Asia/Shanghai", geoSocialTimeoutMs: 5_000 };

/** @type {any} */
let database = null;
/** @type {http.Server | null} */
let server = null;
let base = "";
/** @type {GeoStore} */
let store;
/** @type {any} */
let project = null;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  const service = new GeoService({ store, config });
  await service.ready();
  project = await store.createProject({ userId: USER, projectId: PROJECT, engines: ["deepseek", "doubao"], coverageDays: 90 });
  const runtimeManager = { assertActiveModelGatewayToken: (/** @type {string} */ token) => {
    if (token !== "runtime-token") throw new Error("inactive");
    return { userId: USER, projectId: PROJECT };
  } };
  const handler = createGeoGatewayHandler(config, runtimeManager, { geo: { store, service, social: null } });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server?.listen(0, "127.0.0.1", () => resolve(undefined)));
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server?.close(() => resolve(undefined)));
  if (database) await database.close();
});

/** @param {string} operation @param {unknown} body */
async function call(operation, body) {
  const response = await fetch(`${base}${GEO_GATEWAY_PATH}/${operation}`, {
    method: "POST", headers: { authorization: "Bearer runtime-token", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("what a run writes through the gateway is what it reads back, in the pages' shapes", options, async () => {
  const claims = await call("write", { what: "claims", items: [
    { claimKey: "dose", statement: "每周一次", quote: "每周一次皮下注射。", sourceRef: "说明书", sourceKind: "label" },
    { claimKey: "bad", statement: "s" },
  ] });
  assert.equal(claims.status, 200);
  assert.deepEqual([claims.body.data.ok, claims.body.data.ids.length, claims.body.data.issues.length], [true, 1, 2]);
  const read = await call("read", { what: "claims" });
  assert.deepEqual(read.body.data.claims.map((/** @type {any} */ claim) => claim.statement), ["每周一次"]);
  assert.equal(read.body.data.what, "claims");

  const groups = ["P1", "P2", "P3", "P4"].map((pool) => ({ pool, name: `${pool} 群`, questions: [{ text: `${pool} 问`, isMeasured: true }] }));
  const map = await call("write", { what: "questions", data: { groups } });
  assert.equal(map.body.data.version, 1);
  const pool = await call("read", { what: "questions", filter: { pool: "P3" } });
  assert.deepEqual(pool.body.data.groups.map((/** @type {any} */ group) => group.name), ["P3 群"]);
  const page = await call("read", { what: "project" });
  assert.deepEqual(Object.keys(page.body.data).sort(), ["overview", "project", "what"]);
  assert.equal(page.body.data.project.id, project.id);
});

test("answer text is cut at 4,000 characters, and a long list pages at fifty", options, async () => {
  const roundId = `r-${run}`;
  await database.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, status) VALUES ($1, $2, $3, 'baseline', 'done')`,
    [roundId, USER, project.id]);
  const long = "长".repeat(GEO_ANSWER_TEXT_LIMIT + 500);
  await database.query(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, engine, asked_at, status, answer_text)
    VALUES ($1, $2, $3, $4, 'deepseek', now(), 'valid', $5)`, [`s-${run}`, USER, roundId, project.id, long]);
  const snapshots = await call("read", { what: "snapshots", filter: { round: roundId } });
  const [item] = snapshots.body.data.items;
  assert.equal(item.answerText.length, GEO_ANSWER_TEXT_LIMIT);
  assert.equal(item.answerTruncated, true);
  assert.equal(item.facts, null, "no facts row yet reads as none, not as zeros");

  const values = [];
  for (let index = 0; index < 60; index += 1) {
    values.push(`('m-${run}-${index}', '${USER}', '${project.id}', '${roundId}', 'engine', 'deepseek', 'M-${String(index).padStart(2, "0")}', 'ok')`);
  }
  await database.query(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, round_id, scope, engine, metric_id, status) VALUES ${values.join(", ")}`);
  const first = await call("read", { what: "metrics", filter: { round: roundId, limit: 50 } });
  assert.equal(first.body.data.items.length, 50);
  assert.equal(first.body.data.more, true);
  const second = await call("read", { what: "metrics", filter: { round: roundId, limit: 50, offset: 50 } });
  assert.equal(second.body.data.items.length, 10);
  assert.equal(second.body.data.more, false);
  assert.deepEqual(Object.keys(first.body.data.items[0]).sort(), ["arm", "cell", "computedAt", "engine", "groupId", "metricId", "name", "pool", "rival",
    "roundId", "scope", "variant"]);
  const unknownRound = await call("read", { what: "diagnosis", filter: { round: `r-nope-${run}` } });
  assert.deepEqual([unknownRound.status, unknownRound.body.code], [400, "geo_read_filter_invalid"]);
});
