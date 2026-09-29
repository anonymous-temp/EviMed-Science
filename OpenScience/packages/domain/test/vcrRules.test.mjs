import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  VCR_REQUIREMENT_LIMITS,
  VCR_ROW_RULE_LIMITS,
  VCR_ROW_RULE_OPS,
  evaluateRowRule,
  evaluateRowRuleColumn,
  findExpressionFields,
  validateNamedRules,
  validateRequirement,
  validateRowRule,
} from "@evimed/domain";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/vcr-row-rules.json", import.meta.url), "utf8"));

// --- the parity fixture ------------------------------------------------------
// The same file is read by the engine's N00 case. If the two sides ever
// disagree about what a rule means, one of the two runs goes red on the same
// line of this file.

test("the parity fixture is large enough and walks every op and every verdict", () => {
  assert.ok(fixture.valid.length >= 40, `only ${fixture.valid.length} valid cases`);
  assert.ok(fixture.invalid.length >= 15, `only ${fixture.invalid.length} invalid cases`);
  const ops = new Set();
  const verdicts = new Set();
  const visit = (/** @type {any} */ node) => {
    if (!node || typeof node !== "object") return;
    if (node.op) ops.add(node.op);
    (node.operands ?? []).forEach(visit);
    visit(node.operand);
  };
  for (const item of fixture.valid) {
    visit(item.rule);
    item.expected.forEach((/** @type {string} */ verdict) => verdicts.add(verdict));
    assert.equal(item.rows.length, item.expected.length, `${item.name}: one verdict per row`);
  }
  assert.deepEqual([...ops].sort(), [...VCR_ROW_RULE_OPS].sort(), "every op appears in a valid case");
  assert.deepEqual([...verdicts].sort(), ["FALSE", "NA", "TRUE"]);
  assert.ok(fixture.invalid.some((/** @type {any} */ item) => item.issue === "rule_expression_forbidden"));
  assert.ok(fixture.invalid.some((/** @type {any} */ item) => item.issue === "rule_column_unknown"));
  assert.ok(fixture.invalid.some((/** @type {any} */ item) => item.issue === "rule_too_deep"));
  assert.ok(fixture.invalid.some((/** @type {any} */ item) => item.issue === "rule_too_large"));
  assert.ok(fixture.invalid.some((/** @type {any} */ item) => item.issue === "rule_op_unknown"));
  assert.equal(fixture.limits.maxDepth, VCR_ROW_RULE_LIMITS.maxDepth, "the fixture states the limits it was written against");
  assert.equal(fixture.limits.maxNodes, VCR_ROW_RULE_LIMITS.maxNodes);
});

test("every valid fixture rule validates against its table and evaluates to the written verdicts", () => {
  for (const item of fixture.valid) {
    assert.deepEqual(validateRowRule(item.rule, { columns: item.columns }), [], `${item.name}: refused`);
    assert.deepEqual(evaluateRowRuleColumn(item.rule, item.rows), item.expected, item.name);
  }
});

test("every invalid fixture rule is refused with exactly one issue, naming the code and the path", () => {
  for (const item of fixture.invalid) {
    const issues = validateRowRule(item.rule, { columns: item.columns });
    assert.deepEqual(issues.map((issue) => [issue.code, issue.field]), [[item.issue, item.path]], item.name);
  }
});

test("the fixture's non-finite spelling, 1e999, reaches the validator as an infinity", () => {
  const hasInfinity = (/** @type {any} */ node) => typeof node === "number" ? node === Number.POSITIVE_INFINITY
    : node !== null && typeof node === "object" && Object.values(node).some(hasInfinity);
  const spelled = fixture.invalid.filter((/** @type {any} */ item) => hasInfinity(item.rule));
  assert.equal(spelled.length, 3, "value, bound and listed value");
});

// --- validation, directly ----------------------------------------------------

