import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildComposeArgs,
  parseDockerEngineInfo,
  parseEnvFile,
  runHostPreflight,
  validateDeploymentConfig,
  validateDockerSocketStat,
  validateSandboxPrerequisites,
} from "../../../scripts/ops/host-preflight.mjs";
import { signDeepSeekReleaseReceipt } from "../../../scripts/ops/deepseek-kernel-release-gate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function deploymentValues(overrides = {}) {
  return {
    NODE_ENV: "production",
    OPEN_SCIENCE_DEPLOYMENT_PROFILE: "controlled-pilot",
    OPEN_SCIENCE_PUBLIC_URL: "https://science.example.com",
    OPEN_SCIENCE_DOMAIN: "science.example.com",
    OPEN_SCIENCE_CADDY_VERSION: "2.11.4-alpine",
    OPEN_SCIENCE_RELEASE_ID: "release-2026-07-13",
    OPEN_SCIENCE_SOURCE_REVISION: "a".repeat(40),
    OPEN_SCIENCE_BUILD_CREATED: "2026-07-13T10:00:00Z",
    OPEN_SCIENCE_WEB_CONTAINER_IMAGE: "registry.example.com/open-science-web:0.1.3",
    OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE:
      "registry.example.com/open-science-opencode:opencode-1.17.13-uv-0.11.26",
    OPEN_SCIENCE_RELEASE_MANIFEST_HOST_FILE: "./release-manifest.json",
    OPEN_SCIENCE_DATA_VOLUME: "open-science-data",
    OPEN_SCIENCE_DOCKER_SOCKET_GID: "998",
    OPEN_SCIENCE_AUTH_MODE: "local",
    OPEN_SCIENCE_BOOTSTRAP_USER: "admin",
    OPEN_SCIENCE_BOOTSTRAP_PASSWORD: "",
    OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE: "./secrets/bootstrap-password.txt",
    OPEN_SCIENCE_PREFLIGHT_MONITORING: "false",
    OPEN_SCIENCE_OPERATOR_METRICS_TOKEN: "m".repeat(48),
    OPEN_SCIENCE_BACKUP_MODE: "external",
    OPEN_SCIENCE_BACKUP_EXTERNAL_ACK: "true",
    OPEN_SCIENCE_RESTORE_DRILL_ACK: "true",
    OPEN_SCIENCE_RUNTIME_MODE: "opencode",
    OPEN_SCIENCE_RUNTIME_SANDBOX_MODE: "docker",
    OPEN_SCIENCE_RUNTIME_TRANSPORT: "unix",
    OPEN_SCIENCE_RUNTIME_NETWORK_MODE: "none",
    OPEN_SCIENCE_DEEPSEEK_PROVIDER_ENABLED: "false",
    OPEN_SCIENCE_EVIMED_API_KEY_HOST_FILE: "./secrets/evimed-api-key.txt",
    OPEN_SCIENCE_ENABLE_KERNEL: "false",
    OPEN_SCIENCE_TRUST_PROXY: "true",
    OPEN_SCIENCE_PREFLIGHT_MIN_FREE_BYTES: String(1024 * 1024 * 1024),
    ...overrides,
  };
}

