// The social collector's job ledger against a real PostgreSQL: an accepted job's id is readable by the user and project that started it
// and by no one else, a repeat is one row, a day-old row is gone, and the project's and the account's deletion take the rows with them
// (even for a project that is no GEO project: the social search answers in any conversation).
//
// Its own database (test/helpers/geoTestDatabase.mjs): it drops the schema inside a rolled-back transaction.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createSocialCrawlClient } from "../src/socialCrawlClient.mjs";
import { migrateGeo } from "../src/geoPersistence.mjs";
import { SOCIAL_JOB_RETENTION_MS, createSocialJobLedger } from "../src/geoSocialJobs.mjs";
import { GeoStore, deleteGeoProjectRows, deleteGeoUserRows } from "../src/geoStore.mjs";
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
before(async () => { if (databaseUrl) isolated = await createGeoTestDatabase(databaseUrl, "socialjobs"); });
after(async () => {
  for (const database of opened) await database.close();
  await isolated?.drop();
});

const run = randomBytes(4).toString("hex");
const own = (/** @type {string} */ name) => `${name}-${run}`;
const JOB = "a".repeat(32), OTHER_JOB = "b".repeat(32);
const entry = (/** @type {string} */ userId, /** @type {string} */ projectId, jobId = JOB) =>
  ({ scope: { userId, projectId }, jobId, query: "二甲双胍", platforms: ["xhs", "zhihu"], sort: "latest", limit: 7 });
const rowsOf = async (/** @type {any} */ database, /** @type {string} */ userId) =>
  Number((await database.query(`SELECT count(*)::integer AS n FROM evimed_geo.social_jobs WHERE user_id = $1`, [userId])).rows[0].n);

test("an accepted job is found by its user and project and by no one else, with the request it was started with", options, async () => {
  const database = open();
  const store = new GeoStore({ database });
  const ledger = createSocialJobLedger({ store });
  const alice = own("alice"), bob = own("bob");
  await ledger.record(entry(alice, "p1"));
  assert.deepEqual(await ledger.find({ userId: alice, projectId: "p1" }, JOB), { jobId: JOB, query: "二甲双胍", platforms: ["xhs", "zhihu"], sort: "latest", limit: 7 });
  assert.equal(await ledger.find({ userId: alice, projectId: "p2" }, JOB), null, "another project of the same person");
  assert.equal(await ledger.find({ userId: bob, projectId: "p1" }, JOB), null, "another person's project of the same id");
  assert.equal(await ledger.find({ userId: alice, projectId: "p1" }, OTHER_JOB), null, "a job nobody recorded");
  // A repeat of the same search is the same job: one row, the record kept as it was.
  await ledger.record({ ...entry(alice, "p1"), query: "changed" });
  assert.equal(await rowsOf(database, alice), 1);
  assert.equal((await ledger.find({ userId: alice, projectId: "p1" }, JOB))?.query, "二甲双胍");
  // The table is the schema's: migrated with the rest, listed with the rest.
  assert.ok((await migrateGeo(database)).tables.includes("social_jobs"));
});

test("a job older than a day is neither found nor kept", options, async () => {
  const database = open();
  const store = new GeoStore({ database });
  let at = Date.parse("2026-10-27T00:00:00Z");
  const ledger = createSocialJobLedger({ store, now: () => new Date(at) });
  const carol = own("carol");
  await ledger.record(entry(carol, "p1"));
  at += SOCIAL_JOB_RETENTION_MS - 1_000;
  assert.ok(await ledger.find({ userId: carol, projectId: "p1" }, JOB), "inside the day");
  at += 2_000;
  assert.equal(await ledger.find({ userId: carol, projectId: "p1" }, JOB), null, "past it");
  assert.equal(await rowsOf(database, carol), 1, "found no more, still stored until the next write");
  await ledger.record(entry(own("dave"), "p9", OTHER_JOB));
  assert.equal(await rowsOf(database, carol), 0, "the next write drops what aged out");
});

test("the project's deletion and the account's deletion take the job ids, whether or not a GEO project exists", options, async () => {
  const database = open();
  const store = new GeoStore({ database });
  const ledger = createSocialJobLedger({ store });
  const erin = own("erin"), frank = own("frank");
  await ledger.record(entry(erin, "no-geo-project"));
  await ledger.record(entry(erin, "kept", OTHER_JOB));
  await ledger.record(entry(frank, "no-geo-project"));
  assert.deepEqual(await database.transaction((client) => deleteGeoProjectRows(client, erin, "no-geo-project")), { projects: 0, screenshots: [] });
  assert.equal(await ledger.find({ userId: erin, projectId: "no-geo-project" }, JOB), null);
  assert.ok(await ledger.find({ userId: erin, projectId: "kept" }, OTHER_JOB), "another project of the same account");
  assert.ok(await ledger.find({ userId: frank, projectId: "no-geo-project" }, JOB), "another account's project of the same id");
  await database.transaction((client) => deleteGeoUserRows(client, erin));
  assert.equal(await rowsOf(database, erin), 0);
  assert.equal(await rowsOf(database, frank), 1);
});

test("a schema made before the table existed still deletes projects and accounts", options, async () => {
  const database = open();
  await migrateGeo(database);
  const rollback = new Error("rollback");
  await assert.rejects(database.transaction(async (client) => {
    await client.query(`DROP TABLE evimed_geo.social_jobs`);
    assert.deepEqual(await deleteGeoProjectRows(client, "anyone", "any"), { projects: 0, screenshots: [] });
    assert.deepEqual(await deleteGeoUserRows(client, "anyone"), { projects: 0, screenshots: [] });
    throw rollback;
  }), (error) => error === rollback);
});

test("a search that outlives its deadline is read on through the real ledger, by its own project only", options, async () => {
  const database = open();
  const store = new GeoStore({ database });
  const QUERY = "二甲双胍", id = "c".repeat(32);
  const envelope = (/** @type {string} */ status) => ({ job_id: id, job_status: status, query: QUERY, platforms: ["xhs"],
    result: status === "done" ? { platform: "xhs", question: QUERY, meta: { collection_status: "collected" }, posts: [{ post_id: "p1", content: "饭前吃", url: "https://example.org/p1" }] } : null });
  let finished = false;
  const seen = /** @type {string[]} */ ([]);
  const client = createSocialCrawlClient({ baseUrl: "https://social.example", apiKey: "mock-social-key", timeoutMs: 20, pollIntervalMs: 50, jobs: createSocialJobLedger({ store }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetchImpl: async (url, init) => {
      seen.push(`${init?.method} ${String(url).replace("https://social.example", "")}`);
      const body = JSON.stringify(envelope(init?.method === "POST" || !finished ? "running" : "done"));
      return new Response(body, { status: init?.method === "POST" ? 202 : 200, headers: { "content-type": "application/json" } });
    } });
  const gina = { userId: own("gina"), projectId: "p1" };
  const pending = await client.search({ query: QUERY, platforms: ["xhs"], scope: gina });
  assert.deepEqual([pending.status, pending.jobId], ["pending", id]);
  await assert.rejects(client.job({ jobId: id, scope: { userId: own("hal"), projectId: "p1" } }), { code: "social_posts_job_unknown" });
  finished = true;
  const done = await client.job({ jobId: id, scope: gina });
  assert.deepEqual([done.status, done.query, done.posts.map((post) => post.postId)], ["collected", QUERY, ["p1"]]);
  assert.deepEqual(seen.filter((line) => line.startsWith("POST")).length, 1, "one submit, however often it was read");
});
