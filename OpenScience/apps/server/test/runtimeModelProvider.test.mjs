import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { runtimeEnvironment } from "../src/dshProfilePatch.mjs";
import {
  RuntimeManager,
  buildRuntimeLaunchPlan,
  issueModelGatewayRuntimeToken,
  modelGatewayTokenFileName,
  runtimeNetworkRequiresEgressOptIn,
  runtimeNetworkUsesHostOrContainer,
  syncRuntimeDshProfile,
  verifyModelGatewayRuntimeToken,
} from "../src/runtimeManager.mjs";
import { releaseManifestFixture, runtimeReleaseConfig } from "./releaseFixture.mjs";

const secret = "model-gateway-signing-secret-with-at-least-32-bytes";

/**
 * The two provenance rows `runtimeReleasePolicyError` compares that the shared
 * fixture does not carry: it still exports the retired kernel's version field,
 * which is now `undefined`, so a production launch built from it alone fails on
 * `dshVersion` before it reaches whatever the test is about. Restated here
 * rather than worked around, so a production plan in this file is a plan the
 * release policy actually accepts.
 */
const dshReleaseConfig = Object.freeze({
  ...runtimeReleaseConfig,
  dshVersion: releaseManifestFixture.runtime.dshVersion,
  socketBundleVersion: releaseManifestFixture.runtime.socketVersion,
});

test("only the explicitly configured internal runtime network bypasses public-egress opt-in", () => {
  assert.equal(runtimeNetworkRequiresEgressOptIn("open-science-runtime-internal", "open-science-runtime-internal"), false);
  assert.equal(runtimeNetworkRequiresEgressOptIn("bridge", "open-science-runtime-internal"), true);
  assert.equal(runtimeNetworkRequiresEgressOptIn("another-named-network", "open-science-runtime-internal"), true);
  assert.equal(runtimeNetworkUsesHostOrContainer("host"), true);
  assert.equal(runtimeNetworkUsesHostOrContainer("container:other-runtime"), true);
  assert.equal(runtimeNetworkUsesHostOrContainer("open-science-runtime-internal"), false);

  // And the same rule where it actually decides whether a container starts.
  // The predicate above is only advice until the launch plan refuses on it;
  // this is the seam the invariant lives at now that there is one kernel and
  // the plan is the only place a container is described.
  const rootDir = "/data/users/alice/projects/paper1";
  const project = {
    id: "paper1",
    userId: "alice",
    rootDir,
    workspaceDir: `${rootDir}/workspace`,
    runtimeDir: `${rootDir}/runtime`,
  };
  const base = {
    ...dshReleaseConfig,
    production: true,
    dataDir: "/data",
    runtimeSandboxMode: "docker",
    runtimeTransport: "unix",
    runtimeContainerBin: "docker",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    allowRuntimeHostNetwork: false,
    allowRuntimeNetworkEgress: false,
    runtimeNetworkEgressPolicyAck: false,
    runtimeInternalNetworkName: "open-science-runtime-internal",
  };

  const internal = buildRuntimeLaunchPlan(
    { ...base, runtimeNetworkMode: "open-science-runtime-internal" },
    project,
    4096,
  );
  assert.ok(
    internal.args.includes("open-science-runtime-internal"),
    "the network the deployment declares internal needs no egress opt-in",
  );

  for (const mode of ["bridge", "another-named-network"]) {
    assert.throws(
      () => buildRuntimeLaunchPlan({ ...base, runtimeNetworkMode: mode }, project, 4096),
      (error) => error?.code === "runtime_network_egress_forbidden",
      `${mode} must not inherit the internal network's exemption`,
    );
  }
  // Even the declared internal name does not buy host or shared-container
  // networking: that is a different refusal, and it fires first.
  assert.throws(
    () => buildRuntimeLaunchPlan({ ...base, runtimeNetworkMode: "host" }, project, 4096),
    (error) => error?.code === "runtime_network_forbidden",
  );
  assert.throws(
    () => buildRuntimeLaunchPlan({ ...base, runtimeNetworkMode: "container:other-runtime" }, project, 4096),
    (error) => error?.code === "runtime_network_forbidden",
  );
});

