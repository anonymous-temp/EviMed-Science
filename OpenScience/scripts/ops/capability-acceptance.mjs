#!/usr/bin/env node
// Drive one capability brief against a deployed instance and record what came back.
//
// `evals/acceptance-ledger.json` has one row per capability saying whether it has
// ever produced a real accepted delivery. Fourteen of eighteen say `not-run`, and
// the reason is not that nobody tried: there was no vehicle. `hosted-production-e2e`
// drives exactly one capability, hardcoded; `deployment-smoke` never waits for a run
// to finish; the briefs in `evals/*/briefs.json` had no code that could dispatch them
// at all. So "has this capability ever delivered" was answered from memory, in prose,
// in a file the checker cannot verify.
//
// This is the missing vehicle, and it is deliberately not clinical-specific: the
// gap is a class (fourteen rows), not one row. It renders a brief from the harness
// the ledger already names, binds the session to that capability so the router
// cannot send the run somewhere else, dispatches, waits, and writes a result file
// whose path is exactly what the ledger's `evidence` field wants.
//
// It does not update the ledger. An acceptance that writes its own verdict is not
// an acceptance; the result and package are reviewed separately before the row changes.
//
// Usage:
//   OPEN_SCIENCE_ACCEPTANCE_PASSWORD_FILE=<path> \
//   node scripts/ops/capability-acceptance.mjs \
//     --capability clinical-evidence-synthesis --brief review-001-empa-kidney-report-family \
//     [--base https://host] [--insecure] [--project <id>] [--timeout-ms 7200000]
//
// Candidate-bound actual native revision cohort (no --capability/--brief needed):
//   --result-revisions --candidate-manifest <release-manifest.json> --expected-revision <40hex>
//   Requires OPEN_SCIENCE_PLAYWRIGHT_CORE, existing password-file auth and pdftotext.
//   It refuses a different release before creating projects or submitting prompts.
//
// 「循证传播」 capabilities work on a GEO project's data, which a plain
// acceptance project does not have (geo_read answers `geo_no_project`):
//   --geo-create <brand> [--geo-engines qianwen,kimi] [--geo-coverage-days 90] [--geo-paused]
//       make a GEO project for the brand and dispatch into its first conversation
//       (`--geo-paused` holds the platform's own program while the run works);
//   --geo-project <geo id> --geo-export proposal|weekly | --geo-step <step>
//       ask the GEO module itself for the run (导出 / 让 AI 做) and watch the run
//       its orchestrator dispatches, with the orchestrator's own brief;
//   --prompt-file <path>
//       dispatch this text instead of the rendered brief (the brief still names
//       the results directory), e.g. a GEO step's brief into an existing GEO project.
//   --inputs <dir>
//       upload every file under <dir> into the project's workspace at the same
//       relative path before dispatching — a brief that starts from a dataset
//       (`data/<export>/…`) or a manuscript (`manuscripts/…`) names files the
//       run has to find there.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Accepts both `--name=value` and `--name value`; a bare `--name` is a flag.
 *  @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(entry);
    if (!match) throw new Error(`Unrecognized argument: ${entry}`);
    if (match[2] !== undefined) { args[match[1]] = match[2]; continue; }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) { args[match[1]] = next; index += 1; }
    else args[match[1]] = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const base = String(args.base ?? process.env.OPEN_SCIENCE_ACCEPTANCE_BASE_URL ?? "https://82.156.128.153").replace(/\/+$/, "");
