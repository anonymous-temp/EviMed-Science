// Hot-event topics (c2-leads 2026-10-25) against a real PostgreSQL: a fake plugin serving hot-list snapshots, a fake editor
// answering the grouping, topic and overview calls through the real checks, a fake vocabulary and a fake web search; the
// sightings, the candidate rule, the quota, the name rule, the waves, the joins, the overview, the close and the reading real.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierLeads, migrateFrontierLeads } from "../src/frontierLeads.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { FRONTIER_TOPIC_OVERVIEW_INSTRUCTIONS, FRONTIER_TOPIC_WRITE_INSTRUCTIONS, FrontierTopics, migrateFrontierTopics } from "../src/frontierTopics.mjs";
import { migrateEvidenceZones } from "../src/evidenceZonePersistence.mjs";
import { TEST_VOCABULARY, insertSource } from "./helpers/frontierFixtures.mjs";
import { insertComposedItem, resetFrontier } from "./helpers/frontierComposeFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** 2026-03-24 22:00 in Shanghai: the evening of the event. */
const T0 = new Date("2026-03-24T14:00:00Z");
const at = (/** @type {number} */ minutes) => new Date(T0.getTime() + minutes * 60_000);
const owner = { userId: "frontier-operator", projectId: "evimed-frontier" };
const reader = { id: `reader_${randomUUID().slice(0, 8)}` };
const config = { frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300 };

/** @type {any} */
let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateFrontierLeads(database);
  await migrateFrontierTopics(database);
  await migrateEvidenceZones(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Reader','development') ON CONFLICT DO NOTHING", [reader.id]);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id = $1", [reader.id]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  for (const table of ["topic_items", "topics", "hot_sightings", "hot_boards", "lead_urls", "leads", "item_keys"]) await database.query(`DELETE FROM evimed_frontier.${table}`);
  await database.query("DELETE FROM evimed_frontier.meta WHERE key = 'hot_lists_cursor'");
  await resetFrontier(database);
  await insertSource(database, "jama", { name: "JAMA", authority: 5 });
  await insertSource(database, "health", { name: "健康时报", source_type: "media", authority: 3 });
});

/** One board's snapshot as the plugin client returns it. @param {string} board @param {Date} when @param {Array<[string, number, string?]>} entries */
const snap = (board, when, entries) => ({ board, fetchedAt: when.toISOString(),
  entries: entries.map(([title, rank, desc]) => ({ rank, title, heat: 1000 - rank, desc: desc ?? null, url: `https://s.example.cn/${encodeURIComponent(title)}` })) });

const EVENT = "张雪峰去世";
const PEG_DESC = "据其公司讣告，张雪峰于3月24日因心源性猝死离世";
const weibo = (/** @type {Date} */ when, flash = true) => snap("weibo", when, [
  [EVENT, 1], ["日剧Vivant抹黑中国", 2], ["心源性猝死", 3], ...(flash ? [/** @type {[string, number]} */ (["闪现的条目", 4])] : []),
  ["某明星死因曝光", 5], ["黄金四分钟是心源性猝死抢救关键", 8], ["4成心源性猝死患者不到40岁", 9], ["金价又涨了", 35]]);
const baidu = (/** @type {Date} */ when) => snap("baidu", when, [[EVENT, 2, PEG_DESC], ["国考报名人数创新高", 6]]);

/** A plugin serving the snapshots taken after `since`. @param {any[]} snapshots */
function fakePlugin(snapshots) {
  const asked = [];
  return { asked, configured: true, async hotLists(/** @type {{ since: string | null }} */ { since }) {
    asked.push(since);
    return { boards: snapshots.filter((snapshot) => !since || snapshot.fetchedAt > since) };
  }, async submitLeads(/** @type {any[]} */ leads) {
    return { accepted: leads.length, duplicate: 0, refused: 0, capped: 0, results: leads.map((lead) => ({ url: lead.url, status: "accepted", reason: null })) };
  } };
}

