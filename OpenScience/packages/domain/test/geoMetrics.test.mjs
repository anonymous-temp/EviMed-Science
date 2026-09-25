import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GEO_METRICS,
  GEO_METRIC_IDS,
  GEO_METRIC_POOL_IDS,
  GEO_PROBE_SANITY,
  computeGeoMetrics,
  computeGvi,
  geoCellRows,
  geoConstant,
  geoMetricDefinition,
  hardLines,
  isOurCitation,
  netEffect,
  noiseBand,
  pythonRound,
  pythonSum,
  rollingTrend,
  standardName,
  wilsonInterval,
} from "../index.mjs";

/** @typedef {import("../src/geoMetrics.mjs").GeoMetricCell} GeoMetricCell */
/** @typedef {import("../src/geoMetrics.mjs").GeoFactRow} GeoFactRow */
/** @typedef {import("../src/geoMetrics.mjs").GeoGviResult} GeoGviResult */

/** @type {{ source: Record<string, string>, rows: GeoFactRow[], options: import("../src/geoMetrics.mjs").GeoMetricsOptions }} */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/geo/metrics-golden.fixture.json", import.meta.url), "utf8"));
/** @type {{ source: Record<string, string>, cells: Array<Record<string, any>>, denominators: Record<string, number>, gvi: { project: unknown, arms: Record<string, unknown> } }} */
const expected = JSON.parse(readFileSync(new URL("./fixtures/geo/metrics-golden.expected.json", import.meta.url), "utf8"));

const OWNED = { domains: ["example-pharma.com"] };
let counter = 0;

/**
 * A parsed, valid snapshot on its own question (so per-question denominators stay even).
 * @param {Record<string, any>} [overrides] @param {Record<string, any>} [facts] @returns {any}
 */
function row(overrides = {}, facts = {}) {
  counter += 1;
  return {
    snapshotId: `s${counter}`,
    questionId: `q${counter}`,
    engine: "deepseek",
    roundKind: "baseline",
    status: "valid",
    pool: "P2",
    groupId: "g1",
    isControl: false,
    citations: [],
    ...overrides,
    facts: overrides.facts === null ? null : {
      brands: [],
      firstOurs: false,
      positionOurs: null,
      recommendedOurs: false,
      retrievalTriggered: false,
      statements: [],
      redFlagExpected: [],
      redFlagHits: [],
      safetyTermsHit: [],
      ...facts,
    },
  };
}
const ours = { brands: [{ name: "示例牌", ours: true, count: 1, position: 1 }], firstOurs: true, positionOurs: 1 };
/** @param {number} n @param {(index: number) => any} make @returns {any[]} */
const many = (n, make) => Array.from({ length: n }, (_, index) => make(index));
/** @param {GeoMetricCell[]} cells @param {Record<string, any>} where @returns {GeoMetricCell} */
const cellOf = (cells, where) => {
  const found = cells.filter((cell) => Object.entries(where).every(([key, value]) => /** @type {Record<string, any>} */ (cell)[key] === value)
    && (where.variant === undefined ? cell.variant === null : true) && (where.rival === undefined ? cell.rival === null : true));
  assert.equal(found.length, 1, `exactly one cell for ${JSON.stringify(where)}, found ${found.length}`);
  return found[0];
};

// ------------------------------------------------------------------ the table

