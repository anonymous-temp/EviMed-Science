// What a reader is served, against a real PostgreSQL: lists and their keyset
// cursors, ETags and 304s, the in-process cache, a reader's own state, search
// legs, the status, follows and the operator's changes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { bumpFrontierVersion, migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const reader = { id: `reader_${randomUUID().slice(0, 8)}` };
const other = { id: `other_${randomUUID().slice(0, 8)}` };
const operator = { id: `operator_${randomUUID().slice(0, 8)}` };
const vocabulary = frontierVocabularyView(TEST_VOCABULARY);
const NOW = new Date("2026-09-22T04:00:00Z");

let database;
let capabilities;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  capabilities = await migrateFrontier(database, { dimension: 1024 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Reader','development'),($2,'Other','development'),($3,'Operator','development')",
    [reader.id, other.id, operator.id]);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [[reader.id, other.id, operator.id]]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await database.query("DELETE FROM evimed_frontier.user_follows");
  await database.query("DELETE FROM evimed_frontier.user_prefs");
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key IN ('content_version','plugin_cursor')");
  await insertSource(database, "nejm");
  await insertSource(database, "lancet", { name: "The Lancet" });
  await insertSource(database, "fda", { lane: "regulatory", source_type: "regulator" });
});

/** @param {Record<string, any>} [overrides] */
function serviceFor({ config: configOverrides = {}, ...overrides } = {}) {
  const config = { frontierEnabled: true, frontierAudience: "all", operatorUsers: [operator.id], frontierPreviewUsers: [],
    frontierDailyBudgetCny: 10, frontierTimeZone: "Asia/Shanghai", ...configOverrides };
  return new FrontierService({ database, vocabulary, now: () => NOW, ...overrides, config });
}

/** @param {Record<string, string>} values */
const params = (values = {}) => new URLSearchParams(values);

test("the selected view lists selected, published items of enabled sources, newest first, with the card's fields", options, async () => {
  const selected = await insertItem(database, { selected: true, selectedRule: "threshold", timelineAt: "2026-09-22T03:00:00Z",
    title: "SGLT2 in heart failure", titleZh: "SGLT2 抑制剂用于心衰", summaryZh: "导读", reasonZh: "理由", specialties: ["cardiology", "bogus"],
    flags: ["preprint", "unknown-flag"], entities: { drugs: ["dapagliflozin"], trials: [], orgs: [], diseases: ["heart failure"] },
    openAccess: "gold", oaPdfUrl: "https://example.org/a.pdf", scores: { authority: 30, impact: 15, novelty: 3, relevance: null },
    mentions: [{ sourceId: "lancet", url: "https://lancet.example.org/1", publishedAt: "2026-09-22T02:00:00Z" },
      { sourceId: "nejm", url: "https://nejm.example.org/dup" }] });
  await insertItem(database, { selected: true, timelineAt: "2026-09-21T03:00:00Z", title: "Older selected" });
  await insertItem(database, { selected: false, timelineAt: "2026-09-22T03:30:00Z", title: "Not selected" });
  await insertItem(database, { selected: true, state: "withdrawn", title: "Withdrawn" });
  await insertItem(database, { selected: true, sourceId: "fda", title: "From a disabled source" });
  await database.query("UPDATE evimed_frontier.sources SET enabled=false WHERE id='fda'");

  const service = serviceFor();
  const answer = await service.listItems(reader, params());
  assert.equal(answer.status, 200);
  assert.match(answer.etag, /^W\/"0\.0\.[a-f0-9]{16}"$/);
  assert.equal(answer.body.mode, "list");
  assert.equal(answer.body.version, "0");
  assert.deepEqual(answer.body.items.map((item) => item.titleRaw), ["SGLT2 in heart failure", "Older selected"]);
  const card = answer.body.items[0];
  assert.equal(card.id, selected.publicId);
  assert.equal(card.title, "SGLT2 抑制剂用于心衰");
  assert.equal(card.laneLabel, "临床证据");
  assert.equal(card.sourceTypeLabel, "期刊");
  assert.equal(card.evidenceTypeLabel, "RCT");
  assert.deepEqual(card.specialties, [{ key: "cardiology", label: "心血管" }], "an unknown specialty never reaches a card");
  assert.deepEqual(card.flags, [{ key: "preprint", label: "未经同行评议" }]);
  assert.deepEqual(card.levels, { authority: "high", impact: "medium", novelty: "low", relevance: null });
  assert.deepEqual([card.score, card.scoreBand], [null, null], "an item not scored in full has no total to show");
  assert.equal(/"score(Authority|Impact|Novelty|Relevance|s)"|"scoreTotal"/.test(JSON.stringify(card)), false, "the four dimensions stay internal");
  assert.deepEqual(card.openAccess, { status: "gold", pdfUrl: "https://example.org/a.pdf" });
  assert.deepEqual(card.alsoReportedBy, [{ sourceId: "lancet", sourceName: "The Lancet", url: "https://lancet.example.org/1" }],
    "the primary source never reports itself");
  assert.equal(card.alsoReportedCount, 1);
  assert.deepEqual(card.source, { id: "nejm", name: "NEJM Journal", homepage: "https://nejm.example.org/" });
  assert.deepEqual(card.state, { starred: false, hidden: false, read: false });
  assert.equal(card.selectedRule, "threshold");
  assert.equal(card.timelineAt, "2026-09-22T03:00:00.000Z");

  const all = await service.listItems(reader, params({ view: "all" }));
  assert.deepEqual(all.body.items.map((item) => item.titleRaw), ["Not selected", "SGLT2 in heart failure", "Older selected"]);
});

