import assert from "node:assert/strict";
import test from "node:test";
import { readinessSaasProfile } from "../src/saasProfile.mjs";

function passingChecks() {
  return {
    publicUrl: { ok: true, secure: true },
    auth: { ok: true, mode: "oidc" },
    stateStore: { ok: true, mode: "postgres", shared: true, required: true },
    memory: { ok: true, required: true, connected: true },
    security: { ok: true, production: true },
    observability: { ok: true, required: true, mode: "protected" },
    evimedAdapters: { ok: true, enabled: 9 },
    scienceConnectors: { ok: true, enabled: 7 },
    modelGateway: { ok: true, enabled: true },
    release: { ok: true, required: true, tracked: true },
    resources: { ok: true, production: true },
    backup: { ok: true, mode: "external", restoreDrill: true },
    runtime: {
      ok: true,
      mode: "opencode",
      sandboxMode: "docker",
      controlPlane: "controller_socket",
    },
  };
}

test("controlled pilot remains explicit and never claims public SaaS readiness", () => {
  assert.deepEqual(
    readinessSaasProfile({ deploymentProfile: "controlled-pilot", production: true }, {}),
    {
      profile: "controlled-pilot",
      tenantModel: "individual-account",
      targetAudience: "individual-researchers",
      technicalSaas: false,
      organizationCollaboration: false,
      billingIntegrated: false,
    },
  );
});

test("individual SaaS profile requires the complete hosted execution boundary", () => {
  const result = readinessSaasProfile(
    {
      deploymentProfile: "individual-saas",
      production: true,
      requireMemos: true,
      requireSharedStateStore: true,
    },
    passingChecks(),
  );
  assert.equal(result.profile, "individual-saas");
  assert.equal(result.technicalSaas, true);
  assert.equal(result.tenantModel, "individual-account");
  assert.equal(result.organizationCollaboration, false);
  assert.equal(result.billingIntegrated, false);
  assert.deepEqual(result.validatedBoundaries, [
    "public-origin",
    "oidc-identity",
    "shared-control-plane",
    "project-isolation",
    "sandboxed-runtime",
    "server-model-gateway",
    "audited-science-connectors",
    "research-memory",
    "release-provenance",
    "external-recovery",
    "content-safe-observability",
  ]);
});

test("individual SaaS profile fails closed with stable missing boundary ids", () => {
  const checks = passingChecks();
  checks.auth = { ok: true, mode: "local" };
  checks.stateStore = { ok: true, mode: "file", shared: false, required: false };
  checks.backup = { ok: true, mode: "local", restoreDrill: true };
  assert.throws(
    () => readinessSaasProfile(
      {
        deploymentProfile: "individual-saas",
        production: true,
        requireMemos: true,
        requireSharedStateStore: false,
      },
      checks,
    ),
    (error) => {
      assert.equal(error.code, "saas_profile_requirements_missing");
      assert.deepEqual(error.details.missing, ["oidc-identity", "shared-control-plane", "external-recovery"]);
      return true;
    },
  );
});

test("unknown SaaS profiles are rejected instead of silently downgrading", () => {
  assert.throws(
    () => readinessSaasProfile({ deploymentProfile: "enterprise-magic", production: true }, passingChecks()),
    (error) => error.code === "saas_profile_invalid",
  );
});