test("metrics.json is the owner's metrics.yaml: every metric, pool, weight and constant, with provenance", () => {
  assert.equal(GEO_METRICS.version, "3.0.0", "metrics.yaml's own version: the yaml did not change in 3.0.1");
  assert.equal(GEO_METRICS._provenance.version, "3.0.1", "converted from the 3.0.1 package");
  assert.equal(GEO_METRIC_IDS.length, 26, "20 metrics of 2.0 plus six added in 3.0.0");
  assert.equal(GEO_METRICS.diagnostics.length, 5);
  assert.deepEqual([...GEO_METRIC_POOL_IDS], ["P1", "P2", "P3", "P4"]);
  assert.equal(pythonSum(GEO_METRIC_POOL_IDS.map((pool) => GEO_METRICS.pools[pool].gvi_weight)), 1);
  assert.equal(GEO_METRICS.pools.P4.gvi_weight, 0, "the risk pool never enters the index");
  assert.equal(pythonSum(Object.values(GEO_METRICS.gvi.dimension_weights)), 1);
  for (const metric of GEO_METRICS.metrics) {
    for (const key of ["id", "name", "formula", "unit", "channel", "measurable_when", "direction", "pools", "client_facing", "gvi_group"]) {
      assert.ok(/** @type {Record<string, unknown>} */ (metric)[key] !== undefined, `${metric.id} keeps ${key}`);
    }
  }
  // every constant carries its provenance, and no provenance points at a constant that is not there
  assert.deepEqual(Object.keys(GEO_METRICS._provenance.constants).sort(), Object.keys(GEO_METRICS.constants).sort());
  assert.equal(geoConstant("SOV_COVERAGE_MIN"), 0.6);
  assert.equal(geoConstant("STD_CELL_MIN_SAMPLES"), 30);
  assert.equal(geoConstant("ACCURACY_HARD_LINE"), 0.98);
  assert.equal(geoConstant("IRON_04_GROUP_REFERENCE_CAP"), 96);
  assert.throws(() => geoConstant("NO_SUCH_CONSTANT"), /no constant NO_SUCH_CONSTANT/);
  // the yaml names constants by name; each one it names is in the table
  for (const name of [GEO_METRICS.gvi.cap, GEO_METRICS.net_effect.window_weeks, ...GEO_METRICS.net_effect.control_share]) {
    assert.ok(Object.hasOwn(GEO_METRICS.constants, name), `${name} is defined`);
  }
  assert.ok(Object.isFrozen(GEO_METRICS.metrics[0]), "the table cannot be edited by a consumer");
});

test("sanity.json carries the probe sanity markers the probe queue classifies by", () => {
  assert.ok(GEO_PROBE_SANITY.session_invalid_markers.includes("请先登录"));
  assert.ok(GEO_PROBE_SANITY.refusal_markers.length > 0);
  assert.ok(GEO_PROBE_SANITY.service_unavailable_markers.includes("算力不足"));
  assert.equal(GEO_PROBE_SANITY.min_answer_chars, 40);
  assert.equal(GEO_PROBE_SANITY.page_chrome_tail_ratio, 0.3);
  assert.ok(GEO_PROBE_SANITY.page_chrome_markers.includes("相关视频"));
  assert.ok(Array.isArray(GEO_PROBE_SANITY._provenance.classification_order));
});

// ------------------------------------------------------------------ arithmetic

test("rounding is CPython's round(x, 2) and sums are CPython 3.12's sum()", () => {
  assert.equal(pythonRound(0.125, 2), 0.12, "an exact tie goes to the even digit");
  assert.equal(pythonRound(0.375, 2), 0.38);
  assert.equal(pythonRound(2.675, 2), 2.67, "2.675 is 2.67499… in binary");
  assert.equal(pythonRound(1.005, 2), 1);
  assert.equal(pythonRound(-0.125, 2), -0.12);
  assert.equal(pythonRound(53.846153846153854, 2), 53.85);
  assert.equal(pythonRound(1e-10, 9), 0);
  assert.equal(pythonSum(Array(10).fill(0.1)), 1, "compensated: a naive loop gives 0.9999999999999999");
  assert.equal(pythonSum([]), 0);
});

test("Wilson 95% intervals on the percent scale", () => {
  assert.deepEqual(wilsonInterval(21, 39), [38.57, 68.43]);
  assert.deepEqual(wilsonInterval(15, 18), [60.78, 94.16]);
  const [low, high] = /** @type {[number, number]} */ (wilsonInterval(0, 31));
  assert.equal(Math.abs(low), 0, "CPython gives -0.0 here too; it serialises as 0");
  assert.equal(high, 11.03);
  assert.equal(wilsonInterval(0, 0), null);
  assert.equal(wilsonInterval(5, 4), null, "a count above its denominator has no binomial interval");
});

// ------------------------------------------------------------------ denominators

test("a rate over fewer than 30 answers is insufficient; 30 is enough", () => {
  const small = computeGeoMetrics(many(29, (i) => row({}, i % 2 ? ours : {})), { owned: OWNED });
  const m01 = cellOf(small.cells, { metricId: "M-01", scope: "pool", pool: "P2" });
  assert.equal(m01.status, "insufficient");
  assert.equal(m01.denominator, 29);
  assert.equal(m01.value, 48.28, "the value is kept for the record");
  const enough = computeGeoMetrics(many(30, (i) => row({}, i % 2 ? ours : {})), { owned: OWNED });
  const ok = cellOf(enough.cells, { metricId: "M-01", scope: "pool", pool: "P2" });
  assert.equal(ok.status, "ok");
  assert.deepEqual([ok.numerator, ok.denominator, ok.value], [15, 30, 50]);
  assert.deepEqual([ok.ciLow, ok.ciHigh], wilsonInterval(15, 30));
});

