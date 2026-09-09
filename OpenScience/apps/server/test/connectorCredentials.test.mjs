// A researcher's own connector credentials: encrypted at rest, resolved only
// for their own runs, and only where the deployment holds none. The database
// is a fake that keeps rows as the real table would (bytea columns as
// Buffers), so what is exercised is the store's own logic — precedence,
// binding of the ciphertext to its owner, expiry — not SQL.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { CONNECTOR_CREDENTIAL_GATEWAY_PATH, ConnectorCredentialStore, createConnectorCredentialGatewayHandler } from "../src/connectorCredentials.mjs";

const SECRET = "s".repeat(48);

function fakeDatabase() {
  /** @type {Map<string, any>} */ const rows = new Map();
  const key = (user, connector) => `${user}\0${connector}`;
  return {
    rows,
    async query(text, values = []) {
      if (/^CREATE TABLE/m.test(text)) return { rows: [], rowCount: 0 };
      if (text.includes("INSERT INTO")) {
        const [user_id, connector, ciphertext, nonce, tag, expires_at] = values;
        const previous = rows.get(key(user_id, connector));
        rows.set(key(user_id, connector), { user_id, connector, ciphertext, nonce, tag, expires_at, created_at: previous?.created_at ?? new Date(), updated_at: new Date() });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("DELETE FROM")) {
        const existed = rows.delete(key(values[0], values[1]));
        return { rows: [], rowCount: existed ? 1 : 0 };
      }
      if (text.includes("SELECT connector, expires_at")) {
        return { rows: [...rows.values()].filter((row) => row.user_id === values[0]), rowCount: null };
      }
      if (text.includes("SELECT ciphertext")) {
        const row = rows.get(key(values[0], values[1]));
        return { rows: row ? [row] : [], rowCount: null };
      }
      throw new Error(`unexpected query: ${text.slice(0, 40)}`);
    },
  };
}

const jwt = (exp) => ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".");
const future = Math.floor(Date.now() / 1000) + 7 * 86_400;

test("a credential round-trips only for its own user and connector", async () => {
  const database = fakeDatabase();
  const store = new ConnectorCredentialStore({ database, secret: SECRET, config: { publicSourceCredentials: {} } });
  await store.migrate();
  await store.set("alice", "umls", " key-123 ");
  assert.equal(await store.resolveOwn("alice", "umls"), "key-123");
  // The row's bytes belong to alice/umls: read as anyone or anything else they
  // do not open, which is what the AAD is for.
  const row = database.rows.get("alice\0umls");
  database.rows.set("bob\0umls", { ...row, user_id: "bob" });
  database.rows.set("alice\0omim", { ...row, connector: "omim" });
  assert.equal(await store.resolveOwn("bob", "umls"), null);
  assert.equal(await store.resolveOwn("alice", "omim"), null);
  // Nothing about the value is stored in the clear.
  assert.ok(!Buffer.from(row.ciphertext).includes("key-123"));
});

test("the deployment's credential wins, the researcher's fills the gap, and expiry closes it", async () => {
  const database = fakeDatabase();
  let now = new Date();
  const config = { publicSourceCredentials: { umls: "deployment-umls" }, materialsProjectApiKey: "" };
  const store = new ConnectorCredentialStore({ database, secret: SECRET, config, now: () => now });
  await store.set("alice", "umls", "alice-umls");
  await store.set("alice", "opengwas", jwt(future));
  assert.deepEqual(await store.resolve("alice", "umls"), { value: "deployment-umls", source: "deployment" });
  assert.deepEqual(await store.resolve("alice", "opengwas"), { value: jwt(future), source: "user" });
  assert.equal(await store.resolve("alice", "core"), null);
  assert.equal(await store.resolve("alice", "evimed-evidence"), null, "the first-party API is not a connector");
  const status = Object.fromEntries((await store.status("alice")).map((entry) => [entry.id, entry]));
  assert.equal(status.umls.source, "deployment");
  assert.equal(status.umls.own?.updatedAt > "", true, "the researcher can still see and remove their own row");
  assert.equal(status.opengwas.source, "user");
  assert.equal(status.opengwas.needsAttention, false);
  assert.equal(status.core.source, "none");
  assert.equal(status.core.needsAttention, true);
  // Keyless upstreams never ask for attention: they serve without a key.
  assert.equal(status.ncbi.source, "none");
  assert.equal(status.ncbi.needsAttention, false);
  // Fourteen days on, the OpenGWAS token is expired: not offered to the
  // gateway, and asking for attention again.
  now = new Date((future + 60) * 1000);
  assert.equal(await store.resolve("alice", "opengwas"), null);
  const later = Object.fromEntries((await store.status("alice")).map((entry) => [entry.id, entry]));
  assert.equal(later.opengwas.source, "none");
  assert.equal(later.opengwas.own?.expired, true);
  assert.equal(later.opengwas.needsAttention, true);
});

