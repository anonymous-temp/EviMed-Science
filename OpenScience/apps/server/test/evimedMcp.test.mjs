import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.mjs";
import { SCIENCE_CONNECTORS } from "../src/runtimeManager.mjs";
import { MCP_CLIENT_PLUGIN, WORKLOAD_TOKEN_REF } from "../src/dshProfilePatch.mjs";
import {
  RUNTIME_KERNEL_NAME,
  RuntimeManager,
  evimedWorkloadRefreshIntervalMs,
  issueEviMedWorkloadToken,
  modelGatewayTokenFileName,
  refreshEviMedWorkloadToken,
  syncRuntimeDshProfile,
  validateEviMedAdapterConfig,
  verifyEviMedWorkloadToken,
  verifyModelGatewayRuntimeToken,
} from "../src/runtimeManager.mjs";
import { MCP_SERVER_NAME, MCP_TOOL_BASE_NAMES, MCP_TOOL_PREFIX } from "@evimed/domain";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const signingSecret = "test-only-evimed-workload-signing-secret-with-32-bytes";
const modelGatewaySecret = "test-only-model-gateway-signing-secret-with-32-bytes";

/** Where the runtime image keeps the research MCP. The retired kernel had the
 *  control plane copy the Python tree into each project's config directory and
 *  then name the copy; this one bakes it into the image read-only, shared by
 *  every project, so there is no per-project copy to make, own or roll back. */
const imageMcpServerPath = "/opt/evimed/mcp/evimed-research/server.py";


async function fixture(root) {
  const projectRoot = path.join(root, "project");
  const workspaceDir = path.join(projectRoot, "workspace");
  const runtimeDir = path.join(projectRoot, "runtime");
  const metaDir = path.join(projectRoot, ".openscience");
  const dshHomeDir = path.join(runtimeDir, "dsh-home");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(metaDir, { recursive: true }),
  ]);
  return {
    project: {
      id: "project-1",
      userId: "user-1",
      rootDir: projectRoot,
      baseDir: workspaceDir,
      workspaceDir,
      runtimeDir,
      metaDir,
    },
    dshHomeDir,
    plan: { sandboxMode: "host", dshHomeDir, proxyWorkspaceDir: workspaceDir },
  };
}

/** The settings every DSH profile needs before it can render at all: which
 *  gateway, which certified model, and the two signing keys. Everything a test
 *  is actually about is passed on top of this. */
function dshConfig(overrides = {}) {
  return {
    deepseekProviderEnabled: true,
    deepseekModel: "deepseek-v4-pro",
    modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
    modelGatewaySigningSecret: modelGatewaySecret,
    evimedWorkloadSigningSecret: signingSecret,
    evimedWorkloadTokenTtlSeconds: 300,
    socketBundleVersion: "0.1.0",
    dshVersion: "0.1.2-alpha.5",
    runtimeSandboxEnforcement: "full",
    evimedAdapterUrls: {},
    ...overrides,
  };
}

async function readPatch(plan) {
  return readFile(path.join(plan.dshHomeDir, "control-plane-patch.yml"), "utf8");
}

/**
 * The MCP subprocess's environment, read back out of the generated patch.
 *
 * The retired kernel took it as a JSON object in a config file the control
 * plane owned; this one takes it as `env:` rows of one generated YAML file. The
 * rows are the same facts, so reading them back is what lets the assertions
 * below stay about the environment rather than about YAML.
 */
function mcpEnvironment(patch) {
  const lines = patch.split("\n");
  const start = lines.findIndex((line) => line === "        env:");
  assert.notEqual(start, -1, "the generated patch carries no MCP environment block");
  const environment = {};
  for (const line of lines.slice(start + 1)) {
    const match = /^ {10}([A-Za-z0-9_]+): '(.*)'$/.exec(line);
    if (!match) break;
    environment[match[1]] = match[2].replace(/''/g, "'");
  }
  assert.ok(Object.keys(environment).length > 0, "the MCP environment block parsed to nothing");
  return environment;
}


test("loadConfig resolves the bundled EviMed MCP source and explicit adapter URLs", () => {
  const config = loadConfig({
    rootDir: repoRoot,
    evimedMcpSourceDir: "runtime/mcp/evimed-research",
    evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" },
    evimedWorkloadSigningSecret: signingSecret,
  });

  assert.equal(config.evimedMcpSourceDir, path.join(repoRoot, "runtime/mcp/evimed-research"));
  assert.deepEqual(config.evimedAdapterUrls, {
    literatureSearch: "https://evidence.internal/literature",
  });
  assert.equal(config.evimedWorkloadSigningSecret, signingSecret);
  assert.equal(config.evimedWorkloadSigningSecretSource, "override");
});

