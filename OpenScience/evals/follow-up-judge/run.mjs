#!/usr/bin/env node
/**
 * Calibrate the follow-up judge: send every labelled case through the judge as the control plane sends it, apply the module's own
 * verdict parser, and report per-class precision and recall, the confusion matrix, quotation validity and — on its own, because it
 * triggers learning — the precision of `adopt`.
 *
 * Nothing about the judge is copied here. The request is the module's own (`FollowUpJudge.read` builds the messages, the model
 * parameters and the truncations), the call is the control plane's own `callModelForControlPlane` with the key held in memory (the
 * production path minus the usage ledger), and the answer is read by the module's own `followUpVerdictFrom`. A change to the
 * instructions, to the parameters or to the parser in the tree is therefore what is measured. `--instructions-file` replaces only
 * the system message, to try a rewording before it is edited into the module.
 *
 *   node evals/follow-up-judge/run.mjs --key-file <path> [--model deepseek-flash] [--instructions-file <txt>] [--only fj-001,fj-002]
 *     [--lang zh|en] [--concurrency 4] [--samples 1] [--out evals/follow-up-judge/results/<name>.json] [--dry-run]
 *   node evals/follow-up-judge/run.mjs --list-ambiguous      # the cases whose label the labeller hesitated over, for review
 *
 * The key is read from --key-file (or DEEPSEEK_API_KEY) and is never printed or written.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { caseIssues, render, summarize } from "./score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.resolve(here, "../../apps/server/src/learningEvidence.mjs")).href;
const GATEWAY = pathToFileURL(path.resolve(here, "../../apps/server/src/modelGateway.mjs")).href;

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {Record<string, any>} */
  const options = { model: "deepseek-flash", concurrency: 4, samples: 1, dryRun: false, cases: path.join(here, "cases.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => { const next = argv[index + 1]; if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`); index += 1; return next; };
    if (flag === "--key-file") options.keyFile = value();
    else if (flag === "--model") options.model = value();
    else if (flag === "--instructions-file") options.instructionsFile = value();
    else if (flag === "--only") options.only = value().split(",");
    else if (flag === "--lang") options.lang = value();
    else if (flag === "--concurrency") options.concurrency = Math.max(1, Math.min(16, Number(value()) || 4));
    else if (flag === "--samples") options.samples = Math.max(1, Math.min(9, Number(value()) || 1));
    else if (flag === "--out") options.out = value();
    else if (flag === "--cases") options.cases = path.resolve(value());
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--list-ambiguous") options.listAmbiguous = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

/**
 * The module's raw verdict word, when the model's text names one (even one the module does not know yet): the report shows what the
 * model said beside what the module made of it, because a tree without `adopt` refuses it as unreadable and a reader should be able to
 * tell that from a model that said something else.
 * @param {string | null} text
 */
export function rawVerdictOf(text) {
  const match = /"verdict"\s*:\s*"([A-Za-z_-]+)"/.exec(String(text ?? ""));
  return match ? match[1].toLowerCase() : null;
}

/**
 * Run the cases. `judge` is a `FollowUpJudge`, `followUpVerdictFrom` the module's parser; both are passed in so a test can stub the model.
 * @param {{ cases: readonly any[], judge: { read: Function }, followUpVerdictFrom: Function, samples?: number, concurrency?: number }} input
 */
export async function runCases({ cases, judge, followUpVerdictFrom, samples = 1, concurrency = 4 }) {
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
      const methods = (item.methodsOpened ?? []).map((/** @type {any} */ method) => ({ id: method.id, title: method.title, whenToUse: method.whenToUse }));
      const text = await judge.read({ message: item.message, previousRequest: item.previousRequest, methods }, { userId: "eval", projectId: "eval", runId: `eval-${item.id}` });
      /** @type {any} */
      const verdict = text === null ? { failure: "model_failed" } : followUpVerdictFrom(text, { message: item.message, methods: methods.map((/** @type {any} */ method) => ({ ...method, digest: `d-${method.id}` })) });
      results[slot] = {
        id: item.id, sample, lang: item.lang, gold: item.class, alsoAcceptable: item.alsoAcceptable ?? [], ambiguous: item.ambiguous === true, tag: item.tag,
        predicted: "failure" in verdict ? "unreadable" : verdict.verdict, failure: "failure" in verdict ? verdict.failure : null,
        rawVerdict: rawVerdictOf(text), rule: "failure" in verdict ? null : verdict.rule, quote: "failure" in verdict ? null : verdict.quote,
        concerns: "failure" in verdict ? [] : verdict.concerns.map((/** @type {any} */ concern) => concern.id), goldQuote: item.quote ?? null, goldConcerns: item.concerns ?? null,
        modelText: text === null ? null : String(text).slice(0, 600),
      };
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
  if (options.listAmbiguous) {
    for (const item of cases.filter((/** @type {any} */ candidate) => candidate.ambiguous)) {
      write(`${item.id} [${item.lang}] gold ${item.class}${item.alsoAcceptable?.length ? ` (also ${item.alsoAcceptable.join("/")})` : ""}: ${item.message}\n    why: ${item.why}\n`);
    }
    return 0;
  }
  if (options.only) cases = cases.filter((/** @type {any} */ item) => options.only.includes(item.id));
  if (options.lang) cases = cases.filter((/** @type {any} */ item) => item.lang === options.lang);
  if (!cases.length) throw new Error("no case selected");

  const { FollowUpJudge, followUpVerdictFrom, FOLLOW_UP_JUDGE_INSTRUCTIONS } = await import(MODULE);
  const { callModelForControlPlane } = await import(GATEWAY);
  const instructions = options.instructionsFile ? (await readFile(options.instructionsFile, "utf8")).trim() : null;

  const key = process.env.DEEPSEEK_API_KEY?.trim() || (options.keyFile ? (await readFile(options.keyFile, "utf8")).trim() : "");
  if (options.dryRun) {
    /** @type {any} */
    let captured = null;
    const judge = new FollowUpJudge({ deepseekProviderEnabled: true, deepseekApiKey: "dry-run", deepseekModel: options.model }, {
      callModel: async (/** @type {any} */ _context, /** @type {any} */ call) => { captured = call.body; return { choices: [{ message: { content: "" } }] }; },
    });
    const item = cases[0];
    await judge.read({ message: item.message, previousRequest: item.previousRequest, methods: [] }, { userId: "eval", projectId: "eval", runId: "dry" });
    if (instructions && captured) captured.messages[0].content = instructions;
    write(`${JSON.stringify({ case: item.id, instructionsAreTheModules: !instructions && captured?.messages?.[0]?.content === FOLLOW_UP_JUDGE_INSTRUCTIONS, request: captured }, null, 1)}\n`);
    return 0;
  }
  if (!key) throw new Error("no key: pass --key-file <path> (or set DEEPSEEK_API_KEY)");

  const config = { deepseekProviderEnabled: true, deepseekApiKey: key, deepseekBaseUrl: "https://api.deepseek.com", deepseekModel: options.model, modelGatewayTimeoutMs: 60_000, production: false, requireDurableUsageLedger: false };
  const judge = new FollowUpJudge(config, {
    callModel: instructions
      ? (/** @type {any} */ context, /** @type {any} */ call) => callModelForControlPlane(context, { ...call, body: { ...call.body, messages: [{ role: "system", content: instructions }, ...call.body.messages.slice(1)] } })
      : callModelForControlPlane,
  });
  const results = await runCases({ cases, judge, followUpVerdictFrom, samples: options.samples, concurrency: options.concurrency });
  const summary = summarize(results);
  write(`${render(summary)}\n`);
  const out = options.out ?? path.join(here, "results", `${new Date().toISOString().slice(0, 10)}-${options.model}${instructions ? "-custom-instructions" : ""}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({
    model: options.model, instructions: instructions ? "file" : "module", samples: options.samples, at: new Date().toISOString(), summary, results,
  }, null, 1)}\n`);
  write(`wrote ${out}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => process.exit(code), (error) => { process.stderr.write(`${error?.message ?? error}\n`); process.exit(1); });
}