test("filters: lane, specialty, window and the published axis", options, async () => {
  await insertItem(database, { title: "Cardio today", specialties: ["cardiology"], timelineAt: "2026-09-22T02:00:00Z", publishedAt: "2026-09-20T00:00:00Z" });
  await insertItem(database, { title: "Regulatory", lane: "regulatory", sourceId: "fda", sourceType: "regulator", timelineAt: "2026-09-22T01:00:00Z", publishedAt: "2026-09-22T00:30:00Z" });
  await insertItem(database, { title: "Old", timelineAt: "2026-09-10T00:00:00Z", publishedAt: "2026-09-10T00:00:00Z" });
  await insertItem(database, { title: "Undated", timelineAt: "2026-09-21T00:00:00Z", publishedAt: null });
  const service = serviceFor();
  const titles = async (values) => (await service.listItems(reader, params({ view: "all", ...values }))).body.items.map((item) => item.titleRaw);
  assert.deepEqual(await titles({ lane: "regulatory" }), ["Regulatory"]);
  assert.deepEqual(await titles({ specialty: "cardiology" }), ["Cardio today"]);
  assert.deepEqual(await titles({ window: "24h" }), ["Cardio today", "Regulatory"]);
  assert.deepEqual(await titles({ window: "7d" }), ["Cardio today", "Regulatory", "Undated"]);
  assert.deepEqual(await titles({ by: "published" }), ["Regulatory", "Cardio today", "Old"], "the published axis has no undated item");
  for (const [name, value] of [["view", "hot"], ["by", "random"], ["lane", "mixed"], ["lane", "gossip"], ["specialty", "astrology"],
    ["window", "1y"], ["starred", "yes"], ["limit", "51"], ["limit", "0"], ["q", "x".repeat(201)]]) {
    await assert.rejects(service.listItems(reader, params({ [name]: value })), { code: "frontier_query_invalid" }, `${name}=${value}`);
  }
});

test("keyset pages cover the list once, and a cursor from another list or version is refused", options, async () => {
  for (let index = 0; index < 5; index += 1) {
    await insertItem(database, { title: `Row ${index}`, timelineAt: `2026-09-22T0${index}:00:00Z` });
  }
  const service = serviceFor();
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const answer = await service.listItems(reader, params({ view: "all", limit: "2", ...(cursor ? { cursor } : {}) }));
    seen.push(...answer.body.items.map((item) => item.titleRaw));
    cursor = answer.body.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["Row 4", "Row 3", "Row 2", "Row 1", "Row 0"]);

  const first = await service.listItems(reader, params({ view: "all", limit: "2" }));
  const next = first.body.nextCursor;
  await assert.rejects(service.listItems(reader, params({ view: "selected", limit: "2", cursor: next })), { code: "invalid_cursor" });
  await assert.rejects(service.listItems(reader, params({ view: "all", by: "published", limit: "2", cursor: next })), { code: "invalid_cursor" });
  await assert.rejects(service.listItems(reader, params({ view: "all", lane: "evidence", limit: "2", cursor: next })), { code: "invalid_cursor" });
  await assert.rejects(service.listItems(reader, params({ view: "all", limit: "2", cursor: "not-a-cursor" })), { code: "invalid_cursor" });
  await database.transaction((client) => bumpFrontierVersion(client));
  await assert.rejects(service.listItems(reader, params({ view: "all", limit: "2", cursor: next })), { code: "invalid_cursor" },
    "a list that changed under the reader sends them back to page one");
  assert.ok(service.counters.invalidCursors >= 5);
});