test("all seven science connector MCP processes expose an independent tool contract", async (t) => {
  const script = path.join(repoRoot, "runtime/mcp/evimed-research/science_connectors.py");
  const expected = {
    "paper-search": "search_papers",
    biomcp: "search_biomedical_records",
    "materials-project": "search_materials",
    fred: "get_fred_series",
    spaceweather: "get_space_weather_alerts",
    "open-meteo": "get_weather",
    "usgs-water": "get_usgs_water_data",
  };
  for (const [connector, tool] of Object.entries(expected)) {
    await t.test(connector, () => {
      const result = spawnSync("python3", [script], {
        encoding: "utf8",
        env: { ...process.env, OPEN_SCIENCE_CONNECTOR_ID: connector },
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const messages = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(messages[0].result.serverInfo.name, `evimed-science-${connector}`);
      assert.equal(messages[1].result.tools[0].name, tool);
      assert.equal(messages[1].result.tools[0].inputSchema.additionalProperties, false);
    });
  }
});

test("production specialist readiness fails closed when a visible agent adapter is missing", () => {
  assert.throws(
    () => validateEviMedAdapterConfig({
      requireAllSpecialistAdapters: true,
      evimedAdapterUrls: { metaAnalysis: "https://meta.internal/api/v1/evimed/meta-analysis" },
      production: true,
      evimedWorkloadSigningSecret: signingSecret,
      evimedWorkloadTokenTtlSeconds: 300,
    }),
    (error) => error?.code === "runtime_specialist_adapters_missing"
      && /EVIMED_ADR_CASE_QUERY_URL/.test(error.message)
      && /EVIMED_PEER_REVIEW_URL/.test(error.message)
      && /EVIMED_DRUG_SAFETY_ANALYSIS_URL/.test(error.message),
  );
});


test("EviMed workload tokens bind audience, project, expiry, and signature", () => {
  const token = issueEviMedWorkloadToken({
    secret: signingSecret,
    userId: "user-1",
    projectId: "project-1",
    nowSeconds: 1_000,
    ttlSeconds: 120,
    jti: "jti-fixed",
  });
  const payload = verifyEviMedWorkloadToken(token, {
    secret: signingSecret,
    audience: "evimed-adapter",
    userId: "user-1",
    projectId: "project-1",
    nowSeconds: 1_060,
  });
  assert.deepEqual(payload, {
    v: 1,
    aud: "evimed-adapter",
    userId: "user-1",
    projectId: "project-1",
    iat: 1_000,
    exp: 1_120,
    jti: "jti-fixed",
  });
  const [header, body, signature] = token.split(".");
  const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("x") ? "y" : "x"}`;
  for (const { candidate, expectations } of [
    { candidate: `${header}.${body}.${tamperedSignature}`, expectations: {} },
    { candidate: token, expectations: { audience: "wrong-audience" } },
    { candidate: token, expectations: { projectId: "project-2" } },
    { candidate: token, expectations: { nowSeconds: 1_121 } },
  ]) {
    assert.throws(
      () => verifyEviMedWorkloadToken(candidate, {
        secret: signingSecret,
        audience: "evimed-adapter",
        userId: "user-1",
        projectId: "project-1",
        nowSeconds: 1_060,
        ...expectations,
      }),
      (error) => error?.code === "evimed_workload_token_invalid",
    );
  }
});


// A project starts its runtime once and keeps it, so a channel the platform
// configured and then failed to pass through stays invisible until something
// forces a second start — a container recreate, a host reboot. It did: the
// web-search work added EVIMED_WEB_SEARCH_GATEWAY_URL to what gets written
// without adding it to the set the ownership check allowed, and every project
// that had started a runtime could never start one again.
//
// The kernel that had a config file to own is gone; the patch is regenerated
// from scratch on every start, so there is no ownership check left to fail.
// What survives is the half of the property that was always the point: every
// optional channel the deployment switched on has to reach the MCP subprocess,
// and starting a second time has to produce the same runtime as the first.
test("every optional evidence channel the platform configures reaches the runtime, twice", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-rewrite-"));
  try {
    const { project, plan } = await fixture(tmp);
    const config = dshConfig({
      evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" },
      publicSourceGatewayInternalUrl: "https://gateway.internal/internal/sources/v1/fetch",
      // The variable is only written when the deployment actually has a
      // metasearch backend, which is why the defect needed a configured one to
      // reproduce and why every deployment that has one was affected.
      webSearchUrl: "http://open-science-web-search:8080/search",
      webSearchGatewayInternalUrl: "https://gateway.internal/internal/search/v1/query",
      // Every optional channel has to be switched on here or this test does not
      // cover it: it only proves the writer passes through the variables the
      // fixture actually causes to be written. The GEO probe is the second
      // variable to take this route.
      geoProbeUrl: "http://geo-probe.internal:9999",
      geoProbeGatewayInternalUrl: "https://gateway.internal/internal/geo-probe/v1",
      publicSourceCredentials: { unpaywall: "evimed@example.test" },
    });
    await syncRuntimeDshProfile(config, project, plan, { nowSeconds: 1_000, jti: "mgw-first" });
    const first = await readPatch(plan);
    const environment = mcpEnvironment(first);
    assert.equal(
      environment.EVIMED_PUBLIC_SOURCE_GATEWAY_URL,
      "https://gateway.internal/internal/sources/v1/fetch",
      "the writer emits the source gateway address",
    );
    assert.equal(
      environment.EVIMED_WEB_SEARCH_GATEWAY_URL,
      "https://gateway.internal/internal/search/v1/query",
      "the writer emits the search gateway address",
    );
    assert.equal(
      environment.EVIMED_GEO_PROBE_GATEWAY_URL,
      "https://gateway.internal/internal/geo-probe/v1",
      "the writer emits the probe gateway address",
    );
    assert.equal(environment.EVIMED_UNPAYWALL_EMAIL, "evimed@example.test");
    assert.equal(environment.EVIMED_LITERATURE_SEARCH_URL, "https://evidence.internal/literature");

    // The second start is where it broke. Nothing in the patch may depend on
    // whether one has been written before.
    await syncRuntimeDshProfile(config, project, plan, { nowSeconds: 2_000, jti: "mgw-second" });
    assert.equal(await readPatch(plan), first);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("the generated patch mounts the research MCP and hands it a token, never a key", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-"));
  try {
    const { project, plan } = await fixture(tmp);
    const result = await syncRuntimeDshProfile(
      dshConfig({
        evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" },
        deepseekApiKey: "must-never-be-written",
      }),
      project,
      plan,
    );

    assert.equal(result.configured, true);
    assert.equal(result.workloadTokenFile, path.join(plan.dshHomeDir, "evimed-workload.token"));
    assert.equal(result.workloadTokenRefreshMs, 150_000);

    const patch = await readPatch(plan);
    // One MCP row, naming the plugin that speaks MCP, the server name the model
    // sees its tools under, and the interpreter and script the image carries.
    assert.match(patch, /^ {4}- id: mcp-evimed$/m);
    assert.match(patch, new RegExp(`^ {6}name: '${MCP_CLIENT_PLUGIN.replace(/[/@-]/g, "\\$&")}'$`, "m"));
    assert.match(patch, new RegExp(`^ {8}serverName: '${MCP_SERVER_NAME}'$`, "m"));
    assert.match(patch, /^ {8}command: python3$/m);
    assert.match(patch, new RegExp(`^ {10}- '${imageMcpServerPath.replace(/\//g, "\\/")}'$`, "m"));
    // A runtime without the research tools cannot do the work it would accept.
    assert.match(patch, /^ {8}failOnStartupError: true$/m);

    assert.deepEqual(mcpEnvironment(patch), {
      EVIMED_MODEL_GATEWAY_MODEL: "deepseek-v4-pro",
      EVIMED_MODEL_GATEWAY_TOKEN_FILE: `/runtime/dsh-home/${modelGatewayTokenFileName}`,
      EVIMED_MODEL_GATEWAY_URL: "http://127.0.0.1:8787/internal/model/v1",
      EVIMED_LITERATURE_SEARCH_URL: "https://evidence.internal/literature",
      EVIMED_WORKLOAD_TOKEN_FILE: path.join(plan.dshHomeDir, "evimed-workload.token"),
      OPEN_SCIENCE_PROJECT_ID: "project-1",
      OPEN_SCIENCE_TENANT_ID: "user-1",
      OPEN_SCIENCE_USER_ID: "user-1",
      OPEN_SCIENCE_WORKSPACE_DIR: project.workspaceDir,
    });

    const workloadTokenFile = result.workloadTokenFile;
    const workloadToken = (await readFile(workloadTokenFile, "utf8")).trim();
    assert.equal((await stat(workloadTokenFile)).mode & 0o777, 0o600);
    assert.equal(
      verifyEviMedWorkloadToken(workloadToken, {
        secret: signingSecret,
        audience: "evimed-adapter",
        userId: "user-1",
        projectId: "project-1",
      }).projectId,
      "project-1",
    );

    // The patch is a generated file that ships to a container. It names a
    // credential reference; it carries no credential.
    assert.match(patch, new RegExp(`^ {4}apiKeyEnv: '${WORKLOAD_TOKEN_REF}'$`, "m"));
    assert.doesNotMatch(patch, /apiKey:|Authorization|Bearer/);
    assert.equal(patch.includes(signingSecret), false);
    assert.equal(patch.includes(modelGatewaySecret), false);
    assert.equal(patch.includes(workloadToken), false);
    assert.equal(patch.includes("must-never-be-written"), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("host runtimes bind the local MetaAgent, and the MCP reads the gateway from a token file", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-meta-host-"));
  try {
    const { project, plan } = await fixture(tmp);
    const metaAgentRoot = path.join(tmp, "meta");
    await mkdir(path.join(metaAgentRoot, "new_meta"), { recursive: true });
    await writeFile(path.join(metaAgentRoot, "new_meta", "main.py"), "# test fixture\n");
    await syncRuntimeDshProfile(
      dshConfig({ metaAgentRoot, metaAgentPython: "/usr/bin/python3" }),
      project,
      plan,
      { nowSeconds: 5_000, jti: "mgw-meta" },
    );
    const environment = mcpEnvironment(await readPatch(plan));
    assert.equal(environment.EVIMED_META_AGENT_ROOT, metaAgentRoot);
    assert.equal(environment.EVIMED_META_AGENT_PYTHON, "/usr/bin/python3");

    // The retired kernel let the MCP read `provider.deepseek.options.apiKey`
    // out of the kernel's own config file. There is no such file now, so the
    // gateway travels as three named facts and the credential as a file of its
    // own — the MCP never parses a kernel's configuration to learn who it is
    // talking to, and never sees a provider key either.
    assert.equal(environment.EVIMED_MODEL_CONFIG_FILE, undefined);
    assert.equal(environment.EVIMED_MODEL_GATEWAY_URL, "http://127.0.0.1:8787/internal/model/v1");
    assert.equal(environment.EVIMED_MODEL_GATEWAY_MODEL, "deepseek-v4-pro");
    assert.equal(environment.EVIMED_MODEL_GATEWAY_TOKEN_FILE, `/runtime/dsh-home/${modelGatewayTokenFileName}`);
    assert.equal(JSON.stringify(environment).includes("apiKey"), false);

    // And the token in that file is bound to this audience and this project:
    // a token minted for another project must not open this one's gateway.
    const tokenFile = path.join(plan.dshHomeDir, modelGatewayTokenFileName);
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    const gatewayToken = (await readFile(tokenFile, "utf8")).trim();
    const payload = verifyModelGatewayRuntimeToken(gatewayToken, {
      secret: modelGatewaySecret,
      userId: "user-1",
      projectId: "project-1",
      nowSeconds: 5_001,
    });
    assert.equal(payload.aud, "evimed-model-gateway");
    assert.equal(payload.projectId, "project-1");
    for (const wrong of [{ projectId: "project-2" }, { userId: "user-2" }]) {
      assert.throws(
        () => verifyModelGatewayRuntimeToken(gatewayToken, {
          secret: modelGatewaySecret,
          userId: "user-1",
          projectId: "project-1",
          nowSeconds: 5_001,
          ...wrong,
        }),
        (error) => error?.code === "model_gateway_token_invalid",
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("host runtimes bind a bounded pharmacy reference while docker requires its HTTP adapter", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-pharmacy-"));
  try {
    const { project, plan } = await fixture(tmp);
    const pharmacyReferenceDb = path.join(tmp, "pharmacy-reference.sqlite");
    await writeFile(pharmacyReferenceDb, "bounded test database fixture");
    await syncRuntimeDshProfile(dshConfig({ pharmacyReferenceDb }), project, plan);
    assert.equal(
      mcpEnvironment(await readPatch(plan)).EVIMED_PHARMACY_REFERENCE_DB,
      pharmacyReferenceDb,
    );

    const dockerPlan = { ...plan, sandboxMode: "docker", proxyWorkspaceDir: "/workspace" };
    await assert.rejects(
      () => syncRuntimeDshProfile(dshConfig({ pharmacyReferenceDb }), project, dockerPlan),
      (error) => error?.code === "runtime_pharmacy_reference_adapter_required",
    );
    await syncRuntimeDshProfile(
      dshConfig({
        pharmacyReferenceDb,
        evimedAdapterUrls: { pharmacyReferenceSearch: "https://pharmacy.internal/reference" },
      }),
      project,
      dockerPlan,
    );
    const environment = mcpEnvironment(await readPatch(dockerPlan));
    assert.equal(environment.EVIMED_PHARMACY_REFERENCE_SEARCH_URL, "https://pharmacy.internal/reference");
    assert.equal(environment.EVIMED_PHARMACY_REFERENCE_DB, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("docker runtimes require the MetaAgent HTTP adapter instead of a host source path", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-meta-docker-"));
  try {
    const { project, plan } = await fixture(tmp);
    const dockerPlan = { ...plan, sandboxMode: "docker", proxyWorkspaceDir: "/workspace" };
    const metaAgentRoot = path.join(tmp, "meta");
    await assert.rejects(
      () => syncRuntimeDshProfile(dshConfig({ metaAgentRoot }), project, dockerPlan),
      (error) => error?.code === "runtime_meta_agent_adapter_required",
    );

    await syncRuntimeDshProfile(
      dshConfig({
        metaAgentRoot,
        evimedAdapterUrls: { metaAnalysis: "https://meta.internal/api/v1/evimed/meta-analysis" },
      }),
      project,
      dockerPlan,
    );
    const environment = mcpEnvironment(await readPatch(dockerPlan));
    assert.equal(environment.EVIMED_META_ANALYSIS_URL, "https://meta.internal/api/v1/evimed/meta-analysis");
    assert.equal(environment.EVIMED_META_AGENT_ROOT, undefined);
    // Inside a container the token file is a container path, not the host one
    // the control plane rewrites.
    assert.equal(environment.EVIMED_WORKLOAD_TOKEN_FILE, "/runtime/dsh-home/evimed-workload.token");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("workload token file converges across signing-key rotation", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-key-rotation-"));
  const rotatedSecret = "rotated-test-only-evimed-workload-secret-with-32-bytes";
  try {
    const { project, plan } = await fixture(tmp);
    const base = { evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" } };
    await syncRuntimeDshProfile(dshConfig(base), project, plan);
    const tokenFile = path.join(plan.dshHomeDir, "evimed-workload.token");
    const first = (await readFile(tokenFile, "utf8")).trim();
    verifyEviMedWorkloadToken(first, {
      secret: signingSecret,
      userId: project.userId,
      projectId: project.id,
    });

    await syncRuntimeDshProfile(
      dshConfig({ ...base, evimedWorkloadSigningSecret: rotatedSecret }), project, plan,
    );
    const second = (await readFile(tokenFile, "utf8")).trim();
    assert.notEqual(second, first);
    verifyEviMedWorkloadToken(second, {
      secret: rotatedSecret,
      userId: project.userId,
      projectId: project.id,
    });
    assert.throws(
      () => verifyEviMedWorkloadToken(second, {
        secret: signingSecret,
        userId: project.userId,
        projectId: project.id,
      }),
      (error) => error?.code === "evimed_workload_token_invalid",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("the MCP is told where its token is exactly when workload signing is configured", async (t) => {
  await t.test("signing configured: the row appears and the file is minted 0600", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-token-upgrade-"));
    try {
      const { project, plan } = await fixture(tmp);
      await syncRuntimeDshProfile(dshConfig(), project, plan);
      const tokenFile = path.join(plan.dshHomeDir, "evimed-workload.token");
      assert.equal(mcpEnvironment(await readPatch(plan)).EVIMED_WORKLOAD_TOKEN_FILE, tokenFile);
      assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // The other half, and it does not hold today.
  //
  // `evimedMcpEnvironment` still emits EVIMED_WORKLOAD_TOKEN_FILE only when a
  // signing secret is configured — so the environment side still describes a
  // deployment that has none. `syncRuntimeDshProfile` then calls
  // `refreshEviMedWorkloadToken` unconditionally, which refuses to mint a token
  // without a secret, so the whole runtime bootstrap throws
  // `runtime_mcp_workload_secret_invalid` before anything starts. A deployment
  // without .evimed-local/secrets/evimed-workload.signing therefore cannot start
  // a runtime at all, and the failure names a token nobody asked for.
  //
  // The retired kernel made both halves conditional together; the fix belongs in
  // `syncRuntimeDshProfile` (apps/server/src/runtimeManager.mjs), which this
  // package does not own. Kept as a failing assertion rather than dropped,
  // because dropping it is how the regression becomes permanent.
  await t.test("no signing secret: the runtime still starts, with no token row", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-token-unsigned-"));
    try {
      const { project, plan } = await fixture(tmp);
      await syncRuntimeDshProfile(dshConfig({ evimedWorkloadSigningSecret: "" }), project, plan);
      assert.equal(mcpEnvironment(await readPatch(plan)).EVIMED_WORKLOAD_TOKEN_FILE, undefined);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});


test("MCP bootstrap is idempotent when the managed public-source gateway is enabled", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-gateway-restart-"));
  try {
    const { project, plan } = await fixture(tmp);
    const settings = dshConfig({ publicSourceGatewayInternalUrl: "http://127.0.0.1:8799" });

    await syncRuntimeDshProfile(settings, project, plan);
    await syncRuntimeDshProfile(settings, project, plan);

    assert.equal(
      mcpEnvironment(await readPatch(plan)).EVIMED_PUBLIC_SOURCE_GATEWAY_URL,
      "http://127.0.0.1:8799",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("workload token refresh atomically writes a valid token at half-TTL", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-refresh-"));
  try {
    const { project, plan } = await fixture(tmp);
    const tokenFile = path.join(plan.dshHomeDir, "evimed-workload.token");
    assert.equal(evimedWorkloadRefreshIntervalMs({ evimedWorkloadTokenTtlSeconds: 120 }), 60_000);
    const refreshed = await refreshEviMedWorkloadToken(
      {
        evimedWorkloadSigningSecret: signingSecret,
        evimedWorkloadTokenTtlSeconds: 120,
      },
      project,
      tokenFile,
      { nowSeconds: 2_000, jti: "refresh-fixed" },
    );
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    assert.deepEqual(
      verifyEviMedWorkloadToken((await readFile(tokenFile, "utf8")).trim(), {
        secret: signingSecret,
        userId: project.userId,
        projectId: project.id,
        nowSeconds: 2_001,
      }),
      refreshed.payload,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("RuntimeManager clears workload refresh timers and fails closed on refresh write errors", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-refresh-manager-"));
  try {
    const { project, plan } = await fixture(tmp);
    const tokenFile = path.join(plan.dshHomeDir, "evimed-workload.token");
    const timers = [];
    const cleared = [];
    const manager = new RuntimeManager({
      evimedWorkloadSigningSecret: signingSecret,
      evimedWorkloadTokenTtlSeconds: 120,
      evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" },
      maxLogFileBytes: 1024 * 1024,
    }, {
      setWorkloadTimer(callback, delay) {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearWorkloadTimer(timer) {
        cleared.push(timer);
      },
    });
    let closed = 0;
    const runtime = {
      kind: RUNTIME_KERNEL_NAME,
      sandboxMode: "docker",
      networkMode: null,
      startedAt: new Date().toISOString(),
      pid: 123,
      exitedAt: null,
      containerName: null,
      workloadTokenFile: tokenFile,
      close: async () => { closed += 1; },
    };
    manager.runtimes.set(manager.key(project), runtime);
    manager.scheduleEviMedWorkloadRefresh(project, runtime);
    assert.equal(timers[0].delay, 60_000);
    await manager.stop(project);
    assert.deepEqual(cleared, [timers[0]]);
    assert.equal(closed, 1);

    const failingManager = new RuntimeManager({
      evimedWorkloadSigningSecret: signingSecret,
      evimedWorkloadTokenTtlSeconds: 120,
      evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" },
      maxLogFileBytes: 1024 * 1024,
    }, {
      workloadTokenWriter: async () => { throw new Error("injected refresh failure"); },
    });
    let failedClosed = 0;
    const failingRuntime = {
      ...runtime,
      close: async () => { failedClosed += 1; },
    };
    const key = failingManager.key(project);
    const monitor = { timer: null };
    failingManager.runtimes.set(key, failingRuntime);
    failingManager.evimedWorkloadRefreshTimers.set(key, monitor);
    await failingManager.refreshEviMedRuntimeToken(project, monitor);
    assert.equal(failedClosed, 1);
    assert.equal(failingManager.runtimes.has(key), false);
    const state = JSON.parse(await readFile(path.join(project.metaDir, "runtime-state.json"), "utf8"));
    assert.equal(state.error, "runtime_workload_token_refresh_failed");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("production adapter bootstrap requires a workload signing secret", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-token-required-"));
  try {
    const { project, plan } = await fixture(tmp);
    await assert.rejects(
      () => syncRuntimeDshProfile(
        dshConfig({
          production: true,
          evimedWorkloadSigningSecret: "",
          evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" },
        }),
        project,
        plan,
      ),
      (error) => error?.code === "runtime_mcp_workload_secret_missing",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("MCP bootstrap rebinds the workspace the MCP sees when the active workspace changes", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-rebind-"));
  try {
    const { project, plan } = await fixture(tmp);
    await syncRuntimeDshProfile(dshConfig(), project, plan);

    const datedWorkspace = path.join(project.baseDir, "2026-07-17-1011");
    await mkdir(datedWorkspace);
    project.workspaceDir = datedWorkspace;
    await syncRuntimeDshProfile(dshConfig(), project, { ...plan, proxyWorkspaceDir: datedWorkspace });

    assert.equal(mcpEnvironment(await readPatch(plan)).OPEN_SCIENCE_WORKSPACE_DIR, datedWorkspace);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("MCP bootstrap safely rebases its managed paths after a whitespace-only workspace rename", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-root-rebase-"));
  try {
    const oldContainer = path.join(tmp, "EviMed Science");
    const newContainer = path.join(tmp, "EviMedScience");
    const initial = await fixture(oldContainer);
    const oldSpecialistRoot = path.join(oldContainer, "项目代码", "科研选题");
    await mkdir(path.join(oldSpecialistRoot, "services"), { recursive: true });
    await writeFile(path.join(oldSpecialistRoot, "services", "task_service.py"), "# fixture\n");
    await syncRuntimeDshProfile(
      dshConfig({ specialistAgents: { researchTopicSelection: { root: oldSpecialistRoot, python: "" } } }),
      initial.project,
      initial.plan,
    );

    await rename(oldContainer, newContainer);
    const rebase = (value) => path.join(newContainer, path.relative(oldContainer, value));
    const project = Object.fromEntries(
      Object.entries(initial.project).map(([key, value]) => [key, typeof value === "string" && path.isAbsolute(value) ? rebase(value) : value]),
    );
    const specialistRoot = rebase(oldSpecialistRoot);
    const plan = { ...initial.plan, dshHomeDir: rebase(initial.plan.dshHomeDir), proxyWorkspaceDir: project.workspaceDir };
    await syncRuntimeDshProfile(
      dshConfig({ specialistAgents: { researchTopicSelection: { root: specialistRoot, python: "" } } }),
      project,
      plan,
    );

    const patch = await readPatch(plan);
    const environment = mcpEnvironment(patch);
    // The server script is the image's own path, so a rename on the host cannot
    // reach it — that is the whole reason it stopped being a per-project copy.
    assert.match(patch, new RegExp(`^ {10}- '${imageMcpServerPath.replace(/\//g, "\\/")}'$`, "m"));
    assert.equal(environment.OPEN_SCIENCE_WORKSPACE_DIR, project.workspaceDir);
    assert.equal(environment.EVIMED_RESEARCH_TOPIC_AGENT_ROOT, specialistRoot);
    assert.equal(environment.EVIMED_WORKLOAD_TOKEN_FILE, path.join(plan.dshHomeDir, "evimed-workload.token"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("MCP bootstrap refuses a DSH home reached through a symbolic link", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-symlink-"));
  try {
    const { project, plan } = await fixture(tmp);
    const outside = path.join(tmp, "outside-dsh-home");
    await mkdir(outside, { recursive: true });
    await symlink(outside, plan.dshHomeDir, "dir");
    await assert.rejects(
      () => syncRuntimeDshProfile(dshConfig(), project, plan),
      (error) => error?.code === "path_forbidden",
    );
    // Nothing was written through the link.
    await assert.rejects(readFile(path.join(outside, "control-plane-patch.yml")), { code: "ENOENT" });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("runtime bootstrap fails closed with the specific cause and writes nothing", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-start-"));
  try {
    const { project, plan } = await fixture(tmp);
    // The caller gets the cause, not the stage. Every bootstrap failure used to
    // arrive as runtime_bootstrap_failed, with the real code readable only in a
    // ledger inside a Docker volume.
    await assert.rejects(
      () => syncRuntimeDshProfile(dshConfig({ deepseekModel: "deepseek-v3-legacy" }), project, plan),
      (error) => error?.code === "runtime_model_gateway_model_invalid",
    );
    await assert.rejects(readPatch(plan), { code: "ENOENT" });
    await assert.rejects(
      readFile(path.join(plan.dshHomeDir, modelGatewayTokenFileName)),
      { code: "ENOENT" },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("production web image includes specialty agents and the Python EviMed MCP source", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /COPY --from=build \/app\/runtime\/skills\/evimed \.\/runtime\/skills\/evimed/,
  );
  assert.match(
    dockerfile,
    /COPY --from=build \/app\/runtime\/mcp\/evimed-research \.\/runtime\/mcp\/evimed-research/,
  );
});


test("the runtime image carries the research MCP the generated patch names", async () => {
  // The patch names an absolute path inside the container. If the image stopped
  // copying that tree the row would still render, the container would still
  // boot, and every research tool would be missing — with `failOnStartupError`
  // turning that into a runtime that refuses work rather than one that does it
  // badly, which is why the copy is worth pinning to the path.
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /COPY runtime\/mcp\/evimed-research \/opt\/evimed\/mcp\/evimed-research/,
  );
  assert.equal(path.posix.dirname(imageMcpServerPath), "/opt/evimed/mcp/evimed-research");
});


test("hosted deployment exposes only MCP source and non-secret adapter URL settings", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  assert.match(
    compose,
    /OPEN_SCIENCE_EVIMED_MCP_SOURCE_DIR:\s+\$\{OPEN_SCIENCE_EVIMED_MCP_SOURCE_DIR:-runtime\/mcp\/evimed-research\}/,
  );
  for (const name of [
    "EVIMED_LITERATURE_SEARCH_URL",
    "EVIMED_GUIDELINE_SEARCH_URL",
    "EVIMED_CLINICAL_TRIAL_SEARCH_URL",
    "EVIMED_PATENT_SEARCH_URL",
    "EVIMED_DRUG_LABEL_SEARCH_URL",
  ]) {
    assert.match(compose, new RegExp(name + ": \\$\\{" + name + ":-\\}"));
    assert.match(example, new RegExp(`^${name}=$`, "m"));
  }
  for (const [name, servicePath] of Object.entries({
    EVIMED_PHARMACY_REFERENCE_SEARCH_URL: "pharmacy-reference-search",
    EVIMED_ADR_CASE_QUERY_URL: "adr-cases",
    EVIMED_ADR_SIGNAL_ANALYSIS_URL: "adr-signal",
    EVIMED_OFFLABEL_EVIDENCE_PACKET_URL: "offlabel-evidence-packet",
    EVIMED_COMPREHENSIVE_DRUG_EVALUATION_URL: "comprehensive-drug-evaluation",
    EVIMED_DRUG_SELECTION_EVALUATION_URL: "drug-selection-evaluation",
  })) {
    assert.match(
      compose,
      new RegExp(`${name}: \\$\\{${name}:-http://evimed-drug-evidence-adapter:8026/api/v1/evimed/${servicePath}\\}`),
    );
    assert.match(example, new RegExp(`^${name}=$`, "m"));
  }
  assert.match(
    compose,
    /EVIMED_META_ANALYSIS_URL:\s+\$\{EVIMED_META_ANALYSIS_URL:-http:\/\/evimed-meta-agent:8024\/api\/v1\/evimed\/meta-analysis\}/,
  );
  assert.match(example, /^EVIMED_META_ANALYSIS_URL=http:\/\/evimed-meta-agent:8024\/api\/v1\/evimed\/meta-analysis$/m);
  for (const [name, target] of Object.entries({
    EVIMED_MR_ANALYSIS_URL: "evimed-mr-agent:8025/api/v1/evimed/mendelian-randomization",
    EVIMED_BIBLIOMETRIC_ANALYSIS_URL: "evimed-bibliometric-agent:8025/api/v1/evimed/bibliometric-analysis",
    EVIMED_RESEARCH_TOPIC_SELECTION_URL: "evimed-research-topic-agent:8025/api/v1/evimed/research-topic-selection",
    EVIMED_PEER_REVIEW_URL: "evimed-peer-review-agent:8025/api/v1/evimed/peer-review",
    EVIMED_DRUG_SAFETY_ANALYSIS_URL: "evimed-drug-safety-agent:8025/api/v1/evimed/drug-safety-analysis",
  })) {
    assert.match(compose, new RegExp(`${name}: \\$\\{${name}:-http://${target}\\}`));
  }
  assert.doesNotMatch(example, /EVIMED_(?:API_KEY|TOKEN|PASSWORD)=/);
  assert.match(compose, /OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET:\s+\$\{OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET:-\}/);
  assert.match(compose, /OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_FILE:\s+\/run\/secrets\/evimed-workload-signing-key/);
  assert.match(example, /^OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET=$/m);
  assert.match(example, /^OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_FILE=$/m);
  assert.match(example, /^OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_HOST_FILE=\.\/secrets\/evimed-workload-signing-key\.txt$/m);
});

