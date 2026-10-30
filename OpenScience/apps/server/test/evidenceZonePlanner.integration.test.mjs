// The planner of the platform's zones against a real PostgreSQL and a stub model: the first zones seeded from the feed's own statistics
// (once, capped, nothing empty or duplicate), and the Monday pass whose every action is re-derived from the data before it is applied.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import {
  EVIDENCE_ZONE_SEED_INSTRUCTIONS, EVIDENCE_ZONE_WEEKLY_INSTRUCTIONS, PLANNER_ACTIONS_PER_WEEK, beijingWeek, createEvidenceZonePlanner,
} from "../src/evidenceZonePlanner.mjs";
import { insertTopicZone } from "../src/evidenceZoneWrites.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
/** A Monday, 03:30 Beijing time (the pass is due from 03:00). */
const MONDAY = new Date("2026-10-25T19:30:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let isolated, db, zones, plane, editor, planner;

/** A model that answers from a script: the first matching answer for the kind of call (seed or weekly), recorded. */
function scriptedModel({ seed = [], weekly = [] } = {}) {
  const queues = { seed: [...seed], weekly: [...weekly] };
  return {
    available: true,
    calls: [],
    async callJson(messages, limits) {
      const kind = messages[0].content === EVIDENCE_ZONE_SEED_INSTRUCTIONS ? "seed" : messages[0].content === EVIDENCE_ZONE_WEEKLY_INSTRUCTIONS ? "weekly" : "other";
      this.calls.push({ kind, input: JSON.parse(messages[1].content), limits });
      const next = queues[kind]?.shift();
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(this.calls.at(-1).input) : next;
    },
  };
}

/** A data plane that finds items for every keyword except those whose label is in `empty`. */
function recordingPlane(empty = []) {
  const told = { afterSave: [], previews: [] };
  return {
    told,
    async resolveKeywords(definition) { return definition; },
    async preview(definition) {
      told.previews.push(definition.keywords[0].label);
      const none = empty.includes(definition.keywords[0].label);
      return { count30: none ? 0 : 30, perWeek: none ? 0 : 7, band: "normal", recentRowIds: [], borderlineRowIds: [] };
    },
    async afterSave(zoneId) { told.afterSave.push(zoneId); },
  };
}

const draftOf = (title, labels = [title, "治疗"], extra = {}) => ({
  title, type: "drug-indication", keywords: labels.map((label) => ({ label, terms: [label] })), perspective: null, scope: `${title}的研究`,
  include: "讲这个主题", exclude: "不相关的", excludeTerms: [], specialties: ["endocrinology"], group: "测试", ...extra,
});

async function addTag(slug, name, nameEn, kind, specialties = [], broader = null) {
  const broaderId = broader ? (await db.query("SELECT id FROM evimed_frontier.tags WHERE slug = $1", [broader])).rows[0].id : null;
  return Number((await db.query(`INSERT INTO evimed_frontier.tags(slug, name, name_en, kind, specialties, broader_id, state, origin)
    VALUES ($1, $2, $3, $4, $5::text[], $6, 'active', 'seed') RETURNING id`, [slug, name, nameEn, kind, specialties, broaderId])).rows[0].id);
}
const TAG_IDS = {};

/** `count` published items visible `daysAgo` before MONDAY, each carrying the named tags. */
async function items(count, daysAgo, tagSlugs, overrides = {}) {
  const made = [];
  for (let index = 0; index < count; index += 1) {
    const visibleAt = new Date(MONDAY.getTime() - daysAgo * DAY - index * 1000).toISOString();
    const item = await insertItem(db, { title: `${tagSlugs.join("+")} ${daysAgo} ${index}`, visibleAt, timelineAt: visibleAt, publishedAt: visibleAt, ...overrides });
    for (const [rank, slug] of tagSlugs.entries()) {
      await db.query("INSERT INTO evimed_frontier.item_tags(item_id, tag_id, rank, origin) VALUES ($1, $2, $3, 'edit')", [item.id, TAG_IDS[slug], rank + 1]);
    }
    made.push(item);
  }
  return made;
}

/** A platform zone, as the planner makes one, with its history set back. */
async function platformZone(slug, title, { lifecycle = "active", ageDays = 400, keywords = [title, "治疗"], tagIds = [] } = {}) {
  const id = `ez_${slug}`;
  const definition = { version: 1, type: "drug-indication", keywords: keywords.map((label, index) => ({ label, terms: [label], tagIds: index === 0 ? tagIds : [], entityKeys: [] })),
    perspective: null, scope: `${title}的范围`, include: "", exclude: "", excludeTerms: [], specialties: ["endocrinology"], group: "测试", seeds: { positive: [], negative: [] } };
  await db.transaction((client) => insertTopicZone(client, { id, userId: PLATFORM_PUBLISHER_USER_ID, kind: "official", state: "published", visibility: "internet", title, definition, slug }));
  await db.query("UPDATE evimed_frontier.evidence_zones SET lifecycle = $2, created_at = $3 WHERE id = $1", [id, lifecycle, new Date(MONDAY.getTime() - ageDays * DAY).toISOString()]);
  return id;
}
/** Put items into a zone as `in`. @param {string} zoneId @param {Array<{ id: string }>} list */
async function fill(zoneId, list) {
  await db.query("INSERT INTO evimed_frontier.zone_items(zone_id, item_id, state, via, role, relevance) SELECT $1, x, 'in', 'tag', 'research', 'core' FROM unnest($2::bigint[]) AS x ON CONFLICT DO NOTHING",
    [zoneId, list.map((item) => item.id)]);
}
/** Each of the last `weeks` complete Beijing weeks gets `perWeek[i]` items in the zone, mid-week. */
async function series(zoneId, perWeek) {
  for (const [index, count] of perWeek.entries()) {
    if (!count) continue;
    const visibleAt = new Date(MONDAY.getTime() - (index + 1) * 7 * DAY + 2 * DAY).toISOString();
    const made = [];
    for (let position = 0; position < count; position += 1) {
      const stamp = new Date(new Date(visibleAt).getTime() + position * 1000).toISOString();
      made.push(await insertItem(db, { title: `${zoneId} week ${index + 1} #${position}`, visibleAt: stamp, timelineAt: stamp, publishedAt: stamp }));
    }
    await fill(zoneId, made);
  }
}
const zoneRow = async (id) => (await db.query("SELECT * FROM evimed_frontier.evidence_zones WHERE id = $1", [id])).rows[0];
const changes = async (id) => (await db.query("SELECT kind, actor, detail FROM evimed_frontier.zone_changes WHERE zone_id = $1 ORDER BY id", [id])).rows;
const officialCount = async () => Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_zones WHERE kind = 'official' AND lifecycle <> 'none'")).rows[0].n);
const markSeeded = () => db.query("INSERT INTO evimed_frontier.meta(key, value) VALUES ('zone_planner_seed', '{}'::jsonb) ON CONFLICT (key) DO NOTHING");

function compose({ model, planePlane = recordingPlane(), config = {}, budget = null, now = () => MONDAY, seedPerCall } = {}) {
  plane = planePlane;
  editor = model;
  planner = createEvidenceZonePlanner({ database: db, editor, membership: plane, zones, budget, now, publisherUserId: PLATFORM_PUBLISHER_USER_ID, ...(seedPerCall ? { seedPerCall } : {}),
    config: { evidenceZonePlannerEnabled: true, evidenceZoneSeedCount: 4, kbEmbeddingDimension: 1024, ...config } });
  return planner;
}

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "zplanner");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development'),('bob','Bob','development'),('carol','Carol','development')");
  zones = new EvidenceZoneService({ database: db });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones, evimed_frontier.items, evimed_frontier.zone_changes CASCADE");
  await db.query("DELETE FROM evimed_frontier.sources");
  await db.query("DELETE FROM evimed_frontier.meta WHERE key IN ('zone_planner_seed', 'zone_planner_seed_attempts', 'zone_planner_weekly')");
  await db.query("DELETE FROM evimed_frontier.tags WHERE slug LIKE 'ezt-%'");
  await insertSource(db, "nejm");
  await insertSource(db, "lancet");
  TAG_IDS["ezt-glp1"] = await addTag("ezt-glp1", "GLP-1 受体激动剂", "GLP-1 receptor agonist", "drug-class", ["endocrinology"]);
  TAG_IDS["ezt-sema"] = await addTag("ezt-sema", "司美格鲁肽", "semaglutide", "drug", ["endocrinology"], "ezt-glp1");
  TAG_IDS["ezt-obesity"] = await addTag("ezt-obesity", "肥胖", "obesity", "disease", ["endocrinology"]);
  TAG_IDS["ezt-t2dm"] = await addTag("ezt-t2dm", "2 型糖尿病", "type 2 diabetes", "disease", ["endocrinology"]);
  TAG_IDS["ezt-pd1"] = await addTag("ezt-pd1", "PD-1 抑制剂", "PD-1 inhibitor", "drug-class", ["oncology"]);
  TAG_IDS["ezt-nsclc"] = await addTag("ezt-nsclc", "非小细胞肺癌", "NSCLC", "disease", ["oncology"]);
  TAG_IDS["ezt-rare"] = await addTag("ezt-rare", "冷门技术", "rare technology", "technology", ["radiology"]);
  TAG_IDS["ezt-flu"] = await addTag("ezt-flu", "流感", "influenza", "disease", ["infectious-disease"]);
  TAG_IDS["ezt-tcm"] = await addTag("ezt-tcm", "医保谈判", "price negotiation", "policy", []);
});

