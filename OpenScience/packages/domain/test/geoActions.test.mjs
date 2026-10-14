// The action read model of 「循证 GEO」: one implementation of what is being done for each question group and what came of it. The
// cases are the audit's (C §2.5): a group's reading is k of n and never a rate under the floor, a target is the chosen tier's row
// for the pool, a control group has no action, the status is the furthest stage reached, and the 8-week stale rule is one function.
import assert from "node:assert/strict";
import test from "node:test";

import {
  GEO_ACTION_CHECKS,
  GEO_ACTION_KINDS,
  GEO_ACTION_PROMISES,
  GEO_ACTION_STATUSES,
  GEO_METRICS,
  GEO_MIN_CELL_SAMPLES,
  GEO_NEEDS_YOU_KINDS,
  GEO_STALE_PLACEMENT_WEEKS,
  deriveGeoActions,
  geoActionKey,
  geoActionNotices,
  geoActionSentence,
  geoErrorsByClaim,
  geoExpectedMetrics,
  geoGroupReading,
  geoChoiceEffects,
  geoGroupShort,
  geoNeedsYou,
  geoPlacementStale,
  geoPoolTarget,
  geoStepSummary,
  geoTextKey,
  parseGeoActionKey,
} from "../index.mjs";

const NOW = "2026-10-14T00:00:00.000Z";
const DAY = 86_400_000;
/** @param {number} days */
const ago = (days) => new Date(Date.parse(NOW) - days * DAY).toISOString();

/** Four groups: two pilot groups in P2 and P4, one in P1, and one control group in P2. */
const groups = [
  { id: "g-p2", name: "停药与反弹", pool: "P2", weight: 0.12, isControl: false, journeyStage: "疗效评估", questions: [
    { id: "q1", text: "停药后会反弹吗？", isMeasured: true }, { id: "q2", text: "停药多久反弹？", isMeasured: true }, { id: "q3", text: "闲聊", isMeasured: false } ] },
  { id: "g-p4", name: "说明书安全题组", pool: "P4", weight: 0.06, isControl: false, questions: [{ id: "q4", text: "哪些人不能用？", isMeasured: true }] },
  { id: "g-p1", name: "品牌身份", pool: "P1", weight: 0.2, isControl: false, questions: [{ id: "q5", text: "信尔美是什么药？", isMeasured: true }] },
  { id: "g-c1", name: "对照一", pool: "P2", weight: 0.1, isControl: true, questions: [{ id: "q6", text: "对照问句", isMeasured: true }] },
];

const targets = { version: 2, rows: [
  { tier: "2", metricId: "M-01", pool: "P2", target: 15, horizonWeeks: 12, dataType: "forecast" },
  { tier: "2", metricId: "M-06", pool: "P1", target: 98, horizonWeeks: 12, dataType: "forecast" },
  { tier: "2", metricId: "M-15", pool: "P4", target: 0, horizonWeeks: 12, dataType: "forecast" },
  { tier: "2", metricId: "M-01", pool: "P1", target: 40, dataType: "forecast" },
  { tier: "1", metricId: "M-01", pool: "P2", target: 12, dataType: "forecast" },
] };

const gaps = [
  { gapId: "GAP-01", groupId: "g-p4", group: "说明书安全题组", pool: "P4", class: "benefit_only", rank: 1, safetyPinned: true, handoff: "content",
    judgment: "就医红旗覆盖不全", consequence: { band: "高", basis: "健康后果" },
    expectedPoints: [{ pointId: "EP-1", kind: "safety", statement: "出现过敏及时就医", refs: [{ type: "claim_id", id: "c-1" }] }] },
  { gapId: "GAP-02", groupId: "g-p2", group: "停药与反弹", pool: "P2", class: "dropped_condition", rank: 2, handoff: "content", judgment: "没提停药后的限定条件", expectedPoints: [] },
  { gapId: "GAP-03", groupId: "g-p1", group: "品牌身份", pool: "P1", class: "wrong", rank: 3, handoff: "EC", judgment: "讲错", evidence: { errors: ["e-1"] } },
  { gapId: "GAP-04", groupId: "g-c1", group: "对照一", pool: "P2", class: "weak_source", rank: null, handoff: "monitor_only", judgment: "对照组" },
];

const base = () => ({ now: NOW, tier: "2", engines: ["doubao", "qianwen", "yuanbao"], groups, strategy: { version: 7, gaps, expectations: [
  { engine: "doubao", ceiling: "undetermined" }, { engine: "qianwen", ceiling: "mention_and_accuracy" }, { engine: "yuanbao", ceiling: "accuracy_only" } ] },
  targets, readings: [], errors: [], articles: [], orders: [], ownedLinks: [], cited: [], batches: [], choices: [], candidates: {}, arms: {}, poolReadings: [] });

/** @param {{ actions: any[] }} result @returns {Record<string, any>} */
const byKey = (result) => Object.fromEntries(result.actions.map((action) => [action.key, action]));

