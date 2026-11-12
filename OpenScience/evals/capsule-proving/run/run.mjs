#!/usr/bin/env node
// The engine-layer runner of the capsule proving experiment: per case, ingest sessions through the product's memory stack up
// to each checkpoint, snapshot the memory files, ask that checkpoint's questions, and record everything in the run directory
// (contract "Run directory"). Resumable: every finished step has a DONE line in STATUS and is skipped on a rerun.
//
//   node evals/capsule-proving/run/run.mjs --set synthetic-users --split dev --data <dir> --out <run dir> \
//     --engine-url http://127.0.0.1:19330 --engine-key-file <file> --database-url-file <file> --deepseek-key-file <file> \
//     [--arm product|no-memory|keyword] [--only U01,U02] [--max-sessions N] [--concurrency N] [--no-history-search] \
//     [--commit-every session|turn] [--plant-corruptions-after <afterSession>] [--limit-questions N] [--plugin-tgz <file>] \
//     [--ingest-only] [--snapshot-checkpoints] [--templates-dir <dir>] [--max-rounds N] [--extraction-timeout-ms N] [--gateway-timeout-ms N] [--engine-timeout-ms N]
//     [--config key=value] [--answer-variant name:key=value,...] [--maintain none|consolidate|verify|consolidate+verify]
//     [--live-turns forget] [--question-category CATEGORY]
//     [--answers-only] [--variants-only] [--retrieval-only] [--answer-model ID] [--answer-base URL] [--answer-key-file FILE]
//     [--maintain-after n[,n...]|each] [--no-rejection-judge] [--label text] [--stock-engine] [--database-pool-max N]
//
// `--engine-url` accepts an ordered comma-separated shard list; `each` maintains at every existing checkpoint.
// Arms `no-memory` and `keyword` never touch the engine. Step keys: `<caseId>/ingest/<sessionId>`, `<caseId>/plant/<n>`,
// `<caseId>/snapshot/<n>`, `<caseId>/answer/<qid>`. Questions of a checkpoint are asked only while memory is exactly at that
// checkpoint; one left unanswered by an earlier run whose ingestion has since moved on is recorded as FAIL `stale_checkpoint`.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, isDeepStrictEqual } from "node:util";

import { bloatMetrics } from "./bloat.mjs";
import { checkRestored } from "./corruptions.mjs";
import { loadCases } from "./cases.mjs";
import { answerOptions, gatewayOptions } from "./answerVariants.mjs";
import { firstLine } from "./lab.mjs";
import { ingestLiveSession } from "./liveTurns.mjs";
import { openStatus } from "./status.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const ARMS = new Set(["product", "no-memory", "keyword"]);
const run = promisify(execFile);

/** JSON values when possible, otherwise literal strings. Split only on the first equals sign.
 * @param {string} text
 */
export function configEntry(text) {
  const at = text.indexOf("=");
  if (at < 1 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(text.slice(0, at))) throw new Error("config needs key=value");
  let value = text.slice(at + 1);
  try { value = JSON.parse(value); } catch { /* literal string */ }
  return [text.slice(0, at), value];
}

/** Split variant assignments without splitting commas inside JSON strings, arrays or objects. @param {string} text */
function configEntries(text) {
  const entries = []; let start = 0; let depth = 0; let quoted = false; let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) { entries.push(text.slice(start, i)); start = i + 1; }
  }
  entries.push(text.slice(start));
  return Object.fromEntries(entries.map(configEntry));
}