test("the Beijing week of an instant starts on its Monday, and the pass is due from 03:00 that day", () => {
  assert.deepEqual(beijingWeek(MONDAY).week, "2026-10-26");
  assert.equal(beijingWeek(MONDAY).startsAt.toISOString(), "2026-10-25T19:00:00.000Z");
  assert.equal(beijingWeek(new Date("2026-10-31T15:59:59Z")).week, "2026-10-26", "Saturday 23:59 Beijing is the same week");
  assert.equal(beijingWeek(new Date("2026-10-31T16:00:00Z")).week, "2026-10-26", "Sunday 00:00 Beijing too");
  assert.equal(beijingWeek(new Date("2026-11-01T16:00:00Z")).week, "2026-11-02", "Monday 00:00 Beijing starts the next");
});

test("the statistics are the feed's own: pairs of an intervention and a disease by distinct events, a drug counted under its class, the window honoured", options, async () => {
  compose({ model: scriptedModel() });
  await items(14, 5, ["ezt-sema", "ezt-obesity"]);
  await items(16, 9, ["ezt-glp1", "ezt-t2dm"]);
  await items(20, 3, ["ezt-pd1", "ezt-nsclc"]);
  await items(30, 45, ["ezt-pd1", "ezt-nsclc"]);
  await items(3, 4, ["ezt-rare", "ezt-flu"]);
  const stats = await planner.candidateStatistics(MONDAY);
  const pair = (a, b) => stats.pairs.find((row) => row.a_name === a && row.b_name === b);
  assert.equal(pair("PD-1 抑制剂", "非小细胞肺癌").events, 20, "the 45-day-old items are outside the window");
  assert.equal(pair("GLP-1 受体激动剂", "肥胖").events, 14, "an item tagged with a drug counts for its class");
  assert.equal(pair("司美格鲁肽", "肥胖").events, 14);
  assert.equal(pair("GLP-1 受体激动剂", "2 型糖尿病").events, 16);
  assert.equal(pair("冷门技术", "流感"), undefined, "below the floor of a candidate");
  assert.ok(stats.hot.some((row) => row.spec === "oncology" && row.name === "PD-1 抑制剂"), "each specialty's most active tags");
});