test("a group's reading is k of n; a rate exists only from the floor of answers", () => {
  const thin = geoGroupReading({ k: 3, n: GEO_MIN_CELL_SAMPLES - 1 });
  assert.deepEqual(thin, { k: 3, n: 29, state: "thin" });
  assert.equal(Object.hasOwn(thin, "rate"), false, "no rate field under the floor");
  assert.deepEqual(geoGroupReading({ k: 15, n: 30 }), { k: 15, n: 30, state: "enough", rate: 50 });
  assert.deepEqual(geoGroupReading({ k: 1, n: 3, floor: 3 }), { k: 1, n: 3, state: "enough", rate: 33.33 });
  assert.deepEqual(geoGroupReading({ k: null, n: null }), { k: null, n: null, state: "absent" });
  assert.deepEqual(geoGroupReading({ k: 0, n: 0 }), { k: null, n: null, state: "absent" });
  assert.deepEqual(geoGroupReading(undefined), { k: null, n: null, state: "absent" });
});

test("a placement is stale at eight weeks published and never cited, strictly past the line", () => {
  assert.equal(GEO_STALE_PLACEMENT_WEEKS, 8);
  assert.equal(geoPlacementStale({ publishedAt: ago(57), now: NOW, cited: false }), true);
  assert.equal(geoPlacementStale({ publishedAt: ago(56), now: NOW, cited: false }), false, "exactly eight weeks is not yet past it");
  assert.equal(geoPlacementStale({ publishedAt: ago(100), now: NOW, cited: true }), false, "a cited placement is never stale");
  assert.equal(geoPlacementStale({ publishedAt: null, now: NOW, cited: false }), false);
  assert.equal(geoPlacementStale({ publishedAt: ago(20), now: NOW, cited: false, weeks: 2 }), true);
});

test("the expected metrics are the owner's table by pool, and a pool's target is the chosen tier's row, else the project-wide one", () => {
  assert.deepEqual(geoExpectedMetrics("P1"), GEO_METRICS.net_effect.metrics_by_pool.P1);
  assert.deepEqual(geoExpectedMetrics("P4"), ["M-15"]);
  assert.deepEqual(geoExpectedMetrics("index"), []);
  assert.deepEqual(geoExpectedMetrics(null), []);
  assert.equal(geoPoolTarget(targets.rows, { tier: "2", pool: "P2", metricIds: ["M-01", "M-01S"] })?.target, 15);
  assert.equal(geoPoolTarget(targets.rows, { tier: "1", pool: "P2", metricIds: ["M-01"] })?.target, 12);
  assert.equal(geoPoolTarget(targets.rows, { tier: "3", pool: "P2", metricIds: ["M-01"] }), null);
  const withAll = [...targets.rows, { tier: "2", metricId: "M-01S", pool: "all", target: 12 }];
  assert.equal(geoPoolTarget(withAll, { tier: "2", pool: "P3", metricIds: ["M-01", "M-01S"] })?.target, 12, "no P3 row: the project-wide one");
});

test("a group is short on its own reading when it is a measurement, on the pool's otherwise, and never on nothing", () => {
  assert.deepEqual(geoGroupShort({ own: { value: 5, status: "ok" }, proxy: { value: 40, status: "ok" }, goal: 15 }), { short: true, basis: "group" });
  assert.deepEqual(geoGroupShort({ own: { value: 20, status: "ok" }, proxy: { value: 1, status: "ok" }, goal: 15 }), { short: false, basis: "group" });
  assert.deepEqual(geoGroupShort({ own: { value: 5, status: "insufficient" }, proxy: { value: 10, status: "ok" }, goal: 15 }), { short: true, basis: "pool" });
  assert.deepEqual(geoGroupShort({ own: null, proxy: null, goal: 15 }), { short: false, basis: null });
  assert.deepEqual(geoGroupShort({ own: { value: 5, status: "ok" }, goal: null }), { short: false, basis: null });
});

test("an action key round-trips, and a text key does not move while the words do not", () => {
  const key = geoActionKey({ kind: "fill_gap", groupId: "ggr_ab12", ref: "benefit_only" });
  assert.equal(key, "fill_gap:ggr_ab12:benefit_only");
  assert.deepEqual(parseGeoActionKey(key), { kind: "fill_gap", groupId: "ggr_ab12", ref: "benefit_only" });
  assert.deepEqual(parseGeoActionKey("correct_error:-:ge_1"), { kind: "correct_error", groupId: null, ref: "ge_1" });
  for (const bad of ["", "fill_gap", "other:g:r", "fill_gap:g:r:extra", "fill_gap:a b:r", null, 5]) assert.equal(parseGeoActionKey(bad), null, String(bad));
  assert.equal(geoTextKey("开通  并认证 公众号"), geoTextKey("开通 并认证 公众号"));
  assert.notEqual(geoTextKey("a"), geoTextKey("b"));
  assert.match(geoTextKey("x"), /^[0-9a-f]{8}$/);
});

test("gaps become actions by group and class; a control group and a monitor-only gap have none", () => {
  const result = deriveGeoActions(base());
  const actions = byKey(result);
  assert.deepEqual(Object.keys(actions).sort(), ["correct_error:g-p1:wrong", "fill_gap:g-p2:dropped_condition", "fill_gap:g-p4:benefit_only"].sort());
  assert.deepEqual(result.control.map((/** @type {any} */ entry) => entry.id), ["g-c1"]);
  assert.deepEqual(result.noAction, [{ gapId: "GAP-04", groupId: "g-c1", reason: "control_group" }]);
  for (const action of result.actions) assert.ok(GEO_ACTION_KINDS.includes(action.kind) && GEO_ACTION_STATUSES.includes(action.status));
  assert.deepEqual(result.actions.map((action) => action.need.rank), [1, 2, 3], "ordered by the run's rank");
  const safety = actions["fill_gap:g-p4:benefit_only"];
  assert.equal(safety.need.safetyPinned, true);
  assert.equal(safety.need.judgment, "就医红旗覆盖不全");
  assert.deepEqual(safety.need.expectedPoints, [{ id: "EP-1", kind: "safety", statement: "出现过敏及时就医", claimIds: ["c-1"] }]);
  assert.deepEqual(safety.questions, [{ id: "q4", text: "哪些人不能用？" }]);
  assert.equal(safety.status, "proposed");
});