test("a suspect answer leaves the denominator; a refusal stays in it", () => {
  const rows = [
    row({}, ours),
    row({ status: "refusal", facts: null }),
    row({ status: "suspect", facts: null }),
    row({ status: "failed", facts: null }),
  ];
  const { cells, denominators } = computeGeoMetrics(rows, { owned: OWNED });
  const m01 = cellOf(cells, { metricId: "M-01", scope: "pool", pool: "P2" });
  assert.deepEqual([m01.numerator, m01.denominator, m01.value], [1, 2, 50], "2, not 3 and not 1");
  const m20 = cellOf(cells, { metricId: "M-20", scope: "pool", pool: "P2" });
  assert.deepEqual([m20.numerator, m20.denominator], [2, 3], "valid share = valid / (valid + suspect)");
  const refusal = cellOf(cells, { metricId: "M-20", scope: "pool", pool: "P2", variant: "refusal" });
  assert.deepEqual([refusal.numerator, refusal.denominator], [1, 2]);
  assert.deepEqual(denominators, {
    snapshots: 4, inDenominator: 2, valid: 1, refusal: 1, suspect: 1, failed: 1, noiseExcluded: 0, repeatExcluded: 0, unparsed: 0,
  });
});

test("noise and confirmation repeats never enter a denominator; an unparsed answer is counted apart", () => {
  const rows = [
    row({}, ours),
    row({}, {}),
    row({ roundKind: "noise", repeatIndex: 0 }, ours),
    row({ roundKind: "confirm" }, ours),
    row({ facts: null }),
  ];
  const { cells, denominators } = computeGeoMetrics(rows, { owned: OWNED });
  const m01 = cellOf(cells, { metricId: "M-01", scope: "pool", pool: "P2" });
  assert.deepEqual([m01.numerator, m01.denominator], [1, 2]);
  assert.equal(denominators.noiseExcluded, 1);
  assert.equal(denominators.repeatExcluded, 1);
  assert.equal(denominators.unparsed, 1);
});

test("questions answered a different number of times give no pool rate (the script's evenness rule)", () => {
  const rows = [
    row({ questionId: "qa" }, ours), row({ questionId: "qa", engine: "doubao" }, ours),
    row({ questionId: "qb" }, {}), row({ questionId: "qb", engine: "doubao", status: "suspect", facts: null }),
  ];
  const { cells } = computeGeoMetrics(rows, { owned: OWNED });
  const m01 = cellOf(cells, { metricId: "M-01", scope: "pool", pool: "P2" });
  assert.equal(m01.status, "not_measurable");
  assert.equal(m01.reason, "uneven_denominators");
  // each engine alone asks each question once, so its rate stands
  assert.equal(cellOf(cells, { metricId: "M-01", scope: "engine", engine: "deepseek" }).value, 50);
});

test("an engine of the project with no snapshot is absent, never zero", () => {
  const { cells } = computeGeoMetrics(many(3, () => row({}, ours)), { engines: ["deepseek", "kimi"], owned: OWNED });
  const kimi = cells.filter((cell) => cell.engine === "kimi");
  assert.ok(kimi.length > 0);
  for (const cell of kimi) {
    assert.equal(cell.status, "absent");
    assert.equal(cell.value, null);
    assert.equal(cell.numerator, null);
  }
  assert.equal(cellOf(cells, { metricId: "M-01", scope: "engine", engine: "deepseek" }).value, 100);
});

test("an unparsed status is refused by name", () => {
  assert.throws(() => computeGeoMetrics([row({ status: "ok" })]), /status "ok"/);
});

// ------------------------------------------------------------------ metric rules