test("with no platform zone the planner asks in rounds, makes what is usable up to the seed count, and does not seed again", options, async () => {
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  await items(20, 6, ["ezt-pd1", "ezt-nsclc"]);
  await items(20, 7, ["ezt-glp1", "ezt-t2dm"]);
  await items(20, 7, ["ezt-tcm"]);
  const model = scriptedModel({
    seed: [
      { zones: [
        { slug: "glp1-obesity", draft: draftOf("GLP-1 受体激动剂减重") },
        { slug: "pd1-nsclc", draft: draftOf("PD-1 抑制剂治疗非小细胞肺癌", ["PD-1 抑制剂", "非小细胞肺癌"], { specialties: ["oncology", "not-a-key"] }) },
        { slug: "no-words", draft: { title: "没有关键词", keywords: [] } },
        { slug: "empty-topic", draft: draftOf("冷门主题") },
        { slug: "glp1-obesity", draft: draftOf("GLP-1 受体激动剂减重") },
      ] },
      { zones: [
        { slug: "glp1-obesity", draft: draftOf("GLP-1 受体激动剂治疗糖尿病", ["GLP-1 受体激动剂", "2 型糖尿病"]) },
        { slug: "price-negotiation", draft: draftOf("国家医保谈判", ["医保谈判"], { type: "policy" }) },
        { slug: "one-more", draft: draftOf("第五个专区") },
      ] },
    ],
  });
  compose({ model, planePlane: recordingPlane(["冷门主题"]), seedPerCall: 2 });
  const first = await planner.tick();
  assert.equal(model.calls.length, 2, "two calls");
  assert.deepEqual(model.calls.map((call) => call.input.want), [2, 2], "a few at a time, the second for what is still missing");
  const zonesNow = (await db.query("SELECT * FROM evimed_frontier.evidence_zones WHERE kind = 'official' ORDER BY created_at, id")).rows;
  assert.equal(zonesNow.length, 4, "capped at the seed count: the fifth is not made");
  assert.deepEqual(zonesNow.map((row) => row.title).sort(), ["GLP-1 受体激动剂治疗糖尿病", "GLP-1 受体激动剂减重", "PD-1 抑制剂治疗非小细胞肺癌", "国家医保谈判"].sort());
  for (const row of zonesNow) {
    assert.deepEqual([row.user_id, row.state, row.visibility, row.lifecycle, row.definition_version], [PLATFORM_PUBLISHER_USER_ID, "published", "internet", "active", 1]);
    assert.match(row.slug, /^[a-z0-9][a-z0-9-]*$/);
  }
  assert.equal(new Set(zonesNow.map((row) => row.slug)).size, 4, "slugs are unique, a repeated one is suffixed");
  assert.deepEqual(zonesNow.find((row) => row.title.startsWith("PD-1")).specialties, ["oncology"], "a specialty outside the thirty is dropped");
  assert.equal(first.seeded.created, 4);
  assert.equal(first.seeded.complete, true);
  const history = await changes(zonesNow[0].id);
  assert.deepEqual([history[0].kind, history[0].actor, history[0].detail.reason], ["created", "planner", "seed"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plane.told.afterSave.length, 4, "the data plane collects each");
  assert.ok(!plane.told.previews.includes("没有关键词"), "a draft without keywords never reached the data plane");
  // The statistics the model read are the feed's, shown without ids.
  const shown = model.calls[0].input;
  assert.ok(shown.pairs.some((pair) => pair.a === "GLP-1 受体激动剂" && pair.b === "肥胖" && pair.n === 20));
  assert.ok(shown.policy.some((row) => row.tag === "医保谈判"));
  assert.deepEqual(model.calls[0].input.chosen, []);
  assert.equal(model.calls[1].input.chosen.length, 2, "the second call is told what exists");
  assert.equal(model.calls[0].limits.maxTokens > 4000, true);
  // Seeded: nothing more is asked, however many ticks.
  assert.deepEqual((await planner.tick()).seeded, { skipped: "seeded" });
  assert.equal(model.calls.length, 2);
  assert.equal(await officialCount(), 4);
});

test("a feed that supports fewer zones than the seed count: after the attempts are spent, across restarts, the seeding is done and the weekly pass runs", options, async () => {
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  const nothing = { zones: [] };
  const model = scriptedModel({
    seed: [{ zones: [{ slug: "a", draft: draftOf("甲专区") }, { slug: "b", draft: draftOf("乙专区") }] }, ...Array(40).fill(nothing)],
    weekly: [{ actions: [] }],
  });
  let clock = MONDAY;
  compose({ model, now: () => clock });
  const seedCalls = () => model.calls.filter((call) => call.kind === "seed").length;
  assert.equal((await planner.tick(clock)).seeded.complete, false, "the feed gave two of four");
  assert.equal(await officialCount(), 2);
  // Attempts two and three, then a restart: a new planner has no memory of them, the database has.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    clock = new Date(clock.getTime() + 61 * 60_000);
    assert.equal((await planner.tick(clock)).seeded.complete, false);
  }
  compose({ model, now: () => clock });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    clock = new Date(clock.getTime() + 61 * 60_000);
    assert.equal((await planner.tick(clock)).seeded.complete, false, `attempt ${attempt + 4}`);
  }
  assert.equal(seedCalls(), 3 + 5 * 2, "six attempts: the first asks three times (two zones, then two empty answers), the others twice");
  assert.equal((await db.query("SELECT value FROM evimed_frontier.meta WHERE key = 'zone_planner_seed_attempts'")).rows[0].value.count, 6);
  assert.equal(await db.query("SELECT 1 FROM evimed_frontier.meta WHERE key = 'zone_planner_seed'").then((result) => result.rowCount), 0, "not yet");
  // The seventh look: the attempts are spent, the zones there are the platform's, and the week's pass runs with them.
  clock = new Date(clock.getTime() + 61 * 60_000);
  const last = await planner.tick(clock);
  assert.deepEqual(last.seeded, { skipped: "seeded" });
  assert.equal(last.weekly.week, "2026-10-26", "the weekly pass ran with two zones, short of the seed count");
  const marker = (await db.query("SELECT value FROM evimed_frontier.meta WHERE key = 'zone_planner_seed'")).rows[0].value;
  assert.deepEqual([marker.by, marker.zones], ["attempts", 2]);
  assert.equal(seedCalls(), 3 + 5 * 2, "nothing more was asked");
  // Another restart buys no attempts back.
  compose({ model, now: () => clock });
  assert.deepEqual((await planner.tick(clock)).seeded, { skipped: "seeded" });
  assert.equal(seedCalls(), 3 + 5 * 2);
});

