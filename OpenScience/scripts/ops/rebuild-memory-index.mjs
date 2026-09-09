#!/usr/bin/env node
/**
 * Rewrite the recall index from the authoritative store.
 *
 * The index holds nothing of its own — every file in it is derived from a
 * record in the research-memory service — so this always converges and is
 * always safe to run again. That is deliberate, and it is what makes adopting
 * a provider a decision rather than a migration: there is no reconciliation
 * ledger to get wrong, and recovering from any drift is this command.
 *
 *   node scripts/ops/rebuild-memory-index.mjs --user <userId> [--user <userId>]
 *   node scripts/ops/rebuild-memory-index.mjs --all
 *
 * `--all` reads the user list from the control-plane database, so it needs the
 * same configuration the server runs with.
 */
import process from "node:process";

function parseArguments(argv) {
  const users = [];
  let all = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") all = true;
    else if (argument === "--json") json = true;
    else if (argument === "--user") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--user needs a user id");
      users.push(value);
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (!all && users.length === 0) throw new Error("give --user <id> at least once, or --all");
  return { users, all, json };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { MemosClient }, { OpenVikingClient }, { MemorySubstrate }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/memosClient.mjs"),
    import("../../apps/server/src/openVikingClient.mjs"),
    import("../../apps/server/src/memorySubstrate.mjs"),
  ]);

  const config = loadConfig();
  const memos = new MemosClient(config);
  const openViking = new OpenVikingClient(config);
  const substrate = new MemorySubstrate(config, { memos, openViking });

  if (!substrate.active) {
    // Not an error worth a stack trace: the likely cause is running this on a
    // deployment that has not selected an index, and the useful output is
    // which provider it is on.
    const status = await substrate.status();
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "no index selected", status }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const health = await substrate.status();
  if (!health.connected) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "index unreachable", status: health }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  let userIds = options.users;
  if (options.all) {
    const { createStore } = await import("../../apps/server/src/store.mjs");
    const store = createStore(config);
    await store.loadUsers();
    userIds = [...store.users.keys()];
    await store.close();
  }

  const results = [];
  for (const userId of userIds) {
    const started = Date.now();
    try {
      const result = await substrate.rebuild(userId);
      results.push({ userId, ...result, ms: Date.now() - started });
    } catch (error) {
      // One user's failure must not abandon the rest: this is a bulk operation
      // over independent namespaces, and a partial index is better than none.
      results.push({ userId, error: error?.code ?? "rebuild_failed", message: String(error?.message ?? error) });
    }
  }

  const failed = results.filter((row) => row.error);
  const summary = {
    ok: failed.length === 0,
    provider: substrate.provider,
    users: results.length,
    written: results.reduce((total, row) => total + (row.written ?? 0), 0),
    skipped: results.reduce((total, row) => total + (row.skipped ?? 0), 0),
    failed: failed.length,
    results: options.json ? results : failed,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});