test("non-finite numbers built in code are refused as values, bounds and list members", () => {
  const rule = (/** @type {any} */ body) => validateRowRule({ column: "age", ...body });
  assert.equal(rule({ op: "compare", comparator: "gt", value: Number.POSITIVE_INFINITY })[0]?.field, "value");
  assert.equal(rule({ op: "compare", comparator: "eq", value: Number.NaN })[0]?.field, "value");
  assert.equal(rule({ op: "between", low: 1, high: Number.POSITIVE_INFINITY })[0]?.field, "high");
  assert.equal(rule({ op: "in", values: [Number.NEGATIVE_INFINITY] })[0]?.field, "values[0]");
});

test("a rule is checked without the table when no columns are given, and a column check names the column", () => {
  assert.deepEqual(validateRowRule({ op: "present", column: "anything_at_all" }), []);
  const issues = validateRowRule({ op: "present", column: "ghost" }, { columns: ["age"] });
  assert.deepEqual(issues.map((issue) => issue.code), ["rule_column_unknown"]);
  assert.match(issues[0].detail, /ghost/);
});

test("a rule embedded in a larger document reports the path it lives at", () => {
  const issues = validateRowRule({ op: "all", operands: [{ op: "present", column: "a" }, { op: "nope" }] }, { path: "scenario.rules[2].rule" });
  assert.deepEqual(issues.map((issue) => issue.field), ["scenario.rules[2].rule.operands[1].op"]);
});

test("the validator walks a bounded amount, however hostile the rule", () => {
  /** @type {any} */
  const cyclic = { op: "not" };
  cyclic.operand = cyclic;
  const issues = validateRowRule(cyclic);
  assert.deepEqual(issues.map((issue) => issue.code), ["rule_too_deep"]);
  const wide = { op: "all", operands: Array.from({ length: 32 }, () => ({ op: "all", operands: Array.from({ length: 32 }, () => ({ op: "present", column: "a" })) })) };
  assert.deepEqual(validateRowRule(wide).map((issue) => issue.code), ["rule_too_large"]);
});

test("a prototype key or a dotted path cannot smuggle a column past the pattern", () => {
  for (const column of ["__proto__", "constructor", "a b", "a-b", "a\nb", "a/b", "", "é"]) {
    const issues = validateRowRule({ op: "present", column: column }, { columns: ["age"] });
    assert.equal(issues.length, 1, JSON.stringify(column));
    assert.ok(["rule_shape_invalid", "rule_column_unknown"].includes(issues[0].code), JSON.stringify(column));
  }
  // `__proto__` is a legal column name by the pattern; only the table decides.
  assert.deepEqual(validateRowRule({ op: "present", column: "__proto__" }, { columns: ["__proto__"] }), []);
});

test("named rules carry a name of 1 to 80 characters and a rule, and an expression is refused by name", () => {
  const ok = [{ name: "adult", rule: { op: "compare", column: "age", comparator: "gte", value: 18 } }];
  assert.deepEqual(validateNamedRules(ok, { path: "scenario.rules", columns: ["age"] }), []);
  const codes = (/** @type {any} */ items, /** @type {any} */ options = {}) => validateNamedRules(items, { path: "rules", ...options }).map((issue) => `${issue.code}@${issue.field}`);
  assert.deepEqual(codes([{ name: "", rule: ok[0].rule }]), ["rule_shape_invalid@rules[0].name"]);
  assert.deepEqual(codes([{ name: "x".repeat(81), rule: ok[0].rule }]), ["rule_shape_invalid@rules[0].name"]);
  assert.deepEqual(codes([{ name: "adult" }]), ["rule_shape_invalid@rules[0].rule"]);
  assert.deepEqual(codes([{ name: "adult", expression: "age >= 18" }]), ["rule_expression_forbidden@rules[0]"]);
  assert.deepEqual(codes([{ name: "adult", rule: ok[0].rule, note: "x" }]), ["rule_shape_invalid@rules[0].note"]);
  assert.deepEqual(codes([]), ["rule_shape_invalid@rules"]);
  assert.deepEqual(codes([], { allowEmpty: true }), []);
  assert.deepEqual(codes("adult"), ["rule_shape_invalid@rules"]);
  assert.deepEqual(codes([{ name: "a", rule: { op: "present", column: "ghost" } }], { columns: ["age"] }), ["rule_column_unknown@rules[0].rule.column"]);
});

