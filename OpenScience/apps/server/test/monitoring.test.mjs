import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { probeAlertDelivery } from "../../../scripts/ops/configure-monitoring.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/configure-monitoring.mjs");

function runMonitoring(outputDir, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPEN_SCIENCE_MONITORING_SECRETS_DIR: outputDir,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

const validEnv = {
  OPEN_SCIENCE_OPERATOR_METRICS_TOKEN: "metrics-token-generated-for-monitoring-tests-123456",
  OPEN_SCIENCE_GRAFANA_ADMIN_PASSWORD: "grafana-password-generated-for-tests-123456",
  OPEN_SCIENCE_ALERT_WEBHOOK_URL: "https://alerts.example.com/hooks/open-science?token=secret",
};

test("monitoring alert probe sends a bounded synthetic resolved notification", async () => {
  let request;
  const result = await probeAlertDelivery({
    webhookUrl: validEnv.OPEN_SCIENCE_ALERT_WEBHOOK_URL,
    receiverName: "operator-webhook",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(result, { ok: true, receiverName: "operator-webhook" });
  assert.equal(request.url.includes("token=secret"), true);
  assert.equal(request.options.method, "POST");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.status, "resolved");
  assert.equal(payload.alerts[0].labels.alertname, "OpenScienceDeploymentPreflight");
  assert.equal(payload.alerts[0].status, "resolved");
});

test("monitoring alert probe fails closed on rejected delivery", async () => {
  await assert.rejects(
    probeAlertDelivery({
      webhookUrl: validEnv.OPEN_SCIENCE_ALERT_WEBHOOK_URL,
      receiverName: "operator-webhook",
      fetchImpl: async () => new Response(null, { status: 503 }),
    }),
    { code: "alert_delivery_probe_http" },
  );
});

test("monitoring configuration generator writes private validated secrets", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-monitoring-"));
  const outputDir = path.join(tmp, "secrets");
  try {
    const generated = await runMonitoring(outputDir, ["--json"], validEnv);
    const result = JSON.parse(generated.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.mode, "generate");
    assert.equal(generated.stdout.includes(validEnv.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN), false);
    assert.equal(generated.stdout.includes("token=secret"), false);

    const tokenFile = path.join(outputDir, "operator-metrics-token.txt");
    const prometheusTokenFile = path.join(outputDir, "prometheus-operator-metrics-token.txt");
    const passwordFile = path.join(outputDir, "grafana-admin-password.txt");
    const alertmanagerFile = path.join(outputDir, "alertmanager.json");
    assert.equal((await readFile(tokenFile, "utf8")).trim(), validEnv.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN);
    assert.equal((await readFile(prometheusTokenFile, "utf8")).trim(), validEnv.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN);
    assert.equal((await readFile(passwordFile, "utf8")).trim(), validEnv.OPEN_SCIENCE_GRAFANA_ADMIN_PASSWORD);
    const alertmanager = JSON.parse(await readFile(alertmanagerFile, "utf8"));
    assert.equal(alertmanager.route.receiver, "operator-webhook");
    assert.equal(alertmanager.receivers[0].webhook_configs[0].url, validEnv.OPEN_SCIENCE_ALERT_WEBHOOK_URL);
    assert.equal(alertmanager.receivers[0].webhook_configs[0].send_resolved, true);

    if (process.platform !== "win32") {
      assert.equal((await lstat(outputDir)).mode & 0o077, 0);
      for (const file of [tokenFile, prometheusTokenFile, passwordFile, alertmanagerFile]) {
        assert.equal((await lstat(file)).mode & 0o077, 0);
      }
    }

    const checked = await runMonitoring(outputDir, ["--check", "--json"]);
    assert.deepEqual(JSON.parse(checked.stdout), {
      ok: true,
      mode: "check",
      directory: outputDir,
      files: [
        "operator-metrics-token.txt",
        "prometheus-operator-metrics-token.txt",
        "grafana-admin-password.txt",
        "alertmanager.json",
      ],
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("monitoring configuration rejects weak secrets and local alert webhooks", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-monitoring-"));
  try {
    await assert.rejects(
      () => runMonitoring(path.join(tmp, "weak"), [], { ...validEnv, OPEN_SCIENCE_OPERATOR_METRICS_TOKEN: "short" }),
      (err) => {
        assert.match(err.stderr, /monitoring_secret_too_short/);
        return true;
      },
    );
    await assert.rejects(
      () => runMonitoring(path.join(tmp, "local"), [], { ...validEnv, OPEN_SCIENCE_ALERT_WEBHOOK_URL: "https://localhost/hook" }),
      (err) => {
        assert.match(err.stderr, /alert_webhook_local_forbidden/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("monitoring configuration refuses symbolic-link paths", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-monitoring-"));
  const realDir = path.join(tmp, "real-secrets");
  const linkedDir = path.join(tmp, "secrets");
  await mkdir(realDir);
  await symlink(realDir, linkedDir);
  try {
    await assert.rejects(
      () => runMonitoring(linkedDir, [], validEnv),
      (err) => {
        assert.match(err.stderr, /monitoring_path_symlink/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("monitoring check rejects group-readable secret files", { skip: process.platform === "win32" }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-monitoring-"));
  const outputDir = path.join(tmp, "secrets");
  try {
    await runMonitoring(outputDir, [], validEnv);
    await chmod(path.join(outputDir, "operator-metrics-token.txt"), 0o640);
    await assert.rejects(
      () => runMonitoring(outputDir, ["--check"]),
      (err) => {
        assert.match(err.stderr, /monitoring_file_permissions/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
