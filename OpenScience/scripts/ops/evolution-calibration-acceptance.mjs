// Isolated, metered primary-paper curation only. This does not dispatch research runtimes.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../../evals/paper-gold/evaluator.mjs";
import { createWebApiApp } from "../../apps/server/src/server.mjs";
import { createEvolutionConfiguration } from "./evolution-acceptance-config.mjs";

export const CALIBRATION_TRACKS = ["meta", "pharmacovigilance", "mr"];
/** Resume frozen definitions without another model request. @param {any} dependencies */
export async function runCalibrationAcceptance({ app, evaluationDataDir, tracks = CALIBRATION_TRACKS, version = "v1", signal, output = value => process.stdout.write(`${JSON.stringify(value)}\n`) }) {
  if (!/^v[1-9]$/.test(version)) throw new Error("Unknown calibration version.");
  if (!Array.isArray(tracks) || !tracks.length || new Set(tracks).size !== tracks.length) throw new Error("Select distinct calibration tracks.");
  const rows = [];
  for (const track of tracks) {
    if (!CALIBRATION_TRACKS.includes(track)) throw new Error("Unknown calibration track.");
    signal?.throwIfAborted();
    const cycleId = `acceptance-calibration-${track}-${version}`;
    const directory = path.join(evaluationDataDir, "paper-gold", "cycles", cycleId);
    let frozen;
    try { frozen = JSON.parse(await fs.readFile(path.join(directory, "definition.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let resumed = Boolean(frozen);
    if (frozen) {
      if (!/^[a-f0-9]{64}$/.test(frozen.hash) || !/^[a-f0-9]{64}$/.test(frozen.evaluatorCodeHash) || frozen.hash !== digest({ definition: frozen.definition, evaluatorCodeHash: frozen.evaluatorCodeHash }) || frozen.definition?.track !== track || !Array.isArray(frozen.definition.cases) || !Array.isArray(frozen.definition.unavailable)) throw new Error("The saved calibration definition is malformed or belongs to another track.");
    } else {
      await app.evolution.paperGold.prepareCalibration({ userId: "evolution-acceptance", cycleId, track, signal, ...(["v5", "v6"].includes(version) && track === "meta" ? { replacementId: "meta-31679516" } : {}), ...(version === "v6" && track === "mr" ? { replacementId: "mr-28855160" } : {}), ...(version !== "v1" ? { targetedRepair: ["v4", "v5", "v6"].includes(version), reuseFromCycleId: `acceptance-calibration-${track}-v${Number(version.slice(1)) - 1}` } : {}) });
      frozen = JSON.parse(await fs.readFile(path.join(directory, "definition.json"), "utf8"));
      resumed = false;
    }
    const admissible = frozen.definition.cases.length;
    const missing = frozen.definition.unavailable.length;
    const row = { track, cycleId, hash: frozen.hash, count: admissible + missing, admissible, missing, resumed, scored: false };
    rows.push(row);
    output(row);
  }
  await fs.mkdir(evaluationDataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(evaluationDataDir, "calibration-acceptance-summary.json"), JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), tracks: rows, scored: false }), { mode: 0o600 });
  return rows;
}

async function closeDetachedApp(app) {
  try { await app.close(); }
  catch (error) { if (error.code !== "ERR_SERVER_NOT_RUNNING") throw error; await app.store.close(); }
}
async function main() {
  const inputFile = process.env.EVIMED_EVOLUTION_ACCEPTANCE_INPUT;
  if (!inputFile) throw new Error("EVIMED_EVOLUTION_ACCEPTANCE_INPUT must name the isolated acceptance input.");
  const input = JSON.parse(await fs.readFile(inputFile, "utf8"));
  if (!String(input.databaseUrl).includes("evimed_test_evolution") || input.dataDir !== "/acceptance" || input.evaluationDataDir !== "/control-eval"
    || !String(input.runtimeImage).startsWith("evimed-evolution-acceptance:") || !String(input.network).startsWith("evimed-evolution-acceptance")) throw new Error("Refusing an unscoped calibration environment.");
  const credentials = JSON.parse(await fs.readFile("/control-state/acceptance-credentials.json", "utf8"));
  const overrides = createEvolutionConfiguration(input, credentials);
  const version = process.argv.find(arg => arg.startsWith("--version="))?.slice(10) ?? "v1";
  const requested = process.argv.slice(2).filter(arg => !arg.startsWith("--version="));
  const tracks = requested.length ? requested : CALIBRATION_TRACKS;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const app = createWebApiApp(overrides);
  // Construction alone starts neither listeners nor recurring workers.
  try {
    await runCalibrationAcceptance({ app, evaluationDataDir: input.evaluationDataDir, tracks, version, signal: controller.signal });
  } finally { await closeDetachedApp(app); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