test("an unchanged list is a 304 without a list query; a reader's own change or new content moves the tag", options, async () => {
  const item = await insertItem(database, { selected: true, title: "Tagged" });
  const service = serviceFor();
  const first = await service.listItems(reader, params());
  const statements = [];
  const patched = [];
  const connect = database.pool.connect;
  database.pool.connect = async function recordingConnect(...args) {
    const client = await connect.apply(this, args);
    const clientQuery = client.query;
    // Every argument forwarded: the pool itself calls query with a callback.
    client.query = function recordingQuery(...queryArgs) {
      statements.push(String(queryArgs[0]?.text ?? queryArgs[0]));
      return clientQuery.apply(this, queryArgs);
    };
    patched.push(client);
    return client;
  };
  try {
    const again = await service.listItems(reader, params(), first.etag);
    assert.equal(again.status, 304);
    assert.ok(statements.length > 0, "the recorder saw the version read, so it can see a list read");
    assert.equal(statements.some((text) => /FROM evimed_frontier\.items i/.test(text)), false, "a 304 must not read the list");
  } finally {
    delete database.pool.connect;
    for (const client of patched) delete client.query;
  }
  assert.notEqual((await service.listItems(other, params())).etag, first.etag, "another account never shares a tag");
  await service.setItemState(reader, item.publicId, "star");
  const afterStar = await service.listItems(reader, params(), first.etag);
  assert.equal(afterStar.status, 200, "a star moves the reader's state version");
  await database.transaction((client) => bumpFrontierVersion(client));
  assert.equal((await service.listItems(reader, params(), afterStar.etag)).status, 200, "new content moves the content version");
  assert.equal((await service.listItems(reader, params(), `W/"x", ${afterStar.etag}`)).status, 200);
});

test("public pages come from the in-process cache until the content version moves", options, async () => {
  await insertItem(database, { selected: true, title: "Cached" });
  const service = serviceFor();
  await service.listItems(reader, params());
  await service.listItems(other, params());
  assert.equal(service.counters.cacheHits, 1, "the second reader's page came from the cache");
  await insertItem(database, { selected: true, title: "Fresh", timelineAt: "2026-09-22T03:59:00Z" });
  // Written without a version bump: the cache (rightly) does not see it.
  assert.deepEqual((await service.listItems(reader, params())).body.items.map((item) => item.titleRaw), ["Cached"]);
  await database.transaction((client) => bumpFrontierVersion(client));
  assert.deepEqual((await service.listItems(reader, params())).body.items.map((item) => item.titleRaw), ["Fresh", "Cached"]);
});

