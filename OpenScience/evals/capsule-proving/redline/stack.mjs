// The whole product control plane, in process, against the lab memory engine and a database of its own: the stack the
// deletion (G4) and isolation (G5) red-line runners drive.
//
// Unlike `run/lab.mjs`, which composes the memory pieces one by one, the red lines need the product's own routes and the
// composition root's own closures (account deletion, memory reset, conversation source deletion, account export, the
// capsule export preview, GEO shared-project namespaces). So this module builds the real app with `createWebApiApp`, the
// way the product's own integration tests do (`apps/server/test/helpers/nativeAppFixture.mjs`), with three differences:
//  - the engine is the real lab OpenViking (an `evlab-<runId>` account of its own), not the stub;
//  - the database is a dedicated one on the lab PostgreSQL (`evimed_redline` by default), because the app's own workers and
//    migrations act on every account of the database they are given and must never touch other lanes' rows;
//  - the app's recurring workers are stopped right after it starts listening, and the runner advances them itself (the
//    native memory worker's settle, the source-deletion drain), so a trial is deterministic and finishes when it says so.
//
// What stands in for parts a lab does not have (each is a recorded deviation):
//  - workload tokens: the runtime manager accepts tokens this module mints for (user, project), exactly the identity a running
//    kernel's token resolves to; a retired owner (an account being deleted) is refused as the product refuses it;
//  - a conversation is a research session and an agent run in the product's own ledgers (`researchSessions.put`,
//    `agentRuns.start`), its messages go through the product's memory gateway, the run is closed and the conversation is
//    committed at once through the attended-turn commit function (`nativeTurnCommit.commit`, the gateway's `commitSession`; the
//    product's debounced scheduler is switched off so a turn is committed exactly once); no kernel exists, so the kernel transcript's
//    capture and purge (`captureConversationSource` / `purgeConversationSource`) answer from this module's own record of the
//    conversation — the memory side of a conversation deletion is entirely the product's;
//  - the sign-in rate limit per address is lifted (every throwaway account signs in from loopback);
//  - the mock runtime has no kernel plugin service, so its `evimedPlugins/status` 404 is read as "not busy" (source cleanup asks it);
//  - the capsule index is `builtin` (no `openVikingEngine` readiness gate), consolidation is off, model gateway calls use a
//    30 s engine deadline where production gives 4 s.
//
// Keys and the database URL are read from files and never printed: every message that leaves goes through `redact`.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { GeoMembers } from "../../../apps/server/src/geoMembers.mjs";
import { GeoStore } from "../../../apps/server/src/geoStore.mjs";
import { MEMORY_GATEWAY_PATH } from "../../../apps/server/src/memoryGateway.mjs";
import { migrateMemorySettings } from "../../../apps/server/src/memorySettingsPersistence.mjs";
import { OPENVIKING_MEMORY_TYPES } from "../../../apps/server/src/openVikingLayout.mjs";
import { createWebApiApp } from "../../../apps/server/src/server.mjs";
import { createMemoryClient, firstLine, redact } from "../run/lab.mjs";

const requireServer = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} file */
async function secretFrom(file) {
  const value = (await readFile(file, "utf8")).trim();
  if (!value) throw new Error("a secret file is empty");
  return value;
}

/**
 * The URL of a sibling database on the same server, made when it does not exist yet. The name is held to a safe alphabet.
 * @param {string} databaseUrl @param {string} name
 */
export async function ensureDatabase(databaseUrl, name) {
  if (!/^evimed_[a-z0-9_]{1,40}$/.test(name)) throw new Error("a red-line database is named evimed_<a-z0-9_>");
  const target = new URL(databaseUrl);
  target.pathname = `/${name}`;
  const pg = requireServer("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
    if (!found.rows.length) {
      try { await client.query(`CREATE DATABASE ${name}`); }
      catch (error) { if (/** @type {any} */ (error)?.code !== "42P04") throw error; }
    }
  } finally { await client.end(); }
  return target.toString();
}

