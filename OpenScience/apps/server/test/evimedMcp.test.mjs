import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import {
  RuntimeManager,
  evimedWorkloadRefreshIntervalMs,
  issueEviMedWorkloadToken,
  refreshEviMedWorkloadToken,
  syncRuntimeEviMedMcp,
  validateEviMedAdapterConfig,
  verifyEviMedWorkloadToken,
} from "../src/runtimeManager.mjs";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const signingSecret = "test-only-evimed-workload-signing-secret-with-32-bytes";


async function fixture(root) {
  const sourceDir = path.join(root, "source", "evimed-research");
  const projectRoot = path.join(root, "project");
  const workspaceDir = path.join(projectRoot, "workspace");
  const runtimeDir = path.join(projectRoot, "runtime");
  const metaDir = path.join(projectRoot, ".openscience");
  const xdgConfigDir = path.join(runtimeDir, "xdg-config");
  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(metaDir, { recursive: true }),
  ]);
  await writeFile(path.join(sourceDir, "server.py"), "print('protocol')\n", { mode: 0o755 });
  await writeFile(path.join(sourceDir, "science_connectors.py"), "# connector fixture\n", { mode: 0o755 });
  await writeFile(path.join(sourceDir, "public_sources.py"), "# source fixture\n", { mode: 0o644 });
  return {
    sourceDir,
    project: {
      id: "project-1",
      userId: "user-1",
      rootDir: projectRoot,
      baseDir: workspaceDir,
      workspaceDir,
      runtimeDir,
      metaDir,
    },
    xdgConfigDir,
  };
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


