#!/usr/bin/env node
// Report the credential posture of the EviMed evidence connectors that use a
// managed credential, including the keyless public tiers that need no API key.
// This is a static audit of environment configuration: it never prints secret
// values and never performs network access. See the manual verification notes
// printed at the end for live connectivity evidence.
//
// Which connectors are keyless is read from the domain's connector registry
// (`packages/domain/src/connectorCredentials.mjs`, `keyless`), the same flag
// the public-source gateway reads to send a request anonymously when no key is
// configured. This script used to keep its own copy of that column, and on
// 2026-09-26 it reported Semantic Scholar as keyless-public in the production
// container while the gateway refused every keyless request, and it did not
// list NCBI, openFDA or Materials Project at all (audit I1-3).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), "../..");

/**
 * The environment variable that holds each connector's deployment credential
 * (apps/server/src/config.mjs `publicSourceCredentialSpecs` and the Materials
 * Project secret; each also takes `<NAME>_FILE`). `evimed-evidence`, the
 * platform's own API, is a connector like the rest since 2026-10-04: a
 * deployment may hold the key for everyone, and a researcher may bring their own
 * where it does not.
 */
export const CONNECTOR_ENV = Object.freeze({
  "evimed-evidence": "OPEN_SCIENCE_EVIMED_API_KEY",
  "semantic-scholar": "OPEN_SCIENCE_SEMANTIC_SCHOLAR_API_KEY",
  core: "OPEN_SCIENCE_CORE_API_KEY",
  unpaywall: "OPEN_SCIENCE_UNPAYWALL_EMAIL",
  umls: "OPEN_SCIENCE_UMLS_API_KEY",
  omim: "OPEN_SCIENCE_OMIM_API_KEY",
  addgene: "OPEN_SCIENCE_ADDGENE_API_KEY",
  biogrid: "OPEN_SCIENCE_BIOGRID_API_KEY",
  opengwas: "OPEN_SCIENCE_OPENGWAS_JWT",
  ncbi: "OPEN_SCIENCE_NCBI_API_KEY",
  openfda: "OPEN_SCIENCE_OPENFDA_API_KEY",
  "materials-project": "OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY",
});

/**
 * Without the server gateway (a local runtime calling upstreams directly),
 * the MCP can use Unpaywall's keyless tier with a contact address of its own.
 * Through the gateway it cannot: the gateway resolves DOIs with the
 * deployment's address or refuses.
 */
const DIRECT_KEYLESS_ENV = Object.freeze({ unpaywall: "EVIMED_UNPAYWALL_EMAIL" });

/** The domain registry, resolved the way the server resolves it — the web image has no root node_modules. */
async function connectorRegistry() {
  const require = createRequire(path.join(repoRoot, "apps/server/package.json"));
  const domain = await import(pathToFileURL(require.resolve("@evimed/domain")).href);
  return domain.CONNECTOR_CREDENTIALS;
}

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

/** @param {string} name @param {NodeJS.ProcessEnv} env */
function keyState(name, env) {
  if ((env[name] ?? "").trim()) return "configured";
  const fileEnv = `${name}_FILE`;
  const file = (env[fileEnv] ?? "").trim();
  if (!file) return "missing";
  const state = secretFileState(file);
  return state === "present" ? "configured" : `error:${fileEnv} ${state}`;
}

/**
 * Every connector's posture under an environment.
 * @param {ReadonlyArray<{ id: string, keyless: boolean }>} registry the domain's CONNECTOR_CREDENTIALS
 * @param {NodeJS.ProcessEnv} env
 */
export function connectorPosture(registry, env) {
  const gatewayConfigured = Boolean((env.EVIMED_PUBLIC_SOURCE_GATEWAY_URL ?? "").trim());
  const profiles = registry.map((spec) => spec.id);
  return profiles.map((profile) => {
    const variable = CONNECTOR_ENV[profile];
    if (!variable) throw new Error(`no credential variable is known for the connector ${profile}; add it to CONNECTOR_ENV`);
    const keyless = registry.find((spec) => spec.id === profile)?.keyless === true;
    const direct = DIRECT_KEYLESS_ENV[profile];
    const key = keyState(variable, env);
    let mode;
    const notes = [];
    if (key === "configured") mode = "managed";
    else if (key.startsWith("error:")) mode = "error";
    else if (keyless) {
      mode = "keyless-public";
      notes.push("no key: requests go upstream anonymously; shared upstream rate limits apply");
    } else if (direct && !gatewayConfigured && (env[direct] ?? "").trim()) {
      mode = "keyless-public";
      notes.push(`keyless via ${direct} (runtime without the gateway only)`);
    } else {
      mode = "blocked";
      notes.push(`fails closed: public_source_${profile.replaceAll("-", "_")}_credential_missing`);
    }
    return { profile, managedKey: key, mode, note: notes.join("; ") };
  });
}

async function main() {
  const jsonOutput = process.argv.includes("--json");
  const rows = connectorPosture(await connectorRegistry(), process.env);
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
    "3. Keyless tiers: call the MCP tool biomedical_source_search with source=semantic-scholar (keyless through the gateway when no key is configured) and inspect the result; a 429 from the anonymous tier comes back as public_source_gateway_rate_limited.",
    "4. Refusals in production: open_science_public_source_credential_missing_total{source,reason} on /api/ops/metrics (alerts PublicSourceCredentialUnusable, EvimedEvidenceRefused).",
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
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === scriptFile) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
