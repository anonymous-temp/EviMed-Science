/**
 * Lineage ids and staleness, the intended-use ceiling, and the package
 * contracts' findings after the merge review of 2026-09-29.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_KINDS,
  CONTRACT_KIND_LABELS,
  VCR_ASSUMPTION_KEY,
  VCR_ASSUMPTION_KEY_PATTERN,
  VCR_ENGINE_METHODS,
  VCR_ESS_FLOOR,
  VCR_INTENDED_USES,
  VCR_MAP_CONFLICT_BOUND,
  VCR_MODEL_RISKS,
  VCR_MODEL_RISK_EVIDENCE,
  VCR_MODEL_TIERS,
  VCR_RECONSTRUCTION_TOLERANCE,
  VCR_RISK_USE_CEILING,
  VCR_SUPPORT_CEILING,
  affectedNodes,
  intendedUseCeiling,
  intendedUseCeilingDetail,
  intendedUseCeilingFor,
  lineageImpact,
  lineageNode,
  parseLineageNode,
  proseNumbers,
  recomputePlan,
  resultNumbers,
  reviewStateFor,
  validateRequirement,
  vcrMatchingFindings,
  vcrStudyPackageFindings,
} from "@evimed/domain";

// --- lineage ids: one grammar, and an id that cannot be read back is refused ---------

test("an assumption key is a lowercase name, and the same pattern is exported for whoever validates one", () => {
  assert.equal(VCR_ASSUMPTION_KEY_PATTERN, "^[a-z][a-z0-9_]{0,63}$");
  for (const key of ["dropout_rate", "orr", "a", "control_median_pfs", "x".repeat(64)]) assert.ok(VCR_ASSUMPTION_KEY.test(key), key);
  for (const key of ["脱落率", "control median pfs", "orr@12m", "Dropout", "1st", "", "x".repeat(65), "a-b", "a.b", "a\n"]) assert.equal(VCR_ASSUMPTION_KEY.test(key), false, JSON.stringify(key));
});

test("lineageNode throws on an id it cannot parse back, and every node it writes round-trips", () => {
  for (const key of ["dropout_rate", "脱落率", "control median pfs", "orr@12m"]) {
    if (VCR_ASSUMPTION_KEY.test(key)) assert.equal(lineageNode("assumption", key, 2), `assumption:${key}@2`);
    else assert.throws(() => lineageNode("assumption", key, 2), /assumption key|cannot be read back/, key);
  }
  for (const id of ["a@b", "asm 1", "研究1", "x/y", "", "-x", ".x"]) {
    assert.throws(() => lineageNode("trial_scenario", id, 1), Error, JSON.stringify(id));
  }
  for (const id of ["scn_1", "std_1.v2", "a:b", "A1"]) {
    const node = lineageNode("trial_scenario", id, 12);
    assert.deepEqual(parseLineageNode(node), { kind: "trial_scenario", id, version: 12 });
  }
  assert.throws(() => lineageNode("assumption", "a", /** @type {any} */ ("3")), /positive integer/);
  assert.throws(() => lineageNode("assumption", "a", 0), /positive integer/);
  assert.throws(() => lineageNode("nonsense", "a", 1), /unknown kind/);
  assert.throws(() => lineageNode("trial_scenario", "x".repeat(140), 1), /cannot be read back/, "a node longer than an input id may be is refused");
  assert.equal(parseLineageNode("assumption:a@0"), null);
  assert.equal(parseLineageNode("assumption:a@03"), null, "a version has no leading zero");
});

test("a node is also a valid engine input id: the one grammar reaches the job", async () => {
  const { validateCallerInputs } = await import("@evimed/domain");
  assert.deepEqual(validateCallerInputs([{ kind: "assumption", id: lineageNode("assumption", "dropout_rate", 3), hash: null }]), []);
  assert.deepEqual(validateCallerInputs([{ kind: "population", id: lineageNode("population", "pop_1", 2) }]), []);
});

// --- staleness reaches the version a review signed (D-12) --------------------------