test("syncRuntimeEviMedMcp atomically copies the server and safely merges docker config", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const opencodeDir = path.join(xdgConfigDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(path.join(opencodeDir, "opencode.json"), JSON.stringify({
      mcp: { existing: { type: "remote", url: "https://example.test/mcp" } },
      model: "existing/model",
    }));

    const result = await syncRuntimeEviMedMcp(
      {
        evimedMcpSourceDir: sourceDir,
        evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" },
        evimedWorkloadSigningSecret: signingSecret,
      },
      project,
      { sandboxMode: "docker", xdgConfigDir, proxyWorkspaceDir: "/workspace" },
    );

    assert.deepEqual(result, {
      copied: 1,
      configured: 8,
      workloadTokenFile: path.join(opencodeDir, "evimed-workload.token"),
      workloadTokenRefreshMs: 150_000,
    });
    assert.equal(
      await readFile(path.join(opencodeDir, "mcp", "evimed-research", "server.py"), "utf8"),
      "print('protocol')\n",
    );
    const config = JSON.parse(await readFile(path.join(opencodeDir, "opencode.json"), "utf8"));
    assert.equal(config.model, "existing/model");
    assert.equal(config.mcp.existing.url, "https://example.test/mcp");
    const managed = config.mcp["evimed-research"];
    const scienceConnectorNames = Object.keys(config.mcp).filter((name) => name.startsWith("science-")).sort();
    assert.deepEqual(scienceConnectorNames, [
      "science-biomcp",
      "science-fred",
      "science-materials-project",
      "science-open-meteo",
      "science-paper-search",
      "science-spaceweather",
      "science-usgs-water",
    ]);
    assert.deepEqual(config.mcp["science-paper-search"], {
      type: "local",
      command: ["python3", "/runtime/xdg-config/opencode/mcp/evimed-research/science_connectors.py"],
      enabled: true,
      environment: {
        OPEN_SCIENCE_CONNECTOR_ID: "paper-search",
      },
    });
    const workloadTokenFile = path.join(opencodeDir, "evimed-workload.token");
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
    assert.deepEqual({
      ...managed,
      environment: managed.environment,
    }, {
      type: "local",
      command: [
        "python3",
        "/runtime/xdg-config/opencode/mcp/evimed-research/server.py",
      ],
      enabled: true,
      environment: {
        OPEN_SCIENCE_TENANT_ID: "user-1",
        OPEN_SCIENCE_USER_ID: "user-1",
        OPEN_SCIENCE_PROJECT_ID: "project-1",
        OPEN_SCIENCE_WORKSPACE_DIR: "/workspace",
        EVIMED_WORKLOAD_TOKEN_FILE: "/runtime/xdg-config/opencode/evimed-workload.token",
        EVIMED_LITERATURE_SEARCH_URL: "https://evidence.internal/literature",
      },
    });
    assert.doesNotMatch(JSON.stringify(config), /API_KEY|Authorization|Bearer/);
    assert.equal(JSON.stringify(config).includes(signingSecret), false);
    assert.equal(JSON.stringify(config).includes(workloadToken), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("host runtimes bind the managed local MetaAgent and model config without exposing a key", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-meta-host-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const metaAgentRoot = path.join(tmp, "meta");
    await mkdir(path.join(metaAgentRoot, "new_meta"), { recursive: true });
    await writeFile(path.join(metaAgentRoot, "new_meta", "main.py"), "# test fixture\n");
    await syncRuntimeEviMedMcp(
      {
        evimedMcpSourceDir: sourceDir,
        evimedAdapterUrls: {},
        metaAgentRoot,
        metaAgentPython: "/usr/bin/python3",
      },
      project,
      { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir },
    );
    const config = JSON.parse(await readFile(path.join(xdgConfigDir, "opencode", "opencode.json"), "utf8"));
    const environment = config.mcp["evimed-research"].environment;
    assert.equal(environment.EVIMED_META_AGENT_ROOT, metaAgentRoot);
    assert.equal(environment.EVIMED_META_AGENT_PYTHON, "/usr/bin/python3");
    assert.equal(
      environment.EVIMED_MODEL_CONFIG_FILE,
      path.join(xdgConfigDir, "opencode", "opencode.json"),
    );
    assert.equal(JSON.stringify(environment).includes("apiKey"), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("docker runtimes require the MetaAgent HTTP adapter instead of a host source path", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-meta-docker-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const metaAgentRoot = path.join(tmp, "meta");
    await assert.rejects(
      () => syncRuntimeEviMedMcp(
        { evimedMcpSourceDir: sourceDir, evimedAdapterUrls: {}, metaAgentRoot },
        project,
        { sandboxMode: "docker", xdgConfigDir, proxyWorkspaceDir: "/workspace" },
      ),
      (error) => error?.code === "runtime_meta_agent_adapter_required",
    );

    await syncRuntimeEviMedMcp(
      {
        evimedMcpSourceDir: sourceDir,
        evimedAdapterUrls: { metaAnalysis: "https://meta.internal/api/v1/evimed/meta-analysis" },
        metaAgentRoot,
        evimedWorkloadSigningSecret: signingSecret,
      },
      project,
      { sandboxMode: "docker", xdgConfigDir, proxyWorkspaceDir: "/workspace" },
    );
    const config = JSON.parse(await readFile(path.join(xdgConfigDir, "opencode", "opencode.json"), "utf8"));
    const environment = config.mcp["evimed-research"].environment;
    assert.equal(environment.EVIMED_META_ANALYSIS_URL, "https://meta.internal/api/v1/evimed/meta-analysis");
    assert.equal(environment.EVIMED_META_AGENT_ROOT, undefined);
    assert.equal(environment.EVIMED_MODEL_CONFIG_FILE, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("workload token file converges across signing-key rotation without config ownership failure", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-key-rotation-"));
  const rotatedSecret = "rotated-test-only-evimed-workload-secret-with-32-bytes";
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const plan = { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir };
    const base = {
      evimedMcpSourceDir: sourceDir,
      evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" },
    };
    await syncRuntimeEviMedMcp(
      { ...base, evimedWorkloadSigningSecret: signingSecret }, project, plan,
    );
    const tokenFile = path.join(xdgConfigDir, "opencode", "evimed-workload.token");
    const first = (await readFile(tokenFile, "utf8")).trim();
    verifyEviMedWorkloadToken(first, {
      secret: signingSecret,
      userId: project.userId,
      projectId: project.id,
    });

    await syncRuntimeEviMedMcp(
      { ...base, evimedWorkloadSigningSecret: rotatedSecret }, project, plan,
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


test("MCP bootstrap upgrades a marker-owned config when workload signing is enabled later", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-token-upgrade-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const plan = { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir };
    await syncRuntimeEviMedMcp(
      { evimedMcpSourceDir: sourceDir, evimedAdapterUrls: {} },
      project,
      plan,
    );
    const configFile = path.join(xdgConfigDir, "opencode", "opencode.json");
    const before = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(before.mcp["evimed-research"].environment.EVIMED_WORKLOAD_TOKEN_FILE, undefined);

    await syncRuntimeEviMedMcp(
      {
        evimedMcpSourceDir: sourceDir,
        evimedAdapterUrls: {},
        evimedWorkloadSigningSecret: signingSecret,
      },
      project,
      plan,
    );
    const after = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(
      after.mcp["evimed-research"].environment.EVIMED_WORKLOAD_TOKEN_FILE,
      path.join(xdgConfigDir, "opencode", "evimed-workload.token"),
    );
    assert.equal((await stat(path.join(xdgConfigDir, "opencode", "evimed-workload.token"))).mode & 0o777, 0o600);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("MCP bootstrap is idempotent when the managed public-source gateway is enabled", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-gateway-restart-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const settings = {
      evimedMcpSourceDir: sourceDir,
      evimedAdapterUrls: {},
      publicSourceGatewayInternalUrl: "http://127.0.0.1:8799",
    };
    const plan = {
      sandboxMode: "host",
      xdgConfigDir,
      proxyWorkspaceDir: project.workspaceDir,
    };

    await syncRuntimeEviMedMcp(settings, project, plan);
    await syncRuntimeEviMedMcp(settings, project, plan);

    const config = JSON.parse(await readFile(path.join(xdgConfigDir, "opencode", "opencode.json"), "utf8"));
    assert.equal(
      config.mcp["evimed-research"].environment.EVIMED_PUBLIC_SOURCE_GATEWAY_URL,
      "http://127.0.0.1:8799",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("workload token refresh atomically writes a valid token at half-TTL", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-refresh-"));
  try {
    const { project, xdgConfigDir } = await fixture(tmp);
    const tokenFile = path.join(xdgConfigDir, "opencode", "evimed-workload.token");
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
    const { project, xdgConfigDir } = await fixture(tmp);
    const tokenFile = path.join(xdgConfigDir, "opencode", "evimed-workload.token");
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
      kind: "opencode",
      sandboxMode: "host",
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
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    await assert.rejects(
      () => syncRuntimeEviMedMcp(
        {
          production: true,
          evimedMcpSourceDir: sourceDir,
          evimedAdapterUrls: { literatureSearch: "https://evidence.internal/literature" },
        },
        project,
        { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir },
      ),
      (error) => error?.code === "runtime_mcp_workload_secret_missing",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("MCP bootstrap rejects a foreign reserved config entry before copying source", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-collision-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const opencodeDir = path.join(xdgConfigDir, "opencode");
    const configFile = path.join(opencodeDir, "opencode.json");
    await mkdir(opencodeDir, { recursive: true });
    const foreign = JSON.stringify({
      mcp: { "evimed-research": { type: "remote", url: "https://foreign.test/mcp" } },
    });
    await writeFile(configFile, foreign);
    await assert.rejects(
      () => syncRuntimeEviMedMcp(
        { evimedMcpSourceDir: sourceDir, evimedAdapterUrls: {} },
        project,
        { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir },
      ),
      (error) => error?.code === "runtime_mcp_config_collision",
    );
    assert.equal(await readFile(configFile, "utf8"), foreign);
    await assert.rejects(
      () => access(path.join(opencodeDir, "mcp", "evimed-research", "server.py")),
      /ENOENT/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("MCP bootstrap rebinds its managed entry when the active project workspace changes", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-rebind-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const settings = { evimedMcpSourceDir: sourceDir, evimedAdapterUrls: {} };
    await syncRuntimeEviMedMcp(
      settings,
      project,
      { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir },
    );

    const datedWorkspace = path.join(project.baseDir, "2026-07-17-1011");
    await mkdir(datedWorkspace);
    project.workspaceDir = datedWorkspace;
    await syncRuntimeEviMedMcp(
      settings,
      project,
      { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: datedWorkspace },
    );

    const config = JSON.parse(await readFile(path.join(xdgConfigDir, "opencode", "opencode.json"), "utf8"));
    assert.equal(
      config.mcp["evimed-research"].environment.OPEN_SCIENCE_WORKSPACE_DIR,
      datedWorkspace,
    );
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
    const settings = {
      evimedMcpSourceDir: initial.sourceDir,
      evimedAdapterUrls: {},
      specialistAgents: { researchTopicSelection: { root: oldSpecialistRoot, python: "" } },
    };
    await syncRuntimeEviMedMcp(
      settings,
      initial.project,
      { sandboxMode: "host", xdgConfigDir: initial.xdgConfigDir, proxyWorkspaceDir: initial.project.workspaceDir },
    );

    await rename(oldContainer, newContainer);
    const rebase = (value) => path.join(newContainer, path.relative(oldContainer, value));
    const project = Object.fromEntries(
      Object.entries(initial.project).map(([key, value]) => [key, typeof value === "string" && path.isAbsolute(value) ? rebase(value) : value]),
    );
    const sourceDir = rebase(initial.sourceDir);
    const xdgConfigDir = rebase(initial.xdgConfigDir);
    const specialistRoot = rebase(oldSpecialistRoot);
    await syncRuntimeEviMedMcp(
      {
        ...settings,
        evimedMcpSourceDir: sourceDir,
        specialistAgents: { researchTopicSelection: { root: specialistRoot, python: "" } },
      },
      project,
      { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir },
    );

    const config = JSON.parse(await readFile(path.join(xdgConfigDir, "opencode", "opencode.json"), "utf8"));
    const managed = config.mcp["evimed-research"];
    assert.equal(managed.command[1], path.join(xdgConfigDir, "opencode", "mcp", "evimed-research", "server.py"));
    assert.equal(managed.environment.OPEN_SCIENCE_WORKSPACE_DIR, project.workspaceDir);
    assert.equal(managed.environment.EVIMED_RESEARCH_TOPIC_AGENT_ROOT, specialistRoot);
    assert.equal(managed.environment.EVIMED_MODEL_CONFIG_FILE, path.join(xdgConfigDir, "opencode", "opencode.json"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("MCP bootstrap rejects a managed-looking entry bound outside the project workspace", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-outside-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const settings = { evimedMcpSourceDir: sourceDir, evimedAdapterUrls: {} };
    const plan = { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir };
    await syncRuntimeEviMedMcp(settings, project, plan);
    const configFile = path.join(xdgConfigDir, "opencode", "opencode.json");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    config.mcp["evimed-research"].environment.OPEN_SCIENCE_WORKSPACE_DIR = path.join(tmp, "foreign-workspace");
    await writeFile(configFile, JSON.stringify(config));

    await assert.rejects(
      () => syncRuntimeEviMedMcp(settings, project, plan),
      (error) => error?.code === "runtime_mcp_config_collision",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("MCP bootstrap rolls source back when config validation or atomic write fails", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-rollback-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    const plan = { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir };
    const settings = { evimedMcpSourceDir: sourceDir, evimedAdapterUrls: {} };
    await syncRuntimeEviMedMcp(settings, project, plan);
    const targetServer = path.join(
      xdgConfigDir, "opencode", "mcp", "evimed-research", "server.py",
    );
    const configFile = path.join(xdgConfigDir, "opencode", "opencode.json");
    const originalConfig = await readFile(configFile, "utf8");
    await writeFile(path.join(sourceDir, "server.py"), "print('replacement')\n");

    await assert.rejects(
      () => syncRuntimeEviMedMcp(settings, project, plan, {
        writeConfig: async () => { throw new Error("injected config write failure"); },
      }),
      /injected config write failure/,
    );
    assert.equal(await readFile(targetServer, "utf8"), "print('protocol')\n");
    assert.equal(await readFile(configFile, "utf8"), originalConfig);

    await writeFile(configFile, "{invalid-json");
    await assert.rejects(
      () => syncRuntimeEviMedMcp(settings, project, plan),
      (error) => error?.code === "runtime_opencode_config_invalid",
    );
    assert.equal(await readFile(targetServer, "utf8"), "print('protocol')\n");
    assert.equal(await readFile(configFile, "utf8"), "{invalid-json");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("syncRuntimeEviMedMcp uses the copied host path and rejects source symlinks", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-"));
  try {
    const { sourceDir, project, xdgConfigDir } = await fixture(tmp);
    await syncRuntimeEviMedMcp(
      { evimedMcpSourceDir: sourceDir, evimedAdapterUrls: {} },
      project,
      { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir },
    );
    const config = JSON.parse(
      await readFile(path.join(xdgConfigDir, "opencode", "opencode.json"), "utf8"),
    );
    assert.deepEqual(config.mcp["evimed-research"].command, [
      "python3",
      path.join(xdgConfigDir, "opencode", "mcp", "evimed-research", "server.py"),
    ]);

    const outside = path.join(tmp, "outside.py");
    await writeFile(outside, "print('outside')\n");
    await rm(path.join(sourceDir, "server.py"));
    await symlink(outside, path.join(sourceDir, "server.py"));
    await assert.rejects(
      () => syncRuntimeEviMedMcp(
        { evimedMcpSourceDir: sourceDir, evimedAdapterUrls: {} },
        project,
        { sandboxMode: "host", xdgConfigDir, proxyWorkspaceDir: project.workspaceDir },
      ),
      (error) => error?.code === "runtime_mcp_symlink",
    );
    assert.equal(await readFile(outside, "utf8"), "print('outside')\n");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test("runtime startup fails closed before spawn when EviMed MCP bootstrap fails", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-evimed-mcp-start-"));
  try {
    const { sourceDir, project } = await fixture(tmp);
    const marker = path.join(tmp, "spawned");
    const opencodeBin = path.join(tmp, "opencode-stub.mjs");
    await writeFile(
      opencodeBin,
      `#!/usr/bin/env node\nimport fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)}, "spawned");\n`,
      { mode: 0o755 },
    );
    const outside = path.join(tmp, "outside.py");
    await writeFile(outside, "print('outside')\n");
    await rm(path.join(sourceDir, "server.py"));
    await symlink(outside, path.join(sourceDir, "server.py"));

    const manager = new RuntimeManager({
      production: false,
      runtimeMode: "opencode",
      runtimeSandboxMode: "host",
      allowUnsandboxedRuntime: true,
      opencodeBin,
      runtimeSkillDirs: [],
      evimedMcpSourceDir: sourceDir,
      evimedAdapterUrls: {},
      runtimeProxyConnectTimeoutMs: 100,
      maxLogFileBytes: 1024 * 1024,
    });
    try {
      await assert.rejects(
        () => manager.startOpenCode(project),
        (error) => error?.code === "runtime_bootstrap_failed",
      );
      await assert.rejects(() => access(marker), /ENOENT/);
      const state = JSON.parse(await readFile(path.join(project.metaDir, "runtime-state.json"), "utf8"));
      assert.equal(state.error, "runtime_bootstrap_failed");
    } finally {
      await manager.closeAll();
    }
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
    "EVIMED_DRUG_LABEL_SEARCH_URL",
    "EVIMED_ADR_CASE_QUERY_URL",
    "EVIMED_ADR_SIGNAL_ANALYSIS_URL",
    "EVIMED_OFFLABEL_EVIDENCE_PACKET_URL",
    "EVIMED_COMPREHENSIVE_DRUG_EVALUATION_URL",
    "EVIMED_DRUG_SELECTION_EVALUATION_URL",
  ]) {
    assert.match(compose, new RegExp(name + ": \\$\\{" + name + ":-\\}"));
    assert.match(example, new RegExp(`^${name}=$`, "m"));
  }
  assert.match(
    compose,
    /EVIMED_META_ANALYSIS_URL:\s+\$\{EVIMED_META_ANALYSIS_URL:-http:\/\/evimed-meta-agent:8024\/api\/v1\/evimed\/meta-analysis\}/,
  );
  assert.match(example, /^EVIMED_META_ANALYSIS_URL=http:\/\/evimed-meta-agent:8024\/api\/v1\/evimed\/meta-analysis$/m);
  assert.doesNotMatch(example, /EVIMED_(?:API_KEY|TOKEN|PASSWORD)=/);
  assert.match(compose, /OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET:\s+\$\{OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET:-\}/);
  assert.match(compose, /OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_FILE:\s+\/run\/secrets\/evimed-workload-signing-key/);
  assert.match(example, /^OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET=$/m);
  assert.match(example, /^OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_FILE=$/m);
  assert.match(example, /^OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_HOST_FILE=\.\/secrets\/evimed-workload-signing-key\.txt$/m);
});
