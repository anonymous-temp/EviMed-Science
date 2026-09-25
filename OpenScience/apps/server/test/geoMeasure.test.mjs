// The measurement package's pure parts: what counts as an answer, what code
// reads out of one, what it refuses to take from the judge, when an engine is
// paused, and when a big round may run. The queue against a real database is
// geoMeasure.integration.test.mjs.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyProbeAnswer, isRetriableRawStatus, stripPageChrome } from "../src/geoSanity.mjs";
import { brandRegistry, citationRows, countMentions, failureMode, foldText, parseAnswer } from "../src/geoParse.mjs";
import { buildJudgeInput, quantityTokens, verifyJudgement } from "../src/geoJudge.mjs";
import { errorFingerprint, citedFor } from "../src/geoErrors.mjs";
import { GeoProbeBreaker, nightWindowOpen, parseNightWindow, zonedDay, zonedDayStart, zonedWeekStart } from "../src/geoProbeQueue.mjs";
import { geoScreenshotFile, readGeoScreenshot, storeGeoScreenshot } from "../src/geoScreenshots.mjs";
import { probeUpstream } from "../src/geoProbeGateway.mjs";

const LONG = "玛仕度肽是一种每周一次皮下注射的 GLP-1 和胰高糖素受体双重激动剂，用于成人 2 型糖尿病患者的血糖控制，使用前请咨询医生。";

// ---------------------------------------------------------------- sanity

test("a login page, an empty shell, a capacity notice and chrome alone are suspect; a refusal is an answer", () => {
  assert.deepEqual(classifyProbeAnswer({ answer: "请先登录后继续使用" }), { status: "suspect", reason: "session_invalid", marker: "请先登录" });
  assert.equal(classifyProbeAnswer({ answer: "   " }).status, "suspect");
  assert.equal(classifyProbeAnswer({ answer: "   " }).reason, "empty_shell");
  assert.equal(classifyProbeAnswer({ answer: "刚刚和Kimi聊的人太多了，高峰期算力不足，请稍后再试。" }).reason, "service_unavailable");
  assert.equal(classifyProbeAnswer({ answer: "相关视频\n视频一\n视频二\n推荐追问\n这个药贵吗？\n还有什么副作用？\n孕妇能用吗？\n怎么保存？" }).reason, "chrome_only");
  // A refusal stays IN the denominator: dropping it would raise every mention rate.
  assert.deepEqual(classifyProbeAnswer({ answer: "抱歉，我无法提供医疗建议，请咨询专业医生。" }).status, "refusal");
  assert.equal(classifyProbeAnswer({ answer: "好" }).reason, "too_short");
  assert.deepEqual(classifyProbeAnswer({ answer: LONG }), { status: "valid", reason: null, marker: null });
  assert.equal(classifyProbeAnswer({ rawStatus: "error", answer: LONG }).status, "failed");
});

test("a capacity phrase inside a long real answer is not a capacity failure", () => {
  const answer = `${LONG}若两周后症状仍未缓解，请稍后再试其他方案并及时就医，不要自行加量，也不要与其他降糖药自行合用。`;
  assert.ok(answer.length > 100);
  assert.equal(classifyProbeAnswer({ answer }).status, "valid");
});

test("page chrome is cut from the tail only", () => {
  const body = `${LONG}${LONG}${LONG}`;
  assert.deepEqual(stripPageChrome(`${body}\n相关视频\n某某产品测评`), { body, stripped: "相关视频\n某某产品测评".length });
  const middle = `参考资料显示，${LONG}${LONG}${LONG}`;
  assert.equal(stripPageChrome(middle).stripped, 0, "a marker in the body is not chrome");
});

test("the vendor's busy statuses are retriable, other statuses are not", () => {
  assert.equal(isRetriableRawStatus("model_failed"), true);
  assert.equal(isRetriableRawStatus("BUSY"), true);
  assert.equal(isRetriableRawStatus("error"), false);
});

// ---------------------------------------------------------------- parse

const product = { brandName: "玛仕度肽", aliases: ["信尔美"], misspellings: ["马仕度肽"], genericName: "mazdutide" };
const competitors = [{ brandName: "诺和泰", genericName: "司美格鲁肽" }, { genericName: "替尔泊肽" }];

test("registered names are matched case- and width-folded, without double counting overlapping aliases", () => {
  const registry = brandRegistry({ brandName: "ABC", aliases: ["ABC口服液"] }, []);
  assert.equal(foldText("ＡＢＣ口服液"), "abc口服液");
  const { count, first } = countMentions(foldText("推荐ＡＢＣ口服液，abc 也可以"), registry[0].aliases);
  assert.equal(count, 2, "「ABC口服液」 is one mention, not two");
  assert.equal(first, 2);
});

