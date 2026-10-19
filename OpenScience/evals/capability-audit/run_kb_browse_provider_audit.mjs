#!/usr/bin/env node
/** Bounded real-provider probe. Writes only a random audit namespace, then removes it.
 * Run in the configured control-plane environment. No engine or response stand-in is used.
 * Runtime-token admission is the audit's explicit seam; this is not browser-login certification.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.EVIMED_AUDIT_SOURCE_ROOT || process.cwd();
const moduleAt = (name) => import(pathToFileURL(path.join(root, "apps/server/src", name)).href);
const [{ loadConfig }, { OpenVikingClient }, { OpenVikingResources }, { createKbBrowseGatewayHandler, KB_BROWSE_GATEWAY_PATH }] = await Promise.all([
  moduleAt("config.mjs"), moduleAt("openVikingClient.mjs"), moduleAt("openVikingResources.mjs"), moduleAt("kbBrowseGateway.mjs"),
]);
const config = loadConfig();
const resources = new OpenVikingResources({ client: new OpenVikingClient(config) });
assert.ok(resources.configured, "A real OpenViking provider must be configured");
const nonce = randomUUID();
const userId = `capability-audit-${nonce}`;
const projectId = `kb-browse-${nonce}`;
const sourceId = `src_${createHash("sha256").update(nonce).digest("hex").slice(0, 32)}`;
const content = `# Synthetic capability audit\n\nKB-BROWSE-${nonce}\nThis file contains no customer data.\n`;
const token = randomUUID();
const identities = new Map([[token, { userId, projectId }], [`${token}-sibling`, { userId, projectId: `${projectId}-sibling` }], [`${token}-foreign`, { userId: `${userId}-foreign`, projectId }]]);
const runtimeManager = { assertActiveModelGatewayToken(value) { assert.ok(identities.has(value), "Inactive audit token"); return identities.get(value); } };
const handler = createKbBrowseGatewayHandler(config, runtimeManager, { resources });
const server = createServer((req, res) => { void handler(req, res); });
const receipts = [];
let cleanup = false;
try {
  await resources.pushSource(userId, resources.sourceUri(userId, projectId, sourceId), content, { sourceId, sha: createHash("sha256").update(content).digest("hex") });
  const indexed = await resources.read(userId, resources.sourceUri(userId, projectId, sourceId));
  assert.ok(JSON.stringify(indexed).includes(nonce), "The real provider must retain the written synthetic source");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const call = async (name, body, credential = token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${KB_BROWSE_GATEWAY_PATH}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body) });
    const result = await response.json();
    receipts.push({ name, httpStatus: response.status, response: result });
    return { status: response.status, result };
  };
  const overview = await call("indexed-source-overview", { op: "overview", root: "sources" });
  assert.equal(overview.status, 200);
  assert.ok(JSON.stringify(overview.result).includes(sourceId));
  const read = await call("indexed-source-read", { op: "read", root: "sources", path: `${sourceId}.md` });
  assert.equal(read.status, 200);
  assert.ok(JSON.stringify(read.result).includes(nonce));
  const grep = await call("indexed-source-grep", { op: "grep", root: "sources", pattern: `KB-BROWSE-${nonce}` });
  assert.equal(grep.status, 200);
  assert.ok(JSON.stringify(grep.result).includes(nonce));
  for (const suffix of ["sibling", "foreign"]) {
    const denied = await call(`${suffix}-cannot-read-source`, { op: "read", root: "sources", path: `${sourceId}.md` }, `${token}-${suffix}`);
    assert.ok(!JSON.stringify(denied.result).includes(nonce), "Other identities must not receive the synthetic secret");
    assert.ok(denied.status >= 400);
  }
  assert.equal((await call("invalid-token", { op: "overview", root: "sources" }, "inactive")).status, 401);
  assert.equal((await call("path-traversal", { op: "read", root: "sources", path: `../${sourceId}.md` })).status, 400);
} finally {
  if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await resources.removeTree(userId, resources.roots(userId, projectId).project);
  cleanup = true;
}
const sourceIdentity = {};
for (const name of ["kbBrowseGateway.mjs", "openVikingClient.mjs", "openVikingResources.mjs", "openVikingLayout.mjs"]) sourceIdentity[name] = createHash("sha256").update(await readFile(path.join(root, "apps/server/src", name))).digest("hex");
console.log(JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(), provider: "configured-openviking", scope: "real-provider-production-handler-with-audit-runtime-admission", fixture: "synthetic-random-isolated-namespace", sourceIdentity, cleanup, receipts }, null, 2));