test("M-04 share of voice is not measurable below the brand-registration coverage floor", () => {
  /** @param {number} unregistered */
  const brands = (unregistered) => ({
    brands: [
      { name: "示例牌", ours: true, count: 1, position: 1 },
      { name: "对照牌", competitor: true, count: 1, position: 2 },
      { name: "未登记片", count: unregistered },
    ],
    firstOurs: true,
    positionOurs: 1,
  });
  // coverage = 2 registered / (2 + 1) = 0.667 >= 0.6
  const high = computeGeoMetrics(many(4, () => row({}, brands(1))), { owned: OWNED });
  const m04 = cellOf(high.cells, { metricId: "M-04", scope: "pool", pool: "P2" });
  assert.deepEqual([m04.numerator, m04.denominator, m04.value], [4, 8, 50]);
  assert.equal(cellOf(high.cells, { metricId: "M-04C", scope: "pool", pool: "P2" }).value, 66.67);
  // coverage = 2 / (2 + 2) = 0.5 < 0.6
  const low = computeGeoMetrics(many(4, () => row({}, brands(2))), { owned: OWNED });
  const blocked = cellOf(low.cells, { metricId: "M-04", scope: "pool", pool: "P2" });
  assert.equal(blocked.status, "not_measurable");
  assert.equal(blocked.reason, "coverage_below_min");
  assert.equal(blocked.value, null);
  // P1 asks about our product by name: share is not defined there
  const p1 = computeGeoMetrics(many(4, () => row({ pool: "P1" }, brands(1))), { owned: OWNED });
  assert.equal(p1.cells.filter((cell) => cell.metricId === "M-04" && cell.scope === "pool" && cell.pool === "P1").length, 0);
});

test("M-08 is over retrieval-triggered answers only; an engine that never retrieves has no citation rate", () => {
  const cited = { retrievalTriggered: true };
  const rows = [
    row({ citations: [{ url: "https://www.example-pharma.com/a", domain: "www.example-pharma.com" }] }, cited),
    row({ citations: [{ url: "https://other.org/a", domain: "other.org" }] }, cited),
    row({}, {}),
    row({ engine: "qianwen" }, {}),
    row({ engine: "qianwen" }, {}),
  ];
  const { cells } = computeGeoMetrics(rows, { owned: OWNED });
  const pool = cellOf(cells, { metricId: "M-08", scope: "pool", pool: "P2" });
  assert.deepEqual([pool.numerator, pool.denominator, pool.value], [1, 2, 50], "denominator = retrieval-triggered answers");
  const qianwen = cellOf(cells, { metricId: "M-08", scope: "engine", engine: "qianwen" });
  assert.equal(qianwen.status, "not_measurable");
  assert.equal(qianwen.reason, "no_retrieval");
  assert.equal(cellOf(cells, { metricId: "M-10", scope: "engine", engine: "qianwen" }).value, 0, "retrieval rate itself is a real 0");
  // without a registered owned source, a zero hit would be a claim we cannot support
  const unregistered = computeGeoMetrics(rows, {});
  assert.equal(cellOf(unregistered.cells, { metricId: "M-08", scope: "pool", pool: "P2" }).reason, "owned_not_registered");
  assert.equal(cellOf(unregistered.cells, { metricId: "M-09S", scope: "project" }).reason, "owned_not_registered");
});

test("M-06 counts only adjudicated answers; M-07 counts distinct wrong statements", () => {
  const wrong = { text: "示例牌每次服用五粒", verdict: "wrong" };
  const right = { text: "示例牌每日一次", verdict: "correct" };
  const rows = [
    row({}, { ...ours, statements: [wrong] }),
    row({}, { ...ours, statements: [wrong, right] }),
    row({}, { ...ours, statements: [right] }),
    row({}, { ...ours, statements: [{ text: "示例牌疗程两周", verdict: "unverifiable" }] }),
    row({}, ours),
  ];
  const { cells } = computeGeoMetrics(rows, { owned: OWNED });
  const m06 = cellOf(cells, { metricId: "M-06", scope: "pool", pool: "P2" });
  assert.deepEqual([m06.numerator, m06.denominator], [1, 3], "an answer with any wrong statement is wrong");
  const m07 = cellOf(cells, { metricId: "M-07", scope: "pool", pool: "P2" });
  assert.deepEqual([m07.numerator, m07.value], [1, 1], "the same wrong sentence twice is one error");
  const none = computeGeoMetrics([row({}, ours)], { owned: OWNED });
  assert.equal(cellOf(none.cells, { metricId: "M-06", scope: "pool", pool: "P2" }).reason, "not_adjudicated");
  assert.equal(cellOf(none.cells, { metricId: "M-07", scope: "pool", pool: "P2" }).reason, "not_adjudicated", "not checked is not error-free");
});

test("M-12 without the safety-term extraction is not measurable, never 0%", () => {
  const rows = many(3, () => row({}, ours));
  for (const item of rows) delete item.facts.safetyTermsHit;
  const { cells } = computeGeoMetrics(rows, { owned: OWNED });
  assert.equal(cellOf(cells, { metricId: "M-12", scope: "pool", pool: "P2" }).reason, "not_extracted");
});