/** Ordered, normalized shard identities; never accept credentials in recorded engine URLs. @param {string} value */
export function engineUrlsOf(value) {
  if (!value) return [];
  return value.split(",").map((part) => {
    const url = new URL(part.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("engine URL must be HTTP(S) without credentials, query or fragment");
    return url.href.replace(/\/$/, "");
  });
}

/** Stable across processes and case ordering. @param {string} userKey @param {number} count */
export function engineShard(userKey, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error("at least one engine is required");
  return createHash("sha256").update(String(userKey)).digest().readUInt32BE(0) % count;
}

/** Older run directories stored one engine.url and no list. @param {any} previous @param {any} facts */
export function assertResumeCompatible(previous, facts) {
  if (!previous) return;
  if (previous.arm !== facts.arm || previous.set !== facts.set || previous.split !== facts.split) throw new Error(`the run directory holds a ${previous.set}/${previous.split} ${previous.arm} run: use another --out`);
  // An answers-only pass cannot ingest, so live turns and the question filter no longer shape memory: it may ask the questions a
  // live-turn run left out of the memory that run finished (only final-checkpoint questions; earlier ones are recorded stale).
  const answersOnly = Boolean(facts.options?.answersOnly ?? facts.answersOnly);
  if (!answersOnly && (previous.options?.liveTurns ?? "") !== (facts.options?.liveTurns ?? facts.liveTurns ?? "")) throw new Error("cannot resume with different live turns");
  if (!answersOnly && (previous.options?.questionCategory ?? "") !== (facts.options?.questionCategory ?? facts.questionCategory ?? "")) throw new Error("cannot resume with different question category");
  if ((previous.engine?.templates === "stock") !== Boolean(facts.stockEngine)) throw new Error("cannot resume with different engine templates");
  const urls = (record) => record.engine?.urls ?? record.engineUrls ?? (record.engine?.url ? engineUrlsOf(record.engine.url) : []);
  if (JSON.stringify(urls(previous)) !== JSON.stringify(urls(facts))) throw new Error("cannot resume with a different engine URL list (including order)");
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = {
    answerModel: "", answerBase: "", answerKeyFile: "", stockEngine: false, answersOnly: false, retrievalOnly: false, variantsOnly: false,
    set: "", split: "", data: "", out: "", engineUrl: "", engineKeyFile: "", databaseUrlFile: "", deepseekKeyFile: "",
    arm: "product", only: "", maxSessions: 0, concurrency: 3, databasePoolMax: 2, historySearch: true, commitEvery: "session", plantCorruptionsAfter: -1,
    config: {}, answerVariants: [], maintain: "none", maintainAfter: [], rejectionJudge: true, label: "", thinking: "enabled", reasoningEffort: "high",
    liveTurns: "", questionCategory: "", limitQuestions: 0, pluginTgz: "", ingestOnly: false, snapshotCheckpoints: false, templatesDir: "", maxRounds: 8, extractionTimeoutMs: 300_000, gatewayTimeoutMs: 4_000, engineTimeoutMs: 30_000,
  };
  /** @type {Record<string, [keyof typeof options, "string" | "int"]>} */
  const valued = {
    "--live-turns": ["liveTurns", "string"], "--question-category": ["questionCategory", "string"],
    "--answer-model": ["answerModel", "string"], "--answer-base": ["answerBase", "string"], "--answer-key-file": ["answerKeyFile", "string"],
    "--set": ["set", "string"], "--split": ["split", "string"], "--data": ["data", "string"], "--out": ["out", "string"],
    "--engine-url": ["engineUrl", "string"], "--engine-key-file": ["engineKeyFile", "string"], "--database-url-file": ["databaseUrlFile", "string"],
    "--deepseek-key-file": ["deepseekKeyFile", "string"], "--arm": ["arm", "string"], "--only": ["only", "string"],
    "--database-pool-max": ["databasePoolMax", "int"], "--max-sessions": ["maxSessions", "int"], "--concurrency": ["concurrency", "int"], "--commit-every": ["commitEvery", "string"],
    "--plant-corruptions-after": ["plantCorruptionsAfter", "int"], "--limit-questions": ["limitQuestions", "int"], "--plugin-tgz": ["pluginTgz", "string"],
    "--templates-dir": ["templatesDir", "string"], "--max-rounds": ["maxRounds", "int"], "--extraction-timeout-ms": ["extractionTimeoutMs", "int"],
    "--gateway-timeout-ms": ["gatewayTimeoutMs", "int"], "--engine-timeout-ms": ["engineTimeoutMs", "int"], "--maintain": ["maintain", "string"], "--label": ["label", "string"], "--thinking": ["thinking", "string"], "--reasoning-effort": ["reasoningEffort", "string"],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--stock-engine") { options.stockEngine = true; continue; }
    if (flag === "--answers-only") { options.answersOnly = true; continue; }
    if (flag === "--variants-only") { options.variantsOnly = true; continue; }
    if (flag === "--retrieval-only") { options.retrievalOnly = true; options.answersOnly = true; continue; }
    if (flag === "--no-history-search") { options.historySearch = false; continue; }
    if (flag === "--no-rejection-judge") { options.rejectionJudge = false; continue; }
    if (["--config", "--answer-variant", "--maintain-after"].includes(flag)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      if (flag === "--config") Object.assign(options.config, Object.fromEntries([configEntry(value)]));
      else if (flag === "--answer-variant") {
        const at = value.indexOf(":"); const name = value.slice(0, at);
        if (at < 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || options.answerVariants.some((entry) => entry.name === name)) throw new Error("answer variant needs a unique safe name:k=v");
        options.answerVariants.push({ name, config: configEntries(value.slice(at + 1)) });
      } else {
        if (value !== "each" && !/^\d+(,\d+)*$/.test(value)) throw new Error("--maintain-after is n[,n...] or each");
        options.maintainAfter = value === "each" ? "each" : [...new Set(value.split(",").map(Number))];
        if (Array.isArray(options.maintainAfter) && options.maintainAfter.some((n) => !Number.isSafeInteger(n))) throw new Error("--maintain-after needs safe whole numbers");
      }
      continue;
    }
    if (flag === "--snapshot-checkpoints") { options.snapshotCheckpoints = true; continue; }
    if (flag === "--ingest-only") { options.ingestOnly = true; continue; }
    const spec = valued[flag];
    if (!spec) throw new Error(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    index += 1;
    if (spec[1] === "int") {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${flag} is a whole number`);
      /** @type {any} */ (options)[spec[0]] = number;
    } else /** @type {any} */ (options)[spec[0]] = value;
  }
  for (const [flag, field] of [["--set", "set"], ["--split", "split"], ["--data", "data"], ["--out", "out"]]) {
    if (!/** @type {any} */ (options)[field]) throw new Error(`${flag} is required`);
  }
  if (options.liveTurns && options.liveTurns !== "forget") throw new Error("--live-turns is forget");
  if (options.liveTurns && (options.arm !== "product" || options.stockEngine || options.answersOnly || options.ingestOnly)) throw new Error("--live-turns needs product replay with model answers");
  if (options.questionCategory && options.set !== "synthetic-users") throw new Error("--question-category needs synthetic-users structural categories");
  if (!ARMS.has(options.arm)) throw new Error("--arm is product, no-memory or keyword");
  if (!["session", "turn"].includes(options.commitEvery)) throw new Error("--commit-every is session or turn");
  if (options.databasePoolMax < 1 || options.databasePoolMax > 8) throw new Error("--database-pool-max is 1 to 8 per engine");
  if (options.concurrency < 1 || options.concurrency > 16) throw new Error("--concurrency is 1 to 16");
  if (options.maxRounds < 1 || options.maxRounds > 32) throw new Error("--max-rounds is 1 to 32");
  if (options.engineTimeoutMs < 1) throw new Error("--engine-timeout-ms must be positive");
  if (options.arm === "product" && (!options.engineUrl || !options.engineKeyFile || !options.databaseUrlFile)) {
    throw new Error("arm product needs --engine-url, --engine-key-file and --database-url-file");
  }
  if (!options.ingestOnly && !options.retrievalOnly && !options.deepseekKeyFile && !options.answerKeyFile) throw new Error("answering needs --deepseek-key-file (or pass --ingest-only)");
  if (options.stockEngine && options.arm !== "product") throw new Error("--stock-engine needs arm product");
  if (options.arm !== "product" && options.plantCorruptionsAfter >= 0) throw new Error("--plant-corruptions-after needs arm product");
  if (options.arm !== "product" && options.ingestOnly) throw new Error("--ingest-only has nothing to do without the engine (arm product)");
  if (!["none", "consolidate", "verify", "consolidate+verify"].includes(options.maintain)) throw new Error("--maintain is none, consolidate, verify or consolidate+verify");
  if (options.maintain !== "none" && options.maintainAfter.length === 0) throw new Error("--maintain needs --maintain-after");
  if (options.arm !== "product" && (options.maintain !== "none" || options.answerVariants.some(variant => Object.keys(gatewayOptions(variant.config)).length))) throw new Error("gateway variants and maintenance need arm product");
  answerOptions({ ...options.config, ...(options.answerModel ? { answerModel: options.answerModel } : {}), ...(options.answerBase ? { answerBase: options.answerBase } : {}) });
  for (const variant of options.answerVariants) answerOptions({ ...options.config, ...variant.config });
  if (options.retrievalOnly && (options.set !== "longmemeval-s" || options.split !== "dev")) throw new Error("retrieval diagnosis requires longmemeval-s dev");
  if (options.answersOnly && (options.ingestOnly || options.maintain !== "none" || options.plantCorruptionsAfter >= 0)) throw new Error("answers-only cannot ingest or maintain");
  if (options.variantsOnly && !options.answerVariants.length) throw new Error("variants-only needs an answer variant");
  options.engineUrls = engineUrlsOf(options.engineUrl);
  if (new Set(options.engineUrls).size !== options.engineUrls.length) throw new Error("engine URLs must be distinct");
  return options;
}

/** The run id: the run directory's name, held to the engine's alphabet. @param {string} out */
export function runIdOf(out) {
  const name = path.basename(path.resolve(out));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error("the run directory's name is the run id: 1-64 of [A-Za-z0-9_-]");
  return name;
}

/**
 * The checkpoints a case walks: its questions' `afterSession` values within the sessions taken, the last session taken (so
 * every run ends with a snapshot), and the planting point when there is one.
 * @param {{ afterSession: number }[]} questions @param {number} sessionCount @param {number} [plantAfter]
 */
export function checkpointsFor(questions, sessionCount, plantAfter = -1) {
  const points = new Set(questions.map((question) => question.afterSession).filter((n) => n <= sessionCount));
  points.add(sessionCount);
  if (plantAfter >= 0 && plantAfter <= sessionCount) points.add(plantAfter);
  return [...points].sort((a, b) => a - b);
}

/** sha256 over every file of a directory (sorted by name): name and content digest per line. @param {string} directory */
export async function directoryDigest(directory) {
  const names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const hash = createHash("sha256");
  for (const name of names) hash.update(`${name}\u0000${createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex")}\n`);
  return { digest: hash.digest("hex"), files: names.length };
}

/** Write a file whole (temporary file, then rename). @param {string} file @param {string} text */
async function writeAtomic(file, text) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Replace the row with this key in a JSONL file (or add it), whole-file atomically: a step that is run again after a crash
 * between its row and its DONE line leaves one row, not two.
 * @param {string} file @param {string} keyField @param {Record<string, any>} row
 */
export async function upsertJsonl(file, keyField, row) {
  let lines = [];
  try { lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim()); }
  catch (error) { if (/** @type {any} */ (error)?.code !== "ENOENT") throw error; }
  const kept = lines.filter((line) => { try { return JSON.parse(line)?.[keyField] !== row[keyField]; } catch { return true; } });
  kept.push(JSON.stringify(row));
  await writeAtomic(file, `${kept.join("\n")}\n`);
}

/** @param {string} file */
async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (/** @type {any} */ (error)?.code === "ENOENT") return null; throw error; }
}

/** @param {string} file */
async function readJsonl(file) {
  try { return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

async function gitFacts() {
  try {
    const commit = (await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
    const changed = (await run("git", ["status", "--porcelain", "--", "."], { cwd: repoRoot })).stdout.split("\n").filter(Boolean);
    return { commit, dirty: changed.length > 0, dirtyPaths: changed.length };
  } catch {
    return { commit: null, dirty: null, dirtyPaths: null };
  }
}

/** A short number for a summary line. @param {number} value */
const kilo = (value) => (value >= 10_000 ? `${(value / 1000).toFixed(0)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));

/**
 * Run a list of tasks with at most `limit` at once, in order of start.
 * @template T @param {T[]} items @param {number} limit @param {(item: T) => Promise<void>} work
 */
async function pool(items, limit, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const item = items[next]; next += 1; await work(item); }
  }));
}

/** Run the CLI; dependencies allow offline engine/model fixtures. @param {string[]} [argv] @param {any} [dependencies] */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  const out = path.resolve(options.out);
  const runId = runIdOf(out);
  await mkdir(path.join(out, "cases"), { recursive: true, mode: 0o700 });
  const status = await openStatus(path.join(out, "STATUS"));
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();

  const cases = await (dependencies.loadCases ?? loadCases)({ set: options.set, split: options.split, dataDir: options.data, only: options.only || null });
  if (options.liveTurns && cases.some(item => item.meta?.unlocatedLiveTurns)) throw new Error("forget_message_index_missing: annotate schedule messageIndex before live replay");
  if (!cases.length) throw new Error("no cases to run");

  // The answering side (lane B), only when questions are asked: an ingest-only run needs none of it.
  /** @type {any} */ let answering = null;
  /** @type {any} */ let baselines = null;
  /** @type {any} */ let client = null;
  const clients = new Map();
  const baseAnswer = { ...answerOptions(options.config), ...(options.answerModel ? { answerModel: options.answerModel } : {}), ...(options.answerBase ? { answerBase: options.answerBase } : {}), ...(options.answerKeyFile ? { answerKeyFile: options.answerKeyFile } : {}) };
  if (!options.ingestOnly && !options.retrievalOnly) {
    if (options.pluginTgz) process.env.CAPSULE_PROVING_PLUGIN_TGZ = path.resolve(options.pluginTgz);
    if (options.arm === "product" && !process.env.CAPSULE_PROVING_PLUGIN_TGZ) throw new Error("arm product answers with the plugin's profile block: pass --plugin-tgz");
    answering = dependencies.answering ?? await import(pathToFileURL(path.join(here, "answerer.mjs")).href);
    if (options.arm === "keyword") baselines = await import(pathToFileURL(path.join(here, "baselines.mjs")).href);
    const { createDeepSeekClient, createOpenAICompatibleClient } = await import(pathToFileURL(path.join(here, "deepseek.mjs")).href);
    const makeClient = (selected) => {
      const qwen = /^qwen/.test(selected.answerModel ?? "");
      return (qwen ? createOpenAICompatibleClient : createDeepSeekClient)({
        keyFile: selected.answerKeyFile ?? (qwen ? "/srv/evimed/secrets/dashscope.api-key" : path.resolve(options.deepseekKeyFile)),
        model: selected.answerModel ?? "deepseek-flash",
        // Production's default for a conversation is thinking on at effort "high" (OPEN_SCIENCE_DEEPSEEK_REASONING_EFFORT); runs before 2026-11-10 10:30Z answered with thinking off.
        thinking: selected.thinking ?? options.thinking, reasoningEffort: selected.reasoningEffort ?? options.reasoningEffort,
        baseURL: selected.answerBase ?? (qwen ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "https://api.deepseek.com"),
        timeoutMs: 300_000,
      });
    };
    client = dependencies.client ?? makeClient(baseAnswer);
    for (const variant of options.answerVariants) clients.set(variant.name, dependencies.clients?.[variant.name] ?? (dependencies.client && !variant.config.answerModel && !variant.config.thinking ? dependencies.client : makeClient({ ...baseAnswer, ...answerOptions(variant.config) })));
  }

  const retrievalRows = [];
  let retrieval = null, diagnosticGold = null;
  if (options.retrievalOnly) {
    retrieval = await import("./retrieval.mjs");
    const { loadGold } = await import("./score.mjs");
    diagnosticGold = new Map((await (dependencies.loadGold ?? loadGold)(options.data, options)).map(entry => [entry.caseId, entry]));
  }
  const previous = await readJson(path.join(out, "run.json"));
  for (const variant of options.answerVariants) {
    const held = previous?.answerVariants?.find(v => v.name === variant.name);
    if (held && !isDeepStrictEqual(held.config, variant.config)) throw new Error(`answer variant ${variant.name} changed: use another name`);
  }
  assertResumeCompatible(previous, { ...options, engine: options.arm === "product" ? { urls: options.engineUrls } : null });
  /** @type {any[]} */ const labs = [];
  /** @type {any} */ let lab = null;
  const templatesDir = path.resolve(options.templatesDir || path.join(repoRoot, "deploy/web/openviking/memory-templates"));
  const templates = options.stockEngine ? { digest: null, files: 0 } : await directoryDigest(templatesDir).catch(() => ({ digest: null, files: 0 }));
  if (options.arm === "product") {
    const { openLab } = await import(pathToFileURL(path.join(here, "lab.mjs")).href);
    try {
      for (const engineUrl of options.engineUrls) {
        // Concurrent lab initializers may race on PostgreSQL DDL. Retry only the explicit deadlock code.
        for (let attempt = 0; ; attempt++) {
          try {
            labs.push(await (dependencies.openLab ?? openLab)({
              databasePoolMax: options.databasePoolMax, stockEngine: options.stockEngine, engineUrl, engineKeyFile: path.resolve(options.engineKeyFile), account: `evlab-${runId}`, runId,
              databaseUrlFile: path.resolve(options.databaseUrlFile), historySearch: options.historySearch,
              deepseekKeyFile: options.deepseekKeyFile ? path.resolve(options.deepseekKeyFile) : null, commitEvery: options.commitEvery,
              extractionTimeoutMs: options.extractionTimeoutMs, gatewayTimeoutMs: options.gatewayTimeoutMs, engineTimeoutMs: options.engineTimeoutMs,
              configOverrides: gatewayOptions(options.config), answerVariants: options.answerVariants.map(v => ({ ...v, config: gatewayOptions(v.config) })), rejectionJudge: options.rejectionJudge,
            }));
            break;
          } catch (error) {
            if (attempt >= 4 || !(error?.code === "40P01" || /40P01|deadlock detected/.test(String(error?.message)))) throw error;
            await new Promise(resolve => setTimeout(resolve, 2_000 * (attempt + 1)));
          }
        }
      }
    } catch (error) { await Promise.all(labs.map((entry) => entry.close())); throw error; }
    lab = labs[0];
  }
  const scrub = (/** @type {unknown} */ text) => (lab ? lab.redact(text) : String(text ?? ""));
  const errorLine = (/** @type {unknown} */ error) => (lab ? lab.errorLine(error) : firstLine(error));

  const runFile = path.join(out, "run.json");
  const git = await gitFacts();
  const runnerFiles = (await readdir(here)).filter((name) => name.endsWith(".mjs")).sort();
  const runnerHash = createHash("sha256");
  for (const name of runnerFiles) runnerHash.update(`${name}\u0000${createHash("sha256").update(await readFile(path.join(here, name))).digest("hex")}\n`);
  const facts = {
    runId, set: options.set, split: options.split, arm: options.arm, automated: true,
    commit: git.commit, dirty: git.dirty, dirtyPaths: git.dirtyPaths, runnerDigest: runnerHash.digest("hex"),
    engine: lab ? { templates: options.stockEngine ? "stock" : "product", url: options.engineUrls[0], urls: options.engineUrls, version: lab.facts.engineVersion, account: lab.account, templatesDigest: templates.digest, templatesFiles: templates.files,
      templatesDir: options.stockEngine ? null : path.relative(repoRoot, templatesDir) || templatesDir,
      shards: labs.map((entry, index) => ({ url: options.engineUrls[index], account: entry.account, version: entry.facts.engineVersion })) } : null,
    flags: { liveTurns: options.liveTurns, questionCategory: options.questionCategory, historySearch: options.arm === "product" ? options.historySearch : false, commitEvery: options.commitEvery, plantCorruptionsAfter: options.plantCorruptionsAfter >= 0 ? options.plantCorruptionsAfter : null,
      consolidation: "manual-only", rejectionJudge: Boolean(lab?.config.nativeMemoryRejectionJudgeEnabled), gatewayCommitsPerHour: 0,
      gatewayTimeoutMs: options.gatewayTimeoutMs, engineTimeoutMs: options.engineTimeoutMs, capsuleSearch: false, config: options.config, maintain: options.maintain, maintainAfter: options.maintainAfter },
    answerVariants: options.answerVariants.map((variant) => ({ ...variant, model: { answer: clients.get(variant.name)?.model ?? null, thinking: clients.get(variant.name)?.thinking ?? null, answerJudgeSameFamily: /^qwen/.test(clients.get(variant.name)?.model ?? "") }, flags: { config: { ...options.config, ...variant.config } } })), label: options.label,
    answerOptions: baseAnswer,
    model: { answer: client?.model ?? null, thinking: client?.thinking ?? null, extraction: options.arm === "product" ? "deepseek-flash (lab engine ov.conf, provider direct)" : null },
    options: { liveTurns: options.liveTurns, questionCategory: options.questionCategory, only: options.only || null, maxSessions: options.maxSessions || null, concurrency: options.concurrency, databasePoolMax: options.databasePoolMax, limitQuestions: options.limitQuestions || null,
      ingestOnly: options.ingestOnly, snapshotCheckpoints: options.snapshotCheckpoints, answersOnly: options.answersOnly, retrievalOnly: options.retrievalOnly, maxRounds: options.maxRounds, extractionTimeoutMs: options.extractionTimeoutMs, engineTimeoutMs: options.engineTimeoutMs, dataDir: path.resolve(options.data) },
    cases: cases.map((item) => item.caseId),
  };
  const runJson = previous ? { ...previous,
    engine: previous.engine ? { ...previous.engine, urls: options.engineUrls, shards: facts.engine.shards } : null,
    flags: { ...previous.flags, config: facts.flags.config, maintain: facts.flags.maintain, maintainAfter: facts.flags.maintainAfter, rejectionJudge: facts.flags.rejectionJudge, engineTimeoutMs: facts.flags.engineTimeoutMs },
    answerVariants: [...(previous.answerVariants ?? []).filter(old => !facts.answerVariants.some(v => v.name === old.name)), ...facts.answerVariants], label: options.label || previous.label || "",
    resumes: [...(previous.resumes ?? []), { at: startedAt, commit: git.commit, dirty: git.dirty, runnerDigest: facts.runnerDigest, options: facts.options, answerOptions: facts.answerOptions, model: facts.model, flags: facts.flags, answerVariants: facts.answerVariants, label: facts.label }] }
    : { runId, startedAt, ...facts, resumes: [] };
  await writeAtomic(runFile, `${JSON.stringify(runJson, null, 2)}\n`);

  const totals = { sessions: 0, skipped: 0, failures: 0, extraction: { prompt: 0, completion: 0 }, answers: 0, answerErrors: 0, answer: { prompt: 0, completion: 0 } };
  /** @param {any} item */
  const runCase = async (item) => {
    const lab = labs.length ? labs[engineShard(item.userKey, labs.length)] : null;
    const caseStart = Date.now();
    const stats = { sessions: 0, skipped: 0, failures: 0, extraction: { prompt: 0, completion: 0 }, answers: 0, answerErrors: 0, answer: { prompt: 0, completion: 0 }, stopped: "" };
    const caseDir = path.join(out, "cases", item.caseId);
    await mkdir(path.join(caseDir, "snapshots"), { recursive: true, mode: 0o700 });
    const sessions = options.maxSessions ? item.sessions.slice(0, options.maxSessions) : item.sessions;
    let questions = options.ingestOnly ? [] : item.questions.filter((question) => question.afterSession <= sessions.length);
    if (options.questionCategory) questions = questions.filter(question => question.category === options.questionCategory);
    if (options.limitQuestions) questions = questions.slice(0, options.limitQuestions);
    const plantAfter = options.plantCorruptionsAfter;
    const checkpoints = [...new Set([...checkpointsFor(options.snapshotCheckpoints ? item.questions : questions, sessions.length, plantAfter),
      ...(options.maintain !== "none" && Array.isArray(options.maintainAfter) ? options.maintainAfter.filter((n) => n <= sessions.length) : [])])].sort((a, b) => a - b);
    const bloat = async (current = null) => {
      const names = (await readdir(path.join(caseDir, "snapshots"))).filter((name) => /^\d+\.json$/.test(name)).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]));
      let snapshots = await Promise.all(names.map((name) => readJson(path.join(caseDir, "snapshots", name))));
      if (current) snapshots = [...snapshots.filter((snap) => snap.afterSession < current.afterSession), current];
      const rows = await readJsonl(path.join(caseDir, "ingest.jsonl"));
      const through = current?.afterSession ?? sessions.length;
      const ids = new Set(sessions.slice(0, through).map((session) => session.sessionId));
      return bloatMetrics({ snapshots, ingestRows: rows.filter((row) => ids.has(row.sessionId)) });
    };
    const ingestKey = (/** @type {any} */ session) => `${item.caseId}/ingest/${session.sessionId}`;
    const fail = async (/** @type {string} */ key, /** @type {string} */ why) => { stats.failures += 1; await status.markFailed(key, scrub(why)); process.stdout.write(`${item.caseId} FAIL ${key} ${scrub(why)}\n`); };
    try {
      const user = lab ? await lab.user(item.userKey) : null;
      // How far an earlier run got: the leading run of ingested sessions (they are noted for raw-history titles).
      let ingested = 0;
      if (lab) {
        while (ingested < sessions.length && status.isDone(ingestKey(sessions[ingested]))) { lab.noteConversation(user, sessions[ingested]); ingested += 1; }
        const ahead = sessions.slice(ingested).filter((session) => status.isDone(ingestKey(session)));
        if (ahead.length) throw new Error(`STATUS records sessions done past the first one not done (${ahead[0].sessionId}): ingestion order is broken`);
      }
      if (lab && options.answersOnly && ingested !== sessions.length) throw new Error("answers_only_incomplete_ingestion: refusing to ingest");
      const resumedAt = ingested;
      stats.skipped = ingested;
      /** @type {Map<string, any>} */
      const memories = new Map();
      for (const checkpoint of checkpoints) {
        let checkpointChanged = false;
        if (lab) {
          for (; ingested < checkpoint; ingested += 1) {
            const session = sessions[ingested];
            const key = ingestKey(session);
            let row;
            try {
              if (options.liveTurns) {
                const file = path.join(caseDir, "live-turns.jsonl");
                const records = await readJsonl(file);
                row = await ingestLiveSession({ lab, user, session, caseId: item.caseId, records,
                  persist: async entry => {
                    await upsertJsonl(file, "turnId", entry);
                    const held = records.findIndex(record => record.turnId === entry.turnId);
                    if (held < 0) records.push(entry); else records[held] = entry;
                  },
                  answer: input => answering.answerQuestion({ ...baseAnswer, client, maxRounds: options.maxRounds, ...input }),
                  onUsage: record => {
                    stats.answer.prompt += Number(record.usage?.promptTokens) || 0;
                    stats.answer.completion += Number(record.usage?.completionTokens) || 0;
                  },
                });
              } else row = await lab.ingestSession(user, session);
            }
            catch (error) {
              await fail(key, errorLine(error));
              stats.stopped = `ingest of ${session.sessionId} failed`;
              return stats;
            }
            await upsertJsonl(path.join(caseDir, "ingest.jsonl"), "sessionId", row);
            stats.sessions += 1;
            stats.extraction.prompt += row.usage.promptTokens; stats.extraction.completion += row.usage.completionTokens;
            const ops = `+${row.operations.adds}~${row.operations.updates}-${row.operations.deletes}`;
            const line = `commit=${row.commit.status} ops=${ops} obs=${row.observations} tok=${row.usage.promptTokens}/${row.usage.completionTokens} history=${row.history?.state ?? "none"} ms=${row.ms}`;
            await status.markDone(key, line);
            process.stdout.write(`${item.caseId} ${session.sessionId} ${line}\n`);
          }
          if (checkpoint === plantAfter) {
            const key = `${item.caseId}/plant/${checkpoint}`;
            if (!status.isDone(key)) {
              if (resumedAt > checkpoint) await fail(key, "stale_checkpoint: ingestion has moved past the planting point");
              else {
                try {
                  const file = item.meta?.corruptionsFile ?? path.join(path.resolve(options.data), options.split, item.userKey, "corruptions.json");
                  const list = (await readJson(file))?.corruptions;
                  if (!Array.isArray(list)) throw new Error("no corruptions list for this case");
                  const { applyCorruptions } = await import(pathToFileURL(path.join(here, "corruptions.mjs")).href);
                  const before = await lab.snapshot(user);
                  const planted = applyCorruptions(before.files, list);
                  const changed = Object.keys(planted.files).filter((rel) => planted.files[rel] !== before.files[rel]);
                  for (const rel of changed) await lab.replaceFile(user, rel, planted.files[rel]);
                  checkpointChanged = changed.length > 0;
                  await writeAtomic(path.join(caseDir, "corruptions-applied.json"), `${JSON.stringify({ afterSession: checkpoint, at: new Date().toISOString(), files: changed, applied: planted.applied, skipped: planted.skipped }, null, 2)}\n`);
                  await status.markDone(key, `applied=${planted.applied.length} skipped=${planted.skipped.length} files=${changed.length}`);
                } catch (error) { await fail(key, errorLine(error)); }
              }
            }
          }
          const maintainHere = options.maintain !== "none" && (options.maintainAfter === "each" || options.maintainAfter.includes(checkpoint));
          if (maintainHere) {
            for (const kind of options.maintain.split("+")) {
              const key = `${item.caseId}/maintain.${kind}/${checkpoint}`;
              if (status.isDone(key)) continue;
              if (resumedAt > checkpoint) { await fail(key, "stale_checkpoint: ingestion has moved past maintenance"); continue; }
              checkpointChanged = true;
              const started = Date.now(); const startedAt = new Date(started).toISOString();
              let before = null; let result; let error = ""; let filesChanged = [];
              try {
                before = await lab.snapshot(user);
                result = kind === "consolidate" ? await lab.consolidate(user, { mode: options.config.nativeMemoryConsolidationMode ?? "merge" }) : await lab.verifyExisting(user, { limit: 200, mode: "verify" });
                if (["failed", "lost", "submitted"].includes(result?.outcome)) throw new Error(`maintenance_${result.outcome}`);
              } catch (caught) { error = errorLine(caught); result = { ...(result ?? {}), error }; }
              try {
                const after = await lab.snapshot(user);
                if (before) filesChanged = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter((rel) => before.files[rel] !== after.files[rel]).sort();
              } catch (caught) { error ||= errorLine(caught); result = { ...(result ?? {}), error }; }
              await appendFile(path.join(caseDir, "maintenance.jsonl"), `${JSON.stringify({ afterSession: checkpoint, kind, startedAt, ms: Date.now() - started, result, filesChanged })}\n`, { mode: 0o600 });
              if (error) await fail(key, error);
              else await status.markDone(key, `files=${filesChanged.length} ms=${Date.now() - started}`);
            }
          }
          if (resumedAt <= checkpoint && plantAfter >= 0 && checkpoint >= plantAfter && status.isDone(`${item.caseId}/plant/${plantAfter}`)) {
            const planted = await readJson(path.join(caseDir, "corruptions-applied.json"));
            const list = (await readJson(item.meta?.corruptionsFile ?? path.join(path.resolve(options.data), options.split, item.userKey, "corruptions.json")))?.corruptions ?? [];
            const after = await lab.snapshot(user);
            await writeAtomic(path.join(caseDir, "corruptions-restored.json"), `${JSON.stringify({ afterSession: checkpoint, at: new Date().toISOString(), results: checkRestored(after.files, planted.applied, list.filter((entry) => planted.applied.some((applied) => applied.id === entry.id))) }, null, 2)}\n`);
          }
          const snapKey = `${item.caseId}/snapshot/${checkpoint}`;
          if (!options.retrievalOnly && (!status.isDone(snapKey) || checkpointChanged)) {
            if (resumedAt > checkpoint) await fail(snapKey, "stale_checkpoint: ingestion has moved past this checkpoint");
            else {
              let lastError = null;
              for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                  const snapshot = { afterSession: checkpoint, takenAt: new Date().toISOString(), ...await lab.snapshot(user) };
                  snapshot.bloat = await bloat(snapshot);
                  await writeAtomic(path.join(caseDir, "snapshots", `${checkpoint}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
                  await status.markDone(snapKey, `files=${snapshot.metrics.files} chars=${snapshot.metrics.chars}`);
                  lastError = null;
                  break;
                } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 2_000)); }
              }
              if (lastError) await fail(snapKey, errorLine(lastError));
            }
          }
        } else ingested = checkpoint;
        for (const question of questions.filter((entry) => entry.afterSession === checkpoint)) {
          if (options.retrievalOnly) {
            const entry = diagnosticGold.get(item.caseId);
            if (!entry) throw new Error("retrieval_gold_missing");
            const file = path.join(caseDir, options.config.memoryHistoryRetrievalV2Enabled===true ? 'retrieval.v2.json' : 'retrieval.json');
            let row = await readJson(file);
            if (!row || row.qid !== question.qid || row.results.some(r => r.isError)) {
              row = await retrieval.diagnoseQuestion({ entry, item, question, memory: lab.memoryFor(user), lab, user });
              await writeAtomic(file, `${JSON.stringify(row, null, 2)}\n`);
            }
            retrievalRows.push(row);
            await status.markDone(`${item.caseId}/retrieval/${question.qid}`, `limits=8,20`);
            continue;
          }
          for (const variant of [...(options.variantsOnly ? [] : [null]), ...options.answerVariants]) {
            const key = `${item.caseId}/answer${variant ? `.${variant.name}` : ""}/${question.qid}`;
            if (status.isDone(key)) continue;
            if (lab && resumedAt > checkpoint) { await fail(key, "stale_checkpoint: ingestion has moved past this question's checkpoint"); continue; }
            let memory = null;
            if (lab) {
              const projectKey = `${variant?.name ?? ""}\u0000${question.project?.id ?? "default"}`;
              if (!memories.has(projectKey)) memories.set(projectKey, lab.memoryFor(user, { project: question.project ?? null, variant: variant?.name ?? "" }));
              memory = memories.get(projectKey);
            } else if (options.arm === "keyword") memory = baselines.createTranscriptIndex(sessions.slice(0, checkpoint));
            let record;
            const selectedClient = variant ? clients.get(variant.name) : client;
            const selectedOptions = { ...baseAnswer, ...answerOptions(variant?.config ?? {}) };
            try {
              if (Array.isArray(question.probe)) {
                // A probe is a direct tool call, with no model: what the memory surface returns for a query (the secret red line reads it).
                const started = Date.now();
                const toolCalls = [];
                if (memory && lab) for (const call of question.probe) {
                  const at = Date.now();
                  const result = await memory.callTool(call.name, call.args ?? {});
                  toolCalls.push({ round: 0, name: call.name, args: call.args ?? {}, blocks: result.blocks, isError: result.isError, ms: Date.now() - at });
                }
                record = { qid: question.qid, caseId: item.caseId, arm: options.arm, asOf: question.asOf, question: "", answer: "", probe: true,
                  opening: { profileBlock: null, residentBlock: null }, toolCalls, rounds: 0, model: null,
                  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, ms: Date.now() - started };
              } else
              record = await answering.answerQuestion({ question: question.text, asOf: question.asOf, arm: options.arm, memory, materials: question.materials ?? [],
                ...selectedOptions, sessions: sessions.slice(0, checkpoint), client: selectedClient, maxRounds: options.maxRounds, caseId: item.caseId, qid: question.qid, project: question.project ?? null });
            } catch (error) {
              record = { qid: question.qid, caseId: item.caseId, arm: options.arm, asOf: question.asOf, question: question.text, answer: "", opening: { profileBlock: null, residentBlock: null },
                toolCalls: [], rounds: 0, model: client?.model ?? null, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, ms: 0, error: `runner: ${errorLine(error)}` };
            }
            await upsertJsonl(path.join(caseDir, variant ? `answers.${variant.name}.jsonl` : "answers.jsonl"), "qid", record);
            stats.answers += 1;
            stats.answer.prompt += Number(record.usage?.promptTokens) || 0; stats.answer.completion += Number(record.usage?.completionTokens) || 0;
            if (record.error) { stats.answerErrors += 1; await fail(key, String(record.error)); }
            else await status.markDone(key, `rounds=${record.rounds} tools=${record.toolCalls?.length ?? 0} tok=${record.usage?.promptTokens ?? 0}/${record.usage?.completionTokens ?? 0} ms=${record.ms}`);
          }
        }
      }
      if (lab && !options.retrievalOnly) await writeAtomic(path.join(caseDir, "bloat.json"), `${JSON.stringify(await bloat(), null, 2)}\n`);
    } catch (error) {
      stats.failures += 1;
      stats.stopped = errorLine(error);
      await status.markFailed(`${item.caseId}/case`, stats.stopped).catch(() => {});
    } finally {
      const wall = Math.round((Date.now() - caseStart) / 1000);
      process.stdout.write(`${item.caseId} ${options.arm}: sessions ${stats.sessions} (+${stats.skipped} done earlier), extraction ${kilo(stats.extraction.prompt)}/${kilo(stats.extraction.completion)} tok, `
        + `answers ${stats.answers} (${stats.answerErrors} errors) ${kilo(stats.answer.prompt)}/${kilo(stats.answer.completion)} tok, failures ${stats.failures}, wall ${wall}s${stats.stopped ? `, stopped: ${scrub(stats.stopped)}` : ""}\n`);
      totals.sessions += stats.sessions; totals.skipped += stats.skipped; totals.failures += stats.failures;
      totals.extraction.prompt += stats.extraction.prompt; totals.extraction.completion += stats.extraction.completion;
      totals.answers += stats.answers; totals.answerErrors += stats.answerErrors;
      totals.answer.prompt += stats.answer.prompt; totals.answer.completion += stats.answer.completion;
    }
    return stats;
  };

  try {
    // Cases sharing a user share memory and must not ingest/maintain while another case is answering.
    const groups = new Map();
    for (const item of cases) { const group = groups.get(item.userKey) ?? []; group.push(item); groups.set(item.userKey, group); }
    await pool([...groups.values()], options.concurrency, async (group) => { for (const item of group) await runCase(item); });
  } finally {
    if (lab) {
      try {
        const latest = await readJson(runFile);
        if (latest?.engine) {
          latest.engine.templatesMounted = lab.facts.templatesMounted;
          latest.engine.memoryTypes = lab.facts.memoryTypes;
          latest.engine.shards = labs.map((entry, index) => ({ url: options.engineUrls[index], account: entry.account, version: entry.facts.engineVersion, templatesMounted: entry.facts.templatesMounted, memoryTypes: entry.facts.memoryTypes }));
          await writeAtomic(runFile, `${JSON.stringify(latest, null, 2)}\n`);
        }
      } finally { await Promise.all(labs.map((entry) => entry.close().catch(() => {}))); }
    }
  }
  if (!options.ingestOnly && !options.retrievalOnly) {
    const latest = await readJson(runFile);
    latest.answerStats ??= {};
    for (const variant of options.answerVariants) {
      const records = (await Promise.all(cases.map(item => readJsonl(path.join(out, "cases", item.caseId, `answers.${variant.name}.jsonl`))))).flat();
      latest.answerStats[variant.name] = { questions: records.length, errors: records.filter(r => r.error).length,
        truncatedQuestions: records.filter(r => r.fullContext?.truncated).length,
        models: [...new Set(records.map(r => r.model?.resolvedModel ?? r.model?.name).filter(Boolean))] };
    }
    await writeAtomic(runFile, `${JSON.stringify(latest, null, 2)}\n`);
  }
  if (options.retrievalOnly) {
    const report = retrieval.retrievalReport(retrievalRows, { runId, expectedQuestions: cases.reduce((n, c) => n + c.questions.length, 0),
      historyExcerptCap:options.config.memoryHistoryRetrievalV2Enabled===true?20:8 });
    await writeAtomic(path.join(out, options.config.memoryHistoryRetrievalV2Enabled===true ? 'retrieval.v2.json' : 'retrieval.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(retrieval.summaryText(report) + "\n");
  }
  const wall = Math.round((Date.now() - wallStart) / 1000);
  process.stdout.write(`total ${cases.length} case(s): sessions ${totals.sessions} (+${totals.skipped} done earlier), extraction ${kilo(totals.extraction.prompt)}/${kilo(totals.extraction.completion)} tok, `
    + `answers ${totals.answers} (${totals.answerErrors} errors) ${kilo(totals.answer.prompt)}/${kilo(totals.answer.completion)} tok, failures ${totals.failures}, wall ${wall}s\n`);
  return totals;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((totals) => { if (totals.failures) process.exitCode = 1; }).catch((error) => {
    process.stderr.write(`capsule_proving_run_failed: ${firstLine(error)}\n`);
    process.exitCode = 1;
  });
}

