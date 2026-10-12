#!/usr/bin/env node
/**
 * Read an account's older memories again under today's memory rules now, rather than one batch after each of its runs
 * (`apps/server/src/memoryReview.mjs`).
 *
 *   node scripts/ops/review-memories.mjs --user <userId> --project <projectId>            # report what a reading would forget
 *   node scripts/ops/review-memories.mjs --user <userId> --project <projectId> --apply    # read, and forget what the rules exclude
 *   ... [--max-batches <n>]   (default 10, each at most 24 memories and one model call)
 *
 * The project is the one the model calls are charged to, as a run's reading is charged to its run's project. Only memories the
 * platform wrote and nobody has touched are read; a forgotten one is archived — the researcher sees it under 「已忘记的内容」 and can
 * put it back — and every reading is noted, so a second run reads nothing until the rules change. Prints ids, kinds and reason
 * codes, never a memory's text. Uses the configuration the server runs with.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { apply: false, user: "", project: "", maxBatches: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { options.apply = true; continue; }
    const field = { "--user": "user", "--project": "project", "--max-batches": "maxBatches" }[argument];
    if (!field) throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    /** @type {any} */ (options)[field] = field === "maxBatches" ? Number(value) : value;
    index += 1;
  }
  if (!options.user || !options.project) throw new Error("give --user <id> and --project <id>");
  if (!Number.isInteger(options.maxBatches) || options.maxBatches < 1 || options.maxBatches > 100) throw new Error("--max-batches is 1 to 100");
  return options;
}

/**
 * One account's reading. A report reads the unread memories in batches without noting or changing anything; `apply` reads a batch,
 * forgets and notes, and goes on until nothing is left to read or the batches run out.
 * @param {import('../../apps/server/src/memoryReview.mjs').MemoryReview} review @param {any} researchMemory
 * @param {ReturnType<typeof parseArguments>} options
 */
export async function reviewAccount(review, researchMemory, options) {
  if (!review.available) throw new Error("this deployment cannot read memories again: no model or no memory database");
  const { MEMORY_REVIEW_BATCH, MEMORY_REVIEW_RULES } = await import("../../apps/server/src/memoryReview.mjs");
  /** @type {{ id: string, kind: string, scope: string, reason: string }[]} */
  const forgotten = [];
  let read = 0;
  if (!options.apply) {
    const unread = await researchMemory.unreviewedRecords(options.user, MEMORY_REVIEW_RULES, { limit: Math.min(100, MEMORY_REVIEW_BATCH * options.maxBatches) });
    for (let start = 0; start < unread.length; start += MEMORY_REVIEW_BATCH) {
      const batch = unread.slice(start, start + MEMORY_REVIEW_BATCH);
      const verdicts = await review.judge(options.user, batch, { projectId: options.project });
      read += batch.length;
      for (const record of batch) {
        if (verdicts.has(record.id)) forgotten.push({ id: record.id, kind: record.kind, scope: record.scope, reason: String(verdicts.get(record.id)) });
      }
    }
  } else {
    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      const result = await review.review(options.user, { projectId: options.project });
      if (result.read === 0) break;
      read += result.read;
      forgotten.push(...result.forgotten);
    }
  }
  /** @type {Record<string, number>} */
  const byReason = {};
  for (const item of forgotten) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
  return { applied: options.apply, rules: MEMORY_REVIEW_RULES, read, forgotten: forgotten.length, byReason, items: forgotten };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ResearchMemoryStore }, { MemoryReview }, { UsageLedger }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/researchMemory.mjs"),
    import("../../apps/server/src/memoryReview.mjs"),
    import("../../apps/server/src/usageLedger.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const researchMemory = new ResearchMemoryStore(config, { database });
    const review = new MemoryReview(config, researchMemory, { usageLedger: new UsageLedger(database) });
    const result = await reviewAccount(review, researchMemory, options);
    process.stdout.write(`${JSON.stringify({ user: options.user, project: options.project, ...result }, null, 2)}\n`);
  } finally {
    await database?.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`review-memories: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