test("the change's superseded versions are affected, the new version is not, and the traversal is linear", () => {
  const edges = [
    { from: "assumption:dropout@3", to: "trial_scenario:scn_1@1", cost: /** @type {'heavy'} */ ("heavy") },
    { from: "trial_scenario:scn_1@1", to: "result:res_1@1", cost: /** @type {'light'} */ ("light") },
  ];
  // The lead saves version 4: the change is the new node.
  assert.deepEqual(affectedNodes(edges, ["assumption:dropout@4"]), ["assumption:dropout@3", "trial_scenario:scn_1@1", "result:res_1@1"]);
  // The orchestrator passes the superseded versions with the new one.
  assert.deepEqual(affectedNodes(edges, ["assumption:dropout@3", "assumption:dropout@4"]), ["assumption:dropout@3", "trial_scenario:scn_1@1", "result:res_1@1"]);
  // A change that is only the newest version reaches only what is downstream of it.
  assert.deepEqual(affectedNodes(edges, ["assumption:dropout@3"]), ["trial_scenario:scn_1@1", "result:res_1@1"]);
  assert.deepEqual(affectedNodes(edges, ["assumption:other@1"]), []);
  const { superseded, downstream } = lineageImpact(edges, ["assumption:dropout@4"]);
  assert.deepEqual([...superseded], ["assumption:dropout@3"]);
  assert.deepEqual([...downstream], ["trial_scenario:scn_1@1", "result:res_1@1"]);
  const N = 20_000;
  const chain = Array.from({ length: N }, (_, i) => ({ from: `result:r${i}@1`, to: `result:r${i + 1}@1` }));
  const started = Date.now();
  assert.equal(affectedNodes(chain, ["result:r0@1"]).length, N);
  assert.ok(Date.now() - started < 1_000, "a long chain is walked in linear time");
});

test("a superseded assumption reaches its review: the recompute plan marks it, the review reads changed", () => {
  const edges = [{ from: "assumption:dropout@3", to: "trial_scenario:scn_1@1" }, { from: "trial_scenario:scn_1@1", to: "result:res_1@1" }];
  const plan = recomputePlan({ edges, changed: ["assumption:dropout@4"], reason: "assumption_changed" });
  assert.deepEqual([...plan.all], ["assumption:dropout@3", "trial_scenario:scn_1@1", "result:res_1@1"]);
  assert.deepEqual([...plan.superseded], ["assumption:dropout@3"]);
  assert.equal(plan.all.includes("assumption:dropout@4"), false, "the version just written is current, not stale");
  assert.deepEqual([...plan.heavy], ["trial_scenario:scn_1@1"], "only what is recomputed is light or heavy");
  assert.deepEqual([...plan.light], ["result:res_1@1"]);
  assert.deepEqual([...plan.changed], ["assumption:dropout@4"]);
  // The presenter's own route: reviewed nodes that are not marked stale are added to the current set.
  const review = { nodes: ["assumption:dropout@3"] };
  const staleNodes = new Set(plan.all);
  assert.ok(review.nodes.some((node) => staleNodes.has(node)), "the mark now reaches the reviewed node");
});

test("a review holds only while nothing it signed has a newer version beside it", () => {
  const held = { reviewedNodes: ["population:pop_1@3"], currentNodes: ["population:pop_1@3"] };
  assert.equal(reviewStateFor(held), "reviewed");
  assert.equal(reviewStateFor({ reviewedNodes: ["population:pop_1@3"], currentNodes: ["population:pop_1@4"] }), "changed_after_review");
  // The reviewed node is listed as current because nothing marked it stale — and a newer version is there too.
  assert.equal(reviewStateFor({ reviewedNodes: ["population:pop_1@3"], currentNodes: ["population:pop_1@3", "population:pop_1@4"] }), "changed_after_review");
  assert.equal(reviewStateFor({ reviewedNodes: ["population:pop_1@3", "result:r@1"], currentNodes: ["population:pop_1@3", "result:r@1", "result:s@9"] }), "reviewed", "another object's version is no evidence of change");
  assert.equal(reviewStateFor({ reviewedNodes: [], currentNodes: ["result:r@2"] }), "ai_set", "a review that names no node countersigned nothing");
});

test("a diamond with conflicting edge costs is heavy whatever order the edges come in", () => {
  const edges = [
    { from: "assumption:asm_1@3", to: "trial_scenario:scn_1@2", cost: /** @type {'heavy'} */ ("heavy") },
    { from: "population:pop_1@2", to: "trial_scenario:scn_1@2", cost: /** @type {'light'} */ ("light") },
  ];
  for (const order of [edges, [...edges].reverse()]) {
    const plan = recomputePlan({ edges: order, changed: ["assumption:asm_1@3", "population:pop_1@2"], reason: "assumption_changed" });
    assert.deepEqual([...plan.heavy], ["trial_scenario:scn_1@2"]);
    assert.deepEqual([...plan.light], []);
  }
  // A cost that is neither light nor heavy says nothing: the kind decides.
  const odd = recomputePlan({ edges: [{ from: "assumption:a@1", to: "execution:e@1", cost: /** @type {any} */ ("medium") }], changed: ["assumption:a@1"], reason: "assumption_changed" });
  assert.deepEqual([...odd.heavy], ["execution:e@1"]);
});

