import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { createWebApiApp } from "../src/server.mjs";
import { dshProductionReleaseConfig, productionReleaseConfig, releaseManifestFixture } from "./releaseFixture.mjs";

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasR = spawnSync("Rscript", ["--version"], { stdio: "ignore" }).status === 0;
const productionReadinessReady = {
  backupMode: "external",
  backupExternalAck: true,
  restoreDrillAck: true,
  operatorMetricsToken: "metrics-token-for-production-readiness-tests",
  trustProxy: true,
  ...productionReleaseConfig,
};

async function fakeDockerBin(root, logPath) {
  const bin = path.join(root, "fake-docker.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};

if (args[0] === "info") {
  process.stdout.write("26.0.0\\n");
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  // Answers per placeholder, the way docker does, instead of echoing a fixed
  // field count. A stub with a hardcoded three-field reply silently misaligns
  // the moment the reader asks for a fourth, and every assertion downstream
  // then measures the misalignment rather than the thing under test.
  //
  // The runtime image publishes the kernel-neutral version label and the uv
  // label, and nothing kernel-specific: there is one kernel, and the readiness
  // gate reads io.open-science.runtime.version. A stub still carrying the
  // retired vendor label answers empty for the label the gate asks for, which
  // fails runtime_image_metadata_missing and never reaches provenance.
  // (No backticks in this comment: it lives inside a template literal.)
  const labels = ${JSON.stringify({
    "io.open-science.runtime.version": releaseManifestFixture.runtime.dshVersion,
    "io.open-science.uv.version": releaseManifestFixture.runtime.uvVersion,
  })};
  const format = args[args.indexOf("--format") + 1] ?? "";
  process.stdout.write(format.split("|").map((token) => {
    if (token === "{{.Id}}") return ${JSON.stringify(releaseManifestFixture.runtime.imageId)};
    const label = token.match(/"([^"]+)"/)?.[1];
    return label && Object.hasOwn(labels, label) ? labels[label] : "";
  }).join("|") + "\\n");
  process.exit(0);
}
if (args[0] === "rm") process.exit(0);

if (args[0] === "run") {
  const input = fs.readFileSync(0, "utf8");
  fs.writeFileSync(logPath, JSON.stringify({ args, input }));
  const mount = args.find((arg) => arg.startsWith("type=bind,src=") && arg.includes(",dst=/workspace"));
  const workspace = mount?.slice("type=bind,src=".length, mount.indexOf(",dst=/workspace"));
  if (workspace && input.includes("WRITE_QUOTA_FILE")) {
    fs.writeFileSync(path.join(workspace, "quota.bin"), "x".repeat(32));
  }
  process.stdout.write("docker stdout\\n");
  process.stderr.write("docker stderr\\n");
  process.exit(input.includes("EXIT_1") ? 1 : 0);
}

process.stderr.write("unexpected fake docker invocation: " + args.join(" "));
process.exit(2);
`,
    "utf8",
  );
  await chmod(bin, 0o700);
  return bin;
}

async function fakeRuntimeCleanupFailDockerBin(root) {
  const bin = path.join(root, "fake-runtime-cleanup-docker.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "rm" && args[1] === "-f") {
  process.stderr.write("permission denied while connecting to the container socket\\n");
  process.exit(125);
}
process.stderr.write("runtime should not start after cleanup failure: " + args.join(" "));
process.exit(2);
`,
    "utf8",
  );
  await chmod(bin, 0o700);
  return bin;
}

async function withApp(fn, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-api-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, ...overrides });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ app, base, dataDir });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function withPausedTaskApp(fn, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-tasks-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: true,
    maxConcurrentTasks: 0,
    ...overrides,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ app, base });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function withQuotaApp(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-quota-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: true,
    maxProjectBytes: 8,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ app, base });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function withAuthApp(fn, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-auth-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    // No kernel override: there is one kernel, and /api/me reports it from the
    // server constant rather than from configuration. Naming it here would be
    // a setting nothing reads, so the assertion would prove nothing.
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    ...overrides,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ app, base });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function withStaticApp(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-api-"));
  const staticDir = await mkdtemp(path.join(tmpdir(), "os-web-static-"));
  await mkdir(path.join(staticDir, "assets"), { recursive: true });
  await writeFile(path.join(staticDir, "index.html"), "<div id=\"root\"></div>", "utf8");
  await writeFile(path.join(staticDir, "assets/app.js"), "console.log('ok')", "utf8");
  const app = createWebApiApp({
    dataDir,
    staticDir,
    port: 0,
    runtimeMode: "mock",
    // No kernel override, for the same reason as `withAuthApp`: readiness
    // reports the kernel from the server constant, not from configuration.
    devAuth: true,
    operatorMetricsToken: "",
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ app, base, dataDir, staticDir });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  }
}

async function startAppWithDataDir(dataDir, overrides = {}) {
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, ...overrides });
  const address = await app.listen(0, "127.0.0.1");
  return { app, base: `http://127.0.0.1:${address.port}` };
}

async function command(base, name, args = {}) {
  return commandWithHeaders(base, name, args);
}

async function commandWithHeaders(base, name, args = {}, headers = {}) {
  const res = await fetch(`${base}/api/commands/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  return { res, json };
}

async function login(base, username = "alice", password = "correct horse battery staple") {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const json = await res.json();
  const csrfToken = json.data?.csrfToken ?? "";
  return {
    res,
    cookie,
    csrfToken,
    auth: { Cookie: cookie, "X-Open-Science-CSRF": csrfToken },
    setCookie: res.headers.get("set-cookie") ?? "",
    json,
  };
}

async function waitForTask(base, id, headers = {}) {
  const terminal = new Set(["succeeded", "failed", "canceled", "timed_out"]);
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/api/tasks/${id}`, { headers });
    assert.equal(res.status, 200);
    const task = (await res.json()).data;
    if (terminal.has(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${id} did not finish`);
}

async function waitForRuntimeLogs(base, select) {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/api/logs/runtime?limit=20`);
    assert.equal(res.status, 200);
    const rows = (await res.json()).data;
    const selected = select(rows);
    if (selected) return selected;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("runtime log entry did not appear");
}

async function waitForRuntimeStatus(base, select) {
  for (let i = 0; i < 50; i++) {
    const out = await command(base, "runtime_status");
    assert.equal(out.res.status, 200);
    const selected = select(out.json.data);
    if (selected) return selected;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("runtime status did not match");
}


// The browser-to-kernel pass-through is gone, and with it fifteen tests that
// hardened it: credential stripping, redirect sanitization, response-body caps,
// per-project and global connection limits, method allow-lists, mutation
// payload validation, and the refusal to wake a stopped runtime for a stale
// control mutation. None of those risks survived the route — a browser can no
// longer reach a kernel at all — and the surfaces that replaced it are covered
// where they live: the wire-method allow-list in dshRuntimeAdapter.test.mjs,
// the session and transcript routes below, and the event stream in
// runEventStream.test.mjs. The one test kept from that family is the one about
// project-id decoding, which is about our routing and not about the kernel.

test("specialty agent catalog requires authentication and exposes only public metadata", async () => {
  await withAuthApp(async ({ base }) => {
    const anonymous = await fetch(`${base}/api/agents`);
    assert.equal(anonymous.status, 401);

    const loggedIn = await login(base);
    assert.equal(loggedIn.res.status, 200);
    const response = await fetch(`${base}/api/agents`, { headers: { Cookie: loggedIn.cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.map((agent) => agent.id), [
      "adr-analysis",
      "bibliometric-analysis",
      "clinical-evidence-synthesis",
      "comprehensive-drug-evaluation",
      "dataset-research-scoping",
      "drug-selection",
      "mendelian-randomization",
      "meta-analysis",
      "off-label-analysis",
      "peer-review",
      "research-topic-selection",
    ]);
    assert.equal(body.data[0].title, "Drug Safety Analysis");
    assert.deepEqual(body.data[0].estimatedMinutes, [20, 40]);
    assert.equal(body.data[0].runtimeAgent, "evimed-adr-analysis");
    for (const agent of body.data) {
      assert.equal(Object.hasOwn(agent, "steps"), false);
      assert.equal(Object.hasOwn(agent, "name"), false);
      assert.equal(Object.hasOwn(agent, "icon"), false);
      assert.equal(Object.hasOwn(agent, "packageDir"), false);
      assert.equal(Object.hasOwn(agent, "manifestPath"), false);
      assert.equal(Object.hasOwn(agent, "skillPath"), false);
      assert.equal(Object.hasOwn(agent, "skillText"), false);
      assert.equal(Object.hasOwn(agent, "systemPrompt"), false);
    }
  });
});

function tarEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const name = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    entries.set(name, buffer.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function tarEntryNames(buffer) {
  return [...tarEntries(buffer).keys()];
}

test("command API enforces allowlist", async () => {
  await withApp(async ({ base }) => {
    const { res, json } = await command(base, "shell_exec", { command: "rm -rf /" });

    assert.equal(res.status, 404);
    assert.equal(json.code, "unknown_command");
  });
});

test("desktop-only workspace reveal command is an explicit hosted no-op", async () => {
  await withApp(async ({ base }) => {
    const { res, json } = await command(base, "open_workspace_base");

    assert.equal(res.status, 200);
    assert.equal(json.data, null);
  });
});

test("desktop run commands cannot forge hosted AgentRun provenance", async () => {
  await withApp(async ({ base }) => {
    let out = await command(base, "record_run", { command: "python analysis.py", status: "ok" });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "run_recording_server_managed");

    out = await command(base, "list_runs");
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data, []);

    out = await command(base, "query_runs_cmd", { query: {} });
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data, { rows: [], total: 0, facets: { status: [], surface: [] } });

    out = await command(base, "read_run_log", { hash: "deadbeef" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, null);
  });
});

test("route parameters reject malformed percent encoding with JSON errors", async () => {
  await withApp(async ({ base }) => {
    let res = await fetch(`${base}/api/commands/%E0%A4%A`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_encoding");

    res = await fetch(`${base}/api/files/preview/%E0%A4%A`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_encoding");

    res = await fetch(`${base}/api/files/download/%E0%A4%A`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_encoding");

    res = await fetch(`${base}/api/tasks/%E0%A4%A`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_encoding");

    res = await fetch(`${base}/api/runtime/sessions/%E0%A4%A/transcript`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_encoding");
  });
});

test("API route handlers reject ambiguous extra task path segments", async () => {
  await withApp(async ({ base }) => {
    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "write_workspace_file",
        args: { path: "task-route.txt", content: "queued" },
      }),
    });
    assert.equal(created.status, 202);
    const task = (await created.json()).data;

    const res = await fetch(`${base}/api/tasks/${task.id}/cancel/extra`, { method: "POST" });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "not_found");
  });
});

test("route components reject encoded path separators, and the retired pass-through says so", async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/runtime/sessions/default%2Fescape/transcript`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_id");

    // And the retired pass-through says what replaced it rather than 404ing
    // into silence — a browser pointed at it is a browser that was speaking a
    // kernel's protocol.
    const retired = await fetch(`${base}/api/opencode/default/session`, { method: "POST", body: "{}" });
    assert.equal(retired.status, 410);
    assert.equal((await retired.json()).code, "runtime_passthrough_retired");

    const status = await command(base, "runtime_status");
    assert.equal(status.res.status, 200);
    assert.equal(status.json.data.running, false);
  });
});

test("API responses include hosted security headers", async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("strict-transport-security"), null);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\* ws: wss:/);
  });
});

test("the origin the shell frames is also an origin it may ask about", async () => {
  // The shell asks whether the kernel application's origin is reachable before
  // it frames it, because an iframe cannot report a network failure and a
  // frame pointed at a blocked port spins forever. That question is a `fetch`,
  // which `connect-src` governs — and with only `frame-src` widened, our own
  // policy refused the probe, the probe reported the origin unreachable, and
  // the frame was never rendered even when the origin was fine. Seen in a real
  // browser on 2026-09-04, invisible to every test before this one, because a
  // test browser enforces no CSP.
  await withAuthApp(
    async ({ base }) => {
      const csp = (await fetch(`${base}/api/health`)).headers.get("content-security-policy") ?? "";
      assert.match(csp, /frame-src https:\/\/science\.example\.com:8443/);
      assert.match(csp, /connect-src 'self' https:\/\/science\.example\.com:8443/);
    },
    {
      production: true,
      publicUrl: "https://science.example.com",
      allowMockRuntime: true,
      runtimeUiProxyEnabled: true,
      runtimeUiPublicOrigin: "https://science.example.com:8443",
    },
  );
});

test("production security headers do not allow browser-local runtime connections", async () => {
  await withAuthApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/health`);

      assert.equal(res.status, 200);
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.match(csp, /connect-src 'self'(;|$)/);
      assert.equal(csp.includes("127.0.0.1"), false);
      assert.equal(csp.includes("localhost"), false);
      assert.equal(csp.includes("ws:"), false);
      assert.equal(csp.includes("wss:"), false);
      assert.match(csp, /frame-src 'none'/);
      assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000");
    },
    {
      production: true,
      publicUrl: "https://science.example.com",
      allowMockRuntime: true,
    },
  );
});

test("operator metrics endpoint is disabled unless a token is configured", async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/ops/metrics`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "not_found");
  });
});

test("operator metrics endpoint requires a bearer token and exposes only low-cardinality signals", async () => {
  await withApp(
    async ({ app, base }) => {
      let res = await fetch(`${base}/api/ops/metrics`);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, "operator_metrics_unauthorized");

      res = await fetch(`${base}/api/ops/metrics`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(res.status, 401);

      res = await fetch(`${base}/api/ops/metrics`, {
        headers: { Authorization: "Bearer metrics-secret" },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
      const body = await res.text();
      assert.match(body, /^# HELP open_science_up /m);
      assert.match(body, /^open_science_up 1$/m);
      assert.match(body, /^open_science_ready 1$/m);
      assert.match(body, /^open_science_readiness_check\{check="dataDir",code="ok"\} 1$/m);
      assert.match(body, /^open_science_process_memory_bytes\{kind="rss"\} \d+$/m);
      assert.match(body, /^open_science_http_active_requests 1$/m);
      assert.match(
        body,
        /^open_science_http_requests_total\{method="GET",route="\/api\/ops\/metrics",status_code="401",status_class="4xx"\} 2$/m,
      );
      assert.match(
        body,
        /^open_science_http_errors_total\{route="\/api\/ops\/metrics",code="operator_metrics_unauthorized"\} 2$/m,
      );
      assert.match(
        body,
        /^open_science_http_request_duration_seconds_bucket\{method="GET",route="\/api\/ops\/metrics",le="\+Inf"\} 2$/m,
      );
      assert.match(body, /^open_science_task_status_total\{status="queued"\} \d+$/m);
      assert.match(body, /^open_science_task_queue_limit\{scope="global"\} 100$/m);
      assert.match(body, /^open_science_task_queue_limit\{scope="project"\} 25$/m);
      assert.match(body, /^open_science_runtime_running \d+$/m);
      assert.match(body, /^open_science_runtime_quota_monitored 0$/m);
      assert.match(body, /^open_science_runtime_quota_monitor_interval_seconds 30$/m);
      assert.match(body, /^open_science_runtime_limit\{scope="global"\} 8$/m);
      assert.match(body, /^open_science_runtime_limit\{scope="user"\} 4$/m);
      assert.match(body, /^open_science_runtime_proxy_active \d+$/m);
      assert.match(body, /^open_science_runtime_proxy_limit\{scope="global"\} 64$/m);
      assert.match(body, /^open_science_runtime_proxy_limit\{scope="project"\} 8$/m);
      assert.equal(body.includes(app.config.dataDir), false);
      assert.equal(body.includes("workspace"), false);
    },
    { operatorMetricsToken: "metrics-secret" },
  );
});

test("operator metrics token can be loaded from a no-follow secret file", async () => {
  const secretDir = await mkdtemp(path.join(tmpdir(), "os-web-metrics-secret-"));
  const secretFile = path.join(secretDir, "metrics-token.txt");
  await writeFile(secretFile, "metrics-secret-from-file-with-32-bytes-minimum\n", { mode: 0o600 });
  try {
    await withApp(
      async ({ base }) => {
        const ready = await fetch(`${base}/api/ready`);
        assert.equal(ready.status, 200);
        const readiness = (await ready.json()).data.checks.observability;
        assert.equal(readiness.ok, true);
        assert.equal(readiness.mode, "protected");
        assert.equal(readiness.source, "file");

        const metrics = await fetch(`${base}/api/ops/metrics`, {
          headers: { Authorization: "Bearer metrics-secret-from-file-with-32-bytes-minimum" },
        });
        assert.equal(metrics.status, 200);
        assert.match(await metrics.text(), /^open_science_up 1$/m);
      },
      { operatorMetricsTokenFile: secretFile },
    );
  } finally {
    await rm(secretDir, { recursive: true, force: true });
  }
});

test("health and operator metrics expose release identity without image ids", async () => {
  await withApp(
    async ({ base }) => {
      const health = await fetch(`${base}/api/health`);
      const healthData = (await health.json()).data;
      assert.equal(healthData.releaseId, releaseManifestFixture.app.releaseId);
      assert.equal(healthData.runtimeControlPlane, "direct");

      const metrics = await fetch(`${base}/api/ops/metrics`, {
        headers: { Authorization: "Bearer metrics-secret" },
      });
      const body = await metrics.text();
      assert.match(body, /release_id="2026\.07\.10-test\.1"/);
      assert.match(body, /source_revision="aaaaaaaaaaaa"/);
      assert.match(body, /runtime_control_plane="direct"/);
      assert.equal(body.includes(releaseManifestFixture.runtime.imageId), false);
      assert.equal(body.includes(releaseManifestFixture.web.imageId), false);
    },
    { operatorMetricsToken: "metrics-secret", releaseManifest: releaseManifestFixture },
  );
});

test("observability readiness rejects a symbolic-link metrics token file", async () => {
  const secretDir = await mkdtemp(path.join(tmpdir(), "os-web-metrics-secret-"));
  const target = path.join(secretDir, "target.txt");
  const link = path.join(secretDir, "metrics-token.txt");
  await writeFile(target, "metrics-secret-from-file-with-32-bytes-minimum\n", { mode: 0o600 });
  await symlink(target, link);
  try {
    await withApp(
      async ({ base }) => {
        const ready = await fetch(`${base}/api/ready`);
        const check = (await ready.json()).data.checks.observability;
        assert.equal(check.ok, false);
        assert.equal(check.code, "operator_metrics_token_file_symlink");
      },
      { operatorMetricsTokenFile: link },
    );
  } finally {
    await rm(secretDir, { recursive: true, force: true });
  }
});

test("API errors carry request ids and write sanitized server error logs", async () => {
  await withApp(async ({ app, base }) => {
    const res = await fetch(`${base}/api/files/preview/private/report.md?auth_token=secret`, {
      headers: { "X-Request-Id": "req-test-1" },
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("x-open-science-request-id"), "req-test-1");
    const body = await res.json();
    assert.equal(body.code, "file_not_found");
    assert.equal(body.requestId, "req-test-1");

    const raw = await readFile(path.join(app.config.dataDir, ".openscience", "errors.jsonl"), "utf8");
    assert.equal(raw.includes("private/report.md"), false);
    assert.equal(raw.includes("auth_token"), false);
    const row = JSON.parse(raw.trim());
    assert.equal(row.requestId, "req-test-1");
    assert.equal(row.method, "GET");
    assert.equal(row.route, "/api/files/preview/:path");
    assert.equal(row.status, 404);
    assert.equal(row.code, "file_not_found");

    const hidden = await fetch(`${base}/api/files/preview/hidden.md`, {
      headers: { "X-Request-Id": "req-other-project", "X-Open-Science-Project": "paper2" },
    });
    assert.equal(hidden.status, 404);

    const visible = await fetch(`${base}/api/logs/errors?limit=10`);
    assert.equal(visible.status, 200);
    const rows = (await visible.json()).data;
    assert.ok(rows.some((item) => item.requestId === "req-test-1"));
    assert.equal(rows.some((item) => item.requestId === "req-other-project"), false);
  });
});

test("server error logs reject symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const outside = path.join(app.config.dataDir, "outside-errors.jsonl");
    const errorFile = path.join(app.config.dataDir, ".openscience", "errors.jsonl");
    await mkdir(path.dirname(errorFile), { recursive: true });
    await writeFile(outside, "", "utf8");
    await symlink(outside, errorFile);

    const res = await fetch(`${base}/api/unknown`, { headers: { "X-Request-Id": "req-test-symlink" } });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).requestId, "req-test-symlink");
    assert.equal(await readFile(outside, "utf8"), "");

    const logs = await fetch(`${base}/api/logs/errors`);
    assert.equal(logs.status, 403);
    assert.equal((await logs.json()).code, "path_forbidden");
  });
});

test("server error log API includes rotated rows without crossing projects", async () => {
  await withApp(async ({ app, base }) => {
    const errorDir = path.join(app.config.dataDir, ".openscience");
    await mkdir(errorDir, { recursive: true });
    await writeFile(
      path.join(errorDir, "errors.jsonl.1"),
      [
        JSON.stringify({
          createdAt: new Date().toISOString(),
          requestId: "req-rotated-default",
          method: "GET",
          route: "/api/test",
          status: 404,
          code: "file_not_found",
          projectId: "default",
        }),
        JSON.stringify({
          createdAt: new Date().toISOString(),
          requestId: "req-rotated-other",
          method: "GET",
          route: "/api/test",
          status: 404,
          code: "file_not_found",
          projectId: "paper2",
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(errorDir, "errors.jsonl"),
      `${JSON.stringify({
        createdAt: new Date().toISOString(),
        requestId: "req-current-default",
        method: "GET",
        route: "/api/test",
        status: 404,
        code: "file_not_found",
        projectId: "default",
      })}\n`,
      "utf8",
    );

    const visible = await fetch(`${base}/api/logs/errors?limit=10`);
    assert.equal(visible.status, 200);
    const rows = (await visible.json()).data;
    assert.ok(rows.some((item) => item.requestId === "req-current-default"));
    assert.ok(rows.some((item) => item.requestId === "req-rotated-default"));
    assert.equal(rows.some((item) => item.requestId === "req-rotated-other"), false);
  });
});

test("security audit log API returns only the authenticated user's auth rows", async () => {
  await withAuthApp(async ({ app, base }) => {
    await app.store.loadUsers();
    await app.store.createUser("bob", "correct horse battery stable", "Bob");

    let res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong-password" }),
    });
    assert.equal(res.status, 401);

    res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "correct horse battery stable" }),
    });
    assert.equal(res.status, 200);

    const alice = await login(base);
    const logs = await fetch(`${base}/api/logs/security?limit=20`, { headers: alice.auth });
    assert.equal(logs.status, 200);
    const rows = (await logs.json()).data;
    assert.ok(rows.some((row) => row.action === "auth.login" && row.status === "failed" && row.username === "alice"));
    assert.ok(rows.some((row) => row.action === "auth.login" && row.status === "completed" && row.username === "alice"));
    assert.equal(rows.some((row) => row.username === "bob" || row.userId === "bob"), false);
  });
});

test("security audit log API rejects symbolic links", async () => {
  await withAuthApp(async ({ app, base }) => {
    const outside = path.join(app.config.dataDir, "outside-security.jsonl");
    const securityFile = path.join(app.config.dataDir, ".openscience", "security.jsonl");
    await mkdir(path.dirname(securityFile), { recursive: true });
    await writeFile(outside, `${JSON.stringify({ action: "auth.login", username: "alice" })}\n`, "utf8");
    await symlink(outside, securityFile);

    const alice = await login(base);
    const logs = await fetch(`${base}/api/logs/security`, { headers: alice.auth });
    assert.equal(logs.status, 403);
    assert.equal((await logs.json()).code, "path_forbidden");
  });
});

test("readiness reports writable data storage and static asset availability", async () => {
  await withStaticApp(async ({ base }) => {
    const res = await fetch(`${base}/api/ready`);
    assert.equal(res.status, 200);
    const body = (await res.json()).data;
    assert.equal(body.ok, true);
    assert.equal(body.checks.dataDir.ok, true);
    assert.equal(body.checks.dataDir.symlink, false);
    assert.equal(body.checks.examples.ok, true);
    assert.equal(body.checks.examples.bundles, 1);
    assert.equal(body.checks.staticDir.ok, true);
    assert.equal(body.checks.auth.mode, "development");
    assert.equal(body.checks.security.ok, true);
    assert.equal(body.checks.security.production, false);
    assert.equal(body.checks.observability.ok, true);
    assert.equal(body.checks.observability.required, false);
    assert.equal(body.checks.observability.mode, "disabled");
    assert.equal(body.checks.release.ok, true);
    assert.equal(body.checks.release.required, false);
    assert.equal(body.checks.release.tracked, false);
    assert.equal(body.checks.runtime.mode, "mock");
    // Which kernel this deployment is on, on every branch. While the shipped
    // default is the rollback kernel, a deployment that meant to move to DSH and
    // did not is otherwise indistinguishable from one that moved.
    assert.equal(body.checks.runtime.kernel, "dsh");
    assert.ok(body.checks.runtime.kernelVersion, "readiness must name the kernel version it would launch");
    assert.equal(body.checks.saasProfile.ok, true);
    assert.equal(body.checks.saasProfile.profile, "controlled-pilot");
    assert.equal(body.checks.saasProfile.technicalSaas, false);
  });
});

test("readiness fails when the hosted example bundle is unavailable", async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/ready`);
    assert.equal(res.status, 503);
    const body = (await res.json()).data;
    assert.equal(body.checks.examples.ok, false);
    assert.equal(body.checks.examples.code, "example_bundle_unavailable");
  }, { examplesDir: path.join(process.cwd(), "examples", "not-bundled") });
});

