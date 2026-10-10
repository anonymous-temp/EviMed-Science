// The independent review of the measurement package (2026-09-25, before the
// first production baseline): the pure parts of its fixes. The queue-level
// fixes are in geoMeasure.integration.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { geoConstant } from "@evimed/domain";
import { GEO_JUDGE_INSTRUCTIONS, GeoJudge, judgeFailureIsTheAnswers } from "../src/geoJudge.mjs";
import { armsOf, balanceRows, commonArms, computeRoundCells, netEffectRows, sameEngines } from "../src/geoMetricsJob.mjs";
import { GEO_PROBE_BREAK_AFTER, GeoProbeBreaker, engineAnswers } from "../src/geoProbeQueue.mjs";

test("the circuit breaker's threshold is the owner's five, read from the domain's table", () => {
  assert.equal(geoConstant("PROBE_CIRCUIT_BREAK_CONSECUTIVE"), 5);
  assert.equal(GEO_PROBE_BREAK_AFTER, 5);
  assert.equal(new GeoProbeBreaker().threshold, 5);
});

test("a paused engine holds its round until a re-check since the pause fails, or thirty minutes pass", () => {
  const breaker = new GeoProbeBreaker({ threshold: 2, recheckMs: 600_000, skipAfterMs: 1_800_000 });
  breaker.record("doubao", "suspect", 0);
  assert.equal(breaker.record("doubao", "suspect", 1_000), true);
  assert.deepEqual(breaker.skippable(1_000), [], "just paused: its jobs wait");
  assert.deepEqual(breaker.skippable(600_000), [], "not re-checked yet");
  breaker.checked("doubao", 601_000, false);
  assert.deepEqual(breaker.skippable(601_000), ["doubao"], "re-checked and still down");
  // Paused again after a resume: the old failed check does not count.
  breaker.checked("doubao", 1_201_000, true);
  breaker.record("doubao", "suspect", 1_202_000);
  breaker.record("doubao", "suspect", 1_203_000);
  assert.deepEqual(breaker.skippable(1_204_000), []);
  assert.deepEqual(breaker.skippable(1_203_000 + 1_800_000), ["doubao"], "a pause of thirty minutes is long enough");
});

test("a provider refusing this request as too long or malformed is the answer's own failure; outages, balance and rate limits stop the tick", () => {
  const upstream = (/** @type {number} */ status) => Object.assign(new Error("upstream"), { code: "model_gateway_upstream_error", upstreamStatus: status });
  for (const status of [400, 413, 422]) assert.equal(judgeFailureIsTheAnswers(upstream(status)), true, String(status));
  for (const status of [401, 402, 429, 500, 502, 503]) assert.equal(judgeFailureIsTheAnswers(upstream(status)), false, String(status));
  assert.equal(judgeFailureIsTheAnswers(Object.assign(new Error("x"), { code: "model_gateway_payment_required", upstreamStatus: 402 })), false);
  assert.equal(judgeFailureIsTheAnswers(new TypeError("fetch failed")), false, "a network failure is not the answer's");
  for (const code of ["geo_judge_invalid", "geo_judge_timeout", "geo_judge_truncated"]) {
    assert.equal(judgeFailureIsTheAnswers(Object.assign(new Error(code), { code })), true, code);
  }
});

test("the judge has room for thirty statements, asks for the most important first, and a cut-off answer is its own code", async () => {
  assert.match(GEO_JUDGE_INSTRUCTIONS, /最多 30 条，最重要的/);
  /** @type {any[]} */
  const calls = [];
  const judge = new GeoJudge({ deepseekProviderEnabled: true, deepseekApiKey: "test-only-key" }, {
    callModel: /** @type {any} */ (async (/** @type {any} */ _deps, /** @type {any} */ call) => {
      calls.push(call);
      return { choices: [{ finish_reason: "length", message: { content: "{\"statements\":[{\"text\":\"玛仕度肽" } }] };
    }),
  });
  await assert.rejects(judge.judge({
    owner: { userId: "u", projectId: "p" }, product: { brandName: "玛仕度肽" }, competitors: [],
    claims: [{ id: "c1", key: "dosing", statement: "每周一次", quote: "本品每周一次皮下注射给药。" }], careFlags: [],
    question: { text: "怎么用" }, answer: "玛仕度肽每周注射一次。",
  }), (error) => /** @type {any} */ (error).code === "geo_judge_truncated");
  assert.equal(calls[0].body.max_tokens, 8_000);
});

