import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SESSION_PATHS } from "../src/agentbay/runtimeProvider.mjs";
import { COMMUNITY_CLIENT_BUNDLE_ROWS, renderProfilePatch } from "../src/dshProfilePatch.mjs";
import { dshProfileInput } from "../src/runtimeManager.mjs";
import { definedInstallPhases, expandInstallPhases, installPhaseCalls } from "../../../scripts/ops/runtime-install-phases.mjs";

// The runtime image is built twice from one install script (plan §3.1 #2):
// `Dockerfile` for the Docker provider and `Dockerfile.agentbay` for AgentBay.
// These tests hold the two builds to the same steps and the same pins, and the
// community bundles they install to the one record of what was booted.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");

async function sources() {
  const [docker, agentbay, script, pins, support, baseline, launcher, serve, buildScript] = await Promise.all([
    read("deploy/runtime-dsh/Dockerfile"),
    read("deploy/runtime-dsh/Dockerfile.agentbay"),
    read("deploy/runtime-dsh/install-runtime.sh"),
    read("deps-version.json").then(JSON.parse),
    read("runtime/skills/community/plugin-support.json").then(JSON.parse),
    read("deploy/runtime-dsh/dump-config.baseline.json"),
    read("deploy/runtime-dsh/evimed-session.sh"),
    read("deploy/runtime-dsh/open-science-dsh-serve.sh"),
    read("scripts/ops/agentbay-image-build.sh"),
  ]);
  return { docker, agentbay, script, pins, support, baseline, launcher, serve, buildScript };
}

/** @param {string} dockerfile @param {string} name */
function arg(dockerfile, name) {
  const match = new RegExp(`^ARG ${name}=(?:"([^"]*)"|(\\S*))$`, "m").exec(dockerfile);
  return match ? (match[1] ?? match[2]) : undefined;
}

test("the Docker and AgentBay images run the same install phases in the same order, and AgentBay adds only its session", async () => {
  const { docker, agentbay, script } = await sources();
  const dockerPhases = installPhaseCalls(docker);
  const agentbayPhases = installPhaseCalls(agentbay);
  assert.ok(dockerPhases.length >= 15, `only ${dockerPhases.length} phases found; the parse is wrong`);
  assert.deepEqual(agentbayPhases, [...dockerPhases, "session"]);
  // Every phase either file runs is defined, and nothing the script defines is
  // dead: a phase no build runs is a step someone believes is taken.
  const defined = [...definedInstallPhases(script).keys()];
  assert.deepEqual([...new Set(agentbayPhases)].sort(), [...defined].sort());
  assert.doesNotThrow(() => expandInstallPhases(docker, script));
  assert.doesNotThrow(() => expandInstallPhases(agentbay, script));
});

test("both images pin every shared tool to the same version, and the kernel to deps-version.json", async () => {
  const { docker, agentbay, pins } = await sources();
  const shared = [...docker.matchAll(/^ARG ([A-Z0-9_]+)=/gm)].map((match) => match[1])
    .filter((name) => !["RUNTIME_BASE_IMAGE"].includes(name));
  assert.ok(shared.length >= 25, `only ${shared.length} ARGs parsed from the Dockerfile`);
  for (const name of shared) {
    assert.equal(arg(agentbay, name), arg(docker, name), `${name} differs between the two images`);
  }
  assert.equal(arg(docker, "DSH_VERSION"), pins.dsh.version);
  assert.equal(arg(agentbay, "DSH_VERSION"), pins.dsh.version);
  assert.equal(arg(docker, "DSH_CORDIS_VERSION"), pins.dsh.cordis);
  assert.equal(arg(docker, "PNPM_VERSION"), pins.dsh.pnpm);
  assert.match(agentbay, /^ARG TARGETARCH$/m);
});