function serializeEnv(values) {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

async function deploymentFixture(values = deploymentValues()) {
  const dir = await mkdtemp(path.join(repoRoot, ".host-preflight-test-"));
  const envFile = path.join(dir, ".env");
  await writeFile(envFile, serializeEnv(values), { mode: 0o600 });
  await chmod(envFile, 0o600);
  await writeFile(path.join(dir, "release-manifest.json"), "{}\n", { mode: 0o600 });
  const bootstrapPasswordFile = path.resolve(dir, values.OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE);
  await mkdir(path.dirname(bootstrapPasswordFile), { recursive: true });
  await writeFile(bootstrapPasswordFile, "correct-horse-battery-staple\n", { mode: 0o600 });
  await chmod(bootstrapPasswordFile, 0o600);
  const evimedApiKeyFile = path.resolve(dir, values.OPEN_SCIENCE_EVIMED_API_KEY_HOST_FILE);
  await writeFile(evimedApiKeyFile, "test-evimed-credential\n", { mode: 0o600 });
  await chmod(evimedApiKeyFile, 0o600);
  return { dir, envFile, values, bootstrapPasswordFile, evimedApiKeyFile };
}

test("host preflight accepts only a matching non-fake DeepSeek release receipt when enabled", async (t) => {
  const receiptId = "dsrg_0123456789abcdef";
  const configRevision = "gateway-config-v1";
  const values = deploymentValues({
    OPEN_SCIENCE_DEEPSEEK_PROVIDER_ENABLED: "true",
    OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_HOST_FILE: "./secrets/deepseek-release-receipt.json",
    OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_ID: receiptId,
    OPEN_SCIENCE_DEEPSEEK_CONFIG_REVISION: configRevision,
    OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_HOST_FILE: "./secrets/model-gateway-signing-key.txt",
  });
  const fixture = await deploymentFixture(values);
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));
  const receiptFile = path.join(fixture.dir, "secrets/deepseek-release-receipt.json");
  const signingSecret = "host-preflight-signing-secret-with-at-least-32-bytes";
  await writeFile(path.join(fixture.dir, "secrets/model-gateway-signing-key.txt"), `${signingSecret}\n`, { mode: 0o600 });
  const receipt = signDeepSeekReleaseReceipt({
    schemaVersion: 1,
    id: receiptId,
    mode: "production",
    productionEligible: true,
    createdAt: new Date().toISOString(),
    opencodeVersion: "1.17.13",
    model: "deepseek-v4-pro",
    sourceRevision: values.OPEN_SCIENCE_SOURCE_REVISION,
    configRevision,
    capabilities: {
      providerBaseline: true,
      providerStreaming: true,
      providerToolLoop: true,
      providerStructuredOutput: true,
      gatewayOnly: true,
      streaming: true,
      toolResultIterations: 2,
      sessionHistory: true,
      structuredFinal: true,
    },
  }, { signingSecret });
  await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await chmod(receiptFile, 0o600);
  assert.doesNotThrow(() => validateDeploymentConfig(values, fixture.envFile));

  const fakeReceipt = signDeepSeekReleaseReceipt({
    ...receipt,
    mode: "fake",
    productionEligible: false,
  }, { signingSecret });
  await writeFile(receiptFile, `${JSON.stringify(fakeReceipt)}\n`, { mode: 0o600 });
  assert.throws(
    () => validateDeploymentConfig(values, fixture.envFile),
    (error) => error?.code === "deepseek_release_receipt_fake",
  );
});

test("host preflight env parser preserves explicit values and rejects duplicates", () => {
  assert.deepEqual(parseEnvFile('A="one two"\nexport B=three\n'), { A: "one two", B: "three" });
  assert.throws(() => parseEnvFile("A=one\nA=two\n"), { code: "preflight_env_duplicate" });
});

test("host preflight requires an exact HTTPS Caddy domain and immutable release inputs", async (t) => {
  const fixture = await deploymentFixture();
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  const valid = validateDeploymentConfig(fixture.values, fixture.envFile);
  assert.equal(valid.publicUrl.origin, "https://science.example.com");
  assert.equal(valid.apiPort, 8787);
  assert.equal(valid.trustProxy, true);
  assert.equal(valid.dockerSocketGid, 998);
  assert.equal(valid.runtimeImage.includes("opencode-1.17.13"), true);
  assert.equal(valid.bootstrapPasswordFile, fixture.bootstrapPasswordFile);

  assert.throws(
    () =>
      validateDeploymentConfig(
        deploymentValues({ OPEN_SCIENCE_TRUST_PROXY: "false" }),
        fixture.envFile,
      ),
    { code: "preflight_proxy_trust" },
  );
  assert.throws(
    () =>
      validateDeploymentConfig(
        deploymentValues({ OPEN_SCIENCE_DOMAIN: "other.example.com" }),
        fixture.envFile,
      ),
    { code: "preflight_domain_mismatch" },
  );
  assert.throws(
    () =>
      validateDeploymentConfig(
        deploymentValues({ OPEN_SCIENCE_RELEASE_ID: "replace-with-release-id" }),
        fixture.envFile,
      ),
    { code: "preflight_release_id" },
  );
  assert.throws(
    () =>
      validateDeploymentConfig(
        deploymentValues({ OPEN_SCIENCE_API_PORT: "70000" }),
        fixture.envFile,
      ),
    { code: "preflight_api_port" },
  );
  assert.throws(
    () =>
      validateDeploymentConfig(
        deploymentValues({ OPEN_SCIENCE_PREFLIGHT_OBJECT_STORAGE: "true" }),
        fixture.envFile,
      ),
    { code: "preflight_object_storage_missing" },
  );
  assert.throws(
    () =>
      validateDeploymentConfig(
        deploymentValues({ OPEN_SCIENCE_PREFLIGHT_ALERT_DELIVERY: "true" }),
        fixture.envFile,
      ),
    { code: "preflight_alert_probe_monitoring" },
  );
  assert.throws(
    () =>
      validateDeploymentConfig(
        deploymentValues({ OPEN_SCIENCE_DOCKER_SOCKET_GID: "docker" }),
        fixture.envFile,
      ),
    { code: "preflight_docker_socket_gid" },
  );
});

