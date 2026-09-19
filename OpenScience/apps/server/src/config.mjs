import fs from "node:fs";
import { defaultDeepSeekModel } from "./modelGateway.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "./dshProfilePatch.mjs";
import { readReleaseManifestFile, validateReleaseManifest } from "./releaseManifest.mjs";

/**
 * How much of the caller's window a gateway leaves itself to answer in.
 *
 * A deadline equal to the ceiling is still a deadline the caller never sees:
 * the abort and the response race, and the response has to be serialized and
 * written. Thirty seconds is generous on purpose — the cost of being wrong the
 * other way is an error message nobody receives.
 */
const GATEWAY_RESPONSE_MARGIN_MS = 30_000;

// The one place a tracked upstream pin is written. A Dockerfile ARG, a seam
// manifest, a peer dependency and a release manifest that each carried their
// own copy meant "bump the pin" was four edits and one was always missed.
//
// Read rather than imported as a JSON module: the control plane already reads
// files, and an import attribute is a parse error on the linter this repo pins.
// The domain package uses the import form because it must not touch `node:fs`.
const depsVersions = JSON.parse(
  fs.readFileSync(new URL("../../../deps-version.json", import.meta.url), "utf8"),
);

const defaultSessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const bundledExamplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");
const bundledAgentPackagesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../runtime/skills/evimed",
);
const bundledCapabilitiesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../capabilities",
);
const bundledEviMedMcpDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../runtime/mcp/evimed-research",
);

/** DeepSeek's thinking-effort levels, exactly. Anything else is a typo that
 *  would otherwise ride to the provider on every call. */
export const DEEPSEEK_REASONING_EFFORTS = Object.freeze(["low", "high", "max"]);

/** @param {unknown} value */
function parseReasoningEffort(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!DEEPSEEK_REASONING_EFFORTS.includes(effort)) {
    throw new Error(`OPEN_SCIENCE_DEEPSEEK_REASONING_EFFORT must be one of ${DEEPSEEK_REASONING_EFFORTS.join(", ")}, got ${JSON.stringify(value)}.`);
  }
  return effort;
}

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
    // A secret may carry one LF or CRLF terminator. Bound the content after
    // removing that terminator so every caller agrees on the same 8 KiB value.
    if (stat.size > 8 * 1024 + 2) return { value: "", error: `${codePrefix}_file_too_large` };
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      return { value: "", error: `${codePrefix}_file_permissions` };
    }
    const value = fs.readFileSync(handle, "utf8").replace(/\r?\n$/, "");
    if (Buffer.byteLength(value, "utf8") > 8 * 1024) {
      return { value: "", error: `${codePrefix}_file_too_large` };
    }
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

