#!/usr/bin/env node
/**
 * C1 library builds (plan 2026-11-04 §5.5): the paper's protocol — learn from training tasks, then evaluate — with the product's learning
 * loop (`learn/offlineLoop.mjs`) doing the learning.
 *
 *   node build_library.mjs build  --env alfworld --variant pyramid|from-scratch|add-only --train-dir <run_c1 training out> \
 *        --pool <c1 training pool> --out <dir> [--gate every-success|product] [--sleep-every 10] [--embed-key-file F] [--key-file F] [--dry-run]
 *   node build_library.mjs evolve --env alfworld --dir <a copy of a pyramid variant dir> --episodes <trajectory files in task order...>
 *
 * What a training episode teaches, following the product (no new trigger): a successful episode is a clean run of the environment's
 * scope, and a lesson about it is the product's `routine` induction across it and two earlier clean runs (`routine` reads this run's
 * trajectory digest and its peers'). `--gate every-success` (default) distils every successful episode once two earlier ones exist, with the
 * two nearest by request similarity (tool chains matching first) as its peers; `--gate product` distils only where the product's own
 * routine gate fires (`routineLessonFor`, toolchain switch on: every third clean run whose tool chain and request match). Both counts are
 * recorded either way. A failed episode teaches nothing: the product distils a run nobody corrected only through `routine`, which reads
 * clean runs, and the game's failure is no person's correction.
 *
 * Variants: `pyramid` — lessons see the library, every write is integrated and the library consolidated every `--sleep-every` episodes and
 * at the end, levels with the pyramid switch on; `from-scratch` — the same, but every lesson is shown an empty related pool; `add-only` —
 * lessons see the library, nothing is ever consolidated. The `flat`, `no-atomic` and `no-abstract` arms select from the pyramid library.
 * Every step is resumable (`<dir>/STATUS`, the library saved after each step); model answers are shared through `<out>/cache`.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OfflineLoop, embedderFrom, learningModel, LESSON_GATES } from "../learn/offlineLoop.mjs";

export const VARIANTS = Object.freeze({
  pyramid: { related: "library", consolidate: "integrate+sleep", pyramid: true },
  "from-scratch": { related: "empty", consolidate: "integrate+sleep", pyramid: true },
  "add-only": { related: "library", consolidate: "none", pyramid: true },
});

const GLOBAL_STATUS = process.env.C1_GLOBAL_STATUS ?? "/srv/evimed/runs/c1-STATUS";

/** The trajectory file run_c1.py writes for one episode (`episode_key`). @param {string} out @param {string} env @param {string} fold @param {string} arm @param {string} taskId */
export function trajectoryPath(out, env, fold, arm, taskId) {
  return path.join(out, "trajectories", `${env}-${fold}-${arm}-${createHash("sha256").update(taskId).digest("hex").slice(0, 20)}.json`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) { options._.push(flag); continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[flag.slice(2)] = true;
    else { options[flag.slice(2)] = next; index += 1; }
  }
  return options;
}

/** @param {string} line */
async function globalStatus(line) {
  await appendFile(GLOBAL_STATUS, `${new Date().toISOString()} ${line}\n`).catch(() => {});
}

/**
 * Feed episodes to a loop in order: each success is distilled under the gate, the library consolidated every `sleepEvery` episodes.
 * @param {OfflineLoop} loop @param {any[]} episodes in the order they are learnt from @param {{ gate: string, sleepEvery: number, prefix: string, earlier?: any[], offset?: number }} options
 */
export async function learnFrom(loop, episodes, { gate, sleepEvery, prefix, earlier = [], offset = 0 }) {
  const tally = { episodes: 0, successes: 0, failures: 0, errors: 0, productGate: 0, distilled: 0, sleeps: 0 };
  for (const record of episodes) {
    tally.episodes += 1;
    if (record.error) tally.errors += 1;
    if (record.success === true) {
      tally.successes += 1;
      const lesson = await loop.lessonFor(record, earlier);
      if (lesson.productGate) tally.productGate += 1;
      const peers = gate === "product" ? (lesson.productGate ? lesson.productPeers : null) : (earlier.length >= 2 ? lesson.nearestPeers : null);
      if (peers) {
        await loop.distill({ record, peers, stepId: `${prefix}distill:${record.taskId}` });
        tally.distilled += 1;
      }
      earlier.push(record);
    } else {
      tally.failures += 1;
    }
    const position = offset + tally.episodes;
    if (sleepEvery > 0 && position % sleepEvery === 0 && loop.policy.consolidate !== "none") {
      await loop.consolidate({ stepId: `${prefix}sleep:${position}` });
      tally.sleeps += 1;
    }
  }
  return tally;
}