test("an inclusion-channel engine reports mentions only", () => {
  const rows = [
    row({ engine: "baidu", surface: { mode: "inclusion" } }, ours),
    row({ engine: "baidu", surface: { mode: "inclusion" } }, {}),
    row({}, ours),
  ];
  const { cells } = computeGeoMetrics(rows, { owned: OWNED });
  assert.equal(cellOf(cells, { metricId: "M-01", scope: "engine", engine: "baidu" }).value, 50);
  const retrieval = cellOf(cells, { metricId: "M-10", scope: "engine", engine: "baidu" });
  assert.equal(retrieval.status, "not_measurable");
  assert.equal(retrieval.reason, "inclusion_channel");
  // and it does not dilute the pool's rates
  assert.equal(cellOf(cells, { metricId: "M-01", scope: "pool", pool: "P2" }).denominator, 1);
});

test("isOurCitation matches an owned domain label by label and accepts our published article URLs", () => {
  assert.equal(isOurCitation({ domain: "www.example-pharma.com" }, OWNED), true);
  assert.equal(isOurCitation({ domain: "example-pharma.com" }, OWNED), true);
  assert.equal(isOurCitation({ url: "https://EXAMPLE-pharma.com/x" }, OWNED), true);
  assert.equal(isOurCitation({ domain: "notexample-pharma.com" }, OWNED), false, "a bare suffix is not our domain (geo-skills 3.0.1)");
  assert.equal(isOurCitation({ domain: "other.org" }, OWNED), false);
  const owned = { urls: ["https://news.example.org/a/123?utm_source=x"] };
  assert.equal(isOurCitation({ url: "http://www.news.example.org/a/123/", domain: "news.example.org" }, owned), true);
  assert.equal(isOurCitation({ url: "https://news.example.org/a/456", domain: "news.example.org" }, owned), false);
});

// ------------------------------------------------------------------ the index

test("the index redistributes a missing dimension's weight and declares it", () => {
  /** @param {string} metricId @param {number|null} value @returns {GeoMetricCell} */
  const cell = (metricId, value) => ({
    metricId, scope: "pool", pool: "P2", engine: null, groupId: null, arm: null, rival: null, variant: null,
    numerator: null, denominator: null, value, ciLow: null, ciHigh: null, status: value === null ? "not_measurable" : "ok",
    reason: null, dataType: "measured", snapshotCount: 40,
  });
  const cells = [cell("M-01", 60), cell("M-06", 80), cell("M-08", null), cell("M-10", 40), cell("M-12", 50), { ...cell("M-20", 97), numerator: 40 }];
  const gvi = computeGvi(cells);
  const p2 = gvi.pools.P2;
  assert.deepEqual(p2.redistributed, ["share"], "share has no measurable metric");
  assert.deepEqual(p2.dimensions.citation.used, ["M-10"], "a not-measurable M-08 is skipped, not zeroed");
  // mention .30, accuracy .20, citation .15, safety .20 over a total of .85
  assert.equal(p2.value, pythonRound(60 * (0.3 / 0.85) + 80 * (0.2 / 0.85) + 40 * (0.15 / 0.85) + 50 * (0.2 / 0.85), 2));
  assert.equal(pythonSum(Object.values(p2.effectiveWeights)), 1);
  assert.deepEqual(gvi.poolsUsed, ["P2"]);
  assert.deepEqual(gvi.poolsMissing, ["P1", "P3"], "P1 and P3 absent: their weight goes to P2 and the result says so");
  assert.equal(gvi.value, p2.value);
  assert.deepEqual(gvi.declaration, { dimensions: { P2: ["share"] }, poolsMissing: ["P1", "P3"] });
});

test("the index is capped at IRON_04_GROUP_REFERENCE_CAP and the position metric is inverted", () => {
  /** @type {any[]} */
  const full = ["M-01", "M-02", "M-03", "M-04", "M-06", "M-08", "M-10", "M-11", "M-12"].map((metricId) => ({
    metricId, scope: "pool", pool: "P2", engine: null, groupId: null, arm: null, rival: null, variant: null,
    numerator: null, denominator: null, value: 100, ciLow: null, ciHigh: null, status: "ok", reason: null, dataType: "measured", snapshotCount: 40,
  }));
  full.push({ ...full[0], metricId: "M-05", value: 1 });
  const gvi = computeGvi(full);
  assert.equal(gvi.pools.P2.rawValue, 100);
  assert.equal(gvi.pools.P2.value, geoConstant("IRON_04_GROUP_REFERENCE_CAP"));
  assert.equal(gvi.pools.P2.cappedBy, "IRON-04");
  full[full.length - 1] = { ...full[0], metricId: "M-05", value: 2 };
  assert.equal(computeGvi(full).pools.P2.dimensions.mention.value, pythonRound((100 + 100 + 100 + 50) / 4, 2), "second place scores 50");
});