/** The candidates' numbers by title, read from the grouping input. @param {string} input */
const numbersOf = (input) => Object.fromEntries([...input.matchAll(/^\[(\d+)\] [^｜]+｜(.+)$/gm)].map((match) => [match[2], Number(match[1])]));

/** The grouping answer for the evening of the 24th, built from the numbers it was shown. @param {string} input */
function eveningGroups(input) {
  const n = numbersOf(input);
  const ids = (/** @type {string[]} */ titles) => titles.map((title) => n[title]).filter(Boolean);
  return { groups: [
    { members: ids([EVENT, "心源性猝死", "黄金四分钟是心源性猝死抢救关键", "4成心源性猝死患者不到40岁"]),
      medical_members: ids(["心源性猝死", "黄金四分钟是心源性猝死抢救关键", "4成心源性猝死患者不到40岁"]), domain: "public-figure", medical: true,
      needs_private_health: false, subject_names: ["张雪峰"], question: "运动会诱发心源性猝死吗", same_as: null, confidence: 0.92 },
    { members: ids(["日剧Vivant抹黑中国"]), medical_members: [], domain: "entertainment", medical: false, needs_private_health: false, subject_names: [], question: "", confidence: 0.95 },
    { members: ids(["某明星死因曝光"]), medical_members: [], domain: "public-figure", medical: true, needs_private_health: true, subject_names: ["某明星"], question: "某明星的死因", confidence: 0.8 },
    { members: ids(["国考报名人数创新高"]), medical_members: [], domain: "education", medical: false, needs_private_health: false, subject_names: [], question: "", confidence: 0.9 },
  ] };
}

const GOOD_TOPIC = {
  title: "运动会诱发心源性猝死吗？风险有多大", question: "健康成年人跑步等运动时发生心源性猝死的风险有多大，谁需要先做检查？",
  peg: "据其公司讣告，一位知名教育博主于3月24日因心源性猝死离世。", peg_entry: 1,
  entities: { diseases: ["心源性猝死", "心脏骤停", "不认识的病"], drugs: [] },
  queries: { zh_reports: ["张雪峰 心源性猝死 专家", "运动性猝死 专家解读"], zh_evidence: ["心源性猝死 预防 指南", "心肺复苏 AED 共识"],
    en_evidence: ["cardiac arrest long-distance running races incidence", "exercise-related sudden cardiac death systematic review"], stats: ["院外心脏骤停 存活率 中国"] },
};

/**
 * An editor whose calls answer from scripts and run the module's own checks as `FrontierEditor.#write` does: the first
 * answer, then the second when the first failed.
 * @param {{ groups?: (input: string) => any, topic?: any[], overview?: (input: string) => any[] }} script
 */
function fakeEditor({ groups = eveningGroups, topic = [GOOD_TOPIC], overview = () => [{ overview_zh: "" }] } = {}) {
  const calls = { group: /** @type {string[]} */ ([]), topic: /** @type {string[]} */ ([]), overview: /** @type {string[]} */ ([]) };
  return {
    calls,
    async callJson(/** @type {any[]} */ messages) { calls.group.push(messages[1].content); return groups(messages[1].content); },
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ input, /** @type {number} */ _max, /** @type {{ verify: Function }} */ { verify }) {
      const kind = instructions === FRONTIER_TOPIC_OVERVIEW_INSTRUCTIONS ? "overview" : instructions === FRONTIER_TOPIC_WRITE_INSTRUCTIONS ? "topic" : "other";
      calls[/** @type {"topic" | "overview"} */ (kind)].push(input);
      const answers = kind === "overview" ? overview(input) : topic;
      const first = verify(answers[0]);
      if (!first.issues.length) return { verification: "passed", output: first.output };
      if (answers[1]) {
        const second = verify(answers[1]);
        if (!second.issues.length) return { verification: "repaired", output: second.output };
      }
      return { verification: "dropped", output: null, issues: first.issues };
    },
  };
}

