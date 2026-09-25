// The independent review of the measurement package (2026-09-25, before the
// first production baseline): the pure parts of its fixes. The queue-level
// fixes are in geoMeasure.integration.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { geoConstant } from "@evimed/domain";
import { GEO_JUDGE_INSTRUCTIONS, GeoJudge, judgeFailureIsTheAnswers } from "../src/geoJudge.mjs";
import { balanceRows } from "../src/geoMetricsJob.mjs";
import { GEO_PROBE_BREAK_AFTER, GeoProbeBreaker } from "../src/geoProbeQueue.mjs";

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
