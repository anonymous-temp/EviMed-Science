#!/usr/bin/env node
/**
 * Find, and with `--apply` remove, memory usage counters whose record no
 * longer exists.
 *
 * `evimed_memory.record_usage` has no foreign key to the records it counts —
 * a recall must never fail on a row deleted underneath it — so every delete
 * has to clear its counters itself. Until 2026-09-27 two did not (a project's
 * deletion, and the operator SQL of the 09-23 history cleanup), and production
 * held 84 such rows on 2026-09-26 (audit M-7). A counter for a deleted memory
 * is a copy of deleted data, however small. Every store path clears them now;
 * this removes what was left before.
 *
 *   node scripts/ops/prune-orphan-memory-usage.mjs                    # report only
 *   node scripts/ops/prune-orphan-memory-usage.mjs --apply            # remove
 *   node scripts/ops/prune-orphan-memory-usage.mjs --user <id> [--apply]
 *
 * Idempotent: a second run finds nothing. Prints counts per account only.
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { apply: false, user: /** @type {string | null} */ (null) };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--user") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--user needs a user id");
      options.user = value;
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ResearchMemoryStore }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/researchMemory.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const result = await new ResearchMemoryStore(config, { database }).orphanUsage({ userId: options.user, apply: options.apply });
    const total = result.orphans.reduce((sum, entry) => sum + entry.rows, 0);
    process.stdout.write(`${JSON.stringify({ ...result, total }, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`prune_orphan_memory_usage_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