// --- the intended-use ceiling (D-6) ------------------------------------------------

const ALL_EVIDENCE = [...VCR_MODEL_RISK_EVIDENCE.high];

test("each model is capped by its tier, its declared risk and the evidence it holds — the lowest wins", () => {
  assert.equal(intendedUseCeilingFor({}), "submission_preparation", "no models: no model ceiling");
  assert.equal(intendedUseCeilingFor({ tiers: [], models: [] }), "submission_preparation");
  // A validated model with all the evidence, declared high, is the top.
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", risk: "high", evidence: ALL_EVIDENCE }] }), "submission_preparation");
  // Same model, no evidence: exploratory. The tier alone does not carry the use.
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", risk: "high", evidence: [] }] }), "exploratory");
  // Evidence for medium, declared high: specified analysis.
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", risk: "high", evidence: VCR_MODEL_RISK_EVIDENCE.medium }] }), "specified_analysis");
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", risk: "high", evidence: VCR_MODEL_RISK_EVIDENCE.low }] }), "design_support");
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", risk: "high", evidence: VCR_MODEL_RISK_EVIDENCE.none }] }), "exploratory");
  // A tier caps whatever the evidence says.
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "literature", risk: "high", evidence: ALL_EVIDENCE }] }), "design_support");
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "scenario", risk: "high", evidence: ALL_EVIDENCE }] }), "exploratory");
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "data", risk: "high", evidence: ALL_EVIDENCE }] }), "specified_analysis");
  // A declared risk caps the use it claims: a low-risk use is a design-support use.
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", risk: "low", evidence: ALL_EVIDENCE }] }), "design_support");
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", risk: "none", evidence: ALL_EVIDENCE }] }), "exploratory");
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", risk: "medium", evidence: ALL_EVIDENCE }] }), "specified_analysis");
});

test("an unknown tier counts as a scenario model and an unknown risk as high; the weakest model decides", () => {
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "Validated", risk: "high", evidence: ALL_EVIDENCE }] }), "exploratory", "a tier nobody recognises has earned nothing");
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", risk: "HIGH", evidence: VCR_MODEL_RISK_EVIDENCE.low }] }), "design_support", "an unknown risk demands the most, and the evidence decides");
  assert.equal(intendedUseCeilingFor({ models: [{ tier: "validated", evidence: ALL_EVIDENCE }] }), "submission_preparation", "no declared risk is not a cap");
  assert.equal(intendedUseCeilingFor({ models: [{}] }), "exploratory");
  assert.equal(intendedUseCeilingFor({ models: [
    { tier: "validated", risk: "high", evidence: ALL_EVIDENCE },
    { tier: "literature", risk: "low", evidence: VCR_MODEL_RISK_EVIDENCE.low },
  ] }), "design_support");
  // The older tier-only input still works and still means the tier's ceiling.
  assert.equal(intendedUseCeilingFor({ tiers: ["validated", "literature"] }), "design_support");
  assert.equal(intendedUseCeiling(["scenario", "data"]), "exploratory");
  assert.equal(intendedUseCeilingFor({ tiers: ["nonsense"] }), "exploratory");
});

test("the ceiling says what set it, so the result can write the reason (AC-34)", () => {
  const detail = intendedUseCeilingDetail({ models: [
    { tier: "validated", risk: "high", evidence: VCR_MODEL_RISK_EVIDENCE.low },
    { tier: "validated", risk: "high", evidence: ALL_EVIDENCE },
  ] });
  assert.equal(detail.ceiling, "design_support");
  assert.equal(detail.limitedBy.length, 1, "only the model that limits is listed");
  assert.equal(detail.limitedBy[0].index, 0);
  assert.equal(detail.limitedBy[0].cause, "evidence");
  assert.equal(detail.limitedBy[0].supportedRisk, "low");
  assert.ok(detail.limitedBy[0].missing.includes("external_validation"), "and what is missing");
  assert.equal(intendedUseCeilingDetail({ models: [{ tier: "scenario", risk: "none", evidence: ALL_EVIDENCE }] }).limitedBy[0].cause, "tier");
  assert.equal(intendedUseCeilingDetail({ models: [{ tier: "validated", risk: "low", evidence: ALL_EVIDENCE }] }).limitedBy[0].cause, "declared_risk");
  assert.deepEqual(VCR_MODEL_RISKS.map((risk) => VCR_RISK_USE_CEILING[/** @type {keyof typeof VCR_RISK_USE_CEILING} */ (risk)]), ["exploratory", "design_support", "specified_analysis", "submission_preparation"]);
});

