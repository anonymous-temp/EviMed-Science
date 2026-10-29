#!/usr/bin/env node
/**
 * Rewrite the capsule's recall index from the authoritative store.
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
 * The capsule facts go through the same durable job the server's worker runs so
 * that one capsule is never being written by two processes at once. A change of
 * embedding model or a lost volume invalidates them. (The index once held a second half, the
 * derived copies of the legacy engine's records, which this command also rebuilt; that engine is
 * deleted, an account's memory is the engine's own files and is not derived from anything, and
 * `legacyMemoryRetirement.mjs` withdrew those copies.)
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

/** How long to keep asking the ledger about a job the server's own worker
 *  claimed before calling it unfinished. The exit code of this command means
 *  "the index is current", and a non-zero one for a capsule that another
 *  process is in the middle of rebuilding would make that reading false in the
 *  ordinary case of running it on a live deployment. */
const FOREIGN_JOB_WAIT_MS = 60_000;
const FOREIGN_JOB_POLL_MS = 500;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

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
 * @param {{database:any,jobs:any,indexing:any,userIds:string[],failurePolicy:(code:string,attempts:number)=>{retry:boolean,delayMs:number}}} context
 */
async function rebuildCapsules({ database, jobs, indexing, userIds, failurePolicy }) {
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
    // The same renewal the server's worker runs, for the same reason. A capsule
    // large enough to out-run one lease would otherwise have it expire
    // mid-rebuild: a second claimer would start over on a subtree this process
    // is still writing, and the finish would be refused as a lost lease after
    // the work was done.
    const renewal = setInterval(() => {
      void jobs.renew(job.userId, job.id, job.leaseToken, CAPSULE_LEASE_MS).catch(() => {});
    }, Math.max(1000, Math.floor(CAPSULE_LEASE_MS / 3)));
    renewal.unref();
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
      // Leave the job failed or requeued rather than running: a lease that
      // expires on its own would hold this capsule for the length of the lease
      // and tell nobody. Which of the two is the worker's policy, not this
      // command's — the claim above has no user filter, so the job in hand may
      // belong to an account nobody named on the command line, enqueued with
      // ten attempts by the reconcile this command never ran. Marking that one
      // terminally failed would be this process deciding, from outside, that
      // another account's capsule is unsearchable. This command's own jobs are
      // enqueued with a single attempt, so the same policy settles them here.
      if (code !== "product_job_lease_lost") {
        await jobs.fail(job.userId, job.id, job.leaseToken, { code, message: "Memory index rebuild failed." },
          failurePolicy(code, job.attempts)).catch(() => {});
      }
    } finally {
      clearInterval(renewal);
    }
  }

  // A job still marked pending here was not claimed by this command — a server
  // worker claims the same kind, and it does the same work. Ask the ledger what
  // became of it rather than reporting a failure for work that succeeded
  // somewhere else, and keep asking for a bounded while: a job the other worker
  // is still running is not a failure, it is one this command has not seen the
  // end of yet. Only a job still queued or running when the wait runs out is
  // reported as unfinished.
  const deadline = Date.now() + FOREIGN_JOB_WAIT_MS;
  for (;;) {
    let unfinished = 0;
    for (const [id, outcome] of [...outcomes]) {
      if (outcome.status !== "pending") continue;
      const job = await jobs.get(outcome.userId, id);
      if (job?.status === "succeeded") outcomes.set(id, { ...outcome, status: "rebuilt_elsewhere" });
      else if (job?.status === "failed") {
        outcomes.set(id, { ...outcome, status: "failed", code: String(job.error?.code ?? "memory_index_failed") });
      } else unfinished += 1;
    }
    if (unfinished === 0 || Date.now() >= deadline) break;
    await sleep(FOREIGN_JOB_POLL_MS);
  }
  return [...outcomes.values()];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { OpenVikingClient },
    { MemoryIndexProvider }, { MemoryIndexing }, { ProductJobs }, { memoryIndexFailurePolicy }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/openVikingClient.mjs"),
    import("../../apps/server/src/memoryIndexProvider.mjs"),
    import("../../apps/server/src/memoryIndexing.mjs"),
    import("../../apps/server/src/productJobs.mjs"),
    import("../../apps/server/src/memoryIndexWorker.mjs"),
  ]);

  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    const openViking = new OpenVikingClient(config);
    const substrate = new MemoryIndexProvider(config, { openViking });

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
      // The capsules are rows in the control-plane database. Without one
      // there is nothing authoritative to rebuild from,
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

    const jobs = new ProductJobs(database);
    const indexing = new MemoryIndexing({ database, openViking, jobs });
    const capsules = await rebuildCapsules({
      database, jobs, indexing, userIds, failurePolicy: memoryIndexFailurePolicy,
    });

    const capsulesFailed = capsules.filter((row) => row.status === "failed" || row.status === "pending");
    const summary = {
      ok: capsulesFailed.length === 0,
      provider: substrate.provider,
      users: userIds.length,
      capsules: capsules.length,
      capsulesFailed: capsulesFailed.length,
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
