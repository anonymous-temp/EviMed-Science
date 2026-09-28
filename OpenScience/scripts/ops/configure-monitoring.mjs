#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), "../..");
const outputDir = path.resolve(
  process.env.OPEN_SCIENCE_MONITORING_SECRETS_DIR ?? path.join(repoRoot, "deploy/web/secrets"),
);
/** Where Prometheus discovers the deployment-specific probe targets. Not under
 *  `secrets/`: it holds a public URL, and Prometheus reads it as its own user. */
const targetsDir = path.resolve(
  process.env.OPEN_SCIENCE_MONITORING_TARGETS_DIR ?? path.join(repoRoot, "deploy/web/monitoring/targets"),
);
const tlsTargetsFile = path.join(targetsDir, "tls.json");

const checkOnly = process.argv.includes("--check");
const probeOnly = process.argv.includes("--probe");
const prepareReaders = process.argv.includes("--prepare-container-secrets");
/** Rewrite the probe-target list alone, from the environment (`node
 *  --env-file=.env`), without the three secrets a full generation asks for:
 *  the release switch runs it for every release, so the certificate probes
 *  follow `.env` instead of whoever last ran the generator and with what. */
const targetsOnly = process.argv.includes("--targets");
/** Write the alert receiver's credential and Alertmanager's routes to it, and
 *  nothing else: no metrics token, Grafana password or external webhook is
 *  asked for (an external webhook already configured is kept). Idempotent — a
 *  file whose content would not change is not touched, because a running
 *  container still reads the inode it started with — so the release switch
 *  runs it on every release, like `--targets`. As root on Linux it then assigns
 *  the container readers, exactly as `--prepare-container-secrets` does. */
const alertReceiverOnly = process.argv.includes("--alert-receiver");
const jsonOutput = process.argv.includes("--json");

/**
 * Where Alertmanager delivers: the control plane's own receiver
 * (apps/server/src/alertReceiver.mjs), over the compose network. Until
 * 2026-09-28 the only receiver was an operator webhook on the public host,
 * which nginx answered `return 204`: every alert was accepted and dropped.
 */
export const DEFAULT_ALERT_RECEIVER_URL = "http://open-science-web:8787/api/ops/alerts";
/** Where the Alertmanager container reads its bearer credential for it. */
export const ALERT_RECEIVER_CREDENTIALS_FILE = "/run/secrets/alert_receiver_token";
/** The label a synthetic probe alert carries (the integration audit's): routed
 *  to the control plane alone and recorded there as a probe, never pushed. */
export const ALERT_PROBE_MATCHER = 'audit_probe="true"';

function monitoringFiles(directory) {
  return {
    metricsToken: path.join(directory, "operator-metrics-token.txt"),
    prometheusMetricsToken: path.join(directory, "prometheus-operator-metrics-token.txt"),
    grafanaPassword: path.join(directory, "grafana-admin-password.txt"),
    alertmanager: path.join(directory, "alertmanager.json"),
    // One credential, two readers, as for the metrics token: the web container
    // (root) and Alertmanager (65534) each get a 0600 copy they own.
    alertReceiverToken: path.join(directory, "alert-receiver-token.txt"),
    alertmanagerReceiverToken: path.join(directory, "alertmanager-receiver-token.txt"),
  };
}
const files = monitoringFiles(outputDir);

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail("monitoring_secret_missing", `${name} is required.`);
  return value;
}

function validateSecret(value, label, minimumBytes) {
  if (value !== value.trim() || /[\r\n\0]/.test(value)) {
    fail("monitoring_secret_invalid", `${label} must not contain surrounding whitespace, newlines, or NUL bytes.`);
  }
  if (/^(?:replace(?:-with)?|change-?me|example)(?:[-_]|$)/i.test(value)) {
    fail("monitoring_secret_placeholder", `${label} must not use a placeholder value.`);
  }
  if (Buffer.byteLength(value, "utf8") < minimumBytes) {
    fail("monitoring_secret_too_short", `${label} must contain at least ${minimumBytes} UTF-8 bytes.`);
  }
  return value;
}

function validateWebhook(value) {
  if (value.length > 4096 || /[\r\n\0]/.test(value)) {
    fail("alert_webhook_invalid", "OPEN_SCIENCE_ALERT_WEBHOOK_URL is invalid.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("alert_webhook_invalid", "OPEN_SCIENCE_ALERT_WEBHOOK_URL must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail("alert_webhook_invalid", "Alert webhook URLs must use HTTPS without userinfo or fragments.");
  }
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) {
    fail("alert_webhook_local_forbidden", "Alert webhook URLs must not target the local monitoring container.");
  }
  return url.toString();
}