test("an unacceptable value is refused before anything is written, and removal is reported honestly", async () => {
  const database = fakeDatabase();
  const store = new ConnectorCredentialStore({ database, secret: SECRET, config: {} });
  await assert.rejects(() => store.set("alice", "opengwas", "not-a-jwt"), /connector_credential_invalid|not accepted/);
  await assert.rejects(() => store.set("alice", "nope", "x"), /not accepted/);
  await assert.rejects(() => store.set("../x", "umls", "x"), /invalid/);
  assert.equal(database.rows.size, 0);
  assert.equal(await store.remove("alice", "umls"), false);
  await store.set("alice", "umls", "k");
  assert.equal(await store.remove("alice", "umls"), true);
  assert.equal(await store.resolveOwn("alice", "umls"), null);
});

test("the store refuses a weak root secret", () => {
  assert.throws(() => new ConnectorCredentialStore({ database: fakeDatabase(), secret: "short", config: {} }), /secret is invalid/);
});

// --- the adapter's endpoint ------------------------------------------------
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("an adapter gets the credential its workload's user should run with, and nothing for anyone else", async (t) => {
  const database = fakeDatabase();
  const store = new ConnectorCredentialStore({ database, secret: SECRET, config: { publicSourceCredentials: { umls: "deployment-umls" } } });
  await store.set("alice", "opengwas", jwt(future));
  const runtimeManager = {
    async assertActiveEviMedWorkloadToken(token) {
      if (token === "alice-workload") return { userId: "alice", projectId: "p" };
      if (token === "bob-workload") return { userId: "bob", projectId: "p" };
      throw new Error("invalid");
    },
  };
  const failures = [];
  const server = createServer(createConnectorCredentialGatewayHandler({ runtimeManager, store }));
  const base = await listen(server);
  t.after(() => { server.close(); });
  const ask = (connector, token) => fetch(`${base}${CONNECTOR_CREDENTIAL_GATEWAY_PATH}?connector=${connector}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  const alice = await ask("opengwas", "alice-workload");
  assert.equal(alice.status, 200);
  assert.deepEqual((await alice.json()).data, { connector: "opengwas", source: "user", value: jwt(future) });
  assert.equal(alice.headers.get("cache-control"), "no-store");
  const deployment = await ask("umls", "bob-workload");
  assert.deepEqual((await deployment.json()).data, { connector: "umls", source: "deployment", value: "deployment-umls" });
  assert.equal((await ask("opengwas", "bob-workload")).status, 404);
  assert.equal((await ask("opengwas", "nobody")).status, 401);
  assert.equal((await ask("opengwas")).status, 401);
  assert.equal((await ask("evimed-evidence", "alice-workload")).status, 400, "the first-party API is not a connector");
  const method = await fetch(`${base}${CONNECTOR_CREDENTIAL_GATEWAY_PATH}?connector=opengwas`, { method: "POST", headers: { authorization: "Bearer alice-workload" } });
  assert.equal(method.status, 404);
  // Without a store the endpoint says so by name rather than pretending.
  const bare = createServer(createConnectorCredentialGatewayHandler({ runtimeManager, store: null }));
  const bareBase = await listen(bare);
  t.after(() => { bare.close(); });
  const none = await fetch(`${bareBase}${CONNECTOR_CREDENTIAL_GATEWAY_PATH}?connector=opengwas`, { headers: { authorization: "Bearer alice-workload" } });
  assert.equal(none.status, 503);
  assert.equal((await none.json()).code, "connector_credentials_unavailable");
  assert.deepEqual(failures, []);
});
