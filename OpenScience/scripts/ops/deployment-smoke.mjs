#!/usr/bin/env node
import fs from "node:fs";

const DEFAULT_PROJECT_PREFIX = "smoke";

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readSecretFile(name) {
  const file = process.env[name];
  if (!file) return "";
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size > 8 * 1024) throw new Error(`${name} must reference a small regular file.`);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error(`${name} must not be group- or world-accessible.`);
    }
    return fs.readFileSync(handle, "utf8").replace(/\r?\n$/, "");
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

function normalizeBaseUrl(value) {
  if (!value) throw new Error("OPEN_SCIENCE_SMOKE_BASE_URL or URL argument is required.");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Smoke base URL must use http or https.");
  }
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocal && !boolEnv("OPEN_SCIENCE_SMOKE_ALLOW_HTTP")) {
    throw new Error("Smoke base URL must use HTTPS unless OPEN_SCIENCE_SMOKE_ALLOW_HTTP=true.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function smokeProjectId() {
  const configured = process.env.OPEN_SCIENCE_SMOKE_PROJECT_ID;
  if (configured) return configured;
  return `${DEFAULT_PROJECT_PREFIX}-${Date.now().toString(36)}`.slice(0, 48);
}

function log(message) {
  process.stdout.write(`[smoke] ${message}\n`);
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = Number(process.env.OPEN_SCIENCE_SMOKE_TIMEOUT_MS ?? 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonFetch(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return { res, json };
}

async function textFetch(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} -> ${res.status} ${text.slice(0, 512)}`);
  }
  return { res, text };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function command(baseUrl, name, args, headers) {
  return jsonFetch(`${baseUrl}/api/commands/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(args ?? {}),
  });
}

async function login(baseUrl) {
  const username = requiredEnv("OPEN_SCIENCE_SMOKE_USERNAME");
  const password = requiredEnv("OPEN_SCIENCE_SMOKE_PASSWORD");
  const loginRes = await jsonFetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = loginRes.res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const csrfToken = loginRes.json?.data?.csrfToken;
  assert(cookie.startsWith("os_session="), "Login did not return an os_session cookie.");
  assert(typeof csrfToken === "string" && csrfToken.startsWith("csrf_"), "Login did not return a CSRF token.");
  return { Cookie: cookie, "X-Open-Science-CSRF": csrfToken };
}

function configuredSessionCookie() {
  const raw =
    process.env.OPEN_SCIENCE_SMOKE_SESSION_COOKIE ||
    readSecretFile("OPEN_SCIENCE_SMOKE_SESSION_COOKIE_FILE");
  if (!raw) return "";
  const cookie = raw.split(";")[0]?.trim() ?? "";
  if (!/^os_session=sess_[a-f0-9]{32}$/.test(cookie)) {
    throw new Error("OPEN_SCIENCE_SMOKE_SESSION_COOKIE must contain only a valid os_session cookie.");
  }
  return cookie;
}

async function authenticate(baseUrl) {
  const methods = await jsonFetch(`${baseUrl}/api/auth/methods`);
  const mode = methods.json?.data?.mode;
  let cookie = "";
  if (mode === "local") {
    return { headers: await login(baseUrl), mode };
  }
  if (mode === "oidc") {
    cookie = configuredSessionCookie();
    assert(
      cookie,
      "OPEN_SCIENCE_SMOKE_SESSION_COOKIE or OPEN_SCIENCE_SMOKE_SESSION_COOKIE_FILE is required for OIDC deployment smoke.",
    );
  } else if (mode === "development") {
    const devLogin = await jsonFetch(`${baseUrl}/api/auth/dev-login`, { method: "POST" });
    cookie = devLogin.res.headers.get("set-cookie")?.split(";")[0] ?? "";
  } else {
    throw new Error(`Unsupported deployment authentication mode: ${String(mode)}`);
  }

  const me = await jsonFetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
  const csrfToken = me.json?.data?.csrfToken;
  assert(cookie.startsWith("os_session="), "Authentication did not provide an os_session cookie.");
  assert(typeof csrfToken === "string" && csrfToken.startsWith("csrf_"), "Authentication did not provide a CSRF token.");
  return { headers: { Cookie: cookie, "X-Open-Science-CSRF": csrfToken }, mode };
}

