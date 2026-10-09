// The runtime's door to the scheduled tasks: `schedule_task` makes one and `update_task` changes one (design reference §14.2
// 「在对话里创建与修改」, N-13).
//
// The same shape as every internal gateway (layer 3): one path, one handler, one allowlist of operations and fields, and the
// runtime's own gateway token as the only credential. The token — never anything the run says — names the account and the
// project, so a run can only ever make tasks in the project it runs in, and only ever find tasks of that project: a task of
// another project or another account is `task_not_found`, exactly as if it did not exist.
//
//   POST /internal/tasks/v1/schedule  { instruction, schedule, title? }                              -> the task, made and started
//   POST /internal/tasks/v1/update    { taskId, instruction?, schedule?, title?, paused? }           -> the task as it now stands
//
// Hidden knowledge:
//
// - A task made here is the task form's twin: `AutopilotService.create` then `.start`, with the platform's default budgets and
//   stopping rules (`AGENDA_DEFAULT_BUDGETS`, the task form's own task types), and no step to approve — the owner's rulings of
//   2026-09-19 and 2026-09-20. The conversation names a thing to keep doing and a moment; it never names a price. An edit goes
//   through the same service methods and validation as the PATCH / start / stop routes (`autopilotRoutes.mjs`).
// - Idempotent by what was asked, not by an id the runtime would have to invent: a task with this instruction and this schedule
//   already in the project is returned as it is (`created: false`) instead of made again, so a model that retries after a lost
//   answer — or says it twice — leaves one task, not two.
// - A task is named by its own id, or by an execution of it: a scheduled execution's conversation carries the execution's id (the
//   platform's brief), and 「改到每周一 8 点」 said there means the task that execution belongs to.
// - An execution of a task does not make or change tasks: a bounded runtime's token names a run, and a task that schedules tasks is
//   a loop nobody asked for. That is `task_tools_not_in_conversation`. (An execution that runs in the researcher's own runtime
//   carries no such mark; what holds it is the per-minute ceiling and `taskToolsMaxTasks`.)
// - The answer is facts only: id, title, the schedule as data and in words, the zone, the next run and the state. Nothing in it
//   tells the model what to do next; that travels in the tool's own summary.
// - A malformed or impossible call comes back as the run's to fix, with the project's tasks beside a wrong id so the next call can
//   be right. A feature that is off answers `task_tools_disabled`, which the tool turns into a plain sentence to the researcher.

import {
  AGENDA_DEFAULT_BUDGETS, DISPLAY_TIME_ZONE, TASK_INSTRUCTION_MAX_CHARS, TASK_TITLE_MAX_CHARS, TASK_TOOLS_DEFAULT_MAX_TASKS,
  agendaInstantText, agendaNextOccurrence, agendaZoneName, describeAgendaSchedule, normalizeAgendaSchedule, validateAgendaSchedule,
} from "@evimed/domain";
import { HttpError, readJson, sendJson } from "./security.mjs";

export const TASK_TOOLS_GATEWAY_PATH = "/internal/tasks/v1";
const OPERATIONS = Object.freeze({
  schedule: ["instruction", "schedule", "title"],
  update: ["taskId", "instruction", "schedule", "title", "paused"],
});
const SCHEDULE_FIELDS = Object.freeze(["kind", "time", "date", "weekdays", "timeZone"]);
/** An instruction is at most 20,000 characters, which is up to 60 KB of UTF-8; the rest of a call is small. */
const MAX_BODY_BYTES = 128 * 1024;
/** What a run does in a minute is a handful of calls; the ceiling is for a loop, not a researcher. */
const WINDOW_LIMIT = 30;
/** The task types the task form starts a task with: the planner chooses among them for each execution. */
const TASK_TYPES = Object.freeze(["literature-sentinel"]);
/** A task is named by its own id (`agenda-…`) or by an execution of it (`episode-…`). */
const TASK_ID = /^(?:agenda|episode)-[A-Za-z0-9-]{1,160}$/;
/** How many of a project's tasks a refusal lists beside a wrong id. */
const CANDIDATES = 20;
const SCHEDULE_RULES = "The schedule needs kind (once, daily or weekly), time HH:MM on a 24-hour clock, weekdays 1-7 (1 = Monday) when weekly, a date YYYY-MM-DD when once, and an IANA time zone.";

/** A refusal that also carries the project's tasks, so the next call can name one. */
class TaskToolsRefusal extends HttpError {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, any>[]} [tasks] */
  constructor(status, code, message, tasks = []) {
    super(status, code, message);
    /** @type {Record<string, any>[]} */
    this.tasks = tasks;
  }
}

