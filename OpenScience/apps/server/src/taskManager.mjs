import path from "node:path";
import { HttpError, appendJsonLineNoFollow, randomId, readTextFileNoFollow, writeJsonFileAtomicNoFollow } from "./security.mjs";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "timed_out"]);
const ACTIVE_STATUSES = new Set(["queued", "running", "canceling"]);
const MAX_PERSISTED_TASKS_PER_PROJECT = 500;

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotRequest(req) {
  return {
    url: req.url,
    headers: { ...req.headers },
    socket: { encrypted: Boolean(req.socket?.encrypted) },
  };
}

function publicTask(task) {
  return {
    id: task.id,
    command: task.command,
    status: task.status,
    userId: task.userId,
    projectId: task.projectId,
    createdAt: task.createdAt,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
  };
}

function projectKey(project) {
  return `${project.userId}:${project.id}`;
}

function taskStateFile(project) {
  return path.join(project.metaDir, "tasks-state.json");
}

function persistedTask(task) {
  return {
    id: task.id,
    command: task.command,
    status: task.status,
    userId: task.userId,
    projectId: task.projectId,
    createdAt: task.createdAt,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
  };
}

function hydrateTaskRecord(record, project) {
  if (!record || typeof record !== "object") return null;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.command !== "string" || !record.command) return null;
  if (record.userId !== project.userId || record.projectId !== project.id) return null;
  const task = {
    id: record.id,
    command: record.command,
    args: {},
    status: typeof record.status === "string" ? record.status : "failed",
    userId: project.userId,
    projectId: project.id,
    user: null,
    project,
    ctx: null,
    controller: new AbortController(),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : nowIso(),
    queuedAt: typeof record.queuedAt === "string" ? record.queuedAt : null,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
    finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null,
    error: record.error && typeof record.error === "object" ? record.error : null,
    timedOut: false,
    runPromise: null,
    historical: true,
  };
  if (ACTIVE_STATUSES.has(task.status)) {
    task.status = "failed";
    task.finishedAt = nowIso();
    task.error = {
      code: "server_restarted",
      message: "Server restarted before the task completed.",
    };
  }
  if (!TERMINAL_STATUSES.has(task.status) && !ACTIVE_STATUSES.has(task.status)) {
    task.status = "failed";
    task.finishedAt = task.finishedAt ?? nowIso();
    task.error = { code: "task_state_invalid", message: "Persisted task state was invalid." };
  }
  return task;
}

async function appendTaskEvent(task, event, maxLogFileBytes) {
  const file = path.join(task.project.metaDir, "tasks.jsonl");
  await appendJsonLineNoFollow(task.project.rootDir, file, {
    taskId: task.id,
    command: task.command,
    userId: task.userId,
    projectId: task.projectId,
    status: task.status,
    event,
    error: task.error,
    createdAt: nowIso(),
  }, {
    maxBytes: maxLogFileBytes,
  });
}

function timeoutError(ms) {
  return new HttpError(504, "command_timeout", `Command exceeded ${ms}ms timeout.`);
}

