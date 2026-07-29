#!/usr/bin/env node
// Report the credential posture of the EviMed evidence connectors that use a
// managed credential, including the keyless public tiers that need no API key.
// This is a static audit of environment configuration: it never prints secret
// values and never performs network access. See the manual verification notes
// printed at the end for live connectivity evidence.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), "../..");
const jsonOutput = process.argv.includes("--json");

// Mirrors apps/server/src/config.mjs publicSourceCredentialSpecs (managed keys)
// and runtime/mcp/evimed-research/public_sources.py _keyless_public_params.
// keyless: "anonymous" = upstream permits anonymous access (rate-limited);
// "EVIMED_UNPAYWALL_EMAIL" = keyless only when that runtime env var is set.
const connectors = [
  { profile: "evimed-evidence", env: "OPEN_SCIENCE_EVIMED_API_KEY", keyless: null },
  { profile: "semantic-scholar", env: "OPEN_SCIENCE_SEMANTIC_SCHOLAR_API_KEY", keyless: "anonymous" },
  { profile: "core", env: "OPEN_SCIENCE_CORE_API_KEY", keyless: null },
  { profile: "unpaywall", env: "OPEN_SCIENCE_UNPAYWALL_EMAIL", keyless: "EVIMED_UNPAYWALL_EMAIL" },
  { profile: "umls", env: "OPEN_SCIENCE_UMLS_API_KEY", keyless: null },
  { profile: "omim", env: "OPEN_SCIENCE_OMIM_API_KEY", keyless: null },
  { profile: "addgene", env: "OPEN_SCIENCE_ADDGENE_API_KEY", keyless: null },
  { profile: "biogrid", env: "OPEN_SCIENCE_BIOGRID_API_KEY", keyless: null },
  { profile: "opengwas", env: "OPEN_SCIENCE_OPENGWAS_JWT", keyless: null },
];

function secretFileState(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return "unreadable";
  }
  if (!stat.isFile() || stat.size <= 0) return "empty";
  return "present";
}

function keyState(env) {
  if ((process.env[env] ?? "").trim()) return "configured";
  const fileEnv = `${env}_FILE`;
  const file = (process.env[fileEnv] ?? "").trim();
  if (!file) return "missing";
  const state = secretFileState(file);
  return state === "present" ? "configured" : `error:${fileEnv} ${state}`;
}

function connectorMode(connector, key) {
  if (key === "configured") return "managed";
  if (key.startsWith("error:")) return "error";
  if (connector.keyless === "anonymous") return "keyless-public";
  if (connector.keyless && (process.env[connector.keyless] ?? "").trim()) return "keyless-public";
  return "blocked";
}

const rows = connectors.map((connector) => {
  const key = keyState(connector.env);
  const mode = connectorMode(connector, key);
  const notes = [];
  if (mode === "keyless-public" && connector.keyless === "anonymous") {
    notes.push("anonymous public tier; shared upstream rate limits apply");
  }
  if (mode === "keyless-public" && connector.keyless !== "anonymous") {
    notes.push(`keyless via ${connector.keyless}`);
  }
  if (mode === "blocked") {
    notes.push("fails closed: public_source_managed_credential_required");
  }
  return {
    profile: connector.profile,
    managedKey: key,
    mode,
    note: notes.join("; "),
  };
});

const runtime = {
  publicConnectorsEnabled: !/^(?:0|false|no|off)$/i.test(process.env.EVIMED_PUBLIC_CONNECTORS_ENABLED ?? "true"),
  gatewayUrlConfigured: Boolean((process.env.EVIMED_PUBLIC_SOURCE_GATEWAY_URL ?? "").trim()),
  gatewayTokenConfigured: Boolean((process.env.EVIMED_MODEL_CONFIG_FILE ?? "").trim()),
  unpaywallKeylessEmail: Boolean((process.env.EVIMED_UNPAYWALL_EMAIL ?? "").trim()),
};

const summary = {
  managed: rows.filter((row) => row.mode === "managed").length,
  keylessPublic: rows.filter((row) => row.mode === "keyless-public").length,
  blocked: rows.filter((row) => row.mode === "blocked").length,
  errors: rows.filter((row) => row.mode === "error").length,
};

const manualVerification = [
  "Static audit only; no network calls were made. To verify live connectivity:",
  `1. Public (no-credential) connectors: python3 evals/capability-audit/run_connector_audit.py --workspace <dir> --source pubmed --source europe-pmc --source openalex`,
  `2. Managed-credential connectors through the server gateway: node evals/capability-audit/run_connector_gateway_audit.mjs --workspace <dir>`,
  "3. Keyless tiers: call the MCP tool evimed_biomedical_source_search with source=semantic-scholar (always keyless-capable) or source=unpaywall (requires EVIMED_UNPAYWALL_EMAIL) and inspect data.credentialMode in the result.",
];

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify({ ok: summary.errors === 0, runtime, connectors: rows, summary, manualVerification })}\n`);
} else {
  process.stdout.write("EviMed evidence connector credential posture (static audit, no network access)\n");
  for (const row of rows) {
    const note = row.note ? ` — ${row.note}` : "";
    process.stdout.write(`  ${row.profile}: ${row.mode} (managed key: ${row.managedKey})${note}\n`);
  }
  process.stdout.write(
    `runtime: public connectors ${runtime.publicConnectorsEnabled ? "enabled" : "disabled"}, `
      + `gateway URL ${runtime.gatewayUrlConfigured ? "configured" : "not configured"}, `
      + `gateway token ${runtime.gatewayTokenConfigured ? "configured" : "not configured"}\n`,
  );
  process.stdout.write(
    `summary: ${summary.managed} managed, ${summary.keylessPublic} keyless-public, ${summary.blocked} blocked, ${summary.errors} misconfigured\n`,
  );
  for (const line of manualVerification) process.stdout.write(`${line}\n`);
}
if (summary.errors > 0) process.exitCode = 1;