const vocabularyStub = {
  async keysForEntities(/** @type {any} */ entities) { return (entities.diseases ?? []).filter((/** @type {string} */ name) => ["心源性猝死", "心脏骤停"].includes(name)).map((/** @type {string} */ name) => `disease:${name}`); },
  async keysForText() { return []; },
};

/** @param {{ plugin?: any, editor?: any, now?: () => Date, budget?: any, extra?: Record<string, any> }} [input] */
function topicsWith({ plugin = fakePlugin([weibo(at(0)), baidu(at(5)), weibo(at(30), false), baidu(at(35))]), editor = fakeEditor(), now = () => at(40),
  budget = async () => ({ state: "ok" }), extra = {} } = {}) {
  return new FrontierTopics({ database, plugin, editor, entityVocabulary: vocabularyStub, budget, config: { ...config, ...extra }, now });
}

test("the hot lists become sightings; a candidate is new, ranked ≤ 30 and seen in two consecutive snapshots; one key across boards is one candidate", options, async () => {
  const topics = topicsWith();
  assert.equal((await topics.readHotLists(at(40))).snapshots, 4);
  const candidates = await topics.candidates(at(40));
  const titles = candidates.map((candidate) => candidate.title);
  assert.ok(!titles.includes("闪现的条目"), "a flash entry gone at the next round is not a candidate");
  assert.ok(!titles.includes("金价又涨了"), "rank 35 is not a candidate");
  const event = candidates.find((candidate) => candidate.title === EVENT);
  assert.deepEqual(event?.boards.map((board) => [board.board, board.rank]).sort(), [["baidu", 2], ["weibo", 1]]);
  assert.equal(event?.description, PEG_DESC);
  assert.deepEqual(candidates.map((candidate) => candidate.n), candidates.map((_, index) => index + 1));
  // The cursor: a second read asks from the last snapshot and folds nothing twice.
  const again = await topics.readHotLists(at(41));
  assert.equal(again.snapshots, 0);
  const streak = (await database.query("SELECT streak FROM evimed_frontier.hot_sightings WHERE board = 'weibo' AND title_key = 'vivant'")).rows;
  assert.equal(streak.length, 0, "the key is the whole title's");
  const vivant = (await database.query("SELECT streak, best_rank FROM evimed_frontier.hot_sightings WHERE board = 'weibo' AND title = '日剧Vivant抹黑中国'")).rows[0];
  assert.deepEqual([vivant.streak, vivant.best_rank], [2, 2]);
});

test("a round: the medical event becomes a surge topic, the rest are refused by the model's own answer, a name in the title is rewritten away", options, async () => {
  // A paper of the last week that shares the event's key joins at creation (corpus), as evidence.
  const paper = await insertComposedItem(database, { sourceId: "jama", title: "Cardiac Arrest During Long-Distance Running Races", entityKeys: ["disease:心源性猝死"],
    publishedAt: "2026-03-20T00:00:00Z", timelineAt: "2026-03-21T00:00:00Z", visibleAt: "2026-03-21T00:00:00Z" });
  const editor = fakeEditor({ topic: [{ ...GOOD_TOPIC, title: "张雪峰猝死：运动风险多大" }, GOOD_TOPIC] });
  const topics = topicsWith({ editor });
  const result = await topics.tick();
  assert.equal(result.parts.detect.accepted, 1);
  assert.equal(editor.calls.group.length, 1);
  assert.match(editor.calls.group[0], /【已有话题】\n无/);
  assert.equal(editor.calls.topic.length, 1, "one topic call (its rewrite is inside it)");
  const [row] = (await database.query("SELECT * FROM evimed_frontier.topics")).rows;
  assert.equal(row.title_zh, GOOD_TOPIC.title, "the rewrite without the name");
  assert.equal(row.surge, true, "top ten of two boards and three medical entries");
  assert.equal(row.domain, "public-figure");
  assert.deepEqual(row.subject_names, ["张雪峰"]);
  assert.deepEqual(row.entity_keys.sort(), ["disease:心源性猝死", "disease:心脏骤停"], "only keys the vocabulary knows");
  assert.deepEqual(row.boards.map((/** @type {any} */ board) => [board.board, board.peakRank]).sort(), [["baidu", 2], ["weibo", 1]]);
  assert.deepEqual(row.peg_source, { name: "微博热搜", url: `https://s.example.cn/${encodeURIComponent(EVENT)}`, date: "2026-03-24" });
  assert.deepEqual(row.waves.map((/** @type {any} */ wave) => wave.due), ["2026-03-24T14:40:00.000Z", "2026-03-24T20:40:00.000Z", "2026-03-25T01:00:00.000Z"]);
  assert.equal(topics.counters.refused.not_medical, 2);
  assert.equal(topics.counters.refused.private_health, 1, "「死因曝光」: a named person's health nobody stated");
  assert.equal(topics.counters.accepted["public-figure"], 1);
  const joined = (await database.query("SELECT item_id, role, via FROM evimed_frontier.topic_items")).rows;
  assert.deepEqual(joined.map((/** @type {any} */ item) => [String(item.item_id), item.role, item.via]), [[paper.id, "evidence", "corpus"]]);
  // Every candidate was offered once: the next round, with nothing new on the boards, asks nothing.
  const next = await topicsWith({ editor, now: () => at(70) }).tick();
  assert.equal(next.parts.detect.candidates, 0);
  assert.equal(editor.calls.group.length, 1);
});

