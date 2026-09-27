// The socket plugins' off switches, from .env to the preset row that reads them.
//
// A plugin is measured against the kernel's own composition (principle 11),
// so "off" has to reach the runtime: the operator names the plugin, config
// refuses a name that switches nothing, the launch plan writes every switch
// into the container, and the preset row of that plugin is the one that reads
// it. `packages/socket/test/pluginSwitches.test.mjs` holds the other half —
// that a row switched off registers nothing.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { SOCKET_PLUGIN_SWITCHES, runtimeEnvironment } from "../src/dshProfilePatch.mjs";
import { buildRuntimeLaunchPlan } from "../src/runtimeManager.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LEVER = "OPEN_SCIENCE_RUNTIME_DISABLED_SOCKET_PLUGINS";
const input = { presetSkillsDir: "", capabilitiesDir: "", capabilitySkillsDir: "", capsuleMethodsDir: "", capsuleGatewayUrl: "", workloadTokenFile: "", bundleVersion: "", flags: {}, limits: {} };

/** @param {string | undefined} value @param {() => any} run */
function withLever(value, run) {
  const saved = process.env[LEVER];
  if (value == null) delete process.env[LEVER];
  else process.env[LEVER] = value;
  try {
    return run();
  } finally {
    if (saved == null) delete process.env[LEVER];
    else process.env[LEVER] = saved;
  }
}

test("each switch is read by its own plugin's preset row, off only at 0", async () => {
  const preset = await readFile(path.join(repoRoot, "packages/socket/presets/evimed-universal/agent.cordis.yml"), "utf8");
  const ids = Object.keys(SOCKET_PLUGIN_SWITCHES);
  assert.equal(ids.length, 6, `found ${ids.length} switches; the table is wrong, not the preset`);
  for (const [id, name] of Object.entries(SOCKET_PLUGIN_SWITCHES)) {
    // The row from its id to the next row at any depth.
    const row = new RegExp(`- id: ${id}\\n([\\s\\S]*?)(?=\\n\\s*- id: |$)`).exec(preset)?.[1] ?? "";
    assert.match(row, new RegExp(`enabled: !!js process\\.env\\.${name} !== '0'`), `${id}'s row does not read ${name}`);
  }
});

test("the runtime is given every switch: on unless the deployment names the plugin", () => {
  const on = runtimeEnvironment(input);
  for (const name of Object.values(SOCKET_PLUGIN_SWITCHES)) assert.equal(on[name], "1", name);

  const off = runtimeEnvironment({ ...input, disabledPlugins: ["evimed-screening", "evimed-capsule"] });
  assert.equal(off.EVIMED_SCREENING_ENABLED, "0");
  assert.equal(off.EVIMED_CAPSULE_ENABLED, "0");
  assert.equal(off.EVIMED_GUIDANCE_ENABLED, "1", "one plugin off leaves the others on");

  assert.throws(() => runtimeEnvironment({ ...input, disabledPlugins: ["evimed-screen"] }), /Unknown socket plugin to switch off: evimed-screen/);
  // Review and the citation tools follow their own levers; a second path to
  // the same switch would disagree with the first.
  assert.throws(() => runtimeEnvironment({ ...input, disabledPlugins: ["evimed-review"] }), /evimed-review/);
});

test("the deployment names the plugins to switch off, and a name that switches nothing is refused", () => {
  assert.deepEqual(withLever(undefined, () => loadConfig({ rootDir: repoRoot })).runtimeDisabledSocketPlugins, []);
  assert.deepEqual(
    withLever(" evimed-screening, evimed-compaction ,evimed-screening", () => loadConfig({ rootDir: repoRoot })).runtimeDisabledSocketPlugins,
    ["evimed-screening", "evimed-compaction"],
  );
  assert.throws(() => withLever("evimed-screening,screening", () => loadConfig({ rootDir: repoRoot })),
    /OPEN_SCIENCE_RUNTIME_DISABLED_SOCKET_PLUGINS must name plugins among evimed-guidance, .*got "screening"/);
});

test("the launch plan writes the switches into the container", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "socket-switches-"));
  try {
    const project = { id: "paper1", userId: "alice", rootDir: tmp, workspaceDir: path.join(tmp, "workspace"), runtimeDir: path.join(tmp, "runtime") };
    const config = {
      runtimeSandboxMode: "docker", runtimeContainerBin: "docker", runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeTransport: "unix", runtimeNetworkMode: "none", runtimeCpuLimit: "1", runtimeMemoryLimit: "1g", runtimePidsLimit: 64,
      allowRuntimeHostNetwork: false, deepseekProviderEnabled: true, deepseekModel: "deepseek-v4-pro",
      modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
      modelGatewaySigningSecret: "model-gateway-signing-secret-with-at-least-32-bytes",
      runtimeSandboxEnforcement: "full",
    };
    const envOf = (/** @type {any} */ plan) => plan.args.filter((/** @type {string} */ arg, /** @type {number} */ index) => plan.args[index - 1] === "--env");
    const defaults = envOf(buildRuntimeLaunchPlan(config, project, 49152));
    for (const name of Object.values(SOCKET_PLUGIN_SWITCHES)) assert.ok(defaults.includes(`${name}=1`), `${name} is not sent`);
    const off = envOf(buildRuntimeLaunchPlan({ ...config, runtimeDisabledSocketPlugins: ["evimed-run-policy"] }, project, 49152));
    assert.ok(off.includes("EVIMED_RUN_POLICY_ENABLED=0"));
    assert.ok(off.includes("EVIMED_EVIDENCE_ENABLED=1"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
