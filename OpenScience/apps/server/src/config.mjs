import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseManifestFile, validateReleaseManifest } from "./releaseManifest.mjs";

const defaultSessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const bundledExamplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");
const bundledAgentPackagesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../runtime/skills/evimed",
);
const bundledEviMedMcpDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../runtime/mcp/evimed-research",
);

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function listEnv(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readSecretFile(file, codePrefix) {
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return { value: "", error: `${codePrefix}_file_not_regular` };
    if (stat.size > 8 * 1024) return { value: "", error: `${codePrefix}_file_too_large` };
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      return { value: "", error: `${codePrefix}_file_permissions` };
    }
    const value = fs.readFileSync(handle, "utf8").replace(/\r?\n$/, "");
    if (value.includes("\0")) return { value: "", error: `${codePrefix}_file_invalid` };
    return { value, error: null };
  } catch (err) {
    return {
      value: "",
      error: err?.code === "ELOOP"
        ? `${codePrefix}_file_symlink`
        : `${codePrefix}_file_unavailable`,
    };
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

function operatorMetricsSecret(overrides) {
  if (Object.hasOwn(overrides, "operatorMetricsToken")) {
    return { value: overrides.operatorMetricsToken ?? "", source: "override", error: null };
  }

  const direct = process.env.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN ?? "";
  const file = overrides.operatorMetricsTokenFile ?? process.env.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE ?? "";
  if (direct && file) {
    return { value: "", source: "conflict", error: "operator_metrics_token_source_conflict" };
  }
  if (file) {
    const loaded = readSecretFile(file, "operator_metrics_token");
    return { ...loaded, source: "file" };
  }
  return { value: direct, source: direct ? "environment" : "none", error: null };
}

function configuredSecret(overrides, {
  overrideValue,
  overrideFile,
  valueEnv,
  fileEnv,
  codePrefix,
  defaultFile = "",
}) {
  if (Object.hasOwn(overrides, overrideValue)) {
    return { value: overrides[overrideValue] ?? "", source: "override", error: null };
  }
  const direct = process.env[valueEnv] ?? "";
  const file = overrides[overrideFile] ?? process.env[fileEnv] ?? defaultFile;
  if (direct && file) {
    return { value: "", source: "conflict", error: `${codePrefix}_source_conflict` };
  }
  if (file) {
    const loaded = readSecretFile(file, codePrefix);
    return { ...loaded, source: "file" };
  }
  return { value: direct, source: direct ? "environment" : "none", error: null };
}

function preferredFileSecret(overrides, {
  overrideValue,
  overrideFile,
  valueEnv,
  fileEnv,
  codePrefix,
  defaultFile = "",
}) {
  const file = overrides[overrideFile] ?? process.env[fileEnv] ?? defaultFile;
  if (file) {
    const loaded = readSecretFile(file, codePrefix);
    return { ...loaded, source: "file" };
  }
  const direct = Object.hasOwn(overrides, overrideValue)
    ? overrides[overrideValue] ?? ""
    : process.env[valueEnv] ?? "";
  return { value: direct, source: direct ? (Object.hasOwn(overrides, overrideValue) ? "override" : "environment") : "none", error: null };
}

function releaseManifestConfig(overrides) {
  if (Object.hasOwn(overrides, "releaseManifest")) {
    if (overrides.releaseManifest == null) return { manifest: null, source: "none", error: null };
    try {
      return { manifest: validateReleaseManifest(overrides.releaseManifest), source: "override", error: null };
    } catch (err) {
      return { manifest: null, source: "override", error: err?.code ?? "release_manifest_invalid" };
    }
  }
  const file = overrides.releaseManifestFile ?? process.env.OPEN_SCIENCE_RELEASE_MANIFEST_FILE ?? "";
  return readReleaseManifestFile(file);
}

function bundledOpenCodeBinary(rootDir) {
  const target = process.platform === "darwin"
    ? process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
    : process.platform === "linux"
      ? process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
      : process.platform === "win32"
        ? "x86_64-pc-windows-msvc.exe"
        : "";
  if (!target) return "";
  return path.join(rootDir, "apps/desktop/src-tauri/binaries", `opencode-${target}`);
}

export function loadConfig(overrides = {}) {
  const rootDir = overrides.rootDir ?? process.cwd();
  const port = Number(overrides.port ?? process.env.OPEN_SCIENCE_PORT ?? 8787);
  const dataDir =
    overrides.dataDir ??
    process.env.OPEN_SCIENCE_DATA_DIR ??
    path.join(rootDir, ".openscience-web-data");
  const opencodeBin =
    overrides.opencodeBin ??
    process.env.OPEN_SCIENCE_OPENCODE_BIN ??
    bundledOpenCodeBinary(rootDir);
  const runtimeMode =
    overrides.runtimeMode ??
    process.env.OPEN_SCIENCE_RUNTIME_MODE ??
    "opencode";
  const legacyDevAuth = overrides.devAuth ?? boolEnv("OPEN_SCIENCE_DEV_AUTH", true);
  const authMode = String(
    overrides.authMode ?? process.env.OPEN_SCIENCE_AUTH_MODE ?? (legacyDevAuth ? "development" : "local"),
  ).trim().toLowerCase();
  const devAuth = authMode === "development";
  const production = overrides.production ?? process.env.NODE_ENV === "production";
  const localAutoConfig = !production && (
    overrides.localAutoConfig ?? boolEnv("OPEN_SCIENCE_LOCAL_AUTO_CONFIG", false)
  );
  const localSecretsDir = localAutoConfig ? path.resolve(rootDir, "..", ".evimed-local", "secrets") : "";
  const localSecretFile = (name) => {
    const candidate = localSecretsDir ? path.join(localSecretsDir, name) : "";
    return candidate && fs.existsSync(candidate) ? candidate : "";
  };
  const runtimeSkillDirs =
    overrides.runtimeSkillDirs ??
    (process.env.OPEN_SCIENCE_RUNTIME_SKILL_DIRS != null
      ? listEnv("OPEN_SCIENCE_RUNTIME_SKILL_DIRS")
      : [
          path.join(rootDir, "runtime/skills/core"),
          path.join(rootDir, "runtime/skills/external/ai4s-skills"),
          path.join(rootDir, "runtime/skills/curated-scientific"),
          path.join(rootDir, "runtime/skills/office"),
        ]);
  const agentPackageDirs =
    overrides.agentPackageDirs ??
    (process.env.OPEN_SCIENCE_AGENT_PACKAGE_DIRS != null
      ? listEnv("OPEN_SCIENCE_AGENT_PACKAGE_DIRS")
      : [bundledAgentPackagesDir]);
  const configuredMcpSourceDir =
    overrides.evimedMcpSourceDir ??
    process.env.OPEN_SCIENCE_EVIMED_MCP_SOURCE_DIR ??
    bundledEviMedMcpDir;
  const localMetaAgentRoot = localAutoConfig
    ? path.resolve(rootDir, "..", "项目代码", "meta")
    : "";
  const configuredMetaAgentRoot =
    overrides.metaAgentRoot ??
    process.env.OPEN_SCIENCE_META_AGENT_ROOT ??
    (localMetaAgentRoot && fs.existsSync(path.join(localMetaAgentRoot, "new_meta", "main.py"))
      ? localMetaAgentRoot
      : "");
  const configuredMetaAgentPython =
    overrides.metaAgentPython ?? process.env.OPEN_SCIENCE_META_AGENT_PYTHON ?? "";
  const localPharmacyReferenceDb = localAutoConfig
    ? path.resolve(rootDir, "..", ".evimed-local", "data", "pharmacy-reference.sqlite")
    : "";
  const configuredPharmacyReferenceDb =
    overrides.pharmacyReferenceDb ??
    process.env.OPEN_SCIENCE_PHARMACY_REFERENCE_DB ??
    (localPharmacyReferenceDb && fs.existsSync(localPharmacyReferenceDb) ? localPharmacyReferenceDb : "");
  const specialistAgentDefinitions = {
    mendelianRandomization: {
      rootEnv: "OPEN_SCIENCE_MR_AGENT_ROOT",
      pythonEnv: "OPEN_SCIENCE_MR_AGENT_PYTHON",
      localDir: "孟德尔随机化",
      marker: "mr_agent/core/engine.py",
    },
    bibliometricAnalysis: {
      rootEnv: "OPEN_SCIENCE_BIBLIOMETRIC_AGENT_ROOT",
      pythonEnv: "OPEN_SCIENCE_BIBLIOMETRIC_AGENT_PYTHON",
      localDir: "文献剂量分析",
      marker: "src/bibliometric/pipeline.py",
    },
    researchTopicSelection: {
      rootEnv: "OPEN_SCIENCE_RESEARCH_TOPIC_AGENT_ROOT",
      pythonEnv: "OPEN_SCIENCE_RESEARCH_TOPIC_AGENT_PYTHON",
      localDir: "科研选题",
      marker: "services/task_service.py",
    },
    peerReview: {
      rootEnv: "OPEN_SCIENCE_PEER_REVIEW_AGENT_ROOT",
      pythonEnv: "OPEN_SCIENCE_PEER_REVIEW_AGENT_PYTHON",
      localDir: "论文审稿",
      marker: "src/main_v2.py",
    },
    drugSafetyAnalysis: {
      rootEnv: "OPEN_SCIENCE_DRUG_SAFETY_AGENT_ROOT",
      pythonEnv: "OPEN_SCIENCE_DRUG_SAFETY_AGENT_PYTHON",
      localDir: "药物安全分析agent",
      marker: "safety_agent/analysis/pipeline.py",
    },
  };
  const configuredSpecialistAgents = overrides.specialistAgents ?? Object.fromEntries(
    Object.entries(specialistAgentDefinitions).map(([key, definition]) => {
      const localRoot = localAutoConfig ? path.resolve(rootDir, "..", "项目代码", definition.localDir) : "";
      const root = (process.env[definition.rootEnv] ?? "").trim()
        || (localRoot && fs.existsSync(path.join(localRoot, definition.marker)) ? localRoot : "");
      const python = (process.env[definition.pythonEnv] ?? "").trim();
      return [key, { root, python }];
    }),
  );
  const evimedAdapterUrls = overrides.evimedAdapterUrls ?? Object.fromEntries(
    [
      ["biomedicalSourceSearch", "EVIMED_BIOMEDICAL_SOURCE_SEARCH_URL"],
      ["literatureSearch", "EVIMED_LITERATURE_SEARCH_URL"],
      ["guidelineSearch", "EVIMED_GUIDELINE_SEARCH_URL"],
      ["clinicalTrialSearch", "EVIMED_CLINICAL_TRIAL_SEARCH_URL"],
      ["patentSearch", "EVIMED_PATENT_SEARCH_URL"],
      ["pharmacyReferenceSearch", "EVIMED_PHARMACY_REFERENCE_SEARCH_URL"],
      ["drugLabelSearch", "EVIMED_DRUG_LABEL_SEARCH_URL"],
      ["adrCaseQuery", "EVIMED_ADR_CASE_QUERY_URL"],
      ["adrSignalAnalysis", "EVIMED_ADR_SIGNAL_ANALYSIS_URL"],
      ["offlabelEvidencePacket", "EVIMED_OFFLABEL_EVIDENCE_PACKET_URL"],
      ["comprehensiveDrugEvaluation", "EVIMED_COMPREHENSIVE_DRUG_EVALUATION_URL"],
      ["drugSelectionEvaluation", "EVIMED_DRUG_SELECTION_EVALUATION_URL"],
      ["metaAnalysis", "EVIMED_META_ANALYSIS_URL"],
      ["mendelianRandomization", "EVIMED_MR_ANALYSIS_URL"],
      ["bibliometricAnalysis", "EVIMED_BIBLIOMETRIC_ANALYSIS_URL"],
      ["researchTopicSelection", "EVIMED_RESEARCH_TOPIC_SELECTION_URL"],
      ["peerReview", "EVIMED_PEER_REVIEW_URL"],
      ["drugSafetyAnalysis", "EVIMED_DRUG_SAFETY_ANALYSIS_URL"],
    ]
      .map(([key, envName]) => [key, (process.env[envName] ?? "").trim()])
      .filter(([, value]) => value),
  );
  const evimedWorkloadSecret = configuredSecret(overrides, {
    overrideValue: "evimedWorkloadSigningSecret",
    overrideFile: "evimedWorkloadSigningSecretFile",
    valueEnv: "OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET",
    fileEnv: "OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_FILE",
    codePrefix: "evimed_workload_signing_secret",
    defaultFile: localSecretFile("evimed-workload.signing"),
  });
  const deepseekSecret = preferredFileSecret(overrides, {
    overrideValue: "deepseekApiKey",
    overrideFile: "deepseekApiKeyFile",
    valueEnv: "OPEN_SCIENCE_DEEPSEEK_API_KEY",
    fileEnv: "OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE",
    codePrefix: "deepseek_api_key",
    defaultFile: localSecretFile("deepseek.api-key"),
  });
  const modelGatewaySecret = preferredFileSecret(overrides, {
    overrideValue: "modelGatewaySigningSecret",
    overrideFile: "modelGatewaySigningSecretFile",
    valueEnv: "OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET",
    fileEnv: "OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_FILE",
    codePrefix: "model_gateway_signing_secret",
    defaultFile: localSecretFile("model-gateway.signing"),
  });
  const materialsProjectSecret = preferredFileSecret(overrides, {
    overrideValue: "materialsProjectApiKey",
    overrideFile: "materialsProjectApiKeyFile",
    valueEnv: "OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY",
    fileEnv: "OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY_FILE",
    codePrefix: "materials_project_api_key",
  });
  const publicSourceCredentialSpecs = {
    evimedEvidence: ["evimedApiKey", "OPEN_SCIENCE_EVIMED_API_KEY", "evimed.api-key"],
    semanticScholar: ["semanticScholarApiKey", "OPEN_SCIENCE_SEMANTIC_SCHOLAR_API_KEY", "semantic-scholar.api-key"],
    core: ["coreApiKey", "OPEN_SCIENCE_CORE_API_KEY", "core.api-key"],
    unpaywall: ["unpaywallEmail", "OPEN_SCIENCE_UNPAYWALL_EMAIL", "unpaywall.email"],
    umls: ["umlsApiKey", "OPEN_SCIENCE_UMLS_API_KEY", "umls.api-key"],
    omim: ["omimApiKey", "OPEN_SCIENCE_OMIM_API_KEY", "omim.api-key"],
    addgene: ["addgeneApiKey", "OPEN_SCIENCE_ADDGENE_API_KEY", "addgene.api-key"],
    biogrid: ["biogridApiKey", "OPEN_SCIENCE_BIOGRID_API_KEY", "biogrid.api-key"],
    opengwas: ["opengwasJwt", "OPEN_SCIENCE_OPENGWAS_JWT", "opengwas.jwt"],
  };
  const publicSourceCredentialSecrets = Object.fromEntries(
    Object.entries(publicSourceCredentialSpecs).map(([profile, [overrideValue, valueEnv, localFile]]) => [
      profile,
      preferredFileSecret(overrides, {
        overrideValue,
        overrideFile: `${overrideValue}File`,
        valueEnv,
        fileEnv: `${valueEnv}_FILE`,
        codePrefix: `public_source_${profile.replaceAll(/([A-Z])/g, "_$1").toLowerCase()}`,
        defaultFile: localSecretFile(localFile),
      }),
    ]),
  );
  const memosSecret = preferredFileSecret(overrides, {
    overrideValue: "memosAccessToken",
    overrideFile: "memosAccessTokenFile",
    valueEnv: "OPEN_SCIENCE_MEMOS_ACCESS_TOKEN",
    fileEnv: "OPEN_SCIENCE_MEMOS_ACCESS_TOKEN_FILE",
    codePrefix: "memos_access_token",
    defaultFile: localSecretFile("memos.pat"),
  });
  const databaseSecret = preferredFileSecret(overrides, {
    overrideValue: "databaseUrl",
    overrideFile: "databaseUrlFile",
    valueEnv: "OPEN_SCIENCE_DATABASE_URL",
    fileEnv: "OPEN_SCIENCE_DATABASE_URL_FILE",
    codePrefix: "database_url",
  });
  const bootstrapSecret = configuredSecret(overrides, {
    overrideValue: "bootstrapPassword",
    overrideFile: "bootstrapPasswordFile",
    valueEnv: "OPEN_SCIENCE_BOOTSTRAP_PASSWORD",
    fileEnv: "OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE",
    codePrefix: "bootstrap_password",
    defaultFile: localSecretFile("bootstrap-password"),
  });
  const metricsSecret = operatorMetricsSecret(overrides);
  const oidcClientSecret = configuredSecret(overrides, {
    overrideValue: "oidcClientSecret",
    overrideFile: "oidcClientSecretFile",
    valueEnv: "OPEN_SCIENCE_OIDC_CLIENT_SECRET",
    fileEnv: "OPEN_SCIENCE_OIDC_CLIENT_SECRET_FILE",
    codePrefix: "oidc_client_secret",
  });
  const oidcFlowSecret = configuredSecret(overrides, {
    overrideValue: "oidcFlowSecret",
    overrideFile: "oidcFlowSecretFile",
    valueEnv: "OPEN_SCIENCE_OIDC_FLOW_SECRET",
    fileEnv: "OPEN_SCIENCE_OIDC_FLOW_SECRET_FILE",
    codePrefix: "oidc_flow_secret",
  });
  const release = releaseManifestConfig(overrides);
  const runtimeDataVolume =
    overrides.runtimeDataVolume ?? process.env.OPEN_SCIENCE_RUNTIME_DATA_VOLUME ?? "";
  const runtimeTransport =
    overrides.runtimeTransport ??
    process.env.OPEN_SCIENCE_RUNTIME_TRANSPORT ??
    (production ? "unix" : "tcp");
  const backupDir = overrides.backupDir ?? process.env.OPEN_SCIENCE_BACKUP_DIR ?? "";

  return {
    host: overrides.host ?? process.env.OPEN_SCIENCE_HOST ?? "127.0.0.1",
    port,
    rootDir,
    dataDir,
    examplesDir:
      overrides.examplesDir ?? process.env.OPEN_SCIENCE_EXAMPLES_DIR ?? bundledExamplesDir,
    usersFile: overrides.usersFile ?? process.env.OPEN_SCIENCE_USERS_FILE ?? path.join(dataDir, "users.json"),
    sessionsFile:
      overrides.sessionsFile ?? process.env.OPEN_SCIENCE_SESSIONS_FILE ?? path.join(dataDir, ".openscience", "sessions.json"),
    sessionTtlMs: Number(overrides.sessionTtlMs ?? process.env.OPEN_SCIENCE_SESSION_TTL_MS ?? defaultSessionTtlMs),
    bootstrapUser: overrides.bootstrapUser ?? process.env.OPEN_SCIENCE_BOOTSTRAP_USER ?? "",
    bootstrapPassword: bootstrapSecret.value,
    bootstrapPasswordSource: bootstrapSecret.source,
    bootstrapPasswordError: bootstrapSecret.error,
    publicUrl: overrides.publicUrl ?? process.env.OPEN_SCIENCE_PUBLIC_URL ?? "",
    operatorMetricsToken: metricsSecret.value,
    operatorMetricsTokenSource: metricsSecret.source,
    operatorMetricsTokenError: metricsSecret.error,
    releaseManifest: release.manifest,
    releaseManifestSource: release.source,
    releaseManifestError: release.error,
    releaseId: overrides.releaseId ?? process.env.OPEN_SCIENCE_RELEASE_ID ?? release.manifest?.app.releaseId ?? "",
    sourceRevision:
      overrides.sourceRevision ?? process.env.OPEN_SCIENCE_SOURCE_REVISION ?? release.manifest?.source.revision ?? "",
    buildCreatedAt:
      overrides.buildCreatedAt ?? process.env.OPEN_SCIENCE_BUILD_CREATED ?? release.manifest?.source.createdAt ?? "",
    appVersion: overrides.appVersion ?? process.env.OPEN_SCIENCE_APP_VERSION ?? release.manifest?.app.version ?? "0.1.3",
    webContainerImage:
      overrides.webContainerImage ??
      process.env.OPEN_SCIENCE_WEB_CONTAINER_IMAGE ??
      release.manifest?.web.image ??
      "open-science-web:0.1.3",
    staticDir: overrides.staticDir ?? process.env.OPEN_SCIENCE_STATIC_DIR ?? "",
    backupMode: overrides.backupMode ?? process.env.OPEN_SCIENCE_BACKUP_MODE ?? "disabled",
    backupDir,
    backupStateFile:
      overrides.backupStateFile ??
      process.env.OPEN_SCIENCE_BACKUP_STATE_FILE ??
      (backupDir ? path.join(backupDir, ".open-science-backup-state.json") : ""),
    backupIntervalSeconds: Number(
      overrides.backupIntervalSeconds ?? process.env.OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS ?? 86_400,
    ),
    backupHealthGraceSeconds: Number(
      overrides.backupHealthGraceSeconds ?? process.env.OPEN_SCIENCE_BACKUP_HEALTH_GRACE_SECONDS ?? 1_800,
    ),
    backupRetentionDays: Number(overrides.backupRetentionDays ?? process.env.OPEN_SCIENCE_BACKUP_RETENTION_DAYS ?? 0),
    backupPassphraseConfigured:
      overrides.backupPassphraseConfigured ??
      (
        boolEnv("OPEN_SCIENCE_BACKUP_ENCRYPTION_ACK", false) ||
        Boolean(process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE || process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE)
      ),
    backupExternalAck:
      overrides.backupExternalAck ?? boolEnv("OPEN_SCIENCE_BACKUP_EXTERNAL_ACK", false),
    restoreDrillAck: overrides.restoreDrillAck ?? boolEnv("OPEN_SCIENCE_RESTORE_DRILL_ACK", false),
    authMode,
    devAuth,
    oidcIssuer: overrides.oidcIssuer ?? process.env.OPEN_SCIENCE_OIDC_ISSUER ?? "",
    oidcClientId: overrides.oidcClientId ?? process.env.OPEN_SCIENCE_OIDC_CLIENT_ID ?? "",
    oidcClientAuthMethod:
      overrides.oidcClientAuthMethod ??
      process.env.OPEN_SCIENCE_OIDC_CLIENT_AUTH_METHOD ??
      "client_secret_basic",
    oidcClientSecret: oidcClientSecret.value,
    oidcClientSecretSource: oidcClientSecret.source,
    oidcClientSecretError: oidcClientSecret.error,
    oidcFlowSecret: oidcFlowSecret.value,
    oidcFlowSecretSource: oidcFlowSecret.source,
    oidcFlowSecretError: oidcFlowSecret.error,
    oidcScopes: String(overrides.oidcScopes ?? process.env.OPEN_SCIENCE_OIDC_SCOPES ?? "openid profile email")
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
    oidcLabel: overrides.oidcLabel ?? process.env.OPEN_SCIENCE_OIDC_LABEL ?? "Organization SSO",
    oidcAllowedGroups: overrides.oidcAllowedGroups ?? listEnv("OPEN_SCIENCE_OIDC_ALLOWED_GROUPS"),
    oidcGroupClaim: overrides.oidcGroupClaim ?? process.env.OPEN_SCIENCE_OIDC_GROUP_CLAIM ?? "groups",
    oidcAllowedEmailDomains:
      overrides.oidcAllowedEmailDomains ?? listEnv("OPEN_SCIENCE_OIDC_ALLOWED_EMAIL_DOMAINS"),
    oidcTimeoutMs: Number(overrides.oidcTimeoutMs ?? process.env.OPEN_SCIENCE_OIDC_TIMEOUT_MS ?? 10_000),
    oidcFlowTtlMs: Number(overrides.oidcFlowTtlMs ?? process.env.OPEN_SCIENCE_OIDC_FLOW_TTL_MS ?? 10 * 60_000),
    production,
    deploymentProfile: String(
      overrides.deploymentProfile ?? process.env.OPEN_SCIENCE_DEPLOYMENT_PROFILE ?? "controlled-pilot",
    ).trim().toLowerCase(),
    stateStore: String(
      overrides.stateStore ?? process.env.OPEN_SCIENCE_STATE_STORE ?? "file",
    ).trim().toLowerCase(),
    requireSharedStateStore:
      overrides.requireSharedStateStore ?? boolEnv("OPEN_SCIENCE_REQUIRE_SHARED_STATE_STORE", false),
    databaseUrl: databaseSecret.value,
    databaseUrlSource: databaseSecret.source,
    databaseUrlError: databaseSecret.error,
    databasePoolMax: Number(
      overrides.databasePoolMax ?? process.env.OPEN_SCIENCE_DATABASE_POOL_MAX ?? 10,
    ),
    databaseConnectionTimeoutMs: Number(
      overrides.databaseConnectionTimeoutMs ?? process.env.OPEN_SCIENCE_DATABASE_CONNECTION_TIMEOUT_MS ?? 10_000,
    ),
    enableKernel: overrides.enableKernel ?? boolEnv("OPEN_SCIENCE_ENABLE_KERNEL", false),
    kernelSandboxMode: overrides.kernelSandboxMode ?? process.env.OPEN_SCIENCE_KERNEL_SANDBOX_MODE ?? "host",
    kernelPythonBin: overrides.kernelPythonBin ?? process.env.OPEN_SCIENCE_KERNEL_PYTHON_BIN ?? "python3",
    kernelRBin: overrides.kernelRBin ?? process.env.OPEN_SCIENCE_KERNEL_R_BIN ?? "Rscript",
    maxKernelOutputBytes: Number(
      overrides.maxKernelOutputBytes ?? process.env.OPEN_SCIENCE_KERNEL_MAX_OUTPUT_BYTES ?? 1024 * 1024,
    ),
    kernelTimeoutMs: Number(overrides.kernelTimeoutMs ?? process.env.OPEN_SCIENCE_KERNEL_TIMEOUT_MS ?? 10_000),
    allowUnsandboxedKernel:
      overrides.allowUnsandboxedKernel ?? boolEnv("OPEN_SCIENCE_ALLOW_UNSANDBOXED_KERNEL", devAuth && !production),
    securityHeaders: overrides.securityHeaders ?? boolEnv("OPEN_SCIENCE_SECURITY_HEADERS", true),
    corsOrigins: overrides.corsOrigins ?? listEnv("OPEN_SCIENCE_CORS_ORIGINS"),
    maxJsonBytes: Number(overrides.maxJsonBytes ?? process.env.OPEN_SCIENCE_MAX_JSON_BYTES ?? 12 * 1024 * 1024),
    maxFileBytes: Number(overrides.maxFileBytes ?? process.env.OPEN_SCIENCE_MAX_FILE_BYTES ?? 50 * 1024 * 1024),
    maxProjectBytes: Number(overrides.maxProjectBytes ?? process.env.OPEN_SCIENCE_MAX_PROJECT_BYTES ?? 1024 * 1024 * 1024),
    maxWorkspaceScanEntries: Number(
      overrides.maxWorkspaceScanEntries ?? process.env.OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES ?? 10_000,
    ),
    maxArchiveEntries: Number(overrides.maxArchiveEntries ?? process.env.OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES ?? 10_000),
    maxArchiveBytes: Number(overrides.maxArchiveBytes ?? process.env.OPEN_SCIENCE_MAX_ARCHIVE_BYTES ?? 1024 * 1024 * 1024),
    maxProjectUsageScanEntries: Number(
      overrides.maxProjectUsageScanEntries ?? process.env.OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES ?? 10_000,
    ),
    maxLogReadBytes: Number(overrides.maxLogReadBytes ?? process.env.OPEN_SCIENCE_MAX_LOG_READ_BYTES ?? 1024 * 1024),
    maxLogFileBytes: Number(overrides.maxLogFileBytes ?? process.env.OPEN_SCIENCE_MAX_LOG_FILE_BYTES ?? 10 * 1024 * 1024),
    rateLimitWindowMs: Number(overrides.rateLimitWindowMs ?? process.env.OPEN_SCIENCE_RATE_LIMIT_WINDOW_MS ?? 60_000),
    rateLimitMaxRequests: Number(overrides.rateLimitMaxRequests ?? process.env.OPEN_SCIENCE_RATE_LIMIT_MAX_REQUESTS ?? 600),
    authRateLimitWindowMs: Number(
      overrides.authRateLimitWindowMs ?? process.env.OPEN_SCIENCE_AUTH_RATE_LIMIT_WINDOW_MS ?? 5 * 60_000,
    ),
    authRateLimitMaxRequests: Number(
      overrides.authRateLimitMaxRequests ?? process.env.OPEN_SCIENCE_AUTH_RATE_LIMIT_MAX_REQUESTS ?? 20,
    ),
    commandRateLimitWindowMs: Number(
      overrides.commandRateLimitWindowMs ?? process.env.OPEN_SCIENCE_COMMAND_RATE_LIMIT_WINDOW_MS ?? 60_000,
    ),
    commandRateLimitMaxRequests: Number(
      overrides.commandRateLimitMaxRequests ?? process.env.OPEN_SCIENCE_COMMAND_RATE_LIMIT_MAX_REQUESTS ?? 120,
    ),
    trustProxy: overrides.trustProxy ?? boolEnv("OPEN_SCIENCE_TRUST_PROXY", false),
    maxConcurrentCommands: Number(overrides.maxConcurrentCommands ?? process.env.OPEN_SCIENCE_MAX_CONCURRENT_COMMANDS ?? 8),
    maxConcurrentKernels: Number(
      overrides.maxConcurrentKernels ?? process.env.OPEN_SCIENCE_MAX_CONCURRENT_KERNELS ?? 2,
    ),
    maxConcurrentKernelsPerUser: Number(
      overrides.maxConcurrentKernelsPerUser ?? process.env.OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER ?? 1,
    ),
    maxConcurrentTasks: Number(overrides.maxConcurrentTasks ?? process.env.OPEN_SCIENCE_MAX_CONCURRENT_TASKS ?? 2),
    maxConcurrentTasksPerProject: Number(
      overrides.maxConcurrentTasksPerProject ?? process.env.OPEN_SCIENCE_MAX_CONCURRENT_TASKS_PER_PROJECT ?? 1,
    ),
    maxQueuedTasks: Number(overrides.maxQueuedTasks ?? process.env.OPEN_SCIENCE_MAX_QUEUED_TASKS ?? 100),
    maxQueuedTasksPerProject: Number(
      overrides.maxQueuedTasksPerProject ?? process.env.OPEN_SCIENCE_MAX_QUEUED_TASKS_PER_PROJECT ?? 25,
    ),
    commandTimeoutMs: Number(overrides.commandTimeoutMs ?? process.env.OPEN_SCIENCE_COMMAND_TIMEOUT_MS ?? 120_000),
    runtimeProxyConnectTimeoutMs: Number(
      overrides.runtimeProxyConnectTimeoutMs ?? process.env.OPEN_SCIENCE_RUNTIME_PROXY_CONNECT_TIMEOUT_MS ?? 30_000,
    ),
    runtimeProxyRequestTimeoutMs: Number(
      overrides.runtimeProxyRequestTimeoutMs ?? process.env.OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS ?? 120_000,
    ),
    runtimeIdleTimeoutMs: Number(
      overrides.runtimeIdleTimeoutMs ?? process.env.OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS ?? 30 * 60_000,
    ),
    runtimeQuotaCheckIntervalMs: Number(
      overrides.runtimeQuotaCheckIntervalMs ?? process.env.OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS ?? 30_000,
    ),
    maxRuntimeProxyConnections: Number(
      overrides.maxRuntimeProxyConnections ?? process.env.OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS ?? 64,
    ),
    maxRuntimeProxyConnectionsPerProject: Number(
      overrides.maxRuntimeProxyConnectionsPerProject ??
        process.env.OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT ??
        8,
    ),
    maxRunningRuntimes: Number(overrides.maxRunningRuntimes ?? process.env.OPEN_SCIENCE_MAX_RUNNING_RUNTIMES ?? 8),
    maxRunningRuntimesPerUser: Number(
      overrides.maxRunningRuntimesPerUser ?? process.env.OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER ?? 4,
    ),
    runtimeMode,
    allowMockRuntime: overrides.allowMockRuntime ?? boolEnv("OPEN_SCIENCE_ALLOW_MOCK_RUNTIME", !production),
    opencodeBin,
    runtimeSandboxMode: overrides.runtimeSandboxMode ?? process.env.OPEN_SCIENCE_RUNTIME_SANDBOX_MODE ?? "host",
    runtimeContainerBin: overrides.runtimeContainerBin ?? process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_BIN ?? "docker",
    runtimeControllerMode: String(
      overrides.runtimeControllerMode ?? process.env.OPEN_SCIENCE_RUNTIME_CONTROLLER_MODE ?? "direct",
    ).trim().toLowerCase(),
    runtimeControllerSocket:
      overrides.runtimeControllerSocket ??
      process.env.OPEN_SCIENCE_RUNTIME_CONTROLLER_SOCKET ??
      (production
        ? "/run/open-science-controller/controller.sock"
        : path.join(dataDir, ".openscience", "runtime-controller.sock")),
    runtimeControllerTimeoutMs: Number(
      overrides.runtimeControllerTimeoutMs ?? process.env.OPEN_SCIENCE_RUNTIME_CONTROLLER_TIMEOUT_MS ?? 10_000,
    ),
    runtimeControllerPollMs: Number(
      overrides.runtimeControllerPollMs ?? process.env.OPEN_SCIENCE_RUNTIME_CONTROLLER_POLL_MS ?? 500,
    ),
    allowDirectDockerControl:
      overrides.allowDirectDockerControl ?? boolEnv("OPEN_SCIENCE_ALLOW_DIRECT_DOCKER_CONTROL", !production),
    runtimeContainerImage:
      overrides.runtimeContainerImage ??
      process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE ??
      release.manifest?.runtime.image ??
      "open-science-opencode:opencode-1.17.13-uv-0.11.26",
    opencodeVersion:
      overrides.opencodeVersion ??
      process.env.OPEN_SCIENCE_OPENCODE_VERSION ??
      release.manifest?.runtime.opencodeVersion ??
      "1.17.13",
    uvVersion:
      overrides.uvVersion ?? process.env.OPEN_SCIENCE_UV_VERSION ?? release.manifest?.runtime.uvVersion ?? "0.11.26",
    runtimeRequireImageLocal:
      overrides.runtimeRequireImageLocal ?? boolEnv("OPEN_SCIENCE_RUNTIME_REQUIRE_IMAGE_LOCAL", production),
    runtimeDataVolume,
    runtimeTransport,
    runtimeNetworkMode:
      overrides.runtimeNetworkMode ??
      process.env.OPEN_SCIENCE_RUNTIME_NETWORK_MODE ??
      (runtimeTransport === "unix" ? "none" : "bridge"),
    runtimeInternalNetworkName:
      overrides.runtimeInternalNetworkName ?? process.env.OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME ?? "",
    allowRuntimeNetworkEgress:
      overrides.allowRuntimeNetworkEgress ?? boolEnv("OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS", !production),
    runtimeNetworkEgressPolicyAck:
      overrides.runtimeNetworkEgressPolicyAck ??
      boolEnv("OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK", false),
    runtimeCpuLimit: overrides.runtimeCpuLimit ?? process.env.OPEN_SCIENCE_RUNTIME_CPU_LIMIT ?? "2",
    runtimeMemoryLimit: overrides.runtimeMemoryLimit ?? process.env.OPEN_SCIENCE_RUNTIME_MEMORY_LIMIT ?? "4g",
    runtimePidsLimit: Number(overrides.runtimePidsLimit ?? process.env.OPEN_SCIENCE_RUNTIME_PIDS_LIMIT ?? 256),
    runtimeNoNewPrivileges:
      overrides.runtimeNoNewPrivileges ?? boolEnv("OPEN_SCIENCE_RUNTIME_NO_NEW_PRIVILEGES", true),
    runtimeCapDrop: overrides.runtimeCapDrop ?? process.env.OPEN_SCIENCE_RUNTIME_CAP_DROP ?? "ALL",
    runtimeReadOnlyRoot:
      overrides.runtimeReadOnlyRoot ?? boolEnv("OPEN_SCIENCE_RUNTIME_READ_ONLY_ROOT", true),
    runtimeTmpfs: overrides.runtimeTmpfs ?? process.env.OPEN_SCIENCE_RUNTIME_TMPFS ?? "/tmp:rw,nosuid,nodev,size=64m",
    runtimeContainerUser: overrides.runtimeContainerUser ?? process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_USER ?? "",
    runtimeSkillDirs: runtimeSkillDirs.map((dir) => (path.isAbsolute(dir) ? dir : path.join(rootDir, dir))),
    agentPackageDirs: agentPackageDirs.map((dir) => (path.isAbsolute(dir) ? dir : path.join(rootDir, dir))),
    evimedMcpSourceDir: path.isAbsolute(configuredMcpSourceDir)
      ? configuredMcpSourceDir
      : path.join(rootDir, configuredMcpSourceDir),
    metaAgentRoot: configuredMetaAgentRoot
      ? (path.isAbsolute(configuredMetaAgentRoot) ? configuredMetaAgentRoot : path.join(rootDir, configuredMetaAgentRoot))
      : "",
    metaAgentPython: configuredMetaAgentPython
      ? (path.isAbsolute(configuredMetaAgentPython) ? configuredMetaAgentPython : path.join(rootDir, configuredMetaAgentPython))
      : "",
    specialistAgents: Object.fromEntries(
      Object.entries(configuredSpecialistAgents).map(([key, value]) => [key, {
        root: value?.root
          ? (path.isAbsolute(value.root) ? value.root : path.join(rootDir, value.root))
          : "",
        python: value?.python
          ? (path.isAbsolute(value.python) ? value.python : path.join(rootDir, value.python))
          : "",
      }]),
    ),
    evimedAdapterUrls,
    pharmacyReferenceDb: configuredPharmacyReferenceDb
      ? (path.isAbsolute(configuredPharmacyReferenceDb)
        ? configuredPharmacyReferenceDb
        : path.join(rootDir, configuredPharmacyReferenceDb))
      : "",
    requireAllSpecialistAdapters:
      overrides.requireAllSpecialistAdapters ??
      boolEnv("OPEN_SCIENCE_REQUIRE_ALL_SPECIALIST_ADAPTERS", false),
    evimedWorkloadSigningSecret: evimedWorkloadSecret.value,
    evimedWorkloadSigningSecretSource: evimedWorkloadSecret.source,
    evimedWorkloadSigningSecretError: evimedWorkloadSecret.error,
    evimedWorkloadTokenTtlSeconds: Number(
      overrides.evimedWorkloadTokenTtlSeconds ??
      process.env.OPEN_SCIENCE_EVIMED_WORKLOAD_TOKEN_TTL_SECONDS ??
      300,
    ),
    deepseekProviderEnabled:
      overrides.deepseekProviderEnabled ?? boolEnv("OPEN_SCIENCE_DEEPSEEK_PROVIDER_ENABLED", Boolean(deepseekSecret.value)),
    deepseekApiKey: deepseekSecret.value,
    deepseekApiKeySource: deepseekSecret.source,
    deepseekApiKeyError: deepseekSecret.error,
    deepseekBaseUrl:
      overrides.deepseekBaseUrl ?? process.env.OPEN_SCIENCE_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    deepseekModel:
      overrides.deepseekModel ?? process.env.OPEN_SCIENCE_DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    modelGatewaySigningSecret: modelGatewaySecret.value,
    modelGatewaySigningSecretSource: modelGatewaySecret.source,
    modelGatewaySigningSecretError: modelGatewaySecret.error,
    materialsProjectApiKey: materialsProjectSecret.value,
    materialsProjectApiKeySource: materialsProjectSecret.source,
    materialsProjectApiKeyError: materialsProjectSecret.error,
    publicSourceCredentials: Object.fromEntries(
      Object.entries(publicSourceCredentialSecrets).map(([profile, secret]) => [profile, secret.value]),
    ),
    publicSourceCredentialSources: Object.fromEntries(
      Object.entries(publicSourceCredentialSecrets).map(([profile, secret]) => [profile, secret.source]),
    ),
    publicSourceCredentialErrors: Object.fromEntries(
      Object.entries(publicSourceCredentialSecrets).map(([profile, secret]) => [profile, secret.error]),
    ),
    modelGatewayInternalUrl:
      overrides.modelGatewayInternalUrl ??
      process.env.OPEN_SCIENCE_MODEL_GATEWAY_INTERNAL_URL ??
      (production
        ? "http://open-science-web:8787/internal/model/v1"
        : `http://127.0.0.1:${port}/internal/model/v1`),
    publicSourceGatewayInternalUrl:
      overrides.publicSourceGatewayInternalUrl ??
      process.env.OPEN_SCIENCE_PUBLIC_SOURCE_GATEWAY_INTERNAL_URL ??
      (production
        ? "http://open-science-web:8787/internal/sources/v1/fetch"
        : `http://127.0.0.1:${port}/internal/sources/v1/fetch`),
    publicSourceGatewayTimeoutMs: Number(
      overrides.publicSourceGatewayTimeoutMs ??
      process.env.OPEN_SCIENCE_PUBLIC_SOURCE_GATEWAY_TIMEOUT_MS ??
      60_000,
    ),
    publicSourceGatewayMaxResponseBytes: Number(
      overrides.publicSourceGatewayMaxResponseBytes ??
      process.env.OPEN_SCIENCE_PUBLIC_SOURCE_GATEWAY_MAX_RESPONSE_BYTES ??
      4 * 1024 * 1024,
    ),
    modelGatewayTimeoutMs: Number(
      overrides.modelGatewayTimeoutMs ?? process.env.OPEN_SCIENCE_MODEL_GATEWAY_TIMEOUT_MS ?? 300_000,
    ),
    modelGatewayMaxBodyBytes: Number(
      overrides.modelGatewayMaxBodyBytes ?? process.env.OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES ?? 2 * 1024 * 1024,
    ),
    modelGatewayMaxResponseBytes: Number(
      overrides.modelGatewayMaxResponseBytes ??
      process.env.OPEN_SCIENCE_MODEL_GATEWAY_MAX_RESPONSE_BYTES ??
      32 * 1024 * 1024,
    ),
    deepseekReleaseReceiptFile:
      overrides.deepseekReleaseReceiptFile ?? process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_FILE ?? "",
    deepseekReleaseReceiptId:
      overrides.deepseekReleaseReceiptId ?? process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_ID ?? "",
    deepseekConfigRevision:
      overrides.deepseekConfigRevision ?? process.env.OPEN_SCIENCE_DEEPSEEK_CONFIG_REVISION ?? "",
    deepseekReleaseReceiptMaxAgeMs: Number(
      overrides.deepseekReleaseReceiptMaxAgeMs ??
      process.env.OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_MAX_AGE_MS ??
      24 * 60 * 60 * 1000,
    ),
    memosUrl: String(
      overrides.memosUrl ?? process.env.OPEN_SCIENCE_MEMOS_URL ?? (memosSecret.value ? "http://127.0.0.1:8081" : ""),
    ).replace(/\/+$/, ""),
    memosAccessToken: memosSecret.value,
    memosAccessTokenSource: memosSecret.source,
    memosAccessTokenError: memosSecret.error,
    memosRequestTimeoutMs: Number(
      overrides.memosRequestTimeoutMs ?? process.env.OPEN_SCIENCE_MEMOS_REQUEST_TIMEOUT_MS ?? 8_000,
    ),
    memosContextLimit: Number(
      overrides.memosContextLimit ?? process.env.OPEN_SCIENCE_MEMOS_CONTEXT_LIMIT ?? 8,
    ),
    memosContextMaxChars: Number(
      overrides.memosContextMaxChars ?? process.env.OPEN_SCIENCE_MEMOS_CONTEXT_MAX_CHARS ?? 20_000,
    ),
    requireMemos:
      overrides.requireMemos ?? boolEnv("OPEN_SCIENCE_REQUIRE_MEMOS", false),
    knowledgeChunkChars: Number(
      overrides.knowledgeChunkChars ?? process.env.OPEN_SCIENCE_KNOWLEDGE_CHUNK_CHARS ?? 1_600,
    ),
    knowledgeChunkOverlapChars: Number(
      overrides.knowledgeChunkOverlapChars ?? process.env.OPEN_SCIENCE_KNOWLEDGE_CHUNK_OVERLAP_CHARS ?? 240,
    ),
    knowledgeTopK: Number(
      overrides.knowledgeTopK ?? process.env.OPEN_SCIENCE_KNOWLEDGE_TOP_K ?? 6,
    ),
    knowledgeContextMaxChars: Number(
      overrides.knowledgeContextMaxChars ?? process.env.OPEN_SCIENCE_KNOWLEDGE_CONTEXT_MAX_CHARS ?? 12_000,
    ),
    knowledgeIndexMaxFileBytes: Number(
      overrides.knowledgeIndexMaxFileBytes ?? process.env.OPEN_SCIENCE_KNOWLEDGE_INDEX_MAX_FILE_BYTES ?? 5 * 1024 * 1024,
    ),
    knowledgeIndexMaxChars: Number(
      overrides.knowledgeIndexMaxChars ?? process.env.OPEN_SCIENCE_KNOWLEDGE_INDEX_MAX_CHARS ?? 5_000_000,
    ),
    allowRuntimeHostNetwork:
      overrides.allowRuntimeHostNetwork ?? boolEnv("OPEN_SCIENCE_ALLOW_RUNTIME_HOST_NETWORK", false),
    allowUnsandboxedRuntime:
      overrides.allowUnsandboxedRuntime ?? boolEnv("OPEN_SCIENCE_ALLOW_UNSANDBOXED_RUNTIME", devAuth),
    allowHostShell: overrides.allowHostShell ?? boolEnv("OPEN_SCIENCE_ALLOW_HOST_SHELL", false),
    allowDirectShell: overrides.allowDirectShell ?? boolEnv("OPEN_SCIENCE_ALLOW_DIRECT_SHELL", false),
    allowPersistentApprovals:
      overrides.allowPersistentApprovals ?? boolEnv("OPEN_SCIENCE_ALLOW_PERSISTENT_APPROVALS", false),
    allowFullApproval: overrides.allowFullApproval ?? boolEnv("OPEN_SCIENCE_ALLOW_FULL_APPROVAL", false),
    approvalMode: overrides.approvalMode ?? process.env.OPEN_SCIENCE_APPROVAL_MODE ?? "approve",
    sessionCookieName: overrides.sessionCookieName ?? "os_session",
  };
}
