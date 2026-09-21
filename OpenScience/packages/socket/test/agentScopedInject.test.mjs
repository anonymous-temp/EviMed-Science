import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

// The port's agent-scoped helpers reach a service through the agent's own
// context (`agent.ctx.<service>`), and cordis resolves that property against
// the CALLING plugin's declared injects. A plugin that uses the helper without
// declaring the service fails at run time with 「cannot get property "…"
// without inject」 — which is how every method section of the live aspirin run
// of 2026-09-19 failed to register, while every unit test (fake contexts
// enforce nothing) stayed green.
const portUrl = new URL("../../harness-port/index.mjs", import.meta.url);
const pluginsUrl = new URL("../plugins/", import.meta.url);

/** helper name -> the service it reaches through agent.ctx */
async function agentScopedHelpers() {
  const source = await readFile(portUrl, "utf8");
  const helpers = new Map();
  for (const match of source.matchAll(/export function (\w+)\(agent[^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
    const service = /agent\.ctx\.(\w+)/.exec(match[2]);
    if (service) helpers.set(match[1], service[1]);
  }
  return helpers;
}

test("the scan finds every agent-scoped helper the port exports", async () => {
  const source = await readFile(portUrl, "utf8");
  const helpers = await agentScopedHelpers();
  const reaches = [...source.matchAll(/agent\.ctx\.(\w+)/g)].length;
  assert.ok(helpers.size >= 3, `found ${helpers.size} helpers; the scan is wrong, not the port`);
  assert.equal(helpers.size, reaches, "every agent.ctx access belongs to one exported helper");
  assert.equal(helpers.get("registerAgentSkill"), "skills");
});

test("a plugin that uses an agent-scoped helper declares the service it reaches", async () => {
  const helpers = await agentScopedHelpers();
  const files = (await readdir(pluginsUrl)).filter((name) => name.endsWith(".mjs"));
  assert.ok(files.length >= 10, `found ${files.length} plugins; the scan is wrong, not the directory`);
  let checked = 0;
  for (const file of files) {
    const source = await readFile(new URL(file, pluginsUrl), "utf8");
    const injectMatch = /export const inject = (\[[^\]]*\])/.exec(source);
    const declared = injectMatch ? new Set([...injectMatch[1].matchAll(/'(\w+)'/g)].map((m) => m[1])) : new Set();
    for (const [helper, service] of helpers) {
      if (!new RegExp(`\\b${helper}\\(`).test(source)) continue;
      checked += 1;
      assert.ok(declared.has(service), `${file} calls ${helper}, which reaches agent.ctx.${service}, but does not inject '${service}'`);
    }
  }
  assert.ok(checked >= 2, `checked ${checked} helper uses; at least run-policy and guidance use them`);
});

/** helper name -> the service it reaches through the calling plugin's own ctx */
async function contextScopedHelpers() {
  const source = await readFile(portUrl, "utf8");
  const helpers = new Map();
  for (const match of source.matchAll(/export function (\w+)\(ctx[^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
    const service = /\bctx\.(skills|systemPrompt|tools|agents|tui|web)\b/.exec(match[2]);
    if (service) helpers.set(match[1], service[1]);
  }
  return helpers;
}

/** The plugin files the agent preset mounts, read from the preset itself. */
async function agentPresetPlugins() {
  const preset = await readFile(new URL("../presets/evimed-universal/agent.cordis.yml", import.meta.url), "utf8");
  return [...preset.matchAll(/name: '@evimed\/dsh-socket\/plugins\/([\w-]+)'/g)].map((match) => `${match[1]}.mjs`);
}

test("a plugin that registers through its own context declares the service it reaches", async () => {
  // 2026-09-21: the capsule plugin registered each mounted method with
  // `registerSkill(ctx, …)` while injecting only 'tools'. It had never run with
  // a method present; the first learned method made its apply throw 「cannot get
  // property "skills" without inject」 and the whole evimed-universal preset
  // failed to mount for that account.
  const helpers = await contextScopedHelpers();
  assert.ok(helpers.get("registerSection") === "systemPrompt" && helpers.get("registerTool") === "tools",
    `found ${JSON.stringify([...helpers])}; the scan is wrong, not the port`);
  const files = (await readdir(pluginsUrl)).filter((name) => name.endsWith(".mjs"));
  let checked = 0;
  for (const file of files) {
    const source = await readFile(new URL(file, pluginsUrl), "utf8");
    const injectMatch = /export const inject = (\[[^\]]*\])/.exec(source);
    const declared = injectMatch ? new Set([...injectMatch[1].matchAll(/'(\w+)'/g)].map((m) => m[1])) : new Set();
    for (const [helper, service] of helpers) {
      if (!new RegExp(`\\b${helper}\\(ctx\\b`).test(source)) continue;
      checked += 1;
      assert.ok(declared.has(service), `${file} calls ${helper}(ctx…), which reaches ctx.${service}, but does not inject '${service}'`);
    }
  }
  assert.ok(checked >= 3, `checked ${checked} helper uses; guidance, capsule and evidence register through their own ctx`);
});

test("no row of the agent preset reaches the skills service, which an agent scope does not have at this pin", async () => {
  // Declaring 'skills' does not help: the property resolves against the
  // agent's fiber chain, where no skills service lives (2026-09-19, and again
  // 2026-09-21 in the capsule plugin). A method reaches the model through a
  // prompt section or an injected body instead.
  const rows = await agentPresetPlugins();
  assert.ok(rows.includes("capsule.mjs") && rows.length >= 6, `found ${rows.join(", ")}; the preset scan is wrong`);
  for (const file of rows) {
    const source = await readFile(new URL(file, pluginsUrl), "utf8");
    assert.doesNotMatch(source, /\bregisterSkill\(|\bregisterAgentSkill\(|\bctx\.skills\b/, `${file} is an agent-preset row and reaches the skills service`);
  }
});
