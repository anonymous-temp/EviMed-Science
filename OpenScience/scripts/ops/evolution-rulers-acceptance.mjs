// Actual frozen question and missing-input research rulers. No curation calls or budget reset.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../../evals/paper-gold/evaluator.mjs";
import { createWebApiApp } from "../../apps/server/src/server.mjs";
import { loadConfig } from "../../apps/server/src/config.mjs";
import { createRuntimeController } from "../../apps/server/src/runtimeControllerServer.mjs";
import { RuntimeControllerClient } from "../../apps/server/src/runtimeControllerClient.mjs";
import { createEvolutionConfiguration } from "./evolution-acceptance-config.mjs";

const tracksAllowed = ["meta", "pharmacovigilance", "mr"];
/** Planning is read-only and never creates an app or calls a model. */
export async function planRulers({ evaluationDataDir, tracks = tracksAllowed, sourceVersion = "v3", version = "v1", rulers = ["question", "research"], caseIds = null }) {
  if (![sourceVersion, version].every(value => /^v[1-9][0-9]*$/.test(value))) throw new Error("Invalid phase version.");
  if (!tracks.length || new Set(tracks).size !== tracks.length || tracks.some(track => !tracksAllowed.includes(track))) throw new Error("Select distinct supported tracks.");
  if (!rulers.length || new Set(rulers).size !== rulers.length || rulers.some(ruler => !["question", "research"].includes(ruler))) throw new Error("Select question or research rulers.");
  const phases = [];
  for (const track of tracks) {
    const sourceCycleId = `acceptance-calibration-${track}-${sourceVersion}`;
    const source = JSON.parse(await fs.readFile(path.join(evaluationDataDir, "paper-gold", "cycles", sourceCycleId, "definition.json"), "utf8"));
    if (source.hash !== digest({ definition: source.definition, evaluatorCodeHash: source.evaluatorCodeHash }) || source.definition.track !== track) throw new Error("Calibration freeze identity changed.");
    const selected = caseIds === null ? source.definition.cases : source.definition.cases.filter(row => caseIds.includes(row.id));
    if (!selected.length || (caseIds !== null && caseIds.some(id => !source.definition.cases.some(row => row.id === id)))) throw new Error("Unknown selected calibration case; select one track for a pilot.");
    const suffix = caseIds === null ? "" : `-${digest({ sourceHash: source.hash, caseIds: [...caseIds].sort() }).slice(0,12)}`;
    for (const ruler of rulers) phases.push({ track, ruler, sourceCycleId, sourceHash: source.hash,
      cycleId: `acceptance-${ruler}-${track}-${version}${suffix}`, caseIds, admitted: selected.length,
      missing: source.definition.unavailable.length, plannedDshRuns: selected.length * 6,
      minimumBaselineCalls: selected.length, minimumAssessmentCalls: selected.length * 6 });
  }
  return phases;
}
/** Requires an already listening isolated app. Single phase at a time; runner checkpoints every unit. */
export async function runRulersAcceptance({ app, evaluationDataDir, signal, maxNewUnits = null, output = value => process.stdout.write(`${JSON.stringify(value)}\n`), ...selection }) {
  const phases = await planRulers({ evaluationDataDir, ...selection });
  if (!app.evolution.service.withLock) throw new Error("Ruler execution requires the shared control-plane advisory lock.");
    const completed = [];
    for (const phase of phases) {
      signal?.throwIfAborted();
      const phaseResult = await app.evolution.service.withLock(`rulers-acceptance:${phase.cycleId}`, async () => {
      signal?.throwIfAborted();
      await app.evolution.paperGold.prepareBenchmarks({ sourceCycleId: phase.sourceCycleId, cycleId: phase.cycleId, methodIds: [], rulers: [phase.ruler], caseIds: phase.caseIds });
      const frozen = JSON.parse(await fs.readFile(path.join(evaluationDataDir, "paper-gold", "cycles", phase.cycleId, "definition.json"), "utf8"));
      if (frozen.definition.replicates !== 2 || frozen.definition.cases.some(row => row.type !== phase.ruler || row.rewrite.variants.length !== 3)) throw new Error("Acceptance requires exactly three variants and two replicates.");
      if (phase.ruler === "research" && frozen.definition.cases.some(row => row.gold.inputAvailable !== false)) throw new Error("This mode evaluates missing-input research only.");
      const job = { id: `acceptance-ruler-${phase.cycleId}`, kind: "evolution-evaluate", payload: { cycleId: phase.cycleId, maxNewUnits } };
      const evaluation = await app.evolution.worker.callbacks.evaluate(job.payload, { service: app.evolution.service, job, purpose: "evolution", signal });
      // No assumed success: actual independent assessments, exclusions, and unknown exposure remain in the ledger.
      const units = evaluation?.payload?.units ?? [];
      const result = { ...phase, evaluatorHash: frozen.hash, evaluationId: evaluation?.id ?? null, completedUnits: units.length, complete: evaluation?.payload?.complete === true,
        validApplicableStages: units.filter(row => row.applicableStagesValid === true).length,
        independentAssessments: units.filter(row => row.independent === true).length,
        assessmentModels: [...new Set(units.map(row => row.assessmentModel).filter(Boolean))],
        excludedCases: evaluation?.payload?.excluded?.length ?? 0,
        fullResearchValid: units.filter(row => row.fullResearchReproductionValid === true).length,
        unknownExposure: units.filter(row => row.exposureTier === "unknown").length, scored: Boolean(evaluation) };
      await fs.writeFile(path.join(evaluationDataDir, "paper-gold", "cycles", phase.cycleId, "acceptance-summary.json"), JSON.stringify(result), { mode: 0o600 });
      return result;
      });
      completed.push(phaseResult); output(phaseResult);
      await fs.writeFile(path.join(evaluationDataDir, "rulers-acceptance-summary.json"), JSON.stringify({ at: new Date().toISOString(), phases: completed }), { mode: 0o600 });
    }
    return completed;
}

