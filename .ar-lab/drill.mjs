#!/usr/bin/env node
// Fault drills of a long research goal on the lab's Compose stack: each drill is a throwaway person who sets a goal through the route the
// page uses, then something happens to it, and what the run ledger, the container and the workspace show is written down. Nothing here
// judges language: every check is a count, a status or a file. The logs of this repository are public, so stdout is drill names and
// counters only; prompts, answers and files go to RESULTS, which the job encrypts.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";

const base = "http://127.0.0.1:8787";
const RESULTS = process.env.RESULTS ?? "/tmp/ar-results";
const DRILLS = (process.env.DRILLS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const PARALLEL = process.env.PARALLEL === "1";
const JOB_CAP_CNY = Number(process.env.JOB_CAP_CNY ?? 7.5);
const DRILL_CAP_CNY = Number(process.env.DRILL_CAP_CNY ?? 3);
const { fetchTransport, openThrowawayAccount } = await import(pathToFileURL(`${process.env.LAB_SRC}/scripts/ops/throwaway-account.mjs`).href);

const G5 = "这是一个多轮推进的长期研究目标：评估咖啡因半衰期的主要影响因素。第一轮只列出五个影响因素并写入 factors.md；之后每一轮只处理一个因素，把说明追加到 notes.md，段落标题写“## 因素 N”；全部完成后合成 summary.md。不需要联网。每一轮结束后等待自动进入下一轮，不要在同一轮里做完。";
const G_NATURAL = "整理影响咖啡因半衰期的主要因素，给我一份要点总结，写成 summary.md。不需要联网。";
const G_SECOND = "这是一个多轮推进的长期研究目标：评估茶碱清除率的主要影响因素。第一轮只列出三个影响因素并写入 theo-factors.md；之后每一轮只处理一个因素，把说明追加到 theo-notes.md，段落标题写“## 茶碱因素 N”；全部完成后合成 theo-summary.md。不需要联网。每一轮结束后等待自动进入下一轮，不要在同一轮里做完。";
const G_HEAVY = "这是一个多轮推进的长期研究目标：测试本机能做多大的矩阵运算。第一轮写一个 Python 脚本 big.py：用 numpy 申请一个约 4 GB 的数组并填满，算出它的和，把结果写入 notes.md，然后运行它。如果脚本失败，把错误原文写入 notes.md。第二轮把数组减到 200 MB 再运行一次，把结果追加到 notes.md。第三轮写 summary.md 总结两次结果。不需要联网。每一轮结束后等待自动进入下一轮。";

const G_HEAVY_BIG = "这是一个多轮推进的长期研究目标：测试本机能做多大的矩阵运算。第一轮写一个 Python 脚本 big.py：用 numpy 申请一个约 12 GB 的数组并逐元素填满（不要用稀疏或延迟分配），算出它的和，把结果写入 notes.md，然后运行它。如果脚本失败，把错误原文写入 notes.md。第二轮把数组减到 200 MB 再运行一次，把结果追加到 notes.md。第三轮写 summary.md 总结两次结果。不需要联网。每一轮结束后等待自动进入下一轮。";

let jobSpend = 0;
const say = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const shell = (file, args, { timeoutMs = 120_000, maxBuffer = 40 * 1024 * 1024 } = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer, encoding: "buffer" }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
});
const text = (buffer) => buffer.toString("utf8");
async function webContainer() {
  const rows = text((await shell("docker", ["ps", "--format", "{{.Names}}"])).stdout).split("\n");
  return rows.find((name) => /open-science-web-\d+$/.test(name)) ?? null;
}

