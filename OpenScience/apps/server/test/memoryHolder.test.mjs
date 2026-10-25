import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryRoutes } from "../src/memoryRoutes.mjs";

test("memory holder is derived from the authenticated account, never imported provenance or a query", async () => {
  const seen = [];
  const route = createMemoryRoutes({ config: {}, memorySettings: {}, nativeMemory: { configured: true, async profile(id, options) {
    seen.push([id, options.holder]); return { records: [], groups: {}, activeCount: 601, pendingCount: 5, episodeCount: 20, holder: options.holder };
  } }, store: {}, context: async () => ({ user: { id: "alice", name: "Alice", privateCredential: "test-only-private-field" } }),
  feedbackEvents: {}, audit: async () => {}, recordFeedback: async () => {}, decodeRouteComponent: (value) => value });
  let output;
  const res = { writeHead: () => {}, end: (body) => { output = JSON.parse(body); } };
  await route({ method: "GET", url: "/api/memory/profile?holder=mallory" }, res);
  assert.deepEqual(seen, [["alice", { id: "alice", name: "Alice" }]], "the holder is the authenticated account's, whatever the query says");
  assert.deepEqual(output.data.holder, { id: "alice", name: "Alice" });
  assert.equal(output.data.activeCount, 601);
  assert.equal(output.data.episodeCount, 20);
  assert.equal(JSON.stringify(output).includes("privateCredential"), false);
});
