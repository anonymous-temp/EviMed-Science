#!/usr/bin/env node
// The engine-layer runner of the capsule proving experiment: per case, ingest sessions through the product's memory stack up
// to each checkpoint, snapshot the memory files, ask that checkpoint's questions, and record everything in the run directory
// (contract "Run directory"). Resumable: every finished step has a DONE line in STATUS and is skipped on a rerun.
//
//   node evals/capsule-proving/run/run.mjs --set synthetic-users --split dev --data <dir> --out <run dir> \
//     --engine-url http://127.0.0.1:19330 --engine-key-file <file> --database-url-file <file> --deepseek-key-file <file> \
//     [--arm product|no-memory|keyword] [--only U01,U02] [--max-sessions N] [--concurrency N] [--no-history-search] \
//     [--commit-every session|turn] [--plant-corruptions-after <afterSession>] [--limit-questions N] [--plugin-tgz <file>] \
//     [--ingest-only] [--templates-dir <dir>] [--max-rounds N] [--extraction-timeout-ms N] [--gateway-timeout-ms N]
//
// Arms `no-memory` and `keyword` never touch the engine. Step keys: `<caseId>/ingest/<sessionId>`, `<caseId>/plant/<n>`,
// `<caseId>/snapshot/<n>`, `<caseId>/answer/<qid>`. Questions of a checkpoint are asked only while memory is exactly at that
// checkpoint; one left unanswered by an earlier run whose ingestion has since moved on is recorded as FAIL `stale_checkpoint`.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadCases } from "./cases.mjs";
import { firstLine } from "./lab.mjs";
import { openStatus } from "./status.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const ARMS = new Set(["product", "no-memory", "keyword"]);
const run = promisify(execFile);

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = {
    set: "", split: "", data: "", out: "", engineUrl: "", engineKeyFile: "", databaseUrlFile: "", deepseekKeyFile: "",
    arm: "product", only: "", maxSessions: 0, concurrency: 3, historySearch: true, commitEvery: "session", plantCorruptionsAfter: -1,
    limitQuestions: 0, pluginTgz: "", ingestOnly: false, templatesDir: "", maxRounds: 8, extractionTimeoutMs: 300_000, gatewayTimeoutMs: 4_000,
  };
  /** @type {Record<string, [keyof typeof options, "string" | "int"]>} */
  const valued = {
    "--set": ["set", "string"], "--split": ["split", "string"], "--data": ["data", "string"], "--out": ["out", "string"],
    "--engine-url": ["engineUrl", "string"], "--engine-key-file": ["engineKeyFile", "string"], "--database-url-file": ["databaseUrlFile", "string"],
    "--deepseek-key-file": ["deepseekKeyFile", "string"], "--arm": ["arm", "string"], "--only": ["only", "string"],
    "--max-sessions": ["maxSessions", "int"], "--concurrency": ["concurrency", "int"], "--commit-every": ["commitEvery", "string"],
    "--plant-corruptions-after": ["plantCorruptionsAfter", "int"], "--limit-questions": ["limitQuestions", "int"], "--plugin-tgz": ["pluginTgz", "string"],
    "--templates-dir": ["templatesDir", "string"], "--max-rounds": ["maxRounds", "int"], "--extraction-timeout-ms": ["extractionTimeoutMs", "int"],
    "--gateway-timeout-ms": ["gatewayTimeoutMs", "int"],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--no-history-search") { options.historySearch = false; continue; }
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
  if (!ARMS.has(options.arm)) throw new Error("--arm is product, no-memory or keyword");
  if (!["session", "turn"].includes(options.commitEvery)) throw new Error("--commit-every is session or turn");
  if (options.concurrency < 1 || options.concurrency > 16) throw new Error("--concurrency is 1 to 16");
  if (options.maxRounds < 1 || options.maxRounds > 32) throw new Error("--max-rounds is 1 to 32");
  if (options.arm === "product" && (!options.engineUrl || !options.engineKeyFile || !options.databaseUrlFile)) {
    throw new Error("arm product needs --engine-url, --engine-key-file and --database-url-file");
  }
  if (!options.ingestOnly && !options.deepseekKeyFile) throw new Error("answering needs --deepseek-key-file (or pass --ingest-only)");
  if (options.arm !== "product" && options.plantCorruptionsAfter >= 0) throw new Error("--plant-corruptions-after needs arm product");
  if (options.arm !== "product" && options.ingestOnly) throw new Error("--ingest-only has nothing to do without the engine (arm product)");
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const out = path.resolve(options.out);
  const runId = runIdOf(out);
  await mkdir(path.join(out, "cases"), { recursive: true, mode: 0o700 });
  const status = await openStatus(path.join(out, "STATUS"));
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();

  const cases = await loadCases({ set: options.set, split: options.split, dataDir: options.data, only: options.only || null });
  if (!cases.length) throw new Error("no cases to run");

  // The answering side (lane B), only when questions are asked: an ingest-only run needs none of it.
  /** @type {any} */ let answering = null;
  /** @type {any} */ let baselines = null;
  /** @type {any} */ let client = null;
  if (!options.ingestOnly) {
    if (options.pluginTgz) process.env.CAPSULE_PROVING_PLUGIN_TGZ = path.resolve(options.pluginTgz);
    if (options.arm === "product" && !process.env.CAPSULE_PROVING_PLUGIN_TGZ) throw new Error("arm product answers with the plugin's profile block: pass --plugin-tgz");
    answering = await import(pathToFileURL(path.join(here, "answerer.mjs")).href);
    if (options.arm === "keyword") baselines = await import(pathToFileURL(path.join(here, "baselines.mjs")).href);
    const { createDeepSeekClient } = await import(pathToFileURL(path.join(here, "deepseek.mjs")).href);
    client = createDeepSeekClient({ keyFile: path.resolve(options.deepseekKeyFile) });
  }

  /** @type {any} */ let lab = null;
  const templatesDir = path.resolve(options.templatesDir || path.join(repoRoot, "deploy/web/openviking/memory-templates"));
  const templates = await directoryDigest(templatesDir).catch(() => ({ digest: null, files: 0 }));
  if (options.arm === "product") {
    const { openLab } = await import(pathToFileURL(path.join(here, "lab.mjs")).href);
    lab = await openLab({
      engineUrl: options.engineUrl, engineKeyFile: path.resolve(options.engineKeyFile), account: `evlab-${runId}`, runId,
      databaseUrlFile: path.resolve(options.databaseUrlFile), historySearch: options.historySearch,
      deepseekKeyFile: options.deepseekKeyFile ? path.resolve(options.deepseekKeyFile) : null, commitEvery: options.commitEvery,
      extractionTimeoutMs: options.extractionTimeoutMs, gatewayTimeoutMs: options.gatewayTimeoutMs,
    });
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
    engine: lab ? { url: new URL(options.engineUrl).origin, version: lab.facts.engineVersion, account: lab.account, templatesDigest: templates.digest, templatesFiles: templates.files,
      templatesDir: path.relative(repoRoot, templatesDir) || templatesDir } : null,
    flags: { historySearch: options.arm === "product" ? options.historySearch : false, commitEvery: options.commitEvery, plantCorruptionsAfter: options.plantCorruptionsAfter >= 0 ? options.plantCorruptionsAfter : null,
      consolidation: "manual-only", rejectionJudge: Boolean(lab?.config.nativeMemoryRejectionJudgeEnabled), gatewayCommitsPerHour: 0,
      gatewayTimeoutMs: options.gatewayTimeoutMs, capsuleSearch: false },
    model: { answer: client?.model ?? null, thinking: client?.thinking ?? null, extraction: options.arm === "product" ? "deepseek-flash (lab engine ov.conf, provider direct)" : null },
    options: { only: options.only || null, maxSessions: options.maxSessions || null, concurrency: options.concurrency, limitQuestions: options.limitQuestions || null,
      ingestOnly: options.ingestOnly, maxRounds: options.maxRounds, extractionTimeoutMs: options.extractionTimeoutMs, dataDir: path.resolve(options.data) },
    cases: cases.map((item) => item.caseId),
  };
  const previous = await readJson(runFile);
  if (previous && (previous.arm !== facts.arm || previous.set !== facts.set || previous.split !== facts.split)) {
    throw new Error(`the run directory holds a ${previous.set}/${previous.split} ${previous.arm} run: use another --out`);
  }
  const runJson = previous ? { ...previous, resumes: [...(previous.resumes ?? []), { at: startedAt, commit: git.commit, dirty: git.dirty, runnerDigest: facts.runnerDigest, options: facts.options }] }
    : { runId, startedAt, ...facts, resumes: [] };
  await writeAtomic(runFile, `${JSON.stringify(runJson, null, 2)}\n`);

  const totals = { sessions: 0, skipped: 0, failures: 0, extraction: { prompt: 0, completion: 0 }, answers: 0, answerErrors: 0, answer: { prompt: 0, completion: 0 } };
  /** @param {any} item */
  const runCase = async (item) => {
    const caseStart = Date.now();
    const stats = { sessions: 0, skipped: 0, failures: 0, extraction: { prompt: 0, completion: 0 }, answers: 0, answerErrors: 0, answer: { prompt: 0, completion: 0 }, stopped: "" };
    const caseDir = path.join(out, "cases", item.caseId);
    await mkdir(path.join(caseDir, "snapshots"), { recursive: true, mode: 0o700 });
    const sessions = options.maxSessions ? item.sessions.slice(0, options.maxSessions) : item.sessions;
    let questions = options.ingestOnly ? [] : item.questions.filter((question) => question.afterSession <= sessions.length);
    if (options.limitQuestions) questions = questions.slice(0, options.limitQuestions);
    const plantAfter = options.plantCorruptionsAfter;
    const checkpoints = checkpointsFor(questions, sessions.length, plantAfter);
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
      const resumedAt = ingested;
      stats.skipped = ingested;
      /** @type {Map<string, any>} */
      const memories = new Map();
      for (const checkpoint of checkpoints) {
        if (lab) {
          for (; ingested < checkpoint; ingested += 1) {
            const session = sessions[ingested];
            const key = ingestKey(session);
            let row;
            try { row = await lab.ingestSession(user, session); }
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
                  await writeAtomic(path.join(caseDir, "corruptions-applied.json"), `${JSON.stringify({ afterSession: checkpoint, at: new Date().toISOString(), files: changed, applied: planted.applied, skipped: planted.skipped }, null, 2)}\n`);
                  await status.markDone(key, `applied=${planted.applied.length} skipped=${planted.skipped.length} files=${changed.length}`);
                } catch (error) { await fail(key, errorLine(error)); }
              }
            }
          }
          const snapKey = `${item.caseId}/snapshot/${checkpoint}`;
          if (!status.isDone(snapKey)) {
            if (resumedAt > checkpoint) await fail(snapKey, "stale_checkpoint: ingestion has moved past this checkpoint");
            else {
              let lastError = null;
              for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                  const snapshot = await lab.snapshot(user);
                  await writeAtomic(path.join(caseDir, "snapshots", `${checkpoint}.json`), `${JSON.stringify({ afterSession: checkpoint, takenAt: new Date().toISOString(), ...snapshot }, null, 2)}\n`);
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
          const key = `${item.caseId}/answer/${question.qid}`;
          if (status.isDone(key)) continue;
          if (lab && resumedAt > checkpoint) { await fail(key, "stale_checkpoint: ingestion has moved past this question's checkpoint"); continue; }
          let memory = null;
          if (lab) {
            const projectKey = question.project?.id ?? "default";
            if (!memories.has(projectKey)) memories.set(projectKey, lab.memoryFor(user, { project: question.project ?? null }));
            memory = memories.get(projectKey);
          } else if (options.arm === "keyword") memory = baselines.createTranscriptIndex(sessions.slice(0, checkpoint));
          let record;
          try {
            record = await answering.answerQuestion({ question: question.text, asOf: question.asOf, arm: options.arm, memory, materials: question.materials ?? [],
              client, maxRounds: options.maxRounds, caseId: item.caseId, qid: question.qid, project: question.project ?? null });
          } catch (error) {
            record = { qid: question.qid, caseId: item.caseId, arm: options.arm, asOf: question.asOf, question: question.text, answer: "", opening: { profileBlock: null, residentBlock: null },
              toolCalls: [], rounds: 0, model: client?.model ?? null, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, ms: 0, error: `runner: ${errorLine(error)}` };
          }
          await upsertJsonl(path.join(caseDir, "answers.jsonl"), "qid", record);
          stats.answers += 1;
          stats.answer.prompt += Number(record.usage?.promptTokens) || 0; stats.answer.completion += Number(record.usage?.completionTokens) || 0;
          if (record.error) { stats.answerErrors += 1; await fail(key, String(record.error)); }
          else await status.markDone(key, `rounds=${record.rounds} tools=${record.toolCalls?.length ?? 0} tok=${record.usage?.promptTokens ?? 0}/${record.usage?.completionTokens ?? 0} ms=${record.ms}`);
        }
      }
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
    await pool(cases, options.concurrency, async (item) => { await runCase(item); });
  } finally {
    if (lab) {
      const latest = await readJson(runFile);
      if (latest?.engine) {
        latest.engine.templatesMounted = lab.facts.templatesMounted;
        latest.engine.memoryTypes = lab.facts.memoryTypes;
        await writeAtomic(runFile, `${JSON.stringify(latest, null, 2)}\n`);
      }
      await lab.close().catch(() => {});
    }
  }
  const wall = Math.round((Date.now() - wallStart) / 1000);
  process.stdout.write(`total ${cases.length} case(s): sessions ${totals.sessions} (+${totals.skipped} done earlier), extraction ${kilo(totals.extraction.prompt)}/${kilo(totals.extraction.completion)} tok, `
    + `answers ${totals.answers} (${totals.answerErrors} errors) ${kilo(totals.answer.prompt)}/${kilo(totals.answer.completion)} tok, failures ${totals.failures}, wall ${wall}s\n`);
  if (totals.failures) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`capsule_proving_run_failed: ${firstLine(error)}\n`);
    process.exitCode = 1;
  });
}

