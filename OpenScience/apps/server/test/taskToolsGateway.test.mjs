// The runtime's door to the scheduled tasks (`schedule_task` / `update_task`): the token alone names the account and the project, a
// task is made the way the form makes one (the platform's default budget, started at once, nothing to approve), a change goes through
// the same service methods the page's routes do, a task of another project or account is not found, and what the run is told is facts.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { AGENDA_DEFAULT_BUDGETS, DISPLAY_TIME_ZONE, TASK_TOOL_ERROR_CODES, TASK_TOOL_RUN_FIXES, classifyEvidenceSourceError, knownErrorCodeMessage } from "@evimed/domain";
import { AutopilotService } from "../src/autopilotService.mjs";
import { HttpError } from "../src/security.mjs";
import { createTaskToolsGateway, TASK_TOOLS_GATEWAY_PATH } from "../src/taskToolsGateway.mjs";

const TOKEN = "runtime-token-for-tests";
const BOUNDED = "bounded-token-for-tests";
// Thursday 8 October 2026, 10:00 in Beijing.
const NOW = new Date("2026-10-08T02:00:00.000Z");

class MemoryDocuments {
  constructor() { this.rows = new Map(); }
  key(userId, kind, id) { return `${userId}:${kind}:${id}`; }
  async get(userId, kind, id) { return this.rows.get(this.key(userId, kind, id)) ?? null; }
  async list(userId, kind, { projectId, filter = {}, limit = 50 } = {}) {
    assert.ok(limit <= 100, "the real store refuses a page above 100");
    const items = [...this.rows.values()].filter((row) => row.userId === userId && row.kind === kind
      && (projectId === undefined || row.projectId === projectId) && Object.entries(filter).every(([key, value]) => row.payload[key] === value));
    return { items, nextCursor: null };
  }
  async put(userId, kind, id, payload, { expectedRevision, projectId = null }) {
    const key = this.key(userId, kind, id);
    const current = this.rows.get(key);
    if ((current?.revision ?? 0) !== expectedRevision) { const error = new Error("conflict"); error.code = "product_revision_conflict"; throw error; }
    const row = { id, kind, userId, projectId, payload, revision: expectedRevision + 1, createdAt: current?.createdAt ?? NOW.toISOString(), updatedAt: NOW.toISOString() };
    this.rows.set(key, row);
    return row;
  }
}

const jobs = { enqueue: async () => ({ id: "job" }), cancel: async () => null };

