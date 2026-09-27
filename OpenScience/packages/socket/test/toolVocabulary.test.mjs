/**
 * The socket tool vocabulary is exactly what the plugins register.
 *
 * `SOCKET_TOOL_NAMES` is what the skills, the run ledger, the narration, the
 * leakage list and the "a skill may call this" check all read. A name in it
 * that no plugin registers is a tool the platform claims is mounted and is
 * not — `evimed_complete_run` sat there for a week after its plugin code was
 * deleted (2026-09-20). A name a plugin registers and the vocabulary lacks is
 * a tool nothing downstream recognises. Both directions, against the pinned
 * cordis and tool registry, every agent-scope row mounted and switched on.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { SOCKET_TOOL_NAME_LIST } from "@evimed/domain";
import { __setHarnessModule, loadHarnessModule } from "@evimed/harness-port";
import { buildCiteTools, resolveConfig } from "dsh-cite";

import { AGENT_PLUGIN_IDS, PLUGIN_SPECIFIERS } from "../index.mjs";

/** The upstream shape the compaction engine extends; the real one ships only
 *  in the runtime image. Enough for the `structured` policy to mount, which is
 *  the only policy that registers the compaction request tool. */
class BaseCompactionEngine {
  static inject = ["llm"];
  static Config = {};
  /** @param {any} ctx @param {any} config */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }
  /** @param {any} _input @param {any} _agent @param {AbortSignal} [_signal] */
  async summarize(_input, _agent, _signal) { return null; }
  async compactIfNeeded() { return null; }
  async compactRegion() { return null; }
  async compactNow() { return null; }
}

/** Every agent-scope row switched on, with the policy that mounts every tool. */
const CONFIG = {
  "evimed-compaction": { policy: "structured" },
};

test("every socket tool name is registered by a plugin, and every plugin's tool is in the vocabulary", async () => {
  __setHarnessModule("@deepseek-ai/dsh-compaction-basic", { BasicCompactionEngine: BaseCompactionEngine });
  const { Context } = await loadHarnessModule("@deepseek-ai/cordis");
  const { ToolRuntime } = await loadHarnessModule("@deepseek-ai/dsh-tools");
  const ctx = new Context();
  ctx.provide("systemPrompt", { tools: () => () => {}, section: () => () => {} });
  ctx.provide("agents", { get: () => undefined, list: () => [] });
  ctx.provide("sessions", {});
  ctx.provide("subagents", {});
  ctx.provide("storageDomain", { open: async () => ({ table: () => ({}) }) });
  const runtime = new ToolRuntime(ctx);
  for (const id of AGENT_PLUGIN_IDS) {
    const specifier = PLUGIN_SPECIFIERS[/** @type {keyof typeof PLUGIN_SPECIFIERS} */ (id)];
    const plugin = await import(new URL(specifier, new URL("../", import.meta.url)).href);
    await ctx.plugin(plugin, /** @type {Record<string, any>} */ (CONFIG)[id] ?? {});
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const registered = [...runtime.view().visible.keys()];
  await ctx.fiber.dispose();

  const ours = registered.filter((name) => name.startsWith("evimed_")).sort();
  assert.ok(ours.length >= 10, `mounted ${ours.length} of our tools; the composition did not mount, the vocabulary is not wrong`);
  assert.deepEqual(
    [...SOCKET_TOOL_NAME_LIST].filter((name) => !ours.includes(name)),
    [],
    "the vocabulary names a tool no plugin registers",
  );
  assert.deepEqual(ours.filter((name) => !SOCKET_TOOL_NAME_LIST.includes(name)), [], "a plugin registers a tool the vocabulary does not name");
  // Everything else registered is the citation bundle's own published set.
  const cite = buildCiteTools(resolveConfig({})).map((tool) => tool.name).sort();
  assert.deepEqual(registered.filter((name) => !name.startsWith("evimed_")).sort(), cite);
});

test("no host-scope plugin registers a model-facing tool", async () => {
  // The walk above mounts the agent-scope rows only; this is why that is all
  // of them. A host-scope tool would ride every session, child or root.
  const directory = new URL("../plugins/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".mjs"));
  const registering = [];
  for (const file of files) {
    const source = await readFile(new URL(file, directory), "utf8");
    if (/\bregisterTool\(/.test(source)) registering.push(`./plugins/${file}`);
  }
  assert.ok(files.length >= 12 && registering.length >= 5, `read ${files.length} plugins, ${registering.length} register; the scan is wrong`);
  /** @type {string[]} */
  const agentSpecifiers = AGENT_PLUGIN_IDS.map((id) => PLUGIN_SPECIFIERS[/** @type {keyof typeof PLUGIN_SPECIFIERS} */ (id)]);
  assert.deepEqual(registering.filter((specifier) => !agentSpecifiers.includes(specifier)), []);
});