/**
 * @param {{ config: any, runtimeManager: any, store: any, service: any, now?: () => Date }} dependencies
 */
export function createTaskToolsGateway({ config, runtimeManager, store, service, now = () => new Date() }) {
  /** @type {Map<string, { until: number, count: number }>} */
  const windows = new Map();
  const maxTasks = Math.max(1, Number(config.taskToolsMaxTasks) || TASK_TOOLS_DEFAULT_MAX_TASKS);

  /** @param {any} agenda @param {Record<string, any>} [extra] the task as the page would project it, stated as facts */
  const facts = (agenda, extra = {}) => {
    const view = service.projectAgenda(agenda);
    const schedule = view.payload.schedule;
    const next = view.payload.nextRunAt ?? null;
    return {
      taskId: view.id, title: view.payload.title,
      schedule: { kind: schedule.kind, time: schedule.time, ...(schedule.date ? { date: schedule.date } : {}), ...(schedule.weekdays ? { weekdays: schedule.weekdays } : {}), timeZone: schedule.timeZone },
      scheduleText: describeAgendaSchedule(schedule, now()), timeZone: schedule.timeZone, timeZoneName: agendaZoneName(schedule.timeZone),
      nextRunAt: next, nextRunText: next ? agendaInstantText(next, schedule.timeZone) : null, state: view.payload.scheduleState,
      ...extra,
    };
  };

  /** The project's tasks that are not deleted, as the page projects them. @param {any} user @param {any} project */
  const tasksOf = async (user, project) => (await service.list(user.id, { projectId: project.id })).items;

  /** @param {any} user @param {any} project @returns {Promise<Record<string, any>[]>} */
  const candidates = async (user, project) => (await tasksOf(user, project)).slice(0, CANDIDATES)
    .map((item) => ({ taskId: item.id, title: item.payload.title, scheduleText: describeAgendaSchedule(item.payload.schedule, now()), state: item.payload.scheduleState }));

  /** @param {unknown} value @returns {string} what the researcher said, exactly as they said it */
  const instructionOf = (value) => {
    if (typeof value !== "string" || !value.trim() || value.length > TASK_INSTRUCTION_MAX_CHARS || value.includes("\0")) {
      throw new HttpError(400, "task_instruction_invalid", `instruction must be a non-empty string of at most ${TASK_INSTRUCTION_MAX_CHARS} characters.`);
    }
    return value;
  };
  /** @param {unknown} value @returns {string} */
  const titleOf = (value) => {
    if (typeof value !== "string" || !value.trim() || value.length > TASK_TITLE_MAX_CHARS || value.includes("\0")) {
      throw new HttpError(400, "task_title_invalid", `title must be a non-empty string of at most ${TASK_TITLE_MAX_CHARS} characters.`);
    }
    return value.trim();
  };
  /**
   * The schedule a call asks for: what it names, over what the task already has (an update says only what changes), the platform's
   * zone where none is named. Fields that belong to another kind are not carried over — a weekly task made once-only forgets its
   * weekdays — and a call that names a field of the wrong kind is refused by the domain's own validation.
   * @param {unknown} input @param {Record<string, any> | null} [current]
   */
  const scheduleOf = (input, current = null) => {
    if (input == null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !SCHEDULE_FIELDS.includes(key))) {
      throw new HttpError(400, "task_schedule_invalid", SCHEDULE_RULES);
    }
    const asked = /** @type {Record<string, any>} */ (input);
    const merged = { ...(current ?? {}), ...asked };
    if (merged.kind !== "once" && asked.date === undefined) delete merged.date;
    if (merged.kind !== "weekly" && asked.weekdays === undefined) delete merged.weekdays;
    if (merged.timeZone == null) merged.timeZone = DISPLAY_TIME_ZONE;
    let schedule;
    try { schedule = validateAgendaSchedule(merged); } catch { throw new HttpError(400, "task_schedule_invalid", SCHEDULE_RULES); }
    // A one-time task whose moment has passed would run at once, as the one run it has (catch-up): never what was meant.
    if (schedule.kind === "once" && !agendaNextOccurrence(schedule, null, now())) {
      throw new HttpError(400, "task_schedule_in_past", `${schedule.date} ${schedule.time} (${schedule.timeZone}) has already passed; a one-time task needs a moment still to come.`);
    }
    return schedule;
  };

  /** What a service refusal means to the run: the task's own words where the service is naming a task, its own code otherwise. @param {unknown} error */
  const refusal = (error) => {
    if (!(error instanceof HttpError)) return error;
    if (error.code === "autopilot_revision_conflict") return new HttpError(409, "task_revision_conflict", "The task changed while it was being updated; call again.");
    if (error.code === "autopilot_agenda_not_found" || error.code === "autopilot_episode_not_found" || error.code === "autopilot_archived") {
      return new HttpError(404, "task_not_found", "No such task in this project.");
    }
    return error;
  };

  /**
   * The task a call names, or `task_not_found` — also for one that is another project's, another account's or deleted: what the call
   * cannot see is not there. A refusal lists the project's tasks.
   * @param {any} user @param {any} project @param {unknown} taskId
   */
  const resolveTask = async (user, project, taskId) => {
    if (typeof taskId !== "string" || !TASK_ID.test(taskId)) {
      throw new TaskToolsRefusal(400, "task_id_invalid", "taskId must be the id schedule_task answered with (agenda-…), or an Episode ID (episode-…).", await candidates(user, project));
    }
    let agenda = null;
    try {
      if (taskId.startsWith("episode-")) {
        const episode = await service.getEpisode(user.id, taskId);
        if (episode.projectId === project.id) agenda = await service.get(user.id, episode.payload.agendaId);
      } else {
        agenda = await service.get(user.id, taskId);
      }
    } catch (error) {
      const known = refusal(error);
      if (!(known instanceof HttpError && known.code === "task_not_found")) throw known;
    }
    if (!agenda || agenda.projectId !== project.id || agenda.payload.archivedAt) {
      throw new TaskToolsRefusal(404, "task_not_found", "No such task in this project.", await candidates(user, project));
    }
    return agenda;
  };

  /** @param {any} user @param {any} project @param {Record<string, any>} input */
  const schedule = async (user, project, input) => {
    const instruction = instructionOf(input.instruction);
    const when = scheduleOf(input.schedule);
    const title = input.title === undefined ? (instruction.trim().split(/\r?\n/)[0] ?? "").trim().slice(0, 60) || instruction.trim().slice(0, 60) : titleOf(input.title);
    const existing = await tasksOf(user, project);
    const same = existing.find((item) => item.payload.prompt === instruction && JSON.stringify(item.payload.schedule) === JSON.stringify(when));
    if (same) return facts(same, { created: false });
    if (existing.length >= maxTasks) {
      throw new HttpError(409, "task_limit_reached", `This project already holds ${existing.length} scheduled tasks; delete or pause one before scheduling another.`);
    }
    const made = await service.create(user.id, { projectId: project.id, title, prompt: instruction, taskTypes: [...TASK_TYPES], ...AGENDA_DEFAULT_BUDGETS, schedule: when });
    try {
      return facts(await service.start(user.id, made.id, { expectedRevision: made.revision }), { created: true });
    } catch (error) {
      // A task that could not be started is not left behind paused for the researcher to find: they were not asked to approve one.
      await service.archive(user.id, made.id, { expectedRevision: made.revision }).catch(() => null);
      throw error;
    }
  };

  /** One pass of an update over the task as it now stands. @param {any} user @param {any} project @param {Record<string, any>} input */
  const updateOnce = async (user, project, input) => {
    let agenda = await resolveTask(user, project, input.taskId);
    /** @type {string[]} */
    const changed = [];
    /** @type {Record<string, any>} */
    const patch = {};
    if (input.instruction !== undefined) {
      const instruction = instructionOf(input.instruction);
      if (instruction !== agenda.payload.prompt) { patch.prompt = instruction; changed.push("instruction"); }
    }
    if (input.title !== undefined) {
      const title = titleOf(input.title);
      if (title !== agenda.payload.title) { patch.title = title; changed.push("title"); }
    }
    if (input.schedule !== undefined) {
      const standing = normalizeAgendaSchedule(agenda.payload);
      const next = scheduleOf(input.schedule, standing);
      if (JSON.stringify(next) !== JSON.stringify(standing)) { patch.schedule = next; changed.push("schedule"); }
    }
    if (input.paused !== undefined && typeof input.paused !== "boolean") throw new HttpError(400, "task_paused_invalid", "paused must be true (pause) or false (re-enable).");
    if (Object.keys(patch).length) agenda = await service.update(user.id, agenda.id, { expectedRevision: agenda.revision, ...patch });
    const active = agenda.payload.enabled && agenda.payload.status === "active" && !agenda.payload.archivedAt;
    if (input.paused === true && active) { agenda = await service.stop(user.id, agenda.id, { expectedRevision: agenda.revision }); changed.push("paused"); }
    else if (input.paused === false && !active) { agenda = await service.start(user.id, agenda.id, { expectedRevision: agenda.revision }); changed.push("resumed"); }
    return facts(agenda, { changed });
  };

  /** @param {any} user @param {any} project @param {Record<string, any>} input */
  const update = async (user, project, input) => {
    if (input.taskId !== undefined && !["instruction", "schedule", "title", "paused"].some((field) => input[field] !== undefined)) {
      // Still names a task first, so a wrong id is a wrong id and not a call that changes nothing.
      await resolveTask(user, project, input.taskId);
      throw new HttpError(400, "task_update_empty", "Nothing to change: pass instruction, schedule, title or paused.");
    }
    try {
      return await updateOnce(user, project, input);
    } catch (error) {
      // The task moved under the call (the researcher edited it on the page at the same moment): once more, from where it now stands.
      if (!(error instanceof HttpError) || error.code !== "autopilot_revision_conflict") throw refusal(error);
      try { return await updateOnce(user, project, input); } catch (second) { throw refusal(second); }
    }
  };

  /** @param {any} req @param {any} res @param {(failure: { code: string, status: number }) => void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      const url = new URL(req.url ?? "/", "http://evimed.local");
      const operation = url.pathname.startsWith(`${TASK_TOOLS_GATEWAY_PATH}/`) ? url.pathname.slice(TASK_TOOLS_GATEWAY_PATH.length + 1) : "";
      if (req.method !== "POST" || !Object.hasOwn(OPERATIONS, operation) || url.search) throw new HttpError(404, "not_found", "Not found.");
      const header = String(req.headers?.authorization ?? "").trim();
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
      if (!token) throw new HttpError(401, "task_tools_gateway_token_missing", "Scheduled-task authentication failed.");
      let identity;
      try { identity = runtimeManager.assertActiveModelGatewayToken(token); } catch {
        throw new HttpError(401, "task_tools_gateway_token_invalid", "Scheduled-task authentication failed.");
      }
      // A bounded runtime is a scheduled execution (or a re-check of one): it does not make or change tasks.
      if (identity.runId != null) throw new HttpError(403, "task_tools_not_in_conversation", "A scheduled execution cannot make or change tasks.");
      if (!config.taskToolsEnabled || !service) {
        throw new HttpError(503, "task_tools_disabled", "Scheduling a task from a conversation is switched off for this deployment; the researcher can add it on the 定时任务 page.");
      }
      const at = Date.now();
      for (const [key, window] of windows) if (window.until <= at) windows.delete(key);
      const key = `${identity.userId}\u0000${identity.projectId}`;
      const window = windows.get(key) ?? { until: at + 60_000, count: 0 };
      windows.set(key, window);
      if (++window.count > WINDOW_LIMIT) throw new HttpError(429, "task_tools_rate_limited", "Too many scheduled-task calls in a minute.");
      const user = await store.userById(identity.userId);
      if (!user) throw new HttpError(401, "task_tools_gateway_token_invalid", "Scheduled-task authentication failed.");
      const project = await store.requireProject(user, identity.projectId);
      const input = await readJson(req, MAX_BODY_BYTES).catch((error) => {
        throw error instanceof HttpError && error.status === 413
          ? new HttpError(413, "task_tools_request_too_large", "The request was too large.")
          : new HttpError(400, "task_tools_request_invalid", "The request was not a JSON object.");
      });
      const allowed = /** @type {readonly string[]} */ (OPERATIONS[/** @type {keyof typeof OPERATIONS} */ (operation)]);
      if (Object.keys(input).some((field) => !allowed.includes(field))) throw new HttpError(400, "task_tools_request_invalid", `${operation} takes: ${allowed.join(", ")}.`);
      let data;
      try {
        data = operation === "schedule" ? await schedule(user, project, input) : await update(user, project, input);
      } catch (error) { throw refusal(error); }
      sendJson(res, 200, { data });
    } catch (error) {
      const known = error instanceof HttpError;
      const safe = known ? error : new HttpError(503, "task_tools_unavailable", "Scheduled tasks are unavailable; the researcher can add the task on the 定时任务 page.");
      onFailure?.({ code: safe.code, status: safe.status });
      sendJson(res, safe.status, { error: safe.message, code: safe.code, ...(error instanceof TaskToolsRefusal && error.tasks.length ? { tasks: error.tasks } : {}) });
    }
  };
}
