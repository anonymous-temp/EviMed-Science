// Waking a stopped runtime for a scheduled task (`scheduleWake.mjs`). The kernel's automation tasks deliver by themselves while it runs;
// what this holds is when a stopped project's next task falls due, and what to do about it within the account's allowance and the
// deployment's room. The database is a double that answers the module's few statements, so what is asserted is what was started,
// deferred and told, and the row the next tick would read.
import assert from "node:assert/strict";
import test from "node:test";

import { ScheduleWakes, nextDueOf } from "../src/scheduleWake.mjs";
import { SCHEDULE_WAKE_OUTCOMES, scheduleWakeMetricFamilies } from "../src/scheduleWakeMetrics.mjs";

const T0 = Date.parse("2026-11-05T01:00:00.000Z");
const MINUTE = 60_000;
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
/** The reply of `schedule/list`, in the shape the kernel answers it: a page, with the tasks under `items`. */
const listReply = (...items) => ({ items, shown: items.length, total: items.length, limit: 500, offset: 0 });
const task = (scheduledAt, extra = {}) => ({ id: `t-${scheduledAt}`, status: "active", scheduledAt, ...extra });
const keyOf = (project) => `${project.userId}/${project.id}`;
const outcomeCount = (outcome) => scheduleWakeMetricFamilies()[0].series.find((series) => series.labels.outcome === outcome).value;

/* ---------------------------------------------------------------- nextDueOf */

test("the next due time is the earliest of the active tasks, as an instant", () => {
  const reply = listReply(task("2026-11-06T09:00:00.000Z"), task("2026-11-05T09:00:00+08:00"), task("2026-11-07T01:00:00.000Z"));
  assert.equal(nextDueOf(reply), "2026-11-05T01:00:00.000Z", "an offset is read as the instant it is");
  assert.equal(nextDueOf(listReply(task("2026-11-06T09:00:00.000Z"))), "2026-11-06T09:00:00.000Z");
});

test("only an active task can fall due, and the delivery floor holds one back", () => {
  const reply = listReply(
    task("2026-11-05T00:00:00.000Z", { status: "paused" }),
    task("2026-11-05T00:10:00.000Z", { status: "completed" }),
    task("2026-11-05T00:20:00.000Z", { status: "deleted" }),
    task("2026-11-06T00:00:00.000Z"),
  );
  assert.equal(nextDueOf(reply), "2026-11-06T00:00:00.000Z", "a paused, finished or removed task is not waited for");
  // The kernel will not deliver before the floor (`deliveryFloorEndsAt`), so a wake earlier than it would find nothing to do.
  assert.equal(nextDueOf(listReply(task("2026-11-05T01:00:00.000Z", { deliveryFloorEndsAt: "2026-11-05T01:15:00.000Z" }))), "2026-11-05T01:15:00.000Z");
  assert.equal(nextDueOf(listReply(task("2026-11-05T01:00:00.000Z", { deliveryFloorEndsAt: "2026-11-05T00:30:00.000Z" }))), "2026-11-05T01:00:00.000Z", "a floor already past holds nothing");
  assert.equal(nextDueOf(listReply(
    task("2026-11-05T01:00:00.000Z", { deliveryFloorEndsAt: "2026-11-05T03:00:00.000Z" }), task("2026-11-05T02:00:00.000Z"))), "2026-11-05T02:00:00.000Z", "the earliest of the held-back times");
});

test("no active task, no reply or a reply of another shape is no wake, and a task with no readable time is not one either", () => {
  for (const reply of [listReply(), null, undefined, {}, "", { items: "not a list" }, { items: [null, 7, "x"] }, listReply(task("2026-11-05T00:00:00.000Z", { status: "paused" }))]) {
    assert.equal(nextDueOf(reply), null, JSON.stringify(reply));
  }
  assert.equal(nextDueOf(listReply(task("not a time"), { status: "active" })), null);
  assert.equal(nextDueOf(listReply(task("not a time"), task("2026-11-06T00:00:00.000Z"))), "2026-11-06T00:00:00.000Z", "one task the page cannot read does not hide the next");
});

/* ------------------------------------------------------------- the wake loop */

