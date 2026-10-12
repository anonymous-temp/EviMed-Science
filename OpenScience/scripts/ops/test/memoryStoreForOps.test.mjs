import assert from "node:assert/strict";
import test from "node:test";

import { memoryStoreForOps } from "../memory-store.mjs";

const database = { query: async () => ({ rows: [] }) };

test("an operator script's memory writes reach the index queue exactly when the server's do (2026-10-12)", () => {
  const indexed = memoryStoreForOps({ openVikingUrl: "http://openviking:1933", openVikingApiKey: "test-not-secret" }, database);
  assert.equal(indexed.indexed, true);
  assert.ok(indexed.jobs, "a deployment with an index gives the store its job queue");
  assert.equal(indexed.researchMemory.jobs, indexed.jobs, "the store enqueues index work in each write's own transaction");

  for (const config of [{}, { memoryIndexProvider: "builtin", openVikingUrl: "http://openviking:1933", openVikingApiKey: "test-not-secret" }]) {
    const plain = memoryStoreForOps(config, database);
    assert.equal(plain.indexed, false);
    assert.equal(plain.jobs, null, "no index, no queue: nothing would ever apply its jobs");
  }
});
