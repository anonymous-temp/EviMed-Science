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
    // Exactly what `readinessRuntime` returns for a hosted docker deployment:
    // one kernel, named and versioned on every branch.
    runtime: {
      ok: true,
      mode: "kernel",
      kernel: "dsh",
      kernelVersion: "0.1.2-alpha.3",
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

// The fixture above claimed `mode: "opencode"` for a release in which
// `readinessRuntime` only ever returns "kernel" or "mock", so the boundary it
// was proving green had in fact gone red. Pin the negative side too: a runtime
// that is not the sandboxed DSH kernel must not satisfy `sandboxed-runtime`.
test("only the sandboxed kernel runtime satisfies the hosted execution boundary", () => {
  for (const runtime of [
    { ok: true, mode: "opencode", sandboxMode: "docker", controlPlane: "controller_socket" },
    { ok: true, mode: "mock", sandboxMode: "mock" },
    { ok: true, mode: "kernel", sandboxMode: "host", controlPlane: "controller_socket" },
    { ok: true, mode: "kernel", sandboxMode: "docker", controlPlane: "direct_override" },
    { ok: false, mode: "kernel", sandboxMode: "docker", controlPlane: "controller_socket" },
  ]) {
    const checks = passingChecks();
    checks.runtime = runtime;
    let error = null;
    try {
      readinessSaasProfile(productionConfig(), checks);
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error, `${JSON.stringify(runtime)} must not pass as a sandboxed runtime`);
    assert.equal(error.code, "saas_profile_requirements_missing");
    assert.deepEqual(error.details.missing, ["sandboxed-runtime"]);
  }
});

test("unknown SaaS profiles are rejected instead of silently downgrading", () => {
  assert.throws(
    () => readinessSaasProfile({ deploymentProfile: "enterprise-magic", production: true }, passingChecks()),
    (error) => error.code === "saas_profile_invalid",
  );
});

// Closing the gate on "every configured surface green, every unconfigured one
// named", per the 2026-08-31 ruling.
//
// Production sat on four missing requirements, and three of them were never
// going to be met: it authenticates with local-auth by choice, holds no
// Materials Project credential, and keeps backups on one machine by decision.
// The fourth — a stale model gateway receipt — is a real defect, and it read
// exactly like the other three. A probe that is red for four reasons, three of
// them permanent, is one that stops being read.
function productionConfig(overrides = {}) {
  return {
    deploymentProfile: "individual-saas",
    production: true,
    requireSharedStateStore: true,
    requireMemos: true,
    ...overrides,
  };
}

test("a declared unconfigured surface is acknowledged, and still shown", () => {
  const checks = passingChecks();
  checks.auth = { ok: true, mode: "local" };            // local-auth by choice
  checks.scienceConnectors = { ok: true, enabled: 6 };  // no Materials Project key
  checks.backup = { ok: true, mode: "local", restoreDrill: true };

  const verdict = readinessSaasProfile(
    productionConfig({ saasProfileUnconfigured: "oidc-identity,audited-science-connectors,external-recovery" }),
    checks,
  );
  assert.equal(verdict.technicalSaas, true);
  assert.deepEqual(
    verdict.declaredUnconfigured.sort(),
    ["audited-science-connectors", "external-recovery", "oidc-identity"],
    "what was waived must come back in the body; a waiver nobody can see is a waiver nobody reviews",
  );
  // And it does not quietly claim the waived boundaries were validated.
  for (const waived of verdict.declaredUnconfigured) {
    assert.ok(!verdict.validatedBoundaries.includes(waived), `${waived} was declared, not validated`);
  }
});

test("an undeclared miss still fails, so the declaration cannot drift", () => {
  const checks = passingChecks();
  checks.auth = { ok: true, mode: "local" };
  checks.modelGateway = { ok: false, code: "deepseek_release_receipt_stale" };

  // oidc is declared; the stale receipt is not, and it is the actual defect.
  let error = null;
  try {
    readinessSaasProfile(productionConfig({ saasProfileUnconfigured: "oidc-identity" }), checks);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, "an undeclared missing requirement must still fail");
  assert.equal(error.code, "saas_profile_requirements_missing");
  assert.deepEqual(error.details.missing, ["server-model-gateway"]);
  assert.deepEqual(error.details.declaredUnconfigured, ["oidc-identity"]);
});

test("a declaration naming something that is not a requirement is refused", () => {
  let error = null;
  try {
    readinessSaasProfile(productionConfig({ saasProfileUnconfigured: "oidc-identity,external-recovry" }), passingChecks());
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, "a misspelled declaration must be refused");
  assert.equal(error.code, "saas_profile_declaration_unknown");
  assert.deepEqual(error.details.unknown, ["external-recovry"]);
});
