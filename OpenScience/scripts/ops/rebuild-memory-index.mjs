#!/usr/bin/env node
/**
 * Rewrite the recall index from the authoritative store.
 *
 * The index holds nothing of its own — every file in it is derived from a row
 * in the control-plane database — so this always converges and is always safe
 * to run again. That is deliberate, and it is what makes adopting a provider a
 * decision rather than a migration: there is no reconciliation ledger to get
 * wrong, and recovering from any drift is this command.
 *
 *   node scripts/ops/rebuild-memory-index.mjs --user <userId> [--user <userId>]
 *   node scripts/ops/rebuild-memory-index.mjs --all
 *
 * Both halves of the index are rebuilt, because there is one index: the
 * research-memory records, which this process writes itself, and the capsule
 * facts, which go through the same durable job the server's worker runs so that
 * one capsule is never being written by two processes at once. A change of
 * embedding model or a lost volume invalidates both, and a command that
 * restored only the half its name happened to suggest would leave the other
 * silently unsearchable.
 *
 * `--all` reads the user list from the control-plane database, so it needs the
 * same configuration the server runs with.
 */
import { randomUUID } from "node:crypto";
import process from "node:process";

/** How long one capsule rebuild may hold its job. Long enough for a capsule of
 *  a few hundred facts against a network embedder, short enough that a killed
 *  command does not park the capsule for an hour. */
const CAPSULE_LEASE_MS = 300_000;

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

/**
 * Republish every capsule of these users through the ordinary indexing job.
 *
 * The publication ledger row is dropped first. Without that, a rebuild whose
 * files are all present and whose fingerprint still matches reports
 * `already_current` and writes nothing — correct after a crash, and exactly
 * wrong after an embedding model change, where the file names are unchanged and
 * every vector behind them is stale.
 *
 * @param {{database:any,jobs:any,indexing:any,userIds:string[]}} context
 */
async function rebuildCapsules({ database, jobs, indexing, userIds }) {
  const workerId = `memory-index-rebuild-${randomUUID()}`;
  /** @type {{userId:string,id:string,capsuleId:string}[]} */
  const enqueued = [];
  for (const userId of userIds) {
    const capsules = await database.query(
      "SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='capsule' ORDER BY id", [userId]);
    for (const row of capsules.rows) {
      const snapshot = await indexing.snapshot(userId, row.id);
      // No snapshot means no account generation to bind the subtree to: the
      // capsule is gone, or the account is. Neither is this command's to repair.
      if (!snapshot) continue;
      await database.query("DELETE FROM evimed_product.memory_index_state WHERE user_id=$1 AND capsule_id=$2",
        [userId, row.id]);
      const job = await jobs.enqueue(userId, "memory-index",
        { capsuleId: row.id, accountCreatedAt: snapshot.generation, reason: "operator_rebuild" },
        // A key unique to this invocation. A stable one would meet the
        // succeeded job of the previous rebuild and return it unchanged, and
        // the command would then wait for work that had already happened.
        { idempotencyKey: `memory-index:rebuild:${workerId}:${row.id}`, maxAttempts: 1 });
      enqueued.push({ userId, id: job.id, capsuleId: row.id });
    }
  }

  /** @type {Map<string,{userId:string,capsuleId:string,status:string,code?:string}>} */
  const outcomes = new Map(enqueued.map((entry) =>
    [entry.id, { userId: entry.userId, capsuleId: entry.capsuleId, status: "pending" }]));
  const mine = new Set(enqueued.map((entry) => entry.id));
  // Claim until every job this command enqueued has left the queue. A server
  // worker may be draining the same kind, which is why a job is followed by its
  // id rather than by who claimed it, and why an empty claim ends the loop
  // instead of spinning: whoever holds it is doing the same work.
  while ([...outcomes.values()].some((outcome) => outcome.status === "pending")) {
    const job = await jobs.claim(["memory-index"], workerId, { leaseMs: CAPSULE_LEASE_MS });
    if (!job) break;
    try {
      const finished = await indexing.rebuild(job);
      if (mine.has(job.id)) {
        outcomes.set(job.id, { userId: job.userId, capsuleId: job.payload?.capsuleId ?? "",
          status: String(finished?.result?.status ?? "rebuilt") });
      }
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "memory_index_failed";
      if (mine.has(job.id)) {
        outcomes.set(job.id, { userId: job.userId, capsuleId: job.payload?.capsuleId ?? "", status: "failed", code });
      }
      // Leave the job failed rather than running: a lease that expires on its
      // own would hold this capsule for the length of the lease and tell nobody.
      if (code !== "product_job_lease_lost") {
        await jobs.fail(job.userId, job.id, job.leaseToken, { code, message: "Memory index rebuild failed." },
          { retry: false }).catch(() => {});
      }
    }
  }

  // A job still marked pending here was not claimed by this command — a server
  // worker claims the same kind, and it does the same work. Ask the ledger what
  // became of it rather than reporting a failure for work that succeeded
  // somewhere else; only a job that is still queued or running is unfinished.
  for (const [id, outcome] of outcomes) {
    if (outcome.status !== "pending") continue;
    const job = await jobs.get(outcome.userId, id);
    if (job?.status === "succeeded") outcomes.set(id, { ...outcome, status: "rebuilt_elsewhere" });
    else if (job?.status === "failed") {
      outcomes.set(id, { ...outcome, status: "failed", code: String(job.error?.code ?? "memory_index_failed") });
    }
  }
  return [...outcomes.values()];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ResearchMemoryStore }, { OpenVikingClient },
    { MemorySubstrate }, { MemoryIndexing }, { ProductJobs }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/researchMemory.mjs"),
    import("../../apps/server/src/openVikingClient.mjs"),
    import("../../apps/server/src/memorySubstrate.mjs"),
    import("../../apps/server/src/memoryIndexing.mjs"),
    import("../../apps/server/src/productJobs.mjs"),
  ]);

  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    const researchMemory = new ResearchMemoryStore(config, { database });
    const openViking = new OpenVikingClient(config);
    const substrate = new MemorySubstrate(config, { store: researchMemory, openViking });

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
    if (!database) {
      // Research memory and capsules are both rows in the control-plane
      // database. Without one there is nothing authoritative to rebuild from,
      // and rebuilding from the index itself is the one thing this command
      // must never do.
      process.stdout.write(`${JSON.stringify({ ok: false, reason: "no control-plane database" }, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }

    let userIds = options.users;
    if (options.all) {
      await store.loadUsers();
      userIds = [...store.users.keys()];
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

    const jobs = new ProductJobs(database);
    const indexing = new MemoryIndexing({ database, openViking, jobs });
    const capsules = await rebuildCapsules({ database, jobs, indexing, userIds });

    const failed = results.filter((row) => row.error);
    const capsulesFailed = capsules.filter((row) => row.status === "failed" || row.status === "pending");
    const summary = {
      ok: failed.length === 0 && capsulesFailed.length === 0,
      provider: substrate.provider,
      users: results.length,
      written: results.reduce((total, row) => total + (row.written ?? 0), 0),
      skipped: results.reduce((total, row) => total + (row.skipped ?? 0), 0),
      failed: failed.length,
      capsules: capsules.length,
      capsulesFailed: capsulesFailed.length,
      results: options.json ? results : failed,
      capsuleResults: options.json ? capsules : capsulesFailed,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});