test("model gateway runtime token is audience and project bound", () => {
  const token = issueModelGatewayRuntimeToken({
    secret,
    userId: "alice",
    projectId: "paper-1",
    nowSeconds: 1_000,
    jti: "runtime-token-1",
  });
  const payload = verifyModelGatewayRuntimeToken(token, {
    secret,
    userId: "alice",
    projectId: "paper-1",
    nowSeconds: 100_001,
  });
  assert.equal(payload.aud, "evimed-model-gateway");
  assert.equal(Object.hasOwn(payload, "exp"), false);
  assert.throws(
    () => verifyModelGatewayRuntimeToken(token, { secret, userId: "alice", projectId: "paper-2", nowSeconds: 100_001 }),
    (error) => error?.code === "model_gateway_token_invalid",
  );
});

test("RuntimeManager accepts only the current active runtime token and rejects it after stop", async (t) => {
  const manager = new RuntimeManager({
    deepseekProviderEnabled: true,
    deepseekModel: "deepseek-v4-pro",
    modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
    modelGatewaySigningSecret: secret,
  });
  const rootDir = await mkdtemp(path.join(tmpdir(), "active-model-runtime-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const project = {
    id: "paper-1",
    userId: "alice",
    rootDir,
    runtimeDir: path.join(rootDir, "runtime"),
    metaDir: path.join(rootDir, "meta"),
    workspaceDir: path.join(rootDir, "workspace"),
  };
  await mkdir(project.runtimeDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  const token = issueModelGatewayRuntimeToken({
    secret,
    userId: project.userId,
    projectId: project.id,
    jti: "active-runtime",
  });
  const runtime = { close: async () => {}, modelGatewayToken: token, modelGatewayTokenJti: "active-runtime" };
  manager.runtimes.set(manager.key(project), runtime);
  manager.activateModelGatewayRuntime(project, runtime);
  assert.equal(manager.assertActiveModelGatewayToken(token).projectId, "paper-1");
  assert.equal(manager.assertActiveModelGatewayToken(token, { nowSeconds: Math.floor(Date.now() / 1000) + 100_000 }).projectId, "paper-1");

  const replacementToken = issueModelGatewayRuntimeToken({
    secret,
    userId: project.userId,
    projectId: project.id,
    jti: "replacement-runtime",
  });
  const replacement = {
    close: async () => {},
    modelGatewayToken: replacementToken,
    modelGatewayTokenJti: "replacement-runtime",
  };
  manager.activateModelGatewayRuntime(project, replacement);
  assert.throws(() => manager.assertActiveModelGatewayToken(token), (error) => error?.code === "model_gateway_token_invalid");
  assert.equal(manager.assertActiveModelGatewayToken(replacementToken).jti, "replacement-runtime");
  manager.runtimes.set(manager.key(project), replacement);

  await manager.stop(project);
  assert.throws(
    () => manager.assertActiveModelGatewayToken(replacementToken),
    (error) => error?.code === "model_gateway_token_invalid",
  );
});

// The seam that closes the gap `dshProfilePatch.mjs` left: a correct,
// well-tested renderer that nothing in the bootstrap sequence ever called. A
// DSH container built from the image alone would boot with no gateway
// address, no MCP command and no way to reach the model — this is what
// actually reaches the file the running kernel reads.
function dshFixtureConfig(overrides = {}) {
  return {
    deepseekProviderEnabled: true,
    deepseekModel: "deepseek-v4-pro",
    modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
    modelGatewaySigningSecret: secret,
    evimedWorkloadSigningSecret: "evimed-workload-signing-secret-with-32-bytes",
    evimedWorkloadTokenTtlSeconds: 300,
    socketBundleVersion: "0.1.0",
    dshVersion: "0.1.2-alpha.5",
    deliveryAttemptLimit: 3,
    maxParallelChildren: 30,
    runMaxSteps: 0,
    runMaxTokens: 0,
    evidenceStaleMinutes: 10,
    screeningBatchSize: 25,
    runtimeSandboxEnforcement: "full",
    production: true,
    ...overrides,
  };
}

async function dshFixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "runtime-dsh-profile-"));
  const project = { id: "paper-1", userId: "alice", rootDir, workspaceDir: path.join(rootDir, "workspace") };
  // `docker` is the only sandbox mode a launch plan can produce — the host
  // branch was refused by name when the retired kernel went — so the fixture
  // describes the one shape that reaches this function in production.
  const plan = { sandboxMode: "docker", dshHomeDir: path.join(rootDir, "runtime", "dsh-home"), proxyWorkspaceDir: project.workspaceDir };
  return { rootDir, project, plan };
}