test("brands are ranked by first appearance and a list item is a recommendation", () => {
  const registry = brandRegistry(product, competitors);
  assert.deepEqual(registry.map((entry) => entry.name), ["玛仕度肽", "诺和泰", "替尔泊肽"]);
  const answer = "常见的选择有：\n1. 诺和泰（司美格鲁肽）每周一次。\n2. 信尔美（玛仕度肽）同样每周一次。\n替尔泊肽也可考虑。";
  const facts = parseAnswer({ answer, registry, citations: [], owned: {} });
  assert.deepEqual(facts.brands.map((brand) => [brand.name, brand.position, brand.count, brand.inRecommendation]), [
    ["诺和泰", 1, 1, true], ["玛仕度肽", 2, 2, true], ["替尔泊肽", 3, 1, false],
  ]);
  assert.equal(facts.firstOurs, false);
  assert.equal(facts.positionOurs, 2);
  assert.equal(facts.recommendedOurs, true);
  assert.equal(facts.brandsMentioned, 3);
});

test("a recommendation sentence counts only for the brands in it; unregistered entities are checked and counted by code", () => {
  const registry = brandRegistry(product, competitors);
  const answer = "玛仕度肽适合超重人群。医生通常推荐诺和泰。二甲双胍片也常用，二甲双胍片价格低。";
  const facts = parseAnswer({
    answer, registry, citations: [], owned: {},
    recommendations: ["医生通常推荐诺和泰"],
    entities: ["二甲双胍片", "阿卡波糖片", "诺和泰", "玛仕度"],
  });
  assert.deepEqual(facts.brands.map((brand) => [brand.name, brand.ours, brand.competitor, brand.count, brand.inRecommendation]), [
    ["玛仕度肽", true, false, 1, false], ["诺和泰", false, true, 1, true], ["二甲双胍片", false, false, 2, false],
  ], "an entity not in the text, a registered one and a fragment of one are all refused");
  assert.equal(facts.recommendedOurs, false);
});

test("a citation is in the body only where the engine renders inline markers; ours is the domain's isOurCitation", () => {
  const results = [{ title: "说明书", url: "https://www.mazdutide.example.com/label" }, { title: "新闻", url: "https://news.example.org/a" }];
  const inline = citationRows(results, "每周一次[1]。", "deepseek");
  assert.deepEqual(inline.map((row) => [row.domain, row.inBody]), [["www.mazdutide.example.com", true], ["news.example.org", false]]);
  const listed = citationRows(results, "每周一次[1]。", "doubao");
  assert.deepEqual(listed.map((row) => row.inBody), [null, null], "an outside-list engine is not measurable, never guessed");
  const reported = citationRows([{ url: "https://a.example.com", in_body: true }], "no markers", "yuanbao");
  assert.equal(reported[0].inBody, true);
  const facts = parseAnswer({ answer: LONG, registry: brandRegistry(product, []), citations: inline, owned: { domains: ["mazdutide.example.com"] } });
  assert.equal(facts.citesOurs, true);
  assert.equal(facts.citesOursInBody, true);
  assert.equal(facts.retrievalTriggered, true);
  const notOurs = parseAnswer({ answer: LONG, registry: [], citations: [{ url: "https://notmazdutide.example.com/x", domain: "notmazdutide.example.com", title: "", inBody: null }], owned: { domains: ["mazdutide.example.com"] } });
  assert.equal(notOurs.citesOurs, false, "label-aligned: a longer domain ending in ours is not ours");
});

test("failure modes: wrong wins, a refusal is none, not named is omitted", () => {
  assert.equal(failureMode({ status: "valid", mentionsOurs: true, statements: [{ verdict: "wrong" }] }), "wrong_ours");
  assert.equal(failureMode({ status: "refusal", mentionsOurs: false, statements: [] }), "none");
  assert.equal(failureMode({ status: "valid", mentionsOurs: false, statements: [] }), "omitted");
  assert.equal(failureMode({ status: "valid", mentionsOurs: true, statements: [{ verdict: "correct" }] }), "correct");
});

// ---------------------------------------------------------------- the judge's check

