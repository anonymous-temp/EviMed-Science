/**
 * The support record lists the socket plugins the composition actually mounts.
 *
 * `runtime/skills/community/plugin-support.json` is what an operator reads to
 * learn what a runtime carries, and its `nativePlugins` listed nine of thirteen
 * (production audit, 2026-09-26): the web provider, the compaction swap, the
 * startup probe and the client-registry row were each mounted and each absent
 * from it. The list is derived here from the two composition files, never
 * counted, so the next row added to either is a red test until it is recorded.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGENT_PLUGIN_IDS, BUNDLE_NAME, HOST_PLUGIN_IDS } from "../index.mjs";

/**
 * Row ids whose `name` is this bundle or one of its subpaths. Each chunk runs
 * from one `- id:` line to the next, at any depth, so a row nested in a group
 * is its own chunk and the group row (named `cordis:group`) is not ours.
 * @param {string} text @returns {string[]}
 */
function bundleRowIds(text) {
  const ids = [];
  for (const chunk of text.split(/\n(?=\s*- id: )/)) {
    const id = /^\s*- id: (\S+)/.exec(chunk)?.[1];
    const name = /^\s*name: '([^']+)'/m.exec(chunk)?.[1] ?? "";
    if (id && (name === BUNDLE_NAME || name.startsWith(`${BUNDLE_NAME}/`))) ids.push(id);
  }
  return ids;
}

test("plugin-support.json lists every socket plugin the composition mounts, and nothing else", async () => {
  const read = (/** @type {string} */ relative) => readFile(new URL(relative, import.meta.url), "utf8");
  const [patch, preset, support] = await Promise.all([
    read("../cordis.patch.yml"),
    read("../presets/evimed-universal/agent.cordis.yml"),
    read("../../../runtime/skills/community/plugin-support.json").then(JSON.parse),
  ]);
  const host = bundleRowIds(patch);
  const agent = bundleRowIds(preset);
  // The walk has to have read both files, or an empty list agrees with an empty record.
  assert.ok(host.length >= 4 && agent.length >= 6, `read ${host.length} host and ${agent.length} agent rows; the scan is wrong`);
  assert.deepEqual([...host].sort(), [...HOST_PLUGIN_IDS].sort(), "the bundle's declared host rows are the ones its patch inserts");
  // The hosted extension shim is platform-owned, separate from the eight core
  // policy plugins. Its presence declares a bridge, not package qualification.
  assert.deepEqual([...agent].sort(), [...AGENT_PLUGIN_IDS, "evimed-cowork-bridge"].sort(),
    "the preset mounts exactly the core policy plugins and the trusted extension shim");

  const recorded = support.nativePlugins;
  assert.equal(new Set(recorded).size, recorded.length, "a plugin is recorded twice");
  assert.deepEqual([...recorded].sort(), [...host, ...agent].sort());
});
