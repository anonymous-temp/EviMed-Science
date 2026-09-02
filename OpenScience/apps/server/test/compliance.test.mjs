import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const auditScript = path.join(repoRoot, "scripts/ops/audit-hosted-compliance.mjs");

function runAudit(env = {}) {
  const mergedEnv = { ...process.env, ...env };
  delete mergedEnv.OPEN_SCIENCE_LICENSE_ACCEPT_RESTRICTED_SKILLS;
  return spawnSync(process.execPath, [auditScript, "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: mergedEnv,
  });
}

function parseAudit(stdout) {
  return JSON.parse(stdout);
}

test("hosted compliance audit passes the default Web redistribution boundary", () => {
  const result = runAudit();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = parseAudit(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.failed, 0);
  const passed = new Set(
    report.findings.filter((finding) => finding.status === "pass").map((finding) => finding.code),
  );
  // Every boundary this audit is the gate for, asserted as a PASS rather than
  // as "a finding with this code exists" — a failing check reports
  // `<code>_missing`, so the old form would also have been satisfied by a
  // check that was present and red.
  for (const code of [
    "web_image_curated_scientific_skills",
    "curated_skill_delivery_contract",
    "first_party_office_artifact_chain",
    "readiness_office_boundary",
    "hosted_science_connector_chain",
    "hosted_example_parity",
    "release_manifest_mount",
    "runtime_release_asset_integrity",
    "runtime_native_architecture",
    "runtime_license_notices",
    "tls_proxy_release_identity",
    "deployment_host_preflight",
    "docker_ci_public_tls",
    "security_incident_response",
    "operator_integration_preflight",
    "workspace_descriptor_io_boundary",
    "hosted_notebook_kernel",
    "hosted_desktop_boundary",
    "hosted_event_stream_recovery",
    "task_resource_control",
    "production_local_auth_secret_boundary",
    "hosted_metadata_boundary",
    "tls_proxy_origin_boundary",
    "trusted_proxy_client_boundary",
    // One agent runtime kernel. These are the checks that used to name
    // OpenCode and now name what the platform actually ships: the pinned DSH
    // image and its single Compose build, the launch plan the controller
    // reconstructs, the Unix-socket transport its launcher exposes, the
    // release gate that refuses to mint an unmeasured receipt, and the labels
    // that say which kernel the image carries.
    "dsh_version_pinned",
    "dsh_version_pin_single_source",
    "uv_version_pinned",
    "compose_runtime_version_arg",
    "hosted_runtime_kernel_singular",
    "runtime_controller_privilege_boundary",
    "runtime_unix_socket_transport",
    "deepseek_compatibility_preflight",
    "deepseek_release_gate_ci_step",
    "runtime_tool_labels",
  ]) {
    assert.ok(passed.has(code), `${code} must pass, got ${JSON.stringify(report.findings.find((finding) => finding.code.startsWith(code)) ?? null)}`);
  }
  assert.equal(
    report.findings.filter((finding) => finding.code === "runtime_skill_dir_reviewed").length,
    4,
  );
  // A floor on the whole gate. Re-pointing a check at a new subject is
  // ordinary work; quietly dropping twenty of them and staying green is what
  // this catches.
  assert.ok(report.checks >= 75, `hosted compliance audit shrank to ${report.checks} checks`);
});

test("every file the audit pattern-matches is a file that exists", async () => {
  // The failure this exists for: `buildOpenCodeLaunchPlan(config, project, port, password)`
  // survived in the audit for as long as it took someone to read it, matching
  // nothing, while the check around it kept reporting a privilege boundary it
  // was no longer measuring. A pattern against a deleted file is the loudest
  // version of that — `read()` throws — but a pattern against a file that is
  // still there and no longer contains the subject is the quiet version, and
  // the cheapest guard against both is to prove the subjects are real files.
  const source = await readFile(auditScript, "utf8");
  const targets = [...source.matchAll(/await read\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(targets.length >= 60, `expected the audit to read the deployment surface, found ${targets.length} paths`);
  const missing = [];
  for (const target of new Set(targets)) {
    try {
      await stat(path.join(repoRoot, target));
    } catch {
      missing.push(target);
    }
  }
  assert.deepEqual(missing, [], "the audit reads files that are not in the repository");

  // Negative control: the check must be able to see an absent path.
  await assert.rejects(() => stat(path.join(repoRoot, "deploy/runtime-not-a-real-kernel/Dockerfile")));

  // And no check may still be pointed at the retired kernel's build tree.
  assert.deepEqual(
    targets.filter((target) => target.startsWith("deploy/runtime-opencode/")),
    [],
    "the hosted compliance audit must not read the retired kernel's build tree",
  );
});

test("hosted compliance audit is part of the Web CI script", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts["audit:hosted-compliance"], /audit-hosted-compliance\.mjs/);
  assert.match(pkg.scripts["audit:saas-alignment"], /audit-saas-alignment\.mjs/);
  assert.match(pkg.scripts["ci:web"], /pnpm audit:hosted-compliance/);
  assert.match(pkg.scripts["ci:web"], /pnpm audit:saas-alignment/);
});

