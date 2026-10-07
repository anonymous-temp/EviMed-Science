// 「循证 GEO」's program rules without a database: what a program wants, the
// calendar arithmetic of the schedules in Asia/Shanghai, the sentinel
// engines, the briefs a run is told, and the notices' titles and kinds.
import assert from "node:assert/strict";
import test from "node:test";
import {
  GEO_SCHEDULE, baselineTooRecent, contentBrief, dispatchIdFor, exportBrief, geoRunPrompt, insightBrief, measurementFreshness, nextWeeklySlot,
  postPublicationCheckpoints, sentinelEngines, sentinelSlot, strategyBrief, topQuestions, wantedSteps, weeklySlot, zonedInstant,
} from "../src/geoOrchestrator.mjs";
import { GEO_NOTICE_KINDS, createGeoNotifier, geoNoticeHref, operatorBody, wrongOursTitle } from "../src/geoNotify.mjs";
import { memorySourceRejection } from "../src/memoryIntelligence.mjs";
import { geoRoutePattern } from "../src/geoRoutes.mjs";

const SHANGHAI = "Asia/Shanghai";
const STEPS = ["evidence", "journey", "questions", "diagnosis", "sources", "content", "distribution", "monitoring"];
/** @param {string[]} requested */
const steps = (requested) => Object.fromEntries(STEPS.map((step) => [step, { status: "none", requested: requested.includes(step) }]));
const project = { id: "geo_1", userId: "u1", projectId: "mashidu", product: { brandName: "玛仕度肽", genericName: "mazdutide" }, coverageDays: 90,
  engines: ["doubao", "deepseek", "kimi"], tier: "2", budget: null };

test("a full program wants every step; a single step wants its upstream as a minimal version", () => {
  const full = wantedSteps(steps(STEPS));
  assert.equal(full.full, true);
  assert.deepEqual([...full.want].sort(), [...STEPS].sort());
  assert.equal(full.fidelity("questions"), "full");

  // 「只做信源分析与预期」: identity + label claims + 30 questions + a round → the strategy run. No journey, no content.
  const sources = wantedSteps(steps(["sources"]));
  assert.equal(sources.full, false);
  assert.deepEqual([...sources.want].sort(), ["diagnosis", "evidence", "questions", "sources"]);
  assert.deepEqual(["evidence", "questions", "diagnosis", "sources"].map((step) => sources.fidelity(step)), ["minimal", "minimal", "minimal", "full"]);

  // Writing only: identity first, no questions, no measurement.
  assert.deepEqual([...wantedSteps(steps(["content"])).want].sort(), ["content", "evidence"]);
  // Monitoring only: a minimal set measured once is the first round.
  assert.deepEqual([...wantedSteps(steps(["monitoring"])).want].sort(), ["diagnosis", "evidence", "monitoring", "questions"]);
  // Nothing asked, nothing wanted.
  assert.equal(wantedSteps(steps([])).want.size, 0);
});

test("the weekly re-measure is due from Monday 03:00 Asia/Shanghai, keyed by that Monday", () => {
  // 2026-09-28 is a Monday. 03:00 in Shanghai is 2026-09-27T19:00Z.
  assert.equal(zonedInstant("2026-09-28", 3, SHANGHAI).toISOString(), "2026-09-27T19:00:00.000Z");
  const sunday = weeklySlot(new Date("2026-09-27T15:00:00Z"), SHANGHAI); // Sunday 23:00 local
  assert.deepEqual([sunday.monday, sunday.due], ["2026-09-21", true], "Sunday belongs to the week that began last Monday (already due)");
  const early = weeklySlot(new Date("2026-09-27T18:59:00Z"), SHANGHAI); // Monday 02:59 local
  assert.deepEqual([early.monday, early.due], ["2026-09-28", false], "a new week's Monday before 03:00 is not due yet");
  const due = weeklySlot(new Date("2026-09-27T19:00:00Z"), SHANGHAI); // Monday 03:00 local
  assert.deepEqual([due.monday, due.due, due.dueAt.toISOString()], ["2026-09-28", true, "2026-09-27T19:00:00.000Z"]);
  const friday = weeklySlot(new Date("2026-10-02T04:00:00Z"), SHANGHAI);
  assert.deepEqual([friday.monday, friday.due], ["2026-09-28", true]);
  // UTC would put 2026-09-27T20:00Z on a Sunday; Shanghai puts it on Monday 04:00.
  assert.equal(weeklySlot(new Date("2026-09-27T20:00:00Z"), SHANGHAI).monday, "2026-09-28");
  assert.equal(weeklySlot(new Date("2026-09-27T20:00:00Z"), "UTC").monday, "2026-09-21");
});