test("a reader's stars, hides and reads: hidden items leave lists unless the list is the reader's stars", options, async () => {
  const kept = await insertItem(database, { selected: true, title: "Kept", timelineAt: "2026-09-22T03:00:00Z" });
  const hidden = await insertItem(database, { selected: true, title: "Hidden", timelineAt: "2026-09-22T02:00:00Z" });
  const service = serviceFor();
  assert.deepEqual(await service.setItemState(reader, hidden.publicId, "hide"), { state: { starred: false, hidden: true, read: false } });
  assert.deepEqual(await service.setItemState(reader, hidden.publicId, "star"), { state: { starred: true, hidden: true, read: false } });
  assert.deepEqual(await service.setItemState(reader, kept.publicId, "read"), { state: { starred: false, hidden: false, read: true } });
  const listed = await service.listItems(reader, params());
  assert.deepEqual(listed.body.items.map((item) => item.titleRaw), ["Kept"]);
  assert.deepEqual(listed.body.items[0].state, { starred: false, hidden: false, read: true });
  const stars = await service.listItems(reader, params({ starred: "1" }));
  assert.deepEqual(stars.body.items.map((item) => [item.titleRaw, item.state.hidden]), [["Hidden", true]]);
  assert.deepEqual((await service.listItems(other, params())).body.items.map((item) => item.titleRaw), ["Kept", "Hidden"],
    "one reader's marks are theirs alone");
  await service.setItemState(reader, hidden.publicId, "unhide");
  await service.setItemState(reader, hidden.publicId, "unstar");
  assert.deepEqual((await service.listItems(reader, params())).body.items.map((item) => item.titleRaw), ["Kept", "Hidden"]);
  await assert.rejects(service.setItemState(reader, "nosuchitem0000", "star"), { code: "frontier_item_not_found" });
  const prefs = await database.query("SELECT state_version FROM evimed_frontier.user_prefs WHERE user_id=$1", [reader.id]);
  assert.equal(Number(prefs.rows[0].state_version), 5, "every write moved the reader's state version");
});

test("search runs the keyword leg, widens 精选 to 全部, marks selected items, and pages by rank", options, async () => {
  await insertItem(database, { title: "Semaglutide cuts cardiovascular events", titleZh: "司美格鲁肽降低心血管事件", selected: true });
  await insertItem(database, { title: "Tirzepatide weight trial", titleZh: "替尔泊肽减重试验", selected: false });
  await insertItem(database, { title: "Unrelated oncology update", titleZh: "肿瘤进展" });
  const service = serviceFor();
  const zh = await service.listItems(reader, params({ q: "司美格鲁肽" }));
  assert.equal(zh.body.mode, "keyword");
  assert.deepEqual(zh.body.items.map((item) => item.titleRaw), ["Semaglutide cuts cardiovascular events"]);
  const widened = await service.listItems(reader, params({ q: "trial weight" }));
  assert.deepEqual(widened.body.items.map((item) => [item.titleRaw, item.selected]), [["Tirzepatide weight trial", false]],
    "searching the selected view searches every published item");
  const paged = await service.listItems(reader, params({ view: "all", q: "试验 司美格鲁肽 肿瘤", limit: "1" }));
  assert.equal(paged.body.items.length, 1);
  assert.ok(paged.body.nextCursor);
  const second = await service.listItems(reader, params({ view: "all", q: "试验 司美格鲁肽 肿瘤", limit: "1", cursor: paged.body.nextCursor }));
  assert.equal(second.body.items.length, 1);
  assert.notEqual(second.body.items[0].id, paged.body.items[0].id);
  assert.equal(service.counters.searches, 3, "the second page reused the first page's ranking");
});

test("with pgvector and an embedder the vector leg joins and the answer says hybrid", options, async (t) => {
  if (!capabilities.vector) { t.skip("this database has no pgvector"); return; }
  const paraphrased = await insertItem(database, { title: "Kidney outcomes with finerenone", titleZh: "非奈利酮肾脏结局" });
  const vector = (hot) => Array.from({ length: 1024 }, (_, index) => (index === hot ? 1 : 0.001));
  await database.query(`INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding) VALUES ($1, 'fake@1024', $2::${capabilities.halfvec ? "halfvec" : "vector"})`,
    [paraphrased.id, `[${vector(7).join(",")}]`]);
  const embedder = { configured: true, modelKey: "fake@1024", async embedQuery() { return vector(7); } };
  const service = serviceFor({ embedder });
  const answer = await service.listItems(reader, params({ q: "diabetic nephropathy drug" }));
  assert.equal(answer.body.mode, "hybrid");
  assert.deepEqual(answer.body.items.map((item) => item.titleRaw), ["Kidney outcomes with finerenone"],
    "a question sharing no word with the item is found by the vector leg alone");
  const failing = serviceFor({ embedder: { configured: true, modelKey: "fake@1024", async embedQuery() { throw Object.assign(new Error("down"), { code: "kb_embedding_unavailable" }); } } });
  assert.equal((await failing.listItems(reader, params({ q: "finerenone" }))).body.mode, "keyword", "an embedding outage leaves keyword search standing");
});

