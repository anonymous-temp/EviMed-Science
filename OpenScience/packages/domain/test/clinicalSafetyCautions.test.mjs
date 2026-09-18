import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CLINICAL_SAFETY_CAUTION_CHECK,
  CLINICAL_SAFETY_CAUTION_RULES,
  clinicalSafetyCautionHits,
  compileCautionRules,
} from "../src/safetyRules.mjs";

/** @param {string} relative @returns {Promise<any>} */
const read = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const rulesDocument = await read("../src/clinical-safety-rules.json");
const schema = await read("../src/clinical-safety-rules.schema.json");
const { cases } = await read("./fixtures/clinical-safety-cautions.json");

/** @param {{ question?: string, report: string }} input */
const fired = (input) => clinicalSafetyCautionHits({ question: input.question, reportText: input.report }).map((hit) => hit.ruleId).sort();

test("every case fires exactly the rules it expects", () => {
  assert.ok(cases.length >= 2 * CLINICAL_SAFETY_CAUTION_RULES.length, "fewer cases than two per rule");
  for (const entry of cases) {
    assert.deepEqual(fired(entry), [...entry.expect].sort(), `${entry.rule}: ${entry.note}`);
  }
});

test("every rule has a case where it fires and a case where it does not", () => {
  assert.ok(CLINICAL_SAFETY_CAUTION_RULES.length >= 20 && CLINICAL_SAFETY_CAUTION_RULES.length <= 40);
  for (const rule of CLINICAL_SAFETY_CAUTION_RULES) {
    assert.ok(cases.some((/** @type {any} */ entry) => entry.rule === rule.id && entry.expect.includes(rule.id)), `${rule.id} never fires in the fixtures`);
    assert.ok(cases.some((/** @type {any} */ entry) => entry.rule === rule.id && !entry.expect.includes(rule.id)), `${rule.id} has no negative case`);
  }
});

test("the aspirin brief of 2026-09-18 is covered", () => {
  // The run behind the review: 「≥70 岁阿司匹林一级预防 + ADR」 matched none of
  // the four rules the file held. A report that never mentions the cautions
  // now draws both notices; one that states them draws none.
  const question = "≥70 岁阿司匹林一级预防 + ADR";
  assert.deepEqual(fired({ question, report: "# 证据摘要\n\n本报告检索了相关随机对照试验与指南。" }),
    ["aspirin-primary-prevention-bleeding", "aspirin-primary-prevention-older-adults"]);
  assert.deepEqual(fired({ question, report: "ASPREE 试验中阿司匹林增加大出血；USPSTF 2022 不推荐 60 岁及以上人群启用。" }), []);
});

test("a hit carries what a reader and a ledger need", () => {
  const [hit] = clinicalSafetyCautionHits({ reportText: "华法林与氯吡格雷联用于冠心病合并房颤患者。" });
  assert.equal(hit.check, CLINICAL_SAFETY_CAUTION_CHECK);
  assert.equal(hit.ruleId, "anticoagulant-with-antiplatelet-or-nsaid");
  assert.match(hit.titleZh, /出血/);
  assert.match(hit.messageZh, /出血/);
  assert.deepEqual(hit.matched, [["华法林"], ["氯吡格雷"]]);
  assert.ok(hit.evidence.every((entry) => entry.url.startsWith("https://")));
  assert.deepEqual(clinicalSafetyCautionHits({ reportText: "" }), []);
});

test("a caution is advice, phrased as what to add", () => {
  for (const rule of CLINICAL_SAFETY_CAUTION_RULES) {
    assert.match(rule.messageZh, /请写明/, `${rule.id} must tell the reader what the report should mention`);
    assert.doesNotMatch(rule.messageZh, /不得|禁止撰写|不能写/, `${rule.id} must not forbid wording`);
  }
});

test("the rules file satisfies its schema", () => {
  assert.deepEqual(validate(schema, rulesDocument, schema), []);
});

test("a malformed caution is refused at load, naming the rule", () => {
  const valid = {
    id: "x-rule", family: "drug-scenario", titleZh: "测试", message: "The report discusses x and never mentions y; state y.", messageZh: "请写明 y。",
    when: [["甲药"]], mention: ["乙风险"], evidence: [{ authority: "A", url: "https://example.org/a" }],
  };
  /** @param {Record<string, any>} overrides */
  const load = (overrides) => compileCautionRules({ cautionRules: [{ ...valid, ...overrides }] });
  assert.equal(load({}).length, 1);
  assert.throws(() => load({ when: [["@nowhere"]] }), /unknown vocabulary @nowhere/);
  assert.throws(() => load({ when: [["肾功能不全"]], mention: ["肾功能"] }), /can never be missing/);
  assert.throws(() => load({ evidence: [{ authority: "A", url: "http://example.org" }] }), /https url/);
  assert.throws(() => load({ scope: "sentence" }), /scope must be/);
  assert.throws(() => load({ when: [{ anyOf: ["甲药"], minDistinct: 0 }] }), /minDistinct/);
  assert.throws(() => compileCautionRules({ cautionRules: [valid, valid] }), /repeats an id/);
  assert.throws(() => load({ messageZh: "" }), /missing messageZh/);
});

/**
 * A validator for the subset of JSON Schema the rules schema uses, so the
 * schema a pharmacist's editor enforces is the one CI enforces too.
 * @param {any} node @param {any} value @param {any} root @param {string} [at]
 * @returns {string[]}
 */
function validate(node, value, root, at = "$") {
  if (node.$ref) return validate(node.$ref.split("/").slice(1).reduce((/** @type {any} */ found, /** @type {string} */ key) => found[key], root), value, root, at);
  const errors = [];
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;
  if (node.type && !(node.type === kind || (node.type === "number" && kind === "integer"))) return [`${at}: expected ${node.type}, got ${kind}`];
  if ("const" in node && value !== node.const) errors.push(`${at}: expected ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${node.enum.join(", ")}`);
  if (typeof value === "string") {
    if (node.minLength != null && value.length < node.minLength) errors.push(`${at}: shorter than ${node.minLength}`);
    if (node.maxLength != null && value.length > node.maxLength) errors.push(`${at}: longer than ${node.maxLength}`);
    if (node.pattern && !new RegExp(node.pattern, "u").test(value)) errors.push(`${at}: does not match ${node.pattern}`);
  }
  if (typeof value === "number") {
    if (node.minimum != null && value < node.minimum) errors.push(`${at}: below ${node.minimum}`);
    if (node.maximum != null && value > node.maximum) errors.push(`${at}: above ${node.maximum}`);
  }
  if (Array.isArray(value)) {
    if (node.minItems != null && value.length < node.minItems) errors.push(`${at}: fewer than ${node.minItems} items`);
    if (node.items) value.forEach((item, index) => errors.push(...validate(node.items, item, root, `${at}[${index}]`)));
  }
  if (kind === "object") {
    for (const key of node.required ?? []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (node.properties?.[key]) errors.push(...validate(node.properties[key], item, root, `${at}.${key}`));
      else if (node.additionalProperties === false) errors.push(`${at}: unexpected ${key}`);
      else if (node.additionalProperties && typeof node.additionalProperties === "object") errors.push(...validate(node.additionalProperties, item, root, `${at}.${key}`));
    }
  }
  if (node.oneOf) {
    const passing = node.oneOf.filter((/** @type {any} */ option) => validate(option, value, root, at).length === 0).length;
    if (passing !== 1) errors.push(`${at}: matches ${passing} of the oneOf forms, not exactly one`);
  }
  return errors;
}