test("a name the rewrite keeps, a low confidence, a spent budget and a full day make no topic", options, async () => {
  const named = fakeEditor({ topic: [{ ...GOOD_TOPIC, title: "张雪峰猝死：运动风险多大" }, { ...GOOD_TOPIC, question: "张雪峰为什么猝死？" }] });
  await topicsWith({ editor: named }).tick();
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.topics")).rows[0].n, 0);
  await database.query("DELETE FROM evimed_frontier.hot_sightings; DELETE FROM evimed_frontier.hot_boards; DELETE FROM evimed_frontier.meta WHERE key = 'hot_lists_cursor'");
  const unsure = fakeEditor({ groups: (input) => ({ groups: eveningGroups(input).groups.map((group) => ({ ...group, confidence: 0.5 })) }) });
  const low = topicsWith({ editor: unsure });
  await low.tick();
  assert.equal(low.counters.refused.low_confidence, 1, "the event; the private one is refused for that first");
  await database.query("DELETE FROM evimed_frontier.hot_sightings; DELETE FROM evimed_frontier.hot_boards; DELETE FROM evimed_frontier.meta WHERE key = 'hot_lists_cursor'");
  const spent = topicsWith({ budget: async () => ({ state: "exhausted" }) });
  const answer = await spent.tick();
  assert.equal(answer.parts.detect.skipped, "budget");
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.hot_sightings WHERE offered_at IS NOT NULL")).rows[0].n, 0, "not offered: tried again when the budget allows");
  // A full day: four normal topics and the surge already accepted today.
  for (let index = 0; index < 5; index += 1) {
    await database.query(`INSERT INTO evimed_frontier.topics (public_id, group_key, title_zh, question_zh, domain, surge, first_seen_at, accepted_at)
      VALUES ($1, $2, '已有话题', '已有问题', 'other', $3, $4, $4)`, [`full${index}00000000000`, `full-${index}`, index === 4, at(-60)]);
  }
  const full = topicsWith();
  await full.tick();
  assert.equal(full.counters.quotaFull, 1);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.topics")).rows[0].n, 5);
});

