#!/usr/bin/env node
// Benchmark run driver: ONE lane, one item at a time, against a deployed EviMed Science instance.
//
// It runs ON the production host inside the web image (which carries the throwaway-account helper):
//
//   sudo docker run -d --name bench-<lane> --network host --user 0:0 --stop-timeout 180 \
//     -v /srv/evimed-science/shared/benchmarks:/bench --entrypoint node open-science-web:<rev12> \
//     /bench/tools/bench-driver.mjs --queue /bench/queue/<name>.jsonl --out /bench/results
//
// What it does, per queue line (a JSON object, see below):
//   1. one throwaway account for the whole process (`bench-<UTC>-<hex>`), made through the product's own
//      self-registration and deleted through `DELETE /api/account` on exit, on error and on SIGTERM/SIGINT/SIGHUP
//      (an in-flight run is cancelled first);
//   2. one project per `group` (the previous group's runtime is stopped when the group changes unless `keepRuntime`, and its
//      project deleted when the last item of it said `deleteGroupAfter`);
//   3. the item's input files are uploaded into the project's WORKSPACE (`POST /api/files/upload`, root workspace:
//      a plain atomic write mirrored into a running runtime; only root=base + `knowledge-base/…` becomes a source,
//      so nothing is parsed or pushed to OpenViking);
//   4. a new open-domain research session (what the web app's "new conversation" does), then
//      `POST /api/agent-runs/dispatch {sessionId, dispatchId, text, automated:true[, line]}` — the router decides;
//   5. polling `GET /api/agent-runs` (the project's own list; each captured run is archived so the list stays tiny),
//      a timeout cancels the run and records status "timeout";
//   6. the answer (last assistant message of the transcript), the full transcript, the run record, the cost
//      (`GET /api/runs/:id/usage`) and the text files the run wrote are written to <out>/<key>/…
//
// Files (collectFiles): at most 40 are read, and the report-like ones always come first — a document under a `report/` folder, a
// Markdown/Word/PDF file at any depth (newest, then largest), then the figures of a report, then the rest in the run record's order
// (a 54-file `artifacts` list once hid report/report.md behind its own code files). A run that TIMED OUT also gets the workspace
// scanned (`list_dir`) for report-like files written after the dispatch: the newest ones are captured too and the newest document is
// recorded as `lastReport` {path, bytes, mtime, saved} (the newest one under `report/`, else the newest anywhere): a draft that
// existed at the cap. Scorers read it as delivery "at-cap" and report both figures: strict (timeout = 0) and at-cap
// (judge_packets.py, report.py).
// Timing: `firstReportAtMs` is the first write of a report-like file by a tool call of the transcript (milliseconds after the turn
// began; `firstReportPath` says which file), `deliveredWithinCap` is true when the run ended on its own, inside the cap, with an answer
// or a report; both are null/false when the facts are not there, never guessed.
//
// Queue line: {"key":"<bench>/<id>","bench":"…","id":"…","group":"…","prompt":"…","line":null|"answer"|"<capability-id>",
//   "timeoutMin":15,"files":[{"src":"/bench/data/…","dest":"inputs/x.csv"}],"collect":true,"deleteGroupAfter":false,
//   "keepRuntime":false,"groupSkill":null|{"title":"…","description":"…","instructions":"…"},"expectInAnswer":"…",
//   "timeBudgetMinutes":<absent|positive number>}
//
// timeBudgetMinutes: the optional dispatch field of the same name, passed to the product as given when the item sets it and left out
// otherwise (the run budget the product shows the model; `timeoutMin` stays this driver's own cap and is never sent).
//
// The key names the result folder: `/` becomes `__` and every character outside [A-Za-z0-9_.-] becomes `_`, so
// `bench/123#r1` is `bench__123_r1`. Two keys that map to one folder are refused when the queue is read.
//
// keepRuntime: moving on from a group stops that group's runtime, unless the last item of the group left or the first item of
//   the group entered says `keepRuntime: true` (an alternating pair of groups keeps both runtimes; at most two are kept, the
//   least recently used yields). A group whose last item said `deleteGroupAfter` is stopped and deleted regardless.
// groupSkill: the same object on every item of a group (or null on all of them). The first item of the group makes the
//   personal skill (`POST /api/skills`), selects it for the group's project (`PUT /api/projects/:id/skills`), starts the
//   runtime with nothing running and waits for the activation to be proven, so the first run carries the skill. Every
//   result.json says which skill (`groupSkill`), the activation before and after (`skillActivationBefore/After`) and what
//   shows it was mounted (`skillEvidence`, `personalPinsInRun`). A group without a skill must have an empty selection (checked
//   before every dispatch, `skillSelectionBefore`) or the item is a driver error and never dispatched.
// expectInAnswer: a text the answer should contain; the outcome is `checks.expectInAnswer` (a probe, never a gate).
//
// Resumable: an item whose result.json has a FINAL status (succeeded, failed, canceled, timeout — the run started and
// ended) is skipped. A run that was interrupted by this driver's own stop, a refused dispatch and a driver error leave a
// non-final result (`interrupted`, `dispatch_refused`, `driver_error`) and are run again by the next start, the earlier
// attempt kept in `previousAttempts`. A dispatch refused with 429/423 is asked again after 60 s (10 times, each time
// with a fresh session and dispatch id, because a refused dispatch is recorded as a failed run under its id); one answered
// 500/502/503/504 is infrastructure and is asked again with a bounded exponential backoff (see INFRA_*), every try recorded in
// result.json `dispatchRetries` and `infrastructure`; if it never succeeds the item is `dispatch_refused` with
// `infrastructureFailure: true` (so it is told apart from a run that failed). A dispatch that did not answer at all is looked up
// by its dispatch id and adopted if the run exists, never sent twice.
//
// Stop gracefully by creating <out>/STOP (the lane finishes the item in hand and exits), or `docker stop -t 180`.
// Exit: 0 done, 2 driver error, 3 five items in a row could not run, 4 the account was not deleted, 130/143/129 signals.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DRIVER = "bench-driver/3";
const HELPER = process.env.BENCH_THROWAWAY_HELPER ?? "/app/scripts/ops/throwaway-account.mjs";
const { fetchTransport, openThrowawayAccount } = await import(HELPER);

/** Run statuses the control plane ends a run in. */
const TERMINAL_RUN = new Set(["succeeded", "failed", "canceled"]);
/** Item statuses that are final: the run started and ended. Anything else is run again on the next start. */
const FINAL_ITEM = new Set(["succeeded", "failed", "canceled", "timeout"]);
/** Item statuses that mean the item never ran (five in a row stop the lane). */
const NOT_RUN = new Set(["driver_error", "dispatch_refused"]);
/** `OPEN_SCIENCE_MAX_FILE_BYTES` on production; a bigger file is refused by the server (413). */
const MAX_UPLOAD_BYTES = 52_428_800;
const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const ARTIFACT_MAX_FILES = 40;
const REFUSAL_RETRIES = 10;
const REFUSAL_WAIT_MS = 60_000;
/** A dispatch answered 5xx (a release switching, a gateway restarting) is infrastructure, not the item: asked again with a bounded
 *  exponential backoff (10 s, 20 s … capped at 2 min, 12 tries, about 19 minutes) and recorded as such in result.json. */