async function fixture(t, { enabled = true, maxTasks = 30, service: given = undefined, runId = null } = {}) {
  const documents = new MemoryDocuments();
  let counter = 0;
  const real = new AutopilotService({ documents, jobs, now: () => NOW, id: (prefix) => `${prefix}${++counter}` });
  const failures = [];
  const handler = createTaskToolsGateway({
    config: { taskToolsEnabled: enabled, taskToolsMaxTasks: maxTasks },
    runtimeManager: { assertActiveModelGatewayToken: (token) => {
      if (token === TOKEN) return { userId: "owner", projectId: "p1" };
      if (token === BOUNDED) return { userId: "owner", projectId: "p1", runId: "run-bounded", dailyLimit: 1, weeklyLimit: 1, runLimit: 1 };
      throw new Error("no");
    } },
    store: { userById: async (id) => (id === "owner" ? { id } : null), requireProject: async (_user, id) => ({ id, userId: "owner" }) },
    service: given === undefined ? real : given,
    now: () => NOW,
  });
  const server = createServer((req, res) => { void handler(req, res, (failure) => failures.push(failure)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}${TASK_TOOLS_GATEWAY_PATH}`;
  const call = async (operation, body, { token = runId ? BOUNDED : TOKEN, method = "POST", raw = undefined } = {}) => {
    const response = await fetch(`${base}/${operation}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(method === "POST" ? { body: raw ?? JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const schedule = (body) => call("schedule", body);
  const update = (body) => call("update", body);
  /** A task of another project or another account, as the ledger holds it. */
  const seed = async (userId, projectId, id, extra = {}) => {
    const made = await real.create(userId, { projectId, title: "别人的任务", prompt: "别人的指令", taskTypes: ["literature-sentinel"], ...AGENDA_DEFAULT_BUDGETS, schedule: { kind: "daily", timeZone: "Asia/Shanghai", time: "07:00" }, ...extra });
    return real.start(userId, made.id, { expectedRevision: made.revision });
  };
  return { call, schedule, update, real, documents, failures, seed };
}

const weekly = { kind: "weekly", weekdays: [5], time: "09:00" };
const said = "每周五帮我看看 SGLT2 抑制剂的新研究，说明设计与局限";
const stored = async (real, id) => (await real.get("owner", id)).payload;

test("a task is made and started as the form makes one: default budgets and types, no step to approve, the facts back", async (t) => {
  const { schedule, real } = await fixture(t);
  const answer = await schedule({ instruction: said, schedule: weekly });
  assert.equal(answer.status, 200);
  const task = answer.body.data;
  assert.match(task.taskId, /^agenda-/);
  assert.equal(task.created, true);
  assert.equal(task.title, said.slice(0, 60));
  assert.deepEqual(task.schedule, { kind: "weekly", time: "09:00", weekdays: [5], timeZone: DISPLAY_TIME_ZONE });
  assert.equal(task.scheduleText, "每周五 09:00");
  assert.equal(task.timeZoneName, "中国标准时间");
  assert.equal(task.state, "scheduled");
  // The next Friday 09:00 in Beijing: tomorrow.
  assert.equal(task.nextRunAt, "2026-10-09T01:00:00.000Z");
  assert.equal(task.nextRunText, "10月9日 09:00");
  // Facts only: no budget, no account, no project.
  assert.doesNotMatch(JSON.stringify(task), /owner|p1|CNY|Cny|budget/i);
  const agenda = await stored(real, task.taskId);
  assert.equal(agenda.enabled, true);
  assert.equal(agenda.status, "active");
  assert.equal(agenda.prompt, said);
  assert.deepEqual([agenda.maxEpisodeCny, agenda.dailyBudgetCny, agenda.weeklyBudgetCny], [AGENDA_DEFAULT_BUDGETS.maxEpisodeCny, AGENDA_DEFAULT_BUDGETS.dailyBudgetCny, AGENDA_DEFAULT_BUDGETS.weeklyBudgetCny]);
  assert.deepEqual(agenda.taskTypes, ["literature-sentinel"]);
  assert.equal((await real.get("owner", task.taskId)).projectId, "p1", "the project is the token's");
});

test("the instruction is kept exactly as said, and a title the researcher named is the title", async (t) => {
  const { schedule, real } = await fixture(t);
  const raw = "  肾病与心衰\n保留换行与全部指令  ";
  const answer = await schedule({ instruction: raw, title: "  肾心追踪  ", schedule: { kind: "daily", time: "07:30", timeZone: "America/New_York" } });
  assert.equal(answer.body.data.title, "肾心追踪");
  assert.equal((await stored(real, answer.body.data.taskId)).prompt, raw);
  assert.equal(answer.body.data.timeZone, "America/New_York");
  assert.equal(answer.body.data.scheduleText, "每天 07:30");
  assert.match(answer.body.data.timeZoneName, /^北美东部/);
});

test("a one-time task is for a moment still to come: its date is in words, and a moment that has passed is refused rather than run at once", async (t) => {
  const { schedule, real } = await fixture(t);
  const future = await schedule({ instruction: "x", schedule: { kind: "once", date: "2026-10-12", time: "07:00" } });
  assert.equal(future.status, 200);
  assert.equal(future.body.data.scheduleText, "10月12日 · 仅一次 07:00");
  assert.equal(future.body.data.nextRunText, "10月12日 07:00");
  const past = await schedule({ instruction: "y", schedule: { kind: "once", date: "2026-10-08", time: "09:00" } });
  assert.deepEqual([past.status, past.body.code], [400, "task_schedule_in_past"]);
  assert.equal((await real.list("owner", { projectId: "p1" })).items.length, 1);
});

test("a call the tool cannot act on is refused by name and makes nothing", async (t) => {
  const { schedule, real } = await fixture(t);
  const good = { kind: "daily", time: "07:00" };
  for (const [body, code] of [
    [{ schedule: good }, "task_instruction_invalid"],
    [{ instruction: "  ", schedule: good }, "task_instruction_invalid"],
    [{ instruction: "x\0y", schedule: good }, "task_instruction_invalid"],
    [{ instruction: "x".repeat(20_001), schedule: good }, "task_instruction_invalid"],
    [{ instruction: "x", schedule: good, title: "" }, "task_title_invalid"],
    [{ instruction: "x", schedule: good, title: "t".repeat(201) }, "task_title_invalid"],
    [{ instruction: "x" }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: "daily 7am" }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: { kind: "monthly", time: "07:00" } }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: { kind: "daily" } }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: { kind: "daily", time: "25:00" } }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: { kind: "weekly", time: "07:00" } }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: { kind: "weekly", time: "07:00", weekdays: [8] } }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: { kind: "once", time: "07:00" } }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: { kind: "daily", time: "07:00", date: "2026-10-12" } }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: { kind: "daily", time: "07:00", timeZone: "Mars/Base" } }, "task_schedule_invalid"],
    [{ instruction: "x", schedule: { kind: "daily", time: "07:00", budget: 5 } }, "task_schedule_invalid"],
    // A call cannot name an account, a project or a price: those are the token's and the platform's.
    [{ instruction: "x", schedule: good, projectId: "p2" }, "task_tools_request_invalid"],
    [{ instruction: "x", schedule: good, userId: "someone" }, "task_tools_request_invalid"],
    [{ instruction: "x", schedule: good, maxEpisodeCny: 500 }, "task_tools_request_invalid"],
    [{ instruction: "x", schedule: good, dailyBudgetCny: 500 }, "task_tools_request_invalid"],
  ]) {
    const answer = await schedule(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.code, code, JSON.stringify(body));
    assert.ok(TASK_TOOL_RUN_FIXES.includes(answer.body.code), `${answer.body.code} is the run's to fix`);
  }
  assert.equal((await schedule({ instruction: "x" }).then(() => real.list("owner", { projectId: "p1" }))).items.length, 0);
});

