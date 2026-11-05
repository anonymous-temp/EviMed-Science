// Which knowledge-source rows are the AI-discovery channel, and so dropped from the medical feed (`frontierPipeline.mjs`).
// The plugin's contract has no field for it, so the id prefix is the marker: this file and the plugin's registry must agree.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AI_DISCOVERY_PREFIX, LEGACY_DISCOVERY_SOURCE_ID, isDiscoveryOnlySource } from "../src/evolutionDiscoverySources.mjs";

const registryFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../项目代码/knowledge-plugin/registry/sources.json");
const pluginPresent = existsSync(registryFile);
const registry = pluginPresent ? JSON.parse(readFileSync(registryFile, "utf8")).sources : [];

test("only the discovery rows and the legacy query are dropped from the medical feed", () => {
  assert.equal(isDiscoveryOnlySource("ai-discovery-arxiv-agents-memory"), true);
  assert.equal(isDiscoveryOnlySource("ai-discovery-req-0123456789ab"), true, "a source the platform asked the plugin for carries the prefix");
  assert.equal(isDiscoveryOnlySource(LEGACY_DISCOVERY_SOURCE_ID), true, "entries stored before the set replaced the single query keep their meaning");
  for (const id of ["openai-news", "pubmed-rct-core-journals", "j-0028-4793", "", null, undefined, "xai-ai-discovery-like"]) assert.equal(isDiscoveryOnlySource(id), false, String(id));
});

// The id prefix is a contract between two codebases; a row on one side only is a row whose entries are read wrongly.
test("the plugin's registry and this file agree on which rows are the channel", { skip: !pluginPresent && "the plugin's registry is not in this checkout" }, () => {
  assert.ok(registry.length > 700, "the registry was read");
  const rows = new Map(registry.map((/** @type {any} */ row) => [row.id, row]));
  for (const row of registry) {
    const discoveryOnly = row.config?.discovery_only === true;
    assert.equal(discoveryOnly, row.id.startsWith(AI_DISCOVERY_PREFIX), `${row.id}: discovery_only and the id prefix must go together`);
    assert.equal(isDiscoveryOnlySource(row.id), discoveryOnly, row.id);
  }
  assert.equal(rows.has(LEGACY_DISCOVERY_SOURCE_ID), false, "the single arXiv query is replaced by the set, not kept beside it");
});
