const deploymentProfiles = new Set(["controlled-pilot", "individual-saas"]);

/** @returns {Error & Record<string, any>} An Error carrying the extra fields its
 *  callers read; a bare Error type rejects every one of them. */
function profileFailure(code, details = null) {
  /** @type {Error & Record<string, any>} */
  const error = new Error(code);
  error.code = code;
  if (details && typeof details === "object") error.details = details;
  return error;
}

/** @param {any} check @param {(check: any) => boolean} predicate */
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

  /** @type {[string, boolean][]} */
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
          check.mode === "kernel" &&
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
  // A surface this deployment has chosen not to configure, named one by one.
  //
  // Three of these requirements are not defects and never will be: this
  // deployment authenticates with local-auth rather than OIDC, holds no
  // Materials Project credential, and keeps its backups on one machine by
  // decision. Left undeclared they read exactly like the fourth — a stale model
  // gateway receipt, which IS a defect — and a readiness probe that is red for
  // four reasons, three of them permanent, is one nobody reads.
  //
  // So the gate closes on "every configured surface green, every unconfigured
  // one named". The declaration is per item, it cannot drift (an undeclared
  // miss still fails), and it hides nothing: what was declared comes back in
  // the readiness body next to what was validated.
  const declared = new Set(
    String(config.saasProfileUnconfigured ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const requirementIds = new Set(requirements.map(([id]) => id));
  // A declaration naming something that is not a requirement is a misspelling
  // of one that is, and it would quietly protect nothing.
  const unknown = [...declared].filter((id) => !requirementIds.has(id));
  if (unknown.length > 0) {
    throw profileFailure("saas_profile_declaration_unknown", { unknown, known: [...requirementIds] });
  }

  const failed = requirements.filter(([, passed]) => !passed).map(([id]) => id);
  const missing = failed.filter((id) => !declared.has(id));
  const declaredUnconfigured = failed.filter((id) => declared.has(id));
  if (missing.length > 0) {
    throw profileFailure("saas_profile_requirements_missing", { missing, declaredUnconfigured });
  }

  return {
    ...common,
    technicalSaas: true,
    validatedBoundaries: requirements.filter(([, passed]) => passed).map(([id]) => id),
    declaredUnconfigured,
  };
}

export const SAAS_DEPLOYMENT_PROFILES = Object.freeze([...deploymentProfiles]);
