#!/usr/bin/env node
/**
 * Put away the methods the hourly consolidation pass built on top of each other before it stopped doing so
 * (`unprovenMerge` in apps/server/src/methodConsolidation.mjs): merges nobody has used once, whose originals are still in
 * force beside them. On production between 2026-10-07 and 10-12 the pass built 27 of them out of three taught methods, and
 * every one was listed on the 做法 page and packed into a share.
 *
 *   node scripts/ops/retire-unproven-merges.mjs --user <userId>              # report what would be put away
 *   node scripts/ops/retire-unproven-merges.mjs --user <userId> --apply      # retire them; the taught methods stay
 *   node scripts/ops/retire-unproven-merges.mjs --user <userId> --restore    # put back every method this script retired
 *
 * Retiring keeps every revision; `--restore` returns each to the body it held before (the method ledger's own rollback).
 * Prints ids and the page's titles, never a method's body. Uses the configuration the server runs with.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The reason a retired merge carries; `--restore` recognises its own retirements by it. */
export const RETIRE_REASON = "与已有做法重复，已收起；它合并的原做法仍然有效。";

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { user: "", apply: false, restore: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { options.apply = true; continue; }
    if (argument === "--restore") { options.restore = true; continue; }
    if (argument !== "--user") throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--user needs a value");
    options.user = value;
    index += 1;
  }
  if (!options.user) throw new Error("give --user <id>");
  if (options.apply && options.restore) throw new Error("--apply and --restore are two runs");
  return options;
}

/**
 * @param {any} learning the method ledger (`LearningService`)
 * @param {(method: any) => boolean} unproven `unprovenMerge`
 * @param {ReturnType<typeof parseArguments>} options
 */
export async function retireUnprovenMerges(learning, unproven, options) {
  const items = (await learning.listMethods(options.user, { limit: 100 })).items ?? [];
  const title = (/** @type {any} */ method) => String(method.payload?.display?.title ?? method.payload?.frontmatter?.name ?? method.id);
  if (options.restore) {
    const restored = [];
    for (const method of items.filter((item) => item.payload?.status === "retired" && item.payload?.statusReason === RETIRE_REASON)) {
      await learning.rollback(options.user, method.id, { expectedRevision: method.revision, targetRevision: method.revision });
      restored.push({ id: method.id, title: title(method) });
    }
    return { mode: "restore", restored: restored.length, items: restored };
  }
  const merges = items.filter((item) => item.payload?.status === "approved" && unproven(item));
  const kept = items.filter((item) => item.payload?.status === "approved" && !unproven(item));
  if (options.apply) {
    for (const method of merges) {
      await learning.retire(options.user, method.id, { expectedRevision: method.revision, reason: RETIRE_REASON });
    }
  }
  return {
    mode: options.apply ? "apply" : "report",
    retired: merges.length,
    kept: kept.length,
    items: merges.map((method) => ({ id: method.id, title: title(method) })),
    keeping: kept.map((method) => ({ id: method.id, title: title(method) })),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ProductDocuments }, { LearningService }, { unprovenMerge }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/productStore.mjs"),
    import("../../apps/server/src/learningService.mjs"),
    import("../../apps/server/src/methodConsolidation.mjs"),
  ]);
  const store = createStore(loadConfig());
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const learning = new LearningService({ documents: new ProductDocuments(database) });
    const result = await retireUnprovenMerges(learning, unprovenMerge, options);
    process.stdout.write(`${JSON.stringify({ user: options.user, ...result }, null, 2)}\n`);
  } finally {
    await database?.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`retire-unproven-merges: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