test("the topic's searches are the plan's first leads, in waves, each searched once; the pages that arrive join as reports", options, async () => {
  const topics = topicsWith();
  await topics.tick();
  const [topic] = (await database.query("SELECT id, public_id FROM evimed_frontier.topics")).rows;
  const wave0 = await topics.duePlans(at(41));
  assert.deepEqual(wave0.map((plan) => plan.subject.kind), ["zh_reports", "zh_reports", "zh_evidence", "zh_evidence", "en_evidence", "en_evidence", "stats"], "a surge: twice the searches");
  assert.ok(wave0.every((plan) => plan.trigger === "outside-event" && plan.subject.topic === topic.public_id && plan.subject.wave === 0));
  assert.ok(wave0.filter((plan) => plan.subject.kind !== "zh_reports").every((plan) => !plan.query.includes("张雪峰")), "names only in the Chinese reports");
  assert.deepEqual(wave0.filter((plan) => plan.subject.kind === "en_evidence").map((plan) => [plan.language, plan.timeRange]), [["en", "year"], ["en", "year"]]);
  /** @type {any[]} */
  const searched = [];
  const webSearch = { async search(/** @type {any} */ body) {
    searched.push(body);
    return { data: { results: [{ url: `https://news.example.cn/${encodeURIComponent(body.query)}/1`, title: `${body.query} 报道`, snippet: "s", publishedDate: "2026-03-24T15:00:00.000Z" }], engines: ["searxng"] } };
  } };
  const leads = new FrontierLeads({ database, plugin: fakePlugin([]), webSearch, owner: () => owner, budget: async () => ({ state: "ok" }),
    config: { ...config, frontierLeadsDailyQueries: 120 }, now: () => at(42), topics });
  const plan = await leads.plan(at(42));
  assert.deepEqual(plan.slice(0, 7).map((entry) => entry.trigger), Array(7).fill("outside-event"), "the outside event leads the plan");
  await leads.tick();
  assert.equal(searched.filter((body) => wave0.some((entry) => entry.query === body.query)).length, 7, "the topic's seven searches went first in the tick");
  assert.deepEqual(await topics.duePlans(at(43)), [], "a wave is searched once");
  const wave1 = await topics.duePlans(at(40 + 6 * 60 + 1));
  assert.deepEqual(wave1.map((entry) => [entry.subject.wave, entry.subject.kind]), [[1, "zh_reports"], [1, "zh_reports"]]);
  // The next day: wave 0 stays done (its keys are claimed on any day).
  assert.ok((await topics.duePlans(at(40 + 26 * 60))).every((entry) => entry.subject.wave !== 0));
  // A page the searches found arrives as an item; a news page is a report, a page older than the event by a month background.
  const found = `https://news.example.cn/${encodeURIComponent("运动性猝死 专家解读")}/1`;
  const report = await insertComposedItem(database, { sourceId: "health", sourceType: "media", title: "运动性猝死，专家这样说", titleZh: "运动性猝死，专家这样说",
    publishedAt: "2026-03-25T01:00:00Z", timelineAt: "2026-03-25T01:00:00Z", visibleAt: "2026-03-25T01:00:00Z" });
  await database.query("UPDATE evimed_frontier.items SET canonical_url = $2 WHERE id = $1", [report.id, found]);
  const joined = await topics.joinLeadItems(at(60 * 12));
  assert.equal(joined.joined, 1);
  assert.deepEqual((await database.query("SELECT role, via FROM evimed_frontier.topic_items WHERE item_id = $1", [report.id])).rows[0], { role: "report", via: "lead" });
  assert.equal((await topics.joinLeadItems(at(60 * 13))).joined, 0, "joined once");
  assert.equal(topic.id != null, true);
});

