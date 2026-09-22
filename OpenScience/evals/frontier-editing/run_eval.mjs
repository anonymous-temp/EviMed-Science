#!/usr/bin/env node
/**
 * The frontier feed's editing incidents as an eval (principle 6): each case is
 * a real production item one of the editor's calls got wrong on 2026-09-22 —
 * a food recall filed under 药物安全, one publisher's templated notices judged
 * one event, a trial and its editorial kept apart — or a control that must
 * stay right. It calls the live model through the platform's own
 * `FrontierEditor`, so the prompts under test are the ones that ship.
 *
 *   node evals/frontier-editing/run_eval.mjs [--runs 3] [--key-file <path>] [--only <case-id>] [--editor <module>]
 *
 * `--editor` runs another copy of `frontierEditor.mjs` (placed beside it, so
 * its imports resolve) — the control arm of a prompt change.
 * The key file defaults to the workspace's local DeepSeek key; nothing is
 * metered (no usage ledger) and nothing is written but the result file.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FRONTIER_LANES } from "../../packages/domain/src/frontierVocabulary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
    only: { type: "string" },
    editor: { type: "string", default: resolve(here, "../../apps/server/src/frontierEditor.mjs") },
  },
});
const { FRONTIER_EDITOR_VERSION, FrontierEditor } = await import(pathToFileURL(resolve(values.editor)).href);
const runs = Math.max(1, Math.min(10, Number(values.runs) || 3));
const apiKey = (await readFile(values["key-file"], "utf8")).trim();
if (!apiKey) throw new Error("The DeepSeek key file is empty.");

const cases = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));
const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: apiKey, deepseekBaseUrl: "https://api.deepseek.com",
  frontierModel: "deepseek-flash" },
  { owner: { userId: "eval", projectId: "eval" } });
const allowedLanes = FRONTIER_LANES.filter((lane) => lane !== "mixed");
const wanted = (/** @type {{ id: string }} */ item) => !values.only || item.id === values.only;

/** @type {any[]} */
const results = [];
for (const item of cases.lane.filter(wanted)) {
  const answers = [];
  for (let run = 0; run < runs; run += 1) {
    const screened = await editor.screen([{ key: "1", ...item.screen, allowedLanes }]);
    const screenLane = screened.verdicts.get("1")?.lane ?? null;
    const edited = await editor.edit({ ...item.edit, allowedLanes, defaults: { lane: screenLane } });
    answers.push({ screen: screenLane ?? `error:${screened.errors.get("1")}`, edit: edited.output?.lane ?? `error:${edited.error}` });
  }
  const ok = (/** @type {string} */ lane) => (item.expect ? item.expect.includes(lane) : !item.expect_not.includes(lane));
  const passed = answers.filter((answer) => ok(answer.screen) && ok(answer.edit)).length;
  results.push({ kind: "lane", id: item.id, passed, runs, answers, why: item.why });
  console.log(`${passed === runs ? "PASS" : "FAIL"} lane ${item.id} ${passed}/${runs} ${JSON.stringify(answers)}`);
}
for (const item of cases.same_event.filter(wanted)) {
  const answers = [];
  for (let run = 0; run < runs; run += 1) {
    const judged = await editor.judgeSameEvent({ report: item.report, candidates: item.candidates });
    answers.push(judged.verdicts?.[0] ?? `error:${judged.error}`);
  }
  const passed = answers.filter((answer) => item.expect.includes(answer)).length;
  results.push({ kind: "same-event", id: item.id, passed, runs, answers, why: item.why });
  console.log(`${passed === runs ? "PASS" : "FAIL"} same-event ${item.id} ${passed}/${runs} ${JSON.stringify(answers)}`);
}

const total = results.reduce((sum, result) => sum + result.runs, 0);
const passed = results.reduce((sum, result) => sum + result.passed, 0);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
await mkdir(join(here, "results"), { recursive: true });
const file = join(here, "results", `run-${stamp}.json`);
await writeFile(file, `${JSON.stringify({ at: new Date().toISOString(), editor: values.editor.split("/").pop(), editorVersion: FRONTIER_EDITOR_VERSION, model: editor.model,
  runs, passed, total, results }, null, 1)}\n`);
console.log(`${passed}/${total} answers as expected; ${results.filter((result) => result.passed === result.runs).length}/${results.length} cases in every run → ${file}`);