async function build(options) {
  const env = String(options.env);
  const variant = String(options.variant);
  if (!VARIANTS[/** @type {keyof typeof VARIANTS} */ (variant)]) throw new Error(`Unknown variant ${variant}`);
  const gate = String(options.gate ?? "every-success");
  if (!LESSON_GATES.includes(gate)) throw new Error(`Unknown gate ${gate}`);
  const sleepEvery = Number(options["sleep-every"] ?? 10);
  const out = String(options.out);
  const pool = JSON.parse(await readFile(String(options.pool), "utf8"));
  const tasks = pool.sets?.[env]?.train;
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("The pool has no training tasks for this environment.");
  /** @type {any[]} */
  const episodes = [];
  for (const taskId of tasks) {
    const file = trajectoryPath(String(options["train-dir"]), env, "train", "no-skill", taskId);
    const record = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (!record) {
      if (options["allow-missing"]) continue;
      throw new Error(`Training episode missing: ${taskId}`);
    }
    episodes.push(record);
  }
  if (options.limit) episodes.splice(Number(options.limit));
  const embedder = options["embed-key-file"] ? await embedderFrom(String(options["embed-key-file"])) : null;
  const dir = path.join(out, `${env}-${variant}`);
  await mkdir(out, { recursive: true });
  const loop = await OfflineLoop.open({ dir, env, variant, policy: { ...VARIANTS[/** @type {keyof typeof VARIANTS} */ (variant)], approve: "immediate", officialInLoop: false },
    model: learningModel({ dryRun: Boolean(options["dry-run"]), keyFile: options["key-file"] ?? undefined }),
    embed: embedder?.embed ?? null, embedModel: embedder?.model ?? null, cacheDir: path.join(out, "cache") });
  const started = Date.now();
  const tally = await learnFrom(loop, episodes, { gate, sleepEvery, prefix: "" });
  if (loop.policy.consolidate !== "none") await loop.consolidate({ stepId: "sleep:final" });
  const exported = await loop.exportTo(path.join(out, `${env}-${variant}.json`));
  const summary = { env, variant, gate, sleepEvery, tally, stats: exported.stats, seconds: Math.round((Date.now() - started) / 1000) };
  await writeFile(path.join(out, `${env}-${variant}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  await globalStatus(`c1 library ${env}-${variant} built: ${exported.stats.methods} methods (${JSON.stringify(exported.stats.byRole)}), lessons ${tally.distilled}/${tally.successes} successes, product gate would fire ${tally.productGate}, model calls ${exported.stats.modelUsage?.calls ?? 0}`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

/**
 * The evolving arm's learning between waves: the episodes an evaluation wave just finished, in task order, taught to the evolving copy of
 * the pyramid library exactly as training episodes are. The successes seen so far (training and evaluation) are kept in `<dir>/seen.json`.
 */
async function evolve(options) {
  const env = String(options.env);
  const dir = String(options.dir);
  const saved = JSON.parse(await readFile(path.join(dir, "library.json"), "utf8"));
  const embedder = options["embed-key-file"] ? await embedderFrom(String(options["embed-key-file"])) : null;
  const loop = await OfflineLoop.open({ dir, env, variant: saved.variant, policy: saved.policy,
    model: learningModel({ dryRun: Boolean(options["dry-run"]), keyFile: options["key-file"] ?? undefined }),
    embed: embedder?.embed ?? null, embedModel: embedder?.model ?? null, cacheDir: options["cache-dir"] ? String(options["cache-dir"]) : undefined });
  const seenPath = path.join(dir, "seen.json");
  const seen = await readFile(seenPath, "utf8").then(JSON.parse).catch(() => ({ successes: [], position: 0 }));
  const earlier = [];
  for (const file of seen.successes) earlier.push(JSON.parse(await readFile(file, "utf8")));
  /** @type {any[]} */
  const episodes = [];
  const files = options._.slice(1).concat(String(options.episodes ?? "").split(",").filter(Boolean));
  for (const file of files) episodes.push({ ...JSON.parse(await readFile(file, "utf8")), file });
  const fresh = episodes.filter((record) => !seen.successes.includes(record.file) && !loop.done(`eval:distill:${record.taskId}`));
  const tally = await learnFrom(loop, fresh, { gate: String(options.gate ?? "every-success"), sleepEvery: Number(options["sleep-every"] ?? 10), prefix: "eval:", earlier, offset: seen.position });
  for (const record of fresh) if (record.success === true && !seen.successes.includes(record.file)) seen.successes.push(record.file);
  seen.position += fresh.length;
  await writeFile(seenPath, `${JSON.stringify(seen)}\n`);
  if (options.export) await loop.exportTo(String(options.export));
  process.stdout.write(`${JSON.stringify({ env, tally, methods: (await loop.methods()).length })}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const command = options._[0];
  if (command === "build") return build(options);
  if (command === "evolve") return evolve(options);
  throw new Error("Usage: build_library.mjs build|evolve ...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${String(error?.stack ?? error).split("\n").slice(0, 3).join(" | ")}\n`); process.exit(1); });
}