test("spent attempts with no zone at all leave the seeding open: a restart may try again", options, async () => {
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  const model = scriptedModel({ seed: Array(60).fill({ zones: [] }) });
  let clock = MONDAY;
  compose({ model, now: () => clock });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal((await planner.tick(clock)).seeded.complete, false);
    clock = new Date(clock.getTime() + 61 * 60_000);
  }
  assert.deepEqual((await planner.tick(clock)).seeded, { skipped: "waiting" }, "this process has spent its six");
  const before = model.calls.length;
  compose({ model, now: () => clock });
  assert.equal((await planner.tick(clock)).seeded.complete, false, "a new process asks again: there is nothing to keep");
  assert.ok(model.calls.length > before);
  assert.equal(await db.query("SELECT 1 FROM evimed_frontier.meta WHERE key = 'zone_planner_seed'").then((result) => result.rowCount), 0);
});

const seedAttemptCount = async () => Number((await db.query("SELECT value FROM evimed_frontier.meta WHERE key = 'zone_planner_seed_attempts'")).rows[0]?.value?.count ?? 0);
const seedMarker = async () => (await db.query("SELECT value FROM evimed_frontier.meta WHERE key = 'zone_planner_seed'")).rows[0]?.value ?? null;

// An attempt used to be counted before the model was asked. A control plane restarting through an hour of model trouble spent the
// database's six on timeouts and unreadable answers and, with any zone standing, closed the seeding for good below the count.
test("a timeout, an unreadable answer and a feed with no candidates are not attempts: restarts through model trouble leave the seeding open", options, async () => {
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  await platformZone("alpha", "甲专区");
  const timeout = () => Object.assign(new Error("slow"), { code: "frontier_model_timeout" });
  const trouble = scriptedModel({ seed: [timeout(), { zones: "not a list" }, timeout(), { nonsense: true }, timeout(), { zones: "still not" }, timeout(), timeout()] });
  let clock = MONDAY;
  for (let restart = 0; restart < 8; restart += 1) {
    compose({ model: trouble, now: () => clock });
    const result = await planner.tick(clock);
    assert.equal(result.seeded.complete, false, `look ${restart + 1}`);
    clock = new Date(clock.getTime() + 61 * 60_000);
  }
  assert.equal(trouble.calls.filter((call) => call.kind === "seed").length, 8, "each look asked once");
  assert.equal(await seedAttemptCount(), 0, "none of the eight is an attempt");
  assert.equal(await seedMarker(), null, "the seeding is not closed");
  // No candidates at all is no call and no attempt either.
  await db.query("TRUNCATE evimed_frontier.items CASCADE");
  const empty = scriptedModel();
  for (let restart = 0; restart < 7; restart += 1) {
    compose({ model: empty, now: () => clock });
    assert.deepEqual((await planner.tick(clock)).seeded, { skipped: "no_candidates" });
    clock = new Date(clock.getTime() + 61 * 60_000);
  }
  assert.equal(await seedAttemptCount(), 0);
  assert.equal(await seedMarker(), null);
  // The model recovers: the first readable answer is the first attempt, and the seeding finishes.
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  const recovered = scriptedModel({ seed: [{ zones: [{ slug: "b", draft: draftOf("乙专区") }, { slug: "c", draft: draftOf("丙专区") }, { slug: "d", draft: draftOf("丁专区") }] }] });
  compose({ model: recovered, now: () => clock });
  const done = await planner.tick(clock);
  assert.equal(done.seeded.complete, true);
  assert.equal(await officialCount(), 4);
  assert.equal(await seedAttemptCount(), 1);
});

test("an answer that is readable and makes no zone is an attempt: the database counts it, however many rounds it took", options, async () => {
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  const model = scriptedModel({ seed: Array(6).fill({ zones: [] }) });
  compose({ model, now: () => MONDAY });
  assert.equal((await planner.tick(MONDAY)).seeded.complete, false);
  assert.equal(await seedAttemptCount(), 1, "one attempt, however many questions it asked");
  assert.ok(model.calls.length >= 2, "two empty rounds in a row end it");
});