test("an expression field is found anywhere in a scenario, and only by name", () => {
  const scenario = { design: { kind: "x" }, rules: [{ name: "a", rule: { op: "present", column: "c" } }, { name: "b", expression: "age > 1" }], nested: { deeper: [{ expression: "1" }] } };
  assert.deepEqual(findExpressionFields(scenario, { path: "scenario" }), ["scenario.rules[1]", "scenario.nested.deeper[0]"]);
  assert.deepEqual(findExpressionFields({ expression: "1" }), [""], "the root is the empty path");
  assert.deepEqual(findExpressionFields({ note: "expression in a value is not a key" }), []);
  /** @type {any} */
  const cyclic = { a: {} };
  cyclic.a.b = cyclic;
  assert.deepEqual(findExpressionFields(cyclic), []);
});

// --- evaluation, directly ----------------------------------------------------

test("a missing cell, a NaN and an absent key all read as missing", () => {
  const rule = { op: "compare", column: "x", comparator: "gt", value: 1 };
  assert.equal(evaluateRowRule(rule, { x: null }), null);
  assert.equal(evaluateRowRule(rule, { x: undefined }), null);
  assert.equal(evaluateRowRule(rule, { x: Number.NaN }), null);
  assert.equal(evaluateRowRule(rule, {}), null);
  assert.equal(evaluateRowRule({ op: "missing", column: "x" }, { x: Number.NaN }), true);
  assert.equal(evaluateRowRule({ op: "present", column: "x" }, {}), false);
  assert.equal(evaluateRowRule({ op: "present", column: "constructor" }, {}), false, "an inherited property is not a cell");
  assert.equal(evaluateRowRule({ op: "present", column: "__proto__" }, {}), false);
});

test("Kleene logic: FALSE beats NA under all, TRUE beats NA under any, and NA survives not", () => {
  const na = { op: "compare", column: "x", comparator: "gt", value: 1 };
  const yes = { op: "present", column: "y" };
  const no = { op: "missing", column: "y" };
  const row = { x: null, y: 1 };
  assert.equal(evaluateRowRule({ op: "all", operands: [na, yes] }, row), null);
  assert.equal(evaluateRowRule({ op: "all", operands: [na, no] }, row), false);
  assert.equal(evaluateRowRule({ op: "any", operands: [na, no] }, row), null);
  assert.equal(evaluateRowRule({ op: "any", operands: [na, yes] }, row), true);
  assert.equal(evaluateRowRule({ op: "not", operand: na }, row), null);
});

test("evaluation throws only on a node the validator would have refused", () => {
  assert.throws(() => evaluateRowRule({ op: "xor" }, {}), TypeError);
  assert.throws(() => evaluateRowRule(null, {}), TypeError);
  assert.throws(() => evaluateRowRule({ op: "compare", column: "x", comparator: "approx", value: 1 }, { x: 1 }), TypeError);
});

// --- eligibility requirements ------------------------------------------------

const requirementIssues = (/** @type {any} */ requirement) => validateRequirement(requirement).map((issue) => `${issue.code}@${issue.field}`);

