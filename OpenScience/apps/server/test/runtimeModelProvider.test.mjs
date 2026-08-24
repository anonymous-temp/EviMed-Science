import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RuntimeManager,
  issueModelGatewayRuntimeToken,
  runtimeNetworkRequiresEgressOptIn,
  syncRuntimeDshProfile,
  syncRuntimeModelProvider,
  verifyModelGatewayRuntimeToken,
} from "../src/runtimeManager.mjs";

const secret = "model-gateway-signing-secret-with-at-least-32-bytes";

test("only the explicitly configured internal runtime network bypasses public-egress opt-in", () => {
  assert.equal(runtimeNetworkRequiresEgressOptIn("open-science-runtime-internal", "open-science-runtime-internal"), false);
  assert.equal(runtimeNetworkRequiresEgressOptIn("bridge", "open-science-runtime-internal"), true);
  assert.equal(runtimeNetworkRequiresEgressOptIn("another-named-network", "open-science-runtime-internal"), true);
});

async function fixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "runtime-model-provider-"));
  const project = {
    id: "paper-1",
    userId: "alice",
    rootDir,
    workspaceDir: path.join(rootDir, "workspace"),
    runtimeDir: path.join(rootDir, "runtime"),
  };
  const plan = {
    sandboxMode: "host",
    xdgConfigDir: path.join(project.runtimeDir, "xdg-config"),
    proxyWorkspaceDir: project.workspaceDir,
  };
  await mkdir(plan.xdgConfigDir, { recursive: true });
  return { rootDir, project, plan };
}

function config(overrides = {}) {
  return {
    deepseekProviderEnabled: true,
    deepseekModel: "deepseek-v4-pro",
    modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
    modelGatewaySigningSecret: secret,
    ...overrides,
  };
}

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

test("runtime bootstrap safely merges a managed DeepSeek provider without persisting the real key", async (t) => {
  const { rootDir, project, plan } = await fixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const opencodeRoot = path.join(plan.xdgConfigDir, "opencode");
  await mkdir(opencodeRoot, { recursive: true });
  await writeFile(path.join(opencodeRoot, "opencode.json"), JSON.stringify({ mcp: { retained: { type: "remote" } } }));

  const result = await syncRuntimeModelProvider(config({ deepseekApiKey: "must-never-be-written" }), project, plan, {
    nowSeconds: 2_000,
    jti: "runtime-token-2",
  });
  const saved = JSON.parse(await readFile(path.join(opencodeRoot, "opencode.json"), "utf8"));

  assert.equal(saved.model, "deepseek/deepseek-v4-pro");
  assert.equal(saved.provider.deepseek.npm, "@ai-sdk/openai-compatible");
  assert.equal(saved.provider.deepseek.options.baseURL, "http://127.0.0.1:8787/internal/model/v1");
  assert.equal(saved.provider.deepseek.options.apiKey, result.token);
  assert.deepEqual(saved.provider.deepseek.models, {
    "deepseek-v4-pro": { name: "DeepSeek V4 Pro" },
  });
  assert.deepEqual(saved.mcp, { retained: { type: "remote" } });
  assert.deepEqual(saved.permission, {
    bash: "allow",
    edit: "allow",
    write: "allow",
    webfetch: "allow",
  });
  assert.doesNotMatch(JSON.stringify(saved), /must-never-be-written/);
});

test("docker-isolated runtimes cannot invoke the dead direct web fetch path", async (t) => {
  const { rootDir, project, plan } = await fixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const isolatedPlan = { ...plan, sandboxMode: "docker" };
  await syncRuntimeModelProvider(config(), project, isolatedPlan, {
    nowSeconds: 2_000,
    jti: "runtime-token-isolated",
  });
  const saved = JSON.parse(await readFile(path.join(plan.xdgConfigDir, "opencode", "opencode.json"), "utf8"));
  assert.equal(saved.permission.webfetch, "deny");
});

test("runtime bootstrap rejects a foreign reserved provider and rotates only marker-owned tokens", async (t) => {
  const { rootDir, project, plan } = await fixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const opencodeRoot = path.join(plan.xdgConfigDir, "opencode");
  await mkdir(opencodeRoot, { recursive: true });
  await writeFile(path.join(opencodeRoot, "opencode.json"), JSON.stringify({ provider: { deepseek: { name: "foreign" } } }));
  await assert.rejects(
    () => syncRuntimeModelProvider(config(), project, plan),
    (error) => error?.code === "runtime_model_provider_collision",
  );

  await writeFile(path.join(opencodeRoot, "opencode.json"), "{}", "utf8");
  const first = await syncRuntimeModelProvider(config(), project, plan, { nowSeconds: 2_000, jti: "runtime-old" });
  const second = await syncRuntimeModelProvider(config(), project, plan, { nowSeconds: 2_010, jti: "runtime-new" });
  assert.notEqual(first.token, second.token);
});

test("RuntimeManager accepts only the current active runtime token and rejects it after stop", async (t) => {
  const manager = new RuntimeManager(config());
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
    dshVersion: "0.1.1-rc.2",
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
  const plan = { sandboxMode: "host", dshHomeDir: path.join(rootDir, "runtime", "dsh-home"), proxyWorkspaceDir: project.workspaceDir };
  return { rootDir, project, plan };
}

test("the screening plugin's batch size reaches the container from the control plane", async (t) => {
  // It was hard-coded at 50 in the bundle with no row addressing it, so a
  // deployment whose records are long had to edit the plug to change it. The
  // concurrency ceiling is deliberately the delegation one rather than a second
  // number: a screening child is a delegation child (§10.4).
  const { rootDir, project, plan } = await dshFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await syncRuntimeDshProfile(dshFixtureConfig(), project, plan);
  const patch = await readFile(path.join(plan.dshHomeDir, "control-plane-patch.yml"), "utf8");
  const row = patch.slice(patch.indexOf("- id: evimed-screening"));
  assert.match(row, /^- id: evimed-screening\n  config:\n    batchSize: 25\n    maxParallelChildren: 30\n/);
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
  // In host sandbox mode there is no container indirection, so the runtime
  // path the MCP subprocess is told and the host path the control plane wrote
  // to are the same path (unlike the docker case, covered separately below).
  assert.match(patch, new RegExp(`EVIMED_WORKLOAD_TOKEN_FILE: '${path.join(plan.dshHomeDir, "evimed-workload.token").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  // The literal provider key never appears — only the reference name does.
  assert.equal(patch.includes("must-never-be-written"), false);

  const credentials = await readFile(path.join(plan.dshHomeDir, ".credentials.yaml"), "utf8");
  assert.match(credentials, /EVIMED_WORKLOAD_TOKEN: '[^']+'/);

  // A capsule endpoint that is not built yet fails closed and visibly — an
  // empty URL the plugin itself recognizes and disables on — not silently
  // pointed at something that does not exist.
  assert.match(patch, /capsuleGatewayUrl|recallUrl: ''/);

  const workloadToken = await readFile(result.workloadTokenFile, "utf8");
  assert.ok(workloadToken.trim().split(".").length >= 3, "the MCP subprocess token is a signed JWT-shaped value");
});

test("syncRuntimeDshProfile places --patch's target under $DSH_HOME, matching what the entrypoint passes", async (t) => {
  const { rootDir, project, plan } = await dshFixture();
  plan.sandboxMode = "docker";
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