test("the overview: written from the items with marks and numbers checked, kept with its basis, not written again until the items change", options, async () => {
  await insertComposedItem(database, { sourceId: "jama", title: "Cardiac Arrest During Long-Distance Running Races", titleZh: "长跑比赛中的心脏骤停",
    summaryZh: "长跑比赛中心脏骤停发生率为每10万名参赛者0.60例。", entityKeys: ["disease:心源性猝死"], publishedAt: "2026-03-20T00:00:00Z",
    timelineAt: "2026-03-21T00:00:00Z", visibleAt: "2026-03-21T00:00:00Z" });
  await insertComposedItem(database, { sourceId: "health", sourceType: "media", title: "猝死前身体的3个求救信号", titleZh: "猝死前身体的3个求救信号",
    summaryZh: "出现胸痛、心悸、晕厥时应及时就医。", entityKeys: ["disease:心脏骤停"], publishedAt: "2026-03-23T00:00:00Z",
    timelineAt: "2026-03-23T00:00:00Z", visibleAt: "2026-03-23T00:00:00Z" });
  const text = "长跑比赛中心脏骤停的发生率约为每10万名参赛者0.60例[1]，属于罕见事件；规律运动的人总体心血管风险更低，但运动中出现胸痛、心悸或晕厥时应立即停止并及时就医[2]。据其公司讣告，一位知名教育博主因心源性猝死离世，这一消息让许多跑步爱好者担心运动风险；现有证据提示，风险更高的是本身有心脏病或家族史的人，他们在开始高强度运动前应先咨询医生[1]。";
  let answers = [{ overview_zh: text }];
  const editor = fakeEditor({ overview: () => answers });
  const topics = topicsWith({ editor });
  await topics.tick();
  const [row] = (await database.query("SELECT overview_zh, overview_refs, overview_basis FROM evimed_frontier.topics")).rows;
  assert.equal(row.overview_zh, text);
  assert.deepEqual(row.overview_refs.map((/** @type {any} */ ref) => ref.n), [1, 2]);
  assert.match(editor.calls.overview[0], /12356/, "the help line is in the material for the model to use when the topic is suicide");
  assert.match(editor.calls.overview[0], /\[1\] 研究证据｜2026-03-20｜JAMA｜长跑比赛中的心脏骤停/);
  // Within six hours nothing is asked; after, the same items are not written again.
  await topics.writeOverviews(at(60 * 7));
  assert.equal(editor.calls.overview.length, 1);
  // A number not in the material and a name twice are dropped.
  answers = [{ overview_zh: `${text.replace("0.60", "0.7")}` }, { overview_zh: `张雪峰、张雪峰${text}` }];
  await insertComposedItem(database, { sourceId: "health", sourceType: "media", title: "AED 使用率不足", titleZh: "AED 使用率不足", entityKeys: [],
    publishedAt: "2026-03-26T00:00:00Z", timelineAt: "2026-03-26T00:00:00Z", visibleAt: "2026-03-26T00:00:00Z" });
  const [{ id }] = (await database.query("SELECT id FROM evimed_frontier.topics")).rows;
  const extra = (await database.query("SELECT id FROM evimed_frontier.items WHERE title_raw = 'AED 使用率不足'")).rows[0].id;
  await database.query("INSERT INTO evimed_frontier.topic_items (topic_id, item_id, role, via) VALUES ($1, $2, 'report', 'lead')", [id, extra]);
  await topics.writeOverviews(at(60 * 8));
  assert.equal(topics.counters.overviews.dropped, 1);
  assert.equal((await database.query("SELECT overview_zh FROM evimed_frontier.topics")).rows[0].overview_zh, null, "a dropped overview leaves none, never a softened one");
});