test("every method records the tier its output carries on its own, so the control plane needs no self-report", () => {
  for (const [id, spec] of Object.entries(VCR_ENGINE_METHODS)) {
    assert.ok("modelTier" in spec, id);
    assert.ok(spec.modelTier === null || VCR_MODEL_TIERS.includes(spec.modelTier), `${id}: ${spec.modelTier}`);
  }
  for (const method of /** @type {const} */ (["profile.snapshot", "cohort.build", "matching.evaluate"])) assert.equal(VCR_ENGINE_METHODS[method].modelTier, null, "not a model");
  assert.equal(VCR_ENGINE_METHODS["patients.time_to_event"].modelTier, "scenario");
  assert.equal(VCR_ENGINE_METHODS["evidence.pool"].modelTier, "literature");
  assert.equal(VCR_ENGINE_METHODS["comparator.entropy_balance"].modelTier, "data");
  assert.ok(VCR_INTENDED_USES.includes(intendedUseCeilingFor({ models: [{ tier: VCR_ENGINE_METHODS["design.simulate"].modelTier }] })));
});

// --- the presets the engine reads instead of scenario keys ---------------------------

test("the not-estimable thresholds are deployment presets with stated values", () => {
  assert.equal(VCR_ESS_FLOOR, 10);
  assert.equal(VCR_SUPPORT_CEILING, 0.1);
  assert.equal(VCR_MAP_CONFLICT_BOUND, 0.01);
  assert.deepEqual({ ...VCR_RECONSTRUCTION_TOLERANCE }, { atRiskAbsolute: 2, atRiskRelative: 0.05, events: 0.05, median: 0.05, logHazardRatio: 0.05 });
  assert.ok(Object.isFrozen(VCR_RECONSTRUCTION_TOLERANCE));
});

// --- the contracts' own findings (D-11, D-13, CW-20) ---------------------------------

const pkg = (/** @type {any} */ results, /** @type {Record<string, string>} */ files = {}) => ({
  files: new Map([["results.json", typeof results === "string" ? results : JSON.stringify(results)], ...Object.entries(files)]),
});
const base = { conclusion: "estimable", counts: { realPatients: 180, events: 138, effectiveSampleSize: 138, generatedRecords: 0 } };
const untraced = (/** @type {any} */ found) => found.issues.filter((/** @type {any} */ issue) => issue.code === "vcr_number_untraced").map((/** @type {any} */ issue) => issue.message.slice(1, issue.message.indexOf("」")));

test("the five contract kinds have Chinese labels like the others (D-11)", () => {
  for (const kind of ["vcr-study-package", "vcr-simulation-report", "vcr-comparator-analysis", "vcr-cohort-snapshot", "vcr-matching-assessment"]) {
    assert.ok(CONTRACT_KINDS.includes(kind));
    const label = /** @type {Record<string, string>} */ (CONTRACT_KIND_LABELS)[kind];
    assert.ok(label && /[一-鿿]/.test(label), `${kind} has no Chinese label`);
    assert.notEqual(label, kind);
  }
});