test("balanced rows keep only questions answered on every engine, one answer per job; the per-engine rows keep every answer", () => {
  const row = (/** @type {string} */ questionId, /** @type {string} */ engine, /** @type {string} */ status, /** @type {string} */ askedAt, facts = true) => ({
    questionId, engine, repeatIndex: 0, status, askedAt, facts: facts ? { brands: [] } : null,
  });
  const rows = [
    row("q1", "deepseek", "valid", "t1"), row("q1", "doubao", "valid", "t1"),
    row("q2", "deepseek", "valid", "t1"), row("q2", "doubao", "suspect", "t1"), row("q2", "doubao", "suspect", "t2"),
    row("q3", "deepseek", "refusal", "t1", false), row("q3", "doubao", "valid", "t1"),
    // the same job answered twice (a re-leased ask): one answer kept, the latest
    row("q3", "doubao", "valid", "t2"),
    // a valid answer the judge gave up on is not an answer here
    row("q4", "deepseek", "valid", "t1"), row("q4", "doubao", "valid", "t1", false),
  ];
  const balance = balanceRows(rows);
  assert.deepEqual(balance.engines, ["deepseek", "doubao"]);
  assert.deepEqual(balance.dropped, ["q2", "q4"]);
  assert.equal(balance.kept, 2);
  assert.equal(balance.questions, 4);
  assert.equal(balance.rows.filter((entry) => entry.questionId === "q3" && entry.engine === "doubao").length, 1);
  assert.equal(balance.rows.find((entry) => entry.questionId === "q3" && entry.engine === "doubao")?.askedAt, "t2");
  assert.equal(balance.deduped.length, rows.length - 1, "per engine every answer counts, only the duplicate goes");
});

test("a paused engine resumes only when a test ask comes back, not because its tab exists", async () => {
  const stuck = { ask: async () => ({ results: [{ status: "failed", answer: "", error: "发问后 45000ms 内未出现用户气泡" }] }) };
  const answering = { ask: async (/** @type {any} */ request) => ({ results: [{ status: "ok", answer: `你好！有什么可以帮你？（${request.providers[0]}）` }] }) };
  const busy = { ask: async () => { throw Object.assign(new Error("busy"), { code: "geo_probe_busy" }); } };
  assert.equal(await engineAnswers(stuck, "doubao", 1_000), false, "a stuck tab stays paused");
  assert.equal(await engineAnswers(busy, "doubao", 1_000), false, "a busy host is checked again later");
  assert.equal(await engineAnswers(answering, "doubao", 1_000), true);
});

