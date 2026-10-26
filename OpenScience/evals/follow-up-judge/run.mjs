#!/usr/bin/env node
/**
 * Calibrate the follow-up judge: send every labelled case through the judge as the control plane sends it, and report per-class precision and
 * recall, the confusion matrix, quotation validity and — on its own, because it triggers learning — the precision of `adopt`.
 *
 * Nothing about the judge is copied here. A case is read by the module's own `readFollowUp` (apps/server/src/learningEvidence.mjs): the nearest
 * examples of the bank chosen (`followUpExamples.mjs`), the request built by `FollowUpJudge.read` (messages, model parameters and truncations), the
 * call made by the control plane's own `callModelForControlPlane` with the key held in memory (the production path minus the usage ledger), an
 * `adopt` asked twice with the examples in the other order, and every answer read by the module's own `followUpVerdictFrom`. A change to the
 * instructions, the bank, the parameters or the parser in the tree is therefore what is measured. `--instructions-file` replaces only the system
 * message, to try a rewording before it is edited into the module.
 *
 * The labelled set is split once (`split.json`): its `train` cases feed the judge's example bank (`@evimed/domain/follow-up-examples`), every other
 * case is held out, and the held-out cases are what is scored by default (`--split heldout`). `--split train` or `all` is for looking at the
 * bank's own cases and is not evidence: even then a case never sees its own example.
 *
 *   node evals/follow-up-judge/run.mjs --key-file <path> [--model deepseek-flash] [--instructions-file <txt>] [--only fj-001,fj-002]
 *     [--split heldout|train|all] [--no-examples] [--embed-key-file <path>] [--lang zh|en] [--concurrency 4] [--samples 1]
 *     [--out evals/follow-up-judge/results/<name>.json] [--dry-run]
 *   node evals/follow-up-judge/run.mjs --list-ambiguous      # the cases whose label the labeller hesitated over, for review
 *
 * The examples are chosen by character n-grams unless `--embed-key-file` names the knowledge base's DashScope key (the production selection, by the
 * meaning of the message); `--no-examples` runs the judge with its fixed contrasts alone, to read what the bank adds.
 * The keys are read from --key-file / DEEPSEEK_API_KEY and --embed-key-file and are never printed or written.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { caseIssues, render, summarize } from "./score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.resolve(here, "../../apps/server/src/learningEvidence.mjs")).href;
const EXAMPLES = pathToFileURL(path.resolve(here, "../../apps/server/src/followUpExamples.mjs")).href;
const EMBEDDER = pathToFileURL(path.resolve(here, "../../apps/server/src/kbEmbedding.mjs")).href;
const GATEWAY = pathToFileURL(path.resolve(here, "../../apps/server/src/modelGateway.mjs")).href;
const SPLITS = Object.freeze(["heldout", "train", "all"]);

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {Record<string, any>} */
  const options = { model: "deepseek-flash", concurrency: 4, samples: 1, dryRun: false, split: "heldout", examples: true, cases: path.join(here, "cases.json"), splitFile: path.join(here, "split.json") };
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
    else if (flag === "--split") { options.split = value(); options.splitGiven = true; if (!SPLITS.includes(options.split)) throw new Error(`--split is one of ${SPLITS.join(", ")}`); }
    else if (flag === "--no-examples") options.examples = false;
    else if (flag === "--embed-key-file") options.embedKeyFile = value();
    else if (flag === "--split-file") options.splitFile = path.resolve(value());
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
 * The cases a split names: the held-out ones (those not in `train`), the bank's own, or all of them.
 * @param {readonly any[]} cases @param {{ train?: readonly string[] }} split @param {"heldout" | "train" | "all"} which
 */
export function casesOfSplit(cases, split, which) {
  const train = new Set(split?.train ?? []);
  if (which === "all") return [...cases];
  return cases.filter((item) => (which === "train") === train.has(item.id));
}

/**
 * A selector that never shows a case its own example: for a run over the bank's cases, so a case is not scored on the answer it is shown.
 * @param {{ select: (message: string) => Promise<any> } | null} examples @param {{ message: string }} item
 */