test("one item: its abstract and enrichment, a 304 when unchanged, a 404 when withdrawn or unknown", options, async () => {
  const item = await insertItem(database, { title: "Detailed", abstract: "Background. 42% fewer events.", openAccess: "green", oaPdfUrl: "https://example.org/b.pdf" });
  const withdrawn = await insertItem(database, { title: "Gone", state: "withdrawn" });
  const service = serviceFor();
  const answer = await service.getItem(reader, item.publicId);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.item.abstract, "Background. 42% fewer events.");
  assert.deepEqual(answer.body.item.enrichment.publicationTypes, ["Randomized Controlled Trial"]);
  assert.equal(answer.body.item.enrichment.impactFactor, 50.1);
  assert.equal((await service.getItem(reader, item.publicId, answer.etag)).status, 304);
  await assert.rejects(service.getItem(reader, withdrawn.publicId), { code: "frontier_item_not_found" });
  await assert.rejects(service.getItem(reader, "NOT-AN-ID"), { code: "frontier_item_not_found" });
});

test("status: sources by health, today's counts, versions, the plugin's state and the budget", options, async () => {
  await insertSource(database, "sleepy", { plugin_health: "weird-word" });
  await insertSource(database, "planned", { plugin_health: "disabled" });
  await insertSource(database, "broken", { plugin_health: "unreadable" });
  await insertSource(database, "gone", { retired_at: "2026-09-01T00:00:00Z" });
  await insertItem(database, { selected: true, visibleAt: "2026-09-22T01:00:00Z" });
  await insertItem(database, { selected: false, visibleAt: "2026-09-21T16:30:00Z" });
  await insertItem(database, { selected: true, visibleAt: "2026-09-21T15:00:00Z", timelineAt: "2026-09-21T15:00:00Z" });
  const ingest = { status: () => ({ state: "ok", contract: "1.0.0", version: "0.1.0", lastPullOkAt: "2026-09-22T03:59:00Z", latestSeq: 120 }) };
  await database.query("UPDATE evimed_frontier.meta SET value='100'::jsonb WHERE key='plugin_cursor'");
  const service = serviceFor({ ingest, budget: async () => ({ spentCny: 8.5, budgetCny: 10, state: "throttled" }) });
  const status = await service.status();
  assert.deepEqual(status.sources, { total: 6, enabled: 5, healthy: 3, degraded: 1, unreadable: 1, drifted: 0, planned: 1 },
    "a retired source is not counted; a planned one is not among those read");
  // 16:00 UTC on the 21st is midnight in Shanghai on the 22nd.
  assert.deepEqual(status.counts, { today: 2, selectedToday: 1 });
  assert.deepEqual(status.plugin, { state: "ok", contract: "1.0.0", version: "0.1.0", lastPullAt: "2026-09-22T03:59:00Z", cursor: 100, latestSeq: 120, lag: 20 });
  assert.deepEqual(status.budget, { spentCny: 8.5, budgetCny: 10, state: "throttled" });
  assert.equal(status.personalization, "off");
  assert.deepEqual(status.versions, { content: "0", hot: "0", daily: "0" });
  assert.equal(status.lastPublishedAt, "2026-09-22T01:00:00.000Z");
  const tagged = await service.statusAnswer();
  assert.equal((await service.statusAnswer(tagged.etag)).status, 304);
});

test("the budget shown is the pipeline's reading; without one, or when it fails, it is unavailable with no number", options, async () => {
  assert.deepEqual(await serviceFor().budget(), { spentCny: null, budgetCny: 10, state: "unavailable" });
  const read = serviceFor({ budget: async () => ({ spentCny: 9, budgetCny: 10, state: "throttled", measured: true }) });
  assert.deepEqual(await read.budget(), { spentCny: 9, budgetCny: 10, state: "throttled" });
  const failing = serviceFor({ budget: async () => { throw new Error("ledger down"); } });
  assert.deepEqual(await failing.budget(), { spentCny: null, budgetCny: 10, state: "unavailable" });
  assert.equal(failing.counters.budgetFailures, 1);
});