test("a week is compared with the baseline only on the engines both were measured on; otherwise the net effect says 引擎不同，不可比", async () => {
  // Production, 2026-09-28: the 信尔美 baseline (09-25) was measured on
  // DeepSeek, Kimi, 千问 and 元宝; the probe host has since lost DeepSeek and
  // 元宝. The first weekly re-measure on two engines, compared with the four-engine
  // baseline, would read as a drop in both arms and a net effect built on it.
  const FOUR = ["deepseek", "kimi", "qianwen", "yuanbao"];
  const TWO = ["kimi", "qianwen"];
  const point = (/** @type {string} */ date, /** @type {number} */ value, /** @type {string[] | null} */ engines) => (
    { date, value, numerator: value, denominator: 100, engines });
  /** @param {{ pilot: any[], control: any[] }} series */
  const storeWith = (series) => /** @type {any} */ ({
    baselineDate: async () => "2026-09-25",
    latestNoiseBand: async () => ({ value: 2, measured: true }),
    armSeries: async () => structuredClone(series),
  });
  const input = (/** @type {string[]} */ engines) => ({ project: { id: "geo_x" }, round: { setVersion: 5, sampleDate: "2026-10-05" }, controlGroups: 5, engines });

  const differ = await netEffectRows(storeWith({
    pilot: [point("2026-09-25", 50, FOUR), point("2026-10-05", 30, TWO)],
    control: [point("2026-09-25", 10, FOUR), point("2026-10-05", 4, TWO)],
  }), input(TWO));
  assert.ok(differ.length >= 9, "every pool metric and the index");
  assert.ok(differ.every((row) => row.status === "not_measurable" && row.reason === "engines_differ" && row.value === null), JSON.stringify(differ));

  // The same engines on both sides: a number, from those rounds only.
  const same = await netEffectRows(storeWith({
    pilot: [point("2026-09-25", 50, FOUR), point("2026-10-05", 60, [...FOUR].reverse())],
    control: [point("2026-09-25", 10, FOUR), point("2026-10-05", 12, FOUR)],
  }), input(FOUR));
  assert.ok(same.every((row) => row.status === "ok"), JSON.stringify(same));
  // The domain's rolling windows: the current window averages 50 and 60 (+5), the control's 10 and 12 (+1).
  assert.ok(same.every((row) => row.numerator === 5 && row.denominator === 1 && row.value === 4), JSON.stringify(same));

  // Missing observed versions block an otherwise computable effect, preserving structural failure reasons.
  const unknown = { ...input(FOUR), round: { ...input(FOUR).round, surface: { intervention: { engines: [{ observedVersion: "unknown" }] } } } };
  const series = { pilot: [point("2026-09-25", 50, FOUR), point("2026-10-05", 60, FOUR)], control: [point("2026-09-25", 10, FOUR), point("2026-10-05", 12, FOUR)] };
  assert.ok((await netEffectRows(storeWith(series), unknown)).every(row => row.reason === "engine_version_unknown"));
  assert.ok((await netEffectRows(storeWith(series), { ...unknown, controlGroups: 0 })).every(row => row.reason === "too_few_control_groups"));
  assert.ok((await netEffectRows(storeWith(series), { ...unknown, round: { ...unknown.round, sampleDate: "2026-09-25" } })).every(row => row.reason === "no_follow_up"));

  // A round with no recorded engine set is not known to match.
  const legacy = await netEffectRows(storeWith({
    pilot: [point("2026-09-25", 50, null), point("2026-10-05", 60, FOUR)],
    control: [point("2026-09-25", 10, null), point("2026-10-05", 12, FOUR)],
  }), input(FOUR));
  assert.ok(legacy.every((row) => row.reason === "engines_differ"));

  assert.equal(sameEngines(["qianwen", "kimi"], ["kimi", "qianwen"]), true);
  assert.equal(sameEngines(["qianwen"], ["kimi", "qianwen"]), false);
  assert.equal(sameEngines(null, ["kimi"]), false);
});

test("a net effect is not stored from windows under the answer floor, and a computed one keeps the band it was judged against (Q-2)", async () => {
  // Pilot 2/8 -> 5/8 against control 2/8 -> 2/8 was stored `ok`, "up", from windows of eight answers: far under the 30 a cell needs.
  const ENGINES = ["kimi", "qianwen"];
  const point = (/** @type {string} */ date, /** @type {number} */ k, /** @type {number} */ n) => ({ date, value: (100 * k) / n, numerator: k, denominator: n, engines: ENGINES });
  const storeWith = (/** @type {{ pilot: any[], control: any[] }} */ series) => /** @type {any} */ ({
    baselineDate: async () => "2026-09-25",
    // A noise round exists only for the metrics the table names; the store answers for those and for nothing else.
    latestNoiseBand: async () => ({ value: 2, measured: true }),
    armSeries: async () => structuredClone(series),
  });
  const input = { project: { id: "geo_x" }, round: { setVersion: 5, sampleDate: "2026-10-05" }, controlGroups: 4, engines: ENGINES };

  const small = await netEffectRows(storeWith({
    pilot: [point("2026-09-25", 2, 8), point("2026-10-05", 5, 8)], control: [point("2026-09-25", 2, 8), point("2026-10-05", 2, 8)],
  }), input);
  assert.ok(small.length >= 9, "every pool metric and the index");
  assert.ok(small.every((row) => row.status === "not_measurable" && row.reason === "insufficient_sample" && row.value === null && row.noiseBand === undefined),
    JSON.stringify(small[0]));

  // With the answers behind it, the same change is a result, and its row says which band judged it.
  const enough = await netEffectRows(storeWith({
    pilot: [point("2026-09-25", 40, 100), point("2026-10-05", 60, 100)], control: [point("2026-09-25", 40, 100), point("2026-10-05", 40, 100)],
  }), input);
  // (The domain's rolling windows overlap this early: the pilot's current window pools 40/100 and 60/100, so +10.)
  assert.ok(enough.every((row) => row.status === "ok" && row.value === 10 && row.reason === "up"), JSON.stringify(enough[0]));
  const byMetric = (/** @type {string} */ metric) => enough.filter((row) => row.variant === metric);
  assert.ok(byMetric("M-01").length > 0 && byMetric("M-01").every((row) => row.noiseBand === 2 && row.noiseMeasured === true), "mention has a noise round");
  const defaulted = enough.filter((row) => !["M-01", "M-03", "M-10"].includes(String(row.variant)));
  assert.ok(defaulted.length > 0 && defaulted.every((row) => row.noiseBand === geoConstant("RANKING_NOISE_DEFAULT_THRESHOLD") && row.noiseMeasured === false),
    "every other metric was judged against the default, and says so");

  // Too few control groups is still the structural reason, whatever the answers.
  assert.ok((await netEffectRows(storeWith({ pilot: [point("2026-09-25", 2, 8), point("2026-10-05", 5, 8)], control: [point("2026-09-25", 2, 8), point("2026-10-05", 2, 8)] }),
    { ...input, controlGroups: 0 })).every((row) => row.reason === "too_few_control_groups"));
});