function withoutOwn(examples, item) {
  if (!examples) return null;
  const same = (/** @type {string} */ text) => String(text).replace(/\s+/g, " ").trim();
  return { select: async (/** @type {string} */ message) => {
    const chosen = await examples.select(message);
    return { ...chosen, examples: chosen.examples.filter((/** @type {any} */ example) => same(example.message) !== same(item.message)) };
  } };
}

/**
 * Run the cases. `judge` is a `FollowUpJudge`, `readFollowUp` the module's reader, `examples` the example selector (or null); all are passed in so
 * a test can stub the model.
 * @param {{ cases: readonly any[], judge: { read: Function }, readFollowUp: Function, examples?: { select: Function } | null, samples?: number, concurrency?: number }} input
 */
export async function runCases({ cases, judge, readFollowUp, examples = null, samples = 1, concurrency = 4 }) {
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
      const methods = (item.methodsOpened ?? []).map((/** @type {any} */ method) => ({ id: method.id, title: method.title, whenToUse: method.whenToUse, digest: `d-${method.id}` }));
      /** @type {(string | null)[]} */
      const texts = [];
      /** @type {string[]} */
      const seen = [];
      const tap = { read: async (/** @type {any} */ request, /** @type {any} */ owner) => { const text = await judge.read(request, owner); texts.push(text); return text; } };
      /** @type {any} */
      const read = await readFollowUp({ judge: tap, examples: withoutOwn(examples, item), observe: (/** @type {string} */ outcome) => seen.push(outcome) },
        { message: item.message, previousRequest: item.previousRequest, methods }, { userId: "eval", projectId: "eval", runId: `eval-${item.id}` });
      // A model that did not answer is the model's failure, not the module's refusal.
      const failure = "failure" in read ? (read.failure === "judge_failed" ? "model_failed" : read.failure) : null;
      results[slot] = {
        id: item.id, sample, lang: item.lang, gold: item.class, alsoAcceptable: item.alsoAcceptable ?? [], ambiguous: item.ambiguous === true, tag: item.tag,
        predicted: failure ? "unreadable" : read.verdict, failure,
        rawVerdict: rawVerdictOf(texts[0] ?? null), rule: failure ? null : read.rule, quote: failure ? null : read.quote,
        concerns: failure ? [] : read.concerns.map((/** @type {any} */ concern) => concern.id), goldQuote: item.quote ?? null, goldConcerns: item.concerns ?? null,
        modelText: texts[0] == null ? null : String(texts[0]).slice(0, 600),
        calls: texts.length, adoptCheck: seen.includes("adopt_confirmed") ? "confirmed" : seen.includes("adopt_disagreed") ? "disagreed" : null,
        examples: seen.includes("examples_embedding") ? "embedding" : seen.includes("examples_ngram") ? "ngram" : null,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}

/**
 * What is wrong with the split, or []: an id that is not a case, a repeated one, a bank example that is not a train case, and a bank example
 * whose words are a held-out case's (the bank is the train part and nothing else).
 * @param {readonly any[]} cases @param {{ train?: readonly string[] }} split
 * @param {readonly { id: string, message: string }[]} [bank] the bank's examples, when they are to be held apart from the held-out cases too
 * @returns {string[]}
 */
export function splitIssues(cases, split, bank = []) {
  /** @type {string[]} */
  const issues = [];
  const ids = new Set(cases.map((item) => item.id));
  const train = split?.train ?? [];
  if (!Array.isArray(split?.train) || !train.length) issues.push("train names no case");
  if (new Set(train).size !== train.length) issues.push("train repeats a case");
  for (const id of train) if (!ids.has(id)) issues.push(`train names ${id}, which is not a case`);
  const trainSet = new Set(train);
  const heldOut = cases.filter((item) => !trainSet.has(item.id));
  if (!heldOut.length) issues.push("no case is held out");
  const same = (/** @type {string} */ text) => String(text).replace(/\s+/g, " ").trim();
  for (const example of bank) {
    if (!trainSet.has(example.id)) issues.push(`bank example ${example.id} is not a train case`);
    const twin = heldOut.find((item) => same(item.message) === same(example.message));
    if (twin) issues.push(`bank example ${example.id} has the words of held-out case ${twin.id}`);
  }
  return issues;
}

/** The knowledge base's embedder as a function of texts, from a key file and the pin in deps-version.json; the key is held in memory. @param {string} keyFile */
async function embedderFrom(keyFile) {
  const { KbEmbedder } = await import(EMBEDDER);
  const pin = JSON.parse(await readFile(path.resolve(here, "../../deps-version.json"), "utf8")).openviking?.embedding ?? {};
  const embedder = new KbEmbedder({ apiKey: (await readFile(keyFile, "utf8")).trim(), model: String(pin.model ?? ""), dimension: Number(pin.dimension ?? 1024), apiBase: String(pin.apiBase ?? ""), timeoutMs: 30_000 });
  return (/** @type {string[]} */ texts) => embedder.embedDocuments(texts);
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
  const split = JSON.parse(await readFile(options.splitFile, "utf8"));
  const issues_ = splitIssues(cases, split);
  if (issues_.length) throw new Error(`the split is malformed:\n  ${issues_.join("\n  ")}`);
  // A case named by id is read whichever part it is in, unless a part was asked for too.
  cases = casesOfSplit(cases, split, options.only && !options.splitGiven ? "all" : options.split);
  if (options.only) cases = cases.filter((/** @type {any} */ item) => options.only.includes(item.id));
  if (options.lang) cases = cases.filter((/** @type {any} */ item) => item.lang === options.lang);
  if (!cases.length) throw new Error("no case selected");

  const { FollowUpJudge, readFollowUp, FOLLOW_UP_JUDGE_INSTRUCTIONS } = await import(MODULE);
  const { createFollowUpExamples } = await import(EXAMPLES);
  const { FOLLOW_UP_EXAMPLES_VERSION } = await import("@evimed/domain/follow-up-examples");
  const { callModelForControlPlane } = await import(GATEWAY);
  const instructions = options.instructionsFile ? (await readFile(options.instructionsFile, "utf8")).trim() : null;
  const embed = options.embedKeyFile ? await embedderFrom(options.embedKeyFile) : null;
  const examples = options.examples ? createFollowUpExamples({ embed, logger: { warn: (/** @type {string} */ message) => process.stderr.write(`${message}\n`) } }) : null;

  const key = process.env.DEEPSEEK_API_KEY?.trim() || (options.keyFile ? (await readFile(options.keyFile, "utf8")).trim() : "");
  if (options.dryRun) {
    /** @type {any} */
    let captured = null;
    const judge = new FollowUpJudge({ deepseekProviderEnabled: true, deepseekApiKey: "dry-run", deepseekModel: options.model }, {
      callModel: async (/** @type {any} */ _context, /** @type {any} */ call) => { captured = call.body; return { choices: [{ message: { content: "" } }] }; },
    });
    const item = cases[0];
    const shown = examples ? (await examples.select(item.message)).examples.reverse() : [];
    await judge.read({ message: item.message, previousRequest: item.previousRequest, methods: [], ...(shown.length ? { examples: shown } : {}) }, { userId: "eval", projectId: "eval", runId: "dry" });
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
  const results = await runCases({ cases, judge, readFollowUp, examples, samples: options.samples, concurrency: options.concurrency });
  const summary = summarize(results);
  write(`${render(summary)}\n`);
  const out = options.out ?? path.join(here, "results", `${new Date().toISOString().slice(0, 10)}-${options.model}${instructions ? "-custom-instructions" : ""}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({
    model: options.model, instructions: instructions ? "file" : "module", split: options.split, bankVersion: options.examples ? FOLLOW_UP_EXAMPLES_VERSION : null,
    examples: options.examples ? (embed ? "embedding" : "ngram") : "none", samples: options.samples, at: new Date().toISOString(), summary, results,
  }, null, 1)}\n`);
  write(`wrote ${out}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => process.exit(code), (error) => { process.stderr.write(`${error?.message ?? error}\n`); process.exit(1); });
}
