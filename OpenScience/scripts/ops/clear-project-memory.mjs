#!/usr/bin/env node
/**
 * Clear one project's research memory without deleting the project — the
 * supported way to do what the 2026-09-23 history cleanup did by hand.
 *
 * That cleanup emptied the acceptance account's `default` project (which
 * cannot be deleted) with a bare `delete from evimed_memory.records`, which
 * told the recall index nothing and left the usage counters behind: sixteen
 * index copies of deleted memories and 84 orphan counters were still there on
 * 2026-09-26 (audit I3 §6, M-7). This goes through the store, so each removed
 * record enqueues its own index delete and its counters go with it in the same
 * transaction, and then removes the project's index subtree as project
 * deletion does.
 *
 *   node scripts/ops/clear-project-memory.mjs --user <id> --project <id>           # report only
 *   node scripts/ops/clear-project-memory.mjs --user <id> --project <id> --apply   # clear
 *
 * Idempotent: a second run finds nothing to clear. Prints counts only.
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { apply: false, user: "", project: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { options.apply = true; continue; }
    const field = { "--user": "user", "--project": "project" }[argument];
    if (!field) throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    /** @type {any} */ (options)[field] = value;
    index += 1;
  }
  if (!options.user || !options.project) throw new Error("give --user <id> and --project <id>");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ResearchMemoryStore }, { OpenVikingClient }, { MemorySubstrate, selectedMemoryIndexProvider }, { ProductJobs }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/researchMemory.mjs"),
    import("../../apps/server/src/openVikingClient.mjs"),
    import("../../apps/server/src/memorySubstrate.mjs"),
    import("../../apps/server/src/productJobs.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const openViking = new OpenVikingClient(config);
    // The store enqueues index deletes exactly when the server's does: when
    // this deployment has an index for a worker to apply them to.
    const indexed = selectedMemoryIndexProvider(config) === "openviking" && Boolean(openViking.configured);
    const jobs = indexed ? new ProductJobs(database) : null;
    const researchMemory = new ResearchMemoryStore(config, { database, jobs });
    const substrate = new MemorySubstrate(config, { store: researchMemory, openViking, jobs });
    const held = (await researchMemory.listAllRecords(options.user))
      .filter((/** @type {any} */ record) => record.scope === "project" && record.scopeId === options.project);
    const report = { user: options.user, project: options.project, applied: options.apply, records: held.length, indexed };
    if (!options.apply) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    // The subtree first and last, as project deletion does: an index copy of
    // a deleted memory is the thing this exists to prevent.
    if (substrate.active) await substrate.forgetProject(options.user, options.project);
    const removed = await researchMemory.deleteProjectMemory(options.user, options.project);
    if (substrate.active) await substrate.forgetProject(options.user, options.project).catch(() => false);
    process.stdout.write(`${JSON.stringify({ ...report, removed: removed.structured }, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`clear_project_memory_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