test("the expectation is the pool's metric and the chosen tier's target; a number a run typed is never the target", () => {
  const result = deriveGeoActions({ ...base(), strategy: { ...base().strategy, actions: [
    { gapId: "GAP-02", what: { layer: "qa", channel: "wechat_mp" }, target: 80, promise: "raise_mention", metricId: "M-06" },
  ] } });
  const gap = byKey(result)["fill_gap:g-p2:dropped_condition"];
  assert.deepEqual(gap.expected.metricIds, ["M-01", "M-02", "M-06", "M-08"]);
  assert.equal(gap.expected.primaryMetricId, "M-06", "the run's metric when it is one of the pool's");
  const plain = byKey(deriveGeoActions(base()))["fill_gap:g-p2:dropped_condition"];
  assert.equal(plain.expected.primaryMetricId, "M-01");
  assert.equal(plain.expected.target, 15);
  assert.equal(plain.expected.horizonWeeks, 12);
  assert.equal(plain.expected.dataType, "forecast");
  assert.deepEqual(plain.expected.basis, { tier: "2", metricId: "M-01", pool: "P2", targetsVersion: 2, source: "targets", note: null });
  // the typed target 80 is not the target, and its missing basis is noted
  assert.ok(gap.checks.some((/** @type {any} */ check) => check.code === "target_without_basis"));
  assert.equal(byKey(deriveGeoActions({ ...base(), tier: "1" }))["fill_gap:g-p2:dropped_condition"].expected.target, 12, "another tier, another row");
});

test("a metric outside the pool's table is noted and not used; an unknown promise falls back to the code's", () => {
  const result = deriveGeoActions({ ...base(), strategy: { ...base().strategy, actions: [{ gapId: "GAP-01", metricId: "M-11", promise: "guaranteed" }] } });
  const action = byKey(result)["fill_gap:g-p4:benefit_only"];
  assert.equal(action.expected.primaryMetricId, "M-15");
  assert.deepEqual(action.checks.map((/** @type {any} */ check) => check.code).sort(), ["metric_not_in_pool", "promise_unknown"]);
  for (const check of action.checks) assert.ok(GEO_ACTION_CHECKS.includes(check.code));
  assert.equal(GEO_ACTION_PROMISES.includes(action.expected.promise), true);
});

test("a group below the floor reads k of n and a state with no rate anywhere in the action", () => {
  const readings = [
    { groupId: "g-p2", metricId: "M-01", roundId: "r1", date: "2026-09-25", kind: "baseline", k: 0, n: 12, value: 0, status: "insufficient" },
    { groupId: "g-p2", metricId: "M-01", roundId: "r2", date: "2026-10-05", kind: "weekly", k: 2, n: 14, value: 14.29, status: "insufficient" },
  ];
  const action = byKey(deriveGeoActions({ ...base(), readings }))["fill_gap:g-p2:dropped_condition"];
  assert.deepEqual(action.expected.baseline, { metricId: "M-01", k: 0, n: 12, state: "thin", roundId: "r1", date: "2026-09-25", coverage: null });
  assert.deepEqual(action.expected.from, { metricId: "M-01", k: 2, n: 14, state: "thin", roundId: "r2", date: "2026-10-05", coverage: null });
  assert.equal(JSON.stringify(action).includes('"rate"'), false, "no rate for a thin group, anywhere in the action");
  assert.equal(action.expected.reached, null, "no verdict on a thin reading");
  assert.deepEqual(action.observed.series.map((/** @type {any} */ point) => [point.k, point.n, point.state]), [[0, 12, "thin"], [2, 14, "thin"]]);
  assert.equal(action.expected.promise, "raise_mention");
  const never = byKey(deriveGeoActions({ ...base(), readings: [readings[0]] }))["fill_gap:g-p2:dropped_condition"];
  assert.equal(never.expected.promise, "enter_mention", "a group nobody mentions is promised entry, never a rank");
});

test("a group already at its target is promised completion, and its gap turns to correction when the errors it names are open", () => {
  const readings = [{ groupId: "g-p2", metricId: "M-01", roundId: "r2", date: "2026-10-05", kind: "weekly", k: 40, n: 100, value: 40, status: "ok" }];
  const errors = [{ id: "e-9", fingerprint: "f9", engine: "qianwen", groupId: "g-p2", severity: "S3", status: "open", statement: "错", createdAt: ago(3) }];
  const named = gaps.map((gap) => (gap.gapId === "GAP-02" ? { ...gap, evidence: { metric: "M-01", errors: ["e-9"] }, expectedPoints: [
    { pointId: "EP-1", kind: "product", statement: "补上限定条件", refs: [] }] } : gap));
  const result = byKey(deriveGeoActions({ ...base(), strategy: { ...base().strategy, gaps: named }, readings, errors }));
  const gap = result["fill_gap:g-p2:dropped_condition"];
  assert.equal(gap.expected.reached, true);
  assert.equal(gap.expected.promise, "coverage_complete");
  assert.equal(gap.kind, "correct_error", "the kind flips");
  assert.deepEqual(gap.need.errorIds, ["e-9"]);
  assert.deepEqual(gap.expected.closes, { errors: 1, points: 1 }, "what the row now promises: close the errors, complete the expected points");
  assert.equal(Object.hasOwn(result, "correct_error:g-p2:e-9"), false, "the error is the gap's, not an action of its own");
  // the same group below its target keeps the kind
  const short = byKey(deriveGeoActions({ ...base(), strategy: { ...base().strategy, gaps: named }, errors,
    readings: [{ ...readings[0], k: 5, value: 5 }] }))["fill_gap:g-p2:dropped_condition"];
  assert.equal(short.kind, "fill_gap");
  assert.equal(short.expected.reached, false);
  assert.equal(short.expected.promise, "raise_mention");
});