const username = String(process.env.OPEN_SCIENCE_ACCEPTANCE_USERNAME ?? "cdss-access");
const capabilityId = String(args.capability ?? "");
const briefId = String(args.brief ?? "");
const attachRunId = typeof args.run === "string" ? args.run : "";
const promptFile = typeof args["prompt-file"] === "string" ? args["prompt-file"] : "";
const geoCreate = typeof args["geo-create"] === "string" ? args["geo-create"].trim() : "";
const geoProjectId = typeof args["geo-project"] === "string" ? args["geo-project"] : "";
const geoExport = typeof args["geo-export"] === "string" ? args["geo-export"] : "";
const geoStep = typeof args["geo-step"] === "string" ? args["geo-step"] : "";
/** Runs the GEO module dispatches itself: the driver asks, then watches. */
const geoTrigger = Boolean(geoProjectId && (geoExport || geoStep));
// Production terminates TLS with a certificate issued to a bare IP, which no
// trust store will validate by name. The flag is explicit so this can never be
// the silent default on a host where the name does check out.
if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// A clinical review measured 41-61 minutes in production and the manifest
// declares up to 120. A poll budget shorter than the work is a script that
// reports failure for a run that was still going.
const timeoutMs = Number(args["timeout-ms"] ?? 7_200_000);
const pollMs = Number(args["poll-ms"] ?? 15_000);
// Downloading partial results is best effort, with one budget for the whole capture.
const artifactTimeoutMs = Number(args["artifact-timeout-ms"] ?? 30_000);

/** @type {Record<string, string>} */
let auth = {};