test("sentinels are due from 08:00 local each day", () => {
  assert.deepEqual(sentinelSlot(new Date("2026-09-28T23:59:00Z"), SHANGHAI), { day: "2026-09-29", due: false }, "07:59 local");
  assert.deepEqual(sentinelSlot(new Date("2026-09-29T00:00:00Z"), SHANGHAI), { day: "2026-09-29", due: true }, "08:00 local");
});

test("post-publication checks fall at weeks 1, 2, 4, 8 and 12; one more than a week late is missed, not back-filled", () => {
  const published = new Date("2026-09-01T02:00:00Z");
  const at = (/** @type {number} */ days) => postPublicationCheckpoints(published, new Date(published.getTime() + days * 86_400_000));
  assert.deepEqual(GEO_SCHEDULE.postPublicationWeeks, [1, 2, 4, 8, 12]);
  assert.deepEqual(at(6).map((entry) => entry.due), [false, false, false, false, false]);
  assert.deepEqual(at(7).map((entry) => [entry.week, entry.due, entry.missed]), [[1, true, false], [2, false, false], [4, false, false], [8, false, false],
    [12, false, false]]);
  const late = at(29);
  assert.deepEqual(late.map((entry) => [entry.due, entry.missed]), [[true, true], [true, true], [true, false], [false, false], [false, false]],
    "week 1 and 2 were missed by more than seven days; week 4 is due now");
  assert.equal(late[2].dueAt.toISOString(), "2026-09-29T02:00:00.000Z");
});

test("sentinel engines: the two with the highest measured retrieval rate among the project's own, else DeepSeek and 元宝", () => {
  const own = ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"];
  assert.deepEqual(sentinelEngines([
    { engine: "doubao", value: 62, denominator: 60, status: "ok" },
    { engine: "kimi", value: 80, denominator: 40, status: "ok" },
    { engine: "qianwen", value: 62, denominator: 90, status: "ok" },
    { engine: "yuanbao", value: 99, denominator: 10, status: "insufficient" },
    { engine: "baidu", value: 100, denominator: 90, status: "ok" },
  ], own), ["kimi", "qianwen"], "ranked by value, ties by sample; not-ok cells and engines outside the project do not count");
  assert.deepEqual(sentinelEngines([], own), ["deepseek", "yuanbao"], "before any measured rate: the defaults");
  assert.deepEqual(sentinelEngines([{ engine: "kimi", value: 10, denominator: 30, status: "ok" }], ["doubao", "kimi"]), ["kimi", "doubao"],
    "a default the project does not measure is skipped; its own engines fill the pair");
});

test("the most important questions are the heaviest groups' measured ones", () => {
  const groups = [
    { weight: 0.2, questions: [{ id: "a", isMeasured: true }, { id: "b", isMeasured: false }] },
    { weight: 0.9, questions: [{ id: "c", isMeasured: true }, { id: "d", isMeasured: true, retiredAt: "2026-09-01" }, { id: "e", isMeasured: true }] },
  ];
  assert.deepEqual(topQuestions(groups, 2), ["c", "e"]);
  assert.deepEqual(topQuestions(groups, 10), ["c", "e", "a"]);
});

test("dispatch ids are the ledger's shape and one per attempt", () => {
  assert.equal(dispatchIdFor("run:insight", 1), "geo-insight-a1");
  assert.equal(dispatchIdFor("run:content:w2026-09-28", 2), "geo-content-w2026-09-28-a2");
  const long = dispatchIdFor(`run:export:${"x".repeat(100)}`, 12);
  assert.ok(long.length <= 64 && long.endsWith("-a12") && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(long));
});