test("the runtime bootstrap writes the gateway address and the model, and never the provider key", async (t) => {
  // The retired kernel took these as `provider.deepseek.options.{baseURL,apiKey}`
  // merged into its own `opencode.json`. There is no such file under this
  // kernel: the same three facts — which gateway, which model, and a reference
  // rather than a key — are rows of a generated patch plus a credentials file,
  // and the property that matters is unchanged. The real provider key must
  // never reach any file the container can read.
  const { rootDir, project, plan } = await dshFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const result = await syncRuntimeDshProfile(
    dshFixtureConfig({ deepseekApiKey: "must-never-be-written" }),
    project,
    plan,
    { nowSeconds: 2_000, jti: "runtime-token-2" },
  );

  const patch = await readFile(path.join(plan.dshHomeDir, "control-plane-patch.yml"), "utf8");
  assert.match(patch, /baseURL: 'http:\/\/127\.0\.0\.1:8787\/internal\/model\/v1'/);
  assert.match(patch, /id: 'deepseek-v4-pro'/);
  assert.match(patch, /model: 'deepseek-v4-pro'/);
  // A reference name, never a key: the gateway exchanges the workload token for
  // the real credential server-side.
  assert.match(patch, /apiKeyEnv: 'EVIMED_WORKLOAD_TOKEN'/);

  const credentials = await readFile(path.join(plan.dshHomeDir, ".credentials.yaml"), "utf8");
  assert.ok(
    credentials.includes(`EVIMED_WORKLOAD_TOKEN: '${result.token}'`),
    "the kernel resolves the reference from this file, so the token has to be the one the caller registers",
  );

  // The research MCP is a separate process and reads the same gateway token
  // from a bare file rather than from the kernel's credentials store.
  const tokenFile = await readFile(path.join(plan.dshHomeDir, modelGatewayTokenFileName), "utf8");
  assert.equal(tokenFile.trim(), result.token);

  for (const [name, text] of [["patch", patch], ["credentials", credentials], ["token file", tokenFile]]) {
    assert.equal(text.includes("must-never-be-written"), false, `the provider key reached the ${name}`);
  }
});

test("a hosted runtime runs confined and unattended, and a local one still asks", async (t) => {
  // The retired kernel spelled this as a `permission` map of tool verbs
  // (`bash`/`edit`/`write` allowed). DSH decides it with a named preset pairing
  // a sandbox with an approval policy, and the pair a hosted run needs —
  // confined *and* unattended — is one the kernel does not ship, so the patch
  // has to define it. A patch that named no preset would leave an unattended
  // runtime on the stock policy, which asks and then waits forever.
  const hosted = await dshFixture();
  t.after(() => rm(hosted.rootDir, { recursive: true, force: true }));
  await syncRuntimeDshProfile(dshFixtureConfig(), hosted.project, hosted.plan);
  const hostedPatch = await readFile(path.join(hosted.plan.dshHomeDir, "control-plane-patch.yml"), "utf8");
  assert.match(hostedPatch, /defaultPreset: 'evimed-hosted'/);
  assert.match(hostedPatch, /policy: 'never'/);
  assert.match(hostedPatch, /evimed-hosted:\n\s*sandbox: workspace-write\n\s*approval: never/);

  const local = await dshFixture();
  t.after(() => rm(local.rootDir, { recursive: true, force: true }));
  await syncRuntimeDshProfile(dshFixtureConfig({ production: false }), local.project, local.plan);
  const localPatch = await readFile(path.join(local.plan.dshHomeDir, "control-plane-patch.yml"), "utf8");
  assert.match(localPatch, /defaultPreset: 'workspace-write'/);
  assert.match(localPatch, /policy: 'ask'/);
  assert.equal(localPatch.includes("evimed-hosted"), false, "the unattended preset is a hosted decision, not a default");
});

