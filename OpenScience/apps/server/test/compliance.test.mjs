import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  assert.ok(report.findings.some((finding) => finding.code === "web_image_curated_scientific_skills"));
  assert.ok(report.findings.some((finding) => finding.code === "curated_skill_delivery_contract"));
  assert.ok(report.findings.some((finding) => finding.code === "first_party_office_artifact_chain"));
  assert.ok(report.findings.some((finding) => finding.code === "readiness_office_boundary"));
  assert.ok(report.findings.some((finding) => finding.code === "hosted_science_connector_chain"));
  assert.equal(
    report.findings.filter((finding) => finding.code === "runtime_skill_dir_reviewed").length,
    4,
  );
  assert.ok(report.findings.some((finding) => finding.code === "hosted_example_parity"));
  assert.ok(report.findings.some((finding) => finding.code === "runtime_skill_dir_reviewed"));
  assert.ok(report.findings.some((finding) => finding.code === "release_manifest_mount"));
  assert.ok(report.findings.some((finding) => finding.code === "runtime_release_asset_integrity"));
  assert.ok(report.findings.some((finding) => finding.code === "runtime_native_architecture"));
  assert.ok(report.findings.some((finding) => finding.code === "tls_proxy_release_identity"));
  assert.ok(report.findings.some((finding) => finding.code === "deployment_host_preflight"));
  assert.ok(report.findings.some((finding) => finding.code === "docker_ci_public_tls"));
  assert.ok(report.findings.some((finding) => finding.code === "security_incident_response"));
  assert.ok(report.findings.some((finding) => finding.code === "operator_integration_preflight"));
  assert.ok(report.findings.some((finding) => finding.code === "workspace_descriptor_io_boundary"));
  assert.ok(report.findings.some((finding) => finding.code === "hosted_notebook_kernel"));
  assert.ok(report.findings.some((finding) => finding.code === "hosted_desktop_boundary"));
  assert.ok(report.findings.some((finding) => finding.code === "hosted_event_stream_recovery"));
  assert.ok(report.findings.some((finding) => finding.code === "task_resource_control"));
  assert.ok(report.findings.some((finding) => finding.code === "production_local_auth_secret_boundary"));
  assert.ok(report.findings.some((finding) => finding.code === "hosted_metadata_boundary"));
  assert.ok(report.findings.some((finding) => finding.code === "tls_proxy_origin_boundary"));
  assert.ok(report.findings.some((finding) => finding.code === "trusted_proxy_client_boundary"));
  assert.ok(report.findings.some((finding) => finding.code === "runtime_license_notices"));
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