async function readFirstSseEvent(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.OPEN_SCIENCE_SMOKE_TIMEOUT_MS ?? 30_000));
  const res = await fetch(`${url}/event`, { headers, signal: controller.signal });
  try {
    assert(res.ok, `Runtime SSE endpoint returned HTTP ${res.status}.`);
    assert((res.headers.get("content-type") ?? "").includes("text/event-stream"), "Runtime endpoint is not SSE.");
    const reader = res.body?.getReader();
    assert(reader, "Runtime SSE response did not include a body.");
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert(text.includes("event:") || text.includes("data:"), "Runtime SSE did not emit an event chunk.");
    await reader.cancel().catch(() => {});
    return text;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function smokeRuntime(baseUrl, headers) {
  const runtime = await command(baseUrl, "start_runtime", {}, headers);
  const runtimeUrl = runtime.json?.data;
  assert(typeof runtimeUrl === "string" && runtimeUrl.includes("/api/opencode/"), "start_runtime returned an invalid URL.");
  await readFirstSseEvent(runtimeUrl, headers);

  const session = await jsonFetch(`${runtimeUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  });
  assert(session.json?.id, "Runtime did not create a session.");

  if (boolEnv("OPEN_SCIENCE_SMOKE_RUNTIME_PROMPT", true)) {
    await jsonFetch(`${runtimeUrl}/session/${encodeURIComponent(session.json.id)}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ parts: [{ type: "text", text: "Create a deployment smoke-test artifact." }] }),
    });
  }

  const running = await command(baseUrl, "runtime_status", {}, headers);
  assert(running.json?.data?.running === true, "Runtime did not report running after startup.");

  await command(baseUrl, "stop_runtime", {}, headers);
  const stopped = await command(baseUrl, "runtime_status", {}, headers);
  assert(stopped.json?.data?.running === false, "Runtime did not stop cleanly.");
}

