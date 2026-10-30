// The topic zones' membership against a real PostgreSQL: the real recall SQL, the real FrontierEditor (its checks and its rewrite)
// over a model that is a function of what it was shown, the real tag store; the entity vocabulary and the embedder are fakes.
// Proved here: every candidate is judged, all-keyword recall and the legs, excluded names, backfill and a definition change that
// keeps the old rows until the new judgement replaces them, overrides left alone, feedback, the zones an item stands in, the
// preview, the stats and 「最新进展」 (when it is written, what it cites, when it comes down).
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { normalizeEvidenceZoneDefinition } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneMembership, ZONE_JUDGE, ZONE_RECALL, zoneProgressBasis } from "../src/evidenceZoneMembership.mjs";
import { FrontierEditor } from "../src/frontierEditor.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierTagStore } from "../src/frontierTags.mjs";
import { insertSource } from "./helpers/frontierFixtures.mjs";
import { TEST_DIMENSION, TEST_MODEL_KEY, insertComposedItem, vectorAt } from "./helpers/frontierComposeFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const NOW = new Date("2026-10-29T12:00:00Z");
const hoursAgo = (/** @type {number} */ hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const minutes = (/** @type {number} */ n) => n * 60_000;

/** @type {any} */ let db;
/** @type {any} */ let isolated;
/** @type {Date} */ let clock;
/** @type {{ judge: string[], progress: string[] }} */ let calls;
/** @type {(item: string, zone: string) => string | null} */ let judgeRule;
/** @type {(user: string, round: number) => string} */ let progressRule;
/** @type {"ok" | "exhausted"} */ let budgetState;
/** @type {Error | null} */ let judgeFailure;
/** Run once, inside the next judge call after its answer is fixed and before it is returned: the owner saves while the call is out. @type {(() => Promise<void>) | null} */ let duringJudge;
/** @type {any} */ let tags;
const fakeEntities = {
  /** @param {{ texts: string[] }} input */
  async keysForText({ texts }) {
    const keys = [];
    for (const text of texts) {
      if (text.includes("司美格鲁肽") || text.toLowerCase().includes("semaglutide")) keys.push("drug:semaglutide");
      if (text.includes("测试实体词")) keys.push("drug:ez-test");
      if (text.includes("乳腺癌")) keys.push("disease:breast cancer");
    }
    return keys;
  },
};
const embedder = Object.freeze({ configured: true, modelKey: TEST_MODEL_KEY, dimension: TEST_DIMENSION, embedQuery: async () => vectorAt(1.0) });

const PROGRESS = "司美格鲁肽在肥胖成人中的随机对照试验显示，68 周后体重下降 15%[1]。口服剂型的另一项研究报告了相近的体重变化，并给出了停药后的随访结果[2]。监管机构更新了该类药物的标签，补充了胃肠道不良反应的描述[3]。另有一项队列研究分析了真实世界中的使用情况，随访数据与上述试验方向一致[1]。";

/** The model: a function of what it was shown. A judge call is answered by `judgeRule` for every (item title, zone title) it asked about. */
async function callModel(_deps, call) {
  const messages = call.body.messages;
  const system = messages[0].content;
  const user = messages[1].content;
  const reply = (/** @type {unknown} */ content) => ({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  if (system.includes("归入「证据专区」")) {
    calls.judge.push(user);
    if (judgeFailure) throw judgeFailure;
    const zones = new Map([...user.matchAll(/^(Z\d+)｜(.+)$/gm)].map((match) => [match[1], match[2]]));
    const judgements = [];
    const blocks = user.split("【条目】")[1] ?? "";
    for (const block of blocks.split(/\n(?=\[\d+\] )/)) {
      const head = block.match(/^\[(\d+)\] [^｜]*｜[^｜]*｜[^｜]*｜(.+)$/m);
      const candidates = block.match(/候选专区：(.+)$/m);
      if (!head || !candidates) continue;
      for (const label of candidates[1].split("、")) {
        const verdict = judgeRule(head[2], /** @type {string} */ (zones.get(label)));
        if (verdict) judgements.push({ item: Number(head[1]), zone: label, verdict });
      }
    }
    if (duringJudge) {
      const run = duringJudge;
      duringJudge = null;
      await run();
    }
    return reply({ judgements });
  }
  if (system.includes("最新进展")) {
    calls.progress.push(user);
    return reply({ overview_zh: progressRule(user, messages.length) });
  }
  throw new Error(`unexpected model call: ${system.slice(0, 40)}`);
}

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "ezm");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: TEST_DIMENSION });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('publisher','Publisher','development'),('alice','Alice','development'),('bob','Bob','development')");
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("DELETE FROM evimed_frontier.zone_changes");
  await db.query("DELETE FROM evimed_frontier.evidence_zones");
  await db.query("DELETE FROM evimed_frontier.item_tags");
  await db.query("DELETE FROM evimed_frontier.tags WHERE slug LIKE 'ezt-%'");
  await db.query("DELETE FROM evimed_frontier.items");
  await db.query("DELETE FROM evimed_frontier.sources");
  await insertSource(db, "nejm", { name: "NEJM" });
  await insertSource(db, "off", { name: "Off", enabled: false });
  clock = new Date(NOW);
  calls = { judge: [], progress: [] };
  judgeRule = (item) => (item.startsWith("CORE") ? "core" : item.startsWith("REL") ? "related" : "out");
  progressRule = () => PROGRESS;
  budgetState = "ok";
  judgeFailure = null;
  duringJudge = null;
  tags = new FrontierTagStore({ database: db });
});

/** @param {{ embedder?: any, entities?: any, budget?: any, config?: Record<string, any> }} [overrides] */
function makeMembership({ embedder: useEmbedder = null, entities = fakeEntities, budget = async () => ({ state: budgetState }), config = {} } = {}) {
  const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: "test-key", frontierTimeZone: "Asia/Shanghai" },
    { callModel, owner: { userId: "publisher", projectId: "evimed-frontier" } });
  return new EvidenceZoneMembership({ database: db, editor, embedder: useEmbedder, tags, entities, budget, config: { kbEmbeddingDimension: TEST_DIMENSION, frontierTimeZone: "Asia/Shanghai", ...config }, now: () => clock });
}

/** @param {string} slug @param {string} name @param {Record<string, any>} [more] */
async function tag(slug, name, more = {}) {
  const row = (await db.query(`INSERT INTO evimed_frontier.tags (slug, name, name_en, kind, state, broader_id, merged_into, origin)
    VALUES ($1, $2, $3, 'concept', $4, $5, $6, 'seed') RETURNING id`, [`ezt-${slug}`, name, more.nameEn ?? null, more.state ?? "active", more.broaderId ?? null, more.mergedInto ?? null])).rows[0];
  tags.invalidate();
  return Number(row.id);
}

/** @param {Record<string, any>} [more] */
const glp = (more = {}) => ({ label: "GLP-1 受体激动剂", terms: ["semaglutide", "tirzepatide"], tagIds: [], entityKeys: [], ...more });
/** @param {Record<string, any>} [more] */
const obesity = (more = {}) => ({ label: "减重", terms: ["obesity", "weight loss"], tagIds: [], entityKeys: [], ...more });

/** @param {Record<string, any>} [overrides] */
function zoneDefinition(overrides = {}) {
  const { definition, issues } = normalizeEvidenceZoneDefinition({ type: "drug-indication", keywords: [glp(), obesity()], scope: "GLP-1 类药物用于减重",
    include: "纳入减重适应症的研究", exclude: "不含只讲降糖的研究", excludeTerms: [], specialties: ["endocrinology"], group: "肥胖", seeds: { positive: [], negative: [] }, ...overrides });
  assert.deepEqual(issues, []);
  return definition;
}

