// The composition root, tested as a composition root.
//
// Two features shipped fully built and fully unit-tested and were dark in every
// real deployment, because nothing introduced them to the rest of the system:
// `runtimeManager.capsuleService` was assigned only inside a unit test, so every
// container launched with an empty methods directory; and the usage-reservation
// sweep's only coverage was an integration test that skips without PostgreSQL,
// so a regression that dropped its timer, forgot to re-arm it after a
// maintenance pause, or left it cleared after `close()` would have shipped
// green.
//
// What makes this file possible offline is that `createWebApiApp` already takes
// an injected `databasePool`: with a fake pool the composition root builds its
// real `CapsuleService`, `UsageLedger`, `NotificationService`, `AutopilotService`
// and `MaintenanceService` over a real `ControlPlaneDatabase`, and `listen()`
// runs the real startup sequence. No production path is conditional on being
// under test.
//
// Timers are observed by recording `setInterval`/`clearInterval` for the
// lifetime of one app. A recorded interval keeps its real callback and its real
// delay -- the recorder only remembers it -- so "which sweep does this timer
// drive" is answered by invoking the callback and watching the SQL the sweep
// issues, not by trusting a name.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { splitEpisodeBudget, verificationIdFor, verificationWorkspacePath } from "../src/autopilotService.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { DISTILL_TRIGGER, FeedbackEvents, deliverableSubjectId } from "../src/feedbackEvents.mjs";
import { DISTILLATION_TRIGGERS, buildDistillationInput } from "../src/methodDistillationRuns.mjs";
import { memoryNamespace } from "../src/memosClient.mjs";
import { buildRuntimeLaunchPlan } from "../src/runtimeManager.mjs";
import { createWebApiApp } from "../src/server.mjs";

/** One-line form of a statement, so a signature can be matched across the
 *  indentation the sources are written with. */
const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();

/**
 * The four pieces of recurring work `startRecurringWork` arms, each named by
 * something only that piece of work does.
 *
 * Three are identified by the statement they send to the database, which is the
 * strongest evidence available offline: the sweep did not merely get called, it
 * reached its table. Capsule cleanup has no SQL of its own -- it walks the
 * identity store on disk -- so it is identified by a pass-through spy on the one
 * method the composition root calls.
 */
const RECURRING_SWEEPS = [
  {
    key: "capsuleCleanup",
    name: "capsule pending-deletion cleanup",
    intervalMs: 30_000,
    // `listen()` runs it once directly and once through `startRecurringWork`.
    startupRuns: 2,
  },
  {
    key: "autopilotSchedule",
    name: "autopilot agenda scheduling",
    intervalMs: 60_000,
    startupRuns: 1,
    statement: /SELECT user_id,id,payload FROM evimed_product\.documents WHERE kind='agenda'/,
  },
  {
    key: "notificationDefaults",
    name: "inbox default resolution",
    intervalMs: 30_000,
    startupRuns: 1,
    statement: /FROM evimed_inbox\.notifications WHERE resolved_at IS NULL AND default_action IS NOT NULL/,
  },
  {
    key: "usageReconcile",
    name: "usage-reservation reconciliation",
    intervalMs: 60_000,
    startupRuns: 1,
    statement: /SELECT user_id,id FROM evimed_usage\.model_requests WHERE status='reserved'/,
  },
];

const USER_ID = "composition-user";
const PROJECT_ID = "composition-project";

/** A row as `evimed_product.documents` stores one. */
function documentRow(kind, id, payload) {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    user_id: USER_ID, kind, id, project_id: null, payload,
    revision: 1, created_at: at, updated_at: at, deleted_at: null,
  };
}

/**
 * A capsule holding one approved work-style method and one imported candidate.
 *
 * The candidate is the discriminator: `materializeCapsuleMethods` must mount the
 * approved entry and refuse the candidate, so a directory containing both would
 * mean the runtime read the capsule through something other than the real
 * service.
 */
function capsuleFixtureRows() {
  return [
    documentRow("preferences", `active-capsules:project:${PROJECT_ID}`, { items: [{ capsuleId: "capsule-a", mode: "own" }] }),
    documentRow("capsule", "capsule-a", { title: "Work style", description: "", activationMode: "own", imported: false }),
    documentRow("fact", "approved-method", {
      capsuleId: "capsule-a", factKind: "method_preference", layer: "methods",
      status: "approved", origin: "explicit", content: "Report every effect estimate with its confidence interval.",
    }),
    documentRow("fact", "imported-candidate", {
      capsuleId: "capsule-a", factKind: "method_preference", layer: "methods",
      status: "candidate", origin: "system", content: "A stranger's method nobody approved.",
    }),
  ];
}

/**
 * A `pg.Pool` that answers the statements this test's assertions depend on and
 * `{ rows: [] }` for everything else.
 *
 * It holds the maintenance lease for real, because that is how the pause and
 * resume under test are triggered in production: `MaintenanceService.request`
 * and `.release` publish the state change that `server.mjs` subscribed to. A
 * test that called the private `updateCache` instead would prove less.
 */
class FakePool extends EventEmitter {
  constructor(documents) {
    super();
    /** @type {Map<string, any>} */
    this.documents = new Map(documents.map((row) => [`${row.kind}:${row.id}`, row]));
    /** @type {Map<string, any>} Rows of `evimed_product.feedback_events`. */
    this.feedback = new Map();
    /** @type {Map<string, any>} Rows of `evimed_product.jobs`, distillation only. */
    this.jobs = new Map();
    /** @type {Map<string, any>} Rows of `evimed_inbox.notifications`. */
    this.inbox = new Map();
    /** @type {string[]} Every statement, in order, one line each. */
    this.statements = [];
    /** @type {{ sql: string, values: any[] }[]} The same statements with their bound parameters. */
    this.calls = [];
    /** @type {any} */
    this.lease = null;
    /** CNY already settled in the rolling window, as the admission check reads it. */
    this.daySpendCny = 0;
  }

  count(pattern) {
    return this.statements.filter((statement) => pattern.test(statement)).length;
  }