test("hosted compliance audit rejects restricted Anthropic skills when configured for runtime deployment", () => {
  const result = runAudit({
    OPEN_SCIENCE_RUNTIME_SKILL_DIRS: "runtime/skills/external/anthropic-skills",
  });
  assert.notEqual(result.status, 0);
  const report = parseAudit(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(
    report.findings.some(
      (finding) => finding.status === "fail" && finding.code === "restricted_skill_directory",
    ),
  );
});

test("the boot-proof check tells running the proof apart from mentioning it", async () => {
  // The previous version of this test rewrote the real Dockerfile to make the
  // audit fail. `node --test` runs files in parallel, so it corrupted a tracked
  // file other tests were reading — it took `server.test.mjs` down on its first
  // CI run — and a crash between the write and the restore would have left the
  // repository broken. The predicate is exported instead, so the same property
  // is provable against synthetic text and cannot drift from the audit.
  const { dshBuildSmokeIsInvoked } = await import("../../../scripts/ops/audit-hosted-compliance.mjs");

  // Tabulated rather than described, which is how the surviving half of the
  // original defect was found: `\b#` only matches when a word character
  // precedes the `#`, so a whole-line comment naming the proof satisfied the
  // check on its own.
  const cases = [
    ["RUN SOCKET_VERSION=1 /usr/local/bin/evimed-build-smoke", true],
    ["  SOCKET_VERSION=\"1\" /usr/local/bin/evimed-build-smoke", true],
    ["RUN chmod 0755 /usr/local/bin/evimed-build-smoke; /usr/local/bin/evimed-build-smoke", true],
    ["RUN chmod 0755 /usr/local/bin/evimed-build-smoke", false],
    ["RUN set -eux; chmod 0755 /usr/local/bin/evimed-build-smoke", false],
    ["COPY deploy/runtime-dsh/build-smoke.sh /usr/local/bin/evimed-build-smoke", false],
    ["# runs /usr/local/bin/evimed-build-smoke", false],
    ["  # SOCKET_VERSION=1 /usr/local/bin/evimed-build-smoke", false],
    ["RUN set -eux; \\", false],
    ["", false],
  ];
  for (const [line, expected] of cases) {
    assert.equal(dshBuildSmokeIsInvoked(line), expected, `${JSON.stringify(line)} should be ${expected ? "an invocation" : "only a mention"}`);
  }

  // And the real Dockerfile must still read as running it, or the audit that
  // passes today is passing for the wrong reason.
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  assert.equal(dshBuildSmokeIsInvoked(dockerfile), true);
  // The negative control on the whole file: strip the invoking command and it
  // must read as not run. Done on a copy in memory, not on the file.
  const shipOnly = dockerfile
    .split("\n")
    .filter((line) => !(line.includes("evimed-build-smoke") && !/^\s*(#|COPY)/i.test(line) && !/chmod/.test(line)))
    .join("\n");
  assert.equal(dshBuildSmokeIsInvoked(shipOnly), false, "an image that only ships the proof must not read as running it");
});

test("the boot proof fails on a patch row the composition does not have", async () => {
  // The kernel WARNS and carries on when a patch row names a missing target, so
  // a row that silently does nothing produces a healthy container with one
  // capability absent — no error, no failed build, nothing in the ledger. The
  // smoke checked for "failed to apply loader entry", which is the loud case,
  // and not for this one, which is the quiet one.
  const smoke = await readFile(path.join(repoRoot, "deploy/runtime-dsh/build-smoke.sh"), "utf8");

  // Both spellings the installed kernel emits: replace and insert.
  assert.match(smoke, /patch\( insert\)\?: entry \.\* not found/, "the boot proof must fail on a dropped patch row");
  assert.match(smoke, /failed to apply loader entry/, "and must keep failing on the loud case");

  // Negative control: the pattern has to match what the kernel actually prints.
  const asKernelPrints = [
    "patch: entry evimed-run-policy not found",
    "patch insert: entry evimed-guidance not found",
  ];
  const pattern = /patch( insert)?: entry .* not found/;
  for (const line of asKernelPrints) assert.ok(pattern.test(line), `the smoke would not catch: ${line}`);
  // And it must not fire on an ordinary line, or every build fails.
  assert.equal(pattern.test("dsh web: listening on http://127.0.0.1:4096"), false);
  assert.equal(pattern.test("applied patch entry evimed-run-policy"), false);
});

test("the boot proof boots under the environment production actually emits", async () => {
  // Not a rewrite of the proof: it already exports the production surface. What
  // was missing is anything that fails when the two drift, and they drift in the
  // direction that is hardest to see — production gains a variable, the proof
  // does not, and the image keeps auditing clean while booting under an
  // environment no run will ever have. `EVIMED_PRESET_SKILLS_DIR` reached a
  // real container missing from exactly one of the two places it had to be.
  const { runtimeEnvironment } = await import("../src/dshProfilePatch.mjs");
  const produced = Object.keys(runtimeEnvironment({
    capabilitiesDir: "/opt/evimed/capabilities",
    capabilitySkillsDir: "/opt/evimed/capability-skills",
    presetSkillsDir: "/opt/evimed/skills",
    flags: { hosted: true, askUser: false, review: true, capsule: false, requiredEnforcement: "full" },
    limits: { maxSteps: 0, maxTokens: 0, maxChildren: 30, deliveryAttempts: 3, screeningBatchSize: 25, evidenceStaleMinutes: 10 },
  }));

  const smoke = await readFile(path.join(repoRoot, "deploy/runtime-dsh/build-smoke.sh"), "utf8");
  const exported = new Set(smoke.match(/EVIMED_[A-Z_]+/g) ?? []);
  const missing = produced.filter((name) => !exported.has(name)).sort();
  assert.deepEqual(missing, [], "the boot proof would boot under an environment no run has");

  // Negative control: the check must notice a variable the proof does not set.
  assert.equal(exported.has("EVIMED_NOT_A_REAL_VARIABLE"), false);
  assert.ok(produced.length >= 10, `expected a real environment surface, got ${produced.length} names`);
  // And the kernel's own two, which are set in three places on purpose.
  assert.match(smoke, /DSH_TELEMETRY_DISABLED=1/, "telemetry has no redaction rules and must be off wherever the kernel boots");
  assert.match(smoke, /DSH_PERMISSION_MODE=workspace-write/);
});