test("saying it twice leaves one task: the same instruction and schedule is returned, not made again", async (t) => {
  const { schedule, real } = await fixture(t);
  const first = await schedule({ instruction: said, schedule: weekly });
  const again = await schedule({ instruction: said, schedule: weekly });
  assert.deepEqual([again.status, again.body.data.created, again.body.data.taskId], [200, false, first.body.data.taskId]);
  // Another moment, or another instruction, is another task.
  assert.notEqual((await schedule({ instruction: said, schedule: { ...weekly, time: "10:00" } })).body.data.taskId, first.body.data.taskId);
  assert.notEqual((await schedule({ instruction: `${said}，只看随机对照试验`, schedule: weekly })).body.data.taskId, first.body.data.taskId);
  assert.equal((await real.list("owner", { projectId: "p1" })).items.length, 3);
});

test("a project holds a bounded number of tasks, and deleting one makes room", async (t) => {
  const { schedule, real } = await fixture(t, { maxTasks: 2 });
  const first = await schedule({ instruction: "一", schedule: weekly });
  await schedule({ instruction: "二", schedule: weekly });
  const third = await schedule({ instruction: "三", schedule: weekly });
  assert.deepEqual([third.status, third.body.code], [409, "task_limit_reached"]);
  assert.match(third.body.error, /delete or pause one/);
  // The same task said again is still the same task, not a new one over the limit.
  assert.equal((await schedule({ instruction: "一", schedule: weekly })).body.data.created, false);
  const gone = await real.get("owner", first.body.data.taskId);
  await real.archive("owner", gone.id, { expectedRevision: gone.revision });
  assert.equal((await schedule({ instruction: "三", schedule: weekly })).status, 200);
});