test("follows: upsert by kind and key, the reader's own, and bounded", options, async () => {
  const service = serviceFor();
  const created = await service.createFollow(reader, { kind: "specialty", key: "cardiology" });
  assert.equal(created.follow.label, "心血管");
  const drug = await service.createFollow(reader, { kind: "drug", key: "  Semaglutide ", label: "司美格鲁肽" });
  assert.equal(drug.follow.key, "semaglutide");
  const muted = await service.createFollow(reader, { kind: "drug", key: "semaglutide", label: "司美格鲁肽", muted: true });
  assert.equal(muted.follow.id, drug.follow.id, "following again changes the row, never adds one");
  assert.equal(muted.follow.muted, true);
  await service.createFollow(reader, { kind: "source", key: "nejm" });
  await assert.rejects(service.createFollow(reader, { kind: "source", key: "no-such-source" }), { code: "frontier_follow_invalid" });
  await assert.rejects(service.createFollow(reader, { kind: "specialty", key: "astrology" }), { code: "frontier_follow_invalid" });
  await assert.rejects(service.createFollow(reader, { kind: "author", key: "x" }), { code: "frontier_follow_invalid" });
  await assert.rejects(service.createFollow(reader, { kind: "topic", key: "x", muted: "yes" }), { code: "frontier_follow_invalid" });
  assert.equal((await service.listFollows(reader)).follows.length, 3);
  assert.equal((await service.listFollows(other)).follows.length, 0);
  await assert.rejects(service.deleteFollow(other, created.follow.id), { code: "frontier_follow_not_found" }, "another reader's follow is not theirs to delete");
  assert.deepEqual(await service.deleteFollow(reader, created.follow.id), { deleted: true });
  assert.equal((await service.listFollows(reader)).follows.length, 2);
});

test("operators withdraw with a reason, pin and unpin, and switch a source off for readers at once", options, async () => {
  const item = await insertItem(database, { selected: false, title: "Operated" });
  const service = serviceFor();
  await assert.rejects(service.operateItem(item.publicId, "withdraw", {}), { code: "frontier_operation_invalid" });
  const pinned = await service.operateItem(item.publicId, "pin", { reason: "important" });
  assert.deepEqual([pinned.item.selected, pinned.item.selectedRule], [true, "operator-pin"]);
  assert.deepEqual((await service.listItems(reader, params())).body.items.map((entry) => entry.titleRaw), ["Operated"]);
  const unpinned = await service.operateItem(item.publicId, "unpin", {});
  assert.equal(unpinned.item.selected, false);
  await assert.rejects(service.operateItem(item.publicId, "unpin", {}), { code: "frontier_item_not_pinned" });
  const withdrawn = await service.operateItem(item.publicId, "withdraw", { reason: "Retracted by the journal" });
  assert.equal(withdrawn.item.state, "withdrawn");
  assert.equal(withdrawn.item.withdrawnReason, "Retracted by the journal");
  assert.deepEqual((await service.listItems(reader, params({ view: "all" }))).body.items, []);
  const changes = (await database.query("SELECT op, reason FROM evimed_frontier.item_changes WHERE item_id=$1 ORDER BY seq", [item.id])).rows;
  assert.deepEqual(changes.map((row) => [row.op, row.reason]), [["upsert", "selected"], ["upsert", "selected"], ["remove", "withdrawn"]]);
  await assert.rejects(service.operateItem(item.publicId, "pin", {}), { code: "frontier_item_withdrawn" });

  await insertItem(database, { title: "From Lancet", sourceId: "lancet" });
  const off = await service.setSourceEnabled("lancet", false);
  assert.equal(off.source.enabled, false);
  assert.deepEqual((await service.listItems(reader, params({ view: "all" }))).body.items, [], "a source switched off leaves every list at once");
  const listing = await service.sources(reader);
  assert.equal(listing.sources.some((source) => source.id === "lancet"), false, "readers do not see a switched-off source");
  assert.equal((await service.sources(operator)).sources.some((source) => source.id === "lancet"), true, "operators see every row");
  await assert.rejects(service.setSourceEnabled("lancet", "no"), { code: "frontier_operation_invalid" });
  await assert.rejects(service.setSourceEnabled("nope", true), { code: "frontier_source_not_found" });
});