test("each community bundle is installed at the version its record says was booted, with its peers pinned", async () => {
  const { docker, agentbay, pins, support, baseline } = await sources();
  const cite = support.communityToolBundles.find((row) => row.name === "dsh-cite");
  const clients = Object.fromEntries(support.communityClientBundles.map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(clients).sort(), ["dsh-annotation", "dsh-mermaid"]);
  for (const dockerfile of [docker, agentbay]) {
    assert.equal(arg(dockerfile, "DSH_CITE_BUNDLE"), `dsh-cite@${pins.dsh.citeVersion}`);
    assert.equal(arg(dockerfile, "DSH_ANNOTATION_BUNDLE"), `${clients["dsh-annotation"].npmPackage}@${pins.dsh.annotationVersion}`);
    assert.equal(arg(dockerfile, "DSH_MERMAID_BUNDLE"), `${clients["dsh-mermaid"].npmPackage}@${pins.dsh.mermaidVersion}`);
    const peers = Object.entries(pins.dsh.communityPeerPins).map(([name, version]) => `${name}@${version}`).join(" ");
    assert.equal(arg(dockerfile, "DSH_COMMUNITY_PEER_PINS"), peers);
  }
  assert.equal(cite.version, pins.dsh.citeVersion);
  assert.equal(clients["dsh-annotation"].version, pins.dsh.annotationVersion);
  assert.equal(clients["dsh-mermaid"].version, pins.dsh.mermaidVersion);
  const recordedPeers = Object.assign({}, ...support.communityClientBundles.map((row) => row.peerPins ?? {}));
  assert.deepEqual(recordedPeers, pins.dsh.communityPeerPins);
  // Each bundle's row is in the composition the image records, under the
  // bundle that inserts it, and each switch is the one the control plane reads.
  for (const [key, row] of Object.entries(COMMUNITY_CLIENT_BUNDLE_ROWS)) {
    const record = Object.values(clients).find((entry) => entry.row === row);
    assert.ok(record, `${key}: no record names the row ${row}`);
    assert.equal(record.switch, `OPEN_SCIENCE_RUNTIME_${key.toUpperCase()}_ENABLED`);
    assert.match(baseline, new RegExp(`^# == ${record.npmPackage.replace(/[/.]/g, "\\$&")}\\n- id: ${row}\\n  name: '?${record.npmPackage.replace(/[/.]/g, "\\$&")}'?$`, "m"));
  }
  assert.equal(support.kernel, `@deepseek-ai/dsh@${pins.dsh.version}`, "the record names the kernel its bundles were booted against");
});

test("a switched-off client bundle is a disabled row in the patch, and an unknown one is refused", async () => {
  const input = (disabledClientBundles) => ({
    modelGatewayUrl: "http://open-science-web:8787/internal/model/v1",
    model: "deepseek-v4-pro",
    contextWindow: 400000,
    sessionsDir: "/runtime/dsh-home/sessions",
    mcpServerPath: "/opt/evimed/mcp/evimed-research/server.py",
    mcpEnvironment: {},
    presetRoot: "/opt/evimed/dsh/presets",
    presetSkillsDir: "/opt/evimed/socket/presets/evimed-universal/skills",
    capabilitiesDir: "/opt/evimed/capabilities",
    capabilitySkillsDir: "/opt/evimed/capability-skills",
    capsuleMethodsDir: "",
    capsuleGatewayUrl: "",
    workloadTokenFile: "",
    bundleVersion: "0.1.0",
    dshVersion: "0.1.5-rc.2",
    limits: { deliveryAttemptLimit: 3, maxSteps: 0, maxTokens: 0, evidenceStaleMinutes: 10 },
    flags: { hosted: false, askUser: false, review: true, capsule: false, requiredEnforcement: /** @type {const} */ ("full") },
    disabledClientBundles,
  });
  assert.doesNotMatch(renderProfilePatch(input([])), /dsh-annotation|ui-mermaid/, "on is the image's own composition: nothing is written");
  const off = renderProfilePatch(input(["mermaid"]));
  assert.match(off, /^- id: ui-mermaid\n {2}disabled: true$/m);
  assert.doesNotMatch(off, /dsh-annotation/);
  assert.match(renderProfilePatch(input(["annotation", "mermaid"])), /^- id: dsh-annotation\n {2}disabled: true$/m);
  assert.throws(() => renderProfilePatch(input(["excalidraw"])), /Unknown community client bundle/);

  const plan = { sandboxMode: "docker", dshHomeDir: "/x", proxyWorkspaceDir: "/workspace", pluginConfig: { revision: 0, enabled: true, settings: { timeoutMs: 15000 } }, capsuleMethodCount: 0 };
  const config = { modelGatewayInternalUrl: "http://open-science-web:8787/internal/model/v1", runtimeSandboxEnforcement: "full" };
  const project = { id: "p", userId: "u", workspaceDir: "/w" };
  assert.deepEqual(dshProfileInput(config, project, plan, "deepseek-v4-pro", null).disabledClientBundles, []);
  assert.deepEqual(dshProfileInput({ ...config, runtimeAnnotationEnabled: false }, project, plan, "deepseek-v4-pro", null).disabledClientBundles, ["annotation"]);
  assert.deepEqual(dshProfileInput({ ...config, runtimeMermaidEnabled: false }, project, plan, "deepseek-v4-pro", null).disabledClientBundles, ["mermaid"]);
});