test("a change names the task and only what changes: a schedule left partly out keeps what it had", async (t) => {
  const { schedule, update, real } = await fixture(t);
  const { taskId } = (await schedule({ instruction: said, schedule: weekly })).body.data;
  // 「改到每周一 8 点」
  const monday = await update({ taskId, schedule: { weekdays: [1], time: "08:00" } });
  assert.equal(monday.status, 200);
  assert.deepEqual(monday.body.data.changed, ["schedule"]);
  assert.equal(monday.body.data.scheduleText, "每周一 08:00");
  assert.equal(monday.body.data.nextRunAt, "2026-10-12T00:00:00.000Z");
  assert.equal(monday.body.data.created, undefined);
  // Only the clock.
  const clock = await update({ taskId, schedule: { time: "07:15" } });
  assert.equal(clock.body.data.scheduleText, "每周一 07:15");
  assert.deepEqual((await stored(real, taskId)).schedule, { kind: "weekly", timeZone: DISPLAY_TIME_ZONE, time: "07:15", weekdays: [1] });
  // Another kind forgets what belongs to the old one; a kind that needs a field the call does not give is refused.
  assert.equal((await update({ taskId, schedule: { kind: "daily" } })).body.data.scheduleText, "每天 07:15");
  assert.deepEqual((await stored(real, taskId)).schedule, { kind: "daily", timeZone: DISPLAY_TIME_ZONE, time: "07:15" });
  const bare = await update({ taskId, schedule: { kind: "weekly" } });
  assert.deepEqual([bare.status, bare.body.code], [400, "task_schedule_invalid"]);
  assert.equal((await update({ taskId, schedule: { kind: "once", date: "2026-10-20" } })).body.data.scheduleText, "10月20日 · 仅一次 07:15");
  const past = await update({ taskId, schedule: { date: "2026-10-01" } });
  assert.deepEqual([past.status, past.body.code], [400, "task_schedule_in_past"]);
  // A zone is a field like any other.
  assert.equal((await update({ taskId, schedule: { kind: "daily", timeZone: "America/New_York" } })).body.data.timeZone, "America/New_York");
});

test("a change of words is the instruction or the title, byte for byte; asking for what already is changes nothing", async (t) => {
  const { schedule, update, real } = await fixture(t);
  const { taskId } = (await schedule({ instruction: said, schedule: weekly })).body.data;
  const narrowed = await update({ taskId, instruction: `${said}，只看随机对照试验\n` });
  assert.deepEqual(narrowed.body.data.changed, ["instruction"]);
  assert.equal((await stored(real, taskId)).prompt, `${said}，只看随机对照试验\n`);
  assert.equal((await update({ taskId, title: "  SGLT2 随机对照  " })).body.data.title, "SGLT2 随机对照");
  const same = await update({ taskId, title: "SGLT2 随机对照", schedule: { time: "09:00" }, paused: false });
  assert.deepEqual([same.status, same.body.data.changed], [200, []]);
  const empty = await update({ taskId });
  assert.deepEqual([empty.status, empty.body.code], [400, "task_update_empty"]);
});

test("pausing and re-enabling are the page's own stop and start, and say so in the state", async (t) => {
  const { schedule, update, real } = await fixture(t);
  const { taskId } = (await schedule({ instruction: said, schedule: weekly })).body.data;
  const paused = await update({ taskId, paused: true });
  assert.deepEqual([paused.body.data.changed, paused.body.data.state, paused.body.data.nextRunAt], [["paused"], "paused", null]);
  const row = await stored(real, taskId);
  assert.deepEqual([row.enabled, row.status], [false, "stopped"]);
  // Again: nothing to do, and no second sweep of the work it stopped.
  assert.deepEqual((await update({ taskId, paused: true })).body.data.changed, []);
  const resumed = await update({ taskId, paused: false });
  assert.deepEqual([resumed.body.data.changed, resumed.body.data.state], [["resumed"], "scheduled"]);
  assert.equal((await stored(real, taskId)).status, "active");
  // A change and a pause in one call: the change first, then the pause.
  const both = await update({ taskId, schedule: { time: "10:00" }, paused: true });
  assert.deepEqual(both.body.data.changed, ["schedule", "paused"]);
  assert.equal(both.body.data.scheduleText, "每周五 10:00");
  const bad = await update({ taskId, paused: "yes" });
  assert.deepEqual([bad.status, bad.body.code], [400, "task_paused_invalid"]);
});