async function main() {
  const inputFile = process.env.EVIMED_EVOLUTION_ACCEPTANCE_INPUT;
  if (!inputFile) throw new Error("Supply isolated acceptance input.");
  const input = JSON.parse(await fs.readFile(inputFile, "utf8"));
  if (!String(input.databaseUrl).includes("evimed_test_evolution") || input.dataDir !== "/acceptance" || input.evaluationDataDir !== "/control-eval"
    || !String(input.runtimeImage).startsWith("evimed-evolution-acceptance:") || !String(input.network).startsWith("evimed-evolution-acceptance")) throw new Error("Refusing an unscoped ruler environment.");
  const argument = (key, fallback) => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
  const selection = { caseIds: argument("case-ids", "").split(",").filter(Boolean).length ? argument("case-ids", "").split(",") : null, sourceVersion: argument("source-version", "v3"), version: argument("version", "v1"),
    tracks: argument("tracks", tracksAllowed.join(",")).split(","), rulers: argument("rulers", "question,research").split(",") };
  if (!process.argv.includes("--execute")) {
    for (const phase of await planRulers({ evaluationDataDir: input.evaluationDataDir, ...selection })) process.stdout.write(`${JSON.stringify({ ...phase, scored: false })}\n`);
    return;
  }
  // Exclusive replacement of the acceptance web process, using the same DB, credentials and ledger.
  const credentials = JSON.parse(await fs.readFile("/control-state/acceptance-credentials.json", "utf8"));
  const overrides = createEvolutionConfiguration(input, credentials);
  const config = loadConfig(overrides), controller = createRuntimeController(config);
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort()); process.once("SIGTERM", () => abort.abort());
  let app;
  try {
    await controller.listen();
    app = createWebApiApp({ ...overrides, evolutionController: new RuntimeControllerClient(config) });
    await app.listen(8787, "0.0.0.0");
    app.evolution.worker.stop();
    await app.store.bootstrapUserState();
    await runRulersAcceptance({ app, evaluationDataDir: input.evaluationDataDir, signal: abort.signal, maxNewUnits: argument("max-new-units", "") ? Number(argument("max-new-units", "")) : null, ...selection });
  } finally { await app?.close(); await controller.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
