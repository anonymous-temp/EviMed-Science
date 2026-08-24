#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readDeepSeekReleaseReceiptFile,
  readModelGatewaySigningSecretFile,
} from "./deepseek-opencode-release-gate.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), "../..");
const MIN_DOCKER_MAJOR = 26;
const DEFAULT_MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_ENV_BYTES = 1024 * 1024;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boolValue(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  throw failure("preflight_boolean_invalid", `Invalid boolean deployment value: ${value}`);
}

function positiveInteger(value, name, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw failure("preflight_number_invalid", `${name} must be a positive integer.`);
  }
  return parsed;
}

function dockerSocketGidValue(value) {
  const raw = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d{0,9})$/.test(raw)) {
    throw failure(
      "preflight_docker_socket_gid",
      "OPEN_SCIENCE_DOCKER_SOCKET_GID must be the numeric group owner of /var/run/docker.sock.",
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > 0xffff_ffff) {
    throw failure("preflight_docker_socket_gid", "OPEN_SCIENCE_DOCKER_SOCKET_GID is outside the Linux GID range.");
  }
  return parsed;
}

function isPlaceholder(value) {
  return /^(?:replace(?:-with)?|change-?me|example|placeholder|untracked|test)(?:[-_ ]|$)/i.test(
    value ?? "",
  );
}

function assertNoSymlinkPath(target) {
  const full = path.resolve(target);
  const parsed = path.parse(full);
  const parts = path.relative(parsed.root, full).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw failure("preflight_path_symlink", `Deployment path must not contain symbolic links: ${target}`);
    }
  }
}

function readRegularFileNoFollow(file, { privateFile = false, maxBytes = MAX_ENV_BYTES } = {}) {
  const target = path.resolve(file);
  assertNoSymlinkPath(target);
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw failure("preflight_file_not_regular", `${target} must be a regular file.`);
    if (stat.size <= 0 || stat.size > maxBytes) {
      throw failure("preflight_file_size", `${target} has an invalid size.`);
    }
    if (privateFile && process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw failure(
        "preflight_file_permissions",
        `${target} must not be accessible by group or other users. Use chmod 600.`,
      );
    }
    return fs.readFileSync(handle, "utf8");
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

function validateDeepSeekCompatibilityTool() {
  const scripts = [
    path.join(repoRoot, "scripts/ops/deepseek-compatibility-preflight.mjs"),
    path.join(repoRoot, "scripts/ops/deepseek-opencode-release-gate.mjs"),
  ];
  const pkgFile = path.join(repoRoot, "package.json");
  for (const script of scripts) {
    let stat;
    try {
      stat = fs.lstatSync(script);
    } catch {
      throw failure("preflight_deepseek_tool_missing", "DeepSeek compatibility preflight script is unavailable.");
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw failure("preflight_deepseek_tool_invalid", "DeepSeek compatibility preflight must be a regular file.");
    }
    if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
      throw failure("preflight_deepseek_tool_not_executable", "DeepSeek compatibility preflight is not executable.");
    }
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  } catch {
    throw failure("preflight_deepseek_tool_invalid", "DeepSeek compatibility package command is invalid.");
  }
  if (pkg.scripts?.["preflight:deepseek"] !== "node scripts/ops/deepseek-compatibility-preflight.mjs") {
    throw failure("preflight_deepseek_tool_invalid", "DeepSeek compatibility package command is unavailable.");
  }
  if (pkg.scripts?.["preflight:deepseek:release"] !== "node scripts/ops/deepseek-opencode-release-gate.mjs") {
    throw failure("preflight_deepseek_tool_invalid", "DeepSeek OpenCode release-gate package command is unavailable.");
  }
}

export function parseEnvFile(text) {
  const values = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const equals = normalized.indexOf("=");
    if (equals <= 0) {
      throw failure("preflight_env_syntax", `Invalid environment entry on line ${index + 1}.`);
    }
    const key = normalized.slice(0, equals).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw failure("preflight_env_syntax", `Invalid environment name on line ${index + 1}.`);
    }
    if (Object.hasOwn(values, key)) {
      throw failure("preflight_env_duplicate", `Duplicate environment name: ${key}`);
    }
    let value = normalized.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (/[\r\n\0]/.test(value)) {
      throw failure("preflight_env_syntax", `Invalid control character in ${key}.`);
    }
    values[key] = value;
  }
  return values;
}

function required(values, name) {
  const value = values[name]?.trim();
  if (!value) throw failure("preflight_config_missing", `${name} is required.`);
  return value;
}

function validateImageReference(value, name) {
  if (isPlaceholder(value) || /(?:^|:)latest$/i.test(value) || /\s/.test(value)) {
    throw failure("preflight_image_unpinned", `${name} must use a reviewed version tag or digest, not latest.`);
  }
  const leaf = value.slice(value.lastIndexOf("/") + 1);
  if (!leaf.includes(":") && !value.includes("@sha256:")) {
    throw failure("preflight_image_unpinned", `${name} must include a version tag or sha256 digest.`);
  }
  return value;
}

