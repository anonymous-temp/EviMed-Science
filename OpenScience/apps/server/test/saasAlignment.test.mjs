import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("SaaS product alignment contract covers every module without overstating launch readiness", async () => {
  const contract = JSON.parse(await readFile(path.join(repoRoot, "deploy/web/saas-capability-contract.json"), "utf8"));
  assert.equal(contract.modules.length, 21);
  assert.equal(contract.claims.coreResearchWorkflowAdapted, true);
  assert.equal(contract.claims.individualAccountSaasProfileImplemented, true);
  assert.equal(contract.claims.publicDeploymentExternallyVerified, false);
  assert.equal(contract.claims.organizationSaasReady, false);
  assert.equal(contract.claims.commercialSaasReady, false);
  assert.equal(contract.claims.horizontalScaleReady, false);
  assert.ok(contract.modules.some((module) => module.id === "curated-scientific-skills" && module.status === "adapted"));
  assert.ok(contract.modules.some((module) => module.id === "drug-evidence-decision-support" && module.status === "adapted"));
  assert.ok(contract.modules.some((module) => module.id === "organization-collaboration" && module.status === "out-of-scope"));
});

test("SaaS product alignment audit is executable and release-gated", () => {
  const result = spawnSync(process.execPath, ["scripts/ops/audit-saas-alignment.mjs", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.modules, 21);
  assert.equal(report.profile, "individual-saas");
  assert.equal(report.tenantModel, "individual-account");
  assert.ok(report.adapted >= 15);
  assert.ok(report.bounded >= 5);
});
