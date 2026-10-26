// The one-time backfill of `items.timeline_at` (the 2026-10-26 rule: the source's own time) against a real PostgreSQL, and the
// proof that its SQL and `frontierTimelineAt` (the pipeline's JS) say the same thing on the same rows.
//
// Every scenario runs inside a transaction that is rolled back, so the shared test database keeps nothing of it and no other
// test file ever sees a row this one moved.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { frontierTimelineAt } from "../src/frontierPipeline.mjs";
import {
  FRONTIER_META_KEYS,
  FRONTIER_TIMELINE_RULE,
  backfillTimelineRule,
  metaNumber,
  migrateFrontier,
} from "../src/frontierPersistence.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
after(async () => { await database.close(); });

class Rollback extends Error {}
/** Run `work` in a transaction and always roll it back. @param {(client: any) => Promise<void>} work */
async function scratch(work) {
  await migrateFrontier(database, { dimension: 1024 });
  await assert.rejects(database.transaction(async (client) => { await work(client); throw new Rollback("done"); }), Rollback);
}

/**
 * One row per case: what the source said, how precisely, when we published it, and what the rule gives. The expectations are
 * written out (Beijing is UTC+8 with no daylight saving), and the JS function is held to the same ones.
 * @type {Array<{ name: string, publishedAt: string | null, precision: string, visibleAt: string, expected: string }>}
 */
const CASES = [
  { name: "instant-earlier", publishedAt: "2026-10-25T11:00:00Z", precision: "instant", visibleAt: "2026-10-25T21:59:00Z", expected: "2026-10-25T11:00:00.000Z" },
  { name: "instant-same-moment", publishedAt: "2026-10-25T11:00:00Z", precision: "instant", visibleAt: "2026-10-25T11:00:00Z", expected: "2026-10-25T11:00:00.000Z" },
  { name: "instant-a-week-earlier", publishedAt: "2026-10-18T03:00:00Z", precision: "instant", visibleAt: "2026-10-25T21:59:00Z", expected: "2026-10-18T03:00:00.000Z" },
  { name: "instant-later", publishedAt: "2026-10-26T00:00:00Z", precision: "instant", visibleAt: "2026-10-25T21:59:00Z", expected: "2026-10-25T21:59:00.000Z" },
  { name: "instant-no-date", publishedAt: null, precision: "instant", visibleAt: "2026-10-25T21:59:00Z", expected: "2026-10-25T21:59:00.000Z" },
  { name: "day-seen-on-its-day", publishedAt: "2026-10-25T00:00:00Z", precision: "day", visibleAt: "2026-10-25T10:00:00Z", expected: "2026-10-25T10:00:00.000Z" },
  { name: "day-seen-at-the-last-millisecond", publishedAt: "2026-10-25T00:00:00Z", precision: "day", visibleAt: "2026-10-25T15:59:59.999Z", expected: "2026-10-25T15:59:59.999Z" },
  { name: "day-seen-at-the-next-days-start", publishedAt: "2026-10-25T00:00:00Z", precision: "day", visibleAt: "2026-10-25T16:00:00Z", expected: "2026-10-25T15:59:59.999Z" },
  { name: "day-seen-a-day-later", publishedAt: "2026-10-25T00:00:00Z", precision: "day", visibleAt: "2026-10-26T04:00:00Z", expected: "2026-10-25T15:59:59.999Z" },
  { name: "day-seen-a-week-later", publishedAt: "2026-10-18T00:00:00Z", precision: "day", visibleAt: "2026-10-25T10:00:00Z", expected: "2026-10-18T15:59:59.999Z" },
  { name: "day-not-over-yet", publishedAt: "2026-10-26T00:00:00Z", precision: "day", visibleAt: "2026-10-25T17:00:00Z", expected: "2026-10-25T17:00:00.000Z" },
  { name: "day-ahead-of-us", publishedAt: "2026-10-30T00:00:00Z", precision: "day", visibleAt: "2026-10-25T10:00:00Z", expected: "2026-10-25T10:00:00.000Z" },
  { name: "day-across-a-year-end", publishedAt: "2026-12-31T00:00:00Z", precision: "day", visibleAt: "2027-01-05T00:00:00Z", expected: "2026-12-31T15:59:59.999Z" },
  { name: "day-no-date", publishedAt: null, precision: "day", visibleAt: "2026-10-25T10:00:00Z", expected: "2026-10-25T10:00:00.000Z" },
  { name: "inferred-with-a-date", publishedAt: "2026-10-01T00:00:00Z", precision: "inferred", visibleAt: "2026-10-25T10:00:00Z", expected: "2026-10-25T10:00:00.000Z" },
  { name: "inferred-no-date", publishedAt: null, precision: "inferred", visibleAt: "2026-10-25T10:00:00Z", expected: "2026-10-25T10:00:00.000Z" },
];