function resolveDeploymentPath(value, envFile) {
  return path.resolve(path.dirname(envFile), value);
}

function normalizeArch(value) {
  const arch = value.trim().toLowerCase();
  if (["x86_64", "x64"].includes(arch)) return "amd64";
  if (["aarch64", "arm64"].includes(arch)) return "arm64";
  return arch;
}

/**
 * The kernel's active LSM list.
 * @returns {string}
 */
function readHostLsmList() {
  try {
    return fs.readFileSync("/sys/kernel/security/lsm", "utf8");
  } catch {
    throw failure(
      "preflight_landlock_unavailable",
      "/sys/kernel/security/lsm is unreadable, so the host cannot confirm Landlock is enabled. "
      + "Mount securityfs, or run the preflight where the kernel can be queried.",
    );
  }
}

/** The kernel that first shipped Landlock (`landlock_create_ruleset`). */
const MIN_KERNEL = Object.freeze({ major: 5, minor: 13 });

/**
 * The kernel at which Landlock governs every access the launcher asks it to.
 *
 * Having Landlock is not the same as having all of it. DSH's launcher builds a
 * ruleset up to ABI 5 and, on an older ABI, confines what the kernel supports
 * and reports `partial enforcement` — which is honest but is not what a hosted
 * profile asks for: it requires `full`, and the startup probe fails closed
 * below it. ABI 5 arrived in 6.10. Measured on this project's host: 6.8 gave
 * ABI 4 and `partially enforced`; 7.0 gave `fully enforced`.
 */
const FULL_ENFORCEMENT_KERNEL = Object.freeze({ major: 6, minor: 10 });

/**
 * Whether this host can confine the agent's shell.
 *
 * The failure this prevents is quiet and total. In a container bwrap is
 * unavailable — it needs an unprivileged user namespace, which Docker's default
 * seccomp profile and Ubuntu's AppArmor both refuse — so the kernel's sandbox
 * chain falls through to Landlock. If Landlock is unavailable as well, the
 * agent's `bash` tool refuses every command it is ever asked to run, while the
 * container starts, answers health checks and reports itself ready. A run then
 * fails for reasons no log explains.
 *
 * Three prerequisites, checked here because they are host facts a deployment
 * cannot fix from inside the image: the kernel is new enough to have Landlock,
 * the LSM list actually has it enabled, and Docker is new enough that its
 * default seccomp profile permits the `landlock_*` syscalls (moby#43199 —
 * already covered by the engine check above, which requires a far newer major).
 *
 * @param {string} release @param {string} lsmList
 * @returns {{ kernel: string, landlock: boolean }}
 */
export function validateSandboxPrerequisites(release, lsmList) {
  const parsed = release.trim().match(/^(\d+)\.(\d+)/);
  if (!parsed) throw failure("preflight_kernel_version_invalid", "The host kernel version could not be read.");
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  if (major < MIN_KERNEL.major || (major === MIN_KERNEL.major && minor < MIN_KERNEL.minor)) {
    throw failure(
      "preflight_kernel_too_old",
      `Landlock needs Linux ${MIN_KERNEL.major}.${MIN_KERNEL.minor} or newer; found ${release.trim()}. `
      + "Without it the agent's shell tool refuses every command while the runtime still reports healthy.",
    );
  }
  const modules = lsmList.trim().split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!modules.includes("landlock")) {
    throw failure(
      "preflight_landlock_unavailable",
      `The host kernel does not have Landlock enabled (active LSMs: ${modules.join(", ") || "none reported"}). `
      + "Boot with `lsm=...,landlock,...` — bwrap is not a fallback inside a container.",
    );
  }
  const full = major > FULL_ENFORCEMENT_KERNEL.major
    || (major === FULL_ENFORCEMENT_KERNEL.major && minor >= FULL_ENFORCEMENT_KERNEL.minor);
  if (!full) {
    throw failure(
      "preflight_landlock_partial_enforcement",
      `Landlock reaches full enforcement at Linux ${FULL_ENFORCEMENT_KERNEL.major}.${FULL_ENFORCEMENT_KERNEL.minor}; `
      + `found ${release.trim()}, where the launcher confines what the kernel supports and reports partial. `
      + "A hosted profile requires full, so the runtime's startup probe would refuse to boot. "
      + "Upgrade the host kernel, or set OPEN_SCIENCE_RUNTIME_SANDBOX_ENFORCEMENT=partial for this deployment "
      + "and record which accesses go ungoverned.",
    );
  }
  return { kernel: release.trim(), landlock: true, enforcement: "full" };
}