test("a task of another project or another account is not found, and a wrong id comes back with this project's tasks", async (t) => {
  const { schedule, update, seed } = await fixture(t);
  const mine = (await schedule({ instruction: said, schedule: weekly })).body.data;
  const otherProject = await seed("owner", "p2", undefined);
  const otherAccount = await seed("stranger", "p1", undefined);
  for (const taskId of [otherProject.id, otherAccount.id, "agenda-nope"]) {
    const answer = await update({ taskId, paused: true });
    assert.deepEqual([answer.status, answer.body.code], [404, "task_not_found"], taskId);
    assert.deepEqual(answer.body.tasks.map((task) => task.taskId), [mine.taskId], "only this project's own tasks are named");
    assert.deepEqual(Object.keys(answer.body.tasks[0]).sort(), ["scheduleText", "state", "taskId", "title"]);
  }
  // Neither was touched.
  assert.equal(otherProject.payload.enabled, true);
  const bad = await update({ taskId: "../../etc/passwd", paused: true });
  assert.deepEqual([bad.status, bad.body.code], [400, "task_id_invalid"]);
  assert.equal(bad.body.tasks.length, 1);
  assert.equal((await update({ paused: true })).body.code, "task_id_invalid");
});

test("an execution's id names its task: 「改到每周一 8 点」 said in a task's own conversation changes that task, and only if it is this project's", async (t) => {
  const { schedule, update, documents } = await fixture(t);
  const { taskId } = (await schedule({ instruction: said, schedule: weekly })).body.data;
  await documents.put("owner", "episode", "episode-" + "a".repeat(32), { agendaId: taskId, status: "merged" }, { expectedRevision: 0, projectId: "p1" });
  await documents.put("owner", "episode", "episode-" + "b".repeat(32), { agendaId: taskId, status: "merged" }, { expectedRevision: 0, projectId: "p2" });
  const changed = await update({ taskId: "episode-" + "a".repeat(32), schedule: { weekdays: [1], time: "08:00" } });
  assert.deepEqual([changed.status, changed.body.data.taskId, changed.body.data.scheduleText], [200, taskId, "每周一 08:00"]);
  const elsewhere = await update({ taskId: "episode-" + "b".repeat(32), paused: true });
  assert.deepEqual([elsewhere.status, elsewhere.body.code], [404, "task_not_found"]);
  assert.equal((await update({ taskId: "episode-" + "c".repeat(32), paused: true })).body.code, "task_not_found");
});

test("a scheduled execution does not make or change tasks, and nothing is touched", async (t) => {
  const { call, real } = await fixture(t, { runId: "run-bounded" });
  const made = await call("schedule", { instruction: said, schedule: weekly });
  assert.deepEqual([made.status, made.body.code], [403, "task_tools_not_in_conversation"]);
  const changed = await call("update", { taskId: "agenda-1", paused: true });
  assert.equal(changed.body.code, "task_tools_not_in_conversation");
  assert.equal((await real.list("owner", { projectId: "p1" })).items.length, 0);
});

test("a missing or forged credential, a switched-off feature and a bad request each answer by name", async (t) => {
  const { call, failures } = await fixture(t);
  assert.equal((await call("schedule", {}, { token: null })).body.code, "task_tools_gateway_token_missing");
  assert.equal((await call("schedule", {}, { token: "forged" })).body.code, "task_tools_gateway_token_invalid");
  assert.equal((await call("schedule", null, { raw: "not json" })).body.code, "task_tools_request_invalid");
  assert.equal((await call("update", { taskId: "agenda-1", note: "x" })).body.code, "task_tools_request_invalid");
  const huge = await call("schedule", { instruction: "x".repeat(200_000), schedule: weekly });
  assert.deepEqual([huge.status, huge.body.code], [413, "task_tools_request_too_large"]);
  for (const missing of [{ operation: "nothing", method: "POST" }, { operation: "schedule", method: "GET" }]) {
    assert.equal((await call(missing.operation, {}, { method: missing.method })).status, 404, missing.operation);
  }
  assert.ok(failures.some((failure) => failure.code === "task_tools_gateway_token_invalid" && failure.status === 401));
  const off = await fixture(t, { enabled: false });
  assert.deepEqual([(await off.schedule({ instruction: "x", schedule: weekly })).status, (await off.schedule({})).body.code], [503, "task_tools_disabled"]);
  const nowhere = await fixture(t, { service: null });
  assert.equal((await nowhere.schedule({})).body.code, "task_tools_disabled");
});

