// The tag tree on PostgreSQL (frontierTags.mjs, frontierTagUpkeep.mjs; owner 2026-10-23): the seed loads once, a deployed database's
// retired specialties and follow kinds move with the migration, an edit's names link to the tree or become hidden candidates, the
// list filters by tag (merged and narrower included), by several specialties, by evidence type and by what is unread, and the
// upkeep promotes, folds, refuses, sleeps, wakes, splits and takes back — each a row an operator can see.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FRONTIER_EDITOR_VERSION } from "../src/frontierEditor.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { FrontierTagStore, FRONTIER_TAG_VERSION } from "../src/frontierTags.mjs";
import { FrontierTagUpkeep } from "../src/frontierTagUpkeep.mjs";
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
const NOW = new Date("2026-10-23T04:00:00Z");
const open = () => new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });

/** @type {any} */
let database;

before(async () => {
  if (!databaseUrl) return;
  database = open();
  await migrateFrontier(database, { dimension: 1024 });
  await migrateUsageLedger(database);
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
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.sources");
  await database.query("DELETE FROM evimed_frontier.user_follows WHERE user_id = $1", [reader.id]);
  // The tree as the seed left it: what a test grew or changed goes.
  await database.query("DELETE FROM evimed_frontier.tag_changes");
  await database.query("DELETE FROM evimed_frontier.tags WHERE origin <> 'seed'");
  await database.query(`UPDATE evimed_frontier.tags SET state = CASE WHEN slug LIKE 'c-seed-%' THEN 'candidate' WHEN slug LIKE 'r-seed-%' THEN 'rejected' ELSE 'active' END,
    merged_into = NULL, judged_at = NULL WHERE origin = 'seed'`);
  await database.query("UPDATE evimed_frontier.meta SET value = to_jsonb(coalesce((value #>> '{}')::bigint, 0) + 1) WHERE key = 'tags_version'");
  for (const id of ["nejm", "lancet", "fda"]) await insertSource(database, id);
});

/** @param {Record<string, any>} [overrides] */
const serviceFor = (overrides = {}) => new FrontierService({ database, vocabulary, now: () => NOW,
  config: { frontierEnabled: true, frontierAudience: "all", operatorUsers: [], frontierPreviewUsers: [], frontierSelectThreshold: 80 }, ...overrides });
/** @param {Record<string, string>} values */
const params = (values) => new URLSearchParams({ view: "all", ...values });
const titles = async (/** @type {any} */ service, /** @type {Record<string, string>} */ values) => (await service.listItems(reader, params(values))).body.items.map((/** @type {any} */ item) => item.titleRaw).sort();
const slugOf = async (/** @type {string} */ name) => (await database.query("SELECT slug FROM evimed_frontier.tags WHERE name = $1", [name])).rows[0]?.slug;