test("a run's brief says, in plain Chinese, the step, minimal or not, the product, and geo_read / geo_write", () => {
  const full = insightBrief(project, { scope: [{ step: "evidence", fidelity: "full" }, { step: "journey", fidelity: "full" },
    { step: "questions", fidelity: "full" }], target: "evidence", full: true });
  for (const phrase of ["完整方案", "玛仕度肽", "mazdutide", "geo_read", "geo_write", "锁定 40–120 个测量问句", "旅程", "豆包、DeepSeek、Kimi"]) {
    assert.ok(full.includes(phrase), `${phrase} missing from the full brief`);
  }
  assert.equal(full.includes("单步模式"), false);
  const minimal = insightBrief(project, { scope: [{ step: "evidence", fidelity: "minimal" }, { step: "questions", fidelity: "minimal" }],
    target: "sources", full: false });
  for (const phrase of ["单步模式", "“信源”", "最小版", "共 30 个测量问句", "minimal:true", "geo_read", "geo_write"]) {
    assert.ok(minimal.includes(phrase), `${phrase} missing from the minimal brief`);
  }
  assert.equal(minimal.includes("· 旅程"), false, "a single step does not do the journey");
  assert.ok(strategyBrief(project, { minimal: true }).includes("30 个问句"));
  const batch = contentBrief(project, { number: 1, size: 3, reason: "first", groups: [{ name: "减重效果", pool: "P2", typicalQuestion: "玛仕度肽能减多少？" }],
    errors: [{ engine: "deepseek", statement: "每天注射一次" }] });
  for (const phrase of ["第 1 批", "最多 3 篇", "语义群“减重效果”", "通用名与品类类", "DeepSeek 讲错“每天注射一次”", "safety: open", "geo_write articles",
    "errorIds"]) {
    assert.ok(batch.includes(phrase), `${phrase} missing from the content brief`);
  }
  // What the identity, the journey and the strategy are asked to carry (G5, G10, G3, G16).
  for (const phrase of ["aliases", "misspellings", "approvalNo", "identityStatus", "singleSource", "subtypes", "personas", "files", "collectedAt"]) {
    assert.ok(full.includes(phrase), `${phrase} missing from the full brief`);
  }
  const strategy = strategyBrief(project, { minimal: false });
  for (const phrase of ["10–20", "icpMatches", "newsIndexed", "medicalVertical", "checkedAt", "impostor: true", "promise", "layers", "M-19", "M-01S"]) {
    assert.ok(strategy.includes(phrase), `${phrase} missing from the strategy brief`);
  }
  for (const brief of [full, minimal, batch, strategy]) assert.equal(/[「」]/.test(brief), false, "a person reads a brief: quotes are “”");
  assert.ok(exportBrief(project, { kind: "weekly", week: "2026-09-28" }).includes("周报"));
  assert.ok(exportBrief(project, { kind: "proposal" }).includes("提案资料包"));
  for (const brief of [full, minimal, batch]) assert.equal(/gq_|ggr_|geo_[0-9a-f]{8}/.test(brief), false, "no ids in what a person can read");
});

test("a brief that reads measurements says how current each engine's are, and which are stale", () => {
  // Production, 2026-09-28: the probe host had lost DeepSeek and 豆包, so the
  // newest DeepSeek answer was from 09-25 and 豆包 had none at all while 千问
  // was measured daily. A strategy or an export built on those numbers without
  // saying so presents three-day-old cells as this week's.
  const at = new Date("2026-10-03T02:00:00Z");
  const rows = [
    { engine: "deepseek", last: "2026-09-25T18:49:40Z" },
    { engine: "kimi", last: new Date("2026-10-02T16:09:59Z") },
    { engine: "qianwen", last: "2026-10-03T00:05:20Z" },
  ];
  const line = measurementFreshness(rows, ["doubao", "deepseek", "kimi"], at, SHANGHAI);
  assert.ok(line, "a project with answers gets a line");
  for (const phrase of ["豆包 没有有效回答", "DeepSeek 2026-09-26", "Kimi 2026-10-03", "豆包、DeepSeek 没有 7 天内的数", "写明是哪天测的", "“未测”", "不要为此补测或停下"]) {
    assert.ok(line.includes(phrase), `${phrase} missing from: ${line}`);
  }
  assert.equal(line.includes("千问"), false, "only the project's own engines are listed");
  // Current everywhere: the dates, and no stale sentence.
  const fresh = measurementFreshness([{ engine: "doubao", last: at }, { engine: "deepseek", last: at }, { engine: "kimi", last: at }],
    ["doubao", "deepseek", "kimi"], at, SHANGHAI);
  assert.ok(fresh?.startsWith("各引擎最近一次有效回答："));
  assert.equal(fresh?.includes("没有 7 天内的数"), false);
  // Nothing measured yet: no line at all — the step itself says the numbers are missing.
  assert.equal(measurementFreshness([], ["doubao"], at, SHANGHAI), null);

  // The line reaches the strategy brief and both export briefs, and only when there is one.
  for (const brief of [strategyBrief(project, { minimal: false, freshness: line }), exportBrief(project, { kind: "proposal", freshness: line }),
    exportBrief(project, { kind: "weekly", week: "2026-10-05", freshness: line })]) {
    assert.ok(brief.includes(line), "the freshness line is in the brief");
    assert.equal(/[「」]/.test(brief), false, "a person reads a brief: quotes are “”");
  }
  assert.equal(exportBrief(project, { kind: "proposal" }).includes("最近一次有效回答"), false);
});