test("runtimes cannot invoke the direct web fetch path, and the generated patch never re-enables it", async (t) => {
  // The retired kernel was denied `webfetch` per project. DSH's equivalent is
  // composition-level: the fetch provider that arrived as a new default in
  // 0.1.2 is disabled in the bundle, and the preset mounts no `tool-web` for
  // the model to reach it with. Every source this platform retrieves goes
  // through the control plane's own gateway, which resolves DOIs, refuses
  // private and link-local addresses before it fetches, and records what it
  // fetched; a second, unrecorded egress path defeats all three silently.
  const bundlePatch = await readFile(new URL("../../../packages/socket/cordis.patch.yml", import.meta.url), "utf8");
  assert.match(bundlePatch, /- id: web-fetch-http\n\s*disabled: true/);

  const { rootDir, project, plan } = await dshFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await syncRuntimeDshProfile(dshFixtureConfig(), project, plan);
  const patch = await readFile(path.join(plan.dshHomeDir, "control-plane-patch.yml"), "utf8");
  assert.equal(
    patch.includes("web-fetch-http"),
    false,
    "the per-start patch must not address the row the bundle disables: the last writer wins",
  );
});

test("the runtime bootstrap refuses a target it does not own, and rotates the token on every start", async (t) => {
  // The retired kernel merged into a config file it shared with whatever was
  // already there, so it had to refuse a `deepseek` provider entry it had not
  // written. This kernel generates the file whole, which moves the same
  // question to the write itself: a target that is a symlink is someone else's
  // file, and following it would write the kernel's credentials outside the
  // project.
  const { rootDir, project, plan } = await dshFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const outside = path.join(rootDir, "not-ours.yml");
  await writeFile(outside, "# not ours\n", "utf8");
  await mkdir(plan.dshHomeDir, { recursive: true });
  await symlink(outside, path.join(plan.dshHomeDir, "control-plane-patch.yml"));

  await assert.rejects(
    () => syncRuntimeDshProfile(dshFixtureConfig(), project, plan),
    (error) => error?.code === "path_forbidden",
  );
  assert.equal(await readFile(outside, "utf8"), "# not ours\n", "the foreign file must be left exactly as it was");

  await rm(path.join(plan.dshHomeDir, "control-plane-patch.yml"), { force: true });
  const first = await syncRuntimeDshProfile(dshFixtureConfig(), project, plan, { nowSeconds: 2_000, jti: "runtime-old" });
  const second = await syncRuntimeDshProfile(dshFixtureConfig(), project, plan, { nowSeconds: 2_010, jti: "runtime-new" });
  assert.notEqual(first.token, second.token, "each start gets its own gateway token, or a stopped runtime keeps a working one");
});

