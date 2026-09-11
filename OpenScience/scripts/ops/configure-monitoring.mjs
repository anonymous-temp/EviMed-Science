#!/usr/bin/env node
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
const jsonOutput = process.argv.includes("--json");

function monitoringFiles(directory) {
  return {
    metricsToken: path.join(directory, "operator-metrics-token.txt"),
    prometheusMetricsToken: path.join(directory, "prometheus-operator-metrics-token.txt"),
    grafanaPassword: path.join(directory, "grafana-admin-password.txt"),
    alertmanager: path.join(directory, "alertmanager.json"),
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

function alertmanagerConfig(webhookUrl) {
  return {
    global: { resolve_timeout: "5m" },
    route: {
      receiver: "operator-webhook",
      group_by: ["alertname", "severity"],
      group_wait: "30s",
      group_interval: "5m",
      repeat_interval: "4h",
    },
    receivers: [
      {
        name: "operator-webhook",
        webhook_configs: [
          {
            url: webhookUrl,
            send_resolved: true,
            max_alerts: 20,
            http_config: { follow_redirects: false },
          },
        ],
      },
    ],
  };
}

async function generate() {
  const metricsToken = validateSecret(requiredEnv("OPEN_SCIENCE_OPERATOR_METRICS_TOKEN"), "Metrics token", 32);
  const grafanaPassword = validateSecret(requiredEnv("OPEN_SCIENCE_GRAFANA_ADMIN_PASSWORD"), "Grafana password", 24);
  const webhookUrl = validateWebhook(requiredEnv("OPEN_SCIENCE_ALERT_WEBHOOK_URL"));

  await assertNoSymlinkPath(outputDir, { allowMissingTail: true });
  await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(outputDir);
  await fsp.chmod(outputDir, 0o700);
  await writePrivateFile(files.metricsToken, `${metricsToken}\n`);
  await writePrivateFile(files.prometheusMetricsToken, `${metricsToken}\n`);
  await writePrivateFile(files.grafanaPassword, `${grafanaPassword}\n`);
  await writePrivateFile(files.alertmanager, `${JSON.stringify(alertmanagerConfig(webhookUrl), null, 2)}\n`);
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
async function writeTlsTargets() {
  const raw = process.env.OPEN_SCIENCE_PUBLIC_HEALTH_URL ?? "";
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
  await assertNoSymlinkPath(targetsDir, { allowMissingTail: true });
  await fsp.mkdir(targetsDir, { recursive: true, mode: 0o755 });
  await assertNoSymlinkPath(targetsDir);
  await fsp.writeFile(tlsTargetsFile, `${JSON.stringify([{ targets, labels: { probe: "public-tls" } }], null, 2)}\n`, { mode: 0o644 });
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
  let config;
  try {
    config = JSON.parse(await readFile(secretFiles.alertmanager));
  } catch (err) {
    if (err?.code) throw err;
    fail("alertmanager_config_invalid", "alertmanager.json must contain valid JSON-compatible YAML.");
  }
  const receiver = config?.receivers?.find((item) => item?.name === config?.route?.receiver);
  const webhookUrl = receiver?.webhook_configs?.[0]?.url;
  if (typeof webhookUrl !== "string") fail("alertmanager_receiver_missing", "Alertmanager must route to a webhook receiver.");
  validateWebhook(webhookUrl);
  if (receiver.webhook_configs[0].send_resolved !== true) {
    fail("alertmanager_resolved_disabled", "Alertmanager must notify when alerts resolve.");
  }
  // Present, parseable and shaped like file-SD. A missing file is an error
  // Prometheus reports once per refresh interval and nowhere a person looks.
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
  return { receiverName: receiver.name, webhookUrl, tlsTargets: tlsTargets[0].targets.length };
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
    ["grafanaPassword", 472, -1], ["alertmanager", 65534, 65534]];
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
  if (probeOnly) await probeAlertDelivery(checked);
  const result = {
    ok: true,
    mode: prepareReaders ? "prepare-container-secrets" : probeOnly ? "probe" : checkOnly ? "check" : "generate",
    directory: outputDir,
    files: Object.values(files).map((file) => path.basename(file)),
    ...(readers ? { readers } : {}),
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