test("readiness rejects unsafe data directory roots", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "os-web-data-root-"));
  try {
    const realDataDir = path.join(parent, "real-data");
    const linkedDataDir = path.join(parent, "linked-data");
    const fileDataDir = path.join(parent, "data-file");
    await mkdir(realDataDir);
    await symlink(realDataDir, linkedDataDir);
    await writeFile(fileDataDir, "not a directory", "utf8");

    const cases = [
      { dataDir: linkedDataDir, code: "data_dir_symlink" },
      { dataDir: fileDataDir, code: "data_dir_not_directory" },
    ];
    for (const item of cases) {
      const app = createWebApiApp({
        dataDir: item.dataDir,
        port: 0,
        runtimeMode: "mock",
        devAuth: true,
      });
      const address = await app.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${address.port}`;
      try {
        const res = await fetch(`${base}/api/ready`);
        assert.equal(res.status, 503);
        const body = (await res.json()).data;
        assert.equal(body.ok, false);
        assert.equal(body.checks.dataDir.ok, false);
        assert.equal(body.checks.dataDir.code, item.code);
      } finally {
        await app.close();
      }
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("API access rejects a symlinked data directory root even if readiness is ignored", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "os-web-data-root-api-"));
  try {
    const realDataDir = path.join(parent, "real-data");
    const linkedDataDir = path.join(parent, "linked-data");
    await mkdir(realDataDir);
    await symlink(realDataDir, linkedDataDir);

    const app = createWebApiApp({
      dataDir: linkedDataDir,
      port: 0,
      runtimeMode: "mock",
      devAuth: true,
    });
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const out = await command(base, "list_dir", {});
      assert.equal(out.res.status, 403);
      assert.equal(out.json.code, "path_forbidden");
    } finally {
      await app.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("readiness rejects development auth in production mode", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.auth.ok, false);
      assert.equal(body.checks.auth.code, "dev_auth_enabled");
    },
    { production: true, devAuth: true, publicUrl: "https://science.example.com" },
  );
});

test("production mode refuses development-auth API access even if readiness is ignored", async () => {
  await withApp(
    async ({ base }) => {
      const me = await fetch(`${base}/api/me`);
      assert.equal(me.status, 503);
      assert.equal((await me.json()).code, "dev_auth_enabled");
      assert.equal(me.headers.get("set-cookie"), null);

      const out = await command(base, "list_dir", {});
      assert.equal(out.res.status, 503);
      assert.equal(out.json.code, "dev_auth_enabled");
      assert.equal(out.res.headers.get("set-cookie"), null);
    },
    { production: true, devAuth: true },
  );
});

test("readiness rejects login mode with no configured users", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.auth.ok, false);
      assert.equal(body.checks.auth.code, "no_login_users");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "",
      bootstrapPassword: "",
      publicUrl: "https://science.example.com",
    },
  );
});

// Counting logins answers a different question than "can the administrator this
// deployment is configured for log in". Production ran two days with three
// unrelated accounts and a bootstrap user that had been deleted: seeding refuses
// to resurrect a deleted id, so it never came back, every login as that user was
// invalid_credentials, and readiness reported auth ok the whole time.
test("readiness reports the configured bootstrap account, not just that some account exists", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-bootstrap-user-"));
  const start = async (overrides) => {
    const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, ...overrides });
    const address = await app.listen(0, "127.0.0.1");
    return { app, base: `http://127.0.0.1:${address.port}` };
  };
  try {
    const seeded = await start({ bootstrapUser: "evimed", bootstrapPassword: "a-sufficiently-long-password" });
    try {
      const body = (await (await fetch(`${seeded.base}/api/ready`)).json()).data;
      assert.equal(body.checks.auth.ok, true);
      assert.equal(body.checks.auth.bootstrapUser, "present");
    } finally {
      await seeded.app.close();
    }

    // Same data directory, a different configured administrator, and no password
    // with which to create one. The seeded account is still there, so the login
    // count stays non-zero and the old check would have reported ok while the
    // configured administrator did not exist.
    const renamed = await start({ bootstrapUser: "site-admin", bootstrapPassword: "" });
    try {
      const body = (await (await fetch(`${renamed.base}/api/ready`)).json()).data;
      assert.equal(body.checks.auth.ok, false);
      assert.equal(body.checks.auth.code, "bootstrap_user_missing");
      assert.equal(body.checks.auth.bootstrapUser, "absent");
    } finally {
      await renamed.app.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Seeding into an empty set only: one unrelated account was enough for the
// configured administrator never to be created. The Postgres store was fixed for
// this; the file store kept the old gate.
test("the configured bootstrap account is created when it is absent, not only when nothing exists", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-bootstrap-seed-"));
  const start = async (overrides) => {
    const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, ...overrides });
    const address = await app.listen(0, "127.0.0.1");
    return { app, base: `http://127.0.0.1:${address.port}` };
  };
  try {
    const first = await start({ bootstrapUser: "first-admin", bootstrapPassword: "a-sufficiently-long-password" });
    await first.app.close();

    const second = await start({ bootstrapUser: "second-admin", bootstrapPassword: "another-long-password-x" });
    try {
      const body = (await (await fetch(`${second.base}/api/ready`)).json()).data;
      assert.equal(body.checks.auth.bootstrapUser, "present");
      // And it is a real account, not just a row: it can log in.
      const login = await fetch(`${second.base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "second-admin", password: "another-long-password-x" }),
      });
      assert.equal(login.status, 200);
    } finally {
      await second.app.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local authentication bootstraps from a no-follow password file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-bootstrap-secret-"));
  const dataDir = path.join(root, "data");
  const secretFile = path.join(root, "bootstrap-password.txt");
  const password = "file-backed-correct-horse-battery-staple";
  await writeFile(secretFile, `${password}\n`, { mode: 0o600 });
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    authMode: "local",
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPasswordFile: secretFile,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const ready = await fetch(`${base}/api/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).data.checks.auth.bootstrapPasswordSource, "file");

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password }),
    });
    assert.equal(login.status, 200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local authentication readiness rejects a symbolic-link password file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-bootstrap-secret-link-"));
  const target = path.join(root, "target.txt");
  const link = path.join(root, "bootstrap-password.txt");
  await writeFile(target, "file-backed-correct-horse-battery-staple\n", { mode: 0o600 });
  await symlink(target, link);
  const app = createWebApiApp({
    dataDir: path.join(root, "data"),
    port: 0,
    runtimeMode: "mock",
    authMode: "local",
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPasswordFile: link,
  });
  const address = await app.listen(0, "127.0.0.1");
  try {
    const ready = await fetch(`http://127.0.0.1:${address.port}/api/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).data.checks.auth.code, "bootstrap_password_file_symlink");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("production readiness rejects an environment-sourced bootstrap password", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-bootstrap-env-"));
  const previousPassword = process.env.OPEN_SCIENCE_BOOTSTRAP_PASSWORD;
  const previousFile = process.env.OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE;
  process.env.OPEN_SCIENCE_BOOTSTRAP_PASSWORD = "environment-correct-horse-battery-staple";
  delete process.env.OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE;
  let app;
  try {
    app = createWebApiApp({
      dataDir: path.join(root, "data"),
      port: 0,
      runtimeMode: "mock",
      allowMockRuntime: true,
      production: true,
      authMode: "local",
      devAuth: false,
      bootstrapUser: "alice",
      publicUrl: "https://science.example.com",
      ...productionReadinessReady,
    });
  } finally {
    if (previousPassword == null) delete process.env.OPEN_SCIENCE_BOOTSTRAP_PASSWORD;
    else process.env.OPEN_SCIENCE_BOOTSTRAP_PASSWORD = previousPassword;
    if (previousFile == null) delete process.env.OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE;
    else process.env.OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE = previousFile;
  }
  const address = await app.listen(0, "127.0.0.1");
  try {
    const ready = await fetch(`http://127.0.0.1:${address.port}/api/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).data.checks.auth.code, "bootstrap_password_environment_forbidden");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness rejects invalid production session TTLs", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.auth.ok, false);
      assert.equal(body.checks.auth.code, "session_ttl_invalid");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      sessionTtlMs: 0,
    },
  );
});

test("readiness rejects disabled production security headers", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.security.ok, false);
      assert.equal(body.checks.security.code, "security_headers_disabled");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      securityHeaders: false,
    },
  );
});

test("readiness requires the trusted reverse proxy boundary in production", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.security.ok, false);
      assert.equal(body.checks.security.code, "trusted_proxy_required");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      ...productionReadinessReady,
      trustProxy: false,
    },
  );
});

test("readiness rejects unsafe production CORS origins", async () => {
  const cases = [
    { corsOrigins: ["*"], code: "cors_origin_forbidden" },
    { corsOrigins: ["not a url"], code: "cors_origin_invalid" },
    { corsOrigins: ["https://app.example.com/path"], code: "cors_origin_not_exact" },
    { corsOrigins: ["http://app.example.com"], code: "cors_origin_https_required" },
    { corsOrigins: ["https://localhost:5173"], code: "cors_origin_local_forbidden" },
  ];
  for (const item of cases) {
    await withApp(
      async ({ base }) => {
        const res = await fetch(`${base}/api/ready`);
        assert.equal(res.status, 503);
        const body = (await res.json()).data;
        assert.equal(body.ok, false);
        assert.equal(body.checks.security.ok, false);
        assert.equal(body.checks.security.code, item.code);
      },
      {
        production: true,
        devAuth: false,
        bootstrapUser: "alice",
        bootstrapPassword: "correct horse battery staple",
        publicUrl: "https://science.example.com",
        operatorMetricsToken: "metrics-token-for-production-readiness-tests",
        runtimeMode: "mock",
        allowMockRuntime: true,
        corsOrigins: item.corsOrigins,
      },
    );
  }
});

test("readiness rejects dangerous production shell and approval controls", async () => {
  const cases = [
    { overrides: { allowHostShell: true }, code: "host_shell_enabled" },
    { overrides: { allowDirectShell: true }, code: "direct_shell_enabled" },
    { overrides: { allowPersistentApprovals: true }, code: "persistent_approvals_enabled" },
    { overrides: { allowFullApproval: true }, code: "full_approval_enabled" },
    { overrides: { approvalMode: "full" }, code: "full_approval_enabled" },
  ];
  for (const item of cases) {
    await withApp(
      async ({ base }) => {
        const res = await fetch(`${base}/api/ready`);
        assert.equal(res.status, 503);
        const body = (await res.json()).data;
        assert.equal(body.ok, false);
        assert.equal(body.checks.security.ok, false);
        assert.equal(body.checks.security.code, item.code);
      },
      {
        production: true,
        devAuth: false,
        bootstrapUser: "alice",
        bootstrapPassword: "correct horse battery staple",
        publicUrl: "https://science.example.com",
        runtimeMode: "mock",
        allowMockRuntime: true,
        ...item.overrides,
      },
    );
  }
});

test("readiness requires protected operator metrics in production", async () => {
  const cases = [
    { token: "", code: "operator_metrics_token_missing" },
    { token: "short-token", code: "operator_metrics_token_too_short" },
    { token: " replace-with-a-long-random-scrape-token", code: "operator_metrics_token_invalid" },
    { token: "replace-with-a-long-random-scrape-token", code: "operator_metrics_token_placeholder" },
  ];
  for (const item of cases) {
    await withApp(
      async ({ base }) => {
        const res = await fetch(`${base}/api/ready`);
        assert.equal(res.status, 503);
        const body = (await res.json()).data;
        assert.equal(body.ok, false);
        assert.equal(body.checks.observability.ok, false);
        assert.equal(body.checks.observability.code, item.code);
        if (item.token) assert.equal(JSON.stringify(body.checks.observability).includes(item.token), false);
      },
      {
        production: true,
        devAuth: false,
        bootstrapUser: "alice",
        bootstrapPassword: "correct horse battery staple",
        publicUrl: "https://science.example.com",
        runtimeMode: "mock",
        allowMockRuntime: true,
        ...productionReadinessReady,
        operatorMetricsToken: item.token,
      },
    );
  }
});

test("readiness requires a validated release manifest in production", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const check = (await res.json()).data.checks.release;
      assert.equal(check.ok, false);
      assert.equal(check.code, "release_manifest_missing");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      ...productionReadinessReady,
      releaseManifest: null,
    },
  );
});

test("production readiness accepts a release manifest that matches the deployed kernel", async () => {
  // Two readiness comparisons read the manifest's runtime row, and each had to
  // learn the kernel switch separately. `readinessRelease` had not: it compared
  // a kernel version field the manifest no longer carries, so the expected side
  // was `undefined` while the actual side held a real version — `release_
  // manifest_mismatch` on every deployment, unconditionally, and invisible in
  // dev because the whole block is behind `config.production`.
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      const body = (await res.json()).data;
      assert.equal(body.checks.release.ok, true, `release check: ${JSON.stringify(body.checks.release)}`);
      assert.equal(body.checks.release.code, undefined);
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      backupMode: "external",
      backupExternalAck: true,
      restoreDrillAck: true,
      operatorMetricsToken: "metrics-token-for-production-readiness-tests",
      trustProxy: true,
      ...dshProductionReleaseConfig,
    },
  );
});

test("a manifest from before the kernel change is refused at parse, by name", async () => {
  // Both directions of this used to be tested, because the rollback lever could
  // move the kernel under a manifest that described the other one. The lever is
  // gone and there is one kernel, so only one disagreement is still reachable —
  // and it is the one that matters on an upgrade: a release deployed against a
  // manifest generated before the kernel changed.
  //
  // That manifest carries `opencodeVersion` and no `dshVersion`. The rollback
  // work added a readiness check for exactly this, which turned out to be
  // unreachable: `releaseManifest.mjs` requires the runtime row's kernel keys
  // by name, so the manifest is refused at parse and never reaches the
  // field-by-field comparison. The property survives — the failure names the
  // manifest's shape rather than blaming a version number — and it is checked
  // where it actually happens.
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const check = (await res.json()).data.checks.release;
      assert.equal(check.ok, false);
      assert.equal(check.code, "release_manifest_runtime_fields_invalid");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      backupMode: "external",
      backupExternalAck: true,
      restoreDrillAck: true,
      operatorMetricsToken: "metrics-token-for-production-readiness-tests",
      trustProxy: true,
      ...dshProductionReleaseConfig,
      releaseManifest: {
        ...dshProductionReleaseConfig.releaseManifest,
        runtime: (() => {
          const { dshVersion: _dshVersion, ...withoutDsh } = dshProductionReleaseConfig.releaseManifest.runtime;
          return { ...withoutDsh, opencodeVersion: "1.17.13" };
        })(),
      },
    },
  );
});

test("a DSH release whose kernel version drifts is still caught", async () => {
  // The negative control. Making the check kernel-aware must not make it
  // toothless: a manifest naming one DSH build while the deployment runs
  // another is exactly what this comparison is for, and reporting `dshVersion`
  // by name is what tells an operator which half to fix.
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const check = (await res.json()).data.checks.release;
      assert.equal(check.ok, false);
      assert.equal(check.code, "release_manifest_mismatch");
      assert.equal(check.field, "dshVersion");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      backupMode: "external",
      backupExternalAck: true,
      restoreDrillAck: true,
      operatorMetricsToken: "metrics-token-for-production-readiness-tests",
      trustProxy: true,
      ...dshProductionReleaseConfig,
      dshVersion: "0.1.1-rc.9",
    },
  );
});

test("readiness rejects deployment settings that disagree with the release manifest", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const check = (await res.json()).data.checks.release;
      assert.equal(check.ok, false);
      assert.equal(check.code, "release_manifest_mismatch");
      assert.equal(check.field, "runtimeContainerImage");
      assert.equal(JSON.stringify(check).includes(releaseManifestFixture.runtime.imageId), false);
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      ...productionReadinessReady,
      runtimeContainerImage: "evimed-runtime-dsh:mismatch",
    },
  );
});

test("readiness rejects invalid production resource limits", async () => {
  const baseConfig = {
    production: true,
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    publicUrl: "https://science.example.com",
    runtimeMode: "mock",
    allowMockRuntime: true,
  };
  const cases = [
    { overrides: { maxFileBytes: 0 }, code: "resource_limit_invalid", field: "maxFileBytes" },
    {
      overrides: { maxConcurrentKernels: 0 },
      code: "resource_limit_invalid",
      field: "maxConcurrentKernels",
    },
    {
      overrides: { runtimeQuotaCheckIntervalMs: 0 },
      code: "resource_limit_invalid",
      field: "runtimeQuotaCheckIntervalMs",
    },
    {
      overrides: { maxFileBytes: 2 * 1024, maxProjectBytes: 1024 },
      code: "resource_limit_inconsistent",
      field: "maxFileBytes",
      maximum: "maxProjectBytes",
    },
    {
      overrides: { maxQueuedTasks: 2, maxQueuedTasksPerProject: 3 },
      code: "resource_limit_inconsistent",
      field: "maxQueuedTasksPerProject",
      maximum: "maxQueuedTasks",
    },
    {
      overrides: { maxConcurrentKernels: 1, maxConcurrentKernelsPerUser: 2 },
      code: "resource_limit_inconsistent",
      field: "maxConcurrentKernelsPerUser",
      maximum: "maxConcurrentKernels",
    },
    {
      overrides: {
        runtimeMode: "kernel",
        runtimeSandboxMode: "docker",
        runtimeNetworkMode: "none",
        runtimeRequireImageLocal: false,
        runtimeCpuLimit: "0",
      },
      code: "resource_limit_invalid",
      field: "runtimeCpuLimit",
    },
    {
      overrides: {
        runtimeMode: "kernel",
        runtimeSandboxMode: "docker",
        runtimeNetworkMode: "none",
        runtimeRequireImageLocal: false,
        runtimeMemoryLimit: "0g",
      },
      code: "resource_limit_invalid",
      field: "runtimeMemoryLimit",
    },
  ];

  for (const item of cases) {
    await withApp(
      async ({ base }) => {
        const res = await fetch(`${base}/api/ready`);
        assert.equal(res.status, 503);
        const body = (await res.json()).data;
        assert.equal(body.ok, false);
        assert.equal(body.checks.resources.ok, false);
        assert.equal(body.checks.resources.code, item.code);
        assert.equal(body.checks.resources.field, item.field);
        if (item.maximum) assert.equal(body.checks.resources.maximum, item.maximum);
      },
      {
        ...baseConfig,
        ...item.overrides,
      },
    );
  }
});

test("production readiness requires the server-held Materials Project key", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const check = (await res.json()).data.checks.scienceConnectors;
      assert.equal(check.ok, false);
      assert.equal(check.code, "materials_project_api_key_missing");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      ...productionReadinessReady,
      materialsProjectApiKey: "",
    },
  );
});

test("controlled production can declare Materials Project unavailable without faking a key", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 200);
      const check = (await res.json()).data.checks.scienceConnectors;
      assert.equal(check.ok, true);
      assert.deepEqual(check, {
        ok: true,
        enabled: 6,
        gateway: "server-managed",
        materialsProjectEnabled: false,
        materialsProjectRequired: false,
        materialsProjectKeySource: "none",
      });
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      ...productionReadinessReady,
      materialsProjectApiKey: "",
      materialsProjectApiKeySource: "none",
      materialsProjectApiKeyError: null,
      requireMaterialsProject: false,
    },
  );
});

test("readiness requires explicit production backup configuration", async () => {
  const baseConfig = {
    production: true,
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    publicUrl: "https://science.example.com",
    runtimeMode: "mock",
    allowMockRuntime: true,
  };

  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.backup.ok, false);
      assert.equal(body.checks.backup.code, "backup_not_configured");
    },
    baseConfig,
  );

  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.backup.ok, false);
      assert.equal(body.checks.backup.code, "backup_external_unconfirmed");
    },
    {
      ...baseConfig,
      backupMode: "external",
      restoreDrillAck: true,
    },
  );

  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.backup.ok, false);
      assert.equal(body.checks.backup.code, "restore_drill_unconfirmed");
    },
    {
      ...baseConfig,
      backupMode: "external",
      backupExternalAck: true,
    },
  );
});