export function parseDockerEngineInfo(output) {
  const [version, os, architecture] = output.trim().split("|");
  const major = Number(version?.match(/^(\d+)/)?.[1]);
  if (!Number.isSafeInteger(major)) {
    throw failure("preflight_docker_version_invalid", "Docker returned an invalid server version.");
  }
  if (major < MIN_DOCKER_MAJOR) {
    throw failure(
      "preflight_docker_too_old",
      `Docker Engine ${MIN_DOCKER_MAJOR} or newer is required for volume-subpath mounts; found ${version}.`,
    );
  }
  if (os !== "linux") {
    throw failure("preflight_docker_os", `The Docker server must run Linux containers; found ${os || "unknown"}.`);
  }
  const normalizedArch = normalizeArch(architecture ?? "");
  if (!normalizedArch) throw failure("preflight_docker_arch", "Docker server architecture is missing.");
  return { version, major, os, architecture: normalizedArch };
}

export function validateDockerSocketStat(socketStat, expectedGid) {
  if (!socketStat?.isSocket?.()) {
    throw failure("preflight_docker_socket", "/var/run/docker.sock must be a Unix socket.");
  }
  const actualGid = Number(socketStat.gid);
  if (!Number.isSafeInteger(actualGid) || actualGid < 0 || actualGid > 0xffff_ffff) {
    throw failure("preflight_docker_socket_gid", "/var/run/docker.sock returned an invalid group owner.");
  }
  if (actualGid !== expectedGid) {
    throw failure(
      "preflight_docker_socket_gid_mismatch",
      `OPEN_SCIENCE_DOCKER_SOCKET_GID must match /var/run/docker.sock (expected ${actualGid}).`,
    );
  }
  if ((Number(socketStat.mode) & 0o060) !== 0o060) {
    throw failure(
      "preflight_docker_socket_permissions",
      "/var/run/docker.sock must grant its owning group read and write access.",
    );
  }
  return actualGid;
}