/** A database that answers the module's few statements over a map of rows. */
function fakeDatabase() {
  /** @type {Map<string, Record<string, any>>} */
  const rows = new Map();
  const ddl = [];
  return {
    rows, ddl,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (/^CREATE /.test(text)) { ddl.push(text); return { rows: [] }; }
      if (/^INSERT INTO evimed_control\.schedule_wakes/.test(text)) {
        const [userId, projectId, nextDue] = params;
        const key = `${userId}/${projectId}`;
        rows.set(key, { user_id: userId, project_id: projectId, next_due_at: nextDue, retry_at: null, last_outcome: rows.get(key)?.last_outcome ?? null });
        return { rows: [] };
      }
      if (/^SELECT user_id, project_id FROM evimed_control\.schedule_wakes WHERE next_due_at <= \$1 AND \(retry_at IS NULL OR retry_at <= \$1\) ORDER BY next_due_at LIMIT \$2/.test(text)) {
        const [now, limit] = params;
        const due = [...rows.values()]
          .filter((row) => row.next_due_at && Date.parse(row.next_due_at) <= Date.parse(now) && (!row.retry_at || Date.parse(row.retry_at) <= Date.parse(now)))
          .sort((left, right) => Date.parse(left.next_due_at) - Date.parse(right.next_due_at))
          .slice(0, limit);
        return { rows: due.map(({ user_id, project_id }) => ({ user_id, project_id })) };
      }
      if (/^UPDATE evimed_control\.schedule_wakes SET retry_at = \$3, last_outcome = \$4/.test(text)) {
        const [userId, projectId, retryAt, outcome] = params;
        Object.assign(rows.get(`${userId}/${projectId}`), { retry_at: retryAt, last_outcome: outcome });
        return { rows: [] };
      }
      throw new Error(`the double does not answer: ${text}`);
    },
  };
}

/**
 * The deployment around the wake: the projects, what each kernel would list, the runtimes up, and a clock. `tasks` is read at the
 * moment of asking, so a test can change what a project's kernel would say.
 */
function fixture({ projects = [], running = [], tasks = {}, idle = {}, restAfterMs = 10 * MINUTE, canRun = () => true } = {}) {
  const clock = { t: T0 };
  const database = fakeDatabase();
  const registry = new Map(projects.map((project) => [keyOf(project), project]));
  const live = new Map(running.map((project) => [keyOf(project), project]));
  const calls = { start: [], rest: [], list: [], balance: [], notified: [] };
  const state = { balanceError: null, startError: null, listError: new Set() };
  const wakes = new ScheduleWakes({
    database,
    runtimes: {
      liveProjects: () => [...live.values()],
      isRunning: (project) => live.has(keyOf(project)),
      listTasks: async (project) => {
        calls.list.push(keyOf(project));
        if (state.listError.has(keyOf(project))) throw new Error("kernel did not answer");
        return tasks[keyOf(project)] ?? null;
      },
      start: async (project) => {
        calls.start.push(keyOf(project));
        if (state.startError) throw state.startError;
        live.set(keyOf(project), project);
        return {};
      },
      idle: async (project) => idle[keyOf(project)] ?? true,
      rest: async (project) => { calls.rest.push(keyOf(project)); live.delete(keyOf(project)); return true; },
    },
    resolveProject: async (userId, projectId) => registry.get(`${userId}/${projectId}`) ?? null,
    assertBalance: async (userId) => { calls.balance.push(userId); if (state.balanceError) throw state.balanceError; },
    notifyNoBalance: async (project) => { calls.notified.push(keyOf(project)); },
    canRun,
    now: () => clock.t,
    restAfterMs,
  });
  return { wakes, database, clock, calls, state, live, tasks, idle, row: (project) => database.rows.get(keyOf(project)) };
}

const project = (id, userId = "u1") => ({ userId, id });
const [alpha, beta, gamma] = [project("alpha"), project("beta"), project("gamma")];
const futureTask = listReply(task(at(6 * 60 * MINUTE)));

test("the table and its index are made once and again without harm", async () => {
  const f = fixture();
  await f.wakes.migrate();
  await f.wakes.migrate();
  assert.equal(f.database.ddl.length, 4);
  assert.ok(f.database.ddl.every((statement) => /IF NOT EXISTS/.test(statement)), "a second start is the same start");
});

