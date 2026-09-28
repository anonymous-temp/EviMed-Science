import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareContainerSecrets, probeAlertDelivery } from "../../../scripts/ops/configure-monitoring.mjs";

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
          OPEN_SCIENCE_MONITORING_TARGETS_DIR: path.join(path.dirname(outputDir), "targets"),
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

async function temporaryDirectory() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-monitoring-")));
}

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
  const tmp = await temporaryDirectory();
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
    const [controlPlane, external] = alertmanager.receivers[0].webhook_configs;
    assert.equal(controlPlane.url, "http://open-science-web:8787/api/ops/alerts", "every alert reaches the control plane's receiver");
    assert.deepEqual(controlPlane.http_config.authorization, { type: "Bearer", credentials_file: "/run/secrets/alert_receiver_token" });
    assert.equal(external.url, validEnv.OPEN_SCIENCE_ALERT_WEBHOOK_URL, "and the operator's own webhook beside it");
    for (const hook of alertmanager.receivers[0].webhook_configs) assert.equal(hook.send_resolved, true);
    const receiverTokenFile = path.join(outputDir, "alert-receiver-token.txt");
    const alertmanagerTokenFile = path.join(outputDir, "alertmanager-receiver-token.txt");
    const receiverToken = (await readFile(receiverTokenFile, "utf8")).trim();
    assert.ok(receiverToken.length >= 32);
    assert.equal((await readFile(alertmanagerTokenFile, "utf8")).trim(), receiverToken);
    assert.equal(generated.stdout.includes(receiverToken), false);

    if (process.platform !== "win32") {
      assert.equal((await lstat(outputDir)).mode & 0o077, 0);
      for (const file of [tokenFile, prometheusTokenFile, passwordFile, alertmanagerFile, receiverTokenFile, alertmanagerTokenFile]) {
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
        "alert-receiver-token.txt",
        "alertmanager-receiver-token.txt",
      ],
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("the alert receiver is written on its own, keeps what is configured, and touches nothing unchanged", async () => {
  // Until 2026-09-28 the only receiver was an operator webhook nginx answered
  // with 204: every alert was accepted and dropped. The release switch runs
  // this mode on every release, so a rerun must leave identical files alone —
  // a running Alertmanager keeps reading the inode it started with.
  const tmp = await temporaryDirectory();
  const outputDir = path.join(tmp, "secrets");
  try {
    await runMonitoring(outputDir, [], validEnv);
    const alertmanagerFile = path.join(outputDir, "alertmanager.json");
    const tokenFile = path.join(outputDir, "alert-receiver-token.txt");
    const before = { config: await lstat(alertmanagerFile), token: await lstat(tokenFile) };
    const again = JSON.parse((await runMonitoring(outputDir, ["--alert-receiver", "--json"], { OPEN_SCIENCE_ALERT_WEBHOOK_URL: "" })).stdout);
    assert.equal(again.mode, "alert-receiver");
    assert.deepEqual(again.changed, [], "nothing to change, nothing rewritten");
    assert.equal((await lstat(alertmanagerFile)).ino, before.config.ino);
    assert.equal((await lstat(tokenFile)).ino, before.token.ino);
    const kept = JSON.parse(await readFile(alertmanagerFile, "utf8"));
    assert.equal(kept.receivers[0].webhook_configs[1].url, validEnv.OPEN_SCIENCE_ALERT_WEBHOOK_URL, "the external webhook already configured is kept");
    const probe = kept.route.routes.find((route) => route.matchers.includes('audit_probe="true"'));
    assert.equal(probe.receiver, "control-plane-probe");
    assert.deepEqual(kept.receivers.find((item) => item.name === "control-plane-probe").webhook_configs.map((hook) => hook.url),
      ["http://open-science-web:8787/api/ops/alerts"], "a probe never reaches a person's webhook");

    // A configuration from before the receiver existed is brought up to date.
    const legacy = { global: {}, route: { receiver: "operator-webhook" }, receivers: [{ name: "operator-webhook", webhook_configs: [
      { url: validEnv.OPEN_SCIENCE_ALERT_WEBHOOK_URL, send_resolved: true, http_config: { follow_redirects: false } }] }] };
    await writeFile(alertmanagerFile, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    await chmod(alertmanagerFile, 0o600);
    await assert.rejects(runMonitoring(outputDir, ["--check"]), (err) => /alertmanager_receiver_missing/.test(err.stderr));
    const upgraded = JSON.parse((await runMonitoring(outputDir, ["--alert-receiver", "--json"], { OPEN_SCIENCE_ALERT_WEBHOOK_URL: "" })).stdout);
    assert.deepEqual(upgraded.changed, ["alertmanager.json"]);
    await runMonitoring(outputDir, ["--check"]);

    // A fresh directory with no webhook at all still gets a working receiver.
    const bare = path.join(tmp, "bare");
    const written = JSON.parse((await runMonitoring(bare, ["--alert-receiver", "--json"], { OPEN_SCIENCE_ALERT_WEBHOOK_URL: "" })).stdout);
    assert.deepEqual(written.changed.sort(), ["alert-receiver-token.txt", "alertmanager-receiver-token.txt", "alertmanager.json"]);
    const config = JSON.parse(await readFile(path.join(bare, "alertmanager.json"), "utf8"));
    assert.equal(config.receivers[0].webhook_configs.length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("monitoring configuration rejects weak secrets and local alert webhooks", async () => {
  const tmp = await temporaryDirectory();
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

const noProbeUrls = { OPEN_SCIENCE_PUBLIC_HEALTH_URL: "", OPEN_SCIENCE_EDGE_PROXY_URL: "" };

test("the probe-target list is written from the environment alone, without the monitoring secrets", async () => {
  // 2026-09-26 (platform audit I3-1): production's `.env` named the public
  // health URL, but the list had been generated by a run without it, and
  // regenerating it meant re-entering all three secrets. The release switch
  // now runs `--targets` from `.env` for every release.
  const tmp = await temporaryDirectory();
  const outputDir = path.join(tmp, "secrets");
  try {
    const written = await runMonitoring(outputDir, ["--targets", "--json"], {
      OPEN_SCIENCE_PUBLIC_HEALTH_URL: "https://evimed.example.org/api/health",
      OPEN_SCIENCE_EDGE_PROXY_URL: "https://203.0.113.7",
      OPEN_SCIENCE_OPERATOR_METRICS_TOKEN: "", OPEN_SCIENCE_GRAFANA_ADMIN_PASSWORD: "", OPEN_SCIENCE_ALERT_WEBHOOK_URL: "",
    });
    const result = JSON.parse(written.stdout);
    assert.equal(result.mode, "targets");
    assert.deepEqual([result.publicTls, result.edgeTls], [1, 1]);
    const list = JSON.parse(await readFile(path.join(tmp, "targets", "tls.json"), "utf8"));
    assert.deepEqual(list, [
      { targets: ["https://evimed.example.org/api/health"], labels: { probe: "public-tls" } },
      { targets: ["203.0.113.7:443"], labels: { probe: "edge-proxy-tls" } },
    ]);
    // Nothing secret was asked for, so nothing secret was written.
    await assert.rejects(readFile(path.join(outputDir, "operator-metrics-token.txt")), { code: "ENOENT" });
    // An http origin reports no certificate expiry and is refused, not listed.
    await assert.rejects(
      () => runMonitoring(outputDir, ["--targets"], { ...noProbeUrls, OPEN_SCIENCE_PUBLIC_HEALTH_URL: "http://evimed.example.org/api/health" }),
      (err) => { assert.match(err.stderr, /public_health_url_insecure/); return true; },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("the monitoring check fails when the probe list does not probe what the environment names", async () => {
  const tmp = await temporaryDirectory();
  const outputDir = path.join(tmp, "secrets");
  try {
    // Generated by a run that did not carry the URL...
    await runMonitoring(outputDir, [], { ...validEnv, ...noProbeUrls });
    await runMonitoring(outputDir, ["--check"], noProbeUrls);
    // ...then checked where `.env` names it: the list is stale, and says how to fix it.
    await assert.rejects(
      () => runMonitoring(outputDir, ["--check"], { ...noProbeUrls, OPEN_SCIENCE_PUBLIC_HEALTH_URL: "https://evimed.example.org/api/health" }),
      (err) => { assert.match(err.stderr, /tls_targets_stale.*OPEN_SCIENCE_PUBLIC_HEALTH_URL.*--targets/); return true; },
    );
    await assert.rejects(
      () => runMonitoring(outputDir, ["--check"], { ...noProbeUrls, OPEN_SCIENCE_EDGE_PROXY_URL: "https://203.0.113.7" }),
      (err) => { assert.match(err.stderr, /tls_targets_stale.*OPEN_SCIENCE_EDGE_PROXY_URL/); return true; },
    );
    await runMonitoring(outputDir, ["--targets"], { ...noProbeUrls, OPEN_SCIENCE_PUBLIC_HEALTH_URL: "https://evimed.example.org/api/health" });
    await runMonitoring(outputDir, ["--check"], { ...noProbeUrls, OPEN_SCIENCE_PUBLIC_HEALTH_URL: "https://evimed.example.org/api/health" });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("monitoring configuration refuses symbolic-link paths", async () => {
  const tmp = await temporaryDirectory();
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
  const tmp = await temporaryDirectory();
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

function simulatedOwnership(assignments) {
  return async (file, flags) => {
    const handle = await open(file, flags);
    let owner;
    let group;
    return {
      read: (...args) => handle.read(...args),
      close: () => handle.close(),
      stat: async () => {
        const value = await handle.stat();
        if (owner !== undefined) value.uid = owner;
        if (group !== undefined) value.gid = group;
        return value;
      },
      chown: async (uid, gid) => {
        owner = uid;
        if (gid !== -1) group = gid;
        assignments.push({ file: path.basename(file), uid, gid });
      },
    };
  };
}

test("container secret preparation assigns only fixed readers and preserves private bytes", async () => {
  const tmp = await temporaryDirectory();
  const outputDir = path.join(tmp, "secrets");
  const assignments = [];
  try {
    await runMonitoring(outputDir, [], validEnv);
    const names = ["operator-metrics-token.txt", "prometheus-operator-metrics-token.txt", "grafana-admin-password.txt", "alertmanager.json",
      "alert-receiver-token.txt", "alertmanager-receiver-token.txt"];
    const before = new Map(await Promise.all(names.map(async (name) => [name, await readFile(path.join(outputDir, name))])));
    const prepared = await prepareContainerSecrets({ directory: outputDir, targetsFile: path.join(tmp, "targets/tls.json"),
      platform: "linux", uid: 0, openFile: simulatedOwnership(assignments) });
    assert.deepEqual(assignments, [
      { file: names[0], uid: 0, gid: 0 }, { file: names[1], uid: 65534, gid: 65534 },
      { file: names[2], uid: 472, gid: -1 }, { file: names[3], uid: 65534, gid: 65534 },
      { file: names[4], uid: 0, gid: 0 }, { file: names[5], uid: 65534, gid: 65534 },
    ]);
    for (const row of prepared) {
      assert.equal(row.mode, "0600");
      assert.deepEqual(await readFile(path.join(outputDir, row.file)), before.get(row.file));
      assert.equal((await lstat(path.join(outputDir, row.file))).mode & 0o777, 0o600);
    }
    assert.equal(JSON.stringify(prepared).includes("token=secret"), false);
    assert.equal(JSON.parse((await runMonitoring(outputDir, ["--check", "--json"])).stdout).ok, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("container secret preparation accepts the owner-only 0400 files an older release wrote", async () => {
  // The production host's token files were written 0400 before the alert
  // receiver existed; the switch refused them as "not 0600" on 2026-09-28
  // and stopped before moving `current`.
  const tmp = await temporaryDirectory();
  const outputDir = path.join(tmp, "secrets");
  try {
    await runMonitoring(outputDir, [], validEnv);
    for (const name of ["operator-metrics-token.txt", "prometheus-operator-metrics-token.txt", "grafana-admin-password.txt"]) {
      await chmod(path.join(outputDir, name), 0o400);
    }
    const prepared = await prepareContainerSecrets({ directory: outputDir, targetsFile: path.join(tmp, "targets/tls.json"),
      platform: "linux", uid: 0, openFile: simulatedOwnership([]) });
    assert.deepEqual(prepared.map((row) => row.mode), ["0400", "0400", "0400", "0600", "0600", "0600"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("container secret preparation refuses non-root or non-Linux before opening files", async () => {
  for (const options of [{ platform: "darwin", uid: 0 }, { platform: "linux", uid: 1001 }]) {
    let opened = false;
    await assert.rejects(prepareContainerSecrets({ ...options, openFile: async () => { opened = true; } }),
      { code: "monitoring_prepare_requires_root_linux" });
    assert.equal(opened, false);
  }
});

test("container secret preparation validates every reader secret before any ownership change", async () => {
  const tmp = await temporaryDirectory();
  const outputDir = path.join(tmp, "secrets");
  try {
    await runMonitoring(outputDir, [], validEnv);
    const target = path.join(outputDir, "prometheus-operator-metrics-token.txt");
    await writeFile(target, "different-but-long-enough-prometheus-token-for-test\n");
    const assignments = [];
    await assert.rejects(prepareContainerSecrets({ directory: outputDir, targetsFile: path.join(tmp, "targets/tls.json"),
      platform: "linux", uid: 0, openFile: simulatedOwnership(assignments) }), { code: "monitoring_metrics_token_mismatch" });
    assert.deepEqual(assignments, []);
    await writeFile(target, `${validEnv.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN}\n`);
    await chmod(path.join(outputDir, "alertmanager.json"), 0o640);
    await assert.rejects(prepareContainerSecrets({ directory: outputDir, targetsFile: path.join(tmp, "targets/tls.json"),
      platform: "linux", uid: 0, openFile: simulatedOwnership(assignments) }), { code: "monitoring_file_permissions" });
    assert.deepEqual(assignments, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("container secret preparation rejects a symlinked ancestor without changing files", async () => {
  const tmp = await temporaryDirectory();
  const outputDir = path.join(tmp, "actual/secrets");
  try {
    await runMonitoring(outputDir, [], validEnv);
    await symlink(path.join(tmp, "actual"), path.join(tmp, "linked"));
    const assignments = [];
    await assert.rejects(prepareContainerSecrets({ directory: path.join(tmp, "linked/secrets"),
      targetsFile: path.join(tmp, "actual/targets/tls.json"), platform: "linux", uid: 0,
      openFile: simulatedOwnership(assignments) }), { code: "monitoring_path_symlink" });
    assert.deepEqual(assignments, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("monitoring Compose readers match the prepared numeric UIDs", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.monitoring.yml"), "utf8");
  assert.match(compose, /prometheus:\n\s+image:[^\n]+\n\s+user: "65534:65534"/);
  assert.match(compose, /alertmanager:\n\s+image:[^\n]+\n\s+user: "65534:65534"/);
  assert.match(compose, /grafana:\n\s+image:[^\n]+\n\s+user: "472"/);
});

test("Docker CI root shell preserves toolchain PATH and GITHUB_ENV across sudo", async () => {
  const workflow = await readFile(path.join(repoRoot, "../.github/workflows/web.yml"), "utf8");
  const dockerJob = workflow.split("  docker-hosted:\n")[1].split(/\n  [a-z][a-z-]+:\n/)[0];
  assert.match(dockerJob, /shell: \/usr\/local\/bin\/evimed-ci-root-shell \{0\}/);
  assert.equal((dockerJob.match(/shell: bash/g) ?? []).length, 1);
  assert.match(dockerJob, /configure-monitoring\.mjs --prepare-container-secrets/);
  const wrapper = dockerJob.match(/cat > "\$RUNNER_TEMP\/evimed-ci-root-shell" <<'SH'\n([\s\S]*?)\n          SH/)[1]
    .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
  const tmp = await temporaryDirectory();
  try {
    const bin = path.join(tmp, "bin");
    await mkdir(bin);
    // Simulate sudo secure_path. The wrapper must hand env the original PATH.
    await writeFile(path.join(bin, "sudo"), '#!/bin/sh\ntest "$1" = -E || exit 1\nshift\nPATH=/usr/bin:/bin exec "$@"\n', { mode: 0o755 });
    await writeFile(path.join(bin, "node"), '#!/bin/sh\nprintf "action-node\\n"\n', { mode: 0o755 });
    await writeFile(path.join(bin, "pnpm"), '#!/bin/sh\nprintf "action-pnpm\\n"\n', { mode: 0o755 });
    const wrapperPath = path.join(tmp, "root-shell");
    const stepPath = path.join(tmp, "step.sh");
    const envPath = path.join(tmp, "github-env");
    await writeFile(wrapperPath, `${wrapper}\n`, { mode: 0o755 });
    await writeFile(stepPath, 'test "$(node)" = action-node\ntest "$(pnpm)" = action-pnpm\nprintf "CI_STEP=ok\\n" >> "$GITHUB_ENV"\n');
    await new Promise((resolve, reject) => {
      execFile(wrapperPath, [stepPath], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ENV: envPath } },
        (error) => error ? reject(error) : resolve());
    });
    assert.equal(await readFile(envPath, "utf8"), "CI_STEP=ok\n");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