test("the seed loads once into an empty table; a second migration and a grown table leave it alone", options, async () => {
  const count = async () => Number((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.tags WHERE origin = 'seed'")).rows[0].n);
  const seeded = await count();
  assert.ok(seeded > 3_000, `${seeded} seed rows`);
  assert.ok(Number((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.tag_aliases")).rows[0].n) > seeded, "every spelling an alias");
  const active = Number((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.tags WHERE state = 'active'")).rows[0].n);
  assert.ok(active > 1_000 && active < seeded, "the most used are shown, the rest wait as candidates");
  const second = open();
  await migrateFrontier(second, { dimension: 1024 });
  await second.close();
  assert.equal(await count(), seeded);
  // An English abstract names a seeded tag by MeSH's own words.
  const store = new FrontierTagStore({ database });
  const names = (await store.vocabulary()).candidatesFor({ title: "Atezolizumab plus bevacizumab in hepatocellular carcinoma", text: "Patients with HCC and obesity" }).map((tag) => tag.name);
  assert.ok(names.includes("肝细胞癌") && names.includes("肥胖"), names.join("、"));
});

test("a deployed database: the follow kinds' CHECK takes 'tag', and stored retired specialties move to their successor or go", options, async () => {
  await database.query("ALTER TABLE evimed_frontier.user_follows DROP CONSTRAINT user_follows_kind_check");
  await database.query("ALTER TABLE evimed_frontier.user_follows ADD CONSTRAINT user_follows_kind_check CHECK (kind IN ('topic', 'specialty', 'drug', 'source', 'event'))");
  const item = await insertItem(database, { title: "Old keys", specialties: ["surgery-anesthesia", "geriatrics", "public-health"] });
  await database.query("INSERT INTO evimed_frontier.user_follows (user_id, kind, key, label) VALUES ($1, 'specialty', 'surgery-anesthesia', '外科与麻醉'), ($1, 'specialty', 'geriatrics', '老年')", [reader.id]);
  const fresh = open();
  await migrateFrontier(fresh, { dimension: 1024 });
  await fresh.close();
  const definition = (await database.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'user_follows_kind_check'")).rows[0].d;
  assert.match(definition, /'tag'/);
  assert.deepEqual((await database.query("SELECT specialties FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0].specialties, ["general-surgery"]);
  assert.deepEqual((await database.query("SELECT kind, key, label FROM evimed_frontier.user_follows WHERE user_id = $1", [reader.id])).rows,
    [{ kind: "specialty", key: "general-surgery", label: "普通外科" }]);
});

test("an edit's names: a spelling of a tag links to it, an unknown name becomes a hidden candidate, a refused one is dropped, a fold reads as its target", options, async () => {
  const store = new FrontierTagStore({ database });
  const item = await insertItem(database, { title: "Semaglutide in obesity" });
  const linked = await database.transaction((/** @type {any} */ client) => store.link(client, item.id, ["司美格鲁肽", "Obesity", "一个新的概念"], { origin: "edit", specialties: ["endocrinology"] }));
  assert.deepEqual(linked, { linked: 3, created: 1 });
  assert.deepEqual((await store.itemTags([item.id])).get(item.id)?.map((tag) => tag.name), ["司美格鲁肽", "肥胖"], "the candidate is not shown");
  assert.equal((await database.query("SELECT tag_version FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0].tag_version, FRONTIER_TAG_VERSION);
  const candidate = (await database.query("SELECT id, state, specialties FROM evimed_frontier.tags WHERE name = '一个新的概念'")).rows[0];
  assert.deepEqual([candidate.state, candidate.specialties], ["candidate", ["endocrinology"]]);
  // A name the seed refused (a generic word) is dropped at once, never a candidate.
  const generic = await insertItem(database, { title: "Generic" });
  const refusedSeed = (await database.query("SELECT name FROM evimed_frontier.tags WHERE slug LIKE 'r-seed-%' LIMIT 1")).rows[0].name;
  assert.deepEqual(await database.transaction((/** @type {any} */ client) => store.link(client, generic.id, [refusedSeed], { origin: "edit" })), { linked: 0, created: 0 });
  // The same name again links to the same candidate; a refused name is dropped.
  const other = await insertItem(database, { title: "Another" });
  await database.transaction((/** @type {any} */ client) => store.link(client, other.id, ["一个新的概念"], { origin: "edit" }));
  assert.equal(Number((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.tags WHERE name = '一个新的概念'")).rows[0].n), 1);
  await database.query("UPDATE evimed_frontier.tags SET state = 'rejected' WHERE id = $1", [candidate.id]);
  await database.query("UPDATE evimed_frontier.meta SET value = to_jsonb((value #>> '{}')::bigint + 1) WHERE key = 'tags_version'");
  store.invalidate();
  await database.transaction((/** @type {any} */ client) => store.link(client, other.id, ["一个新的概念", "肥胖"], { origin: "retag" }));
  assert.deepEqual((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.item_tags WHERE item_id = $1", [other.id])).rows[0].n, 1);
  // A tag folded into another is shown as the other.
  const obesity = (await database.query("SELECT id FROM evimed_frontier.tags WHERE name = '肥胖'")).rows[0].id;
  await database.query("UPDATE evimed_frontier.tags SET state = 'merged', merged_into = $1 WHERE name = '司美格鲁肽'", [obesity]);
  await database.query("UPDATE evimed_frontier.meta SET value = to_jsonb((value #>> '{}')::bigint + 1) WHERE key = 'tags_version'");
  store.invalidate();
  assert.deepEqual((await store.itemTags([item.id])).get(item.id)?.map((tag) => tag.name), ["肥胖"], "each tag once");
});

test("the list: a tag lists its narrower and folded tags, several specialties are any of them, a retired key reads as its successor, evidence and unread filter", options, async () => {
  const store = new FrontierTagStore({ database });
  const link = async (/** @type {string} */ title, /** @type {string[]} */ names, /** @type {Record<string, any>} */ more = {}) => {
    const item = await insertItem(database, { title, ...more });
    await database.transaction((/** @type {any} */ client) => store.link(client, item.id, names, { origin: "edit" }));
    return item;
  };
  await link("Lung", ["肺癌"], { specialties: ["oncology"] });
  const nsclc = await link("NSCLC", ["非小细胞肺癌"], { specialties: ["oncology", "respiratory"], evidenceType: "observational" });
  await link("Breast", ["乳腺癌"], { specialties: ["oncology"] });
  await link("Surgery", [], { specialties: ["general-surgery"] });
  const service = serviceFor({ tags: store });
  const lung = await slugOf("肺癌");
  assert.deepEqual(await titles(service, { tag: lung }), ["Lung", "NSCLC"], "肺癌 lists 非小细胞肺癌");
  assert.deepEqual(await titles(service, { tag: await slugOf("非小细胞肺癌") }), ["NSCLC"]);
  assert.deepEqual(await titles(service, { specialty: "respiratory,general-surgery" }), ["NSCLC", "Surgery"]);
  assert.deepEqual(await titles(service, { specialty: "surgery-anesthesia" }), ["Surgery"], "an old link still works");
  assert.deepEqual(await titles(service, { evidence: "observational" }), ["NSCLC"]);
  await service.setItemState(reader, nsclc.publicId, "read");
  assert.deepEqual(await titles(service, { unread: "1", tag: lung }), ["Lung"]);
  await assert.rejects(service.listItems(reader, params({ tag: "no-such-tag" })), (error) => /** @type {any} */ (error).code === "frontier_tag_not_found");
  await assert.rejects(service.listItems(reader, params({ specialty: "astrology" })), (error) => /** @type {any} */ (error).code === "frontier_query_invalid");
  // A fold: the old address lists as the tag that stands for it now.
  const breast = (await database.query("SELECT id FROM evimed_frontier.tags WHERE name = '乳腺癌'")).rows[0].id;
  await database.query("UPDATE evimed_frontier.tags SET state = 'merged', merged_into = $1 WHERE name = '肺癌'", [breast]);
  await database.query("UPDATE evimed_frontier.meta SET value = to_jsonb((value #>> '{}')::bigint + 1) WHERE key = 'tags_version'");
  store.invalidate();
  assert.deepEqual(await titles(service, { tag: lung }), ["Breast", "Lung"], "肺癌 now reads as 乳腺癌 (a test fold), so both");
});

test("the 专科 panel's 热门标签, the search box's suggestions, a tag's page, and a followed tag", options, async () => {
  const store = new FrontierTagStore({ database, now: () => NOW });
  for (const [title, names] of /** @type {Array<[string, string[]]>} */ ([["A", ["肺癌"]], ["B", ["肺癌", "非小细胞肺癌"]], ["C", ["乳腺癌"]], ["D", ["肥胖"]]])) {
    const item = await insertItem(database, { title, timelineAt: "2026-10-20T00:00:00Z" });
    await database.transaction((/** @type {any} */ client) => store.link(client, item.id, names, { origin: "edit" }));
  }
  const service = serviceFor({ tags: store });
  const hot = (await service.tagList(new URLSearchParams({ specialty: "oncology" }))).tags;
  assert.deepEqual(hot.map((/** @type {any} */ tag) => [tag.name, tag.count]), [["肺癌", 2], ["乳腺癌", 1], ["非小细胞肺癌", 1]]);
  const suggested = (await service.tagList(new URLSearchParams({ q: "肺癌" }))).tags.map((/** @type {any} */ tag) => tag.name);
  assert.equal(suggested[0], "肺癌", "the name that starts with the words first");
  assert.ok(suggested.includes("非小细胞肺癌"));
  const page = await service.tagDetail(await slugOf("非小细胞肺癌"));
  assert.equal(page.tag.broader?.name, "肺癌");
  assert.deepEqual(page.tag.specialties.map((/** @type {any} */ specialty) => specialty.label), ["肿瘤"]);
  await assert.rejects(service.tagDetail("no-such-tag"), (error) => /** @type {any} */ (error).code === "frontier_tag_not_found");
  const follow = await service.createFollow(reader, { kind: "tag", key: await slugOf("肺癌"), label: "肺癌" });
  assert.equal(follow.kind ?? follow.follow?.kind, "tag");
  assert.deepEqual(await titles(service, { follow: "all" }), ["A", "B"]);
});

/** A model double for the upkeep: each call answered by the next function, given the user message. */
function editorDouble(/** @type {Array<(input: string) => any>} */ answers) {
  /** @type {string[]} */
  const inputs = [];
  return { inputs, available: true, callJson: async (/** @type {any[]} */ messages) => {
    inputs.push(messages[1].content);
    const next = answers.shift();
    if (!next) throw Object.assign(new Error("unexpected call"), { code: "frontier_test_unexpected" });
    return next(messages[1].content);
  } };
}

test("the daily upkeep: a candidate named by five items from two sources is judged — promoted, folded or refused — a full specialty asks ten, and a promotion can be taken back", options, async () => {
  const store = new FrontierTagStore({ database, now: () => NOW });
  const named = async (/** @type {string} */ name, /** @type {number} */ count) => {
    for (let index = 0; index < count; index += 1) {
      const item = await insertItem(database, { title: `${name} ${index}`, sourceId: index % 2 ? "nejm" : "lancet", timelineAt: "2026-10-20T00:00:00Z" });
      await database.transaction((/** @type {any} */ client) => store.link(client, item.id, [name], { origin: "edit", specialties: ["oncology"] }));
    }
  };
  await named("测试新疗法甲", 5);
  await named("肺部恶性肿瘤", 5);
  await named("某次会议", 5);
  await named("还不够的概念", 4);
  await named("满员专科的概念", 5);
  const editor = editorDouble([(input) => {
    const lines = input.split("\n").filter((line) => /^\[\d+\]/.test(line));
    assert.equal(lines.length, 4, "only the candidates over the line are judged");
    const index = (/** @type {string} */ name) => lines.findIndex((line) => line.includes(name)) + 1;
    const block = input.split("\n\n").find((part) => part.includes("肺部恶性肿瘤")) ?? "";
    const lung = /(\d+)=肺癌/.exec(block)?.[1];
    assert.ok(lung, "肺癌 is among its neighbours");
    return { items: [
      // A specialty with room: 肿瘤 has its sixty, where a new tag asks ten items (FRONTIER_TAG_RULES.cappedItems).
      { i: index("测试新疗法甲"), verdict: "new", zh: "测试新疗法甲", en: "Test Therapy Alpha", kind: "therapy", specialties: ["cardiothoracic-surgery"], broader: null },
      { i: index("肺部恶性肿瘤"), verdict: "same", same_as: Number(lung) },
      { i: index("某次会议"), verdict: "reject", why: "一次性事件" },
      { i: index("满员专科的概念"), verdict: "new", zh: "满员专科的概念", en: "Full Specialty Concept", kind: "concept", specialties: ["oncology"], broader: null },
    ] };
  }]);
  const upkeep = new FrontierTagUpkeep({ database, editor, tags: store, now: () => NOW });
  await upkeep.promote();
  const state = async (/** @type {string} */ name) => (await database.query("SELECT slug, state, merged_into FROM evimed_frontier.tags WHERE name = $1", [name])).rows[0];
  assert.deepEqual([(await state("测试新疗法甲")).state, (await state("测试新疗法甲")).slug], ["active", "test-therapy-alpha"]);
  assert.equal((await state("肺部恶性肿瘤")).state, "merged");
  assert.equal((await state("某次会议")).state, "rejected");
  assert.equal((await state("还不够的概念")).state, "candidate");
  assert.equal((await state("满员专科的概念")).state, "candidate", "肿瘤 has sixty: five items are not enough there");
  const overview = await upkeep.overview();
  assert.deepEqual(overview.changes.map((/** @type {any} */ change) => change.action).sort(), ["merge", "promote", "reject"]);
  assert.ok(overview.specialties.find((/** @type {any} */ row) => row.key === "cardiothoracic-surgery").tags.some((/** @type {any} */ tag) => tag.name === "测试新疗法甲"));
  const promotion = overview.changes.find((/** @type {any} */ change) => change.action === "promote");
  assert.equal(await upkeep.undo(promotion.id), true);
  assert.equal((await state("测试新疗法甲")).state, "candidate");
  assert.equal(await upkeep.undo(promotion.id), false, "a change is taken back once");
  const fold = overview.changes.find((/** @type {any} */ change) => change.action === "merge");
  assert.equal(await upkeep.undo(fold.id), true);
  assert.deepEqual([(await state("肺部恶性肿瘤")).state, (await state("肺部恶性肿瘤")).merged_into], ["candidate", null]);
});

test("the weekly upkeep: tags carried by the same items are judged for a fold; an idle tag sleeps and wakes when named again; a specialty's untagged items are read for new candidates", options, async () => {
  const store = new FrontierTagStore({ database, now: () => NOW });
  for (let index = 0; index < 6; index += 1) {
    const item = await insertItem(database, { title: `Shared ${index}`, timelineAt: "2026-10-20T00:00:00Z" });
    await database.transaction((/** @type {any} */ client) => store.link(client, item.id, ["肥胖", "2型糖尿病"], { origin: "edit" }));
  }
  const untagged = [];
  for (let index = 0; index < 40; index += 1) {
    const item = await insertItem(database, { title: `Kidney ${index}`, specialties: ["urology"], timelineAt: "2026-10-01T00:00:00Z" });
    await database.query("UPDATE evimed_frontier.items SET tag_version = 1 WHERE id = $1", [item.id]);
    untagged.push(item);
  }
  const editor = editorDouble([
    () => ({ pairs: [{ i: 1, same: false }] }),
    () => ({ tags: [{ zh: "测试泌尿新概念", en: "Test Urology Concept", kind: "concept", items: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, { zh: "太少的概念", en: "Too Few", kind: "concept", items: [1, 2] }] }),
  ]);
  const upkeep = new FrontierTagUpkeep({ database, editor, tags: store, now: () => NOW });
  assert.equal(await upkeep.merge(), 0, "judged not one concept: nothing folds");
  assert.match(editor.inputs[0], /肥胖/);
  assert.equal(await upkeep.split(), 1, "one proposal covers enough items; the other does not");
  const split = (await database.query("SELECT id, state, origin FROM evimed_frontier.tags WHERE name = '测试泌尿新概念'")).rows[0];
  assert.deepEqual([split.state, split.origin], ["candidate", "split"]);
  assert.equal(Number((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.item_tags WHERE tag_id = $1", [split.id])).rows[0].n), 9);
  // Sleep: an active seed tag no published item named in half a year; wake when one does.
  const later = () => new Date("2027-06-01T00:00:00Z");
  const sleeper = new FrontierTagUpkeep({ database, editor: editorDouble([]), tags: new FrontierTagStore({ database, now: later }), now: later });
  assert.ok(await sleeper.sleep() > 1_000, "a year later almost the whole seed sleeps");
  const breast = (await database.query("SELECT state FROM evimed_frontier.tags WHERE name = '乳腺癌'")).rows[0].state;
  assert.equal(breast, "dormant");
  const item = await insertItem(database, { title: "Named again", timelineAt: "2027-05-30T00:00:00Z" });
  await database.transaction((/** @type {any} */ client) => new FrontierTagStore({ database, now: later }).link(client, item.id, ["乳腺癌"], { origin: "edit" }));
  assert.ok(await sleeper.wake() >= 1);
  assert.equal((await database.query("SELECT state FROM evimed_frontier.tags WHERE name = '乳腺癌'")).rows[0].state, "active");
});

test("a run claims its period: the daily part runs once in twenty hours, whichever process asks", options, async () => {
  await database.query("DELETE FROM evimed_frontier.meta WHERE key IN ('tags_daily_at', 'tags_weekly_at')");
  const calls = [];
  const make = () => {
    const upkeep = new FrontierTagUpkeep({ database, editor: { available: true, callJson: async () => ({ items: [] }) }, tags: new FrontierTagStore({ database, now: () => NOW }), now: () => NOW });
    for (const part of ["promote", "wake", "merge", "split", "sleep"]) /** @type {any} */ (upkeep)[part] = async () => { calls.push(part); return 0; };
    return upkeep;
  };
  assert.deepEqual(await make().tick(), { daily: true, weekly: true });
  assert.deepEqual(await make().tick(), { daily: false, weekly: false });
  assert.deepEqual(calls, ["promote", "wake", "merge", "split", "sleep"]);
});

test("what was published before the tree is tagged again, newest first, a few calls a batch: specialties judged anew, tags linked, a malformed answer waits a day", options, async () => {
  const items = [];
  for (const [index, title] of ["Old NSCLC paper", "Old obesity paper", "Old odd paper"].entries()) {
    const item = await insertItem(database, { title, specialties: ["general-practice", "pharmacy"], timelineAt: `2026-10-2${index}T00:00:00Z`,
      entities: { diseases: index === 0 ? ["非小细胞肺癌"] : [], drugs: [] } });
    await database.query("UPDATE evimed_frontier.items SET editor_version = $2 WHERE id = $1", [item.id, FRONTIER_EDITOR_VERSION]);
    items.push(item);
  }
  /** @type {any[][]} */
  const asked = [];
  const methods = {
    available: true, owner: { userId: reader.id, projectId: "evimed-frontier" },
    async screen() { return { verdicts: new Map(), errors: new Map() }; },
    async edit() { throw Object.assign(new Error("not expected"), { code: "frontier_test_unexpected" }); },
    async retag(/** @type {any[]} */ batch) {
      asked.push(batch);
      return batch.map((/** @type {any} */ entry) => entry.titleRaw === "Old odd paper" ? null
        : entry.titleRaw === "Old NSCLC paper" ? { specialties: ["oncology", "respiratory"], tags: ["非小细胞肺癌", "一个候选"] }
          : { specialties: ["endocrinology"], tags: ["肥胖"] });
    },
  };
  // Every other step of a batch finds nothing to do with these items; a method it might look for answers nothing.
  const editor = new Proxy(methods, { get: (target, key) => (key in target ? /** @type {any} */ (target)[key] : undefined) });
  const pipeline = new FrontierPipeline({ database, editor, plugin: { text: async () => null }, now: () => NOW, workerId: `test-${randomUUID()}`,
    config: { frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 0, frontierSelectThreshold: 80 } });
  const summary = await pipeline.processBatch();
  assert.equal(summary.retagged, 2);
  assert.equal(asked.length, 1, "three items fit one call");
  assert.deepEqual(asked[0].map((/** @type {any} */ entry) => entry.titleRaw), ["Old odd paper", "Old obesity paper", "Old NSCLC paper"], "newest first");
  assert.ok(asked[0][2].tagCandidates.includes("非小细胞肺癌"), "the tree's tags its words name are offered");
  const row = async (/** @type {any} */ item) => (await database.query("SELECT specialties, tag_version, tag_claim_until FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0];
  assert.deepEqual((await row(items[0])).specialties, ["oncology", "respiratory"], "全科 and 药学 judged anew");
  assert.equal((await row(items[0])).tag_version, 1);
  const shown = await new FrontierTagStore({ database }).itemTags(items.map((item) => item.id));
  assert.deepEqual(shown.get(items[0].id)?.map((tag) => tag.name), ["非小细胞肺癌"]);
  assert.deepEqual(shown.get(items[1].id)?.map((tag) => tag.name), ["肥胖"]);
  const odd = await row(items[2]);
  assert.equal(odd.tag_version, null);
  assert.ok(new Date(odd.tag_claim_until).getTime() - NOW.getTime() > 23 * 3_600_000, "a malformed answer waits a day");
  assert.equal(pipeline.status().counters.retagSkipped, 1);
  assert.equal((await pipeline.processBatch()).retagged, 0, "nothing left to tag");
});
