// `scripts/ops/frontier-regroup.mjs` (fr-events 2026-10-22): its arguments, and what its report says asking would cost.
// What it does is `FrontierEvents.regroupRecent`, which `frontierEvents.integration.test.mjs` holds against a real database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REFERENCE_PRICE_LIST } from "@evimed/domain";
import { estimateRegroupCost, GROUP_CALL_TOKENS, parseArguments } from "../../../scripts/ops/frontier-regroup.mjs";

test("the report is the default; --apply asks; the window is at most the recall's fourteen days, or where a stopped run resumes", () => {
  assert.deepEqual(parseArguments([]), { apply: false, days: 14, since: null, concurrency: 4, limit: 100_000 });
  const options = parseArguments(["--apply", "--days", "3", "--concurrency", "2", "--limit", "500"]);
  assert.deepEqual({ ...options }, { apply: true, days: 3, since: null, concurrency: 2, limit: 500 });
  assert.equal(parseArguments(["--since", "2026-10-15T04:00:00Z"]).since?.toISOString(), "2026-10-15T04:00:00.000Z");
  assert.throws(() => parseArguments(["--days", "15"]), /--days/);
  assert.throws(() => parseArguments(["--concurrency", "0"]), /--concurrency/);
  assert.throws(() => parseArguments(["--since", "yesterday"]), /--since/);
  assert.throws(() => parseArguments(["--all"]), /unknown argument/);
});

test("the cost: one call per item with candidates, its size by candidate, at the reference deepseek-flash row", () => {
  const price = REFERENCE_PRICE_LIST.model["deepseek-flash"];
  assert.deepEqual(estimateRegroupCost({ withCandidates: 0, candidateEvents: 0 }, price).cny, 0);
  const day = estimateRegroupCost({ withCandidates: 1_276, candidateEvents: 7_337 }, price);
  assert.equal(day.calls, 1_276);
  assert.equal(day.promptTokens, 1_276 * (GROUP_CALL_TOKENS.cached + GROUP_CALL_TOKENS.report) + 7_337 * GROUP_CALL_TOKENS.perCandidate);
  assert.ok(day.cny > 1 && day.cny < 300, `a production day costs a fraction of the module's ¥300 (${day.cny})`);
  assert.ok(day.pairCnyPerThousand > 0);
});