test("a net effect counts the control groups every compared round had, not the ones the newest round has (Q-3)", async () => {
  assert.deepEqual(armsOf(new Map([["g2", true], ["g1", false], ["g3", true], ["g4", true]]), new Set(["g3"])), { pilot: ["g1"], control: ["g2", "g4"] },
    "a control group an article touched is not in the arm; the arms are sorted");
  const wide = { pilot: ["p1"], control: ["c1", "c2", "c3", "c4"] };
  const narrow = { pilot: ["p1"], control: ["c1", "c2", "c3"] };
  const wider = { pilot: ["p1", "p2"], control: ["c2", "c3", "c9"] };
  assert.deepEqual(commonArms([wide, narrow]), narrow);
  assert.deepEqual(commonArms([wide, narrow, wider]), { pilot: ["p1"], control: ["c2", "c3"] });
  assert.deepEqual(commonArms([]), { pilot: [], control: [] });

  const ENGINES = ["kimi", "qianwen"];
  const point = (/** @type {string} */ roundId, /** @type {string} */ date, /** @type {number} */ k) => ({ roundId, date, value: k, numerator: k, denominator: 100, engines: ENGINES });
  const series = { pilot: [point("r1", "2026-09-25", 20), point("r2", "2026-10-25", 40)], control: [point("r1", "2026-09-25", 20), point("r2", "2026-10-25", 20)] };
  const storeWith = (/** @type {Array<{ roundId: string, date: string, engines: string[], arms: any }>} */ rounds) => /** @type {any} */ ({
    baselineDate: async () => "2026-09-25",
    latestNoiseBand: async () => ({ value: 2, measured: true }),
    armSeries: async () => structuredClone(series),
    armRounds: async () => rounds,
    // No answers on file: nothing to compute again, the stored cells stand.
    roundSkippedEngines: async () => [], roundFactRows: async () => [], round: async () => ({ engines: ENGINES }), projectContext: async () => null,
  });
  const input = { project: { id: "geo_x" }, round: { id: "r2", setVersion: 5, sampleDate: "2026-10-25" }, controlGroups: 4, engines: ENGINES };
  const rounds = [{ roundId: "r1", date: "2026-09-25", engines: ENGINES, arms: wide }, { roundId: "r2", date: "2026-10-25", engines: ENGINES, arms: narrow }];

  // The caller counted four control groups; the two rounds share two, which is under the table's minimum.
  const two = { pilot: ["p1"], control: ["c1", "c2"] };
  const shared = await netEffectRows(storeWith([rounds[0], { ...rounds[1], arms: two }]), { ...input, arms: two });
  assert.ok(shared.every((row) => row.reason === "too_few_control_groups"), "two shared groups are under the table's minimum, whatever the caller counted");
  // Without arms the caller's count and the stored cells are all there is (a caller that does not know its arms).
  assert.ok((await netEffectRows(storeWith(rounds), input)).every((row) => row.status === "ok"));
  // A round measured before arms were recorded, with no answers on file, is left as stored and does not narrow what is shared.
  const legacy = await netEffectRows(storeWith([{ ...rounds[0], arms: null }, rounds[1]]), { ...input, arms: narrow });
  assert.ok(legacy.every((row) => row.status === "ok"), JSON.stringify(legacy[0]));
});