test("readiness validates local production backup settings without exposing paths", async () => {
  const backupParent = await realpath(tmpdir());
  const backupDir = await mkdtemp(path.join(backupParent, "os-web-backups-"));
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(backupDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    path.join(backupDir, ".open-science-backup-state.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      status: "healthy",
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastDrillAt: now,
      lastArchive: "open-science-data-20260710T000000Z.tar.gz.enc",
      successfulBackups: 1,
      consecutiveFailures: 0,
    })}\n`,
    { mode: 0o600 },
  );
  try {
    await withApp(
      async ({ base }) => {
        const res = await fetch(`${base}/api/ready`);
        assert.equal(res.status, 200);
        const body = (await res.json()).data;
        assert.equal(body.ok, true);
        assert.equal(body.checks.backup.ok, true);
        assert.equal(body.checks.backup.mode, "local");
        assert.equal(body.checks.backup.retentionDays, 30);
        assert.equal(body.checks.backup.encrypted, true);
        assert.equal(body.checks.backup.schedulerHealthy, true);
        assert.equal(JSON.stringify(body.checks.backup).includes(backupDir), false);
      },
      {
        production: true,
        devAuth: false,
        bootstrapUser: "alice",
        bootstrapPassword: "correct horse battery staple",
        publicUrl: "https://science.example.com",
        runtimeMode: "mock",
        allowMockRuntime: true,
        backupMode: "local",
        operatorMetricsToken: "metrics-token-for-production-readiness-tests",
        backupDir,
        backupRetentionDays: 30,
        backupPassphraseConfigured: true,
        restoreDrillAck: true,
        trustProxy: true,
        ...productionReleaseConfig,
      },
    );
  } finally {
    await rm(backupDir, { recursive: true, force: true });
  }
});

test("readiness rejects unsafe local production backup directories", async () => {
  const baseConfig = {
    production: true,
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    publicUrl: "https://science.example.com",
    runtimeMode: "mock",
    allowMockRuntime: true,
    backupMode: "local",
    backupRetentionDays: 30,
    backupPassphraseConfigured: true,
    restoreDrillAck: true,
  };

  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.checks.backup.ok, false);
      assert.equal(body.checks.backup.code, "backup_dir_not_absolute");
    },
    {
      ...baseConfig,
      backupDir: "relative-backups",
    },
  );

  await withApp(
    async ({ app, base }) => {
      app.config.backupDir = path.join(app.config.dataDir, "backups");
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.checks.backup.ok, false);
      assert.equal(body.checks.backup.code, "backup_dir_inside_data_dir");
    },
    {
      ...baseConfig,
      backupDir: "/tmp/open-science-unused-backups",
    },
  );

  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.checks.backup.ok, false);
      assert.equal(body.checks.backup.code, "backup_encryption_missing");
    },
    {
      ...baseConfig,
      backupDir: path.join(tmpdir(), `os-web-backups-${Date.now()}`),
      backupPassphraseConfigured: false,
    },
  );
});

test("readiness fails closed on missing, failed, stale, or symlinked backup scheduler state", async () => {
  const backupDir = await realpath(await mkdtemp(path.join(tmpdir(), "os-web-backup-state-")));
  const stateFile = path.join(backupDir, ".open-science-backup-state.json");
  const targetFile = path.join(backupDir, "state-target.json");
  const baseConfig = {
    production: true,
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    publicUrl: "https://science.example.com",
    runtimeMode: "mock",
    allowMockRuntime: true,
    backupMode: "local",
    backupDir,
    backupRetentionDays: 30,
    backupPassphraseConfigured: true,
    restoreDrillAck: true,
    backupIntervalSeconds: 60,
    backupHealthGraceSeconds: 60,
  };
  const healthyShape = {
    schemaVersion: 1,
    status: "healthy",
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastDrillAt: new Date().toISOString(),
    lastArchive: "open-science-data-20260710T000000Z.tar.gz.enc",
    successfulBackups: 1,
    consecutiveFailures: 0,
  };
  const cases = [
    { code: "backup_state_missing", prepare: async () => {} },
    {
      code: "backup_scheduler_unhealthy",
      prepare: async () => writeFile(stateFile, `${JSON.stringify({ ...healthyShape, status: "failed" })}\n`),
    },
    {
      code: "backup_scheduler_stale",
      prepare: async () => writeFile(
        stateFile,
        `${JSON.stringify({ ...healthyShape, lastSuccessAt: "2020-01-01T00:00:00.000Z" })}\n`,
      ),
    },
    {
      code: "backup_state_symlink",
      prepare: async () => {
        await writeFile(targetFile, `${JSON.stringify(healthyShape)}\n`);
        await symlink(targetFile, stateFile);
      },
    },
  ];
  try {
    for (const item of cases) {
      await rm(stateFile, { force: true });
      await rm(targetFile, { force: true });
      await item.prepare();
      await withApp(
        async ({ base }) => {
          const response = await fetch(`${base}/api/ready`);
          assert.equal(response.status, 503);
          const body = (await response.json()).data;
          assert.equal(body.checks.backup.ok, false);
          assert.equal(body.checks.backup.code, item.code);
        },
        baseConfig,
      );
    }
  } finally {
    await rm(backupDir, { recursive: true, force: true });
  }
});

test("readiness rejects production mode without a public URL", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.publicUrl.ok, false);
      assert.equal(body.checks.publicUrl.code, "public_url_missing");
      assert.equal(body.checks.auth.ok, true);
      assert.equal(body.checks.runtime.ok, true);
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      runtimeMode: "mock",
      allowMockRuntime: true,
    },
  );
});

test("readiness rejects production mode with a non-HTTPS public URL", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.publicUrl.ok, false);
      assert.equal(body.checks.publicUrl.code, "public_url_https_required");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "http://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
    },
  );
});

test("readiness rejects production public URLs that are not origins", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.publicUrl.ok, false);
      assert.equal(body.checks.publicUrl.code, "public_url_origin_required");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com/app?from=docs",
      runtimeMode: "mock",
      allowMockRuntime: true,
    },
  );
});

test("readiness rejects mock runtime in production unless explicitly allowed", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.auth.ok, true);
      assert.equal(body.checks.runtime.ok, false);
      assert.equal(body.checks.runtime.code, "runtime_mock_forbidden");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
    },
  );
});

test("readiness allows production mock runtime only with explicit opt-in", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 200);
      const body = (await res.json()).data;
      assert.equal(body.ok, true);
      assert.equal(body.checks.publicUrl.origin, "https://science.example.com");
      assert.equal(body.checks.publicUrl.secure, true);
      assert.equal(body.checks.security.ok, true);
      assert.equal(body.checks.security.production, true);
      assert.equal(body.checks.resources.ok, true);
      assert.equal(body.checks.resources.production, true);
      assert.equal(body.checks.resources.maxConcurrentTasks, 2);
      assert.equal(body.checks.observability.ok, true);
      assert.equal(body.checks.observability.required, true);
      assert.equal(body.checks.observability.mode, "protected");
      assert.equal(body.checks.release.ok, true);
      assert.equal(body.checks.release.tracked, true);
      assert.equal(body.checks.release.releaseId, releaseManifestFixture.app.releaseId);
      assert.equal(body.checks.release.revision, releaseManifestFixture.source.revision.slice(0, 12));
      assert.equal(body.checks.runtime.mode, "mock");
      assert.equal(body.checks.runtime.explicit, true);
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "mock",
      allowMockRuntime: true,
      ...productionReadinessReady,
    },
  );
});

test("readiness accepts exact HTTPS production CORS origins", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 200);
      const body = (await res.json()).data;
      assert.equal(body.ok, true);
      assert.equal(body.checks.security.ok, true);
      assert.equal(body.checks.security.corsOriginCount, 1);
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      corsOrigins: ["https://app.example.com"],
      runtimeMode: "mock",
      allowMockRuntime: true,
      ...productionReadinessReady,
    },
  );
});

test("readiness rejects host Python kernels in production mode", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.auth.ok, true);
      assert.equal(body.checks.kernel.ok, false);
      assert.equal(body.checks.kernel.code, "kernel_sandbox_required");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      enableKernel: true,
      allowUnsandboxedKernel: true,
    },
  );
});

test("production readiness rejects direct Docker control without the isolated controller", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.checks.runtime.ok, false);
      assert.equal(body.checks.runtime.code, "runtime_controller_required");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      runtimeControllerMode: "direct",
      allowDirectDockerControl: false,
      runtimeRequireImageLocal: false,
      ...productionReadinessReady,
    },
  );
});

test("readiness accepts a production Docker kernel sandbox with a local image", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "os-web-fake-docker-"));
  try {
    const dockerBin = await fakeDockerBin(tmp, path.join(tmp, "docker-log.json"));
    await withApp(
      async ({ base }) => {
        const res = await fetch(`${base}/api/ready`);
        assert.equal(res.status, 200);
        const body = (await res.json()).data;
        assert.equal(body.ok, true);
        assert.equal(body.checks.kernel.ok, true);
        assert.equal(body.checks.kernel.sandboxMode, "docker");
        assert.equal(body.checks.kernel.networkMode, "none");
        assert.equal(body.checks.kernel.imageLocal, true);
        assert.equal(body.checks.kernel.imageVerified, true);
      },
      {
        production: true,
        devAuth: false,
        bootstrapUser: "alice",
        bootstrapPassword: "correct horse battery staple",
        publicUrl: "https://science.example.com",
        runtimeMode: "mock",
        allowMockRuntime: true,
        enableKernel: true,
        kernelSandboxMode: "docker",
        allowDirectDockerControl: true,
        runtimeContainerBin: dockerBin,
        runtimeRequireImageLocal: true,
        ...productionReadinessReady,
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("readiness rejects Docker image metadata that disagrees with the release manifest", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "os-web-fake-docker-"));
  const dockerBin = path.join(tmp, "docker-fake");
  await writeFile(
    dockerBin,
    [
      "#!/bin/sh",
      'if [ "$1" = "info" ]; then exit 0; fi',
      // Id | runtime.version | uv.version — the three placeholders the gate
      // asks for, in order. Only the id disagrees with the manifest, so the
      // reported field is unambiguous; a stub that answered a field count the
      // gate no longer asks for would blank the last column instead and fail
      // `runtime_image_metadata_missing` without ever reaching provenance.
      `if [ "$1" = "image" ]; then echo 'sha256:${"f".repeat(64)}|${releaseManifestFixture.runtime.dshVersion}|${releaseManifestFixture.runtime.uvVersion}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  try {
    await withApp(
      async ({ base }) => {
        const res = await fetch(`${base}/api/ready`);
        assert.equal(res.status, 503);
        const check = (await res.json()).data.checks.kernel;
        assert.equal(check.ok, false);
        assert.equal(check.code, "runtime_image_provenance_mismatch");
        assert.equal(check.field, "imageId");
        assert.equal(JSON.stringify(check).includes("f".repeat(64)), false);
      },
      {
        production: true,
        devAuth: false,
        bootstrapUser: "alice",
        bootstrapPassword: "correct horse battery staple",
        publicUrl: "https://science.example.com",
        runtimeMode: "mock",
        allowMockRuntime: true,
        enableKernel: true,
        kernelSandboxMode: "docker",
        allowDirectDockerControl: true,
        runtimeContainerBin: dockerBin,
        runtimeRequireImageLocal: true,
        ...productionReadinessReady,
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("readiness rejects an unsandboxed kernel runtime, opt-in or not", async () => {
  // The property is the sandbox invariant, and it is stricter than the opt-in
  // that used to gate it. The kernel's EviMed composition lives in the runtime
  // image, so a host-mode deployment would serve a runtime that boots, answers
  // its own health probe and can satisfy nothing. Readiness refuses it whatever
  // `allowUnsandboxedRuntime` says, so both values are exercised: a build that
  // let the opt-in through again would fail here rather than ship.
  for (const allowUnsandboxedRuntime of [false, true]) {
    await withApp(
      async ({ base }) => {
        const res = await fetch(`${base}/api/ready`);
        assert.equal(res.status, 503, `allowUnsandboxedRuntime=${allowUnsandboxedRuntime}`);
        const body = (await res.json()).data;
        assert.equal(body.ok, false);
        assert.equal(body.checks.runtime.ok, false);
        assert.equal(body.checks.runtime.code, "runtime_sandbox_invalid");
      },
      {
        runtimeMode: "kernel",
        dshBin: "/bin/echo",
        runtimeSandboxMode: "host",
        allowUnsandboxedRuntime,
      },
    );
  }
});

test("readiness rejects invalid Docker data volumes and incompatible transports", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).data.checks.runtime.code, "runtime_data_volume_invalid");
    },
    {
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "/bin/true",
      runtimeDataVolume: "invalid/volume",
      runtimeTransport: "unix",
      runtimeRequireImageLocal: false,
    },
  );

  // The same property one layer earlier. A data volume is only servable over
  // the unix transport, and readiness used to report that as
  // `runtime_transport_volume_mismatch`. `loadConfig` now accepts no transport
  // but `unix`, so the deployment is refused before a server exists to ask —
  // the readiness branch is unreachable, not gone. Asserted at the layer that
  // owns it so a build that quietly re-accepted TCP still fails here.
  const transportDataDir = await mkdtemp(path.join(tmpdir(), "os-web-transport-"));
  try {
    assert.throws(
      () =>
        createWebApiApp({
          dataDir: transportDataDir,
          port: 0,
          devAuth: true,
          runtimeMode: "kernel",
          runtimeSandboxMode: "docker",
          runtimeContainerBin: "/bin/true",
          runtimeDataVolume: "open-science-data",
          runtimeTransport: "tcp",
          runtimeRequireImageLocal: false,
        }),
      /OPEN_SCIENCE_RUNTIME_TRANSPORT must be "unix"/,
    );
  } finally {
    await rm(transportDataDir, { recursive: true, force: true });
  }
});

test("readiness rejects production docker runtime network egress unless explicitly allowed", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.runtime.ok, false);
      assert.equal(body.checks.runtime.code, "runtime_network_egress_forbidden");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      allowDirectDockerControl: true,
      runtimeNetworkMode: "bridge",
      runtimeRequireImageLocal: false,
    },
  );
});

test("readiness rejects production docker runtime network egress without policy acknowledgement", async () => {
  await withApp(
    async ({ base }) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.runtime.ok, false);
      assert.equal(body.checks.runtime.code, "runtime_network_egress_policy_unconfirmed");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      allowDirectDockerControl: true,
      runtimeNetworkMode: "bridge",
      allowRuntimeNetworkEgress: true,
      runtimeRequireImageLocal: false,
      ...productionReadinessReady,
    },
  );
});

test("readiness allows production docker runtime network egress with opt-in and policy acknowledgement", async () => {
  await withApp(
    async ({ app, base }) => {
      const docker = path.join(app.config.dataDir, "docker-fake");
      await writeFile(
        docker,
        ["#!/bin/sh", "if [ \"$1\" = \"info\" ]; then echo 26.0.0; exit 0; fi", "exit 1", ""].join("\n"),
        { mode: 0o755 },
      );
      app.config.runtimeContainerBin = docker;

      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 200);
      const body = (await res.json()).data;
      assert.equal(body.ok, true);
      assert.equal(body.checks.runtime.networkMode, "bridge");
      assert.equal(body.checks.runtime.networkEgress, "explicitly_allowed");
      assert.equal(body.checks.runtime.networkPolicy, "acknowledged");
      assert.equal(body.checks.runtime.transport, "unix");
      assert.equal(body.checks.runtime.dataMount, "volume");
    },
    {
      production: true,
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      allowDirectDockerControl: true,
      runtimeNetworkMode: "bridge",
      allowRuntimeNetworkEgress: true,
      runtimeNetworkEgressPolicyAck: true,
      runtimeDataVolume: "open-science-data",
      runtimeTransport: "unix",
      runtimeRequireImageLocal: false,
      ...productionReadinessReady,
    },
  );
});

test("readiness rejects a docker kernel runtime when the required image is unavailable", async () => {
  await withApp(
    async ({ app, base }) => {
      const docker = path.join(app.config.dataDir, "docker-fake");
      await writeFile(
        docker,
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"info\" ]; then echo 24.0.0; exit 0; fi",
          "if [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 1; fi",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      app.config.runtimeContainerBin = docker;

      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()).data;
      assert.equal(body.ok, false);
      assert.equal(body.checks.runtime.ok, false);
      assert.equal(body.checks.runtime.code, "runtime_image_unavailable");
    },
    {
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      runtimeContainerImage: "missing-runtime-dsh:latest",
      runtimeRequireImageLocal: true,
    },
  );
});

test("readiness can skip docker image locality checks for lazy-pull deployments", async () => {
  await withApp(
    async ({ app, base }) => {
      const docker = path.join(app.config.dataDir, "docker-fake");
      await writeFile(
        docker,
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"info\" ]; then echo 24.0.0; exit 0; fi",
          "if [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 1; fi",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      app.config.runtimeContainerBin = docker;

      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 200);
      const body = (await res.json()).data;
      assert.equal(body.ok, true);
      assert.equal(body.checks.runtime.ok, true);
      assert.equal(body.checks.runtime.imageCheck, "skipped");
    },
    {
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      runtimeContainerImage: "remote-runtime-dsh:latest",
      runtimeRequireImageLocal: false,
    },
  );
});

test("API requests are rate limited per client address", async () => {
  await withApp(
    async ({ base }) => {
      assert.equal(
        (await fetch(`${base}/api/commands`, { headers: { "X-Forwarded-For": "203.0.113.1" } })).status,
        200,
      );
      assert.equal(
        (await fetch(`${base}/api/commands`, { headers: { "X-Forwarded-For": "203.0.113.2" } })).status,
        200,
      );

      const limited = await fetch(`${base}/api/commands`, {
        headers: { "X-Forwarded-For": "203.0.113.3" },
      });
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).code, "rate_limited");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    },
    { rateLimitMaxRequests: 2, rateLimitWindowMs: 60_000 },
  );
});

test("trusted proxy rate limits validated forwarded clients independently", async () => {
  await withApp(
    async ({ base }) => {
      const request = (forwarded) =>
        fetch(`${base}/api/commands`, { headers: { "X-Forwarded-For": forwarded } });

      assert.equal((await request("203.0.113.10")).status, 200);
      assert.equal((await request("203.0.113.11")).status, 200);
      assert.equal((await request("203.0.113.10")).status, 429);

      assert.equal((await request("attacker-controlled-a")).status, 200);
      const invalid = await request("attacker-controlled-b");
      assert.equal(invalid.status, 429);
      assert.equal((await invalid.json()).code, "rate_limited");
    },
    { trustProxy: true, rateLimitMaxRequests: 1, rateLimitWindowMs: 60_000 },
  );
});

test("server-side approval policy is immutable through the hosted command API", async () => {
  await withApp(async ({ base }) => {
    let out = await command(base, "get_approval_mode");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "approve");

    out = await command(base, "set_approval_mode", { mode: "full" });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "approval_mode_managed");

    out = await command(base, "set_approval_mode", { mode: "approve" });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "approval_mode_managed");

    out = await command(base, "get_approval_mode");
    assert.equal(out.json.data, "approve");
  });
});

test("hosted users cannot lower an operator-configured approval policy", async () => {
  await withApp(
    async ({ base }) => {
      let out = await command(base, "get_approval_mode");
      assert.equal(out.json.data, "full");

      out = await command(base, "set_approval_mode", { mode: "approve" });
      assert.equal(out.res.status, 403);
      assert.equal(out.json.code, "approval_mode_managed");

      out = await command(base, "get_approval_mode");
      assert.equal(out.json.data, "full");
    },
    { approvalMode: "full", allowFullApproval: true },
  );
});

test("hosted provider and MCP mutation commands fail explicitly", async () => {
  await withApp(async ({ base }) => {
    let out = await command(base, "configure_opencode", {
      provider: "example",
      apiKey: "browser-key-must-not-be-accepted",
      model: "example/model",
    });
    assert.equal(out.res.status, 501);
    assert.equal(out.json.code, "unsupported_in_web");

    out = await command(base, "remove_config_entry", { kind: "mcp", key: "example" });
    assert.equal(out.res.status, 501);
    assert.equal(out.json.code, "unsupported_in_web");
  });
});

test("hosted tool detection does not expose server-local tools", async () => {
  await withApp(async ({ base }) => {
    const out = await command(base, "detect_tools");
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data, []);
    assert.equal(JSON.stringify(out.json).includes(process.version), false);
  });
});

test("login attempts use a stricter auth rate limit", async () => {
  await withAuthApp(
    async ({ app, base }) => {
      const first = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "wrong-password" }),
      });
      assert.equal(first.status, 401);

      const limited = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "wrong-password" }),
      });
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).code, "auth_rate_limited");

      const securityLog = await readFile(path.join(app.config.dataDir, ".openscience", "security.jsonl"), "utf8");
      assert.ok(
        securityLog
          .split("\n")
          .filter(Boolean)
          .some((line) => {
            const row = JSON.parse(line);
            return row.action === "auth.login" && row.status === "failed" && row.code === "invalid_credentials";
          }),
      );
    },
    { authRateLimitMaxRequests: 1, authRateLimitWindowMs: 60_000 },
  );
});

test("starting a real kernel runtime unsandboxed is refused, opt-in or not", async () => {
  // Readiness is advisory for an operator; this is the enforcing edge. A run
  // asked for through the command API must not get a host-launched kernel even
  // when readiness was never consulted, and the opt-in that used to buy one no
  // longer buys anything — both values are exercised for that reason.
  for (const allowUnsandboxedRuntime of [false, true]) {
    await withApp(
      async ({ base }) => {
        const out = await command(base, "start_runtime");
        assert.equal(out.res.status, 400, `allowUnsandboxedRuntime=${allowUnsandboxedRuntime}`);
        assert.equal(out.json.code, "invalid_runtime_sandbox");
      },
      {
        runtimeMode: "kernel",
        dshBin: "/bin/echo",
        runtimeSandboxMode: "host",
        allowUnsandboxedRuntime,
      },
    );
  }
});

test("production command API rejects mock runtime startup unless explicitly allowed", async () => {
  await withAuthApp(
    async ({ base }) => {
      const loggedIn = await login(base);
      const out = await commandWithHeaders(base, "start_runtime", {}, loggedIn.auth);
      assert.equal(out.res.status, 503);
      assert.equal(out.json.code, "runtime_mock_forbidden");
    },
    {
      production: true,
      runtimeMode: "mock",
      allowMockRuntime: false,
    },
  );
});

test("production command API rejects runtime egress without policy acknowledgement", async () => {
  await withAuthApp(
    async ({ base }) => {
      const loggedIn = await login(base);
      const out = await commandWithHeaders(base, "start_runtime", {}, loggedIn.auth);
      assert.equal(out.res.status, 403);
      assert.equal(out.json.code, "runtime_network_egress_policy_unconfirmed");
    },
    {
      production: true,
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      allowDirectDockerControl: true,
      runtimeNetworkMode: "bridge",
      allowRuntimeNetworkEgress: true,
      runtimeNetworkEgressPolicyAck: false,
    },
  );
});

