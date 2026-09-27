// The keyless tiers are said in one place and the three readers agree on it:
// the domain's connector registry, the public-source gateway (which sends a
// keyless request anonymously when no key is configured) and the operator's
// `check:evidence-connectors`. On 2026-09-26 the registry and the checker
// called Semantic Scholar keyless and the gateway refused it every time
// (audit I1-3).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONNECTOR_CREDENTIALS } from "@evimed/domain";
import { createPublicSourceGatewayHandler, PUBLIC_SOURCE_CREDENTIAL_PROFILES } from "../src/publicSourceGateway.mjs";
import { CONNECTOR_ENV, connectorPosture } from "../../../scripts/ops/check-evidence-connectors.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops/check-evidence-connectors.mjs");

test("the checker lists every connector the registry has, and takes keyless from it", () => {
  const rows = new Map(connectorPosture(CONNECTOR_CREDENTIALS, {}).map((row) => [row.profile, row]));
  for (const spec of CONNECTOR_CREDENTIALS) {
    assert.ok(rows.has(spec.id), `${spec.id} is not reported`);
    assert.equal(rows.get(spec.id).mode, spec.keyless ? "keyless-public" : "blocked", spec.id);
  }
  // The three the old list never named.
  for (const id of ["ncbi", "openfda", "materials-project"]) assert.ok(rows.has(id), id);
  assert.equal(rows.get("evimed-evidence").mode, "blocked");
  assert.match(rows.get("core").note, /public_source_core_credential_missing/);
  // A configured key is managed whatever the tier.
  assert.equal(new Map(connectorPosture(CONNECTOR_CREDENTIALS, { OPEN_SCIENCE_SEMANTIC_SCHOLAR_API_KEY: "k" }).map((row) => [row.profile, row.mode])).get("semantic-scholar"), "managed");
  // Unpaywall's contact address makes it keyless only for a runtime without the gateway.
  const direct = (env) => connectorPosture(CONNECTOR_CREDENTIALS, env).find((row) => row.profile === "unpaywall").mode;
  assert.equal(direct({ EVIMED_UNPAYWALL_EMAIL: "a@example.org" }), "keyless-public");
  assert.equal(direct({ EVIMED_UNPAYWALL_EMAIL: "a@example.org", EVIMED_PUBLIC_SOURCE_GATEWAY_URL: "http://web:8787/internal/sources/v1" }), "blocked");
});

test("with no key configured, the gateway serves exactly the profiles the checker calls keyless", async (t) => {
  const posture = new Map(connectorPosture(CONNECTOR_CREDENTIALS, { EVIMED_PUBLIC_SOURCE_GATEWAY_URL: "http://web" }).map((row) => [row.profile, row.mode]));
  const upstream = [];
  const server = createServer(createPublicSourceGatewayHandler({}, {
    assertActiveModelGatewayToken: (token) => { if (token !== "runtime-token") throw new Error("invalid"); return { userId: "alice", projectId: "p" }; },
  }, {
    fetchImpl: async (url) => { upstream.push(new URL(url).hostname); return new Response("{}", { headers: { "content-type": "application/json" } }); },
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  let compared = 0;
  for (const [profile, spec] of PUBLIC_SOURCE_CREDENTIAL_PROFILES) {
    // The platform's own API takes fixed POST bodies; its refusal is covered in publicSourceGateway.test.mjs.
    if (profile === "evimed-evidence") continue;
    const answer = await fetch(`http://127.0.0.1:${server.address().port}/internal/sources/v1/fetch`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
      body: JSON.stringify({ url: `https://${spec.host}${spec.path}probe`, accept: ["application/json"], credentialProfile: profile }),
    });
    const body = await answer.json().catch(() => ({}));
    const keyless = posture.get(profile) === "keyless-public";
    assert.equal(answer.status, keyless ? 200 : 503, `${profile}: ${JSON.stringify(body.error ?? {})}`);
    if (!keyless) assert.equal(body.error?.code, `public_source_${profile.replaceAll("-", "_")}_credential_missing`);
    compared += 1;
  }
  assert.ok(compared >= 8, `compared ${compared} profiles`);
  assert.ok(upstream.includes("api.semanticscholar.org"), "Semantic Scholar went upstream without a key");
});

test("the checker runs as a program and says Semantic Scholar is keyless", async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !Object.values(CONNECTOR_ENV).some((variable) => name.startsWith(variable))));
  const output = await new Promise((resolve, reject) => {
    execFile(process.execPath, [script, "--json"], { env }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
  });
  const report = JSON.parse(output);
  assert.equal(report.ok, true);
  assert.equal(report.connectors.find((row) => row.profile === "semantic-scholar").mode, "keyless-public");
  assert.equal(report.connectors.length, CONNECTOR_CREDENTIALS.length + 1);
});