function validatePublicUrl(values) {
  let url;
  try {
    url = new URL(required(values, "OPEN_SCIENCE_PUBLIC_URL"));
  } catch {
    throw failure("preflight_public_url", "OPEN_SCIENCE_PUBLIC_URL must be an absolute HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw failure("preflight_public_url", "OPEN_SCIENCE_PUBLIC_URL must be an HTTPS origin without credentials or a path.");
  }
  const domain = required(values, "OPEN_SCIENCE_DOMAIN").toLowerCase();
  if (domain !== url.hostname.toLowerCase()) {
    throw failure(
      "preflight_domain_mismatch",
      "OPEN_SCIENCE_DOMAIN must exactly match the OPEN_SCIENCE_PUBLIC_URL hostname.",
    );
  }
  return url;
}

function normalizeScriptPaths(values, envFile) {
  const normalized = { ...values };
  for (const name of [
    "OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE",
    "OPEN_SCIENCE_OIDC_SECRETS_DIR",
    "OPEN_SCIENCE_MONITORING_SECRETS_DIR",
    "OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE",
    "OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_HOST_FILE",
    "OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_HOST_FILE",
    "OPEN_SCIENCE_EVIMED_API_KEY_HOST_FILE",
  ]) {
    if (normalized[name] && !path.isAbsolute(normalized[name])) {
      normalized[name] = resolveDeploymentPath(normalized[name], envFile);
    }
  }
  return normalized;
}

export function validateDeploymentConfig(values, envFile) {
  if (values.NODE_ENV !== "production") {
    throw failure("preflight_node_env", "NODE_ENV must be production on the deployment host.");
  }
  const deploymentProfile = values.OPEN_SCIENCE_DEPLOYMENT_PROFILE?.trim() || "controlled-pilot";
  if (!new Set(["controlled-pilot", "individual-saas"]).has(deploymentProfile)) {
    throw failure("preflight_deployment_profile", "OPEN_SCIENCE_DEPLOYMENT_PROFILE must be controlled-pilot or individual-saas.");
  }
  const publicUrl = validatePublicUrl(values);
  const apiPort = positiveInteger(values.OPEN_SCIENCE_API_PORT, "OPEN_SCIENCE_API_PORT", 8787);
  if (apiPort > 65_535) {
    throw failure("preflight_api_port", "OPEN_SCIENCE_API_PORT must be a valid TCP port.");
  }
  const trustProxy = boolValue(values.OPEN_SCIENCE_TRUST_PROXY, false);
  if (!trustProxy) {
    throw failure(
      "preflight_proxy_trust",
      "OPEN_SCIENCE_TRUST_PROXY must be true when public traffic enters through the bundled Caddy profile.",
    );
  }
  const releaseId = required(values, "OPEN_SCIENCE_RELEASE_ID");
  if (isPlaceholder(releaseId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) {
    throw failure("preflight_release_id", "OPEN_SCIENCE_RELEASE_ID must be a non-placeholder release identifier.");
  }
  const sourceRevision = required(values, "OPEN_SCIENCE_SOURCE_REVISION");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sourceRevision)) {
    throw failure("preflight_source_revision", "OPEN_SCIENCE_SOURCE_REVISION must be a 40- or 64-character hex revision.");
  }
  const buildCreated = required(values, "OPEN_SCIENCE_BUILD_CREATED");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(buildCreated) || Number.isNaN(Date.parse(buildCreated))) {
    throw failure("preflight_build_time", "OPEN_SCIENCE_BUILD_CREATED must be an RFC3339 UTC timestamp.");
  }

  const webImage = validateImageReference(required(values, "OPEN_SCIENCE_WEB_CONTAINER_IMAGE"), "Web image");
  const runtimeImage = validateImageReference(
    required(values, "OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE"),
    "Runtime image",
  );
  const caddyVersion = required(values, "OPEN_SCIENCE_CADDY_VERSION");
  if (!/^\d+\.\d+\.\d+-alpine$/.test(caddyVersion)) {
    throw failure("preflight_caddy_version", "OPEN_SCIENCE_CADDY_VERSION must use an exact x.y.z-alpine tag.");
  }
  const caddyImage = validateImageReference(`caddy:${caddyVersion}`, "Caddy image");
  const manifestFile = resolveDeploymentPath(
    required(values, "OPEN_SCIENCE_RELEASE_MANIFEST_HOST_FILE"),
    envFile,
  );
  readRegularFileNoFollow(manifestFile, { maxBytes: 4 * 1024 * 1024 });

  const dataVolume = required(values, "OPEN_SCIENCE_DATA_VOLUME");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(dataVolume)) {
    throw failure("preflight_data_volume", "OPEN_SCIENCE_DATA_VOLUME is not a safe Docker volume name.");
  }
  const dockerSocketGid = dockerSocketGidValue(required(values, "OPEN_SCIENCE_DOCKER_SOCKET_GID"));

  const authMode = required(values, "OPEN_SCIENCE_AUTH_MODE");
  if (authMode === "local") {
    required(values, "OPEN_SCIENCE_BOOTSTRAP_USER");
    if (values.OPEN_SCIENCE_BOOTSTRAP_PASSWORD) {
      throw failure(
        "preflight_bootstrap_password_environment",
        "Production local authentication must use OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE, not an environment password.",
      );
    }
    const bootstrapPasswordFile = resolveDeploymentPath(
      required(values, "OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE"),
      envFile,
    );
    const password = readRegularFileNoFollow(bootstrapPasswordFile, {
      privateFile: true,
      maxBytes: 8193,
    }).replace(/\r?\n$/, "");
    if (
      password !== password.trim() ||
      /[\r\n\0]/.test(password) ||
      isPlaceholder(password) ||
      Buffer.byteLength(password, "utf8") < 16
    ) {
      throw failure(
        "preflight_bootstrap_password",
        "Local bootstrap password file must contain a non-placeholder value of at least 16 bytes without surrounding whitespace or control characters.",
      );
    }
  } else if (authMode === "oidc") {
    let issuer;
    try {
      issuer = new URL(required(values, "OPEN_SCIENCE_OIDC_ISSUER"));
    } catch {
      throw failure("preflight_oidc_issuer", "OPEN_SCIENCE_OIDC_ISSUER must be an absolute HTTPS URL.");
    }
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash) {
      throw failure("preflight_oidc_issuer", "OPEN_SCIENCE_OIDC_ISSUER must use HTTPS without credentials or fragments.");
    }
    required(values, "OPEN_SCIENCE_OIDC_CLIENT_ID");
    if (!values.OPEN_SCIENCE_OIDC_ALLOWED_GROUPS && !values.OPEN_SCIENCE_OIDC_ALLOWED_EMAIL_DOMAINS) {
      throw failure(
        "preflight_oidc_admission",
        "OIDC production access requires an allowed group or verified email-domain admission rule.",
      );
    }
  } else {
    throw failure("preflight_auth_mode", "OPEN_SCIENCE_AUTH_MODE must be local or oidc in production.");
  }

  const monitoringEnabled = boolValue(values.OPEN_SCIENCE_PREFLIGHT_MONITORING, true);
  const alertDeliveryProbeEnabled = boolValue(
    values.OPEN_SCIENCE_PREFLIGHT_ALERT_DELIVERY,
    monitoringEnabled,
  );
  if (alertDeliveryProbeEnabled && !monitoringEnabled) {
    throw failure(
      "preflight_alert_probe_monitoring",
      "Alert delivery probing requires the bundled monitoring configuration.",
    );
  }
  if (!monitoringEnabled) {
    const token = values.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN;
    const tokenFile = values.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE;
    if (token && tokenFile) {
      throw failure("preflight_metrics_secret", "Configure only one operator metrics token source.");
    }
    if (token) {
      if (isPlaceholder(token) || Buffer.byteLength(token, "utf8") < 32) {
        throw failure("preflight_metrics_secret", "Operator metrics token must be non-placeholder and at least 32 bytes.");
      }
    } else if (tokenFile) {
      const secret = readRegularFileNoFollow(resolveDeploymentPath(tokenFile, envFile), {
        privateFile: true,
        maxBytes: 8192,
      }).replace(/\r?\n$/, "");
      if (Buffer.byteLength(secret, "utf8") < 32) {
        throw failure("preflight_metrics_secret", "Operator metrics token file must contain at least 32 bytes.");
      }
    } else {
      throw failure("preflight_metrics_secret", "Production observability requires an operator metrics token.");
    }
  }

  const backupMode = required(values, "OPEN_SCIENCE_BACKUP_MODE");
  if (backupMode === "local") {
    positiveInteger(values.OPEN_SCIENCE_BACKUP_RETENTION_DAYS, "OPEN_SCIENCE_BACKUP_RETENTION_DAYS");
    if (!boolValue(values.OPEN_SCIENCE_RESTORE_DRILL_ACK)) {
      throw failure("preflight_restore_drill", "Local backup mode requires restore-drill acknowledgement.");
    }
  } else if (backupMode === "external") {
    if (!boolValue(values.OPEN_SCIENCE_BACKUP_EXTERNAL_ACK) || !boolValue(values.OPEN_SCIENCE_RESTORE_DRILL_ACK)) {
      throw failure("preflight_external_backup", "External backup mode requires backup ownership and restore-drill acknowledgement.");
    }
  } else {
    throw failure("preflight_backup_mode", "OPEN_SCIENCE_BACKUP_MODE must be local or external in production.");
  }
  if (deploymentProfile === "individual-saas" && (authMode !== "oidc" || backupMode !== "external")) {
    throw failure(
      "preflight_saas_boundary",
      "The individual-saas profile requires OIDC identity and externally owned recovery.",
    );
  }
  const objectStorageRequired = boolValue(values.OPEN_SCIENCE_PREFLIGHT_OBJECT_STORAGE, false);
  const objectStorageUri = values.OPEN_SCIENCE_OBJECT_BACKUP_URI?.trim() ?? "";
  if (objectStorageRequired && !objectStorageUri) {
    throw failure(
      "preflight_object_storage_missing",
      "Required off-host object storage needs OPEN_SCIENCE_OBJECT_BACKUP_URI.",
    );
  }

  for (const [name, expected] of [
    ["OPEN_SCIENCE_RUNTIME_MODE", "opencode"],
    ["OPEN_SCIENCE_RUNTIME_SANDBOX_MODE", "docker"],
    ["OPEN_SCIENCE_RUNTIME_TRANSPORT", "unix"],
  ]) {
    if (values[name] !== expected) throw failure("preflight_runtime_boundary", `${name} must be ${expected}.`);
  }
  for (const name of [
    "OPEN_SCIENCE_ALLOW_RUNTIME_HOST_NETWORK",
    "OPEN_SCIENCE_ALLOW_UNSANDBOXED_RUNTIME",
    "OPEN_SCIENCE_ALLOW_HOST_SHELL",
    "OPEN_SCIENCE_ALLOW_DIRECT_SHELL",
    "OPEN_SCIENCE_ALLOW_PERSISTENT_APPROVALS",
    "OPEN_SCIENCE_ALLOW_FULL_APPROVAL",
    "OPEN_SCIENCE_ALLOW_UNSANDBOXED_KERNEL",
  ]) {
    if (boolValue(values[name])) throw failure("preflight_escape_hatch", `${name} must remain false.`);
  }
  const networkMode = required(values, "OPEN_SCIENCE_RUNTIME_NETWORK_MODE");
  const internalNetwork = values.OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME?.trim() ?? "";
  const runtimeEgress = networkMode !== "none" && (!internalNetwork || networkMode !== internalNetwork);
  if (
    runtimeEgress &&
    (!boolValue(values.OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS) ||
      !boolValue(values.OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK))
  ) {
    throw failure("preflight_runtime_egress", "Runtime network egress requires both production policy acknowledgements.");
  }
  const deepseekProviderEnabled = boolValue(values.OPEN_SCIENCE_DEEPSEEK_PROVIDER_ENABLED, true);
  if (deepseekProviderEnabled) {
    const receiptSigningSecret = readModelGatewaySigningSecretFile(
      resolveDeploymentPath(required(values, "OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_HOST_FILE"), envFile),
    );
    const receiptMaxAgeMs = positiveInteger(
      values.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_MAX_AGE_MS,
      "OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_MAX_AGE_MS",
      24 * 60 * 60 * 1000,
    );
    readDeepSeekReleaseReceiptFile(
      resolveDeploymentPath(required(values, "OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_HOST_FILE"), envFile),
      {
        requireProduction: true,
        signingSecret: receiptSigningSecret,
        maxAgeMs: receiptMaxAgeMs,
        receiptId: required(values, "OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_ID"),
        sourceRevision,
        configRevision: required(values, "OPEN_SCIENCE_DEEPSEEK_CONFIG_REVISION"),
      },
    );
  }
  const evimedApiKey = readRegularFileNoFollow(
    resolveDeploymentPath(required(values, "OPEN_SCIENCE_EVIMED_API_KEY_HOST_FILE"), envFile),
    { privateFile: true, maxBytes: 8 * 1024 },
  ).replace(/\r?\n$/, "");
  if (!evimedApiKey || /[\r\n\0]/.test(evimedApiKey)) {
    throw failure("preflight_evimed_api_key", "The EviMed API key file must contain one non-empty credential.");
  }
  if (boolValue(values.OPEN_SCIENCE_ENABLE_KERNEL) && values.OPEN_SCIENCE_KERNEL_SANDBOX_MODE !== "docker") {
    throw failure("preflight_kernel_boundary", "Enabled production kernels must use the Docker sandbox.");
  }

  const minFreeBytes = positiveInteger(
    values.OPEN_SCIENCE_PREFLIGHT_MIN_FREE_BYTES,
    "OPEN_SCIENCE_PREFLIGHT_MIN_FREE_BYTES",
    DEFAULT_MIN_FREE_BYTES,
  );
  if (minFreeBytes < 1024 * 1024 * 1024) {
    throw failure("preflight_disk_floor", "Host preflight free-space floor must be at least 1 GiB.");
  }

  return {
    alertDeliveryProbeEnabled,
    apiPort,
    authMode,
    bootstrapPasswordFile:
      authMode === "local" ? resolveDeploymentPath(values.OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE, envFile) : "",
    backupMode,
    buildCreated,
    caddyImage,
    caddyVersion,
    dataVolume,
    deploymentProfile,
    dockerSocketGid,
    manifestFile,
    minFreeBytes,
    monitoringEnabled,
    objectStorageProbeEnabled: Boolean(objectStorageUri),
    objectStorageUri,
    publicUrl,
    releaseId,
    runtimeEgress,
    runtimeImage,
    sourceRevision,
    trustProxy,
    webImage,
  };
}

