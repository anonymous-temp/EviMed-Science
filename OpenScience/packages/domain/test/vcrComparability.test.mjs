// The words a comparison is read in (remediation plan A5-A9, A13 and owner decision 2 of 2026-11-01): the class of a result, the
// weighted balance in a sentence, the seven components of the target trial in every shape they were written in, the applicability
// record and the triggers that limit a result, and the role of an effect on its card.
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_APPLICABILITY_LIMIT_LABELS_ZH, VCR_BALANCE_BANDS, VCR_BENCHMARK_ONLY_BASES, VCR_BENCHMARK_ONLY_BASIS_LABELS_ZH, VCR_BENCHMARK_ONLY_USE_CEILING,
  VCR_CONCLUSIONS, VCR_EFFECT_ROLES, VCR_EFFECT_ROLE_LABELS_ZH, VCR_INTENDED_USES, VCR_RESULT_CLASSES, VCR_RESULT_CLASS_LABELS_ZH,
  VCR_SMD_FLOOR, VCR_SMD_SEVERE, VCR_TARGET_TRIAL_COMPONENTS, VCR_TARGET_TRIAL_COMPONENT_LABELS_ZH, VCR_TARGET_TRIAL_STATUSES,
  vcrApplicability, vcrApplicabilityLimits, vcrBalanceBand, vcrBalanceSentence, vcrBalanceVerdictOf, vcrBenchmarkBasis, vcrIsEffectCardKey,
  vcrResultClass, vcrResultLimits, vcrTargetTrial, vcrTargetTrialEngineItems, vcrTargetTrialStored,
} from "../index.mjs";

test("the result classes are the three conclusions and one more, each with its word", () => {
  assert.deepEqual([...VCR_RESULT_CLASSES].sort(), [...VCR_CONCLUSIONS, "benchmark_only"].sort(), "the stored conclusions are the engine's and do not grow");
  for (const key of VCR_RESULT_CLASSES) assert.ok(/** @type {Record<string, string>} */ (VCR_RESULT_CLASS_LABELS_ZH)[key], `${key} has its word`);
  assert.equal(VCR_RESULT_CLASS_LABELS_ZH.benchmark_only, "仅基准");
  for (const basis of VCR_BENCHMARK_ONLY_BASES) assert.ok(/** @type {Record<string, string>} */ (VCR_BENCHMARK_ONLY_BASIS_LABELS_ZH)[basis], `${basis} has its sentence`);
  assert.ok(VCR_INTENDED_USES.includes(VCR_BENCHMARK_ONLY_USE_CEILING), "the ceiling of a benchmark is one of the four uses");
});

test("a literature curve, an unanchored MAIC and a model's prediction are benchmarks; an estimate of an effect is not", () => {
  const maic = { method: "comparator.maic", diagnostics: { anchored: false } };
  assert.equal(vcrBenchmarkBasis(maic), "unanchored_maic");
  assert.equal(vcrBenchmarkBasis({ method: "comparator.maic_time_to_event", diagnostics: { anchored: false } }), "unanchored_maic");
  assert.equal(vcrBenchmarkBasis({ method: "comparator.maic", diagnostics: { anchored: true } }), null, "an anchored comparison is an estimate");
  assert.equal(vcrBenchmarkBasis({ method: "model.prognostic_apply" }), "model_prediction");
  assert.equal(vcrBenchmarkBasis({ route: "model_comparator" }), "model_prediction");
  assert.equal(vcrBenchmarkBasis({ method: "evidence.reconstruct_km", route: "literature_control", measures: [{ name: "median_survival" }] }), "literature_curve");
  assert.equal(vcrBenchmarkBasis({ method: "evidence.reconstruct_km", route: "literature_control", measures: [{ name: "rmst_difference" }] }), null,
    "two arms compared on their curves are a comparison");
  assert.equal(vcrBenchmarkBasis({ method: "comparator.weighted_cox" }), null);
  assert.equal(vcrBenchmarkBasis({}), null);
  assert.equal(vcrBenchmarkBasis(), null);

  assert.equal(vcrResultClass({ conclusion: "limited", ...maic }), "benchmark_only");
  assert.equal(vcrResultClass({ conclusion: "estimable", method: "model.prognostic_apply" }), "benchmark_only");
  assert.equal(vcrResultClass({ conclusion: "not_estimable", ...maic }), "not_estimable", "a result that cannot be estimated stays that");
  assert.equal(vcrResultClass({ conclusion: "limited", method: "comparator.weighted_cox" }), "limited");
  assert.equal(vcrResultClass({ conclusion: "estimable" }), "estimable");
  assert.equal(vcrResultClass({ conclusion: null }), null);
  assert.equal(vcrResultClass({ conclusion: "something_else" }), null);
});