// The tool table, pinned against the server that publishes it.
//
// This is the check that was missing while the two drifted for the whole
// migration: `MCP_TOOL_BASE_NAMES` was rewritten to bare names and 84 SKILL.md
// files plus eleven capability manifests were rewritten to
// `mcp__evimed__<base>` — while `server.py` went on publishing
// `evimed_<base>`. Under DSH the model would have been shown
// `mcp__evimed__evimed_literature_search`, and every name the skills referred
// to would simply not have existed. Nothing caught it because every test on
// both sides was internally consistent: the Python suite asserted the server's
// own names, and the manifest validator asserted the vocabulary's own names.
//
// Asking the server is the point. A test that imported a shared constant would
// prove the two agree about a constant, not that the server publishes what the
// vocabulary promises.
//
// It used to ask by grepping `server.py` for `"name": "..."` lines. That read
// the source text rather than the roster, and it stopped being true the moment
// a tool arrived from somewhere other than that file's own literal — seven
// connectors mounted from `science_connectors.py` were invisible to it while
// being published perfectly well. Importing the module and reading
// `TOOL_DEFINITIONS` asks for the result instead of inferring it from the
// mechanism, and cannot be fooled by however the list is assembled.
const execFile = promisify(execFileCallback);

async function publishedToolNames() {
  const script = "import json,sys; sys.path.insert(0, '.'); import server; print(json.dumps([t['name'] for t in server.TOOL_DEFINITIONS]))";
  const { stdout } = await execFile("python3", ["-c", script], {
    cwd: path.join(repoRoot, "runtime/mcp/evimed-research"),
  });
  return JSON.parse(stdout);
}

