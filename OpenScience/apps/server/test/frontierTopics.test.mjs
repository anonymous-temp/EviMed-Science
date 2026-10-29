// The outside-event trigger's checks without a database (c2-leads 2026-10-25): the grouping answer read against what the
// call was shown, the topic answer's name, length and number rules, the overview's marks, and the waves.
import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_TOPIC_DOMAINS, FRONTIER_TOPIC_LIMITS } from "@evimed/domain";
import {
  FRONTIER_TOPIC_GROUP_INSTRUCTIONS, FRONTIER_TOPIC_OVERVIEW_INSTRUCTIONS, buildGroupInput, buildOverviewInput, buildTopicInput, frontierTopicSummary,
  groupRefusal, topicWaves, verifyGroups, verifyOverview, verifyTopic, waveSearches,
} from "../src/frontierTopics.mjs";

const candidates = [
  { n: 1, key: "a", title: "张雪峰去世", description: "据其公司讣告，张雪峰于3月24日因心源性猝死离世", boards: [{ board: "weibo", rank: 1, url: null, firstSeenAt: "2026-03-24T14:00:00.000Z" }] },
  { n: 2, key: "b", title: "心源性猝死", description: null, boards: [{ board: "weibo", rank: 3, url: null, firstSeenAt: "2026-03-24T14:00:00.000Z" }] },
  { n: 3, key: "c", title: "金价", description: null, boards: [{ board: "baidu", rank: 7, url: null, firstSeenAt: "2026-03-24T14:00:00.000Z" }] },
];

test("the grouping prompt names every field and the answer is read against what the call was shown", () => {
  for (const domain of FRONTIER_TOPIC_DOMAINS) assert.ok(FRONTIER_TOPIC_GROUP_INSTRUCTIONS.includes(domain), domain);
  for (const angle of ["战争冲突", "经济", "国事政策", "文娱", "体育", "自然灾害", "事故", "环境气候", "食品安全", "疫情", "科技", "社会", "网传的健康说法"]) {
    assert.ok(FRONTIER_TOPIC_GROUP_INSTRUCTIONS.includes(angle), angle);
  }
  const input = buildGroupInput(candidates, [{ n: "T1", id: "x", title: "已有", question: "问题" }]);
  assert.match(input, /T1｜已有｜问题/);
  assert.match(input, /\[1\] 微博热搜第1名｜张雪峰去世\n    描述：据其公司讣告/);
  const groups = verifyGroups({ groups: [
    { members: [1, 2, 99], medical_members: [2, 3], domain: "public-figure", medical: true, subject_names: ["张雪峰", ""], confidence: 1.4, same_as: "T9" },
    { members: [2, 3], medical: false, domain: "finance", confidence: 0.9 },
    { members: [], medical: true },
  ] }, candidates, [{ n: "T1", id: "x", title: "已有", question: "问题" }]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].members.map((member) => member.n), [1, 2], "an unknown number is dropped");
  assert.equal(groups[0].medicalMembers, 1, "a medical member outside the group is not counted");
  assert.deepEqual(groups[0].subjectNames, ["张雪峰"]);
  assert.equal(groups[0].confidence, 1);
  assert.equal(groups[0].sameAs, null, "a topic it was not shown");
  assert.deepEqual(groups[1].members.map((member) => member.n), [3], "a number names one group, the first");
  assert.equal(groups[1].domain, "other", "an unknown field is other");
  assert.equal(groupRefusal(groups[1]), "not_medical");
  assert.equal(groupRefusal({ ...groups[0], privateHealth: true }), "private_health");
  assert.equal(groupRefusal({ ...groups[0], confidence: 0.69 }), "low_confidence");
  assert.equal(groupRefusal(groups[0]), null);
});

test("the topic answer: the question as title, no name outside the Chinese reports, numbers from the material, a search at least", () => {
  const group = verifyGroups({ groups: [{ members: [1, 2], medical_members: [2], domain: "public-figure", medical: true, subject_names: ["张雪峰"], confidence: 0.9 }] }, candidates, [])[0];
  const input = buildTopicInput(group);
  assert.match(input, /【领域】公众人物/);
  const good = { title: "运动会诱发心源性猝死吗？风险有多大", question: "健康成年人运动时发生心源性猝死的风险有多大？",
    peg: "据其公司讣告，一位知名教育博主于3月24日因心源性猝死离世。", peg_entry: 1, entities: { diseases: ["心源性猝死"] },
    queries: { zh_reports: ["张雪峰 心源性猝死 专家"], zh_evidence: ["心源性猝死 预防 指南"], en_evidence: ["exercise sudden cardiac death"], stats: [] } };
  const passed = verifyTopic(good, input, group.subjectNames, group.members.length);
  assert.deepEqual(passed.issues, []);
  assert.equal(passed.output.pegEntry, 1);
  assert.deepEqual(passed.output.queries.zh_reports, ["张雪峰 心源性猝死 专家"], "names stay in the Chinese reports");
  const named = verifyTopic({ ...good, title: "张雪峰猝死：运动风险多大", queries: { ...good.queries, en_evidence: ["Zhang 张雪峰 sudden death"] } }, input, group.subjectNames, 2);
  assert.ok(named.issues.some((issue) => issue.startsWith("title 里出现了人名")));
  assert.ok(named.issues.some((issue) => issue.startsWith("queries.en_evidence")));
  const numbers = verifyTopic({ ...good, peg: "据讣告，他于3月25日离世。" }, input, group.subjectNames, 2);
  assert.ok(numbers.issues.some((issue) => issue.includes("25")), "a date the material does not hold");
  const long = verifyTopic({ ...good, title: "运".repeat(FRONTIER_TOPIC_LIMITS.titleChars + 1) }, input, [], 2);
  assert.ok(long.issues.some((issue) => issue.startsWith("title 太长")));
  const empty = verifyTopic({ ...good, queries: {} }, input, [], 2);
  assert.ok(empty.issues.includes("queries 至少要有一条检索式。"));
  assert.equal(verifyTopic({ ...good, peg: "" }, input, [], 2).output.peg, null, "no peg is a valid answer");
});