/** @param {string} route @param {any} [init] */
async function api(route, init = {}) {
  const response = await fetch(`${base}${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...auth, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
  return { status: response.status, body, response };
}

/**
 * A poll that survives the network.
 *
 * `fetch` throws on a dropped connection, and the first version let that throw
 * end the whole script — so one blip 90 seconds into a 70-minute acceptance
 * killed the watcher while the run itself carried on to completion on the
 * server, unobserved. The run is the expensive part; the watcher is not, and it
 * must not be the fragile one.
 * @param {string} route @param {any} [init]
 */
async function pollApi(route, init = {}) {
  try {
    return await api(route, init);
  } catch (error) {
    return { status: 0, body: null, response: null, error: String(error?.message ?? error) };
  }
}

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
/** @param {string} message */
const say = (message) => process.stdout.write(`${stamp()} ${message}\n`);

/**
 * The brief as a prompt.
 *
 * Every field the capability manifest calls an input, and nothing else. The
 * dispatched text is also the brief the delivery gate checks question coverage
 * against, so padding it with acceptance-harness prose would widen the surface
 * the run has to satisfy and fail it for the harness's words.
 * @param {any} brief
 */
function renderBrief(brief) {
  const inputs = brief?.inputs ?? {};
  // PICO-style briefs phrase their request as a `question` with clinical
  // fields; the other harnesses declare the capability manifest's own
  // input names (topic, drug, exposure, section, ...). Those render as one
  // `name: value` line each, in the brief's order, so the run receives every
  // declared input and nothing the harness made up.
  if (!inputs.question) {
    const rendered = Object.entries(inputs)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    return rendered.join("\n").trim();
  }
  const lines = [String(inputs.question ?? "").trim()];
  if (inputs.reviewType) lines.push(`\nReview design: ${inputs.reviewType}.`);
  for (const [key, label] of [["population", "Population"], ["intervention", "Intervention"],
    ["comparator", "Comparator"], ["outcomes", "Outcomes"], ["careSetting", "Care setting"],
    ["jurisdiction", "Jurisdiction"], ["outputLanguage", "Output language"]]) {
    if (inputs[key]) lines.push(`${label}: ${Array.isArray(inputs[key]) ? inputs[key].join("; ") : inputs[key]}.`);
  }
  const eligibility = inputs.eligibility ?? {};
  if (eligibility.inclusionCriteria?.length) {
    lines.push(`\nInclude: ${eligibility.inclusionCriteria.join("; ")}.`);
  }
  if (eligibility.exclusionCriteria?.length) {
    lines.push(`Exclude: ${eligibility.exclusionCriteria.join("; ")}.`);
  }
  if (Array.isArray(inputs.sources) && inputs.sources.length) {
    lines.push("\nStarting sources (retrieve and preserve the current text of each; this list is not evidence):");
    for (const source of inputs.sources) {
      const parts = [source.identifier, source.url, source.role && `role: ${source.role}`,
        source.expectedStudyId && `study: ${source.expectedStudyId}`].filter(Boolean);
      lines.push(`- ${parts.join(" — ")}`);
    }
  }
  if (Array.isArray(inputs.datasets) && inputs.datasets.length) {
    lines.push("\nDatasets:");
    for (const dataset of inputs.datasets) lines.push(`- ${typeof dataset === "string" ? dataset : JSON.stringify(dataset)}`);
  }
  for (const [key, label] of [["studies", "Supplied study reports"], ["sourceNotes", "Supplied source notes"]]) {
    if (!Array.isArray(inputs[key]) || !inputs[key].length) continue;
    lines.push(`\n${label}:`);
    for (const value of inputs[key]) lines.push(`- ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return lines.join("\n").trim();
}

async function main() {
  if (!capabilityId) throw new Error("--capability is required");
  if (!briefId) throw new Error("--brief is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(pollMs) || pollMs < 1
    || !Number.isSafeInteger(artifactTimeoutMs) || artifactTimeoutMs < 0) {
    throw new Error("Timeout budgets must be nonnegative and --poll-ms must be a positive integer");
  }

  const ledger = JSON.parse(await readFile(path.join(repoRoot, "evals", "acceptance-ledger.json"), "utf8"));
  const row = ledger.capabilities.find((/** @type {any} */ entry) => entry.id === capabilityId);
  if (!row) throw new Error(`${capabilityId} has no acceptance-ledger row`);
  const harness = String(row.evalHarness);
  const briefsFile = path.join(repoRoot, harness, "briefs.json");
  const briefs = JSON.parse(await readFile(briefsFile, "utf8"));
  if (briefs.capability !== capabilityId) {
    throw new Error(`${harness}/briefs.json declares capability ${briefs.capability}, not ${capabilityId}`);
  }
  const brief = briefs.briefs.find((/** @type {any} */ entry) => entry.id === briefId);
  if (!brief) {
    throw new Error(`${harness}/briefs.json has no brief ${briefId}; it has: ${briefs.briefs.map((/** @type {any} */ b) => b.id).join(", ")}`);
  }
  // A prompt file replaces the rendered brief as the text dispatched; the brief
  // still names the results directory and is recorded beside it.
  const text = promptFile ? (await readFile(path.resolve(promptFile), "utf8")).trim() : renderBrief(brief);
  if (!text) throw new Error(promptFile ? `${promptFile} is empty` : `brief ${briefId} rendered to an empty prompt`);
  if (geoTrigger && (promptFile || attachRunId || geoCreate)) {
    throw new Error("--geo-export / --geo-step ask the GEO module for its own run: no --prompt-file, --run or --geo-create with them");
  }

  const passwordFile = String(process.env.OPEN_SCIENCE_ACCEPTANCE_PASSWORD_FILE ?? "");
  if (!passwordFile) {
    throw new Error("OPEN_SCIENCE_ACCEPTANCE_PASSWORD_FILE is required; this never takes a password on the command line");
  }
  const password = (await readFile(passwordFile, "utf8")).trim();

  say(`base=${base} user=${username} capability=${capabilityId} brief=${briefId}`);
  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body).slice(0, 200)}`);
  const cookie = (login.response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(";")[0]).join("; ");
  if (!cookie) throw new Error("login returned no session cookie");
  auth = { cookie, "x-open-science-csrf": String(login.body.data.csrfToken) };
  say("authenticated");

  // A GEO capability reads and writes a GEO project's data. `--geo-create`
  // makes one (its control project, and a first conversation already bound to
  // geo-insight); `--geo-project` names one that exists.
  /** @type {{ id: string, projectId: string, sessionId: string | null } | null} */
  let geo = null;
  if (geoCreate) {
    const engines = typeof args["geo-engines"] === "string" ? args["geo-engines"].split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;
    const coverageDays = args["geo-coverage-days"] === undefined ? undefined : Number(args["geo-coverage-days"]);
    const made = await api("/api/geo/projects", { method: "POST", body: JSON.stringify({ brandName: geoCreate, coverageDays, engines }) });
    if (made.status !== 201 && made.status !== 200) throw new Error(`GEO project create failed: ${made.status} ${JSON.stringify(made.body).slice(0, 300)}`);
    geo = { id: String(made.body.data.id), projectId: String(made.body.data.projectId), sessionId: made.body.data.sessionId ?? null };
    say(`GEO project ${geo.id} (${geoCreate}) created in project ${geo.projectId}`);
  } else if (geoProjectId) {
    const read = await api(`/api/geo/projects/${encodeURIComponent(geoProjectId)}`);
    if (read.status !== 200) throw new Error(`GEO project read failed: ${read.status} ${JSON.stringify(read.body).slice(0, 300)}`);
    geo = { id: geoProjectId, projectId: String(read.body.data.projectId), sessionId: read.body.data.sessionId ?? null };
    say(`GEO project ${geo.id} is project ${geo.projectId}`);
  }
  // `--geo-paused`: hold the platform's own program while this run works. A
  // conversation that locks a full question set starts the whole program on
  // the next tick (baseline, strategy, six content batches); an acceptance of
  // one capability should not buy the other seven. The run's own geo_read and
  // geo_write work on a paused project; resume it from its page.
  if (geo && args["geo-paused"] === true) {
    if (geoTrigger) throw new Error("--geo-paused holds the GEO module's runs; it cannot be combined with --geo-export or --geo-step");
    const paused = await api(`/api/geo/projects/${encodeURIComponent(geo.id)}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) });
    if (paused.status !== 200) throw new Error(`GEO project pause failed: ${paused.status} ${JSON.stringify(paused.body).slice(0, 200)}`);
    say(`GEO project ${geo.id} paused: the platform will not start its own steps while this run works`);
  }

  const projectId = String(geo?.projectId ?? args.project ?? `acceptance-${capabilityId}`.slice(0, 60));
  // List before creating. A 409 from the create route means two unrelated
  // things — the id is taken, or the account is at its project ceiling — and
  // treating both as "already there" made a full account look like a resume
  // and then failed one call later with `project_not_found`, which points at
  // the wrong problem entirely.
  const existing = await api("/api/projects");
  if (existing.status !== 200) throw new Error(`project list failed: ${existing.status}`);
  const already = (existing.body.data ?? []).some((/** @type {any} */ entry) => entry.id === projectId);
  if (!already && geo) throw new Error(`the GEO project's control project ${projectId} is not in this account's project list`);
  // An acceptance project is one of the platform's own (`isInternalProject`),
  // so the list never shows it: its existence is the create answering
  // `project_exists`, which is the resume.
  let resumed = false;
  if (!already) {
    const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ id: projectId, name: `Acceptance ${capabilityId}` }) });
    if (created.status === 409 && created.body?.code === "project_exists") resumed = true;
    else if (created.status !== 201 && created.status !== 200) {
      const code = created.body?.code ?? "";
      const hint = code === "project_limit_reached"
        ? ` — pass --project <existing id> to reuse one of the ${(existing.body.data ?? []).length} this account already holds`
        : "";
      throw new Error(`project create failed: ${created.status} ${code || JSON.stringify(created.body).slice(0, 200)}${hint}`);
    }
  }
  auth["x-open-science-project"] = projectId;
  if (typeof args.inputs === "string") {
    const inputRoot = path.resolve(args.inputs);
    /** @param {string} directory @returns {Promise<string[]>} */
    const walk = async (directory) => (await Promise.all((await readdir(directory, { withFileTypes: true }))
      .map((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : Promise.resolve(entry.isFile() ? [path.join(directory, entry.name)] : []))))
      .flat();
    const files = await walk(inputRoot);
    if (!files.length) throw new Error(`--inputs ${inputRoot} holds no files`);
    for (const file of files) {
      const relative = path.relative(inputRoot, file).split(path.sep).join("/");
      const uploaded = await api("/api/files/upload", { method: "POST", body: JSON.stringify({
        path: relative, data: (await readFile(file)).toString("base64"), encoding: "base64" }) });
      if (uploaded.status !== 200) throw new Error(`upload of ${relative} failed: ${uploaded.status} ${JSON.stringify(uploaded.body).slice(0, 200)}`);
    }
    say(`inputs: ${files.length} file(s) from ${inputRoot} uploaded into the workspace`);
  }
  say(`project=${projectId} (${already || resumed ? "existing" : "created"})`);

  const agents = await api("/api/agents");
  if (agents.status !== 200) throw new Error(`agent list failed: ${agents.status}`);
  const agent = agents.body.data.find((/** @type {any} */ entry) => entry.id === capabilityId);
  if (!agent) throw new Error(`${capabilityId} is not registered on this deployment`);
  say(`agent version=${agent.version} runtimeAgent=${agent.runtimeAgent}`);

  // Bind the session to the capability rather than letting the router pick.
  // An acceptance that depends on the classifier is measuring the classifier.
  // A new GEO project's first conversation is the one its page opens: dispatch there.
  let sessionId = String(args.session ?? (geoCreate && geo?.sessionId ? geo.sessionId : `acc-${capabilityId.slice(0, 20)}-${Date.now().toString(36)}`))
    .replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  if (!attachRunId && !geoTrigger) {
    const bound = await api(`/api/research-sessions/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      body: JSON.stringify({ mode: "specialist", agentId: capabilityId, agentVersion: agent.version }),
    });
    if (bound.status !== 200) throw new Error(`session bind failed: ${bound.status} ${JSON.stringify(bound.body).slice(0, 300)}`);
    say(`session=${sessionId} bound to ${capabilityId}@${agent.version}`);
  }

  // `--run <id>` attaches to a run already in flight instead of starting one.
  // A dispatched acceptance costs an hour of real model work, so losing the
  // watcher must not mean losing the run — and re-running the script would be
  // refused `agent_run_active` anyway, which reads as a failure rather than as
  // "it is still going, come and watch".
  let runId;
  let run;
  let dispatchedAt = null;
  let promptSource = promptFile ? `file ${path.basename(promptFile)}` : "rendered brief";
  if (geoTrigger && geo) {
    // The GEO module's own run: 导出 or 让 AI 做, dispatched by its orchestrator
    // with its own brief. It answers with the run when it could dispatch at
    // once; when the run slot was busy the orchestrator's next tick sends it,
    // so the run is found by its `geo-` dispatch id among the project's runs.
    // Five minutes of slack: the run's start is the server's clock, this is ours.
    const asked = new Date(Date.now() - 300_000).toISOString();
    const route = geoExport ? `/api/geo/projects/${encodeURIComponent(geo.id)}/export` : `/api/geo/projects/${encodeURIComponent(geo.id)}/run`;
    const answer = await api(route, { method: "POST", body: JSON.stringify(geoExport ? { kind: geoExport } : { step: geoStep }) });
    if (answer.status !== 200) throw new Error(`GEO ${geoExport ? "export" : "step"} request failed: ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
    runId = answer.body.data?.runId ? String(answer.body.data.runId) : "";
    say(runId ? `the GEO module dispatched run=${runId}` : "the GEO module queued the run; waiting for its dispatch");
    const waitUntil = Date.now() + Number(args["geo-wait-ms"] ?? 1_800_000);
    while (!runId && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const list = await pollApi("/api/agent-runs");
      const found = list.status === 200 ? (list.body.data ?? []).find((/** @type {any} */ entry) => String(entry.dispatchId ?? "").startsWith("geo-")
        && String(entry.startedAt ?? entry.createdAt ?? "") >= asked && entry.effectiveAgentId === capabilityId) : null;
      if (found) runId = String(found.id);
    }
    if (!runId) throw new Error("the GEO module did not dispatch the run in time; see the project's page for why (paused, a run already out, or a step not yet due)");
    const list = await api("/api/agent-runs");
    run = (list.body?.data ?? []).find((/** @type {any} */ entry) => entry.id === runId) ?? { id: runId, status: "running" };
    sessionId = String(run.sessionId ?? sessionId);
    promptSource = "the GEO orchestrator's brief, as the run ledger records it";
  } else if (attachRunId) {
    const list = await api("/api/agent-runs");
    if (list.status !== 200) throw new Error(`could not list runs: ${list.status}`);
    run = list.body.data.find((/** @type {any} */ entry) => entry.id === attachRunId);
    if (!run) throw new Error(`no run ${attachRunId} in project ${projectId}`);
    runId = attachRunId;
    promptSource = "the run ledger (attached to a run started elsewhere)";
    say(`attached to run=${runId} (${run.status})`);
  } else {
    const dispatchId = String(args["dispatch-id"] ?? `acc-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
    dispatchedAt = stamp();
    const dispatched = await api("/api/agent-runs/dispatch", {
      method: "POST",
      body: JSON.stringify({ sessionId, dispatchId, text, automated: true }),
    });
    if (dispatched.status !== 202) {
      throw new Error(`dispatch failed: ${dispatched.status} ${JSON.stringify(dispatched.body).slice(0, 400)}`);
    }
    runId = String(dispatched.body.data.id);
    run = dispatched.body.data;
    say(`dispatched run=${runId} prompt=${text.length} chars`);
  }

  sessionId = String(run.sessionId ?? sessionId);
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(["succeeded", "failed", "canceled"]);
  let lastPhase = "";
  let lastPollProblem = null;
  while (!terminal.has(run.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    const list = await pollApi("/api/agent-runs", { signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))) });
    if (list.status !== 200) {
      lastPollProblem = "poll_unavailable";
      say(list.error ? `poll could not reach the deployment (${list.error}); retrying` : `poll returned ${list.status}; retrying`);
      continue;
    }
    const found = list.body.data.find((/** @type {any} */ entry) => entry.id === runId);
    if (!found) { lastPollProblem = "run_unavailable"; say("run not in the list yet"); continue; }
    lastPollProblem = null;
    run = found;
    sessionId = String(run.sessionId ?? sessionId);
    const phase = `${run.status}/${run.phase ?? "-"} msgs=${run.observedMessages ?? 0} tools=${run.observedToolCalls ?? 0} repairs=${run.attempts ?? 0}`;
    if (phase !== lastPhase) { say(phase); lastPhase = phase; }
  }
  const observedAt = stamp();
  const observation = { status: terminal.has(run.status) ? "terminal" : "pending",
    reason: terminal.has(run.status) ? "terminal" : lastPollProblem ?? "deadline" };
  if (observation.status === "pending") {
    say(`PENDING after ${Math.round(timeoutMs / 60000)} min; last observed run status=${run.status}. The run continues.`);
    const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
    say(`Resume: node scripts/ops/capability-acceptance.mjs --capability ${quote(capabilityId)} --brief ${quote(briefId)} --base ${quote(base)} --project ${quote(projectId)} --run ${quote(runId)}${args.insecure ? " --insecure" : ""}`);
  }

  // A second run of one brief on one day gets its own directory: writing into
  // the first one replaced its run.json, and the record of a delivered or
  // failed run is what the acceptance ledger cites (2026-09-28, three reruns
  // of ma-001 and mr-001 each overwrote the committed record).
  const baseDir = path.join(repoRoot, harness, "results", `${new Date().toISOString().slice(0, 10)}-${briefId}`);
  let outDir = baseDir;
  for (let attempt = 2; existsSync(path.join(outDir, "run.json")); attempt += 1) outDir = `${baseDir}-run${attempt}`;
  await mkdir(outDir, { recursive: true });
  const result = {
    capability: capabilityId,
    brief: briefId,
    base,
    project: projectId,
    session: sessionId,
    runId,
    agentVersion: agent.version,
    dispatchedAt: run.startedAt ?? run.createdAt ?? dispatchedAt,
    observedAt,
    observation,
    // What the run was asked: this driver's text when it dispatched, the run's
    // own record when the GEO module did or the run was started elsewhere.
    prompt: geoTrigger || attachRunId ? String(run.question ?? "") : text,
    promptSource,
    ...(geo ? { geoProject: geo.id } : {}),
    outcome: {
      status: run.status,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      errorCode: run.errorCode ?? null,
      verification: run.verification ?? null,
      artifacts: run.artifacts ?? [],
      unverifiedArtifacts: run.unverifiedArtifacts ?? [],
      qualityNotices: run.qualityNotices ?? [],
      effectiveAgentId: run.effectiveAgentId ?? null,
      effectiveRouteReason: run.effectiveRouteReason ?? null,
      durationMs: run.durationMs ?? null,
      repairRounds: run.repairRounds ?? null,
      model: run.model ?? null,
    },
  };
  await writeFile(path.join(outDir, "run.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  // The package itself, so the ledger's evidence is the delivery and not a
  // sentence about it. A gate-accepted artifact and an unverified one are both
  // worth keeping; which is which is already recorded above.
  const wanted = [...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])];
  let saved = 0;
  const captureDeadline = Date.now() + artifactTimeoutMs;
  for (const relative of wanted.slice(0, 40)) {
    const remaining = captureDeadline - Date.now();
    if (remaining <= 0) { say("artifact capture budget exhausted; the observation and files already saved are preserved"); break; }
    const read = await pollApi("/api/commands/read_artifact", { method: "POST", body: JSON.stringify({ path: relative }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))) });
    if (read.status !== 200 || read.body?.data?.encoding !== "utf8") { say(`could not read ${relative} (${read.status})`); continue; }
    const target = path.join(outDir, "deliverable", relative.replace(/^(\.\.\/)+/, ""));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(read.body.data.data), "utf8");
    saved += 1;
  }

  say(`status=${run.status} errorCode=${run.errorCode ?? "none"} verification=${run.verification ?? "none"}`);
  say(`artifacts=${(run.artifacts ?? []).length} unverified=${(run.unverifiedArtifacts ?? []).length} saved=${saved}`);
  // Structured since 2026-09-18 (C2): the title is the reader's, `text` the sentence.
  for (const notice of (run.qualityNotices ?? []).slice(0, 10)) say(`notice: ${typeof notice === "string" ? notice.slice(0, 300) : `[${notice?.severity ?? "advice"}] ${notice?.title ?? ""} — ${String(notice?.text ?? "").slice(0, 300)}`}`);
  say(`results: ${path.relative(repoRoot, outDir)}`);

  // Watching a run never authorizes canceling it or another session sharing
  // its project. The existing idle manager owns runtime reclamation.
  // 3 is an unfinished observation, 1 a terminal non-acceptance, 2 a driver error.
  process.exit(observation.status === "pending" ? 3 : run.status === "succeeded" && !run.verification ? 0 : 1);
}

(args["result-revisions"]
  ? import("./result-revision-acceptance.mjs").then(module => module.runResultRevisionAcceptance(args)).then(() => say("three actual native revision journeys passed"))
  : main()).catch((error) => {
  process.stderr.write(`${stamp()} acceptance failed: ${error?.message ?? error}\n`);
  process.exit(2);
});