test("the operators' market routes have bounded metric labels", () => {
  assert.equal(geoRoutePattern("/api/geo/market/clear-stop"), "/api/geo/market/clear-stop");
  assert.equal(geoRoutePattern("/api/geo/market/orders/o-123/resolve"), "/api/geo/market/orders/:id/resolve");
  assert.equal(geoRoutePattern("/api/geo/market/orders/o-123/lost"), "/api/geo/market/orders/:id/lost");
  assert.equal(geoRoutePattern("/api/geo/market/orders/o-123/anything"), "/api/geo/market/orders/:id/:action");
  assert.equal(geoRoutePattern("/api/geo/market/topups/t-1/confirm"), "/api/geo/market/topups/:id/confirm");
});

test("a 讲错我方 notice's title states the fact", () => {
  assert.equal(wrongOursTitle(project, { engine: "deepseek", statement: "把玛仕度肽说成每天注射一次" }), "DeepSeek 把玛仕度肽说成每天注射一次");
  assert.equal(wrongOursTitle(project, { engine: "deepseek", statement: "玛仕度肽每天注射一次。" }), "DeepSeek 把玛仕度肽说成每天注射一次");
  assert.equal(wrongOursTitle(project, { engine: "doubao", statement: "mazdutide 是口服药" }), "豆包把mazdutide说成口服药");
  assert.equal(wrongOursTitle(project, { engine: "kimi", statement: "每天一次" }), "Kimi 讲错玛仕度肽：每天一次");
  // A judge's whole sentence made a six-line title on a phone: the title keeps 36 characters and the sentence moves to the body.
  const long = "玛仕度肽在国内获批用于治疗成人2型糖尿病并且可以作为口服片剂每天服用一次不需要注射。";
  const title = wrongOursTitle(project, { engine: "kimi", statement: long });
  assert.ok([...title].length <= "Kimi 讲错玛仕度肽：".length + 36, title);
  assert.ok(title.endsWith("…"));
  assert.equal(geoNoticeHref("geo_1/answers/snap_1"), "/app/geo/geo_1/answers/snap_1");
  assert.equal(geoNoticeHref("../evil"), null);
  assert.equal(geoNoticeHref("geo_1/a/b/c"), null);
});

test("a long 讲错我方 statement is shortened in the title and whole in the body", async () => {
  /** @type {Array<Record<string, any>>} */
  const sent = [];
  const notifications = { async create(/** @type {string} */ _user, /** @type {Record<string, any>} */ input) { sent.push(input); return { id: "1" }; } };
  const notifier = createGeoNotifier({ notifications, store: { async query() { return { rows: [] }; } }, config: { operatorUsers: [] } });
  const long = "玛仕度肽在国内获批用于治疗成人2型糖尿病并且可以作为口服片剂每天服用一次不需要注射。";
  await notifier.wrongOurs(project, { id: "long", engine: "kimi", statement: long, severity: "S3", evidence_quote: "每周一次皮下注射" });
  await notifier.wrongOurs(project, { id: "short", engine: "kimi", statement: "每天一次", severity: "S3" });
  assert.equal(sent[0].body, `${long}\n依据：“每周一次皮下注射”`);
  assert.ok(sent[0].title.endsWith("…"));
  assert.equal(sent[1].body, "点开看这条回答和依据。", "a statement the title kept whole is not repeated");
});

