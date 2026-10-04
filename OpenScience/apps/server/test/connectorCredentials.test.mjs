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
        // A new value forgets what the upstream said about the old one.
        rows.set(key(user_id, connector), { user_id, connector, ciphertext, nonce, tag, expires_at, created_at: previous?.created_at ?? new Date(), updated_at: new Date(), check_state: null, checked_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SET check_state")) {
        const [user_id, connector, state, nonce] = values;
        const row = rows.get(key(user_id, connector));
        // Only the write that was checked: a later one carries another nonce.
        if (!row || !Buffer.from(row.nonce).equals(Buffer.from(nonce))) return { rows: [], rowCount: 0 };
        rows.set(key(user_id, connector), { ...row, check_state: state, checked_at: new Date() });
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
  // The platform's own evidence API is a connector since 2026-10-04: nobody has
  // saved one, so nothing resolves, and the researcher may.
  assert.equal(await store.resolve("alice", "evimed-evidence"), null);
  await store.set("alice", "evimed-evidence", "alice-evimed-key");
  assert.deepEqual(await store.resolve("alice", "evimed-evidence"), { value: "alice-evimed-key", source: "user" });
  const withDeploymentKey = new ConnectorCredentialStore({ database, secret: SECRET, config: { publicSourceCredentials: { evimedEvidence: "deployment-evimed-key" } } });
  assert.deepEqual(await withDeploymentKey.resolve("alice", "evimed-evidence"), { value: "deployment-evimed-key", source: "deployment" }, "the deployment's key still goes first");
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
  const server = createServer((req, res) => createConnectorCredentialGatewayHandler({ runtimeManager, store })(req, res, (failure) => failures.push(failure)));
  const base = await listen(server);
  t.after(() => { server.close(); });
  const ask = (connector, token, extra = "") => fetch(`${base}${CONNECTOR_CREDENTIAL_GATEWAY_PATH}?connector=${connector}${extra}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  const alice = await ask("opengwas", "alice-workload");
  assert.equal(alice.status, 200);
  assert.deepEqual((await alice.json()).data, { connector: "opengwas", source: "user", value: jwt(future) });
  assert.equal(alice.headers.get("cache-control"), "no-store");
  // Only what an adapter job needs leaves the control plane: a runtime token is
  // a file the run can print, so a deployment's licensed keys stay with the
  // gateway that injects them (security review, 2026-09-20). OMIM is read by the
  // gateway and by no engine, so no job is handed it.
  const gatewayOnly = await ask("omim", "bob-workload");
  assert.equal(gatewayOnly.status, 403);
  assert.equal((await gatewayOnly.json()).code, "connector_not_job_scoped");
  assert.equal((await ask("opengwas", "bob-workload")).status, 404);
  assert.equal((await ask("opengwas", "nobody")).status, 401);
  assert.equal((await ask("opengwas")).status, 401);
  // The platform's own evidence API is a connector now; no engine reads it from
  // its environment, so it is the gateway's, not a job's.
  const evidence = await ask("evimed-evidence", "alice-workload");
  assert.equal(evidence.status, 403);
  assert.equal((await evidence.json()).code, "connector_not_job_scoped");
  assert.equal((await ask("not-a-connector", "alice-workload")).status, 400);
  const method = await fetch(`${base}${CONNECTOR_CREDENTIAL_GATEWAY_PATH}?connector=opengwas`, { method: "POST", headers: { authorization: "Bearer alice-workload" } });
  assert.equal(method.status, 404);
  // Without a store the endpoint says so by name rather than pretending.
  const bare = createServer(createConnectorCredentialGatewayHandler({ runtimeManager, store: null }));
  const bareBase = await listen(bare);
  t.after(() => { bare.close(); });
  const none = await fetch(`${bareBase}${CONNECTOR_CREDENTIAL_GATEWAY_PATH}?connector=opengwas`, { headers: { authorization: "Bearer alice-workload" } });
  assert.equal(none.status, 503);
  assert.equal((await none.json()).code, "connector_credentials_unavailable");
  // Every refusal was reported by code and status only.
  assert.ok(failures.length >= 6);
  for (const failure of failures) assert.deepEqual(Object.keys(failure).sort(), ["code", "status"]);
});

test("a job is handed the researcher's own engine key, never the deployment's, and only for the caller its token names", async (t) => {
  const database = fakeDatabase();
  const config = { publicSourceCredentials: { umls: "deployment-umls-LICENSED", ncbi: "deployment-ncbi", openFda: "deployment-fda" } };
  const store = new ConnectorCredentialStore({ database, secret: SECRET, config });
  await store.set("alice", "umls", "alice-umls-key");
  await store.set("alice", "ncbi", "alice-ncbi-key");
  await store.set("alice", "openfda", "alice-fda-key");
  const runtimeManager = {
    async assertActiveEviMedWorkloadToken(token) {
      if (token === "alice-workload") return { userId: "alice", projectId: "p" };
      if (token === "bob-workload") return { userId: "bob", projectId: "p" };
      throw new Error("the workload token is not active");
    },
  };
  const failures = [];
  const server = createServer((req, res) => createConnectorCredentialGatewayHandler({ runtimeManager, store })(req, res, (failure) => failures.push(failure)));
  const base = await listen(server);
  t.after(() => { server.close(); });
  const ask = (connector, token, extra = "") => fetch(`${base}${CONNECTOR_CREDENTIAL_GATEWAY_PATH}?connector=${connector}${extra}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  for (const [connector, own] of [["umls", "alice-umls-key"], ["ncbi", "alice-ncbi-key"], ["openfda", "alice-fda-key"]]) {
    const answer = await ask(connector, "alice-workload");
    assert.equal(answer.status, 200, connector);
    // The researcher's own value, marked as theirs — and not the deployment's,
    // which the same route would have returned had it answered for the deployment.
    assert.deepEqual((await answer.json()).data, { connector, source: "user", value: own }, connector);
    assert.equal(answer.headers.get("cache-control"), "no-store");
  }
  // Bob saved nothing and the deployment holds all three: he gets nothing, not
  // the deployment's licensed key.
  const refusedBodies = [];
  for (const connector of ["umls", "ncbi", "openfda"]) {
    const answer = await ask(connector, "bob-workload");
    assert.equal(answer.status, 404, connector);
    refusedBodies.push(await answer.text());
    assert.equal(JSON.parse(refusedBodies.at(-1)).code, "connector_credential_missing");
  }
  // A caller cannot name another user: the token is the only identity read.
  const named = await ask("umls", "bob-workload", "&userId=alice&user=alice");
  assert.equal(named.status, 404);
  refusedBodies.push(await named.text());
  // The authentication is exactly the workload token's: absent, malformed or
  // inactive, it is 401 for the new connectors as for OpenGWAS.
  for (const token of [null, "nobody", "alice-workload-expired"]) {
    const answer = await ask("umls", token);
    assert.equal(answer.status, 401, String(token));
    refusedBodies.push(await answer.text());
  }
  // No refusal, no failure report and no audit-shaped record carries any value.
  const everything = JSON.stringify([refusedBodies, failures]);
  for (const secret of ["alice-umls-key", "alice-ncbi-key", "alice-fda-key", "deployment-umls-LICENSED", "deployment-ncbi", "deployment-fda"]) {
    assert.ok(!everything.includes(secret), `${secret} reached a refusal or a failure report`);
  }
  assert.ok(failures.length >= 7);
  // An expired credential is not handed out.
  const expired = new ConnectorCredentialStore({ database: fakeDatabase(), secret: SECRET, config: {}, now: () => new Date(Date.now() + 40 * 86_400_000) });
  await expired.set("carol", "opengwas", jwt(Math.floor(Date.now() / 1000) + 3600));
  assert.equal(await expired.resolveOwn("carol", "opengwas"), null);
});

test("saving asks the source once, keeps the value whatever it says, and remembers the answer beside it", async () => {
  const database = fakeDatabase();
  const asked = [];
  const answers = { umls: "verified", core: "rejected", omim: "unreachable", ncbi: "unchecked", addgene: "throws", biogrid: "something else" };
  const store = new ConnectorCredentialStore({
    database, secret: SECRET, config: {},
    check: async (connector, value) => {
      asked.push([connector, value]);
      if (answers[connector] === "throws") throw new Error(`upstream said: ${value}`);
      return answers[connector];
    },
  });
  const states = {};
  for (const connector of Object.keys(answers)) states[connector] = (await store.set("alice", connector, `key-for-${connector}`)).check;
  assert.deepEqual(states, { umls: "verified", core: "rejected", omim: "unreachable", ncbi: "unchecked", addgene: "unreachable", biogrid: "unreachable" });
  // Saved in every case: a source that says no may be wrong, and one that is
  // down must not stop anyone saving.
  for (const connector of Object.keys(answers)) assert.equal(await store.resolveOwn("alice", connector), `key-for-${connector}`, connector);
  const status = Object.fromEntries((await store.status("alice")).map((entry) => [entry.id, entry]));
  assert.equal(status.umls.own.check.state, "verified");
  assert.equal(status.core.own.check.state, "rejected");
  assert.match(status.core.own.check.checkedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(status.opengwas.own, null);
  assert.equal(status.umls.source, "user", "a rejected value is still the researcher's own");
  // The status reports a state, never a value or anything the source said.
  assert.ok(!JSON.stringify(await store.status("alice")).includes("key-for-"));
  // A malformed value is the one thing refused, and the source is never asked about it.
  asked.length = 0;
  await assert.rejects(() => store.set("alice", "umls", "has a space"), /not accepted/);
  assert.deepEqual(asked, []);
  assert.equal(await store.resolveOwn("alice", "umls"), "key-for-umls", "the refused value replaced nothing");
  // A new value forgets the old answer, and without a check a save is `unchecked`.
  const unchecked = new ConnectorCredentialStore({ database, secret: SECRET, config: {} });
  assert.equal((await unchecked.set("alice", "umls", "newer-key")).check, "unchecked");
  assert.equal((await unchecked.status("alice")).find((entry) => entry.id === "umls").own.check.state, "unchecked");
});

test("a second save while the first is still being checked keeps its own answer", async () => {
  const database = fakeDatabase();
  let nested = false;
  /** @type {ConnectorCredentialStore} */
  const store = new ConnectorCredentialStore({
    database, secret: SECRET, config: {},
    check: async (connector, value) => {
      if (value === "first-key" && !nested) {
        nested = true;
        await store.set("alice", connector, "second-key");
        return "rejected";
      }
      return "verified";
    },
  });
  assert.equal((await store.set("alice", "core", "first-key")).check, "rejected", "the first save is told its own answer");
  assert.equal(await store.resolveOwn("alice", "core"), "second-key");
  const core = (await store.status("alice")).find((entry) => entry.id === "core");
  assert.equal(core.own.check.state, "verified", "the answer about the first key did not land on the second");
});

test("the adapter's engine-key roster is the control plane's job-scoped list", async () => {
  const { readFile } = await import("node:fs/promises");
  const { JOB_SCOPED_CONNECTORS, JOB_OWN_CREDENTIAL_ONLY } = await import("../src/connectorCredentials.mjs");
  const source = await readFile(new URL("../../../deploy/specialist-adapter/evimed_specialist_adapter/service.py", import.meta.url), "utf8");
  const block = /_JOB_CONNECTOR_ENV = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  const asked = new Set([...block.matchAll(/"([a-z][a-z0-9-]*)":\s*"[A-Z][A-Z0-9_]*"/g)].map((match) => match[1]));
  assert.ok(asked.size >= 4, `the adapter's table was read as ${[...asked].join(",")}`);
  // An adapter that asks for a connector the control plane does not answer for
  // would be a job refused with 403 at start; a connector answered for and asked
  // by no adapter would be an exposure nothing needs.
  assert.deepEqual([...asked].sort(), [...JOB_SCOPED_CONNECTORS].sort());
  // Every one of them but OpenGWAS is answered with the researcher's own key only.
  assert.deepEqual([...JOB_SCOPED_CONNECTORS].filter((id) => !JOB_OWN_CREDENTIAL_ONLY.has(id)), ["opengwas"]);
});
