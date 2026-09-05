import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("the MemOS image builds from the single full source revision pin", async () => {
  const versions = JSON.parse(await readFile(path.join(root, "deps-version.json"), "utf8"));
  assert.match(versions.memos.sourceRevision, /^[a-f0-9]{40}$/);
  const dockerfile = await readFile(path.join(root, "deploy/memos-engine/Dockerfile"), "utf8");
  assert.match(dockerfile, /deps-version\.json/);
  assert.match(dockerfile, /pin\['sourceRevision'\]/);
  assert.doesNotMatch(dockerfile, /ARG MEMOS_(?:VERSION|REVISION)/);
});

test("the MemOS stack is private, persistent, bounded, and reachable only by the control plane", async () => {
  const compose = await readFile(path.join(root, "deploy/web/docker-compose.memos-engine.yml"), "utf8");
  assert.match(compose, /memory-index-internal:\n\s+internal: true/);
  assert.match(compose, /OPEN_SCIENCE_REQUIRE_MEMORY_INDEX: "true"/);
  assert.match(compose, /MEMSCHEDULER_USE_REDIS_QUEUE: "true"/);
  assert.match(compose, /EVIMED_MEMOS_PROVIDER_CONFIG: \/run\/secrets\/memos-engine-providers\.json/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  for (const volume of ["engine-data", "neo4j-data", "qdrant-data", "redis-data"]) {
    assert.match(compose, new RegExp(`evimed-memos-${volume}:`));
  }
  assert.equal((compose.match(/^\s+- memory-index-internal$/gm) ?? []).length, 5,
    "only the control plane and four dedicated memory services join the private network");
  assert.equal((compose.match(/\n\s+limits:\n/g) ?? []).length, 4);
});