test("production command API rejects direct Docker control even when readiness is bypassed", async () => {
  await withAuthApp(
    async ({ base }) => {
      const loggedIn = await login(base);
      const out = await commandWithHeaders(base, "start_runtime", {}, loggedIn.auth);
      assert.equal(out.res.status, 503);
      assert.equal(out.json.code, "runtime_controller_required");
    },
    {
      production: true,
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      runtimeControllerMode: "direct",
      allowDirectDockerControl: false,
      runtimeRequireImageLocal: false,
    },
  );
});

test("command API requests are rate limited per user project and command", async () => {
  await withApp(
    async ({ base }) => {
      let out = await command(base, "list_dir");
      assert.equal(out.res.status, 200);

      out = await command(base, "list_dir");
      assert.equal(out.res.status, 429);
      assert.equal(out.json.code, "command_rate_limited");
    },
    { commandRateLimitMaxRequests: 1, commandRateLimitWindowMs: 60_000 },
  );
});

test("unknown commands share a bounded rate key and do not enter audit logs", async () => {
  await withApp(
    async ({ base }) => {
      const markers = ["PRIVATE_COMMAND_ALPHA", "PRIVATE_COMMAND_BETA", "PRIVATE_COMMAND_GAMMA"];
      for (const marker of markers.slice(0, 2)) {
        const out = await command(base, marker);
        assert.equal(out.res.status, 404);
        assert.equal(out.json.code, "unknown_command");
      }

      const limited = await command(base, markers[2]);
      assert.equal(limited.res.status, 429);
      assert.equal(limited.json.code, "command_rate_limited");

      const logs = await fetch(`${base}/api/logs/audit?limit=20`);
      assert.equal(logs.status, 200);
      const text = await logs.text();
      assert.equal(markers.some((marker) => text.includes(marker)), false);
      const rows = JSON.parse(text).data;
      assert.ok(rows.some((row) => row.action === "command.unknown" && row.error === "unknown_command"));
    },
    { commandRateLimitMaxRequests: 2, commandRateLimitWindowMs: 60_000 },
  );
});

test("public readiness does not disclose the local account count", async () => {
  await withAuthApp(async ({ base }) => {
    const ready = await fetch(`${base}/api/ready`);
    assert.equal(ready.status, 200);
    const auth = (await ready.json()).data.checks.auth;
    assert.equal(auth.ok, true);
    assert.equal(auth.mode, "local");
    assert.equal(Object.hasOwn(auth, "users"), false);
  });
});

test("production auth rejects anonymous requests and accepts login cookies", async () => {
  await withAuthApp(async ({ app, base }) => {
    const anonymous = await fetch(`${base}/api/me`);
    assert.equal(anonymous.status, 401);

    const loggedIn = await login(base);
    assert.equal(loggedIn.res.status, 200);
    assert.ok(loggedIn.cookie.startsWith("os_session="));
    assert.match(loggedIn.csrfToken, /^csrf_/);

    const me = await fetch(`${base}/api/me`, { headers: { Cookie: loggedIn.cookie } });
    assert.equal(me.status, 200);
    const body = (await me.json()).data;
    assert.equal(body.user.id, "alice");
    assert.deepEqual(body.tenant, {
      id: "alice",
      model: "individual-account",
      role: "owner",
    });
    assert.equal(body.csrfToken, loggedIn.csrfToken);

    // What the deployment serves as its session surface, decided here and not
    // by a build flag: the views read different sources, and a deployment that
    // serves the kernel's own application serves it from an origin only the
    // server knows. Empty here because this app does not serve it.
    assert.deepEqual(body.runtime, { kernel: "dsh", sessionView: "run-stream", uiOrigin: "" });

    const securityLog = await readFile(path.join(app.config.dataDir, ".openscience", "security.jsonl"), "utf8");
    assert.ok(
      securityLog
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          const row = JSON.parse(line);
          return row.action === "auth.login" && row.status === "completed" && row.username === "alice";
        }),
    );
  });
});

test("a browser holding a deleted project's id can still open its account", async () => {
  // A browser remembers its project and sends it on every request, including
  // the one the shell asks before it renders anything. Deleting that project
  // -- from another device, or from this one with the tab still open -- used
  // to make this route 404: the account became unopenable, and logging in
  // again did not help, because the browser sent the same dead id.
  await withAuthApp(async ({ base }) => {
    const loggedIn = await login(base);

    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        Cookie: loggedIn.cookie,
        "Content-Type": "application/json",
        "X-Open-Science-CSRF": loggedIn.csrfToken,
      },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);

    const deleted = await fetch(`${base}/api/projects/paper1`, {
      method: "DELETE",
      headers: {
        Cookie: loggedIn.cookie,
        "Content-Type": "application/json",
        "X-Open-Science-CSRF": loggedIn.csrfToken,
      },
      body: JSON.stringify({ confirm: "paper1" }),
    });
    assert.equal(deleted.status, 200);

    const me = await fetch(`${base}/api/me`, {
      headers: { Cookie: loggedIn.cookie, "X-Open-Science-Project": "paper1" },
    });
    assert.equal(me.status, 200);
    // And it says which project it actually selected, so the browser can
    // correct itself rather than keep sending the dead one.
    assert.equal((await me.json()).data.project.id, "default");
  });

  // Every other route still refuses it. The fallback is for the one read the
  // shell cannot recover from, not a licence to silently redirect work into
  // another project.
  await withAuthApp(async ({ base }) => {
    const loggedIn = await login(base);
    const runs = await fetch(`${base}/api/agent-runs`, {
      headers: { Cookie: loggedIn.cookie, "X-Open-Science-Project": "never-existed" },
    });
    assert.equal(runs.status, 404);
    assert.equal((await runs.json()).code, "project_not_found");
  });
});

test("an account cannot hold more projects than its limit", async () => {
  // A per-project storage quota and a per-user runtime limit bound nothing on
  // their own: an account at either limit can make another project and have
  // another of each.
  await withAuthApp(async ({ base }) => {
    const loggedIn = await login(base);
    const create = (id) =>
      fetch(`${base}/api/projects`, {
        method: "POST",
        headers: {
          Cookie: loggedIn.cookie,
          "Content-Type": "application/json",
          "X-Open-Science-CSRF": loggedIn.csrfToken,
        },
        body: JSON.stringify({ id, name: id }),
      });

    // `default` already exists, so one more reaches the limit of two.
    assert.equal((await create("paper1")).status, 200);
    const refused = await create("paper2");
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "project_limit_reached");

    // Re-creating one that exists is not a new project and is not refused —
    // otherwise an account at its limit could never touch its own projects.
    assert.equal((await create("paper1")).status, 200);
  }, { maxProjectsPerUser: 2 });
});

test("a run is refused before it starts when the account is over its cap", async () => {
  // At dispatch and nowhere else. A cap enforced mid-run abandons a run that
  // has already spent most of what it was going to spend and delivers nothing
  // for it — the one outcome worse than going slightly over.
  await withAuthApp(async ({ app, base }) => {
    const loggedIn = await login(base);
    const usageFile = path.join(app.config.dataDir, ".openscience", "usage.jsonl");
    await mkdir(path.dirname(usageFile), { recursive: true });
    await writeFile(
      usageFile,
      `${JSON.stringify({
        at: new Date().toISOString(),
        resourceType: "model",
        userId: "alice",
        projectId: "default",
        model: "deepseek-v4-pro",
        cacheHit: 0,
        cacheMiss: 1000,
        output: 500,
        cost: 25,
        currency: "CNY",
        priced: true,
      })}\n`,
      "utf8",
    );

    const refused = await fetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: {
        Cookie: loggedIn.cookie,
        "Content-Type": "application/json",
        "X-Open-Science-CSRF": loggedIn.csrfToken,
      },
      body: JSON.stringify({ sessionId: "ses-1", dispatchId: "turn-1", text: "analyze this" }),
    });
    assert.equal(refused.status, 402);
    const body = await refused.json();
    // The window, not just "no credits": a daily cap frees up on its own, a
    // weekly one is a conversation with whoever set it.
    assert.equal(body.code, "credits_daily_limit_reached");
    assert.match(body.error, /25 of 10 CNY used/);
    // And when it frees up, as a number the client can act on.
    assert.ok(Number(refused.headers.get("retry-after")) > 0);
  }, { userDailySpendLimit: 10 });
});

test("no cap configured refuses no dispatch, whatever the account has spent", async () => {
  await withAuthApp(async ({ app, base }) => {
    const loggedIn = await login(base);
    const usageFile = path.join(app.config.dataDir, ".openscience", "usage.jsonl");
    await mkdir(path.dirname(usageFile), { recursive: true });
    await writeFile(
      usageFile,
      `${JSON.stringify({ at: new Date().toISOString(), resourceType: "model", userId: "alice", projectId: "default", model: "deepseek-v4-pro", cacheHit: 0, cacheMiss: 1, output: 1, cost: 10_000, currency: "CNY", priced: true })}\n`,
      "utf8",
    );

    const response = await fetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: {
        Cookie: loggedIn.cookie,
        "Content-Type": "application/json",
        "X-Open-Science-CSRF": loggedIn.csrfToken,
      },
      body: JSON.stringify({ sessionId: "ses-1", dispatchId: "turn-1", text: "analyze this" }),
    });
    // Whatever else this deployment says about the dispatch, it is not a
    // refusal about money.
    assert.notEqual(response.status, 402);
  });
});

test("self-registration is off unless the deployment turns it on", async () => {
  await withAuthApp(async ({ base }) => {
    const methods = await (await fetch(`${base}/api/auth/methods`)).json();
    assert.deepEqual(methods.data, { mode: "local", selfRegistration: false });

    const refused = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "correct horse battery staple" }),
    });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, "self_registration_disabled");
  });
});

test("registering creates the account, signs it in, and gives it its own space", async () => {
  await withAuthApp(async ({ base }) => {
    // The login page asks before it offers the form: a register link that 403s
    // is worse than no link.
    const methods = await (await fetch(`${base}/api/auth/methods`)).json();
    assert.deepEqual(methods.data, { mode: "local", selfRegistration: true });

    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "another correct horse", name: "Bob" }),
    });
    assert.equal(registered.status, 201);
    const cookie = String(registered.headers.get("set-cookie") ?? "").split(";")[0];
    assert.ok(cookie.startsWith("os_session="), "registration signs the new account in");

    // Its own tenant, and a project nobody else can see.
    const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json();
    assert.equal(me.data.user.id, "bob");
    assert.equal(me.data.tenant.id, "bob");
    assert.equal(me.data.project.id, "default");

    // The name is taken now, and says so rather than overwriting the account.
    const again = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "yet another horse" }),
    });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, "user_exists");
  }, { selfRegistrationEnabled: true });
});

test("registration refuses a weak password and a name the store cannot hold", async () => {
  await withAuthApp(async ({ base }) => {
    const weak = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "short" }),
    });
    assert.equal(weak.status, 400);
    assert.equal((await weak.json()).code, "weak_password");

    // `safeId` is what keeps a username from becoming a path segment.
    const unsafe = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "../root", password: "correct horse battery staple" }),
    });
    assert.equal(unsafe.status, 400);
  }, { selfRegistrationEnabled: true });
});

test("registration is closed under OIDC, where the provider owns the account", async () => {
  await withAuthApp(async ({ base }) => {
    const refused = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dave", password: "correct horse battery staple" }),
    });
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).code, "auth_method_disabled");
  }, {
    selfRegistrationEnabled: true,
    authMode: "oidc",
    oidcIssuer: "https://issuer.example",
    oidcClientId: "evimed",
    oidcClientSecret: "secret",
    publicUrl: "https://science.example",
  });
});

test("production auth ignores malformed cookie values without internal errors", async () => {
  await withAuthApp(async ({ base }) => {
    let res = await fetch(`${base}/api/me`, {
      headers: { Cookie: "os_session=%E0%A4%A" },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "unauthorized");

    const loggedIn = await login(base);
    res = await fetch(`${base}/api/me`, {
      headers: { Cookie: `${loggedIn.cookie}; broken=%E0%A4%A` },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.user.id, "alice");
  });
});

test("production user state file rejects symbolic links", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-users-state-symlink-"));
  const outsideUsersFile = path.join(dataDir, "outside-users.json");
  await writeFile(outsideUsersFile, "{\"users\":[]}\n", "utf8");
  await symlink(outsideUsersFile, path.join(dataDir, "users.json"));

  let running = null;
  try {
    running = await startAppWithDataDir(dataDir, {
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
    });
    const loggedIn = await login(running.base);
    assert.equal(loggedIn.res.status, 403);
    assert.equal(loggedIn.json.code, "path_forbidden");
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("production session state file rejects symbolic links", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-sessions-state-symlink-"));
  const stateDir = path.join(dataDir, ".openscience");
  const outsideSessionsFile = path.join(dataDir, "outside-sessions.json");
  await mkdir(stateDir, { recursive: true });
  await writeFile(outsideSessionsFile, "{\"version\":1,\"sessions\":[]}\n", "utf8");
  await symlink(outsideSessionsFile, path.join(stateDir, "sessions.json"));

  let running = null;
  try {
    running = await startAppWithDataDir(dataDir, {
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
    });
    const loggedIn = await login(running.base);
    assert.equal(loggedIn.res.status, 403);
    assert.equal(loggedIn.json.code, "path_forbidden");
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("production sessions persist across server restarts without storing raw cookies", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-sessions-"));
  let running = null;
  try {
    running = await startAppWithDataDir(dataDir, {
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
    });
    const loggedIn = await login(running.base);
    assert.equal(loggedIn.res.status, 200);
    const sessionCookieValue = loggedIn.cookie.split("=").slice(1).join("=");
    const sessionFile = running.app.config.sessionsFile;
    const stored = await readFile(sessionFile, "utf8");
    assert.equal(stored.includes(sessionCookieValue), false);
    assert.match(stored, /"idHash":\s*"[a-f0-9]{64}"/);
    await running.app.close();
    running = null;

    running = await startAppWithDataDir(dataDir, { devAuth: false });
    const me = await fetch(`${running.base}/api/me`, { headers: { Cookie: loggedIn.cookie } });
    assert.equal(me.status, 200);
    const body = (await me.json()).data;
    assert.equal(body.user.id, "alice");
    assert.equal(body.csrfToken, loggedIn.csrfToken);

    const created = await fetch(`${running.base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...loggedIn.auth },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("concurrent production logins persist every session across a restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-concurrent-sessions-"));
  let running = null;
  try {
    running = await startAppWithDataDir(dataDir, {
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
    });
    const sessions = await Promise.all([login(running.base), login(running.base)]);
    assert.ok(sessions.every(({ res }) => res.status === 200));
    assert.notEqual(sessions[0].cookie, sessions[1].cookie);
    const stored = JSON.parse(await readFile(running.app.config.sessionsFile, "utf8"));
    assert.equal(stored.sessions.length, 2);

    await running.app.close();
    running = await startAppWithDataDir(dataDir, { devAuth: false });
    const restored = await Promise.all(
      sessions.map(({ cookie }) => fetch(`${running.base}/api/me`, { headers: { Cookie: cookie } })),
    );
    assert.ok(restored.every(({ status }) => status === 200));
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("production sessions use configured TTL and expire server-side", async () => {
  await withAuthApp(
    async ({ app, base }) => {
      const loggedIn = await login(base);
      assert.equal(loggedIn.res.status, 200);
      assert.match(loggedIn.setCookie, /;\s*Max-Age=1\b/);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const me = await fetch(`${base}/api/me`, { headers: { Cookie: loggedIn.cookie } });
      assert.equal(me.status, 401);
      assert.equal((await me.json()).code, "unauthorized");

      const sessionFile = await readFile(app.config.sessionsFile, "utf8");
      assert.equal(JSON.parse(sessionFile).sessions.length, 0);
    },
    { sessionTtlMs: 20 },
  );
});

test("production logout revokes persisted sessions across restarts", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-session-logout-"));
  let running = null;
  try {
    running = await startAppWithDataDir(dataDir, {
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
    });
    const loggedIn = await login(running.base);
    const logout = await fetch(`${running.base}/api/auth/logout`, {
      method: "POST",
      headers: loggedIn.auth,
    });
    assert.equal(logout.status, 200);

    let me = await fetch(`${running.base}/api/me`, { headers: { Cookie: loggedIn.cookie } });
    assert.equal(me.status, 401);
    await running.app.close();
    running = null;

    running = await startAppWithDataDir(dataDir, { devAuth: false });
    me = await fetch(`${running.base}/api/me`, { headers: { Cookie: loggedIn.cookie } });
    assert.equal(me.status, 401);
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("production auth requires CSRF tokens for cookie-backed writes", async () => {
  await withAuthApp(async ({ base }) => {
    const loggedIn = await login(base);

    const missing = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: loggedIn.cookie },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).code, "csrf_required");

    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...loggedIn.auth },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);
  });
});

test("login cookies are secure when the configured public URL is HTTPS", async () => {
  await withAuthApp(
    async ({ base }) => {
      const loggedIn = await login(base);
      assert.equal(loggedIn.res.status, 200);
      assert.match(loggedIn.setCookie, /;\s*Secure\b/);
    },
    { publicUrl: "https://science.example.com" },
  );
});

test("cors preflight allows the hosted project header", async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/commands/list_dir`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-open-science-project,x-open-science-csrf",
      },
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /X-Open-Science-Project/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /X-Open-Science-CSRF/);
  });
});

test("production cors does not reflect unconfigured origins for session APIs", async () => {
  await withAuthApp(
    async ({ base }) => {
      const loggedIn = await login(base);
      const me = await fetch(`${base}/api/me`, {
        headers: {
          Cookie: loggedIn.cookie,
          Origin: "https://evil.example",
        },
      });

      assert.equal(me.status, 200);
      assert.equal(me.headers.get("access-control-allow-origin"), null);
      assert.equal(me.headers.get("access-control-allow-credentials"), null);
    },
    { production: true, publicUrl: "https://science.example.com" },
  );
});

test("production cors allows public and explicitly configured origins", async () => {
  await withAuthApp(
    async ({ base }) => {
      let res = await fetch(`${base}/api/commands/list_dir`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://science.example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-open-science-project,x-open-science-csrf",
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), "https://science.example.com");
      assert.equal(res.headers.get("access-control-allow-credentials"), "true");

      res = await fetch(`${base}/api/commands/list_dir`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-open-science-project,x-open-science-csrf",
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example.com");
      assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    },
    {
      production: true,
      publicUrl: "https://science.example.com",
      corsOrigins: ["https://app.example.com"],
    },
  );
});

test("projects isolate workspace files for the same user", async () => {
  await withAuthApp(async ({ base }) => {
    const { auth } = await login(base);

    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);

    const alpha = { ...auth, "X-Open-Science-Project": "paper1" };
    let out = await commandWithHeaders(base, "write_workspace_file", {
      path: "report.md",
      content: "paper project",
    }, alpha);
    assert.equal(out.res.status, 200);

    out = await commandWithHeaders(base, "list_dir", {}, alpha);
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data.map((entry) => entry.name), ["report.md"]);

    out = await commandWithHeaders(base, "list_dir", {}, auth);
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data.map((entry) => entry.name), []);
  });
});

test("hosted example installation copies the real bundled dataset without overwriting edits", async () => {
  await withApp(async ({ base }) => {
    let out = await command(base, "install_example", { name: "climate-trends" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "climate-trends");

    out = await command(base, "read_artifact", { path: "climate-trends/README.md" });
    assert.equal(out.res.status, 200);
    assert.match(out.json.data.data, /NASA GISS Surface Temperature Analysis/);
    assert.doesNotMatch(out.json.data.data, /Server-side example placeholder/);

    out = await command(base, "read_artifact", {
      path: "climate-trends/data/gistemp_global_means.csv",
    });
    assert.equal(out.res.status, 200);
    assert.match(out.json.data.data, /^Land-Ocean: Global Means\nYear,Jan,Feb/m);

    out = await command(base, "write_workspace_file", {
      path: "climate-trends/README.md",
      content: "user edited",
    });
    assert.equal(out.res.status, 200);
    out = await command(base, "install_example", { name: "climate-trends" });
    assert.equal(out.res.status, 200);
    out = await command(base, "read_artifact", { path: "climate-trends/README.md" });
    assert.equal(out.json.data.data, "user edited");

    out = await command(base, "install_example", { name: "unknown-example" });
    assert.equal(out.res.status, 404);
    assert.equal(out.json.code, "example_not_found");
  });
});

test("hosted example installation obeys the project storage quota", async () => {
  await withQuotaApp(async ({ base }) => {
    const out = await command(base, "install_example", { name: "climate-trends" });
    assert.equal(out.res.status, 413);
    assert.equal(out.json.code, "project_quota_exceeded");
  });
});

test("non-default projects must be created before use", async () => {
  await withAuthApp(async ({ base }) => {
    const { auth } = await login(base);
    const headers = { ...auth, "X-Open-Science-Project": "ghost" };

    let out = await commandWithHeaders(base, "list_dir", {}, headers);
    assert.equal(out.res.status, 404);
    assert.equal(out.json.code, "project_not_found");

    const proxied = await fetch(`${base}/api/runtime/sessions`, { method: "POST", headers, body: "{}" });
    assert.equal(proxied.status, 404);
    assert.equal((await proxied.json()).code, "project_not_found");

    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ id: "ghost", name: "Ghost Project" }),
    });
    assert.equal(created.status, 200);

    out = await commandWithHeaders(base, "list_dir", {}, headers);
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data, []);
  });
});