test("errors no gap claims become one action per claim and group, with every engine that says it", () => {
  const errors = [
    { id: "e-1", fingerprint: "claimA", engine: "doubao", groupId: "g-p1", severity: "S3", status: "open", statement: "错", createdAt: ago(5) },
    { id: "e-2", fingerprint: "claimB", engine: "doubao", groupId: "g-p1", severity: "S2", status: "open", statement: "又错", createdAt: ago(4) },
    { id: "e-3", fingerprint: "claimB", engine: "kimi", groupId: "g-p1", severity: "S2", status: "acting", statement: "又错", createdAt: ago(3) },
    { id: "e-4", fingerprint: "claimC", engine: "kimi", groupId: "g-p1", severity: "S1", status: "closed", statement: "旧", createdAt: ago(30), materials: [] },
  ];
  const result = byKey(deriveGeoActions({ ...base(), errors }));
  // e-1 is named by GAP-03; e-2 and e-3 are one claim; e-4 is closed and nothing was done: no action
  assert.deepEqual(result["correct_error:g-p1:wrong"].need.errorIds, ["e-1"]);
  assert.deepEqual(result["correct_error:g-p1:e-2"].need.errorIds, ["e-2", "e-3"]);
  assert.equal(Object.keys(result).some((key) => key.includes("e-4")), false);
});

test("the status is the furthest stage reached; skipped and stale are flags", () => {
  const article = (/** @type {any} */ over) => ({ id: "a1", groupId: "g-p4", layer: "qa", title: "安全问答", status: "draft", gate: "unverified", safety: "clear", createdAt: ago(10), ...over });
  const key = "fill_gap:g-p4:benefit_only";
  const status = (/** @type {any} */ over) => byKey(deriveGeoActions({ ...base(), ...over }))[key].status;
  assert.equal(status({}), "proposed");
  assert.equal(status({ batches: [{ key: "run:content:1", state: "running", groups: ["g-p4"] }] }), "writing");
  assert.equal(status({ articles: [article({})] }), "writing");
  assert.equal(status({ articles: [article({ status: "publishable", gate: "passed" })] }), "ready");
  assert.equal(status({ articles: [article({ status: "placed" })], orders: [{ id: "o1", articleId: "a1", state: "submitted", domain: "dayi.org.cn" }] }), "placed");
  const published = { articles: [article({ status: "published" })], orders: [{ id: "o1", articleId: "a1", state: "published", publishedAt: ago(10), domain: "dayi.org.cn" }] };
  assert.equal(status(published), "live");
  assert.equal(status({ ...published, cited: [{ articleId: "a1", engine: "qianwen", questionId: "q4", firstSeen: ago(2) }] }), "cited");
  assert.equal(status({ ...published, orders: [{ ...published.orders[0], publishedAt: ago(60) }] }), "stale", "published eight weeks, never cited");
  assert.equal(status({ ...published, orders: [{ ...published.orders[0], publishedAt: ago(60) }], cited: [{ articleId: "a1", engine: "qianwen", firstSeen: ago(30) }] }), "cited");
  const verified = status({ ...published, cited: [{ articleId: "a1", engine: "qianwen", firstSeen: ago(2) }],
    arms: { "P4|M-15": { netEffect: -2, verdict: "up", noiseBand: 1, comparable: true } } });
  assert.equal(verified, "verified");
  assert.equal(status({ ...published, choices: [{ key, skipped: true, updatedAt: ago(1) }] }), "skipped");
  assert.equal(status({ articles: [article({ status: "withdrawn" })] }), "proposed", "a withdrawn article is nothing");
});

test("a person's choices are found under the key a group had before its set was copied, and swap the first source", () => {
  const renamed = groups.map((group) => (group.id === "g-p4" ? { ...group, id: "g-p4-v2", aliasIds: ["g-p4"] } : group));
  const choices = [{ key: "fill_gap:g-p4:benefit_only", skipped: false, sourceDomain: "kepuchina.cn", updatedAt: ago(1) }];
  const candidates = { "g-p4-v2": [
    { domain: "dayi.org.cn", name: "大医", layer: "coverage", citedFor: { qianwen: 12 }, conditions: { icp: true, newsIndexed: true, medical: true }, price: 120, available: true, origin: "market" },
    { domain: "www.kepuchina.cn", layer: "anchor", citedFor: { yuanbao: 5 }, available: true, origin: "cited" },
  ] };
  const action = byKey(deriveGeoActions({ ...base(), groups: renamed, choices, candidates,
    strategy: { ...base().strategy, gaps: gaps.map((gap) => (gap.groupId === "g-p4" ? { ...gap, groupId: "g-p4-v2" } : gap)) } }))["fill_gap:g-p4-v2:benefit_only"];
  assert.ok(action, "the action is under the group's current id");
  assert.equal(action.choice?.sourceDomain, "kepuchina.cn");
  assert.deepEqual(action.sources.map((/** @type {any} */ source) => [source.domain, source.chosen]), [["kepuchina.cn", "swapped"], ["dayi.org.cn", "recommended"]]);
  assert.deepEqual(action.sources[1].conditions, { icp: true, newsIndexed: true, medical: true });
  assert.equal(action.sources[1].price, 120);
  assert.equal(action.status, "proposed", "a swap is not a skip");
});