test("quantities read the same whatever numerals and width they are written in", () => {
  assert.deepEqual([...quantityTokens("每周一次皮下注射")], ["freq:1/1周"]);
  assert.deepEqual([...quantityTokens("每周1次")], ["freq:1/1周"]);
  assert.deepEqual([...quantityTokens("玛仕度肽每天注射一次")], ["freq:1/1日"]);
  assert.deepEqual([...quantityTokens("一日三次，每次２片")].sort(), ["freq:3/1日", "span:1日"].sort());
  assert.ok(quantityTokens("起始剂量为2 mg，最大 6毫克").has("6mg"));
  assert.ok(quantityTokens("18-75岁成人").has("age:75"));
  assert.equal(quantityTokens("一般来说比较安全").size, 0, "「一般」 is a word, not a number");
});

const claims = [
  { id: "claim-dose", key: "dosing", statement: "每周一次皮下注射", quote: "本品每周一次皮下注射给药，起始剂量为2 mg。" },
  { id: "claim-ind", key: "indication", statement: "用于成人2型糖尿病", quote: "用于成人2型糖尿病患者的血糖控制。" },
];
const judgeInput = (/** @type {string} */ answer) => ({
  owner: { userId: "u", projectId: "p" }, product, competitors, claims,
  careFlags: [{ id: "F1", text: "出现持续严重腹痛应立即就医", node: "用药中" }],
  question: { text: "玛仕度肽怎么用", pool: "P1", journeyStage: "用药中" }, answer,
});

test("the judge's verdicts are kept only when code can re-verify them, and dropped — not softened — otherwise", () => {
  const answer = "玛仕度肽每周注射一次。玛仕度肽每天注射一次。玛仕度肽起始剂量为5 mg。玛仕度肽可用于儿童。出现剧烈腹痛要及时就医。孕妇禁用。";
  const input = judgeInput(answer);
  const built = buildJudgeInput(input);
  assert.deepEqual(built.claims.map((claim) => claim.alias), ["C1", "C2"]);
  const verdict = verifyJudgement({
    refusal: false,
    statements: [
      { text: "玛仕度肽每周注射一次", verdict: "correct", claim: "C1", evidence: "本品每周一次皮下注射给药" },
      { text: "玛仕度肽每天注射一次", verdict: "wrong", claim: "C1", evidence: "每周一次皮下注射", errorType: "number", severity: "S3" },
      // A number the claim does not have cannot be "correct".
      { text: "玛仕度肽起始剂量为5 mg", verdict: "correct", claim: "C1", evidence: "起始剂量为2 mg" },
      // Evidence that is not in the claim's quote.
      { text: "玛仕度肽可用于儿童", verdict: "wrong", claim: "C2", evidence: "儿童禁用本品", errorType: "unfounded", severity: "S2" },
      // Not in the answer at all.
      { text: "玛仕度肽可以口服", verdict: "wrong", claim: "C1", evidence: "每周一次皮下注射", errorType: "attribute_swap", severity: "S2" },
      // A claim the judge was not shown.
      { text: "孕妇禁用", verdict: "correct", claim: "C9", evidence: "孕妇禁用" },
      { text: "出现剧烈腹痛要及时就医", verdict: "unverifiable", claim: null, evidence: "" },
    ],
    entities: ["二甲双胍"],
    recommendations: [],
    careHint: true,
    redFlagsExpected: ["F1", "F7"],
    redFlagsHit: ["F1"],
    safetyTerms: ["孕妇禁用", "哺乳期慎用"],
  }, built, input);
  assert.deepEqual(verdict.statements.map((statement) => [statement.text, statement.verdict, statement.claimId, statement.claimKey]), [
    ["玛仕度肽每周注射一次", "correct", "claim-dose", "dosing"],
    ["玛仕度肽每天注射一次", "wrong", "claim-dose", "dosing"],
    ["出现剧烈腹痛要及时就医", "unverifiable", null, null],
  ]);
  assert.deepEqual(verdict.dropped.map((entry) => entry.reason).sort(), [
    "claim_unknown", "evidence_not_in_claim", "not_in_answer", "not_in_answer", "number_not_in_claim", "statement_not_in_answer",
  ].sort());
  assert.deepEqual(verdict.redFlagExpected, ["出现持续严重腹痛应立即就医"], "an id that was not offered is refused");
  assert.deepEqual(verdict.redFlagHits, ["出现持续严重腹痛应立即就医"]);
  assert.deepEqual(verdict.safetyTermsHit, ["孕妇禁用"]);
  assert.deepEqual(verdict.entities, [], "an entity not in the answer is refused");
});

test("a 'wrong on a number' verdict whose numbers are the claim's is dropped", () => {
  const answer = "玛仕度肽每周注射一次，起始剂量为2 mg。";
  const input = judgeInput(answer);
  const verdict = verifyJudgement({
    statements: [{ text: "玛仕度肽每周注射一次，起始剂量为2 mg", verdict: "wrong", claim: "C1", evidence: "起始剂量为2 mg", errorType: "number", severity: "S3" }],
  }, buildJudgeInput(input), input);
  assert.deepEqual(verdict.statements, []);
  assert.deepEqual(verdict.dropped.map((entry) => entry.reason), ["number_matches_claim"]);
});