test("a re-sighting joins the topic it is; a topic closes after its hours and stays readable; the reader is never served the names", options, async () => {
  const topics = topicsWith();
  await topics.tick();
  const [topic] = (await database.query("SELECT id, public_id FROM evimed_frontier.topics")).rows;
  // Day two: a new entry of the same event, which the grouping call names as the known topic.
  const plugin = fakePlugin([snap("toutiao", at(600), [["张雪峰追悼会今日举行", 3]]), snap("toutiao", at(630), [["张雪峰追悼会今日举行", 3]])]);
  const again = topicsWith({ plugin, now: () => at(640), editor: fakeEditor({ groups: (input) => {
    const n = numbersOf(input);
    return { groups: [{ members: [n["张雪峰追悼会今日举行"]], medical_members: [], domain: "public-figure", medical: true, needs_private_health: false,
      subject_names: ["张雪峰"], question: "", same_as: "T1", confidence: 0.9 }] };
  } }) });
  await again.tick();
  assert.equal(again.counters.resighted, 1);
  const boards = (await database.query("SELECT boards FROM evimed_frontier.topics WHERE id = $1", [topic.id])).rows[0].boards;
  assert.ok(boards.some((/** @type {any} */ board) => board.board === "toutiao" && board.peakRank === 3));
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.topics")).rows[0].n, 1);
  // The reader's pages: the summary carries no names, the card is the programme's settled one.
  await database.query("INSERT INTO evimed_frontier.evidence_zones (id, user_id, title, state) VALUES ('ez_hot', $1, '热点求证', 'published') ON CONFLICT DO NOTHING", [reader.id]);
  await database.query(`INSERT INTO evimed_frontier.evidence_cards (id, zone_id, user_id, title, subtype, state) VALUES ('ec_hot1', 'ez_hot', $1, '运动会诱发心源性猝死吗？', 'knowledge', 'published')
    ON CONFLICT DO NOTHING`, [reader.id]);
  await database.query("UPDATE evimed_frontier.topics SET programme_state = 'card', programme_card_id = 'ec_hot1' WHERE id = $1", [topic.id]);
  const service = new FrontierService({ database, vocabulary: frontierVocabularyView(TEST_VOCABULARY), now: () => at(700), topics,
    config: { frontierEnabled: true, frontierAudience: "all", operatorUsers: [], frontierPreviewUsers: [], frontierDailyBudgetCny: 10, frontierTimeZone: "Asia/Shanghai" } });
  const listed = await service.topicList(reader, new URLSearchParams({ status: "active" }));
  assert.equal(listed.topics.length, 1);
  const [summary] = listed.topics;
  assert.deepEqual(Object.keys(summary).sort(), ["acceptedAt", "card", "domain", "domainLabel", "firstSeenAt", "id", "itemCount", "overview", "peg", "question", "status", "surge", "title"]);
  assert.equal(summary.domainLabel, "公众人物");
  assert.deepEqual(summary.card, { id: "ec_hot1", title: "运动会诱发心源性猝死吗？", href: "/app/frontier/zones/ez_hot/evidence/ec_hot1" });
  assert.equal(JSON.stringify(listed).includes("张雪峰"), false, "the peg names nobody here, and subject names are never served");
  const page = await service.topic(reader, topic.public_id);
  assert.equal(page.topic.id, topic.public_id);
  assert.ok(Array.isArray(page.items));
  await assert.rejects(service.topic(reader, "nosuchtopic0000"), { code: "frontier_topic_not_found" });
  await assert.rejects(service.topicList(reader, new URLSearchParams({ status: "all" })), { code: "frontier_query_invalid" });
  const found = await service.searchTopics(reader, { q: "心源性猝死 风险" });
  assert.equal(found.topics[0]?.kind, "topic");
  // 72 hours after acceptance the topic is closed, still readable, and searched no more.
  const later = topicsWith({ now: () => at(40 + 72 * 60 + 1), plugin: fakePlugin([]) });
  await later.tick();
  assert.equal((await database.query("SELECT status FROM evimed_frontier.topics WHERE id = $1", [topic.id])).rows[0].status, "closed");
  assert.deepEqual(await later.duePlans(at(40 + 72 * 60 + 2)), []);
  assert.equal((await service.topicList(reader, new URLSearchParams({ status: "recent" }))).topics[0].status, "closed");
  assert.equal((await service.topicList(reader, new URLSearchParams())).topics.length, 0);
  const figures = await later.figures();
  assert.equal(figures.topics7d, 1);
  assert.deepEqual(figures.byDomain, { "public-figure": 1 });
});

test("switched off, no topic is made and none is searched", options, async () => {
  const off = topicsWith({ extra: { frontierOutsideEventEnabled: false } });
  assert.equal((await off.tick()).skipped, "disabled");
  assert.deepEqual(await off.duePlans(at(41)), []);
  const leadsOff = topicsWith({ extra: { frontierLeadsEnabled: false } });
  assert.equal(leadsOff.enabled, false, "the trigger rides with the leads");
});