test("a group short of its target with no gap is an action of its own; one at target with live articles is kept", () => {
  const readings = [
    { groupId: "g-p1", metricId: "M-01", roundId: "r2", date: "2026-10-05", kind: "weekly", k: 2, n: 12, value: 16.67, status: "insufficient" },
  ];
  const noGap = { ...base(), strategy: { version: 1, gaps: [], expectations: [] }, readings,
    poolReadings: [{ pool: "P1", metricId: "M-01", value: 30, status: "ok" }, { pool: "P2", metricId: "M-01", value: 5, status: "ok" }] };
  const result = byKey(deriveGeoActions(noGap));
  assert.deepEqual(Object.keys(result).sort(), ["win_cluster:g-p1:M-01", "win_cluster:g-p2:M-01"].sort(),
    "g-p1: own reading thin, the pool's 30 is below its 40; g-p2: no reading, the pool's 5 is below 15; the control group is never one");
  assert.equal(result["win_cluster:g-p1:M-01"].kind, "win_cluster");
  const atTarget = deriveGeoActions({ ...noGap, poolReadings: [{ pool: "P1", metricId: "M-01", value: 55, status: "ok" }, { pool: "P2", metricId: "M-01", value: 50, status: "ok" }],
    articles: [{ id: "a2", groupId: "g-p2", layer: "popular", title: "科普", status: "published", gate: "passed", safety: "clear" }],
    orders: [{ id: "o2", articleId: "a2", state: "published", publishedAt: ago(5), domain: "kepuchina.cn" }] });
  assert.deepEqual(atTarget.actions.map((action) => action.key), ["maintain:g-p2:M-01"]);
  assert.equal(atTarget.actions[0].status, "live");
});

test("what the run wrote that matches no gap is reported, and a reason alone answers a gap with no action", () => {
  const entries = [
    { gapId: "GAP-02", what: { layer: "popular", title: "停药后怎么办", channel: "zhihu" }, engines: ["qianwen", "kimi"], sources: [{ domain: "WWW.dayi.org.cn", why: "说明书原文所在" }],
      promise: "raise_mention", basis: "千问检索触发率 98.86%", reason: "补上限定条件" },
    { gapId: "GAP-01", reason: "安全题组由纠错覆盖稿统一处理" },
    { gapId: "GAP-99", what: { layer: "qa" } },
  ];
  const result = deriveGeoActions({ ...base(), strategy: { ...base().strategy, actions: entries } });
  const gap = byKey(result)["fill_gap:g-p2:dropped_condition"];
  assert.deepEqual(gap.what, { layer: "popular", title: "停药后怎么办", channel: "zhihu", channelNote: null });
  assert.deepEqual(gap.engines, ["qianwen"], "an engine outside the project is left out and noted");
  assert.ok(gap.checks.some((/** @type {any} */ check) => check.code === "engine_not_in_project" && check.engine === "kimi"));
  assert.equal(gap.sources[0].domain, "dayi.org.cn");
  assert.equal(gap.sources[0].why, "说明书原文所在");
  assert.equal(gap.reason, "补上限定条件");
  assert.equal(Object.hasOwn(byKey(result), "fill_gap:g-p4:benefit_only"), false, "answered with a reason only: no action to list");
  assert.deepEqual(result.noAction.find((entry) => entry.gapId === "GAP-01"), { gapId: "GAP-01", groupId: "g-p4", reason: "安全题组由纠错覆盖稿统一处理" });
  assert.deepEqual(result.unmatched, [{ gapId: "GAP-99", groupId: null, gapClass: null, errorIds: [] }]);
});

test("a mention promised on an engine that rarely searches the web is noted, and engines follow the ceilings", () => {
  const result = deriveGeoActions({ ...base(), strategy: { ...base().strategy, actions: [
    { gapId: "GAP-02", engines: ["yuanbao", "qianwen"], promise: "raise_mention" },
  ] } });
  const action = byKey(result)["fill_gap:g-p2:dropped_condition"];
  assert.deepEqual(action.checks.filter((/** @type {any} */ check) => check.code === "promise_above_ceiling").map((/** @type {any} */ check) => check.engine), ["yuanbao"]);
  const defaulted = byKey(deriveGeoActions(base()))["fill_gap:g-p2:dropped_condition"];
  assert.deepEqual(defaulted.engines, ["qianwen"], "a mention goes only where the engine can be promised one");
  assert.deepEqual(byKey(deriveGeoActions(base()))["correct_error:g-p1:wrong"].engines, ["qianwen", "yuanbao"], "accuracy goes where there is a ceiling at all");
});

