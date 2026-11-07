// Waking a project's runtime when one of its scheduled tasks falls due.
//
// The kernel's automation tasks (`@deepseek-ai/dsh-schedule`) are the product's scheduled tasks. They keep their own store on the
// project's volume and deliver by themselves, but only "while the Host is running", and here the Host is a container that stops after
// an idle period, gives way to another project and is removed at a release. So this holds the one fact the kernel cannot act on while
// it is down: when this project's next task falls due. Everything else stays upstream's: at start the kernel delivers what was missed,
// the latest occurrence of each task once, so a wake that comes late, or twice, changes nothing.
//
//   observe  while a runtime is up, ask it (`schedule/list`) and keep the earliest due time of its active tasks
//   wake     a stopped runtime with a task due is started, within what the account may spend and the deployment has room for
//   rest     a runtime this woke, once its work is done and nobody has it open, stops again instead of holding its slot for hours
//
// Deletable when the kernel can be woken by something outside it, or when a runtime no longer stops.

import { recordScheduleWake } from "./scheduleWakeMetrics.mjs";

const PAGE = 500;
/** Starts one tick may ask for. A nine-o'clock crowd is taken a few at a time; the rest are due still at the next tick. */
const WAKES_PER_TICK = 2;
const RETRY_FULL_MS = 60_000;
const RETRY_FAILED_MS = 5 * 60_000;
const RETRY_NO_BALANCE_MS = 60 * 60_000;

/**
 * When a task list next needs a running kernel: the earliest due time of its active tasks, held back by the delivery floor the kernel
 * applies itself. Null when nothing is active.
 * @param {any} reply the value of `schedule/list`
 * @returns {string | null} an ISO instant
 */
export function nextDueOf(reply) {
  const tasks = Array.isArray(reply?.items) ? reply.items : [];
  let earliest = Number.POSITIVE_INFINITY;
  for (const task of tasks) {
    if (task?.status !== "active") continue;
    const due = Math.max(Date.parse(task.scheduledAt) || 0, Date.parse(task.deliveryFloorEndsAt) || 0);
    if (due > 0 && due < earliest) earliest = due;
  }
  return Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
}

export class ScheduleWakes {
  /**
   * @param {{
   *   database: any,
   *   runtimes: {
   *     liveProjects: () => any[],
   *     isRunning: (project: any) => boolean,
   *     listTasks: (project: any) => Promise<any>,
   *     start: (project: any) => Promise<any>,
   *     idle: (project: any) => Promise<boolean>,
   *     rest: (project: any) => Promise<boolean>,
   *   },
   *   resolveProject: (userId: string, projectId: string) => Promise<any>,
   *   assertBalance: (userId: string) => Promise<void>,
   *   notifyNoBalance: (project: any) => Promise<void>,
   *   canRun?: () => boolean,
   *   now?: () => number,
   *   restAfterMs?: number,
   * }} input
   */
  constructor({ database, runtimes, resolveProject, assertBalance, notifyNoBalance, canRun = () => true, now = Date.now, restAfterMs = 10 * 60_000 }) {
    this.database = database;
    this.runtimes = runtimes;
    this.resolveProject = resolveProject;
    this.assertBalance = assertBalance;
    this.notifyNoBalance = notifyNoBalance;
    this.canRun = canRun;
    this.now = now;
    this.restAfterMs = restAfterMs;
    /** Runtimes this started, by project key, until they rest or someone uses them. @type {Map<string, {project: any, at: number}>} */
    this.woken = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {Promise<void> | null} */
    this.ticking = null;
  }

