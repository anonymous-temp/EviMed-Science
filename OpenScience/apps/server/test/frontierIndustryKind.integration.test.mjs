// The kind of 行业动态 (c5-biz 2026-10-26) against a real PostgreSQL: the column and the index the list filter reads, the filter and the
// item's kind through the service, and the backfill step of scripts/ops/frontier-rewrite.mjs (the report asks nothing; --apply writes
// the answered kinds only; an unreadable answer is asked again; a second run finds nothing; a budget that ended the run says where it
// resumes).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { REFERENCE_PRICE_LIST } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { estimateRewriteCost, frontierRewrite, parseArguments } from "../../../scripts/ops/frontier-rewrite.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const reader = { id: `reader_${randomUUID().slice(0, 8)}` };
const vocabulary = frontierVocabularyView(TEST_VOCABULARY);
const NOW = new Date("2026-09-22T04:00:00Z");
const SINCE = new Date("2026-09-01T00:00:00Z");
const UNTIL = new Date("2026-09-30T00:00:00Z");

/** @type {any} */
let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Reader','development')", [reader.id]);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_control.users WHERE id = $1", [reader.id]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.item_changes");
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key IN ('content_version','plugin_cursor')");
  await insertSource(database, "novo", { name: "Novo Nordisk newsroom", lane: "pipeline", source_type: "company" });
  await insertSource(database, "nejm");
});

function serviceFor() {
  const config = { frontierEnabled: true, frontierAudience: "all", operatorUsers: [], frontierPreviewUsers: [], frontierDailyBudgetCny: 10, frontierTimeZone: "Asia/Shanghai" };
  return new FrontierService({ database, vocabulary, now: () => NOW, config });
}
/** @param {Record<string, string>} values */
const params = (values = {}) => new URLSearchParams({ view: "all", ...values });

/** @param {string} id @param {Record<string, any>} columns */
async function set(id, columns) {
  const names = Object.keys(columns);
  await database.query(`UPDATE evimed_frontier.items SET ${names.map((name, index) => `${name} = $${index + 2}`).join(", ")} WHERE id = $1`, [id, ...Object.values(columns)]);
}

/**
 * Five items: an industry item of each of two kinds, an industry item the model has not named, a paper that still carries a kind
 * from before its genre changed, and a paper.
 */
async function seed() {
  const financing = await insertItem(database, { sourceId: "novo", sourceType: "company", lane: "pipeline", evidenceType: "press-release", title: "Biotech raises 120 million", timelineAt: "2026-09-22T03:00:00Z" });
  const people = await insertItem(database, { sourceId: "novo", sourceType: "company", lane: "pipeline", evidenceType: "press-release", title: "Biotech names a new chief", timelineAt: "2026-09-22T02:50:00Z" });
  const unnamed = await insertItem(database, { sourceId: "novo", sourceType: "company", lane: "pipeline", evidenceType: "press-release", title: "Biotech opens a plant", timelineAt: "2026-09-22T02:40:00Z" });
  const stale = await insertItem(database, { title: "A cohort study", timelineAt: "2026-09-22T02:30:00Z" });
  const paper = await insertItem(database, { title: "A trial", timelineAt: "2026-09-22T02:20:00Z" });
  await set(financing.id, { genre: "industry", genre_basis: "model", industry_kind: "financing" });
  await set(people.id, { genre: "industry", genre_basis: "model", industry_kind: "people" });
  await set(unnamed.id, { genre: "industry", genre_basis: "code" });
  await set(stale.id, { genre: "paper", genre_basis: "code", industry_kind: "people" });
  await set(paper.id, { genre: "paper", genre_basis: "code" });
  return { financing, people, unnamed, stale, paper };
}