test("the screening plugin's batch size reaches the container from the control plane", async (t) => {
  // It was hard-coded at 50 in the bundle with no row addressing it, so a
  // deployment whose records are long had to edit the plug to change it. The
  // concurrency ceiling is deliberately the delegation one rather than a second
  // number: a screening child is a delegation child (§10.4).
  const { rootDir, project, plan } = await dshFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await syncRuntimeDshProfile(dshFixtureConfig(), project, plan);
  // It travels as container environment, not as a patch row: the plugin is
  // mounted by the preset, and a profile patch that named it would be reported
  // as an unmatched target and dropped, leaving the schema default in place.
  const env = runtimeEnvironment({
    capabilitiesDir: "/opt/evimed/capabilities",
    capabilitySkillsDir: "/opt/evimed/capability-skills",
    capsuleMethodsDir: "",
    capsuleGatewayUrl: "",
    workloadTokenFile: "/runtime/dsh-home/workload-token",
    bundleVersion: "0.1.0",
    flags: { hosted: true, askUser: false, review: true, capsule: false, requiredEnforcement: "full" },
    limits: {
      deliveryAttemptLimit: dshFixtureConfig().deliveryAttemptLimit,
      maxParallelChildren: dshFixtureConfig().maxParallelChildren,
      maxSteps: dshFixtureConfig().runMaxSteps,
      maxTokens: dshFixtureConfig().runMaxTokens,
      evidenceStaleMinutes: dshFixtureConfig().evidenceStaleMinutes,
      screeningBatchSize: dshFixtureConfig().screeningBatchSize,
    },
  });
  assert.equal(env.EVIMED_SCREENING_BATCH_SIZE, "25");
  assert.equal(env.EVIMED_MAX_PARALLEL_CHILDREN, "30");
  const patch = await readFile(path.join(plan.dshHomeDir, "control-plane-patch.yml"), "utf8");
  assert.ok(!patch.includes("- id: evimed-screening"), "naming a preset row here would be silently dropped");
});

test("syncRuntimeDshProfile writes a patch and a credentials file the running kernel can actually read", async (t) => {
  const { rootDir, project, plan } = await dshFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const result = await syncRuntimeDshProfile(dshFixtureConfig(), project, plan, { nowSeconds: 2_000, jti: "dsh-runtime-1" });
  assert.equal(result.configured, true);
  assert.ok(result.workloadTokenFile);
  assert.ok(result.workloadTokenRefreshMs > 0);

  const patch = await readFile(path.join(plan.dshHomeDir, "control-plane-patch.yml"), "utf8");
  // The real gateway address and the real model reach the file — this is
  // exactly the class of row that was missing before this function existed.
  assert.match(patch, /baseURL: 'http:\/\/127\.0\.0\.1:8787\/internal\/model\/v1'/);
  assert.match(patch, /id: 'deepseek-v4-pro'/);
  assert.match(patch, /apiKeyEnv: 'EVIMED_WORKLOAD_TOKEN'/);
  // The MCP subprocess is told the path it will see from inside the container,
  // which is not the host path the control plane wrote to. Asserting either
  // spelling alone would pass while the two pointed at different files.
  assert.match(patch, /EVIMED_WORKLOAD_TOKEN_FILE: '\/runtime\/dsh-home\/evimed-workload\.token'/);
  assert.notEqual(result.workloadTokenFile, "/runtime/dsh-home/evimed-workload.token");
  // The literal provider key never appears — only the reference name does.
  assert.equal(patch.includes("must-never-be-written"), false);

  const credentials = await readFile(path.join(plan.dshHomeDir, ".credentials.yaml"), "utf8");
  assert.match(credentials, /EVIMED_WORKLOAD_TOKEN: '[^']+'/);

  // A capsule endpoint that is not built yet fails closed and visibly — an
  // empty URL the plugin itself recognizes and disables on — not silently
  // pointed at something that does not exist.
  assert.equal(runtimeEnvironment({
    capabilitiesDir: "", capabilitySkillsDir: "", capsuleMethodsDir: "", capsuleGatewayUrl: "",
    workloadTokenFile: "/t", bundleVersion: "0.1.0",
    flags: { hosted: true, askUser: false, review: true, capsule: false, requiredEnforcement: "full" },
    limits: { deliveryAttemptLimit: 3, maxParallelChildren: 30, maxSteps: 200, maxTokens: 400000, evidenceStaleMinutes: 10, screeningBatchSize: 50 },
  }).EVIMED_CAPSULE_GATEWAY_URL, "", "an unbuilt capsule endpoint is empty, and the plugin disables itself visibly");

  const workloadToken = await readFile(result.workloadTokenFile, "utf8");
  assert.ok(workloadToken.trim().split(".").length >= 3, "the MCP subprocess token is a signed JWT-shaped value");
});

