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
// an acceptance; a human reads the result and the package, then edits the row.
//
// Usage:
//   OPEN_SCIENCE_ACCEPTANCE_PASSWORD_FILE=<path> \
//   node scripts/ops/capability-acceptance.mjs \
//     --capability clinical-evidence-synthesis --brief review-001-empa-kidney-report-family \
//     [--base https://host] [--insecure] [--project <id>] [--timeout-ms 7200000]
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
// Production terminates TLS with a certificate issued to a bare IP, which no
// trust store will validate by name. The flag is explicit so this can never be
// the silent default on a host where the name does check out.
if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// A clinical review measured 41-61 minutes in production and the manifest
// declares up to 120. A poll budget shorter than the work is a script that
// reports failure for a run that was still going.
const timeoutMs = Number(args["timeout-ms"] ?? 7_200_000);
const pollMs = Number(args["poll-ms"] ?? 15_000);

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
 * @param {string} route
 */
async function pollApi(route) {
  try {
    return await api(route);
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
  return lines.join("\n").trim();
}

async function main() {
  if (!capabilityId) throw new Error("--capability is required");
  if (!briefId) throw new Error("--brief is required");

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
  const text = renderBrief(brief);
  if (!text) throw new Error(`brief ${briefId} rendered to an empty prompt`);

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

  const projectId = String(args.project ?? `acceptance-${capabilityId}`.slice(0, 60));
  // List before creating. A 409 from the create route means two unrelated
  // things — the id is taken, or the account is at its project ceiling — and
  // treating both as "already there" made a full account look like a resume
  // and then failed one call later with `project_not_found`, which points at
  // the wrong problem entirely.
  const existing = await api("/api/projects");
  if (existing.status !== 200) throw new Error(`project list failed: ${existing.status}`);
  const already = (existing.body.data ?? []).some((/** @type {any} */ entry) => entry.id === projectId);
  if (!already) {
    const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ id: projectId, name: `Acceptance ${capabilityId}` }) });
    if (created.status !== 201 && created.status !== 200) {
      const code = created.body?.code ?? "";
      const hint = code === "project_limit_reached"
        ? ` — pass --project <existing id> to reuse one of the ${(existing.body.data ?? []).length} this account already holds`
        : "";
      throw new Error(`project create failed: ${created.status} ${code || JSON.stringify(created.body).slice(0, 200)}${hint}`);
    }
  }
  auth["x-open-science-project"] = projectId;
  say(`project=${projectId} (${already ? "existing" : "created"})`);

  const agents = await api("/api/agents");
  if (agents.status !== 200) throw new Error(`agent list failed: ${agents.status}`);
  const agent = agents.body.data.find((/** @type {any} */ entry) => entry.id === capabilityId);
  if (!agent) throw new Error(`${capabilityId} is not registered on this deployment`);
  say(`agent version=${agent.version} runtimeAgent=${agent.runtimeAgent}`);

  // Bind the session to the capability rather than letting the router pick.
  // An acceptance that depends on the classifier is measuring the classifier.
  const sessionId = String(args.session ?? `acc-${capabilityId.slice(0, 20)}-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  if (!attachRunId) {
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
  if (attachRunId) {
    const list = await api("/api/agent-runs");
    if (list.status !== 200) throw new Error(`could not list runs: ${list.status}`);
    run = list.body.data.find((/** @type {any} */ entry) => entry.id === attachRunId);
    if (!run) throw new Error(`no run ${attachRunId} in project ${projectId}`);
    runId = attachRunId;
    say(`attached to run=${runId} (${run.status})`);
  } else {
    const dispatchId = String(args["dispatch-id"] ?? `acc-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
    const dispatched = await api("/api/agent-runs/dispatch", {
      method: "POST",
      body: JSON.stringify({ sessionId, dispatchId, text }),
    });
    if (dispatched.status !== 202) {
      throw new Error(`dispatch failed: ${dispatched.status} ${JSON.stringify(dispatched.body).slice(0, 400)}`);
    }
    runId = String(dispatched.body.data.id);
    run = dispatched.body.data;
    say(`dispatched run=${runId} prompt=${text.length} chars`);
  }

  const deadline = Date.now() + timeoutMs;
  const pending = new Set(["queued", "dispatching", "running"]);
  let lastPhase = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const list = await pollApi("/api/agent-runs");
    if (list.status !== 200) {
      say(list.error ? `poll could not reach the deployment (${list.error}); retrying` : `poll returned ${list.status}; retrying`);
      continue;
    }
    const found = list.body.data.find((/** @type {any} */ entry) => entry.id === runId);
    if (!found) { say("run not in the list yet"); continue; }
    run = found;
    const phase = `${run.status}/${run.phase ?? "-"} msgs=${run.observedMessages ?? 0} tools=${run.observedToolCalls ?? 0} repairs=${run.attempts ?? 0}`;
    if (phase !== lastPhase) { say(phase); lastPhase = phase; }
    if (!pending.has(run.status)) break;
  }
  if (pending.has(run.status)) say(`TIMEOUT after ${Math.round(timeoutMs / 60000)} min; the run is still ${run.status}`);

  const outDir = path.join(repoRoot, harness, "results", `${new Date().toISOString().slice(0, 10)}-${briefId}`);
  await mkdir(outDir, { recursive: true });
  const result = {
    capability: capabilityId,
    brief: briefId,
    base,
    project: projectId,
    session: sessionId,
    runId,
    agentVersion: agent.version,
    dispatchedAt: stamp(),
    prompt: text,
    outcome: {
      status: run.status,
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
  for (const relative of wanted.slice(0, 40)) {
    const read = await api("/api/commands/read_artifact", { method: "POST", body: JSON.stringify({ path: relative }) });
    if (read.status !== 200 || read.body?.data?.encoding !== "utf8") { say(`could not read ${relative} (${read.status})`); continue; }
    const target = path.join(outDir, "deliverable", relative.replace(/^(\.\.\/)+/, ""));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(read.body.data.data), "utf8");
    saved += 1;
  }

  say(`status=${run.status} errorCode=${run.errorCode ?? "none"} verification=${run.verification ?? "none"}`);
  say(`artifacts=${(run.artifacts ?? []).length} unverified=${(run.unverifiedArtifacts ?? []).length} saved=${saved}`);
  for (const notice of (run.qualityNotices ?? []).slice(0, 10)) say(`notice: ${String(notice).slice(0, 300)}`);
  say(`results: ${path.relative(repoRoot, outDir)}`);

  // Release the runtime slot. Best effort: a held slot is an operational
  // nuisance, not a reason to report the acceptance itself as failed.
  await api("/api/commands/stop_runtime", { method: "POST", body: "{}" }).catch(() => null);

  // `accepted` in the ledger means the gate accepted it. Anything else is not.
  process.exit(run.status === "succeeded" && !run.verification ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${stamp()} acceptance failed: ${error?.message ?? error}\n`);
  process.exit(2);
});
