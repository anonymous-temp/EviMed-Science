// The read side of the topic zones, against a real PostgreSQL: the directory's views and groups, the privacy of a reader's own zone,
// a zone's detail, the modules of its overview in its type's order with their minimums and windows, the 「动态」 list with its
// filters, counts and cursor, and the card port. The membership module is not here: `zone_items` rows are written directly, the way
// it writes them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EVIDENCE_PLATFORM_PRODUCER_NAME, evidenceZoneRole, frontierItemGenre } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createEvidenceZoneCards } from "../src/evidenceZoneCards.mjs";
import { createEvidenceZoneReads } from "../src/evidenceZoneReads.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const NOW = new Date("2026-10-29T08:00:00Z");
const alice = { id: "alice" };
const bob = { id: "bob" };
const config = { frontierEnabled: true, frontierAudience: "all", frontierTimeZone: "Asia/Shanghai", operatorUsers: [], evidenceUserZonesMax: 30, evidenceCardProvider: "none" };

/** @type {any} */ let isolated;
/** @type {any} */ let db;
/** @type {any} */ let reads;
/** @type {Record<string, { id: string, publicId: string }>} */
const items = {};
/** @type {Record<string, string>} */
const events = {};

const ago = (/** @type {number} */ days, hours = 0) => new Date(NOW.getTime() - (days * 24 + hours) * 3_600_000).toISOString();

/** A zone's definition the way the drafter stores one. */
function definition(type, keywords, extra = {}) {
  return { version: 1, type, keywords: keywords.map((entry) => ({ terms: [entry.label], tagIds: [], entityKeys: [], ...entry })), perspective: null, scope: "范围", include: "", exclude: "",
    excludeTerms: [], specialties: [], group: "", seeds: { positive: [], negative: [] }, ...extra };
}

/** @param {Record<string, any>} zone */
async function addZone(zone) {
  const row = { owner: "pub", kind: "official", state: "published", lifecycle: "active", type: "drug-indication", specialties: [], group: "", scope: "范围", definition: null, stats: null,
    overview: null, overviewAt: null, slug: null, updatedAt: ago(0), ...zone };
  await db.query(`INSERT INTO evimed_frontier.evidence_zones (id, user_id, title, state, kind, slug, zone_type, specialties, group_label, scope_zh, definition, definition_version,
      lifecycle, stats, overview, overview_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15::jsonb,$16,$17)`,
  [row.id, row.owner, row.title, row.state, row.kind, row.slug, row.lifecycle === "none" ? null : row.type, row.specialties, row.group, row.scope,
    row.definition ? JSON.stringify(row.definition) : null, row.definition ? 1 : 0, row.lifecycle, row.stats ? JSON.stringify(row.stats) : null,
    row.overview ? JSON.stringify(row.overview) : null, row.overviewAt, row.updatedAt]);
}

/**
 * An item the pipeline left published, with the columns the page reads; `patch` is written after the fixture's own insert.
 * @param {string} name @param {Record<string, any>} [spec]
 */
async function addItem(name, spec = {}) {
  const { age = 1, hours = 0, patch = {}, ...fields } = spec;
  const found = await insertItem(db, { title: name, timelineAt: ago(age, hours), visibleAt: ago(age, hours), publishedAt: ago(age, hours), ...fields });
  const columns = { genre: null, event_id: null, track_facts: null, practice_changing: false, registry_ids: [], score_total: 50, channel: null, ...patch };
  await db.query(`UPDATE evimed_frontier.items SET genre = $2, event_id = $3, track_facts = $4::jsonb, practice_changing = $5, registry_ids = $6, score_total = $7, channel = $8 WHERE id = $1`,
    [found.id, columns.genre, columns.event_id, columns.track_facts ? JSON.stringify(columns.track_facts) : null, columns.practice_changing, columns.registry_ids, columns.score_total, columns.channel]);
  items[name] = found;
  return found;
}

