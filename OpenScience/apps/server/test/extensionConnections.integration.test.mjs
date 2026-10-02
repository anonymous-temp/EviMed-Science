import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ConnectorCredentialStore } from "../src/connectorCredentials.mjs";
import { ExtensionAccess } from "../src/extensionAccess.mjs";
import { ExtensionConnections } from "../src/extensionConnections.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = { id: `connection_${randomUUID()}` }, other = { id: `connection_${randomUUID()}` };
const entry = { id: "source-fixture", connectionRequirements: [{ kind: "unpaywall", operations: ["doi.resolve"] }] };
let database, credentials, connections;
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 1, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Connection owner','development'),($2,'Other fixture','development')", [owner.id, other.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'p1','Owner project',1048576),($2,'p1','Other project',1048576)", [owner.id, other.id]);
  credentials = new ConnectorCredentialStore({ database, secret: "local connection test encryption secret only", config: {} }); await credentials.migrate();
  const access = new ExtensionAccess({ projectAccess: async (user, id, { client }) => {
    const query = client ?? database;
    const result = await query.query("SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2", [user.id, id]);
    if (!result.rows.length) throw Object.assign(Error("missing"), { status: 404 }); return { project: { id, userId: user.id }, role: "owner" };
  } });
  connections = new ExtensionConnections({ credentials, access });
});
after(async () => { if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner.id, other.id]]); await database.close(); } });

test("real encrypted source credentials stay actor scoped across discovery, transaction reuse and revocation", options, async () => {
  await credentials.set(owner.id, "unpaywall", "private-fixture@example.org");
  const listed = await connections.list(owner, entry, "p1"); assert.equal(listed.items.length, 1);
  assert(!JSON.stringify(listed).includes("private-fixture@example.org"));
  assert.deepEqual((await connections.list(other, entry, "p1")).items, []);
  const saved = listed.items[0];
  // poolMax1 makes a nested checkout a real deadlock; supplied transaction must be reused by both judges.
  await database.transaction(async client => {
    const scope = { project: { id: "p1", userId: owner.id }, entry, client, operation: "doi.resolve", revision: saved.revision };
    assert(await connections.authorize(owner, saved.id, scope));
    assert.equal(await connections.authorize(owner, saved.id, { ...scope, operation: "page.publish" }), false);
    assert.equal(await connections.authorize(other, saved.id, { ...scope, project: { id: "p1", userId: other.id } }), false);
  });
  await credentials.remove(owner.id, "unpaywall");
  assert.equal(await connections.authorize(owner, saved.id, { project: { id: "p1", userId: owner.id }, entry, operation: "doi.resolve", revision: saved.revision }), false);
  assert.deepEqual((await connections.list(owner, entry, "p1")).items, []);
});
test("replaced or expired credentials invalidate the earlier metadata revision before operation dispatch", options, async () => {
  await credentials.set(owner.id, "unpaywall", "first-fixture@example.org");
  const old = (await connections.list(owner, entry, "p1")).items[0];
  await credentials.set(owner.id, "unpaywall", "replacement-fixture@example.org");
  const scope = { project: { id: "p1", userId: owner.id }, entry, operation: "doi.resolve", revision: old.revision };
  assert.equal(await connections.authorize(owner, old.id, scope), false);
  await database.query("UPDATE evimed_control.user_connector_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND connector='unpaywall'", [owner.id]);
  assert.equal(await connections.authorize(owner, old.id, scope), false);
});