test("host preflight requires a private no-follow local-auth password file", async (t) => {
  const fixture = await deploymentFixture();
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  assert.throws(
    () => validateDeploymentConfig(
      { ...fixture.values, OPEN_SCIENCE_BOOTSTRAP_PASSWORD: "environment-correct-horse-battery-staple" },
      fixture.envFile,
    ),
    { code: "preflight_bootstrap_password_environment" },
  );

  await chmod(fixture.bootstrapPasswordFile, 0o644);
  assert.throws(() => validateDeploymentConfig(fixture.values, fixture.envFile), {
    code: "preflight_file_permissions",
  });

  await rm(fixture.bootstrapPasswordFile);
  const target = path.join(fixture.dir, "bootstrap-target.txt");
  await writeFile(target, "correct-horse-battery-staple\n", { mode: 0o600 });
  await symlink(target, fixture.bootstrapPasswordFile);
  assert.throws(() => validateDeploymentConfig(fixture.values, fixture.envFile), {
    code: "preflight_path_symlink",
  });
});

test("host preflight rejects Docker engines before volume-subpath support", () => {
  assert.deepEqual(parseDockerEngineInfo("26.1.4|linux|x86_64"), {
    version: "26.1.4",
    major: 26,
    os: "linux",
    architecture: "amd64",
  });
  assert.throws(() => parseDockerEngineInfo("25.0.5|linux|amd64"), {
    code: "preflight_docker_too_old",
  });
  assert.throws(() => parseDockerEngineInfo("27.0.1|windows|amd64"), {
    code: "preflight_docker_os",
  });
});

test("host preflight binds the controller group to the Docker socket owner", () => {
  const socket = { gid: 998, mode: 0o140660, isSocket: () => true };
  assert.equal(validateDockerSocketStat(socket, 998), 998);
  assert.throws(() => validateDockerSocketStat(socket, 999), {
    code: "preflight_docker_socket_gid_mismatch",
  });
  assert.throws(
    () => validateDockerSocketStat({ ...socket, mode: 0o140600 }, 998),
    { code: "preflight_docker_socket_permissions" },
  );
  assert.throws(
    () => validateDockerSocketStat({ ...socket, isSocket: () => false }, 998),
    { code: "preflight_docker_socket" },
  );
});

test("host preflight composes the selected TLS, identity, backup, and monitoring overlays", () => {
  const args = buildComposeArgs(
    { authMode: "oidc", backupMode: "local", monitoringEnabled: true },
    "/srv/open-science/.env",
  );
  const joined = args.join(" ");
  assert.match(joined, /docker-compose\.yml/);
  assert.match(joined, /docker-compose\.oidc\.yml/);
  assert.match(joined, /docker-compose\.backup\.yml/);
  assert.match(joined, /docker-compose\.monitoring\.yml/);
  assert.match(joined, /--profile tls/);
  assert.match(joined, /--profile backup/);
  assert.match(joined, /--profile monitoring/);
  assert.deepEqual(args.slice(-2), ["config", "--quiet"]);

  const localArgs = buildComposeArgs(
    { authMode: "local", backupMode: "external", monitoringEnabled: false },
    "/srv/open-science/.env",
  ).join(" ");
  assert.match(localArgs, /docker-compose\.local-auth\.yml/);
  assert.doesNotMatch(localArgs, /docker-compose\.oidc\.yml/);

  const saasArgs = buildComposeArgs(
    { authMode: "oidc", backupMode: "external", monitoringEnabled: true, deploymentProfile: "individual-saas" },
    "/srv/open-science/.env",
  ).join(" ");
  assert.match(saasArgs, /docker-compose\.oidc\.yml/);
  assert.match(saasArgs, /docker-compose\.saas\.yml/);
  assert.doesNotMatch(saasArgs, /docker-compose\.backup\.yml/);
});

