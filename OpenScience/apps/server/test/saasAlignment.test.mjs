import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("SaaS product alignment contract covers every module without overstating launch readiness", async () => {
  const contract = JSON.parse(await readFile(path.join(repoRoot, "deploy/web/saas-capability-contract.json"), "utf8"));
  assert.equal(contract.modules.length, 22);
  assert.equal(contract.claims.coreResearchWorkflowAdapted, true);
  assert.equal(contract.claims.individualAccountSaasProfileImplemented, true);
  assert.equal(contract.claims.publicDeploymentExternallyVerified, false);
  assert.equal(contract.claims.organizationSaasReady, false);
  assert.equal(contract.claims.commercialSaasReady, false);
  assert.equal(contract.claims.horizontalScaleReady, false);
  assert.ok(contract.modules.some((module) => module.id === "curated-scientific-skills" && module.status === "adapted"));
  assert.ok(contract.modules.some((module) => module.id === "drug-evidence-decision-support" && module.status === "adapted"));
  assert.ok(contract.modules.some((module) => module.id === "organization-collaboration" && module.status === "out-of-scope"));
  // The computational notebook was deleted from the hosted product on
  // 2026-09-19; the module stays in the map, saying so.
  assert.ok(contract.modules.some((module) => module.id === "hosted-notebooks" && module.status === "out-of-scope"));
  // The frontier feed joined on 2026-09-22 as a conditional module: it reads a
  // separate service (the knowledge-source plugin) and ships switched off, so
  // it names both conditions rather than claiming to be adapted outright.
  const frontier = contract.modules.find((module) => module.id === "frontier-feed");
  assert.equal(frontier?.status, "conditional");
  assert.ok(frontier.blockers.some((blocker) => /knowledge-source plugin/.test(blocker)));
  assert.ok(frontier.blockers.some((blocker) => /OPEN_SCIENCE_FRONTIER_ENABLED/.test(blocker)));
  assert.ok(frontier.evidence.includes("packages/contracts/knowledge-plugin/contract.test.mjs"), "its contract test is part of the evidence");
});

test("SaaS product alignment audit is executable and release-gated", () => {
  const result = spawnSync(process.execPath, ["scripts/ops/audit-saas-alignment.mjs", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.modules, 22);
  assert.equal(report.profile, "individual-saas");
  assert.equal(report.tenantModel, "individual-account");
  assert.ok(report.adapted >= 14);
  assert.ok(report.bounded >= 5);
});