test("an index built on fewer than 30 answers is shown as insufficient", () => {
  const { cells } = computeGeoMetrics(many(10, () => row({}, ours)), { owned: OWNED });
  const index = cellOf(cells, { metricId: "M-19", scope: "project" });
  assert.equal(index.status, "insufficient");
  assert.equal(index.dataType, "derived");
  assert.ok(index.value !== null);
});

// ------------------------------------------------------------------ noise, trend, net effect

test("the noise band is 2 x the spread of the metric across noise repeats", () => {
  /** @type {any[]} */
  const noise = [];
  const mentionsPerRepeat = [5, 3, 4]; // out of 10 answers each
  mentionsPerRepeat.forEach((k, repeatIndex) => {
    for (let i = 0; i < 10; i += 1) noise.push(row({ roundKind: "noise", repeatIndex, questionId: `n${i}` }, i < k ? ours : {}));
  });
  const band = noiseBand(noise);
  assert.equal(band.measured, true);
  assert.deepEqual(band.repeats.map((repeat) => repeat.value), [50, 30, 40]);
  assert.equal(band.value, pythonRound(2 * 10, 2), "sample SD of 50/30/40 is 10 points");
  assert.equal(noiseBand(noise.slice(0, 10)).measured, false, "one repeat measures nothing");
  assert.throws(() => noiseBand(noise, { metricId: "M-06" }), /noise band is defined for/);
});

test("the rolling trend pools k/n inside the window and averages an index", () => {
  const points = [
    { date: "2026-09-01", numerator: 10, denominator: 100 },
    { date: "2026-09-08", numerator: 30, denominator: 100 },
    { date: "2026-09-15", numerator: 20, denominator: 50 },
    { date: "2026-10-06", numerator: 5, denominator: 50 },
  ];
  const trend = rollingTrend(points);
  assert.deepEqual(trend.map((point) => point.value), [10, 20, 24, pythonRound(100 * 25 / 100, 2)]);
  assert.deepEqual(trend.map((point) => point.points), [1, 2, 3, 2], "a four-week window: 10-06 reaches back to 09-15 but not 09-08");
  const index = rollingTrend([{ date: "2026-09-01", value: 40 }, { date: "2026-09-08", value: 50 }], 4);
  assert.deepEqual(index.map((point) => point.value), [40, 45]);
  assert.equal(index[1].numerator, null);
});

test("net effect is pilot change minus control change, flat inside the noise band", () => {
  /** @param {number} base @param {number} now */
  const series = (base, now) => [{ date: "2026-08-03", value: base }, { date: "2026-09-28", value: now }];
  const up = netEffect(series(20, 35), series(20, 24), { noise: { value: 5, measured: true } });
  assert.equal(up.status, "computed");
  assert.equal(up.value, 11);
  assert.deepEqual([up.pilotChange, up.controlChange], [15, 4]);
  assert.equal(up.verdict, "up");
  assert.equal(up.noiseMeasured, true);
  const flat = netEffect(series(20, 26), series(20, 21), { noise: { value: 5, measured: true } });
  assert.equal(flat.verdict, "flat", "a 5-point net effect does not clear a 5-point band");
  const down = netEffect(series(20, 20), series(20, 30), { noise: { value: 5, measured: true } });
  assert.equal(down.verdict, "down");
  const unmeasured = netEffect(series(20, 26), series(20, 20));
  assert.equal(unmeasured.noiseThreshold, geoConstant("RANKING_NOISE_DEFAULT_THRESHOLD"));
  assert.equal(unmeasured.noiseMeasured, false, "the default threshold is flagged, not passed off as measured");
  assert.equal(unmeasured.verdict, "up");
  const fewControls = netEffect(series(20, 35), series(20, 24), { controlGroupCount: 2 });
  assert.equal(fewControls.status, "not_computable");
  assert.deepEqual(fewControls.missing, [{ input: "control", reason: "too_few_control_groups" }]);
  const noControl = netEffect(series(20, 35), []);
  assert.equal(noControl.status, "not_computable");
});