export function loadConfig(overrides = {}) {
  const rootDir = overrides.rootDir ?? process.cwd();
  const port = Number(overrides.port ?? process.env.OPEN_SCIENCE_PORT ?? 8787);
  const dataDir =
    overrides.dataDir ??
    process.env.OPEN_SCIENCE_DATA_DIR ??
    path.join(rootDir, ".openscience-web-data");
  // The runtime's *shape*: a real agent kernel in a container, or the in-process
  // fake the tests and local demos run against. The value used to be spelled
  // "opencode" because the only real kernel was OpenCode; the name outlived the
  // kernel, and a deployment still setting it is configuring something that
  // does not exist, so it is refused by name rather than quietly accepted.
  const runtimeMode = String(
    overrides.runtimeMode ?? process.env.OPEN_SCIENCE_RUNTIME_MODE ?? "kernel",
  ).trim().toLowerCase();
  if (runtimeMode === "opencode") {
    throw new Error(
      'OPEN_SCIENCE_RUNTIME_MODE no longer accepts "opencode": DSH is the only kernel. Use "kernel".',
    );
  }
  if (!["kernel", "mock"].includes(runtimeMode)) {
    throw new Error(`OPEN_SCIENCE_RUNTIME_MODE must be "kernel" or "mock", got "${runtimeMode}".`);
  }
  // Removed variables fail loudly for one release rather than being aliased or
  // ignored: a deployment still exporting one is a deployment configuring
  // something that no longer exists, and silence hides that until someone
  // wonders why the setting never took effect.
  for (const [oldName, remedy] of [
    ["OPEN_SCIENCE_RUNTIME_KERNEL", "DSH is the only kernel; remove this variable"],
    ["OPEN_SCIENCE_OPENCODE_BIN", "set OPEN_SCIENCE_DSH_BIN instead"],
    ["OPEN_SCIENCE_OPENCODE_VERSION", "set OPEN_SCIENCE_DSH_VERSION instead"],
    // Research memory is a schema of the control-plane database now, not a
    // service to address and authenticate against. A deployment still setting
    // these is pointing at something that is not there, and the failure it
    // would otherwise get is silence.
    ["OPEN_SCIENCE_MEMOS_URL", "research memory lives in the control-plane database; remove this variable"],
    ["OPEN_SCIENCE_MEMOS_ACCESS_TOKEN", "research memory needs no credential of its own; remove this variable"],
    ["OPEN_SCIENCE_MEMOS_ACCESS_TOKEN_FILE", "research memory needs no credential of its own; remove this variable"],
    ["OPEN_SCIENCE_MEMOS_REQUEST_TIMEOUT_MS", "research memory is an in-process store; remove this variable"],
    ["OPEN_SCIENCE_REQUIRE_MEMOS", "research memory exists exactly when the control-plane database does; remove this variable"],
    ["OPEN_SCIENCE_MEMOS_CONTEXT_LIMIT", "set OPEN_SCIENCE_MEMORY_CONTEXT_LIMIT instead"],
    ["OPEN_SCIENCE_MEMOS_CONTEXT_MAX_CHARS", "set OPEN_SCIENCE_MEMORY_CONTEXT_MAX_CHARS instead"],
    ["OPEN_SCIENCE_MEMOS_ENGINE_URL", "the recall index is OpenViking; set OPEN_SCIENCE_OPENVIKING_URL instead"],
    ["OPEN_SCIENCE_REQUIRE_MEMORY_INDEX", "set OPEN_SCIENCE_MEMORY_INDEX_STRICT instead"],
    // The MinerU container read its input from a shared staging directory
    // under a shared group. The in-house parser receives the bytes in the
    // request itself, so there is no directory, owner or group to configure.
    ["OPEN_SCIENCE_DOCUMENT_PARSER_STAGING_DIR", "the parser receives the bytes over HTTP; remove this variable"],
    ["OPEN_SCIENCE_DOCUMENT_PARSER_UID", "the parser receives the bytes over HTTP; remove this variable"],
    ["OPEN_SCIENCE_DOCUMENT_PARSER_GID", "the parser receives the bytes over HTTP; remove this variable"],
  ]) {
    if (process.env[oldName]) throw new Error(`${oldName} is not read any more: ${remedy}.`);
  }
  const dshBin = overrides.dshBin ?? process.env.OPEN_SCIENCE_DSH_BIN ?? "dsh";
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
  // Deliberately NOT the list of everything the release binds. The image bakes
  // its skill roots in rather than copying them per project — adding
  // `capability-skills` here made
  // the host runtime try to deliver a tree it must not, which surfaced as a 409
  // where a timeout was expected. What a release must digest is the generator's
  // list in `scripts/ops/generate-release-manifest.mjs`, which is a superset, so
  // `runtimeReleasePolicyError`'s membership check still holds.
  const agentPackageDirs =
    overrides.agentPackageDirs ??
    (process.env.OPEN_SCIENCE_AGENT_PACKAGE_DIRS != null
      ? listEnv("OPEN_SCIENCE_AGENT_PACKAGE_DIRS")
      : [bundledAgentPackagesDir]);
  const capabilityDirs = overrides.capabilityDirs ?? (process.env.OPEN_SCIENCE_CAPABILITY_DIRS != null
    ? listEnv("OPEN_SCIENCE_CAPABILITY_DIRS") : [bundledCapabilitiesDir]);
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
  // Optional. Empty means the probe hop is unauthenticated, which is stated in
  // every answer rather than left for someone to discover.
  const geoProbeSecret = preferredFileSecret(overrides, {
    overrideValue: "geoProbeSigningSecret",
    overrideFile: "geoProbeSigningSecretFile",
    valueEnv: "OPEN_SCIENCE_GEO_PROBE_SIGNING_SECRET",
    fileEnv: "OPEN_SCIENCE_GEO_PROBE_SIGNING_SECRET_FILE",
    codePrefix: "geo_probe_signing_secret",
    defaultFile: localSecretFile("geo-probe.signing"),
  });
  const materialsProjectSecret = preferredFileSecret(overrides, {
    overrideValue: "materialsProjectApiKey",
    overrideFile: "materialsProjectApiKeyFile",
    valueEnv: "OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY",
    fileEnv: "OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY_FILE",
    codePrefix: "materials_project_api_key",
    defaultFile: localSecretFile("materials-project.api-key"),
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
    // Rate-ceiling keys, not authorizing ones: both upstreams serve without
    // them, just slower. Injected by host in the gateway rather than through a
    // credential profile, because a profiled host is *required* to carry one.
    ncbi: ["ncbiApiKey", "OPEN_SCIENCE_NCBI_API_KEY", "ncbi.api-key"],
    openFda: ["openFdaApiKey", "OPEN_SCIENCE_OPENFDA_API_KEY", "openfda.api-key"],
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
  // The reranker's credential. It is the same host file the recall index's own
  // configuration is rendered from: the control plane already holds every
  // server-side credential, and the reranker runs here because the index's
  // reranked endpoint cannot reach our memory leaves. The runtime container
  // never receives it.
  const dashscopeSecret = preferredFileSecret(overrides, {
    overrideValue: "dashscopeApiKey",
    overrideFile: "dashscopeApiKeyFile",
    valueEnv: "OPEN_SCIENCE_DASHSCOPE_API_KEY",
    fileEnv: "OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE",
    codePrefix: "dashscope_api_key",
    defaultFile: localSecretFile("dashscope.api-key"),
  });
  const openVikingSecret = preferredFileSecret(overrides, {
    overrideValue: "openVikingApiKey",
    overrideFile: "openVikingApiKeyFile",
    valueEnv: "OPEN_SCIENCE_OPENVIKING_API_KEY",
    fileEnv: "OPEN_SCIENCE_OPENVIKING_API_KEY_FILE",
    codePrefix: "openviking_api_key",
    defaultFile: localSecretFile("openviking.api-key"),
  });
  const documentParserSecret = preferredFileSecret(overrides, {
    overrideValue: "documentParserToken",
    overrideFile: "documentParserTokenFile",
    valueEnv: "OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN",
    fileEnv: "OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN_FILE",
    codePrefix: "document_parser_token",
    defaultFile: localSecretFile("document-parser.token"),
  });
  const openListSecret = preferredFileSecret(overrides, {
    overrideValue: "openListToken",
    overrideFile: "openListTokenFile",
    valueEnv: "OPEN_SCIENCE_OPENLIST_TOKEN",
    fileEnv: "OPEN_SCIENCE_OPENLIST_TOKEN_FILE",
    codePrefix: "openlist_token",
    defaultFile: localSecretFile("openlist.token"),
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
  // The kernel has no TCP transport, and this is where that fact belongs.
  // Its web host refuses to bind anything but loopback, so a published port
  // maps to an interface nothing is listening on; and the container entrypoint
  // that seeds the profile, disables telemetry and injects the deployment's
  // settings is the same script that runs the socat bridge, so the TCP path
  // skipped all of it. A non-production DSH deployment used to take the TCP
  // default silently and produce a container that died during boot saying it
  // had no profile. Kept as a refusal rather than a silent coercion: a
  // deployment that asked for TCP is a deployment expecting a published port.
  // rt: which provider runs a project's runtime (plan §3.1 #1). `docker` is a
  // container on this host behind the runtime controller; `agentbay` is one
  // Alibaba AgentBay cloud session per project, reached over its session link.
  const runtimeProvider = String(overrides.runtimeProvider ?? process.env.OPEN_SCIENCE_RUNTIME_PROVIDER ?? "docker").trim().toLowerCase();
  if (!["docker", "agentbay"].includes(runtimeProvider)) {
    throw new Error(`OPEN_SCIENCE_RUNTIME_PROVIDER must be "docker" or "agentbay", got "${runtimeProvider}".`);
  }
  // `wss` is the AgentBay session link: the kernel still listens on loopback
  // inside the session, and the control plane reaches it through the link and
  // the session bridge (deploy/runtime-dsh/evimed-session-bridge.mjs). Each
  // provider has exactly one transport. A Docker runtime asked to use `wss` is
  // refused by name; an AgentBay runtime is always reached over its links, and
  // a `unix` beside it is accepted because the compose files hand the Docker
  // value to every service that builds a launch plan — the controller and the
  // receipt scheduler keep running Docker runtimes on this host — so the switch
  // is the provider alone.
  const runtimeTransportSetting =
    overrides.runtimeTransport ?? process.env.OPEN_SCIENCE_RUNTIME_TRANSPORT ?? (runtimeProvider === "agentbay" ? "wss" : "unix");
  if (!["unix", "wss"].includes(runtimeTransportSetting)) {
    throw new Error(`OPEN_SCIENCE_RUNTIME_TRANSPORT must be "unix" or "wss", got "${runtimeTransportSetting}".`);
  }
  if (runtimeProvider === "docker" && runtimeTransportSetting === "wss") {
    throw new Error(`OPEN_SCIENCE_RUNTIME_TRANSPORT "wss" does not fit OPEN_SCIENCE_RUNTIME_PROVIDER "docker": a Docker runtime is reached over its unix socket; "wss" is the AgentBay provider's link.`);
  }
  const runtimeTransport = runtimeProvider === "agentbay" ? "wss" : runtimeTransportSetting;
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
    postgresBackupStateFile: overrides.postgresBackupStateFile ?? process.env.OPEN_SCIENCE_POSTGRES_BACKUP_STATE_FILE ?? "",
    postgresBackupMaxAgeSeconds: Number(overrides.postgresBackupMaxAgeSeconds ?? process.env.OPEN_SCIENCE_POSTGRES_BACKUP_MAX_AGE_SECONDS ?? 90000),
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
    // Whether anyone may create an account here. Off by default: a deployment
    // that turns it on is choosing to be open, and that choice belongs to the
    // operator rather than to whichever build happens to be running.
    selfRegistrationEnabled:
      overrides.selfRegistrationEnabled ?? boolEnv("OPEN_SCIENCE_SELF_REGISTRATION_ENABLED", false),
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
    securityHeaders: overrides.securityHeaders ?? boolEnv("OPEN_SCIENCE_SECURITY_HEADERS", true),
    corsOrigins: overrides.corsOrigins ?? listEnv("OPEN_SCIENCE_CORS_ORIGINS"),
    maxJsonBytes: Number(overrides.maxJsonBytes ?? process.env.OPEN_SCIENCE_MAX_JSON_BYTES ?? 12 * 1024 * 1024),
    maxFileBytes: Number(overrides.maxFileBytes ?? process.env.OPEN_SCIENCE_MAX_FILE_BYTES ?? 50 * 1024 * 1024),
    maxProjectBytes: Number(overrides.maxProjectBytes ?? process.env.OPEN_SCIENCE_MAX_PROJECT_BYTES ?? 1024 * 1024 * 1024),
    // How many projects one account may hold. Each carries its own storage
    // quota and its own runtime, so without a count the per-project limits
    // bound nothing: an account can have as much disk and as many containers
    // as it cares to create projects.
    maxProjectsPerUser: Number(
      overrides.maxProjectsPerUser ?? process.env.OPEN_SCIENCE_MAX_PROJECTS_PER_USER ?? 20,
    ) || 20,
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
    maxConcurrentTasks: Number(overrides.maxConcurrentTasks ?? process.env.OPEN_SCIENCE_MAX_CONCURRENT_TASKS ?? 2),
    maxConcurrentTasksPerProject: Number(
      overrides.maxConcurrentTasksPerProject ?? process.env.OPEN_SCIENCE_MAX_CONCURRENT_TASKS_PER_PROJECT ?? 1,
    ),
    maxQueuedTasks: Number(overrides.maxQueuedTasks ?? process.env.OPEN_SCIENCE_MAX_QUEUED_TASKS ?? 100),
    maxQueuedTasksPerProject: Number(
      overrides.maxQueuedTasksPerProject ?? process.env.OPEN_SCIENCE_MAX_QUEUED_TASKS_PER_PROJECT ?? 25,
    ),
    commandTimeoutMs: Number(overrides.commandTimeoutMs ?? process.env.OPEN_SCIENCE_COMMAND_TIMEOUT_MS ?? 120_000),
    // How long a fresh runtime may take to answer its first request. Separate
    // from the per-call connect timeout below because they answer different
    // questions: that one asks "is this call hung", this one asks "has the
    // kernel finished starting". Under DSH those differ by an order of
    // magnitude — composing the profile's plugin tree takes about a minute on
    // this hardware, and the 30s deadline this used to carry killed runtimes
    // that were merely still composing and reported them as failures.
    runtimeReadyTimeoutMs: Number(
      overrides.runtimeReadyTimeoutMs
        ?? process.env.OPEN_SCIENCE_RUNTIME_READY_TIMEOUT_MS
        ?? 180_000,
    ),
    runtimeProxyConnectTimeoutMs: Number(
      overrides.runtimeProxyConnectTimeoutMs ?? process.env.OPEN_SCIENCE_RUNTIME_PROXY_CONNECT_TIMEOUT_MS ?? 30_000,
    ),
    runtimeProxyRequestTimeoutMs: Number(
      overrides.runtimeProxyRequestTimeoutMs ?? process.env.OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS ?? 120_000,
    ),
    runtimeIdleTimeoutMs: Number(
      overrides.runtimeIdleTimeoutMs ?? process.env.OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS ?? 30 * 60_000,
    ),
    // How long a deliberate stop may spend reading the transcripts of the runs
    // it is about to finish, before it gives up and closes the container
    // anyway. A bound rather than a budget: the capture is best effort, and a
    // container held open waiting for a pathological run's history is worse
    // than the `history_unavailable` this replaces. Timeouts are audited
    // (`run.transcript.prestop`), never silent.
    runtimePreStopTranscriptTimeoutMs: Number(
      overrides.runtimePreStopTranscriptTimeoutMs ?? process.env.OPEN_SCIENCE_RUNTIME_PRE_STOP_TRANSCRIPT_TIMEOUT_MS ?? 15_000,
    ),
    runtimeQuotaCheckIntervalMs: Number(
      overrides.runtimeQuotaCheckIntervalMs ?? process.env.OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS ?? 30_000,
    ),
    // A systematic review screens and extracts hundreds of records, so the run
    // monitor has to outlast the specialist rather than the other way round.
    agentRunMonitorTimeoutMs: Number(
      overrides.agentRunMonitorTimeoutMs ?? process.env.OPEN_SCIENCE_AGENT_RUN_MONITOR_TIMEOUT_MS ?? 4 * 60 * 60_000,
    ),
    maxRuntimeProxyConnections: Number(
      overrides.maxRuntimeProxyConnections ?? process.env.OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS ?? 64,
    ),
    maxRuntimeProxyConnectionsPerProject: Number(
      overrides.maxRuntimeProxyConnectionsPerProject ??
        process.env.OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT ??
        8,
    ),
    // rt: an AgentBay session costs this host nothing, so its provider's
    // default is the plan's 100 (Pro allows 200 sessions); Docker keeps 8.
    maxRunningRuntimes: Number(overrides.maxRunningRuntimes ?? process.env.OPEN_SCIENCE_MAX_RUNNING_RUNTIMES ?? (runtimeProvider === "agentbay" ? 100 : 8)),
    // Spend caps, in the price list's currency, per account. Zero means no
    // cap, which is the default: a limit nobody chose is a limit that fires at
    // the worst moment, and until the deployment has seen a month of real
    // usage there is no number to choose. Both are checked at dispatch, not
    // mid-run — stopping a run halfway spends everything it cost and delivers
    // nothing.
    userDailySpendLimit: Number(
      overrides.userDailySpendLimit ?? process.env.OPEN_SCIENCE_USER_DAILY_SPEND_LIMIT ?? 0,
    ) || 0,
    userWeeklySpendLimit: Number(
      overrides.userWeeklySpendLimit ?? process.env.OPEN_SCIENCE_USER_WEEKLY_SPEND_LIMIT ?? 0,
    ) || 0,
    requireDurableUsageLedger:
      overrides.requireDurableUsageLedger ?? boolEnv("OPEN_SCIENCE_REQUIRE_DURABLE_USAGE_LEDGER", production),
    modelGatewayReservationMaxOutputTokens: Number(
      overrides.modelGatewayReservationMaxOutputTokens
      ?? process.env.OPEN_SCIENCE_MODEL_GATEWAY_RESERVATION_MAX_OUTPUT_TOKENS
      ?? 65_536,
    ),
    maxRunningRuntimesPerUser: Number(
      overrides.maxRunningRuntimesPerUser ?? process.env.OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER ?? (runtimeProvider === "agentbay" ? 2 : 4),
    ),
    runtimeMode,
    dshBin,
    allowMockRuntime: overrides.allowMockRuntime ?? boolEnv("OPEN_SCIENCE_ALLOW_MOCK_RUNTIME", !production),
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
      `open-science-runtime:dsh-${depsVersions.dsh?.version ?? ""}-uv-0.11.26`,
    uvVersion:
      overrides.uvVersion ?? process.env.OPEN_SCIENCE_UV_VERSION ?? release.manifest?.runtime.uvVersion ?? "0.11.26",
    // Every version below is derived from deps-version.json, which is the one
    // place a tracked upstream pin is written. A test asserts they are equal.
    dshVersion:
      overrides.dshVersion ??
      process.env.OPEN_SCIENCE_DSH_VERSION ??
      release.manifest?.runtime?.dshVersion ??
      depsVersions.dsh?.version ??
      "0.1.5-rc.2",
    socketBundleVersion:
      overrides.socketBundleVersion ??
      process.env.OPEN_SCIENCE_SOCKET_BUNDLE_VERSION ??
      release.manifest?.runtime?.socketVersion ??
      "0.1.0",
    // The one knob for the whole retry story: the run-side submit ceiling and
    // the control plane's repair loop are the same number (§10.4).
    deliveryAttemptLimit: Number(
      overrides.deliveryAttemptLimit ?? process.env.OPEN_SCIENCE_DELIVERY_ATTEMPT_LIMIT ?? 3,
    ),
    // How many times the control plane sends a finished package back to the
    // run after its own gate has looked at it. 0 since 2026-09-17: measured on
    // twelve live runs, 24 such rounds cost 10 to 35 minutes each and produced
    // no package that passed clean; what the gate finds is attached to the
    // delivery instead. The run still repairs inside its own turn (the ceiling
    // above). An empty value reads as 0, which is the default, not a surprise.
    gateRepairRounds: Math.max(0, Math.trunc(Number(
      overrides.gateRepairRounds ?? process.env.OPEN_SCIENCE_GATE_REPAIR_ROUNDS ?? 0,
    )) || 0),
    maxParallelChildren: Number(
      overrides.maxParallelChildren ?? process.env.OPEN_SCIENCE_MAX_PARALLEL_CHILDREN ?? 30,
    ),
    // S2 delegation limits (2026-09-18). `maxParallelChildren` above was one
    // name with two meanings — a lifetime total in delegation, a wave size in
    // screening — and non-blocking delegation needs both, separately. Each
    // falls back to the old variable, so a deployment that set it keeps what
    // it had; unset, both are the old default.
    maxChildrenTotal: Number(
      overrides.maxChildrenTotal ?? overrides.maxParallelChildren
        ?? process.env.OPEN_SCIENCE_MAX_CHILDREN_TOTAL ?? process.env.OPEN_SCIENCE_MAX_PARALLEL_CHILDREN ?? 30,
    ),
    maxConcurrentChildren: Number(
      overrides.maxConcurrentChildren ?? overrides.maxParallelChildren
        ?? process.env.OPEN_SCIENCE_MAX_CONCURRENT_CHILDREN ?? process.env.OPEN_SCIENCE_MAX_PARALLEL_CHILDREN ?? 30,
    ),
    runMaxSteps: Number(overrides.runMaxSteps ?? process.env.OPEN_SCIENCE_RUN_MAX_STEPS ?? 0),
    runMaxTokens: Number(overrides.runMaxTokens ?? process.env.OPEN_SCIENCE_RUN_MAX_TOKENS ?? 0),
    evidenceStaleMinutes: Number(
      overrides.evidenceStaleMinutes ?? process.env.OPEN_SCIENCE_EVIDENCE_STALE_MINUTES ?? 10,
    ),
    // Records per screening child. The plugin hard-coded 50 and the control
    // plane had no way to say otherwise, so a deployment whose records are
    // long had to edit the bundle. Concurrency is deliberately absent here:
    // screening children are delegation children, and giving them a second
    // ceiling would mean two numbers that must agree and one place to forget
    // (§10.4) — `maxParallelChildren` above governs both.
    screeningBatchSize: Number(
      overrides.screeningBatchSize ?? process.env.OPEN_SCIENCE_SCREENING_BATCH_SIZE ?? 50,
    ),
    // A hosted container must have a working Landlock backend or the shell tool
    // fails closed while the runtime still looks healthy; a laptop gets
    // Seatbelt, which reports partial.
    runtimeSandboxEnforcement: String(
      overrides.runtimeSandboxEnforcement ?? process.env.OPEN_SCIENCE_RUNTIME_SANDBOX_ENFORCEMENT ?? (production ? "full" : "partial"),
    ).trim().toLowerCase(),
    runtimeAskUserEnabled: overrides.runtimeAskUserEnabled ?? boolEnv("OPEN_SCIENCE_RUNTIME_ASK_USER", false),
    // Defaults to on, because that is what every hosted run has actually been
    // getting: both sites that build the container's flags wrote `review: true`
    // as a literal and read nothing. Wiring them to this setting while it
    // defaulted to `false` would have turned cross-deliverable semantic review
    // off everywhere — a silent capability removal disguised as a bug fix.
    runtimeReviewEnabled: overrides.runtimeReviewEnabled ?? boolEnv("OPEN_SCIENCE_RUNTIME_REVIEW_ENABLED", true),
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
    // 4g was not enough: the DSH kernel alone held 2.9 GiB resident when the
    // cgroup OOM killer took it (`constraint=CONSTRAINT_MEMCG`, dmesg,
    // 2026-08-26), and the container's own limit is what ran out — the host
    // had 9.7 GiB free at the time. Raised with the sampler above watching, so
    // a working set that keeps climbing rather than settling is visible as a
    // leak instead of being absorbed by a bigger number.
    runtimeMemoryLimit: overrides.runtimeMemoryLimit ?? process.env.OPEN_SCIENCE_RUNTIME_MEMORY_LIMIT ?? "8g",
    // 256 was not enough, and the way it failed is why it took nine runs to
    // find. The cgroup counts THREADS, and a clinical run at full stretch holds
    // the kernel, its MCP python, one socat per connection, bash subprocesses
    // and up to `maxParallelChildren` delegated agents at once. Hitting the
    // ceiling produced `socat: E fork(): Resource temporarily unavailable` and
    // an exit code of 1 -- no OOM, no signal, nothing in dmesg or the cgroup's
    // memory events, and the container deleted by `--rm` before anything could
    // ask. Three runs died that way with no diagnosis available at all.
    //
    // Sampled at five minutes into a run it read 17 of 256, which is exactly
    // how a ceiling like this hides: the sample proves the moment, not the peak.
    runtimePidsLimit: Number(overrides.runtimePidsLimit ?? process.env.OPEN_SCIENCE_RUNTIME_PIDS_LIMIT ?? 1024),
    runtimeNoNewPrivileges:
      overrides.runtimeNoNewPrivileges ?? boolEnv("OPEN_SCIENCE_RUNTIME_NO_NEW_PRIVILEGES", true),
    runtimeCapDrop: overrides.runtimeCapDrop ?? process.env.OPEN_SCIENCE_RUNTIME_CAP_DROP ?? "ALL",
    runtimeReadOnlyRoot:
      overrides.runtimeReadOnlyRoot ?? boolEnv("OPEN_SCIENCE_RUNTIME_READ_ONLY_ROOT", true),
    runtimeTmpfs: overrides.runtimeTmpfs ?? process.env.OPEN_SCIENCE_RUNTIME_TMPFS ?? "/tmp:rw,nosuid,nodev,size=64m",
    runtimeContainerUser: overrides.runtimeContainerUser ?? process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_USER ?? "",
    runtimeSkillDirs: runtimeSkillDirs.map((dir) => (path.isAbsolute(dir) ? dir : path.join(rootDir, dir))),
    agentPackageDirs: agentPackageDirs.map((dir) => (path.isAbsolute(dir) ? dir : path.join(rootDir, dir))),
    capabilityDirs: capabilityDirs.map((dir) => (path.isAbsolute(dir) ? dir : path.join(rootDir, dir))),
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
    // Base tool names this deployment deliberately does not offer, passed to
    // the research MCP so a run never sees a tool nobody will serve. Distinct
    // from an adapter URL left empty, which means "this should work and does
    // not" and is answered with `adapter_unconfigured`.
    evimedDisabledTools: String(
      overrides.evimedDisabledTools ?? process.env.EVIMED_DISABLED_TOOLS ?? "",
    ).split(",").map((name) => name.trim()).filter(Boolean).join(","),
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
      overrides.deepseekModel ?? process.env.OPEN_SCIENCE_DEEPSEEK_MODEL ?? defaultDeepSeekModel,
    // The thinking budget every managed model call runs at. DeepSeek exposes
    // three levels since 2026-08-13 (low / high / max); this was a literal
    // `high` in the gateway, so the one experiment the clinical line's
    // number-integrity failures call for — the same brief at `max` — needed a
    // code change and a release. A deployment lever, closed vocabulary,
    // refused at load rather than passed upstream to be refused there.
    deepseekReasoningEffort: parseReasoningEffort(
      overrides.deepseekReasoningEffort ?? process.env.OPEN_SCIENCE_DEEPSEEK_REASONING_EFFORT ?? "high",
    ),
    // LLM-augmented open-domain routing. On by default: the classifier only
    // runs after the regex router returns no match and fails safe to
    // open-domain on any error (see specialistClassifier.mjs). Set
    // OPEN_SCIENCE_LLM_ROUTING_ENABLED=false to fall back to regex-only routing.
    llmRoutingEnabled:
      overrides.llmRoutingEnabled ?? boolEnv("OPEN_SCIENCE_LLM_ROUTING_ENABLED", true),
    llmRoutingConfidenceThreshold: Number(
      overrides.llmRoutingConfidenceThreshold
        ?? process.env.OPEN_SCIENCE_LLM_ROUTING_CONFIDENCE_THRESHOLD
        ?? 0.75,
    ),
    modelGatewaySigningSecret: modelGatewaySecret.value,
    modelGatewaySigningSecretSource: modelGatewaySecret.source,
    modelGatewaySigningSecretError: modelGatewaySecret.error,
    materialsProjectApiKey: materialsProjectSecret.value,
    materialsProjectApiKeySource: materialsProjectSecret.source,
    materialsProjectApiKeyError: materialsProjectSecret.error,
    // Which individual-saas requirements this deployment knowingly does not
    // meet. Comma-separated requirement ids; see readinessSaasProfile.
    saasProfileUnconfigured:
      overrides.saasProfileUnconfigured ?? process.env.OPEN_SCIENCE_SAAS_PROFILE_UNCONFIGURED ?? "",
    requireMaterialsProject:
      overrides.requireMaterialsProject ?? boolEnv("OPEN_SCIENCE_REQUIRE_MATERIALS_PROJECT", true),
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
    // The ToolUniverse sidecar's MCP endpoint. Empty by default: a deployment
    // that does not run one emits no MCP row and is unchanged. The runtime
    // container reaches this over the internal network; the sidecar, not the
    // container, is what holds ToolUniverse's own credentials.
    toolUniverseMcpUrl:
      overrides.toolUniverseMcpUrl ?? process.env.OPEN_SCIENCE_TOOLUNIVERSE_MCP_URL ?? "",
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
      16 * 1024 * 1024,
    ),
    // The self-hosted metasearch origin. Empty means the deployment has no
    // open-web channel; the tool then refuses with a stated reason instead of
    // the runtime silently getting nothing back.
    webSearchUrl: overrides.webSearchUrl ?? process.env.OPEN_SCIENCE_WEB_SEARCH_URL ?? "",
    webSearchGatewayInternalUrl:
      overrides.webSearchGatewayInternalUrl ??
      process.env.OPEN_SCIENCE_WEB_SEARCH_GATEWAY_INTERNAL_URL ??
      (production
        ? "http://open-science-web:8787/internal/search/v1/query"
        : `http://127.0.0.1:${port}/internal/search/v1/query`),
    webSearchTimeoutMs: Number(
      overrides.webSearchTimeoutMs ?? process.env.OPEN_SCIENCE_WEB_SEARCH_TIMEOUT_MS ?? 30_000,
    ),
    // The GEO probe origin: an internal service this platform runs, not a
    // public source. Empty means the deployment has no measured-visibility
    // channel, and the tool says so instead of the runtime silently getting
    // nothing back and reporting a brand as absent.
    // The kernel's own browser application, proxied per project behind this
    // control plane's session. Off by default: switching it on lets an
    // authenticated browser reach that kernel's whole surface, which is the
    // rule the pass-through route was retired to enforce, so it is an
    // operator's decision rather than a deployment default.
    runtimeUiProxyEnabled: overrides.runtimeUiProxyEnabled
      ?? boolEnv("OPEN_SCIENCE_RUNTIME_UI_PROXY_ENABLED", false),
    // A separate origin prevents the native application from reading the shell.
    // Per-frame prefixes and the official transport hook keep project identity
    // on every resource and API request while cookies remain same-site.
    runtimeUiPort: Number(overrides.runtimeUiPort ?? process.env.OPEN_SCIENCE_RUNTIME_UI_PORT ?? 0),
    // What to put in the iframe. The listener's own port is not it: a browser
    // reaches this deployment through whatever terminates TLS in front of it,
    // and that is the origin the page must name.
    runtimeUiPublicOrigin:
      overrides.runtimeUiPublicOrigin ?? process.env.OPEN_SCIENCE_RUNTIME_UI_PUBLIC_ORIGIN ?? "",
    // Frame tickets cannot outlive the authenticated login that created them.
    runtimeUiFrameTtlMs: Number(overrides.runtimeUiFrameTtlMs ?? process.env.OPEN_SCIENCE_RUNTIME_UI_FRAME_TTL_MS
      ?? overrides.sessionTtlMs ?? process.env.OPEN_SCIENCE_SESSION_TTL_MS ?? defaultSessionTtlMs),
    // Frame layer (S3, 2026-09-18): which bodies of the kernel page's EviMed
    // layer to switch off (`theme,panels,...`; the bridge is not switchable).
    // Each is off-able on its own, and the kernel's own conversation is what
    // remains with all of them off — the control every body is measured against.
    runtimeUiFrameOff: String(overrides.runtimeUiFrameOff ?? process.env.OPEN_SCIENCE_RUNTIME_UI_FRAME_OFF ?? "")
      .split(",").map((value) => value.trim().toLowerCase()).filter((value) => /^[a-z]{1,32}$/.test(value)),
    geoProbeUrl: overrides.geoProbeUrl ?? process.env.OPEN_SCIENCE_GEO_PROBE_URL ?? "",
    geoProbeGatewayInternalUrl:
      overrides.geoProbeGatewayInternalUrl ??
      process.env.OPEN_SCIENCE_GEO_PROBE_GATEWAY_INTERNAL_URL ??
      (production
        ? "http://open-science-web:8787/internal/geo-probe/v1"
        : `http://127.0.0.1:${port}/internal/geo-probe/v1`),
    // One probe drives a browser through a whole answer; the upstream's own
    // ceiling is about five minutes.
    // Under the kernel's tool-call ceiling, with room to write the answer.
    //
    // It was 360_000 against a ceiling of 180_000, so the gateway's own
    // `geo_probe_timeout` could never be delivered: the kernel abandoned the
    // call first and the run saw an opaque abort at ~183 s. Three production
    // geo-content runs reported "all 10 probe rounds failed" without being able
    // to say that the channel, not the engines, was what failed. A configured
    // value at or above the ceiling is clamped rather than honoured, because
    // honouring it would restore exactly that silence.
    geoProbeTimeoutMs: Math.min(
      MCP_TOOL_CALL_TIMEOUT_MS - GATEWAY_RESPONSE_MARGIN_MS,
      Math.max(1_000, Number(
        overrides.geoProbeTimeoutMs ?? process.env.OPEN_SCIENCE_GEO_PROBE_TIMEOUT_MS ?? 150_000,
      ) || 150_000),
    ),
    // Plaintext to a public address is refused unless the operator says
    // otherwise. The questions are not secret; the measurements are the
    // product, and an unauthenticated hop means a wrong number is
    // indistinguishable from a tampered one.
    geoProbeAllowPlaintext:
      overrides.geoProbeAllowPlaintext ?? process.env.OPEN_SCIENCE_GEO_PROBE_ALLOW_PLAINTEXT === "1",
    geoProbeSigningSecret: geoProbeSecret.value,
    geoProbeSigningSecretSource: geoProbeSecret.source,
    geoProbeSigningSecretError: geoProbeSecret.error,
    // Idle time, not total time: the deadline is re-armed on every streamed
    // chunk. As a total it cut reasoning turns off mid-answer — one measured
    // run spent 68 of 87 minutes re-issuing calls killed while they were
    // streaming — and because the abort lands after the response has started,
    // it left neither a status nor a log line. Raise this only if a model
    // genuinely goes quiet for longer between chunks; it is not a cap on how
    // long a turn may take.
    modelGatewayTimeoutMs: Number(
      overrides.modelGatewayTimeoutMs ?? process.env.OPEN_SCIENCE_MODEL_GATEWAY_TIMEOUT_MS ?? 300_000,
    ),
    // Every tool call and result is a message, so a systematic review run
    // reaches several hundred long before it is finished. Request size stays
    // bounded by modelGatewayMaxBodyBytes; this is the structural guard.
    modelGatewayMaxMessages: Number(
      overrides.modelGatewayMaxMessages ?? process.env.OPEN_SCIENCE_MODEL_GATEWAY_MAX_MESSAGES ?? 1024,
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
    // How much of a recall reaches the prompt: how many memories, and how many
    // characters they may spend between them. The budget is product policy, so
    // it is the same number whichever component ranked the candidates.
    memoryContextLimit: Number(
      overrides.memoryContextLimit ?? process.env.OPEN_SCIENCE_MEMORY_CONTEXT_LIMIT ?? 8,
    ),
    memoryContextMaxChars: Number(
      overrides.memoryContextMaxChars ?? process.env.OPEN_SCIENCE_MEMORY_CONTEXT_MAX_CHARS ?? 20_000,
    ),
    // Which component decides *which* memories a question sees. `builtin` is
    // the term matcher inside the research-memory store and needs nothing
    // deployed; `openviking` delegates the ranking to a context database. The
    // record itself stays authoritative in the control-plane database either
    // way, so this switch changes recall quality and nothing else. Unset, the
    // index is selected exactly when it is configured (an OpenViking URL and
    // its key) — `memorySubstrate.memoryIndexSelection` decides, and readiness
    // says which way and why.
    memoryIndexProvider: String(
      overrides.memoryIndexProvider ?? process.env.OPEN_SCIENCE_MEMORY_INDEX_PROVIDER ?? "",
    ).trim(),
    // Report-only by default (development principle 4: a new check ships as a
    // notice before it may block). Set this and a recall whose index is down
    // fails instead of falling back to the term matcher.
    memoryIndexStrict: overrides.memoryIndexStrict ?? boolEnv("OPEN_SCIENCE_MEMORY_INDEX_STRICT", false),
    openVikingUrl: String(overrides.openVikingUrl ?? process.env.OPEN_SCIENCE_OPENVIKING_URL ?? "").replace(/\/+$/, ""),
    openVikingApiKey: openVikingSecret.value,
    openVikingApiKeySource: openVikingSecret.source,
    openVikingApiKeyError: openVikingSecret.error,
    openVikingAccount: String(
      overrides.openVikingAccount ?? process.env.OPEN_SCIENCE_OPENVIKING_ACCOUNT ?? "evimed",
    ),
    openVikingRequestTimeoutMs: Number(
      overrides.openVikingRequestTimeoutMs ?? process.env.OPEN_SCIENCE_OPENVIKING_REQUEST_TIMEOUT_MS ?? 8_000,
    ),
    // The reranker that orders what a recall has already hydrated. The model,
    // the endpoint and the timeout default to the pins the index's own
    // compatibility is recorded under, because a reranker trained against one
    // embedding family and pointed at another is a silent quality regression.
    // With no key the reranker is inert and the vector order stands.
    dashscopeApiKey: dashscopeSecret.value,
    dashscopeApiKeySource: dashscopeSecret.source,
    dashscopeApiKeyError: dashscopeSecret.error,
    memoryRerankModel: String(
      overrides.memoryRerankModel ?? process.env.OPEN_SCIENCE_MEMORY_RERANK_MODEL
      ?? depsVersions.openviking?.rerank?.model ?? "",
    ),
    memoryRerankApiBase: String(
      overrides.memoryRerankApiBase ?? process.env.OPEN_SCIENCE_MEMORY_RERANK_API_BASE
      ?? depsVersions.openviking?.rerank?.apiBase ?? "",
    ),
    memoryRerankTimeoutMs: Number(
      overrides.memoryRerankTimeoutMs ?? process.env.OPEN_SCIENCE_MEMORY_RERANK_TIMEOUT_MS
      ?? depsVersions.openviking?.rerank?.timeoutMs ?? 3_000,
    ),
    memoryIndexPollMs: Number(
      overrides.memoryIndexPollMs ?? process.env.OPEN_SCIENCE_MEMORY_INDEX_POLL_MS ?? 1_000,
    ),
    memoryIndexLeaseMs: Number(
      overrides.memoryIndexLeaseMs ?? process.env.OPEN_SCIENCE_MEMORY_INDEX_LEASE_MS ?? 300_000,
    ),
    memoryIndexReconcileMs: Number(
      overrides.memoryIndexReconcileMs ?? process.env.OPEN_SCIENCE_MEMORY_INDEX_RECONCILE_MS ?? 300_000,
    ),
    documentParserUrl: String(overrides.documentParserUrl ?? process.env.OPEN_SCIENCE_DOCUMENT_PARSER_URL ?? "").replace(/\/+$/, ""),
    documentParserToken: documentParserSecret.value,
    documentParserTokenSource: documentParserSecret.source,
    documentParserTokenError: documentParserSecret.error,
    // The whole parse — every attempt and the waits between them — not one
    // request. 300 s (plan §2.2): the API waits on Alibaba DocMind inside a
    // single request, which takes minutes on a long scanned document; past
    // five minutes the job queue's own retry, with the source's backoff, is a
    // better next step than holding the same connection open.
    documentParserTimeoutMs: Number(
      overrides.documentParserTimeoutMs ?? process.env.OPEN_SCIENCE_DOCUMENT_PARSER_TIMEOUT_MS ?? 300_000,
    ),
    // The label the knowledge-base index is keyed by, with each file's SHA-256.
    // The parser reports no version of its own, so this is the only way a
    // parser upgrade can reach the index: move the label and every document
    // parsed under the old one is re-indexed. Its default is the pin.
    documentParserRevision: String(
      overrides.documentParserRevision ?? process.env.OPEN_SCIENCE_DOCUMENT_PARSER_REVISION
      ?? depsVersions["evimed-extract"]?.revision ?? "",
    ).trim(),
    // One Crossref lookup per parsed document that names a DOI, made by the
    // ingestion worker between parse and capture. 8 s is several times
    // Crossref's usual answer and short enough that an outage costs a source
    // its DOI check (left unconfirmed), never its ingestion.
    sourceDoiCheckTimeoutMs: Number(
      overrides.sourceDoiCheckTimeoutMs ?? process.env.OPEN_SCIENCE_SOURCE_DOI_CHECK_TIMEOUT_MS ?? 8_000,
    ),
    openListUrl: String(overrides.openListUrl ?? process.env.OPEN_SCIENCE_OPENLIST_URL ?? "").replace(/\/+$/, ""),
    openListToken: openListSecret.value,
    openListTokenSource: openListSecret.source,
    openListTokenError: openListSecret.error,
    openListTenantRoot: String(overrides.openListTenantRoot ?? process.env.OPEN_SCIENCE_OPENLIST_TENANT_ROOT ?? "/tenants"),
    openListMaxDownloadBytes: Number(
      overrides.openListMaxDownloadBytes ?? process.env.OPEN_SCIENCE_OPENLIST_MAX_DOWNLOAD_BYTES ?? 64 * 1024 * 1024,
    ),
    requireOpenList: overrides.requireOpenList ?? boolEnv("OPEN_SCIENCE_REQUIRE_OPENLIST", false),
    sourceIngestionEnabled:
      overrides.sourceIngestionEnabled ?? boolEnv("OPEN_SCIENCE_SOURCE_INGESTION_ENABLED", production),
    requireDocumentParser:
      overrides.requireDocumentParser ?? boolEnv("OPEN_SCIENCE_REQUIRE_DOCUMENT_PARSER", production),
    sourceIngestionPollMs: Number(
      overrides.sourceIngestionPollMs ?? process.env.OPEN_SCIENCE_SOURCE_INGESTION_POLL_MS ?? 1_000,
    ),
    sourceIngestionLeaseMs: Number(
      overrides.sourceIngestionLeaseMs ?? process.env.OPEN_SCIENCE_SOURCE_INGESTION_LEASE_MS ?? 900_000,
    ),
    sourceUnderstandingRunLimitCny: Number(overrides.sourceUnderstandingRunLimitCny
      ?? process.env.OPEN_SCIENCE_SOURCE_UNDERSTANDING_RUN_LIMIT_CNY ?? 3),
    sourceUnderstandingDailyLimitCny: Number(overrides.sourceUnderstandingDailyLimitCny
      ?? process.env.OPEN_SCIENCE_SOURCE_UNDERSTANDING_DAILY_LIMIT_CNY ?? 10),
    sourceUnderstandingWeeklyLimitCny: Number(overrides.sourceUnderstandingWeeklyLimitCny
      ?? process.env.OPEN_SCIENCE_SOURCE_UNDERSTANDING_WEEKLY_LIMIT_CNY ?? 50),
    // Knowledge-base search (`kb_search`, 2026-09-20). One switch for the tool
    // and the index behind it: off, the gateway answers `kb_search_disabled`,
    // nothing is indexed or embedded, and a run reads the files as before.
    kbSearchEnabled: overrides.kbSearchEnabled ?? boolEnv("OPEN_SCIENCE_KB_SEARCH_ENABLED", true),
    kbSearchGatewayInternalUrl:
      overrides.kbSearchGatewayInternalUrl ??
      process.env.OPEN_SCIENCE_KB_SEARCH_GATEWAY_INTERNAL_URL ??
      (production
        ? "http://open-science-web:8787/internal/kb/v1/search"
        : `http://127.0.0.1:${port}/internal/kb/v1/search`),
    // One search: three SQL legs, one query embedding and one rerank call.
    // 20 s is several times their sum on a large library; past it the run is
    // told to read the files rather than kept waiting.
    kbSearchTimeoutMs: Number(overrides.kbSearchTimeoutMs ?? process.env.OPEN_SCIENCE_KB_SEARCH_TIMEOUT_MS ?? 20_000),
    // Below this many tokens across a project's documents and the library, the
    // search answers with the files to read instead of fragments (plan §3.2:
    // 150–200K; Anthropic's guidance is not to retrieve under ~200K).
    kbSmallLibraryTokens: Number(overrides.kbSmallLibraryTokens ?? process.env.OPEN_SCIENCE_KB_SMALL_LIBRARY_TOKENS ?? 150_000),
    // How often the index worker converges on the sources when nothing woke
    // it. A finished source wakes it at once; this is the safety net.
    kbIndexReconcileMs: Number(overrides.kbIndexReconcileMs ?? process.env.OPEN_SCIENCE_KB_INDEX_RECONCILE_MS ?? 60_000),
    // One embedding request of ten chunks against DashScope.
    kbEmbeddingTimeoutMs: Number(overrides.kbEmbeddingTimeoutMs ?? process.env.OPEN_SCIENCE_KB_EMBEDDING_TIMEOUT_MS ?? 30_000),
    // The model and width are the memory index's pin, so one key and one price
    // cover both and a change of either is one edit in deps-version.json.
    kbEmbeddingModel: String(depsVersions.openviking?.embedding?.model ?? ""),
    kbEmbeddingDimension: Number(depsVersions.openviking?.embedding?.dimension ?? 1024),
    kbEmbeddingApiBase: String(depsVersions.openviking?.embedding?.apiBase ?? ""),
    // How many documents one account's personal library holds. It bounds the
    // library's directory (one Markdown copy per document, which every run of
    // the account mounts), its listing and the search scope it adds to every
    // project; past it the researcher is told to remove one first.
    libraryMaxItems: Number(overrides.libraryMaxItems ?? process.env.OPEN_SCIENCE_LIBRARY_MAX_ITEMS ?? 1_000),
    autopilotEnabled: overrides.autopilotEnabled ?? boolEnv("OPEN_SCIENCE_AUTOPILOT_ENABLED", production),
    autopilotPollMs: Number(overrides.autopilotPollMs ?? process.env.OPEN_SCIENCE_AUTOPILOT_POLL_MS ?? 1_000),
    autopilotLeaseMs: Number(overrides.autopilotLeaseMs ?? process.env.OPEN_SCIENCE_AUTOPILOT_LEASE_MS ?? 300_000),
    // The learning loop's own knobs.
    //
    // On by default since 2026-09-08, and the reason it was off is worth keeping
    // rather than deleting. It costs model calls against the same budget a
    // researcher's runs use, so it stayed off while it was a feature nobody had
    // asked for. What changed is that the loop is now the thing being measured:
    // its counters are the production distribution that the retirement window,
    // the contribution floor and the promotion thresholds are supposed to be
    // calibrated against, and every one of those numbers is a guess until a
    // deployment has run with it on. A knob that must be found and set before
    // any evidence accumulates is a knob that produces no evidence.
    //
    // Three things bound what being on costs. The worker declines outside
    // `learningWindow`, where model calls are half price; `learningConcurrency`
    // is 2; and a run is only queued for distillation when it needed at least
    // one repair round and then succeeded, which is a small fraction of runs.
    // Setting `OPEN_SCIENCE_LEARNING_ENABLED=false` still turns it off.
    learningEnabled: overrides.learningEnabled ?? boolEnv("OPEN_SCIENCE_LEARNING_ENABLED", true),
    learningPollMs: Number(overrides.learningPollMs ?? process.env.OPEN_SCIENCE_LEARNING_POLL_MS ?? 5_000),
    learningLeaseMs: Number(overrides.learningLeaseMs ?? process.env.OPEN_SCIENCE_LEARNING_LEASE_MS ?? 900_000),
    // Two, because the learning worker shares a 15 GB machine with the
    // production control plane and every job it claims starts a container.
    learningConcurrency: Number(overrides.learningConcurrency ?? process.env.OPEN_SCIENCE_LEARNING_CONCURRENCY ?? 2),
    // The off-peak window, which is an economic argument rather than a
    // scheduling preference: `priceUsage` halves a model call outside peak
    // hours, so a loop that only ever runs at night costs half as much as the
    // same loop run whenever a job happens to be queued.
    learningWindow: String(overrides.learningWindow ?? process.env.OPEN_SCIENCE_LEARNING_WINDOW ?? "22:00-09:00"),
    // Which zone the window above is written in.
    //
    // It used to be whatever the process's clock said, and the web container
    // ships with no `TZ`: the operator wrote `22:00-09:00` meaning Beijing and
    // the loop evaluated it in UTC, arming itself for the Chinese working day
    // (2026-09-15 walk, B3). The variable existed and no compose file passed
    // it, so it never reached the container either (plan 2026-09-19 §3.3 #2).
    // Beijing by default, not `TZ`: the zone the window's numbers are written
    // in is a property of how the operator wrote them, not of the clock the
    // container happens to run — a container set to UTC would put the night
    // back in the working day. An empty value reads the process clock.
    learningWindowTimeZone: String(overrides.learningWindowTimeZone
      ?? process.env.OPEN_SCIENCE_LEARNING_WINDOW_TIMEZONE ?? "Asia/Shanghai"),
    learningDailyLimitCny: Number(overrides.learningDailyLimitCny
      ?? process.env.OPEN_SCIENCE_LEARNING_DAILY_LIMIT_CNY ?? 5),
    learningWeeklyLimitCny: Number(overrides.learningWeeklyLimitCny
      ?? process.env.OPEN_SCIENCE_LEARNING_WEEKLY_LIMIT_CNY ?? 20),
    learningRunLimitCny: Number(overrides.learningRunLimitCny
      ?? process.env.OPEN_SCIENCE_LEARNING_RUN_LIMIT_CNY ?? 1),
    // How the nightly job runs a paired evaluation, if a deployment wants it to.
    //
    // Empty by default, and an `evaluate` job then fails by name rather than
    // succeeding without evaluating. That default is deliberate: the harness
    // dispatches hundreds of real runs (100 briefs x 2 arms x 3 repeats), and a
    // timer on a shared box is the wrong place to start that.
    //
    // The whole command, including the template that carries the brief set,
    // budget and judge. `--json`, `--method`, `--candidate-digest` and
    // `--baseline-digest` are appended by `runLearningEvaluationProcess`; everything
    // else is the operator's. For example:
    //
    //   python3 evals/method-quality/run_paired.py --template evals/method-quality/configs/nightly.json
    learningEvaluationCommand: String(overrides.learningEvaluationCommand
      ?? process.env.OPEN_SCIENCE_LEARNING_EVALUATION_COMMAND ?? ""),
    // Who may put a method on trial — that is, mount a candidate the loop has
    // not approved into a real container.
    //
    // Empty by default, which means nobody, and the route answers 403. That is
    // the whole access rule: an allowlist of user ids, no new role, no approval
    // flow. The paired evaluation is the only component whose job is
    // measurement, so it is the only one that may name the candidate it is
    // measuring; a researcher's own account can never receive an unproven
    // method by any path, which is what makes the mount safe to have at all.
    learningEvaluationUsers: String(overrides.learningEvaluationUsers
      ?? process.env.OPEN_SCIENCE_LEARNING_EVALUATION_USERS ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    // Who sees the operations page.
    //
    // Same shape and same reason as the allowlist above: an id list, empty by
    // default, no new role and no approval flow. It gates one surface — the
    // readiness board, the audit, error and security ledgers, the hosted task
    // list and the runtime controls — which a researcher was shown in full
    // until 2026-09-15 because the settings page was the deployment's console
    // and the product's settings at the same time. Gating presentation only:
    // every route behind it keeps its own authorization, so an empty list
    // removes a page from a menu, never a check from a request.
    operatorUsers: String(overrides.operatorUsers
      ?? process.env.OPEN_SCIENCE_OPERATOR_USERS ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    // How long a trial lasts if the caller does not say. A trial that outlives
    // the evaluation that set it would keep an unproven method in front of
    // every later run of that project, which is the failure the allowlist above
    // exists to prevent; an expiry makes forgetting to clear it harmless.
    learningTrialTtlMs: Number(overrides.learningTrialTtlMs
      ?? process.env.OPEN_SCIENCE_LEARNING_TRIAL_TTL_MS ?? 6 * 60 * 60 * 1000),
    transcriptRetentionDays: Number(overrides.transcriptRetentionDays
      ?? process.env.OPEN_SCIENCE_TRANSCRIPT_RETENTION_DAYS ?? 90),
    // `basic` is the kernel's own engine; `structured` is ours, which preserves
    // the run's durable handles across a compaction. It stays `basic` until the
    // context-fidelity report has a real distribution to argue from (§6.5).
    runtimeCompactionPolicy: String(overrides.runtimeCompactionPolicy
      ?? process.env.OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY ?? "basic"),
    // The context window the kernel is told it has.
    //
    // It was the literal 1,000,000 while a run's own budget was 400,000, and
    // the two are not independent: pressure compaction fires at
    // thresholdRatio x contextWindow, which put the trigger at 800,000 — inside
    // a window that never opens. Compaction has therefore never fired in this
    // deployment, and no measurement could have told us that apart from the
    // absence of any compaction record at all.
    //
    // Defaulting it to the run budget makes the trigger reachable (0.8 x
    // 400,000 = 320,000) without this file asserting a vendor context size it
    // has no way to verify. A deployment that knows its model's real window
    // sets it explicitly.
    runtimeContextWindow: Number(overrides.runtimeContextWindow
      ?? process.env.OPEN_SCIENCE_RUNTIME_CONTEXT_WINDOW
      ?? overrides.runMaxTokens ?? process.env.OPEN_SCIENCE_RUN_MAX_TOKENS ?? 400_000),
    requireInbox: overrides.requireInbox ?? boolEnv("OPEN_SCIENCE_REQUIRE_INBOX", production),
    // How long a run may produce no new message and no new tool call before it
    // is treated as stalled. A ledger of start/dispatch/finish cannot tell a
    // working run from a dead one, so both used to wait out the full timeout.
    //
    // This was a poll count whose duration depended on an interval nobody
    // passed, and it worked out to two minutes. A report-tier agent is silent
    // for as long as one long model stream takes: across two production
    // evidence-synthesis runs the longest gap between steps was 138s and 113s,
    // so one run was killed mid-step and the other survived by seven seconds.
    // Fifteen minutes leaves room above the observed maximum while still
    // catching a dead runtime long before the overall timeout.
    agentRunMonitorStallMs: Number(
      overrides.agentRunMonitorStallMs ?? process.env.OPEN_SCIENCE_AGENT_RUN_MONITOR_STALL_MS ?? 900_000,
    ),
    // The subsystem's own switch, and the one an operator reaches for. The
    // three underneath it (extraction, the index provider, the learning loop)
    // are finer controls and none of them is the whole thing: extraction off
    // still serves records, an index off still recalls by term match.
    memoryEnabled: overrides.memoryEnabled ?? boolEnv("OPEN_SCIENCE_MEMORY_ENABLED", true),
    // Off by default: turning it on publishes an account's memory to whoever
    // holds an API key. A deployment decides that, never a default.
    agentMemoryApiEnabled:
      overrides.agentMemoryApiEnabled ?? boolEnv("OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED", false),
    memoryExtractionEnabled:
      overrides.memoryExtractionEnabled ?? boolEnv("OPEN_SCIENCE_MEMORY_EXTRACTION_ENABLED", true),
    // Projects extraction never writes for, by id prefix. Empty by default.
    //
    // A paired evaluation manipulates the very records extraction upserts, so
    // it has to run with extraction off — and until now the only way to do that
    // was the deployment-wide switch above, flipped by hand before the batch
    // and flipped back after it. Twice in two days that was a container
    // recreate in the middle of a live deployment, and the failure mode when
    // somebody forgets the second flip is a memory page that stays empty
    // forever and looks exactly like "nothing worth remembering happened".
    //
    // A prefix rather than an exact id because an eval allocates one project
    // per batch (`eval-memory-ablation-v3`, then v4); the operator registers
    // `eval-` once.
    memoryExtractionExcludedProjectPrefixes: String(overrides.memoryExtractionExcludedProjectPrefixes
      ?? process.env.OPEN_SCIENCE_MEMORY_EXTRACTION_EXCLUDED_PROJECT_PREFIXES ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    // Extraction runs after the reply is already delivered, so a generous budget
    // costs the user nothing. The measured request takes 40-46s against
    // deepseek-v4-pro, so the old 30s ceiling aborted every single one.
    memoryExtractionTimeoutMs: Number(
      overrides.memoryExtractionTimeoutMs ?? process.env.OPEN_SCIENCE_MEMORY_EXTRACTION_TIMEOUT_MS ?? 120_000,
    ),
    // Structured extraction rather than reasoning, so the flash tier fits: it
    // measures ~22s against the pro model's ~38s on the same prompt.
    memoryExtractionModel: String(
      overrides.memoryExtractionModel ?? process.env.OPEN_SCIENCE_MEMORY_EXTRACTION_MODEL ?? defaultDeepSeekModel,
    ),
    // How long a per-run episodic memory stays recallable. The profile
    // extracted from those runs has no expiry.
    memoryRunSummaryTtlDays: Number(
      overrides.memoryRunSummaryTtlDays ?? process.env.OPEN_SCIENCE_MEMORY_RUN_SUMMARY_TTL_DAYS ?? 90,
    ),
    // mem stream (2026-09-20): how long an inferred memory lives after it was
    // last observed. With no confirmation step (owner ruling 2026-09-19) an
    // inference takes effect at once, so what keeps "one stressful week" from
    // hardening into the profile is that a pattern not seen again fades; each
    // re-observation extends it, and a statement the researcher made does not
    // fade at all. 0 = never.
    memoryInferredTtlDays: Number(
      overrides.memoryInferredTtlDays ?? process.env.OPEN_SCIENCE_MEMORY_INFERRED_TTL_DAYS ?? 90,
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
    // --- S1 (run ledger & control-plane APIs, 2026-09-18) ---
    // Automatic run titles: one metered deepseek-flash call per new run, off
    // the critical path (runTitles.mjs). Off leaves every run named by its
    // question, which is also what any failure leaves.
    runTitlesEnabled: overrides.runTitlesEnabled ?? boolEnv("OPEN_SCIENCE_RUN_TITLES_ENABLED", true),
    // Per-run spend cap for interactive runs, in CNY; 0 = none. Enforceable
    // since the model gateway attributes an interactive runtime's calls to
    // the run (modelGateway.mjs `attributeRun`); bounded runtimes carry
    // their own cap in their token.
    userRunSpendLimit: Number(overrides.userRunSpendLimit ?? process.env.OPEN_SCIENCE_USER_RUN_SPEND_LIMIT ?? 0),
    // Memory recall, everywhere a run or an agent could receive a memory: the
    // block recalled at dispatch, the resident capsule profile, and the recall
    // tool and API. Off is the native control arm a memory evaluation needs
    // (principle 11) — the ablations had to flip database rows because there
    // was none. Unset follows the memory subsystem's own switch, so a
    // deployment that hid memory from its researchers does not keep feeding it
    // to their runs.
    memoryRecallEnabled: overrides.memoryRecallEnabled ?? boolEnv(
      "OPEN_SCIENCE_MEMORY_RECALL_ENABLED",
      overrides.memoryEnabled ?? boolEnv("OPEN_SCIENCE_MEMORY_ENABLED", true),
    ),
    // --- ops 0920: the routing classifier's own deadline ---
    // One classification, start to finish, on the dispatch path: every second
    // of it is the researcher waiting for a run to start. It borrowed
    // `modelGatewayTimeoutMs` — the gateway's streaming IDLE time — clamped to
    // 120 s (docs/REQUEST_PATH.md C7), so a hung provider held a dispatch for
    // two minutes. With thinking off a verdict takes a second or two; a missed
    // deadline declines with reason `timeout` and the regex net routes instead.
    llmRoutingTimeoutMs: Number(
      overrides.llmRoutingTimeoutMs ?? process.env.OPEN_SCIENCE_LLM_ROUTING_TIMEOUT_MS ?? 20_000,
    ),
    // --- im: Feishu, the channel port and the own-app reservations (2026-09-20) ---
    // The IM module (imService.mjs): scan-to-create Feishu bots, their long
    // connections, progress cards, and inbox pushes to the phone. Off by
    // default: it needs the PostgreSQL product store and a correct
    // OPEN_SCIENCE_PUBLIC_URL for the links it sends. Off, the inbox accepts
    // only in-app delivery, exactly as before the channel port existed.
    imEnabled: overrides.imEnabled ?? boolEnv("OPEN_SCIENCE_IM_ENABLED", false),
    // How often the IM worker looks for inbound messages, runs to report on and
    // pushes to send. Two seconds keeps "收到" under the three seconds a person
    // waits before re-sending, at one indexed query per table per tick.
    imPollMs: Number(overrides.imPollMs ?? process.env.OPEN_SCIENCE_IM_POLL_MS ?? 2_000),
    // A claimed inbound message, task or push is someone else's to retry after
    // this long. Dispatching a question can take a cold runtime start plus a
    // routing call, so five minutes, not seconds.
    imLeaseMs: Number(overrides.imLeaseMs ?? process.env.OPEN_SCIENCE_IM_LEASE_MS ?? 300_000),
    // The shortest gap between two updates of one task's progress card. Feishu
    // allows ten card operations a second per card, but a phone that buzzes on
    // every tool call is a phone that gets muted.
    imProgressIntervalMs: Number(
      overrides.imProgressIntervalMs ?? process.env.OPEN_SCIENCE_IM_PROGRESS_INTERVAL_MS ?? 15_000,
    ),
    // A chat keeps one conversation with the kernel while it keeps talking; a
    // message after this many quiet minutes starts a fresh one. A Feishu chat is
    // one endless thread, and carrying yesterday's 180k-token context into
    // today's unrelated question costs money and confuses the model.
    imConversationIdleMinutes: Number(
      overrides.imConversationIdleMinutes ?? process.env.OPEN_SCIENCE_IM_CONVERSATION_IDLE_MINUTES ?? 360,
    ),
    // At most this many delivered files follow a finished task into the chat
    // (each at most Feishu's 30 MB); the rest are one link away on the page.
    imMaxResultFiles: Number(overrides.imMaxResultFiles ?? process.env.OPEN_SCIENCE_IM_MAX_RESULT_FILES ?? 5),
    // --- sec2 (security review 2026-09-20): IM inbound fairness ---
    // Messages one bound chat may have handled per minute. A person types a
    // few; past this it is a flood, and each handled message is an intent call
    // (up to 30 s) and possibly a run in the worker every account shares. The
    // first message past it is answered 「消息太快了，请稍后再发」, the rest of
    // the minute dropped; counted as `inbound_rate_limited`.
    imInboundPerMinute: Number(overrides.imInboundPerMinute ?? process.env.OPEN_SCIENCE_IM_INBOUND_PER_MINUTE ?? 20),
    // The reserved channels (plan §3.6, 2026-09-19 ruling): each is an adapter
    // file that reports not-configured, and each switch defaults off. On, a
    // channel may be named in notification preferences and says by name that
    // nothing is configured behind it yet.
    channelEnabled: Object.freeze({
      "wechat-service": overrides.channelEnabled?.["wechat-service"]
        ?? boolEnv("OPEN_SCIENCE_CHANNEL_WECHAT_SERVICE_ENABLED", false),
      "wechat-clawbot": overrides.channelEnabled?.["wechat-clawbot"]
        ?? boolEnv("OPEN_SCIENCE_CHANNEL_WECHAT_CLAWBOT_ENABLED", false),
      email: overrides.channelEnabled?.email ?? boolEnv("OPEN_SCIENCE_CHANNEL_EMAIL_ENABLED", false),
      app: overrides.channelEnabled?.app ?? boolEnv("OPEN_SCIENCE_CHANNEL_APP_ENABLED", false),
      dingtalk: overrides.channelEnabled?.dingtalk ?? boolEnv("OPEN_SCIENCE_CHANNEL_DINGTALK_ENABLED", false),
      wecom: overrides.channelEnabled?.wecom ?? boolEnv("OPEN_SCIENCE_CHANNEL_WECOM_ENABLED", false),
    }),
    // Bearer device tokens for a non-browser client (the own app, reserved).
    // Off: the API accepts only the browser session cookie, as it always has,
    // and the Authorization header is never read.
    appApiEnabled: overrides.appApiEnabled ?? boolEnv("OPEN_SCIENCE_APP_API_ENABLED", false),
    // --- web reading (web stream, 2026-09-20; plan §3.5) ---
    // `web_read`, the one tool that reads any public page. Off hides the tool
    // from the runtime and refuses the gateway's web-read mode; the native
    // conversation is untouched (principle 11).
    webReadEnabled: overrides.webReadEnabled ?? boolEnv("OPEN_SCIENCE_WEB_READ_ENABLED", true),
    // Reads in flight at once, every site together. Each may hold a 16 MiB
    // body and, for HTML, a parsed DOM ten times its size; eight bound the
    // worst case on a shared host. Counted in
    // open_science_web_read_limits_total{limit="concurrency"}.
    webReadConcurrency: Math.max(1, Number(
      overrides.webReadConcurrency ?? process.env.OPEN_SCIENCE_WEB_READ_CONCURRENCY ?? 8,
    ) || 8),
    // The least time between two requests to one site (a robots.txt
    // Crawl-delay stretches it): a run fanning out over a regulator's notice
    // list must not read as a flood from our address. Counted in
    // open_science_web_read_limits_total{limit="host_interval"}.
    webReadHostIntervalMs: Math.max(0, Number(
      overrides.webReadHostIntervalMs ?? process.env.OPEN_SCIENCE_WEB_READ_HOST_INTERVAL_MS ?? 1_000,
    ) || 0),
    // One whole read — robots, redirects, a render, a document parse. Clamped
    // under the kernel's tool-call ceiling like the GEO probe's: a deadline
    // the caller has already abandoned is a timeout nobody is told about.
    webReadTimeoutMs: Math.min(
      MCP_TOOL_CALL_TIMEOUT_MS - GATEWAY_RESPONSE_MARGIN_MS,
      Math.max(5_000, Number(
        overrides.webReadTimeoutMs ?? process.env.OPEN_SCIENCE_WEB_READ_TIMEOUT_MS ?? 150_000,
      ) || 150_000),
    ),
    // Tier 3: a page drawn in script opened in AgentBay's cloud browser. Off
    // until the deployment has an AgentBay key; off, a page that needs a
    // browser is the named error `web_read_needs_browser` and the run uses
    // another source.
    webRenderEnabled: overrides.webRenderEnabled ?? boolEnv("OPEN_SCIENCE_WEB_RENDER_ENABLED", false),
    // Renders at once: each is a browser context in the one warm session, and
    // that session's VM is the resource. Counted in
    // open_science_web_render_events_total.
    webRenderConcurrency: Math.max(1, Number(
      overrides.webRenderConcurrency ?? process.env.OPEN_SCIENCE_WEB_RENDER_CONCURRENCY ?? 2,
    ) || 2),
    // One page's time in the browser, a JavaScript challenge solving itself
    // included (NMPA's resolves in seconds).
    webRenderTimeoutMs: Math.max(5_000, Number(
      overrides.webRenderTimeoutMs ?? process.env.OPEN_SCIENCE_WEB_RENDER_TIMEOUT_MS ?? 30_000,
    ) || 30_000),
    // How long the warm browser session outlives the last render: it saves a
    // session start per page while a run is reading, and costs AgentBay time
    // once nobody is.
    webRenderIdleReleaseMs: Math.max(10_000, Number(
      overrides.webRenderIdleReleaseMs ?? process.env.OPEN_SCIENCE_WEB_RENDER_IDLE_RELEASE_MS ?? 300_000,
    ) || 300_000),
    // Retraction and correction flags on the sources a report cites, read
    // from Crossref when its 「依据」 are opened. A notice, never a gate
    // (principle 13); off, the source cards simply carry none.
    sourceUpdatesEnabled: overrides.sourceUpdatesEnabled ?? boolEnv("OPEN_SCIENCE_SOURCE_UPDATES_ENABLED", true),
    // One Crossref request for twenty cited works, made while a reader waits
    // for a report's 「依据」 marks: past this the badges are simply absent.
    // Counted in open_science_source_updates_total{outcome="failed"}.
    sourceUpdatesTimeoutMs: Math.max(500, Number(
      overrides.sourceUpdatesTimeoutMs ?? process.env.OPEN_SCIENCE_SOURCE_UPDATES_TIMEOUT_MS ?? 3_000,
    ) || 3_000),
    // --- rt: runtime UX (plan §3.1 #8, 2026-09-20) ---
    // Start the runtime of the account's most recently used project in the
    // background of a sign-in, so it is up by the time the project is opened.
    // Off costs the reader the cold start on first open and nothing else; the
    // idle reaper stops a warmed runtime nobody used, like any other.
    runtimeWarmOnSignIn: overrides.runtimeWarmOnSignIn ?? boolEnv("OPEN_SCIENCE_RUNTIME_WARM_ON_SIGN_IN", true),
    // --- X3: AgentBay client (shared by the rt and web streams; one block) ---
    // The key lives in a file only the control plane reads (agentbay/client.mjs);
    // it never reaches a runtime, a log or an error message. Empty = AgentBay off.
    agentbayApiKeyFile: String(overrides.agentbayApiKeyFile ?? process.env.OPEN_SCIENCE_AGENTBAY_API_KEY_FILE ?? "").trim(),
    // `cn-hangzhou` is AgentBay's only mainland region (2026-09); keys are
    // region-specific.
    agentbayRegion: String(overrides.agentbayRegion ?? process.env.OPEN_SCIENCE_AGENTBAY_REGION ?? "cn-hangzhou").trim(),
    // Empty = the SDK's own endpoint for the region.
    agentbayEndpoint: String(overrides.agentbayEndpoint ?? process.env.OPEN_SCIENCE_AGENTBAY_ENDPOINT ?? "").trim(),
    // --- rt: the AgentBay runtime provider (plan §3.1) ---
    runtimeProvider,
    // The activated custom image (`imgc-…`) the runtime sessions boot from;
    // empty refuses every AgentBay start by name.
    agentbayImageId: String(overrides.agentbayImageId ?? process.env.OPEN_SCIENCE_AGENTBAY_IMAGE_ID ?? "").trim(),
    // Session lifecycle, in minutes, set on every session so the console's
    // defaults (5 idle / 30 max) never apply. Idle 30 matches this control
    // plane's own reaper; the reaper, not AgentBay, decides idleness while the
    // control plane is up (it keeps the session alive), so this only releases a
    // session the control plane lost. 240 bounds a runaway session: a deep run
    // takes ~40 min.
    agentbayIdleReleaseMinutes: Number(overrides.agentbayIdleReleaseMinutes ?? process.env.OPEN_SCIENCE_AGENTBAY_IDLE_RELEASE_MINUTES ?? 30),
    agentbayMaxRuntimeMinutes: Number(overrides.agentbayMaxRuntimeMinutes ?? process.env.OPEN_SCIENCE_AGENTBAY_MAX_RUNTIME_MINUTES ?? 240),
    // An AgentBay policy id for sessions (connection rules bound in the
    // console); empty uses the API key's own policy.
    agentbayPolicyId: String(overrides.agentbayPolicyId ?? process.env.OPEN_SCIENCE_AGENTBAY_POLICY_ID ?? "").trim(),
    // The session bridge's port: AgentBay links open 30100–30199 only.
    agentbayBridgePort: Number(overrides.agentbayBridgePort ?? process.env.OPEN_SCIENCE_AGENTBAY_BRIDGE_PORT ?? 30100),
    // How the per-session bridge secret travels through AgentBay's link proxy:
    // `header` (x-evimed-bridge-secret) or `path` (a /__evimed_bridge/<secret>/
    // prefix) for a proxy that strips custom headers. The bridge accepts both;
    // the first live bring-up decides which one survives the proxy.
    agentbayBridgeSecretMode: String(overrides.agentbayBridgeSecretMode ?? process.env.OPEN_SCIENCE_AGENTBAY_BRIDGE_SECRET_MODE ?? "header").trim().toLowerCase(),
    // How often the link is proven and the session's idle timer refreshed.
    // AgentBay counts SDK calls, not link traffic, as activity; 25 s also sits
    // under any idle cut a proxy in front of a long-lived WebSocket may apply.
    agentbayHeartbeatMs: Number(overrides.agentbayHeartbeatMs ?? process.env.OPEN_SCIENCE_AGENTBAY_HEARTBEAT_MS ?? 25_000),
    // The workload token a remote runtime holds (plan §3.1 #4): renewed every
    // 300 s through the session file API, valid 900 s, so two failed renewals
    // in a row still leave a valid token. Docker keeps its 300 s in-place
    // rewrite (OPEN_SCIENCE_EVIMED_WORKLOAD_TOKEN_TTL_SECONDS).
    agentbayWorkloadTokenTtlSeconds: Number(overrides.agentbayWorkloadTokenTtlSeconds ?? process.env.OPEN_SCIENCE_AGENTBAY_WORKLOAD_TOKEN_TTL_SECONDS ?? 900),
    agentbayWorkloadTokenRefreshSeconds: Number(overrides.agentbayWorkloadTokenRefreshSeconds ?? process.env.OPEN_SCIENCE_AGENTBAY_WORKLOAD_TOKEN_REFRESH_SECONDS ?? 300),
    // Minimum Landlock enforcement a remote runtime must report (plan §3.1 #9).
    // `partial` is the stated fallback for a guest kernel between 5.13 and 6.9:
    // the per-project VM is the outer boundary and DSH's write fence the inner
    // one. No Landlock at all is never accepted: DSH's bash tool refuses to run.
    agentbaySandboxEnforcement: String(overrides.agentbaySandboxEnforcement ?? process.env.OPEN_SCIENCE_AGENTBAY_SANDBOX_ENFORCEMENT ?? "full").trim().toLowerCase(),
    // The in-image firewall that limits the runtime user to DNS and the
    // gateway domain. Required by default; false leaves AgentBay's domain
    // policy as the only egress control and records that it did.
    agentbayFirewallRequired: overrides.agentbayFirewallRequired ?? boolEnv("OPEN_SCIENCE_AGENTBAY_FIREWALL_REQUIRED", true),
    // How often a live session's workspace changes are mirrored back to the
    // host copy the UI and the ledger read (the delivery gate forces one).
    agentbaySyncIntervalMs: Number(overrides.agentbaySyncIntervalMs ?? process.env.OPEN_SCIENCE_AGENTBAY_SYNC_INTERVAL_MS ?? 15_000),
    // The largest single file carried between the host and a session; larger
    // ones stay where they are and are named in the runtime ledger.
    agentbaySyncMaxFileBytes: Number(overrides.agentbaySyncMaxFileBytes ?? process.env.OPEN_SCIENCE_AGENTBAY_SYNC_MAX_FILE_BYTES ?? 256 * 1024 * 1024),
    // Prefix of every AgentBay Context this deployment creates, so two
    // deployments on one account cannot read each other's projects.
    agentbayContextPrefix: String(overrides.agentbayContextPrefix ?? process.env.OPEN_SCIENCE_AGENTBAY_CONTEXT_PREFIX ?? "evimed").trim(),
    // The public HTTPS prefix a remote runtime reaches the gateways through
    // (plan §3.1 #5), e.g. https://evimed.example/runtime-gateway. The host
    // nginx forwards it to this process; empty keeps every gateway internal.
    runtimeGatewayPublicUrl: String(overrides.runtimeGatewayPublicUrl ?? process.env.OPEN_SCIENCE_RUNTIME_GATEWAY_PUBLIC_URL ?? "").trim(),
    // Requests per minute one runtime may make through that prefix. A deep run
    // makes ~13 model calls a minute and bursts with up to 30 children; 600
    // leaves room for both and stops a runaway loop from starving the others.
    runtimeGatewayRateLimitPerMinute: Number(overrides.runtimeGatewayRateLimitPerMinute ?? process.env.OPEN_SCIENCE_RUNTIME_GATEWAY_RATE_LIMIT_PER_MINUTE ?? 600),
    // --- rt: community client bundles in the runtime image (plan §3.9) ---
    // Selection annotation (`@changfenhuang/dsh-annotation`) and fenced
    // Mermaid rendering (`dsh-mermaid`) in the kernel's own conversation view.
    // Each is on by default and switched off deployment-wide by its own key —
    // the answer when an upgrade breaks one, rather than holding the upgrade.
    runtimeAnnotationEnabled: overrides.runtimeAnnotationEnabled ?? boolEnv("OPEN_SCIENCE_RUNTIME_ANNOTATION_ENABLED", true),
    runtimeMermaidEnabled: overrides.runtimeMermaidEnabled ?? boolEnv("OPEN_SCIENCE_RUNTIME_MERMAID_ENABLED", true),
  };
}