class Drill {
  constructor(name) {
    this.name = name;
    this.dir = `${RESULTS}/${name}`;
    mkdirSync(this.dir, { recursive: true });
    this.people = [];
    this.facts = { drill: name, startedAt: new Date().toISOString() };
    this.t0 = Date.now();
  }
  note(kind, fields = {}) { appendFileSync(`${this.dir}/timeline.jsonl`, `${JSON.stringify({ t: Math.round((Date.now() - this.t0) / 1000), kind, ...fields })}\n`); }
  fact(key, value) { this.facts[key] = value; this.note(`fact:${key}`, { value }); }
  async person(label) {
    const person = new Person(this, label);
    await person.open();
    this.people.push(person);
    return person;
  }
  spend() { return this.people.reduce((sum, person) => sum + person.spend(), 0); }
  async guard() {
    if (this.spend() >= DRILL_CAP_CNY) throw new CapReached(`drill cap ${DRILL_CAP_CNY}`);
    if (jobSpend >= JOB_CAP_CNY) throw new CapReached(`job cap ${JOB_CAP_CNY}`);
  }
}
class CapReached extends Error {}

class Person {
  constructor(drill, label) { this.drill = drill; this.label = label; this.costs = new Map(); this.lines = new Map(); this.projectId = `d${randomBytes(6).toString("hex")}`; this.sessions = []; this.cached = []; }
  async open() {
    this.account = await openThrowawayAccount({
      base, send: fetchTransport(base, { timeoutMs: 120_000 }), prefix: "ardrill", say: () => {}, signals: false,
      stop: async () => { for (const run of this.cached) if (run.status === "running" || run.status === "queued") await this.api("POST", `/api/agent-runs/${run.id}/cancel`, { body: {} }).catch(() => {}); },
    });
    const made = await this.api("POST", "/api/projects", { body: { id: this.projectId, name: "drill" }, project: null });
    this.drill.note("project", { label: this.label, status: made.status });
  }
  async api(method, path, { body, project = this.projectId, timeoutMs = 120_000 } = {}) {
    const response = await fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", origin: base, ...this.account.headers, ...(project ? { "x-open-science-project": project } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let parsed = null; try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: response.status, body: parsed ?? raw.slice(0, 600) };
  }
  async newSession() {
    const id = `web-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const bound = await this.api("PUT", `/api/research-sessions/${id}`, { body: { mode: "open-domain" } });
    this.drill.note("session", { label: this.label, status: bound.status, session: id });
    this.sessions.push(id);
    return id;
  }
  async setGoal(goal, sessionId) {
    const session = sessionId ?? await this.newSession();
    const answer = await this.api("POST", "/api/agent-runs/dispatch", { body: { sessionId: session, dispatchId: `drill-${randomBytes(6).toString("hex")}`, text: goal, researchGoal: true }, timeoutMs: 300_000 });
    this.drill.note("set-goal", { label: this.label, status: answer.status, code: answer.body?.code ?? answer.body?.error?.code ?? null, run: answer.body?.data?.id ?? null, session });
    return { status: answer.status, session, run: answer.body?.data?.id ?? null, code: answer.body?.code ?? answer.body?.error?.code ?? null };
  }
  async say_(words, sessionId) {
    const session = sessionId ?? await this.newSession();
    const t = Date.now();
    const answer = await this.api("POST", "/api/agent-runs/dispatch", { body: { sessionId: session, dispatchId: `drill-${randomBytes(6).toString("hex")}`, text: words, line: "answer" }, timeoutMs: 300_000 });
    this.drill.note("message", { label: this.label, status: answer.status, code: answer.body?.code ?? answer.body?.error?.code ?? null, run: answer.body?.data?.id ?? null, session, answeredInMs: Date.now() - t });
    return { status: answer.status, session, run: answer.body?.data?.id ?? null, code: answer.body?.code ?? answer.body?.error?.code ?? null, answeredInMs: Date.now() - t };
  }
  async runs() {
    const list = await this.api("GET", "/api/agent-runs");
    if (list.status !== 200) { this.drill.note("runs-read", { label: this.label, status: list.status }); return this.cached; }
    const runs = list.body?.data ?? [];
    this.cached = runs;
    for (const run of runs) {
      const line = JSON.stringify({ st: run.status, why: run.effectiveRouteReason, auto: run.automated, goal: run.goal?.id, anchor: run.goal?.runId, err: run.errorCode, sub: run.errorSubCode, files: run.outputFiles?.length, session: run.sessionId });
      if (this.lines.get(run.id) !== line) { this.lines.set(run.id, line); this.drill.note("run", { label: this.label, id: run.id, ...JSON.parse(line), startedAt: run.startedAt, finishedAt: run.finishedAt }); }
      const known = this.costs.get(run.id);
      if (!known || !known.settled) {
        const usage = await this.api("GET", `/api/runs/${encodeURIComponent(run.id)}/usage`).catch(() => null);
        const data = usage?.status === 200 ? usage.body?.data : null;
        const cny = Number(data?.cost ?? 0) + Number(data?.openCost ?? 0);
        const settled = !["running", "queued"].includes(run.status) && !Number(data?.openCost ?? 0) && !Number(data?.uncertain ?? 0);
        jobSpend += cny - (known?.cny ?? 0);
        this.costs.set(run.id, { cny, settled, calls: data?.calls ?? null, uncertain: data?.uncertain ?? null });
      }
    }
    await this.drill.guard();
    return runs;
  }
  spend() { return [...this.costs.values()].reduce((sum, row) => sum + row.cny, 0); }
  roundsOf(session) { return this.cached.filter((run) => run.sessionId === session); }
  async container() {
    const ids = text((await shell("docker", ["ps", "-aq", "--filter", "label=open-science.web.runtime=true"])).stdout).split("\n").filter(Boolean);
    for (const id of ids) {
      const raw = text((await shell("docker", ["inspect", id])).stdout);
      if (raw.includes(this.projectId)) { const [row] = JSON.parse(raw); return { id, name: row.Name, status: row.State?.Status, oomKilled: row.State?.OOMKilled, exit: row.State?.ExitCode, restarts: row.RestartCount, startedAt: row.State?.StartedAt }; }
    }
    return null;
  }
  async capture() {
    const web = await webContainer();
    if (!web) { this.drill.note("capture", { label: this.label, ok: false, why: "no web container" }); return; }
    const found = text((await shell("docker", ["exec", web, "sh", "-c", `find /data/users -maxdepth 3 -type d -name ${this.projectId} | head -1`])).stdout).trim();
    if (!found) { this.drill.note("capture", { label: this.label, ok: false, why: "no project dir" }); return; }
    const packed = await shell("docker", ["exec", web, "sh", "-c", `cd '${found}' && find ./.openscience ./workspace -type f -size -2048k -not -path '*/node_modules/*' -not -name '*.token' -not -name '.credentials*' | head -600 | tar -cf - -T -`], { timeoutMs: 180_000 });
    writeFileSync(`${this.drill.dir}/${this.label}-project.tar`, packed.stdout);
    const list = await this.api("GET", "/api/agent-runs").catch(() => null);
    writeFileSync(`${this.drill.dir}/${this.label}-runs.json`, JSON.stringify({ runs: list?.body?.data ?? null, costs: [...this.costs.entries()] }, null, 1));
    const c = await this.container();
    if (c) {
      const peak = await shell("docker", ["exec", c.id, "sh", "-c", "cat /sys/fs/cgroup/memory.peak 2>/dev/null; cat /sys/fs/cgroup/memory.events 2>/dev/null"], { timeoutMs: 15_000 });
      this.drill.note("container-end", { label: this.label, ...c, memory: text(peak.stdout).slice(0, 300) });
    } else this.drill.note("container-end", { label: this.label, gone: true });
    const words = await shell("docker", ["exec", web, "sh", "-c", `cd '${found}/workspace' && for f in factors.md notes.md summary.md theo-factors.md theo-notes.md theo-summary.md; do if [ -f "$f" ]; then printf '%s %s ' "$f" "$(wc -c < "$f")"; grep -c '^## ' "$f" || true; fi; done; ls -a | head -40; ls -a .loopx 2>/dev/null | head -12`], { timeoutMs: 30_000 });
    this.drill.note("workspace", { label: this.label, listing: text(words.stdout).slice(0, 1600) });
  }
  async close() { if (this.closed) return null; this.closed = true; await this.capture().catch((error) => this.drill.note("capture-failed", { label: this.label, why: String(error?.message ?? error).slice(0, 200) })); const verdict = await this.account.close(); this.drill.note("account", { label: this.label, ...verdict }); return verdict; }
}

const running = (runs) => runs.filter((run) => run.status === "running" || run.status === "queued");
/** Set a goal; when its first round ends without a tool call (the provider was busy), the goal never began, so set it again and count that. */
async function establish(drill, person, goal, { tries = 3 } = {}) {
  let set;
  const lost = [];
  for (let attempt = 0; attempt < tries; attempt += 1) {
    set = await person.setGoal(goal);
    if (!set.run) break;
    const ended = await waitFor(drill, person, (runs) => {
      const row = runs.find((run) => run.id === set.run);
      if (!row) return null;
      if (Number(row.observedToolCalls ?? 0) >= 6) return { live: true };
      return ["running", "queued"].includes(row.status) ? null : { row };
    }, { capMs: 12 * 60_000, everyMs: 5000, label: "first round began" });
    if (!ended?.row || Number(ended.row.observedToolCalls ?? 0) >= 6) break;
    lost.push({ status: ended.row.status, err: ended.row.errorCode ?? null, tools: ended.row.observedToolCalls ?? null });
  }
  drill.fact("firstRoundsLost", lost);
  return set;
}
async function waitFor(drill, person, test, { capMs, everyMs = 5000, label }) {
  const end = Date.now() + capMs;
  for (;;) {
    const runs = await person.runs();
    const hit = test(runs);
    if (hit) return hit;
    if (Date.now() > end) { drill.note("wait-timeout", { label }); return null; }
    await sleep(everyMs);
  }
}
/** A goal's nth round is running and has been for a moment. */
const roundRunning = (drill, person, session, n, { ranMs = 20_000, capMs = 20 * 60_000 } = {}) => waitFor(drill, person, (runs) => {
  const rounds = runs.filter((run) => run.sessionId === session);
  const live = rounds.find((run) => run.status === "running");
  return rounds.length >= n && live && Date.now() - Date.parse(live.startedAt) >= ranMs ? live : null;
}, { capMs, label: `round ${n} running` });
/** A round of at least the nth has ended and nothing is running: the gap between rounds. */
const gapAfterRound = (drill, person, session, n, { capMs = 20 * 60_000 } = {}) => waitFor(drill, person, (runs) => {
  const rounds = runs.filter((run) => run.sessionId === session);
  return rounds.length >= n && !running(rounds).length ? { rounds: rounds.length } : null;
}, { capMs, everyMs: 2500, label: `gap after round ${n}` });
/** Watch for this long and say what happened: stop early when nothing has run for quietMs. */
async function watch(drill, person, { ms, quietMs = null, label }) {
  const end = Date.now() + ms;
  let quietSince = null;
  let quiet = false;
  while (Date.now() < end) {
    const runs = await person.runs();
    if (running(runs).length) quietSince = null; else quietSince ??= Date.now();
    if (quietMs && quietSince && Date.now() - quietSince >= quietMs) { quiet = true; break; }
    await sleep(10_000);
  }
  const runs = person.cached;
  const summary = { label, runs: runs.length, running: running(runs).length, quiet, seconds: Math.round((Date.now() - drill.t0) / 1000) };
  drill.note("watch", summary);
  return summary;
}
/** A person comes back: opens the page (a read), then the conversation (the runtime starts), then writes one word. */
async function personReturns(drill, person, session) {
  const before = person.cached.length;
  const page = await watch(drill, person, { ms: 3 * 60_000, label: "page open only" });
  const afterPage = person.cached.length;
  const started = await person.api("POST", "/api/commands/start_runtime", { body: {}, timeoutMs: 240_000 });
  drill.note("start-runtime", { status: started.status });
  await watch(drill, person, { ms: 6 * 60_000, quietMs: 5 * 60_000, label: "runtime started" });
  const afterOpen = person.cached.length;
  const words = await person.say_("继续", session);
  drill.note("said-continue", { status: words.status, code: words.code });
  await watch(drill, person, { ms: 8 * 60_000, quietMs: 3 * 60_000, label: "said continue" });
  drill.fact("revival", { roundsBefore: before, afterPageOpen: afterPage, afterRuntimeStart: afterOpen, afterSayingContinue: person.cached.length, pageRead: page.runs, continueStatus: words.status, continueCode: words.code });
}
const dockerDo = async (drill, what, args) => { const done = await shell("docker", args, { timeoutMs: 120_000 }); drill.note(what, { code: done.code, err: text(done.stderr).slice(0, 200) }); return done.code; };

async function repeatControl(drill) {
  const person = await drill.person("a");
  const set = await establish(drill, person, G5);
  drill.fact("setStatus", set.status);
  const end = await watch(drill, person, { ms: 30 * 60_000, quietMs: 5 * 60_000, label: "control repeat" });
  drill.fact("stoppedByItself", end.quiet);
  await person.close();
}
const DRILL = {
  /** A natural goal: does it continue at all, does it stop. */
  async D01(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G_NATURAL);
    drill.fact("setStatus", set.status);
    const end = await watch(drill, person, { ms: 25 * 60_000, quietMs: 5 * 60_000, label: "natural" });
    drill.fact("stoppedByItself", end.quiet);
    await person.close();
  },
  /** The forced multi-round goal with nothing done to it: the control for everything below, and does it stop after the summary. */
  async D02(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G5);
    drill.fact("setStatus", set.status);
    const end = await watch(drill, person, { ms: 40 * 60_000, quietMs: 5 * 60_000, label: "control" });
    drill.fact("stoppedByItself", end.quiet);
    await person.close();
  },
  /** The kernel's container dies in the middle of a round. */
  async D03(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G5);
    const live = await roundRunning(drill, person, set.session, 2);
    drill.fact("killedDuringRound", live?.id ?? null);
    const c = await person.container();
    if (live && c) await dockerDo(drill, "kill", ["kill", c.id]);
    await watch(drill, person, { ms: 4 * 60_000, label: "after kill" });
    drill.fact("containerAfterKill", await person.container());
    drill.fact("killedRunState", person.cached.find((run) => run.id === live?.id)?.status ?? null);
    await personReturns(drill, person, set.session);
    await person.close();
  },
  /** The kernel's container dies between two rounds. */
  async D04(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G5);
    const gap = await gapAfterRound(drill, person, set.session, 2);
    const c = await person.container();
    if (gap && c) await dockerDo(drill, "kill", ["kill", c.id]);
    drill.fact("killedInGapAfterRounds", gap?.rounds ?? null);
    await watch(drill, person, { ms: 4 * 60_000, label: "after kill" });
    drill.fact("containerAfterKill", await person.container());
    await personReturns(drill, person, set.session);
    await person.close();
  },
  /** The control plane restarts while a round runs; the runtime stays up. */
  async D05(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G5);
    const live = await roundRunning(drill, person, set.session, 2);
    const web = await webContainer();
    if (live && web) await dockerDo(drill, "restart-web", ["restart", web]);
    for (let i = 0; i < 60; i += 1) { try { const up = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) }); if (up.status === 200) break; } catch { /* not yet */ } await sleep(3000); }
    drill.note("web-back");
    const end = await watch(drill, person, { ms: 15 * 60_000, quietMs: 5 * 60_000, label: "after web restart" });
    drill.fact("restartedDuringRun", live?.id ?? null);
    drill.fact("runStateAfter", person.cached.find((run) => run.id === live?.id)?.status ?? null);
    drill.fact("stoppedByItself", end.quiet);
    drill.fact("containerAfter", await person.container());
    await person.close();
  },
  /** What a release does: the runtime removed while a round runs, the control plane restarted. */
  async D06(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G5);
    const live = await roundRunning(drill, person, set.session, 2);
    const c = await person.container();
    const web = await webContainer();
    if (live && c) await dockerDo(drill, "remove-runtime", ["rm", "-f", c.id]);
    if (live && web) await dockerDo(drill, "restart-web", ["restart", web]);
    for (let i = 0; i < 60; i += 1) { try { const up = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) }); if (up.status === 200) break; } catch { /* not yet */ } await sleep(3000); }
    await watch(drill, person, { ms: 4 * 60_000, label: "after release" });
    drill.fact("runStateAfter", person.cached.find((run) => run.id === live?.id)?.status ?? null);
    drill.fact("containerAfter", await person.container());
    await personReturns(drill, person, set.session);
    await person.close();
  },
  /** A tool script asks for more memory than the container has. */
  async D07(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G_HEAVY);
    drill.fact("setStatus", set.status);
    await watch(drill, person, { ms: 25 * 60_000, quietMs: 5 * 60_000, label: "heavy" });
    drill.fact("containerAfter", await person.container());
    drill.fact("statuses", person.cached.map((run) => [run.status, run.errorCode ?? null]));
    await person.close();
  },
  /** The same with more memory than the container and its swap together. */
  async D07B(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G_HEAVY_BIG);
    drill.fact("setStatus", set.status);
    await watch(drill, person, { ms: 22 * 60_000, quietMs: 5 * 60_000, label: "heavy big" });
    drill.fact("containerAfter", await person.container());
    drill.fact("statuses", person.cached.map((run) => [run.status, run.errorCode ?? null]));
    await person.close();
  },
  /** Repeats of the control: how often does a finished goal keep going. */
  async D21(drill) { await repeatControl(drill); },
  async D22(drill) { await repeatControl(drill); },
  async D23(drill) { await repeatControl(drill); },
  /** Stop pressed during a round: does the goal stop, or only the round. */
  async D08(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G5);
    const live = await roundRunning(drill, person, set.session, 2);
    const t = Date.now();
    const answer = live ? await person.api("POST", `/api/agent-runs/${live.id}/cancel`, { body: {} }) : null;
    drill.fact("cancel", { status: answer?.status ?? null, code: answer?.body?.code ?? null, run: live?.id ?? null });
    const stopped = live ? await waitFor(drill, person, (runs) => { const row = runs.find((run) => run.id === live.id); return row && !["running", "queued"].includes(row.status) ? row : null; }, { capMs: 5 * 60_000, everyMs: 2000, label: "round stopped" }) : null;
    drill.fact("cancelTookMs", stopped ? Date.now() - t : null);
    drill.fact("cancelledRunState", stopped?.status ?? null);
    const before = person.cached.length;
    await watch(drill, person, { ms: 6 * 60_000, label: "after cancel" });
    drill.fact("roundsAfterCancel", { before, after: person.cached.length });
    await person.close();
  },
  /** A second goal in the same project while the first is running. */
  async D09(drill) {
    const person = await drill.person("a");
    const first = await establish(drill, person, G5);
    await roundRunning(drill, person, first.session, 2);
    const second = await person.setGoal(G_SECOND);
    drill.fact("secondSet", { status: second.status, code: second.code });
    await watch(drill, person, { ms: 22 * 60_000, quietMs: 5 * 60_000, label: "two goals" });
    drill.fact("roundsBySession", { first: person.roundsOf(first.session).length, second: person.roundsOf(second.session).length });
    drill.fact("goalIds", [...new Set(person.cached.map((run) => run.goal?.id ?? null))]);
    await person.close();
  },
  /** A second goal in the same project after the first has gone quiet. */
  async D10(drill) {
    const person = await drill.person("a");
    const first = await establish(drill, person, G_NATURAL);
    await watch(drill, person, { ms: 12 * 60_000, quietMs: 3 * 60_000, label: "first goal" });
    const second = await person.setGoal(G_SECOND);
    drill.fact("secondSet", { status: second.status, code: second.code });
    await watch(drill, person, { ms: 16 * 60_000, quietMs: 5 * 60_000, label: "second goal" });
    drill.fact("roundsBySession", { first: person.roundsOf(first.session).length, second: person.roundsOf(second.session).length });
    drill.fact("goalIds", [...new Set(person.cached.map((run) => run.goal?.id ?? null))]);
    await person.close();
  },
  /** A direction during a round, through the route the page's 补充 uses. */
  async D11(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G5);
    const live = await roundRunning(drill, person, set.session, 2);
    const answer = live ? await person.api("POST", `/api/agent-runs/${live.id}/steer`, { body: { text: "再加一个因素：口服避孕药对咖啡因半衰期的影响，也要写进 notes.md。" } }) : null;
    drill.fact("steer", { status: answer?.status ?? null, code: answer?.body?.code ?? null });
    await watch(drill, person, { ms: 22 * 60_000, quietMs: 5 * 60_000, label: "after steer" });
    await person.close();
  },
  /** A message typed in the gap between rounds. */
  async D12(drill) {
    const person = await drill.person("a");
    const set = await establish(drill, person, G5);
    const gap = await gapAfterRound(drill, person, set.session, 2);
    const words = gap ? await person.say_("顺便把 summary.md 写成英文。", set.session) : null;
    drill.fact("message", { status: words?.status ?? null, code: words?.code ?? null, tookMs: words?.answeredInMs ?? null });
    await watch(drill, person, { ms: 22 * 60_000, quietMs: 5 * 60_000, label: "after message" });
    await person.close();
  },
  /** Production's own limits (2 tasks, 4 runtimes): two goals running, then other people arrive. */
  async D13(drill) {
    const a = await drill.person("a");
    const b = await drill.person("b");
    const [goalA, goalB] = await Promise.all([establish(drill, a, G5), establish(drill, b, G5)]);
    drill.fact("goals", [goalA.status, goalB.status]);
    await roundRunning(drill, a, goalA.session, 2);
    await b.runs();
    const others = [];
    for (const label of ["c", "d", "e"]) {
      const person = await drill.person(label);
      const t = Date.now();
      const answer = await person.say_("用一句话介绍你自己。");
      let finished = null;
      if (answer.run) finished = await waitFor(drill, person, (runs) => { const row = runs.find((run) => run.id === answer.run); return row && !["running", "queued"].includes(row.status) ? row : null; }, { capMs: 8 * 60_000, everyMs: 5000, label: `${label} reply` });
      others.push({ label, status: answer.status, code: answer.code, answeredInMs: answer.answeredInMs, finished: finished?.status ?? null, tookMs: Date.now() - t, runningA: running(await a.runs()).length, runningB: running(await b.runs()).length });
      drill.fact(`arrival-${label}`, others.at(-1));
    }
    await a.runs(); await b.runs();
    drill.fact("runtimes", text((await shell("docker", ["ps", "-q", "--filter", "label=open-science.web.runtime=true"])).stdout).split("\n").filter(Boolean).length);
    for (const person of drill.people) await person.close();
  },
};

async function runDrill(name) {
  const drill = new Drill(name);
  say(`${name} start`);
  try {
    await DRILL[name](drill);
    drill.facts.outcome = "finished";
  } catch (error) {
    drill.facts.outcome = error instanceof CapReached ? "cap" : "error";
    drill.note("drill-stopped", { why: String(error?.message ?? error).slice(0, 400) });
  }
  for (const person of drill.people) await person.close().catch(() => {});
  drill.facts.spend = drill.spend();
  drill.facts.finishedAt = new Date().toISOString();
  writeFileSync(`${drill.dir}/facts.json`, JSON.stringify(drill.facts, null, 1));
  say(`${name} ${drill.facts.outcome} spend=${drill.facts.spend.toFixed(2)} jobSpend=${jobSpend.toFixed(2)} minutes=${Math.round((Date.now() - drill.t0) / 60000)}`);
}

mkdirSync(RESULTS, { recursive: true });
if (PARALLEL) await Promise.all(DRILLS.map(runDrill));
else for (const name of DRILLS) await runDrill(name);
const dmesg = await shell("sh", ["-c", "dmesg -T 2>/dev/null | grep -iE 'oom|killed process' | tail -60; journalctl -k --no-pager 2>/dev/null | grep -iE 'oom-kill|killed process' | tail -60"]);
writeFileSync(`${RESULTS}/kernel-oom.txt`, dmesg.stdout);
say(`done jobSpend=${jobSpend.toFixed(2)} drills=${DRILLS.length}`);
