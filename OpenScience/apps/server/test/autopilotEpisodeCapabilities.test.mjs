// Which capability an autopilot episode runs, against what the capabilities
// themselves declare.
//
// An agenda names task types, never a capability, so the episode table is the
// whole of the choice. `geo-content` declared `signal-monitoring` for GEO
// citation monitoring while the table sent that type to adverse-event analysis:
// a GEO agenda item ran `adr-analysis`, and GEO monitoring never ran (build spec
// 2026-09-25 §1). Monitoring is now the 「循证 GEO」 module's own scheduler. This
// file holds the table and the declarations together so the next capability
// that declares a type the table sends elsewhere is a red test, not a quiet
// misroute.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AUTOPILOT_EPISODE_CAPABILITIES, AUTOPILOT_TASK_TYPES, autopilotEpisodeCapability } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The manifests the runtime ships, by id. */
async function shippedManifests() {
  const dir = path.join(repoRoot, "deploy/runtime-dsh/capabilities");
  const manifests = new Map();
  for (const name of (await readdir(dir)).filter((file) => file.endsWith(".json"))) {
    const manifest = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    manifests.set(manifest.id, manifest);
  }
  return manifests;
}

// Declarations the table does not honour, recorded rather than silently
// tolerated. Both predate the table's move into the domain (2026-09-25) and
// neither changes what an episode runs: the type goes to the capability named
// in the table. Removing one means either declaring it away in the manifest or
// changing the table, which is a product decision.
const KNOWN_UNHONOURED = new Set([
  "bibliometric-analysis:literature-sentinel",
  "meta-analysis:evidence-update",
  "research-grant-development:writing-pipeline",
]);

test("every task type the allocator knows runs a capability the runtime ships and lists publicly", async () => {
  const manifests = await shippedManifests();
  assert.ok(manifests.size >= 15, `only ${manifests.size} shipped manifests read`);
  assert.deepEqual(Object.keys(AUTOPILOT_EPISODE_CAPABILITIES).sort(), [...AUTOPILOT_TASK_TYPES].sort());
  for (const type of AUTOPILOT_TASK_TYPES) {
    const id = autopilotEpisodeCapability(type);
    assert.ok(id, `${type} runs nothing`);
    const manifest = manifests.get(id);
    assert.ok(manifest, `${type} runs ${id}, which the runtime does not ship`);
    assert.notEqual(manifest.visibility, "internal", `${type} runs ${id}, an internal capability`);
  }
  assert.equal(autopilotEpisodeCapability("geo-monitoring"), null, "an unknown type runs nothing");
});

test("a declared task type is one the table sends to the declaring capability", async () => {
  const manifests = await shippedManifests();
  const misrouted = [];
  let declared = 0;
  for (const manifest of manifests.values()) {
    for (const type of manifest.autopilot?.taskTypes ?? []) {
      declared += 1;
      if (autopilotEpisodeCapability(type) === manifest.id) continue;
      if (KNOWN_UNHONOURED.has(`${manifest.id}:${type}`)) continue;
      misrouted.push(`${manifest.id} declares ${type}, which runs ${autopilotEpisodeCapability(type)}`);
    }
  }
  assert.ok(declared >= 5, `only ${declared} declarations read; the walk is wrong`);
  assert.deepEqual(misrouted, [], "an episode of a declared type would run a different capability");
});

test("adverse-event monitoring still runs adverse-event analysis, and no GEO capability rides the allocator", async () => {
  const manifests = await shippedManifests();
  assert.equal(autopilotEpisodeCapability("signal-monitoring"), "adr-analysis");
  assert.ok(manifests.get("adr-analysis").autopilot.taskTypes.includes("signal-monitoring"));
  const geo = [...manifests.values()].filter((manifest) => manifest.id.startsWith("geo-"));
  assert.equal(geo.length, 4, `expected the four GEO capabilities, found ${geo.map((manifest) => manifest.id)}`);
  for (const manifest of geo) {
    assert.deepEqual(manifest.autopilot.taskTypes, [], `${manifest.id} declares an autopilot task type; GEO scheduling is its module's`);
  }
});

test("the control plane dispatches episodes through the domain's table and keeps no copy of its own", async () => {
  const source = await readFile(path.join(repoRoot, "apps/server/src/server.mjs"), "utf8");
  assert.match(source, /autopilotEpisodeCapability\(episode\.taskType\)/);
  assert.doesNotMatch(source, /"signal-monitoring":\s*"/, "a second table in server.mjs is the one that drifts");
});