/** @param {{ id?: string, userId?: string, kind?: string, title?: string, definition?: any, lifecycle?: string, state?: string, version?: number, backfilled?: number }} [zone] */
async function createZone({ id = "ez_g", userId = "publisher", kind = "official", title = "GLP-1 受体激动剂减重", definition = zoneDefinition(), lifecycle = "active", state = "published", version = 1, backfilled = 0 } = {}) {
  await db.query(`INSERT INTO evimed_frontier.evidence_zones (id, user_id, title, state, kind, lifecycle, zone_type, definition, definition_version, backfilled_version, scope_zh)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
  [id, userId, title, state, kind, lifecycle, definition.type, JSON.stringify(definition), version, backfilled, definition.scope]);
  return id;
}

/** @param {string} title @param {Record<string, any>} [more] */
async function item(title, { hours = 3, titleZh = null, summaryZh = null, tagIds = [], entityKeys = [], vector = null, genre = "paper", eventId = null, flags = [], lead = null, sourceId = "nejm", more = {} } = {}) {
  const row = await insertComposedItem(db, { title, titleZh, summaryZh, entityKeys, vector, sourceId, visibleAt: hoursAgo(hours), timelineAt: hoursAgo(hours), publishedAt: hoursAgo(hours), ...more });
  await db.query("UPDATE evimed_frontier.items SET genre = $2, event_id = $3, flags = $4, lead_zh = $5 WHERE id = $1", [row.id, genre, eventId, flags, lead]);
  for (const [rank, tagId] of tagIds.entries()) await db.query("INSERT INTO evimed_frontier.item_tags (item_id, tag_id, rank, origin) VALUES ($1, $2, $3, 'edit')", [row.id, tagId, rank]);
  return row;
}

/** The zone's rows by the item's public id. @param {string} [zoneId] */
async function rows(zoneId = "ez_g") {
  const result = await db.query(`SELECT i.public_id, i.title_raw, zi.state, zi.relevance, zi.via, zi.role, zi.definition_version, zi.attempts, zi.decided_by
    FROM evimed_frontier.zone_items zi JOIN evimed_frontier.items i ON i.id = zi.item_id WHERE zi.zone_id = $1`, [zoneId]);
  return new Map(result.rows.map((/** @type {any} */ row) => [row.title_raw, row]));
}
const zoneRow = async (/** @type {string} */ id = "ez_g") => (await db.query("SELECT * FROM evimed_frontier.evidence_zones WHERE id = $1", [id])).rows[0];

test("a new zone is backfilled, every candidate is judged by the model, and the legs say who offered what", options, async () => {
  const glpTag = await tag("glp", "GLP-1 受体激动剂");
  const obeseTag = await tag("obese", "肥胖");
  await createZone({ definition: zoneDefinition({ keywords: [glp({ tagIds: [glpTag], entityKeys: ["drug:semaglutide"] }), obesity({ tagIds: [obeseTag] })] }) });
  await item("CORE A tags on both", { tagIds: [glpTag, obeseTag] });
  await item("REL B entity and words", { entityKeys: ["drug:semaglutide"], summaryZh: "obesity outcomes" });
  await item("OUT C words on both", { summaryZh: "semaglutide and weight loss in adults" });
  await item("CORE F sixty days ago", { hours: 60 * 24, tagIds: [glpTag, obeseTag] });
  await item("D one keyword only", { tagIds: [glpTag] });
  await item("E the other keyword only", { summaryZh: "obesity prevalence" });
  await item("X from a disabled source", { tagIds: [glpTag, obeseTag], sourceId: "off" });
  await item("W withdrawn", { tagIds: [glpTag, obeseTag], more: { state: "withdrawn" } });
  const membership = makeMembership();
  const tick = await membership.tick(clock);
  assert.equal(tick.parts.backfill.zones, 1);
  assert.equal(calls.judge.length, 1, "one batch for the new zone at once");
  for (const title of ["CORE A tags on both", "REL B entity and words", "OUT C words on both", "CORE F sixty days ago"]) {
    assert.ok(calls.judge[0].includes(title), `${title} went to the judge: no hit counts without the model`);
  }
  for (const title of ["D one keyword only", "E the other keyword only", "X from a disabled source", "W withdrawn"]) assert.ok(!calls.judge[0].includes(title), `${title} was never a candidate`);
  const stored = await rows();
  assert.equal(stored.size, 4);
  assert.deepEqual([stored.get("CORE A tags on both").state, stored.get("CORE A tags on both").relevance, stored.get("CORE A tags on both").via], ["in", "core", "tag"]);
  assert.deepEqual([stored.get("REL B entity and words").state, stored.get("REL B entity and words").relevance, stored.get("REL B entity and words").via], ["in", "related", "entity"]);
  assert.deepEqual([stored.get("OUT C words on both").state, stored.get("OUT C words on both").relevance, stored.get("OUT C words on both").via], ["out", null, "words"]);
  assert.equal(stored.get("CORE F sixty days ago").state, "in", "the backfill reaches ninety days");
  assert.equal(stored.get("CORE A tags on both").role, "research");
  assert.equal(stored.get("CORE A tags on both").decided_by, "model:zone-judge-1");
  assert.equal(stored.get("CORE A tags on both").definition_version, 1);
  const zone = await zoneRow();
  assert.equal(zone.backfilled_version, 1);
  assert.ok(zone.matched_through, "the incremental scan starts from the backfill");
  // An out is kept: the same pair is not judged again.
  clock = new Date(clock.getTime() + minutes(5));
  await membership.tick(clock);
  assert.equal(calls.judge.length, 1, "nothing new, nothing judged");
  assert.equal(membership.status().counters.judge.out, 1);
});

test("an item that becomes visible later is found by the incremental scan once, and judged", options, async () => {
  await createZone();
  await item("CORE first", { summaryZh: "semaglutide for obesity" });
  const membership = makeMembership();
  await membership.tick(clock);
  assert.equal(calls.judge.length, 1);
  clock = new Date(clock.getTime() + minutes(2));
  const later = await item("CORE second", { hours: 0, summaryZh: "tirzepatide in weight loss" });
  await db.query("UPDATE evimed_frontier.items SET visible_at = $2, updated_at = $2 WHERE id = $1", [later.id, new Date(clock.getTime() - minutes(1)).toISOString()]);
  const tick = await membership.tick(clock);
  assert.equal(tick.parts.scan.scanned, 1);
  assert.equal(tick.parts.scan.offered, 1, "only the new item: the overlap re-reads the first and writes nothing for it");
  assert.equal(calls.judge.length, 2);
  assert.ok(calls.judge[1].includes("CORE second") && !calls.judge[1].includes("CORE first"));
  assert.equal([...(await rows()).values()].filter((row) => row.state === "in").length, 2);
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  assert.equal(calls.judge.length, 2, "a scan with nothing new asks nothing");
});

test("a tag is followed through merges and narrower tags", options, async () => {
  const parent = await tag("parent", "治疗肥胖的药物");
  const narrower = await tag("narrower", "口服减重药", { broaderId: parent });
  const merged = await tag("merged", "肥胖药物旧称", { state: "merged", mergedInto: parent });
  const other = await tag("other", "别的标签");
  const sema = await tag("sema", "司美格鲁肽类");
  await createZone({ definition: zoneDefinition({ keywords: [glp({ tagIds: [sema] }), obesity({ tagIds: [parent] })] }) });
  await item("CORE via narrower", { tagIds: [sema, narrower] });
  await item("CORE via merged", { tagIds: [sema, merged] });
  await item("CORE via parent", { tagIds: [sema, parent] });
  await item("OUT via unrelated tag", { tagIds: [sema, other] });
  const membership = makeMembership();
  await membership.tick(clock);
  const stored = await rows();
  assert.deepEqual([...stored.keys()].sort(), ["CORE via merged", "CORE via narrower", "CORE via parent"]);
});

test("an excluded name takes a words-only hit away, and a tag of the item still counts", options, async () => {
  const breast = await tag("breast", "乳腺癌");
  const adc = await tag("adc", "抗体偶联药物");
  const definition = zoneDefinition({ keywords: [{ label: "ADC", terms: ["ADC", "antibody-drug conjugate"], tagIds: [adc], entityKeys: [] },
    { label: "乳腺癌", terms: ["乳腺癌", "breast cancer"], tagIds: [breast], entityKeys: [] }], excludeTerms: ["乳腺癌耐药蛋白", "BCRP"] });
  await createZone({ id: "ez_adc", title: "ADC 治疗乳腺癌", definition });
  await item("OUT BCRP efflux of an ADC payload", { titleZh: "乳腺癌耐药蛋白（BCRP）介导 ADC 药物外排", tagIds: [adc] });
  await item("CORE ADC in breast cancer", { titleZh: "ADC 药物在乳腺癌中的 3 期研究", tagIds: [adc] });
  await item("CORE tagged breast cancer and BCRP", { titleZh: "BCRP 与乳腺癌耐药蛋白的表达", tagIds: [adc, breast] });
  const membership = makeMembership();
  await membership.tick(clock);
  const stored = await rows("ez_adc");
  assert.deepEqual([...stored.keys()].sort(), ["CORE ADC in breast cancer", "CORE tagged breast cancer and BCRP"]);
});

test("a definition change keeps the old rows until the new judgement replaces them; failed calls cost attempts and stop at three", options, async () => {
  await createZone();
  await item("CORE stays", { summaryZh: "semaglutide for obesity" });
  await item("REL becomes out", { summaryZh: "semaglutide for obesity" });
  await item("OUT old", { summaryZh: "semaglutide for obesity" });
  const membership = makeMembership();
  await membership.tick(clock);
  assert.deepEqual([...(await rows()).values()].map((row) => row.state).sort(), ["in", "in", "out"]);
  // The owner narrows the zone: version 2. The judge is down, so the old rows stand.
  await db.query("UPDATE evimed_frontier.evidence_zones SET definition_version = 2 WHERE id = 'ez_g'");
  judgeRule = (itemTitle) => (itemTitle.startsWith("CORE") ? "core" : itemTitle.startsWith("OUT") ? "related" : "out");
  judgeFailure = Object.assign(new Error("upstream"), { code: "model_gateway_upstream_error" });
  for (let round = 0; round < 4; round += 1) {
    clock = new Date(clock.getTime() + minutes(2));
    await membership.tick(clock);
  }
  let stored = await rows();
  assert.equal(stored.get("CORE stays").state, "in", "the page never empties");
  assert.equal(stored.get("REL becomes out").state, "in");
  assert.equal(stored.get("CORE stays").definition_version, 1, "still the old version");
  assert.equal(stored.get("OUT old").state, "pending", "an out the new definition recalls waits, out of sight, for its new judgement");
  assert.equal(stored.get("CORE stays").attempts, 3, "three attempts and then it waits for the next definition version");
  const spent = calls.judge.length;
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  assert.equal(calls.judge.length, spent, "no fourth attempt");
  // The definition is saved again (version 3, nobody calls afterSave) and the judge answers: the next tick backfills, which gives the
  // pairs their attempts back; the stale rows are judged under the new version, the old out is offered again.
  judgeFailure = null;
  await db.query("UPDATE evimed_frontier.evidence_zones SET definition_version = 3 WHERE id = 'ez_g'");
  for (let round = 0; round < 3; round += 1) {
    clock = new Date(clock.getTime() + minutes(2));
    await membership.tick(clock);
  }
  stored = await rows();
  assert.deepEqual([stored.get("CORE stays").state, stored.get("CORE stays").relevance, stored.get("CORE stays").definition_version], ["in", "core", 3]);
  assert.deepEqual([stored.get("REL becomes out").state, stored.get("REL becomes out").definition_version], ["out", 3], "replaced by the new judgement");
  assert.deepEqual([stored.get("OUT old").state, stored.get("OUT old").relevance, stored.get("OUT old").definition_version], ["in", "related", 3], "an out the new definition recalls is judged again");
  assert.equal((await zoneRow()).backfilled_version, 3);
});

test("a verdict for an older definition than the zone now has is dropped: the pair is judged again under the new version", options, async () => {
  await createZone();
  await item("CORE late", { summaryZh: "semaglutide for obesity" });
  const membership = makeMembership();
  // The first tick backfills (version 1); the owner then saves version 2 while the next judge call is out, and the backfill for it has
  // already put the pair back to pending at version 2 when the version-1 answer (`out`) comes in.
  judgeFailure = Object.assign(new Error("upstream"), { code: "model_gateway_upstream_error" });
  await membership.tick(clock);
  judgeFailure = null;
  assert.equal((await rows()).get("CORE late").state, "pending");
  judgeRule = () => "out";
  duringJudge = async () => {
    await db.query("UPDATE evimed_frontier.evidence_zones SET definition_version = 2, backfilled_version = 2 WHERE id = 'ez_g'");
    await db.query("UPDATE evimed_frontier.zone_items SET definition_version = 2, attempts = 0 WHERE zone_id = 'ez_g'");
  };
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  let stored = (await rows()).get("CORE late");
  assert.deepEqual([stored.state, stored.definition_version], ["pending", 2], "the stale `out` was not written over the pair waiting for version 2");
  judgeRule = () => "core";
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  stored = (await rows()).get("CORE late");
  assert.deepEqual([stored.state, stored.relevance, stored.definition_version], ["in", "core", 2], "judged under the new definition");
});

test("a stale `out` does not take an `in` row left for the new version out of the queue", options, async () => {
  await createZone();
  await item("CORE kept", { summaryZh: "semaglutide for obesity" });
  const membership = makeMembership();
  await membership.tick(clock);
  assert.equal((await rows()).get("CORE kept").state, "in");
  // Version 2 is saved: the `in` row stays at version 1 and is queued. While its call is out, version 3 is saved and the answer for
  // version 2 comes in as `out`.
  await db.query("UPDATE evimed_frontier.evidence_zones SET definition_version = 2, backfilled_version = 2 WHERE id = 'ez_g'");
  judgeRule = () => "out";
  duringJudge = async () => {
    await db.query("UPDATE evimed_frontier.evidence_zones SET definition_version = 3, backfilled_version = 3 WHERE id = 'ez_g'");
  };
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  let stored = (await rows()).get("CORE kept");
  assert.deepEqual([stored.state, stored.definition_version], ["in", 1], "the row keeps its place and its old version");
  judgeRule = () => "related";
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  stored = (await rows()).get("CORE kept");
  assert.deepEqual([stored.state, stored.relevance, stored.definition_version], ["in", "related", 3]);
});

test("afterSave while a judge call is out: the answer for the old definition never overwrites the new judgement", options, async () => {
  await createZone();
  await item("CORE both", { summaryZh: "semaglutide for obesity" });
  const membership = makeMembership();
  judgeFailure = Object.assign(new Error("upstream"), { code: "model_gateway_upstream_error" });
  await membership.tick(clock);
  judgeFailure = null;
  assert.equal((await rows()).get("CORE both").state, "pending");
  // The first call answers `out` for version 1; the owner's save (version 2) and its backfill and first judgement (`core`) happen
  // before that answer is returned.
  judgeRule = () => (calls.judge.length === 1 ? "out" : "core");
  calls.judge.length = 0;
  duringJudge = async () => {
    await db.query("UPDATE evimed_frontier.evidence_zones SET definition_version = 2 WHERE id = 'ez_g'");
    await membership.afterSave("ez_g");
    await membership.settled();
  };
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  const stored = (await rows()).get("CORE both");
  assert.deepEqual([stored.state, stored.relevance, stored.definition_version], ["in", "core", 2]);
  assert.equal((await zoneRow()).backfilled_version, 2);
});

test("an unreadable judge answer drops the batch, leaves the pairs pending and counts one attempt", options, async () => {
  await createZone();
  await item("CORE one", { summaryZh: "semaglutide for obesity" });
  const original = judgeRule;
  judgeRule = () => null; // the model answers {"judgements": []}: nothing decided
  const membership = makeMembership();
  await membership.tick(clock);
  let stored = await rows();
  assert.deepEqual([stored.get("CORE one").state, stored.get("CORE one").attempts], ["pending", 1]);
  assert.equal(membership.status().counters.judge.undecided, 1);
  judgeRule = original;
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  stored = await rows();
  assert.deepEqual([stored.get("CORE one").state, stored.get("CORE one").attempts], ["in", 0]);
});

test("pinned and excluded rows are never rewritten, by a scan, a judgement or a new definition", options, async () => {
  await createZone();
  const pinned = await item("OUT pinned by the operator", { summaryZh: "semaglutide for obesity" });
  const excluded = await item("CORE excluded by the reader", { summaryZh: "semaglutide for obesity" });
  await item("CORE ordinary", { summaryZh: "semaglutide for obesity" });
  await db.query(`INSERT INTO evimed_frontier.zone_items (zone_id, item_id, state, via, role, decided_by, definition_version)
    VALUES ('ez_g', $1, 'pinned', 'editor', 'research', 'operator:ops', 1), ('ez_g', $2, 'excluded', 'reader', 'research', 'owner:alice', 1)`, [pinned.id, excluded.id]);
  const membership = makeMembership();
  await membership.tick(clock);
  await db.query("UPDATE evimed_frontier.evidence_zones SET definition_version = 2 WHERE id = 'ez_g'");
  await membership.afterSave("ez_g");
  await membership.settled();
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  const stored = await rows();
  assert.deepEqual([stored.get("OUT pinned by the operator").state, stored.get("OUT pinned by the operator").decided_by, stored.get("OUT pinned by the operator").definition_version], ["pinned", "operator:ops", 1]);
  assert.deepEqual([stored.get("CORE excluded by the reader").state, stored.get("CORE excluded by the reader").decided_by], ["excluded", "owner:alice"]);
  assert.equal(stored.get("CORE ordinary").state, "in");
  assert.ok(!calls.judge.some((input) => input.includes("pinned by the operator") || input.includes("excluded by the reader")), "neither was shown to the judge");
});

test("a spent budget leaves the recall running and the pairs waiting; nothing is asked of the model", options, async () => {
  await createZone();
  await item("CORE one", { summaryZh: "semaglutide for obesity" });
  budgetState = "exhausted";
  const membership = makeMembership();
  await membership.tick(clock);
  assert.equal(calls.judge.length, 0);
  assert.equal(calls.progress.length, 0);
  assert.equal((await rows()).get("CORE one").state, "pending");
  budgetState = "ok";
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  assert.equal((await rows()).get("CORE one").state, "in", "the next day's pass takes the queue");
});

test("a batch holds at most ten items, each with at most eight zones, and a tick makes at most three calls", options, async () => {
  for (let index = 0; index < 10; index += 1) {
    await createZone({ id: `ez_z${index}`, title: `专区 ${index}`, definition: zoneDefinition(), backfilled: 1 });
  }
  for (let index = 0; index < 25; index += 1) await item(`CORE item ${index}`, { hours: 3 + index / 100, summaryZh: "semaglutide for obesity" });
  const membership = makeMembership();
  await membership.tick(clock); // all ten zones are due for a scan; zones are looked at from `matched_through` null → a week back
  assert.ok(calls.judge.length <= 3, `${calls.judge.length} calls in one tick`);
  for (const input of calls.judge) {
    const itemCount = [...input.matchAll(/^\[\d+\] /gm)].length;
    assert.ok(itemCount <= ZONE_JUDGE.itemsPerCall, `${itemCount} items in a call`);
    for (const line of input.matchAll(/候选专区：(.+)$/gm)) assert.ok(line[1].split("、").length <= ZONE_JUDGE.zonesPerItem, line[1]);
    assert.ok(new Set([...input.matchAll(/^(Z\d+)｜/gm)].map((match) => match[1])).size <= ZONE_JUDGE.zonesPerCall);
  }
  const before = (await db.query("SELECT count(*)::int AS n FROM evimed_frontier.zone_items WHERE state = 'pending'")).rows[0].n;
  assert.ok(before > 0, "the rest of the queue waits for the next tick");
  for (let round = 0; round < 12 && (await db.query("SELECT 1 FROM evimed_frontier.zone_items WHERE state = 'pending' LIMIT 1")).rows.length; round += 1) {
    clock = new Date(clock.getTime() + 5_000);
    await membership.tick(clock);
  }
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.zone_items WHERE state = 'in'")).rows[0].n, 250, "every pair is judged in the end");
});

test("the vector completes a zone one keyword short, and a zone the vocabularies cannot hold takes its nearest items", options, async () => {
  const glpTag = await tag("glp", "GLP-1 受体激动剂");
  const obeseTag = await tag("obese", "肥胖");
  await createZone({ definition: zoneDefinition({ keywords: [glp({ tagIds: [glpTag] }), obesity({ tagIds: [obeseTag] })] }) });
  await createZone({ id: "ez_open", title: "开放主题", definition: zoneDefinition({ keywords: [{ label: "afterglow", terms: ["afterglow"], tagIds: [], entityKeys: [] }] }) });
  await item("CORE near the zone, one keyword", { tagIds: [glpTag], vector: vectorAt(0.8) });
  await item("far from the zone, one keyword", { tagIds: [glpTag], vector: vectorAt(0.3) });
  await item("no vector, one keyword", { tagIds: [glpTag] });
  await item("CORE nearest, no keyword", { vector: vectorAt(0.7) });
  await item("not near enough", { vector: vectorAt(0.5) });
  const membership = makeMembership({ embedder });
  await membership.tick(clock);
  const g = await rows();
  assert.deepEqual([...g.keys()], ["CORE near the zone, one keyword"]);
  assert.equal(g.get("CORE near the zone, one keyword").via, "tag", "the strongest leg that offered it");
  const open = await rows("ez_open");
  assert.deepEqual([...open.keys()].sort(), ["CORE near the zone, one keyword", "CORE nearest, no keyword"].sort().filter((title) => open.has(title)));
  assert.equal(open.get("CORE nearest, no keyword")?.via, "vector");
  assert.ok(!open.has("not near enough"));
});

test("feedback: a reader's own zone excludes at once; a platform zone asks the judge again; more-like adds an example", options, async () => {
  await createZone({ id: "ez_mine", userId: "alice", kind: "user", title: "我的专区", state: "draft" });
  await createZone({ id: "ez_pub", title: "平台专区" });
  const x = await item("CORE shared item", { summaryZh: "semaglutide for obesity" });
  const y = await item("CORE another item", { summaryZh: "semaglutide for obesity" });
  const membership = makeMembership();
  await membership.tick(clock);
  await membership.tick(new Date(clock.getTime() + 1));
  assert.equal((await rows("ez_mine")).get("CORE shared item").state, "in");
  assert.equal((await rows("ez_pub")).get("CORE shared item").state, "in");
  // Another reader cannot give feedback on alice's zone.
  await assert.rejects(membership.feedback("ez_mine", x.id, "not-in", { userId: "bob" }), (/** @type {any} */ error) => error.status === 403 && error.code === "evidence_zone_forbidden");
  assert.deepEqual(await membership.feedback("ez_mine", x.id, "not-in", { userId: "alice", isOwner: true }), { accepted: true, outcome: "excluded" });
  let mine = await rows("ez_mine");
  assert.deepEqual([mine.get("CORE shared item").state, mine.get("CORE shared item").decided_by], ["excluded", "owner:alice"]);
  const definition = (await zoneRow("ez_mine")).definition;
  assert.deepEqual(definition.seeds.negative, [x.publicId], "a negative example for the judge");
  assert.equal((await zoneRow("ez_mine")).definition_version, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.zone_changes WHERE zone_id = 'ez_mine' AND kind = 'excluded'")).rows[0].n, 1);
  // A later pass never brings it back.
  await membership.afterSave("ez_mine");
  await membership.settled();
  mine = await rows("ez_mine");
  assert.equal(mine.get("CORE shared item").state, "excluded");
  // A platform zone: the judge reads the pair again with the note; an `out` excludes, anything else keeps it.
  const before = calls.judge.length;
  judgeRule = () => "core";
  assert.deepEqual(await membership.feedback("ez_pub", x.id, "not-in", { userId: "bob" }), { accepted: true, outcome: "kept" });
  assert.equal(calls.judge.length, before + 1);
  assert.ok(calls.judge.at(-1).includes("读者提示：读者认为这条不属于这个专区。"));
  assert.equal((await rows("ez_pub")).get("CORE shared item").state, "in");
  // The same reader asking again about the same pair costs no model call; another reader's word is read.
  const asked = calls.judge.length;
  judgeRule = () => "out";
  assert.deepEqual(await membership.feedback("ez_pub", x.id, "not-in", { userId: "bob" }), { accepted: true, outcome: "unjudged" });
  assert.equal(calls.judge.length, asked, "bob has had this pair read already");
  assert.equal((await rows("ez_pub")).get("CORE shared item").state, "in");
  assert.deepEqual(await membership.feedback("ez_pub", x.id, "not-in", { userId: "carol" }), { accepted: true, outcome: "excluded" });
  const pub = await rows("ez_pub");
  assert.deepEqual([pub.get("CORE shared item").state, pub.get("CORE shared item").decided_by], ["excluded", "model:zone-judge-1"]);
  assert.equal((await db.query("SELECT actor FROM evimed_frontier.zone_changes WHERE zone_id = 'ez_pub'")).rows[0].actor, "reader:carol");
  assert.equal((await zoneRow("ez_pub")).definition.seeds.negative.length, 0, "a reader does not edit a platform zone's examples through a no");
  // more-like: the owner's zone takes the item as a positive example; a platform zone's examples are an operator's, not a reader's.
  assert.deepEqual(await membership.feedback("ez_pub", y.id, "more-like", { userId: "bob" }), { accepted: true, outcome: "noted" });
  assert.deepEqual((await zoneRow("ez_pub")).definition.seeds.positive, [], "another reader's word does not steer the judgement of a platform zone");
  assert.deepEqual(await membership.feedback("ez_mine", y.id, "more-like", { userId: "alice", isOwner: true }), { accepted: true, outcome: "seeded" });
  assert.deepEqual((await zoneRow("ez_mine")).definition.seeds.positive, [y.publicId]);
  const operating = makeMembership({ config: { operatorUsers: ["op"] } });
  assert.deepEqual(await operating.feedback("ez_pub", y.id, "more-like", { userId: "op" }), { accepted: true, outcome: "seeded" });
  assert.deepEqual((await zoneRow("ez_pub")).definition.seeds.positive, [y.publicId]);
  assert.equal((await zoneRow("ez_pub")).definition_version, 1);
  await assert.rejects(membership.feedback("ez_pub", x.id, "more-like", { userId: "bob" }), (/** @type {any} */ error) => error.status === 404, "not in the zone any more");
  await assert.rejects(membership.feedback("ez_pub", x.id, "weird", { userId: "bob" }), (/** @type {any} */ error) => error.status === 400);
  // The example is shown to the judge the next time the zone is judged.
  judgeRule = () => "core";
  await item("CORE newly arrived", { hours: 0, summaryZh: "semaglutide for obesity" });
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  assert.ok(calls.judge.at(-1).includes("算的例子：「CORE another item」"));
});

test("zonesForItem: the platform's zones and the reader's own, never another reader's", options, async () => {
  await createZone({ id: "ez_a", title: "平台 A" });
  await createZone({ id: "ez_b", title: "平台 B" });
  await createZone({ id: "ez_c", title: "平台 C，只是相关" });
  await createZone({ id: "ez_draft", title: "平台草稿", state: "draft" });
  await createZone({ id: "ez_alice", userId: "alice", kind: "user", title: "爱丽丝的专区", state: "draft" });
  await createZone({ id: "ez_bob", userId: "bob", kind: "user", title: "鲍勃的专区", state: "published" });
  await createZone({ id: "ez_old", title: "平台旧区", lifecycle: "none" });
  const row = await item("CORE everywhere", { summaryZh: "semaglutide for obesity" });
  for (const [zone, state, relevance] of [["ez_a", "in", "core"], ["ez_b", "pinned", null], ["ez_c", "in", "related"], ["ez_draft", "in", "core"], ["ez_alice", "in", "core"], ["ez_bob", "in", "core"], ["ez_old", "in", "core"]]) {
    await db.query("INSERT INTO evimed_frontier.zone_items (zone_id, item_id, state, relevance, via, role, decided_by) VALUES ($1, $2, $3, $4, 'tag', 'research', 'test')", [zone, row.id, state, relevance]);
  }
  await db.query("INSERT INTO evimed_frontier.zone_items (zone_id, item_id, state, via, role, decided_by) SELECT 'ez_a', id, 'out', 'tag', 'research', 'test' FROM evimed_frontier.items WHERE id <> $1", [row.id]);
  const membership = makeMembership();
  const forAlice = await membership.zonesForItem(row.id, "alice", { limit: 10 });
  assert.deepEqual(forAlice.map((zone) => zone.id), ["ez_alice", "ez_a", "ez_b", "ez_c"], "her own first, then the platform's, core and pinned before related");
  assert.deepEqual(forAlice[0], { id: "ez_alice", title: "爱丽丝的专区" });
  const forBob = await membership.zonesForItem(row.id, "bob");
  assert.deepEqual(forBob.map((zone) => zone.id), ["ez_bob", "ez_a", "ez_b"], "limit three");
  assert.ok(!forBob.some((zone) => zone.id === "ez_alice"));
  assert.deepEqual((await membership.zonesForItem(row.id, "nobody")).map((zone) => zone.id), ["ez_a", "ez_b", "ez_c"]);
});

test("preview counts events, gives the band, the newest five and the borderline ones, with no model call", options, async () => {
  const glpTag = await tag("glp", "GLP-1 受体激动剂");
  const obeseTag = await tag("obese", "肥胖");
  const definition = zoneDefinition({ keywords: [glp({ tagIds: [glpTag] }), obesity({ tagIds: [obeseTag] })] });
  const strong = [];
  for (let index = 0; index < 7; index += 1) strong.push(await item(`strong ${index}`, { hours: 24 * (index + 1) - 2, tagIds: [glpTag, obeseTag], eventId: index === 6 ? 900 : 1000 + index }));
  await item("a second report of the same event", { hours: 24 * 7 + 1, tagIds: [glpTag, obeseTag], eventId: 900 });
  const weak = await item("words only", { hours: 30, summaryZh: "semaglutide and obesity again" });
  const near = await item("one keyword and near", { hours: 31, tagIds: [glpTag], vector: vectorAt(0.9) });
  await item("older than the window", { hours: 24 * 40, tagIds: [glpTag, obeseTag] });
  const membership = makeMembership({ embedder });
  const preview = await membership.preview(definition);
  assert.equal(preview.count30, 9, "seven strong events (one reported twice), the words-only item and the near one");
  assert.equal(preview.perWeek, 2.1);
  assert.equal(preview.band, "narrow");
  assert.equal(preview.recentRowIds.length, 5);
  assert.equal(preview.recentRowIds[0], strong[0].id, "newest first");
  assert.deepEqual(preview.borderlineRowIds, [near.id, weak.id], "the vector-completed one first, then the one a keyword hit by words alone");
  assert.equal(calls.judge.length + calls.progress.length, 0, "no model call");
  const short = await membership.preview(definition, { days: 3 });
  assert.equal(short.count30, 5, "the window is the caller's: three strong events and the two weaker ones");
  assert.equal(short.perWeek, 11.7);
  assert.equal(calls.judge.length, 0);
});

test("a keyword's tags and entity keys are filled from its terms", options, async () => {
  const known = await tag("known", "测试专区标签甲", { nameEn: "ez test tag alpha" });
  await db.query("INSERT INTO evimed_frontier.tag_aliases (key, tag_id, alias, origin) VALUES ('测试别名乙', $1, '测试别名乙', 'seed')", [known]);
  const dormant = await tag("dormant", "测试休眠标签", { state: "dormant" });
  const candidate = await tag("candidate", "测试候选标签", { state: "candidate" });
  const membership = makeMembership();
  const resolved = await membership.resolveKeywords(zoneDefinition({ keywords: [
    { label: "测试专区标签甲", terms: ["测试别名乙", "ez test tag alpha", "测试实体词"], tagIds: [99999], entityKeys: ["drug:stale"] },
    { label: "测试休眠标签", terms: ["测试候选标签"], tagIds: [], entityKeys: [] }] }));
  assert.deepEqual(resolved.keywords[0].tagIds, [known], "by name, alias and English name; what the definition held is replaced");
  assert.deepEqual(resolved.keywords[0].entityKeys, ["drug:ez-test"]);
  assert.deepEqual(resolved.keywords[1].tagIds, [dormant], "a dormant tag counts, a candidate does not");
  assert.deepEqual(resolved.keywords[1].entityKeys, []);
  void candidate;
  const bare = new EvidenceZoneMembership({ database: db, now: () => clock });
  const same = await bare.resolveKeywords(zoneDefinition());
  assert.deepEqual(same.keywords.map((keyword) => [keyword.tagIds, keyword.entityKeys]), [[[], []], [[], []]], "no vocabulary, nothing resolved, nothing thrown");
});

test("stats count events by window, the roles of the month, the latest and the latest key update", options, async () => {
  await createZone();
  const a = await item("CORE a", { hours: 2, summaryZh: "semaglutide obesity", eventId: 11 });
  await item("CORE a second report", { hours: 3, summaryZh: "semaglutide obesity", eventId: 11 });
  await item("CORE b guideline", { hours: 24 * 3, summaryZh: "semaglutide obesity", genre: "guideline" });
  await item("CORE c ten days", { hours: 24 * 10, summaryZh: "semaglutide obesity" });
  await item("CORE d forty days", { hours: 24 * 40, summaryZh: "semaglutide obesity" });
  await item("CORE e twenty-five days", { hours: 24 * 25, summaryZh: "semaglutide obesity", genre: "approval" });
  const membership = makeMembership();
  await membership.tick(clock);
  const zone = await zoneRow();
  assert.ok(zone.stats_at);
  const stats = zone.stats;
  assert.equal(stats.all, 5, "the second report of an event is not another item");
  assert.equal(stats.week, 2);
  assert.equal(stats.month, 4);
  assert.equal(stats.perWeek, 1);
  assert.deepEqual(stats.roleCounts30, { research: 2, guideline: 1, approval: 1 });
  assert.deepEqual([stats.latest.itemId, stats.latest.title], [a.publicId, "CORE a"]);
  assert.equal(stats.keyLatest.title, "CORE b guideline");
  assert.equal(stats.cards, 0);
  // Not recomputed within ten minutes unless asked; recomputed after ten minutes when rows changed.
  await item("CORE f new", { hours: 1, summaryZh: "semaglutide obesity" });
  clock = new Date(clock.getTime() + minutes(2));
  await membership.tick(clock);
  assert.equal((await zoneRow()).stats.all, 5, "ten minutes have not passed");
  clock = new Date(clock.getTime() + minutes(11));
  await membership.tick(clock);
  assert.equal((await zoneRow()).stats.all, 6);
});

test("a new zone is counted once it has been backfilled, and again soon after its first items are judged", options, async () => {
  for (const id of ["ez_1", "ez_2", "ez_3"]) await createZone({ id, title: `专区 ${id}` });
  await item("CORE one", { summaryZh: "semaglutide obesity" });
  budgetState = "exhausted";
  const membership = makeMembership();
  await membership.tick(clock); // two zones are backfilled; the model has no budget
  const counted = async () => Object.fromEntries((await db.query("SELECT id, stats FROM evimed_frontier.evidence_zones")).rows.map((/** @type {any} */ row) => [row.id, row.stats?.all ?? null]));
  const first = Object.values(await counted());
  assert.deepEqual([first.filter((value) => value === 0).length, first.filter((value) => value === null).length], [2, 1], "the third has not been backfilled: nothing is counted for it yet");
  budgetState = "ok";
  clock = new Date(clock.getTime() + 40_000);
  await membership.tick(clock);
  await membership.tick(new Date(clock.getTime() + 1));
  clock = new Date(clock.getTime() + 40_000);
  await membership.tick(clock);
  assert.deepEqual(await counted(), { ez_1: 1, ez_2: 1, ez_3: 1 }, "a count of nothing is looked at again after half a minute, not ten");
});

/** Four core items in the last two weeks, the first with the numbers the paragraph states. */
async function coreItems(count = 4) {
  const made = [];
  for (let index = 0; index < count; index += 1) {
    made.push(await item(`CORE material ${index}`, { hours: 24 * (index + 1), titleZh: `CORE 司美格鲁肽研究第${index + 1}项`, summaryZh: "semaglutide obesity 68 周随访，体重下降 15%", lead: "纳入 68 周随访，体重下降 15%" }));
  }
  return made;
}

test("最新进展 is written for a zone with three core items, cites what it shows, and is not written again for the same material", options, async () => {
  await createZone();
  const made = await coreItems(4);
  const membership = makeMembership();
  await membership.tick(clock);
  assert.equal(calls.progress.length, 1);
  assert.ok(calls.progress[0].includes("【专区】GLP-1 受体激动剂减重") && calls.progress[0].includes("[1] 研究｜"));
  const zone = await zoneRow();
  assert.equal(zone.overview.text, PROGRESS);
  assert.deepEqual(zone.overview.refs.map((/** @type {any} */ entry) => entry.n), [1, 2, 3]);
  assert.ok(made.some((entry) => entry.publicId === zone.overview.refs[0].itemId), "refs name the items by their public id");
  assert.equal(zone.overview.version, "zone-progress-1");
  assert.equal(zone.overview.model, "deepseek-flash");
  assert.match(zone.overview.basis, /^[0-9a-f]{64}$/);
  assert.equal(new Date(zone.overview_at).toISOString(), clock.toISOString());
  assert.equal(membership.status().counters.overview.written, 1);
  // The same material: not due, however many ticks.
  for (let round = 0; round < 3; round += 1) { clock = new Date(clock.getTime() + minutes(10)); await membership.tick(clock); }
  assert.equal(calls.progress.length, 1);
  // New material the same day: not before twenty hours.
  await item("CORE material new", { hours: 0, titleZh: "CORE 司美格鲁肽新研究", summaryZh: "semaglutide obesity 68 周随访，体重下降 15%" });
  clock = new Date(clock.getTime() + minutes(30));
  await membership.tick(clock);
  assert.equal(calls.progress.length, 1, "the material changed, the paragraph is a few hours old");
  clock = new Date(clock.getTime() + 20 * 3_600_000);
  await membership.tick(clock);
  assert.equal(calls.progress.length, 2, "a day on");
});

test("最新进展: a key update newer than the paragraph rewrites it after six hours; fewer than three core items write none", options, async () => {
  await createZone();
  await coreItems(3);
  const membership = makeMembership();
  await membership.tick(clock);
  assert.equal(calls.progress.length, 1);
  clock = new Date(clock.getTime() + minutes(61));
  const guideline = await item("CORE the new guideline", { hours: 0, genre: "guideline", titleZh: "CORE 司美格鲁肽指南更新", summaryZh: "semaglutide obesity 68 周随访，体重下降 15%" });
  await db.query("UPDATE evimed_frontier.items SET visible_at = $2, updated_at = $2 WHERE id = $1", [guideline.id, clock.toISOString()]);
  clock = new Date(clock.getTime() + minutes(30));
  await membership.tick(clock);
  assert.equal(calls.progress.length, 1, "an hour and a half after the paragraph");
  clock = new Date(clock.getTime() + 5 * 3_600_000);
  await membership.tick(clock);
  assert.equal(calls.progress.length, 2, "six hours after the paragraph, with a key update newer than it");
  assert.ok(calls.progress[1].includes("[1] 指南共识｜"), "key updates first");
  // A zone with two core items is not written, and a paragraph it had falls away without a model call.
  await createZone({ id: "ez_thin", title: "单薄的专区", definition: zoneDefinition({ keywords: [glp(), { label: "thin", terms: ["thinword"], tagIds: [], entityKeys: [] }] }) });
  await item("CORE thin one", { summaryZh: "semaglutide thinword" });
  await item("CORE thin two", { summaryZh: "semaglutide thinword" });
  await membership.tick(clock);
  assert.equal((await zoneRow("ez_thin")).overview, null);
  const written = calls.progress.length;
  await db.query(`UPDATE evimed_frontier.evidence_zones SET overview = '{"text":"旧的一段话。","refs":[],"basis":"x","model":"m","version":"zone-progress-1"}'::jsonb, overview_at = $1 WHERE id = 'ez_thin'`,
    [new Date(clock.getTime() - 7 * 3_600_000).toISOString()]);
  clock = new Date(clock.getTime() + minutes(10));
  await membership.tick(clock);
  assert.equal(calls.progress.length, written, "no call for a zone with too little");
  assert.equal((await zoneRow("ez_thin")).overview.text, "", "the paragraph about material that is no longer there is gone");
});

test("最新进展: an empty answer is a valid paragraph, a refused one keeps the old one, and a reader's own zone is written too", options, async () => {
  await createZone({ id: "ez_mine", userId: "alice", kind: "user", title: "我的专区", state: "draft" });
  await coreItems(3);
  progressRule = () => "";
  const membership = makeMembership();
  await membership.tick(clock);
  await membership.tick(new Date(clock.getTime() + 1));
  let zone = await zoneRow("ez_mine");
  assert.equal(zone.overview.text, "", "thin material: no block");
  assert.equal(membership.status().counters.overview.empty, 1);
  // A refused answer (a mark that was not shown, twice): the previous paragraph stays and the zone is not retried at once.
  await db.query(`UPDATE evimed_frontier.evidence_zones SET overview = NULL WHERE id = 'ez_mine'`);
  progressRule = () => PROGRESS.replace("[3]", "[9]");
  clock = new Date(clock.getTime() + minutes(10));
  await membership.tick(clock);
  const asked = calls.progress.length;
  zone = await zoneRow("ez_mine");
  assert.equal(zone.overview, null);
  assert.equal(membership.status().counters.overview.dropped, 1);
  assert.equal(asked >= 3, true, "one call and one rewrite with the issues named");
  clock = new Date(clock.getTime() + minutes(10));
  await membership.tick(clock);
  assert.equal(calls.progress.length, asked, "not retried for two hours");
  progressRule = () => PROGRESS;
  clock = new Date(clock.getTime() + 2 * 3_600_000);
  await membership.tick(clock);
  assert.equal((await zoneRow("ez_mine")).overview.text, PROGRESS);
});

test("最新进展 comes down when a cited item is withdrawn or retracted, and is written again without it", options, async () => {
  await createZone();
  const made = await coreItems(4);
  const membership = makeMembership();
  await membership.tick(clock);
  const first = (await zoneRow()).overview;
  const cited = made.find((entry) => entry.publicId === first.refs[0].itemId);
  assert.ok(cited);
  clock = new Date(clock.getTime() + minutes(5));
  await db.query("UPDATE evimed_frontier.items SET flags = ARRAY['retracted'], updated_at = $2 WHERE id = $1", [cited.id, clock.toISOString()]);
  clock = new Date(clock.getTime() + minutes(3));
  const tick = await membership.tick(clock);
  assert.equal(tick.parts.takeDown.cleared, 1);
  const again = await zoneRow();
  assert.equal(calls.progress.length, 2, "written again in the same pass, from the three that are left");
  assert.ok(!again.overview.refs.some((/** @type {any} */ entry) => entry.itemId === cited.publicId), "the retracted item is not cited");
  assert.ok(!calls.progress[1].includes(`研究第${made.indexOf(cited) + 1}项`), "and not shown to the writer");
  // Withdrawn.
  clock = new Date(clock.getTime() + minutes(5));
  const nowCited = made.find((entry) => entry.publicId === again.overview.refs[0].itemId);
  await db.query("UPDATE evimed_frontier.items SET state = 'withdrawn', withdrawn_at = $2, updated_at = $2 WHERE id = $1", [nowCited.id, clock.toISOString()]);
  clock = new Date(clock.getTime() + minutes(3));
  await membership.tick(clock);
  assert.equal(calls.progress.length, 2, "two core items are left: no paragraph is written");
  assert.equal((await zoneRow()).overview, null, "and the old one is gone");
});

test("afterSave starts a zone's backfill and first judgement without waiting for the worker, and raises a zero version", options, async () => {
  await createZone({ version: 0 });
  await item("CORE early", { summaryZh: "semaglutide obesity" });
  const membership = makeMembership();
  await membership.afterSave("ez_g");
  await membership.settled();
  const zone = await zoneRow();
  assert.deepEqual([zone.definition_version, zone.backfilled_version], [1, 1]);
  assert.equal((await rows()).get("CORE early").state, "in");
  assert.ok(zone.stats, "its counts are there too");
});

test("the metric families carry the zones' counters", options, async () => {
  await createZone();
  await item("CORE one", { summaryZh: "semaglutide obesity" });
  await item("OUT two", { summaryZh: "semaglutide obesity" });
  const membership = makeMembership();
  await membership.tick(clock);
  const { frontierMetricFamilies } = await import("../src/frontierService.mjs");
  const snapshot = { tables: null, composer: null, actions: null, editor: null, budget: { spentCny: 0, budgetCny: 10, state: "ok" },
    worker: { pipeline: {}, loops: {}, zones: membership.status() }, client: { counters: {} }, service: {},
    plugin: { state: "ok", contract: "1.2.0", compatibility: "compatible", lastError: null, counters: { pulls: 0, pullFailures: 0 }, gaps: { count: 0, entries: 0 }, unknownVocabulary: {} } };
  const families = frontierMetricFamilies(true, /** @type {any} */ (snapshot));
  const names = families.map((entry) => entry.name).filter((name) => name.startsWith("open_science_zone_"));
  assert.deepEqual(names.sort(), ["open_science_zone_failures_total", "open_science_zone_feedback_total", "open_science_zone_items_total", "open_science_zone_judge_calls_total",
    "open_science_zone_judge_total", "open_science_zone_overview_total", "open_science_zone_scans_total"]);
  const judge = families.find((entry) => entry.name === "open_science_zone_judge_total");
  assert.equal(judge?.series.find((entry) => entry.labels?.outcome === "core")?.value, 1);
  assert.equal(judge?.series.find((entry) => entry.labels?.outcome === "out")?.value, 1);
  const items = families.find((entry) => entry.name === "open_science_zone_items_total");
  assert.ok(items?.series.some((entry) => entry.labels?.via === "words" && entry.labels?.state === "pending" && entry.value === 2));
});

// ───────────────────────── the fix round of 2026-10-29 (server review F1, F2, F3, F4, F6) ─────────────────────────

/** Attach existing items to zones as judged members, without the model (the rows a judge would have written). */
async function attach(/** @type {string[]} */ zoneIds, /** @type {string[]} */ itemIds, { state = "in", relevance = "core", role = "research" } = {}) {
  await db.query(`INSERT INTO evimed_frontier.zone_items (zone_id, item_id, state, relevance, via, role, score, decided_by, definition_version, judged_at, matched_at)
    SELECT z, i, $3, $4, 'tag', $5, 1, 'model:zone-judge-1', 1, $6::timestamptz, $6::timestamptz FROM unnest($1::text[]) z, unnest($2::bigint[]) i`,
  [zoneIds, itemIds, state, relevance, role, hoursAgo(200)]);
}

/** Items the writer can cite (numbers in the lead) that no zone's keywords match, so the scans leave them alone. @param {number} count @param {number} [hours] */
async function materialItems(count, hours = 48) {
  const made = [];
  for (let index = 0; index < count; index += 1) {
    made.push(await item(`MATERIAL ${hours} ${index}`, { hours: hours + index, titleZh: `材料研究第${index + 1}项`, lead: "纳入 68 周随访，体重下降 15%" }));
  }
  return made;
}

/** Move many items' instants at once. @param {Array<{ id: string }>} items @param {Date[]} visible @param {Date[]} updated */
async function setInstants(items, visible, updated) {
  await db.query(`UPDATE evimed_frontier.items i SET visible_at = u.v, timeline_at = u.v, updated_at = u.u
    FROM unnest($1::bigint[], $2::timestamptz[], $3::timestamptz[]) AS u(id, v, u) WHERE i.id = u.id`,
  [items.map((entry) => entry.id), visible.map((at) => at.toISOString()), updated.map((at) => at.toISOString())]);
}

test("F1: 最新进展 reaches a zone that is due however many zones sit below three core items", options, async () => {
  const shared = await materialItems(3);
  const thin = Array.from({ length: 65 }, (_, index) => `ez_a_thin_${String(index).padStart(2, "0")}`);
  for (const id of thin) await createZone({ id, title: `单薄 ${id}`, backfilled: 1 });
  await attach(thin.slice(0, 30), shared.slice(0, 2).map((entry) => entry.id));
  await createZone({ id: "ez_z_due", title: "到期的专区", backfilled: 1 });
  await attach(["ez_z_due"], shared.map((entry) => entry.id));
  // A paragraph about material that is gone, in a zone that sorts after every thin one and was written before.
  await createZone({ id: "ez_z_old", title: "旧段落", backfilled: 1 });
  await attach(["ez_z_old"], shared.slice(0, 2).map((entry) => entry.id));
  await db.query(`UPDATE evimed_frontier.evidence_zones SET overview = '{"text":"旧的一段话。","refs":[],"basis":"x","model":"m","version":"zone-progress-1"}'::jsonb, overview_at = $1 WHERE id = 'ez_z_old'`,
    [hoursAgo(7)]);
  const membership = makeMembership();
  for (let round = 0; round < 3; round += 1) { clock = new Date(clock.getTime() + 1_000); await membership.tick(clock); }
  assert.equal((await zoneRow("ez_z_due")).overview?.text, PROGRESS, "the one zone that can be written is written, with 65 thin zones ahead of it");
  assert.equal(calls.progress.length, 1, "and no thin zone cost a model call");
  assert.equal((await zoneRow("ez_z_old")).overview?.text, "", "the paragraph about material that is gone comes down");
  assert.equal((await zoneRow("ez_a_thin_00")).overview, null);
});

test("F1: zones whose material did not change do not hold back one with a key update behind them", options, async () => {
  const shared = await materialItems(3);
  const basis = zoneProgressBasis(shared.map((entry) => ({ itemId: entry.publicId })));
  const calm = Array.from({ length: 65 }, (_, index) => `ez_b_calm_${String(index).padStart(2, "0")}`);
  for (const id of calm) await createZone({ id, title: `平静 ${id}`, backfilled: 1 });
  await attach(calm, shared.map((entry) => entry.id));
  const written = JSON.stringify({ text: PROGRESS, refs: [{ n: 1, itemId: shared[0].publicId }], basis, model: "m", version: "zone-progress-1" });
  await db.query("UPDATE evimed_frontier.evidence_zones SET overview = $1::jsonb, overview_at = $2 WHERE id = ANY($3::text[])", [written, hoursAgo(30), calm]);
  await createZone({ id: "ez_b_key", title: "有重要更新的专区", backfilled: 1 });
  const guideline = await item("MATERIAL guideline", { hours: 1, genre: "guideline", titleZh: "材料指南更新", lead: "纳入 68 周随访，体重下降 15%" });
  await attach(["ez_b_key"], shared.map((entry) => entry.id));
  await attach(["ez_b_key"], [guideline.id], { role: "guideline" });
  await db.query("UPDATE evimed_frontier.evidence_zones SET overview = $1::jsonb, overview_at = $2 WHERE id = 'ez_b_key'", [written, hoursAgo(8)]);
  const membership = makeMembership();
  let rounds = 0;
  while (rounds < 14 && (await zoneRow("ez_b_key")).overview_at.toISOString() === hoursAgo(8)) { rounds += 1; clock = new Date(clock.getTime() + 1_000); await membership.tick(clock); }
  assert.ok(rounds <= 14, `reached the key-update zone after ${rounds} passes`);
  assert.equal(calls.progress.length, 1, "one paragraph written, none for the calm zones");
  assert.ok(calls.progress[0].includes("[1] 指南共识｜"), "the key update first");
  assert.equal(new Date((await zoneRow("ez_b_calm_00")).overview_at).toISOString(), hoursAgo(30), "a calm zone was looked at and left as it was");
});

test("F2: a bulk update of old items does not stall the scan, and the new items behind them are offered", options, async () => {
  await createZone();
  const membership = makeMembership();
  await membership.tick(clock); // backfilled with nothing; matched_through = now
  clock = new Date(clock.getTime() + 3_600_000);
  /** @type {Array<{ id: string, publicId: string }>} */
  const made = [];
  for (let index = 0; index < 230; index += 1) made.push(await item(`CORE bumped ${String(index).padStart(3, "0")}`, { hours: 140 - index * 0.5, summaryZh: "semaglutide obesity" }));
  const fresh = await item("CORE fresh", { hours: 0, summaryZh: "tirzepatide in weight loss" });
  const bump = new Date(clock.getTime() - minutes(1));
  await setInstants([...made, fresh], [...made.map((_, index) => new Date(NOW.getTime() - (140 - index * 0.5) * 3_600_000)), new Date(clock.getTime() - 30_000)],
    [...made.map(() => bump), new Date(clock.getTime() - 30_000)]);
  const tick = await membership.tick(clock);
  assert.equal(tick.parts.scan.offered, 231, "all of them, the bumped items past the page and the fresh one behind them");
  assert.equal((await rows()).size, 231);
  clock = new Date(clock.getTime() + minutes(2));
  const later = await item("CORE later", { hours: 0, summaryZh: "semaglutide obesity" });
  await setInstants([later], [new Date(clock.getTime() - minutes(1))], [new Date(clock.getTime() - minutes(1))]);
  const again = await membership.tick(clock);
  assert.equal(again.parts.scan.offered, 1, "and the next one is not held behind the bumped items");
  assert.ok(ZONE_RECALL.scanLimit < 231, "the page really was smaller than the bump");
});

test("F2: a row the excluded names drop does not make the scan decide the page was not full", options, async () => {
  const adc = await tag("adc2", "抗体偶联药物");
  const definition = zoneDefinition({ keywords: [{ label: "ADC", terms: ["ADC", "antibody-drug conjugate"], tagIds: [adc], entityKeys: [] },
    { label: "乳腺癌", terms: ["乳腺癌", "breast cancer"], tagIds: [], entityKeys: [] }], excludeTerms: ["乳腺癌耐药蛋白", "BCRP"] });
  await createZone({ id: "ez_adc", title: "ADC 治疗乳腺癌", definition });
  const membership = makeMembership();
  await membership.tick(clock);
  clock = new Date(clock.getTime() + 2 * 3_600_000);
  const made = [await item("OUT BCRP efflux", { titleZh: "乳腺癌耐药蛋白（BCRP）介导 ADC 药物外排", tagIds: [adc] })];
  for (let index = 0; index < ZONE_RECALL.scanLimit - 1; index += 1) made.push(await item(`CORE ADC ${index}`, { titleZh: `ADC 药物在乳腺癌中的 3 期研究 ${index}`, tagIds: [adc] }));
  for (let index = 0; index < 3; index += 1) made.push(await item(`CORE newest ${index}`, { titleZh: `ADC 药物在乳腺癌中的最新研究 ${index}`, tagIds: [adc] }));
  const base = clock.getTime() - 3_600_000;
  const at = made.map((_, index) => new Date(base + index * 1_000));
  await setInstants(made, at, at);
  const tick = await membership.tick(clock);
  const stored = await rows("ez_adc");
  assert.ok(!stored.has("OUT BCRP efflux"), "the excluded name still drops its row");
  for (let index = 0; index < 3; index += 1) assert.ok(stored.has(`CORE newest ${index}`), `the newest ones behind the full page are offered (${index})`);
  assert.equal(tick.parts.scan.offered, ZONE_RECALL.scanLimit - 1 + 3);
});

test("F6: a row's role is read from the columns the modules read the genre by, and rows written before are repaired", options, async () => {
  await createZone({ id: "ez_mine", userId: "alice", kind: "user", title: "我的专区", state: "draft", backfilled: 1 });
  const guideline = await item("CORE null genre guideline", { genre: null, summaryZh: "semaglutide obesity", more: { evidenceType: "guideline" } });
  const paper = await item("CORE null genre paper", { genre: null, summaryZh: "semaglutide obesity" });
  await item("CORE safety alert", { summaryZh: "semaglutide obesity", more: { safetyAlert: true } });
  const quiet = await item("OTHER no keywords", { genre: null });
  const membership = makeMembership();
  await membership.tick(clock);
  await membership.tick(new Date(clock.getTime() + 1));
  const stored = await rows("ez_mine");
  assert.equal(stored.get("CORE null genre guideline").role, "guideline", "an item with no stored genre is read as the modules read it");
  assert.equal(stored.get("CORE null genre paper").role, "research");
  assert.equal(stored.get("CORE safety alert").role, "safety");
  // An exclusion of an item the zone never held writes the same role.
  await membership.feedback("ez_mine", quiet.id, "not-in", { userId: "alice", isOwner: true });
  assert.equal((await rows("ez_mine")).get("OTHER no keywords").role, "research");
  // Rows written before the fix hold `news`; the next pass of a process reads them again, and their zone's counts follow.
  await createZone({ id: "ez_old_rows", title: "旧行", backfilled: 1, definition: zoneDefinition({ keywords: [
    { label: "无匹配甲", terms: ["zzunmatched"], tagIds: [], entityKeys: [] }, { label: "无匹配乙", terms: ["yyunmatched"], tagIds: [], entityKeys: [] }] }) });
  await attach(["ez_old_rows"], [guideline.id, paper.id], { role: "news" });
  await db.query(`UPDATE evimed_frontier.evidence_zones SET stats = '{"week":2,"month":2,"all":2,"perWeek":0.5,"roleCounts30":{"news":2},"latest":null,"keyLatest":null,"cards":0}'::jsonb, stats_at = $1 WHERE id = 'ez_old_rows'`, [hoursAgo(1)]);
  const restarted = makeMembership();
  await restarted.tick(clock);
  const repaired = await rows("ez_old_rows");
  assert.deepEqual([repaired.get("CORE null genre guideline").role, repaired.get("CORE null genre paper").role], ["guideline", "research"]);
  assert.deepEqual((await zoneRow("ez_old_rows")).stats.roleCounts30, { guideline: 1, research: 1 }, "the counts that read the stored role are counted again");
  // The writer's material counts the guideline as a key update although its genre column is empty.
  const material = await restarted.progressMaterial("ez_old_rows", clock);
  assert.ok(material.newestKeyAt, "a guideline read from its columns is a key update");
});

test("F3: a reader's 「不属于」 on a platform zone costs the budget at most once per pair and a few times an hour", options, async () => {
  await createZone({ id: "ez_pub", title: "平台专区" });
  const items = [];
  for (let index = 0; index < 5; index += 1) items.push(await item(`CORE item ${index}`, { summaryZh: "semaglutide obesity" }));
  const membership = makeMembership({ config: { evidenceZoneFeedbackRejudgesPerHour: 3 } });
  await membership.tick(clock);
  await membership.tick(new Date(clock.getTime() + 1));
  judgeRule = () => "core";
  const base = calls.judge.length;
  // The same click repeated is read once.
  for (let round = 0; round < 4; round += 1) await membership.feedback("ez_pub", items[0].id, "not-in", { userId: "bob" });
  assert.equal(calls.judge.length, base + 1, "one reading for four clicks on one pair");
  // Three readings an hour in all, whichever pairs; the pairs stay where they were, the word is counted.
  for (const entry of items.slice(1)) assert.equal((await membership.feedback("ez_pub", entry.id, "not-in", { userId: "bob" })).accepted, true);
  assert.equal(calls.judge.length, base + 3, "the hour's limit is three");
  assert.equal([...(await rows("ez_pub")).values()].filter((row) => row.state === "in").length, 5);
  assert.deepEqual([membership.status().counters.feedback["not-in:repeated"], membership.status().counters.feedback["not-in:limited"], membership.status().counters.feedback["not-in:kept"]], [3, 2, 3]);
  // Another reader has an hour of their own; an hour later the first has theirs again.
  await membership.feedback("ez_pub", items[4].id, "not-in", { userId: "carol" });
  assert.equal(calls.judge.length, base + 4);
  clock = new Date(clock.getTime() + 61 * 60_000);
  await membership.feedback("ez_pub", items[4].id, "not-in", { userId: "bob" });
  assert.equal(calls.judge.length, base + 5, "an hour on, bob's refused word is read");
  await membership.feedback("ez_pub", items[4].id, "not-in", { userId: "bob" });
  assert.equal(calls.judge.length, base + 5, "and read once: the pair is remembered for him");
});

test("F2: the scan's vector legs are paged by the same key, so a zone that takes its nearest items loses none past the page", options, async () => {
  await createZone({ id: "ez_open", title: "开放主题", definition: zoneDefinition({ keywords: [{ label: "afterglow", terms: ["afterglow"], tagIds: [], entityKeys: [] }] }) });
  const membership = makeMembership({ embedder });
  await membership.tick(clock);
  clock = new Date(clock.getTime() + 2 * 3_600_000);
  const total = ZONE_RECALL.nearestLimit + 5;
  const made = [];
  for (let index = 0; index < total; index += 1) made.push(await item(`NEAR ${String(index).padStart(2, "0")}`, { vector: vectorAt(0.7) }));
  const at = made.map((_, index) => new Date(clock.getTime() - 3_600_000 + index * 1_000));
  await setInstants(made, at, at);
  const tick = await membership.tick(clock);
  assert.equal(tick.parts.scan.offered, total, "the nearest page was full, so the scan went on past it");
  assert.equal((await rows("ez_open")).size, total);
  assert.ok((await rows("ez_open")).get(`NEAR ${total - 1}`), "the newest is there");
});

test("F1 (class): zones that cannot be read do not hold the backfill and scan windows against the zones behind them", options, async () => {
  const broken = '{"version":1,"keywords":[]}';
  // Backfill: two slots a tick, newest definition first. Two zones that cannot be read are newer than the good one.
  await createZone({ id: "ez_ok", title: "好的专区" });
  await item("CORE ok", { summaryZh: "semaglutide obesity" });
  for (const id of ["ez_bad_1", "ez_bad_2"]) await createZone({ id, title: `坏的 ${id}` });
  await db.query("UPDATE evimed_frontier.evidence_zones SET definition = $1::jsonb, updated_at = clock_timestamp() + interval '1 hour' WHERE id LIKE 'ez_bad_%'", [broken]);
  const membership = makeMembership();
  await membership.tick(clock);
  await membership.tick(new Date(clock.getTime() + 1_000));
  assert.equal((await zoneRow("ez_ok")).backfilled_version, 1, "the good zone is backfilled on the second pass");
  assert.equal((await rows("ez_ok")).get("CORE ok")?.state, "in");
  // Scan: forty zones a pass, the oldest scan first. Forty-one that cannot be read have never been scanned.
  const bad = Array.from({ length: 41 }, (_, index) => `ez_scan_bad_${String(index).padStart(2, "0")}`);
  for (const id of bad) await createZone({ id, title: `坏的 ${id}`, backfilled: 1 });
  await db.query("UPDATE evimed_frontier.evidence_zones SET definition = $1::jsonb WHERE id = ANY($2::text[])", [broken, bad]);
  await db.query("UPDATE evimed_frontier.evidence_zones SET matched_through = $1 WHERE id = 'ez_ok'", [hoursAgo(1)]);
  await item("CORE later", { hours: 0.5, summaryZh: "semaglutide obesity" });
  clock = new Date(clock.getTime() + minutes(10));
  await membership.tick(clock);
  await membership.tick(new Date(clock.getTime() + 1_000));
  assert.equal((await rows("ez_ok")).get("CORE later")?.state, "in", "the zone behind forty-one unreadable ones is scanned on the second pass");
});