test("M-15 is P4's own recommended rate, so P4's net effect computes", () => {
  /** @param {string} date @param {number} pilotRecommended @param {number} controlRecommended */
  const round = (date, pilotRecommended, controlRecommended) => [
    ...many(10, (i) => row({ pool: "P4", groupId: "g41", isControl: false, askedAt: date }, { ...ours, recommendedOurs: i < pilotRecommended })),
    ...many(10, (i) => row({ pool: "P4", groupId: "g42", isControl: true, askedAt: date }, { ...ours, recommendedOurs: i < controlRecommended })),
  ];
  const baseline = computeGeoMetrics(round("2026-08-03", 6, 6), { owned: OWNED });
  const pool = cellOf(baseline.cells, { metricId: "M-15", scope: "pool", pool: "P4" });
  assert.deepEqual([pool.numerator, pool.denominator, pool.value, pool.status], [12, 20, 60, "insufficient"]);
  assert.deepEqual([pool.ciLow, pool.ciHigh], wilsonInterval(12, 20));
  assert.equal(cellOf(baseline.cells, { metricId: "M-15", scope: "project" }).value, 60);
  assert.equal(baseline.cells.some((cell) => cell.metricId === "M-03" && cell.pool === "P4"), false, "M-03 itself stays undefined for P4");

  const later = computeGeoMetrics(round("2026-09-28", 2, 6), { owned: OWNED });
  /** @param {"pilot"|"control"} arm */
  const series = (arm) => [baseline, later].map((result, index) => {
    const cell = cellOf(result.cells, { metricId: "M-15", scope: "arm", pool: "P4", arm });
    return { date: index ? "2026-09-28" : "2026-08-03", numerator: cell.numerator, denominator: cell.denominator };
  });
  const effect = netEffect(series("pilot"), series("control"), { noise: { value: 5, measured: true }, controlGroupCount: 3 });
  assert.equal(effect.status, "computed");
  assert.deepEqual([effect.pilotChange, effect.controlChange, effect.value], [-40, 0, -40]);
  assert.equal(effect.verdict, "down", "recommended less often on risk questions: the direction P4 wants");
  assert.equal(geoMetricDefinition("M-15")?.direction, "down");
});

// ------------------------------------------------------------------ hard lines, names

test("hard lines: accuracy at the line and no open retrieval-layer 讲错我方; parametric errors never block", () => {
  /** @param {number} value @returns {any[]} */
  const accuracy = (value) => [{ metricId: "M-06", scope: "project", variant: null, value, status: "ok", numerator: 49, denominator: 50 }];
  const retrieval = { id: "e1", status: "open", severity: "S3", citedSource: { url: "https://farm.example/x", domain: "farm.example", attribute: "farm" } };
  const parametric = { id: "e2", status: "acting", severity: "S2", citedSource: null };
  const closed = { id: "e3", status: "closed", severity: "S4", citedSource: { domain: "x.org", attribute: "farm" } };

  const met = hardLines(accuracy(98), [parametric, closed]);
  assert.equal(met.accuracy.share, 0.98);
  assert.equal(met.accuracy.met, true, "98 % meets a 0.98 line");
  assert.equal(met.retrievalErrors.open, 0);
  assert.equal(met.parametricErrors.open, 1);
  assert.equal(met.parametricErrors.blocking, false);
  assert.equal(met.met, true, "a parametric error is listed, not blocking");

  const missed = hardLines(accuracy(97.99), []);
  assert.equal(missed.met, false);
  const blocked = hardLines(accuracy(100), [retrieval, parametric]);
  assert.equal(blocked.met, false);
  assert.deepEqual(blocked.retrievalErrors, { open: 1, ids: ["e1"], bySeverity: { S3: 1 }, met: false });
  const unknown = hardLines(/** @type {any[]} */ ([{ metricId: "M-06", scope: "project", variant: null, value: null, status: "not_measurable" }]), []);
  assert.equal(unknown.met, null, "not measured is not met and not failed");
});

test("standard names follow X-STDVIS: only metrics with the standard's formula carry one", () => {
  assert.equal(standardName("M-01S"), "可见率");
  assert.equal(standardName("M-01S", "top1"), "首推率");
  assert.equal(standardName("M-01S", "top3"), "前三推荐率");
  assert.equal(standardName("M-04"), "可见份额");
  assert.equal(standardName("M-05"), "平均位序");
  assert.equal(standardName("M-06"), "指定信息正确率");
  assert.equal(standardName("M-08S"), "信源问题引用率");
  assert.equal(standardName("M-09S"), "信源数量引用率");
  assert.equal(standardName("M-01"), null, "M-01 is not renamed to the standard's 提及率");
  assert.equal(standardName("M-99"), null);
});