/** The row the membership module would write for an item of a zone. @param {string} zone @param {string} name @param {Record<string, any>} [spec] */
async function addMember(zone, name, { state = "in", relevance = "core" } = {}) {
  const row = (await db.query("SELECT genre, platform, channel, source_type, evidence_type, flags, safety_alert, lane FROM evimed_frontier.items WHERE id = $1", [items[name].id])).rows[0];
  const role = evidenceZoneRole({ genre: frontierItemGenre(row), safetyAlert: row.safety_alert });
  await db.query(`INSERT INTO evimed_frontier.zone_items (zone_id, item_id, state, relevance, via, role, definition_version) VALUES ($1,$2,$3,$4,'tag',$5,1)`,
    [zone, items[name].id, state, state === "pinned" || state === "in" ? relevance : null, role]);
}

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "ezreads");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development'),('pub','EviMed','development')");
  await insertSource(db, "nejm", { owner_entity: "nejm-publisher" });
  await insertSource(db, "lancet", { owner_entity: "lancet-publisher" });
  await insertSource(db, "fda", { lane: "regulatory", source_type: "regulator", owner_entity: "U.S. Food and Drug Administration" });
  await insertSource(db, "newsco", { lane: "evidence", source_type: "news", owner_entity: "newsco-publisher" });
  await insertSource(db, "evimed", { owner_entity: "evimed-platform" });
  await db.query("UPDATE evimed_frontier.sources SET platform_produced = true WHERE id = 'evimed'");

  // ───── events: E1 two institutions report one trial (and the platform's own writing is not a report); E2 one institution twice
  for (const [key, title] of [["e1", "司美格鲁肽心衰试验"], ["e2", "利拉鲁肽试验"]]) {
    events[key] = (await db.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at) VALUES ($1,$2,'evidence',$3,$3) RETURNING id`,
      [`event${key}abcdefgh`, title, ago(1)])).rows[0].id;
  }
  const inEvent = async (/** @type {string} */ name, /** @type {string} */ event, /** @type {string} */ role) => {
    await db.query("UPDATE evimed_frontier.items SET event_id = $2 WHERE id = $1", [items[name].id, events[event]]);
    await db.query("INSERT INTO evimed_frontier.event_items (event_id, item_id, role, joined_by) VALUES ($1,$2,$3,'identifier')", [events[event], items[name].id, role]);
  };

  // ───── the GLP-1 zone's items
  await addItem("g1 semaglutide trial", { age: 2, selected: true, entities: { drugs: ["semaglutide", "tirzepatide"] }, patch: { score_total: 80 } });
  await addItem("g2 trial report", { age: 1, sourceId: "newsco", sourceType: "news", evidenceType: null, patch: { score_total: 40 } });
  await addItem("g2b platform note", { age: 1, sourceId: "evimed", sourceType: "news", evidenceType: null });
  await addItem("g3 guideline", { age: 20, sourceId: "lancet", sourceType: "evidence-body", evidenceType: "guideline" });
  await addItem("g4 older guideline", { age: 100, sourceId: "lancet", sourceType: "evidence-body", evidenceType: "guideline" });
  await addItem("g5 tirzepatide approval", { age: 40, sourceId: "fda", sourceType: "regulator", evidenceType: "regulatory-decision", entities: { drugs: ["tirzepatide"] },
    patch: { track_facts: { kind: "approval", approval: "new-indication", agency: { key: "fda" }, drug: { text: "tirzepatide", quote: "q" }, indication: { text: "肥胖", quote: "q" }, date: { value: "2026-09-20", quote: "q" } } } });
  await addItem("g6 safety notice", { age: 10, sourceId: "fda", sourceType: "regulator", evidenceType: "safety-notice", safetyAlert: true });
  await addItem("g7 older safety notice", { age: 50, sourceId: "fda", sourceType: "regulator", evidenceType: "safety-notice", safetyAlert: true });
  await addItem("g8 liraglutide trial", { age: 5, entities: { drugs: ["liraglutide"] }, patch: { score_total: 55, registry_ids: ["NCT01234567"] } });
  await addItem("g8b same institution", { age: 5, patch: { score_total: 30 } });
  await addItem("g9 meta-analysis", { age: 8, evidenceType: "systematic-review", entities: { drugs: ["orforglipron"] }, patch: { score_total: 65 } });
  await addItem("g10 related only", { age: 0, hours: 1, evidenceType: "observational" });
  await addItem("g11 judged out", { age: 3 });
  await addItem("g12 excluded", { age: 3 });
  await addItem("g13 waiting for the model", { age: 3 });
  await addItem("g14 hidden by alice", { age: 3, patch: { score_total: 70 } });
  await addItem("g15 one policy", { age: 5, sourceId: "fda", sourceType: "regulator", evidenceType: null });
  await addItem("g16 registry trial", { age: 15, evidenceType: null, patch: { genre: "trial", channel: "registry", score_total: 40 } });
  await addItem("g17 pinned study", { age: 4, evidenceType: "observational", patch: { score_total: 60 } });
  await inEvent("g1 semaglutide trial", "e1", "primary");
  await inEvent("g2 trial report", "e1", "report");
  await inEvent("g2b platform note", "e1", "report");
  await inEvent("g8 liraglutide trial", "e2", "primary");
  await inEvent("g8b same institution", "e2", "report");
  await db.query("INSERT INTO evimed_frontier.user_state (user_id, item_id, hidden_at) VALUES ('alice', $1, clock_timestamp())", [items["g14 hidden by alice"].id]);

  // ───── the oncology zone's items: a congress is on (ESMO 2026 ended on 10-27; the zone sees its reports until 14 days after)
  await addItem("o1 esmo report", { age: 2, patch: { genre: "conference" } });
  await addItem("o2 esmo late-breaker", { age: 3, patch: { genre: "conference" } });
  await addItem("o3 esmo old", { age: 40, patch: { genre: "conference" } });
  await addItem("o4 guideline", { age: 30, sourceId: "lancet", sourceType: "evidence-body", evidenceType: "guideline" });
  await addItem("o5 guideline", { age: 31, sourceId: "lancet", sourceType: "evidence-body", evidenceType: "guideline" });
  await addItem("o6 study", { age: 6, patch: { score_total: 70 } });
  await addItem("o7 study", { age: 7, patch: { score_total: 60 } });

  // ───── zones
  const glp1 = definition("drug-indication", [
    { label: "GLP-1 受体激动剂", terms: ["GLP-1 受体激动剂", "semaglutide"], tagIds: [7], entityKeys: ["drug-class:glp1"] }, { label: "减重" }], { group: "肥胖", specialties: ["endocrinology"] });
  await addZone({ id: "ez_glp1", slug: "glp1-obesity", title: "GLP-1 受体激动剂减重", specialties: ["endocrinology"], group: "肥胖", definition: glp1,
    stats: { week: 5, month: 9, all: 14, perWeek: 5, cards: 0, latest: { itemId: items["g10 related only"].publicId, title: "最新", at: ago(0, 1) }, keyLatest: { itemId: items["g6 safety notice"].publicId, title: "重要", at: ago(10) } },
    overview: { text: "近两周，司美格鲁肽的心衰试验公布[1]。", refs: [{ n: 1, itemId: items["g1 semaglutide trial"].publicId }], basis: "x", model: "m", version: 1 }, overviewAt: ago(0, 2) });
  await addZone({ id: "ez_t2d", slug: "glp1-t2d", title: "GLP-1 受体激动剂治疗 2 型糖尿病", specialties: ["endocrinology"], group: "糖尿病", stats: { week: 9, month: 20, all: 40, perWeek: 9, cards: 0 },
    definition: definition("drug-indication", [{ label: "GLP-1 受体激动剂", tagIds: [7] }, { label: "2 型糖尿病" }]) });
  await addZone({ id: "ez_adc", slug: "adc-her2-low", title: "ADC 治疗 HER2 低表达乳腺癌", type: "disease-strategy", specialties: ["oncology"], group: "乳腺癌",
    stats: { week: 3, month: 12, all: 30, perWeek: 3, cards: 0 }, definition: definition("disease-strategy", [{ label: "ADC" }, { label: "HER2 低表达乳腺癌" }]) });
  await addZone({ id: "ez_quiet", slug: "old-topic", title: "一个安静的专区", lifecycle: "quiet", specialties: ["oncology"], group: "乳腺癌", stats: { week: 0, month: 1, all: 8, perWeek: 0, cards: 0 },
    definition: definition("disease-strategy", [{ label: "旧主题" }, { label: "乳腺癌" }]) });
  await addZone({ id: "ez_nospec", title: "没有专科的专区", definition: definition("policy", [{ label: "医保" }, { label: "谈判" }]), type: "policy", stats: { week: 1, month: 1, all: 1, perWeek: 1, cards: 0 } });
  await addZone({ id: "ez_gone", title: "已归档的专区", lifecycle: "archived", specialties: ["endocrinology"], definition: definition("drug-indication", [{ label: "归档" }, { label: "归档主题" }]) });
  await addZone({ id: "ez_product", title: "产品专区", lifecycle: "none" });
  await addZone({ id: "ez_alice_private", title: "我的私有专区", owner: "alice", kind: "user", state: "draft", definition: definition("drug-indication", [{ label: "私有" }, { label: "私有主题" }]), stats: { week: 2, month: 2, all: 2, perWeek: 2, cards: 0 }, updatedAt: ago(0, 3) });
  await addZone({ id: "ez_alice_public", title: "我公开的专区", owner: "alice", kind: "user", definition: definition("drug-indication", [{ label: "GLP-1 受体激动剂", tagIds: [7] }, { label: "公开" }]), updatedAt: ago(0, 4) });
  await addZone({ id: "ez_bob_private", title: "鲍勃的私有专区", owner: "bob", kind: "user", state: "draft", definition: definition("drug-indication", [{ label: "鲍勃私有" }, { label: "鲍勃私有主题" }]) });
  await addZone({ id: "ez_bob_public", title: "鲍勃公开的专区", owner: "bob", kind: "user", definition: definition("drug-indication", [{ label: "鲍勃公开" }, { label: "鲍勃公开主题" }]), stats: { week: 4, month: 4, all: 4, perWeek: 4, cards: 0 } });
  await addZone({ id: "ez_bulk", title: "条目很多的专区", definition: definition("technology-use", [{ label: "很多" }, { label: "条目" }]), type: "technology-use" });
  await db.query("INSERT INTO evimed_frontier.evidence_zone_follows (user_id, zone_id) VALUES ('alice','ez_glp1'), ('alice','ez_bob_public'), ('bob','ez_bob_public'), ('bob','ez_glp1'), ('bob','ez_alice_public')");
  await db.query(`INSERT INTO evimed_frontier.topics (public_id, group_key, title_zh, question_zh, domain, entity_keys, first_seen_at, accepted_at)
    VALUES ('topicglp1abcdefgh', 'g1', '某公众人物使用司美格鲁肽', 'GLP-1 减重药物安全吗？', 'medicine', ARRAY['drug-class:glp1'], clock_timestamp(), clock_timestamp()),
           ('topicother1abcdef', 'g2', '无关话题', '别的问题', 'medicine', ARRAY['drug:other'], clock_timestamp(), clock_timestamp())`);

  for (const [name, state, relevance] of [
    ["g1 semaglutide trial", "in", "core"], ["g2 trial report", "in", "core"], ["g3 guideline", "in", "core"], ["g4 older guideline", "in", "core"],
    ["g5 tirzepatide approval", "in", "core"], ["g6 safety notice", "in", "core"], ["g7 older safety notice", "in", "core"], ["g8 liraglutide trial", "in", "core"],
    ["g9 meta-analysis", "in", "core"], ["g10 related only", "in", "related"], ["g11 judged out", "out", null], ["g12 excluded", "excluded", null],
    ["g13 waiting for the model", "pending", null], ["g14 hidden by alice", "in", "core"], ["g15 one policy", "in", "core"], ["g16 registry trial", "in", "core"],
    ["g17 pinned study", "pinned", null]]) {
    await addMember("ez_glp1", name, { state, relevance });
  }
  for (const name of ["o1 esmo report", "o2 esmo late-breaker", "o3 esmo old", "o4 guideline", "o5 guideline", "o6 study", "o7 study"]) await addMember("ez_adc", name);

  // ───── a zone with more rows than a page
  for (let index = 0; index < 35; index += 1) {
    await addItem(`bulk ${index}`, { age: 1, hours: index, patch: { score_total: index } });
    await addMember("ez_bulk", `bulk ${index}`);
  }

  const service = new FrontierService({ database: db, config, vocabulary: frontierVocabularyView(TEST_VOCABULARY), now: () => NOW });
  reads = createEvidenceZoneReads({ database: db, service, cards: createEvidenceZoneCards({ config }), config, now: () => NOW });
});

after(async () => {
  await db?.close();
  await isolated?.drop();
});

const titles = (/** @type {any[]} */ zones) => zones.map((zone) => zone.title);
const params = (/** @type {Record<string, string>} */ values = {}) => new URLSearchParams(values);
const itemTitles = (/** @type {any[]} */ list) => list.map((item) => item.title);
const moduleOf = (/** @type {any} */ overview, /** @type {string} */ key) => overview.modules.find((/** @type {any} */ module) => module.key === key);

test("the recommended view groups the platform's active zones by specialty and group, busiest first, quiet ones last, and lists nothing else", options, async () => {
  const directory = await reads.directory(alice, params({ view: "recommended" }));
  assert.equal(directory.view, "recommended");
  assert.deepEqual(directory.groups.map((group) => [group.specialty.key, group.specialty.label]), [["endocrinology", "内分泌代谢"], ["oncology", "肿瘤"], ["other", "其他"]]);
  const [endocrinology, oncology, other] = directory.groups;
  assert.deepEqual(endocrinology.sections.map((section) => [section.label, titles(section.zones)]), [
    ["糖尿病", ["GLP-1 受体激动剂治疗 2 型糖尿病"]], ["肥胖", ["GLP-1 受体激动剂减重"]]], "the busier group first");
  assert.deepEqual(oncology.sections.map((section) => [section.label, titles(section.zones)]), [["乳腺癌", ["ADC 治疗 HER2 低表达乳腺癌", "一个安静的专区"]]], "a quiet zone after the active one");
  assert.deepEqual(other.sections.map((section) => [section.label, titles(section.zones)]), [["其他", ["没有专科的专区", "条目很多的专区"]]], "no specialty and no group is filed under 其他, busiest first");
  const everything = directory.groups.flatMap((group) => group.sections.flatMap((section) => titles(section.zones)));
  for (const hidden of ["已归档的专区", "产品专区", "我的私有专区", "我公开的专区", "鲍勃公开的专区", "鲍勃的私有专区"]) assert.ok(!everything.includes(hidden), hidden);
  assert.equal(directory.total, 6);
  assert.deepEqual(directory.zones, []);
  assert.equal(directory.canCreate, true);
  assert.deepEqual(directory.userZones, { count: 2, max: 30 });
  const glp1 = endocrinology.sections[1].zones[0];
  assert.deepEqual({ revision: glp1.revision, owned: glp1.owned, followers: glp1.followers }, { revision: 1, owned: false, followers: 2 }, "what a follow sends back, whether it is the reader's own, who follows it");
  assert.deepEqual({ slug: glp1.slug, type: glp1.type, keywords: glp1.keywords, kind: glp1.kind, published: glp1.published, creator: glp1.creator, following: glp1.following,
    counts: glp1.counts, perWeek: glp1.perWeek, cards: glp1.cards, lifecycle: glp1.lifecycle, specialties: glp1.specialties, group: glp1.group }, {
    slug: "glp1-obesity", type: "drug-indication", keywords: ["GLP-1 受体激动剂", "减重"], kind: "official", published: true, creator: EVIDENCE_PLATFORM_PRODUCER_NAME, following: true,
    counts: { week: 5, month: 9, all: 14 }, perWeek: 5, cards: 0, lifecycle: "active", specialties: [{ key: "endocrinology", label: "内分泌代谢" }], group: "肥胖" });
  assert.equal(glp1.latest?.title, "重要", "the latest important update stands before the latest item");
  assert.equal(directory.groups[0].sections[0].zones[0].following, false);
  // The default view is the recommended one, and Bob follows the same zone from another account.
  assert.equal((await reads.directory(bob, params())).view, "recommended");
});

test("a search reads titles, keyword labels and groups; a specialty narrows; a word nobody wrote is a 400", options, async () => {
  const flat = async (/** @type {Record<string, string>} */ query) => (await reads.directory(alice, params({ view: "recommended", ...query }))).groups.flatMap((group) => group.sections.flatMap((section) => titles(section.zones)));
  assert.deepEqual(await flat({ q: "减重" }), ["GLP-1 受体激动剂减重"], "a keyword label");
  assert.deepEqual(await flat({ q: "adc" }), ["ADC 治疗 HER2 低表达乳腺癌"], "case-folded");
  assert.deepEqual((await flat({ q: "乳腺癌" })).sort(), ["ADC 治疗 HER2 低表达乳腺癌", "一个安静的专区"].sort(), "a group, and a keyword label of the quiet zone");
  assert.deepEqual(await flat({ q: "糖尿病" }), ["GLP-1 受体激动剂治疗 2 型糖尿病"]);
  assert.deepEqual(await flat({ specialty: "oncology" }), ["ADC 治疗 HER2 低表达乳腺癌", "一个安静的专区"]);
  assert.deepEqual(await flat({ q: "不存在的词" }), []);
  await assert.rejects(reads.directory(alice, params({ specialty: "astrology" })), (error) => error.status === 400 && error.code === "evidence_query_invalid");
  await assert.rejects(reads.directory(alice, params({ view: "everyone" })), (error) => error.status === 400);
  await assert.rejects(reads.directory(alice, params({ q: "x".repeat(201) })), (error) => error.status === 400);
});

test("mine is the reader's own zones in any state, then the zones followed; community is other readers' published zones — and a private zone is in no view but its owner's", options, async () => {
  const mine = await reads.directory(alice, params({ view: "mine" }));
  assert.deepEqual(titles(mine.zones), ["我的私有专区", "我公开的专区", "GLP-1 受体激动剂减重", "鲍勃公开的专区"], "own first (newest edit first), then followed by activity");
  assert.deepEqual(mine.zones.map((zone) => zone.published), [false, true, true, true]);
  assert.deepEqual(mine.zones.map((zone) => zone.owned), [true, true, false, false], "owned is the reader's own user zone: not a followed platform zone, not another reader's");
  assert.deepEqual(mine.zones.map((zone) => zone.followers), [0, 1, 2, 2]);
  assert.ok(mine.zones.every((zone) => zone.revision === 1));
  assert.deepEqual(mine.groups, []);
  const community = await reads.directory(alice, params({ view: "community" }));
  assert.deepEqual(titles(community.zones), ["鲍勃公开的专区"], "not her own, not Bob's private one, not the platform's");
  assert.deepEqual(community.zones.map((zone) => [zone.owned, zone.followers]), [[false, 2]]);
  const bobs = await reads.directory(bob, params({ view: "community" }));
  assert.deepEqual(titles(bobs.zones), ["我公开的专区"], "Alice's private zone never appears to Bob, and Bob's own is not his community's");
  const bobMine = await reads.directory(bob, params({ view: "mine" }));
  assert.deepEqual(titles(bobMine.zones), ["鲍勃的私有专区", "鲍勃公开的专区", "GLP-1 受体激动剂减重", "我公开的专区"], "his own, then what he follows — Alice's published zone, not her private one");
  assert.ok(!titles(bobMine.zones).includes("我的私有专区"));
  assert.deepEqual(bobMine.userZones, { count: 2, max: 30 });
});

test("a zone's detail names the zones that took over from an archived one, and when its newest item came out", options, async () => {
  // An archived zone points at what replaced it: a merge's survivor, a split's pieces, and through a zone that was archived in its turn.
  await addZone({ id: "ez_split_old", title: "拆开的专区", lifecycle: "archived", specialties: ["endocrinology"], definition: definition("drug-indication", [{ label: "拆开" }, { label: "拆开主题" }]) });
  await addZone({ id: "ez_merged_old", title: "并入拆开专区的专区", lifecycle: "archived", definition: definition("drug-indication", [{ label: "并入" }, { label: "并入主题" }]) });
  await addZone({ id: "ez_bob_gone", title: "鲍勃私有的已归档专区", owner: "bob", kind: "user", state: "draft", lifecycle: "archived", definition: definition("drug-indication", [{ label: "鲍勃归档" }, { label: "鲍勃归档主题" }]) });
  await db.query(`INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail) VALUES
    ('ez_split_old', 'split', 'planner', '{"into":["ez_t2d","ez_adc","ez_bob_gone","ez_missing"]}'),
    ('ez_merged_old', 'merged', 'planner', '{"into":"ez_split_old"}'),
    ('ez_gone', 'merged', 'planner', '{"into":"ez_glp1"}')`);
  const successorsOf = async (ref, user = alice) => (await reads.detail(user, ref)).zone.successors;
  assert.deepEqual(await successorsOf("ez_gone"), [{ id: "ez_glp1", slug: "glp1-obesity", title: "GLP-1 受体激动剂减重" }], "a merge's survivor");
  assert.deepEqual((await successorsOf("ez_split_old")).map((zone) => zone.id).sort(), ["ez_adc", "ez_t2d"], "a split's pieces; one that is another reader's private zone or gone is left out");
  assert.deepEqual((await successorsOf("ez_merged_old")).map((zone) => zone.id).sort(), ["ez_adc", "ez_t2d"], "a successor archived in its turn is replaced by its own");
  assert.deepEqual(await successorsOf("ez_glp1"), [], "a zone that is still collecting has none");
  assert.deepEqual(await successorsOf("ez_quiet"), [], "nor has a quiet one");
  assert.deepEqual(await successorsOf("ez_bob_gone", bob), [], "an archived zone nothing took over from names none");
  // The newest item of a zone, in or pinned, by the date the page dates it at (the related one of an hour ago is the newest here).
  assert.equal((await reads.detail(alice, "ez_glp1")).zone.lastItemAt, ago(0, 1));
  assert.equal((await reads.detail(alice, "ez_gone")).zone.lastItemAt, null, "a zone with no items has no date");
  assert.deepEqual(Object.keys((await reads.detail(alice, "ez_quiet")).zone).filter((key) => ["successors", "lastItemAt"].includes(key)).sort(), ["lastItemAt", "successors"], "always present");
});

test("a zone's detail is a topic zone's: its definition only to its owner, edit rights by kind, a band, the related zones the reader may see", options, async () => {
  const platform = (await reads.detail(alice, "glp1-obesity")).zone;
  assert.equal(platform.id, "ez_glp1");
  assert.equal(platform.definition, null, "a platform zone's recipe is not served to readers");
  assert.equal(platform.canEdit, false);
  assert.equal(platform.canDelete, false);
  assert.equal(platform.band, "normal");
  assert.equal(platform.revision, 1);
  assert.ok(Number.isFinite(Date.parse(platform.overviewAt)));
  assert.deepEqual((await reads.detail(alice, "ez_glp1")).feedback, []);
  // Related: a shared keyword label (the diabetes zone), a shared tag (the readers' zones), seen through the reader's own eyes.
  assert.deepEqual(titles(platform.related).sort(), ["GLP-1 受体激动剂治疗 2 型糖尿病", "我公开的专区"].sort(), "Alice sees her own public zone; the platform's other zones with no common keyword stay out");
  assert.deepEqual(platform.related.map((zone) => [zone.title, zone.owned]).sort(), [["GLP-1 受体激动剂治疗 2 型糖尿病", false], ["我公开的专区", true]], "a related zone of her own says so");
  assert.deepEqual([platform.revision, platform.owned, platform.followers], [1, false, 2]);
  const forBob = (await reads.detail(bob, "ez_glp1")).zone;
  assert.deepEqual(titles(forBob.related).sort(), ["GLP-1 受体激动剂治疗 2 型糖尿病", "我公开的专区"].sort());
  const own = (await reads.detail(alice, "ez_alice_public")).zone;
  assert.equal(own.owned, true);
  assert.equal(own.canEdit, true);
  assert.equal(own.canDelete, true);
  assert.deepEqual(own.definition.keywords.map((keyword) => keyword.label), ["GLP-1 受体激动剂", "公开"]);
  assert.equal("tagIds" in own.definition.keywords[0], false, "the ids a keyword resolved to are the platform's");
  assert.deepEqual(titles((await reads.detail(alice, "ez_alice_private")).zone.related), []);
  assert.equal((await reads.detail(bob, "ez_alice_public")).zone.definition, null, "another reader sees a published zone without its recipe");
  // A zone that is not a topic zone, or not the reader's to see, is not answered here at all.
  assert.equal(await reads.detail(alice, "ez_product"), null);
  assert.equal(await reads.detail(bob, "ez_alice_private"), null);
  assert.equal(await reads.detail(alice, "no-such-zone"), null);
  assert.equal(await reads.detail(alice, "has a space"), null);
  assert.deepEqual(await reads.resolveZone(bob, "glp1-obesity"), { id: "ez_glp1", slug: "glp1-obesity", title: "GLP-1 受体激动剂减重" });
  assert.equal(await reads.resolveZone(bob, "ez_alice_private"), null);
  assert.deepEqual(titles(await reads.summaries(bob, ["ez_adc", "ez_alice_private", "ez_product", "ez_glp1", "ez_adc", "has a space"])), ["ADC 治疗 HER2 低表达乳腺癌", "GLP-1 受体激动剂减重"],
    "the order asked, once each, the zones Bob may see, topic zones only");
  assert.deepEqual((await reads.summaries(bob, ["ez_alice_public", "ez_bob_public"])).map((zone) => [zone.id, zone.owned, zone.followers, zone.revision]), [["ez_alice_public", false, 1, 1], ["ez_bob_public", true, 2, 1]],
    "owned is relative to the reader asking");
  assert.deepEqual(await reads.summaries(bob, []), []);
  assert.equal(await reads.resolveId(alice, "glp1-obesity"), "ez_glp1");
  assert.equal(await reads.resolveId(alice, "ez_glp1"), "ez_glp1");
  assert.equal(await reads.resolveId(bob, "ez_alice_private"), "ez_alice_private", "an address the reader cannot see comes back as asked, for the service to refuse");
});

test("the overview of a drug zone is its modules in the drug order, each with its own window and minimum", options, async () => {
  const overview = await reads.overview(alice, "glp1-obesity");
  assert.equal(overview.zoneId, "ez_glp1");
  assert.equal(overview.type, "drug-indication");
  assert.deepEqual(overview.modules.map((module) => module.key), ["progress", "key-updates", "approved-drugs", "guidelines", "key-studies", "safety", "trials", "multi-source", "latest"],
    "no cards (none), no policy (one item), no industry or congress (none), and the drug order puts the approved drugs before the guidelines");

  const progress = moduleOf(overview, "progress").progress;
  assert.equal(progress.text, "近两周，司美格鲁肽的心衰试验公布[1]。");
  assert.deepEqual(progress.refs, [{ n: 1, itemId: items["g1 semaglutide trial"].publicId, title: "g1 semaglutide trial", sourceName: "NEJM Journal" }]);
  assert.ok(Number.isFinite(Date.parse(progress.at)));

  assert.deepEqual(itemTitles(moduleOf(overview, "key-updates").items), ["g6 safety notice", "g3 guideline"], "30 days: the safety notice and the guideline, newest first; the approval is 40 days old");
  assert.deepEqual(moduleOf(overview, "key-updates").more, { role: null, window: "30d" });
  assert.deepEqual(itemTitles(moduleOf(overview, "guidelines").items), ["g3 guideline", "g4 older guideline"], "180 days");
  assert.deepEqual(moduleOf(overview, "guidelines").more, { role: "guideline", window: "all" });
  assert.deepEqual(itemTitles(moduleOf(overview, "key-studies").items), ["g1 semaglutide trial", "g9 meta-analysis", "g8 liraglutide trial", "g17 pinned study", "g16 registry trial"],
    "randomised trials and meta-analyses first, then by score; a pinned row counts as core; Alice's hidden study is gone");
  assert.deepEqual(itemTitles(moduleOf(overview, "safety").items), ["g6 safety notice", "g7 older safety notice"], "90 days");
  assert.deepEqual(itemTitles(moduleOf(overview, "trials").items), ["g8 liraglutide trial", "g16 registry trial"], "a registry number, or the trial genre");
  assert.ok(!itemTitles(moduleOf(overview, "key-studies").items).includes("g10 related only"), "a related row stays out of every module but the latest");
  const latest = itemTitles(moduleOf(overview, "latest").items);
  assert.equal(latest[0], "g10 related only", "the latest list holds related rows too, newest first");
  assert.ok(latest.includes("g1 semaglutide trial") && !latest.includes("g2 trial report"), "one row per event: the trial and its report are one line, the selected item");
  for (const absent of ["g11 judged out", "g12 excluded", "g13 waiting for the model", "g14 hidden by alice"]) assert.ok(!latest.includes(absent), absent);
  assert.ok(latest.length <= 10);
  assert.deepEqual(moduleOf(overview, "latest").more, { role: null, window: "all" });
  // Everything a module shows is the feed's own card with this reader's marks.
  const first = moduleOf(overview, "guidelines").items[0];
  assert.equal(first.id, items["g3 guideline"].publicId);
  assert.deepEqual(first.state, { starred: false, hidden: false, read: false });
  assert.equal(first.genre, "guideline");

  const forBob = await reads.overview(bob, "ez_glp1");
  assert.ok(itemTitles(moduleOf(forBob, "key-studies").items).includes("g14 hidden by alice"), "the hidden study is Alice's alone");
});

test("approved drugs are the drugs the zone names with their latest approval and best study; a multi-source module counts institutions, not the platform's own writing", options, async () => {
  const overview = await reads.overview(alice, "glp1-obesity");
  const drugs = moduleOf(overview, "approved-drugs").rows;
  assert.deepEqual(drugs.map((row) => row.label), ["tirzepatide", "liraglutide", "orforglipron", "semaglutide"], "the one with an approval first, then by the month's items");
  assert.deepEqual(drugs[0], {
    label: "tirzepatide", key: "tirzepatide", count30: 1,
    approval: { agency: "FDA", date: "2026-09-20", kind: "新增适应症", itemId: items["g5 tirzepatide approval"].publicId },
    study: { itemId: items["g1 semaglutide trial"].publicId, title: "g1 semaglutide trial" },
  });
  assert.equal(drugs[1].approval, null);
  assert.equal(drugs[1].study.itemId, items["g8 liraglutide trial"].publicId);
  const multi = moduleOf(overview, "multi-source").events;
  assert.deepEqual(multi, [{ eventId: "evente1abcdefgh", title: "司美格鲁肽心衰试验", reports: 2, hasPrimary: true, lastAt: multi[0].lastAt, itemId: items["g1 semaglutide trial"].publicId }],
    "two institutions report E1 (the platform's note is not a third); E2 has one institution, however many reports");
});

test("the side panel: related zones, the month's most named entities, twelve Monday weeks, the hot topics on its entities and the congresses of its specialty", options, async () => {
  const { side } = await reads.overview(alice, "glp1-obesity");
  assert.deepEqual(titles(side.related).sort(), ["GLP-1 受体激动剂治疗 2 型糖尿病", "我公开的专区"].sort());
  assert.deepEqual(side.entities.drugs.map((entry) => [entry.label, entry.key, entry.count]), [["liraglutide", "liraglutide", 1], ["orforglipron", "orforglipron", 1], ["semaglutide", "semaglutide", 1], ["tirzepatide", "tirzepatide", 1]],
    "30 days: the approval of 40 days ago is not counted");
  assert.deepEqual(side.entities.diseases, []);
  assert.equal(side.weekly.length, 12);
  assert.equal(side.weekly[0].weekStart, "2026-08-10");
  assert.equal(side.weekly[11].weekStart, "2026-10-26", "Thursday 29 October 2026 is in the week of Monday the 26th");
  assert.equal(side.weekly[11].count, 2, "the related item of an hour ago, and the trial with its report (one event); Alice's hidden study was 3 days ago");
  assert.equal((await reads.overview(bob, "ez_glp1")).side.weekly[11].count, 3);
  assert.deepEqual(side.topics, [{ id: "topicglp1abcdefgh", title: "某公众人物使用司美格鲁肽" }], "only the topic about the zone's entity");
  assert.deepEqual(side.congresses.map((congress) => congress.id), ["cds-2026"], "the endocrinology congress that opens within 30 days");
});

test("a weekly bar counts an item in the week it was published, the instant the list dates it at, not the week the zone collected it", options, async () => {
  await addZone({ id: "ez_weekly", title: "按发表时间计周的专区", definition: definition("drug-indication", [{ label: "周" }, { label: "发表" }]) });
  // Collected this week (visible_at today), published nine weeks ago and five days ago: the bars of those weeks, not this one's.
  await addItem("w1 collected now, published long ago", { age: 0, hours: 2, patch: {} });
  await addItem("w2 collected now, published last week", { age: 0, hours: 3, patch: {} });
  await addItem("w3 published this week", { age: 0, hours: 4, patch: {} });
  await db.query("UPDATE evimed_frontier.items SET timeline_at = $2 WHERE id = $1", [items["w1 collected now, published long ago"].id, ago(63)]);
  await db.query("UPDATE evimed_frontier.items SET timeline_at = $2 WHERE id = $1", [items["w2 collected now, published last week"].id, ago(5)]);
  for (const name of ["w1 collected now, published long ago", "w2 collected now, published last week", "w3 published this week"]) await addMember("ez_weekly", name);
  const weekly = (await reads.overview(alice, "ez_weekly")).side.weekly;
  const countOf = (/** @type {string} */ weekStart) => weekly.find((week) => week.weekStart === weekStart)?.count;
  assert.equal(countOf("2026-10-26"), 1, "this week holds only what was published this week");
  assert.equal(countOf("2026-10-19"), 1, "an item published five days ago is last week's");
  assert.equal(countOf("2026-08-24"), 1, "an item published nine weeks ago is that week's, though it arrived today");
  assert.equal(weekly.reduce((sum, week) => sum + week.count, 0), 3);
});

test("a disease zone has its own order, and a congress module appears only while a congress of its specialty is on", options, async () => {
  const overview = await reads.overview(alice, "adc-her2-low");
  assert.deepEqual(overview.modules.map((module) => module.key), ["key-updates", "guidelines", "key-studies", "congress", "latest"],
    "the guidelines lead a disease zone, before the studies; approved drugs, safety and the rest have nothing to show");
  assert.deepEqual(itemTitles(moduleOf(overview, "key-updates").items), ["o4 guideline"], "a guideline of exactly 30 days is still in the month; one of 31 is not");
  assert.deepEqual(itemTitles(moduleOf(overview, "congress").items), ["o1 esmo report", "o2 esmo late-breaker"], "ESMO's days and the two weeks after; the report of 40 days ago is outside them");
  assert.deepEqual(moduleOf(overview, "congress").more, { role: "conference", window: "30d" });
  assert.deepEqual(overview.side.congresses.map((congress) => congress.id), ["caca-cchio-2026"], "ESMO has ended; the next oncology congress is within 30 days");
  const policy = await reads.overview(alice, "ez_nospec");
  assert.deepEqual(policy.modules.map((module) => module.key), ["latest"], "a zone with nothing to show still has its latest list, empty");
  assert.deepEqual(moduleOf(policy, "latest").items, []);
});

test("another reader's private zone and a zone that is not a topic zone answer 404 in every read; a reader's own does not", options, async () => {
  for (const read of [() => reads.overview(bob, "ez_alice_private"), () => reads.items(bob, "ez_alice_private", params()), () => reads.cards(bob, "ez_alice_private"),
    () => reads.overview(alice, "ez_product"), () => reads.items(alice, "ez_product", params()), () => reads.cards(alice, "ez_product"), () => reads.overview(alice, "unknown")]) {
    await assert.rejects(read(), (error) => error.status === 404 && error.code === "evidence_not_found");
  }
  assert.equal((await reads.overview(alice, "ez_alice_private")).zoneId, "ez_alice_private");
  assert.equal((await reads.items(alice, "ez_alice_private", params())).total, 0);
});

test("the 「动态」 list: one row per event, newest first, with the window's tab counts and the filters", options, async () => {
  const all = await reads.items(alice, "glp1-obesity", params());
  assert.deepEqual(itemTitles(all.items), ["g10 related only", "g1 semaglutide trial", "g17 pinned study", "g15 one policy", "g8 liraglutide trial", "g9 meta-analysis", "g6 safety notice",
    "g16 registry trial", "g3 guideline", "g5 tirzepatide approval", "g7 older safety notice", "g4 older guideline"],
  "newest first by the feed's own axis (two items of the same instant by id); the trial and its report are one row, the selected one; the out, excluded, pending and hidden are not rows");
  assert.equal(all.total, 12);
  assert.equal(all.nextCursor, null);
  assert.deepEqual(all.roleCounts, { research: 6, guideline: 2, approval: 1, safety: 2, policy: 1, news: 1 }, "distinct events per role; a role with none is absent");

  const guidelines = await reads.items(alice, "glp1-obesity", params({ role: "guideline" }));
  assert.deepEqual(itemTitles(guidelines.items), ["g3 guideline", "g4 older guideline"]);
  assert.equal(guidelines.total, 2);
  assert.deepEqual(guidelines.roleCounts, all.roleCounts, "the tabs keep their numbers while one is open");

  const week = await reads.items(alice, "glp1-obesity", params({ window: "7d" }));
  assert.deepEqual(itemTitles(week.items), ["g10 related only", "g1 semaglutide trial", "g17 pinned study", "g15 one policy", "g8 liraglutide trial"]);
  assert.equal(week.total, 5);
  assert.deepEqual(week.roleCounts, { research: 4, policy: 1, news: 1 }, "a week: four research events, the policy item, and the trial's report");

  const picked = await reads.items(alice, "glp1-obesity", params({ picked: "1" }));
  assert.deepEqual(itemTitles(picked.items), ["g1 semaglutide trial", "g9 meta-analysis", "g6 safety notice", "g3 guideline", "g5 tirzepatide approval", "g7 older safety notice", "g4 older guideline"],
    "the editors' pick (g1), a score at the selection line of 64 (g9 has 65; g17 60 and g8 55 do not), or a key update by kind (guideline, approval, safety)");
  assert.ok(!itemTitles(picked.items).includes("g10 related only"));

  const searched = await reads.items(alice, "glp1-obesity", params({ q: "guideline" }));
  assert.deepEqual(itemTitles(searched.items).sort(), ["g3 guideline", "g4 older guideline"]);
  const forBob = await reads.items(bob, "glp1-obesity", params({ role: "research", window: "7d" }));
  assert.ok(itemTitles(forBob.items).includes("g14 hidden by alice"));
  assert.ok(!itemTitles((await reads.items(alice, "glp1-obesity", params({ role: "research" }))).items).includes("g14 hidden by alice"));

  for (const bad of [{ role: "rumour" }, { window: "1y" }, { picked: "yes" }, { q: "x".repeat(201) }]) {
    await assert.rejects(reads.items(alice, "glp1-obesity", params(bad)), (error) => error.status === 400 && error.code === "evidence_query_invalid", JSON.stringify(bad));
  }
});

test("the list pages by (timeline, id): thirty a page, no row twice, and a cursor belongs to its own filters", options, async () => {
  const first = await reads.items(alice, "ez_bulk", params());
  assert.equal(first.items.length, 30);
  assert.equal(first.total, 35);
  assert.ok(first.nextCursor);
  const second = await reads.items(alice, "ez_bulk", params({ cursor: first.nextCursor }));
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, null);
  const seen = new Set([...first.items, ...second.items].map((item) => item.id));
  assert.equal(seen.size, 35, "every row once");
  assert.deepEqual(itemTitles(first.items).slice(0, 2), ["bulk 0", "bulk 1"], "newest first: bulk 0 is the freshest");
  await assert.rejects(reads.items(alice, "ez_bulk", params({ cursor: first.nextCursor, role: "research" })), (error) => error.status === 409 && error.code === "evidence_cursor_invalid");
  await assert.rejects(reads.items(alice, "ez_bulk", params({ cursor: "not-a-cursor" })), (error) => error.status === 409);
  const narrowed = await reads.items(alice, "ez_bulk", params({ role: "research", window: "7d" }));
  assert.equal(narrowed.items.length, 30);
  const next = await reads.items(alice, "ez_bulk", params({ role: "research", window: "7d", cursor: narrowed.nextCursor }));
  assert.equal(next.items.length, 5);
});

test("cards come through the port: none today, the adapter's when the team's interface is connected", options, async () => {
  assert.deepEqual(await reads.cards(alice, "glp1-obesity"), { cards: [], provider: "none" });
  const card = { provider: "team", id: "card-1", version: "3", updatedAt: null, status: "current", title: "GLP-1 减重的结论", conclusion: "有效", certainty: null,
    producer: { name: "团队", kind: "team" }, sourceCount: 4, detail: { kind: "link", url: "https://example.org/card-1" } };
  /** @type {any[]} */ const asked = [];
  const external = { async list(zone, request) { asked.push([zone.id, zone.slug, request]); return [card, { id: "", title: "no id" }]; } };
  const service = new FrontierService({ database: db, config, vocabulary: frontierVocabularyView(TEST_VOCABULARY), now: () => NOW });
  const connected = createEvidenceZoneReads({ database: db, service, config: { ...config, evidenceCardProvider: "external" }, now: () => NOW,
    cards: createEvidenceZoneCards({ config: { evidenceCardProvider: "external" }, external }) });
  assert.deepEqual((await connected.cards(alice, "ez_glp1")).cards, [card], "a card without an id is not one");
  assert.equal((await connected.cards(alice, "ez_glp1")).provider, "external");
  assert.deepEqual(asked[0], ["ez_glp1", "glp1-obesity", { limit: 50 }]);
  const overview = await connected.overview(alice, "ez_glp1");
  assert.deepEqual(overview.modules.slice(0, 2).map((module) => module.key), ["progress", "cards"], "the card module follows 最新进展 in the drug order");
  assert.equal(moduleOf(overview, "cards").total, 1);
  assert.deepEqual(asked.at(-1)[2], { limit: 3 });
});