export function buildComposeArgs(config, envFile) {
  const files = [path.join(repoRoot, "deploy/web/docker-compose.yml")];
  const profiles = ["tls"];
  if (config.authMode === "local") files.push(path.join(repoRoot, "deploy/web/docker-compose.local-auth.yml"));
  else if (config.authMode === "oidc") files.push(path.join(repoRoot, "deploy/web/docker-compose.oidc.yml"));
  if (config.deploymentProfile === "individual-saas") {
    files.push(path.join(repoRoot, "deploy/web/docker-compose.saas.yml"));
  }
  if (config.backupMode === "local") {
    files.push(path.join(repoRoot, "deploy/web/docker-compose.backup.yml"));
    profiles.push("backup");
  }
  if (config.monitoringEnabled) {
    files.push(path.join(repoRoot, "deploy/web/docker-compose.monitoring.yml"));
    profiles.push("monitoring");
  }
  const args = ["compose", "--env-file", envFile];
  for (const file of files) args.push("-f", file);
  for (const profile of profiles) args.push("--profile", profile);
  args.push("config", "--quiet");
  return args;
}

function defaultExecute(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw failure("preflight_command_unavailable", `${path.basename(command)} is unavailable or could not start.`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 512);
    throw failure(
      "preflight_command_failed",
      `${path.basename(command)} preflight command failed with exit ${result.status}${detail ? `: ${detail}` : "."}`,
    );
  }
  return result.stdout.trim();
}