test("the number-provenance notice skips the backstage file, reads negatives and numeric strings, and passes a confidence level (D-13)", () => {
  assert.deepEqual(untraced(vcrStudyPackageFindings(pkg(base, { "report.md": "需要 180 例。", "revision-notes.md": "把脱落率从 15% 改成 20%，样本量 250。" }))), [],
    "revision notes name numbers being changed, not numbers being reported");
  assert.deepEqual(untraced(vcrStudyPackageFindings(pkg({ ...base, measures: [{ name: "bias", value: -0.12 }] }, { "report.md": "偏倚 -0.12。" }))), []);
  assert.deepEqual(untraced(vcrStudyPackageFindings(pkg({ ...base, measures: [{ name: "bias", value: -0.12 }] }, { "report.md": "偏倚 −0.12，即下降 0.12。" }))), [], "a Unicode minus, and the magnitude alone");
  assert.deepEqual(untraced(vcrStudyPackageFindings(pkg({ ...base, measures: [{ name: "power", value: "0.81" }] }, { "report.md": "功效 81%，即 0.81。" }))), []);
  for (const label of ["HR 0.70（95% CI 0.55–0.89）", "HR 0.70（95%置信区间 0.55–0.89）", "HR 0.70（90 % CrI 0.55–0.89）", "HR 0.70（95%可信区间 0.55–0.89）"]) {
    const found = vcrStudyPackageFindings(pkg({ ...base, measures: [{ name: "hr", value: 0.7, interval: { kind: "confidence", low: 0.55, high: 0.89 } }] }, { "report.md": `${label}。` }));
    assert.deepEqual(untraced(found), [], label);
  }
  // Still caught: a number no result carries, next to a label.
  assert.deepEqual(untraced(vcrStudyPackageFindings(pkg({ ...base, measures: [{ name: "hr", value: 0.7 }] }, { "report.md": "HR 0.70（95% CI 0.55–0.89），需要 220 例。" }))), ["0.55", "0.89", "220"]);
  assert.deepEqual(proseNumbers("95% CI 0.55 与 5% 显著性水平"), ["0.55", "5"].filter((n) => n !== "5"), "small integers are not traced; the level in a label is not read");
  assert.ok(resultNumbers({ v: -0.12 }).has("0.12") && resultNumbers({ v: -0.12 }).has("-0.12"));
  assert.ok(resultNumbers({ v: "0.81" }).has("81"));
});

test("a criterion's requirement outside the closed grammar, or without its source sentence, is a notice (CW-20)", () => {
  const criteria = [
    { kind: "inclusion", criterionType: "diagnosis", requirement: { op: "present", variable: "nsclc" }, sourceText: "确诊非小细胞肺癌", sourceLocator: { page: 3 } },
    { kind: "inclusion", criterionType: "performance_status", requirement: { field: "ecog", op: "<=", value: 1 }, sourceText: "ECOG 0-1", sourceLocator: { page: 3 } },
    { kind: "exclusion", criterionType: "comorbidity", requirement: { op: "language", text: "预期生存期不足 12 周" }, sourceText: "", sourceLocator: {} },
    { kind: "exclusion", criterionType: "other", sourceText: "其他", sourceLocator: { page: 4 } },
  ];
  const found = vcrStudyPackageFindings(pkg({ ...base }, { "criteria.json": JSON.stringify(criteria) }));
  const of = (/** @type {string} */ code) => found.issues.filter((issue) => issue.code === code);
  assert.equal(of("vcr_criterion_requirement_invalid").length, 2, "the old {field, op, value} shape and a missing requirement");
  assert.match(of("vcr_criterion_requirement_invalid")[0].message, /第 2 条/);
  assert.match(of("vcr_criterion_requirement_invalid")[0].message, /rule_op_unknown/);
  assert.equal(of("vcr_criterion_source_missing").length, 1);
  assert.match(of("vcr_criterion_source_missing")[0].message, /第 3 条.*sourceText.*sourceLocator/);
  assert.ok(found.issues.every((issue) => issue.severity === "advisory"), "all findings stay advisory");
  assert.equal(found.metrics.vcrCriteria, 4);
  assert.equal(found.metrics.vcrCriteriaInvalid, 2);
  // A clean criteria file raises nothing, and an unreadable one says so.
  assert.deepEqual(vcrStudyPackageFindings(pkg({ ...base }, { "criteria.json": JSON.stringify([criteria[0]]) })).issues.filter((issue) => issue.check === "vcr-criteria-shape"), []);
  assert.equal(vcrStudyPackageFindings(pkg({ ...base }, { "criteria.json": "{bad" })).issues.filter((issue) => issue.check === "vcr-criteria-shape")[0].code, "vcr_criteria_unreadable");
  assert.deepEqual(vcrStudyPackageFindings(pkg({ ...base })).issues.filter((issue) => issue.check === "vcr-criteria-shape"), [], "a package with no criteria file has nothing to check");
  // A long list is reported in part, with a summary.
  const many = Array.from({ length: 12 }, () => ({ requirement: { op: "matches" }, sourceText: "x", sourceLocator: { p: 1 } }));
  const flood = vcrStudyPackageFindings(pkg({ ...base }, { "criteria.json": JSON.stringify(many) })).issues.filter((issue) => issue.check === "vcr-criteria-shape");
  assert.equal(flood.length, 6);
  assert.equal(flood.at(-1)?.code, "vcr_criteria_more");
});