test("the requirement grammar accepts each shape the matching skill teaches", () => {
  const valid = [
    { op: "present", variable: "myocardial_infarction", window: { months: 6 } },
    { op: "absent", variable: "brain_metastasis" },
    { op: "compare", variable: "hemoglobin", comparator: "gte", value: 90, unit: "g/L", window: { days: 28 }, aggregate: "latest" },
    { op: "compare", variable: "ecog", comparator: "between", value: 0, highValue: 1 },
    { op: "compare", variable: "histology", comparator: "in", value: ["adenocarcinoma", "squamous"] },
    { op: "compare", variable: "egfr_status", comparator: "eq", value: "mutant" },
    { op: "compare", variable: "hbv", comparator: "not_in", value: [1, 2] },
    { op: "elapsed_since", variable: "docetaxel", days: 28 },
    { op: "language", text: "预期生存期至少 12 周" },
    { op: "all", operands: [
      { op: "present", variable: "nsclc" },
      { op: "not", operand: { op: "any", operands: [{ op: "present", variable: "a" }, { op: "absent", variable: "b" }] } },
    ] },
  ];
  for (const requirement of valid) assert.deepEqual(requirementIssues(requirement), [], JSON.stringify(requirement));
});

test("a malformed requirement is refused with a named code and the path of the defect", () => {
  const cases = /** @type {[string, any, string[]][]} */ ([
    ["unknown op", { op: "matches", variable: "a" }, ["rule_op_unknown@op"]],
    ["no op", { variable: "a" }, ["rule_shape_invalid@op"]],
    ["null", null, ["rule_shape_invalid@"]],
    ["an expression", { op: "present", variable: "a", expression: "1" }, ["rule_expression_forbidden@"]],
    ["all without operands", { op: "all" }, ["rule_shape_invalid@operands"]],
    ["all with 33 operands", { op: "all", operands: Array.from({ length: 33 }, () => ({ op: "present", variable: "a" })) }, ["rule_shape_invalid@operands"]],
    ["a variable that is not a name", { op: "present", variable: "Bad Name" }, ["rule_shape_invalid@variable"]],
    ["a variable with a capital", { op: "present", variable: "ECOG" }, ["rule_shape_invalid@variable"]],
    ["a window with both units", { op: "present", variable: "a", window: { days: 3, months: 1 } }, ["rule_shape_invalid@window"]],
    ["a window of zero days", { op: "present", variable: "a", window: { days: 0 } }, ["rule_shape_invalid@window.days"]],
    ["a window over the cap", { op: "present", variable: "a", window: { months: 1201 } }, ["rule_shape_invalid@window.months"]],
    ["a fractional window", { op: "present", variable: "a", window: { days: 1.5 } }, ["rule_shape_invalid@window.days"]],
    ["compare without a comparator", { op: "compare", variable: "a", value: 1 }, ["rule_shape_invalid@comparator"]],
    ["compare with a comparator outside the list", { op: "compare", variable: "a", comparator: "approx", value: 1 }, ["rule_shape_invalid@comparator"]],
    ["a numeric comparator with a string", { op: "compare", variable: "a", comparator: "gte", value: "90" }, ["rule_shape_invalid@value"]],
    ["a numeric comparator with an infinity", { op: "compare", variable: "a", comparator: "lt", value: Number.POSITIVE_INFINITY }, ["rule_shape_invalid@value"]],
    ["between without a highValue", { op: "compare", variable: "a", comparator: "between", value: 1 }, ["rule_shape_invalid@highValue"]],
    ["between with highValue below value", { op: "compare", variable: "a", comparator: "between", value: 5, highValue: 1 }, ["rule_shape_invalid@highValue"]],
    ["a highValue on a comparator that takes none", { op: "compare", variable: "a", comparator: "gt", value: 1, highValue: 2 }, ["rule_shape_invalid@highValue"]],
    ["in with a scalar", { op: "compare", variable: "a", comparator: "in", value: "x" }, ["rule_shape_invalid@value"]],
    ["in with an empty list", { op: "compare", variable: "a", comparator: "in", value: [] }, ["rule_shape_invalid@value"]],
    ["in with a boolean in the list", { op: "compare", variable: "a", comparator: "in", value: ["x", true] }, ["rule_shape_invalid@value[1]"]],
    ["eq with a list", { op: "compare", variable: "a", comparator: "eq", value: ["x"] }, ["rule_shape_invalid@value"]],
    ["eq with a boolean", { op: "compare", variable: "a", comparator: "eq", value: true }, ["rule_shape_invalid@value"]],
    ["a unit that is a number", { op: "compare", variable: "a", comparator: "gt", value: 1, unit: 5 }, ["rule_shape_invalid@unit"]],
    ["an aggregate outside the list", { op: "compare", variable: "a", comparator: "gt", value: 1, aggregate: "mean" }, ["rule_shape_invalid@aggregate"]],
    ["elapsed_since without days", { op: "elapsed_since", variable: "a" }, ["rule_shape_invalid@days"]],
    ["elapsed_since over ten years", { op: "elapsed_since", variable: "a", days: 3651 }, ["rule_shape_invalid@days"]],
    ["elapsed_since with a comparator the grammar does not carry", { op: "elapsed_since", variable: "a", days: 5, comparator: "lt" }, ["rule_shape_invalid@comparator"]],
    ["deniedSatisfies that is not a boolean", { op: "elapsed_since", variable: "a", days: 5, deniedSatisfies: "no" }, ["rule_shape_invalid@deniedSatisfies"]],
    ["a language key with a space", { op: "language", text: "有能力签署知情同意", key: "consent ok" }, ["rule_shape_invalid@key"]],
    ["a window with two units", { op: "present", variable: "a", window: { days: 3, years: 1 } }, ["rule_shape_invalid@window"]],
    ["an anchorDate that is not a date", { op: "present", variable: "a", window: { months: 6, anchorDate: "last spring" } }, ["rule_shape_invalid@window.anchorDate"]],
    ["language without text", { op: "language" }, ["rule_shape_invalid@text"]],
    ["language with empty text", { op: "language", text: "" }, ["rule_shape_invalid@text"]],
    ["language with 501 characters", { op: "language", text: "x".repeat(501) }, ["rule_shape_invalid@text"]],
    ["a stray key", { op: "absent", variable: "a", note: "x" }, ["rule_shape_invalid@note"]],
    ["a defect deep in the tree", { op: "all", operands: [{ op: "present", variable: "a" }, { op: "not", operand: { op: "compare", variable: "b", comparator: "gt", value: "x" } }] }, ["rule_shape_invalid@operands[1].operand.value"]],
  ]);
  for (const [name, requirement, expected] of cases) assert.deepEqual(requirementIssues(requirement), expected, name);
});