let sequence = 0;
/**
 * Insert one item the way the pipeline leaves a published one before the new rule: its timeline instant is our publication
 * instant (the old rule's answer for anything newer than 72 hours).
 * @param {any} client @param {Record<string, any>} row
 */
async function insertItem(client, { name, publishedAt, precision, visibleAt, state = "published", timelineAt = visibleAt }) {
  const tag = `tl${Date.now().toString(36)}${(sequence += 1).toString(36)}`;
  const { rows } = await client.query(`INSERT INTO evimed_frontier.items (public_id, primary_source_id, canonical_url, identity_key, title_raw, lang, lane,
      source_type, published_at, date_precision, first_seen_at, timeline_at, state, visible_at)
    VALUES ($1, 'tl-source', $2, $3, $4, 'en', 'evidence', 'journal', $5::timestamptz, $6, $7::timestamptz, $8::timestamptz, $9, $10::timestamptz)
    RETURNING id`, [`${tag}x${"a".repeat(12)}`, `https://tl.example.org/${tag}`, `tl:${tag}`, name, publishedAt, precision, visibleAt ?? timelineAt, timelineAt, state, visibleAt]);
  return String(rows[0].id);
}

/** @param {any} client */
async function seedSource(client) {
  await client.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region)
    VALUES ('tl-source', 'Timeline source', 'evidence', 'journal', 'crossref-issn', 'api', 3, false, 'tl-owner', 'P0', 'US') ON CONFLICT (id) DO NOTHING`);
}

/** @param {any} client @param {string} id */
const timelineOf = async (client, id) => new Date((await client.query("SELECT timeline_at FROM evimed_frontier.items WHERE id = $1", [id])).rows[0].timeline_at).toISOString();
/** @param {any} client @param {string} key */
const metaOf = async (client, key) => (await client.query("SELECT value FROM evimed_frontier.meta WHERE key = $1", [key])).rows[0]?.value;

test("the JS rule gives the expected instant on every case", () => {
  for (const row of CASES) {
    assert.equal(frontierTimelineAt(new Date(row.visibleAt), row.publishedAt, row.precision).toISOString(), row.expected, row.name);
  }
});

test("the backfill writes the same instants as the JS rule, leaves what is not a published item with a visible instant alone, and bumps the content version once", options, async () => {
  await scratch(async (client) => {
    await seedSource(client);
    const ids = new Map();
    for (const row of CASES) ids.set(row.name, await insertItem(client, row));
    // Not published: never moved. Published with no visible instant: nothing to compute from, never moved.
    const scored = await insertItem(client, { name: "scored", publishedAt: "2026-10-18T00:00:00Z", precision: "day", visibleAt: "2026-10-25T10:00:00Z", state: "scored", timelineAt: "2026-10-24T01:00:00Z" });
    const noVisible = await insertItem(client, { name: "no-visible", publishedAt: "2026-10-18T00:00:00Z", precision: "day", visibleAt: null, timelineAt: "2026-10-24T02:00:00Z" });
    await client.query("DELETE FROM evimed_frontier.meta WHERE key = $1", [FRONTIER_META_KEYS.timelineRule]);
    const before = metaNumber(await metaOf(client, FRONTIER_META_KEYS.contentVersion));

    await backfillTimelineRule(client);

    for (const row of CASES) {
      const got = await timelineOf(client, /** @type {string} */ (ids.get(row.name)));
      assert.equal(got, row.expected, `SQL: ${row.name}`);
      assert.equal(got, frontierTimelineAt(new Date(row.visibleAt), row.publishedAt, row.precision).toISOString(), `SQL equals JS: ${row.name}`);
    }
    assert.equal(await timelineOf(client, scored), "2026-10-24T01:00:00.000Z", "a scored item is not published");
    assert.equal(await timelineOf(client, noVisible), "2026-10-24T02:00:00.000Z", "no visible instant, nothing to compute from");
    assert.equal(metaNumber(await metaOf(client, FRONTIER_META_KEYS.timelineRule)), FRONTIER_TIMELINE_RULE);
    assert.equal(metaNumber(await metaOf(client, FRONTIER_META_KEYS.contentVersion)), before + 1, "the content version moved once");

    // A second run finds the key and does nothing, even where a value would now differ.
    await client.query("UPDATE evimed_frontier.items SET timeline_at = $2::timestamptz WHERE id = $1", [ids.get("instant-earlier"), "2026-10-01T00:00:00Z"]);
    await backfillTimelineRule(client);
    assert.equal(await timelineOf(client, /** @type {string} */ (ids.get("instant-earlier"))), "2026-10-01T00:00:00.000Z", "the second run did not touch it");
    assert.equal(metaNumber(await metaOf(client, FRONTIER_META_KEYS.contentVersion)), before + 1, "and did not move the version");
  });
});

test("a database the rule already ran on, or one with no published item, keeps its content version", options, async () => {
  await scratch(async (client) => {
    await seedSource(client);
    // Inside this transaction no item is published, which is an empty feed to the migration.
    await client.query("UPDATE evimed_frontier.items SET state = 'withdrawn' WHERE state = 'published'");
    await client.query("DELETE FROM evimed_frontier.meta WHERE key = $1", [FRONTIER_META_KEYS.timelineRule]);
    const before = metaNumber(await metaOf(client, FRONTIER_META_KEYS.contentVersion));
    await backfillTimelineRule(client);
    assert.equal(metaNumber(await metaOf(client, FRONTIER_META_KEYS.timelineRule)), FRONTIER_TIMELINE_RULE, "the key is stored on an empty feed");
    assert.equal(metaNumber(await metaOf(client, FRONTIER_META_KEYS.contentVersion)), before, "nothing moved, so the version did not");

    // The key says 2 and rows exist whose value the rule would change: still nothing.
    const id = await insertItem(client, { name: "late", publishedAt: "2026-10-18T03:00:00Z", precision: "instant", visibleAt: "2026-10-25T21:59:00Z" });
    await backfillTimelineRule(client);
    assert.equal(await timelineOf(client, id), "2026-10-25T21:59:00.000Z");
    assert.equal(metaNumber(await metaOf(client, FRONTIER_META_KEYS.contentVersion)), before);

    // The first rule's key (1) reads as not yet done.
    await client.query("UPDATE evimed_frontier.meta SET value = '1'::jsonb WHERE key = $1", [FRONTIER_META_KEYS.timelineRule]);
    await backfillTimelineRule(client);
    assert.equal(await timelineOf(client, id), "2026-10-18T03:00:00.000Z");
    assert.equal(metaNumber(await metaOf(client, FRONTIER_META_KEYS.contentVersion)), before + 1);
    assert.equal(metaNumber(await metaOf(client, FRONTIER_META_KEYS.timelineRule)), FRONTIER_TIMELINE_RULE);
  });
});

test("the migration runs the backfill and a second process finds the rule already stored", options, async () => {
  const first = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  const second = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  try {
    await migrateFrontier(first, { dimension: 1024 });
    const stored = metaNumber((await first.query("SELECT value FROM evimed_frontier.meta WHERE key = $1", [FRONTIER_META_KEYS.timelineRule])).rows[0]?.value);
    assert.equal(stored, FRONTIER_TIMELINE_RULE);
    const version = (await first.query("SELECT value FROM evimed_frontier.meta WHERE key = 'content_version'")).rows[0].value;
    await migrateFrontier(second, { dimension: 1024 });
    assert.deepEqual((await second.query("SELECT value FROM evimed_frontier.meta WHERE key = 'content_version'")).rows[0].value, version, "a second start moves nothing");
  } finally {
    await first.close();
    await second.close();
  }
});
