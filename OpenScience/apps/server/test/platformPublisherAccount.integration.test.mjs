// The platform's own publishing account (「EviMed 证据中心」, evidence-flywheel B2, 2026-10-05): one control-plane migration
// makes it, and no path a person has — sign-in, registration, an external identity, a session, a device token, an integration
// key, account deletion, account export — may reach it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PLATFORM_PUBLISHER_NAME, PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { createAgentMemoryRoutes } from "../src/agentMemoryRoutes.mjs";
import { withAccountExportSnapshot } from "../src/accountExport.mjs";
import { DEVICE_REQUEST } from "../src/channels/deviceTokens.mjs";
import { CONTROL_PLANE_SCHEMA_VERSION, ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { InMemoryStore, createStore } from "../src/store.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
/** @type {any} */ let isolated, store, dataDir;

const databaseConfig = (/** @type {string} */ databaseUrl) => ({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
const response = () => {
  const headers = {};
  return { headers, setHeader(/** @type {string} */ name, /** @type {string} */ value) { headers[name] = value; }, getHeader() {} };
};
const request = (/** @type {Record<string, any>} */ extra = {}) => ({ headers: {}, socket: { encrypted: false }, ...extra });
const platformUser = { id: PLATFORM_PUBLISHER_USER_ID, name: PLATFORM_PUBLISHER_NAME, authType: "platform", accountCreatedAt: "2026-10-05 00:00:00+00" };
const refusal = (/** @type {string} */ code, status = 0) => (/** @type {any} */ error) => error?.code === code && (status === 0 || error.status === status);

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "platformacct");
  dataDir = await mkdtemp(join(tmpdir(), "platform-account-"));
  store = createStore({ stateStore: "postgres", ...databaseConfig(isolated.url), dataDir, sessionCookieName: "os_session", sessionTtlMs: 3_600_000, production: false });
});
after(async () => {
  await store?.close();
  await isolated?.drop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("the migration makes the publisher account, twice, and it is nobody's: no password, an auth type of its own", options, async () => {
  await store.database.migrate();
  const row = async () => (await store.database.query("SELECT id,name,password_hash,auth_type FROM evimed_control.users WHERE id=$1", [PLATFORM_PUBLISHER_USER_ID])).rows;
  assert.deepEqual(await row(), [{ id: PLATFORM_PUBLISHER_USER_ID, name: PLATFORM_PUBLISHER_NAME, password_hash: null, auth_type: "platform" }]);
  // A second process starting against the same database changes nothing, and the schema version readiness requires is recorded.
  const second = new ControlPlaneDatabase(databaseConfig(isolated.url));
  try { await second.migrate(); await second.migrate(); assert.equal((await second.health()).schemaVersion, CONTROL_PLANE_SCHEMA_VERSION); } finally { await second.close(); }
  assert.equal(CONTROL_PLANE_SCHEMA_VERSION, 5);
  assert.equal((await row()).length, 1);
  assert.equal(Number((await store.database.query("SELECT count(*) AS n FROM evimed_control.users WHERE auth_type='platform'")).rows[0].n), 1);
  assert.deepEqual(await store.readiness(), { mode: "postgres", shared: true, schemaVersion: 5 });
});

test("the database itself refuses a second platform account, a person holding its id, and a password on it", options, async () => {
  const insert = (/** @type {string} */ id, /** @type {string} */ type, /** @type {string | null} */ hash) => store.database.query(
    "INSERT INTO evimed_control.users(id,name,password_hash,auth_type) VALUES($1,'x',$2,$3)", [id, hash, type]);
  await assert.rejects(insert("another-platform", "platform", null), /users_platform_account_check/);
  await assert.rejects(insert("Evimed-Evidence-Center", "platform", null), /users_platform_account_check/, "not even its own id in another case");
  for (const id of [PLATFORM_PUBLISHER_USER_ID, "Evimed-Evidence-Center", "EVIMED-EVIDENCE-CENTER"]) {
    for (const type of ["local", "oidc", "evimed", "subject", "development"]) {
      await assert.rejects(insert(id, type, type === "local" ? "scrypt:a:b" : null), /users_pkey|users_platform_account_check/, `${id} as ${type}`);
    }
  }
  await assert.rejects(store.database.query("UPDATE evimed_control.users SET password_hash='scrypt:a:b' WHERE id=$1", [PLATFORM_PUBLISHER_USER_ID]), /users_platform_account_check/);
  await assert.rejects(store.database.query("UPDATE evimed_control.users SET auth_type='local',password_hash='scrypt:a:b' WHERE id=$1", [PLATFORM_PUBLISHER_USER_ID]), /users_platform_account_check/);
});

test("it migrates on a database that already holds release data, and names a person who took its id first instead of overwriting them", options, async () => {
  const upgrade = await createGeoTestDatabase(/** @type {string} */ (url), "platformupgrade");
  const first = new ControlPlaneDatabase(databaseConfig(upgrade.url));
  try {
    await first.migrate();
    // The database as release 5 left it: the older constraint, no publisher, the people who already registered.
    await first.query("ALTER TABLE evimed_control.users DROP CONSTRAINT users_platform_account_check");
    await first.query("ALTER TABLE evimed_control.users DROP CONSTRAINT users_auth_type_check");
    await first.query("DELETE FROM evimed_control.users WHERE id=$1", [PLATFORM_PUBLISHER_USER_ID]);
    await first.query("DELETE FROM evimed_control.schema_migrations WHERE version=5");
    await first.query("ALTER TABLE evimed_control.users ADD CONSTRAINT users_auth_type_check CHECK (auth_type IN ('local','oidc','development','evimed','subject'))");
    await first.query("INSERT INTO evimed_control.users(id,name,password_hash,auth_type) VALUES('alice','Alice','scrypt:a:b','local'),('bob','Bob',NULL,'oidc')");
    const upgraded = new ControlPlaneDatabase(databaseConfig(upgrade.url));
    try {
      await upgraded.migrate();
      assert.deepEqual((await upgraded.query("SELECT id,auth_type FROM evimed_control.users ORDER BY id")).rows,
        [{ id: "alice", auth_type: "local" }, { id: "bob", auth_type: "oidc" }, { id: PLATFORM_PUBLISHER_USER_ID, auth_type: "platform" }]);
      assert.equal((await upgraded.health()).schemaVersion, 5);
    } finally { await upgraded.close(); }
    // A person registered the id before the account existed: the migration stops, naming it, and does not touch them.
    await first.query("ALTER TABLE evimed_control.users DROP CONSTRAINT users_platform_account_check");
    await first.query("ALTER TABLE evimed_control.users DROP CONSTRAINT users_auth_type_check");
    await first.query("DELETE FROM evimed_control.users WHERE id=$1", [PLATFORM_PUBLISHER_USER_ID]);
    await first.query("ALTER TABLE evimed_control.users ADD CONSTRAINT users_auth_type_check CHECK (auth_type IN ('local','oidc','development','evimed','subject'))");
    await first.query("INSERT INTO evimed_control.users(id,name,password_hash,auth_type) VALUES('Evimed-Evidence-Center','Someone','scrypt:a:b','local')");
    const refused = new ControlPlaneDatabase(databaseConfig(upgrade.url));
    try {
      await assert.rejects(refused.migrate(), /platform_account_id_taken/);
      assert.equal((await first.query("SELECT name FROM evimed_control.users WHERE id='Evimed-Evidence-Center'")).rows[0].name, "Someone");
    } finally { await refused.close(); }
  } finally { await first.close(); await upgrade.drop(); }
});

test("it cannot sign in by a password, a session, an external identity, a device token or a registration", options, async () => {
  const user = await store.userById(PLATFORM_PUBLISHER_USER_ID);
  assert.equal(user.authType, "platform");
  // Local sign-in: the answer a wrong password gets, whatever is typed — nothing says the account exists.
  for (const password of ["", "password", "correct horse battery staple"]) {
    await assert.rejects(store.login(PLATFORM_PUBLISHER_USER_ID, password, request(), response()), refusal("invalid_credentials", 401));
  }
  // The one chokepoint every sign-in ends at: OIDC's callback, the EviMed shell's exchange and the development login all call it.
  await assert.rejects(store.createSession(user, request(), response()), refusal("platform_account_protected", 403));
  assert.equal(Number((await store.database.query("SELECT count(*) AS n FROM evimed_control.auth_sessions WHERE user_id=$1", [PLATFORM_PUBLISHER_USER_ID])).rows[0].n), 0);
  // External identities: an id that is the publisher's is refused, and a provider's display name that is the publisher's is not kept.
  for (const kind of ["oidc", "evimed"]) {
    await assert.rejects(store.upsertExternalUser(PLATFORM_PUBLISHER_USER_ID, "Someone", kind, kind === "evimed" ? { evimedUserId: "u-1" } : {}), refusal("platform_account_reserved", 409), kind);
  }
  const impersonator = await store.upsertExternalUser("oidc-subject-1", "EviMed 证据中心", "oidc");
  assert.equal(impersonator.name, "EviMed User", "an identity provider cannot give a person the publisher's name");
  // A session row that names the account is no session: it is deleted, never honoured.
  const secret = "sess_platform_forged";
  const { createHash } = await import("node:crypto");
  await store.database.query("INSERT INTO evimed_control.auth_sessions(id_hash,user_id,csrf_token,created_at,expires_at) VALUES($1,$2,'csrf',now(),now()+interval '1 hour')",
    [createHash("sha256").update(secret).digest("hex"), PLATFORM_PUBLISHER_USER_ID]);
  await assert.rejects(store.ensureSessionUser(request({ headers: { cookie: `os_session=${secret}` } }), response(), { allowDevAuth: false }), refusal("unauthorized", 401));
  assert.equal(Number((await store.database.query("SELECT count(*) AS n FROM evimed_control.auth_sessions WHERE user_id=$1", [PLATFORM_PUBLISHER_USER_ID])).rows[0].n), 0, "the forged row is gone");
  // A device token resolved to it authenticates nobody.
  await assert.rejects(store.ensureSessionUser(request({ [DEVICE_REQUEST]: { user, tokenId: "t1" } }), response(), { allowDevAuth: false }), refusal("unauthorized", 401));
  // Registration: its id in any case, and its name in any spelling a reader would take for it.
  for (const username of [PLATFORM_PUBLISHER_USER_ID, "Evimed-Evidence-Center", "EVIMED-EVIDENCE-CENTER"]) {
    await assert.rejects(store.createUser(username, "a long enough password"), refusal("platform_account_reserved", 409), username);
  }
  for (const name of ["EviMed 证据中心", "EviMed证据中心", " evimed  证据中心 "]) {
    await assert.rejects(store.createUser("honest-user", "a long enough password", name), refusal("platform_account_reserved", 409), name);
  }
  assert.equal((await store.database.query("SELECT 1 FROM evimed_control.users WHERE id='honest-user'")).rowCount, 0, "nothing was created by a refused registration");
  const registered = await store.createUser("honest-user", "a long enough password", "Honest User");
  assert.equal(registered.id, "honest-user", "the guard refuses the publisher's names and nobody else's");
});

test("nothing speaks for it through an integration key", options, async () => {
  const routes = createAgentMemoryRoutes({
    config: { agentMemoryApiEnabled: true, maxJsonBytes: 1_048_576 },
    apiKeys: /** @type {any} */ ({ async resolve() { return { userId: PLATFORM_PUBLISHER_USER_ID, keyId: "agk_1", projectId: null, scopes: ["memory.read"], subjects: false }; } }),
    store, researchMemory: /** @type {any} */ ({}), capsules: /** @type {any} */ ({}), memoryIntelligence: /** @type {any} */ ({}),
  });
  await assert.rejects(routes(/** @type {any} */ ({ url: "/api/agent-memory/v1/recall", method: "GET", headers: { authorization: "Bearer evk_x" } }), /** @type {any} */ (response())),
    refusal("agent_key_invalid", 401));
});

test("it cannot be deleted or exported, by the store or by the export itself", options, async () => {
  const user = await store.userById(PLATFORM_PUBLISHER_USER_ID);
  await assert.rejects(store.deleteUser(user), refusal("platform_account_protected", 403));
  await assert.rejects(store.deleteUser({ id: PLATFORM_PUBLISHER_USER_ID, authType: "local" }), refusal("platform_account_protected", 403), "refused by its id, whatever the caller says it is");
  await assert.rejects(store.deleteUser({ id: "Evimed-Evidence-Center" }), refusal("platform_account_protected", 403));
  assert.equal((await store.database.query("SELECT 1 FROM evimed_control.users WHERE id=$1", [PLATFORM_PUBLISHER_USER_ID])).rowCount, 1);
  let exported = false;
  await assert.rejects(withAccountExportSnapshot(store.database, { ...platformUser, accountCreatedAt: user.accountCreatedAt }, {}, async () => { exported = true; }), refusal("platform_account_protected", 403));
  assert.equal(exported, false, "no snapshot was taken");
  // Even a deployment with no product database refuses by name rather than handing back an empty archive.
  await assert.rejects(withAccountExportSnapshot(null, platformUser, {}, async () => "archive"), refusal("platform_account_protected", 403));
});

test("the file store refuses the same names and the same sign-in", async () => {
  const files = new InMemoryStore({ dataDir: await mkdtemp(join(tmpdir(), "platform-account-files-")), usersFile: "", sessionsFile: "" });
  await assert.rejects(files.createUser("evimed-evidence-center", "a long enough password"), refusal("platform_account_reserved", 409));
  await assert.rejects(files.createUser("someone", "a long enough password", "EviMed 证据中心"), refusal("platform_account_reserved", 409));
  await assert.rejects(files.upsertExternalUser("evimed-evidence-center", "x", "oidc"), refusal("platform_account_reserved", 409));
  await assert.rejects(files.deleteUser(platformUser), refusal("platform_account_protected", 403));
  await assert.rejects(files.createSession(platformUser, request(), response()), refusal("platform_account_protected", 403));
  await rm(files.config.dataDir, { recursive: true, force: true });
});
