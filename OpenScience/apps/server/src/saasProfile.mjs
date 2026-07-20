const deploymentProfiles = new Set(["controlled-pilot", "individual-saas"]);

function profileFailure(code, details = null) {
  const error = new Error(code);
  error.code = code;
  if (details && typeof details === "object") error.details = details;
  return error;
}

function checkMatches(check, predicate = () => true) {
  return check?.ok === true && predicate(check);
}

/**
 * Validate the declared hosted deployment posture without changing the original
 * product into an organization-admin product. In EviMed's first SaaS profile an
 * authenticated individual account is the tenant boundary; projects are nested
 * isolation units inside that tenant.
 */
export function readinessSaasProfile(config, checks) {
  const profile = String(config.deploymentProfile ?? "controlled-pilot").trim().toLowerCase();
  if (!deploymentProfiles.has(profile)) {
    throw profileFailure("saas_profile_invalid", { profile });
  }

  const common = {
    profile,
    tenantModel: "individual-account",
    targetAudience: "individual-researchers",
    organizationCollaboration: false,
    billingIntegrated: false,
  };
  if (profile === "controlled-pilot") {
    return { ...common, technicalSaas: false };
  }
  if (!config.production) throw profileFailure("saas_profile_production_required");

  const requirements = [
    ["public-origin", checkMatches(checks.publicUrl, (check) => check.secure === true)],
    ["oidc-identity", checkMatches(checks.auth, (check) => check.mode === "oidc")],
    [
      "shared-control-plane",
      Boolean(config.requireSharedStateStore) &&
        checkMatches(checks.stateStore, (check) => check.mode === "postgres" && check.shared === true),
    ],
    ["project-isolation", checkMatches(checks.resources, (check) => check.production === true)],
    [
      "sandboxed-runtime",
      checkMatches(
        checks.runtime,
        (check) =>
          check.mode === "opencode" &&
          check.sandboxMode === "docker" &&
          check.controlPlane === "controller_socket",
      ),
    ],
    ["server-model-gateway", checkMatches(checks.modelGateway, (check) => check.enabled === true)],
    [
      "audited-science-connectors",
      checkMatches(checks.scienceConnectors, (check) => check.enabled === 7) && checkMatches(checks.evimedAdapters),
    ],
    ["research-memory", !config.requireMemos || checkMatches(checks.memory, (check) => check.connected === true)],
    ["release-provenance", checkMatches(checks.release, (check) => check.required === true && check.tracked === true)],
    [
      "external-recovery",
      checkMatches(checks.backup, (check) => check.mode === "external" && check.restoreDrill === true),
    ],
    [
      "content-safe-observability",
      checkMatches(checks.observability, (check) => check.required === true && check.mode === "protected"),
    ],
  ];
  const missing = requirements.filter(([, passed]) => !passed).map(([id]) => id);
  if (missing.length > 0) {
    throw profileFailure("saas_profile_requirements_missing", { missing });
  }

  return {
    ...common,
    technicalSaas: true,
    validatedBoundaries: requirements.map(([id]) => id),
  };
}

export const SAAS_DEPLOYMENT_PROFILES = Object.freeze([...deploymentProfiles]);