test("the five notices: kinds, severities, pages, keys; S3+ alone, lower severities folded per day; operators apart", async () => {
  /** @type {Array<{ userId: string, input: Record<string, any> }>} */
  const sent = [];
  const notifications = { async create(/** @type {string} */ userId, /** @type {Record<string, any>} */ input) { sent.push({ userId, input }); return { id: String(sent.length) }; } };
  const store = { async query() { return { rows: [{ id: "e2", engine: "doubao", statement: "玛仕度肽是口服药", severity: "S2" }, { id: "e3" }] }; } };
  const notifier = createGeoNotifier({ notifications, store, config: { operatorUsers: ["ops"] } });
  await notifier.diagnosisDone(project, { roundId: "r1", engines: 5, answers: 310, wrongOurs: 2 });
  await notifier.targetsReady(project, { version: 1, suggestedBudgetCny: 12000 });
  await notifier.firstPublishable(project, { count: 3, budgetSet: false });
  await notifier.firstCited(project, { engine: "deepseek", title: "玛仕度肽减重证据卡" });
  await notifier.wrongOurs(project, { id: "e1", engine: "deepseek", statement: "玛仕度肽每天注射一次", severity: "S3", last_snapshot_id: "s1",
    evidence_quote: "每周一次皮下注射" });
  await notifier.wrongOurs(project, { id: "e2", engine: "doubao", statement: "玛仕度肽是口服药", severity: "S2" });
  await notifier.articleSafety(project, { id: "a1", title: "减重科普" });
  await notifier.alertOperator({ kind: "geo_probe_engine_paused", engine: "kimi", idempotencyKey: "geo:probe:kimi:paused" });
  const user = sent.filter((entry) => entry.userId === "u1").map((entry) => entry.input);
  assert.deepEqual(user.map((input) => [input.title, input.severity]), [
    ["玛仕度肽：诊断完成", "info"],
    ["玛仕度肽：三档目标出来了", "info"],
    ["玛仕度肽：首批稿件可发布", "info"],
    ["DeepSeek 第一次引用了《玛仕度肽减重证据卡》", "info"],
    ["DeepSeek 把玛仕度肽说成每天注射一次", "safety"],
    ["豆包把玛仕度肽说成口服药（另有 1 处）", "safety"],
    ["《减重科普》有临床安全问题，暂不投放", "safety"],
  ]);
  assert.deepEqual(user.map((input) => input.idempotencyKey), ["geo:geo_1:diagnosis:r1", "geo:geo_1:targets:1", "geo:geo_1:first-publishable",
    "geo:geo_1:first-cited", "geo:wrong_ours:e1:first", "geo:wrong_ours:e2:first", "geo:article-safety:a1"]);
  assert.deepEqual([user[2].body, user[2].source.id], ["3 篇稿件可以发布了，可以在“行动”里查看；投放渠道接通后才能投放。", "geo_1/content"],
    "with no media market configured, no budget is asked for");
  assert.deepEqual(user[4].source, { type: "geo", id: "geo_1/answers/s1" }, "a 讲错我方 opens on its answer");
  assert.equal(user[4].groupKey, undefined, "an S3 stands alone");
  assert.match(String(user[5].groupKey), /^geo-wrong:geo_1:\d{4}-\d{2}-\d{2}$/, "lower severities fold into one line a day");
  assert.ok(user.every((input) => input.noticeType === "notify" && input.projectId === "mashidu" && input.actions[0].id === "open"));
  const operator = sent.filter((entry) => entry.userId === "ops");
  assert.deepEqual(operator.map((entry) => [entry.input.title, entry.input.severity]), [["测量：一家 AI 引擎暂停探测", "attention"]],
    "machinery goes to operators only");
  // G21: an engine down on the probe host is handled there, never in the placement account.
  assert.equal(operator[0].input.body, "引擎 Kimi。在探测机上重新登录这家 AI，或重开它的标签页；恢复后会自动续测。");
  assert.deepEqual(GEO_NOTICE_KINDS, ["diagnosis_done", "targets_ready", "first_publishable", "first_cited", "wrong_or_safety"]);
  // The measurement's event reads the error row and keeps the event's own key.
  const rowStore = { async query(/** @type {string} */ sql) {
    if (sql.includes("FROM evimed_geo.errors")) return { rows: [{ id: "e9", geo_project_id: "geo_1", user_id: "u1", engine: "deepseek", severity: "S4",
      statement: "把玛仕度肽说成可以口服", last_snapshot_id: "s9" }] };
    return { rows: [{ id: "geo_1", user_id: "u1", project_id: "mashidu", product: project.product, tier: "2" }] };
  } };
  const measured = [];
  const second = createGeoNotifier({ notifications: { async create(/** @type {string} */ _u, /** @type {any} */ input) { measured.push(input); return {}; } }, store: rowStore });
  await second.measurement({ kind: "wrong_ours", errorId: "e9", idempotencyKey: "geo:wrong_ours:e9:seen:s9" });
  assert.deepEqual([measured[0].title, measured[0].idempotencyKey, measured[0].severity], ["DeepSeek 把玛仕度肽说成可以口服",
    "geo:wrong_ours:e9:seen:s9", "safety"]);
  // A replay the inbox refuses as different content was sent already: not a failure.
  const replay = createGeoNotifier({ notifications: { async create() { throw Object.assign(new Error("x"), { code: "notification_idempotency_conflict" }); } }, store });
  assert.equal(await replay.diagnosisDone(project, { roundId: "r1", engines: 5, answers: 310, wrongOurs: 0 }), true);
  assert.equal(replay.counts.failed, 0);
});