  /** @param {number} [everyMs] */
  start(everyMs = 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.ticking ??= this.tick().finally(() => { this.ticking = null; }); }, everyMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => {});
  }

  async migrate() {
    await this.database.query(`CREATE TABLE IF NOT EXISTS evimed_control.schedule_wakes (
      user_id text NOT NULL, project_id text NOT NULL, next_due_at timestamptz, retry_at timestamptz, last_outcome text,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, project_id),
      FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects (user_id, id) ON DELETE CASCADE)`);
    await this.database.query(`CREATE INDEX IF NOT EXISTS schedule_wakes_due ON evimed_control.schedule_wakes (next_due_at) WHERE next_due_at IS NOT NULL`);
  }

  /** @param {any} project */
  async observe(project) {
    const reply = await this.runtimes.listTasks(project);
    const nextDue = nextDueOf(reply);
    await this.database.query(`INSERT INTO evimed_control.schedule_wakes (user_id, project_id, next_due_at, retry_at, updated_at)
      VALUES ($1, $2, $3, NULL, now())
      ON CONFLICT (user_id, project_id) DO UPDATE SET next_due_at = EXCLUDED.next_due_at, retry_at = NULL, updated_at = now()`,
    [project.userId, project.id, nextDue]);
    return nextDue;
  }

  async tick() {
    if (!this.canRun()) return;
    for (const project of this.runtimes.liveProjects()) {
      await this.observe(project).catch(() => recordScheduleWake("observe_failed"));
    }
    await this.#wakeDue().catch(() => recordScheduleWake("tick_failed"));
    await this.#restWoken().catch(() => recordScheduleWake("tick_failed"));
  }

  async #wakeDue() {
    const at = new Date(this.now()).toISOString();
    const { rows } = await this.database.query(`SELECT user_id, project_id FROM evimed_control.schedule_wakes
      WHERE next_due_at <= $1 AND (retry_at IS NULL OR retry_at <= $1) ORDER BY next_due_at LIMIT $2`, [at, PAGE]);
    let started = 0;
    for (const row of rows) {
      if (started >= WAKES_PER_TICK) return;
      const project = await this.resolveProject(row.user_id, row.project_id).catch(() => null);
      // A running kernel delivers by itself; a project gone takes its row with it, and this one is a race with that.
      if (!project || this.runtimes.isRunning(project)) continue;
      started += 1;
      await this.#wake(project);
    }
  }

  /** @param {any} project */
  async #wake(project) {
    try {
      await this.assertBalance(project.userId);
    } catch {
      await this.#defer(project, "no_balance", RETRY_NO_BALANCE_MS);
      recordScheduleWake("no_balance");
      await this.notifyNoBalance(project).catch(() => {});
      return;
    }
    try {
      await this.runtimes.start(project);
    } catch (error) {
      const full = /** @type {any} */ (error)?.code === "runtime_capacity_full";
      await this.#defer(project, full ? "no_room" : "failed", full ? RETRY_FULL_MS : RETRY_FAILED_MS);
      recordScheduleWake(full ? "no_room" : "failed");
      return;
    }
    this.woken.set(`${project.userId}/${project.id}`, { project, at: this.now() });
    recordScheduleWake("woken");
    await this.observe(project).catch(() => recordScheduleWake("observe_failed"));
  }

  /** @param {any} project @param {string} outcome @param {number} afterMs */
  async #defer(project, outcome, afterMs) {
    await this.database.query(`UPDATE evimed_control.schedule_wakes SET retry_at = $3, last_outcome = $4, updated_at = now() WHERE user_id = $1 AND project_id = $2`,
      [project.userId, project.id, new Date(this.now() + afterMs).toISOString(), outcome]);
  }

  /** A runtime this woke does not hold its slot for the hours a person's does: nobody is coming back to it. */
  async #restWoken() {
    for (const [key, entry] of this.woken) {
      if (!this.runtimes.isRunning(entry.project)) { this.woken.delete(key); continue; }
      if (this.now() - entry.at < this.restAfterMs) continue;
      const next = Date.parse(await this.observe(entry.project).catch(() => null) ?? "") || Number.POSITIVE_INFINITY;
      if (next - this.now() < this.restAfterMs) continue;
      if (!await this.runtimes.idle(entry.project)) continue;
      if (await this.runtimes.rest(entry.project)) { this.woken.delete(key); recordScheduleWake("rested"); }
    }
  }
}