test("the sources page reads the mirror, maps unknown health to degraded, and names the plugin's fields", options, async () => {
  await insertSource(database, "odd", { plugin_health: "weird-word" });
  await database.query(`INSERT INTO evimed_frontier.meta(key, value) VALUES ('plugin_manifest', $1::jsonb)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({ manifest: { plugin: { version: "0.2.0" }, contract: { version: "1.1.0" },
    fields: { entry: ["summary"], facts: [], enrichment: ["publication_types"] } }, compatible: true })]);
  const service = serviceFor();
  const listing = await service.sources(reader);
  assert.deepEqual(listing.plugin, { version: "0.2.0", contract: "1.1.0", fields: { entry: ["summary"], facts: [], enrichment: ["publication_types"] } });
  const odd = listing.sources.find((source) => source.id === "odd");
  assert.deepEqual([odd.health, odd.healthLabel], ["degraded", "退化"]);
  assert.deepEqual(Object.keys(odd).sort(), ["access", "displayName", "egress", "enabled", "entries7d", "health", "healthLabel", "homepage", "id", "lane",
    "laneLabel", "lastNewEntryAt", "lastOkAt", "launchTier", "name", "retired", "selected30d", "sourceType", "sourceTypeLabel"]);
});

test("the sources list names each feed and its institution, with its selected items of the last 30 days", options, async () => {
  await insertSource(database, "openfda-drug-enforcement-api", { name: "openFDA 药品召回（enforcement）API", lane: "safety", source_type: "regulator",
    owner_entity: "U.S. Food and Drug Administration" });
  await database.query("UPDATE evimed_frontier.sources SET selected_30d = 7 WHERE id = 'openfda-drug-enforcement-api'");
  const listing = await serviceFor().sources(reader);
  const fda = listing.sources.find((source) => source.id === "openfda-drug-enforcement-api");
  assert.deepEqual([fda.name, fda.displayName, fda.selected30d], ["openFDA 药品召回（enforcement）API", "FDA", 7],
    "the list is a list of feeds, so it keeps the feed's name — and says whose it is");
  const nejm = listing.sources.find((source) => source.id === "nejm");
  assert.deepEqual([nejm.displayName, nejm.selected30d], ["NEJM Journal", 0], "an institution the table does not name keeps the registry's name");
});

test("a card carries the editorial total and its band against the selection line; a safety alert carries neither", options, async () => {
  const scored = async (title, total, overrides = {}) => {
    const row = await insertItem(database, { title, selected: true, ...overrides });
    await database.query("UPDATE evimed_frontier.items SET score_total = $2 WHERE id = $1", [row.id, total]);
    return row;
  };
  await scored("Top", 86, { timelineAt: "2026-09-22T03:00:00Z" });
  await scored("Middle", 64, { timelineAt: "2026-09-22T02:00:00Z" });
  await scored("Low", 41, { timelineAt: "2026-09-22T01:00:00Z" });
  await scored("Alert", 90, { timelineAt: "2026-09-22T00:30:00Z", safetyAlert: true, selectedRule: "safety-bypass" });
  const cards = async (config) => Object.fromEntries((await serviceFor({ config }).listItems(reader, params({ view: "all" }))).body.items
    .map((item) => [item.titleRaw, [item.score, item.scoreBand]]));
  assert.deepEqual(await cards({}), { Top: [86, "high"], Middle: [64, "medium"], Low: [41, "low"], Alert: [null, null] },
    "at or above the line (70 unless set) is high, from 60 medium, below low");
  assert.deepEqual((await cards({ frontierSelectThreshold: 90 })).Top, [86, "medium"], "the band reads the deployment's own line");
});

test("a source reaches a reader by its institution: the card, and 「另有 N 家」 counted by institution, never a feed of the card's own", options, async () => {
  await insertSource(database, "openfda-drug-enforcement-api", { name: "openFDA 药品召回（enforcement）API", lane: "safety", source_type: "regulator",
    owner_entity: "U.S. Food and Drug Administration" });
  await insertSource(database, "fda-medwatch-safety-alerts", { name: "美国FDA MedWatch 安全警示 MedWatch Safety Alerts", lane: "safety",
    source_type: "regulator", owner_entity: "U.S. Food and Drug Administration" });
  await insertSource(database, "mhra-alerts-recalls", { name: "英国MHRA 警示与召回 Alerts and recalls", lane: "safety", source_type: "regulator",
    owner_entity: "Medicines and Healthcare products Regulatory Agency" });
  await insertSource(database, "stat-biotech", { name: "STAT Biotech 频道", source_type: "media", owner_entity: "Boston Globe Media" });
  await insertSource(database, "stat-news", { name: "STAT News", source_type: "media", owner_entity: "Boston Globe Media" });
  await insertItem(database, { title: "Class I recall", sourceId: "openfda-drug-enforcement-api", sourceType: "regulator", lane: "safety",
    safetyAlert: true, selected: true, mentions: [
      { sourceId: "fda-medwatch-safety-alerts", url: "https://fda.example.org/medwatch", publishedAt: "2026-09-22T02:30:00Z" },
      { sourceId: "mhra-alerts-recalls", url: "https://mhra.example.org/1", publishedAt: "2026-09-22T02:00:00Z" },
      { sourceId: "stat-biotech", url: "https://stat.example.org/b", publishedAt: "2026-09-22T01:00:00Z" },
      { sourceId: "stat-news", url: "https://stat.example.org/n", publishedAt: "2026-09-22T01:30:00Z" },
    ] });
  const [card] = (await serviceFor().listItems(reader, params({ safety: "1", view: "all" }))).body.items;
  assert.equal(card.source.name, "FDA", "not 「openFDA 药品召回（enforcement）API」");
  assert.deepEqual(card.alsoReportedBy.map((mention) => [mention.sourceName, mention.url]),
    [["英国 MHRA", "https://mhra.example.org/1"], ["STAT", "https://stat.example.org/n"]],
    "one row per other institution, its latest mention; the FDA's own second feed is not another report");
  assert.equal(card.alsoReportedCount, 2);
});

test("search by time: the items the words match, newest first; by relevance otherwise; the order is part of the cursor", options, async () => {
  await insertItem(database, { title: "Semaglutide heart failure outcomes", titleZh: "司美格鲁肽心衰结局", timelineAt: "2026-09-20T00:00:00Z" });
  await insertItem(database, { title: "Semaglutide kidney trial", titleZh: "司美格鲁肽肾脏试验", timelineAt: "2026-09-22T00:00:00Z" });
  await insertItem(database, { title: "Semaglutide semaglutide weight semaglutide", titleZh: "司美格鲁肽 司美格鲁肽 减重", timelineAt: "2026-09-21T00:00:00Z" });
  await insertItem(database, { title: "Unrelated oncology", titleZh: "肿瘤", timelineAt: "2026-09-22T03:00:00Z" });
  const service = serviceFor();
  const byTime = await service.listItems(reader, params({ view: "all", q: "司美格鲁肽", sort: "time" }));
  assert.equal(byTime.body.mode, "keyword");
  assert.deepEqual(byTime.body.items.map((item) => item.titleRaw),
    ["Semaglutide kidney trial", "Semaglutide semaglutide weight semaglutide", "Semaglutide heart failure outcomes"]);
  const byRelevance = await service.listItems(reader, params({ view: "all", q: "司美格鲁肽" }));
  assert.equal(byRelevance.body.items.length, 3);
  const paged = await service.listItems(reader, params({ view: "all", q: "司美格鲁肽", sort: "time", limit: "2" }));
  assert.deepEqual(paged.body.items.map((item) => item.titleRaw), ["Semaglutide kidney trial", "Semaglutide semaglutide weight semaglutide"]);
  const next = await service.listItems(reader, params({ view: "all", q: "司美格鲁肽", sort: "time", limit: "2", cursor: paged.body.nextCursor }));
  assert.deepEqual(next.body.items.map((item) => item.titleRaw), ["Semaglutide heart failure outcomes"]);
  await assert.rejects(service.listItems(reader, params({ view: "all", q: "司美格鲁肽", limit: "2", cursor: paged.body.nextCursor })),
    { code: "invalid_cursor" }, "a cursor of the time order is not one of the relevance order");
  await assert.rejects(service.listItems(reader, params({ sort: "random" })), { code: "frontier_query_invalid" });
});
