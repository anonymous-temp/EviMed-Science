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
const checkOnly = process.argv.includes("--check");
const probeOnly = process.argv.includes("--probe");
const jsonOutput = process.argv.includes("--json");

const files = {
  metricsToken: path.join(outputDir, "operator-metrics-token.txt"),
  grafanaPassword: path.join(outputDir, "grafana-admin-password.txt"),
  alertmanager: path.join(outputDir, "alertmanager.json"),
};

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
  while (true) {
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
    return;
  }
}

async function readRegularFile(file, maxBytes = 16 * 1024) {
  await assertNoSymlinkPath(file);
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) fail("monitoring_file_not_regular", `${path.basename(file)} must be a regular file.`);
    if (stat.size > maxBytes) fail("monitoring_file_too_large", `${path.basename(file)} is unexpectedly large.`);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      fail("monitoring_file_permissions", `${path.basename(file)} must not be group- or world-accessible.`);
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
  await writePrivateFile(files.grafanaPassword, `${grafanaPassword}\n`);
  await writePrivateFile(files.alertmanager, `${JSON.stringify(alertmanagerConfig(webhookUrl), null, 2)}\n`);
}

async function check() {
  await assertNoSymlinkPath(outputDir);
  const metricsToken = (await readRegularFile(files.metricsToken)).replace(/\r?\n$/, "");
  const grafanaPassword = (await readRegularFile(files.grafanaPassword)).replace(/\r?\n$/, "");
  validateSecret(metricsToken, "Metrics token", 32);
  validateSecret(grafanaPassword, "Grafana password", 24);
  let config;
  try {
    config = JSON.parse(await readRegularFile(files.alertmanager));
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
  return { receiverName: receiver.name, webhookUrl };
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
  if (checkOnly || probeOnly) checked = await check();
  else {
    await generate();
    checked = await check();
  }
  if (probeOnly) await probeAlertDelivery(checked);
  const result = {
    ok: true,
    mode: probeOnly ? "probe" : checkOnly ? "check" : "generate",
    directory: outputDir,
    files: Object.values(files).map((file) => path.basename(file)),
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
