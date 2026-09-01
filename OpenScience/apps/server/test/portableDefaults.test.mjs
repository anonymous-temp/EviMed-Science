// The bundle is meant to be usable by someone who does not run our control
// plane. These pin the handful of defaults that decide whether that is true,
// because each of them is a single line whose cost is paid entirely by people
// who are not us — and none of them fails loudly here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { renderProfilePatch } from "../src/dshProfilePatch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// apps/server/test -> apps/server -> apps -> OpenScience

test("a bundle with no control plane defaults to partial sandbox enforcement", async () => {
  // With `full`, an ordinary Linux box or a Mac cannot start the composition at
  // all: Landlock is absent or reports partial, the self-check is fatal, and the
  // failure is a line nobody chose. The guarantee `full` buys is one those hosts
  // cannot give in the first place.
  const source = await readFile(path.join(repoRoot, "packages/socket/plugins/seam-probe.mjs"), "utf8");
  assert.match(
    source,
    /requiredEnforcement: Schema\.union\(\['full', 'partial'\]\)\.default\('partial'\)/,
    "the plugin default decides whether a stranger can boot at all",
  );
});

test("hosted production still demands full enforcement, explicitly", async () => {
  // The other half, and the reason the flip above is not a weakening: the
  // control plane never relies on the plugin default. If this stops being true,
  // the flip silently becomes a downgrade of every hosted run.
  // `production` is its own override, not derived from a nodeEnv argument.
  const production = loadConfig({ production: true, publicUrl: "https://example.test" });
  assert.equal(production.runtimeSandboxEnforcement, "full");

  const development = loadConfig({ production: false });
  assert.equal(development.runtimeSandboxEnforcement, "partial");
});

test("the generated patch writes enforcement out loud rather than inheriting it", async () => {
  const patch = renderProfilePatch({
    modelGatewayUrl: "https://open-science-web:8787/internal/model/v1",
    model: "deepseek-v4-pro",
    contextWindow: 1000000,
    sessionsDir: "/runtime/dsh-home/sessions",
    mcpServerPath: "/opt/evimed/mcp/evimed-research/server.py",
    mcpEnvironment: {},
    presetRoot: "/opt/evimed/socket/presets",
    capabilitiesDir: "/opt/evimed/capabilities",
    capabilitySkillsDir: "/opt/evimed/capability-skills",
    capsuleMethodsDir: "/runtime/capsule/methods",
    capsuleGatewayUrl: "https://open-science-web:8787/internal/capsule/v1",
    workloadTokenFile: "/runtime/secrets/workload-token",
    bundleVersion: "0.1.0",
    dshVersion: "0.1.1-rc.2",
    limits: { deliveryAttemptLimit: 3, maxParallelChildren: 30, maxSteps: 200, maxTokens: 4000000, evidenceStaleMinutes: 10 },
    flags: { hosted: true, askUser: false, review: true, capsule: false, requiredEnforcement: "full" },
  });
  assert.match(patch, /requiredEnforcement:\s*['"]?full['"]?/, "hosted must state full, not inherit a default");
});