test("a seed count of zero is seeding switched off: the zones there are still kept by the weekly pass", options, async () => {
  await platformZone("alpha", "甲专区");
  const model = scriptedModel({ weekly: [{ actions: [] }] });
  compose({ model, config: { evidenceZoneSeedCount: 0 } });
  const result = await planner.tick(MONDAY);
  assert.deepEqual(result.seeded, { skipped: "seed_count_zero" });
  assert.equal(result.weekly.week, "2026-10-26");
  assert.equal(model.calls.length, 1);
});

test("a failed or unreadable seeding keeps what was made, tries again after an hour, and finishes without duplicating", options, async () => {
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  let clock = MONDAY;
  const model = scriptedModel({
    seed: [
      { zones: [{ slug: "a", draft: draftOf("甲专区") }, { slug: "b", draft: draftOf("乙专区") }] },
      Object.assign(new Error("slow"), { code: "frontier_model_timeout" }),
      { zones: "not a list" },
      { zones: [{ slug: "b2", draft: draftOf("乙专区") }, { slug: "c", draft: draftOf("丙专区") }, { slug: "d", draft: draftOf("丁专区") }] },
    ],
  });
  compose({ model, now: () => clock });
  const first = await planner.tick(clock);
  assert.equal(first.seeded.complete, false, "the second call failed");
  assert.equal(await officialCount(), 2, "the first call's zones stand");
  assert.deepEqual((await planner.tick(clock)).seeded, { skipped: "waiting" }, "not again at once");
  assert.equal(model.calls.length, 2);
  clock = new Date(clock.getTime() + 61 * 60_000);
  const second = await planner.tick(clock);
  assert.equal(second.seeded.complete, false, "an unreadable list is no list");
  assert.equal(await officialCount(), 2);
  clock = new Date(clock.getTime() + 61 * 60_000);
  const third = await planner.tick(clock);
  assert.equal(third.seeded.complete, true);
  assert.deepEqual((await db.query("SELECT title FROM evimed_frontier.evidence_zones WHERE kind = 'official' ORDER BY title")).rows.map((row) => row.title), ["乙专区", "丁专区", "丙专区", "甲专区"].sort(), "the repeated title was not made twice");
  assert.equal(planner.status().counters.failures >= 2, true);
});

test("nothing is asked while the editor cannot, the budget is spent, or the planner is off; no candidates is no call", options, async () => {
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  const unavailable = scriptedModel();
  unavailable.available = false;
  assert.deepEqual((await compose({ model: unavailable }).tick()).seeded, { skipped: "cannot_ask" });
  const spent = scriptedModel();
  assert.deepEqual((await compose({ model: spent, budget: async () => ({ state: "exhausted" }) }).tick()).seeded, { skipped: "cannot_ask" });
  assert.equal(spent.calls.length, 0);
  assert.equal(planner.status().counters.skippedBudget, 1);
  const off = scriptedModel();
  assert.equal(await compose({ model: off, config: { evidenceZonePlannerEnabled: false } }).tick(), null);
  assert.equal(off.calls.length, 0);
  await db.query("TRUNCATE evimed_frontier.items CASCADE");
  const empty = scriptedModel();
  assert.deepEqual((await compose({ model: empty }).tick()).seeded, { skipped: "no_candidates" });
  assert.equal(empty.calls.length, 0, "no statistics, no question");
  assert.equal(await officialCount(), 0);
});

test("two control planes seeding at once make the seed count between them, not twice", options, async () => {
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  const answer = (prefix) => ({ zones: [1, 2, 3].map((n) => ({ slug: `${prefix}-${n}`, draft: draftOf(`${prefix}专区${n}`) })) });
  const one = compose({ model: scriptedModel({ seed: [answer("甲"), answer("甲二")] }) });
  const modelTwo = scriptedModel({ seed: [answer("乙"), answer("乙二")] });
  const two = createEvidenceZonePlanner({ database: db, editor: modelTwo, membership: recordingPlane(), zones, now: () => MONDAY, publisherUserId: PLATFORM_PUBLISHER_USER_ID,
    config: { evidenceZonePlannerEnabled: true, evidenceZoneSeedCount: 4, kbEmbeddingDimension: 1024 } });
  await Promise.all([one.tick(), two.tick()]);
  assert.equal(await officialCount(), 4);
});

test("an operator can set the pass aside: the weekly pass needs the seeding done, runs once a week from Monday 03:00, and not before", options, async () => {
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  await platformZone("alpha", "甲专区");
  const model = scriptedModel({ weekly: [{ actions: [] }, { actions: [] }] });
  const early = new Date("2026-10-25T18:59:00Z");
  compose({ model });
  assert.deepEqual(await planner.weeklyIfDue(early), { skipped: "not_yet" });
  assert.deepEqual(await planner.weeklyIfDue(MONDAY), { skipped: "not_seeded" });
  await markSeeded();
  const run = await planner.weeklyIfDue(MONDAY);
  assert.equal(run.week, "2026-10-26");
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].input.zones[0].id, "ez_alpha");
  assert.equal(model.calls[0].input.zones[0].weekly.length, 8);
  assert.deepEqual(await planner.weeklyIfDue(new Date(MONDAY.getTime() + 2 * HOUR)), { skipped: "done" }, "once a week");
  assert.equal(model.calls.length, 1);
  const nextWeek = await planner.weeklyIfDue(new Date(MONDAY.getTime() + 7 * DAY));
  assert.equal(nextWeek.week, "2026-11-02");
  assert.equal(model.calls.length, 2);
  // Catching up: the server was down on Monday.
  assert.equal(beijingWeek(new Date(MONDAY.getTime() + 2 * DAY)).week, "2026-10-26");
});

