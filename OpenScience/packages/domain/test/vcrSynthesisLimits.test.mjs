// What an empirical synthesis can finish inside a job's CPU budget. The scenario used to advertise `m` from 1 (the engine refuses
// fewer than five copies) and a table of any size (a full-feature synthesis of a 12,000-row intensive-care table ran out of CPU
// budget and kept nothing). The description, the validator and the pre-queue refusal now come from the same constants.
import assert from "node:assert/strict";
import test from "node:test";

import {
  VCR_ENGINE_CPU_CEILING_SECONDS,
  VCR_SCENARIO_SCHEMAS,
  VCR_SYNTHPOP_COPIES,
  VCR_SYNTHPOP_COST,
  validateScenario,
  vcrScenarioHelp,
  vcrSynthpopBudgetSeconds,
  vcrSynthpopEstimateSeconds,
  vcrSynthpopFeasibility,
  vcrSynthpopHelpNotes,
} from "@evimed/domain";

test("the copies the scenario takes are the copies the engine makes: five to fifty, said by the schema, the validator and the help", () => {
  const field = /** @type {any} */ (VCR_SCENARIO_SCHEMAS["population.synthpop"]).fields.m;
  assert.deepEqual([field.min, field.max, field.default], [VCR_SYNTHPOP_COPIES.min, VCR_SYNTHPOP_COPIES.max, VCR_SYNTHPOP_COPIES.min]);
  const codes = (/** @type {number} */ m) => validateScenario("population.synthpop", { m }).map((issue) => issue.field);
  assert.deepEqual(codes(5), []);
  assert.deepEqual(codes(50), []);
  assert.deepEqual(codes(4), ["scenario.m"], "four copies are refused where the scenario is validated, not only in R");
  assert.deepEqual(codes(1), ["scenario.m"]);
  assert.deepEqual(codes(51), ["scenario.m"]);
  const row = /** @type {any} */ (vcrScenarioHelp()).methods["population.synthpop"].rows.find((/** @type {any} */ entry) => entry.path === "m");
  assert.deepEqual([row.min, row.max], [5, 50]);
});

test("the help says what a synthesis can finish, with the sizes the model itself allows", () => {
  const notes = /** @type {any} */ (vcrScenarioHelp()).methods["population.synthpop"].notes.join("\n");
  assert.equal(notes, vcrSynthpopHelpNotes().join("\n"));
  assert.match(notes, /cpuSecondsLimit/);
  assert.match(notes, /fails with no table and no copy kept/);
  assert.match(notes, /does not sample rows and does not drop columns/);
  assert.match(notes, /at 12,000/, "the table size of the evaluation that failed is in the help");
});

test("the estimate grows with rows, columns and copies, and the budget is what R stops at", () => {
  const base = { rows: 2000, columns: 12, copies: 5 };
  const seconds = vcrSynthpopEstimateSeconds(base);
  assert.ok(seconds > 0 && Number.isFinite(seconds));
  assert.ok(vcrSynthpopEstimateSeconds({ ...base, rows: 4000 }) > seconds);
  assert.ok(vcrSynthpopEstimateSeconds({ ...base, columns: 24 }) > seconds);
  assert.ok(vcrSynthpopEstimateSeconds({ ...base, copies: 10 }) > seconds);
  assert.equal(vcrSynthpopBudgetSeconds(600), 540);
  assert.equal(vcrSynthpopBudgetSeconds(100_000), 0.9 * VCR_ENGINE_CPU_CEILING_SECONDS, "no job is given more than the engine's own ceiling");
});