test("a wrong verdict without a valid severity or error type cannot be traced and is dropped", () => {
  const answer = "玛仕度肽每天注射一次。";
  const input = judgeInput(answer);
  const verdict = verifyJudgement({
    statements: [
      { text: "玛仕度肽每天注射一次", verdict: "wrong", claim: "C1", evidence: "每周一次皮下注射", errorType: "number", severity: "S9" },
      { text: "玛仕度肽每天注射一次", verdict: "wrong", claim: "C1", evidence: "每周一次皮下注射", errorType: "typo", severity: "S3" },
    ],
  }, buildJudgeInput(input), input);
  assert.deepEqual(verdict.statements, []);
  assert.deepEqual(verdict.dropped.map((entry) => entry.reason), ["severity_invalid", "error_type_invalid"]);
  assert.throws(() => verifyJudgement(null, buildJudgeInput(input), input), (error) => /** @type {any} */ (error).code === "geo_judge_invalid");
});

// ---------------------------------------------------------------- errors

test("one error per fact per engine: the fingerprint is the claim, not the wording", () => {
  assert.equal(errorFingerprint({ claimKey: "dosing", text: "每天注射一次" }), errorFingerprint({ claimKey: "dosing", text: "一天打一针" }));
  assert.notEqual(errorFingerprint({ claimKey: "dosing" }), errorFingerprint({ claimKey: "indication" }));
  assert.equal(errorFingerprint({ text: "每天 注射一次" }), errorFingerprint({ text: "每天注射一次" }));
});

test("the cited source of a sentence is the inline marker next to it, or none", () => {
  const citations = [{ url: "https://a.example.com/1", domain: "a.example.com" }, { url: "https://b.example.com/2", domain: "b.example.com" }];
  assert.equal(citedFor("第一句。玛仕度肽每天注射一次[2]。", "玛仕度肽每天注射一次", citations)?.domain, "b.example.com");
  assert.equal(citedFor("玛仕度肽每天注射一次。", "玛仕度肽每天注射一次", citations), null);
  assert.equal(citedFor("玛仕度肽每天注射一次[7]。", "玛仕度肽每天注射一次", citations), null, "a marker past the list is not a citation");
});

// ---------------------------------------------------------------- the breaker and the clock

test("an engine pauses after the threshold of suspect answers in a row, per engine, and resumes when its tab is back", () => {
  const breaker = new GeoProbeBreaker({ threshold: 3, recheckMs: 600_000 });
  // Another engine answering in between does not reset this one's count.
  assert.equal(breaker.record("doubao", "suspect", 0), false);
  breaker.record("deepseek", "valid", 1);
  assert.equal(breaker.record("doubao", "failed", 2), false);
  breaker.record("deepseek", "valid", 3);
  assert.equal(breaker.record("doubao", "suspect", 4), true);
  assert.deepEqual(breaker.paused(), ["doubao"]);
  assert.deepEqual(breaker.due(5), [], "just paused: not re-checked at once");
  assert.deepEqual(breaker.due(600_004), ["doubao"]);
  assert.equal(breaker.checked("doubao", 600_004, false), false);
  assert.deepEqual(breaker.due(600_005), []);
  assert.equal(breaker.checked("doubao", 1_200_004, true), true);
  assert.deepEqual(breaker.paused(), []);
  // A refusal is an answer: it resets the count.
  breaker.record("kimi", "suspect", 0);
  breaker.record("kimi", "suspect", 0);
  breaker.record("kimi", "refusal", 0);
  assert.equal(breaker.record("kimi", "suspect", 0), false);
});

test("a breaker seeded from stored answers starts paused and is re-checked at once", () => {
  const breaker = new GeoProbeBreaker({ threshold: 3 });
  breaker.seed({ doubao: ["suspect", "failed", "suspect", "valid"], deepseek: ["suspect", "valid"] }, 100);
  assert.deepEqual(breaker.paused(), ["doubao"]);
  assert.deepEqual(breaker.due(100), ["doubao"]);
});

