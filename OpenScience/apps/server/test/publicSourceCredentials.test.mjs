import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { loadConfig } from "../src/config.mjs";
import { publicSourceCredentialReadiness } from "../src/publicSourceGateway.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("readiness says which public-source credentials are configured, never their values", () => {
  const report = publicSourceCredentialReadiness({
    publicSourceCredentials: { unpaywall: "evidence-team@example.org", core: "", ncbi: null },
    publicSourceCredentialSources: { unpaywall: "environment", core: "none", ncbi: "file" },
    publicSourceCredentialErrors: { ncbi: "public_source_ncbi_file_permissions" },
  });
  assert.equal(report.informational, true);
  assert.deepEqual(report.credentials, {
    core: { configured: false, source: "none" },
    ncbi: { configured: false, source: "none", error: "public_source_ncbi_file_permissions" },
    unpaywall: { configured: true, source: "environment" },
  });
  assert.deepEqual(report.unconfigured, ["core", "ncbi"]);
  assert.deepEqual(report.fullTextRoutes, ["europe-pmc", "unpaywall-open-access-pdf"]);
  assert.equal(JSON.stringify(report).includes("evidence-team@example.org"), false);
});

test("without an Unpaywall address the report names the full-text route that is gone", () => {
  const config = loadConfig({ unpaywallEmail: "", unpaywallEmailFile: "", production: false });
  const report = publicSourceCredentialReadiness(config);
  assert.equal(report.credentials.unpaywall.configured, false);
  assert.ok(report.unconfigured.includes("unpaywall"));
  assert.deepEqual(report.fullTextRoutes, ["europe-pmc"]);
});

test("the Unpaywall contact address is a documented lever that reaches the web service", async () => {
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  assert.match(example, /^OPEN_SCIENCE_UNPAYWALL_EMAIL=$/m, "documented, and empty: the operator sets the address");
  // The runtime's copy is derived by the control plane; documenting it for an
  // operator to set would be a second knob that silently disagrees.
  assert.doesNotMatch(example, /^#? *EVIMED_UNPAYWALL_EMAIL=/m);
  const compose = YAML.parse(await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8"));
  assert.ok(Object.hasOwn(compose.services["open-science-web"].environment, "OPEN_SCIENCE_UNPAYWALL_EMAIL"));
});