test("a malformed or failed weekly answer changes nothing and is tried again, three times at most", options, async () => {
  await platformZone("alpha", "甲专区", { lifecycle: "quiet" });
  await markSeeded();
  let clock = MONDAY;
  const model = scriptedModel({ weekly: [{ nonsense: true }, Object.assign(new Error("slow"), { code: "frontier_model_timeout" }), "text", { actions: [] }] });
  compose({ model, now: () => clock });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await planner.weeklyIfDue(clock);
    assert.ok(result.failed, `attempt ${attempt}`);
    assert.deepEqual(await planner.weeklyIfDue(clock), { skipped: "waiting" });
    clock = new Date(clock.getTime() + 61 * 60_000);
  }
  assert.deepEqual(await planner.weeklyIfDue(clock), { skipped: "waiting" }, "three tries a week");
  assert.equal((await zoneRow("ez_alpha")).lifecycle, "quiet");
  assert.equal(model.calls.length, 3);
  assert.equal(await db.query("SELECT 1 FROM evimed_frontier.meta WHERE key = 'zone_planner_weekly'").then((result) => result.rowCount), 0);
});

test("quiet, wake and archive are applied only when the numbers say so, and are recorded with what the planner found", options, async () => {
  await markSeeded();
  const quietNow = await platformZone("quiet-now", "该安静的", { ageDays: 200 });
  await series(quietNow, [1, 0, 1, 0, 0, 1, 0, 0]);
  const busy = await platformZone("busy", "忙碌的", { ageDays: 200 });
  await series(busy, [6, 5, 7, 6, 5, 6, 5, 6]);
  const young = await platformZone("young", "新建的", { ageDays: 20 });
  const waking = await platformZone("waking", "醒来的", { lifecycle: "quiet", ageDays: 300 });
  await series(waking, [3, 4, 0, 0, 0, 0, 0, 0]);
  const stillQuiet = await platformZone("still-quiet", "仍安静的", { lifecycle: "quiet", ageDays: 300 });
  await series(stillQuiet, [1, 0, 0, 0, 0, 0, 0, 0]);
  const old = await platformZone("old", "停更一年的", { lifecycle: "quiet", ageDays: 900 });
  const followed = await platformZone("followed", "有人关注的", { lifecycle: "quiet", ageDays: 900 });
  const recentQuiet = await platformZone("recent-quiet", "刚安静的", { lifecycle: "quiet", ageDays: 900 });
  for (const [id, daysAgo] of [[old, 400], [followed, 400], [recentQuiet, 100]]) {
    await db.query("INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail, occurred_at) VALUES ($1, 'quiet', 'planner', '{}', $2)", [id, new Date(MONDAY.getTime() - daysAgo * DAY).toISOString()]);
  }
  await db.query("INSERT INTO evimed_frontier.evidence_zone_follows(user_id, zone_id) VALUES ('alice', $1)", [followed]);
  const model = scriptedModel({ weekly: [{ actions: [
    { action: "quiet", zone: quietNow, perWeek: 0.5, reason: "连续八周不到两条" },
    { action: "quiet", zone: busy, perWeek: 5.5, reason: "该安静吗" },
    { action: "quiet", zone: young, perWeek: 0, reason: "太新了" },
    { action: "active", zone: waking, perWeek: 3.5, reason: "回来了" },
    { action: "active", zone: stillQuiet, perWeek: 0.2, reason: "没回来" },
    { action: "archive", zone: old, perWeek: 0, reason: "停更一年" },
    { action: "archive", zone: followed, perWeek: 0, reason: "有人关注" },
    { action: "archive", zone: recentQuiet, perWeek: 0, reason: "才三个月" },
    { action: "quiet", zone: "ez_unknown", reason: "不存在" },
    "text",
    { action: "teleport", zone: busy },
  ] }] });
  compose({ model });
  const run = await planner.weeklyIfDue(MONDAY);
  const outcome = Object.fromEntries(run.outcomes.map((entry, index) => [index, entry.refused]));
  assert.equal(run.applied, 3, "the three that the numbers support");
  assert.deepEqual([outcome[0], outcome[3], outcome[5], outcome[8], outcome[9], outcome[10]], [null, null, null, "zone_unknown", "action_unreadable", undefined], "the first ten proposals are read, no more");
  assert.equal((await zoneRow(quietNow)).lifecycle, "quiet");
  assert.equal((await zoneRow(waking)).lifecycle, "active");
  assert.equal((await zoneRow(old)).lifecycle, "archived");
  assert.equal(outcome[1], "not_quiet");
  assert.equal(outcome[2], "not_quiet");
  assert.equal(outcome[4], "not_active");
  assert.equal(outcome[6], "not_archivable");
  assert.equal(outcome[7], "not_archivable");
  assert.equal((await zoneRow(busy)).lifecycle, "active");
  assert.equal((await zoneRow(young)).lifecycle, "active", "a zone younger than the eight weeks it is judged on is never quiet");
  const history = await changes(quietNow);
  assert.deepEqual([history.at(-1).kind, history.at(-1).actor, history.at(-1).detail.fromLifecycle, history.at(-1).detail.weekly.length], ["quiet", "planner", "active", 8]);
  assert.equal((await changes(old)).at(-1).kind, "archived");
  assert.equal((await db.query("SELECT value FROM evimed_frontier.meta WHERE key = 'zone_planner_weekly'")).rows[0].value.applied, 3);
});