test("the night window and the week are Asia/Shanghai's, and the window may wrap past midnight", () => {
  const config = { geoNightWindow: "22-07", geoTimeZone: "Asia/Shanghai" };
  assert.equal(nightWindowOpen(new Date("2026-09-25T15:30:00Z"), config), true, "23:30 in Shanghai");
  assert.equal(nightWindowOpen(new Date("2026-09-25T22:59:00Z"), config), true, "06:59 in Shanghai");
  assert.equal(nightWindowOpen(new Date("2026-09-25T23:00:00Z"), config), false, "07:00 in Shanghai");
  assert.equal(nightWindowOpen(new Date("2026-09-25T04:00:00Z"), config), false, "noon in Shanghai");
  assert.equal(nightWindowOpen(new Date("2026-09-25T04:00:00Z"), { geoNightWindow: "0-0" }), true, "equal ends: always");
  assert.deepEqual(parseNightWindow("nonsense"), { start: 22, end: 7 });
  assert.equal(zonedDay(new Date("2026-09-25T17:00:00Z"), "Asia/Shanghai"), "2026-09-26");
  assert.equal(zonedDayStart(new Date("2026-09-25T17:00:00Z"), "Asia/Shanghai").toISOString(), "2026-09-25T16:00:00.000Z");
  // 2026-09-25 is a Friday; its week starts Monday 2026-09-21 00:00 in Shanghai.
  assert.equal(zonedWeekStart(new Date("2026-09-25T04:00:00Z"), "Asia/Shanghai").toISOString(), "2026-09-20T16:00:00.000Z");
  assert.equal(zonedWeekStart(new Date("2026-09-20T16:30:00Z"), "Asia/Shanghai").toISOString(), "2026-09-20T16:00:00.000Z", "Monday 00:30 is its own week");
});

// ---------------------------------------------------------------- screenshots

const png = (/** @type {string} */ tail) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(tail)]);

test("a screenshot is stored once per content, under its own digest", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "geo-shots-"));
  try {
    const first = await storeGeoScreenshot(dataDir, png("page-a"));
    const again = await storeGeoScreenshot(dataDir, png("page-a"));
    const other = await storeGeoScreenshot(dataDir, png("page-b"));
    assert.equal(first.stored, true);
    assert.equal(again.stored, false);
    assert.equal(again.sha256, first.sha256);
    assert.notEqual(other.sha256, first.sha256);
    const file = geoScreenshotFile(dataDir, first.sha256);
    assert.equal(path.relative(dataDir, file), path.join("geo", "snapshots", first.sha256.slice(0, 2), `${first.sha256}.png`));
    assert.deepEqual(await readGeoScreenshot(dataDir, first.sha256), png("page-a"));
    assert.equal(await readGeoScreenshot(dataDir, "../../etc/passwd"), null);
    assert.equal(await readGeoScreenshot(dataDir, "0".repeat(64)), null);
    const dir = path.join(dataDir, "geo", "snapshots", first.sha256.slice(0, 2));
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
    await assert.rejects(storeGeoScreenshot(dataDir, Buffer.from("<svg/>")), (error) => /** @type {any} */ (error).code === "screenshot_not_png");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the probe client

test("probeUpstream asks one provider and hands back the upstream's own rows beside the normalized answer", async () => {
  /** @type {any[]} */
  const calls = [];
  const upstream = probeUpstream({ geoProbeUrl: "http://127.0.0.1:9/" }, {
    fetchImpl: /** @type {any} */ (async (/** @type {URL} */ url, /** @type {any} */ init) => {
      calls.push({ path: url.pathname, body: init.body ? JSON.parse(init.body) : null });
      const payload = url.pathname === "/providers"
        ? { providers: { deepseek: "tab_found", kimi: "no_tab" } }
        : { results: [{ provider: "kimi", status: "model_failed", answer: "", search_results: [{ url: "https://a.example.com", in_body: true }] }] };
      const text = JSON.stringify(payload);
      return { ok: true, status: 200, headers: new Headers({ "content-length": String(Buffer.byteLength(text)) }), text: async () => text };
    }),
  });
  const answer = await upstream.ask({ question: "q", providers: ["kimi"] });
  assert.deepEqual(calls[0], { path: "/ask", body: { question: "q", providers: ["kimi"], deep: 0, new_chat: 1 } });
  assert.equal(answer.results[0].status, "failed");
  assert.equal(answer.raw[0].status, "model_failed", "the raw status word survives for the queue");
  assert.equal(answer.raw[0].search_results[0].in_body, true);
  assert.equal(answer.integrity.transport, "plaintext");
  const providers = await upstream.providers();
  assert.deepEqual(providers.ready, ["deepseek"]);
  await assert.rejects(upstream.ask({ question: "q", providers: ["chatgpt"] }), (error) => /** @type {any} */ (error).code === "geo_probe_provider_invalid");
});