test("the weighted balance has three bands and says its worst variable", () => {
  assert.deepEqual([...VCR_BALANCE_BANDS], ["balanced", "moderate", "severe"]);
  assert.equal(VCR_SMD_FLOOR, 0.1);
  assert.equal(VCR_SMD_SEVERE, 0.25);
  assert.equal(vcrBalanceBand(0), "balanced");
  assert.equal(vcrBalanceBand(0.1), "balanced", "at most 0.10 is normal");
  assert.equal(vcrBalanceBand(-0.1), "balanced");
  assert.equal(vcrBalanceBand(0.1001), "moderate");
  assert.equal(vcrBalanceBand(-0.25), "moderate", "at most 0.25 is a moderate difference");
  assert.equal(vcrBalanceBand(0.2501), "severe");
  assert.equal(vcrBalanceBand(Number.NaN), null);
  assert.equal(vcrBalanceBand(/** @type {any} */ ("x")), null);

  assert.equal(vcrBalanceSentence({ worst: 0.05, variable: "age" }), null, "balanced says nothing");
  assert.equal(vcrBalanceSentence(null), null);
  assert.equal(vcrBalanceSentence({ band: "moderate", worst: 0.119, variable: "age" }), "加权后“age”的标准化差异仍为 0.12，超过界值 0.1。");
  const severe = String(vcrBalanceSentence({ band: "severe", worst: -0.274, variable: "re74" }));
  assert.match(severe, /^严重失衡：/);
  assert.match(severe, /“re74”/);
  assert.match(severe, /0\.27/);
  assert.match(severe, /0\.25/);
  assert.match(String(vcrBalanceSentence({ worst: 0.3 })), /加权后最大的标准化差异/, "a verdict with no variable still says the number");

  // a result written before the engine said its verdict is read from its balance table
  const verdict = vcrBalanceVerdictOf([{ covariate: "age", smdAdjusted: 0.04 }, { covariate: "re74", smdAdjusted: -0.31 }, { covariate: "educ", smdAdjusted: 0.12 }]);
  assert.deepEqual({ band: verdict?.band, variable: verdict?.variable, worst: verdict?.worst }, { band: "severe", variable: "re74", worst: 0.31 });
  assert.equal(vcrBalanceVerdictOf([]), null);
  assert.equal(vcrBalanceVerdictOf(null), null);
});