test("the valid share (M-20) counts every ask at every scope; a question dropped from the rates is not dropped from it (Q-11)", () => {
  // 70 questions on two engines, 140 asks: doubao gave nothing usable (a login page) for questions 41 to 70, so those thirty leave the
  // cross-engine rates (a question answered on one engine only would make every pool rate uneven), but they were asked.
  /** @type {any[]} */
  const rows = [];
  const base = { roundKind: "weekly", repeatIndex: 0, surface: { mode: "web" }, citations: [], pool: "P2", isControl: false };
  for (let q = 1; q <= 70; q += 1) {
    const group = q <= 40 ? "g1" : "g2";
    for (const engine of ["deepseek", "doubao"]) {
      const suspect = engine === "doubao" && q > 40;
      rows.push({ ...base, snapshotId: `s-${q}-${engine}`, questionId: `q${q}`, engine, groupId: group, status: suspect ? "suspect" : "valid", askedAt: `2026-10-01T00:${String(q % 60).padStart(2, "0")}:00Z`,
        facts: suspect ? null : { brands: [], firstOurs: false, positionOurs: null, recommendedOurs: false, retrievalTriggered: false, statements: [], redFlagExpected: [], redFlagHits: [], safetyTermsHit: [] } });
    }
  }
  const { cells, balance, denominators } = computeRoundCells(rows, { engines: ["deepseek", "doubao"], competitors: [], owned: {}, arms: { pilot: ["g1", "g2"], control: [] } });
  const share = (/** @type {Record<string, any>} */ where) => {
    const found = cells.filter((cell) => cell.metricId === "M-20" && cell.variant === null && Object.entries(where).every(([key, value]) => /** @type {any} */ (cell)[key] === value));
    assert.equal(found.length, 1, JSON.stringify(where));
    return [found[0].numerator, found[0].denominator, found[0].value, found[0].status];
  };
  assert.deepEqual([balance.questions, balance.kept, balance.dropped.length], [70, 40, 30]);
  assert.deepEqual(share({ scope: "engine", engine: "doubao" }), [40, 70, 57.14, "ok"], "the engine reads every ask");
  assert.deepEqual(share({ scope: "project" }), [110, 140, 78.57, "ok"], "and so does the project: 110 answers of 140 asks, not 80 of 80");
  assert.deepEqual(share({ scope: "pool", pool: "P2" }), [110, 140, 78.57, "ok"]);
  assert.deepEqual(share({ scope: "group", groupId: "g1" }), [80, 80, 100, "ok"]);
  assert.deepEqual(share({ scope: "group", groupId: "g2" }), [30, 60, 50, "ok"], "a group whose questions all left the rates still has its share");
  assert.deepEqual(share({ scope: "arm", arm: "pilot", pool: "P2" }), [110, 140, 78.57, "ok"]);
  // The rates are what they were: over the questions answered on every engine.
  const mention = cells.find((cell) => cell.metricId === "M-01" && cell.scope === "project" && cell.variant === null);
  assert.equal(mention?.denominator, 80);
  assert.equal(cells.some((cell) => cell.scope === "group" && cell.groupId === "g2" && cell.metricId === "M-01"), false, "no rate for a group nothing was answered on every engine in");
  assert.deepEqual([denominators.valid, denominators.suspect, denominators.unparsed], [110, 30, 0]);

  // Nothing dropped: the cells are those of one computation, and the denominators count what was left out unjudged.
  const whole = rows.filter((row) => row.questionId <= "q4" && !(row.status === "suspect"));
  const same = computeRoundCells(whole, { engines: ["deepseek", "doubao"], competitors: [], owned: {}, arms: { pilot: ["g1"], control: [] } });
  assert.equal(same.balance.dropped.length, 0);
  const unjudged = rows.slice(0, 4).map((row, index) => (index < 2 ? { ...row, facts: null } : row));
  assert.equal(computeRoundCells(unjudged, { engines: ["deepseek", "doubao"], competitors: [], owned: {}, arms: { pilot: [], control: [] } }).denominators.unparsed, 2,
    "a valid answer the judge gave up on is counted as left out, not as an answer that said nothing");
});