test("the MCP server publishes exactly the tools the vocabulary names", async () => {
  const published = await publishedToolNames();
  assert.ok(published.length >= 20, `only ${published.length} tool names found; the roster did not load`);

  const declared = [...MCP_TOOL_BASE_NAMES];
  assert.deepEqual([...published].sort(), [...declared].sort());

  // And none of them carries the prefix a kernel adds. `evimed_x` published
  // under the server named `evimed` becomes `mcp__evimed__evimed_x`: the prefix
  // twice, and a name no skill refers to.
  for (const name of published) {
    assert.equal(name.startsWith("evimed_"), false, `${name} repeats the server name that the kernel already prefixes`);
    assert.equal(name.startsWith(MCP_TOOL_PREFIX), false, `${name} hard-codes a kernel's presentation prefix`);
  }
});

// The other half: what an agent package may ask for has to be something the
// server offers. The registry used to keep its own copy of the list, which is
// how a manifest could name a tool nobody publishes.
test("every tool an agent package may declare is one the server publishes", async () => {
  const { EVIMED_AGENT_TOOL_IDS } = await import("../src/agentRegistry.mjs");
  const published = new Set(await publishedToolNames());
  for (const tool of EVIMED_AGENT_TOOL_IDS) {
    assert.ok(published.has(tool), `agent packages may declare "${tool}", which the MCP server does not publish`);
  }
  // `health` is an operator probe, so it is published but not declarable.
  assert.equal(EVIMED_AGENT_TOOL_IDS.has("health"), false);
  assert.equal(published.has("health"), true);
});