function parseImageInfo(output, expectedArch, label) {
  const [id, os, architecture] = output.trim().split("|");
  if (!/^sha256:[a-f0-9]{64}$/i.test(id ?? "") || os !== "linux") {
    throw failure("preflight_image_invalid", `${label} image metadata is invalid or not Linux.`);
  }
  if (normalizeArch(architecture ?? "") !== expectedArch) {
    throw failure("preflight_image_arch", `${label} image architecture does not match the Docker server.`);
  }
}

function availableBytes(stat) {
  const blocks = typeof stat.bavail === "bigint" ? stat.bavail : BigInt(stat.bavail);
  const blockSize = typeof stat.bsize === "bigint" ? stat.bsize : BigInt(stat.bsize);
  return blocks * blockSize;
}

async function fetchWithTimeout(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(url, { redirect: "error", signal: controller.signal });
    if (response.url && new URL(response.url).origin !== url.origin) {
      throw failure("preflight_online_origin", `${url.pathname} escaped the configured public origin.`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(fetchImpl, url, releaseId) {
  const response = await fetchWithTimeout(fetchImpl, url);
  if (!response.ok) throw failure("preflight_online_http", `${url.pathname} returned HTTP ${response.status}.`);
  const body = await response.json();
  if (body?.data?.ok !== true) throw failure("preflight_online_body", `${url.pathname} did not report ok.`);
  const reportedReleaseId = body.data.releaseId ?? body.data.checks?.release?.releaseId;
  if (reportedReleaseId !== releaseId) {
    throw failure("preflight_online_release", `${url.pathname} does not report the configured release id.`);
  }
  return { response, body };
}

async function verifyOnline(config, fetchImpl) {
  const base = config.publicUrl.origin;
  const rootResponse = await fetchWithTimeout(fetchImpl, new URL("/", base));
  if (!rootResponse.ok || !(rootResponse.headers.get("content-type") ?? "").includes("text/html")) {
    throw failure("preflight_online_frontend", "The public HTTPS origin did not serve the Web frontend.");
  }
  for (const name of ["content-security-policy", "strict-transport-security", "x-content-type-options"]) {
    if (!rootResponse.headers.get(name)) {
      throw failure("preflight_online_headers", `The public HTTPS response is missing ${name}.`);
    }
  }
  const health = await fetchJson(fetchImpl, new URL("/api/health", base), config.releaseId);
  const ready = await fetchJson(fetchImpl, new URL("/api/ready", base), config.releaseId);
  if (ready.body?.data?.checks?.release?.ok !== true || ready.body?.data?.checks?.security?.ok !== true) {
    throw failure("preflight_online_readiness", "Public readiness did not pass release and security checks.");
  }
  return { health: health.body.data, readiness: ready.body.data };
}

export async function runHostPreflight({
  envFile,
  online = false,
  processEnv = process.env,
  platform = process.platform,
  execute = defaultExecute,
  stat = fs.statSync,
  statfs = fs.statfsSync,
  readLsm = readHostLsmList,
  fetchImpl = fetch,
  onCheck = () => {},
} = {}) {
  validateDeepSeekCompatibilityTool();
  onCheck("deepseek-compatibility-tool", "file-keyed compatibility command available; live probe not executed");
  const resolvedEnvFile = path.resolve(envFile ?? path.join(repoRoot, "deploy/web/.env"));
  const fileValues = parseEnvFile(readRegularFileNoFollow(resolvedEnvFile, { privateFile: true }));
  const values = normalizeScriptPaths({ ...fileValues, ...processEnv }, resolvedEnvFile);
  const config = validateDeploymentConfig(values, resolvedEnvFile);
  onCheck("deployment-config", "production configuration and private env file");

  if (platform !== "linux") {
    throw failure("preflight_host_os", `Production host preflight must run on Linux; found ${platform}.`);
  }
  onCheck("host-os", "linux");

  let dockerSocketStat;
  try {
    dockerSocketStat = stat("/var/run/docker.sock");
  } catch {
    throw failure("preflight_docker_socket", "/var/run/docker.sock is unavailable on the deployment host.");
  }
  validateDockerSocketStat(dockerSocketStat, config.dockerSocketGid);
  onCheck("docker-socket", `group ${config.dockerSocketGid} with group read/write access`);

  const commandOptions = { cwd: repoRoot, env: values };
  const engine = parseDockerEngineInfo(
    execute(
      "docker",
      ["version", "--format", "{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}"],
      commandOptions,
    ),
  );
  onCheck("docker-engine", `${engine.version} linux/${engine.architecture}`);

  // V13: the sandbox backend's host prerequisites. Read from the kernel rather
  // than assumed, because every other check here passes on a host where the
  // agent cannot run a single command.
  const sandbox = validateSandboxPrerequisites(
    execute("uname", ["-r"], commandOptions),
    // Injected like `stat` and `statfs` above, so a test can describe a host it
    // is not running on. An unreadable `/sys/kernel/security/lsm` means
    // securityfs is not mounted, which is itself the answer.
    readLsm(),
  );
  onCheck("sandbox-backend", `landlock available on kernel ${sandbox.kernel}`);

  const composeVersion = execute("docker", ["compose", "version", "--short"], commandOptions);
  if (!/^v?\d+\.\d+(?:\.\d+)?/.test(composeVersion)) {
    throw failure("preflight_compose_version", "Docker Compose returned an invalid version.");
  }
  onCheck("docker-compose", composeVersion);

  const dockerRoot = execute("docker", ["info", "--format", "{{.DockerRootDir}}"], commandOptions);
  if (!path.isAbsolute(dockerRoot)) throw failure("preflight_docker_root", "Docker root directory is invalid.");
  const freeBytes = availableBytes(statfs(dockerRoot, { bigint: true }));
  if (freeBytes < BigInt(config.minFreeBytes)) {
    throw failure(
      "preflight_disk_space",
      `Docker storage has less than the required ${config.minFreeBytes} free bytes.`,
    );
  }
  onCheck("docker-storage", `${freeBytes.toString()} bytes free`);

  const imageFormat = "{{.Id}}|{{.Os}}|{{.Architecture}}";
  parseImageInfo(
    execute("docker", ["image", "inspect", "--format", imageFormat, config.webImage], commandOptions),
    engine.architecture,
    "Web",
  );
  parseImageInfo(
    execute("docker", ["image", "inspect", "--format", imageFormat, config.runtimeImage], commandOptions),
    engine.architecture,
    "Runtime",
  );
  parseImageInfo(
    execute("docker", ["image", "inspect", "--format", imageFormat, config.caddyImage], commandOptions),
    engine.architecture,
    "Caddy",
  );
  onCheck("container-images", "Web, Runtime, and Caddy images match host architecture");

  // The runtime image is only used while a job runs, so between jobs no
  // container references it and `docker system prune -a` on a shared host takes
  // it. That happened twice: the image vanished, and nothing said so until
  // somebody submitted work and the platform answered runtime_image_unavailable.
  // A container in the created state is enough to pin it — compose already
  // defines one under the runtime-image profile.
  const runtimeImagePin = execute(
    "docker",
    ["ps", "-a", "--filter", `ancestor=${config.runtimeImage}`, "--format", "{{.Names}}"],
    commandOptions,
  ).trim();
  if (!runtimeImagePin) {
    throw failure(
      "preflight_runtime_image_unpinned",
      `No container references ${config.runtimeImage}, so a host-wide image prune will remove it and the next job will fail with runtime_image_unavailable. `
        + "Create the pin: docker compose --profile runtime-image up --no-build --no-start opencode-runtime-image",
    );
  }
  onCheck("runtime-image-pinned", `referenced by ${runtimeImagePin.split("\n")[0]}`);

  execute("docker", buildComposeArgs(config, resolvedEnvFile), commandOptions);
  onCheck("compose-config", "base, TLS, and selected production overlays");

  const scriptEnv = {
    ...values,
    OPEN_SCIENCE_RELEASE_MANIFEST_FILE: config.manifestFile,
  };
  execute(process.execPath, [path.join(repoRoot, "scripts/ops/configure-production-state.mjs"), "--check"], {
    cwd: repoRoot,
    env: scriptEnv,
  });
  onCheck("production-state-secrets", "private PostgreSQL and Memos connection files");
  if (config.authMode === "local") {
    execute(process.execPath, [path.join(repoRoot, "scripts/ops/configure-local-auth.mjs"), "--check"], {
      cwd: repoRoot,
      env: scriptEnv,
    });
    onCheck("local-auth-secret", "private bootstrap password file");
  }
  execute(
    process.execPath,
    [path.join(repoRoot, "scripts/ops/generate-release-manifest.mjs"), "--check", "--verify-images"],
    { cwd: repoRoot, env: scriptEnv },
  );
  onCheck("release-manifest", "source digests and local image identities");

  if (config.authMode === "oidc") {
    execute(process.execPath, [path.join(repoRoot, "scripts/ops/configure-oidc.mjs"), "--check"], {
      cwd: repoRoot,
      env: scriptEnv,
    });
    onCheck("oidc-secrets", "private client and flow secret files");
  }
  if (config.monitoringEnabled) {
    execute(process.execPath, [path.join(repoRoot, "scripts/ops/configure-monitoring.mjs"), "--check"], {
      cwd: repoRoot,
      env: scriptEnv,
    });
    onCheck("monitoring-secrets", "metrics, Grafana, and Alertmanager files");
  }
  if (config.backupMode === "local") {
    execute(process.execPath, [path.join(repoRoot, "scripts/ops/configure-backup.mjs"), "--check"], {
      cwd: repoRoot,
      env: scriptEnv,
    });
    onCheck("backup-secret", "private encryption passphrase file");
  }
  if (config.objectStorageProbeEnabled) {
    execute(
      process.execPath,
      [path.join(repoRoot, "scripts/ops/object-backup.mjs"), "probe", config.objectStorageUri],
      { cwd: repoRoot, env: scriptEnv },
    );
    onCheck("object-storage", "encrypted write, read-back, integrity, and delete access");
  }

  let onlineEvidence = null;
  if (online) {
    onlineEvidence = await verifyOnline(config, fetchImpl);
    onCheck("public-https", "frontend, health, readiness, security headers, and release identity");
    if (config.alertDeliveryProbeEnabled) {
      execute(
        process.execPath,
        [path.join(repoRoot, "scripts/ops/configure-monitoring.mjs"), "--probe"],
        { cwd: repoRoot, env: scriptEnv },
      );
      onCheck("alert-delivery", "synthetic resolved notification accepted by the configured operator endpoint");
    }
  }

  return {
    ok: true,
    releaseId: config.releaseId,
    publicOrigin: config.publicUrl.origin,
    docker: { version: engine.version, architecture: engine.architecture, composeVersion },
    runtimeEgress: config.runtimeEgress,
    objectStorageProbed: config.objectStorageProbeEnabled,
    alertDeliveryProbed: online && config.alertDeliveryProbeEnabled,
    online: Boolean(onlineEvidence),
  };
}

function parseArgs(argv) {
  const options = { online: false, json: false, envFile: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--online") options.online = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--env-file") {
      options.envFile = argv[index + 1];
      index += 1;
      if (!options.envFile) throw failure("preflight_argument", "--env-file requires a path.");
    } else {
      throw failure("preflight_argument", `Unknown host preflight argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const checks = [];
  const result = await runHostPreflight({
    envFile: options.envFile,
    online: options.online,
    onCheck(name, detail) {
      checks.push({ name, detail });
      if (!options.json) process.stdout.write(`[preflight] PASS ${name}: ${detail}\n`);
    },
  });
  if (options.json) process.stdout.write(`${JSON.stringify({ ...result, checks })}\n`);
  else process.stdout.write("[preflight] production host prerequisites passed\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "preflight_failed"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