test("write APIs validate the selected project before reading large bodies", async () => {
  await withAuthApp(
    async ({ base }) => {
      const { auth } = await login(base);
      const ghost = { ...auth, "X-Open-Science-Project": "ghost" };
      const largeData = "x".repeat(9_000);

      let res = await fetch(`${base}/api/commands/upload_file`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ghost },
        body: JSON.stringify({
          filename: "large-command.bin",
          data: largeData,
        }),
      });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, "project_not_found");

      res = await fetch(`${base}/api/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ghost },
        body: JSON.stringify({
          filename: "large-direct.bin",
          data: largeData,
        }),
      });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, "project_not_found");

      res = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ghost },
        body: JSON.stringify({
          command: "upload_file",
          args: {
            filename: "large-task.bin",
            data: largeData,
          },
        }),
      });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, "project_not_found");
    },
    { maxJsonBytes: 512, maxFileBytes: 64 },
  );
});

test("project export returns a scoped archive without host paths", async () => {
  await withAuthApp(async ({ app, base }) => {
    const { auth } = await login(base);
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);

    const projectHeaders = { ...auth, "X-Open-Science-Project": "paper1" };
    const written = await commandWithHeaders(base, "write_workspace_file", {
      path: "report.md",
      content: "paper project",
    }, projectHeaders);
    assert.equal(written.res.status, 200);

    const exported = await fetch(`${base}/api/projects/paper1/export`, { headers: auth });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") ?? "", /application\/gzip/);
    assert.match(exported.headers.get("content-disposition") ?? "", /evimed-project-paper1\.tar\.gz/);

    const archive = gunzipSync(Buffer.from(await exported.arrayBuffer()));
    const names = tarEntryNames(archive);
    assert.ok(names.includes("project.json"));
    assert.ok(names.includes("workspace/report.md"));
    assert.equal(names.some((name) => name.includes(app.config.dataDir)), false);
    assert.equal(archive.toString("utf8").includes(app.config.dataDir), false);
  });
});

test("account export returns only the current user's scoped projects", async () => {
  await withAuthApp(async ({ app, base }) => {
    const alice = await login(base);
    await app.store.createUser("bob", "another correct password", "Bob");
    const bob = await login(base, "bob", "another correct password");

    let out = await commandWithHeaders(base, "write_workspace_file", {
      path: "alice.md",
      content: "alice default",
    }, alice.auth);
    assert.equal(out.res.status, 200);

    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...alice.auth },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);
    out = await commandWithHeaders(base, "write_workspace_file", {
      path: "report.md",
      content: "paper project",
    }, { ...alice.auth, "X-Open-Science-Project": "paper1" });
    assert.equal(out.res.status, 200);

    out = await commandWithHeaders(base, "write_workspace_file", {
      path: "bob-only.md",
      content: "bob project",
    }, bob.auth);
    assert.equal(out.res.status, 200);

    const exported = await fetch(`${base}/api/account/export`, { headers: alice.auth });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") ?? "", /application\/gzip/);
    assert.match(exported.headers.get("content-disposition") ?? "", /evimed-account-alice\.tar\.gz/);

    const archive = gunzipSync(Buffer.from(await exported.arrayBuffer()));
    const entries = tarEntries(archive);
    const names = [...entries.keys()];
    assert.ok(names.includes("account.json"));
    assert.ok(names.includes("projects/default/project.json"));
    assert.ok(names.includes("projects/default/workspace/alice.md"));
    assert.ok(names.includes("projects/paper1/workspace/report.md"));
    assert.equal(names.some((name) => name.includes("bob")), false);
    assert.equal(archive.toString("utf8").includes("bob-only"), false);
    assert.equal(archive.toString("utf8").includes(app.config.dataDir), false);

    const account = JSON.parse(entries.get("account.json").toString("utf8"));
    assert.equal(account.user.id, "alice");
    assert.deepEqual(
      account.projects.map((project) => project.id).sort(),
      ["default", "paper1"],
    );
    const accountJson = JSON.stringify(account);
    assert.equal(accountJson.includes("passwordHash"), false);
    assert.equal(accountJson.includes("csrf"), false);
    assert.equal(accountJson.includes("sess_"), false);
  });
});

test("project and account exports enforce archive entry limits", async () => {
  await withAuthApp(
    async ({ base }) => {
      const { auth } = await login(base);
      const created = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
      });
      assert.equal(created.status, 200);

      const written = await commandWithHeaders(base, "write_workspace_file", {
        path: "report.md",
        content: "paper project",
      }, { ...auth, "X-Open-Science-Project": "paper1" });
      assert.equal(written.res.status, 200);

      let exported = await fetch(`${base}/api/projects/paper1/export`, { headers: auth });
      assert.equal(exported.status, 413);
      assert.equal((await exported.json()).code, "archive_too_large");

      exported = await fetch(`${base}/api/account/export`, { headers: auth });
      assert.equal(exported.status, 413);
      assert.equal((await exported.json()).code, "archive_too_large");
    },
    { maxArchiveEntries: 2 },
  );
});

test("project and account exports enforce archive byte limits", async () => {
  await withAuthApp(
    async ({ base }) => {
      const { auth } = await login(base);
      const created = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
      });
      assert.equal(created.status, 200);

      let exported = await fetch(`${base}/api/projects/paper1/export`, { headers: auth });
      assert.equal(exported.status, 413);
      assert.equal((await exported.json()).code, "archive_too_large");

      exported = await fetch(`${base}/api/account/export`, { headers: auth });
      assert.equal(exported.status, 413);
      assert.equal((await exported.json()).code, "archive_too_large");
    },
    { maxArchiveBytes: 1 },
  );
});

test("project deletion requires confirmation, protects default, and removes project data", async () => {
  await withAuthApp(async ({ base }) => {
    const { auth } = await login(base);
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);

    const projectHeaders = { ...auth, "X-Open-Science-Project": "paper1" };
    let out = await commandWithHeaders(base, "write_workspace_file", {
      path: "report.md",
      content: "paper project",
    }, projectHeaders);
    assert.equal(out.res.status, 200);

    let deleted = await fetch(`${base}/api/projects/default`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ confirm: "default" }),
    });
    assert.equal(deleted.status, 400);
    assert.equal((await deleted.json()).code, "default_project_protected");

    deleted = await fetch(`${base}/api/projects/paper1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ confirm: "wrong" }),
    });
    assert.equal(deleted.status, 400);
    assert.equal((await deleted.json()).code, "delete_confirmation_required");

    deleted = await fetch(`${base}/api/projects/paper1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ confirm: "paper1" }),
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).data.id, "paper1");

    const projects = await fetch(`${base}/api/projects`, { headers: auth });
    assert.equal(projects.status, 200);
    assert.equal((await projects.json()).data.some((project) => project.id === "paper1"), false);

    out = await commandWithHeaders(base, "list_dir", {}, projectHeaders);
    assert.equal(out.res.status, 404);
    assert.equal(out.json.code, "project_not_found");
  });
});

test("account deletion requires confirmation and password, stops runtimes, and removes account data", async () => {
  await withAuthApp(async ({ app, base }) => {
    const loggedIn = await login(base);
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...loggedIn.auth },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);
    let out = await commandWithHeaders(base, "write_workspace_file", {
      path: "report.md",
      content: "paper project",
    }, { ...loggedIn.auth, "X-Open-Science-Project": "paper1" });
    assert.equal(out.res.status, 200);

    out = await commandWithHeaders(base, "start_runtime", {}, loggedIn.auth);
    assert.equal(out.res.status, 200);
    assert.equal(app.runtimeManager.statsAll().running, 1);

    let deleted = await fetch(`${base}/api/account`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...loggedIn.auth },
      body: JSON.stringify({ confirm: "wrong", password: "correct horse battery staple" }),
    });
    assert.equal(deleted.status, 400);
    assert.equal((await deleted.json()).code, "account_delete_confirmation_required");

    deleted = await fetch(`${base}/api/account`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...loggedIn.auth },
      body: JSON.stringify({ confirm: "alice", password: "wrong password" }),
    });
    assert.equal(deleted.status, 403);
    assert.equal((await deleted.json()).code, "invalid_password");

    deleted = await fetch(`${base}/api/account`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...loggedIn.auth },
      body: JSON.stringify({ confirm: "alice", password: "correct horse battery staple" }),
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).data.id, "alice");
    assert.equal(app.runtimeManager.statsAll().running, 0);

    await assert.rejects(
      () => readFile(path.join(app.config.dataDir, "users", "alice", "projects", "paper1", "workspace", "report.md"), "utf8"),
      (err) => err?.code === "ENOENT",
    );

    const me = await fetch(`${base}/api/me`, { headers: loggedIn.auth });
    assert.equal(me.status, 401);
    assert.equal((await me.json()).code, "unauthorized");

    const relogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        password: "correct horse battery staple",
      }),
    });
    assert.equal(relogin.status, 401);
    assert.equal((await relogin.json()).code, "invalid_credentials");
  });
});

test("deleted bootstrap accounts are not recreated after server restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-account-delete-"));
  let running = null;
  try {
    running = await startAppWithDataDir(dataDir, {
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
    });
    const loggedIn = await login(running.base);
    const deleted = await fetch(`${running.base}/api/account`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...loggedIn.auth },
      body: JSON.stringify({ confirm: "alice", password: "correct horse battery staple" }),
    });
    assert.equal(deleted.status, 200);
    await running.app.close();
    running = null;

    running = await startAppWithDataDir(dataDir, {
      devAuth: false,
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
    });
    const ready = await fetch(`${running.base}/api/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).data.checks.auth.code, "no_login_users");

    const relogin = await fetch(`${running.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        password: "correct horse battery staple",
      }),
    });
    assert.equal(relogin.status, 401);
    assert.equal((await relogin.json()).code, "invalid_credentials");
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("project deletion rejects projects with active tasks", async () => {
  await withPausedTaskApp(async ({ base }) => {
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);

    const task = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Open-Science-Project": "paper1" },
      body: JSON.stringify({
        command: "write_workspace_file",
        args: { path: "queued.md", content: "queued" },
      }),
    });
    assert.equal(task.status, 202);
    assert.equal((await task.json()).data.status, "queued");

    const deleted = await fetch(`${base}/api/projects/paper1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "paper1" }),
    });
    assert.equal(deleted.status, 409);
    assert.equal((await deleted.json()).code, "project_busy");
  });
});

test("account deletion rejects accounts with active tasks", async () => {
  await withPausedTaskApp(async ({ base }) => {
    const task = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "write_workspace_file",
        args: { path: "queued.md", content: "queued" },
      }),
    });
    assert.equal(task.status, 202);
    assert.equal((await task.json()).data.status, "queued");

    const deleted = await fetch(`${base}/api/account`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "dev" }),
    });
    assert.equal(deleted.status, 409);
    assert.equal((await deleted.json()).code, "account_busy");
  });
});

test("user roots reject symbolic links", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-user-symlink-"));
  const usersRoot = path.join(dataDir, "users");
  const outsideUser = path.join(dataDir, "outside-user");
  await mkdir(usersRoot, { recursive: true });
  await mkdir(outsideUser, { recursive: true });
  await symlink(outsideUser, path.join(usersRoot, "dev"));

  let running = null;
  try {
    running = await startAppWithDataDir(dataDir);
    const me = await fetch(`${running.base}/api/me`);
    assert.equal(me.status, 403);
    assert.equal((await me.json()).code, "path_forbidden");
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("per-user project containers reject symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const outsideProjects = path.join(app.config.dataDir, "outside-projects");
    await mkdir(outsideProjects, { recursive: true });
    await symlink(outsideProjects, path.join(user.rootDir, "projects"));

    const listed = await fetch(`${base}/api/projects`);
    assert.equal(listed.status, 403);
    assert.equal((await listed.json()).code, "path_forbidden");

    const out = await command(base, "list_dir");
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
  });
});

test("project roots reject symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const projectsRoot = path.join(user.rootDir, "projects");
    await mkdir(projectsRoot, { recursive: true });
    const outsideProject = path.join(app.config.dataDir, "outside-project");
    await mkdir(outsideProject, { recursive: true });
    await symlink(outsideProject, path.join(projectsRoot, "escape"));

    const out = await commandWithHeaders(base, "list_dir", {}, { "X-Open-Science-Project": "escape" });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");

    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "escape", name: "Escape" }),
    });
    assert.equal(created.status, 403);
    assert.equal((await created.json()).code, "path_forbidden");

    const proxied = await fetch(`${base}/api/runtime/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Open-Science-Project": "escape" },
      body: "{}",
    });
    assert.equal(proxied.status, 403);
    assert.equal((await proxied.json()).code, "path_forbidden");
  });
});

test("cached project roots are revalidated before reuse", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const outsideProject = path.join(app.config.dataDir, "outside-cached-project");
    await mkdir(outsideProject, { recursive: true });
    await rm(project.rootDir, { recursive: true, force: true });
    await symlink(outsideProject, project.rootDir);

    const out = await command(base, "list_dir");
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
  });
});

test("project metadata files reject symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const outsideMeta = path.join(app.config.dataDir, "outside-project.json");
    const metaFile = path.join(project.rootDir, "project.json");
    await writeFile(outsideMeta, "{\"id\":\"default\"}\n", "utf8");
    await rm(metaFile, { force: true });
    await symlink(outsideMeta, metaFile);

    const out = await command(base, "list_dir");
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
  });
});

test("project jsonl logs reject symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const outsideAudit = path.join(app.config.dataDir, "outside-audit.jsonl");
    const auditFile = path.join(project.metaDir, "audit.jsonl");
    await writeFile(outsideAudit, "{\"outside\":true}\n", "utf8");
    await symlink(outsideAudit, auditFile);

    const out = await command(base, "list_dir");
    assert.equal(out.res.status, 200);
    assert.equal(await readFile(outsideAudit, "utf8"), "{\"outside\":true}\n");

    const logs = await fetch(`${base}/api/logs/audit`);
    assert.equal(logs.status, 403);
    assert.equal((await logs.json()).code, "path_forbidden");
  });
});

test("provenance files reject symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const outsideProvenance = path.join(app.config.dataDir, "outside-provenance.jsonl");
    const provenanceFile = path.join(project.metaDir, "provenance.jsonl");
    await writeFile(outsideProvenance, "{\"outside\":true}\n", "utf8");
    await symlink(outsideProvenance, provenanceFile);

    let out = await command(base, "record_provenance", {
      path: "artifact.md",
      tool: "test",
    });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
    assert.equal(await readFile(outsideProvenance, "utf8"), "{\"outside\":true}\n");

    out = await command(base, "list_provenance", { path: "artifact.md" });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
  });
});

test("provenance records are scoped, versioned, capped, and rotated", async () => {
  await withApp(
    async ({ app, base }) => {
      let out = await command(base, "record_provenance", {
        path: "fig/plot.py",
        tool: "write",
        content: "x".repeat(110 * 1024),
        log: "Generated the plot",
        sessionId: "ses_1",
        callId: "call_plot_1",
        model: "mock/model",
      });
      assert.equal(out.res.status, 200);

      out = await command(base, "record_provenance", {
        path: "fig/plot.py",
        tool: "edit",
        content: "print(2)",
        log: "Updated the plot",
        sessionId: "ses_1",
        callId: "call_plot_2",
      });
      assert.equal(out.res.status, 200);

      out = await command(base, "list_provenance", { path: "fig/plot.py" });
      assert.equal(out.res.status, 200);
      const records = out.json.data;
      assert.equal(records.length, 2);
      assert.deepEqual(records.map((record) => record.version), [1, 2]);
      assert.equal(records[0].path, "fig/plot.py");
      assert.equal(records[0].tool, "write");
      assert.equal(records[0].log, "Generated the plot");
      assert.equal(records[0].sessionId, "ses_1");
      assert.equal(records[0].callId, "call_plot_1");
      assert.equal(records[0].model, "mock/model");
      assert.equal(Number.isInteger(records[0].ts), true);
      assert.equal(records[0].content.endsWith("[truncated]"), true);
      assert.ok(Buffer.byteLength(records[0].content, "utf8") <= 100 * 1024);
      assert.equal(records[1].tool, "edit");
      assert.equal(records[1].content, "print(2)");

      const user = await app.store.devUser();
      const project = await app.store.defaultProject(user);
      const absoluteArtifact = path.join(project.workspaceDir, "fig", "absolute.md");
      out = await command(base, "record_provenance", {
        path: absoluteArtifact,
        tool: "write",
        content: "absolute runtime path",
        log: `write → ${absoluteArtifact}`,
        sessionId: "ses_absolute",
        callId: "call_absolute",
      });
      assert.equal(out.res.status, 200);
      const duplicateRequests = await Promise.all([
        command(base, "record_provenance", {
          path: absoluteArtifact,
          tool: "write",
          content: "absolute runtime path",
          sessionId: "ses_absolute",
          callId: "call_absolute",
        }),
        command(base, "record_provenance", {
          path: absoluteArtifact,
          tool: "write",
          content: "absolute runtime path",
          sessionId: "ses_absolute",
          callId: "call_absolute",
        }),
      ]);
      assert.deepEqual(duplicateRequests.map((item) => item.res.status), [200, 200]);
      out = await command(base, "record_provenance", {
        path: absoluteArtifact,
        tool: "write",
        content: "absolute runtime path",
        sessionId: "ses_absolute",
      });
      assert.equal(out.res.status, 200);
      out = await command(base, "list_provenance", { path: absoluteArtifact });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data.length, 1);
      assert.equal(out.json.data[0].path, "fig/absolute.md");
      assert.equal(out.json.data[0].log, "write → fig/absolute.md");

      await readFile(path.join(project.metaDir, "provenance.jsonl.1"), "utf8");

      out = await command(base, "record_provenance", {
        path: "notes/unicode.md",
        tool: "write",
        content: "汉".repeat(40 * 1024),
      });
      assert.equal(out.res.status, 200);

      out = await command(base, "list_provenance", { path: "notes/unicode.md" });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data[0].content.endsWith("[truncated]"), true);
      assert.ok(Buffer.byteLength(out.json.data[0].content, "utf8") <= 100 * 1024);
      assert.equal(out.json.data[0].content.includes("\uFFFD"), false);

      out = await command(base, "record_provenance", {
        path: "../escape.md",
        tool: "write",
        content: "escape",
      });
      assert.equal(out.res.status, 403);
      assert.equal(out.json.code, "path_forbidden");

      out = await command(base, "list_provenance", { path: "/etc/passwd" });
      assert.equal(out.res.status, 400);
      assert.equal(out.json.code, "invalid_path");
    },
    { maxLogFileBytes: 800 },
  );
});

test("environment lockfile metadata rejects symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const envDir = path.join(project.metaDir, "env");
    const outsideLockfile = path.join(app.config.dataDir, "outside-lockfile.txt");
    await mkdir(envDir, { recursive: true });
    await writeFile(outsideLockfile, "outside", "utf8");
    await symlink(outsideLockfile, path.join(envDir, "abc123.txt"));

    const out = await command(base, "read_env_lockfile", { hash: "abc123" });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
  });
});

test("base-scoped file APIs stay inside the selected project", async () => {
  await withAuthApp(async ({ base }) => {
    const { auth } = await login(base);
    for (const id of ["paper1", "paper2"]) {
      const created = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ id, name: id }),
      });
      assert.equal(created.status, 200);
    }

    const paper2 = { ...auth, "X-Open-Science-Project": "paper2" };
    let out = await commandWithHeaders(base, "write_workspace_file", {
      root: "base",
      path: "paper2-only.md",
      content: "paper 2 data",
    }, paper2);
    assert.equal(out.res.status, 200);

    out = await commandWithHeaders(base, "upload_file", {
      root: "base",
      filename: "uploads/from-command.bin",
      encoding: "base64",
      data: Buffer.from("command upload").toString("base64"),
    }, paper2);
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "uploads/from-command.bin");

    const directUpload = await fetch(`${base}/api/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...paper2 },
      body: JSON.stringify({
        root: "base",
        filename: "uploads/from-api.txt",
        data: "api upload",
      }),
    });
    assert.equal(directUpload.status, 200);
    assert.equal((await directUpload.json()).data.path, "uploads/from-api.txt");

    out = await commandWithHeaders(base, "read_artifact", {
      root: "base",
      path: "uploads/from-command.bin",
    }, paper2);
    assert.equal(out.res.status, 200);
    assert.equal(Buffer.from(out.json.data.data, "base64").toString("utf8"), "command upload");

    const paper1 = { ...auth, "X-Open-Science-Project": "paper1" };
    out = await commandWithHeaders(base, "list_dir", { root: "base" }, paper1);
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data.map((entry) => entry.name), []);

    out = await commandWithHeaders(base, "read_artifact", {
      root: "base",
      path: "../paper2/workspace/paper2-only.md",
    }, paper1);
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
  });
});

test("async tasks can run command API work and expose status", async () => {
  await withApp(async ({ base }) => {
    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "write_workspace_file",
        args: { path: "task-output.md", content: "from task" },
      }),
    });
    assert.equal(created.status, 202);
    const task = (await created.json()).data;
    assert.match(task.id, /^task_/);

    const finished = await waitForTask(base, task.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(Object.hasOwn(finished, "result"), false);
    assert.equal(JSON.stringify(finished).includes("from task"), false);

    const read = await command(base, "read_artifact", { path: "task-output.md" });
    assert.equal(read.json.data.data, "from task");

    const list = await fetch(`${base}/api/tasks`);
    assert.equal(list.status, 200);
    assert.ok((await list.json()).data.some((item) => item.id === task.id));
  });
});

test("async task API rejects runtime lifecycle commands", async () => {
  await withApp(async ({ base }) => {
    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "start_runtime",
        args: {},
      }),
    });
    assert.equal(created.status, 403);
    const body = await created.json();
    assert.equal(body.code, "task_command_forbidden");
    assert.match(body.error, /cannot be queued/);

    const status = await command(base, "runtime_status");
    assert.equal(status.res.status, 200);
    assert.equal(status.json.data.running, false);
  });
});

test("async task APIs and logs do not expose command args or results", async () => {
  await withApp(async ({ app, base }) => {
    const secretPath = "private/task-secret.txt";
    const secret = "TASK_RESULT_SECRET_9fb8e7";
    const write = await command(base, "write_workspace_file", {
      path: secretPath,
      content: secret,
    });
    assert.equal(write.res.status, 200);

    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "read_artifact",
        args: { path: secretPath },
      }),
    });
    assert.equal(created.status, 202);
    const task = (await created.json()).data;

    const finished = await waitForTask(base, task.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(Object.hasOwn(finished, "result"), false);

    const detail = await fetch(`${base}/api/tasks/${task.id}`);
    assert.equal(detail.status, 200);
    const detailText = await detail.text();
    assert.equal(Object.hasOwn(JSON.parse(detailText).data, "result"), false);

    const list = await fetch(`${base}/api/tasks`);
    assert.equal(list.status, 200);
    const listText = await list.text();

    let taskLogsText = "";
    for (let i = 0; i < 10; i++) {
      const taskLogs = await fetch(`${base}/api/logs/tasks`);
      assert.equal(taskLogs.status, 200);
      taskLogsText = await taskLogs.text();
      if (taskLogsText.includes(task.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const stateText = await readFile(path.join(project.metaDir, "tasks-state.json"), "utf8");

    for (const surface of [detailText, listText, taskLogsText, stateText]) {
      assert.equal(surface.includes(secret), false);
      assert.equal(surface.includes(secretPath), false);
    }
  });
});

test("task state files reject symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const outsideState = path.join(app.config.dataDir, "outside-tasks-state.json");
    const stateFile = path.join(project.metaDir, "tasks-state.json");
    await writeFile(outsideState, "{\"version\":1,\"tasks\":[]}\n", "utf8");
    await symlink(outsideState, stateFile);

    const listed = await fetch(`${base}/api/tasks`);
    assert.equal(listed.status, 403);
    assert.equal((await listed.json()).code, "path_forbidden");

    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "list_dir", args: {} }),
    });
    assert.equal(created.status, 403);
    assert.equal((await created.json()).code, "path_forbidden");
    assert.equal(await readFile(outsideState, "utf8"), "{\"version\":1,\"tasks\":[]}\n");
  });
});

