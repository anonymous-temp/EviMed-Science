import assert from "node:assert/strict";
import test from "node:test";
import { USAGE_PURPOSES } from "@evimed/domain";
import { formatUsageReport, parseArguments } from "../../../scripts/ops/usage-by-purpose.mjs";

function rows(overrides = {}) {
  return USAGE_PURPOSES.map((purpose) => ({
    purpose, requests: 0, cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, costCny: 0, ...overrides[purpose],
  }));
}

test("the host report takes a window in whole days and nothing else", () => {
  assert.deepEqual(parseArguments([]), { days: 7, json: false });
  assert.deepEqual(parseArguments(["--days", "30"]), { days: 30, json: false });
  assert.deepEqual(parseArguments(["--", "--days=1", "--json"]), { days: 1, json: true });
  for (const argv of [["--days", "0"], ["--days", "367"], ["--days", "1.5"], ["--days"], ["--since", "2026-09-01"]]) {
    assert.throws(() => parseArguments(argv), /--days|Unknown argument/, JSON.stringify(argv));
  }
});

test("the host report prints every purpose, its share of the money, and the total", () => {
  const text = formatUsageReport(rows({
    kernel: { requests: 346, cacheHitTokens: 63_000_000, cacheMissTokens: 1_100_000, outputTokens: 330_000, costCny: 3.2 },
    "memory-extraction": { requests: 4, cacheHitTokens: 0, cacheMissTokens: 90_000, outputTokens: 6_000, costCny: 0.8 },
  }), { days: 7, since: "2026-09-13T00:00:00.000Z" });
  const lines = text.split("\n");
  assert.match(lines[0], /last 7 days \(since 2026-09-13T00:00:00\.000Z\)/);
  assert.equal(lines.length, 2 + USAGE_PURPOSES.length + 1, "a header, every purpose, and the total");
  const line = (purpose) => lines.find((item) => item.startsWith(`${purpose} `));
  assert.match(line("kernel"), /研究运行\s+346\s+63000000\s+1100000\s+330000\s+3\.2000\s+80\.0%$/);
  assert.match(line("memory-extraction"), /记忆提取\s+4\s+0\s+90000\s+6000\s+0\.8000\s+20\.0%$/);
  assert.match(line("routing"), /路由分类\s+0\s+0\s+0\s+0\s+0\.0000\s+0\.0%$/);
  assert.match(lines.at(-1), /^total\s+合计\s+350\s+63000000\s+1190000\s+336000\s+4\.0000\s+100\.0%$/);
  // Nothing spent is a report of nothing, not a division by zero.
  assert.match(formatUsageReport(rows(), { days: 1, since: "x" }).split("\n").at(-1), /0\.0000\s+-$/);
});