test("at most five actions are taken in a week, in the model's order, and the rest are not looked at", options, async () => {
  await markSeeded();
  const ids = [];
  for (let index = 0; index < 7; index += 1) {
    const id = await platformZone(`zone-${index}`, `专区${index}`, { ageDays: 200 });
    await series(id, [1, 0, 0, 0, 0, 0, 0, 0]);
    ids.push(id);
  }
  const model = scriptedModel({ weekly: [{ actions: ids.map((zone) => ({ action: "quiet", zone, perWeek: 0.2, reason: "安静" })) }] });
  compose({ model });
  const run = await planner.weeklyIfDue(MONDAY);
  assert.equal(run.applied, PLANNER_ACTIONS_PER_WEEK);
  assert.equal(run.outcomes.length, PLANNER_ACTIONS_PER_WEEK);
  assert.deepEqual((await db.query("SELECT id FROM evimed_frontier.evidence_zones WHERE lifecycle = 'quiet' ORDER BY id")).rows.map((row) => row.id), ids.slice(0, 5).sort());
});

test("a cited number that is not the data's refuses the action", options, async () => {
  await markSeeded();
  const quiet = await platformZone("quiet-now", "该安静的", { ageDays: 200 });
  await series(quiet, [1, 0, 0, 0, 0, 0, 0, 0]);
  const model = scriptedModel({ weekly: [{ actions: [{ action: "quiet", zone: quiet, perWeek: 40, reason: "写错了数字" }] }] });
  compose({ model });
  const run = await planner.weeklyIfDue(MONDAY);
  assert.deepEqual(run.outcomes, [{ action: "quiet", refused: "cited_number_mismatch" }]);
  assert.equal((await zoneRow(quiet)).lifecycle, "active");
  assert.equal(planner.status().counters.actionsRefused, 1);
});

test("a zone above the band for four weeks is split into narrower zones and archived with their ids; an incomplete split changes nothing", options, async () => {
  await markSeeded();
  const wide = await platformZone("wide", "太宽的", { ageDays: 200 });
  await series(wide, [61, 62, 61, 63, 0, 0, 0, 0]);
  const narrow = await platformZone("narrow", "正好的", { ageDays: 200 });
  await series(narrow, [10, 10, 10, 10, 0, 0, 0, 0]);
  await db.query("INSERT INTO evimed_frontier.evidence_zone_follows(user_id, zone_id, created_at) VALUES ('alice', $1, '2026-09-01T00:00:00Z'), ('bob', $1, '2026-10-01T00:00:00Z'), ('bob', $2, '2026-10-02T00:00:00Z')", [wide, narrow]);
  const model = scriptedModel({ weekly: [{ actions: [
    { action: "split", zone: narrow, perWeek: 10, into: [{ slug: "n1", draft: draftOf("窄一") }, { slug: "n2", draft: draftOf("窄二") }], reason: "不宽" },
    { action: "split", zone: wide, perWeek: 62, into: [{ slug: "w1", draft: draftOf("加一个限定甲") }], reason: "只给了一个" },
    { action: "split", zone: wide, perWeek: 62, into: [{ slug: "w1", draft: draftOf("加一个限定甲") }, { slug: "w2", draft: draftOf("加一个限定乙") }, { slug: "w3", draft: draftOf("冷门限定") }], reason: "拆开" },
  ] }] });
  compose({ model, planePlane: recordingPlane(["冷门限定"]) });
  const run = await planner.weeklyIfDue(MONDAY);
  assert.deepEqual(run.outcomes.map((entry) => entry.refused), ["not_above_band", "split_needs_two", null]);
  assert.equal((await zoneRow(narrow)).lifecycle, "active");
  assert.equal((await zoneRow(wide)).lifecycle, "archived");
  const record = (await changes(wide)).at(-1);
  assert.equal(record.kind, "split");
  assert.equal(record.detail.into.length, 2, "the empty one was not made");
  const made = (await db.query("SELECT id, title FROM evimed_frontier.evidence_zones WHERE id = ANY($1::text[]) ORDER BY title", [record.detail.into])).rows;
  assert.deepEqual(made.map((row) => row.title), ["加一个限定乙", "加一个限定甲"].sort());
  assert.equal((await changes(made[0].id))[0].detail.from, wide, "each new zone says what it came from");
  // The wide zone's followers follow every piece of it, from the day they began to follow; nobody is left on a zone that collects no more.
  assert.deepEqual(record.detail.movedFollowers, ["alice", "bob"]);
  const follows = (await db.query("SELECT user_id, zone_id, created_at FROM evimed_frontier.evidence_zone_follows ORDER BY zone_id, user_id")).rows;
  assert.equal(follows.some((row) => row.zone_id === wide), false);
  for (const piece of made) {
    assert.deepEqual(follows.filter((row) => row.zone_id === piece.id).map((row) => [row.user_id, row.created_at.toISOString()]),
      [["alice", "2026-09-01T00:00:00.000Z"], ["bob", "2026-10-01T00:00:00.000Z"]], "each piece has both followers, with the day they began");
  }
  assert.equal(follows.filter((row) => row.zone_id === narrow).length, 1, "a zone that was not split keeps its own follower");
});

test("a split whose second zone cannot be made takes back the first and leaves the wide zone as it was", options, async () => {
  await markSeeded();
  const wide = await platformZone("wide", "太宽的", { ageDays: 200 });
  await series(wide, [61, 62, 61, 63, 0, 0, 0, 0]);
  const model = scriptedModel({ weekly: [{ actions: [
    { action: "split", zone: wide, perWeek: 62, into: [{ slug: "w1", draft: draftOf("加一个限定甲") }, { slug: "w2", draft: draftOf("冷门限定") }], reason: "拆开" },
  ] }] });
  compose({ model, planePlane: recordingPlane(["冷门限定"]) });
  const run = await planner.weeklyIfDue(MONDAY);
  assert.deepEqual(run.outcomes, [{ action: "split", refused: "split_incomplete" }]);
  assert.equal((await zoneRow(wide)).lifecycle, "active");
  assert.equal(await officialCount(), 1);
});