test("host preflight verifies Docker, images, Compose, release identity, and public HTTPS", async (t) => {
  const fixture = await deploymentFixture(deploymentValues({
    OPEN_SCIENCE_PREFLIGHT_MONITORING: "true",
    OPEN_SCIENCE_PREFLIGHT_ALERT_DELIVERY: "true",
    OPEN_SCIENCE_PREFLIGHT_OBJECT_STORAGE: "true",
    OPEN_SCIENCE_OBJECT_BACKUP_URI: "s3://research-backups/open-science/prod",
  }));
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));
  const calls = [];
  const checks = [];
  const imageInfo = `sha256:${"b".repeat(64)}|linux|amd64`;
  const execute = (command, args) => {
    calls.push([command, ...args]);
    if (command === "uname") return "7.0.0-30-generic";
    if (command === "docker" && args[0] === "version") return "26.1.4|linux|amd64";
    if (command === "docker" && args[0] === "compose" && args[1] === "version") return "v2.27.1";
    if (command === "docker" && args[0] === "info") return "/var/lib/docker";
    if (command === "docker" && args[0] === "image") return imageInfo;
    // A container in any state referencing the runtime image; without one, a
    // host-wide prune takes it between jobs.
    if (command === "docker" && args[0] === "ps") return "web-opencode-runtime-image-1\n";
    return "";
  };
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self'",
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
  };
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/") return new Response("<!doctype html>", { status: 200, headers });
    const data = url.pathname === "/api/ready"
      ? {
          ok: true,
          checks: {
            release: { ok: true, releaseId: "release-2026-07-13" },
            security: { ok: true },
          },
        }
      : { ok: true, releaseId: "release-2026-07-13" };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await runHostPreflight({
    envFile: fixture.envFile,
    online: true,
    processEnv: {},
    platform: "linux",
    execute,
    stat: () => ({ gid: 998, mode: 0o140660, isSocket: () => true }),
    statfs: () => ({ bavail: 4_000_000n, bsize: 4096n }),
    readLsm: () => "lockdown,capability,landlock,yama,apparmor",
    fetchImpl,
    onCheck: (name) => checks.push(name),
  });

  assert.equal(result.ok, true);
  assert.equal(result.online, true);
  assert.equal(result.docker.architecture, "amd64");
  assert.equal(calls.filter((call) => call[0] === "docker" && call[1] === "image").length, 3);
  assert.ok(calls.some((call) => call.includes("--verify-images")));
  assert.ok(calls.some((call) => call.some((part) => part.endsWith("configure-production-state.mjs")) && call.includes("--check")));
  assert.ok(calls.some((call) => call.some((part) => part.endsWith("configure-local-auth.mjs")) && call.includes("--check")));
  assert.ok(calls.some((call) => call.includes("--profile") && call.includes("tls")));
  assert.ok(calls.some((call) => call.some((part) => part.endsWith("object-backup.mjs")) && call.includes("probe")));
  assert.ok(calls.some((call) => call.some((part) => part.endsWith("configure-monitoring.mjs")) && call.includes("--probe")));
  assert.equal(result.objectStorageProbed, true);
  assert.equal(result.alertDeliveryProbed, true);
  assert.ok(checks.includes("object-storage"));
  assert.ok(checks.includes("alert-delivery"));
  assert.ok(checks.includes("docker-socket"));
  assert.ok(checks.includes("production-state-secrets"));
  assert.ok(checks.includes("public-https"));
  assert.ok(checks.includes("sandbox-backend"), "a deployment host must be shown to be able to confine the agent's shell");
});