test("every code the gateway answers with is registered: a verdict, a sentence, and the run's mistakes are the terminal ones", async (t) => {
  for (const code of TASK_TOOL_ERROR_CODES) {
    assert.match(knownErrorCodeMessage(code) ?? "", /定时任务/, code);
    assert.equal(classifyEvidenceSourceError(code), TASK_TOOL_RUN_FIXES.includes(code) ? "terminal" : "recoverable", code);
  }
  // And nothing the gateway source names is missing from the registry.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/taskToolsGateway.mjs", import.meta.url), "utf8");
  for (const [, code] of source.matchAll(/"(task_[a-z_]+)"/g)) assert.ok(TASK_TOOL_ERROR_CODES.includes(code), `${code} is not registered`);
  t.diagnostic(`${TASK_TOOL_ERROR_CODES.length} codes`);
});

test("an unexpected failure is a coded outage the run goes on from, never the stack", async (t) => {
  const { schedule } = await fixture(t, { service: { list: async () => { throw new Error("connection reset by 10.0.0.7:5432"); } } });
  const answer = await schedule({ instruction: "x", schedule: weekly });
  assert.deepEqual([answer.status, answer.body.code], [503, "task_tools_unavailable"]);
  assert.doesNotMatch(JSON.stringify(answer.body), /10\.0\.0\.7|connection reset/);
});

test("a task that cannot be started is not left behind paused, and the service's own refusal reaches the run by its code", async (t) => {
  const failing = new AutopilotService({ documents: new MemoryDocuments(), jobs, now: () => NOW, id: (prefix) => `${prefix}x` });
  failing.start = async () => { throw new HttpError(400, "autopilot_episode_budget_too_small", "This task's episode budget is below the minimum."); };
  const { schedule } = await fixture(t, { service: failing });
  const answer = await schedule({ instruction: "x", schedule: weekly });
  assert.deepEqual([answer.status, answer.body.code], [400, "autopilot_episode_budget_too_small"]);
  assert.equal((await failing.list("owner", { projectId: "p1" })).items.length, 0, "the half-made task was removed");
});

test("a task that moved under the call (edited on the page at the same moment) is read again once", async (t) => {
  const { schedule, update, real } = await fixture(t);
  const { taskId } = (await schedule({ instruction: said, schedule: weekly })).body.data;
  const original = real.update.bind(real);
  let moved = 0;
  real.update = async (userId, id, input) => {
    if (moved++ === 0) {
      const current = await real.get(userId, id);
      await real.documents.put(userId, "agenda", id, { ...current.payload, title: "页面里改了名" }, { expectedRevision: current.revision, projectId: current.projectId });
    }
    return original(userId, id, input);
  };
  const answer = await update({ taskId, schedule: { time: "08:00" } });
  assert.equal(answer.status, 200);
  assert.deepEqual([answer.body.data.title, answer.body.data.scheduleText], ["页面里改了名", "每周五 08:00"]);
  // Twice in a row is the call's to repeat.
  let always = 0;
  real.update = async (userId, id, input) => {
    always++;
    const current = await real.get(userId, id);
    await real.documents.put(userId, "agenda", id, { ...current.payload, updatedAt: String(always) }, { expectedRevision: current.revision, projectId: current.projectId });
    return original(userId, id, input);
  };
  const lost = await update({ taskId, schedule: { time: "09:30" } });
  assert.deepEqual([lost.status, lost.body.code], [409, "task_revision_conflict"]);
  assert.equal(always, 2);
});

test("a loop is stopped at the per-project rate and nothing else is", async (t) => {
  const { update } = await fixture(t);
  let last;
  for (let index = 0; index < 31; index += 1) last = await update({ taskId: "agenda-nope", paused: true });
  assert.deepEqual([last.status, last.body.code], [429, "task_tools_rate_limited"]);
});
