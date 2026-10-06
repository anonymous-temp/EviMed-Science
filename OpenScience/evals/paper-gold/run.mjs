import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { usagePurposeOfRun } from "@evimed/domain";
import { freezeCycle, scoreUnit, reportReplicates, validateRewrite, screenRetractions, digest } from "./evaluator.mjs";
/**
 * How many times one unit may be dispatched after administrative refusals (a spent model allowance).
 * Each attempt is a fresh isolated project and a fresh run, so an unbounded counter is an unbounded
 * number of projects: a unit that is still refused after this many attempts is recorded as unscored
 * (`administrative_retry_limit`) and the cycle moves on. Unscored is never read as a score.
 */
export const PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS = 5;
/** Control-only administrative stop; not a scientific assessment or a day-window claim. */
export class PaperGoldAdministrativeDeferral extends Error {
  /** @param {any} run @param {string} projectId */
  constructor(run, projectId) {
    super("Paper evaluation waits for administrative spending capacity.");
    if (typeof run?.id !== "string" || !run.id.trim() || typeof projectId !== "string" || !projectId.trim() || run.status !== "failed" || run.errorCode !== "runtime_spend_limit_reached") throw new Error("Not a trusted administrative terminal run.");
    this.code = "paper_gold_administrative_deferred";
    this.status = 402;
    this.details = {runId:run.id,projectId,administrativeCode:run.errorCode,cause:"unknown"};
  }
}
/**
 * Dispatch one unit from outside the server, through the public session and dispatch routes, for an
 * operator's standalone adapter. Policy registration precedes runtime start.
 *
 * What these runs are, said plainly: ordinary runs of the signed-in operator account. A run's usage
 * purpose is decided by the server from what its own dispatcher stamps (`usagePurposeOfRun`), and the
 * public dispatch route never takes a purpose, a route reason or a classification from its caller. The
 * dispatch id sent here is an identity for replay and nothing else. So a unit dispatched this way is
 * charged to that operator account, under that account's own caps and billing, and the evolution daily
 * budget (`OPEN_SCIENCE_EVOLUTION_DAILY_BUDGET_CNY`) does not hold it. Bound a standalone cycle with
 * `maxNewUnits`.
 *
 * The path the budget does hold is the in-process one the worker uses: an `evolution-evaluate` job for
 * the cycle, which runs this same `runCycle` with the control plane's adapter and dispatches through
 * `evolutionRuns.mjs`, where the platform's route reason is stamped and the allowance is checked first.
 * `runCycle` records on every unit the purpose the server's rule gives its run, so a report shows which
 * of the two a unit was.
 */
