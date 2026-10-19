import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SESSION_PATHS } from "../src/agentbay/runtimeProvider.mjs";
import { COMMUNITY_CLIENT_BUNDLE_ROWS, renderProfilePatch } from "../src/dshProfilePatch.mjs";
import { PYTHON_DISTRIBUTION_MODULES } from "@evimed/domain";
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

test("the python-methods phase adds the curated skills' libraries once, after the stack and before the skills are smoke-tested, and moves no pin of the stack", async () => {
  const { docker, agentbay, script } = await sources();
  for (const dockerfile of [docker, agentbay]) {
    const calls = installPhaseCalls(dockerfile);
    assert.ok(calls.indexOf("python") < calls.indexOf("python-methods") && calls.indexOf("python-methods") < calls.indexOf("curated-smoke"));
    // Before the kernel and the skill trees: a kernel pin bump or a SKILL.md edit invalidates what follows it.
    assert.ok(calls.indexOf("python-methods") < calls.indexOf("kernel"));
    assert.ok(dockerfile.indexOf("install-runtime.sh python-methods") < dockerfile.indexOf("COPY runtime/skills/curated-scientific"));
  }
  const phases = definedInstallPhases(script);
  const phase = phases.get("python-methods") ?? "";
  const pin = /^\s+([A-Za-z0-9_.-]+)==([0-9][^\s\\]*)/gmu;
  const added = [...phase.matchAll(pin)].map((match) => match[1]);
  assert.deepEqual([...added].sort(), ["anndata", "biopython", "gseapy", "lifelines", "rdkit", "scanpy"]);
  const stack = [...String(phases.get("python")).matchAll(pin)].map((match) => match[1]);
  assert.ok(stack.length >= 10 && added.every((name) => !stack.includes(name)), "a library is pinned in one phase");
  // Exact pins, wheels only (the image has no compiler), the stack frozen as constraints so nothing it pinned can move,
  // and the environment checked for consistency afterwards.
  assert.match(phase, /uv pip freeze --python "\$\{VIRTUAL_ENV\}\/bin\/python" > "\$\{stack\}"/);
  assert.match(phase, /--only-binary :all: --constraint "\$\{stack\}"/);
  assert.match(phase, /uv pip check --python/);
  // Every library it pins is imported by the phase's own check, by a module the domain's table says it provides.
  for (const name of added) assert.ok(phase.includes(`"${PYTHON_DISTRIBUTION_MODULES[name][0]}"`), `${name} is imported by the phase's check`);
  // The phase runs wherever the image runs it: the script accepts it and dispatches it.
  assert.match(script, /\|verify-tools\|python-methods\|curated-smoke\|/);
  assert.equal(spawnSync("bash", [path.join(repoRoot, "deploy/runtime-dsh/install-runtime.sh"), "no-such-phase"], { encoding: "utf8" }).status, 64);
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
  const pandoc = pins.$runtimeTools.pandoc;
  for (const dockerfile of [docker, agentbay]) {
    assert.equal(arg(dockerfile, "PANDOC_VERSION"), pandoc.version);
    for (const arch of ["amd64", "arm64"]) {
      assert.match(pandoc.debSha256[arch], /^[a-f0-9]{64}$/);
      assert.equal(arg(dockerfile, `PANDOC_SHA256_${arch.toUpperCase()}`), pandoc.debSha256[arch]);
    }
  }
  assert.match(agentbay, /^ARG TARGETARCH$/m);
});