test("a running project is asked for its tasks and its next due time is kept, one row per project", async () => {
  const f = fixture({ running: [alpha], tasks: { [keyOf(alpha)]: listReply(task(at(2 * 60 * MINUTE)), task(at(MINUTE))) } });
  assert.equal(await f.wakes.observe(alpha), at(MINUTE));
  assert.equal(f.row(alpha).next_due_at, at(MINUTE));
  // The person paused the last task: nothing is due, and the row says so rather than keeping the old time.
  f.tasks[keyOf(alpha)] = listReply(task(at(MINUTE), { status: "paused" }));
  assert.equal(await f.wakes.observe(alpha), null);
  assert.equal(f.database.rows.size, 1);
  assert.equal(f.row(alpha).next_due_at, null);
  // A wait that was set is over once the kernel has been asked again.
  f.row(alpha).retry_at = at(30 * MINUTE);
  await f.wakes.observe(alpha);
  assert.equal(f.row(alpha).retry_at, null);
});

test("a stopped runtime with a task due is started, and what it was woken for is read at once", async () => {
  const f = fixture({ projects: [alpha], tasks: { [keyOf(alpha)]: futureTask }, running: [] });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  const woken = outcomeCount("woken");
  await f.wakes.tick();
  assert.deepEqual(f.calls.start, [keyOf(alpha)]);
  assert.deepEqual(f.calls.balance, ["u1"], "the account's allowance is asked before the start");
  assert.equal(outcomeCount("woken"), woken + 1);
  assert.equal(f.row(alpha).next_due_at, at(6 * 60 * MINUTE), "the kernel delivered what was missed; the row now holds the next occurrence");
  // Due no more: the next minute starts nothing.
  await f.wakes.tick();
  assert.equal(f.calls.start.length, 1);
});

test("a task not yet due and a running kernel's own due task start nothing", async () => {
  const f = fixture({ projects: [alpha, beta], running: [beta], tasks: { [keyOf(beta)]: listReply(task(at(-5 * MINUTE))) } });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(MINUTE), retry_at: null, last_outcome: null });
  await f.wakes.tick();
  assert.deepEqual(f.calls.start, [], "alpha is not due yet, and beta is up and delivers by itself");
  assert.equal(f.row(beta).next_due_at, at(-5 * MINUTE), "beta was observed");
  f.clock.t += 2 * MINUTE;
  await f.wakes.tick();
  assert.deepEqual(f.calls.start, [keyOf(alpha)], "alpha falls due");
});

test("a project that is gone, or a row with no due time, is not started", async () => {
  const f = fixture({ projects: [] });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  f.database.rows.set(keyOf(beta), { user_id: "u1", project_id: "beta", next_due_at: null, retry_at: null, last_outcome: null });
  await f.wakes.tick();
  assert.deepEqual(f.calls.start, []);
  assert.deepEqual(f.calls.balance, []);
});

test("an account with no balance is not woken: the wait is an hour, it is told, and the task is delivered at the next start", async () => {
  const f = fixture({ projects: [alpha] });
  f.state.balanceError = Object.assign(new Error("insufficient balance"), { code: "insufficient_balance" });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  const refused = outcomeCount("no_balance");
  await f.wakes.tick();
  assert.deepEqual(f.calls.start, []);
  assert.deepEqual(f.calls.notified, [keyOf(alpha)]);
  assert.equal(outcomeCount("no_balance"), refused + 1);
  assert.equal(f.row(alpha).retry_at, at(60 * MINUTE));
  assert.equal(f.row(alpha).last_outcome, "no_balance");
  // Not asked again while the wait lasts, and asked again when it is over; a top-up in between lets it start.
  f.clock.t += 59 * MINUTE;
  await f.wakes.tick();
  assert.equal(f.calls.balance.length, 1);
  f.state.balanceError = null;
  f.clock.t += 2 * MINUTE;
  await f.wakes.tick();
  assert.deepEqual(f.calls.start, [keyOf(alpha)]);
  assert.equal(f.calls.notified.length, 1);
});

