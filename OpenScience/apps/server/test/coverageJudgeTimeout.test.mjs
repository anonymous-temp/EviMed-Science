// One setting, three numbers, and the configured one was the one that never
// applied. `config.mjs` raised the default to 420 s with a comment recording
// that at 120 s four deliveries in five aborted and reported "not judged";
// the judge clamped to 300 s and fell back to the 120 s the default had been
// raised away from. Nothing failed — the wait was simply shorter than the
// operator asked for, and the notice it produced blamed the model.
//
// This file exists because the contradiction lived in two files that agreed
// with themselves. It also could not be found by search until 2026-08-25:
// coverageJudge.mjs carried a raw NUL byte, so every binary-skipping grep
// treated 453 lines of it as unsearchable.
import assert from "node:assert/strict";
import test from "node:test";
import { CoverageJudge, COVERAGE_JUDGE_TIMEOUT_CEILING_MS, COVERAGE_JUDGE_TIMEOUT_DEFAULT_MS } from "../src/coverageJudge.mjs";
import { loadConfig } from "../src/config.mjs";

const judgeFor = (overrides) => new CoverageJudge({ coverageJudgeEnabled: true, ...overrides }, { fetchImpl: async () => { throw new Error("unused"); } });

test("the judge's ceiling is above the configured default, not under it", () => {
  const configured = loadConfig({}).coverageJudgeTimeoutMs;
  assert.equal(configured, COVERAGE_JUDGE_TIMEOUT_DEFAULT_MS, "config.mjs and the judge disagree about the default");
  assert.ok(
    COVERAGE_JUDGE_TIMEOUT_CEILING_MS >= configured,
    `a ceiling of ${COVERAGE_JUDGE_TIMEOUT_CEILING_MS} silently discards the configured ${configured}`,
  );
  // The configured value must survive the constructor unchanged.
  assert.equal(judgeFor({ coverageJudgeTimeoutMs: configured }).timeoutMs, configured);
});

test("a value outside the range is bounded, and the default is what config says", () => {
  // Negative controls: the ceiling must still be a ceiling and the floor a
  // floor, or "raise the ceiling" would have quietly removed the bound.
  assert.equal(judgeFor({ coverageJudgeTimeoutMs: 10_000_000 }).timeoutMs, COVERAGE_JUDGE_TIMEOUT_CEILING_MS);
  assert.equal(judgeFor({ coverageJudgeTimeoutMs: 1 }).timeoutMs, 1_000);
  // A mistyped setting is not a zero-length wait and not a wait that never
  // ends: NaN survives both Math.min and Math.max, so this used to produce
  // `timeoutMs = NaN` — neither bounded nor an error.
  assert.equal(judgeFor({ coverageJudgeTimeoutMs: Number.NaN }).timeoutMs, COVERAGE_JUDGE_TIMEOUT_DEFAULT_MS);
  assert.equal(judgeFor({ coverageJudgeTimeoutMs: "not a number" }).timeoutMs, COVERAGE_JUDGE_TIMEOUT_DEFAULT_MS);
  assert.ok(Number.isFinite(judgeFor({ coverageJudgeTimeoutMs: undefined }).timeoutMs));
  // A deployment that passes nothing waits the documented default, not the
  // number that default replaced.
  assert.equal(judgeFor({}).timeoutMs, COVERAGE_JUDGE_TIMEOUT_DEFAULT_MS);
});