test("CI installs the same digest-checked renderer and real Chromium before the Office tests", async () => {
  const { script } = await sources();
  const phase = definedInstallPhases(script).get("renderer");
  assert.ok(phase);
  assert.match(phase, /sha256sum -c -/);
  assert.match(phase, /dpkg -i/);
  assert.match(phase, /test "\$\(pandoc --version.*= "pandoc \$\{PANDOC_VERSION\}"/);
  const workflow = await read("../.github/workflows/web.yml");
  const marker = "      - name: Install the runtime document renderer";
  const position = workflow.indexOf(marker);
  assert.ok(position > 0 && position < workflow.indexOf("      - name: Test Hosted Web API"));
  const step = workflow.slice(position + marker.length).split(/\n      - (?:name:|uses:)/)[0];
  assert.match(step, /deps-version\.json"\)\.\$runtimeTools\.pandoc\.version/);
  for (const arch of ["amd64", "arm64"]) assert.match(step, new RegExp(`\\.debSha256\\.${arch}`));
  for (const name of ["renderer", "browser", "verify-tools"]) assert.match(step, new RegExp(`bash deploy/runtime-dsh/install-runtime\\.sh ${name}`));
  const python = definedInstallPhases(script).get("python") ?? "";
  // The Office skills' libraries ride with the renderer: the flows test (officeFlows.test.mjs) runs on the same versions the image pins.
  for (const name of ["Pillow", "playwright", "pypdf", "openpyxl", "pdfplumber", "python-docx", "python-pptx", "XlsxWriter"]) {
    const dependency = new RegExp(`${name}==[0-9.]+`).exec(python)?.[0];
    assert.ok(dependency && step.includes(dependency), `${name}: CI and runtime must exercise one renderer dependency version`);
  }
});

test("the image and the nightly seam check install the kernel under one cutoff", async () => {
  // The seam check used to `pnpm add` the pin with no cutoff, so every range
  // inside the pinned release resolved to whatever was newest that night; from
  // 2026-09-22 it verified a cordis no image held and was red for that alone.
  const { docker, agentbay, pins } = await sources();
  assert.ok(Number.isFinite(Date.parse(pins.dsh.publishedBefore)), "deps-version.json carries no dsh.publishedBefore");
  assert.equal(arg(docker, "DSH_PUBLISHED_BEFORE"), pins.dsh.publishedBefore);
  assert.equal(arg(agentbay, "DSH_PUBLISHED_BEFORE"), pins.dsh.publishedBefore);
  const { kernelInstallArgs } = await import("../../../scripts/ops/kernel-install.mjs");
  const install = kernelInstallArgs(pins, "/tmp/probe");
  assert.ok(install.includes(`--before=${pins.dsh.publishedBefore}`));
  assert.ok(install.includes(`${pins.dsh.npmPackage}@${pins.dsh.version}`));
  assert.ok(install.includes("--ignore-scripts"));
  assert.throws(() => kernelInstallArgs({ dsh: { ...pins.dsh, publishedBefore: undefined } }, "/tmp/probe"), /publishedBefore/);
  const seams = await read("scripts/ops/verify-harness-seams.mjs");
  assert.match(seams, /import \{ closureDrift, installKernel \} from "\.\/kernel-install\.mjs"/);
  assert.doesNotMatch(seams, /"pnpm", \["add"/, "the seam check must not install the kernel a second way");
});

test("the seam check exempts the wire methods the platform registers itself, all of them and only them", async () => {
  // `pnpm verify:seams` reported three phantom methods: the manifest lists the
  // platform's own `evimedSkills/*` methods, which the kernel never ships, and
  // the check exempted one namespace by a literal prefix. The namespaces are
  // read from the services that register them now.
  const { ownWireNamespaces, wireSurfaceFindings } = await import("../../../scripts/ops/wire-surface.mjs");
  const manifest = JSON.parse(await read("packages/harness-port/seam-manifest.json"));
  const own = ownWireNamespaces(path.join(repoRoot, "packages/harness-port/src"));
  assert.deepEqual([...own].sort(), ["evimedPlugins", "evimedSkills"]);

  const declared = [...manifest.wire.unary, ...manifest.wire.denied];
  const ours = declared.filter((name) => own.has(name.split("/")[0]));
  assert.equal(ours.filter((name) => name.startsWith("evimedSkills/")).length, 3);
  // The kernel ships everything the manifest names except what the platform registers.
  const shipped = declared.filter((name) => !ours.includes(name));
  const streams = Object.values(manifest.wire.streamEndpoints);
  assert.deepEqual(wireSurfaceFindings({ declared, shipped, streams, own }), { unclassified: [], phantom: [] });

  // The old rule, for the record: one namespace exempted by prefix left these three.
  assert.deepEqual(
    wireSurfaceFindings({ declared, shipped, streams, own: new Set(["evimedPlugins"]) }).phantom,
    ["evimedSkills/list", "evimedSkills/read", "evimedSkills/snapshotBuiltin"],
  );
  // Both directions still find a finding: a retired upstream method is a phantom,
  // an `evimed…/` name nothing registers is a phantom, and a method the kernel
  // ships that the manifest does not classify is reported.
  const findings = wireSurfaceFindings({
    declared: [...declared, "session/retiredUpstream", "evimedNothing/registersThis"],
    shipped: [...shipped, "session/newUpstream"], streams, own,
  });
  assert.deepEqual(findings.phantom, ["evimedNothing/registersThis", "session/retiredUpstream"]);
  assert.deepEqual(findings.unclassified, ["session/newUpstream"]);
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
    presetSkillsDir: "/opt/evimed/socket/presets/evimed-universal/skills",
    capabilitiesDir: "/opt/evimed/capabilities",
    capabilitySkillsDir: "/opt/evimed/capability-skills",
    capsuleMethodsDir: "",
    capsuleGatewayUrl: "",
    workloadTokenFile: "",
    bundleVersion: "0.1.0",
    dshVersion: "0.2.1-rc.2",
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

test("the runtime tool verification cannot pass after any required tool fails", async () => {
  const { script } = await sources();
  const phase = definedInstallPhases(script).get("verify-tools");
  assert.ok(phase);
  for (const failed of ["pandoc", "test", "rg", "python"]) {
    const commands = ["pandoc", "test", "rg", "python"].map(name => `${name}() { return ${name === failed ? 73 : 0}; }`).join("\n");
    const result = spawnSync("bash", ["-c", `set -e\n${commands}\nRscript() { echo unexpected-fallthrough; }\nverify() {\n${phase}\n}\nverify`], { encoding: "utf8" });
    assert.equal(result.status, 73, `${failed} must fail the phase, not only its intermediate command`);
    assert.doesNotMatch(result.stdout, /unexpected-fallthrough/);
  }
});

test("the runtime layers are ordered by how often they change, so a release reuses the stable ones", async () => {
  // A layer is reused from the CI cache only while everything before it is
  // unchanged, and a reused layer is one the serving host already holds. Every
  // full release used to load the whole runtime again (2026-10-19).
  const { docker } = await sources();
  const calls = installPhaseCalls(docker);
  const stable = ["system", "renderer", "toolchain", "python", "browser", "python-methods"];
  assert.deepEqual(calls.slice(0, stable.length), stable, "the heavy, stable phases come first");
  assert.ok(calls.indexOf("kernel") === stable.length, "the kernel pin is the first thing a kernel bump rebuilds");
  // The tool checks prove the LibreOffice Kit, which ships in the kernel's closure, and the Office smoke needs it.
  assert.ok(calls.indexOf("kernel") < calls.indexOf("verify-tools") && calls.indexOf("verify-tools") < calls.indexOf("office-smoke"));

  const lines = docker.split("\n");
  const stage = lines.findLastIndex((line) => /^FROM /.test(line));
  const runOf = (phase) => lines.findIndex((line) => line === `RUN bash /usr/local/lib/evimed/install-runtime.sh ${phase}`);
  // BuildKit hands every ARG declared in a stage to each later RUN as its environment, so an ARG is part of the cache
  // key of every phase after it: each is declared just above the first phase that reads it, never at the top.
  const firstReader = { APT_MIRROR: "system", PANDOC_VERSION: "renderer", NODE_VERSION: "toolchain", UV_VERSION: "toolchain",
    PIP_INDEX_URL: "python", NPM_REGISTRY: "kernel", DSH_VERSION: "kernel", DSH_PUBLISHED_BEFORE: "kernel", PNPM_VERSION: "pnpm",
    SOCKET_VERSION: "smoke" };
  const previousRun = (index) => lines.slice(0, index).findLastIndex((line) => /^RUN /.test(line));
  for (const [name, phase] of Object.entries(firstReader)) {
    const declared = lines.findIndex((line) => line.startsWith(`ARG ${name}=`));
    assert.ok(declared > stage && declared < runOf(phase), `${name} is declared before the ${phase} phase`);
    assert.ok(previousRun(declared) === -1 || previousRun(declared) === previousRun(runOf(phase)), `${name} is declared after the phase before ${phase}`);
  }
  // The refresh key is above every install phase, so a new month rebuilds the image from upstream.
  const refresh = lines.findIndex((line) => line === "ARG BASE_REFRESH=unset");
  assert.ok(refresh > stage && refresh < runOf("system"));
  // The release identity is last; the version LABELs, which are configuration and not layers, sit just above it.
  const release = lines.findIndex((line) => line.startsWith("ARG RELEASE_ID="));
  assert.ok(release > runOf("serve"));
  for (const label of lines.filter((line) => line.startsWith("LABEL "))) assert.ok(lines.indexOf(label) > runOf("serve"), `${label} sits after the last phase`);
});

test("each install phase copies only its own cut of the script, and every cut runs exactly that phase", async () => {
  const { docker, script } = await sources();
  const lines = docker.split("\n");
  // Each phase RUN is preceded by the copy of its own cut, from the stage that cuts them.
  for (const phase of installPhaseCalls(docker)) {
    const run = lines.indexOf(`RUN bash /usr/local/lib/evimed/install-runtime.sh ${phase}`);
    assert.equal(lines[run - 1], `COPY --from=install-phases /phases/${phase}.sh /usr/local/lib/evimed/install-runtime.sh`);
  }
  assert.match(docker, /^FROM \$\{RUNTIME_BASE_IMAGE\} AS install-phases$/m);
  assert.match(docker, /^RUN mkdir \/phases && awk -v out=\/phases -f \/usr\/local\/src\/evimed\/split-install-phases\.awk \/usr\/local\/src\/evimed\/install-runtime\.sh$/m);
  // The whole script is never copied ahead of a phase (that is what rebuilt everything); it lands once, after the last.
  const whole = lines.indexOf("COPY deploy/runtime-dsh/install-runtime.sh /usr/local/lib/evimed/install-runtime.sh");
  assert.ok(whole > lines.indexOf("RUN bash /usr/local/lib/evimed/install-runtime.sh serve"));

  const out = await mkdtemp(path.join(os.tmpdir(), "install-phases-"));
  try {
    const cut = spawnSync("awk", ["-v", `out=${out}`, "-f", path.join(repoRoot, "deploy/runtime-dsh/split-install-phases.awk"), path.join(repoRoot, "deploy/runtime-dsh/install-runtime.sh")], { encoding: "utf8" });
    assert.equal(cut.status, 0, cut.stderr);
    const defined = definedInstallPhases(script);
    assert.deepEqual((await readdir(out)).sort(), [...defined.keys()].map((phase) => `${phase}.sh`).sort());
    for (const [phase, body] of defined) {
      const text = await readFile(path.join(out, `${phase}.sh`), "utf8");
      // The cut holds the phase's function as the parser reads it, and no other phase's.
      const own = definedInstallPhases(text);
      assert.deepEqual([...own.keys()], [phase]);
      assert.equal(own.get(phase), body);
      assert.equal(spawnSync("bash", ["-n", path.join(out, `${phase}.sh`)]).status, 0, `${phase}.sh parses`);
      // Run under another phase's name it refuses, as the whole script refuses an unknown phase.
      const other = phase === "serve" ? "smoke" : "serve";
      assert.equal(spawnSync("bash", [path.join(out, `${phase}.sh`), other], { encoding: "utf8", env: { PATH: process.env.PATH } }).status, 64);
    }
    // An edit to one phase changes that phase's cut alone.
    const edited = script.replace("chmod 0755 /usr/local/bin/open-science-dsh-serve", "chmod 0755 /usr/local/bin/open-science-dsh-serve\n  true");
    assert.notEqual(edited, script);
    const again = await mkdtemp(path.join(os.tmpdir(), "install-phases-"));
    try {
      await writeFile(path.join(again, "install-runtime.sh"), edited);
      assert.equal(spawnSync("awk", ["-v", `out=${again}`, "-f", path.join(repoRoot, "deploy/runtime-dsh/split-install-phases.awk"), path.join(again, "install-runtime.sh")]).status, 0);
      for (const phase of defined.keys()) {
        const same = (await readFile(path.join(out, `${phase}.sh`), "utf8")) === (await readFile(path.join(again, `${phase}.sh`), "utf8"));
        assert.equal(same, phase !== "serve", `${phase}.sh ${phase === "serve" ? "changes" : "stays byte-identical"}`);
      }
      // Code outside every function would be lost from every cut, so the cut refuses the script.
      await writeFile(path.join(again, "install-runtime.sh"), script.replace("serve() {", "echo stray\nserve() {"));
      const stray = spawnSync("awk", ["-v", `out=${again}`, "-f", path.join(repoRoot, "deploy/runtime-dsh/split-install-phases.awk"), path.join(again, "install-runtime.sh")], { encoding: "utf8" });
      assert.notEqual(stray.status, 0);
      assert.match(stray.stderr, /outside every function/);
    } finally {
      await rm(again, { recursive: true, force: true });
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