test("the target trial is one shape of seven components, read from the three shapes that were written", () => {
  assert.deepEqual([...VCR_TARGET_TRIAL_COMPONENTS], ["eligibility", "strategies", "assignment", "timeZero", "outcome", "contrast", "analysis"]);
  for (const key of VCR_TARGET_TRIAL_COMPONENTS) assert.ok(/** @type {Record<string, string>} */ (VCR_TARGET_TRIAL_COMPONENT_LABELS_ZH)[key]);
  assert.deepEqual([...VCR_TARGET_TRIAL_STATUSES], ["exact", "approximate", "not_possible"]);

  // 1. the closed shape
  const closed = vcrTargetTrial({
    eligibility: { status: "approximate", text: "外部对照的入排条件更宽" }, strategies: { status: "exact", text: "试验药物对标准治疗" },
    timeZero: { status: "not_possible", text: "外部对照没有随机日期" }, outcome: "总生存期",
  });
  assert.equal(closed.shape, "components");
  assert.deepEqual(closed.components.map((entry) => [entry.key, entry.status]), [["eligibility", "approximate"], ["strategies", "exact"], ["timeZero", "not_possible"], ["outcome", null]]);
  assert.deepEqual(closed.missing, ["assignment", "outcome", "contrast", "analysis"], "a component with no status is as good as missing for the reader");
  assert.equal(closed.components[0].statusLabel, "只能近似");
  assert.deepEqual(vcrTargetTrialEngineItems(closed), [
    { item: "eligibility", emulation: "approximate" }, { item: "strategies", emulation: "exact" }, { item: "timeZero", emulation: "cannot" },
  ]);

  // 2. the engine's list, which is what the skill used to teach: the skill's own example reaches the page
  const items = vcrTargetTrial(undefined, [
    { item: "入选标准", emulation: "approximate" }, { item: "处理策略", emulation: "exact" }, { item: "同期治疗", emulation: "cannot" },
  ]);
  assert.equal(items.shape, "items");
  assert.deepEqual(items.components.map((entry) => [entry.key, entry.status]), [["eligibility", "approximate"], ["strategies", "exact"]]);
  assert.deepEqual(items.other, [{ item: "同期治疗", status: "not_possible" }], "a name that is no component is kept as it was, never guessed into one");
  assert.deepEqual(vcrTargetTrialEngineItems(items), [
    { item: "eligibility", emulation: "approximate" }, { item: "strategies", emulation: "exact" }, { item: "同期治疗", emulation: "cannot" },
  ]);

  // 3. the page's old two sentences and a note
  const legacy = vcrTargetTrial({ population: "晚期肺癌一线患者", treatment: "药物 X", note: "按公开方案" });
  assert.equal(legacy.shape, "legacy");
  assert.deepEqual(legacy.components.map((entry) => [entry.key, entry.text, entry.status]), [["eligibility", "晚期肺癌一线患者", null], ["strategies", "药物 X", null]]);
  assert.equal(legacy.note, "按公开方案");

  // the row's record is read first and the configuration's fills what it does not say
  const both = vcrTargetTrial({ eligibility: { status: "exact", text: "同一标准" } }, [{ item: "eligibility", emulation: "cannot" }, { item: "outcome", emulation: "approximate" }]);
  assert.deepEqual(both.components.map((entry) => [entry.key, entry.status]), [["eligibility", "exact"], ["outcome", "approximate"]]);

  // nothing is a record that is absent, not an error
  for (const nothing of [undefined, null, {}, [], "", 7]) assert.equal(vcrTargetTrial(nothing).present, false);
  assert.deepEqual(vcrTargetTrial(undefined).missing, [...VCR_TARGET_TRIAL_COMPONENTS]);

  // what is stored is the closed shape, and reads back as itself
  const stored = vcrTargetTrialStored(closed);
  assert.deepEqual(stored.timeZero, { status: "not_possible", text: "外部对照没有随机日期" });
  assert.deepEqual(vcrTargetTrial(stored).components, closed.components);
  assert.deepEqual(vcrTargetTrialStored(vcrTargetTrial(stored)), stored);
});

test("the applicability record limits a result only by what code can see, and never refuses", () => {
  assert.equal(vcrApplicability({}).present, false);
  assert.equal(vcrApplicability({ applicability: { state: "bogus" } }).present, false, "a word outside the closed ones is no record");
  const record = vcrApplicability({ applicability: { state: "partly_suitable", claim: "non_inferiority", note: "对照来自另一年代的登记库" } });
  assert.deepEqual([record.present, record.stateLabel, record.claimLabel, record.note], [true, "部分适用", "非劣效", "对照来自另一年代的登记库"]);

  const noTimeZero = (/** @type {any} */ input) => vcrApplicabilityLimits(input).map((entry) => entry.code);
  // an external control with no time-zero rule anywhere is limited, with the reason
  assert.deepEqual(noTimeZero({ route: "external_control", configuration: {}, targetTrial: {} }), ["no_time_zero_rule"]);
  assert.deepEqual(noTimeZero({ route: "external_control", configuration: {}, targetTrial: { timeZero: { status: "approximate", text: "从入组日起算" } } }), []);
  assert.deepEqual(noTimeZero({ route: "external_control", configuration: { targetTrial: [{ item: "timeZero", emulation: "exact" }] } }), [],
    "the engine's list names it too");
  assert.deepEqual(noTimeZero({ route: "external_control", configuration: { timeZero: { column: "index_date" } } }), [], "a time-zero column is a rule");
  assert.deepEqual(noTimeZero({ route: "literature_control", configuration: {} }), [], "a published curve has no time zero of its own to align");
  assert.deepEqual(noTimeZero({ route: "hybrid_control", configuration: {} }), []);
  // a non-inferiority claim on any route that borrows its control
  const claim = { applicability: { state: "doubtful", claim: "non_inferiority" } };
  assert.deepEqual(noTimeZero({ route: "external_control", configuration: claim, targetTrial: { timeZero: "从入组日起算" } }), ["non_inferiority_purpose"]);
  assert.deepEqual(noTimeZero({ route: "hybrid_control", configuration: claim }), ["non_inferiority_purpose"]);
  assert.deepEqual(noTimeZero({ route: "literature_control", configuration: claim }), ["non_inferiority_purpose"]);
  assert.deepEqual(noTimeZero({ route: "prognostic_adjustment", configuration: claim }), [], "a randomised trial adjusted for a score borrows nothing");
  assert.deepEqual(noTimeZero({ route: "external_control", configuration: { applicability: { state: "suitable", claim: "superiority" } }, targetTrial: { timeZero: "x" } }), []);
  for (const code of vcrApplicabilityLimits({ route: "external_control", configuration: claim })) {
    assert.ok(/** @type {Record<string, string>} */ (VCR_APPLICABILITY_LIMIT_LABELS_ZH)[code.code], `${code.code} has its sentence`);
    assert.equal(code.reason, /** @type {Record<string, string>} */ (VCR_APPLICABILITY_LIMIT_LABELS_ZH)[code.code]);
  }
  assert.deepEqual(vcrApplicabilityLimits(), []);
});