test("syncRuntimeDshProfile places --patch's target under $DSH_HOME, matching what the entrypoint passes", async (t) => {
  const { rootDir, project, plan } = await dshFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const result = await syncRuntimeDshProfile(dshFixtureConfig(), project, plan);
  // `result.workloadTokenFile` is the *host* path — `scheduleEviMedWorkloadRefresh`
  // needs to know where to rewrite the file on disk when the token rotates, and
  // that is always a host path, docker or not.
  assert.equal(result.workloadTokenFile, path.join(plan.dshHomeDir, "evimed-workload.token"));
  const patch = await readFile(path.join(plan.dshHomeDir, "control-plane-patch.yml"), "utf8");
  assert.match(patch, /EVIMED_WORKLOAD_TOKEN_FILE: '\/runtime\/dsh-home\/evimed-workload\.token'/);
});

test("syncRuntimeDshProfile does nothing when the DeepSeek provider is disabled", async (t) => {
  const { rootDir, project, plan } = await dshFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const result = await syncRuntimeDshProfile(dshFixtureConfig({ deepseekProviderEnabled: false }), project, plan);
  assert.equal(result.configured, false);
  assert.equal(result.workloadTokenFile, null);
  await assert.rejects(readFile(path.join(plan.dshHomeDir, "control-plane-patch.yml")), { code: "ENOENT" });
});

test("the two runtime capability settings reach the container, and the default does not change what ships", async (t) => {
  // Both sites that build the container's flags wrote `askUser: false,
  // review: true` as literals and read nothing, while `requiredEnforcement` in
  // the same object literal did read config — a local omission, not an
  // architectural one. An operator setting either variable got exactly nothing,
  // in one case leaving in-run clarification permanently off and in the other
  // leaving semantic review permanently on.
  //
  // The default for review is `true` for a reason: it is what every hosted run
  // has actually been getting. Wiring these up against the old `false` default
  // would have turned cross-deliverable review off everywhere — a capability
  // removal wearing a bug fix's clothes.
  const { rootDir, project } = await dshFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  // Asserted on the argv the control plane actually emits, not on a
  // `runtimeEnvironment` this test builds with flags of its own making. The
  // first version did the latter: it exercised the production path and then
  // measured something else, so reverting the wiring to literals left it green
  // — the same "execution without assertion" this audit found in the
  // profile-sync tests, reproduced while fixing it.
  const argvFor = (overrides) => buildRuntimeLaunchPlan(
    {
      ...dshFixtureConfig(overrides),
      // The release-provenance gate is a separate concern and has its own
      // tests; this one is about whether two settings reach the container.
      production: false,
      dataDir: rootDir,
      runtimeSandboxMode: "docker",
      runtimeTransport: "unix",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeNetworkMode: "none",
      runtimeCpuLimit: "1",
      runtimeMemoryLimit: "1g",
      runtimePidsLimit: 64,
      allowRuntimeHostNetwork: false,
    },
    { ...project, runtimeDir: path.join(rootDir, "runtime") },
    4096,
  ).args;

  const on = argvFor({ runtimeAskUserEnabled: true, runtimeReviewEnabled: true });
  assert.ok(on.includes("EVIMED_ASK_USER=1"), "clarification must be turnable on");
  assert.ok(on.includes("EVIMED_REVIEW_ENABLED=1"));

  const off = argvFor({ runtimeAskUserEnabled: false, runtimeReviewEnabled: false });
  assert.ok(off.includes("EVIMED_ASK_USER=0"));
  assert.ok(off.includes("EVIMED_REVIEW_ENABLED=0"), "a setting that cannot turn something off is not a setting");

  // The shipped defaults must be the behaviour that was already shipping.
  const defaults = loadConfig({});
  assert.equal(defaults.runtimeAskUserEnabled, false, "clarification stays off by default, as it was hardcoded");
  assert.equal(defaults.runtimeReviewEnabled, true, "review stays on by default, as it was hardcoded");
});