function positiveLimit(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function queueFull(scope, limit) {
  return new HttpError(429, "task_queue_full", `Too many queued tasks for ${scope}; limit is ${limit}.`, {
    retryAfterSeconds: 5,
  });
}

export class TaskManager {
  constructor(config, invokeCommand) {
    this.config = config;
    this.invokeCommand = invokeCommand;
    this.tasks = new Map();
    this.queue = [];
    this.active = 0;
    this.activeByProject = new Map();
    this.hydratedProjects = new Set();
    this.projectHydrations = new Map();
    this.projectStateWrites = new Map();
  }

  async enqueue(command, args, ctx) {
    await this.hydrateProject(ctx.project);
    this.assertQueueCapacity(ctx.project);
    const task = {
      id: randomId("task_"),
      command,
      args,
      status: "queued",
      userId: ctx.user.id,
      projectId: ctx.project.id,
      user: ctx.user,
      project: ctx.project,
      ctx: {
        config: ctx.config,
        store: ctx.store,
        runtimeManager: ctx.runtimeManager,
        commands: ctx.commands,
        req: snapshotRequest(ctx.req),
        res: null,
        user: ctx.user,
        project: ctx.project,
      },
      controller: new AbortController(),
      createdAt: nowIso(),
      queuedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      error: null,
      timedOut: false,
      runPromise: null,
    };
    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    await this.persistProject(ctx.project);
    await appendTaskEvent(task, "queued", this.config.maxLogFileBytes).catch(() => {});
    this.drain();
    return publicTask(task);
  }

  async list(ctx) {
    await this.hydrateProject(ctx.project);
    return [...this.tasks.values()]
      .filter((task) => this.canAccess(task, ctx))
      .map((task) => publicTask(task))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async stats(ctx) {
    await this.hydrateProject(ctx.project);
    const counts = {
      queued: 0,
      running: 0,
      canceling: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
      timed_out: 0,
    };
    for (const task of this.tasks.values()) {
      if (!this.canAccess(task, ctx)) continue;
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    return {
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      active: counts.running + counts.canceling,
      queued: counts.queued,
      byStatus: counts,
    };
  }

  statsAll() {
    const counts = {
      queued: 0,
      running: 0,
      canceling: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
      timed_out: 0,
    };
    for (const task of this.tasks.values()) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    return {
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      active: this.active,
      queued: this.queue.length,
      byStatus: counts,
      concurrency: {
        maxGlobal: this.config.maxConcurrentTasks,
        maxPerProject: this.config.maxConcurrentTasksPerProject,
      },
      queueLimits: {
        maxGlobal: positiveLimit(this.config.maxQueuedTasks),
        maxPerProject: positiveLimit(this.config.maxQueuedTasksPerProject),
      },
    };
  }

  async hasActiveProject(project) {
    await this.hydrateProject(project);
    for (const task of this.tasks.values()) {
      if (
        task.userId === project.userId &&
        task.projectId === project.id &&
        ACTIVE_STATUSES.has(task.status)
      ) {
        return true;
      }
    }
    return false;
  }

  purgeProject(project) {
    const key = projectKey(project);
    this.queue = this.queue.filter((id) => {
      const task = this.tasks.get(id);
      return !(task?.userId === project.userId && task?.projectId === project.id);
    });
    for (const [id, task] of this.tasks) {
      if (task.userId === project.userId && task.projectId === project.id) {
        this.tasks.delete(id);
      }
    }
    this.activeByProject.delete(key);
    this.hydratedProjects.delete(key);
  }

  purgeUser(user) {
    this.queue = this.queue.filter((id) => this.tasks.get(id)?.userId !== user.id);
    for (const [id, task] of this.tasks) {
      if (task.userId === user.id) this.tasks.delete(id);
    }
    for (const key of [...this.activeByProject.keys()]) {
      if (key.startsWith(`${user.id}:`)) this.activeByProject.delete(key);
    }
    for (const key of [...this.hydratedProjects.keys()]) {
      if (key.startsWith(`${user.id}:`)) this.hydratedProjects.delete(key);
    }
  }

  async get(ctx, taskId) {
    await this.hydrateProject(ctx.project);
    const task = this.requireTask(ctx, taskId);
    return publicTask(task);
  }

  async cancel(ctx, taskId) {
    await this.hydrateProject(ctx.project);
    const task = this.requireTask(ctx, taskId);
    if (TERMINAL_STATUSES.has(task.status)) {
      return publicTask(task);
    }
    if (task.status === "queued") {
      task.status = "canceled";
      task.finishedAt = nowIso();
      task.error = { code: "task_canceled", message: "Task was canceled before it started." };
      this.queue = this.queue.filter((id) => id !== task.id);
      await this.persistProject(task.project);
      await appendTaskEvent(task, "canceled", this.config.maxLogFileBytes).catch(() => {});
      return publicTask(task);
    }
    task.status = "canceling";
    task.error = { code: "task_canceling", message: "Cancellation requested." };
    task.controller.abort();
    await this.persistProject(task.project);
    await appendTaskEvent(task, "canceling", this.config.maxLogFileBytes).catch(() => {});
    return publicTask(task);
  }

  async close() {
    const running = [];
    const changedProjects = new Map();
    for (const task of this.tasks.values()) {
      if (ACTIVE_STATUSES.has(task.status)) {
        task.status = "canceled";
        task.finishedAt = task.finishedAt ?? nowIso();
        task.error = { code: "server_shutdown", message: "Server shut down before the task completed." };
        task.controller.abort();
        if (task.project) changedProjects.set(projectKey(task.project), task.project);
        await appendTaskEvent(task, "canceled", this.config.maxLogFileBytes).catch(() => {});
        if (task.runPromise) running.push(task.runPromise.catch(() => {}));
      }
    }
    this.queue = [];
    await Promise.all([...changedProjects.values()].map((project) => this.persistProject(project).catch(() => {})));
    await Promise.race([Promise.allSettled(running), delay(2_000)]);
  }

  async hydrateProject(project) {
    const key = projectKey(project);
    if (this.hydratedProjects.has(key)) return;
    const existing = this.projectHydrations.get(key);
    if (existing) return existing;
    const hydration = this.loadProjectState(project, key);
    this.projectHydrations.set(key, hydration);
    try {
      await hydration;
    } finally {
      if (this.projectHydrations.get(key) === hydration) this.projectHydrations.delete(key);
    }
  }

  async loadProjectState(project, key) {
    const raw = await readTextFileNoFollow(project.rootDir, taskStateFile(project), "");
    if (!raw) {
      this.hydratedProjects.add(key);
      return;
    }
    let records = [];
    try {
      const parsed = JSON.parse(raw);
      records = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    } catch {
      this.hydratedProjects.add(key);
      return;
    }
    const recovered = [];
    for (const record of records) {
      if (this.tasks.has(record?.id)) continue;
      const task = hydrateTaskRecord(record, project);
      if (!task) continue;
      this.tasks.set(task.id, task);
      if (task.error?.code === "server_restarted") recovered.push(task);
    }
    if (recovered.length > 0) {
      await this.persistProject(project);
      await Promise.all(recovered.map((task) => appendTaskEvent(task, "server_restarted", this.config.maxLogFileBytes).catch(() => {})));
    }
    this.hydratedProjects.add(key);
  }

  persistProject(project) {
    const key = projectKey(project);
    const previous = this.projectStateWrites.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      // Build the snapshot only when this write reaches the front of the queue,
      // so an older running/canceling state cannot land after a terminal state.
      const records = [...this.tasks.values()]
        .filter((task) => task.userId === project.userId && task.projectId === project.id)
        .map((task) => persistedTask(task))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, MAX_PERSISTED_TASKS_PER_PROJECT);
      const file = taskStateFile(project);
      await writeJsonFileAtomicNoFollow(project.rootDir, file, { version: 1, tasks: records });
    });
    this.projectStateWrites.set(key, current);
    return current.finally(() => {
      if (this.projectStateWrites.get(key) === current) this.projectStateWrites.delete(key);
    });
  }

  canAccess(task, ctx) {
    return task.userId === ctx.user.id && task.projectId === ctx.project.id;
  }

  requireTask(ctx, taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !this.canAccess(task, ctx)) {
      throw new HttpError(404, "task_not_found", "Task not found.");
    }
    return task;
  }

  drain() {
    while (this.active < this.config.maxConcurrentTasks && this.queue.length > 0) {
      const index = this.queue.findIndex((id) => {
        const task = this.tasks.get(id);
        return task?.status === "queued" && this.hasProjectCapacity(task);
      });
      if (index === -1) break;
      const [id] = this.queue.splice(index, 1);
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      task.runPromise = this.run(task);
    }
  }

  hasProjectCapacity(task) {
    const max = this.config.maxConcurrentTasksPerProject;
    if (!Number.isFinite(max) || max <= 0) return true;
    return (this.activeByProject.get(projectKey(task.project)) ?? 0) < max;
  }

  assertQueueCapacity(project) {
    const maxGlobal = positiveLimit(this.config.maxQueuedTasks);
    if (maxGlobal != null && this.queue.length >= maxGlobal) {
      throw queueFull("the server", maxGlobal);
    }
    const maxProject = positiveLimit(this.config.maxQueuedTasksPerProject);
    if (maxProject != null && this.queuedCountForProject(project) >= maxProject) {
      throw queueFull("this project", maxProject);
    }
  }

  queuedCountForProject(project) {
    let count = 0;
    for (const id of this.queue) {
      const task = this.tasks.get(id);
      if (task?.status === "queued" && task.userId === project.userId && task.projectId === project.id) count++;
    }
    return count;
  }

  incrementProjectActive(task) {
    const key = projectKey(task.project);
    this.activeByProject.set(key, (this.activeByProject.get(key) ?? 0) + 1);
  }

  decrementProjectActive(task) {
    const key = projectKey(task.project);
    const next = (this.activeByProject.get(key) ?? 1) - 1;
    if (next > 0) this.activeByProject.set(key, next);
    else this.activeByProject.delete(key);
  }

  async run(task) {
    this.active++;
    this.incrementProjectActive(task);
    task.status = "running";
    task.startedAt = nowIso();
    await this.persistProject(task.project).catch(() => {});
    await appendTaskEvent(task, "started", this.config.maxLogFileBytes).catch(() => {});

    try {
      const work = this.invokeCommand(task.command, task.args, {
        ...task.ctx,
        signal: task.controller.signal,
      });
      await this.withTimeout(task, work);
      if (task.timedOut) {
        this.finish(task, "timed_out", timeoutError(this.config.commandTimeoutMs));
      } else if (task.controller.signal.aborted || task.status === "canceling") {
        this.finish(task, "canceled", new HttpError(499, "task_canceled", "Task was canceled."));
      } else {
        this.finish(task, "succeeded");
      }
    } catch (err) {
      if (task.timedOut) {
        this.finish(task, "timed_out", timeoutError(this.config.commandTimeoutMs));
      } else if (task.controller.signal.aborted || task.status === "canceling") {
        this.finish(task, "canceled", new HttpError(499, "task_canceled", "Task was canceled."));
      } else {
        this.finish(task, "failed", err);
      }
    } finally {
      this.decrementProjectActive(task);
      this.active--;
      await this.persistProject(task.project).catch(() => {});
      await appendTaskEvent(task, task.status, this.config.maxLogFileBytes).catch(() => {});
      this.drain();
    }
  }

  withTimeout(task, work) {
    const timeoutMs = this.config.commandTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        task.timedOut = true;
        task.controller.abort();
        reject(timeoutError(timeoutMs));
      }, timeoutMs);
      Promise.resolve(work).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  finish(task, status, err = null) {
    task.status = status;
    task.finishedAt = nowIso();
    if (err) {
      task.error = {
        code: err instanceof HttpError ? err.code : "task_failed",
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }
    task.error = null;
  }
}