test("a notice that cannot be written does not turn a refused wake into a failed tick", async () => {
  const f = fixture({ projects: [alpha, beta] });
  f.state.balanceError = new Error("no balance");
  f.wakes.notifyNoBalance = async () => { throw new Error("inbox is down"); };
  for (const target of [alpha, beta]) f.database.rows.set(keyOf(target), { user_id: "u1", project_id: target.id, next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  await f.wakes.tick();
  assert.equal(f.row(alpha).last_outcome, "no_balance");
  assert.equal(f.row(beta).last_outcome, "no_balance", "the second project was reached");
});

test("a deployment with no room waits a minute and tells nobody; any other failure to start waits five", async () => {
  const f = fixture({ projects: [alpha, beta] });
  f.state.startError = Object.assign(new Error("no slot"), { code: "runtime_capacity_full" });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  const full = outcomeCount("no_room");
  await f.wakes.tick();
  assert.equal(outcomeCount("no_room"), full + 1);
  assert.equal(f.row(alpha).retry_at, at(MINUTE));
  assert.equal(f.row(alpha).last_outcome, "no_room");
  assert.deepEqual(f.calls.notified, [], "a full host is the platform's to carry, not the person's to hear about");
  await f.wakes.tick();
  assert.equal(f.calls.start.length, 1, "inside the minute the same project is not tried again");
  f.clock.t += MINUTE;
  f.state.startError = null;
  f.tasks[keyOf(alpha)] = futureTask;
  await f.wakes.tick();
  assert.equal(f.calls.start.length, 2);
  assert.ok(f.live.has(keyOf(alpha)));

  const g = fixture({ projects: [beta] });
  g.state.startError = new Error("docker said no");
  g.database.rows.set(keyOf(beta), { user_id: "u1", project_id: "beta", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  const failed = outcomeCount("failed");
  await g.wakes.tick();
  assert.equal(outcomeCount("failed"), failed + 1);
  assert.equal(g.row(beta).retry_at, at(5 * MINUTE));
  assert.equal(g.row(beta).last_outcome, "failed");
});

test("a crowd of tasks due at one minute is taken two starts a tick, earliest first, and nobody is skipped", async () => {
  const f = fixture({ projects: [alpha, beta, gamma], tasks: Object.fromEntries([alpha, beta, gamma].map((target) => [keyOf(target), futureTask])) });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(-3 * MINUTE), retry_at: null, last_outcome: null });
  f.database.rows.set(keyOf(beta), { user_id: "u1", project_id: "beta", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  f.database.rows.set(keyOf(gamma), { user_id: "u1", project_id: "gamma", next_due_at: at(-2 * MINUTE), retry_at: null, last_outcome: null });
  await f.wakes.tick();
  assert.deepEqual(f.calls.start, [keyOf(alpha), keyOf(gamma)]);
  f.clock.t += MINUTE;
  await f.wakes.tick();
  assert.deepEqual(f.calls.start, [keyOf(alpha), keyOf(gamma), keyOf(beta)]);
});

test("an account that is refused does not keep the others from being woken", async () => {
  const broke = project("alpha", "u-broke");
  const f = fixture({ projects: [broke, beta, gamma], tasks: Object.fromEntries([beta, gamma].map((target) => [keyOf(target), futureTask])) });
  f.wakes.assertBalance = async (userId) => { if (userId === "u-broke") throw new Error("no balance"); };
  f.database.rows.set(keyOf(broke), { user_id: "u-broke", project_id: "alpha", next_due_at: at(-4 * MINUTE), retry_at: null, last_outcome: null });
  f.database.rows.set(keyOf(beta), { user_id: "u1", project_id: "beta", next_due_at: at(-3 * MINUTE), retry_at: null, last_outcome: null });
  f.database.rows.set(keyOf(gamma), { user_id: "u1", project_id: "gamma", next_due_at: at(-2 * MINUTE), retry_at: null, last_outcome: null });
  await f.wakes.tick();
  f.clock.t += MINUTE;
  await f.wakes.tick();
  assert.deepEqual([...f.calls.start].sort(), [keyOf(beta), keyOf(gamma)], "both others started, and the refused account never");
  assert.deepEqual(f.calls.notified, [keyOf(broke)], "it was told, once");
});

test("when maintenance holds the work back a tick does nothing at all", async () => {
  const f = fixture({ projects: [alpha], running: [beta], tasks: { [keyOf(beta)]: listReply(task(at(-MINUTE))) }, canRun: () => false });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  const before = structuredClone([...f.database.rows]);
  await f.wakes.tick();
  assert.deepEqual(f.calls, { start: [], rest: [], list: [], balance: [], notified: [] });
  assert.deepEqual([...f.database.rows], before);
});

test("a kernel that does not answer costs one observation and not the tick", async () => {
  const f = fixture({ projects: [beta], running: [alpha, beta], tasks: { [keyOf(beta)]: listReply(task(at(3 * MINUTE))) } });
  f.state.listError.add(keyOf(alpha));
  const failed = outcomeCount("observe_failed");
  await f.wakes.tick();
  assert.equal(outcomeCount("observe_failed"), failed + 1);
  assert.equal(f.row(beta).next_due_at, at(3 * MINUTE), "the project after it was observed");
  assert.equal(f.row(alpha), undefined, "and nothing was invented for the one that did not answer");
});

test("a runtime this woke rests when its work is done and nobody has it open, and not before", async () => {
  const f = fixture({ projects: [alpha], tasks: { [keyOf(alpha)]: futureTask } });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  await f.wakes.tick();
  assert.equal(f.live.has(keyOf(alpha)), true);
  const rested = outcomeCount("rested");
  f.clock.t += 10 * MINUTE - 1;
  await f.wakes.tick();
  assert.deepEqual(f.calls.rest, [], "ten quiet minutes have not passed");
  f.clock.t += 1;
  f.idle[keyOf(alpha)] = false;
  await f.wakes.tick();
  assert.deepEqual(f.calls.rest, [], "a runtime that is working or open on a page is left alone");
  f.idle[keyOf(alpha)] = true;
  await f.wakes.tick();
  assert.deepEqual(f.calls.rest, [keyOf(alpha)]);
  assert.equal(outcomeCount("rested"), rested + 1);
  assert.equal(f.live.has(keyOf(alpha)), false);
  // It is not held again: the next ticks do not rest what is no longer there.
  await f.wakes.tick();
  assert.equal(f.calls.rest.length, 1);
});

test("a woken runtime whose next task is close stays up for it, and rests once that is delivered", async () => {
  const f = fixture({ projects: [alpha], tasks: { [keyOf(alpha)]: futureTask } });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  await f.wakes.tick();
  f.clock.t += 11 * MINUTE;
  f.tasks[keyOf(alpha)] = listReply(task(at(11 * MINUTE + 4 * MINUTE)));
  await f.wakes.tick();
  assert.deepEqual(f.calls.rest, [], "starting it again in four minutes would cost more than keeping it");
  f.clock.t += 5 * MINUTE;
  f.tasks[keyOf(alpha)] = futureTask;
  await f.wakes.tick();
  assert.deepEqual(f.calls.rest, [keyOf(alpha)]);
});

test("a woken runtime that went away on its own is forgotten and never rested", async () => {
  const f = fixture({ projects: [alpha], tasks: { [keyOf(alpha)]: futureTask } });
  f.database.rows.set(keyOf(alpha), { user_id: "u1", project_id: "alpha", next_due_at: at(-MINUTE), retry_at: null, last_outcome: null });
  await f.wakes.tick();
  f.live.delete(keyOf(alpha));
  f.clock.t += 30 * MINUTE;
  await f.wakes.tick();
  assert.deepEqual(f.calls.rest, []);
  assert.equal(f.wakes.woken.size, 0);
});

test("a runtime a person started is never rested by the wake", async () => {
  const f = fixture({ projects: [alpha], running: [alpha], tasks: { [keyOf(alpha)]: futureTask } });
  for (let minute = 0; minute < 30; minute += 5) { f.clock.t = T0 + minute * MINUTE; await f.wakes.tick(); }
  assert.deepEqual(f.calls.rest, []);
  assert.deepEqual(f.calls.start, []);
});

test("the timer ticks until it is stopped, and stopping waits for a tick under way", async () => {
  const f = fixture({ running: [alpha], tasks: { [keyOf(alpha)]: futureTask } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = f.wakes.runtimes.listTasks;
  f.wakes.runtimes.listTasks = async (target) => { await gate; return original(target); };
  f.wakes.start(5);
  f.wakes.start(5);
  const deadline = Date.now() + 2_000;
  while (!f.wakes.ticking && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(f.wakes.ticking, "a tick is under way");
  let stopped = false;
  const stopping = f.wakes.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, "stop waits for the tick in flight");
  release();
  await stopping;
  assert.equal(f.wakes.timer, null);
  const asked = f.calls.list.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.calls.list.length, asked, "nothing ticks after stop");
});

test("every outcome the module records is one the operator's counter names", () => {
  const family = scheduleWakeMetricFamilies()[0];
  assert.equal(family.name, "open_science_schedule_wake_total");
  assert.deepEqual(family.series.map((series) => series.labels.outcome), [...SCHEDULE_WAKE_OUTCOMES]);
  assert.ok(family.series.every((series) => Number.isSafeInteger(series.value) && series.value >= 0));
});