test("the net effect is the arms', stated with its band, and only when comparable", () => {
  const arms = { "all|M-19": { netEffect: 4.2, verdict: "up", noiseBand: 3, comparable: true } };
  const published = { articles: [{ id: "a1", groupId: "g-p4", layer: "qa", status: "published", gate: "passed", safety: "clear" }],
    orders: [{ id: "o1", articleId: "a1", state: "published", publishedAt: ago(4), domain: "d.cn" }] };
  const result = deriveGeoActions({ ...base(), ...published, arms });
  assert.deepEqual(result.headline.arm, { netEffect: 4.2, verdict: "up", noiseBand: 3, comparable: true });
  assert.equal(result.headline.actedGroups, 1);
  assert.equal(result.headline.gapGroupsNotActedOn, 2);
  assert.equal(result.headline.sentence, "已行动的问句群比对照多涨 4.2 个点（波动 ±3）；另有 2 个群的缺口还没有行动");
  assert.equal(geoActionSentence({ actedGroups: 1, gapGroupsNotActedOn: 0, arm: { netEffect: 1, verdict: "flat", noiseBand: 3, comparable: true } }), "已行动的问句群与对照相比没有超出波动（波动 ±3）");
  assert.equal(geoActionSentence({ actedGroups: 2, gapGroupsNotActedOn: 0, arm: { netEffect: null, verdict: null, noiseBand: null, comparable: false } }), "还不能和对照群比较：测量范围不同或样本不足");
  assert.equal(geoActionSentence({ actedGroups: 0, gapGroupsNotActedOn: 3, arm: null }), "另有 3 个群的缺口还没有行动");
  const action = byKey(result)["fill_gap:g-p4:benefit_only"];
  assert.deepEqual(action.observed.arm, { netEffect: 4.2, verdict: "up", noiseBand: 3, comparable: true, scope: "project", pool: null });
});

test("a gap that names no group is the project's: an action with no group, judged on the headline metrics; nothing a run wrote is out of sight", () => {
  const projectGaps = [
    { gapId: "gap-01", class: "weak_source", rank: 1, judgment: "引擎没有一个自有或权威来源可引" },
    { gapId: "gap-02", class: "wrong", rank: 2, judgment: "给药频次被讲错", evidence: { errors: ["e-9"] } },
    { gapId: "gap-03", class: "outdated", group: "已经不存在的语义群", judgment: "引用的页面过时" },
    { gapId: "gap-04", class: "audience_mismatch", handoff: "monitor_only", judgment: "只监测" },
    { gapId: "gap-05", class: "dropped_condition", judgment: "不做" },
  ];
  const targetsWithIndex = { version: 3, rows: [...targets.rows, { tier: "2", metricId: "M-19", pool: "all", target: 35, horizonWeeks: 12, dataType: "forecast" }] };
  const result = deriveGeoActions({ ...base(), targets: targetsWithIndex, strategy: { ...base().strategy, gaps: projectGaps, actions: [
    { gapId: "gap-01", what: { layer: "card", channel: "brand_site" }, metricId: "M-19", promise: "enter_mention", basis: "144 条回答的引用全是第三方" },
    { gapId: "gap-05", reason: "已由 gap-01 的锚点覆盖" },
  ] }, errors: [{ id: "e-9", fingerprint: "f9", engine: "doubao", groupId: "g-p1", severity: "S3", status: "open", statement: "错", createdAt: ago(3) }] });
  const actions = byKey(result);
  assert.deepEqual(Object.keys(actions).filter((key) => key.includes(":-:")).sort(), ["correct_error:-:gap-02", "fill_gap:-:gap-01", "fill_gap:-:gap-03"]);
  const weak = actions["fill_gap:-:gap-01"];
  assert.equal(weak.group, null);
  assert.deepEqual(weak.expected.metricIds, ["M-19", "M-01S"]);
  assert.equal(weak.expected.primaryMetricId, "M-19");
  assert.equal(weak.expected.target, 35, "the tier's project-wide row");
  assert.equal(weak.checks.length, 0);
  assert.equal(weak.what.channel, "brand_site");
  assert.equal(weak.status, "proposed");
  assert.ok(actions["fill_gap:-:gap-03"].checks.some((/** @type {any} */ check) => check.code === "group_unknown" && check.group === "已经不存在的语义群"));
  // the error the wrong gap names is that gap's: it is not also an action of its own
  assert.deepEqual(actions["correct_error:-:gap-02"].need.errorIds, ["e-9"]);
  assert.equal(Object.keys(actions).some((key) => key.startsWith("correct_error:g-p1:")), false);
  // a monitor-only gap and a gap answered with a reason alone are listed as having none, never silently gone
  assert.deepEqual(result.noAction.filter((entry) => entry.groupId === null).map((entry) => [entry.gapId, entry.reason]).sort(),
    [["gap-04", "monitor_only"], ["gap-05", "已由 gap-01 的锚点覆盖"]]);
});

test("the derivation never throws on odd rows, and an empty project has no actions", () => {
  assert.deepEqual(deriveGeoActions({ now: NOW, tier: "2", engines: [], groups: [] }).actions, []);
  const odd = deriveGeoActions(/** @type {any} */ ({ now: "not a date", tier: "2", engines: ["doubao"], groups, strategy: { gaps: [null, 5, { class: "benefit_only" }], actions: [null, "x"] },
    targets: { rows: [null] }, readings: [{ groupId: "g-p2", metricId: "M-01", k: "x", n: null }], errors: [null, {}, { id: "e" }], articles: [null], orders: [undefined],
    ownedLinks: [5], cited: [null], batches: [null], choices: [null] }));
  assert.ok(Array.isArray(odd.actions));
});

