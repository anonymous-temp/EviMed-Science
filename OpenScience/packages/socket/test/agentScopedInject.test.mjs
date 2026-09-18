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