test("the evaluator's own knobs are part of the grammar: years, an anchor date, a strict washout, a denial that does not count, a language key", () => {
  // Each carries a clinical meaning the protocol needs, and each is read by
  // the evaluator in apps/server/src/vcrMatching.mjs.
  for (const requirement of [
    { op: "present", variable: "stroke", window: { years: 5 } },
    { op: "absent", variable: "pregnancy", window: { months: 12, anchorDate: "2026-11-03" } },
    { op: "elapsed_since", variable: "docetaxel", days: 28, comparator: "gt" },
    { op: "elapsed_since", variable: "anti_pd1", days: 90, deniedSatisfies: false },
    { op: "language", text: "研究者判断能耐受化疗", key: "crt-12" },
  ]) assert.deepEqual(requirementIssues(requirement), [], JSON.stringify(requirement));
});

test("requirements are bounded by depth and size like row rules", () => {
  let deep = { op: "present", variable: "a" };
  for (let i = 0; i < VCR_REQUIREMENT_LIMITS.maxDepth; i += 1) deep = /** @type {any} */ ({ op: "not", operand: deep });
  assert.deepEqual(requirementIssues(deep), [`rule_too_deep@${Array.from({ length: 8 }, () => "operand").join(".")}`]);
  const wide = { op: "all", operands: Array.from({ length: 32 }, () => ({ op: "all", operands: Array.from({ length: 32 }, () => ({ op: "present", variable: "a" })) })) };
  assert.deepEqual(requirementIssues(wide).map((issue) => issue.split("@")[0]), ["rule_too_large"]);
});