test("overlapping zones merge: the partner is archived, its followers move, a new definition may replace the kept zone's; unrelated zones do not", options, async () => {
  await markSeeded();
  const keep = await platformZone("keep", "保留的", { ageDays: 200 });
  const gone = await platformZone("gone", "并入的", { ageDays: 200 });
  const other = await platformZone("other", "不相干的", { ageDays: 200 });
  const shared = await items(10, 5, ["ezt-glp1"]);
  await fill(keep, shared);
  await fill(gone, shared.slice(0, 8));
  await fill(other, (await items(10, 6, ["ezt-pd1"])));
  await db.query("INSERT INTO evimed_frontier.evidence_zone_follows(user_id, zone_id, created_at) VALUES ('alice', $1, '2026-09-05T00:00:00Z'), ('bob', $1, '2026-09-06T00:00:00Z'), ('bob', $2, '2026-09-07T00:00:00Z')", [gone, keep]);
  const model = scriptedModel({ weekly: [{ actions: [
    { action: "merge", zone: keep, with: other, reason: "不重叠" },
    { action: "merge", zone: keep, with: "ez_missing", reason: "不存在" },
    { action: "merge", zone: keep, with: keep, reason: "自己" },
    { action: "merge", zone: keep, with: gone, draft: draftOf("合并后的专区"), reason: "高度重叠" },
  ] }] });
  compose({ model });
  const run = await planner.weeklyIfDue(MONDAY);
  assert.deepEqual(run.outcomes.map((entry) => entry.refused), ["not_overlapping", "merge_partner_unknown", "merge_partner_unknown", null]);
  assert.equal((await zoneRow(gone)).lifecycle, "archived");
  assert.equal((await zoneRow(keep)).lifecycle, "active");
  assert.equal((await zoneRow(keep)).title, "合并后的专区");
  assert.equal((await zoneRow(keep)).definition_version, 2);
  assert.equal((await zoneRow(other)).lifecycle, "active");
  const record = (await changes(gone)).at(-1);
  assert.deepEqual([record.kind, record.detail.into, record.detail.fromLifecycle, record.detail.movedFollowers], ["merged", keep, "active", ["alice", "bob"]]);
  assert.deepEqual((await db.query("SELECT user_id FROM evimed_frontier.evidence_zone_follows WHERE zone_id = $1 ORDER BY user_id", [keep])).rows.map((row) => row.user_id), ["alice", "bob"]);
  assert.equal((await db.query("SELECT created_at FROM evimed_frontier.evidence_zone_follows WHERE zone_id = $1 AND user_id = 'alice'", [keep])).rows[0].created_at.toISOString(), "2026-09-05T00:00:00.000Z", "a moved follow keeps the day it began");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.evidence_zone_follows WHERE zone_id = $1", [gone])).rows[0].n, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(plane.told.afterSave.includes(keep), "a redefined zone is collected again");
});

test("a new zone is made from an uncovered pair or a reader's zone, only if the data plane finds items for it, and never a duplicate", options, async () => {
  await markSeeded();
  await items(20, 5, ["ezt-sema", "ezt-obesity"]);
  const covered = await platformZone("covered", "已有的", { tagIds: [TAG_IDS["ezt-glp1"], TAG_IDS["ezt-obesity"]] });
  await db.query("UPDATE evimed_frontier.evidence_zones SET definition = jsonb_set(definition, '{keywords,1,tagIds}', to_jsonb($2::bigint[])) WHERE id = $1", [covered, [TAG_IDS["ezt-obesity"]]]);
  const community = `ez_community`;
  await db.transaction((client) => insertTopicZone(client, { id: community, userId: "alice", kind: "user", state: "published", visibility: "platform", title: "读者的专区",
    definition: { version: 1, type: "drug-indication", keywords: [{ label: "读者关注", terms: [], tagIds: [], entityKeys: [] }], perspective: null, scope: "s", include: "", exclude: "", excludeTerms: [], specialties: [], group: "", seeds: { positive: [], negative: [] } } }));
  await db.query("INSERT INTO evimed_frontier.evidence_zone_follows(user_id, zone_id) VALUES ('bob', $1)", [community]);
  const model = scriptedModel({ weekly: [{ actions: [
    { action: "create", slug: "new-one", draft: draftOf("新建的专区"), fromZone: community, reason: "读者关注多" },
    { action: "create", slug: "empty", draft: draftOf("冷门主题"), reason: "没有内容" },
    { action: "create", slug: "dup", draft: draftOf("已有的"), reason: "重复" },
    { action: "create", draft: { title: "坏了" }, reason: "没有关键词" },
  ] }] });
  compose({ model, planePlane: recordingPlane(["冷门主题"]) });
  const run = await planner.weeklyIfDue(MONDAY);
  assert.deepEqual(run.outcomes.map((entry) => entry.refused), [null, "nothing_collected", "duplicate", "draft_unreadable"]);
  const input = model.calls[0].input;
  assert.deepEqual(input.community.map((entry) => [entry.id, entry.follows]), [[community, 1]], "a reader's zone someone else follows is a signal");
  assert.ok(input.uncovered.some((pair) => pair.a === "司美格鲁肽" && pair.b === "肥胖"), "a pair no zone covers is offered");
  assert.ok(!input.uncovered.some((pair) => pair.a === "GLP-1 受体激动剂" && pair.b === "肥胖"), "a pair a zone already covers is not");
  const made = (await db.query("SELECT * FROM evimed_frontier.evidence_zones WHERE title = '新建的专区'")).rows[0];
  assert.equal(made.kind, "official");
  assert.equal((await changes(made.id))[0].detail.fromZone, community);
  assert.equal((await zoneRow(community)).kind, "user", "a reader's zone is never touched");
  assert.equal((await zoneRow(community)).revision, 1);
});
