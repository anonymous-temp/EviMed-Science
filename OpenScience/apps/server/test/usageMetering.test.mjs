// Metering had a price list and a vocabulary and no caller at all, which meant
// the platform could price a request it never counted. These are the
// properties that make the count worth trusting.
import assert from "node:assert/strict";
import test from "node:test";
import { createUsageTail, parseModelUsage, recordModelUsage, summarizeUsage } from "../src/usageMetering.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PEAK = new Date("2026-09-04T02:00:00.000Z"); // inside a weekday peak window
const OFF_PEAK = new Date("2026-09-04T20:00:00.000Z");

test("reads the provider's own token counts out of a non-streaming answer", () => {
  const body = JSON.stringify({
    id: "chat-1",
    choices: [{ message: { content: "hello" } }],
    usage: { prompt_tokens: 1200, completion_tokens: 340, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 200 },
  });
  assert.deepEqual(parseModelUsage(body), {
    promptTokens: 1200,
    completionTokens: 340,
    cacheHitTokens: 1000,
    cacheMissTokens: 200,
  });
});

test("takes the last usage frame of a stream, not the first", () => {
  // A stream repeats the field; only the final frame describes the whole turn,
  // and billing the first would undercount every long answer.
  const stream = [
    'data: {"choices":[{"delta":{"content":"a"}}],"usage":null}',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1}}',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":900,"prompt_cache_hit_tokens":8}}',
    "data: [DONE]",
  ].join("\n\n");
  assert.deepEqual(parseModelUsage(stream), {
    promptTokens: 10,
    completionTokens: 900,
    cacheHitTokens: 8,
    cacheMissTokens: 2,
  });
});

test("a stream that reported no usage is not invented", () => {
  // `include_usage` is opt-in. A stream without it carries no counts, and a
  // guessed count on an invoice is worse than a visible gap.
  const stream = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]';
  assert.equal(parseModelUsage(stream), null);
  assert.equal(parseModelUsage(""), null);
});

test("charges the whole prompt at the miss rate when the split is absent", () => {
  const body = JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 20 } });
  assert.deepEqual(parseModelUsage(body), {
    promptTokens: 500,
    completionTokens: 20,
    cacheHitTokens: 0,
    cacheMissTokens: 500,
  });
});

test("the tail keeps the end of a large body without holding the body", () => {
  const tail = createUsageTail(256);
  const filler = "x".repeat(64 * 1024);
  tail.observe(Buffer.from(filler));
  tail.observe(Buffer.from('...,"usage":{"prompt_tokens":7,"completion_tokens":3}}'));
  assert.deepEqual(tail.usage(), {
    promptTokens: 7,
    completionTokens: 3,
    cacheHitTokens: 0,
    cacheMissTokens: 7,
  });
});

test("an event names who it bills, and costs half off peak", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-usage-"));
  try {
    const config = { dataDir, maxLogFileBytes: 1024 * 1024 };
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheHitTokens: 0, cacheMissTokens: 1_000_000 };
    const peak = await recordModelUsage({ config, userId: "alice", projectId: "paper1", model: "deepseek-v4-pro", usage, at: PEAK });
    const off = await recordModelUsage({ config, userId: "alice", projectId: "paper1", model: "deepseek-v4-pro", usage, at: OFF_PEAK });

    assert.equal(peak.userId, "alice");
    assert.equal(peak.projectId, "paper1");
    assert.equal(peak.peak, true);
    assert.equal(off.peak, false);
    // 1M cache-miss prompt at 4 + 1M output at 12 = 16, halved off peak.
    assert.equal(peak.cost, 16);
    assert.equal(off.cost, 8);
    assert.equal(peak.priced, true);

    const written = await readFile(path.join(dataDir, ".openscience", "usage.jsonl"), "utf8");
    assert.equal(written.trim().split("\n").length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a model the price list does not know is still counted, and marked unpriced", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-usage-"));
  try {
    const config = { dataDir, maxLogFileBytes: 1024 * 1024 };
    const event = await recordModelUsage({
      config,
      userId: "alice",
      projectId: "paper1",
      model: "some-model-nobody-priced",
      usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 },
      at: PEAK,
    });
    assert.equal(event.priced, false);
    assert.equal(event.cost, 0);
    assert.equal(summarizeUsage([event]).unpricedCalls, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("nothing is written when the answer reported no usage", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-usage-"));
  try {
    const config = { dataDir, maxLogFileBytes: 1024 * 1024 };
    assert.equal(await recordModelUsage({ config, userId: "a", projectId: "p", model: "deepseek-v4-pro", usage: null }), null);
    await assert.rejects(readFile(path.join(dataDir, ".openscience", "usage.jsonl"), "utf8"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a summary totals one account and leaves the others out", () => {
  const rows = [
    { at: "2026-09-03T00:00:00.000Z", resourceType: "model", userId: "alice", projectId: "p1", model: "deepseek-v4-pro", cacheHit: 0, cacheMiss: 100, output: 50, cost: 1.5, priced: true },
    { at: "2026-09-03T01:00:00.000Z", resourceType: "model", userId: "bob", projectId: "p2", model: "deepseek-v4-pro", cacheHit: 0, cacheMiss: 100, output: 50, cost: 9, priced: true },
    { at: "2026-08-01T00:00:00.000Z", resourceType: "model", userId: "alice", projectId: "p1", model: "deepseek-v4-flash", cacheHit: 0, cacheMiss: 10, output: 5, cost: 0.25, priced: true },
  ];
  const summary = summarizeUsage(rows, { userId: "alice", since: new Date("2026-09-01T00:00:00.000Z") });
  assert.equal(summary.calls, 1);
  assert.equal(summary.cost, 1.5);
  assert.equal(summary.promptTokens, 100);
  assert.equal(summary.completionTokens, 50);
  assert.deepEqual(summary.byModel, [{ model: "deepseek-v4-pro", calls: 1, cost: 1.5 }]);
});
