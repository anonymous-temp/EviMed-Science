import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { productionReleaseConfig } from "./releaseFixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const smokeScript = path.join(repoRoot, "scripts/ops/deployment-smoke.mjs");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
// The kernel smoke path runs a Python kernel and then an R one, so it needs both
// interpreters on the host. Declaring only Python meant a machine without R
// failed here with "spawn Rscript ENOENT" — an error that names a missing binary
// rather than an unmet test precondition, and one that no amount of reading the
// test would predict. That made `pnpm test:web` and `pnpm ci:web` unpassable on
// any host without R. Skipping is right only here: `smoke:deployment` run against
// a real deployment still fails on a missing R, which is a genuine host defect.
const hasRscript = spawnSync("Rscript", ["--version"], { stdio: "ignore" }).status === 0;

function runSmoke(env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [smokeScript], { cwd: repoRoot, env }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test("deployment smoke script validates a hosted Web deployment through public APIs", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-smoke-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    operatorMetricsToken: "metrics-secret",
    maxProjectBytes: 1024 * 1024,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const metricsTokenFile = path.join(dataDir, "smoke-metrics-token.txt");
  await writeFile(metricsTokenFile, "metrics-secret\n", { mode: 0o600 });
  try {
    const smoke = await runSmoke({
      ...process.env,
      OPEN_SCIENCE_SMOKE_BASE_URL: base,
      OPEN_SCIENCE_SMOKE_USERNAME: "alice",
      OPEN_SCIENCE_SMOKE_PASSWORD: "correct horse battery staple",
      OPEN_SCIENCE_SMOKE_PROJECT_ID: "smokeproj",
      OPEN_SCIENCE_SMOKE_METRICS_TOKEN: "",
      OPEN_SCIENCE_SMOKE_METRICS_TOKEN_FILE: metricsTokenFile,
      OPEN_SCIENCE_SMOKE_RUNTIME: "true",
    });

    assert.match(smoke.stdout, /\[smoke\] health ok/);
    assert.match(smoke.stdout, /\[smoke\] security readiness ok/);
    assert.match(smoke.stdout, /\[smoke\] observability readiness ok/);
    assert.match(smoke.stdout, /\[smoke\] release provenance readiness ok/);
    assert.match(smoke.stdout, /\[smoke\] backup readiness ok/);
    assert.match(smoke.stdout, /\[smoke\] operator metrics ok/);
    assert.match(smoke.stdout, /\[smoke\] file upload\/read\/preview\/download ok/);
    assert.match(smoke.stdout, /\[smoke\] runtime ok/);
    assert.match(smoke.stdout, /\[smoke\] deployment smoke passed/);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("deployment smoke accepts an operator-supplied OIDC session without password credentials", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-smoke-oidc-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    authMode: "oidc",
    devAuth: false,
    publicUrl: "http://127.0.0.1",
    oidcIssuer: "http://127.0.0.1:9999",
    oidcClientId: "smoke-client",
    oidcClientSecret: "provider-client-secret-for-smoke",
    oidcFlowSecret: "separate-flow-secret-for-smoke-with-32-bytes",
    operatorMetricsToken: "",
    maxProjectBytes: 1024 * 1024,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  app.config.publicUrl = base;
  const responseHeaders = new Map();
  const fakeResponse = {
    getHeader(name) { return responseHeaders.get(String(name).toLowerCase()); },
    setHeader(name, value) { responseHeaders.set(String(name).toLowerCase(), value); },
  };
  try {
    const user = await app.store.upsertOidcUser(`oidc_${"a".repeat(48)}`, "Smoke Researcher");
    await app.store.createSession(user, { headers: {}, socket: { encrypted: false } }, fakeResponse);
    const setCookie = responseHeaders.get("set-cookie");
    const sessionCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];

    const smoke = await runSmoke({
      ...process.env,
      OPEN_SCIENCE_SMOKE_BASE_URL: base,
      OPEN_SCIENCE_SMOKE_SESSION_COOKIE: sessionCookie,
      OPEN_SCIENCE_SMOKE_USERNAME: "",
      OPEN_SCIENCE_SMOKE_PASSWORD: "",
      OPEN_SCIENCE_SMOKE_PROJECT_ID: "oidcsmoke",
      OPEN_SCIENCE_SMOKE_RUNTIME: "false",
    });

    assert.match(smoke.stdout, /\[smoke\] oidc authentication ok/);
    assert.match(smoke.stdout, /\[smoke\] file upload\/read\/preview\/download ok/);
    assert.match(smoke.stdout, /\[smoke\] deployment smoke passed/);
    assert.equal(smoke.stdout.includes(sessionCookie), false);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("deployment smoke executes project-scoped hosted Python and R kernels", { skip: !hasPython3 || !hasRscript }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-smoke-kernel-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    enableKernel: true,
    kernelSandboxMode: "host",
    allowUnsandboxedKernel: true,
    maxProjectBytes: 1024 * 1024,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const smoke = await runSmoke({
      ...process.env,
      OPEN_SCIENCE_SMOKE_BASE_URL: base,
      OPEN_SCIENCE_SMOKE_USERNAME: "alice",
      OPEN_SCIENCE_SMOKE_PASSWORD: "correct horse battery staple",
      OPEN_SCIENCE_SMOKE_PROJECT_ID: "kernelsmoke",
      OPEN_SCIENCE_SMOKE_KERNEL: "true",
      OPEN_SCIENCE_SMOKE_REQUIRE_DOCKER_KERNEL: "false",
      OPEN_SCIENCE_SMOKE_RUNTIME: "false",
    });

    assert.match(smoke.stdout, /\[smoke\] kernel readiness ok \(host\)/);
    assert.match(smoke.stdout, /\[smoke\] project-scoped Python\/R scientific kernels read\/write ok/);
    assert.match(smoke.stdout, /\[smoke\] deployment smoke passed/);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("deployment smoke requires the scrape token when production observability is required", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-smoke-observability-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    production: true,
    publicUrl: "https://science.example.com",
    runtimeMode: "mock",
    allowMockRuntime: true,
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    operatorMetricsToken: "metrics-token-for-production-readiness-tests",
    backupMode: "external",
    backupExternalAck: true,
    restoreDrillAck: true,
    trustProxy: true,
    ...productionReleaseConfig,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(
      runSmoke({
        ...process.env,
        OPEN_SCIENCE_SMOKE_BASE_URL: base,
        OPEN_SCIENCE_SMOKE_METRICS_TOKEN: "",
        OPEN_SCIENCE_SMOKE_METRICS_TOKEN_FILE: "",
        OPEN_SCIENCE_OPERATOR_METRICS_TOKEN: "",
      }),
      (err) => {
        assert.match(err.stderr, /OPEN_SCIENCE_SMOKE_METRICS_TOKEN or OPEN_SCIENCE_SMOKE_METRICS_TOKEN_FILE is required/);
        return true;
      },
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