test("the requirement grammar the protocol skill teaches is what validateRequirement accepts", () => {
  assert.deepEqual(validateRequirement({ op: "language", text: "预期生存期至少 12 周" }), []);
  assert.equal(validateRequirement({ field: "ecog", op: "<=", value: 1 })[0].code, "rule_op_unknown");
  assert.equal(validateRequirement({ free_text: "..." })[0].code, "rule_shape_invalid");
});

test("the study-package cover states its review status, and under a confirmatory use both seal timestamps (CW-20)", () => {
  const cover = (/** @type {any} */ results) => vcrStudyPackageFindings(pkg({ ...base, ...results }, { "study-package.md": "封面" })).issues.filter((issue) => issue.check === "vcr-package-cover");
  assert.deepEqual(cover({ review: { records: [] }, intendedUse: "exploratory" }), []);
  assert.deepEqual(cover({ intendedUse: "exploratory" }).map((issue) => issue.code), ["vcr_cover_review_missing"], "no review field: the cover says nothing about review");
  const missing = cover({ review: { records: [] }, intendedUse: "specified_analysis", study: { dataTier: "T2" }, seal: { planFrozenAt: "2026-09-01T00:00:00Z" } });
  assert.deepEqual(missing.map((issue) => issue.code), ["vcr_cover_seal_missing"]);
  assert.match(missing[0].message, /outcomeFirstReadAt/, "it says which timestamp");
  const neither = cover({ review: { records: [] }, intendedUse: "submission_preparation", study: { dataTier: "T3" } });
  assert.equal(neither.length, 2);
  assert.match(neither.map((issue) => issue.message).join(" "), /planFrozenAt.*outcomeFirstReadAt|outcomeFirstReadAt.*planFrozenAt/);
  assert.deepEqual(cover({ review: { records: [] }, intendedUse: "specified_analysis", study: { dataTier: "T2" }, seal: { planFrozenAt: "a", outcomeFirstReadAt: "b" } }), []);
  assert.deepEqual(cover({ review: { records: [] }, intendedUse: "specified_analysis", study: { dataTier: "T0" } }), [], "a T0 study has no outcome data to seal");
  // The cover check applies to the study package only: a package with no cover document, or a comparator analysis, is not held to it.
  assert.deepEqual(vcrStudyPackageFindings(pkg({ ...base })).issues.filter((issue) => issue.check === "vcr-package-cover"), []);
  assert.ok(found_all_advisory(vcrStudyPackageFindings(pkg({ ...base }, { "study-package.md": "封面" }))));
});

/** @param {{ issues: { severity: string }[] }} found */
const found_all_advisory = (found) => found.issues.every((issue) => issue.severity === "advisory");

test("a not-estimable package says exactly which field is missing", () => {
  const found = vcrStudyPackageFindings(pkg({ conclusion: "not_estimable", counts: { realPatients: 0, events: 0, effectiveSampleSize: null, generatedRecords: 0 } }));
  const notice = found.issues.find((issue) => issue.code === "vcr_not_estimable_rule_missing");
  assert.ok(notice);
  assert.match(notice.message, /notEstimableRule/);
  assert.match(notice.message, /entropy_balance_infeasible/, "and what the field may hold");
  const wrong = vcrStudyPackageFindings(pkg({ conclusion: "not_estimable", notEstimableRule: "because", counts: { realPatients: 0, events: 0, effectiveSampleSize: null, generatedRecords: 0 } }));
  assert.match(wrong.issues.find((issue) => issue.code === "vcr_not_estimable_rule_missing")?.message ?? "", /「because」/);
});

test("the matching contract is untouched: unanchored judgments and a contradicted summary are still noticed", () => {
  const files = new Map([["matching.json", JSON.stringify({ summary: "eligible", judgments: [{ criterionId: "c", kind: "exclusion", state: "unknown" }] })]]);
  const found = vcrMatchingFindings({ files });
  assert.ok(found.issues.some((issue) => issue.code === "vcr_summary_contradicted"));
});