test("the server's science-connector roster is the same seven the runtime dispatches on", async () => {
  // This roster is declared in `runtimeManager.mjs` and called by nothing in
  // that module, so a linter reports it unused and a cleanup deletes it. That
  // happened, and it broke `hosted_science_connector_chain` in the source
  // audit, which reads the file as text precisely so the two declarations
  // cannot silently disagree about which seven connectors exist.
  //
  // This test is the consumer that makes it not dead. It also checks the thing
  // the audit's text match cannot: that the two lists agree, rather than that
  // both merely contain seven strings.
  const source = await readFile(path.join(repoRoot, "runtime/mcp/evimed-research/science_connectors.py"), "utf8");
  assert.equal(SCIENCE_CONNECTORS.length, 7, "the roster is seven connectors");
  for (const connector of SCIENCE_CONNECTORS) {
    assert.ok(
      source.includes(`"${connector}"`),
      `the server declares connector ${connector}, which science_connectors.py does not dispatch on`,
    );
  }
});

test("the kernel wire is spoken over node:http, because fetch cannot send Host", async () => {
  // `Host` is a forbidden header name in undici, so `fetch` drops it without
  // saying so. The kernel is started with `--trusted-host`, and the
  // browser-session cookie is keyed by the authority it was minted for — so a
  // request sent through `fetch` arrives claiming the socket's own address,
  // matches no trusted host, carries a cookie named for somewhere else, and is
  // answered `401 unauthorized` with nothing naming the cause. A recorder built
  // on `fetch` spent two runs on that 401.
  //
  // The production client has always used `node:http`. This keeps it there: the
  // day someone modernises one of these modules to `fetch`, the failure is a
  // red test rather than an authentication mystery in a container.
  for (const file of ["dshMux.mjs", "dshEventPump.mjs", "dshRuntimeAdapter.mjs"]) {
    const source = await readFile(path.join(repoRoot, "apps/server/src", file), "utf8");
    assert.doesNotMatch(
      source,
      /(^|[^.\w])fetch\s*\(/m,
      `${file} speaks to the kernel and must not use fetch: it silently drops the Host header the trusted-host check and the cookie both depend on`,
    );
  }
});