async function smokeKernels(baseUrl, headers, sample) {
  const notebook = "smoke/kernel-smoke.ipynb";
  await command(baseUrl, "write_workspace_file", {
    path: notebook,
    content: `${JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 })}\n`,
  }, headers);

  const execution = await command(baseUrl, "kernel_execute", {
    language: "python",
    notebook,
    root: "workspace",
    code: [
      "from pathlib import Path",
      "import numpy as np",
      "import pandas as pd",
      "from scipy import stats",
      "source = Path('input.txt').read_text(encoding='utf-8')",
      "Path('kernel-output.txt').write_text('kernel:' + source, encoding='utf-8')",
      "print(source, end='')",
      "print('[kernel] science=' + str(float(stats.gmean(np.array([1.0, 4.0])))))",
      "print('[kernel] pandas=' + pd.Series([1, 2, 3]).sum().__str__())",
      "print('[kernel] cwd=' + Path.cwd().name)",
    ].join("\n"),
  }, headers);
  const result = execution.json?.data;
  assert(result?.ok === true, `Hosted kernel failed: ${String(result?.stderr ?? "unknown error").slice(0, 512)}`);
  assert(result.stdout?.includes(sample.trim()), "Hosted kernel could not read the project-scoped input file.");
  assert(result.stdout?.includes("[kernel] science=2.0"), "Hosted Python kernel is missing the reviewed scientific stack.");
  assert(result.stdout?.includes("[kernel] pandas=6"), "Hosted Python kernel could not execute pandas.");
  assert(result.stdout?.includes("[kernel] cwd=smoke"), "Hosted kernel did not use the notebook directory.");

  const output = await command(baseUrl, "read_artifact", { path: "smoke/kernel-output.txt" }, headers);
  assert(output.json?.data?.data === `kernel:${sample}`, "Hosted kernel output did not persist in the project workspace.");

  const rExecution = await command(baseUrl, "kernel_execute", {
    language: "r",
    notebook,
    root: "workspace",
    code: [
      "source <- readLines('input.txt', warn = FALSE)",
      "writeLines(paste0('r-kernel:', source), 'r-kernel-output.txt')",
      "cat(paste0('[r-kernel] mean=', mean(c(1, 2, 3)), '\\n'))",
      "cat(paste0('[r-kernel] cwd=', basename(getwd()), '\\n'))",
    ].join("\n"),
  }, headers);
  const rResult = rExecution.json?.data;
  assert(rResult?.ok === true, `Hosted R kernel failed: ${String(rResult?.stderr ?? "unknown error").slice(0, 512)}`);
  assert(rResult.stdout?.includes("[r-kernel] mean=2"), "Hosted R kernel did not execute base statistics.");
  assert(rResult.stdout?.includes("[r-kernel] cwd=smoke"), "Hosted R kernel did not use the notebook directory.");
  const rOutput = await command(baseUrl, "read_artifact", { path: "smoke/r-kernel-output.txt" }, headers);
  assert(rOutput.json?.data?.data === `r-kernel:${sample.trim()}\n`, "Hosted R kernel output did not persist in the project workspace.");
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.OPEN_SCIENCE_SMOKE_BASE_URL ?? process.argv[2]);
  const projectId = smokeProjectId();
  const sample = `deployment smoke ${new Date().toISOString()}\n`;
  const shouldSmokeKernel = boolEnv("OPEN_SCIENCE_SMOKE_KERNEL");

  log(`target ${baseUrl}`);
  const health = await jsonFetch(`${baseUrl}/api/health`);
  assert(health.json?.data?.ok === true, "/api/health did not report ok.");
  log("health ok");

  const ready = await jsonFetch(`${baseUrl}/api/ready`);
  assert(ready.json?.data?.ok === true, "/api/ready did not report ok.");
  assert(ready.json?.data?.checks?.examples?.ok === true, "/api/ready example bundle check did not report ok.");
  assert(ready.json?.data?.checks?.security?.ok === true, "/api/ready security check did not report ok.");
  assert(ready.json?.data?.checks?.observability?.ok === true, "/api/ready observability check did not report ok.");
  assert(ready.json?.data?.checks?.release?.ok === true, "/api/ready release provenance check did not report ok.");
  if (ready.json?.data?.checks?.release?.required) {
    assert(ready.json.data.checks.release.tracked === true, "Production release provenance is not tracked.");
    assert(typeof ready.json.data.checks.release.releaseId === "string", "Production release id is missing.");
  }
  assert(ready.json?.data?.checks?.backup?.ok === true, "/api/ready backup check did not report ok.");
  if (shouldSmokeKernel) {
    const kernel = ready.json?.data?.checks?.kernel;
    assert(kernel?.ok === true && kernel?.enabled === true, "/api/ready did not report an enabled kernel.");
    if (boolEnv("OPEN_SCIENCE_SMOKE_REQUIRE_DOCKER_KERNEL")) {
      assert(kernel.sandboxMode === "docker", "Deployment smoke requires the Docker kernel sandbox.");
    }
    log(`kernel readiness ok (${kernel.sandboxMode})`);
  }
  log("readiness ok");
  log("example bundle readiness ok");
  log("security readiness ok");
  log("observability readiness ok");
  log("release provenance readiness ok");
  log("backup readiness ok");

  const metricsToken =
    process.env.OPEN_SCIENCE_SMOKE_METRICS_TOKEN ||
    readSecretFile("OPEN_SCIENCE_SMOKE_METRICS_TOKEN_FILE") ||
    process.env.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN;
  if (ready.json?.data?.checks?.observability?.required) {
    assert(
      metricsToken,
      "OPEN_SCIENCE_SMOKE_METRICS_TOKEN or OPEN_SCIENCE_SMOKE_METRICS_TOKEN_FILE is required for production observability verification.",
    );
  }
  if (metricsToken) {
    const metrics = await textFetch(`${baseUrl}/api/ops/metrics`, {
      headers: { Authorization: `Bearer ${metricsToken}` },
    });
    assert(metrics.text.includes("open_science_up 1"), "Operator metrics did not include open_science_up.");
    log("operator metrics ok");
  }

  const authenticated = await authenticate(baseUrl);
  const auth = authenticated.headers;
  await jsonFetch(`${baseUrl}/api/me`, { headers: auth });
  log(`${authenticated.mode} authentication ok`);

  await jsonFetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ id: projectId, name: `Smoke ${projectId}` }),
  });
  const scoped = { ...auth, "X-Open-Science-Project": projectId };
  log(`project ${projectId} ok`);

  await command(baseUrl, "install_example", { name: "climate-trends" }, scoped);
  const example = await command(
    baseUrl,
    "read_artifact",
    { path: "climate-trends/data/gistemp_global_means.csv" },
    scoped,
  );
  assert(
    example.json?.data?.data?.startsWith("Land-Ocean: Global Means\nYear,Jan,Feb"),
    "Hosted workflow example did not contain the bundled real climate dataset.",
  );
  log("real workflow example install ok");

  await jsonFetch(`${baseUrl}/api/files/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...scoped },
    body: JSON.stringify({
      filename: "smoke/input.txt",
      encoding: "base64",
      data: Buffer.from(sample).toString("base64"),
    }),
  });

  const artifact = await command(baseUrl, "read_artifact", { path: "smoke/input.txt" }, scoped);
  assert(artifact.json?.data?.data === sample, "Uploaded smoke file did not round-trip.");

  const preview = await command(baseUrl, "preview_url", { path: "smoke/input.txt" }, scoped);
  const previewed = await textFetch(preview.json.data, { headers: auth });
  assert(previewed.text === sample, "Preview endpoint did not return the smoke file.");

  const download = await textFetch(`${baseUrl}/api/files/download/${encodeURIComponent("smoke/input.txt")}`, {
    headers: scoped,
  });
  assert(download.text === sample, "Download endpoint did not return the smoke file.");
  assert(download.res.headers.get("cache-control") === "no-store", "Download endpoint did not use no-store.");
  assert(
    (download.res.headers.get("content-disposition") ?? "").includes('filename="input.txt"'),
    "Download endpoint did not return an attachment filename.",
  );
  log("file upload/read/preview/download ok");

  if (shouldSmokeKernel) {
    await smokeKernels(baseUrl, scoped, sample);
    log("project-scoped Python/R scientific kernels read/write ok");
  }

  if (boolEnv("OPEN_SCIENCE_SMOKE_RUNTIME")) {
    await smokeRuntime(baseUrl, scoped);
    log("runtime ok");
  }

  log("deployment smoke passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
