#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jsonOutput = process.argv.includes("--json");
const contractPath = path.join(repoRoot, "deploy/web/saas-capability-contract.json");
const allowedStatuses = new Set(["adapted", "conditional", "external", "not-implemented", "out-of-scope"]);
const requiredModules = new Set([
  "research-workbench",
  "identity-and-tenancy",
  "projects-and-workspaces",
  "agent-runtime",
  "model-gateway",
  "curated-scientific-skills",
  "office-artifact-exporters",
  "science-connectors",
  "drug-evidence-decision-support",
  "artifacts-and-provenance",
  "hosted-notebooks",
  "research-memory",
  "account-self-service-and-operations",
  "security-and-isolation",
  "release-and-observability",
  "backup-and-disaster-recovery",
  "async-work-and-capacity",
  "horizontal-scaling",
  "organization-collaboration",
  "commercial-billing",
  "institutional-compliance",
]);

async function read(relative) {
  return readFile(path.join(repoRoot, relative), "utf8");
}

const failures = [];
function requireBoundary(condition, code, message) {
  if (!condition) failures.push({ code, message });
}

let contract;
try {
  contract = JSON.parse(await readFile(contractPath, "utf8"));
} catch (error) {
  failures.push({ code: "contract_unreadable", message: error.message });
  contract = {};
}

requireBoundary(contract.schemaVersion === 1, "schema_version", "SaaS capability contract must use schemaVersion 1.");
requireBoundary(contract.productBaseline?.audience === "individual-researchers", "audience", "Original individual-researcher audience drifted.");
requireBoundary(contract.productBaseline?.tenantModel === "individual-account", "tenant_model", "Phase-one tenant model must remain individual-account.");
requireBoundary(contract.deliveryProfiles?.default === "controlled-pilot", "default_profile", "Controlled pilot must remain the safe default.");
requireBoundary(contract.deliveryProfiles?.publicTechnicalProfile === "individual-saas", "saas_profile", "Individual SaaS technical profile is missing.");

const claims = contract.claims ?? {};
requireBoundary(claims.coreResearchWorkflowAdapted === true, "core_claim", "Core research workflow must remain SaaS-adapted.");
requireBoundary(claims.individualAccountSaasProfileImplemented === true, "profile_claim", "Individual SaaS profile must be implemented.");
for (const claim of [
  "controlledPilotIsPublicSaas",
  "publicDeploymentExternallyVerified",
  "organizationSaasReady",
  "commercialSaasReady",
  "horizontalScaleReady",
  "institutionalComplianceReady",
]) {
  requireBoundary(claims[claim] === false, `honest_claim_${claim}`, `${claim} must stay false until independently evidenced.`);
}

const modules = Array.isArray(contract.modules) ? contract.modules : [];
const moduleIds = modules.map((module) => module.id);
requireBoundary(new Set(moduleIds).size === moduleIds.length, "module_ids_unique", "Module ids must be unique.");
for (const required of requiredModules) {
  requireBoundary(moduleIds.includes(required), `module_${required}`, `Capability contract is missing ${required}.`);
}
for (const module of modules) {
  requireBoundary(allowedStatuses.has(module.status), `status_${module.id}`, `${module.id} has an invalid status.`);
  requireBoundary(Array.isArray(module.evidence) && module.evidence.length > 0, `evidence_${module.id}`, `${module.id} needs repository evidence.`);
  for (const evidence of module.evidence ?? []) {
    requireBoundary(
      typeof evidence === "string" && !path.isAbsolute(evidence) && existsSync(path.join(repoRoot, evidence)),
      `evidence_path_${module.id}`,
      `${module.id} evidence path is missing or unsafe: ${evidence}`,
    );
  }
  if (module.status !== "adapted") {
    requireBoundary(Array.isArray(module.blockers) && module.blockers.length > 0, `blockers_${module.id}`, `${module.id} must name its remaining boundary.`);
  }
}

const [
  prd,
  requirements,
  config,
  server,
  runtime,
  account,
  compose,
  saasOverlay,
  pkg,
  curatedText,
  officeText,
  drugCompiler,
  drugCompilerTests,
  drugSelectionSkill,
  offLabelSkill,
  comprehensiveSkill,
] = await Promise.all([
  read("docs/PRD.md"),
  read("docs/REQUIREMENTS.md"),
  read("apps/server/src/config.mjs"),
  read("apps/server/src/server.mjs"),
  read("apps/server/src/runtimeManager.mjs"),
  read("apps/web/src/app/routes/SettingsPage.tsx"),
  read("deploy/web/docker-compose.yml"),
  read("deploy/web/docker-compose.saas.yml"),
  read("package.json"),
  read("runtime/skills/curated-scientific/inventory.json"),
  read("runtime/skills/office/inventory.json"),
  read("runtime/mcp/evimed-research/drug_assessment.py"),
  read("runtime/mcp/evimed-research/test/test_drug_assessment.py"),
  read("runtime/skills/evimed/drug-selection/SKILL.md"),
  read("runtime/skills/evimed/off-label-analysis/SKILL.md"),
  read("runtime/skills/evimed/comprehensive-drug-evaluation/SKILL.md"),
]);
const curated = JSON.parse(curatedText);
const office = JSON.parse(officeText);
const rootPackage = JSON.parse(pkg);

