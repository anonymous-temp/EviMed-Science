// The wish list the knowledge-source plugin pulls (`GET /evolution/source-requests.json`): it asks for what the platform filed and for nothing else.
import assert from "node:assert/strict";
import test from "node:test";

import { AI_DISCOVERY_SOURCE_REQUESTS, evolutionSourceRequestManifest } from "../src/evolutionSourceRequests.mjs";

test("the manifest no longer asks for the single arXiv query: the plugin's registry carries the set it grew into", async () => {
  assert.deepEqual([...AI_DISCOVERY_SOURCE_REQUESTS], [], "a request for a row the registry has dropped would admit the old query again beside the new rows");
  assert.deepEqual(await evolutionSourceRequestManifest(null), { schemaVersion: 1, sources: [] });
  assert.deepEqual(await evolutionSourceRequestManifest({ list: async () => [] }), { schemaVersion: 1, sources: [] });
});

test("what the platform filed is served, in the order it was filed, and nothing that is not public or not waiting", async () => {
  const filed = (/** @type {string} */ id, /** @type {any} */ over = {}) => ({ payload: { public: true, status: "requested", source: { id }, ...over } });
  const service = { list: async (/** @type {string} */ kind) => (kind === "source-request"
    ? [filed("ai-discovery-req-000000000001"), filed("ai-discovery-req-000000000002", { status: "admitted" }), filed("ai-discovery-req-000000000003", { public: false }), filed("ai-discovery-req-000000000004")] : []) };
  assert.deepEqual((await evolutionSourceRequestManifest(service)).sources.map((/** @type {any} */ source) => source.id), ["ai-discovery-req-000000000001", "ai-discovery-req-000000000004"]);
  const many = { list: async () => Array.from({ length: 40 }, (_, index) => filed(`ai-discovery-req-${String(index).padStart(12, "0")}`)) };
  assert.equal((await evolutionSourceRequestManifest(many)).sources.length, 25, "the plugin reads at most twenty-five");
});