test("the people's to-do list holds real asks only, never a finished step", () => {
  const project = { id: "geo_1", budget: null, steps: {
    evidence: { status: "done" }, content: { status: "done" }, sources: { status: "failed" }, diagnosis: { status: "queued", waiting: "credits", note: "额度不足" },
  } };
  const input = {
    project, marketConfigured: true, canReview: true,
    articles: [{ id: "a1", safety: "open", status: "draft" }, { id: "a2", safety: "open", status: "withdrawn" }, { id: "a3", safety: "clear", status: "publishable" }],
    errors: [
      { id: "e1", fingerprint: "f1", severity: "S3", status: "open", engine: "kimi", statement: "错一", createdAt: ago(5), snapshotId: "s1" },
      { id: "e2", fingerprint: "f1", severity: "S4", status: "open", engine: "doubao", statement: "错一", createdAt: ago(4) },
      { id: "e3", fingerprint: "f3", severity: "S3", status: "open", engine: "kimi", statement: "错三", createdAt: ago(3) },
      { id: "e4", fingerprint: "f4", severity: "S3", status: "open", engine: "kimi", statement: "错四", createdAt: ago(2) },
      { id: "e5", fingerprint: "f5", severity: "S1", status: "open", engine: "kimi", statement: "小错", createdAt: ago(2) },
      { id: "e6", fingerprint: "f6", severity: "S4", status: "acting", engine: "kimi", statement: "处理中", createdAt: ago(2) },
    ],
    clientActions: ["开通并认证自有微信公众号", "登记自有抖音号"],
    choices: [{ key: `client:${geoTextKey("登记自有抖音号")}`, skipped: true }],
  };
  const items = /** @type {any[]} */ (geoNeedsYou(input));
  assert.deepEqual(items.map((item) => item.kind), ["set_budget", "release_articles", "correct_severe_error", "correct_severe_error", "client_action", "credits_waiting", "step_failed"]);
  for (const item of items) assert.ok(GEO_NEEDS_YOU_KINDS.includes(item.kind));
  assert.deepEqual(items[1].object.ids, ["a1"]);
  assert.equal(items[1].count, 1);
  assert.deepEqual(items.filter((item) => item.kind === "correct_severe_error").map((item) => item.object.id), ["e2", "e3"],
    "the two most severe claims, one row per claim: the S4 first, e1 says the same claim as e2");
  assert.equal(items.find((/** @type {any} */ item) => item.kind === "correct_severe_error").severity, "S4");
  assert.equal(items.filter((item) => item.kind === "client_action").length, 1, "a skipped client action is gone");
  assert.equal(items.find((item) => item.kind === "credits_waiting").object.id, "diagnosis");
  // a market not connected never asks for a budget; a reader who cannot review is not asked to
  const quiet = /** @type {any[]} */ (geoNeedsYou({ ...input, marketConfigured: false, canReview: false }));
  assert.equal(quiet.some((item) => item.kind === "set_budget" || item.kind === "release_articles"), false);
  assert.deepEqual(geoNeedsYou({ project: { id: "p", budget: { totalCny: 1 }, steps: { evidence: { status: "done" } } }, marketConfigured: true }), []);
});

test("errors by claim: one row per claim, the engines that say it, the worst severity and the most open state", () => {
  const rows = [
    { id: "e1", fingerprint: "f1", engine: "doubao", severity: "S2", status: "closed", statement: "错一", claimId: "c1", snapshotId: "s1" },
    { id: "e2", fingerprint: "f1", engine: "kimi", severity: "S3", status: "acting", statement: "错一", claimId: "c1", snapshotId: "s2", firstSnapshotId: "s0" },
    { id: "e3", fingerprint: "f2", engine: "kimi", severity: "S1", status: "open", statement: "错二", citedSource: { attribute: "farm", domain: "x.cn" }, action: "report_and_cover" },
  ];
  const claims = /** @type {any[]} */ (geoErrorsByClaim(rows));
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[0], { fingerprint: "f1", claimId: "c1", statement: "错一", engines: ["doubao", "kimi"], count: 2, severity: "S3", status: "acting",
    errorIds: ["e1", "e2"], snapshotId: "s0", citedSources: [], actions: [], urgent: true });
  assert.deepEqual(claims[1].citedSources, [{ attribute: "farm", domain: "x.cn" }]);
  assert.deepEqual(geoErrorsByClaim([]), []);
});

test("a strategy file is held against its own actions as notices: a gap nobody answers, a number without its basis", () => {
  const notices = geoActionNotices({
    gaps: [
      { gapId: "GAP-01", groupId: "g1", class: "benefit_only", pool: "P4" },
      { gapId: "GAP-02", groupId: "g2", class: "missing_evidence", pool: "P2" },
      { gapId: "GAP-03", groupId: "g3", class: "wrong", handoff: "monitor_only" },
    ],
    actions: [
      { gapId: "GAP-01", metricId: "M-06", target: 90, promise: "guaranteed", engines: ["nope"] },
    ],
  });
  assert.deepEqual(notices.map((notice) => notice.code).sort(), ["engine_not_in_project", "gap_without_action", "metric_not_in_pool", "promise_unknown", "target_without_basis"]);
  assert.equal(notices.find((notice) => notice.code === "gap_without_action")?.gapId, "GAP-02");
  assert.deepEqual(geoActionNotices({ gaps: [{ gapId: "G", groupId: "g", class: "wrong" }], actions: [{ gapId: "G", reason: "已由纠错稿处理" }] }), []);
  assert.deepEqual(geoActionNotices({}), []);
});