test("a small table is not refused and the evaluation's full-feature table is, with each way out a way out", () => {
  assert.deepEqual(vcrSynthpopFeasibility({ rows: 300, columns: 8, copies: 5, cpuSecondsLimit: 600 }), { ok: true });
  // 12,000 stays, forty variables, the minimum five copies, the platform's default budget
  const verdict = /** @type {any} */ (vcrSynthpopFeasibility({ rows: 12000, columns: 40, copies: 5, cpuSecondsLimit: 600 }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.estimateSeconds / VCR_SYNTHPOP_COST.worstOverPrediction > verdict.budgetSeconds, "refused because even the best measured case is over the budget");
  assert.match(verdict.message, /12000 行 × 40 列 × 5 份/);
  assert.match(verdict.message, /没有排队，也没有替你抽样或删列/);
  // every reduction it names, taken, is accepted — the sentence and the check cannot disagree
  assert.ok(verdict.fits.columns >= 1 && verdict.fits.columns < 40);
  assert.deepEqual(vcrSynthpopFeasibility({ rows: 12000, columns: verdict.fits.columns, copies: 5, cpuSecondsLimit: 600 }), { ok: true });
  assert.notDeepEqual(vcrSynthpopFeasibility({ rows: 12000, columns: verdict.fits.columns + 1, copies: 5, cpuSecondsLimit: 600 }), { ok: true }, "and it is the largest that is");
  if (verdict.fits.rows >= 100) assert.deepEqual(vcrSynthpopFeasibility({ rows: verdict.fits.rows, columns: 40, copies: 5, cpuSecondsLimit: 600 }), { ok: true });
});

test("more copies than the budget holds are answered with the copies that fit, never fewer than the minimum", () => {
  const at = (/** @type {number} */ columns, /** @type {number} */ copies) => vcrSynthpopFeasibility({ rows: 1500, columns, copies, cpuSecondsLimit: 600 });
  const silent = (/** @type {number} */ columns, /** @type {number} */ copies) => at(columns, copies).ok && !("risk" in at(columns, copies));
  // the narrowest table for which five copies fit and fifty are refused (ten times the work separates them)
  let columns = 1;
  while (columns < 200 && !(silent(columns, 5) && !at(columns, 50).ok)) columns += 1;
  assert.ok(columns < 200, "such a table exists");
  const verdict = /** @type {any} */ (at(columns, 50));
  assert.ok(verdict.fits.copies >= VCR_SYNTHPOP_COPIES.min && verdict.fits.copies < 50);
  assert.equal(silent(columns, verdict.fits.copies), true, "the copies it names are accepted, with nothing to say");
  assert.equal(silent(columns, verdict.fits.copies + 1), false, "and are the most that are");
  assert.match(verdict.message, /份数 m 减到/);
});

test("the platform's own ceiling is offered only when it would hold the job, and the engine's is the last word", () => {
  const rows = 6000;
  let columns = 8;
  while (vcrSynthpopFeasibility({ rows, columns, copies: 5, cpuSecondsLimit: 600 }).ok) columns += 1;
  assert.ok(columns > 8);
  const refused = /** @type {any} */ (vcrSynthpopFeasibility({ rows, columns, copies: 5, cpuSecondsLimit: 60, cpuSecondsCeiling: VCR_ENGINE_CPU_CEILING_SECONDS }));
  assert.equal(refused.ok, false);
  assert.ok(refused.raiseTo === null || refused.raiseTo > 60, "a raise is offered above the limit the caller set");
  const hopeless = /** @type {any} */ (vcrSynthpopFeasibility({ rows: 200000, columns: 400, copies: 50, cpuSecondsLimit: 600, cpuSecondsCeiling: VCR_ENGINE_CPU_CEILING_SECONDS }));
  assert.equal(hopeless.ok, false);
  assert.equal(hopeless.raiseTo, null);
  assert.match(hopeless.message, new RegExp(`${VCR_ENGINE_CPU_CEILING_SECONDS} 秒`), "says that even the engine's largest budget does not hold it");
});

// The model's error was measured: predicted over measured seconds 0.75 to 1.18 across 17 tables. A margin of 1.35 over the estimate
// refused a job that really needed 63% to 100% of its budget, and the person could not raise the limit past the platform's cap. A job is
// now refused only when even the best measured case is over the budget; between that and the margin it is queued with a notice.
test("a table the model cannot tell from finishing is queued with a notice; one that could not finish even at the best measured case is refused", () => {
  const rows = 4000;
  const limit = 600;
  const budget = vcrSynthpopBudgetSeconds(limit);
  const verdictAt = (/** @type {number} */ columns) => /** @type {any} */ (vcrSynthpopFeasibility({ rows, columns, copies: 5, cpuSecondsLimit: limit }));
  const seconds = (/** @type {number} */ columns) => vcrSynthpopEstimateSeconds({ rows, columns, copies: 5 });
  const margin = VCR_SYNTHPOP_COST.margin;
  const over = VCR_SYNTHPOP_COST.worstOverPrediction;
  // a table inside the band: over the budget once the margin is applied, under it at the best measured case
  const inside = [...Array(200).keys()].find((columns) => columns > 0 && seconds(columns) * margin > budget && seconds(columns) / over <= budget);
  assert.ok(inside, "the band exists for such a table");
  const risky = verdictAt(inside);
  assert.equal(risky.ok, true, "it is queued");
  assert.ok(risky.risk, "and the caller is told");
  assert.equal(risky.risk.budgetSeconds, budget);
  assert.ok(risky.risk.bestSeconds <= budget && risky.risk.worstSeconds > budget);
  assert.match(risky.risk.message, new RegExp(`${rows} 行 × ${inside} 列 × 5 份`));
  assert.match(risky.risk.message, /可能在预算内完不成/);
  assert.match(risky.risk.message, /已经排队/);
  assert.match(risky.risk.message, /列数减到 \d+ 以内/, "and what to reduce");
  // one column more than the band holds is refused
  const refusedAt = [...Array(400).keys()].find((columns) => columns > inside && seconds(columns) / over > budget);
  assert.ok(refusedAt);
  const refused = verdictAt(refusedAt);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /没有排队/);
  // every reduction a notice names is one that passes in silence
  assert.deepEqual(vcrSynthpopFeasibility({ rows, columns: risky.risk.fits.columns, copies: 5, cpuSecondsLimit: limit }), { ok: true });
  // a job that really needs between 63% and 100% of the budget is no longer refused
  const needing = [...Array(200).keys()].filter((columns) => columns > 0 && seconds(columns) * 0.75 >= 0.63 * budget && seconds(columns) / over <= budget);
  assert.ok(needing.length > 0);
  for (const columns of needing) assert.equal(verdictAt(columns).ok, true, `${columns} columns`);
});

test("the constants the refusal rests on are the measured ones: the margin is the reciprocal of the lowest ratio, the other is the highest", () => {
  assert.equal(VCR_SYNTHPOP_COST.worstOverPrediction, 1.18);
  assert.ok(VCR_SYNTHPOP_COST.margin >= 1 / 0.75 && VCR_SYNTHPOP_COST.margin < 1.4);
  assert.match(VCR_SYNTHPOP_COST.basis, /0\.75 and 1\.18/);
});