test("async task records persist across server restarts", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-tasks-state-"));
  let running = null;
  try {
    running = await startAppWithDataDir(dataDir);
    const created = await fetch(`${running.base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "write_workspace_file",
        args: { path: "persisted-task.md", content: "task state" },
      }),
    });
    assert.equal(created.status, 202);
    const task = (await created.json()).data;
    const finished = await waitForTask(running.base, task.id);
    assert.equal(finished.status, "succeeded");
    await running.app.close();
    running = null;

    running = await startAppWithDataDir(dataDir);
    const list = await fetch(`${running.base}/api/tasks`);
    assert.equal(list.status, 200);
    const persisted = (await list.json()).data.find((item) => item.id === task.id);
    assert.ok(persisted);
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.error, null);

    const fetched = await fetch(`${running.base}/api/tasks/${task.id}`);
    assert.equal(fetched.status, 200);
    const fetchedTask = (await fetched.json()).data;
    assert.equal(fetchedTask.status, "succeeded");
    assert.equal(Object.hasOwn(fetchedTask, "result"), false);
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("concurrent task state writes retain terminal status across restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-concurrent-task-state-"));
  let running = null;
  try {
    running = await startAppWithDataDir(dataDir, {
      maxConcurrentTasks: 8,
      maxConcurrentTasksPerProject: 8,
    });
    const responses = await Promise.all(
      Array.from({ length: 16 }, (_, index) => fetch(`${running.base}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "write_workspace_file",
          args: { path: `concurrent/task-${index}.txt`, content: `task ${index}` },
        }),
      })),
    );
    assert.equal(responses.every((response) => response.status === 202), true);
    const tasks = await Promise.all(responses.map(async (response) => (await response.json()).data));
    const finished = await Promise.all(tasks.map((task) => waitForTask(running.base, task.id)));
    assert.equal(finished.every((task) => task.status === "succeeded"), true);

    await running.app.close();
    running = null;
    running = await startAppWithDataDir(dataDir);
    const list = await fetch(`${running.base}/api/tasks`);
    assert.equal(list.status, 200);
    const persisted = new Map((await list.json()).data.map((task) => [task.id, task]));
    for (const task of tasks) {
      assert.equal(persisted.get(task.id)?.status, "succeeded");
      assert.equal(persisted.get(task.id)?.error, null);
    }
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("unfinished persisted async tasks are marked failed after restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-orphaned-task-"));
  const metaDir = path.join(dataDir, "users", "dev", "projects", "default", ".openscience");
  await mkdir(metaDir, { recursive: true });
  await writeFile(
    path.join(metaDir, "tasks-state.json"),
    `${JSON.stringify(
      {
        version: 1,
        tasks: [
          {
            id: "task_orphaned",
            command: "kernel_execute",
            status: "running",
            userId: "dev",
            projectId: "default",
            createdAt: "2026-01-01T00:00:00.000Z",
            queuedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:01.000Z",
            finishedAt: null,
            error: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  let running = null;
  try {
    running = await startAppWithDataDir(dataDir);
    const list = await fetch(`${running.base}/api/tasks`);
    assert.equal(list.status, 200);
    const recovered = (await list.json()).data.find((item) => item.id === "task_orphaned");
    assert.ok(recovered);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error.code, "server_restarted");
    assert.equal(typeof recovered.finishedAt, "string");

    const events = await fetch(`${running.base}/api/logs/tasks?limit=10`);
    assert.equal(events.status, 200);
    const rows = (await events.json()).data;
    assert.ok(rows.some((row) => row.taskId === "task_orphaned" && row.event === "server_restarted"));

    const metrics = await fetch(`${running.base}/api/metrics`);
    assert.equal(metrics.status, 200);
    assert.equal((await metrics.json()).data.tasks.byStatus.failed, 1);
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("project storage quota is enforced for workspace writes and replacements", async () => {
  await withQuotaApp(async ({ base }) => {
    let out = await command(base, "write_workspace_file", {
      path: "quota.txt",
      content: "12345678",
    });
    assert.equal(out.res.status, 200);

    out = await command(base, "write_workspace_file", {
      path: "quota.txt",
      content: "1234",
    });
    assert.equal(out.res.status, 200);

    out = await command(base, "write_workspace_file", {
      path: "too-large.txt",
      content: "123456789",
    });
    assert.equal(out.res.status, 413);
    assert.equal(out.json.code, "project_quota_exceeded");

    const upload = await fetch(`${base}/api/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "upload.bin",
        encoding: "base64",
        data: Buffer.from("123456789").toString("base64"),
      }),
    });
    assert.equal(upload.status, 413);
    assert.equal((await upload.json()).code, "project_quota_exceeded");
  });
});

test("project storage quota serializes concurrent workspace writes", async () => {
  await withQuotaApp(async ({ base }) => {
    const results = await Promise.all([
      command(base, "write_workspace_file", {
        path: "concurrent-a.txt",
        content: "12345678",
      }),
      command(base, "write_workspace_file", {
        path: "concurrent-b.txt",
        content: "abcdefgh",
      }),
    ]);

    const statuses = results.map(({ res }) => res.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 413], JSON.stringify(results.map(({ res, json }) => ({ status: res.status, json }))));
    const rejected = results.find(({ res }) => res.status === 413);
    assert.equal(rejected.json.code, "project_quota_exceeded");

    const listed = await command(base, "list_dir", { root: "workspace", rel: "" });
    assert.equal(listed.res.status, 200);
    assert.equal(listed.json.data.length, 1);
    assert.equal(listed.json.data[0].size, 8);
  });
});

test("project usage scans are bounded for quota checks and metrics", async () => {
  await withApp(
    async ({ app, base }) => {
      const user = await app.store.devUser();
      const project = await app.store.defaultProject(user);
      await writeFile(path.join(project.workspaceDir, "a.txt"), "a", "utf8");
      await writeFile(path.join(project.workspaceDir, "b.txt"), "b", "utf8");
      await writeFile(path.join(project.workspaceDir, "c.txt"), "c", "utf8");

      const out = await command(base, "write_workspace_file", {
        path: "new.txt",
        content: "x",
      });
      assert.equal(out.res.status, 413);
      assert.equal(out.json.code, "project_scan_too_large");

      const metrics = await fetch(`${base}/api/metrics`);
      assert.equal(metrics.status, 200);
      const storage = (await metrics.json()).data.project.storage;
      assert.equal(storage.usedBytes, null);
      assert.equal(storage.scanLimited, true);
      assert.equal(storage.error, "project_scan_too_large");
    },
    { maxProjectBytes: 1024, maxProjectUsageScanEntries: 2 },
  );
});

test("runtime startup refuses projects that already exceed the storage quota", async () => {
  await withApp(
    async ({ app, base }) => {
      const user = await app.store.devUser();
      const project = await app.store.defaultProject(user);
      await writeFile(path.join(project.workspaceDir, "oversized-runtime-input.txt"), "123456789", "utf8");

      const started = await command(base, "start_runtime");
      assert.equal(started.res.status, 413);
      assert.equal(started.json.code, "project_quota_exceeded");

      const status = await command(base, "runtime_status");
      assert.equal(status.res.status, 200);
      assert.equal(status.json.data.running, false);
      assert.equal(status.json.data.lastEvent, "quota_exceeded");
      assert.equal(status.json.data.error, "project_quota_exceeded");
    },
    { maxProjectBytes: 8 },
  );
});

test("concurrent project-quota stops wait for the same terminal runtime state", async () => {
  await withApp(async ({ app }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const runtime = await app.runtimeManager.start(project);
    const originalClose = runtime.close;
    let releaseClose;
    const closeGate = new Promise((resolve) => {
      releaseClose = resolve;
    });
    runtime.close = async () => {
      await closeGate;
      await originalClose();
    };

    const firstStop = app.runtimeManager.stopQuotaExceededRuntime(project, { recordMissing: false });
    await new Promise((resolve) => setImmediate(resolve));
    let secondSettled = false;
    const secondStop = app.runtimeManager
      .stopQuotaExceededRuntime(project, { recordMissing: false })
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolve) => setImmediate(resolve));
    const settledBeforeCloseCompleted = secondSettled;
    releaseClose();
    const stopResults = await Promise.all([firstStop, secondStop]);
    assert.equal(settledBeforeCloseCompleted, false);
    assert.deepEqual(stopResults, [true, true]);
    const status = await app.runtimeManager.status(project);
    assert.equal(status.running, false);
    assert.equal(status.lastEvent, "quota_exceeded");
    assert.equal(status.error, "project_quota_exceeded");
  });
});

// Removed with the browser pass-through: "runtime proxy stops a project runtime
// after agent writes exceed the storage quota". What it uniquely tested was that
// the quota check rode on the proxy call, and there is no proxy call — a prompt
// reaches a kernel through the ledger, which writes the brief and the research
// context into the workspace first, so no ceiling can both admit a dispatch and
// be crossed by the run's own artifact. The guarantee itself is unchanged and is
// held by the two tests below, which measure the workspace rather than the
// caller: the monitor stops a runtime whose project goes over, whoever wrote it.

test("runtime quota monitor stops background writes that exceed the project quota", async () => {
  await withApp(
    async ({ app, base }) => {
      const started = await command(base, "start_runtime");
      assert.equal(started.res.status, 200);
      assert.equal(app.runtimeManager.statsAll().quota.monitored, 1);

      const user = await app.store.devUser();
      const project = await app.store.defaultProject(user);
      await writeFile(path.join(project.workspaceDir, "background-write.bin"), "123456789", "utf8");

      const status = await waitForRuntimeStatus(base, (data) =>
        data.running === false && data.lastEvent === "quota_exceeded" ? data : null,
      );
      assert.equal(status.error, "project_quota_exceeded");
      assert.equal(app.runtimeManager.statsAll().quota.monitored, 0);

      const row = await waitForRuntimeLogs(base, (rows) =>
        rows.find((item) => item.event === "quota_exceeded" && item.error === "project_quota_exceeded"),
      );
      assert.equal(row.maxProjectBytes, 8);
    },
    { maxProjectBytes: 8, runtimeQuotaCheckIntervalMs: 20, runtimeIdleTimeoutMs: 0 },
  );
});

test("runtime quota monitor fails closed when workspace usage cannot be scanned safely", async () => {
  await withApp(
    async ({ app, base }) => {
      const started = await command(base, "start_runtime");
      assert.equal(started.res.status, 200);

      const user = await app.store.devUser();
      const project = await app.store.defaultProject(user);
      await writeFile(path.join(project.workspaceDir, "first.txt"), "1", "utf8");
      await writeFile(path.join(project.workspaceDir, "second.txt"), "2", "utf8");

      const status = await waitForRuntimeStatus(base, (data) =>
        data.running === false && data.lastEvent === "quota_check_failed" ? data : null,
      );
      assert.equal(status.error, "project_scan_too_large");

      const row = await waitForRuntimeLogs(base, (rows) =>
        rows.find((item) => item.event === "quota_check_failed" && item.error === "project_scan_too_large"),
      );
      assert.equal(row.maxProjectBytes, 1024);
    },
    {
      maxProjectBytes: 1024,
      maxProjectUsageScanEntries: 1,
      runtimeQuotaCheckIntervalMs: 20,
      runtimeIdleTimeoutMs: 0,
    },
  );
});