test("the rail's count is one short count per step, and nothing where there is nothing", () => {
  assert.deepEqual(geoStepSummary("evidence", { claims: 86 }), { text: "86 条结论", count: 86, unit: "claims" });
  assert.deepEqual(geoStepSummary("questions", { groups: 25 }), { text: "25 个群", count: 25, unit: "groups" });
  assert.equal(geoStepSummary("content", { articles: 0 }), null);
  assert.equal(geoStepSummary("nope", { articles: 3 }), null);
});

test("a person's two words reach the choosers as the derived actions' verdicts: groups set aside, articles not placed, a source preferred", () => {
  const twoGaps = [
    { gapId: "A", groupId: "g-p2", group: "停药与反弹", pool: "P2", class: "benefit_only", rank: 1, handoff: "content", judgment: "只讲获益" },
    { gapId: "B", groupId: "g-p2", group: "停药与反弹", pool: "P2", class: "dropped_condition", rank: 2, handoff: "content", judgment: "丢了限定条件" },
    { gapId: "W", groupId: "g-p1", group: "品牌身份", pool: "P1", class: "wrong", rank: 3, handoff: "EC", judgment: "讲错", evidence: { errors: ["e-1"] } },
  ];
  const articles = [
    { id: "a-p2", groupId: "g-p2", layer: "coverage", status: "publishable", title: "停药", createdAt: ago(5) },
    { id: "a-fix", groupId: "g-p1", layer: "correction", status: "publishable", title: "更正", createdAt: ago(4) },
  ];
  const errors = [{ id: "e-1", fingerprint: "f1", engine: "doubao", groupId: "g-p1", severity: "S3", status: "open", statement: "错", materials: [{ articleId: "a-fix" }], createdAt: ago(9) }];
  const derive = (/** @type {Array<Record<string, any>>} */ choices) => deriveGeoActions({ ...base(), strategy: { ...base().strategy, gaps: twoGaps }, articles, errors, choices });
  const skip = (/** @type {string[]} */ ...keys) => keys.map((key) => ({ key, skipped: true }));

  const none = geoChoiceEffects(derive([]).actions);
  assert.deepEqual([...none.skippedGroupIds, ...none.skippedArticleIds, ...none.skippedErrorIds, ...none.preferredByArticle.keys()], [], "nothing chosen, nothing changes");

  // one gap of two skipped: the group's other action is open, so the group and its article stay
  const one = geoChoiceEffects(derive(skip("fill_gap:g-p2:benefit_only")).actions);
  assert.equal(one.skippedGroupIds.has("g-p2"), false);
  assert.equal(one.skippedArticleIds.has("a-p2"), false);

  // both skipped: the group is set aside and so is the article they both list
  const both = geoChoiceEffects(derive(skip("fill_gap:g-p2:benefit_only", "fill_gap:g-p2:dropped_condition")).actions, { groups: [{ id: "g-p2", aliasIds: ["g-p2-v1"] }] });
  assert.equal(both.skippedGroupIds.has("g-p2"), true);
  assert.equal(both.skippedGroupIds.has("g-p2-v1"), true, "the id the group had in an earlier set is set aside with it");
  assert.equal(both.skippedArticleIds.has("a-p2"), true);
  assert.equal(both.skippedErrorIds.size, 0);

  // a skipped correction names its errors and its articles, and never sets the group aside
  const fix = derive(skip("correct_error:g-p1:wrong"));
  const fixed = geoChoiceEffects(fix.actions);
  assert.deepEqual([...fixed.skippedErrorIds], ["e-1"]);
  assert.equal(fixed.skippedArticleIds.has("a-fix"), true);
  assert.equal(fixed.skippedGroupIds.has("g-p1"), false);

  // a swapped source is a preference for the articles of the open action, and a skipped action prefers nothing
  const swapped = geoChoiceEffects(derive([{ key: "fill_gap:g-p2:benefit_only", sourceDomain: "WWW.Dxy.cn" }]).actions);
  assert.deepEqual(swapped.preferredByArticle.get("a-p2"), ["dxy.cn"]);
  const swappedAndSkipped = geoChoiceEffects(derive([{ key: "fill_gap:g-p2:benefit_only", sourceDomain: "dxy.cn", skipped: true }]).actions);
  assert.equal(swappedAndSkipped.preferredByArticle.has("a-p2"), false);

  // the verdict is the action's own: a skipped action's status is "skipped", and the effects hold nothing but what the page shows
  assert.equal(derive(skip("fill_gap:g-p2:benefit_only")).actions.find((action) => action.key === "fill_gap:g-p2:benefit_only")?.status, "skipped");
  assert.deepEqual(geoChoiceEffects(null).skippedGroupIds.size, 0);
  assert.deepEqual(geoChoiceEffects(/** @type {any} */ ([{ nonsense: true }, null])).preferredByArticle.size, 0);
});
