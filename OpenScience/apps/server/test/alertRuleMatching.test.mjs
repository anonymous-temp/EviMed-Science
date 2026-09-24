// An alert that compares two series of one counter told apart by a label —
// failed against done, failed against called — must aggregate them first.
//
// PromQL matches the two sides of a binary operator on their whole label
// set, and `increase()` keeps the `outcome` label, so
// `increase(x{outcome="failed"}[1h]) > increase(x{outcome="done"}[1h])` never
// finds a pair and returns nothing: the alert can never fire, and nothing
// says so. The reviewer's two alerts shipped that way on 2026-09-23 and were
// found while adding the third (2026-09-24). Every other ratio in the file
// already wraps both sides in `sum(...)`.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** `increase(metric{labels}[range])` or `rate(…)`, and whether a `sum(` opens right before it. */
const TERM = /(sum\s*\(\s*)?(?:increase|rate)\(\s*([a-z_:][a-z0-9_:]*)\{([^}]*)\}\[[^\]]+\]\s*\)/g;

/**
 * The terms of an expression that are compared across label values without
 * being aggregated: one metric selected under two different label sets, one
 * of them not inside `sum(`, in an expression with no `on(`/`ignoring(`.
 * @param {string} expr @returns {string[]}
 */
function unmatchedComparisons(expr) {
  if (/\b(?:on|ignoring)\s*\(/.test(expr)) return [];
  /** @type {Map<string, { labels: Set<string>, bare: boolean }>} */
  const metrics = new Map();
  for (const [, summed, metric, labels] of expr.matchAll(TERM)) {
    const entry = metrics.get(metric) ?? { labels: new Set(), bare: false };
    entry.labels.add(labels.replace(/\s+/g, ""));
    if (!summed) entry.bare = true;
    metrics.set(metric, entry);
  }
  return [...metrics].filter(([, entry]) => entry.labels.size > 1 && entry.bare).map(([metric]) => metric);
}

test("the matcher sees the defect it exists for", () => {
  // The 2026-09-23 expression, verbatim: it could never fire.
  const shipped = "increase(open_science_review_reply_checks_total{outcome=\"failed\"}[1h]) >= 3 and increase(open_science_review_reply_checks_total{outcome=\"failed\"}[1h]) > increase(open_science_review_reply_checks_total{outcome=\"done\"}[1h])";
  assert.deepEqual(unmatchedComparisons(shipped), ["open_science_review_reply_checks_total"]);
  assert.deepEqual(unmatchedComparisons("sum(increase(x_total{outcome=\"failed\"}[1h])) > sum(increase(x_total{outcome=\"done\"}[1h]))"), []);
  assert.deepEqual(unmatchedComparisons("increase(x_total{a=\"1\"}[1h]) / ignoring(a) increase(x_total{a=\"2\"}[1h])"), []);
});

test("no alert compares a counter's series across label values without aggregating them", async () => {
  const rules = JSON.parse(await readFile(path.join(repoRoot, "deploy/web/monitoring/open-science.rules.json"), "utf8"));
  const alerts = rules.groups.flatMap((/** @type {any} */ group) => group.rules);
  let scanned = 0;
  for (const rule of alerts) {
    scanned += [...String(rule.expr).matchAll(TERM)].length;
    assert.deepEqual(unmatchedComparisons(String(rule.expr)), [], `${rule.alert} compares series with different labels that can never match`);
  }
  assert.ok(scanned >= 10, `only ${scanned} counter terms were read; the scan is wrong, not the rules`);
  const review = rules.groups.find((/** @type {any} */ group) => group.name === "evimed-review");
  assert.ok(review?.rules.some((/** @type {any} */ rule) => rule.alert === "ReviewJevFailing"), "the reviewer group carries the first pass's alert");
});