test("project audit and task event logs are readable through scoped APIs", async () => {
  await withApp(async ({ base }) => {
    const write = await command(base, "write_workspace_file", {
      path: "logged.md",
      content: "logged",
    });
    assert.equal(write.res.status, 200);

    const audit = await fetch(`${base}/api/logs/audit?limit=10`);
    assert.equal(audit.status, 200);
    const auditRows = (await audit.json()).data;
    assert.ok(auditRows.some((row) => row.command === "write_workspace_file" && row.status === "completed"));

    const upload = await fetch(`${base}/api/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "uploaded.txt",
        encoding: "base64",
        data: Buffer.from("audit me").toString("base64"),
      }),
    });
    assert.equal(upload.status, 200);
    const preview = await fetch(`${base}/api/files/preview/uploaded.txt`);
    assert.equal(preview.status, 200);

    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "write_workspace_file",
        args: { path: "task-log.md", content: "task logged" },
      }),
    });
    assert.equal(created.status, 202);
    const task = (await created.json()).data;
    await waitForTask(base, task.id);

    const events = await fetch(`${base}/api/logs/tasks?limit=10`);
    assert.equal(events.status, 200);
    const rows = (await events.json()).data;
    assert.ok(rows.some((row) => row.taskId === task.id && row.event === "succeeded"));

    const expandedAudit = await fetch(`${base}/api/logs/audit?limit=20`);
    const expandedRows = (await expandedAudit.json()).data;
    assert.ok(expandedRows.some((row) => row.action === "file.upload" && row.target === "uploaded.txt"));
    assert.ok(expandedRows.some((row) => row.action === "file.preview" && row.target === "uploaded.txt"));
    assert.ok(expandedRows.some((row) => row.action === "task.create" && row.target === task.id));
  });
});

test("project log APIs read a bounded tail of large jsonl files", async () => {
  await withApp(
    async ({ app, base }) => {
      const user = await app.store.devUser();
      const project = await app.store.defaultProject(user);
      const rows = Array.from({ length: 40 }, (_, index) =>
        JSON.stringify({
          action: "log.tail",
          status: "completed",
          index,
          padding: "x".repeat(64),
        }),
      );
      await writeFile(path.join(project.metaDir, "audit.jsonl"), `${rows.join("\n")}\n`, "utf8");

      const res = await fetch(`${base}/api/logs/audit?limit=5`);
      assert.equal(res.status, 200);
      const data = (await res.json()).data;
      assert.deepEqual(data.map((row) => row.index), [39, 38, 37, 36, 35]);
      assert.equal(data.some((row) => row.index === 0), false);
    },
    { maxLogReadBytes: 1024 },
  );
});

test("project log APIs include the rotated jsonl tail", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    await writeFile(
      path.join(project.metaDir, "audit.jsonl.1"),
      [
        JSON.stringify({ action: "rotated", status: "completed", index: 1 }),
        JSON.stringify({ action: "rotated", status: "completed", index: 2 }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(project.metaDir, "audit.jsonl"),
      `${JSON.stringify({ action: "current", status: "completed", index: 3 })}\n`,
      "utf8",
    );

    const res = await fetch(`${base}/api/logs/audit?limit=3`);
    assert.equal(res.status, 200);
    const data = (await res.json()).data;
    assert.deepEqual(data.map((row) => row.index), [3, 2, 1]);
  });
});

test("project log APIs reject symlinked rotated jsonl files", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const outsideAudit = path.join(app.config.dataDir, "outside-rotated-audit.jsonl");
    const auditFile = path.join(project.metaDir, "audit.jsonl");
    await writeFile(auditFile, `${JSON.stringify({ action: "current", status: "completed" })}\n`, "utf8");
    await writeFile(outsideAudit, "{\"outside\":true}\n", "utf8");
    await symlink(outsideAudit, `${auditFile}.1`);

    const logs = await fetch(`${base}/api/logs/audit`);
    assert.equal(logs.status, 403);
    assert.equal((await logs.json()).code, "path_forbidden");
    assert.equal(await readFile(outsideAudit, "utf8"), "{\"outside\":true}\n");
  });
});

test("project operational logs rotate at the configured file size", async () => {
  await withApp(
    async ({ app, base }) => {
      for (let i = 0; i < 20; i += 1) {
        const out = await command(base, "list_dir", {});
        assert.equal(out.res.status, 200);
      }

      const user = await app.store.devUser();
      const project = await app.store.defaultProject(user);
      const current = await readFile(path.join(project.metaDir, "audit.jsonl"), "utf8");
      const rotated = await readFile(path.join(project.metaDir, "audit.jsonl.1"), "utf8");
      assert.equal(current.includes("command.list_dir"), true);
      assert.equal(rotated.includes("command.list_dir"), true);
      assert.ok(current.length < 1_200);
    },
    { maxLogFileBytes: 600 },
  );
});

test("file upload APIs accept scoped nested paths and reject traversal", async () => {
  await withApp(async ({ base }) => {
    const restUpload = await fetch(`${base}/api/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "inputs/raw/data.txt",
        encoding: "base64",
        data: Buffer.from("rest upload").toString("base64"),
      }),
    });
    assert.equal(restUpload.status, 200);
    assert.equal((await restUpload.json()).data.path, "inputs/raw/data.txt");

    let out = await command(base, "read_artifact", { path: "inputs/raw/data.txt" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.data, "rest upload");

    out = await command(base, "upload_file", {
      filename: "inputs/generated/result.bin",
      encoding: "base64",
      data: Buffer.from("command upload").toString("base64"),
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "inputs/generated/result.bin");

    out = await command(base, "read_artifact", { path: "inputs/generated/result.bin" });
    assert.equal(out.res.status, 200);
    assert.equal(Buffer.from(out.json.data.data, "base64").toString("utf8"), "command upload");

    const traversal = await fetch(`${base}/api/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "../escape.txt",
        encoding: "base64",
        data: Buffer.from("bad").toString("base64"),
      }),
    });
    assert.equal(traversal.status, 403);
    assert.equal((await traversal.json()).code, "path_forbidden");
  });
});

test("metrics report current project resource usage without filesystem paths", async () => {
  await withApp(async ({ base }) => {
    const write = await command(base, "write_workspace_file", {
      path: "metrics.txt",
      content: "metrics",
    });
    assert.equal(write.res.status, 200);

    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "write_workspace_file",
        args: { path: "metrics-task.txt", content: "done" },
      }),
    });
    assert.equal(created.status, 202);
    const task = (await created.json()).data;
    await waitForTask(base, task.id);

    const metrics = await fetch(`${base}/api/metrics`);
    assert.equal(metrics.status, 200);
    const body = (await metrics.json()).data;
    assert.equal(body.project.id, "default");
    assert.equal(body.project.storage.maxBytes, 1024 * 1024 * 1024);
    assert.ok(body.project.storage.usedBytes >= "metrics".length);
    assert.equal(body.tasks.total, 1);
    assert.equal(body.tasks.active, 0);
    assert.equal(body.tasks.queued, 0);
    assert.equal(body.tasks.byStatus.succeeded, 1);
    assert.equal(Object.hasOwn(body.tasks, "queuedGlobal"), false);
    assert.equal(body.runtime.running, false);
    assert.equal(typeof body.server.pid, "number");
    assert.equal(typeof body.server.memory.rssBytes, "number");
    assert.equal(JSON.stringify(body).includes("os-web-api-"), false);
  });
});

test("queued async tasks can be canceled before execution", async () => {
  await withPausedTaskApp(async ({ base }) => {
    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "write_workspace_file",
        args: { path: "never-written.md", content: "nope" },
      }),
    });
    assert.equal(created.status, 202);
    const task = (await created.json()).data;
    assert.equal(task.status, "queued");

    const canceled = await fetch(`${base}/api/tasks/${task.id}/cancel`, { method: "POST" });
    assert.equal(canceled.status, 200);
    const body = await canceled.json();
    assert.equal(body.data.status, "canceled");

    const read = await command(base, "read_artifact", { path: "never-written.md" });
    assert.notEqual(read.res.status, 200);
  });
});

test("async task API rejects work when the project queue is full", async () => {
  await withPausedTaskApp(
    async ({ base }) => {
      const first = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "write_workspace_file",
          args: { path: "queued-1.md", content: "one" },
        }),
      });
      assert.equal(first.status, 202);
      assert.equal((await first.json()).data.status, "queued");

      const rejected = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "write_workspace_file",
          args: { path: "queued-2.md", content: "two" },
        }),
      });
      assert.equal(rejected.status, 429);
      const body = await rejected.json();
      assert.equal(body.code, "task_queue_full");
      assert.match(body.error, /project/);
      assert.equal(rejected.headers.get("retry-after"), "5");

      const list = await fetch(`${base}/api/tasks`);
      assert.equal(list.status, 200);
      const tasks = (await list.json()).data;
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].status, "queued");
    },
    { maxQueuedTasksPerProject: 1, maxQueuedTasks: 10 },
  );
});

test("running async kernel tasks can be canceled", { skip: !hasPython3 }, async () => {
  await withApp(
    async ({ base }) => {
      const created = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "kernel_execute",
          args: {
            language: "python",
            code: "import time\nprint('started')\ntime.sleep(5)\nprint('finished')",
          },
        }),
      });
      assert.equal(created.status, 202);
      const task = (await created.json()).data;

      for (let i = 0; i < 30; i++) {
        const status = await fetch(`${base}/api/tasks/${task.id}`);
        assert.equal(status.status, 200);
        if ((await status.json()).data.status === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const canceled = await fetch(`${base}/api/tasks/${task.id}/cancel`, { method: "POST" });
      assert.equal(canceled.status, 200);
      assert.ok(["canceling", "canceled"].includes((await canceled.json()).data.status));

      const finished = await waitForTask(base, task.id);
      assert.equal(finished.status, "canceled");
      assert.equal(finished.error.code, "task_canceled");
    },
    { enableKernel: true, commandTimeoutMs: 10_000 },
  );
});

test("kernel_execute returns hosted stdout and stderr fields", { skip: !hasPython3 }, async () => {
  await withApp(
    async ({ base }) => {
      const out = await command(base, "kernel_execute", {
        language: "python",
        code: "import sys\nprint('out')\nprint('err', file=sys.stderr)\nsys.exit(1)",
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data.ok, false);
      assert.match(out.json.data.stdout, /out/);
      assert.match(out.json.data.stderr, /err/);
      assert.deepEqual(out.json.data.artifacts, []);
    },
    { enableKernel: true, allowUnsandboxedKernel: true },
  );
});

test("kernel_execute renders the final Python expression like a notebook display hook", { skip: !hasPython3 }, async () => {
  await withApp(
    async ({ base }) => {
      const out = await command(base, "kernel_execute", {
        language: "python",
        code: "print('EviMed Notebook OK')\n6 * 7",
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data.ok, true);
      assert.equal(out.json.data.stdout.trim(), "EviMed Notebook OK\n42");
    },
    { enableKernel: true, allowUnsandboxedKernel: true },
  );
});

test("kernel_execute runs R cells and preserves the notebook working directory", { skip: !hasR }, async () => {
  await withApp(
    async ({ base }) => {
      await command(base, "write_workspace_file", {
        path: "analysis/r-kernel.ipynb",
        content: `${JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 })}\n`,
      });
      const out = await command(base, "kernel_execute", {
        language: "r",
        notebook: "analysis/r-kernel.ipynb",
        code: "writeLines(paste0('mean=', mean(c(1, 2, 3))), 'r-output.txt')\ncat(basename(getwd()))",
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data.ok, true);
      assert.match(out.json.data.stdout, /analysis/);
      const artifact = await command(base, "read_artifact", { path: "analysis/r-output.txt" });
      assert.equal(artifact.json.data.data.trim(), "mean=2");
    },
    { enableKernel: true, allowUnsandboxedKernel: true },
  );
});

test("kernel_execute caps hosted stdout and stderr output", { skip: !hasPython3 }, async () => {
  await withApp(
    async ({ base }) => {
      const out = await command(base, "kernel_execute", {
        language: "python",
        code: "import sys\nsys.stdout.write('o' * 100)\nsys.stderr.write('e' * 100)",
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data.ok, true);
      assert.match(out.json.data.stdout, /output truncated after 32 bytes/);
      assert.match(out.json.data.stderr, /output truncated after 32 bytes/);
      assert.ok(out.json.data.stdout.length < 100);
      assert.ok(out.json.data.stderr.length < 100);
    },
    { enableKernel: true, allowUnsandboxedKernel: true, maxKernelOutputBytes: 32 },
  );
});

test("kernel_execute enforces the configured child process timeout", { skip: !hasPython3 }, async () => {
  await withApp(
    async ({ base }) => {
      const out = await command(base, "kernel_execute", {
        language: "python",
        code: "import time\nprint('started', flush=True)\ntime.sleep(5)\nprint('late', flush=True)",
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data.ok, false);
      assert.match(out.json.data.stdout, /started/);
      assert.doesNotMatch(out.json.data.stdout, /late/);
      assert.match(out.json.data.stderr, /Execution timed out after 100ms/);
    },
    { enableKernel: true, allowUnsandboxedKernel: true, kernelTimeoutMs: 100, commandTimeoutMs: 5_000 },
  );
});

test("kernel_execute uses the notebook directory as its scoped working directory", { skip: !hasPython3 }, async () => {
  await withApp(
    async ({ base }) => {
      const written = await command(base, "write_workspace_file", {
        path: "nested/analysis.ipynb",
        content: "{}",
      });
      assert.equal(written.res.status, 200);

      const out = await command(base, "kernel_execute", {
        code: "import os; print(os.path.basename(os.getcwd()))",
        language: "python",
        notebook: "nested/analysis.ipynb",
        root: "workspace",
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data.ok, true);
      assert.equal(out.json.data.stdout.trim(), "nested");
    },
    {
      enableKernel: true,
      kernelSandboxMode: "host",
      allowUnsandboxedKernel: true,
    },
  );
});

test("kernel_execute mounts the workspace selected by a base-scoped notebook", { skip: !hasPython3 }, async () => {
  await withApp(
    async ({ base }) => {
      let out = await command(base, "new_dated_workspace", { name: "historical" });
      assert.equal(out.res.status, 200);
      out = await command(base, "write_workspace_file", {
        path: "nested/analysis.ipynb",
        content: "{}",
      });
      assert.equal(out.res.status, 200);
      out = await command(base, "new_dated_workspace", { name: "current" });
      assert.equal(out.res.status, 200);

      out = await command(base, "kernel_execute", {
        code: "import os; print(os.path.basename(os.path.dirname(os.getcwd())), os.path.basename(os.getcwd()))",
        language: "python",
        notebook: "historical/nested/analysis.ipynb",
        root: "base",
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data.ok, true);
      assert.equal(out.json.data.stdout.trim(), "historical nested");

      const workspace = await command(base, "workspace_path");
      assert.equal(workspace.json.data, "/workspace/default/current");
    },
    {
      enableKernel: true,
      kernelSandboxMode: "host",
      allowUnsandboxedKernel: true,
    },
  );
});

test("kernel_reset aborts an in-flight execution for the selected notebook", { skip: !hasPython3 }, async () => {
  await withApp(
    async ({ base }) => {
      const written = await command(base, "write_workspace_file", {
        path: "analysis.ipynb",
        content: "{}",
      });
      assert.equal(written.res.status, 200);

      const execution = command(base, "kernel_execute", {
        code: "while True: pass",
        language: "python",
        notebook: "analysis.ipynb",
        root: "workspace",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const reset = await command(base, "kernel_reset", {
        language: "python",
        notebook: "analysis.ipynb",
        root: "workspace",
      });
      assert.equal(reset.res.status, 200);

      const finished = await execution;
      assert.equal(finished.res.status, 200);
      assert.equal(finished.json.data.ok, false);
      assert.match(finished.json.data.stderr, /aborted/i);
    },
    {
      enableKernel: true,
      kernelSandboxMode: "host",
      allowUnsandboxedKernel: true,
      kernelTimeoutMs: 5_000,
    },
  );
});

test("kernel_execute runs through the Docker sandbox when configured", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "os-web-fake-docker-"));
  try {
    const logPath = path.join(tmp, "docker-log.json");
    const dockerBin = await fakeDockerBin(tmp, logPath);
    await withApp(
      async ({ base }) => {
        const out = await command(base, "kernel_execute", {
          language: "python",
          code: "print('inside docker kernel')",
        });
        assert.equal(out.res.status, 200);
        assert.equal(out.json.data.ok, true);
        assert.match(out.json.data.stdout, /docker stdout/);
        assert.match(out.json.data.stderr, /docker stderr/);

        const log = JSON.parse(await readFile(logPath, "utf8"));
        assert.match(log.input, /__evimed_ast/);
        assert.match(log.input, /print\\\\u0028|print\\\\u0027|inside docker kernel/);
        assert.equal(log.args[0], "run");
        assert.ok(log.args.includes("--interactive"));
        assert.ok(log.args.includes("--rm"));
        assert.ok(log.args.includes("--init"));
        assert.deepEqual(log.args.slice(log.args.indexOf("--pull"), log.args.indexOf("--pull") + 2), ["--pull", "never"]);
        assert.deepEqual(log.args.slice(log.args.indexOf("--network"), log.args.indexOf("--network") + 2), ["--network", "none"]);
        assert.deepEqual(log.args.slice(log.args.indexOf("--cpus"), log.args.indexOf("--cpus") + 2), ["--cpus", "0.5"]);
        assert.deepEqual(log.args.slice(log.args.indexOf("--memory"), log.args.indexOf("--memory") + 2), ["--memory", "128m"]);
        assert.deepEqual(log.args.slice(log.args.indexOf("--pids-limit"), log.args.indexOf("--pids-limit") + 2), ["--pids-limit", "32"]);
        assert.ok(log.args.includes("--read-only"));
        assert.ok(log.args.includes("--tmpfs"));
        assert.ok(
          log.args.some((arg) =>
            arg.startsWith("type=volume,src=open-science-data,dst=/workspace,volume-subpath=users/")
          ),
        );
        assert.ok(log.args.includes("evimed-runtime-dsh:test"));
        assert.deepEqual(log.args.slice(-2), ["python", "-"]);
        assert.equal(log.args.includes("print('inside docker kernel')"), false);
      },
      {
        enableKernel: true,
        kernelSandboxMode: "docker",
        runtimeContainerBin: dockerBin,
        runtimeContainerImage: "evimed-runtime-dsh:test",
        runtimeDataVolume: "open-science-data",
        runtimeRequireImageLocal: true,
        runtimeCpuLimit: "0.5",
        runtimeMemoryLimit: "128m",
        runtimePidsLimit: 32,
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("kernel_execute selects the production R runtime inside the Docker sandbox", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "os-web-fake-docker-r-"));
  try {
    const logPath = path.join(tmp, "docker-log.json");
    const dockerBin = await fakeDockerBin(tmp, logPath);
    await withApp(
      async ({ base }) => {
        const out = await command(base, "kernel_execute", {
          language: "r",
          code: "cat(mean(c(1, 2, 3)))",
        });
        assert.equal(out.res.status, 200);
        const log = JSON.parse(await readFile(logPath, "utf8"));
        assert.deepEqual(log.args.slice(-2), ["Rscript", "-"]);
        assert.match(log.input, /mean\(c\(1, 2, 3\)\)/);
        assert.equal(log.args.includes("PYTHONUNBUFFERED=1"), false);
      },
      {
        enableKernel: true,
        kernelSandboxMode: "docker",
        runtimeContainerBin: dockerBin,
        runtimeContainerImage: "evimed-runtime-dsh:test",
        runtimeDataVolume: "open-science-data",
        runtimeRequireImageLocal: true,
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("kernel_execute checks project quota after Docker sandbox writes", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "os-web-fake-docker-"));
  try {
    const dockerBin = await fakeDockerBin(tmp, path.join(tmp, "docker-log.json"));
    await withApp(
      async ({ base }) => {
        const out = await command(base, "kernel_execute", {
          language: "python",
          code: "WRITE_QUOTA_FILE",
        });
        assert.equal(out.res.status, 413);
        assert.equal(out.json.code, "project_quota_exceeded");
      },
      {
        enableKernel: true,
        kernelSandboxMode: "docker",
        runtimeContainerBin: dockerBin,
        runtimeContainerImage: "evimed-runtime-dsh:test",
        maxProjectBytes: 8,
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("kernel_execute refuses host Python execution in production mode", async () => {
  await withAuthApp(
    async ({ base }) => {
      const loggedIn = await login(base);
      const out = await commandWithHeaders(
        base,
        "kernel_execute",
        {
          language: "python",
          code: "print('should not run')",
        },
        loggedIn.auth,
      );
      assert.equal(out.res.status, 403);
      assert.equal(out.json.code, "kernel_sandbox_required");
    },
    {
      production: true,
      enableKernel: true,
      allowUnsandboxedKernel: true,
    },
  );
});

test("production kernel execution rejects direct Docker control", async () => {
  await withAuthApp(
    async ({ base }) => {
      const loggedIn = await login(base);
      const out = await commandWithHeaders(
        base,
        "kernel_execute",
        { language: "python", code: "print(1)" },
        loggedIn.auth,
      );
      assert.equal(out.res.status, 503);
      assert.equal(out.json.code, "runtime_controller_required");
    },
    {
      production: true,
      runtimeMode: "mock",
      allowMockRuntime: true,
      enableKernel: true,
      kernelSandboxMode: "docker",
      runtimeControllerMode: "direct",
      allowDirectDockerControl: false,
      ...productionReleaseConfig,
    },
  );
});

test("async kernel tasks time out and abort the child process", { skip: !hasPython3 }, async () => {
  await withApp(
    async ({ base }) => {
      const created = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "kernel_execute",
          args: {
            language: "python",
            code: "import time\ntime.sleep(5)\nprint('late')",
          },
        }),
      });
      assert.equal(created.status, 202);
      const task = (await created.json()).data;

      const finished = await waitForTask(base, task.id);
      assert.equal(finished.status, "timed_out");
      assert.equal(finished.error.code, "command_timeout");
    },
    { enableKernel: true, commandTimeoutMs: 100 },
  );
});

test("users isolate projects with the same project id", async () => {
  await withAuthApp(async ({ app, base }) => {
    const alice = await login(base);
    await app.store.createUser("bob", "another correct battery staple", "Bob");
    const bob = await login(base, "bob", "another correct battery staple");

    await commandWithHeaders(
      base,
      "write_workspace_file",
      { path: "shared.md", content: "alice data" },
      alice.auth,
    );
    await commandWithHeaders(
      base,
      "write_workspace_file",
      { path: "shared.md", content: "bob data" },
      bob.auth,
    );

    const aliceRead = await commandWithHeaders(
      base,
      "read_artifact",
      { path: "shared.md" },
      alice.auth,
    );
    const bobRead = await commandWithHeaders(
      base,
      "read_artifact",
      { path: "shared.md" },
      bob.auth,
    );

    assert.equal(aliceRead.json.data.data, "alice data");
    assert.equal(bobRead.json.data.data, "bob data");
  });
});

test("workspace file commands are scoped and previewable", async () => {
  await withApp(async ({ base }) => {
    let out = await command(base, "write_workspace_file", {
      path: "reports/summary.md",
      content: "# Summary\n",
    });
    assert.equal(out.res.status, 200);

    out = await command(base, "list_dir", { rel: "reports" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data[0].name, "summary.md");

    out = await command(base, "read_artifact", { path: "reports/summary.md" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.data, "# Summary\n");

    out = await command(base, "preview_url", { path: "reports/summary.md" });
    assert.equal(out.res.status, 200);
    const preview = await fetch(out.json.data);
    assert.equal(preview.status, 200);
    assert.equal(await preview.text(), "# Summary\n");
  });
});

test("workspace previews are sandboxed and downloads sanitize filenames", async () => {
  await withApp(async ({ base }) => {
    let out = await command(base, "write_workspace_file", {
      path: "reports/preview.html",
      content: "<!doctype html><script>fetch('/api/me')</script>",
    });
    assert.equal(out.res.status, 200);

    const preview = await fetch(`${base}/api/files/preview/${encodeURIComponent("reports/preview.html")}`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(preview.headers.get("cache-control"), "no-store");
    const csp = preview.headers.get("content-security-policy") ?? "";
    assert.match(csp, /sandbox/);
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /connect-src 'none'/);

    const unsafeName = "bad\"\nname.txt";
    out = await command(base, "write_workspace_file", {
      path: unsafeName,
      content: "download me",
    });
    assert.equal(out.res.status, 200);

    const download = await fetch(`${base}/api/files/download/${encodeURIComponent(unsafeName)}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("cache-control"), "no-store");
    assert.equal(download.headers.get("content-disposition"), 'attachment; filename="bad__name.txt"');
    assert.equal(await download.text(), "download me");
  });
});

test("workspace file APIs return stable not-found errors", async () => {
  await withApp(async ({ base }) => {
    let out = await command(base, "read_artifact", { path: "missing.txt" });
    assert.equal(out.res.status, 404);
    assert.equal(out.json.code, "file_not_found");

    out = await command(base, "probe_large_file", { path: "missing.bin" });
    assert.equal(out.res.status, 404);
    assert.equal(out.json.code, "file_not_found");

    out = await command(base, "list_dir", { rel: "missing-dir" });
    assert.equal(out.res.status, 404);
    assert.equal(out.json.code, "directory_not_found");

    const preview = await fetch(`${base}/api/files/preview/${encodeURIComponent("missing.txt")}`);
    assert.equal(preview.status, 404);
    assert.equal((await preview.json()).code, "file_not_found");

    const download = await fetch(`${base}/api/files/download/${encodeURIComponent("missing.txt")}`);
    assert.equal(download.status, 404);
    assert.equal((await download.json()).code, "file_not_found");
  });
});

test("fresh projects provision an empty personal knowledge base", async () => {
  await withApp(async ({ base }) => {
    const out = await command(base, "list_dir", { root: "base", rel: "knowledge-base" });
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data, []);
  });
});

test("workspace file scans enforce an entry limit", async () => {
  await withApp(
    async ({ base }) => {
      for (const name of ["a.txt", "b.txt", "c.ipynb"]) {
        const out = await command(base, "write_workspace_file", {
          path: name,
          content: name.endsWith(".ipynb") ? "{\"cells\":[]}" : name,
        });
        assert.equal(out.res.status, 200);
      }

      let out = await command(base, "list_dir", {});
      assert.equal(out.res.status, 413);
      assert.equal(out.json.code, "directory_too_large");

      out = await command(base, "resolve_artifact", { path: "missing.md" });
      assert.equal(out.res.status, 413);
      assert.equal(out.json.code, "workspace_scan_too_large");

      out = await command(base, "list_notebooks", {});
      assert.equal(out.res.status, 413);
      assert.equal(out.json.code, "workspace_scan_too_large");
    },
    { maxWorkspaceScanEntries: 2 },
  );
});

test("workspace file APIs reject symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const outside = path.join(app.config.dataDir, "outside.txt");
    await writeFile(outside, "outside secret", "utf8");
    await symlink(outside, path.join(project.workspaceDir, "escape.txt"));
    const outsideNotebook = path.join(app.config.dataDir, "outside.ipynb");
    await writeFile(outsideNotebook, "{\"cells\":[]}", "utf8");
    await symlink(outsideNotebook, path.join(project.workspaceDir, "escape.ipynb"));
    await writeFile(path.join(project.workspaceDir, "visible.txt"), "visible", "utf8");

    let out = await command(base, "list_dir", {});
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data.map((entry) => entry.name), ["visible.txt"]);

    out = await command(base, "read_artifact", { path: "escape.txt" });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");

    out = await command(base, "write_workspace_file", {
      path: "escape.txt",
      content: "overwrite",
    });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");

    const preview = await fetch(`${base}/api/files/preview/${encodeURIComponent("escape.txt")}`);
    assert.equal(preview.status, 403);
    assert.equal((await preview.json()).code, "path_forbidden");

    const upload = await fetch(`${base}/api/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "escape.txt",
        encoding: "base64",
        data: Buffer.from("overwrite").toString("base64"),
      }),
    });
    assert.equal(upload.status, 403);
    assert.equal((await upload.json()).code, "path_forbidden");

    out = await command(base, "resolve_artifact", { path: "escape.txt" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, null);

    out = await command(base, "resolve_artifact", { path: "escape.ipynb" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, null);

    out = await command(base, "list_notebooks", {});
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json.data, []);
  });
});

test("active workspace persists across server restarts", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-workspace-"));
  let running = null;
  try {
    running = await startAppWithDataDir(dataDir);
    let out = await command(running.base, "new_dated_workspace", { name: "session_2026" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "/workspace/default/session_2026");

    out = await command(running.base, "write_workspace_file", {
      path: "note.md",
      content: "persisted workspace",
    });
    assert.equal(out.res.status, 200);

    out = await command(running.base, "workspace_path");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "/workspace/default/session_2026");
    await running.app.close();
    running = null;

    running = await startAppWithDataDir(dataDir);
    out = await command(running.base, "workspace_path");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "/workspace/default/session_2026");

    out = await command(running.base, "read_artifact", { path: "note.md" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.data, "persisted workspace");
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("active workspace selection rejects symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const outsideWorkspace = path.join(app.config.dataDir, "outside-workspace");
    await mkdir(outsideWorkspace, { recursive: true });
    await symlink(outsideWorkspace, path.join(project.baseDir, "linked-workspace"));

    const out = await command(base, "set_workspace", { path: "linked-workspace" });
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
  });
});

test("active workspace selection accepts only project-scoped absolute and display paths", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    await mkdir(path.join(project.baseDir, "absolute-workspace"), { recursive: true });
    await mkdir(path.join(project.baseDir, "display-workspace"), { recursive: true });

    let out = await command(base, "set_workspace", { path: path.join(project.baseDir, "absolute-workspace") });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "/workspace/default/absolute-workspace");

    out = await command(base, "set_workspace", { path: "/workspace/default/display-workspace" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "/workspace/default/display-workspace");

    out = await command(base, "set_workspace", { path: path.join(app.config.dataDir, "outside-workspace") });
    assert.equal(out.res.status, 400);
    assert.equal(out.json.code, "invalid_workspace");
  });
});

test("selecting the already active workspace is idempotent and keeps its runtime alive", async () => {
  await withApp(async ({ app, base }) => {
    let out = await command(base, "new_dated_workspace", { name: "same-workspace" });
    assert.equal(out.res.status, 200);
    out = await command(base, "start_runtime");
    assert.equal(out.res.status, 200);

    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    out = await command(base, "set_workspace", { path: path.join(project.baseDir, "same-workspace") });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "/workspace/default/same-workspace");

    out = await command(base, "runtime_status");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.running, true);
  });
});

test("persisted active workspace rejects symbolic links", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-workspace-symlink-"));
  const projectRoot = path.join(dataDir, "users", "dev", "projects", "default");
  const workspaceRoot = path.join(projectRoot, "workspace");
  const outsideWorkspace = path.join(dataDir, "outside-workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideWorkspace, { recursive: true });
  await mkdir(path.join(projectRoot, "runtime"), { recursive: true });
  await mkdir(path.join(projectRoot, ".openscience"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "project.json"),
    `${JSON.stringify({ id: "default", name: "Default Project", activeWorkspace: "linked-workspace" }, null, 2)}\n`,
    "utf8",
  );
  await symlink(outsideWorkspace, path.join(workspaceRoot, "linked-workspace"));

  let running = null;
  try {
    running = await startAppWithDataDir(dataDir);
    const out = await command(running.base, "list_dir", {});
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
  } finally {
    await running?.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("workspace file commands reject traversal", async () => {
  await withApp(async ({ base }) => {
    const { res, json } = await command(base, "write_workspace_file", {
      path: "../escape.txt",
      content: "bad",
    });

    assert.equal(res.status, 403);
    assert.equal(json.code, "path_forbidden");
  });
});

test("start_runtime returns the control plane's own surface, never a kernel's", async () => {
  await withApp(async ({ base }) => {
    const { res, json } = await command(base, "start_runtime");
    assert.equal(res.status, 200);
    assert.match(json.data, /\/api\/runtime$/);
    assert.ok(!/opencode|dsh/.test(json.data), "a caller must not be handed anything that names a kernel");

    const session = await fetch(`${json.data}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const body = (await session.json()).data;
    assert.match(body.id, /^web_mock_/);
  });
});

test("start_runtime enforces per-user runtime capacity across projects", async () => {
  await withApp(
    async ({ app, base }) => {
      const user = await app.store.devUser();
      await app.store.createProject(user, "paper2", "Paper 2");

      let out = await command(base, "start_runtime");
      assert.equal(out.res.status, 200);

      out = await commandWithHeaders(base, "start_runtime", {}, { "X-Open-Science-Project": "paper2" });
      assert.equal(out.res.status, 429);
      assert.equal(out.json.code, "runtime_limit_exceeded");
      assert.match(out.json.error, /user/);
      assert.equal(out.res.headers.get("retry-after"), "5");
    },
    { maxRunningRuntimesPerUser: 1, maxRunningRuntimes: 10 },
  );
});

test("runtime_status reports running and stopped runtimes", async () => {
  await withApp(async ({ base }) => {
    let out = await command(base, "runtime_status");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.running, false);
    assert.equal(out.json.data.stale, false);

    out = await command(base, "start_runtime");
    assert.equal(out.res.status, 200);

    out = await command(base, "runtime_status");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.running, true);
    assert.equal(out.json.data.kind, "mock");
    assert.equal(out.json.data.sandboxMode, "mock");
    assert.equal(out.json.data.stale, false);
    assert.equal(out.json.data.lastEvent, "started");

    const logs = await fetch(`${base}/api/logs/runtime?limit=10`);
    assert.equal(logs.status, 200);
    assert.ok((await logs.json()).data.some((row) => row.event === "started" && row.kind === "mock"));

    out = await command(base, "stop_runtime");
    assert.equal(out.res.status, 200);

    out = await command(base, "runtime_status");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.running, false);
    assert.equal(out.json.data.stale, false);
    assert.equal(out.json.data.lastEvent, "stopped");
    assert.equal(out.json.data.kind, "mock");
  });
});