/** The control plane's receiver: reached over the compose network, so plain
 *  http to a service name is what it is; still no userinfo, fragment or
 *  loopback (loopback is Alertmanager's own container). */
function validateReceiverUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("alert_receiver_url_invalid", "OPEN_SCIENCE_ALERT_RECEIVER_URL must be an absolute URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    fail("alert_receiver_url_invalid", "The alert receiver URL must be http(s) without userinfo or fragments.");
  }
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) {
    fail("alert_webhook_local_forbidden", "The alert receiver URL must not target the local monitoring container.");
  }
  return url.toString();
}

async function assertNoSymlinkPath(target, { allowMissingTail = false } = {}) {
  let current = path.resolve(target);
  for (;;) {
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if (err?.code === "ENOENT" && allowMissingTail) {
        const parent = path.dirname(current);
        if (parent === current) return;
        current = parent;
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) fail("monitoring_path_symlink", "Monitoring secret paths must not contain symbolic links.");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** @param {string} file @param {number} [maxBytes] @param {boolean} [secret]
 *  `secret` is the default because every file this module wrote until now was
 *  one. The probe-target list is not: it holds a public URL and Prometheus
 *  reads it as its own container user, so requiring 0600 would make it either
 *  unreadable to the scraper or a secret that is not one. */
async function readRegularFile(file, maxBytes = 16 * 1024, secret = true) {
  await assertNoSymlinkPath(file);
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) fail("monitoring_file_not_regular", `${path.basename(file)} must be a regular file.`);
    if (stat.size > maxBytes) fail("monitoring_file_too_large", `${path.basename(file)} is unexpectedly large.`);
    if (secret && process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      fail("monitoring_file_permissions", `${path.basename(file)} must not be group- or world-accessible.`);
    }
    // World-writable is refused whether or not the file is a secret: anyone who
    // can rewrite this list can point the certificate probe at a host they
    // control and silence the alert.
    if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
      fail("monitoring_file_permissions", `${path.basename(file)} must not be group- or world-writable.`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle?.close();
  }
}

async function writePrivateFile(file, content) {
  const existing = await fsp.lstat(file).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (existing?.isSymbolicLink()) fail("monitoring_path_symlink", "Refusing to replace a symbolic-link secret file.");
  if (existing && !existing.isFile()) fail("monitoring_file_not_regular", "Monitoring secret targets must be regular files.");

  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let handle;
  try {
    handle = await fsp.open(temp, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temp, file);
    await fsp.chmod(file, 0o600);
  } finally {
    await handle?.close();
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

/** A private file rewritten only when its content would change; true when it
 *  was. A running container keeps reading the inode it started with, so an
 *  identical rewrite would leave it on a deleted file for nothing. */
async function writePrivateFileIfChanged(file, content) {
  const existing = await readRegularFile(file).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (existing === content) return false;
  await writePrivateFile(file, content);
  return true;
}

/**
 * The receiver's shared credential: from the environment when given, else the
 * one already written, else a new random one — so a rerun keeps it.
 * @param {typeof files} secretFiles
 */
async function alertReceiverToken(secretFiles = files) {
  const supplied = process.env.OPEN_SCIENCE_ALERT_RECEIVER_TOKEN ?? "";
  if (supplied) return validateSecret(supplied, "Alert receiver token", 32);
  const existing = await readRegularFile(secretFiles.alertReceiverToken).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (existing != null) return validateSecret(existing.replace(/\r?\n$/, ""), "Alert receiver token", 32);
  return randomBytes(32).toString("base64url");
}

/**
 * Every alert reaches the control plane's receiver, which writes it into the
 * operators' inbox (and Feishu, for an operator who bound it); an operator's
 * external webhook, when one is configured, receives the same alerts beside
 * it. The integration audit's probe alert (`audit_probe="true"`) goes to the
 * control plane alone, so a check never pages a person.
 * @param {{ receiverUrl: string, externalUrl?: string | null }} targets
 */
export function alertmanagerConfig({ receiverUrl, externalUrl = null }) {
  const controlPlane = {
    url: receiverUrl,
    send_resolved: true,
    max_alerts: 20,
    http_config: {
      follow_redirects: false,
      authorization: { type: "Bearer", credentials_file: ALERT_RECEIVER_CREDENTIALS_FILE },
    },
  };
  return {
    global: { resolve_timeout: "5m" },
    route: {
      receiver: "operator-webhook",
      group_by: ["alertname", "severity"],
      group_wait: "30s",
      group_interval: "5m",
      repeat_interval: "4h",
      routes: [{ receiver: "control-plane-probe", matchers: [ALERT_PROBE_MATCHER], group_wait: "5s", group_interval: "1m", repeat_interval: "4h" }],
    },
    receivers: [
      {
        name: "operator-webhook",
        webhook_configs: [
          controlPlane,
          ...(externalUrl ? [{ url: externalUrl, send_resolved: true, max_alerts: 20, http_config: { follow_redirects: false } }] : []),
        ],
      },
      { name: "control-plane-probe", webhook_configs: [controlPlane] },
    ],
  };
}

/** The external webhook an existing configuration already names, if any. */
async function existingExternalWebhook(secretFiles = files) {
  let config;
  try {
    config = JSON.parse(await readRegularFile(secretFiles.alertmanager));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    if (err?.code) throw err;
    fail("alertmanager_config_invalid", "alertmanager.json must contain valid JSON-compatible YAML.");
  }
  const receiver = config?.receivers?.find((item) => item?.name === config?.route?.receiver);
  const external = (receiver?.webhook_configs ?? []).find((hook) => !hook?.http_config?.authorization);
  return typeof external?.url === "string" ? validateWebhook(external.url) : null;
}

/**
 * The receiver's credential files and Alertmanager's configuration, each
 * written only if it changes. Returns the names of the files that changed.
 * @param {{ externalUrl?: string | null, secretFiles?: typeof files }} [options]
 */
export async function writeAlertReceiver({ externalUrl, secretFiles = files } = {}) {
  const directory = path.dirname(secretFiles.alertmanager);
  await assertNoSymlinkPath(directory, { allowMissingTail: true });
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(directory);
  const token = await alertReceiverToken(secretFiles);
  const receiverUrl = validateReceiverUrl(process.env.OPEN_SCIENCE_ALERT_RECEIVER_URL || DEFAULT_ALERT_RECEIVER_URL);
  const external = externalUrl === undefined
    ? (process.env.OPEN_SCIENCE_ALERT_WEBHOOK_URL ? validateWebhook(process.env.OPEN_SCIENCE_ALERT_WEBHOOK_URL) : await existingExternalWebhook(secretFiles))
    : externalUrl;
  const changed = [];
  for (const [key, content] of [
    ["alertReceiverToken", `${token}\n`],
    ["alertmanagerReceiverToken", `${token}\n`],
    ["alertmanager", `${JSON.stringify(alertmanagerConfig({ receiverUrl, externalUrl: external }), null, 2)}\n`],
  ]) {
    if (await writePrivateFileIfChanged(secretFiles[key], content)) changed.push(path.basename(secretFiles[key]));
  }
  return changed;
}

async function generate() {
  const metricsToken = validateSecret(requiredEnv("OPEN_SCIENCE_OPERATOR_METRICS_TOKEN"), "Metrics token", 32);
  const grafanaPassword = validateSecret(requiredEnv("OPEN_SCIENCE_GRAFANA_ADMIN_PASSWORD"), "Grafana password", 24);
  // Optional since 2026-09-28: the control plane's own receiver is always
  // configured; an operator webhook, when named, receives the alerts too.
  const webhookUrl = process.env.OPEN_SCIENCE_ALERT_WEBHOOK_URL ? validateWebhook(process.env.OPEN_SCIENCE_ALERT_WEBHOOK_URL) : null;

  await assertNoSymlinkPath(outputDir, { allowMissingTail: true });
  await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(outputDir);
  await fsp.chmod(outputDir, 0o700);
  await writePrivateFile(files.metricsToken, `${metricsToken}\n`);
  await writePrivateFile(files.prometheusMetricsToken, `${metricsToken}\n`);
  await writePrivateFile(files.grafanaPassword, `${grafanaPassword}\n`);
  await writeAlertReceiver({ externalUrl: webhookUrl });
  await writeTlsTargets();
}

/**
 * The public origin whose certificate the expiry alert watches.
 *
 * Optional, and absent means an empty target list rather than a failure: a
 * deployment that terminates TLS somewhere this host cannot reach has nothing
 * to probe, and refusing to configure monitoring at all over that would be a
 * worse outcome than no certificate alert. An empty file is also what makes the
 * scrape job legal — Prometheus treats a missing file-SD file as an error it
 * reports every refresh interval.
 */
/**
 * The two probe groups the environment asks for: the public origin's health
 * URL, and the Tokyo proxy as host:port.
 * @param {Record<string, string | undefined>} env
 * @returns {{ targets: string[], edge: string[] }}
 */
export function tlsTargetsFromEnv(env) {
  const raw = env.OPEN_SCIENCE_PUBLIC_HEALTH_URL ?? "";
  const targets = [];
  if (raw) {
    let url;
    try { url = new URL(raw); } catch {
      fail("public_health_url_invalid", "OPEN_SCIENCE_PUBLIC_HEALTH_URL is not a URL.");
    }
    // https only: the metric this exists for is the certificate's expiry, and
    // an http target simply never produces one — which would read as "the
    // certificate is fine" forever.
    if (url.protocol !== "https:") {
      fail("public_health_url_insecure", "OPEN_SCIENCE_PUBLIC_HEALTH_URL must be an https URL; a plain-http target reports no certificate expiry at all.");
    }
    targets.push(url.toString());
  }
  // The Tokyo proxy's IP certificate (plan §10.5.8): a TLS handshake only,
  // as host:port, in a second group its own scrape job keeps. It lives six
  // days and renews twice a day, so its alert line is a day, not three.
  const edge = [];
  const edgeRaw = env.OPEN_SCIENCE_EDGE_PROXY_URL ?? "";
  if (edgeRaw) {
    let url;
    try { url = new URL(edgeRaw); } catch {
      fail("edge_proxy_url_invalid", "OPEN_SCIENCE_EDGE_PROXY_URL is not a URL.");
    }
    if (url.protocol !== "https:") fail("edge_proxy_url_insecure", "OPEN_SCIENCE_EDGE_PROXY_URL must be an https URL.");
    edge.push(`${url.hostname}:${url.port || "443"}`);
  }
  return { targets, edge };
}

async function writeTlsTargets() {
  const { targets, edge } = tlsTargetsFromEnv(process.env);
  await assertNoSymlinkPath(targetsDir, { allowMissingTail: true });
  await fsp.mkdir(targetsDir, { recursive: true, mode: 0o755 });
  await assertNoSymlinkPath(targetsDir);
  await fsp.writeFile(tlsTargetsFile, `${JSON.stringify([{ targets, labels: { probe: "public-tls" } },
    { targets: edge, labels: { probe: "edge-proxy-tls" } }], null, 2)}\n`, { mode: 0o644 });
  // `mode` on writeFile applies only when the file is created, so a file that
  // already exists keeps whatever mode it had — and this one is checked in, so
  // on a host whose umask is 002 the checkout is group-writable and `check()`
  // rejects the generator's own output. The secret writer above chmods for the
  // same reason.
  await fsp.chmod(tlsTargetsFile, 0o644);
}

async function check(secretFiles = files, targetsFile = tlsTargetsFile, readFile = readRegularFile) {
  await assertNoSymlinkPath(path.dirname(secretFiles.metricsToken));
  const metricsToken = (await readFile(secretFiles.metricsToken)).replace(/\r?\n$/, "");
  const prometheusMetricsToken = (await readFile(secretFiles.prometheusMetricsToken)).replace(/\r?\n$/, "");
  const grafanaPassword = (await readFile(secretFiles.grafanaPassword)).replace(/\r?\n$/, "");
  validateSecret(metricsToken, "Metrics token", 32);
  validateSecret(prometheusMetricsToken, "Prometheus metrics token", 32);
  if (prometheusMetricsToken !== metricsToken) {
    fail("monitoring_metrics_token_mismatch", "Web and Prometheus metrics token files must contain the same value.");
  }
  validateSecret(grafanaPassword, "Grafana password", 24);
  const receiver = await checkAlertReceiver(secretFiles, readFile);
  const { publicTls } = await checkTlsTargets(targetsFile, readFile);
  return { ...receiver, tlsTargets: publicTls };
}

/**
 * The alert receiver's half of the check: both credential copies agree, and
 * Alertmanager delivers every alert — resolved ones too — to the control
 * plane, with the audit's probe routed there alone.
 * @returns {Promise<{ receiverName: string, receiverUrl: string, webhookUrl: string | null }>}
 */
async function checkAlertReceiver(secretFiles = files, readFile = readRegularFile) {
  const receiverToken = (await readFile(secretFiles.alertReceiverToken)).replace(/\r?\n$/, "");
  const alertmanagerReceiverToken = (await readFile(secretFiles.alertmanagerReceiverToken)).replace(/\r?\n$/, "");
  validateSecret(receiverToken, "Alert receiver token", 32);
  if (alertmanagerReceiverToken !== receiverToken) {
    fail("monitoring_alert_receiver_token_mismatch", "Web and Alertmanager alert-receiver token files must contain the same value.");
  }
  let config;
  try {
    config = JSON.parse(await readFile(secretFiles.alertmanager));
  } catch (err) {
    if (err?.code) throw err;
    fail("alertmanager_config_invalid", "alertmanager.json must contain valid JSON-compatible YAML.");
  }
  const receiver = config?.receivers?.find((item) => item?.name === config?.route?.receiver);
  const hooks = Array.isArray(receiver?.webhook_configs) ? receiver.webhook_configs : [];
  // The control plane's receiver is the one delivery every alert must have:
  // authenticated with the credential file, resolved notices included.
  const controlPlane = hooks.find((hook) => hook?.http_config?.authorization?.credentials_file === ALERT_RECEIVER_CREDENTIALS_FILE);
  if (!controlPlane || typeof controlPlane.url !== "string") {
    fail("alertmanager_receiver_missing", "Alertmanager must deliver every alert to the control plane's alert receiver; run configure:monitoring --alert-receiver.");
  }
  const receiverUrl = validateReceiverUrl(controlPlane.url);
  const external = hooks.filter((hook) => hook !== controlPlane);
  for (const hook of external) validateWebhook(String(hook?.url ?? ""));
  if (hooks.some((hook) => hook?.send_resolved !== true)) {
    fail("alertmanager_resolved_disabled", "Alertmanager must notify when alerts resolve.");
  }
  const probeRoute = (config?.route?.routes ?? []).find((route) => (route?.matchers ?? []).includes(ALERT_PROBE_MATCHER));
  const probeReceiver = config?.receivers?.find((item) => item?.name === probeRoute?.receiver);
  if (!probeReceiver || (probeReceiver.webhook_configs ?? []).some((hook) => hook?.url !== receiverUrl)) {
    fail("alertmanager_probe_route_invalid", "The audit probe must be routed to the control plane's receiver alone.");
  }
  return { receiverName: receiver.name, receiverUrl, webhookUrl: external[0]?.url ?? null };
}

/**
 * The probe-target list is present, parseable, shaped like file-SD, and
 * probes what the environment names.
 *
 * The last clause is the one that was missing (2026-09-26, platform audit
 * I3-1): production's `.env` named the public health URL, the list had been
 * generated without it, and the certificate-expiry alert had no series to fire
 * on — a check that only read the file's shape passed it for days. A variable
 * the environment does not set is not asked about: this runs in contexts that
 * load no `.env`.
 * @returns {Promise<{ publicTls: number, edgeTls: number }>}
 */
async function checkTlsTargets(targetsFile = tlsTargetsFile, readFile = readRegularFile) {
  // A missing file is an error Prometheus reports once per refresh interval
  // and nowhere a person looks.
  let tlsTargets;
  try {
    tlsTargets = JSON.parse(await readFile(targetsFile, 16 * 1024, false));
  } catch (err) {
    if (err?.code === "monitoring_file_missing" || err?.code === "ENOENT") {
      fail("tls_targets_missing", "monitoring/targets/tls.json is missing; run configure:monitoring.");
    }
    if (err?.code) throw err;
    fail("tls_targets_invalid", "monitoring/targets/tls.json must contain valid JSON.");
  }
  if (!Array.isArray(tlsTargets) || !Array.isArray(tlsTargets[0]?.targets)) {
    fail("tls_targets_invalid", "monitoring/targets/tls.json must be a Prometheus file-SD target list.");
  }
  for (const target of tlsTargets[0].targets) {
    if (!String(target).startsWith("https://")) {
      fail("tls_targets_insecure", "Certificate-expiry probe targets must be https URLs.");
    }
  }
  const group = (probe) => tlsTargets.find((entry) => entry?.labels?.probe === probe)?.targets ?? [];
  const expected = tlsTargetsFromEnv(process.env);
  for (const [probe, want, variable] of [["public-tls", expected.targets, "OPEN_SCIENCE_PUBLIC_HEALTH_URL"], ["edge-proxy-tls", expected.edge, "OPEN_SCIENCE_EDGE_PROXY_URL"]]) {
    const have = group(probe);
    if (want.length && (have.length !== want.length || want.some((target) => !have.includes(target)))) {
      fail("tls_targets_stale", `monitoring/targets/tls.json does not probe the ${variable} the environment names; run configure:monitoring --targets.`);
    }
  }
  return { publicTls: group("public-tls").length, edgeTls: group("edge-proxy-tls").length };
}

/** Prepare existing 0600 bind-mounted files for their fixed container readers.
 * Run explicitly as the Linux host operator after generation and before Compose.
 * Grafana retains its existing file group: UID 472 alone is the image contract.
 * This never rewrites credentials or changes a data directory's ownership. */
export async function prepareContainerSecrets({
  directory = outputDir,
  targetsFile = tlsTargetsFile,
  platform = process.platform,
  uid = process.getuid?.(),
  openFile = fsp.open,
} = {}) {
  if (platform !== "linux" || uid !== 0) {
    fail("monitoring_prepare_requires_root_linux", "Preparing container secret readers requires the Linux host operator (UID 0).");
  }
  const secretFiles = monitoringFiles(path.resolve(directory));
  const readers = [["metricsToken", 0, 0], ["prometheusMetricsToken", 65534, 65534],
    ["grafanaPassword", 472, -1], ["alertmanager", 65534, 65534],
    ["alertReceiverToken", 0, 0], ["alertmanagerReceiverToken", 65534, 65534]];
  const opened = new Map();
  const assertMetadata = (stat) => {
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 16 * 1024) {
      fail("monitoring_prepare_file_invalid", "Container secret files must be nonempty, regular, and have one link.");
    }
    if ((stat.mode & 0o7777) !== 0o600) {
      fail("monitoring_file_permissions", "Container secret files must retain exact mode 0600.");
    }
  };
  try {
    for (const file of Object.values(secretFiles)) {
      await assertNoSymlinkPath(file);
      const handle = await openFile(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      opened.set(file, { handle });
      const before = await handle.stat();
      assertMetadata(before);
      const bytes = Buffer.alloc(before.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      if (bytesRead !== bytes.length || before.dev !== after.dev || before.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        fail("monitoring_prepare_file_changed", "A container secret changed while being validated.");
      }
      opened.set(file, { handle, bytes, before });
    }
    // Complete all content validation before assigning any reader.
    await check(secretFiles, targetsFile, async (file, ...options) => (
      opened.has(file) ? opened.get(file).bytes.toString("utf8") : readRegularFile(file, ...options)
    ));
    const prepared = [];
    for (const [key, readerUid, readerGid] of readers) {
      const file = secretFiles[key];
      const { handle, bytes, before } = opened.get(file);
      const current = await fsp.lstat(file);
      const held = await handle.stat();
      if (current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()
          || held.mtimeMs !== before.mtimeMs || held.ctimeMs !== before.ctimeMs || held.size !== before.size) {
        fail("monitoring_prepare_file_changed", "A container secret changed before its reader was assigned.");
      }
      await handle.chown(readerUid, readerGid);
      const after = await handle.stat();
      assertMetadata(after);
      const preserved = Buffer.alloc(bytes.length);
      const { bytesRead } = await handle.read(preserved, 0, preserved.length, 0);
      if (after.uid !== readerUid || after.gid !== (readerGid === -1 ? before.gid : readerGid)
          || bytesRead !== bytes.length || !preserved.equals(bytes)) {
        fail("monitoring_prepare_verification_failed", "Container reader preparation did not preserve the private file contract.");
      }
      prepared.push({ file: path.basename(file), uid: after.uid, gid: after.gid, mode: "0600" });
    }
    await check(secretFiles, targetsFile);
    return prepared;
  } finally {
    await Promise.allSettled([...opened.values()].map(({ handle }) => handle.close()));
  }
}

export async function probeAlertDelivery({ webhookUrl, receiverName, fetchImpl = fetch }) {
  const target = validateWebhook(webhookUrl);
  const now = new Date();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const payload = {
    version: "4",
    groupKey: "{}:{alertname=\"OpenScienceDeploymentPreflight\"}",
    truncatedAlerts: 0,
    status: "resolved",
    receiver: receiverName,
    groupLabels: { alertname: "OpenScienceDeploymentPreflight" },
    commonLabels: {
      alertname: "OpenScienceDeploymentPreflight",
      severity: "info",
      service: "open-science-web",
    },
    commonAnnotations: {
      summary: "EviMed deployment notification preflight",
      description: "Synthetic resolved notification used to verify the operator alert delivery endpoint.",
    },
    externalURL: process.env.OPEN_SCIENCE_PUBLIC_URL ?? "",
    alerts: [
      {
        status: "resolved",
        labels: {
          alertname: "OpenScienceDeploymentPreflight",
          severity: "info",
          service: "open-science-web",
        },
        annotations: {
          summary: "EviMed deployment notification preflight",
          description: "Synthetic resolved notification used to verify the operator alert delivery endpoint.",
        },
        startsAt: new Date(now.getTime() - 60_000).toISOString(),
        endsAt: now.toISOString(),
        generatorURL: process.env.OPEN_SCIENCE_PUBLIC_URL ?? "",
        fingerprint: "open-science-deployment-preflight",
      },
    ],
  };
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "user-agent": "open-science-host-preflight" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      fail("alert_delivery_probe_http", `Alert delivery endpoint returned HTTP ${response.status}.`);
    }
  } catch (error) {
    if (error?.code) throw error;
    if (error?.name === "AbortError") {
      fail("alert_delivery_probe_timeout", "Alert delivery endpoint did not respond before the timeout.");
    }
    fail("alert_delivery_probe_failed", "Alert delivery endpoint could not be reached successfully.");
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, receiverName };
}

async function main() {
  if (targetsOnly) {
    if (checkOnly || probeOnly || prepareReaders) fail("monitoring_mode_conflict", "The probe-target list must be written on its own.");
    await writeTlsTargets();
    const counts = await checkTlsTargets();
    const result = { ok: true, mode: "targets", file: tlsTargetsFile, ...counts };
    process.stdout.write(jsonOutput ? `${JSON.stringify(result)}\n`
      : `monitoring probe targets written: ${counts.publicTls} public, ${counts.edgeTls} edge proxy (${tlsTargetsFile})\n`);
    return;
  }
  if (alertReceiverOnly) {
    if (checkOnly || probeOnly || prepareReaders) fail("monitoring_mode_conflict", "The alert receiver must be written on its own.");
    const changed = await writeAlertReceiver();
    // Root on Linux is how the release switch runs it: the files it rewrote
    // are given back to their container readers, or Alertmanager (65534)
    // could not read its own configuration.
    const readers = process.platform === "linux" && process.getuid?.() === 0 ? await prepareContainerSecrets() : null;
    if (!readers) await checkAlertReceiver();
    const result = { ok: true, mode: "alert-receiver", directory: outputDir, changed, readersPrepared: Boolean(readers) };
    process.stdout.write(jsonOutput ? `${JSON.stringify(result)}\n`
      : `alert receiver ${changed.length ? `written (${changed.join(", ")})` : "unchanged"}: ${outputDir}\n`);
    return;
  }
  let checked;
  let readers;
  if (prepareReaders) {
    if (checkOnly || probeOnly) fail("monitoring_mode_conflict", "Container secret preparation must be requested on its own.");
    readers = await prepareContainerSecrets();
  } else if (checkOnly || probeOnly) checked = await check();
  else {
    await generate();
    checked = await check();
  }
  // The control plane's receiver is not reachable from the host by its compose
  // name; the integration audit probes it end to end through Alertmanager.
  // What is probed here is the operator's external webhook, when there is one.
  const probed = probeOnly && checked?.webhookUrl ? await probeAlertDelivery(checked) : null;
  const result = {
    ok: true,
    mode: prepareReaders ? "prepare-container-secrets" : probeOnly ? "probe" : checkOnly ? "check" : "generate",
    directory: outputDir,
    files: Object.values(files).map((file) => path.basename(file)),
    ...(readers ? { readers } : {}),
    ...(probeOnly ? { externalWebhookProbed: Boolean(probed) } : {}),
  };
  process.stdout.write(jsonOutput ? `${JSON.stringify(result)}\n` : `monitoring configuration ${result.mode} ok: ${outputDir}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  main().catch((err) => {
    const code = err?.code ?? "monitoring_configuration_failed";
    const message = err instanceof Error ? err.message : String(err);
    if (jsonOutput) process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    else process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  });
}