test("an operator is told where each alert is handled: the probe host, the probe config, the measurement or the placement account", () => {
  assert.match(operatorBody({ type: "geo_probe_engine_paused", engine: "deepseek" }), /探测机上重新登录这家 AI/);
  assert.match(operatorBody({ kind: "geo_probe_suspect" }), /探测机上重新登录/);
  assert.match(operatorBody({ kind: "geo_probe_host_down" }), /探测机是否在线/);
  assert.match(operatorBody({ kind: "geo_probe_unconfigured" }), /探测通道的地址和密钥/);
  assert.match(operatorBody({ type: "metrics_missing" }), /测量任务/);
  assert.equal(operatorBody({ type: "reconciliation_mismatch", diff: 12 }), "差额 ¥12.00。在“循证 GEO”的投放账户里处理。");
  for (const type of ["geo_probe_engine_paused", "geo_probe_busy", "diagnosis_empty"]) {
    assert.equal(operatorBody({ type }).includes("投放账户"), false, `${type} is not a placement matter`);
  }
});

test("the next weekly re-measure is the one the schedule will run: taken weeks and the baseline rest are skipped", () => {
  // The first production baseline finished on Thursday 2026-09-25 17:59Z; the Monday 09-28 03:00 (Shanghai) re-measure falls within three days of it.
  const baselineFinishedAt = "2026-09-25T17:59:00Z";
  const now = new Date("2026-09-26T06:00:00Z");
  assert.equal(baselineTooRecent(baselineFinishedAt, zonedInstant("2026-09-28", 3, SHANGHAI)), true);
  assert.equal(nextWeeklySlot({ now, timeZone: SHANGHAI, baselineFinishedAt }).monday, "2026-10-05", "09-28 is skipped by the rest, as the schedule skips it");
  // On the Monday itself, after 03:00, a week already skipped is taken: the next is the following Monday.
  const monday = new Date("2026-09-28T02:00:00Z");
  assert.equal(nextWeeklySlot({ now: monday, timeZone: SHANGHAI, baselineFinishedAt: "2026-09-01T00:00:00Z", taken: new Set(["weekly:2026-09-28"]) }).monday,
    "2026-10-05");
  assert.equal(nextWeeklySlot({ now: monday, timeZone: SHANGHAI, baselineFinishedAt: "2026-09-01T00:00:00Z" }).monday, "2026-09-28",
    "a week due and not yet taken is this one");
  assert.equal(nextWeeklySlot({ now, timeZone: SHANGHAI, baselineFinishedAt: "2026-09-20T00:00:00Z" }).monday, "2026-09-28");
});

test("every GEO dispatch's prompt carries the platform's mark, and memory takes none of it as the researcher's words", () => {
  const briefs = [
    insightBrief(project, { scope: [{ step: "evidence", fidelity: "full" }], target: null, full: true }),
    strategyBrief(project, { minimal: false }),
    contentBrief(project, { number: 1, size: 1, reason: "first", groups: [], errors: [] }),
    exportBrief(project, { kind: "weekly", week: "2026-09-28" }),
    exportBrief(project, { kind: "proposal" }),
  ];
  for (const brief of briefs) {
    const prompt = geoRunPrompt(brief, "geo-content-1-a1");
    assert.ok(prompt.startsWith(brief), "the brief first: the kernel names a session after its first message");
    assert.ok(prompt.endsWith("<evimed-geo-run>geo-content-1-a1</evimed-geo-run>"));
    // Sent as the prompt itself, it arrives with the user's source; the tag is what marks it ours.
    const message = { info: { role: "user", source: "user" }, parts: [{ type: "text", text: prompt }] };
    assert.equal(memorySourceRejection(message), "injected", "a brief is never stored as what the researcher said");
  }
  assert.equal(geoRunPrompt("x", "geo-a b<c>").endsWith("<evimed-geo-run>geo-a-b-c-</evimed-geo-run>"), true, "the id is one token");
});