test("workspace changes stop the running hosted runtime so it restarts on the new folder", async () => {
  await withApp(async ({ app, base }) => {
    let out = await command(base, "start_runtime");
    assert.equal(out.res.status, 200);

    out = await command(base, "new_dated_workspace", { name: "session_2026" });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data, "/workspace/default/session_2026");

    out = await command(base, "runtime_status");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.running, false);
    assert.equal(out.json.data.stale, false);
    assert.equal(out.json.data.lastEvent, "stopped");

    const logs = await fetch(`${base}/api/logs/runtime?limit=20`);
    assert.equal(logs.status, 200);
    const events = (await logs.json()).data.map((row) => row.event);
    assert.ok(events.includes("started"));
    assert.ok(events.includes("stopped"));

    out = await command(base, "start_runtime");
    assert.equal(out.res.status, 200);
    const runtimeUrl = out.json.data;

    const session = await fetch(`${runtimeUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const sessionBody = (await session.json()).data;
    // The run has to write for the new workspace to be the one it wrote into,
    // and a prompt reaches the kernel only through the ledger now.
    const bound = await fetch(`${base}/api/research-sessions/${encodeURIComponent(sessionBody.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "open-domain" }),
    });
    assert.equal(bound.status, 200);
    const prompt = await fetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionBody.id, dispatchId: "workspace-probe", text: "write artifact" }),
    });
    assert.ok([200, 202].includes(prompt.status), `dispatch returned ${prompt.status}`);

    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    assert.equal(project.activeWorkspace, "session_2026");
    assert.match(
      await readFile(path.join(project.workspaceDir, "mock-agent-artifact.md"), "utf8"),
      /Mock agent artifact/,
    );
    await assert.rejects(
      () => readFile(path.join(project.baseDir, "mock-agent-artifact.md"), "utf8"),
      (err) => err?.code === "ENOENT",
    );
  });
});

test("runtime idle timeout stops inactive project runtimes", async () => {
  await withApp(
    async ({ base }) => {
      let out = await command(base, "start_runtime");
      assert.equal(out.res.status, 200);

      out = await command(base, "runtime_status");
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data.running, true);

      const status = await waitForRuntimeStatus(base, (data) =>
        data.running === false && data.lastEvent === "idle_timeout" ? data : null,
      );
      assert.equal(status.kind, "mock");
      assert.equal(status.stale, false);

      const logs = await fetch(`${base}/api/logs/runtime?limit=20`);
      assert.equal(logs.status, 200);
      assert.ok((await logs.json()).data.some((row) =>
        row.event === "idle_timeout" && row.kind === "mock" && row.idleTimeoutMs === 500,
      ));
    },
    { runtimeIdleTimeoutMs: 500 },
  );
});

test("runtime idle timeout waits for a call still in flight", async () => {
  await withApp(
    async ({ app, base }) => {
      const started = await command(base, "start_runtime");
      assert.equal(started.res.status, 200);

      // The pass-through is gone, so "an active proxied stream" is now a
      // control-plane call still in flight. The rule is unchanged and so is the
      // thing that enforces it: while the runtime has an active proxy slot the
      // idle stop must not fire, or a long read is cut off by its own idleness.
      const manager = app.runtimeManager;
      const user = await app.store.devUser();
      const project = await app.store.defaultProject(user);
      manager.beginProxy(project);
      try {
        await new Promise((resolve) => setTimeout(resolve, 90));
        assert.ok(manager.activeProxyCount() > 0);
        const active = await command(base, "runtime_status");
        assert.equal(active.res.status, 200);
        assert.equal(active.json.data.running, true, "an in-flight call must keep the runtime alive");
      } finally {
        manager.endProxy(project);
      }
      const status = await waitForRuntimeStatus(base, (data) =>
        data.running === false && data.lastEvent === "idle_timeout" ? data : null,
      );
      assert.equal(status.kind, "mock");
    },
    { runtimeIdleTimeoutMs: 40 },
  );
});

test("runtime state files reject symbolic links", async () => {
  await withApp(async ({ app, base }) => {
    const user = await app.store.devUser();
    const project = await app.store.defaultProject(user);
    const outsideState = path.join(app.config.dataDir, "outside-runtime-state.json");
    const stateFile = path.join(project.metaDir, "runtime-state.json");
    await writeFile(outsideState, "{\"version\":1,\"running\":false}\n", "utf8");
    await symlink(outsideState, stateFile);

    const out = await command(base, "runtime_status");
    assert.equal(out.res.status, 403);
    assert.equal(out.json.code, "path_forbidden");
  });
});

test("runtime_status persists stopped runtime state across server restarts", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-runtime-state-"));
  const first = await startAppWithDataDir(dataDir);
  try {
    let out = await command(first.base, "start_runtime");
    assert.equal(out.res.status, 200);
    out = await command(first.base, "stop_runtime");
    assert.equal(out.res.status, 200);
  } finally {
    await first.app.close();
  }

  const second = await startAppWithDataDir(dataDir);
  try {
    const out = await command(second.base, "runtime_status");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.running, false);
    assert.equal(out.json.data.stale, false);
    assert.equal(out.json.data.lastEvent, "stopped");
    assert.equal(out.json.data.kind, "mock");
  } finally {
    await second.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runtime_status marks previously running runtime state as stale after server restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-runtime-stale-"));
  const first = await startAppWithDataDir(dataDir);
  try {
    const started = await command(first.base, "start_runtime");
    assert.equal(started.res.status, 200);
    const status = await command(first.base, "runtime_status");
    assert.equal(status.json.data.running, true);
    assert.equal(status.json.data.stale, false);
  } finally {
    await first.app.close();
  }

  const second = await startAppWithDataDir(dataDir);
  try {
    const out = await command(second.base, "runtime_status");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.running, false);
    assert.equal(out.json.data.stale, true);
    assert.equal(out.json.data.lastEvent, "started");
    assert.equal(out.json.data.kind, "mock");
    assert.equal(JSON.stringify(out.json.data).includes("os-web-runtime-stale-"), false);

    const metrics = await fetch(`${second.base}/api/metrics`);
    assert.equal(metrics.status, 200);
    const body = (await metrics.json()).data;
    assert.equal(body.runtime.running, false);
    assert.equal(body.runtime.stale, true);
    assert.equal(body.runtime.lastEvent, "started");
  } finally {
    await second.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("server startup cleans stale docker runtime state before accepting traffic", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-runtime-startup-cleanup-"));
  let app;
  try {
    const docker = await fakeDockerBin(dataDir, path.join(dataDir, "docker-log.json"));
    const projectRoot = path.join(dataDir, "users", "dev", "projects", "default");
    const metaDir = path.join(projectRoot, ".openscience");
    await mkdir(path.join(projectRoot, "workspace"), { recursive: true });
    await mkdir(path.join(projectRoot, "runtime"), { recursive: true });
    await mkdir(metaDir, { recursive: true });
    await writeFile(
      path.join(metaDir, "runtime-state.json"),
      `${JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        userId: "dev",
        projectId: "default",
        event: "started",
        running: true,
        kind: "dsh",
        startedAt: "2026-07-09T00:00:00.000Z",
        pid: null,
        exitedAt: null,
        sandboxMode: "docker",
        networkMode: "bridge",
        containerName: "open-science-stale-default",
      })}\n`,
      "utf8",
    );

    app = createWebApiApp({
      dataDir,
      port: 0,
      runtimeMode: "kernel",
      runtimeSandboxMode: "docker",
      runtimeContainerBin: docker,
      runtimeContainerImage: "evimed-runtime-dsh:test",
      devAuth: true,
    });
    await app.listen(0, "127.0.0.1");

    const state = JSON.parse(await readFile(path.join(metaDir, "runtime-state.json"), "utf8"));
    assert.equal(state.event, "orphan_cleanup");
    assert.equal(state.running, false);
    assert.equal(state.containerName, "open-science-stale-default");
    const logs = (await readFile(path.join(metaDir, "runtime.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(logs.some((row) => row.event === "startup_orphan_cleanup" && row.result === "removed"));
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runtime_status marks interrupted starting runtime state as stale", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-runtime-starting-"));
  const metaDir = path.join(dataDir, "users", "dev", "projects", "default", ".openscience");
  await mkdir(metaDir, { recursive: true });
  await writeFile(
    path.join(metaDir, "runtime-state.json"),
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        userId: "dev",
        projectId: "default",
        event: "starting",
        running: false,
        // The kernel this build writes into runtime state. The app under test
        // runs in mock mode, so reading `dsh` back out still proves the value
        // came off disk rather than from a server constant, and the fixture no
        // longer describes a deployment this build could not have produced.
        kind: "dsh",
        startedAt: null,
        pid: null,
        exitedAt: null,
        sandboxMode: "docker",
        networkMode: "bridge",
        containerName: "open-science-dev-default-test",
        error: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const running = await startAppWithDataDir(dataDir);
  try {
    const out = await command(running.base, "runtime_status");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.running, false);
    assert.equal(out.json.data.stale, true);
    assert.equal(out.json.data.lastEvent, "starting");
    assert.equal(out.json.data.kind, "dsh");
    assert.equal(out.json.data.sandboxMode, "docker");
    assert.equal(JSON.stringify(out.json.data).includes("os-web-runtime-starting-"), false);
  } finally {
    await running.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("docker runtime startup reports container cleanup failures", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "os-web-runtime-cleanup-"));
  try {
    const dockerBin = await fakeRuntimeCleanupFailDockerBin(tmp);
    await withApp(
      async ({ base }) => {
        const out = await command(base, "start_runtime");
        assert.equal(out.res.status, 502);
        assert.equal(out.json.code, "runtime_cleanup_failed");

        const status = await command(base, "runtime_status");
        assert.equal(status.res.status, 200);
        assert.equal(status.json.data.running, false);
        assert.equal(status.json.data.lastEvent, "failed");
        assert.equal(status.json.data.error, "runtime_cleanup_failed");

        const row = await waitForRuntimeLogs(base, (logs) =>
          logs.find((entry) => entry.event === "cleanup_failed" && entry.sandboxMode === "docker"),
        );
        assert.match(row.error, /permission denied/);
      },
      {
        runtimeMode: "kernel",
        runtimeSandboxMode: "docker",
        runtimeContainerBin: dockerBin,
        runtimeContainerImage: "evimed-runtime-dsh:test",
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// `host OpenCode startup cleans a stale same-project process from runtime
// state` was removed here with the kernel it tested. It drove the host
// sandbox through `runtimeMode: "opencode"` and an `opencodeBin`, neither of
// which this build has any more.
//
// It is recorded rather than silently dropped because it also explains why
// the suite stopped terminating: the test spawns a shell that loops forever,
// and once its first assertion failed against the retired kernel the process
// it had spawned outlived the run. Every assertion in the file passed and the
// runner then sat on that child until it was killed, which reads as "the
// tests hang" and says nothing about a process.

test("restart_runtime replaces a project runtime through the command API", async () => {
  await withApp(async ({ base }) => {
    let out = await command(base, "start_runtime");
    assert.equal(out.res.status, 200);
    const first = out.json.data;

    out = await command(base, "restart_runtime");
    assert.equal(out.res.status, 200);
    assert.match(out.json.data, /\/api\/runtime$/);

    out = await command(base, "runtime_status");
    assert.equal(out.res.status, 200);
    assert.equal(out.json.data.running, true);
    assert.equal(out.json.data.kind, "mock");

    out = await command(base, "stop_runtime");
    assert.equal(out.res.status, 200);

    const logs = await fetch(`${base}/api/logs/runtime?limit=20`);
    assert.equal(logs.status, 200);
    const events = (await logs.json()).data.map((row) => row.event);
    assert.ok(events.includes("stopped"));
    assert.ok(events.filter((event) => event === "started").length >= 2);
    assert.equal(first.endsWith("/api/runtime"), true);

    const audit = await fetch(`${base}/api/logs/audit?limit=30`);
    assert.equal(audit.status, 200);
    const rows = (await audit.json()).data;
    const runtimeRows = rows.filter((row) => row.action?.startsWith("runtime."));
    assert.ok(runtimeRows.some((row) => row.action === "runtime.start" && row.command === "start_runtime"));
    assert.ok(runtimeRows.some((row) => row.action === "runtime.restart" && row.command === "restart_runtime"));
    const stopped = runtimeRows.find((row) => row.action === "runtime.stop" && row.command === "stop_runtime");
    assert.ok(stopped);
    assert.equal(stopped.target, "runtime");
    assert.equal(stopped.runtimeAction, "stop");
    assert.equal(stopped.runtimeKind, "mock");
    assert.equal(stopped.runtimeSandboxMode, "mock");
    assert.equal(stopped.runtimeRunning, false);
    assert.equal(stopped.runtimeStale, false);
    // The retired pass-through path this used to name can no longer be built,
    // so the assertion is stated over the kernel that exists: an audit row is
    // the control plane's own record and must not name a kernel at all.
    assert.equal(/opencode|dsh/i.test(JSON.stringify(runtimeRows)), false, "an audit row must not name a kernel");
    assert.equal(JSON.stringify(runtimeRows).includes("dsh.sock"), false, "a control socket path must not reach an audit row");
  });
});

test("upload_file stores browser-provided base64 data", async () => {
  await withApp(async ({ base }) => {
    const { res, json } = await command(base, "upload_file", {
      filename: "data/data.bin",
      encoding: "base64",
      data: Buffer.from("abc").toString("base64"),
    });
    assert.equal(res.status, 200);
    assert.equal(json.data, "data/data.bin");

    const read = await command(base, "read_artifact", { path: "data/data.bin" });
    assert.equal(read.json.data.encoding, "base64");
    assert.equal(Buffer.from(read.json.data.data, "base64").toString("utf8"), "abc");
  });
});

test("upload endpoints use file-size body limits without relaxing generic commands", async () => {
  await withApp(
    async ({ base }) => {
      const commandPayload = Buffer.alloc(40, "a").toString("base64");
      const commandBody = {
        filename: "limits/command.bin",
        encoding: "base64",
        data: commandPayload,
      };
      assert.ok(JSON.stringify(commandBody).length > 32);

      let out = await command(base, "upload_file", commandBody);
      assert.equal(out.res.status, 200);
      assert.equal(out.json.data, "limits/command.bin");

      let preview = await fetch(`${base}/api/files/preview/${encodeURIComponent("limits/command.bin")}`);
      assert.equal(preview.status, 200);
      assert.equal(await preview.text(), "a".repeat(40));

      const directBody = {
        filename: "limits/direct.bin",
        encoding: "base64",
        data: Buffer.alloc(40, "b").toString("base64"),
      };
      assert.ok(JSON.stringify(directBody).length > 32);

      const direct = await fetch(`${base}/api/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(directBody),
      });
      assert.equal(direct.status, 200);
      assert.equal((await direct.json()).data.path, "limits/direct.bin");

      preview = await fetch(`${base}/api/files/preview/${encodeURIComponent("limits/direct.bin")}`);
      assert.equal(preview.status, 200);
      assert.equal(await preview.text(), "b".repeat(40));

      const taskBody = {
        command: "upload_file",
        args: {
          filename: "limits/task.bin",
          encoding: "base64",
          data: Buffer.alloc(40, "t").toString("base64"),
        },
      };
      assert.ok(JSON.stringify(taskBody).length > 32);
      const taskCreated = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskBody),
      });
      assert.equal(taskCreated.status, 202);
      const task = (await taskCreated.json()).data;
      const finished = await waitForTask(base, task.id);
      assert.equal(finished.status, "succeeded");

      preview = await fetch(`${base}/api/files/preview/${encodeURIComponent("limits/task.bin")}`);
      assert.equal(preview.status, 200);
      assert.equal(await preview.text(), "t".repeat(40));

      out = await command(base, "write_workspace_file", {
        path: "generic.txt",
        content: "x".repeat(128),
      });
      assert.equal(out.res.status, 413);
      assert.equal(out.json.code, "body_too_large");

      const genericTask = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "write_workspace_file",
          args: { path: "generic-task.txt", content: "x".repeat(128) },
        }),
      });
      assert.equal(genericTask.status, 413);
      assert.equal((await genericTask.json()).code, "body_too_large");

      out = await command(base, "upload_file", {
        filename: "limits/too-large.bin",
        encoding: "base64",
        data: Buffer.alloc(65, "c").toString("base64"),
      });
      assert.equal(out.res.status, 413);
      assert.equal(out.json.code, "file_too_large");
    },
    { maxJsonBytes: 32, maxFileBytes: 64 },
  );
});

test("static frontend assets are served with SPA fallback", async () => {
  await withStaticApp(async ({ base }) => {
    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "console.log('ok')");

    const route = await fetch(`${base}/sessions/demo`);
    assert.equal(route.status, 200);
    assert.equal(await route.text(), "<div id=\"root\"></div>");
  });
});

test("static frontend assets reject symbolic links", async () => {
  await withStaticApp(async ({ base, dataDir, staticDir }) => {
    const outside = path.join(dataDir, "outside.js");
    await writeFile(outside, "console.log('outside')", "utf8");
    await symlink(outside, path.join(staticDir, "assets/linked.js"));

    const asset = await fetch(`${base}/assets/linked.js`);
    assert.equal(asset.status, 403);
    assert.equal((await asset.json()).code, "path_forbidden");

    const route = await fetch(`${base}/sessions/demo`);
    assert.equal(route.status, 200);
    assert.equal(await route.text(), "<div id=\"root\"></div>");
  });
});

test("readiness rejects symlinked static index", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-api-"));
  const staticDir = await mkdtemp(path.join(tmpdir(), "os-web-static-"));
  const outsideIndex = path.join(dataDir, "outside-index.html");
  await writeFile(outsideIndex, "<div id=\"root\"></div>", "utf8");
  await symlink(outsideIndex, path.join(staticDir, "index.html"));
  const app = createWebApiApp({ dataDir, staticDir, port: 0, runtimeMode: "mock", devAuth: true });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const res = await fetch(`${base}/api/ready`);
    assert.equal(res.status, 503);
    const body = (await res.json()).data;
    assert.equal(body.ok, false);
    assert.equal(body.checks.staticDir.ok, false);
    assert.equal(body.checks.staticDir.code, "path_forbidden");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  }
});

test("the internal gateways are labelled and ledgered like every other route", async () => {
  // The runtime's entire outbound traffic — every model call, every source
  // fetch, every search — leaves through three paths that answered before the
  // error ledger and were labelled "/static" in the metrics. A provider 401
  // storm and a wave of images were the same line on the dashboard.
  await withApp(async ({ base, dataDir }) => {
    const paths = [
      "/internal/model/v1/chat/completions",
      "/internal/sources/v1/fetch",
      "/internal/search/v1/query",
    ];
    for (const pathname of paths) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 404, `${pathname} answers its own 404 on a wrong method`);
    }
    const file = path.join(dataDir, ".openscience", "errors.jsonl");
    let records = [];
    for (let attempt = 0; attempt < 50 && records.length < paths.length; attempt += 1) {
      const text = await readFile(file, "utf8").catch(() => "");
      records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (records.length < paths.length) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const pathname of paths) {
      const record = records.find((entry) => entry.route === pathname);
      assert.ok(record, `${pathname} must reach the ledger the API routes already use`);
      assert.equal(record.code, "not_found");
      assert.equal(record.status, 404);
    }
    assert.ok(!records.some((entry) => entry.route === "/static"), "no gateway failure may be filed as static traffic");
  });
});

test("a download that does not finish is not audited as a completed delivery", async () => {
  // The audit used to be written before the first byte moved, and a read error
  // answered with a bare res.destroy(). A reader could be handed a truncated
  // report while the audit recorded a successful delivery of the full size.
  await withApp(async ({ base, dataDir }) => {
    const big = "x".repeat(6 * 1024 * 1024);
    const written = await command(base, "write_workspace_file", { path: "big.txt", content: big });
    assert.equal(written.res.status, 200);

    const auditFile = path.join(dataDir, "users", "dev", "projects", "default", ".openscience", "audit.jsonl");
    const readAudit = async () => {
      const text = await readFile(auditFile, "utf8").catch(() => "");
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    };

    const controller = new AbortController();
    const response = await fetch(`${base}/api/files/download/big.txt`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(big.length));
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});

    let record = null;
    for (let attempt = 0; attempt < 100 && !record; attempt += 1) {
      const rows = await readAudit();
      record = rows.reverse().find((row) => row.action === "file.download" && row.target === "big.txt");
      if (!record) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(record, "an interrupted download must still be audited");
    assert.equal(record.status, "failed", "an interrupted download is not a completed delivery");
    assert.ok(record.bytes < big.length, `only ${record.bytes} of ${big.length} bytes left the server`);

    const complete = await fetch(`${base}/api/files/download/big.txt`);
    assert.equal((await complete.text()).length, big.length);
    let done = null;
    for (let attempt = 0; attempt < 100 && !done; attempt += 1) {
      const rows = await readAudit();
      done = rows.reverse().find((row) => row.action === "file.download" && row.status === "completed");
      if (!done) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(done, "a delivery that did finish is still audited as completed");
    assert.equal(done.bytes, big.length);
  });
});

test("a ledger that cannot be written says so instead of dropping the record", async () => {
  // Every one of the three ledgers swallowed its own write failure, so the one
  // failure the audit chain cannot record was its own: a full disk or a lost
  // EACCES left the requests succeeding and the record simply absent.
  await withApp(
    async ({ base, dataDir }) => {
      const ledgerDir = path.join(dataDir, ".openscience");
      await mkdir(ledgerDir, { recursive: true });

      // The counter is process-wide, so measure the delta rather than assume
      // this test is the first thing to have written a ledger.
      const readCount = async () => {
        const res = await fetch(`${base}/api/ops/metrics`, { headers: { Authorization: "Bearer metrics-secret" } });
        const body = await res.text();
        const match = /^open_science_ledger_write_failures_total\{ledger="errors"\} (\d+)$/m.exec(body);
        assert.ok(match, "the metric must be present whether or not anything has failed");
        return Number(match[1]);
      };
      const before = await readCount();

      await chmod(ledgerDir, 0o500);
      try {
        const rejected = await fetch(`${base}/api/projects/does-not-exist-at-all`);
        assert.ok(rejected.status >= 400, "the request still answers even though its record cannot be filed");
      } finally {
        await chmod(ledgerDir, 0o700);
      }

      let after = before;
      for (let attempt = 0; attempt < 50 && after === before; attempt += 1) {
        after = await readCount();
        if (after === before) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(
        after > before,
        `a ledger append that failed must be counted where an operator already looks (${before} → ${after})`,
      );
    },
    { operatorMetricsToken: "metrics-secret" },
  );
});

test("an unreadable project directory is an error, not an empty account", async () => {
  // fs.readdir(root).catch(() => []) returned the empty list plus a
  // synthesised "default", which is exactly what a new user sees. Someone
  // whose project directory lost its permissions was shown a fresh account
  // and told, in effect, that their work was gone.
  await withApp(async ({ base, dataDir }) => {
    const listed = await fetch(`${base}/api/projects`);
    assert.equal(listed.status, 200);

    const root = path.join(dataDir, "users", "dev", "projects");
    await chmod(root, 0o000);
    try {
      const response = await fetch(`${base}/api/projects`);
      assert.notEqual(response.status, 200, "an unreadable directory must not answer like an empty one");
      assert.equal((await response.json()).code, "projects_unreadable");
    } finally {
      await chmod(root, 0o700);
    }

    const recovered = await fetch(`${base}/api/projects`);
    assert.equal(recovered.status, 200, "and it recovers once the directory is readable again");
  });
});