/** The workers a lab app must not run on their own (`pauseRecurringWork` in `server.mjs` clears the same timers). @param {any} app */
const RECURRING_WORKERS = ["nativeMemoryWorker", "sourceDeletion", "memoryIndexWorker", "learningWorker", "sourceWorker", "knowledgePagesWorker", "sourceSyncWorker", "kbIndex"];
export function stopRecurringWork(app) {
  const stopped = [];
  for (const name of RECURRING_WORKERS) {
    const worker = app[name];
    if (worker?.timer) { clearInterval(worker.timer); worker.timer = null; stopped.push(name); }
    if (worker?.reconcileTimer) { clearInterval(worker.reconcileTimer); worker.reconcileTimer = null; }
  }
  for (const worker of [app.geo?.worker, app.frontier?.worker, app.review?.worker]) {
    if (worker?.timer) { clearInterval(worker.timer); worker.timer = null; }
  }
  return stopped;
}

/**
 * @typedef {{ id: string, username: string, password: string, headers: Record<string, string>, label: string }} StackUser
 */

/**
 * Open the product against the lab engine.
 * @param {{ engineUrl: string, engineKeyFile: string, databaseUrlFile: string, databaseName?: string, account: string,
 *   deepseekKeyFile?: string | null, dataDir: string, configOverrides?: Record<string, any>, report?: (line: string) => void }} options
 */
