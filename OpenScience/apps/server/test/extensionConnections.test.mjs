import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionConnections } from "../src/extensionConnections.mjs";

const user = { id: "alice" }, project = { id: "p1", userId: "alice" };
const entry = { id: "citation-graph", connectionRequirements: [{ kind: "unpaywall", operations: ["doi.resolve"] }] };
const status = { id: "unpaywall", title: "Unpaywall", source: "user", own: { updatedAt: "2026-10-02T00:00:00.000Z", expiresAt: null, expired: false }, value: "must-never-leak" };
const access = { project: async (actor, id) => { if (actor.id !== user.id || id !== project.id) throw Object.assign(Error("missing"), { status: 404 }); return project; } };

test("connection inventory reveals only admitted references for the invoking actor, never stored values", async () => {
  const calls = [];
  const connections = new ExtensionConnections({ access, credentials: { status: async id => { calls.push(id); return [status]; } } });
  const result = await connections.list(user, entry, "p1");
  assert.deepEqual(calls, [user.id]); assert.equal(result.items[0].id, "connector:unpaywall");
  assert.deepEqual(Object.keys(result.items[0]).sort(), ["id", "kind", "operations", "revision", "title"]);
  assert(!JSON.stringify(result).includes(status.value)); assert.match(result.items[0].revision, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(connections.list({ id: "bob" }, entry, "p1"), { status: 404 });
  assert.deepEqual(await connections.list(user, { id: "no-connection" }, "p1"), { items: [], supportedKinds: [] });
});
test("authorization rechecks active owner row and operation/revision using the existing transaction", async () => {
  let row = { connector: "unpaywall", expires_at: null, updated_at: status.own.updatedAt };
  const credentials = { status: async () => [status], deploymentConfigured: () => false, database: { query: async () => assert.fail("must reuse supplied transaction") } };
  const connections = new ExtensionConnections({ access, credentials });
  const listed = (await connections.list(user, entry, "p1")).items[0];
  const observed = [];
  const client = { query: async (sql, values) => { observed.push({ sql, values }); return { rows: row ? [row] : [] }; } };
  const scope = { project, entry, client, operation: "doi.resolve", revision: listed.revision };
  assert(await connections.authorize(user, listed.id, scope)); assert(observed[0].sql.endsWith(" FOR SHARE")); assert.equal(observed[0].values[0], user.id);
  assert.equal(await connections.authorize(user, listed.id, { ...scope, operation: "page.publish" }), false);
  assert.equal(await connections.authorize(user, "connector:opengwas", scope), false);
  row = { ...row, updated_at: "2026-10-02T00:00:01.000Z" }; assert.equal(await connections.authorize(user, listed.id, scope), false);
  row = null; assert.equal(await connections.authorize(user, listed.id, scope), false);
});
test("managed connection adapters recheck every cached row and cannot expose credentials as inventory fields", async () => {
  let allowed = true;
  const row = { id: "managed:owned", kind: "notion", title: "My notes", operations: ["page.read"], revision: `sha256:${"a".repeat(64)}` };
  const adapter = { list: async () => [row], authorize: async () => allowed };
  const connections = new ExtensionConnections({ access, credentials: null, adapters: new Map([["notion", adapter]]) });
  const descriptor = { connectionRequirements: [{ kind: "notion", operations: ["page.read"] }] };
  assert.equal((await connections.list(user, descriptor, "p1")).items.length, 1);
  allowed = false; assert.equal((await connections.list(user, descriptor, "p1")).items.length, 0);
  adapter.list = async () => [{ ...row, accessToken: "private-value" }];
  await assert.rejects(connections.list(user, descriptor, "p1"), { code: "extension_contract_invalid" });
});

test("deployment connections reject foreign or stale metadata revisions before dispatch", async () => {
  const deployed = { ...status, source: "deployment", own: null };
  const connections = new ExtensionConnections({ access, credentials: { status: async () => [deployed], deploymentConfigured: () => true } });
  const listed = (await connections.list(user, entry, project.id)).items[0];
  const scope = { project, entry, operation: "doi.resolve", revision: listed.revision };
  assert(await connections.authorize(user, listed.id, scope));
  assert.equal(await connections.authorize(user, listed.id, { ...scope, revision: `sha256:${"f".repeat(64)}` }), false);
});
