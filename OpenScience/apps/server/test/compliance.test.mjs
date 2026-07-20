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