test("host preflight fails before Docker when the deployment env file is not private", async (t) => {
  const fixture = await deploymentFixture();
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));
  await chmod(fixture.envFile, 0o644);

  await assert.rejects(
    runHostPreflight({
      envFile: fixture.envFile,
      processEnv: {},
      platform: "linux",
      execute: () => assert.fail("Docker must not run for an unsafe env file."),
    }),
    { code: "preflight_file_permissions" },
  );
});

test("host preflight refuses a runtime image no container references", async (t) => {
  // It vanished twice from the shared host: between jobs nothing referenced it,
  // a host-wide `docker system prune -a` took it, and nobody found out until
  // somebody submitted work and got runtime_image_unavailable.
  const fixture = await deploymentFixture(deploymentValues());
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));
  const imageInfo = `sha256:${"b".repeat(64)}|linux|amd64`;
  const execute = (command, args) => {
    if (command === "uname") return "7.0.0-30-generic";
    if (command === "docker" && args[0] === "version") return "26.1.4|linux|amd64";
    if (command === "docker" && args[0] === "compose" && args[1] === "version") return "v2.27.1";
    if (command === "docker" && args[0] === "info") return "/var/lib/docker";
    if (command === "docker" && args[0] === "image") return imageInfo;
    if (command === "docker" && args[0] === "ps") return "";
    return "";
  };
  await assert.rejects(
    () => runHostPreflight({
      envFile: fixture.envFile,
      online: false,
      processEnv: {},
      platform: "linux",
      execute,
      stat: () => ({ gid: 998, mode: 0o140660, isSocket: () => true }),
      statfs: () => ({ bavail: 4_000_000n, bsize: 4096n }),
      readLsm: () => "lockdown,capability,landlock,yama,apparmor",
      onCheck: () => {},
    }),
    (error) => {
      assert.equal(error.code, "preflight_runtime_image_unpinned");
      assert.match(error.message, /host-wide image prune will remove it/);
      assert.match(error.message, /--profile runtime-image up --no-build --no-start/);
      return true;
    },
  );
});

// V13. Every other check in this file passes on a host where the agent cannot
// run a single command: without Landlock the shell tool refuses everything,
// and the container still starts, answers health checks and reports ready.
// bwrap is not a fallback — inside a container it needs an unprivileged user
// namespace that Docker's seccomp profile and Ubuntu's AppArmor both refuse.
test("a host that cannot confine the agent's shell is refused before deployment", () => {
  assert.deepEqual(
    validateSandboxPrerequisites("7.0.0-30-generic", "lockdown,capability,landlock,yama,apparmor"),
    { kernel: "7.0.0-30-generic", landlock: true, enforcement: "full" },
  );

  // 6.8 has Landlock and passes every check this function used to make, and the
  // launcher on it reports `partial enforcement (older Landlock ABI)` — which a
  // hosted profile refuses to boot on. Measured on this project's host before
  // and after the kernel upgrade, so the boundary is 6.10 rather than 5.13.
  assert.throws(
    () => validateSandboxPrerequisites("6.8.0-101-generic", "lockdown,capability,landlock,yama,apparmor"),
    (error) => {
      assert.equal(error.code, "preflight_landlock_partial_enforcement");
      assert.match(error.message, /6\.10/);
      return true;
    },
    "having Landlock is not the same as having all of it",
  );

  assert.throws(
    () => validateSandboxPrerequisites("5.12.9-generic", "landlock"),
    (error) => {
      assert.equal(error.code, "preflight_kernel_too_old");
      assert.match(error.message, /5\.13 or newer/);
      return true;
    },
    "Landlock did not exist before 5.13, whatever the LSM list claims",
  );

  assert.throws(
    () => validateSandboxPrerequisites("6.8.0-generic", "capability,yama,apparmor"),
    (error) => {
      assert.equal(error.code, "preflight_landlock_unavailable");
      assert.match(error.message, /capability, yama, apparmor/);
      return true;
    },
    "a new enough kernel still has to have it turned on",
  );

  assert.throws(
    () => validateSandboxPrerequisites("not-a-version", "landlock"),
    (error) => {
      assert.equal(error.code, "preflight_kernel_version_invalid");
      return true;
    },
    "an unreadable version is unknown, not acceptable",
  );
});
