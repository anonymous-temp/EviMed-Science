import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../src/controlPlaneDatabase.mjs";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const { Pool } = pg;

function assertTestDatabase(value) {
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) || !parsed.pathname.includes("evimed_test")) {
    throw new Error("OPEN_SCIENCE_TEST_POSTGRES_URL must target a loopback database whose name contains evimed_test.");
  }
}

async function start(dataDir) {
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: false,
    authMode: "local",
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    stateStore: "postgres",
    requireSharedStateStore: true,
    databaseUrl,
  });
  const address = await app.listen(0, "127.0.0.1");
  return { app, base: `http://127.0.0.1:${address.port}` };
}

async function login(base, username, password) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  return {
    response,
    body,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    csrf: body.data?.csrfToken ?? "",
  };
}

async function pathMissing(file) {
  return (await stat(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error))) == null;
}

test("PostgreSQL shares tenants, auth sessions, projects, quotas, and research session identity across app instances", {
  skip: databaseUrl ? false : "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  assertTestDatabase(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-postgres-store-"));
  let first;
  let second;
  try {
    first = await start(dataDir);
    second = await start(dataDir);

    const alice = await login(first.base, "alice", "correct horse battery staple");
    assert.equal(alice.response.status, 200);
    const created = await fetch(`${first.base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: alice.cookie,
        "X-Open-Science-CSRF": alice.csrf,
      },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.equal(created.status, 200);

    const bound = await fetch(`${first.base}/api/research-sessions/ses_shared`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: alice.cookie,
        "X-Open-Science-CSRF": alice.csrf,
        "X-Open-Science-Project": "paper1",
      },
      body: JSON.stringify({ mode: "open-domain" }),
    });
    assert.equal(bound.status, 200);

    const meFromSecond = await fetch(`${second.base}/api/me`, { headers: { Cookie: alice.cookie } });
    assert.equal(meFromSecond.status, 200);
    assert.equal((await meFromSecond.json()).data.user.id, "alice");
    const projectsFromSecond = await fetch(`${second.base}/api/projects`, { headers: { Cookie: alice.cookie } });
    assert.deepEqual((await projectsFromSecond.json()).data, [
      { id: "paper1", name: "Paper 1", archivedAt: null, runCount: 0, lastActivityAt: null },
      { id: "default", name: "我的研究", archivedAt: null, runCount: 0, lastActivityAt: null },
    ]);
    const sessionsFromSecond = await fetch(`${second.base}/api/research-sessions`, {
      headers: { Cookie: alice.cookie, "X-Open-Science-Project": "paper1" },
    });
    assert.equal(sessionsFromSecond.status, 200);
    assert.equal((await sessionsFromSecond.json()).data[0].sessionId, "ses_shared");

    const aliceFromFirst = await first.app.store.userById("alice");
    const aliceFromSecond = await second.app.store.userById("alice");
    const paperFromFirst = await first.app.store.requireProject(aliceFromFirst, "paper1");
    const paperFromSecond = await second.app.store.requireProject(aliceFromSecond, "paper1");
    const createdAt = new Date().toISOString();
    const competingSessions = await Promise.allSettled([
      first.app.store.putResearchSession(paperFromFirst, {
        sessionId: "ses_capacity_a",
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
        createdAt,
        updatedAt: createdAt,
      }, { maximum: 2 }),
      second.app.store.putResearchSession(paperFromSecond, {
        sessionId: "ses_capacity_b",
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
        createdAt,
        updatedAt: createdAt,
      }, { maximum: 2 }),
    ]);
    assert.equal(competingSessions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(competingSessions.filter((result) => result.status === "rejected").length, 1);
    assert.equal(competingSessions.find((result) => result.status === "rejected").reason.code, "research_session_limit_reached");

    await first.app.store.createUser("bob", "abc123", "Bob");
    const bob = await login(second.base, "bob", "abc123");
    assert.equal(bob.response.status, 200);
    const bobProjects = await fetch(`${second.base}/api/projects`, { headers: { Cookie: bob.cookie } });
    assert.deepEqual((await bobProjects.json()).data, [{ id: "default", name: "我的研究", archivedAt: null, runCount: 0, lastActivityAt: null }]);
    const bobCannotSeeAlice = await fetch(`${second.base}/api/research-sessions`, {
      headers: { Cookie: bob.cookie, "X-Open-Science-Project": "paper1" },
    });
    assert.equal(bobCannotSeeAlice.status, 404);

    await admin.query(
      "UPDATE evimed_control.projects SET quota_bytes = 2048 WHERE user_id = 'alice' AND id = 'paper1'",
    );
    const aliceUser = await second.app.store.userById("alice");
    const quotaProject = await second.app.store.requireProject(aliceUser, "paper1");
    assert.equal(quotaProject.maxBytes, 2048);

    await first.app.store.createProject(aliceFromFirst, "project-race", "Project Race");
    const projectRace = await Promise.allSettled([
      first.app.store.deleteProject(aliceFromFirst, "project-race"),
      second.app.store.createProject(aliceFromSecond, "project-race", "Project Race Recreated"),
    ]);
    assert.equal(projectRace[0].status, "fulfilled");
    const projectRaceRow = await admin.query(
      "SELECT count(*)::integer AS count FROM evimed_control.projects WHERE user_id = 'alice' AND id = 'project-race'",
    );
    const projectRaceExists = projectRaceRow.rows[0].count === 1;
    assert.equal(projectRaceExists, projectRace[1].status === "fulfilled");
    assert.equal(
      await pathMissing(path.join(dataDir, "users", "alice", "projects", "project-race")),
      !projectRaceExists,
    );

    await first.app.store.createProject(aliceFromFirst, "workspace-race", "Workspace Race");
    const workspaceRaceFromFirst = await first.app.store.requireProject(aliceFromFirst, "workspace-race");
    const workspaceRace = await Promise.allSettled([
      first.app.store.setProjectWorkspace(workspaceRaceFromFirst, "analysis"),
      second.app.store.deleteProject(aliceFromSecond, "workspace-race"),
    ]);
    assert.equal(workspaceRace[1].status, "fulfilled");
    if (workspaceRace[0].status === "rejected") {
      assert.equal(workspaceRace[0].reason.code, "project_not_found");
    }
    assert.equal(
      (await admin.query("SELECT count(*)::integer AS count FROM evimed_control.projects WHERE user_id = 'alice' AND id = 'workspace-race'")).rows[0].count,
      0,
    );
    assert.equal(await pathMissing(path.join(dataDir, "users", "alice", "projects", "workspace-race")), true);

    await first.app.store.createUser("identity-race", "race correct battery staple", "Identity Race");
    const identityFromFirst = await first.app.store.userById("identity-race");
    const identityRace = await Promise.allSettled([
      first.app.store.deleteUser(identityFromFirst),
      second.app.store.createUser("identity-race", "new correct battery staple", "Identity Race Recreated"),
    ]);
    assert.equal(identityRace[0].status, "fulfilled");
    const identityRows = await admin.query(
      `SELECT
         (SELECT count(*) FROM evimed_control.users WHERE id = 'identity-race')::integer AS users,
         (SELECT count(*) FROM evimed_control.deleted_users WHERE id = 'identity-race')::integer AS tombstones`,
    );
    assert.equal(identityRows.rows[0].users + identityRows.rows[0].tombstones, 1);
    assert.equal(identityRows.rows[0].users, identityRace[1].status === "fulfilled" ? 1 : 0);
    assert.equal(
      await pathMissing(path.join(dataDir, "users", "identity-race")),
      identityRows.rows[0].users === 0,
    );
    if (projectRaceExists) await first.app.store.deleteProject(aliceFromFirst, "project-race");
    if (identityRows.rows[0].users === 1) {
      await second.app.store.deleteUser(await second.app.store.userById("identity-race"));
    }

    const readiness = await first.app.store.readiness();
    assert.deepEqual(readiness, { mode: "postgres", shared: true, schemaVersion: CONTROL_PLANE_SCHEMA_VERSION });
    for (const file of [
      path.join(dataDir, "users.json"),
      path.join(dataDir, ".openscience", "sessions.json"),
      path.join(dataDir, "users", "alice", "projects", "paper1", "project.json"),
      path.join(dataDir, "users", "alice", "projects", "paper1", ".openscience", "research-sessions.json"),
    ]) {
      assert.equal(await pathMissing(file), true, `${file} should not contain PostgreSQL control-plane state`);
    }

    const rows = await admin.query(
      "SELECT (SELECT count(*) FROM evimed_control.users)::integer AS users, (SELECT count(*) FROM evimed_control.auth_sessions)::integer AS sessions, (SELECT count(*) FROM evimed_control.projects)::integer AS projects",
    );
    assert.deepEqual(rows.rows[0], { users: 2, sessions: 2, projects: 3 });
  } finally {
    await first?.app.close();
    await second?.app.close();
    await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
    await admin.end();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("expired sign-ins are purged oldest first in bounded batches, and a live one keeps working", {
  skip: databaseUrl ? false : "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  // Nothing deleted an expired row before (store.mjs `purgeExpiredSessions`):
  // production held 1,362 of them on 2026-09-27, the oldest from 2026-07-29.
  assertTestDatabase(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-session-purge-"));
  let app;
  try {
    app = await start(dataDir);
    const alice = await login(app.base, "alice", "correct horse battery staple");
    assert.equal(alice.response.status, 200);
    for (let day = 1; day <= 5; day += 1) {
      await admin.query(`INSERT INTO evimed_control.auth_sessions(id_hash, user_id, csrf_token, created_at, expires_at)
        VALUES ($1, 'alice', 'expired-csrf', now() - interval '40 days', now() - ($2::integer * interval '1 day'))`,
      [String(day).repeat(64), day]);
    }
    const expired = async () => (await admin.query(
      "SELECT id_hash FROM evimed_control.auth_sessions WHERE expires_at <= now() ORDER BY expires_at",
    )).rows.map((row) => row.id_hash[0]);
    assert.deepEqual(await expired(), ["5", "4", "3", "2", "1"]);

    assert.equal(await app.app.store.purgeExpiredSessions({ limit: 2 }), 2);
    assert.deepEqual(await expired(), ["3", "2", "1"], "the oldest go first");
    assert.equal(await app.app.store.purgeExpiredSessions({ limit: 10 }), 3);
    assert.equal(await app.app.store.purgeExpiredSessions({ limit: 10 }), 0);
    assert.equal(app.app.store.expiredSessionsPurged, 5);

    const me = await fetch(`${app.base}/api/me`, { headers: { Cookie: alice.cookie } });
    assert.equal(me.status, 200, "a live sign-in is never touched");
    const left = await admin.query("SELECT count(*)::integer AS count FROM evimed_control.auth_sessions");
    assert.equal(left.rows[0].count, 1);
  } finally {
    await app?.app.close();
    await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
    await admin.end();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("PostgreSQL bootstrap applies the character floor only when creating a new account", {
  skip: databaseUrl ? false : "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  assertTestDatabase(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-bootstrap-floor-"));
  const app = createWebApiApp({ dataDir, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "bootstrap-floor", bootstrapPassword: "short", stateStore: "postgres", databaseUrl });
  try {
    await assert.rejects(app.store.loadUsers(), { code: "weak_password" });
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM evimed_control.users")).rows[0].count, 0);
    app.store.config.bootstrapPassword = "abc123";
    await app.store.loadUsers();
    const before = await admin.query("SELECT password_hash FROM evimed_control.users WHERE id = 'bootstrap-floor'");
    assert.equal(before.rowCount, 1);
    app.store.config.bootstrapPassword = "old";
    await app.store.loadUsers();
    const after = await admin.query("SELECT password_hash FROM evimed_control.users WHERE id = 'bootstrap-floor'");
    assert.equal(after.rows[0].password_hash, before.rows[0].password_hash, "existing passwords are not reset");
  } finally {
    await app.close().catch(error => { if (error.code !== "ERR_SERVER_NOT_RUNNING") throw error; });
    await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
    await admin.end();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the configured bootstrap account is created even when other accounts already exist", {
  skip: databaseUrl ? false : "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  assertTestDatabase(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-bootstrap-seed-"));
  let app;
  try {
    // Seed an unrelated account first, the way an access grant for a
    // neighbouring service would. Gating bootstrap creation on an empty table
    // meant the configured administrator was then never created: the user, the
    // password file and the environment were all present, login returned
    // invalid_credentials, and nothing reported a problem.
    const seeding = await start(dataDir);
    await seeding.app.close();
    await admin.query(
      "INSERT INTO evimed_control.users(id, name, password_hash, auth_type) VALUES ($1, $2, $3, 'local') ON CONFLICT (id) DO NOTHING",
      ["other-service", "other-service", "not-a-real-hash"],
    );
    await admin.query("DELETE FROM evimed_control.users WHERE id = $1", ["alice"]);

    app = await start(dataDir);
    const alice = await login(app.base, "alice", "correct horse battery staple");
    assert.equal(alice.response.status, 200, "the configured bootstrap account must be able to log in");

    const rows = await admin.query("SELECT id FROM evimed_control.users ORDER BY id");
    assert.deepEqual(rows.rows.map((row) => row.id), ["alice", "other-service"]);
  } finally {
    await app?.app.close();
    await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
    await admin.end();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a deliberately deleted bootstrap account is not resurrected", {
  skip: databaseUrl ? false : "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  assertTestDatabase(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-bootstrap-deleted-"));
  let app;
  try {
    const seeding = await start(dataDir);
    await seeding.app.close();
    await admin.query("DELETE FROM evimed_control.users WHERE id = $1", ["alice"]);
    await admin.query("INSERT INTO evimed_control.deleted_users(id) VALUES ($1) ON CONFLICT (id) DO NOTHING", ["alice"]);

    app = await start(dataDir);
    const alice = await login(app.base, "alice", "correct horse battery staple");
    assert.equal(alice.response.status, 401, "creating-when-absent must not undo a deliberate deletion");
  } finally {
    await app?.app.close();
    await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
    await admin.end();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a stored English default is renamed once, and a rename and an archive are shared across instances", {
  skip: databaseUrl ? false : "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  assertTestDatabase(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-project-names-"));
  let first;
  let second;
  try {
    // A database from before version 2: the seeded row carries the English
    // name, and the migration record stops at version 1.
    const seeding = await start(dataDir);
    await seeding.app.close();
    await admin.query("UPDATE evimed_control.projects SET name = 'Default Project' WHERE id = 'default'");
    await admin.query("DELETE FROM evimed_control.schema_migrations WHERE version = 2");

    first = await start(dataDir);
    const alice = await login(first.base, "alice", "correct horse battery staple");
    const headers = { Cookie: alice.cookie, "X-Open-Science-CSRF": alice.csrf, "Content-Type": "application/json" };
    const listed = await (await fetch(`${first.base}/api/projects`, { headers })).json();
    assert.equal(listed.data.find((item) => item.id === "default").name, "我的研究");
    const created = await (await fetch(`${first.base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "二甲双胍与乳酸酸中毒" }) })).json();
    assert.match(created.data.id, /^p-[0-9a-f]{8}$/);
    const renamed = await fetch(`${first.base}/api/projects/${created.data.id}`, { method: "PATCH", headers, body: JSON.stringify({ name: "二甲双胍（肾功能不全）" }) });
    assert.equal(renamed.status, 200);
    const archived = await (await fetch(`${first.base}/api/projects/${created.data.id}/archive`, { method: "POST", headers, body: "{}" })).json();
    assert.ok(Date.parse(archived.data.archivedAt));
    // A researcher who then names the default "Default Project" keeps it.
    assert.equal((await fetch(`${first.base}/api/projects/default`, { method: "PATCH", headers, body: JSON.stringify({ name: "Default Project" }) })).status, 200);

    second = await start(dataDir);
    const again = await login(second.base, "alice", "correct horse battery staple");
    const fromSecond = await (await fetch(`${second.base}/api/projects`, { headers: { Cookie: again.cookie } })).json();
    const byId = new Map(fromSecond.data.map((item) => [item.id, item]));
    assert.equal(byId.get(created.data.id).name, "二甲双胍（肾功能不全）");
    assert.equal(byId.get(created.data.id).archivedAt, archived.data.archivedAt);
    assert.equal(byId.get("default").name, "Default Project", "renamed once, not on every start");
    const versions = await admin.query("SELECT version FROM evimed_control.schema_migrations ORDER BY version");
    // Every version up to the one this build writes last, each once: the
    // default rename is version 2, and later versions (3: the `evimed` and
    // `subject` account kinds) are recorded by the same start.
    assert.deepEqual(versions.rows.map((row) => row.version),
      Array.from({ length: CONTROL_PLANE_SCHEMA_VERSION }, (_, index) => index + 1));
  } finally {
    await first?.app.close();
    await second?.app.close();
    await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
    await admin.end();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an EviMed account keeps EviMed's own id on its row, filled in and replaced by sign-ins", {
  skip: databaseUrl ? false : "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  assertTestDatabase(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-postgres-evimed-id-"));
  const id = "evimed_0123456789abcdef0123456789abcdef01234567";
  let running;
  try {
    // A database from before version 4: the column is not there yet, and an
    // EviMed account already exists without it.
    const seeding = await start(dataDir);
    await seeding.app.store.upsertEvimedUser(id, "王医生");
    await seeding.app.close();
    await admin.query("ALTER TABLE evimed_control.users DROP CONSTRAINT users_evimed_user_id_check");
    await admin.query("ALTER TABLE evimed_control.users DROP COLUMN evimed_user_id");
    await admin.query("DELETE FROM evimed_control.schema_migrations WHERE version = 4");

    running = await start(dataDir);
    const store = running.app.store;
    assert.equal(await store.evimedUserIdOf(id), null, "an account from before the column has no EviMed id yet");
    await store.upsertEvimedUser(id, "王医生", "98211");
    assert.equal(await store.evimedUserIdOf(id), "98211");
    // An exchange that reports no id keeps the one on the row; a changed one
    // replaces it.
    await store.upsertEvimedUser(id, "王医生");
    assert.equal(await store.evimedUserIdOf(id), "98211");
    await store.upsertEvimedUser(id, "王医生", "98212");
    assert.equal(await store.evimedUserIdOf(id), "98212");
    // It never rides on the user object a request carries.
    assert.equal(JSON.stringify(await store.userById(id)).includes("98212"), false);
    // Only an EviMed account has one.
    assert.equal(await store.evimedUserIdOf("alice"), null);
    const versions = await admin.query("SELECT max(version)::integer AS version FROM evimed_control.schema_migrations");
    assert.equal(versions.rows[0].version, CONTROL_PLANE_SCHEMA_VERSION);
  } finally {
    await running?.app.close();
    await admin.query("DROP SCHEMA IF EXISTS evimed_control CASCADE");
    await admin.end();
    await rm(dataDir, { recursive: true, force: true });
  }
});