test("an effect has one of two roles, and the keys that are effects are the closed ones", () => {
  assert.deepEqual([...VCR_EFFECT_ROLES], ["important_difference", "realistic_expectation"]);
  assert.deepEqual(VCR_EFFECT_ROLES.map((role) => /** @type {Record<string, string>} */ (VCR_EFFECT_ROLE_LABELS_ZH)[role]), ["重要差异", "现实预期"]);
  for (const key of ["hazard_ratio", "hazard_ratio_pfs", "treatment_event_rate", "risk_difference", "odds_ratio", "mean_difference", "effect_size", "effect"]) {
    assert.equal(vcrIsEffectCardKey(key), true, key);
  }
  for (const key of ["control_median_pfs", "dropout_rate", "control_event_rate", "outcome_sd", "my_hazard_ratio", "hazard_ratios", ""]) {
    assert.equal(vcrIsEffectCardKey(key), false, key);
  }
});

test("P1-6 the sentences a result is read with are one function for the page and the record: balance, the records' limits, what a benchmark is of", () => {
  const worst = { band: "severe", worst: 0.31, variable: "age" };
  assert.deepEqual(vcrResultLimits({ conclusion: "limited", diagnostics: { balanceVerdict: worst } }), [{ key: "balance", text: vcrBalanceSentence(worst) }]);
  // A result that predates the verdict is read from its balance table.
  assert.deepEqual(vcrResultLimits({ conclusion: "limited", diagnostics: { balance: [{ covariate: "age", smdAdjusted: 0.12 }, { covariate: "sex", smdAdjusted: -0.04 }] } }).map((limit) => limit.key), ["balance"]);
  // The comparator's own records, by their code, or the reason the engine wrote for a code this version does not know.
  const code = Object.keys(VCR_APPLICABILITY_LIMIT_LABELS_ZH)[0];
  assert.deepEqual(vcrResultLimits({ conclusion: "limited", diagnostics: { applicabilityLimits: [{ code, reason: "x" }, { code: "unknown_code", reason: "自己写的理由" }, { code: "empty" }] } }),
    [{ key: code, text: /** @type {Record<string, string>} */ (VCR_APPLICABILITY_LIMIT_LABELS_ZH)[code] }, { key: "unknown_code", text: "自己写的理由" }]);
  // A benchmark says what it is a benchmark of, except an unanchored comparison, whose residual error is a premise instead.
  assert.deepEqual(vcrResultLimits({ conclusion: "estimable", method: "evidence.reconstruct_km", route: "literature_control", measures: [] }),
    [{ key: "benchmark", text: VCR_BENCHMARK_ONLY_BASIS_LABELS_ZH.literature_curve }]);
  assert.deepEqual(vcrResultLimits({ conclusion: "limited", method: "comparator.maic", diagnostics: { anchored: false } }), []);
  assert.deepEqual(vcrResultLimits({ conclusion: "limited", method: "model.prognostic_apply" }).map((limit) => limit.key), ["benchmark"]);
  // Nothing to read with, or nothing estimated: none.
  assert.deepEqual(vcrResultLimits({ conclusion: "estimable", diagnostics: { balanceVerdict: { band: "balanced", worst: 0.03, variable: "age" } } }), []);
  assert.deepEqual(vcrResultLimits({ conclusion: "not_estimable", diagnostics: { balanceVerdict: worst } }), []);
  assert.deepEqual(vcrResultLimits(), []);
});
