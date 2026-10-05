import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { freezeCycle, scoreUnit, reportReplicates, validateRewrite, screenRetractions, digest } from "./evaluator.mjs";
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
/** Runs through the existing session/dispatch API; policy registration precedes runtime start. */
export async function platformDispatch({ base, headers, caseRecord, replicate, cycleId, attempt = 0 }) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("Invalid administrative dispatch attempt.");
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
      rows.push({ ...score, caseId: testCase.id, replicate, variant, track: ({ meta: "E", pharmacovigilance: "P", mr: "P" }[testCase.track] ?? testCase.track ?? definition.track), group: testCase.group ?? definition.group ?? "calibration", at: new Date().toISOString(),
        producerRunId: execution.run?.id ?? unit.id ?? null, producerProjectId: execution.project?.id ?? execution.projectId ?? unit.projectId ?? null,
        publishedPaperId: testCase.publicationId ?? testCase.paperId ?? testCase.gold.sourcePaperId ?? testCase.dois?.[0] ?? null,
        goldSourceHash: testCase.sourceHash ?? testCase.gold.sourceHash ?? null,
        retracted: screens.length > 0 && screens.every(row => row.admissible && row.status === "clear") ? false : null,
        independent: assessed.independentAssessment === true, assessmentModel: assessed.assessmentModel ?? null,
        engineId: testCase.engineId ?? null, capabilityId: testCase.capabilityId });
      newUnits++;
      await checkpoint();
      }
    }
  }
  const plannedUnits = definition.cases.filter(c => !rows.some(r => r.id === c.id && r.excluded)).reduce((n,c) => n + c.rewrite.variants.length * Math.max(2, definition.replicates ?? 2), 0);
  const complete = rows.filter(r => !r.excluded).length === plannedUnits;
  const report = { complete, plannedUnits, newUnits, cycleId, evaluatorHash: frozen.hash, at: new Date().toISOString(), units: rows.filter(row => !row.excluded), excluded: rows.filter(row => row.excluded), cases: complete ? reportReplicates(rows.filter(row => !row.excluded)) : [] };
  await writeFile(path.join(frozen.directory, "report.json"), JSON.stringify(report), { mode: 0o600 });
  return report;
}
if (process.argv[1]?.endsWith("run.mjs")) {
  const [definitionFile, adapterFile, cycleId] = process.argv.slice(2);
  if (!definitionFile || !adapterFile || !cycleId || !process.env.OPEN_SCIENCE_EVALUATION_DATA_DIR) throw new Error("Usage: OPEN_SCIENCE_EVALUATION_DATA_DIR=/protected node run.mjs definition.json adapter.mjs cycle-id");
  const definition = JSON.parse(await readFile(definitionFile, "utf8"));
  const adapter = (await import(pathToFileURL(path.resolve(adapterFile)).href)).default;
  const report = await runCycle({ dataDir: process.env.OPEN_SCIENCE_EVALUATION_DATA_DIR, cycleId, definition, adapter });
  process.stdout.write(`${JSON.stringify({ cycleId, evaluatorHash: report.evaluatorHash, completed: report.cases.length, excluded: report.excluded.length })}\n`);
}
