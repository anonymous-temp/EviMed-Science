// JevFailing, evaluated. The rule compares a site's failures with its answers, and in PromQL a comparison between two
// vectors keeps only the labels both sides have: a site whose counter never reached `answered` has no element on the
// right, the comparison finds nothing to compare with, and the alert stays silent for exactly the site that most needs
// it — one that has never answered once. (`ReviewJevFailing` ended `> (sum(answered) or vector(0))` for this reason;
// the per-site rule that replaced it lost the fallback.)
//
// There is no promtool here, so this evaluates the rule text with a small interpreter of the subset the rule uses
// (`sum by (…)`, `increase(selector[range])`, `*`, `>`, `>=`, `and`, `or`, parentheses) and PromQL's one-to-one matching
// on the whole label set. It reads the rule from the shipped file, so an edit to the rule is what is under test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** @typedef {{ labels: Record<string, string>, value: number }} Element */
/** @typedef {number | Element[]} Value */
/** @typedef {{ metric: string, labels: Record<string, string>, increase: number }} Series */

/** @param {Record<string, string>} labels */
const identity = (labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

/**
 * @param {string} expr
 * @param {Series[]} series the counters, and by how much each rose over the range
 * @returns {Element[]} the instant vector the rule evaluates to
 */
function evaluate(expr, series) {
  const tokens = [...expr.matchAll(/\s*(>=|>|\*|\(|\)|\{|\}|\[|\]|,|=|"[^"]*"|[A-Za-z_:][A-Za-z0-9_:]*|\d+(?:\.\d+)?[a-z]?)/g)].map((match) => match[1]);
  assert.equal(tokens.join("").length, expr.replace(/\s+/g, "").length, "the interpreter understood every character of the rule");
  let at = 0;
  const peek = () => tokens[at];
  const take = (/** @type {string} */ expected) => { assert.equal(tokens[at], expected, `expected ${expected} at token ${at}`); at += 1; };
  /** @param {Value} left @param {Value} right @param {(a: number, b: number) => boolean} keep @returns {Value} */
  const compare = (left, right, keep) => {
    assert.ok(Array.isArray(left), "a comparison keeps elements of a vector");
    if (typeof right === "number") return left.filter((element) => keep(element.value, right));
    const byLabels = new Map(right.map((element) => [identity(element.labels), element]));
    return left.filter((element) => { const other = byLabels.get(identity(element.labels)); return other !== undefined && keep(element.value, other.value); });
  };
  /** @returns {Value} */
  const unary = () => {
    const token = peek();
    if (token === "(") { take("("); const inner = or(); take(")"); return inner; }
    if (/^\d/.test(token)) { at += 1; return Number(token); }
    if (token === "sum") {
      take("sum"); take("by"); take("(");
      const by = [];
      while (peek() !== ")") { by.push(tokens[at]); at += 1; if (peek() === ",") take(","); }
      take(")"); take("(");
      const inner = or();
      take(")");
      assert.ok(Array.isArray(inner));
      const groups = new Map();
      for (const element of inner) {
        const labels = Object.fromEntries(by.filter((label) => label in element.labels).map((label) => [label, element.labels[label]]));
        const entry = groups.get(identity(labels)) ?? { labels, value: 0 };
        entry.value += element.value;
        groups.set(identity(labels), entry);
      }
      return [...groups.values()];
    }
    if (token === "increase") {
      take("increase"); take("(");
      const metric = tokens[at]; at += 1;
      const matchers = {};
      take("{");
      while (peek() !== "}") { const name = tokens[at]; at += 1; take("="); matchers[name] = tokens[at].slice(1, -1); at += 1; if (peek() === ",") take(","); }
      take("}"); take("["); at += 1; take("]"); take(")");
      return series.filter((item) => item.metric === metric && Object.entries(matchers).every(([name, value]) => item.labels[name] === value))
        .map((item) => ({ labels: item.labels, value: item.increase }));
    }
    throw new Error(`unsupported token ${token}`);
  };
  const multiplicative = () => {
    let left = unary();
    while (peek() === "*") { take("*"); const right = unary(); assert.ok(Array.isArray(left) && typeof right === "number"); left = left.map((element) => ({ ...element, value: element.value * right })); }
    return left;
  };
  const comparison = () => {
    let left = multiplicative();
    while (peek() === ">=" || peek() === ">") { const operator = tokens[at]; at += 1; left = compare(left, multiplicative(), operator === ">=" ? (a, b) => a >= b : (a, b) => a > b); }
    return left;
  };
  const and = () => {
    let left = comparison();
    while (peek() === "and") {
      take("and");
      const right = comparison();
      assert.ok(Array.isArray(left) && Array.isArray(right));
      const present = new Set(right.map((element) => identity(element.labels)));
      left = left.filter((element) => present.has(identity(element.labels)));
    }
    return left;
  };
  function or() {
    let left = and();
    while (peek() === "or") {
      take("or");
      const right = and();
      assert.ok(Array.isArray(left) && Array.isArray(right));
      const present = new Set(left.map((element) => identity(element.labels)));
      left = [...left, ...right.filter((element) => !present.has(identity(element.labels)))];
    }
    return left;
  }
  const result = or();
  assert.equal(at, tokens.length, "the whole rule was read");
  assert.ok(Array.isArray(result));
  return result;
}

const requests = (/** @type {string} */ site, /** @type {string} */ outcome, /** @type {number} */ increase) =>
  ({ metric: "open_science_jev_requests_total", labels: { site, outcome }, increase });
const firing = (/** @type {string} */ expr, /** @type {Series[]} */ series) => evaluate(expr, series).map((element) => element.labels.site).sort();

/** The expression shipped before the fix, verbatim. */
const SHIPPED_BEFORE_THE_FIX = 'sum by (site) (increase(open_science_jev_requests_total{outcome="failed"}[1h])) >= 3 and sum by (site) (increase(open_science_jev_requests_total{outcome="failed"}[1h])) > sum by (site) (increase(open_science_jev_requests_total{outcome="answered"}[1h]))';

async function shippedRule() {
  const rules = JSON.parse(await readFile(path.join(repoRoot, "deploy/web/monitoring/open-science.rules.json"), "utf8"));
  const rule = rules.groups.flatMap((/** @type {any} */ group) => group.rules).find((/** @type {any} */ item) => item.alert === "JevFailing");
  assert.ok(rule, "the JevFailing alert is shipped");
  return String(rule.expr);
}

test("the interpreter sees the blind spot in the expression that shipped", () => {
  // A site that only ever failed has no `answered` element to be compared with.
  assert.deepEqual(firing(SHIPPED_BEFORE_THE_FIX, [requests("J8", "failed", 5)]), [], "the shipped rule is silent for a site that never answered");
  // And it did work where both series exist, which is why nobody noticed.
  assert.deepEqual(firing(SHIPPED_BEFORE_THE_FIX, [requests("J8", "failed", 5), requests("J8", "answered", 2)]), ["J8"]);
});

test("JevFailing fires for a site that has failed three times and never answered", async () => {
  const expr = await shippedRule();
  assert.deepEqual(firing(expr, [requests("J8", "failed", 5)]), ["J8"], "failures with no answered series at all");
  assert.deepEqual(firing(expr, [requests("J3", "failed", 3), requests("J3", "answered", 0)]), ["J3"], "an answered series that has not risen");
});

test("JevFailing keeps its meaning where both series exist: more failures than answers, three at least, per site", async () => {
  const expr = await shippedRule();
  assert.deepEqual(firing(expr, [requests("J8", "failed", 5), requests("J8", "answered", 6)]), [], "answers outnumber failures");
  assert.deepEqual(firing(expr, [requests("J8", "failed", 5), requests("J8", "answered", 5)]), [], "equal is not more");
  assert.deepEqual(firing(expr, [requests("J8", "failed", 5), requests("J8", "answered", 2)]), ["J8"]);
  assert.deepEqual(firing(expr, [requests("J8", "failed", 2)]), [], "fewer than three failures never fires");
  assert.deepEqual(firing(expr, [requests("J8", "answered", 40)]), [], "no failures, no alert");
  // Requests a site refused (an oversize manuscript, a spent budget) are neither failures nor answers.
  assert.deepEqual(firing(expr, [requests("J8", "refused", 30)]), [], "refusals are not the provider failing");
  // Sites are judged one at a time: a healthy site does not cover for one that never answered.
  assert.deepEqual(firing(expr, [requests("J1", "failed", 4), requests("J1", "answered", 90), requests("J3", "failed", 4)]), ["J3"]);
});