export async function platformDispatch({ base, headers, caseRecord, replicate, cycleId, attempt = 0 }) {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS) throw new Error("Invalid administrative dispatch attempt.");
  const identity = `${cycleId}:${caseRecord.id}:${replicate}${attempt ? `:administrative-retry:${attempt}` : ""}`;
  const projectId = `eval-paper-${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
  const request = async (route, body, scoped = true) => {
    const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "Content-Type": "application/json", ...(scoped ? { "X-Open-Science-Project": projectId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = /** @type {any} */ (await response.json());
    if (!response.ok) throw new Error(`${route}: ${response.status} ${value.error ?? "request failed"}`);
    return value.data?.data ?? value.data ?? value;
  };
  await request("/api/projects", { id: projectId, name: "Published-paper evaluation" }, false);
  await request("/api/evolution/evaluation-policy", { projectId, policy: caseRecord.policy });
  await request("/api/commands/start_runtime", {});
  const session = await request("/api/runtime/sessions", {});
  const run = await request("/api/agent-runs/dispatch", { sessionId: session.id, dispatchId: `evolution_paper_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`, text: caseRecord.input, automated: true, line: caseRecord.capabilityId });
  const deadline = Date.now() + 3600000;
  while (Date.now() < deadline) {
    const listed = await request("/api/agent-runs?limit=200");
    const terminal = listed.find(row => row.id === run.id);
    if (terminal && !["queued", "dispatching", "running"].includes(terminal.status)) {
      if (terminal.status !== "succeeded" && terminal.errorCode === "runtime_spend_limit_reached") throw new PaperGoldAdministrativeDeferral(terminal, projectId);
      return { projectId, run: terminal, transcript: await request(`/api/runtime/sessions/${encodeURIComponent(session.id)}/transcript`) };
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error("Evaluation run exceeded the harness deadline.");
}
/** Adapter keeps gold inaccessible to the execution side. Baseline must disable tools structurally. */
export async function runCycle({ dataDir, cycleId, definition, adapter, signal = undefined, maxNewUnits = null }) {
  if (maxNewUnits !== null && (!Number.isSafeInteger(maxNewUnits) || maxNewUnits < 1)) throw new Error("Invalid bounded unit count.");
  let newUnits = 0;
  const frozen = await freezeCycle(dataDir, cycleId, definition);
  const progressFile = path.join(frozen.directory, "progress.json");
  let progress = { evaluatorHash: frozen.hash, rows: [], baselines: {} };
  try {
    progress = JSON.parse(await readFile(progressFile, "utf8"));
    if (progress.evaluatorHash !== frozen.hash) throw new Error("Checkpoint evaluator hash changed.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const rows = progress.rows;
  progress.dispatchAttempts ??= {};
  progress.administrativeStops ??= [];
  progress.unscored ??= [];
  const checkpoint = async () => {
    const temporary = `${progressFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(progress), { mode: 0o600 });
    await rename(temporary, progressFile);
  };
  unitsLoop: for (const testCase of definition.cases) {
    signal?.throwIfAborted();
    if (rows.some(row => row.id === testCase.id && row.excluded)) continue;
    validateRewrite(testCase.rewrite, { identifiers: testCase.policy.aliases });
    const screens = await screenRetractions(testCase.dois ?? [], adapter.fetchImpl);
    if (screens.some(row => !row.admissible)) { rows.push({ id: testCase.id, excluded: "retraction_screen", screens }); await checkpoint(); continue; }
    // A method case hands the run its inputs; a no-tool guess at it measures arithmetic, not memory. The baseline
    // used to be asked the template question without the inputs, could never match, and was recorded as "not
    // memorised". It is recorded as what it is: not applicable.
    if (testCase.type === "method" && !Object.hasOwn(progress.baselines, testCase.id)) { progress.baselines[testCase.id] = { memorized: null, applicable: false, reason: "inputs_disclosed_method_case", recordedAt: new Date().toISOString() }; await checkpoint(); }
    if (!Object.hasOwn(progress.baselines, testCase.id)) {
      const numericFields = Object.keys(testCase.gold.baselineNumeric ?? testCase.gold.numeric ?? {});
      const baseline = await adapter.noToolBaseline({ prompt: testCase.rewrite.question, numericFields, tools: [], toolChoice: "none" });
      progress.baselines[testCase.id] = { memorized: adapter.baselineMemorized(baseline, testCase.gold), answer: baseline, answerHash: digest(baseline), numericFields, recordedAt: new Date().toISOString() };
      await checkpoint();
    }
    const baselineRecord = progress.baselines[testCase.id];
    if (typeof baselineRecord === "boolean" ? baselineRecord : baselineRecord.memorized === true) { rows.push({ id: testCase.id, excluded: "possible_memorization", developmentOnly: true }); await checkpoint(); continue; }
    for (let variant = 0; variant < testCase.rewrite.variants.length; variant++) {
      for (let replicate = 0; replicate < Math.max(2, definition.replicates ?? 2); replicate++) {
      signal?.throwIfAborted();
      if (rows.some(row => row.caseId === testCase.id && row.variant === variant && row.replicate === replicate)) continue;
      if (maxNewUnits !== null && newUnits >= maxNewUnits) break unitsLoop;
      const variantQuestion = testCase.rewrite.variants[variant];
      const input = testCase.type === "question" ? variantQuestion : String(testCase.input).replace(testCase.rewrite.question, variantQuestion);
      const attemptKey = `${testCase.id}:${variant}:${replicate}`;
      const attempt = progress.dispatchAttempts[attemptKey] ?? 0;
      if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("Invalid administrative dispatch attempt checkpoint.");
      if (progress.unscored.some(row => row.caseId === testCase.id && row.variant === variant && row.replicate === replicate)) continue;
      if (attempt >= PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS) {
        progress.unscored.push({ caseId: testCase.id, variant, replicate, reason: "administrative_retry_limit", attempts: attempt, at: new Date().toISOString() });
        await checkpoint();
        continue;
      }
      let execution;
      try {
        execution = await adapter.dispatch({ caseRecord: { id: testCase.id, policy: testCase.policy, capabilityId: testCase.capabilityId, input }, replicate: variant * Math.max(2, definition.replicates ?? 2) + replicate, variant, cycleId, attempt });
      } catch (error) {
        if (error instanceof PaperGoldAdministrativeDeferral) {
          progress.administrativeStops.push({caseId:testCase.id,variant,replicate,attempt,runId:error.details.runId,projectId:error.details.projectId,code:error.details.administrativeCode,cause:"unknown",at:new Date().toISOString()});
          progress.dispatchAttempts[attemptKey] = attempt + 1;
          await checkpoint();
        }
        throw error;
      }
      const unit = await adapter.extract(execution);
      const assessed = adapter.assess ? await adapter.assess(unit, testCase.gold) : unit;
      const score = await scoreUnit({ ...assessed, id: testCase.id }, { ...testCase.gold, type: testCase.type }, { review: adapter.review, verifyCode: adapter.verifyCode });
      const comparison = adapter.comparison ? await adapter.comparison({ unit: assessed, gold: testCase.gold, score }) : null;
      rows.push({ ...score, ...(comparison ? { comparison } : {}), caseId: testCase.id, replicate, variant, track: ({ meta: "E", pharmacovigilance: "P", mr: "P" }[testCase.track] ?? testCase.track ?? definition.track), group: testCase.group ?? definition.group ?? "calibration", at: new Date().toISOString(),
        producerRunId: execution.run?.id ?? unit.id ?? null, producerProjectId: execution.project?.id ?? execution.projectId ?? unit.projectId ?? null,
        publishedPaperId: testCase.publicationId ?? testCase.paperId ?? testCase.gold.sourcePaperId ?? testCase.dois?.[0] ?? null,
        goldSourceHash: testCase.sourceHash ?? testCase.gold.sourceHash ?? null,
        retracted: screens.length > 0 && screens.every(row => row.admissible && row.status === "clear") ? false : null,
        independent: assessed.independentAssessment === true, assessmentModel: assessed.assessmentModel ?? null,
        engineId: testCase.engineId ?? null, capabilityId: testCase.capabilityId,
        // What the server's own rule says this run was for: `evolution` when the in-process dispatcher made it,
        // `kernel` (an ordinary run of the operator's account) when it came through the public route.
        spendPurpose: execution.run ? usagePurposeOfRun(execution.run) : null });
      newUnits++;
      await checkpoint();
      }
    }
  }
  const plannedUnits = definition.cases.filter(c => !rows.some(r => r.id === c.id && r.excluded)).reduce((n,c) => n + c.rewrite.variants.length * Math.max(2, definition.replicates ?? 2), 0);
  const scored = rows.filter(r => !r.excluded);
  const complete = scored.length === plannedUnits;
  const byPurpose = {};
  for (const row of scored) if (row.spendPurpose) byPurpose[row.spendPurpose] = (byPurpose[row.spendPurpose] ?? 0) + 1;
  const report = { complete, plannedUnits, newUnits, cycleId, evaluatorHash: frozen.hash, at: new Date().toISOString(), units: scored, excluded: rows.filter(row => row.excluded), cases: complete ? reportReplicates(scored) : [],
    // A unit whose dispatch was refused for administrative reasons every time it was tried: in the denominator, with no score.
    unscored: progress.unscored, settled: scored.length + progress.unscored.length === plannedUnits,
    spend: { byPurpose, outsideEvolutionBudget: scored.filter(row => row.spendPurpose && row.spendPurpose !== "evolution").length } };
  await writeFile(path.join(frozen.directory, "report.json"), JSON.stringify(report), { mode: 0o600 });
  return report;
}
if (process.argv[1]?.endsWith("run.mjs")) {
  const [definitionFile, adapterFile, cycleId, unitLimit] = process.argv.slice(2);
  if (!definitionFile || !adapterFile || !cycleId || !process.env.OPEN_SCIENCE_EVALUATION_DATA_DIR || (unitLimit !== undefined && !/^[1-9]\d{0,5}$/.test(unitLimit))) throw new Error("Usage: OPEN_SCIENCE_EVALUATION_DATA_DIR=/protected node run.mjs definition.json adapter.mjs cycle-id [max-new-units]");
  const definition = JSON.parse(await readFile(definitionFile, "utf8"));
  const adapter = (await import(pathToFileURL(path.resolve(adapterFile)).href)).default;
  process.stderr.write("Standalone cycle: a unit an adapter dispatches through the public route (platformDispatch) is an ordinary run of the signed-in operator account, charged to that account under its own caps; the evolution daily budget does not hold it. The in-process path (an evolution-evaluate job for this cycle) is the one the budget holds.\n");
  const report = await runCycle({ dataDir: process.env.OPEN_SCIENCE_EVALUATION_DATA_DIR, cycleId, definition, adapter, maxNewUnits: unitLimit === undefined ? null : Number(unitLimit) });
  process.stdout.write(`${JSON.stringify({ cycleId, evaluatorHash: report.evaluatorHash, complete: report.complete, completed: report.cases.length, excluded: report.excluded.length, unscored: report.unscored.length, spend: report.spend })}\n`);
}
