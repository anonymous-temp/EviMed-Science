// The recall reranker on /api/ops/metrics (audit 2026-09-26, M-14).
//
// It fails open by design, so the only way to know it is reranking at all is
// to count its answers where the operator already scrapes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryRerank } from "../src/memoryRerank.mjs";
import { createWebApiApp } from "../src/server.mjs";

test("the composed reranker's successes and failures are counters on the operator's scrape", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-rerank-metrics-"));
  const answers = [
    { ok: true, status: 200, body: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] } },
    { ok: false, status: 503, body: {} },
  ];
  const memoryRerank = new MemoryRerank({ apiKey: `not-a-real-${"key"}`, model: "qwen3-rerank", apiBase: "https://dashscope.example/v1/reranks" }, {
    fetchImpl: async () => {
      const next = /** @type {any} */ (answers.shift());
      return { ok: next.ok, status: next.status, async text() { return JSON.stringify(next.body); } };
    },
    report: () => {},
  });
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, operatorMetricsToken: "rerank-metrics-token", memoryRerank });
  try {
    const address = await app.listen(0, "127.0.0.1");
    assert.equal(app.memorySubstrate.rerank, memoryRerank, "the scrape reads the reranker recall actually uses");
    await memoryRerank.order("房颤抗凝", ["a", "b"]);
    await memoryRerank.order("房颤抗凝", ["a", "b"]);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ops/metrics`, { headers: { Authorization: "Bearer rerank-metrics-token" } });
    assert.equal(response.status, 200);
    const lines = (await response.text()).split("\n");
    assert.ok(lines.includes("# TYPE open_science_memory_rerank_total counter"), lines.filter((line) => line.includes("rerank")).join("\n"));
    assert.ok(lines.includes('open_science_memory_rerank_total{outcome="succeeded",code="none"} 1'));
    assert.ok(lines.includes('open_science_memory_rerank_total{outcome="failed",code="memory_rerank_upstream_error"} 1'));
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