const INFRA_STATUSES = new Set([500, 502, 503, 504]);
const INFRA_RETRIES = 12;
const INFRA_WAIT_MS = 10_000;
const INFRA_WAIT_CAP_MS = 120_000;
const CANCEL_GRACE_MS = 90_000;
/** Workspace scan after a timeout: directories listed at most, depth, and the newest report-like files taken beyond the run record. */
const SCAN_MAX_DIRS = 80;
const SCAN_MAX_DEPTH = 5;
const SCAN_EXTRA_REPORTS = 12;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */ const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unrecognized argument: ${argv[i]}`);
    if (match[2] !== undefined) out[match[1]] = match[2];
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) { out[match[1]] = argv[i + 1]; i += 1; } else out[match[1]] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.help || !args.queue || !args.out) {
  console.log("usage: bench-driver.mjs --queue <file.jsonl> --out <dir> [--base http://127.0.0.1:18887] [--poll-ms 8000] [--limit N]\n"
    + "       [--min-credits 40] [--skill-warmup-s 180] [--no-skill-warmup] [--no-archive] [--retry-scale 1] [--insecure]");
  process.exit(args.help ? 0 : 2);
}
const base = String(args.base ?? "http://127.0.0.1:18887").replace(/\/+$/, "");
if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const queueFile = path.resolve(String(args.queue));
const outDir = path.resolve(String(args.out));
const pollMs = Number(args["poll-ms"] ?? 8000);
const limit = args.limit === undefined ? Infinity : Number(args.limit);
const minCredits = Number(args["min-credits"] ?? 40);
const archiveRuns = args["no-archive"] !== true;
/** Multiplies every refusal wait (tests use a tiny value; production leaves it at 1). */
const retryScale = Number(args["retry-scale"] ?? 1);
const waitFor = (/** @type {number} */ ms) => Math.max(1, Math.round(ms * (Number.isFinite(retryScale) && retryScale > 0 ? retryScale : 1)));
const logFile = path.join(outDir, "driver.log");
const stopFile = path.join(outDir, "STOP");

/** The line goes to stdout and to <out>/driver.log. It never carries a cookie, a token or a password. @param {string} line */
function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(entry);
  try { appendFileSync(logFile, entry); } catch { /* the console line stands */ }
}

/** @type {{ headers: Record<string, string>, id: string, close: () => Promise<{ deleted: boolean }> } | null} */
let account = null;
let shuttingDown = false;

/**
 * One call as the throwaway account. A transport failure is status 0, never a throw.
 * @param {string} method @param {string} route @param {{ body?: unknown, project?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, body: any, code: string | null, retryAfterMs: number | null }>}
 */
async function api(method, route, { body, project, timeoutMs = 60_000 } = {}) {
  const headers = { ...account?.headers, "x-evimed-automated": "1", ...(project ? { "x-open-science-project": project } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }) };
  try {
    const response = await fetch(`${base}${route}`, { method, headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const retryAfter = Number(response.headers.get("retry-after"));
    return { status: response.status, body: parsed, code: typeof parsed?.code === "string" ? parsed.code : null,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null };
  } catch (error) {
    const why = /** @type {any} */ (error);
    return { status: 0, body: null, code: "transport", retryAfterMs: null, error: String(why?.cause?.code ?? why?.name ?? "fetch_failed").slice(0, 60) };
  }
}
const said = (/** @type {{ status: number, code: string | null }} */ answer) => `${answer.status}${answer.code ? ` ${answer.code}` : ""}`;

/** @param {string} key */
const itemDir = (key) => path.join(outDir, key.replace(/\//g, "__").replace(/[^\w.\-]/g, "_"));

/** Write a file whole or not at all. @param {string} file @param {string | Buffer} content */
async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

/** @param {string} dir */
async function readResult(dir) {
  try { return JSON.parse(await readFile(path.join(dir, "result.json"), "utf8")); } catch { return null; }
}

/** A project id the product accepts (`^[a-z0-9][a-z0-9_-]{0,63}$`, not reserved) and the same group always gets. @param {string} group */
function projectIdFor(group) {
  const slug = group.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
  return `bench-${slug ? `${slug}-` : ""}${createHash("sha256").update(group).digest("hex").slice(0, 6)}`;
}

// ----------------------------------------------------------------------------------------------------------- groups

/**
 * A group is a project. `kept` says its runtime was left running when the lane moved on (`keepRuntime`);
 * `skill` is its personal skill once made (see "personal skills" below).
 * @typedef {{ name: string, projectId: string, deleteAfter: boolean, keepRuntime: boolean, kept: boolean, lastUsed: number,
 *   skill: Record<string, any> | null, plain: boolean }} Group
 */
/** @type {Map<string, Group>} */
const groups = new Map();
/** @type {Group | null} */
let currentGroup = null;
/** The product runs at most two runtimes per account; the lane keeps at most this many left running. */
const MAX_KEPT_RUNTIMES = 2;

/**
 * Make the item's group the current one and return it. Moving on from another group stops that group's runtime, unless
 * its last item or this one says `keepRuntime` (an alternating pair of groups keeps both runtimes); a group whose last
 * item said `deleteGroupAfter` is deleted instead. A group that comes back finds its project (and skill) as it left them.
 * @param {any} item @returns {Promise<Group>}
 */
async function enterGroup(item) {
  if (currentGroup && currentGroup.name !== item.group) await leaveGroup(currentGroup, item);
  let group = groups.get(item.group);
  if (!group) {
    const projectId = projectIdFor(item.group);
    const made = await api("POST", "/api/projects", { body: { id: projectId, name: `bench ${item.group}`.slice(0, 40) } });
    // A project that is already there (409 project_exists) is gone on in.
    const reused = made.status === 409 && made.code === "project_exists";
    if (made.status !== 200 && made.status !== 201 && !reused) throw new Error(`project ${projectId} was not created (${said(made)})`);
    group = { name: item.group, projectId, deleteAfter: false, keepRuntime: false, kept: false, lastUsed: 0, skill: null, plain: false };
    groups.set(item.group, group);
    log(`group ${item.group}: project ${projectId} ${reused ? "reused" : "created"}`);
  }
  // Room for this group's runtime beside the ones kept: the least recently used kept group yields.
  if (currentGroup !== group) {
    const others = [...groups.values()].filter((other) => other !== group && other.kept).sort((a, b) => a.lastUsed - b.lastUsed);
    while (others.length > MAX_KEPT_RUNTIMES - 1) await stopGroupRuntime(/** @type {Group} */ (others.shift()), "runtime cap");
  }
  currentGroup = group;
  group.lastUsed = Date.now();
  group.deleteAfter = item.deleteGroupAfter === true;
  group.keepRuntime = item.keepRuntime === true;
  return group;
}

/** @param {Group} group @param {any} next the item that follows, or null at the end of the lane */
async function leaveGroup(group, next) {
  currentGroup = null;
  if (!group.deleteAfter && (group.keepRuntime || next?.keepRuntime === true)) {
    group.kept = true;
    log(`group ${group.name}: runtime kept running (keepRuntime)`);
    return;
  }
  await closeGroup(group, "group changed");
}

/** @param {Group} group @param {string} reason */
async function stopGroupRuntime(group, reason) {
  group.kept = false;
  const stopped = await api("POST", "/api/commands/stop_runtime", { body: {}, project: group.projectId, timeoutMs: 120_000 });
  log(`group ${group.name}: runtime stop -> ${said(stopped)} (${reason})`);
}

/** Stop the group's runtime and, when its last item said so, delete the project. @param {Group} group @param {string} reason */
async function closeGroup(group, reason) {
  if (currentGroup === group) currentGroup = null;
  await stopGroupRuntime(group, reason);
  if (!group.deleteAfter) return;
  groups.delete(group.name);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const deleted = await api("DELETE", `/api/projects/${encodeURIComponent(group.projectId)}`, { body: { confirm: group.projectId }, timeoutMs: 120_000 });
    log(`group ${group.name}: project ${group.projectId} delete -> ${said(deleted)}`);
    if (deleted.status === 200 || deleted.status === 404) return;
    if (deleted.status !== 409 && deleted.status !== 0 && deleted.status < 500) return;
    await sleep(5_000);
  }
}

/** The end of the lane: every group's runtime is stopped and the flagged projects deleted. */
async function closeAllGroups() {
  for (const group of [...groups.values()]) await closeGroup(group, "lane end").catch(() => {});
}

// ----------------------------------------------------------------------------------------------------------- credits

/** @type {number | null} */
let lastAvailable = null;

/**
 * A new account holds 200 simulated credits (one credit per CNY) and a run is charged to it. Below `--min-credits` the
 * account takes the product's own simulated top-up (`POST /api/simulated-wallet/topups`, a closed list of packages,
 * idempotent on the request id); a deployment without that wallet answers 404 and the lane just goes on.
 * @param {boolean} [force] top up now, a dispatch having been refused for credits
 */
async function ensureCredits(force = false) {
  const balance = await readAvailable();
  if (!force && (balance === null || balance >= minCredits)) return;
  const topped = await api("POST", "/api/simulated-wallet/topups", { body: { packageId: "topup-500", requestId: `bench-${randomBytes(8).toString("hex")}` } });
  log(`allowance ${balance ?? "unknown"} credits: top-up of 500 -> ${said(topped)}`);
  await readAvailable();
}

async function readAvailable() {
  const read = await api("GET", "/api/credits/balance");
  const value = Number(read.body?.data?.available ?? read.body?.data?.balance);
  lastAvailable = read.status === 200 && Number.isFinite(value) ? value : null;
  return lastAvailable;
}

// ----------------------------------------------------------------------------------------------------------- personal skills

/** Activation phases (`GET /api/projects/:id/skills` → `activation.phase`) that mean the saved selection is what a run mounts:
 *  `effective` — proven on the live runtime; `ready` — no runtime runs and the last proven generation carries the selection. */
const MOUNTED_PHASES = new Set(["effective", "ready"]);
/** Phases that will not turn into `effective` by waiting. */
const FAILED_PHASES = new Set(["failed", "rolled-back", "deferred", "not-applicable"]);
const skillWarmupMs = Number(args["skill-warmup-s"] ?? 180) * 1000;
const skillWarmup = args["no-skill-warmup"] !== true;

/** @param {{ title: string, description: string, instructions: string }} spec */
const skillDigest = (spec) => createHash("sha256").update(JSON.stringify([spec.title, spec.description, spec.instructions])).digest("hex");
const projectPath = (/** @type {string} */ projectId) => `/api/projects/${encodeURIComponent(projectId)}`;

/** The project's saved skill selection with its activation, as the product's skills page reads it. @param {string} projectId */
async function readSelection(projectId) {
  const read = await api("GET", `${projectPath(projectId)}/skills`, { project: projectId });
  if (read.status !== 200 || !read.body?.data) throw new Error(`project skill selection unreadable (${said(read)})`);
  return read.body.data;
}

/** @param {any} selection */
const activationOf = (selection) => {
  const a = selection?.activation ?? {};
  return { phase: a.phase ?? null, live: a.live ?? null, savedRevision: a.savedRevision ?? selection?.revision ?? null,
    effectiveRevision: a.effectiveRevision ?? null, error: a.error ?? null };
};
const selectedSkills = (/** @type {any} */ selection) => Array.isArray(selection?.payload?.skills) ? selection.payload.skills : [];

/**
 * Make the group's personal skill (once) and select it for the group's project; with a group that has none, assert that
 * nothing is selected. Fills `groupSkill`, `skillSelectionBefore` and `skillActivationBefore` of the item's result.
 *
 * The first run of a project cannot be relied on to mount a skill saved a moment before it: the runtime start that a
 * dispatch causes happens while the dispatched run is already `running` in the ledger, and the product does not mount a
 * changed selection under work in flight (`personalGenerationForStart`). So a skill group is warmed up first — the
 * runtime is started with nothing running (`start_runtime`), which mounts the selection, and the activation is read until
 * the product has proven it (`effective`). A skill that was not mounted is written down and shouted, never hidden.
 * @param {Group} group @param {any} item @param {Record<string, any>} result
 */
async function prepareGroupSkill(group, item, result) {
  const projectId = group.projectId;
  if (!item.groupSkill) {
    if (group.skill) throw new Error(`group ${group.name} has a personal skill and item ${item.key} has no groupSkill`);
    group.plain = true;
    // A deployment whose skill library cannot be read is not a reason to stop ordinary work: only a selection that is read
    // and is not empty fails the item.
    const read = await api("GET", `${projectPath(projectId)}/skills`, { project: projectId });
    const selection = read.status === 200 ? read.body?.data : null;
    if (selection && selectedSkills(selection).length) throw new Error(`group ${group.name} has no groupSkill but ${selectedSkills(selection).length} personal skill(s) are selected`);
    Object.assign(result, { groupSkill: null, skillSelectionBefore: selection ? { revision: selection.revision, selected: 0 } : { unreadable: said(read) } });
    return;
  }
  const spec = item.groupSkill;
  const digest = skillDigest(spec);
  if (group.plain) throw new Error(`group ${group.name} ran items without a skill and item ${item.key} has one`);
  if (group.skill && group.skill.digest !== digest) throw new Error(`item ${item.key}: groupSkill differs from the one group ${group.name} already has`);
  if (!group.skill) {
    const made = await api("POST", "/api/skills", { body: { expectedRevision: 0, title: spec.title, description: spec.description, instructions: spec.instructions }, timeoutMs: 180_000 });
    const row = made.body?.data;
    if ((made.status !== 201 && made.status !== 200) || typeof row?.id !== "string" || !Number.isInteger(row.revision)) throw new Error(`personal skill was not created (${said(made)})`);
    group.skill = { skillId: row.id, revision: row.revision, nativeName: row.payload?.nativeName ?? null, serverDigest: row.payload?.digest ?? null,
      digest, title: spec.title, selectionRevision: null };
    log(`group ${group.name}: personal skill ${row.id} revision ${row.revision} created (${group.skill.nativeName ?? "no native name"})`);
  }
  const skill = group.skill;
  let selection = await readSelection(projectId);
  const chosen = selectedSkills(selection);
  if (!(chosen.length === 1 && chosen[0].skillId === skill.skillId && chosen[0].revision === skill.revision)) {
    const saved = await api("PUT", `${projectPath(projectId)}/skills`, { project: projectId, timeoutMs: 120_000,
      body: { expectedRevision: selection.revision, skills: [{ skillId: skill.skillId, revision: skill.revision }] } });
    if (saved.status !== 200) throw new Error(`personal skill was not selected (${said(saved)})`);
    log(`group ${group.name}: skill selected (selection revision ${saved.body?.data?.revision ?? "?"})`);
    selection = await readSelection(projectId);
  }
  skill.selectionRevision = selection.revision;
  let activation = activationOf(selection);
  if (skillWarmup && !MOUNTED_PHASES.has(String(activation.phase))) activation = await warmUpGroupRuntime(group, activation);
  Object.assign(result, {
    groupSkill: { skillId: skill.skillId, revision: skill.revision, selectionRevision: skill.selectionRevision, nativeName: skill.nativeName,
      digest: skill.digest, serverDigest: skill.serverDigest, title: skill.title },
    skillSelectionBefore: { revision: selection.revision, selected: 1 }, skillActivationBefore: activation,
  });
  if (!MOUNTED_PHASES.has(String(activation.phase))) {
    log(`SKILL-ACTIVATION-WARN item ${item.key}: before the run the activation is ${activation.phase}${activation.error ? ` (${activation.error})` : ""}, not effective; the run may not carry the skill`);
  }
}

/** Start the group's runtime with nothing running and wait for the product to prove the selection. @param {Group} group @param {any} before */
async function warmUpGroupRuntime(group, before) {
  const started = await api("POST", "/api/commands/start_runtime", { body: {}, project: group.projectId, timeoutMs: 240_000 });
  log(`group ${group.name}: skill warm-up: start_runtime -> ${said(started)} (activation was ${before.phase})`);
  const began = Date.now();
  let activation = before;
  while (Date.now() - began < skillWarmupMs) {
    activation = activationOf(await readSelection(group.projectId));
    if (activation.phase === "effective" || FAILED_PHASES.has(String(activation.phase))) break;
    await sleep(3_000);
  }
  log(`group ${group.name}: skill warm-up: activation ${activation.phase} after ${Math.round((Date.now() - began) / 1000)} s`);
  return activation;
}

/**
 * Does the live kernel list the skill? The product's own catalogue read (`GET /api/projects/:id/skills/effective?sessionId=`)
 * asks the running runtime (`evimedSkills/list`), so it is asked while the run is going. Best effort, a few tries.
 * @param {Group} group @param {string} sessionId
 */
async function probeCatalogue(group, sessionId) {
  const skill = /** @type {Record<string, any>} */ (group.skill);
  /** @type {Record<string, any>} */ let seen = { status: null };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const read = await api("GET", `${projectPath(group.projectId)}/skills/effective?sessionId=${encodeURIComponent(sessionId)}`, { project: group.projectId, timeoutMs: 30_000 });
    const data = read.body?.data;
    if (read.status === 200 && data) {
      const items = Array.isArray(data.items) ? data.items : [];
      const mine = items.find((/** @type {any} */ entry) => entry.source === "personal" && (entry.name === skill.nativeName || entry.personalRef?.skillId === skill.skillId));
      return { status: 200, state: data.state ?? null, runtimeGeneration: data.runtimeGeneration ?? null, items: items.length, found: Boolean(mine),
        personal: items.filter((/** @type {any} */ entry) => entry.source === "personal").map((/** @type {any} */ entry) => ({ name: entry.name, title: entry.personalRef?.title ?? null })),
        entry: mine ? { name: mine.name, source: mine.source, invocation: mine.invocation, personalRef: mine.personalRef ?? null, description: String(mine.description ?? "").slice(0, 200) } : null };
    }
    seen = { status: read.status, code: read.code };
    await sleep(2_000);
  }
  return { ...seen, found: false };
}

/** The `tool` parts of a transcript. @param {any[]} messages */
const toolParts = (messages) => messages.flatMap((message) => (message?.parts ?? []).filter((/** @type {any} */ part) => part?.type === "tool"));

/**
 * After the run: what the run record and the transcript say about the personal skill, and the activation again.
 * `personalPinsInRun` is the runtime's skill pins the control plane wrote into the run when it sent the prompt
 * (`run.personalSkillGeneration.pins`) — the plainest answer to "did this run carry the skill", and for a group without a
 * skill it must be empty. Fills `skillEvidence`, `skillActivationAfter` and the `checks`.
 * @param {Group} group @param {any} item @param {any} run @param {any[]} messages @param {string} answer @param {Record<string, any>} result
 */
async function recordSkillOutcome(group, item, run, messages, answer, result) {
  const skill = group.skill;
  const pins = (run.personalSkillGeneration?.pins ?? []).map((/** @type {any} */ pin) => ({ skillId: pin.skillId, revision: pin.revision, nativeName: pin.nativeName }));
  result.personalPinsInRun = pins;
  if (typeof item.expectInAnswer === "string") result.checks = { expectInAnswer: answer.includes(item.expectInAnswer) };
  if (!skill) {
    if (pins.length) log(`SKILL-CONTROL-WARN item ${item.key}: a group without a skill ran with ${pins.length} personal skill pin(s)`);
    return;
  }
  const mountedInRun = pins.some((/** @type {any} */ pin) => pin.skillId === skill.skillId && pin.revision === skill.revision);
  const calls = toolParts(messages).filter((part) => /skill/i.test(String(part.tool)));
  const names = [skill.nativeName, skill.title].filter(Boolean);
  const loadedByModel = calls.some((part) => names.some((name) => JSON.stringify(part.input ?? "").includes(name)));
  const nameInTranscript = skill.nativeName ? JSON.stringify(messages).includes(skill.nativeName) : null;
  let after = activationOf(await readSelection(group.projectId).catch(() => null));
  // A cold-started runtime proves the selection a few seconds after it starts: `waiting` is read again.
  for (let attempt = 0; attempt < 5 && after.phase === "waiting"; attempt += 1) {
    await sleep(3_000);
    after = activationOf(await readSelection(group.projectId).catch(() => null));
  }
  result.skillActivationAfter = after;
  result.skillEvidence = { ...(result.skillEvidence ?? {}), mountedInRun, runPins: pins, nameInTranscript,
    skillToolCalls: calls.slice(0, 5).map((part) => ({ tool: part.tool, input: JSON.stringify(part.input ?? "").slice(0, 200) })), loadedByModel };
  log(`item ${item.key}: skill mountedInRun=${mountedInRun} catalogue=${result.skillEvidence.catalogue?.found ?? "?"} loadedByModel=${loadedByModel} `
    + `activation before=${result.skillActivationBefore?.phase} after=${after.phase}${result.checks ? ` expectInAnswer=${result.checks.expectInAnswer}` : ""}`);
  if (!mountedInRun) log(`SKILL-NOT-MOUNTED item ${item.key}: the run record carries no pin for skill ${skill.skillId} revision ${skill.revision}`);
  if (!MOUNTED_PHASES.has(String(after.phase))) log(`SKILL-ACTIVATION-WARN item ${item.key}: after the run the activation is ${after.phase}${after.error ? ` (${after.error})` : ""}, not effective`);
}

// ----------------------------------------------------------------------------------------------------------- one item

/** The dispatch was refused and never became a run. */
class Refused extends Error {
  /** @param {string} message @param {string | null} code */
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * What is in flight, for the stop hook: the item's result so far and its run.
 * @type {{ dir: string, result: Record<string, any>, projectId: string | null, runId: string | null, runStatus: string | null } | null}
 */
let inflight = null;

/** @param {any} item */
async function processItem(item) {
  const dir = itemDir(item.key);
  const previous = await readResult(dir);
  /** @type {Record<string, any>} */
  const result = {
    key: item.key, bench: item.bench ?? null, id: item.id ?? null, group: item.group, line: item.line ?? null, status: "driver_error",
    startedAt: new Date().toISOString(), finishedAt: null, promptChars: item.prompt.length,
    promptSha256: createHash("sha256").update(item.prompt).digest("hex"), driver: DRIVER, base, accountId: account?.id ?? null,
    previousAttempts: previous ? [...(previous.previousAttempts ?? []), { status: previous.status, runId: previous.runId ?? null, startedAt: previous.startedAt ?? null, error: previous.error ?? null }] : [],
  };
  inflight = { dir, result, projectId: null, runId: null, runStatus: null };
  log(`item ${item.key}: start (group ${item.group}, line ${item.line ?? "router"}, timeout ${item.timeoutMin ?? 15} min)`);
  try {
    await ensureCredits();
    result.credits = { before: lastAvailable, after: null };
    const group = await enterGroup(item);
    const projectId = group.projectId;
    inflight.projectId = result.projectId = projectId;
    await prepareGroupSkill(group, item, result);
    result.uploads = await uploadInputs(item, projectId);
    const started = await startRun(item, projectId, result);
    if (group.skill) result.skillEvidence = { catalogue: await probeCatalogue(group, result.sessionId) };
    const finished = await waitForRun(item, projectId, started);
    await capture(item, group, finished, result, dir);
  } catch (error) {
    if (shuttingDown) return result;
    const why = /** @type {any} */ (error);
    result.status = error instanceof Refused ? "dispatch_refused" : "driver_error";
    result.error = String(why?.message ?? why).slice(0, 300);
    if (error instanceof Refused) result.errorCode = error.code;
    // A run that started and could not be followed is stopped; the item is run again on the next start.
    if (inflight?.runId && !TERMINAL_RUN.has(String(inflight.runStatus))) await cancelRun(inflight.projectId ?? "", inflight.runId);
    log(`item ${item.key}: ${result.status} (${result.error})`);
  }
  if (shuttingDown) return result;
  result.finishedAt = new Date().toISOString();
  await writeAtomic(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  log(`item ${item.key}: ${result.status}${result.errorCode ? ` ${result.errorCode}` : ""} wall=${Math.round(((Date.parse(result.finishedAt) - Date.parse(result.startedAt)) / 1000))}s`
    + `${result.cost ? ` cost=${result.cost.cost}` : ""}`);
  inflight = null;
  return result;
}

/** Upload the item's files into the project's workspace. @param {any} item @param {string} projectId */
async function uploadInputs(item, projectId) {
  const uploads = [];
  for (const file of item.files ?? []) {
    const dest = String(file.dest ?? "");
    if (!dest || dest.startsWith("/") || dest.split("/").some((part) => part === ".." || part === "")) throw new Error(`upload destination ${JSON.stringify(dest)} is not a relative path`);
    const bytes = await readFile(String(file.src));
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`${dest}: ${bytes.length} bytes is over the ${MAX_UPLOAD_BYTES} byte upload limit`);
    let answer;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      answer = await api("POST", "/api/files/upload", { project: projectId, timeoutMs: 300_000,
        body: { path: dest, data: bytes.toString("base64"), encoding: "base64" } });
      if (answer.status === 200) break;
      if (answer.status !== 429 && answer.status !== 0 && answer.status < 500) break;
      await sleep(answer.retryAfterMs ?? 20_000);
    }
    if (answer?.status !== 200) throw new Error(`upload of ${dest} failed (${answer ? said(answer) : "no answer"})`);
    uploads.push({ dest, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (uploads.length) log(`item ${item.key}: ${uploads.length} file(s) uploaded (${uploads.reduce((sum, file) => sum + file.bytes, 0)} bytes)`);
  return uploads;
}

/**
 * What a refusal is worth waiting for: `null` when it is final, else the wait before the next try. 429/423 are a busy
 * platform (flat 60 s, 10 tries); 5xx is infrastructure (bounded exponential backoff). Every retry is written to the result.
 * @param {Record<string, any>} result @param {{ status: number, code: string | null, retryAfterMs: number | null }} answer
 * @param {{ busy: number, infra: number }} tries
 * @returns {{ waitMs: number, kind: "busy" | "infrastructure", n: number, of: number } | null}
 */
function refusalWait(result, answer, tries) {
  /** @type {{ waitMs: number, kind: "busy" | "infrastructure", n: number, of: number } | null} */
  let wait = null;
  if (INFRA_STATUSES.has(answer.status) && tries.infra < INFRA_RETRIES) {
    tries.infra += 1;
    wait = { waitMs: waitFor(Math.min(INFRA_WAIT_MS * 2 ** (tries.infra - 1), INFRA_WAIT_CAP_MS)), kind: "infrastructure", n: tries.infra, of: INFRA_RETRIES };
  } else if ([429, 423].includes(answer.status) && tries.busy < REFUSAL_RETRIES) {
    tries.busy += 1;
    wait = { waitMs: waitFor(REFUSAL_WAIT_MS), kind: "busy", n: tries.busy, of: REFUSAL_RETRIES };
  }
  if (!wait) return null;
  (result.dispatchRetries ??= []).push({ status: answer.status, code: answer.code, kind: wait.kind, waitedMs: wait.waitMs });
  if (wait.kind === "infrastructure") result.infrastructure = { retries: tries.infra, statuses: [...new Set(result.dispatchRetries.filter((/** @type {any} */ row) => row.kind === "infrastructure").map((/** @type {any} */ row) => row.status))] };
  return wait;
}

/**
 * A new open-domain conversation and its dispatch. Returns the run.
 * @param {any} item @param {string} projectId @param {Record<string, any>} result
 */
async function startRun(item, projectId, result) {
  let credited = false;
  const tries = { busy: 0, infra: 0 };
  const timeBudget = Number(item.timeBudgetMinutes);
  if (Number.isFinite(timeBudget) && timeBudget > 0) result.timeBudgetMinutes = timeBudget;
  for (let attempt = 1; ; attempt += 1) {
    const sessionId = `web-${randomBytes(12).toString("hex")}`;
    const dispatchId = `web-${randomBytes(16).toString("hex")}`;
    const bound = await api("PUT", `/api/research-sessions/${sessionId}`, { project: projectId, body: { mode: "open-domain" } });
    if (bound.status !== 200) {
      const wait = refusalWait(result, bound, tries);
      if (wait) { log(`item ${item.key}: session not made (${said(bound)}); ${wait.kind}, asking again in ${Math.round(wait.waitMs / 1000)} s (${wait.n}/${wait.of})`); await sleep(wait.waitMs); continue; }
      throw refused(result, `session ${sessionId} was not made (${said(bound)})`, bound);
    }
    const body = { sessionId, dispatchId, text: item.prompt, automated: true, ...(item.line ? { line: item.line } : {}), ...(result.timeBudgetMinutes ? { timeBudgetMinutes: result.timeBudgetMinutes } : {}) };
    const asked = Date.now();
    // `automated: true` again in the call itself: the repository-wide check reads the dispatch statement, not the line above it.
    const answer = await api("POST", "/api/agent-runs/dispatch", { project: projectId, body: { ...body, automated: true }, timeoutMs: 10 * 60_000 });
    if (answer.status === 202 && answer.body?.data?.id) {
      const run = answer.body.data;
      Object.assign(result, { sessionId, dispatchId, runId: run.id, dispatchedAt: new Date().toISOString(), dispatchMs: Date.now() - asked });
      if (inflight) Object.assign(inflight, { runId: run.id, runStatus: run.status });
      log(`item ${item.key}: dispatched run ${run.id} (attempt ${attempt}, answered in ${Date.now() - asked} ms)`);
      return run;
    }
    if (answer.status === 0) {
      // No answer: the run may exist. Look for it by its dispatch id and adopt it; never send the prompt twice.
      await sleep(5_000);
      const list = await api("GET", "/api/agent-runs", { project: projectId });
      const found = list.body?.data?.find?.((/** @type {any} */ run) => run.dispatchId === dispatchId);
      if (found) {
        Object.assign(result, { sessionId, dispatchId, runId: found.id, dispatchedAt: found.createdAt ?? new Date().toISOString(), dispatchMs: Date.now() - asked });
        if (inflight) Object.assign(inflight, { runId: found.id, runStatus: found.status });
        log(`item ${item.key}: dispatch did not answer (${/** @type {any} */ (answer).error}); run ${found.id} exists and is followed`);
        return found;
      }
      throw new Error(`dispatch did not answer (${/** @type {any} */ (answer).error}) and no run carries its id`);
    }
    if (answer.status === 402 && !credited) { credited = true; await ensureCredits(true); continue; }
    const wait = refusalWait(result, answer, tries);
    if (wait) {
      log(`item ${item.key}: dispatch refused (${said(answer)}); ${wait.kind === "infrastructure" ? "infrastructure, " : ""}asking again in ${Math.round(wait.waitMs / 1000)} s (${wait.n}/${wait.of})`);
      await sleep(wait.waitMs);
      continue;
    }
    throw refused(result, `dispatch refused (${said(answer)})`, answer);
  }
}

/** A refusal that is final. A 5xx that outlasted its backoff says so: the platform was down, the item did not fail. */
function refused(/** @type {Record<string, any>} */ result, /** @type {string} */ message, /** @type {{ status: number, code: string | null }} */ answer) {
  if (INFRA_STATUSES.has(answer.status)) result.infrastructureFailure = true;
  return new Refused(message, answer.code);
}

/** @param {string} projectId @param {string} runId */
async function cancelRun(projectId, runId) {
  const answer = await api("POST", `/api/agent-runs/${encodeURIComponent(runId)}/cancel`, { project: projectId, body: {}, timeoutMs: 120_000 });
  log(`run ${runId}: cancel -> ${said(answer)}`);
  return answer;
}

/**
 * Follow the run to a terminal status or the item's timeout (the run is then cancelled).
 * @param {any} item @param {string} projectId @param {any} startedRun
 * @returns {Promise<{ run: any, timedOut: boolean }>}
 */
async function waitForRun(item, projectId, startedRun) {
  let run = startedRun;
  let deadline = Date.now() + Number(item.timeoutMin ?? 15) * 60_000;
  let timedOut = false;
  let lastPhase = "";
  const waitStarted = Date.now();
  while (!TERMINAL_RUN.has(run.status)) {
    if (shuttingDown) throw new Error("interrupted");
    if (Date.now() >= deadline) {
      if (timedOut) break; // cancelled and still not ended after the grace: recorded as timeout with the last status seen
      timedOut = true;
      log(`item ${item.key}: timeout after ${item.timeoutMin ?? 15} min; cancelling run ${run.id}`);
      await cancelRun(projectId, run.id);
      deadline = Date.now() + CANCEL_GRACE_MS;
    }
    // Quick questions end in seconds: look often in the first minute, then every --poll-ms.
    await sleep(Date.now() - waitStarted < 60_000 ? Math.min(pollMs, 3_000) : pollMs);
    const list = await api("GET", "/api/agent-runs", { project: projectId });
    const found = list.status === 200 ? list.body?.data?.find?.((/** @type {any} */ candidate) => candidate.id === run.id) : null;
    if (!found) continue; // a poll that failed, or a list that does not hold the run yet: the next poll asks again
    run = found;
    if (inflight) inflight.runStatus = run.status;
    const phase = `${run.status}/${run.phase ?? "-"} msgs=${run.observedMessages ?? 0} tools=${run.observedToolCalls ?? 0}`;
    if (phase !== lastPhase) { log(`item ${item.key}: ${phase}`); lastPhase = phase; }
  }
  return { run, timedOut };
}

// ----------------------------------------------------------------------------------------------------------- capture

/** The text of the last assistant message that has any. @param {any[]} messages */
function finalAnswer(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = message?.role ?? message?.info?.role;
    if (role !== "assistant") continue;
    const text = (message.parts ?? []).filter((/** @type {any} */ part) => part?.type === "text" && !part.synthetic && typeof part.text === "string")
      .map((/** @type {any} */ part) => part.text.trim()).filter(Boolean).join("\n\n");
    if (text) return text;
  }
  return "";
}

/** A path from a run record as a safe path under `root`. @param {string} root @param {string} rel */
function safeUnder(root, rel) {
  const clean = rel.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
  const full = path.resolve(root, clean);
  return clean && full.startsWith(`${path.resolve(root)}${path.sep}`) ? full : null;
}

/**
 * Everything worth keeping about the finished run, each part best effort: one failing read never loses the others.
 * @param {any} item @param {Group} group @param {{ run: any, timedOut: boolean }} finished @param {Record<string, any>} result @param {string} dir
 */
async function capture(item, group, finished, result, dir) {
  const projectId = group.projectId;
  const runId = String(finished.run.id);
  /** @type {any[]} */ let messages = [];
  let answer = "";
  /** @type {Record<string, string>} */ const captured = {};
  // The transcript first: the item's runtime tends to stop a few seconds after its run ends, and a read after that has to start it again.
  let transcript = await api("GET", `/api/runtime/sessions/${encodeURIComponent(result.sessionId)}/transcript`, { project: projectId, timeoutMs: 120_000 });
  if (transcript.status === 409 && transcript.code === "runtime_not_running") {
    const started = await api("POST", "/api/commands/start_runtime", { body: {}, project: projectId, timeoutMs: 180_000 });
    log(`item ${item.key}: runtime was gone; start_runtime -> ${said(started)}`);
    transcript = await api("GET", `/api/runtime/sessions/${encodeURIComponent(result.sessionId)}/transcript`, { project: projectId, timeoutMs: 120_000 });
  }
  // Settle (item.settleSeconds): a run can end its turn while a background job it started is still working, and the
  // kernel wakes the session again when the job finishes — a person at the page sees the work continue as a later turn.
  // The driver waits like that person: it keeps reading the transcript while it grows and takes the answer once it has
  // not changed for settleSeconds, never past the item's timeout. Only a run that ended on its own is waited for.
  const settle = Number(item.settleSeconds) || 0;
  if (settle > 0 && !finished.timedOut && transcript.status === 200 && transcript.body?.data) {
    const deadline = (Date.parse(result.startedAt) || Date.now()) + Number(item.timeoutMin ?? 15) * 60_000;
    const size = (body) => (body?.data?.messages ?? body?.data?.records ?? []).length;
    let last = size(transcript.body), quietSince = Date.now(), grew = 0;
    while (Date.now() - quietSince < settle * 1000 && Date.now() < deadline) {
      await sleep(30_000);
      const again = await api("GET", `/api/runtime/sessions/${encodeURIComponent(result.sessionId)}/transcript`, { project: projectId, timeoutMs: 120_000 });
      if (again.status !== 200 || !again.body?.data) { result.settle = { stoppedBy: `transcript ${said(again)}` }; break; }
      const now = size(again.body);
      if (now > last) { grew += now - last; last = now; quietSince = Date.now(); transcript = again; }
    }
    result.settle = { ...(result.settle ?? {}), seconds: settle, grewMessages: grew, endedBy: Date.now() >= deadline ? "deadline" : (result.settle?.stoppedBy ? "error" : "quiet") };
    if (grew) log(`item ${item.key}: the session continued after the run ended (+${grew} messages)`);
  }
  if (transcript.status === 200 && transcript.body?.data) {
    messages = Array.isArray(transcript.body.data.messages ?? transcript.body.data.records) ? transcript.body.data.messages ?? transcript.body.data.records : [];
    answer = finalAnswer(messages);
    await writeAtomic(path.join(dir, "transcript.json"), JSON.stringify(transcript.body.data));
    await writeAtomic(path.join(dir, "answer.md"), answer);
    result.answerChars = answer.length;
    result.messages = messages.length;
    captured.transcript = "ok";
  } else captured.transcript = `error ${said(transcript)}`;

  // The ledger folds late notices and the output inventory in just after the terminal status.
  await sleep(3_000);
  const list = await api("GET", "/api/agent-runs", { project: projectId });
  const run = list.body?.data?.find?.((/** @type {any} */ candidate) => candidate.id === runId) ?? finished.run;
  result.status = finished.timedOut ? "timeout" : String(run.status);
  result.runStatus = run.status;
  Object.assign(result, {
    errorCode: run.errorCode ?? null, effectiveAgentId: run.effectiveAgentId ?? null, effectiveAgentVersion: run.effectiveAgentVersion ?? null,
    effectiveRouteReason: run.effectiveRouteReason ?? null, durationMs: run.durationMs ?? null, model: run.model ?? null,
    observedMessages: run.observedMessages ?? null, observedToolCalls: run.observedToolCalls ?? null, phase: run.phase ?? null,
    verification: run.verification ?? null, runStartedAt: run.startedAt ?? null, runFinishedAt: run.finishedAt ?? null,
    artifacts: run.artifacts ?? [], unverifiedArtifacts: run.unverifiedArtifacts ?? [], outputFiles: run.outputFiles ?? [], presentedFiles: run.presentedFiles ?? [],
    qualityNotices: (run.qualityNotices ?? []).slice(0, 10).map((/** @type {any} */ notice) => typeof notice === "string" ? notice.slice(0, 200) : `${notice?.severity ?? ""} ${notice?.title ?? ""}`.trim().slice(0, 200)),
    listUsage: run.usage ?? null,
  });

  const usage = await api("GET", `/api/runs/${encodeURIComponent(runId)}/usage`, { project: projectId });
  result.cost = usage.status === 200 ? usage.body?.data ?? null : null;
  captured.cost = usage.status === 200 ? "ok" : `error ${said(usage)}`;

  await recordSkillOutcome(group, item, run, messages, answer, result);

  await writeAtomic(path.join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);

  const first = firstReportWrite(messages);
  result.firstReportAtMs = first?.atMs ?? null;
  result.firstReportPath = first?.path ?? null;
  if (item.collect !== false) result.files = await collectFiles(projectId, run, dir, captured, { timedOut: finished.timedOut, result });
  // Delivered within the cap: the run ended on its own, inside the cap, and left an answer or a report-like file.
  result.deliveredWithinCap = result.status === "succeeded" && (answer.length > 0 || (result.files ?? []).some((/** @type {any} */ entry) => entry.saved && reportTier(entry.path) === 0));
  result.capture = captured;

  const after = await readAvailable();
  if (result.credits) result.credits.after = after;
  if (archiveRuns) {
    // Archived runs leave the project's run list, so the poll of the next item reads one run and not the whole history.
    const archived = await api("PATCH", `/api/agent-runs/${encodeURIComponent(runId)}`, { project: projectId, body: { archived: true } });
    captured.archive = archived.status === 200 ? "ok" : `error ${said(archived)}`;
  }
}

// ------------------------------------------------------------------------------------------------- report-like files

const IMAGE_FILE = /\.(png|jpe?g|svg|gif|webp)$/i;
const REPORT_DOCUMENT = /\.(md|docx|pdf)$/i;
/** Figures a report links to (ResearchClawBench scores image items): kept as bytes, up to 5 MB each. */
const FIGURE_PATH = /(^|\/)(report|figures|images|figs?)\//i;
/** Directories a scan for reports never enters: tool caches, dependency trees, hidden state. */
const SCAN_SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", "env"]);

/**
 * How early a file is read when more than the cap were written. 0: report-like — a Markdown, Word or PDF document anywhere, or
 * any non-image file under a `report/` folder; 1: a figure; 2: everything else (code, data, logs), in the run record's order.
 * @param {string} name
 */
function reportTier(name) {
  if (REPORT_DOCUMENT.test(name) || (/(^|\/)report\//i.test(name) && !IMAGE_FILE.test(name))) return 0;
  return IMAGE_FILE.test(name) && FIGURE_PATH.test(name) ? 1 : 2;
}

/** A path as a tool call names it (`/workspace/report/report.md`, `./x.md`, `x.md`) → workspace-relative, or null outside it. @param {unknown} value */
function workspaceRelative(value) {
  const clean = String(value ?? "").replace(/\\/g, "/").trim();
  const rel = clean.startsWith("/workspace/") ? clean.slice("/workspace/".length) : clean.startsWith("./") ? clean.slice(2) : clean;
  return rel && !rel.startsWith("/") && !rel.split("/").includes("..") ? rel : null;
}

/** Where a shell command writes: the token before it is a redirect, tee or -o, or the token after it is saved/written. */
const BASH_BEFORE = /(?:>>?|\btee(?:\s+-a)?|\s-o|--output(?:-file)?[=\s]|\.save\()\s*["']?$/;
const BASH_AFTER = /^["']?\s*\)?\s*(?:\.(?:write_text|write_bytes|save)\(|,\s*["'][wa]b?["'])/;
/** The report-like paths a shell command writes (best effort: a script that writes its own path is not seen). @param {string} command */
function bashReportWrites(command) {
  const found = [];
  for (const match of command.matchAll(/(?<![\w@%+./\\-])[\w@%+./\\-]*\.(?:md|docx|pdf)\b|(?<![\w/-])report\/[\w@%+./-]+/gi)) {
    const before = command.slice(Math.max(0, match.index - 40), match.index), after = command.slice(match.index + match[0].length, match.index + match[0].length + 40);
    if (BASH_BEFORE.test(before) || BASH_AFTER.test(after)) { const rel = workspaceRelative(match[0]); if (rel && reportTier(rel) === 0) found.push(rel); }
  }
  return found;
}

/**
 * The first write of a report-like file by a tool call, and when: milliseconds after the turn began (the first user message),
 * or null when the transcript has no such write or no clock. The `write` tool names its file; a shell command is read for the
 * redirects and saves above. A write that did not complete is not a report.
 * @param {any[]} messages @returns {{ atMs: number | null, path: string, via: string } | null}
 */
function firstReportWrite(messages) {
  const began = messages.find((message) => (message?.role ?? message?.info?.role) === "user" && Number.isFinite(message?.time))?.time ?? messages.find((message) => Number.isFinite(message?.time))?.time;
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool" || part.status !== "completed") continue;
      let path = null, via = "";
      if (part.tool === "write") { const rel = workspaceRelative(part.input?.file_path ?? part.input?.path); if (rel && reportTier(rel) === 0) { path = rel; via = "write"; } }
      else if (part.tool === "bash" && typeof part.input?.command === "string") { path = bashReportWrites(part.input.command)[0] ?? null; via = "bash"; }
      if (path) return { atMs: Number.isFinite(message.time) && Number.isFinite(began) ? Math.max(0, message.time - began) : null, path, via };
    }
  }
  return null;
}

/** One directory of the project's workspace, with size and mtime (seconds): `list_dir`. @param {string} projectId @param {string} rel */
async function listDir(projectId, rel) {
  const read = await api("POST", "/api/commands/list_dir", { project: projectId, body: { rel }, timeoutMs: 30_000 });
  return read.status === 200 && Array.isArray(read.body?.data) ? read.body.data : null;
}

/** Newest first, then largest, then by name. @param {{ path: string, size: number, modified: number }} a @param {{ path: string, size: number, modified: number }} b */
const newestLargest = (a, b) => b.modified - a.modified || b.size - a.size || a.path.localeCompare(b.path);

/**
 * Report-like files in the workspace written at or after `since` (seconds), breadth first so a top-level `report/` is reached
 * before anything deep. Bounded in directories and depth; hidden and dependency directories are not entered; the item's own
 * uploads are skipped. Best effort: a directory that cannot be listed is passed over.
 * @param {string} projectId @param {number} since @param {Set<string>} uploaded @param {Set<string>} uploadedTop
 * @returns {Promise<Array<{ path: string, size: number, modified: number }>>}
 */
async function scanReportFiles(projectId, since, uploaded, uploadedTop) {
  const found = [];
  const queue = [{ rel: "", depth: 0 }];
  for (let listed = 0; queue.length && listed < SCAN_MAX_DIRS; listed += 1) {
    const { rel, depth } = /** @type {{ rel: string, depth: number }} */ (queue.shift());
    for (const entry of (await listDir(projectId, rel)) ?? []) {
      const name = String(entry?.name ?? ""), entryPath = String(entry?.path ?? "");
      if (!name || !entryPath) continue;
      if (entry.isDir) {
        if (depth < SCAN_MAX_DEPTH && !name.startsWith(".") && !SCAN_SKIP_DIRS.has(name) && !(depth === 0 && uploadedTop.has(name))) queue.push({ rel: entryPath, depth: depth + 1 });
      } else if (reportTier(entryPath) === 0 && Number(entry.modified) >= since && !uploaded.has(entryPath)) {
        found.push({ path: entryPath, size: Number(entry.size) || 0, modified: Number(entry.modified) });
      }
    }
  }
  return found;
}

/**
 * Read back the files the run wrote (`POST /api/commands/read_artifact`): at most 40; text up to 2 MB, Office/PDF documents up to 10 MB.
 * Report-like files are read first (reportTier; newest then largest), so the cap only ever cuts code and data. After a timeout the
 * workspace is scanned and its newest report-like files are added to the run record's list; `lastReport` is the newest document.
 * @param {string} projectId @param {any} run @param {string} dir @param {Record<string, string>} captured
 * @param {{ timedOut: boolean, result: Record<string, any> }} context
 */
async function collectFiles(projectId, run, dir, captured, { timedOut, result }) {
  const names = [...new Set([...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? []), ...(run.outputFiles ?? []), ...(run.presentedFiles ?? [])]
    .map((entry) => typeof entry === "string" ? entry : entry?.path).filter((entry) => typeof entry === "string" && entry))];
  /** @type {Map<string, { size: number, modified: number }>} */ const stats = new Map();
  /** @type {Array<{ path: string, size: number, modified: number }>} */ let scanned = [];
  if (timedOut) {
    const uploads = (result.uploads ?? []).map((/** @type {any} */ upload) => String(upload.dest));
    const since = Math.floor((Date.parse(result.dispatchedAt ?? result.startedAt) || Date.now()) / 1000) - 2;
    scanned = (await scanReportFiles(projectId, since, new Set(uploads), new Set(uploads.filter((dest) => dest.includes("/")).map((dest) => dest.split("/")[0])))).sort(newestLargest);
    for (const file of scanned) stats.set(file.path, file);
    for (const file of scanned.slice(0, SCAN_EXTRA_REPORTS)) if (!names.includes(file.path)) names.push(file.path);
  } else if (names.length > ARTIFACT_MAX_FILES) {
    // Over the cap: the report-like ones need their mtime and size to be put first, from the directories that hold them.
    const parents = [...new Set(names.filter((name) => reportTier(name) < 2).map((name) => name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : ""))].slice(0, 20);
    for (const parent of parents) for (const entry of (await listDir(projectId, parent)) ?? []) if (!entry.isDir) stats.set(String(entry.path), { size: Number(entry.size) || 0, modified: Number(entry.modified) || 0 });
  }
  const ordered = names.map((name, index) => ({ name, index, tier: reportTier(name), stat: stats.get(name) }))
    .sort((a, b) => a.tier - b.tier || (b.stat?.modified ?? 0) - (a.stat?.modified ?? 0) || (b.stat?.size ?? 0) - (a.stat?.size ?? 0) || a.index - b.index).map((entry) => entry.name);
  const filesRoot = path.join(dir, "files");
  /** @type {Array<Record<string, any>>} */ const index = [];
  for (const name of ordered.slice(0, ARTIFACT_MAX_FILES)) {
    const read = await api("POST", "/api/commands/read_artifact", { project: projectId, body: { path: name }, timeoutMs: 60_000 });
    const data = read.body?.data;
    if (read.status !== 200 || !data) { index.push({ path: name, saved: false, reason: `read ${said(read)}` }); continue; }
    // Office and PDF deliverables are the product's answer as often as the reply is (a long report arrives as a .docx):
    // they are kept as bytes, up to 10 MB; other binaries (images, archives) are listed, not kept.
    // Figures a report links to are part of it (ResearchClawBench scores image items), so images under a report or
    // figures directory are kept too, up to 5 MB each.
    const figure = IMAGE_FILE.test(name) && FIGURE_PATH.test(name);
    const document = /\.(docx|pdf|xlsx|pptx)$/i.test(name) || figure;
    if (data.encoding !== "utf8" && !document) { index.push({ path: name, saved: false, reason: "binary", size: data.size ?? null, mime: data.mime ?? null }); continue; }
    const bytes = data.encoding === "utf8" ? Buffer.from(String(data.data), "utf8") : Buffer.from(String(data.data), "base64");
    const target = safeUnder(filesRoot, name);
    const cap = figure ? 5 * 1024 * 1024 : document ? 10 * 1024 * 1024 : ARTIFACT_MAX_BYTES;
    if (bytes.length > cap || !target) { index.push({ path: name, saved: false, reason: target ? `over ${cap} bytes` : "unsafe path", size: bytes.length }); continue; }
    await writeAtomic(target, bytes);
    index.push({ path: name, saved: true, size: bytes.length });
  }
  const left = ordered.slice(ARTIFACT_MAX_FILES);
  if (left.length) index.push({ path: `(${left.length} more)`, saved: false, reason: "over 40 files", reportLikeLeft: left.filter((name) => reportTier(name) === 0).length });
  captured.files = `${index.filter((entry) => entry.saved).length}/${names.length} saved`;
  if (timedOut) {
    // What existed at the cap: the newest document under a `report/` folder, else the newest document anywhere (a scratch note
    // written last must not stand for the report).
    const documents = scanned.filter((file) => !IMAGE_FILE.test(file.path));
    const newest = documents.find((file) => /(^|\/)report\//i.test(file.path)) ?? documents[0] ?? null;
    const row = newest ? index.find((entry) => entry.path === newest.path) : null;
    result.lastReport = newest ? { path: newest.path, bytes: newest.size, mtime: new Date(newest.modified * 1000).toISOString(), saved: row?.saved === true } : null;
    captured.lastReport = newest ? `${newest.path} ${row?.saved ? "saved" : "not saved"}` : "none";
  }
  return index;
}

// ----------------------------------------------------------------------------------------------------------- lane

/** Called by the throwaway helper before it deletes the account: cancel the run in flight and record the item as interrupted. */
async function interruptInflight() {
  shuttingDown = true;
  const flight = inflight;
  if (!flight) return;
  if (flight.runId && !TERMINAL_RUN.has(String(flight.runStatus))) await cancelRun(flight.projectId ?? "", flight.runId);
  flight.result.status = "interrupted";
  flight.result.finishedAt = new Date().toISOString();
  await writeAtomic(path.join(flight.dir, "result.json"), `${JSON.stringify(flight.result, null, 2)}\n`).catch(() => {});
  log(`item ${flight.result.key}: interrupted; it will be run again by the next start`);
}

/** @returns {Promise<any[]>} */
async function readQueue() {
  const lines = (await readFile(queueFile, "utf8")).split("\n");
  const items = [];
  const folders = new Map();
  /** @type {Map<string, string>} the skill digest each group has seen: a group has one skill or none */
  const groupSkills = new Map();
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const where = `queue line ${index + 1}`;
    let item;
    try { item = JSON.parse(line); } catch { throw new Error(`${where} is not JSON`); }
    if (typeof item?.key !== "string" || !item.key || typeof item.prompt !== "string" || !item.prompt.trim()) throw new Error(`${where} needs a key and a prompt`);
    // Two keys that name one folder (`a#r1` and `a_r1`) would overwrite each other's results.
    const folder = path.basename(itemDir(item.key));
    if (folders.has(folder)) throw new Error(`${where}: key ${item.key} and key ${folders.get(folder)} are the same result folder ${folder}`);
    folders.set(folder, item.key);
    const group = typeof item.group === "string" && item.group ? item.group : "bench";
    // timeBudgetMinutes is the product's dispatch field (the run budget the model is shown); absent unless the item sets it.
    if (item.timeBudgetMinutes !== undefined) {
      if (!(typeof item.timeBudgetMinutes === "number" && Number.isFinite(item.timeBudgetMinutes) && item.timeBudgetMinutes > 0 && item.timeBudgetMinutes <= 1440)) throw new Error(`${where}: timeBudgetMinutes must be a number above 0 and up to 1440`);
      if (item.timeBudgetMinutes >= Number(item.timeoutMin ?? 15)) log(`WARN ${where} (${item.key}): timeBudgetMinutes ${item.timeBudgetMinutes} is not below this driver's own cap timeoutMin ${item.timeoutMin ?? 15}; the cap cancels the run first`);
    }
    const skill = item.groupSkill ?? null;
    if (skill !== null) {
      const text = (/** @type {unknown} */ value, /** @type {number} */ max, /** @type {boolean} */ empty) => typeof value === "string" && value.length <= max && (empty || value.trim() !== "");
      if (typeof skill !== "object" || Array.isArray(skill) || !text(skill.title, 240, false) || !text(skill.description, 2048, true) || !text(skill.instructions, 262_144, false)) {
        throw new Error(`${where}: groupSkill needs a title (up to 240 characters), a description (up to 2048) and instructions`);
      }
    }
    const digest = skill ? skillDigest(skill) : "none";
    if (groupSkills.has(group) && groupSkills.get(group) !== digest) throw new Error(`${where}: group ${group} has items with different groupSkill values`);
    groupSkills.set(group, digest);
    items.push({ ...item, group, groupSkill: skill });
  });
  return items;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const items = await readQueue();
  /** @type {any[]} */ const pending = [];
  for (const item of items) {
    const done = await readResult(itemDir(item.key));
    if (!FINAL_ITEM.has(String(done?.status))) pending.push(item);
  }
  log(`${DRIVER} queue=${path.basename(queueFile)} items=${items.length} pending=${pending.length} base=${base}`);
  if (!pending.length) return 0;

  account = await openThrowawayAccount({ base, send: fetchTransport(base), prefix: "bench", say: log, stop: interruptInflight });
  let code = 0;
  try {
    let processed = 0;
    let streak = 0;
    for (const item of pending) {
      if (shuttingDown || processed >= limit) break;
      if (existsSync(stopFile)) { log("STOP file found; the lane ends here"); break; }
      const result = await processItem(item);
      processed += 1;
      streak = NOT_RUN.has(result.status) ? streak + 1 : 0;
      if (streak >= 5) { log("FAIL five items in a row could not run; the lane stops"); code = 3; break; }
    }
  } catch (error) {
    log(`FAIL lane: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 300)}`);
    code = 2;
  }
  await closeAllGroups();
  const outcome = await account.close();
  return outcome.deleted ? code : 4;
}

process.on("unhandledRejection", (reason) => {
  log(`FAIL unhandled rejection: ${String(/** @type {any} */ (reason)?.message ?? reason).slice(0, 200)}`);
  void (account ? account.close() : Promise.resolve()).finally(() => process.exit(2));
});

main().then((code) => process.exit(code), (error) => {
  log(`FAIL ${String(error?.message ?? error).slice(0, 300)}`);
  void (account ? account.close() : Promise.resolve()).finally(() => process.exit(2));
});
