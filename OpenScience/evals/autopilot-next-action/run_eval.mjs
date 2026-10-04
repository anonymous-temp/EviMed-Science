#!/usr/bin/env node
/**
 * The next-action decision's situations as an eval (principle 6; plan 2026-10-02
 * §11.3 N10): counterevidence, a failure to run, a missing input, an answered
 * question and the boundary around stopping. It calls the live model through the
 * platform's own `AutopilotPlanner` and builds each case's context with the same
 * `buildPlannerContext` the scheduler uses, so the prompt under test is the one
 * that ships. A case passes a run when the decision is one of `expect` — the
 * closed-vocabulary choice, never the model's wording.
 *
 *   node evals/autopilot-next-action/run_eval.mjs [--runs 3] [--key-file <path>] [--only <case-id>]
 *
 * The key file defaults to the workspace's local DeepSeek key; nothing is
 * metered (no usage ledger) and nothing is written but the result file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AutopilotPlanner, buildPlannerContext, eligibleTaskTypes } from "../../apps/server/src/autopilotNextAction.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
    only: { type: "string" },
  },
});
const runs = Math.max(1, Math.min(10, Number(values.runs) || 3));
const apiKey = (await readFile(values["key-file"], "utf8")).trim();
if (!apiKey) throw new Error("The DeepSeek key file is empty.");
const { cases } = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));
const planner = new AutopilotPlanner({ deepseekProviderEnabled: true, deepseekApiKey: apiKey, deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-flash" }, { usageLedger: null });

/** @type {any[]} */
const results = [];
for (const item of cases.filter((/** @type {{ id: string }} */ candidate) => !values.only || candidate.id === values.only)) {
  const agenda = { id: "agenda-eval", projectId: "eval", payload: { ...item.agenda, taskTypeState: {} } };
  const eligible = eligibleTaskTypes(agenda.payload);
  const context = buildPlannerContext({ agenda, progress: item.progress, eligible, date: "2026-10-04", trigger: "scheduled",
    reducedPriority: false, stopAllowed: item.stopAllowed });
  const answers = [];
  for (let run = 0; run < runs; run += 1) {
    try {
      const decision = /** @type {any} */ (await planner.decide({ userId: "eval", projectId: "eval", episodeId: `episode-eval-${run}`, context, eligible, stopAllowed: item.stopAllowed }));
      answers.push(decision.action === "stop" ? { action: "stop", stopKind: decision.stopKind, reason: decision.reason } : { action: "run", taskType: decision.taskType, focus: decision.focus });
    } catch (error) {
      answers.push({ error: /** @type {any} */ (error)?.code ?? "autopilot_planner_failed" });
    }
  }
  const right = (/** @type {any} */ answer) => item.expect.some((/** @type {any} */ want) => Object.entries(want).every(([key, value]) => answer[key] === value));
  const passed = answers.filter(right).length;
  results.push({ id: item.id, passed, runs, answers, why: item.why });
  console.log(`${passed === runs ? "PASS" : "FAIL"} ${item.id} ${passed}/${runs} ${JSON.stringify(answers.map((answer) => answer.error ?? (answer.action === "stop" ? `stop:${answer.stopKind}` : `run:${answer.taskType}`)))}`);
}
const total = results.reduce((sum, result) => sum + result.runs, 0);
const passed = results.reduce((sum, result) => sum + result.passed, 0);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
await mkdir(join(here, "results"), { recursive: true });
const file = join(here, "results", `run-${stamp}.json`);
await writeFile(file, `${JSON.stringify({ at: new Date().toISOString(), model: planner.model, runs, passed, total, results }, null, 1)}\n`);
console.log(`${passed}/${total} answers as expected; ${results.filter((result) => result.passed === result.runs).length}/${results.length} cases in every run → ${file}`);