  answer(text, values) {
    const sql = oneLine(text);
    this.statements.push(sql);
    this.calls.push({ sql, values: Array.isArray(values) ? values : [] });
    if (/^SELECT \* FROM evimed_product\.documents WHERE user_id=\$1 AND kind=\$2 AND id=\$3/.test(sql)) {
      const row = this.documents.get(`${values[1]}:${values[2]}`);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^SELECT \* FROM evimed_product\.documents WHERE user_id=\$1 AND kind=\$2 AND \(deleted_at/.test(sql)) {
      const rows = [...this.documents.values()].filter((row) => row.kind === values[1]);
      return { rows, rowCount: rows.length };
    }
    // Everything below is what the feedback loop needs and nothing else needs:
    // each branch is gated on the one kind it serves, so no statement any other
    // test depends on changes its answer.
    if (/^INSERT INTO evimed_product\.documents\(user_id,kind,id,payload,project_id\)/.test(sql) && values[1] === "method") {
      const key = `${values[1]}:${values[2]}`;
      if (this.documents.has(key)) return { rows: [], rowCount: 0 };
      const row = { ...documentRow(values[1], values[2], JSON.parse(values[3])), project_id: values[4] ?? null };
      this.documents.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (/^INSERT INTO evimed_product\.feedback_events/.test(sql)) {
      if (this.feedback.has(values[0])) return { rows: [], rowCount: 0 };
      const row = {
        id: values[0], user_id: values[1], project_id: values[2], run_id: values[3], trigger_kind: values[4],
        subject_type: values[5], subject_id: values[6], detail: JSON.parse(values[7]),
        occurred_at: values[8], recorded_at: new Date().toISOString(),
      };
      this.feedback.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (/^SELECT \* FROM evimed_product\.feedback_events WHERE user_id=\$1 AND id=\$2/.test(sql)) {
      const row = this.feedback.get(values[1]);
      const owned = row && row.user_id === values[0] ? [row] : [];
      return { rows: owned, rowCount: owned.length };
    }
    // The read-back after a conflicting insert, which is how an event recorded
    // twice is recognized as one rather than refused.
    if (/^SELECT \* FROM evimed_product\.feedback_events WHERE id=\$1 AND user_id=\$2/.test(sql)) {
      const row = this.feedback.get(values[0]);
      const owned = row && row.user_id === values[1] ? [row] : [];
      return { rows: owned, rowCount: owned.length };
    }
    // The inbox, for the same reason: a notice that is composed but never
    // reaches a row is exactly the failure this file exists for. The identity
    // rule is the service's own -- the row id is derived from the idempotency
    // key, and `create` compares the content before it hands the prior row back
    // -- so a key that disagrees with its content is a 409 here too.
    if (/^SELECT \* FROM evimed_inbox\.notifications WHERE id=\$1 FOR UPDATE/.test(sql)) {
      const row = this.inbox.get(values[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^INSERT INTO evimed_inbox\.notifications/.test(sql)) {
      if (this.inbox.has(values[0])) return { rows: [], rowCount: 0 };
      const row = {
        id: values[0], user_id: values[1], project_id: values[2], notice_type: values[3], priority: values[4],
        title: values[5], body: values[6], actions: JSON.parse(values[7]), source: JSON.parse(values[8]),
        group_key: values[9], due_at: values[10], default_action: values[11], event_count: 1,
        read_at: null, resolved_at: null, resolution: null, channels_sent: { "in-app": values[12] },
        revision: 1, created_at: values[12], updated_at: values[12],
      };
      this.inbox.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (/^SELECT \* FROM evimed_inbox\.notifications WHERE user_id=\$1 AND id=\$2/.test(sql)) {
      const row = this.inbox.get(values[1]);
      const owned = row && row.user_id === values[0] ? [row] : [];
      return { rows: owned, rowCount: owned.length };
    }
    if (/^INSERT INTO evimed_product\.jobs\(id,user_id,kind,payload/.test(sql) && values[2] === "distill") {
      const existing = [...this.jobs.values()].find((row) => row.user_id === values[1] && row.idempotency_key === values[4]);
      if (existing) return { rows: [existing], rowCount: 1 };
      const row = {
        id: values[0], user_id: values[1], kind: values[2], payload: JSON.parse(values[3]),
        idempotency_key: values[4], project_id: values[5], status: "queued", attempts: 0, max_attempts: values[6],
        lease_token: null, lease_expires_at: null, run_after: new Date(), created_at: new Date(), finished_at: null,
      };
      this.jobs.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (/^WITH queued AS MATERIALIZED/.test(sql) && Array.isArray(values[0]) && values[0].join() === "distill") {
      const row = [...this.jobs.values()].find((item) => item.status === "queued");
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, { status: "running", worker_id: values[1], lease_token: values[2], lease_expires_at: new Date(Date.now() + 60_000) });
      return { rows: [row], rowCount: 1 };
    }
    if (/^SELECT id FROM evimed_product\.jobs WHERE user_id=\$1 AND id=\$2/.test(sql)) {
      const row = this.jobs.get(values[1]);
      const held = row && row.user_id === values[0]
        && (values.length < 3 || (row.lease_token === values[2] && row.status === "running")) ? [row] : [];
      return { rows: held, rowCount: held.length };
    }
    if (/^UPDATE evimed_product\.jobs SET status='succeeded'/.test(sql)) {
      const row = this.jobs.get(values[1]);
      if (!row || row.lease_token !== values[2]) return { rows: [], rowCount: 0 };
      Object.assign(row, { status: "succeeded", result: JSON.parse(values[3]), lease_token: null, finished_at: new Date() });
      return { rows: [row], rowCount: 1 };
    }
    // One optimistic update, applied for real, so a fold that writes a claim
    // back can be read back.
    if (/^UPDATE evimed_product\.documents SET payload=\$4::jsonb/.test(sql)) {
      const key = `${values[1]}:${values[2]}`;
      const row = this.documents.get(key);
      if (!row || row.revision !== values[4]) return { rows: [], rowCount: 0 };
      const updated = { ...row, payload: JSON.parse(values[3]), revision: row.revision + 1 };
      this.documents.set(key, updated);
      return { rows: [updated], rowCount: 1 };
    }
    if (/AS day_settled,/.test(sql)) {
      return { rows: [{ day_settled: this.daySpendCny, week_settled: this.daySpendCny, day_open: 0, week_open: 0 }], rowCount: 1 };
    }
    // Any session cookie is this account's session, and one CSRF token opens
    // it. The fixture is not testing authentication; it is testing what an
    // authenticated request reaches — and a mutating request has to pass the
    // real CSRF guard to get there, which is why this pair is answered rather
    // than the guard bypassed.
    if (/^SELECT csrf_token FROM evimed_control\.auth_sessions/.test(sql)) {
      return { rows: [{ csrf_token: "composition-csrf" }], rowCount: 1 };
    }
    if (/^SELECT s\.user_id, s\.csrf_token/.test(sql)) {
      const now = Date.now();
      return { rows: [{
        user_id: USER_ID, csrf_token: "composition-csrf", created_at: new Date(now), expires_at: new Date(now + 3_600_000),
        id: USER_ID, name: "Composed", password_hash: "", auth_type: "local", account_created_at: "2026-01-01 00:00:00+00",
      }], rowCount: 1 };
    }
    if (/^SELECT id, name, password_hash, auth_type FROM evimed_control\.users WHERE id = \$1/.test(sql)) {
      return values[0] === USER_ID
        ? { rows: [{ id: USER_ID, name: "Composed", password_hash: "", auth_type: "local" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/^SELECT 1 FROM evimed_control\.projects WHERE user_id = \$1 AND id = \$2 FOR UPDATE/.test(sql)) {
      return values[0] === USER_ID && values[1] === PROJECT_ID ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/^SELECT id, name, active_workspace, quota_bytes FROM evimed_control\.projects/.test(sql)) {
      return values[0] === USER_ID && values[1] === PROJECT_ID
        ? { rows: [{ id: PROJECT_ID, name: "Composed project", active_workspace: "", quota_bytes: 1_000_000_000 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/^SELECT request_id,requested_at,expires_at FROM evimed_product\.maintenance_lease/.test(sql)) {
      const held = this.heldLease();
      return { rows: held ? [held] : [], rowCount: held ? 1 : 0 };
    }
    if (/^INSERT INTO evimed_product\.maintenance_lease/.test(sql)) {
      const held = this.heldLease();
      if (held && held.request_id !== values[0]) return { rows: [], rowCount: 0 };
      const requestedAt = new Date();
      this.lease = {
        request_id: values[0],
        requested_at: requestedAt,
        expires_at: new Date(requestedAt.getTime() + Number(values[1]) * 1000),
      };
      return { rows: [this.lease], rowCount: 1 };
    }
    if (/^DELETE FROM evimed_product\.maintenance_lease WHERE singleton=true AND request_id=\$1/.test(sql)) {
      const held = this.heldLease();
      if (!held || held.request_id !== values[0]) return { rows: [], rowCount: 0 };
      this.lease = null;
      return { rows: [held], rowCount: 1 };
    }
    if (/^DELETE FROM evimed_product\.maintenance_lease WHERE singleton=true AND expires_at<=/.test(sql)) {
      if (!this.heldLease()) this.lease = null;
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  heldLease() {
    if (!this.lease) return null;
    return this.lease.expires_at.getTime() > Date.now() ? this.lease : null;
  }

  async connect() {
    const pool = this;
    return {
      on() {},
      off() {},
      removeListener() {},
      async query(text, values) { return pool.answer(text, values); },
      release() {},
    };
  }

  async query(text, values) { return this.answer(text, values); }

  async end() {}
}

/**
 * Record every interval the app arms and every one it clears.
 *
 * The recorded handle is a real interval carrying the real callback at the real
 * delay -- nothing is substituted -- so the delay this reports is the cadence
 * production runs at, and firing the callback runs the production sweep.
 * @param {{ handle: any, callback: any, delay: any, cleared: boolean }[]} armed
 */
function recordIntervals(armed) {
  const setIntervalImpl = globalThis.setInterval;
  const clearIntervalImpl = globalThis.clearInterval;
  globalThis.setInterval = (callback, delay, ...args) => {
    const handle = setIntervalImpl(callback, delay, ...args);
    armed.push({ handle, callback, delay, cleared: false });
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    for (const entry of armed) if (entry.handle === handle) entry.cleared = true;
    return clearIntervalImpl(handle);
  };
  return () => {
    globalThis.setInterval = setIntervalImpl;
    globalThis.clearInterval = clearIntervalImpl;
  };
}

const live = (armed) => armed.filter((entry) => !entry.cleared);

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The real app, its real startup sequence run, over a fake pool.
 * @param {import("node:test").TestContext} t
 */
async function composedApp(t, overrides = {}) {
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "evimed-composition-")));
  const pool = new FakePool(capsuleFixtureRows());

  // Capsule cleanup issues no statement of its own; this is the one call the
  // composition root makes, wrapped rather than replaced so the real cleanup
  // still runs.
  const cleanup = CapsuleTransferService.prototype.recoverPendingDeletions;
  let capsuleCleanupRuns = 0;
  CapsuleTransferService.prototype.recoverPendingDeletions = function recoverPendingDeletions(...args) {
    capsuleCleanupRuns += 1;
    return cleanup.apply(this, args);
  };

  /** @type {{ handle: any, callback: any, delay: any, cleared: boolean }[]} */
  const armed = [];
  const restoreIntervals = recordIntervals(armed);

  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl: "postgres://composition@127.0.0.1:5432/evimed_test",
    databasePool: pool,
    evimedWorkloadSigningSecret: randomBytes(32).toString("hex"),
    memOsEngineUrl: "", requireMemoryIndex: false,
    ...overrides,
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  t.after(async () => {
    try { await close(); } catch { /* a failed listen leaves nothing to close */ }
    restoreIntervals();
    CapsuleTransferService.prototype.recoverPendingDeletions = cleanup;
    await rm(dataDir, { recursive: true, force: true });
  });

  await app.listen(0, "127.0.0.1");

  const evidence = () => {
    /** @type {Record<string, number>} */
    const counts = { capsuleCleanup: capsuleCleanupRuns };
    for (const sweep of RECURRING_SWEEPS) {
      if (sweep.statement) counts[sweep.key] = pool.count(sweep.statement);
    }
    return counts;
  };

  /**
   * Fire one recorded interval and report which sweeps it drove.
   *
   * An interval that drives none of them -- a durable worker's own poll -- pays
   * the full wait and returns an empty list, which is what makes "no armed
   * interval drives this sweep" a real verdict rather than a missed match.
   */
  const drive = async (entry) => {
    const before = evidence();
    const advanced = () => Object.keys(before).filter((key) => evidence()[key] > before[key]);
    entry.callback();
    await waitFor(async () => advanced().length > 0, 1_000);
    return advanced();
  };

  /** Every currently armed interval, mapped to the sweep key it drives. */
  const drivers = async () => {
    /** @type {Map<string, { handle: any, callback: any, delay: any, cleared: boolean }>} */
    const found = new Map();
    for (const entry of live(armed)) {
      for (const key of await drive(entry)) found.set(key, entry);
    }
    return found;
  };

  return { app, armed, dataDir, pool, close, evidence, drivers };
}

/** A project tree of the shape `store.requireProject` hands the runtime manager. */
async function composedProject(dataDir) {
  const rootDir = path.join(dataDir, "projects", USER_ID, PROJECT_ID);
  const runtimeDir = path.join(rootDir, "runtime");
  const workspaceDir = path.join(rootDir, "workspace");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  return { id: PROJECT_ID, userId: USER_ID, rootDir, runtimeDir, baseDir: workspaceDir, workspaceDir };
}

test("the capsule service the composition root builds is the one the runtime manager mounts methods from", async (t) => {
  const fixture = await composedApp(t);

  // The seam itself, on the objects the composition root actually built. Both
  // exist exactly when a product database is configured, so a null here would
  // mean the fixture stopped composing rather than that the wiring is fine.
  assert.ok(fixture.app.capsuleService instanceof CapsuleService, "the fixture must build a real CapsuleService");
  assert.equal(
    fixture.app.runtimeManager.capsuleService,
    fixture.app.capsuleService,
    "runtimeManager.capsuleService must be the CapsuleService the composition root built",
  );

  // And what the seam is for: a launch materializes the approved method, and
  // only the approved one. Without the wiring this returns count 0 and writes
  // nothing, which is exactly what the dark deployment did.
  const project = await composedProject(fixture.dataDir);
  const mounted = await fixture.app.runtimeManager.syncCapsuleMethods(project);
  assert.equal(mounted.count, 1, "the approved work-style method did not reach the runtime");
  const skill = await readFile(path.join(mounted.directory, "approved-method", "SKILL.md"), "utf8");
  assert.match(skill, /Report every effect estimate with its confidence interval\./);
  assert.doesNotMatch(skill, /stranger/, "an unapproved candidate must never be mounted");
});

test("startup arms every recurring sweep, and each timer really drives its own sweep", async (t) => {
  const fixture = await composedApp(t);
  const startup = fixture.evidence();

  for (const sweep of RECURRING_SWEEPS) {
    assert.equal(startup[sweep.key], sweep.startupRuns, `${sweep.name} did not run at startup`);
  }

  // Identified by effect, not by cadence: two sweeps share each delay, so a
  // test that matched on 30s or 60s alone would pass with the two timers
  // swapped.
  const drivers = await fixture.drivers();
  for (const sweep of RECURRING_SWEEPS) {
    const driver = drivers.get(sweep.key);
    assert.ok(driver, `no armed interval drives ${sweep.name}`);
    assert.equal(driver.delay, sweep.intervalMs, `${sweep.name} is armed at the wrong cadence`);
  }
});

test("a maintenance pause clears every recurring timer and reopening re-arms them", async (t) => {
  const fixture = await composedApp(t);
  assert.ok(live(fixture.armed).length >= RECURRING_SWEEPS.length, "startup armed fewer timers than there are sweeps");

  await fixture.app.maintenanceService.request({ requestId: "composition-pause", ttlSeconds: 60 });
  assert.deepEqual(
    live(fixture.armed).map((entry) => entry.delay),
    [],
    "a maintenance pause must leave no recurring timer behind",
  );

  await fixture.app.maintenanceService.release({ requestId: "composition-pause" });
  // The resume is fired from the maintenance listener, not awaited by release.
  const rearmed = await waitFor(async () => live(fixture.armed).length >= RECURRING_SWEEPS.length);
  assert.ok(rearmed, "recurring work was never re-armed after maintenance reopened");

  // Re-armed, and re-armed to the same work: a resume that recreated four
  // timers pointing at nothing would satisfy a count.
  const drivers = await fixture.drivers();
  for (const sweep of RECURRING_SWEEPS) {
    const driver = drivers.get(sweep.key);
    assert.ok(driver, `${sweep.name} was not re-armed after maintenance reopened`);
    assert.equal(driver.delay, sweep.intervalMs, `${sweep.name} was re-armed at the wrong cadence`);
  }
});

test("close() leaves no interval running", async (t) => {
  const fixture = await composedApp(t);
  const armedAtStartup = live(fixture.armed).length;
  assert.ok(armedAtStartup >= RECURRING_SWEEPS.length, "startup armed fewer timers than there are sweeps");

  await fixture.close();

  assert.deepEqual(
    live(fixture.armed).map((entry) => entry.delay),
    [],
    "shutting the app down must clear every interval it armed",
  );
});

test("the composed autopilot worker asks the queue for verification work and can run it", async (t) => {
  // Proactive research is off outside production, so the composition under test
  // is the production one: `autopilotEnabled` is the only thing this fixture
  // changes, and everything it observes is what a hosted deployment builds.
  const fixture = await composedApp(t, { autopilotEnabled: true });

  assert.ok(fixture.app.autopilotWorker, "a production composition builds the autopilot worker");
  assert.deepEqual(fixture.app.autopilotWorker.kinds, ["episode", "verify"],
    "a worker that never claims `verify` leaves every second opinion queued forever");

  // Not "a function is present": the closure the composition root built reaches
  // the real account store, which is what a placeholder would not.
  await assert.rejects(() => fixture.app.autopilotWorker.dispatchVerification({
    userId: "nobody-composed", projectId: PROJECT_ID, agendaId: "agenda-one", episodeId: "episode-one",
    verificationId: "episode-one-v0", claimId: "claim-one", statement: "A finding",
    sources: ["doi:10.1000/one"], budgetCny: 1,
  }), { code: "autopilot_account_unavailable" });

  // And the seam that lets a digest decision become memory: the service holds
  // the same CapsuleService the runtime manager mounts methods from.
  assert.ok(fixture.app.capsuleService instanceof CapsuleService);
  assert.equal(fixture.app.autopilotService.capsules, fixture.app.capsuleService,
    "autopilot must promote decisions through the composition root's capsule service");
  assert.equal(fixture.app.autopilotService.notifications, fixture.app.notificationService,
    "a refuted adoption raises its question through the composed inbox");

  // The claim actually reached the queue, asking for both kinds. The kinds ride
  // as a bound parameter, so this reads the parameter rather than the SQL text.
  const claimed = await waitFor(async () => fixture.pool.calls.some((call) =>
    /^WITH exhausted AS \( SELECT id FROM evimed_product\.jobs/.test(call.sql)
    && Array.isArray(call.values[0]) && call.values[0].includes("verify")));
  assert.ok(claimed, "the composed worker never asked the job queue for verification work");
  const claim = fixture.pool.calls.find((call) => /^WITH exhausted AS \( SELECT id FROM evimed_product\.jobs/.test(call.sql));
  assert.deepEqual(claim.values[0], ["episode", "verify"]);
});

// ---------------------------------------------------------------------------
// The return half of the verification loop.
//
// The outbound half -- worker kinds, the dispatch closure, the capsule seam --
// was composed and covered while the fold that reads a verdict back was keyed
// on `run.effectiveRouteReason`, a field `AgentRunStore.dispatch` overwrites
// with "session-binding" for every specialist-mode session. Everything was
// tested and nothing ever ran. Both tests below therefore drive the composed
// closures with the run shape production actually records.
// ---------------------------------------------------------------------------

const EPISODE_ID = `episode-${"a1b2c3d4".repeat(4)}`;
const VERIFICATION_ID = verificationIdFor(EPISODE_ID, 0);
const REPORT = "reports/evidence.md";
const REPORT_BODY = "REPORT-BODY-NO-VERIFIER-MAY-SEE";

/** The agenda, episode and digest one queued verification points at. */
function verificationFixtureRows() {
  const claim = {
    id: "claim-one", statement: "SGLT2 抑制剂降低心衰再入院 12%。", type: "direct", tier: "gated",
    sources: ["doi:10.1000/one"], effect: { measure: "risk-ratio", value: "0.74" },
    provenance: { episodeId: EPISODE_ID, artifact: REPORT },
    verification: { status: "queued", id: VERIFICATION_ID },
  };
  return [
    // `maxEpisodeCny === dailyBudgetCny` is the configuration the product
    // ships: an episode is allowed to spend the whole night's allowance.
    documentRow("agenda", "agenda-verify", { title: "心衰证据追踪", topics: ["heart failure"], taskTypes: ["literature-sentinel"],
      dailyBudgetCny: 8, weeklyBudgetCny: 80, maxEpisodeCny: 8, enabled: true, status: "active", outcomes: [] }),
    documentRow("episode", EPISODE_ID, { agendaId: "agenda-verify", status: "merged", runId: "run-episode",
      digestId: "digest-verify", budgetCny: 6, verificationBudgetCny: 0.67, claims: [claim] }),
    documentRow("digest", "digest-verify", { agendaId: "agenda-verify", date: "2026-09-06", costCny: 3,
      headlines: [], leads: [claim], decisions: [] }),
  ];
}

test("a verification runs in a workspace that does not contain the report it is checking", async (t) => {
  const fixture = await composedApp(t, { autopilotEnabled: true,
    modelGatewaySigningSecret: randomBytes(32).toString("hex") });
  for (const row of verificationFixtureRows()) fixture.pool.documents.set(`${row.kind}:${row.id}`, row);

  const user = await fixture.app.store.userById(USER_ID);
  const project = await fixture.app.store.requireProject(user, PROJECT_ID);
  // The episode's own report, where the episode wrote it.
  await mkdir(path.join(project.workspaceDir, "reports"), { recursive: true });
  await writeFile(path.join(project.workspaceDir, REPORT), REPORT_BODY, "utf8");

  // The three seams below the unit under test, recorded rather than run: what
  // is being proved is which project the composed closure hands them.
  /** @type {any[]} */ const reserved = [];
  /** @type {any[]} */ const dispatched = [];
  /** @type {any[]} */ const prompts = [];
  fixture.app.runtimeManager.reserveBoundedRuntimeSession = async (scoped, scope) => {
    reserved.push({ project: scoped, scope });
    return { id: "session-verify", kernel: "dsh" };
  };
  fixture.app.runtimeManager.dispatchPrompt = async (scoped, sessionId, request) => {
    prompts.push({ project: scoped, sessionId, request });
    return { accepted: true };
  };
  fixture.app.agentRuns.dispatch = async (scoped, input, sendPrompt) => {
    dispatched.push({ project: scoped, input });
    await sendPrompt({ sessionId: input.sessionId }, { id: "run-verify", kernelRequestIds: [] });
    return { id: "run-verify", status: "running" };
  };

  const result = await fixture.app.autopilotWorker.dispatchVerification({
    userId: USER_ID, projectId: PROJECT_ID, agendaId: "agenda-verify", episodeId: EPISODE_ID,
    digestId: "digest-verify", verificationId: VERIFICATION_ID, claimId: "claim-one",
    statement: "SGLT2 抑制剂降低心衰再入院 12%。", sources: ["doi:10.1000/one"],
    effect: { measure: "risk-ratio", value: "0.74" }, artifact: REPORT, budgetCny: 0.67,
  });
  assert.equal(result.runId, "run-verify");

  // One workspace, and it is not the episode's. That is what the composed
  // closure hands its three seams; what a container is given is the launch
  // plan's business and is asserted below, because these three could be right
  // while the plan mounted something else entirely -- and were.
  const scratch = path.join(project.baseDir, verificationWorkspacePath(VERIFICATION_ID));
  for (const seen of [reserved[0].project, dispatched[0].project, prompts[0].project]) {
    assert.equal(seen.workspaceDir, scratch, "the verification must not run in the workspace it is checking");
  }
  assert.equal(await readFile(path.join(project.workspaceDir, REPORT), "utf8"), REPORT_BODY,
    "the episode's report is still where it was");
  await assert.rejects(() => readFile(path.join(scratch, REPORT), "utf8"), { code: "ENOENT" },
    "the report must not be reachable from the verification workspace");
  // What the container is actually given, read off a real launch plan instead of
  // off the argument the closure passed. The three assertions above were true
  // for the whole time the plan mounted the episode's own runtime root beside
  // this workspace, so only the plan can answer what a verifier can open.
  //
  // Volume-backed, as the shipped stack is (`deploy/web/docker-compose.yml` sets
  // OPEN_SCIENCE_RUNTIME_DATA_VOLUME): with a bind mount the control socket for
  // a project this deep passes the 108-byte `sun_path` limit and no plan builds.
  const planConfig = { ...fixture.app.config, runtimeSandboxMode: "docker",
    runtimeDataVolume: "evimed-composition-data" };
  const subpath = (target) => path.relative(planConfig.dataDir, target).split(path.sep).join("/");
  const plan = buildRuntimeLaunchPlan(planConfig, reserved[0].project, 49152);
  const mounts = new Map(plan.args
    .filter((arg) => typeof arg === "string" && arg.startsWith("type=volume,"))
    .map((arg) => [arg.match(/,dst=([^,]+)/)?.[1], arg]));
  assert.equal(
    mounts.get("/workspace"),
    `type=volume,src=evimed-composition-data,dst=/workspace,volume-subpath=${subpath(scratch)}`,
    "the container's /workspace must be the verification's own scratch directory",
  );
  const mountedSubpaths = [...mounts.values()].map((mount) => mount.slice(mount.indexOf("volume-subpath=") + 15));
  assert.equal(mountedSubpaths.includes(subpath(project.workspaceDir)), false,
    "no mount may name the workspace the episode wrote its report into");

  // `/runtime` is NOT scoped to the verification, and this is the fact that
  // decides it may not be: the privileged controller rebuilds the project from
  // {userId, projectId, activeWorkspace} alone and derives `<rootDir>/runtime`
  // itself, while the control plane writes this run's DSH profile and
  // credentials into the root ITS plan names. Scoping one side alone gives the
  // container a profile nobody wrote for it. So the verifier does share the
  // episode's DSH home -- `verificationRunProject` says so in full -- and this
  // expectation moves only together with the controller protocol.
  const runtimeRoot = path.join(project.runtimeDir, "container-runtime");
  assert.equal(
    mounts.get("/runtime"),
    `type=volume,src=evimed-composition-data,dst=/runtime,volume-subpath=${subpath(runtimeRoot)}`,
    "the two launch-plan builders must name the same runtime root",
  );
  assert.equal(plan.dshHomeDir, path.join(runtimeRoot, "dsh-home"),
    "the profile the control plane writes must sit inside the runtime root the container mounts");

  // And the prompt: the claim and its sources, delimited as data, with no path
  // into the report and nothing of the report in it.
  const text = String(prompts[0].request.text);
  assert.equal(text.includes(REPORT), false, "the artifact path reached the verifier's prompt");
  assert.equal(text.includes(REPORT_BODY), false);
  assert.match(text, /<evimed-claim id="claim-one">/);
  assert.match(text, /<evimed-claim-source index="1">doi:10\.1000\/one<\/evimed-claim-source>/);
  assert.match(text, /data written by the run you are checking/);
  assert.equal(dispatched[0].input.dispatchId, VERIFICATION_ID);
  assert.equal(reserved[0].scope.runId, VERIFICATION_ID);
});

test("a verification that could not be dispatched leaves no scratch directory behind", async (t) => {
  const fixture = await composedApp(t, { autopilotEnabled: true,
    modelGatewaySigningSecret: randomBytes(32).toString("hex") });
  for (const row of verificationFixtureRows()) fixture.pool.documents.set(`${row.kind}:${row.id}`, row);

  const user = await fixture.app.store.userById(USER_ID);
  const project = await fixture.app.store.requireProject(user, PROJECT_ID);
  const scratch = path.join(project.baseDir, verificationWorkspacePath(VERIFICATION_ID));

  // The failure a nightly agenda really hits -- the project's runtime is busy
  // with something else -- taken at the point where the scratch directory
  // already exists and no completion fold will ever be called for it.
  let existedWhenDispatchFailed = false;
  fixture.app.runtimeManager.reserveBoundedRuntimeSession = async () => {
    existedWhenDispatchFailed = (await stat(scratch)).isDirectory();
    throw Object.assign(new Error("The project runtime is already in use."), { status: 409, code: "runtime_busy" });
  };

  await assert.rejects(() => fixture.app.autopilotWorker.dispatchVerification({
    userId: USER_ID, projectId: PROJECT_ID, agendaId: "agenda-verify", episodeId: EPISODE_ID,
    digestId: "digest-verify", verificationId: VERIFICATION_ID, claimId: "claim-one",
    statement: "SGLT2 抑制剂降低心衰再入院 12%。", sources: ["doi:10.1000/one"],
    effect: { measure: "risk-ratio", value: "0.74" }, artifact: REPORT, budgetCny: 0.67,
  }), { code: "runtime_busy" }, "the dispatch failure is the one that must travel");

  assert.equal(existedWhenDispatchFailed, true, "the directory the sweep has to remove was never created");
  await assert.rejects(() => stat(scratch), { code: "ENOENT" },
    "a dispatch that failed must not leave its scratch directory in the tree the quota walks");
});

test("a finished verification is folded into its claim, identified by the id the dispatch layer cannot rewrite", async (t) => {
  const fixture = await composedApp(t, { autopilotEnabled: true });
  for (const row of verificationFixtureRows()) fixture.pool.documents.set(`${row.kind}:${row.id}`, row);

  const user = await fixture.app.store.userById(USER_ID);
  const project = await fixture.app.store.requireProject(user, PROJECT_ID);
  const scratch = path.join(project.baseDir, verificationWorkspacePath(VERIFICATION_ID));
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(scratch, "verification.json"), JSON.stringify({
    schemaVersion: 1, verdict: "stands", numbersReproduced: true,
    recomputed: { measure: "risk-ratio", value: "0.74" }, checkedSources: ["doi:10.1000/one"],
    reason: "两项来源均支持该效应量。",
  }), "utf8");

  // The run shape production records. `effectiveRouteReason` is "session-binding"
  // because `AgentRunStore.dispatch` substitutes it for every specialist-mode
  // session -- which is exactly why the fold may not be keyed on it.
  await fixture.app.agentRuns.onRunFinished(project, {
    id: "run-verify", dispatchId: VERIFICATION_ID, sessionId: "session-verify", status: "succeeded",
    artifacts: ["verification.json"], effectiveRouteReason: "session-binding", effectiveAgentId: "open-domain-answer",
  });

  const claim = fixture.pool.documents.get(`episode:${EPISODE_ID}`).payload.claims[0];
  assert.equal(claim.verification.status, "recorded", "the verdict never reached the claim");
  assert.equal(claim.verification.runId, "run-verify");
  assert.equal(claim.refutation, "stands");
  assert.equal(claim.tier, "reproduced", "a checked reproduction is what the top tier is for");
  const digest = fixture.pool.documents.get("digest:digest-verify").payload;
  assert.deepEqual(digest.headlines.map((item) => item.id), ["claim-one"],
    "a reproduced claim leads the digest it was published in");
  assert.deepEqual(digest.leads, []);

  // And the scratch is gone -- after the verdict was taken out of it, which the
  // assertions above are the evidence of. It lived under the project's
  // workspace root, which is the tree `assertProjectCapacity` and the runtime
  // quota monitor both walk, and nothing used to remove it: a nightly agenda
  // grew the researcher's own quota by one directory per verification forever.
  await assert.rejects(() => stat(scratch), { code: "ENOENT" },
    "a folded verification must not leave its scratch directory behind");
});

test("a deployment whose controller cannot carry the scratch workspace folds the same verdict without the top tier", async (t) => {
  // Same run, same verification.json, same everything — except that this
  // deployment reaches its runtime through the privileged controller, whose
  // start payload carries only {userId, projectId, activeWorkspace}. The
  // scratch workspace the control plane scoped never reaches the container, so
  // the verifier read the report it was checking. The composition root is what
  // knows that, and this asserts it actually tells the fold: with the flag not
  // reaching `recordVerification`, the claim below reads "reproduced" and this
  // whole deployment ships self-graded headlines.
  const fixture = await composedApp(t, { autopilotEnabled: true, runtimeControllerMode: "socket" });
  for (const row of verificationFixtureRows()) fixture.pool.documents.set(`${row.kind}:${row.id}`, row);

  const user = await fixture.app.store.userById(USER_ID);
  const project = await fixture.app.store.requireProject(user, PROJECT_ID);
  const scratch = path.join(project.baseDir, verificationWorkspacePath(VERIFICATION_ID));
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(scratch, "verification.json"), JSON.stringify({
    schemaVersion: 1, verdict: "stands", numbersReproduced: true,
    recomputed: { measure: "risk-ratio", value: "0.74" }, checkedSources: ["doi:10.1000/one"],
    reason: "两项来源均支持该效应量。",
  }), "utf8");

  await fixture.app.agentRuns.onRunFinished(project, {
    id: "run-verify", dispatchId: VERIFICATION_ID, sessionId: "session-verify", status: "succeeded",
    artifacts: ["verification.json"], effectiveRouteReason: "session-binding", effectiveAgentId: "open-domain-answer",
  });

  const claim = fixture.pool.documents.get(`episode:${EPISODE_ID}`).payload.claims[0];
  assert.equal(claim.verification.status, "recorded", "the verdict is still folded; only the promotion is refused");
  assert.equal(claim.refutation, "stands");
  assert.equal(claim.verification.isolationEnforced, false, "the composition root must tell the fold what its deployment can enforce");
  assert.equal(claim.tier, "gated", "an unenforced separation may hold a claim and may not raise it");
  assert.equal(fixture.pool.documents.get("digest:digest-verify").payload.headlines[0].tier, "gated");
});

test("a verification whose scratch cannot be removed still folds, and the sweep never follows a link out of the project", async (t) => {
  const fixture = await composedApp(t, { autopilotEnabled: true });
  for (const row of verificationFixtureRows()) fixture.pool.documents.set(`${row.kind}:${row.id}`, row);

  const user = await fixture.app.store.userById(USER_ID);
  const project = await fixture.app.store.requireProject(user, PROJECT_ID);

  // The scratch root, replaced by a link to a directory outside the project --
  // the shape a compromised run leaves behind to have the control plane read,
  // and then delete, something that was never its own. The verdict on the far
  // side is well-formed, so nothing but the link decides the outcome.
  const outside = await mkdtemp(path.join(tmpdir(), "evimed-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(outside, VERIFICATION_ID), { recursive: true });
  await writeFile(path.join(outside, VERIFICATION_ID, "verification.json"), JSON.stringify({
    schemaVersion: 1, verdict: "stands", numbersReproduced: true,
    recomputed: { measure: "risk-ratio", value: "0.74" }, checkedSources: ["doi:10.1000/one"],
    reason: "项目之外的目录里的结论。",
  }), "utf8");
  const link = path.join(project.baseDir, ".evimed-verification");
  await symlink(outside, link, "dir");

  // The fold runs to completion: recording a verification is what the episode
  // paid for, and neither the read nor the removal is allowed to take it down.
  await fixture.app.agentRuns.onRunFinished(project, {
    id: "run-verify", dispatchId: VERIFICATION_ID, sessionId: "session-verify", status: "succeeded",
    artifacts: ["verification.json"], effectiveRouteReason: "session-binding", effectiveAgentId: "open-domain-answer",
  });

  const claim = fixture.pool.documents.get(`episode:${EPISODE_ID}`).payload.claims[0];
  assert.equal(claim.verification.status, "unavailable", "the fold must still have recorded the verification");
  assert.equal(claim.verification.code, "verification_result_unreadable",
    "a verdict reached through a link out of the project is not a verdict");
  assert.equal(claim.tier, "gated", "and the claim keeps the tier its own episode's gate gave it");

  // Nothing outside the project was read through, and nothing outside it was
  // deleted: the link is still a link, and the tree it points at is intact.
  assert.equal((await lstat(link)).isSymbolicLink(), true, "the sweep must refuse the link, not resolve it");
  assert.deepEqual((await readdir(outside)).sort(), [VERIFICATION_ID],
    "the sweep must not delete a directory outside the project");
  assert.equal(
    JSON.parse(await readFile(path.join(outside, VERIFICATION_ID, "verification.json"), "utf8")).verdict,
    "stands",
    "and must not delete the file inside it either",
  );
});

test("an episode that spent everything it was given still leaves its own verifications affordable", async (t) => {
  // The starvation this splits the budget to prevent: verification spends into
  // the same rolling 24h window the episode just spent into, and the shipped
  // configuration lets one episode have the whole night. Dispatched at the full
  // nightly budget, an episode that used it refuses every re-check of its own
  // claims -- `usage_budget_exceeded` is terminal, so the claim would sit at
  // `gated` forever with a verification nobody could ever run.
  const fixture = await composedApp(t, { autopilotEnabled: true,
    modelGatewaySigningSecret: randomBytes(32).toString("hex") });
  for (const row of verificationFixtureRows()) fixture.pool.documents.set(`${row.kind}:${row.id}`, row);
  fixture.app.runtimeManager.reserveBoundedRuntimeSession = async () => ({ id: "session-verify", kernel: "dsh" });
  fixture.app.runtimeManager.dispatchPrompt = async () => ({ accepted: true });
  fixture.app.agentRuns.dispatch = async (scoped, input, sendPrompt) => {
    await sendPrompt({ sessionId: input.sessionId }, { id: "run-verify", kernelRequestIds: [] });
    return { id: "run-verify", status: "running" };
  };

  const night = 8;
  const split = splitEpisodeBudget(night);
  const request = {
    userId: USER_ID, projectId: PROJECT_ID, agendaId: "agenda-verify", episodeId: EPISODE_ID,
    digestId: "digest-verify", verificationId: VERIFICATION_ID, claimId: "claim-one",
    statement: "SGLT2 抑制剂降低心衰再入院 12%。", sources: ["doi:10.1000/one"],
    artifact: REPORT, budgetCny: split.verificationCny,
  };

  // The episode spent every cent it was dispatched with.
  fixture.pool.daySpendCny = split.episodeCny;
  assert.equal((await fixture.app.autopilotWorker.dispatchVerification(request)).runId, "run-verify",
    "an episode that used its whole budget must not have eaten its own second opinion");

  // And the assertion is not vacuous: at the budget the episode used to be
  // dispatched with, the same call is refused.
  fixture.pool.daySpendCny = night;
  await assert.rejects(() => fixture.app.autopilotWorker.dispatchVerification(request), { code: "usage_budget_exceeded" });
});

// ---------------------------------------------------------------------------
// The feedback loop, composed.
//
// Everything below existed as a unit before it existed in the app: a ledger, a
// producer and a worker are three objects that can each be right while nothing
// introduces them to one another. This drives the objects `createWebApiApp`
// itself built — over the real `ProductJobs` and `ProductDocuments`, against a
// pool that answers the statements they issue — from "the researcher edited
// something they had adopted" to a `method` document the runtime cannot mount.
// ---------------------------------------------------------------------------

test("the composed feedback ledger queues the distillation exactly one worker claims", async (t) => {
  const fixture = await composedApp(t, { learningEnabled: true });
  const { app, pool } = fixture;

  assert.ok(app.feedbackEvents instanceof FeedbackEvents, "a product database must compose the feedback ledger");

  // The property the merge broke, asserted over the composition rather than
  // over either worker: `distill` has exactly one claimer.
  //
  // It had two. `jobs.claim` selects by kind with `SKIP LOCKED`, so whichever
  // polled first took the job — and both classify a payload written for the
  // other as a terminal failure, which burns the idempotency key and makes the
  // lesson unqueueable forever. Nothing failed in either worker's own tests,
  // because a claim race between two objects is not visible from inside one of
  // them. Counting the claimers is.
  const workers = [app.pluginApplyWorker, app.memoryIndexWorker, app.sourceWorker, app.autopilotWorker, app.learningWorker]
    .filter(Boolean);
  // Every worker declares the kinds it claims, so this is countable at all.
  // Four of the five used to pass an array literal straight into `claim`, which
  // is why the collision was invisible from here: there was nothing to count.
  for (const worker of workers) {
    assert.ok(Array.isArray(worker.kinds) && worker.kinds.length > 0,
      `${worker.constructor.name} must declare the job kinds it claims`);
  }
  /** @type {Map<string, string[]>} */
  const byKind = new Map();
  for (const worker of workers) {
    for (const kind of worker.kinds) byKind.set(kind, [...(byKind.get(kind) ?? []), worker.constructor.name]);
  }
  for (const [kind, owners] of byKind) {
    assert.equal(owners.length, 1,
      `job kind ${kind} is claimed by ${owners.join(" and ")} — SKIP LOCKED would decide which one destroys the other's jobs`);
  }

  const claimers = workers.filter((worker) => worker.kinds.includes("distill"));
  assert.equal(claimers.length, 1, "the learning loop is composed here, so `distill` must have its one claimer");

  // Producer and claimer agree, in both directions. Two claimers race; zero
  // claimers with a live producer is the quieter failure of the same kind — a
  // job enqueued per adopted-then-edited deliverable, a `distillJobId` handed
  // back to the browser, and nothing that will ever run it.
  assert.equal(Boolean(app.feedbackEvents.jobs), claimers.length === 1,
    "the feedback ledger must enqueue distillation exactly when something claims it");

  const subject = { type: "deliverable", id: deliverableSubjectId("run-adopted", "reports/evidence.md") };
  const detail = (contentSha256, extra = {}) => ({ path: "reports/evidence.md", runId: "run-adopted", contentSha256, ...extra });
  const adoption = await app.feedbackEvents.record(USER_ID, {
    trigger: "deliverable-adopted", subject, projectId: PROJECT_ID, runId: "run-adopted", detail: detail("a".repeat(64)),
  });
  assert.equal(adoption.distillJob, null);
  const edit = await app.feedbackEvents.record(USER_ID, {
    trigger: "deliverable-edited", subject, identity: ["b".repeat(64)], projectId: PROJECT_ID, runId: "run-adopted",
    detail: detail("b".repeat(64), { summary: "把结论段的效应量补上了置信区间。" }),
  });
  if (claimers.length === 0) {
    assert.equal(edit.distillJob, null, "a deployment with no claimer must not queue a lesson nobody will read");
    assert.ok(pool.calls.length > 0, "the composed ledger never reached the database");
    return;
  }
  assert.ok(edit.distillJob, "the producer never enqueued the lesson");

  // The trigger is the distillation module's own, and the two events travel
  // whole under `feedback` — the field `buildDistillationInput` reads. A
  // payload of ids alone would reach a consumer that cannot resolve them.
  assert.equal(edit.distillJob.payload.trigger, DISTILL_TRIGGER);
  assert.ok(DISTILLATION_TRIGGERS.includes(edit.distillJob.payload.trigger),
    "the queued trigger must be one the distillation run accepts, or the only claimer fails it terminally");
  assert.equal(edit.distillJob.payload.runId, "run-adopted");
  assert.deepEqual(edit.distillJob.payload.feedbackEventIds, [adoption.event.id, edit.event.id]);
  assert.deepEqual(edit.distillJob.payload.feedback.map((event) => event.id), [adoption.event.id, edit.event.id]);
  assert.match(JSON.stringify(edit.distillJob.payload.feedback), /把结论段的效应量补上了置信区间。/,
    "the edit summary is the whole readable evidence of the lesson and must reach the run");

  // And the input assembler accepts it as-is. This is the seam the two branches
  // disagreed across, so it is checked against the real builder rather than by
  // eye.
  const input = buildDistillationInput({
    run: { id: edit.distillJob.payload.runId }, trigger: edit.distillJob.payload.trigger,
    transcript: null, feedback: edit.distillJob.payload.feedback,
  });
  assert.equal(input.trigger, DISTILL_TRIGGER);
  assert.equal(input.feedback.length, 2);
  assert.ok(pool.calls.length > 0, "the composed ledger never reached the database");
});

test("a deployment without the learning loop records the fact and queues nothing", async (t) => {
  // The other direction of the same invariant. Without this the assertion
  // above would be satisfied by a build that simply never composes a claimer.
  //
  // Turned off explicitly rather than by omission: the loop defaults on since
  // 2026-09-08, and a test that read the default would have been asserting
  // "the default is off" while claiming to assert "off composes nothing".
  const { app } = await composedApp(t, { learningEnabled: false });
  assert.equal(app.learningWorker, null, "an opted-out deployment composes no claimer");
  assert.equal(app.feedbackEvents.jobs, null, "and the ledger must not queue work nothing will claim");

  const subject = { type: "deliverable", id: deliverableSubjectId("run-adopted", "reports/evidence.md") };
  const detail = (contentSha256, extra = {}) => ({ path: "reports/evidence.md", runId: "run-adopted", contentSha256, ...extra });
  await app.feedbackEvents.record(USER_ID, {
    trigger: "deliverable-adopted", subject, projectId: PROJECT_ID, runId: "run-adopted", detail: detail("a".repeat(64)),
  });
  const edit = await app.feedbackEvents.record(USER_ID, {
    trigger: "deliverable-edited", subject, identity: ["b".repeat(64)], projectId: PROJECT_ID, runId: "run-adopted",
    detail: detail("b".repeat(64), { summary: "把结论段的效应量补上了置信区间。" }),
  });
  // The fact is still recorded — that half stands on its own and is what a
  // later deployment distils from.
  assert.ok(edit.event.id, "the event must be recorded whether or not anything distils it");
  assert.equal(edit.distillJob, null, "and no job is queued for a loop that does not exist");
});

/**
 * The two memory-service calls the structured-memory PATCH route makes.
 *
 * Only two, and both against the record under test: `getRecord` to read the
 * version the caller claims, and `memoryRecords:upsert` to write the change.
 * Everything the route decides — accepted inference, edit, rejection — is
 * decided from what those two return.
 */
function memoryServiceDouble(record) {
  const state = { ...record };
  return {
    state,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input));
      const method = String(init.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/v1/memoryRecords:upsert" && method === "POST") {
        const body = JSON.parse(String(init.body));
        Object.assign(state, body.memoryRecord, { version: state.version + 1, updateTime: new Date().toISOString() });
        return Response.json(state);
      }
      if (/^\/api\/v1\/memoryRecords\/[^/]+$/.test(url.pathname)) {
        if (method === "GET") return Response.json(state);
        if (method === "DELETE") return new Response(null, { status: 200 });
      }
      return Response.json({ message: "unexpected fake route" }, { status: 500 });
    },
  };
}

test("confirming a pending memory over HTTP writes the feedback event the loop needs", async (t) => {
  // The hop this covers is the one that had no substrate: the route recognized
  // `acceptedInference` and wrote a record plus an audit line, and nothing
  // downstream could ever read that. Driven over the real HTTP server, through
  // the real memory routes, into the ledger the composition root built.
  const memory = memoryServiceDouble({
    name: "memoryRecords/record_1", namespace: memoryNamespace(USER_ID),
    scope: "MEMORY_SCOPE_USER", scopeId: "", kind: "MEMORY_KIND_PREFERENCE", key: "response.evidence_depth",
    value: "优先给原始证据", summary: "原始证据优先", origin: "MEMORY_ORIGIN_INFERRED",
    status: "MEMORY_STATUS_PENDING", confidence: 0.7, importance: 0.9, sensitive: false,
    evidenceCount: 1, version: 1, evidence: [], revisions: [],
  });
  const fixture = await composedApp(t, {
    memosUrl: "http://memos.internal", memosAccessToken: "memos_pat_test",
    memosRequestTimeoutMs: 1_000, memosFetch: memory.fetchImpl,
    // The distillation half of this test needs the loop that claims what the
    // ledger queues. Off by default, and the ledger is honest about it: with no
    // claimer composed it enqueues nothing and answers a null job id, so this
    // has to ask for the deployment it is actually asserting about.
    learningEnabled: true,
  });
  const address = fixture.app.server.address();
  const headers = {
    "Content-Type": "application/json",
    "x-open-science-project": PROJECT_ID,
    "x-open-science-csrf": "composition-csrf",
    Cookie: `${fixture.app.config.sessionCookieName}=composition-session`,
  };

  const confirm = await fetch(`http://127.0.0.1:${address.port}/api/memory/records/record_1`, {
    method: "PATCH", headers, body: JSON.stringify({ expectedVersion: 1, status: "active" }),
  });
  const confirmed = await confirm.json();
  assert.equal(confirm.status, 200, JSON.stringify(confirmed));
  assert.equal(confirmed.data.origin, "explicit", "the confirmation itself must still work");

  // And the fact of it, in the ledger, addressed by the record and the version
  // the change produced.
  const events = [...fixture.pool.feedback.values()];
  assert.equal(events.length, 1, "the confirmed inference never reached the feedback ledger");
  assert.equal(events[0].trigger_kind, "memory-inference-accepted");
  assert.equal(events[0].user_id, USER_ID);
  assert.equal(events[0].subject_type, "memory-record");
  assert.equal(events[0].subject_id, "record_1");
  assert.equal(events[0].detail.key, "response.evidence_depth");

  // Replaying the same decision is the same event: the ledger is append-only
  // and its identity is what happened, not when it was written.
  const replay = await fetch(`http://127.0.0.1:${address.port}/api/memory/records/record_1`, {
    method: "PATCH", headers, body: JSON.stringify({ expectedVersion: 2, status: "active", value: "只用系统综述" }),
  });
  const replayed = await replay.json();
  assert.equal(replay.status, 200, JSON.stringify(replayed));
  const triggers = [...fixture.pool.feedback.values()].map((row) => row.trigger_kind).sort();
  assert.deepEqual(triggers, ["memory-inference-accepted", "memory-value-edited"],
    "an edit of the value is a different decision from confirming an inference");

  // Rejection is the third decision the loop needs, and deleting is the only
  // route that produces it. This hop had no coverage anywhere: removing the
  // call from the DELETE route left the whole server suite green.
  const removed = await fetch(`http://127.0.0.1:${address.port}/api/memory/records/record_1`, { method: "DELETE", headers });
  assert.equal(removed.status, 200, await removed.text());
  const rejection = [...fixture.pool.feedback.values()].find((row) => row.trigger_kind === "memory-rejected");
  assert.ok(rejection, "deleting a memory never reached the feedback ledger");
  assert.equal(rejection.subject_type, "memory-record");
  assert.equal(rejection.subject_id, "record_1");
  assert.equal(rejection.project_id, PROJECT_ID);
  assert.equal(rejection.detail.reason, "deleted", "archiving and deleting are the same trigger and different facts");
  assert.equal(rejection.detail.version, 3, "the version that was deleted is what identifies the event");

  // The route that reports an adoption is reachable and refuses what a client
  // must not be able to claim.
  const forged = await fetch(`http://127.0.0.1:${address.port}/api/feedback/events`, {
    method: "POST", headers, body: JSON.stringify({ trigger: "memory-inference-accepted", runId: "run-1", path: "reports/evidence.md" }),
  });
  assert.equal(forged.status, 400);
  assert.equal((await forged.json()).code, "feedback_event_invalid",
    "a client that could post its own memory feedback could manufacture the evidence the extractor has to earn");

  // A deliverable it cannot read is one it cannot identify: the content digest
  // is the event's identity, and it is computed here rather than accepted.
  const report = (trigger, target, summary, runId = "run-1") => fetch(`http://127.0.0.1:${address.port}/api/feedback/events`, {
    method: "POST", headers, body: JSON.stringify({ trigger, runId, path: target, ...(summary ? { summary } : {}) }),
  });
  const adopt = (target) => report("deliverable-adopted", target);

  const user = await fixture.app.store.userById(USER_ID);
  const project = await fixture.app.store.requireProject(user, PROJECT_ID);

  // The run id is the caller's own claim, and it ends up in the distillation
  // payload and in the method document the lesson becomes. It is resolved
  // through this project's ledger first, exactly as `GET /api/runs/:id/events`
  // does, so a run this project does not have is refused before anything is
  // written.
  const unknownRun = await adopt("reports/evidence.md");
  assert.equal(unknownRun.status, 404);
  assert.equal((await unknownRun.json()).code, "agent_run_not_found");
  await writeFile(path.join(project.metaDir, "runs.jsonl"), `${JSON.stringify({
    event: "started", id: "run-1", dispatchId: "turn-1", sessionId: "session-1", mode: "open-domain",
    agentId: null, agentVersion: null, runtimeAgent: null, model: "deepseek/deepseek-v4-pro",
    createdAt: "2026-09-07T07:00:00.000Z", startedAt: "2026-09-07T07:00:00.000Z",
  })}\n`, "utf8");

  const missingFile = await adopt("reports/never-written.md");
  assert.equal(missingFile.status, 404);
  assert.equal((await missingFile.json()).code, "file_not_found",
    "a run that exists and a file that does not are different refusals");
  await mkdir(path.join(project.workspaceDir, "reports"), { recursive: true });
  await writeFile(path.join(project.workspaceDir, "reports/evidence.md"), "# 证据小结\n效应量 0.74。\n", "utf8");
  const adopted = await adopt("reports/evidence.md");
  assert.equal(adopted.status, 201, await adopted.text());
  const stored = [...fixture.pool.feedback.values()].find((row) => row.trigger_kind === "deliverable-adopted");
  assert.ok(stored, "the adoption never reached the ledger");
  assert.equal(stored.subject_id, deliverableSubjectId("run-1", "reports/evidence.md"));
  assert.match(stored.detail.contentSha256, /^[0-9a-f]{64}$/);

  // Reporting the same adoption again is the same fact.
  assert.equal((await adopt("reports/evidence.md")).status, 200);
  assert.equal([...fixture.pool.feedback.values()].filter((row) => row.trigger_kind === "deliverable-adopted").length, 1);

  // And two different edits of the same deliverable are two lessons: an edit is
  // identified by the content it produced, which is read from the workspace
  // rather than taken from the client.
  const edit = async (body, summary) => {
    await writeFile(path.join(project.workspaceDir, "reports/evidence.md"), body, "utf8");
    return report("deliverable-edited", "reports/evidence.md", summary);
  };
  const revised = "# 证据小结\n效应量 0.74（95% CI 0.61–0.90）。\n";
  const final = "# 证据小结\n效应量 0.74（95% CI 0.61–0.90）。不给用药建议。\n";
  assert.equal((await edit(revised, "补上了置信区间。")).status, 201);
  assert.equal((await edit(final, "删掉了用药建议。")).status, 201);
  const edits = [...fixture.pool.feedback.values()].filter((row) => row.trigger_kind === "deliverable-edited");
  assert.equal(edits.length, 2, "a second, different edit must not collapse into the first");
  assert.notEqual(edits[0].detail.contentSha256, edits[1].detail.contentSha256);
  // The digest is the deliverable's, read from the workspace. A client-supplied
  // one would let a caller claim an edit that never happened.
  assert.deepEqual(
    edits.map((row) => row.detail.contentSha256).sort(),
    [revised, final].map((body) => createHash("sha256").update(body).digest("hex")).sort(),
  );
  assert.equal([...fixture.pool.jobs.values()].filter((row) => row.kind === "distill").length, 2,
    "each lesson gets its own distillation");
});

/**
 * The memory service, as much of it as one extraction run touches: list what is
 * already stored, and upsert what the run produces.
 *
 * The records are proto-shaped because that is what `MemosClient` parses, and
 * parsing them is part of what this proves: a fixture that handed the client
 * its own internal shape would certify a conversion that never ran.
 *
 * @param {any[]} seed
 */
function memoryRecordsDouble(seed = []) {
  /** @type {Map<string, any>} */
  const records = new Map(seed.map((record) => [record.name, record]));
  let minted = seed.length;
  const identity = (record) => [record.scope, record.scopeId ?? "", record.kind, record.key].join("\0");
  return {
    records,
    /** @param {any} input @param {any} init */
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input));
      const method = String(init.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/v1/memoryRecords" && method === "GET") {
        return Response.json({ memoryRecords: [...records.values()] });
      }
      if (url.pathname === "/api/v1/memoryRecords:upsert" && method === "POST") {
        const sent = JSON.parse(String(init.body)).memoryRecord;
        const existing = sent.name
          ? records.get(sent.name)
          : [...records.values()].find((item) => identity(item) === identity(sent));
        const name = existing?.name ?? `memoryRecords/record_${(minted += 1)}`;
        const written = {
          ...existing, ...sent, name,
          version: (existing?.version ?? 0) + 1,
          evidenceCount: (existing?.evidenceCount ?? 0) + 1,
          evidence: existing?.evidence ?? [],
          revisions: existing?.revisions ?? [],
          createTime: existing?.createTime ?? "2026-01-01T00:00:00.000Z",
          updateTime: "2026-09-07T08:00:00.000Z",
        };
        records.set(name, written);
        return Response.json(written);
      }
      return Response.json({ message: "unexpected fake memory route" }, { status: 500 });
    },
  };
}

test("the memory extractor the composition root built reports a rewritten memory into the composed inbox", async (t) => {
  // The wiring this covers went in dark: `MemoryIntelligence` was built inside
  // `createWebApiApp` with `notifications: notificationService` and returned by
  // nothing, so cutting that argument to null left the whole server suite
  // green -- the third time this project has shipped built, tested and never
  // composed. Both halves are asserted here: the seam, and one contradiction
  // driven through the composed objects into the inbox table.
  const language = {
    name: "memoryRecords/record_1", namespace: memoryNamespace(USER_ID),
    scope: "MEMORY_SCOPE_USER", scopeId: "", kind: "MEMORY_KIND_PREFERENCE", key: "preference.output_language",
    value: "回答请用中文", summary: "回答语言", origin: "MEMORY_ORIGIN_EXPLICIT", status: "MEMORY_STATUS_ACTIVE",
    confidence: 1, importance: 0.8, sensitive: false, evidenceCount: 1, version: 1, evidence: [], revisions: [],
    createTime: "2026-01-01T00:00:00.000Z", updateTime: "2026-01-01T00:00:00.000Z",
  };
  const memory = memoryRecordsDouble([language]);
  const fixture = await composedApp(t, {
    memosUrl: "http://memos.internal", memosAccessToken: "memos_pat_test",
    memosRequestTimeoutMs: 1_000, memosFetch: memory.fetchImpl,
    deepseekProviderEnabled: true, deepseekApiKey: "composition-extraction-key",
    // The extraction model, answering with the one candidate this test is
    // about: the researcher saying the opposite of what they confirmed before.
    memoryExtractionFetch: async (_input, init) => {
      const payload = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
      const first = payload.sources.find((item) => item.role === "user");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [{
        scope: "user", kind: "preference", key: "preference.output_language",
        value: "回答请用英文", summary: "回答语言", origin: "explicit",
        confidence: 1, importance: 0.8, sensitive: false,
        sourceRef: first.sourceRef, evidenceQuote: first.text,
      }] }) } }] });
    },
  });

  assert.ok(fixture.app.memoryIntelligence, "the extractor must be part of the composition, not a local of createWebApiApp");
  assert.equal(fixture.app.memoryIntelligence.notifications, fixture.app.notificationService,
    "the extractor's inbox must be the inbox the rest of the app writes to");

  const project = await composedProject(fixture.dataDir);
  const result = await fixture.app.memoryIntelligence.recordRun(project, {
    id: "run-memory", sessionId: "session-memory", status: "succeeded", artifacts: [],
    startedAt: "2026-09-07T07:59:00.000Z", finishedAt: "2026-09-07T08:00:00.000Z",
  }, [{ info: { id: "message-1", role: "user" }, parts: [{ type: "text", text: "回答请用英文" }] }]);

  // The write landed, under the key it belongs to: the researcher's own
  // statement is never held back for approval.
  assert.equal(result.conflicts.length, 1, "the contradiction was not detected at all");
  const stored = [...memory.records.values()].find((record) => record.key === "preference.output_language");
  assert.equal(stored.value, "回答请用英文");
  assert.equal(stored.status, "MEMORY_STATUS_ACTIVE");

  // And the researcher was told, in the table the composed inbox writes to.
  const notices = [...fixture.pool.inbox.values()];
  assert.equal(notices.length, 1, "the conflict notice never reached evimed_inbox.notifications");
  assert.equal(notices[0].user_id, USER_ID);
  assert.equal(notices[0].notice_type, "notify", "the change already happened; there is nothing left to ask");
  assert.deepEqual(notices[0].actions, [], "an inbox action nothing implements is a button that does nothing");
  assert.equal(notices[0].project_id, null, "a user-scoped memory belongs to no project");
  assert.match(notices[0].body, /回答请用中文/);
  assert.match(notices[0].body, /回答请用英文/);

  // Observing the same change again is the same inbox item, against the
  // service's real identity rule rather than a double that only appends.
  await fixture.app.memoryIntelligence.recordRun(project, {
    id: "run-memory-2", sessionId: "session-memory", status: "succeeded", artifacts: [],
    startedAt: "2026-09-08T07:59:00.000Z", finishedAt: "2026-09-08T08:00:00.000Z",
  }, [{ info: { id: "message-2", role: "user" }, parts: [{ type: "text", text: "回答请用英文" }] }]);
  assert.equal([...fixture.pool.inbox.values()].length, 1, "one change is one notice, however many runs observe it");
});