test("the AgentBay image keeps to AgentBay's rules and carries what the provider starts", async () => {
  const { agentbay, launcher, serve, buildScript } = await sources();
  const marker = "# ---- end of the AgentBay template header";
  const header = agentbay.slice(0, agentbay.indexOf(marker));
  const body = agentbay.slice(agentbay.indexOf(marker));
  assert.ok(agentbay.includes(marker), "the build script replaces everything above this line with the template's");
  assert.ok(buildScript.includes(`marker='^${marker}'`), "the build script looks for the same marker");
  assert.equal((header.match(/^FROM /gm) ?? []).length, 1);
  assert.equal((body.match(/^FROM /gm) ?? []).length, 0, "the template's FROM is the only one");
  assert.doesNotMatch(agentbay, /^CMD /m, "an AgentBay image may not declare CMD");
  assert.equal(agentbay.trimEnd().split("\n").at(-1), "USER root", "an AgentBay image ends as root");
  for (const line of body.split("\n").filter((entry) => /^(COPY|ADD) /.test(entry))) {
    const source = line.split(/\s+/)[1];
    assert.ok(!source.startsWith("/") && !source.includes(".."), `${line}: COPY takes context-relative paths only`);
    if (source === "deploy/runtime-dsh/capabilities") continue;
    assert.ok(await lstat(path.join(repoRoot, source)).catch(() => null), `COPY source ${source} does not exist`);
  }
  // What the provider runs and where the image puts it.
  assert.match(agentbay, new RegExp(`^COPY deploy/runtime-dsh/evimed-session\\.sh ${SESSION_PATHS.launcher}$`, "m"));
  assert.match(agentbay, /^COPY deploy\/runtime-dsh\/evimed-session-bridge\.mjs \/usr\/local\/bin\/evimed-session-bridge\.mjs$/m);
  assert.match(serve, /node \/usr\/local\/bin\/evimed-session-bridge\.mjs &/);
  assert.equal(/^runtime_user=(\S+)$/m.exec(launcher)?.[1], arg(agentbay, "EVIMED_RUNTIME_USER"), "the launcher runs the kernel as the user the image creates");
  assert.equal(arg(agentbay, "EVIMED_RUNTIME_TARGET"), "agentbay");
});

test("the Docker image is not the AgentBay variant", async () => {
  const { docker, script } = await sources();
  assert.equal(arg(docker, "EVIMED_RUNTIME_TARGET"), undefined, "the script's default target is the Docker image");
  assert.ok(!installPhaseCalls(docker).includes("session"));
  const build = expandInstallPhases(docker, script);
  assert.doesNotMatch(build, /evimed-session-bridge|useradd/, "nothing of the session reaches the Docker build");
  assert.match(script, /session_packages=\(iptables procps\)/, "the firewall's tools are the AgentBay image's alone");
});

test("the install script refuses what it does not know before touching anything", () => {
  const script = path.join(repoRoot, "deploy/runtime-dsh/install-runtime.sh");
  const run = (args, env = {}) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(run(["no-such-phase"]).status, 64);
  assert.equal(run(["system"], { EVIMED_RUNTIME_TARGET: "kubernetes" }).status, 64);
  const session = run(["session"]);
  assert.equal(session.status, 64, "the session phase belongs to the AgentBay image");
  assert.match(session.stderr, /belongs to the AgentBay image/);
});