test("the overview: marks of shown items only, at most eight, a name once, numbers from the material, empty is none", () => {
  const refs = [1, 2].map((n) => ({ n, itemId: `item${n}xxxxxxxxx`, role: /** @type {const} */ (n === 1 ? "evidence" : "report"), date: "2026-03-20",
    sourceName: n === 1 ? "JAMA" : "健康时报", title: n === 1 ? "长跑比赛中的心脏骤停" : "猝死前的信号", summary: n === 1 ? "每10万名参赛者0.60例。" : "胸痛时应就医。" }));
  const input = buildOverviewInput({ question: "运动会诱发心源性猝死吗", peg: "据讣告，一位博主因心源性猝死离世。", pegSource: "微博热搜" }, refs);
  assert.match(input, /【事件引子】据讣告，一位博主因心源性猝死离世。（出处：微博热搜）/);
  assert.match(input, /12356/);
  assert.ok(FRONTIER_TOPIC_OVERVIEW_INSTRUCTIONS.includes("12356") === false, "the number lives in the material, not the instructions");
  const body = "长跑比赛中心脏骤停的发生率约为每10万名参赛者0.60例[1]，属于罕见事件，运动中出现胸痛时应立即停止并及时就医[2]。规律运动的人总体风险更低，本身有心脏病或家族史的人在开始高强度运动之前应先咨询医生，循序渐进地增加运动量，学会识别身体发出的预警信号，这些建议都来自现有的研究和科普材料[1]。";
  assert.deepEqual(verifyOverview({ overview_zh: body }, input, refs, ["张雪峰"]).issues, []);
  assert.deepEqual(verifyOverview({ overview_zh: body }, input, refs, []).cited, [1, 2]);
  assert.ok(verifyOverview({ overview_zh: body.replace("[2]", "[5]") }, input, refs, []).issues.some((issue) => issue.includes("[5]")));
  assert.ok(verifyOverview({ overview_zh: `张雪峰张雪峰${body}` }, input, refs, ["张雪峰"]).issues.some((issue) => issue.includes("不止一次")));
  assert.ok(verifyOverview({ overview_zh: body.replace("0.60", "0.8") }, input, refs, []).issues.some((issue) => issue.includes("0.8")));
  assert.ok(verifyOverview({ overview_zh: body.replaceAll(/\[\d\]/g, "") }, input, refs, []).issues.some((issue) => issue.includes("没有标注")));
  assert.deepEqual(verifyOverview({ overview_zh: "" }, input, refs, []), { output: { overview_zh: null }, cited: [], issues: [], numbers: { missing: [], checked: 0, unitMismatches: [] } });
});

test("waves: on acceptance, +6 h and the next watch hour after; a surge searches twice as much; the reports again each wave", () => {
  assert.deepEqual(topicWaves(new Date("2026-03-24T14:00:00Z"), "Asia/Shanghai").map((wave) => wave.due),
    ["2026-03-24T14:00:00.000Z", "2026-03-24T20:00:00.000Z", "2026-03-25T01:00:00.000Z"]);
  const queries = { zh_reports: ["a", "b"], zh_evidence: ["c", "d"], en_evidence: ["e", "f"], stats: ["g"] };
  assert.deepEqual(waveSearches(queries, 0, false).map((search) => search.query), ["a", "c", "e", "g"]);
  assert.deepEqual(waveSearches(queries, 0, true).map((search) => search.query), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.deepEqual(waveSearches(queries, 1, false).map((search) => [search.query, search.timeRange, search.chineseOnly]), [["a", "day", true]]);
  assert.deepEqual(waveSearches(queries, 2, true).map((search) => search.query), ["a", "b", "c"]);
});

test("the reader's summary never carries the names, the queries or the sightings", () => {
  const summary = frontierTopicSummary({ public_id: "a1b2c3d4e5f6a7b8", title_zh: "问题", question_zh: "问题？", peg_zh: "据讣告……", peg_source: { name: "微博热搜", url: null, date: "2026-03-24" },
    domain: "conflict", surge: false, first_seen_at: "2026-03-24T14:00:00Z", accepted_at: "2026-03-24T14:30:00Z", status: "active", item_count: 3,
    overview_zh: "概览[1]", subject_names: ["某人"], queries: { zh_reports: ["某人"] }, boards: [] }, { refs: [{ n: 1, itemId: "x", title: "t", sourceName: "s" }] });
  assert.equal(summary.domainLabel, "战争冲突");
  assert.equal(JSON.stringify(summary).includes("某人"), false);
  assert.deepEqual(summary.overview, { text: "概览[1]", refs: [{ n: 1, itemId: "x", title: "t", sourceName: "s" }] });
  assert.equal(frontierTopicSummary({ public_id: "a1b2c3d4e5f6a7b8", title_zh: "t", question_zh: "q", domain: "nope", status: "closed", overview_zh: null }).domainLabel, "其他");
});