test("the column has no value but the pipeline's and the partial index is the one the filter reads", options, async () => {
  const column = (await database.query(`SELECT data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'evimed_frontier' AND table_name = 'items' AND column_name = 'industry_kind'`)).rows[0];
  assert.deepEqual([column.data_type, column.is_nullable], ["text", "YES"]);
  const index = (await database.query("SELECT indexdef FROM pg_indexes WHERE schemaname = 'evimed_frontier' AND indexname = 'frontier_items_industry_kind_idx'")).rows[0];
  assert.match(index.indexdef, /\(industry_kind, timeline_at DESC, id DESC\)/);
  assert.match(index.indexdef, /WHERE \(\(industry_kind IS NOT NULL\) AND \(state = 'published'::text\)\)/);
  // Migrating again changes nothing (idempotent: the column, the index and the kinds already written), and the filter's own predicate
  // can use the index.
  const { financing } = await seed();
  const shape = async () => ({
    columns: (await database.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'evimed_frontier' AND table_name = 'items' ORDER BY ordinal_position`)).rows,
    indexes: (await database.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'evimed_frontier' AND tablename = 'items' ORDER BY indexname")).rows,
    kinds: (await database.query("SELECT public_id, genre, industry_kind FROM evimed_frontier.items ORDER BY id")).rows,
  });
  const before = await shape();
  await migrateFrontier(database, { dimension: 1024 });
  assert.deepEqual(await shape(), before);
  assert.equal(before.kinds.find((row) => row.public_id === financing.publicId).industry_kind, "financing");
  await database.transaction(async (/** @type {any} */ client) => {
    await client.query("SET LOCAL enable_seqscan = off");
    const plan = (await client.query(`EXPLAIN SELECT i.id FROM evimed_frontier.items i WHERE i.state = 'published' AND i.genre = 'industry'
      AND i.industry_kind = 'deal' ORDER BY i.timeline_at DESC, i.id DESC LIMIT 31`)).rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(plan, /frontier_items_industry_kind_idx/);
  });
});

test("the list filter returns one kind of 行业动态, the item carries its kind and label, and a kind written before the genre changed is not served", options, async () => {
  const { financing, people, unnamed, stale, paper } = await seed();
  const service = serviceFor();
  const listed = async (/** @type {Record<string, string>} */ values) => (await service.listItems(reader, params(values))).body.items;
  const ids = async (/** @type {Record<string, string>} */ values) => (await listed(values)).map((entry) => entry.id);

  assert.deepEqual(await ids({ industryKind: "financing" }), [financing.publicId]);
  assert.deepEqual(await ids({ industryKind: "people" }), [people.publicId], "the paper that still carries 「people」 is not in it");
  assert.deepEqual(await ids({ industryKind: "deal" }), []);
  // No filter: everything, each with the kind it has - none for an unnamed industry item or a paper.
  const all = new Map((await listed({})).map((entry) => [entry.id, entry]));
  assert.equal(all.size, 5);
  assert.deepEqual([all.get(financing.publicId).industryKind, all.get(financing.publicId).industryKindLabel], ["financing", "融资与上市"]);
  assert.deepEqual([all.get(people.publicId).industryKind, all.get(people.publicId).industryKindLabel], ["people", "人事与组织"]);
  assert.deepEqual([all.get(people.publicId).genre, all.get(people.publicId).genreLabel], ["industry", "行业动态"]);
  for (const entry of [unnamed, stale, paper]) assert.deepEqual([all.get(entry.publicId).industryKind, all.get(entry.publicId).industryKindLabel], [null, null], entry.publicId);
  // Filters narrow together: a lane the item is not in leaves nothing; the lane it is in keeps it.
  assert.deepEqual(await ids({ industryKind: "financing", lane: "evidence" }), []);
  assert.deepEqual(await ids({ industryKind: "financing", lane: "pipeline" }), [financing.publicId]);
  // The reader's detail carries it as well.
  const detail = await service.getItem(reader, financing.publicId);
  assert.deepEqual([detail.body.item.industryKind, detail.body.item.industryKindLabel], ["financing", "融资与上市"]);
  // A word outside the list is a 400, never a silent default.
  await assert.rejects(service.listItems(reader, params({ industryKind: "merger" })), { code: "frontier_query_invalid" });
});

test("a kind is part of the list's identity: its own entity tag, its own cache, a cursor that is not carried across kinds", options, async () => {
  const { financing } = await seed();
  await set(financing.id, { industry_kind: "deal" });
  const second = await insertItem(database, { sourceId: "novo", sourceType: "company", lane: "pipeline", evidenceType: "press-release", title: "Biotech licenses a drug", timelineAt: "2026-09-22T02:10:00Z" });
  await set(second.id, { genre: "industry", genre_basis: "model", industry_kind: "deal" });
  const service = serviceFor();
  const deals = await service.listItems(reader, params({ industryKind: "deal", limit: "1" }));
  const people = await service.listItems(reader, params({ industryKind: "people", limit: "1" }));
  const everything = await service.listItems(reader, params({ limit: "1" }));
  assert.notEqual(deals.etag, people.etag);
  assert.notEqual(deals.etag, everything.etag);
  assert.equal((await service.listItems(reader, params({ industryKind: "deal", limit: "1" }), deals.etag)).status, 304);
  assert.equal((await service.listItems(reader, params({ industryKind: "people", limit: "1" }), deals.etag)).status, 200, "another kind's tag is no match");
  // Page two of the deals is the other deal; the same cursor under another kind is refused, as under another lane.
  assert.equal(deals.body.items.length, 1);
  assert.ok(deals.body.nextCursor);
  const next = await service.listItems(reader, params({ industryKind: "deal", limit: "1", cursor: deals.body.nextCursor }));
  assert.deepEqual([...deals.body.items, ...next.body.items].map((entry) => entry.id).sort(), [financing.publicId, second.publicId].sort());
  await assert.rejects(service.listItems(reader, params({ industryKind: "people", limit: "1", cursor: deals.body.nextCursor })), { code: "invalid_cursor" });
  await assert.rejects(service.listItems(reader, params({ limit: "1", cursor: deals.body.nextCursor })), { code: "invalid_cursor" });
});

/** An editor whose kind answers are given by title: `[kind:x]` names x, `[unknown]` a word outside the list, `[throws]` a failed call. */
function fakeEditor() {
  /** @type {string[][]} */
  const batches = [];
  return {
    batches,
    async classifyIndustryKinds(/** @type {Array<{ title: string, sourceName: string, excerpt?: string | null }>} */ items) {
      batches.push(items.map((entry) => entry.title));
      if (items.some((entry) => entry.title.includes("[throws]"))) throw Object.assign(new Error("boom"), { code: "frontier_test_boom" });
      return items.map((entry) => {
        if (entry.title.includes("[unknown]")) return null;
        return /\[kind:([a-z]+)\]/.exec(entry.title)?.[1] ?? null;
      });
    },
  };
}

test("kind (c5-biz): the report asks nothing and writes nothing; --apply writes the answered kinds of 行业动态 only, with a change row and a version bump; a second run finds only what was not answered", options, async () => {
  const { financing, people, unnamed, stale, paper } = await seed();
  const todo = [];
  for (const [title, extra] of [["Pharma licenses a drug [kind:deal]", {}], ["Pharma lists on the exchange [kind:financing]", {}], ["Pharma cuts staff [kind:operations]", {}],
    ["Pharma pipeline slips [kind:pipeline]", {}], ["Pharma names a chair [kind:people]", {}], ["Pharma does something [unknown]", {}], ["Pharma goes bankrupt [kind:merger]", {}]]) {
    const row = await insertItem(database, { sourceId: "novo", sourceType: "company", lane: "pipeline", evidenceType: "press-release", title, timelineAt: "2026-09-22T01:00:00Z", ...extra });
    await set(row.id, { genre: "industry", genre_basis: "model" });
    todo.push(row);
  }
  // A paper the model has not named a kind for is not asked, nor is an industry item that has one, nor an item outside the window.
  const old = await insertItem(database, { sourceId: "novo", sourceType: "company", title: "Old deal [kind:deal]", timelineAt: "2026-08-01T01:00:00Z", visibleAt: "2026-08-01T01:00:00Z" });
  await set(old.id, { genre: "industry", genre_basis: "model" });
  const editor = fakeEditor();

  const report = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["kind"] });
  assert.deepEqual(editor.batches, [], "the report asks nothing");
  assert.deepEqual({ ...report.kind, byKind: undefined }, { items: 8, toAsk: 8, written: 0, unreadable: 0, raced: 0, byKind: undefined });
  assert.deepEqual(report.calls, { kind: 1 });
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.items WHERE industry_kind IS NOT NULL")).rows[0].n, 3, "only the seeded kinds");
  const before = Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key = 'content_version'")).rows[0].value);

  const applied = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["kind"], apply: true });
  assert.equal(applied.failed, 0);
  assert.equal(editor.batches.length, 1, "ten items to a call");
  assert.deepEqual(editor.batches[0].length, 8);
  assert.deepEqual(applied.kind.byKind, { deal: 1, financing: 1, operations: 1, pipeline: 1, people: 1 });
  assert.deepEqual([applied.kind.written, applied.kind.unreadable, applied.kind.raced], [5, 3, 0], "the unnamed, the unknown word and 「merger」 are unreadable");
  const kinds = new Map((await database.query("SELECT id, industry_kind, genre FROM evimed_frontier.items")).rows.map((row) => [String(row.id), row]));
  assert.deepEqual(todo.map((row) => kinds.get(row.id).industry_kind), ["deal", "financing", "operations", "pipeline", "people", null, null]);
  assert.equal(kinds.get(unnamed.id).industry_kind, null, "nothing in the text of the item stands for a kind: left without one, never guessed");
  assert.equal(kinds.get(financing.id).industry_kind, "financing");
  assert.equal(kinds.get(people.id).industry_kind, "people");
  assert.equal(kinds.get(stale.id).industry_kind, "people", "an item that is not 行业动态 is not touched");
  assert.equal(kinds.get(paper.id).industry_kind, null);
  assert.equal(kinds.get(old.id).industry_kind, null, "outside the window");
  const reasons = (await database.query("SELECT item_id, reason FROM evimed_frontier.item_changes WHERE reason = 'kind' ORDER BY item_id")).rows;
  assert.deepEqual(reasons.map((row) => String(row.item_id)).sort(), todo.slice(0, 5).map((row) => row.id).sort(), "a change row for each item written, none for the rest");
  assert.ok(Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key = 'content_version'")).rows[0].value) > before, "readers' lists are read again");

  // A second run asks only about the three left without a kind; the five written are not asked again.
  const again = fakeEditor();
  const second = await frontierRewrite({ database, editor: again, threshold: 80, since: SINCE, until: UNTIL, steps: ["kind"], apply: true });
  assert.deepEqual(again.batches[0].map((title) => title.replace(/ \[.*$/, "")).sort(), ["Biotech opens a plant", "Pharma does something", "Pharma goes bankrupt"]);
  assert.deepEqual([second.kind.items, second.kind.written, second.kind.unreadable], [3, 0, 3]);
});

test("kind (c5-biz): a failed call writes nothing and is counted; a kind the pipeline wrote while the answer was being asked is not overwritten; a spent budget asks nothing and says where it resumes", options, async () => {
  const first = await insertItem(database, { sourceId: "novo", sourceType: "company", title: "A deal [kind:deal]", timelineAt: "2026-09-22T01:00:00Z" });
  const second = await insertItem(database, { sourceId: "novo", sourceType: "company", title: "A raise [kind:financing]", timelineAt: "2026-09-22T01:10:00Z" });
  for (const row of [first, second]) await set(row.id, { genre: "industry", genre_basis: "model" });

  const failing = fakeEditor();
  await database.query("UPDATE evimed_frontier.items SET title_raw = title_raw || ' [throws]' WHERE id = $1", [second.id]);
  const failed = await frontierRewrite({ database, editor: failing, threshold: 80, since: SINCE, until: UNTIL, steps: ["kind"], apply: true });
  assert.equal(failed.failed, 1, "the call failed: counted, nothing written for its items");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.items WHERE industry_kind IS NOT NULL")).rows[0].n, 0);
  await database.query("UPDATE evimed_frontier.items SET title_raw = replace(title_raw, ' [throws]', '') WHERE id = $1", [second.id]);

  // The pipeline's re-edit names the first item's kind while the answer for it is on its way.
  const racing = {
    batches: /** @type {string[][]} */ ([]),
    async classifyIndustryKinds(/** @type {Array<{ title: string }>} */ items) {
      this.batches.push(items.map((entry) => entry.title));
      await set(first.id, { industry_kind: "people" });
      return items.map(() => "deal");
    },
  };
  const raced = await frontierRewrite({ database, editor: racing, threshold: 80, since: SINCE, until: UNTIL, steps: ["kind"], apply: true });
  assert.equal(raced.failed, 0);
  assert.deepEqual([raced.kind.written, raced.kind.raced], [1, 1]);
  const kinds = new Map((await database.query("SELECT id, industry_kind FROM evimed_frontier.items")).rows.map((row) => [String(row.id), row.industry_kind]));
  assert.equal(kinds.get(first.id), "people", "the pipeline's answer stands");
  assert.equal(kinds.get(second.id), "deal");

  // A budget that is no longer ok asks nothing and says where the run resumes.
  await database.query("UPDATE evimed_frontier.items SET industry_kind = NULL");
  const stopped = fakeEditor();
  const summary = await frontierRewrite({ database, editor: stopped, budget: async () => ({ state: "exhausted" }), threshold: 80, since: SINCE, until: UNTIL, steps: ["kind"], apply: true });
  assert.deepEqual(stopped.batches, []);
  assert.equal(summary.stopped, "budget");
  assert.ok(summary.resumeFrom);
});

test("kind (c5-biz): it runs after the genre step in a run, is in the default steps, and is priced like a genre call", () => {
  assert.deepEqual(parseArguments([]).steps, ["genre", "kind", "title", "lead", "brief", "reason", "facts", "faith"]);
  assert.deepEqual(parseArguments(["--steps", "title,kind,genre"]).steps, ["genre", "kind", "title"], "kind follows genre");
  assert.deepEqual(parseArguments(["--steps", "kind", "--days", "7"]).steps, ["kind"]);
  const price = REFERENCE_PRICE_LIST.model["deepseek-flash"];
  // Ten items to a call: a thousand items are a hundred calls.
  const thousand = estimateRewriteCost({ kind: 100 }, price);
  assert.ok(thousand.cny > 0.05 && thousand.cny < 1, `a thousand items cost well under a yuan: ${thousand.cny}`);
  assert.ok(thousand.cny <= estimateRewriteCost({ genre: 100 }, price).cny, "the kind call is never dearer than the genre call");
});
