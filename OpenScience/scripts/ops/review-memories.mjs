#!/usr/bin/env node
/**
 * Read an account's older memories again under today's memory rules now, rather than one batch after each of its runs
 * (`apps/server/src/memoryReview.mjs`).
 *
 *   node scripts/ops/review-memories.mjs --user <userId>             # report what a reading would forget
 *   node scripts/ops/review-memories.mjs --user <userId> --apply     # read, and forget what the rules exclude
 *   ... [--project <projectId>] [--max-batches <n>]   (default 10, each at most 24 memories)
 *
 * Two kinds of verdict. Code decides, with no model call, the memories that rest on what the assistant or a tool said
 * (`assistant_text`) and those that rest only on an instruction the platform dispatched (`dispatched_instruction` — a scheduled
 * task reuses one conversation, and its template can be quoted as the person's habit): it reads who wrote the quoted message from
 * the run ledger and the stored transcripts. The model reads what the platform inferred and puts it against the rules (report
 * content, run state, platform notes, ...). A memory the researcher stated and nothing marks as a dispatch or the assistant's, one
 * they ever edited, and one nothing can place, is kept.
 *
 * The project is the one the model calls are charged to (default: the account's default project). Only memories nobody has
 * touched are read; a forgotten one is archived — the researcher sees it under 「已忘记的内容」 and can put it back, nothing is
 * deleted — and every reading is noted, so a second run reads nothing until the rules change. Prints counts, ids, kinds and reason
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
  if (!options.user) throw new Error("give --user <id>");
  if (!Number.isInteger(options.maxBatches) || options.maxBatches < 1 || options.maxBatches > 100) throw new Error("--max-batches is 1 to 100");
  return options;
}

/**
 * One account's reading. A report reads the unread memories in batches without noting or changing anything; `apply` reads a batch,
 * forgets and notes, and goes on until nothing is left to read or the batches run out.
 * @param {import('../../apps/server/src/memoryReview.mjs').MemoryReview} review @param {any} researchMemory
 * @param {ReturnType<typeof parseArguments> & { project: string }} options
 */
export async function reviewAccount(review, researchMemory, options) {
  if (!review.available) throw new Error("this deployment cannot read memories again: no model or no memory database");
  const { MEMORY_REVIEW_BATCH, MEMORY_REVIEW_RULES, MEMORY_REVIEW_STRUCTURAL_REASONS, REVIEWED_ORIGINS } = await import("../../apps/server/src/memoryReview.mjs");
  /** @type {{ id: string, kind: string, scope: string, reason: string }[]} */
  const forgotten = [];
  let read = 0;
  let truncated = false;
  if (!options.apply) {
    const limit = Math.min(100, MEMORY_REVIEW_BATCH * options.maxBatches);
    const unread = await researchMemory.unreviewedRecords(options.user, MEMORY_REVIEW_RULES, { limit, origins: REVIEWED_ORIGINS });
    // A report notes nothing, so it can show the oldest hundred at most; `--apply` goes on until nothing is left.
    truncated = unread.length >= limit;
    for (let start = 0; start < unread.length; start += MEMORY_REVIEW_BATCH) {
      const batch = unread.slice(start, start + MEMORY_REVIEW_BATCH);
      const verdicts = await review.verdicts(options.user, batch, { projectId: options.project });
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
  const decidedInCode = forgotten.filter((item) => MEMORY_REVIEW_STRUCTURAL_REASONS.includes(item.reason)).length;
  return { applied: options.apply, rules: MEMORY_REVIEW_RULES, read, ...(truncated ? { truncated: true } : {}), forgotten: forgotten.length, decidedInCode, decidedByModel: forgotten.length - decidedInCode, byReason, items: forgotten };
}

/** The project the model calls are charged to when none is named: the account's default one, else its first. @param {any} store @param {string} userId */
export async function chargedProject(store, userId) {
  const user = await store.userById(userId);
  if (!user) throw new Error("no such user");
  const projects = await store.listProjects(user);
  return projects.find((/** @type {any} */ project) => project.id === "default")?.id ?? projects[0]?.id ?? "default";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { memoryStoreForOps }, { MemoryReview }, { UsageLedger }, { AgentRunStore }, { createEvidenceProvenance }, { readRunTranscript }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("./memory-store.mjs"),
    import("../../apps/server/src/memoryReview.mjs"),
    import("../../apps/server/src/usageLedger.mjs"),
    import("../../apps/server/src/agentRuns.mjs"),
    import("../../apps/server/src/memoryEvidenceProvenance.mjs"),
    import("../../apps/server/src/runTranscripts.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const { researchMemory } = memoryStoreForOps(config, database);
    const runs = new AgentRunStore(null, {});
    const review = new MemoryReview(config, researchMemory, {
      usageLedger: new UsageLedger(database),
      evidenceProvenance: () => createEvidenceProvenance({
        projectsFor: async (userId, scopeId) => {
          const user = await store.userById(userId);
          if (!user) return [];
          const ids = scopeId ? [scopeId] : (await store.listProjects(user)).map((/** @type {any} */ project) => project.id);
          return (await Promise.all(ids.map((/** @type {string} */ id) => store.requireProject(user, id).catch(() => null)))).filter(Boolean);
        },
        runIndex: (project) => runs.conversationIndex(project),
        readTranscript: readRunTranscript,
      }),
    });
    const project = options.project || await chargedProject(store, options.user);
    const result = await reviewAccount(review, researchMemory, { ...options, project });
    process.stdout.write(`${JSON.stringify({ user: options.user, project, ...result }, null, 2)}\n`);
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
