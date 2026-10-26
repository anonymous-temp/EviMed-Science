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
// Whose account it runs in (owner, 2026-10-25): nobody's. The driver registers a
// throwaway account of its own through the product's self-registration, runs in it,
// writes its result files here as it always did, and deletes the account through the
// product at the end — on a result, on an error and on an interrupt
// (`throwaway-account.mjs`). It prints `account created:` and `account deleted:`; an
// account it cannot delete is a `FAIL` line naming it and exit 4. Deleting the account
// stops its runtime, so a run still going when the observation budget ends is cancelled
// with it (exit 3, `PENDING`): there is no resuming a run in an account that is gone —
// give a long brief a long `--timeout-ms`. What the run was asked and what it wrote is
// in the result directory; the account's own copy is gone.
//
// Usage:
//   node scripts/ops/capability-acceptance.mjs \
//     --capability clinical-evidence-synthesis --brief review-001-empa-kidney-report-family \
//     [--base https://host] [--insecure] [--project <id of the project to make>] [--timeout-ms 7200000]
//
// A brief's followUps are dispatched sequentially in the same session after each
// accepted turn is captured; --timeout-ms applies per turn. Failed/pending turns
// stop the sequence. --prompt-file and GEO module triggers remain single-turn.
//
// Exit: 0 delivered and accepted, 1 a terminal run that is not an acceptance, 2 a driver
// error, 3 the observation budget ended with the run still going, 4 the account was not deleted.
//
// Candidate-bound actual native revision cohort (no --capability/--brief needed):
//   --result-revisions --candidate-manifest <release-manifest.json> --expected-revision <40hex>
//   Requires OPEN_SCIENCE_PLAYWRIGHT_CORE and pdftotext.
//   It refuses a different release before creating an account, projects or prompts.
//
// 「循证 GEO」 capabilities work on a GEO project's data, which a plain
// acceptance project does not have (geo_read answers `geo_no_project`):
//   --geo-create <brand> [--geo-engines qianwen,kimi] [--geo-coverage-days 90] [--geo-paused]
//       make a GEO project for the brand and dispatch into its first conversation
//       (`--geo-paused` holds the platform's own program while the run works);
//   --geo-create <brand> --geo-export proposal|weekly | --geo-step <step>
//       make the project and ask the GEO module itself for the run (导出 / 让 AI 做)
//       and watch the run its orchestrator dispatches, with the orchestrator's own
//       brief;
//   --prompt-file <path>
//       dispatch this text instead of the rendered brief (the brief still names
//       the results directory), e.g. a GEO step's brief.
//   --inputs <dir>
//       upload every file under <dir> into the project's workspace at the same
//       relative path before dispatching — a brief that starts from a dataset
//       (`data/<export>/…`) or a manuscript (`manuscripts/…`) names files the
//       run has to find there.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTransport, openThrowawayAccount } from "./throwaway-account.mjs";

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
const base = String(args.base ?? process.env.OPEN_SCIENCE_ACCEPTANCE_BASE_URL ?? "http://127.0.0.1:8798").replace(/\/+$/, "");
const capabilityId = String(args.capability ?? "");
const briefId = String(args.brief ?? "");
const promptFile = typeof args["prompt-file"] === "string" ? args["prompt-file"] : "";
const geoCreate = typeof args["geo-create"] === "string" ? args["geo-create"].trim() : "";
const geoExport = typeof args["geo-export"] === "string" ? args["geo-export"] : "";
const geoStep = typeof args["geo-step"] === "string" ? args["geo-step"] : "";
/** Runs the GEO module dispatches itself: the driver asks, then watches. */
const geoTrigger = Boolean(geoCreate && (geoExport || geoStep));
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
  if (typeof args.run === "string" || typeof args["geo-project"] === "string") {
    throw new Error("--run and --geo-project are gone: the driver's account is deleted when it ends, so there is no run or GEO project left to attach to");
  }
  if ((geoExport || geoStep) && !geoCreate) {
    throw new Error("--geo-export / --geo-step need --geo-create <brand>: the driver's account is new, so it holds no GEO project to ask");
  }
  if (geoTrigger && promptFile) {
    throw new Error("--geo-export / --geo-step ask the GEO module for its own run: no --prompt-file with them");
  }

  // Follow-ups are researcher prompts, never grading instructions. A custom
  // prompt or module-triggered run does not inherit a different brief's turns.
  const followUps = promptFile || geoTrigger ? [] : brief.followUps ?? [];
  if (!Array.isArray(followUps) || followUps.length > 10
    || followUps.some(value => typeof value !== "string" || !value.trim() || value.length > 32000)) {
    throw new Error("followUps must be at most ten nonempty prompts of at most 32000 characters each");
  }

  // The account is made after everything that can be refused without one, and deleted whatever happens after.
  const account = await openThrowawayAccount({ base, send: fetchTransport(base), prefix: "acc", stop: cancelWhatWasDispatched });
  /** @type {number} */ let code = 2;
  /** @type {unknown} */ let failure = null;
  try {
    code = await observe(account, { harness, text, followUps });
  } catch (error) {
    failure = error;
  }
  // Deleted whatever happened above; an account that cannot be deleted is the exit code, ahead of an error the run ended on (said first).
  const outcome = await account.close();
  if (!outcome.deleted) {
    if (failure) process.stderr.write(`${stamp()} acceptance failed: ${/** @type {any} */ (failure)?.message ?? failure}\n`);
    return 4;
  }
  if (failure) throw failure;
  return code;
}

