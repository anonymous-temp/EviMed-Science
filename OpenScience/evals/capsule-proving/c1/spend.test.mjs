import assert from "node:assert/strict";
import test from "node:test";
import { receiptTotals } from "./spend.mjs";

test("lane spend includes paid retries and all episode rows, ignores cached answers, and uses the peak ceiling", () => {
  const learning = [
    { promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 },
    { promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 },
    { cached: true },
  ];
  const result = receiptTotals(learning, [{ promptTokens: 0, cachedPromptTokens: 0, completionTokens: 1_000_000, steps: 2 }]);
  assert.equal(result.peakCostUpperCny, 10.04);
  assert.equal(result.calls, 4);
  assert.equal(result.promptTokens, 2_000_000);
  assert.throws(() => receiptTotals([{ promptTokens: 1, cachedTokens: 2, completionTokens: 0 }], []), /Unreadable usage/);
});