// ------------------------------------------------------------------ golden

test("golden: every cell equals the owner's compute_metrics.py on the fixture batch", () => {
  assert.equal(fixture.source.sha256, expected.source.sha256, "fixture and expected come from one script");
  assert.match(expected.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(expected.source.version, GEO_METRICS._provenance.version);
  assert.equal(expected.source.metricsYamlSha256, GEO_METRICS._provenance.sha256["shared/rules/metrics.yaml"], "the table and the golden were made from the same yaml");
  assert.equal(expected.source.sha256, GEO_METRICS._provenance.sha256["shared/scripts/compute_metrics.py"]);

  const result = computeGeoMetrics(fixture.rows, fixture.options);
  /** @param {Record<string, any>} cell */
  const key = (cell) => [cell.metricId, cell.scope, cell.pool, cell.engine, cell.groupId, cell.arm, cell.rival, cell.variant].join("|");
  const got = new Map(result.cells.map((cell) => [key(cell), cell]));
  const want = new Map(expected.cells.map((cell) => [key(cell), cell]));
  assert.equal(got.size, result.cells.length, "no duplicate cells");
  assert.ok(want.size > 500, `the golden walked a real batch (${want.size} cells)`);
  assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort(), "the same cells, no more and no fewer");
  for (const [cellKey, wanted] of want) {
    const cell = /** @type {Record<string, any>} */ (got.get(cellKey));
    for (const field of ["numerator", "denominator", "value", "ciLow", "ciHigh"]) {
      if (typeof wanted[field] === "number") {
        assert.ok(typeof cell[field] === "number" && Math.abs(cell[field] - wanted[field]) <= 1e-9, `${cellKey} ${field}: ${cell[field]} vs ${wanted[field]}`);
      } else {
        assert.equal(cell[field], wanted[field], `${cellKey} ${field}`);
      }
    }
    for (const field of ["status", "reason", "dataType", "snapshotCount"]) assert.equal(cell[field], wanted[field], `${cellKey} ${field}`);
  }
  // the batch exercises what the rules are about
  const statuses = new Set(expected.cells.map((cell) => cell.status));
  for (const status of ["ok", "insufficient", "not_measurable", "absent"]) assert.ok(statuses.has(status), `golden covers ${status}`);
  const reasons = new Set(expected.cells.map((cell) => cell.reason));
  for (const reason of ["uneven_denominators", "coverage_below_min", "no_retrieval", "engine_absent"]) {
    assert.ok(reasons.has(reason), `golden covers ${reason}`);
  }
  const risk = expected.cells.filter((cell) => cell.metricId === "M-15" && cell.status !== "absent");
  assert.ok(risk.length > 0 && risk.every((cell) => cell.value !== null), "M-15 is measured in every P4 scope (geo-skills 3.0.1)");

  assert.deepEqual(result.denominators, expected.denominators);
  /** @param {GeoGviResult} gvi */
  const gviView = (gvi) => ({
    value: gvi.value, status: gvi.status, poolsUsed: gvi.poolsUsed, poolsMissing: gvi.poolsMissing,
    pools: Object.fromEntries(Object.entries(gvi.pools).map(([pool, index]) => [pool, {
      value: index.value, rawValue: index.rawValue, status: index.status, cappedBy: index.cappedBy,
      redistributed: index.redistributed, dimensions: index.dimensions,
    }])),
  });
  assert.deepEqual(gviView(result.gvi.project), expected.gvi.project);
  for (const arm of /** @type {const} */ (["pilot", "control"])) {
    assert.deepEqual(gviView(/** @type {GeoGviResult} */ (result.gvi.arms[arm])), expected.gvi.arms[arm]);
  }
});

test("geoCellRows returns the snapshots behind a cell", () => {
  const { cells } = computeGeoMetrics(fixture.rows, fixture.options);
  for (const where of [
    { metricId: "M-01", scope: "pool", pool: "P2" },
    { metricId: "M-06", scope: "project" },
    { metricId: "M-08", scope: "engine", engine: "deepseek" },
    { metricId: "M-01", scope: "group", groupId: "g21" },
    { metricId: "M-19", scope: "arm", arm: "control", pool: null },
  ]) {
    const cell = cellOf(cells, where);
    assert.equal(geoCellRows(fixture.rows, cell).length, cell.snapshotCount, JSON.stringify(where));
  }
});