/**
 * What the driver dispatched and has not seen end: the account's deletion cancels it first (the deletion would stop its runtime anyway;
 * this ends the run in the ledger the way a researcher's stop does).
 * @type {{ runId: string, status: string } | null}
 */
let dispatched = null;
const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);
async function cancelWhatWasDispatched() {
  if (!dispatched || terminalStatuses.has(dispatched.status)) return;
  const answer = await pollApi(`/api/agent-runs/${encodeURIComponent(dispatched.runId)}/cancel`, { method: "POST", body: "{}" });
  say(`run ${dispatched.runId} was ${answer.status === 200 ? "cancelled" : `not cancelled (${answer.status})`} before its account was deleted`);
}

/**
 * Run the brief in the signed-in throwaway account and write what came back. Returns the exit code the driver ends with (the account's
 * deletion is the caller's).
 * @param {{ headers: Record<string, string> }} account @param {{ harness: string, text: string, followUps: string[] }} brief
 */
async function observe(account, { harness, text, followUps }) {
  say(`base=${base} capability=${capabilityId} brief=${briefId}`);
  auth = { ...account.headers };
  say("signed in as the throwaway account");

  // A GEO capability reads and writes a GEO project's data. `--geo-create`
  // makes one (its control project, and a first conversation already bound to
  // geo-insight): the account is new, so there is no other to name.
  /** @type {{ id: string, projectId: string, sessionId: string | null } | null} */
  let geo = null;
  if (geoCreate) {
    const engines = typeof args["geo-engines"] === "string" ? args["geo-engines"].split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;
    const coverageDays = args["geo-coverage-days"] === undefined ? undefined : Number(args["geo-coverage-days"]);
    const made = await api("/api/geo/projects", { method: "POST", body: JSON.stringify({ brandName: geoCreate, coverageDays, engines }) });
    if (made.status !== 201 && made.status !== 200) throw new Error(`GEO project create failed: ${made.status} ${JSON.stringify(made.body).slice(0, 300)}`);
    geo = { id: String(made.body.data.id), projectId: String(made.body.data.projectId), sessionId: made.body.data.sessionId ?? null };
    say(`GEO project ${geo.id} (${geoCreate}) created in project ${geo.projectId}`);
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
  // The account is new, so the project is too — except a GEO project's control project, which creating the GEO project made. The
  // project is an ordinary one of an ordinary account (the platform's own `acceptance-*` names are an operator's alone), so what it
  // costs is that account's: see the handoff of 2026-10-25 for what a new account may spend.
  if (!geo) {
    const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ id: projectId, name: `Acceptance ${capabilityId}` }) });
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(`project create failed: ${created.status} ${created.body?.code || JSON.stringify(created.body).slice(0, 200)}`);
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
  say(`project=${projectId} (${geo ? "the GEO project's" : "created"})`);

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
  if (!geoTrigger) {
    const bound = await api(`/api/research-sessions/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      body: JSON.stringify({ mode: "specialist", agentId: capabilityId, agentVersion: agent.version }),
    });
    if (bound.status !== 200) throw new Error(`session bind failed: ${bound.status} ${JSON.stringify(bound.body).slice(0, 300)}`);
    say(`session=${sessionId} bound to ${capabilityId}@${agent.version}`);
  }

  // Capture each completed turn before a follow-up can change its files.
  // The timeout is per turn; all turns use the same account, project and session.
  let previousRunId = null;
  for (const [turnIndex, turnText] of [text, ...followUps].entries()) {
    let runId;
    let run;
    let dispatchedAt = null;
    let promptSource = turnIndex > 0 ? `brief follow-up ${turnIndex}` : promptFile ? `file ${path.basename(promptFile)}` : "rendered brief";
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
      // The ledger's question is the sentence the run was asked in; the orchestrator's brief travels in the run's own context.
      promptSource = "the GEO run's question, as the run ledger records it (the orchestrator's brief is in the run's context)";
    } else {
      const dispatchBase = String(args["dispatch-id"] ?? `acc-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 56);
      const dispatchId = turnIndex ? `${dispatchBase}-turn${turnIndex + 1}` : dispatchBase;
      dispatchedAt = stamp();
      const answer = await api("/api/agent-runs/dispatch", {
        method: "POST",
        body: JSON.stringify({ sessionId, dispatchId, text: turnText, automated: true }),
      });
      if (answer.status !== 202) {
        throw new Error(`dispatch failed: ${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`);
      }
      runId = String(answer.body.data.id);
      run = answer.body.data;
      say(`dispatched run=${runId} prompt=${turnText.length} chars`);
    }

    // From here the run is the account's deletion's to cancel if the observation ends before it does.
    dispatched = { runId, status: String(run.status) };
    sessionId = String(run.sessionId ?? sessionId);
    const deadline = Date.now() + timeoutMs;
    const terminal = terminalStatuses;
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
      dispatched.status = String(run.status);
      sessionId = String(run.sessionId ?? sessionId);
      const phase = `${run.status}/${run.phase ?? "-"} msgs=${run.observedMessages ?? 0} tools=${run.observedToolCalls ?? 0} repairs=${run.attempts ?? 0}`;
      if (phase !== lastPhase) { say(phase); lastPhase = phase; }
    }
    const observedAt = stamp();
    const observation = { status: terminal.has(run.status) ? "terminal" : "pending",
      reason: terminal.has(run.status) ? "terminal" : lastPollProblem ?? "deadline",
      ...(terminal.has(run.status) ? {} : { note: "the run was cancelled when the driver's throwaway account was deleted" }) };
    if (observation.status === "pending") {
      say(`PENDING after ${Math.round(timeoutMs / 60000)} min; last observed run status=${run.status}. The run is cancelled with the throwaway account: there is no resuming it, so give the brief a longer --timeout-ms.`);
    }

    // A second run of one brief on one day gets its own directory: writing into
    // the first one replaced its run.json, and the record of a delivered or
    // failed run is what the acceptance ledger cites (2026-09-28, three reruns
    // of ma-001 and mr-001 each overwrote the committed record).
    const baseDir = path.join(repoRoot, harness, "results", `${new Date().toISOString().slice(0, 10)}-${briefId}${turnIndex ? `-followup-${turnIndex}` : ""}`);
    let outDir = baseDir;
    for (let attempt = 2; existsSync(path.join(outDir, "run.json")); attempt += 1) outDir = `${baseDir}-run${attempt}`;
    await mkdir(outDir, { recursive: true });
    const result = {
      capability: capabilityId,
      brief: briefId,
      turn: turnIndex + 1,
      previousRunId,
      base,
      project: projectId,
      session: sessionId,
      runId,
      agentVersion: agent.version,
      dispatchedAt: run.startedAt ?? run.createdAt ?? dispatchedAt,
      observedAt,
      observation,
      // What the run was asked: this driver's text when it dispatched, the run's
      // own record when the GEO module did.
      prompt: geoTrigger ? String(run.question ?? "") : turnText,
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
    const wanted = [...new Set([...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])])];
    const capture = { complete: true, saved: [], failed: [] };
    const captureDeadline = Date.now() + artifactTimeoutMs;
    for (const [index, relative] of wanted.entries()) {
      const remaining = captureDeadline - Date.now();
      if (index >= 40 || remaining <= 0) {
        capture.failed.push({ path: relative, reason: index >= 40 ? "file_limit" : "capture_deadline" });
        continue;
      }
      if (typeof relative !== "string" || !relative || path.isAbsolute(relative)
        || relative.includes("\\") || relative.split("/").includes("..")) {
        capture.failed.push({ path: relative, reason: "unsafe_artifact_path" });
        continue;
      }
      const read = await pollApi("/api/commands/read_artifact", { method: "POST", body: JSON.stringify({ path: relative }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))) });
      if (read.status !== 200 || read.body?.data?.encoding !== "utf8") {
        capture.failed.push({ path: relative, reason: read.status !== 200 ? "read_failed" : "unsupported_encoding", status: read.status });
        say(`could not read ${relative} (${read.status})`);
        continue;
      }
      const target = path.join(outDir, "deliverable", relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, String(read.body.data.data), "utf8");
      capture.saved.push(relative);
    }
    capture.complete = capture.failed.length === 0;
    result.artifactCapture = capture;
    await writeFile(path.join(outDir, "run.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

    say(`status=${run.status} errorCode=${run.errorCode ?? "none"} verification=${run.verification ?? "none"}`);
    say(`artifacts=${(run.artifacts ?? []).length} unverified=${(run.unverifiedArtifacts ?? []).length} saved=${capture.saved.length}`);
    // Structured since 2026-09-18 (C2): the title is the reader's, `text` the sentence.
    for (const notice of (run.qualityNotices ?? []).slice(0, 10)) say(`notice: ${typeof notice === "string" ? notice.slice(0, 300) : `[${notice?.severity ?? "advice"}] ${notice?.title ?? ""} — ${String(notice?.text ?? "").slice(0, 300)}`}`);
    say(`results: ${path.relative(repoRoot, outDir)}`);

    // The run belongs to the throwaway account, which is deleted when this returns: a run still going is cancelled first
    // (`cancelWhatWasDispatched`), because nothing could watch it afterwards.
    // 3 is an unfinished observation, 1 a terminal non-acceptance, 2 a driver error, 4 an account that was not deleted (the caller's).
    const code = observation.status === "pending" ? 3 : run.status === "succeeded" && !run.verification ? 0 : 1;
    if (code !== 0) return code;
    if (turnIndex < followUps.length && !capture.complete) {
      say("FOLLOWUP_STOPPED: the current turn's artifact snapshot is incomplete; later turns must not overwrite uncaptured evidence");
      return 2;
    }
    previousRunId = runId;
  }
  return 0;
}

/** The three actual native revision journeys: they register and delete their own account (`result-revision-acceptance.mjs`). */
async function resultRevisions() {
  const { runResultRevisionAcceptance } = await import("./result-revision-acceptance.mjs");
  await runResultRevisionAcceptance(args);
  say("three actual native revision journeys passed");
  return Number(process.exitCode ?? 0);
}

(args["result-revisions"] ? resultRevisions() : main()).then((code) => process.exit(code), (error) => {
  process.stderr.write(`${stamp()} acceptance failed: ${error?.message ?? error}\n`);
  process.exit(2);
});
