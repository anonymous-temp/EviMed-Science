#!/usr/bin/env node
/**
 * Calibrate the replay judge: send every labelled case through `MethodReplayJudge` as the control plane sends it, apply the module's own grounding
 * (`replayVerdictFrom`), and report recall of the contradictions and the false-positive rate on the cases that do not contradict.
 *
 * Nothing about the judge is copied here: the request is the module's (`MethodReplayJudge.read`), the call is the control plane's own
 * `callModelForControlPlane` with the key held in memory, and the answer is read by `replayVerdictFrom`; a change to the instructions, the parameters or the
 * grounding in the tree is what is measured. Each case's method and accepted run are rendered by the module's own `methodReplayText` and `trajectoryReplayText`.
 *
 *   node evals/method-replay/run.mjs --key-file <path> [--model deepseek-flash] [--samples 1] [--only mr-001,mr-013] [--out <file>] [--dry-run]
 *
 * The number to read is the false-positive rate: the replay takes a method's newer version out on two grounded contradictions, so a judge that reports one
 * where there is none is the failure that costs the person a method. The key is read from --key-file (or DEEPSEEK_API_KEY) and is never printed or written.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { caseIssues, render, summarize } from "./score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.resolve(here, "../../apps/server/src/methodReplay.mjs")).href;
const GATEWAY = pathToFileURL(path.resolve(here, "../../apps/server/src/modelGateway.mjs")).href;

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {Record<string, any>} */
  const options = { model: "deepseek-flash", samples: 1, dryRun: false, concurrency: 4, cases: path.join(here, "cases.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => { const next = argv[index + 1]; if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`); index += 1; return next; };
    if (flag === "--key-file") options.keyFile = value();
    else if (flag === "--model") options.model = value();
    else if (flag === "--samples") options.samples = Math.max(1, Math.min(9, Number(value()) || 1));
    else if (flag === "--concurrency") options.concurrency = Math.max(1, Math.min(8, Number(value()) || 4));
    else if (flag === "--only") options.only = value().split(",");
    else if (flag === "--out") options.out = value();
    else if (flag === "--cases") options.cases = path.resolve(value());
    else if (flag === "--dry-run") options.dryRun = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

/**
 * What the module is shown for a case: the method as a method document, the accepted run as a digest-shaped record.
 * @param {any} item
 */
export function shownFor(item, { methodReplayText, trajectoryReplayText }) {
  const method = { id: `method:learned:${item.method.name}`, payload: { frontmatter: { name: item.method.name, description: item.method.description, whenToUse: item.method.whenToUse }, body: item.method.body } };
  const digest = {
    requests: item.run.requests.map((/** @type {string} */ text) => ({ sessionId: null, seq: null, text })),
    interventions: [],
    artifacts: (item.run.files ?? []).map((/** @type {any} */ file) => ({ path: file.path, format: file.format, ...(file.labels?.length ? { shape: { format: file.format, labels: file.labels } } : {}) })),
    tools: item.run.tools ?? [],
    outcome: { status: "succeeded", repaired: false },
    dropped: { sensitive: 0 },
  };
  return { methodText: methodReplayText(method), runText: trajectoryReplayText(/** @type {any} */ (digest)) };
}

/**
 * Run the cases. `judge` is a `MethodReplayJudge`, `module` the module's `replayVerdictFrom`, `methodReplayText` and `trajectoryReplayText`; passed in so a test can stub the model.
 * @param {{ cases: readonly any[], judge: { read: Function }, module: any, samples?: number, concurrency?: number }} input
 */
export async function runCases({ cases, judge, module, samples = 1, concurrency = 4 }) {
  /** @type {{ item: any, sample: number }[]} */
  const queue = cases.flatMap((item) => Array.from({ length: samples }, (_, sample) => ({ item, sample })));
  /** @type {any[]} */
  const results = new Array(queue.length);
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const slot = next;
      next += 1;
      const { item, sample } = queue[slot];
      const shown = shownFor(item, module);
      const text = await judge.read(shown, { userId: "eval", projectId: "eval", runId: `eval-${item.id}` });
      const verdict = text === null ? { verdict: "failed", reason: "unavailable" } : module.replayVerdictFrom(text, shown);
      results[slot] = { id: item.id, sample, lang: item.lang, gold: item.label, tag: item.tag, verdict: verdict.verdict, predicted: verdict.verdict === "contradiction" ? "contradiction" : "none",
        reason: /** @type {any} */ (verdict).reason ?? null, methodQuote: /** @type {any} */ (verdict).methodQuote ?? null, runQuote: /** @type {any} */ (verdict).runQuote ?? null, modelText: text === null ? null : String(text).slice(0, 500) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}

/** @param {string[]} [argv] @param {(text: string) => unknown} [write] */
export async function main(argv = process.argv.slice(2), write = (/** @type {string} */ text) => process.stdout.write(text)) {
  const options = parseArguments(argv);
  let cases = JSON.parse(await readFile(options.cases, "utf8")).cases;
  const issues = caseIssues(cases);
  if (issues.length) throw new Error(`the case file is malformed:\n  ${issues.join("\n  ")}`);
  if (options.only) cases = cases.filter((/** @type {any} */ item) => options.only.includes(item.id));
  if (!cases.length) throw new Error("no case selected");
  const module = await import(MODULE);
  const { callModelForControlPlane } = await import(GATEWAY);
  if (options.dryRun) {
    /** @type {any} */
    let captured = null;
    const judge = new module.MethodReplayJudge({ deepseekProviderEnabled: true, deepseekApiKey: "dry-run", deepseekModel: options.model }, {
      callModel: async (/** @type {any} */ _context, /** @type {any} */ call) => { captured = call.body; return { choices: [{ message: { content: "" } }] }; },
    });
    await judge.read(shownFor(cases[0], module), { userId: "eval", projectId: "eval", runId: "dry" });
    write(`${JSON.stringify({ case: cases[0].id, instructionsAreTheModules: captured?.messages?.[0]?.content === module.REPLAY_INSTRUCTIONS, request: captured }, null, 1)}\n`);
    return 0;
  }
  const key = process.env.DEEPSEEK_API_KEY?.trim() || (options.keyFile ? (await readFile(options.keyFile, "utf8")).trim() : "");
  if (!key) throw new Error("no key: pass --key-file <path> (or set DEEPSEEK_API_KEY)");
  const config = { deepseekProviderEnabled: true, deepseekApiKey: key, deepseekBaseUrl: "https://api.deepseek.com", deepseekModel: options.model, modelGatewayTimeoutMs: 60_000, production: false, requireDurableUsageLedger: false };
  const judge = new module.MethodReplayJudge(config, { callModel: callModelForControlPlane });
  const results = await runCases({ cases, judge, module, samples: options.samples, concurrency: options.concurrency });
  const summary = summarize(results);
  write(`${render(summary)}\n`);
  const out = options.out ?? path.join(here, "results", `${new Date().toISOString().slice(0, 10)}-${options.model}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ model: options.model, samples: options.samples, summary, results }, null, 1)}\n`);
  write(`written to ${out}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => { console.error(error?.message ?? error); process.exit(1); });
}