export async function openStack({ engineUrl, engineKeyFile, databaseUrlFile, databaseName = "evimed_redline", account, deepseekKeyFile = null, dataDir,
  configOverrides = {}, report = (line) => process.stderr.write(`${line}\n`) }) {
  if (!/^evlab-[A-Za-z0-9_-]{1,100}$/.test(account)) throw new Error("the lab engine account is evlab-<runId>");
  const engineKey = await secretFrom(engineKeyFile);
  const mainUrl = await secretFrom(databaseUrlFile);
  const deepseekKey = deepseekKeyFile ? await secretFrom(deepseekKeyFile) : "";
  let password = "";
  try { password = decodeURIComponent(new URL(mainUrl).password); } catch { /* redacted whole */ }
  const secrets = [engineKey, mainUrl, deepseekKey, password];
  /** @type {Set<string>} */
  const bearers = new Set();
  const scrub = (/** @type {unknown} */ text) => redact(text, [...secrets, ...bearers]);
  const errorLine = (/** @type {unknown} */ error) => firstLine(error, [...secrets, ...bearers]);
  const say = (/** @type {string} */ line) => report(scrub(line).split("\n")[0]);

  const databaseUrl = await ensureDatabase(mainUrl, databaseName);
  secrets.push(databaseUrl);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let app;
  try {
    app = createWebApiApp({
      dataDir, port: 0, host: "127.0.0.1", runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
      stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
      openVikingUrl: engineUrl, openVikingApiKey: engineKey, openVikingAccount: account, openVikingRequestTimeoutMs: 60_000,
      memoryEngineEnabled: true, memoryIndexProvider: "builtin", memoryHistorySearchEnabled: true,
      memoryGatewayTimeoutMs: 30_000, memoryGatewayCommitsPerHour: 0,
      nativeMemoryConsolidationEnabled: false, learningEnabled: false,
      // The attended-turn commit is called by the runner the moment a turn ends (`converse`), through the same function the product's
      // `NativeTurnCommit` calls after its 8 s debounce; the debounced second commit of the same turn would race a deletion.
      nativeMemoryTurnCommitEnabled: false,
      ...(deepseekKey ? { deepseekApiKey: deepseekKey } : { nativeMemoryRejectionJudgeEnabled: false }),
      geoEnabled: true, geoAudience: "all",
      // Thousands of throwaway accounts sign in from one loopback address; production's 20 per 5 minutes per address would refuse them.
      authRateLimitMaxRequests: 1_000_000,
      ...configOverrides,
    });
  } catch (error) {
    throw new Error(`the product app could not be built: ${errorLine(error)}`);
  }
  const database = app.store.database;
  await migrateMemorySettings(database);
  // Never started at all (their first pass at start would scan every account of the database, including another shard's accounts
  // that live on another engine); the timers are cleared again after start as a second guard.
  for (const name of RECURRING_WORKERS) if (app[name] && typeof app[name].start === "function") app[name].start = () => {};
  const address = await app.listen(0, "127.0.0.1");
  const stopped = stopRecurringWork(app);
  const base = `http://127.0.0.1:${address.port}`;
  const gatewayBase = `${base}${MEMORY_GATEWAY_PATH}`;
  const sessions = app.nativeMemory.sessions;
  const overlay = app.nativeMemory.overlay;
  const client = app.openVikingClient;
  await app.sourceDeletion?.ledger.migrate();

  // The run's own engine account; the engine wants an admin user for a new account (a placeholder that never holds memory).
  try { await client.request({ method: "POST", path: "/api/v1/admin/accounts", body: { account_id: account, admin_user_id: "evlab-admin" } }); }
  catch (error) { if (Number(/** @type {any} */ (error)?.upstreamStatus) !== 409) throw new Error(`the engine account could not be made: ${errorLine(error)}`); }

  // ---------------------------------------------------------------- workload identities (what a kernel's token resolves to)
  /** @type {Map<string, { userId: string, projectId: string }>} */
  const identities = new Map();
  /** @type {Map<string, string>} */
  const tokens = new Map();
  const tokenFor = (/** @type {string} */ userId, /** @type {string} */ projectId) => {
    const key = `${userId}\u0000${projectId}`;
    let token = tokens.get(key);
    if (!token) {
      token = `rl-${randomBytes(24).toString("hex")}`;
      tokens.set(key, token); identities.set(token, { userId, projectId }); bearers.add(token);
    }
    return token;
  };
  const originalAssert = app.runtimeManager.assertActiveEviMedWorkloadToken.bind(app.runtimeManager);
  app.runtimeManager.assertActiveEviMedWorkloadToken = async (/** @type {string | undefined} */ token) => {
    const identity = typeof token === "string" ? identities.get(token) : undefined;
    if (!identity) return originalAssert(token);
    // An account whose deletion has begun is served no more (`RuntimeManager.retireOwner`).
    if (app.runtimeManager.retiredOwners?.has(String(identity.userId))) throw Object.assign(new Error("retired owner"), { code: "workload_token_invalid", status: 401 });
    return identity;
  };

  // --------------------------------------------------------------- the kernel transcript a conversation deletion captures
  /** userId\0projectId\0sessionId → the conversation's record. @type {Map<string, { createdAt: number, purged: boolean }>} */
  const conversations = new Map();
  const conversationKey = (/** @type {any} */ project, /** @type {string} */ sessionId) => `${project.userId}\u0000${project.id}\u0000${sessionId}`;
  app.runtimeManager.captureConversationSource = async (/** @type {any} */ project, /** @type {string} */ sessionId) => {
    const held = conversations.get(conversationKey(project, sessionId));
    if (!held) return { root: null, sessions: [] };
    const root = { id: sessionId, createdAt: held.createdAt, cwd: "/workspace", isSeeded: false };
    return { root, sessions: [root], generation: "redline-lab" };
  };
  app.runtimeManager.purgeConversationSource = async (/** @type {any} */ project, /** @type {any} */ frozen) => {
    const id = frozen?.root?.id;
    const held = id ? conversations.get(conversationKey(project, id)) : null;
    if (held) held.purged = true;
    return { sourceRemoved: true, removedSessionIds: id ? [id] : [] };
  };

  // The mock runtime a conversation's run starts has no kernel plugin service: its `evimedPlugins/status` answers 404, which the
  // product reads as "no activity proof" and the source cleanup then waits for ever. A lab kernel runs no plugin, so that one
  // answer is read as not busy; every other answer (a start or stop in flight, a bounded scope) is the product's own.
  const originalPluginBusy = app.runtimeManager.pluginRuntimeBusy.bind(app.runtimeManager);
  app.runtimeManager.pluginRuntimeBusy = async (/** @type {any} */ project, /** @type {any} */ options) => {
    try { return await originalPluginBusy(project, options); }
    catch (error) { if (/** @type {any} */ (error)?.code === "runtime_wire_protocol_mismatch") return false; throw error; }
  };

  // The source-deletion worker records only a closed reason (`account_memory_busy`, …); the runner keeps the first line of what the
  // product's own cleanup step threw, per account, so a cleanup that never finishes says why. The steps themselves are unchanged.
  /** @type {Map<string, string>} */
  const cleanupErrors = new Map();
  for (const step of ["removeHistory", "removeDerived"]) {
    const original = app.sourceDeletion?.[step];
    if (typeof original !== "function") continue;
    app.sourceDeletion[step] = async (/** @type {any} */ project, /** @type {any} */ row) => {
      try { return await original(project, row); }
      catch (error) { cleanupErrors.set(String(project?.userId), `${step}: ${errorLine(error)}`); throw error; }
    };
  }

  const geoStore = new GeoStore({ database });
  await geoStore.ready();
  const geoMembers = new GeoMembers({ store: geoStore });

  /** A JSON call of the app's own HTTP surface as a signed-in person. @param {StackUser} user @param {string} method @param {string} path @param {unknown} [body] */
  async function http(user, method, path, body = undefined, { raw = false, timeoutMs = 180_000 } = {}) {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(timeoutMs), headers: user.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (raw) return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "" };
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  }

  /** A gateway REST call of the plugin's own kind; a refusal is returned, not thrown. @param {string} token @param {string} method @param {string} path @param {unknown} [body] */
  async function gateway(token, method, path, body = undefined) {
    const response = await fetch(`${gatewayBase}${path}`, { method, signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok && json?.status !== "error", json, code: json?.error?.code ?? null };
  }

  /** The engine user of an account is registered and holds the deployment's type allowlist (the worker's `#syncPolicy`). @param {string} userId */
  async function registerEngineUser(userId) {
    await sessions.register(userId);
    await overlay.noteRegistered(userId);
    const held = await sessions.settings(userId);
    const expected = [...OPENVIKING_MEMORY_TYPES].sort();
    if (held && !(held.memoryTypes.length === expected.length && held.memoryTypes.every((type, index) => type === expected[index]))) {
      await sessions.setLearning(userId, true);
    }
  }

  const stack = {
    app, base, gatewayBase, sessions, overlay, client, database, account, geoStore, geoMembers, stopped,
    redact: scrub, errorLine, say,

    /**
     * A new account signed in through the product's local login, its engine user registered.
     * @param {string} label @returns {Promise<StackUser>}
     */
    async newUser(label) {
      const username = `rl${randomUUID().replaceAll("-", "").slice(0, 14)}`;
      const userPassword = `rl-${randomBytes(18).toString("base64url")}`;
      bearers.add(userPassword);
      const user = await app.store.createUser(username, userPassword, `redline ${String(label).slice(0, 40)}`);
      const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: userPassword }) });
      const auth = await login.json().catch(() => null);
      const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
      if (!login.ok || !cookie || !auth?.data?.csrfToken) throw new Error(`login failed (HTTP ${login.status})`);
      bearers.add(cookie.split("=").slice(1).join("="));
      const headers = { "content-type": "application/json", cookie, "x-open-science-csrf": String(auth.data.csrfToken) };
      await registerEngineUser(String(user.id));
      return { id: String(user.id), username, password: userPassword, headers, label: String(label) };
    },

    /** @param {StackUser} user @param {string} projectId @param {string} name */
    async createProject(user, projectId, name = projectId) {
      const owner = await app.store.userById(user.id);
      return app.store.createProject(owner, projectId, name);
    },

    /** @param {string} userId @param {string} projectId */
    async project(userId, projectId) {
      const owner = await app.store.userById(userId);
      if (!owner) return null;
      return app.store.requireProject(owner, projectId);
    },

    http,
    gateway,
    tokenFor,

    /** The model-facing tools over one workload (writes allowed: the runner is the model). @param {string} userId @param {string} projectId */
    memory(userId, projectId) {
      return createMemoryClient({ base: gatewayBase, token: tokenFor(userId, projectId), readOnly: false, timeoutMs: 120_000 });
    },

    /**
     * One attended conversation as the product learns it: the conversation and its run in the product's ledgers, the messages
     * through the memory gateway's door, the run closed, the attended-turn commit. A second call with the same session id is a
     * later turn of the same conversation.
     * @param {StackUser} user @param {string} projectId @param {string} sessionId @param {{ role: "user" | "assistant", text: string }[]} messages
     */
    async converse(user, projectId, sessionId, messages) {
      const owner = await app.store.userById(user.id);
      const project = await app.store.requireProject(owner, projectId);
      const existing = await app.researchSessions.get(project, sessionId).catch(() => null);
      if (!existing) await app.researchSessions.put(project, sessionId, { mode: "open-domain" });
      const key = conversationKey(project, sessionId);
      if (!conversations.has(key)) conversations.set(key, { createdAt: Date.now(), purged: false });
      await app.agentRuns.start(project, { sessionId });
      const token = tokenFor(user.id, projectId);
      const engineSession = `dsh-${sessionId}`;
      const writes = [];
      try {
        const created = await gateway(token, "POST", "/api/v1/sessions", { session_id: engineSession });
        writes.push(created.ok ? "created" : `create:${created.code ?? created.status}`);
        for (const message of messages) {
          const body = { role: message.role, parts: [{ type: "text", text: message.text }], created_at: new Date().toISOString() };
          const written = await gateway(token, "POST", `/api/v1/sessions/${engineSession}/messages`, body);
          writes.push(written.ok ? "ok" : `refused:${written.code ?? written.status}`);
        }
      } finally {
        await app.agentRuns.closeProject(project);
        // The turn is over and the runtime it woke is let go, as an idle one is: a lab account never keeps a runtime slot.
        await app.runtimeManager.stop(project, { by: "user" }).catch(() => {});
      }
      const answer = await app.nativeTurnCommit.commit({ user: owner, project, engineSessionId: engineSession });
      const result = answer?.json?.result ?? {};
      return { engineSession, writes, commit: String(answer?.commit ?? answer?.outcome ?? "none"),
        taskId: typeof result.task_id === "string" ? result.task_id : null, archiveUri: typeof result.archive_uri === "string" ? result.archive_uri : null };
    },

    /** Whether the product still holds this lab conversation's transcript (false once a deletion purged it). */
    conversationHeld(/** @type {any} */ project, /** @type {string} */ sessionId) {
      const held = conversations.get(conversationKey(project, sessionId));
      return Boolean(held && !held.purged);
    },

    /**
     * The worker settles what the ledger is owed for this account (extractions, promoted choices, replays, reset tombstones),
     * advanced here in rounds until nothing is open or the deadline passes.
     * @param {string} userId @param {{ timeoutMs?: number, pollMs?: number }} [options]
     */
    async settle(userId, { timeoutMs = 300_000, pollMs = 2_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let rounds = 0, settled = 0, open = [];
      for (;;) {
        rounds += 1;
        settled += Number(await app.nativeMemoryWorker.processCommits({ userId, limit: 50 })) || 0;
        open = await overlay.openCommits({ userId, limit: 50 });
        if (!open.length || Date.now() >= deadline) break;
        await sleep(pollMs);
      }
      await app.memoryHistory?.drainDeletes(userId).catch(() => {});
      return { rounds, settled, open: open.length, openStates: [...new Set(open.map((/** @type {any} */ commit) => String(commit.state)))] };
    },

    /** The source-deletion worker's drain, run until this account's deletions are complete or the deadline passes. @param {string} userId */
    async drainSourceDeletion(userId, { timeoutMs = 240_000, pollMs = 2_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let rows = [];
      for (;;) {
        // This account's own retained intents only (the fixture's rule): another trial's deletion is not ours to drain. The
        // backoff a failed attempt sets is not waited out: the runner asks again on its own cadence.
        await drainExclusive(async () => {
          app.sourceDeletion.ledger.pending = async () => {
            const due = await database.query(`SELECT id FROM evimed_source_deletion.conversations WHERE user_id=$1 AND cleanup='pending' ORDER BY updated_at LIMIT 30`, [userId]);
            const own = new Map((await app.sourceDeletion.ledger.recordsForOwner(userId, { pendingOnly: true })).map((/** @type {any} */ row) => [row.id, row]));
            return due.rows.map((/** @type {any} */ row) => own.get(row.id)).filter(Boolean);
          };
          await app.sourceDeletion.drainOnce();
        });
        rows = (await database.query("SELECT cleanup, reason FROM evimed_source_deletion.conversations WHERE user_id=$1", [userId])).rows;
        if (!rows.some((/** @type {any} */ row) => row.cleanup === "pending") || Date.now() >= deadline) break;
        await sleep(pollMs);
      }
      const thrown = cleanupErrors.get(userId) ?? null;
      return rows.map((/** @type {any} */ row) => ({ cleanup: String(row.cleanup), reason: row.reason ?? null, ...(row.cleanup === "pending" && thrown ? { thrown } : {}) }));
    },

    /** Engine users listed under the run's account (admin listing; never a call as the user, which could register it again). */
    async engineUsers() {
      const listed = await client.request({ path: `/api/v1/admin/accounts/${account}/users` });
      const rows = Array.isArray(listed?.result) ? listed.result : Array.isArray(listed?.result?.users) ? listed.result.users : [];
      return new Set(rows.map((/** @type {any} */ row) => String(row?.user_id ?? row?.id ?? row)));
    },

    /** Delete the run's engine account (a smoke run's throwaway): asked until the listing no longer has it. */
    async eraseEngineAccount() {
      let state = "pending";
      for (let attempt = 0; attempt < 4 && state === "pending"; attempt += 1) {
        try { await client.request({ method: "DELETE", path: `/api/v1/admin/accounts/${account}` }); }
        catch (error) {
          const status = Number(/** @type {any} */ (error)?.upstreamStatus);
          if (status === 404) { state = attempt ? "deleted" : "absent"; break; }
          if (status !== 409 && status !== 412) { state = `failed: ${errorLine(error)}`; break; }
        }
        for (let poll = 0; poll < 30; poll += 1) {
          await sleep(1_000);
          const body = await client.request({ path: "/api/v1/admin/accounts" }).catch(() => null);
          const entry = body ? (Array.isArray(body?.result) ? body.result : []).find((/** @type {any} */ row) => row?.account_id === account) ?? null : undefined;
          if (entry === null) { state = "deleted"; break; }
          if (entry && entry.status !== "deleting") break;
        }
      }
      return state;
    },

    async close() {
      await app.close();
    },
  };

  /** The service's drain is single-flight per process; trials of one process take turns. */
  let drainChain = Promise.resolve();
  function drainExclusive(/** @type {() => Promise<unknown>} */ run) {
    const next = drainChain.catch(() => {}).then(run);
    drainChain = next.then(() => {}, () => {});
    return next;
  }

  say(`redline stack up: engine ${health(engineUrl)}, workers stopped: ${stopped.join(",") || "none"}`);
  return stack;
}

/** @param {string} url */
function health(url) { try { return new URL(url).port; } catch { return "?"; } }