requireBoundary(/local-first, model-agnostic/.test(prd), "product_local_first", "PRD local-first/model-agnostic invariant is missing.");
requireBoundary(/Institutions needing multi-user collaborative SaaS/.test(prd), "product_phase_one_scope", "PRD must preserve the organization-SaaS non-target.");
requireBoundary(/reproducible artifact system/.test(requirements) && /domain tool\/database connectors/.test(requirements), "product_moat", "Research-runtime moat drifted.");
requireBoundary(/OPEN_SCIENCE_DEPLOYMENT_PROFILE/.test(config) && /controlled-pilot/.test(config), "config_profile", "Server config lacks a safe deployment profile default.");
requireBoundary(/readinessSaasProfile/.test(server) && /tenant: \{ id: user\.tenantId \?\? user\.id, model: "individual-account"/.test(server), "server_tenant", "Server readiness or tenant identity is not first-class.");
requireBoundary(/OPEN_SCIENCE_TENANT_ID/.test(runtime), "runtime_tenant", "Runtime workload lacks tenant context.");
// These moved from the account page to the settings page on 2026-09-04, when
// the two were split: the account page is who you are, the settings page is
// how the deployment runs. The variable keeps its name; the surface is the one
// that has to carry them.
for (const component of ["WebProjectsCard", "WebResourcesCard", "WebReadinessCard", "WebTasksCard", "WebAuditCard", "WebSecurityCard"]) {
  requireBoundary(account.includes(component), `settings_${component}`, `Hosted settings surface is missing ${component}.`);
}
requireBoundary(/OPEN_SCIENCE_DEPLOYMENT_PROFILE: \$\{OPEN_SCIENCE_DEPLOYMENT_PROFILE:-controlled-pilot\}/.test(compose), "compose_default", "Base Compose must default to controlled-pilot.");
// The overlay still selects external recovery — as its default. It may no
// longer pin it as a literal: two overlays setting this key literally on the
// same service made the winner depend on -f order, and production ran for
// months with the web container believing "external" and the backup container
// believing "local". The profile keeps its posture; the operator keeps the
// ability to declare a different one, and readinessSaasProfile still reports
// external-recovery as unmet when they do.
requireBoundary(/OPEN_SCIENCE_DEPLOYMENT_PROFILE: individual-saas/.test(saasOverlay) && /OPEN_SCIENCE_BACKUP_MODE: \$\{OPEN_SCIENCE_BACKUP_MODE:-external\}/.test(saasOverlay), "compose_saas", "SaaS overlay must select individual-saas and default to external recovery.");
requireBoundary(rootPackage.scripts?.["audit:saas-alignment"]?.includes("audit-saas-alignment.mjs"), "audit_script", "Root package lacks the SaaS alignment audit.");
requireBoundary(rootPackage.scripts?.["ci:web"]?.includes("audit:saas-alignment"), "audit_ci", "SaaS alignment audit is not release-gated.");
requireBoundary(Object.keys(curated.policy?.delivery?.executable ?? {}).length === 38, "curated_38", "All 38 curated skills must have executable delivery contracts.");
requireBoundary(Object.keys(office.policy?.delivery?.executable ?? {}).length === 4 && office.license === "MIT", "office_4", "All four first-party MIT Office exporters must remain executable.");
requireBoundary(
  /humanReviewRequired/.test(drugCompiler) &&
    /automaticDecision/.test(drugCompiler) &&
    /potentially_off_label/.test(drugCompiler) &&
    /weighted_min_max_normalization/.test(drugCompiler) &&
    /not_automatically_determined/.test(drugCompiler),
  "drug_assessment_compiler",
  "Drug assessment must retain deterministic compilation and human decision boundaries.",
);
requireBoundary(
  /cross_jurisdiction/.test(drugCompilerTests) &&
    /withholds_economic_ranking/.test(drugCompilerTests) &&
    /does_not_map_design_to_recommendation/.test(drugCompilerTests),
  "drug_assessment_regressions",
  "Drug assessment requires cross-jurisdiction, economic-comparability, and recommendation-shortcut regressions.",
);
requireBoundary(
  /evidence-snapshot\.json/.test(drugSelectionSkill) &&
    /action: compile/.test(drugSelectionSkill) &&
    /action: compile/.test(offLabelSkill) &&
    /four conclusions independent/i.test(offLabelSkill) &&
    /action: compile/.test(comprehensiveSkill) &&
    /scoringRubric/.test(comprehensiveSkill) &&
    /missing evidence is never zero/i.test(comprehensiveSkill) &&
    /never determines recommendation strength automatically/i.test(comprehensiveSkill),
  "drug_assessment_skills",
  "The three drug workflows must preserve retrieval snapshots, deterministic compilation, and separate decision axes.",
);

const report = {
  ok: failures.length === 0,
  profile: contract.deliveryProfiles?.publicTechnicalProfile ?? null,
  tenantModel: contract.productBaseline?.tenantModel ?? null,
  modules: modules.length,
  adapted: modules.filter((module) => module.status === "adapted").length,
  bounded: modules.filter((module) => module.status !== "adapted").length,
  failures,
};

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (report.ok) {
  console.log(`SaaS alignment PASS: ${report.adapted}/${report.modules} modules adapted; ${report.bounded} explicit external, conditional, deferred, or out-of-scope boundaries.`);
  console.log(`Technical profile: ${report.profile}; tenant model: ${report.tenantModel}.`);
} else {
  console.error(`SaaS alignment FAIL: ${failures.length} boundary violation(s).`);
  for (const failure of failures) console.error(`- ${failure.code}: ${failure.message}`);
}

process.exitCode = report.ok ? 0 : 1;
