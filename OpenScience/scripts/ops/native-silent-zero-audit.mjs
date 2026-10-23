#!/usr/bin/env node
/**
 * The weekly silent-zero audit of native memory: which accounts talked to the assistant for a week, were committed to the engine
 * after their attended turns, and wrote nothing.
 *
 * A native account whose commits all complete with no operation looks exactly like an account whose conversations had nothing
 * worth keeping. On 2026-10-19 the owner's account was that account: two commits, each `completed`, 0 operations, no memory file
 * in ten days of work orders (research G, the empty default). Nothing counted it. This counts it, and prints what a person can
 * act on: the account, how many attended commits, the last one, and how many of them wrote anything.
 *
 * Report only (nothing is read of an account's memory, nothing is changed). Which commits count is data, not language: a commit
 * of origin `gateway` is the control plane's commit after an attended turn (`nativeTurnCommit.mjs`), a `completed` state means the
 * engine's extraction ran and its diff was read, and `operations` is that diff's adds, updates and deletes. Whether the
 * conversations held anything to keep is the question the offline judge answers (`evals/memory-write-quality/README.md`); this
 * script says where to look.
 *
 *   node scripts/ops/native-silent-zero-audit.mjs                     # the last 7 days, accounts with at least 2 attended commits
 *   node scripts/ops/native-silent-zero-audit.mjs --days 14 --min-commits 3 --json
 *   node scripts/ops/native-silent-zero-audit.mjs --fail-if-any        # exit status 2 when an account is silent (for a scheduler)
 *
 * It reads `evimed_memory.native_commits.operations`, which every completed row already carries. The skipped-operation reasons
 * that package `native` adds to the ledger tell why a commit was empty; this is the question before it.
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The origins of a commit made after a turn a person was in: the control plane's own (`gateway`). The `remember` tool, the page and a replay are not "an attended turn produced nothing". */
export const ATTENDED_COMMIT_ORIGINS = Object.freeze(["gateway"]);

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { days: 7, minCommits: 2, json: false, failIfAny: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { options.json = true; continue; }
    if (argument === "--fail-if-any") { options.failIfAny = true; continue; }
    const field = { "--days": "days", "--min-commits": "minCommits" }[argument];
    if (!field) throw new Error(`unknown argument ${argument}`);
    const value = Number(argv[index + 1]);
    if (!Number.isInteger(value) || value < 1 || value > 365) throw new Error(`${argument} needs a whole number from 1 to 365`);
    /** @type {any} */ (options)[field] = value;
    index += 1;
  }
  return options;
}

/**
 * The accounts of a window's per-account totals that wrote nothing although enough attended commits completed.
 * @param {readonly { userId: string, commits: number, operations: number, productive: number, lastCommit: string | null }[]} accounts
 * @param {{ minCommits?: number }} [options]
 */
export function silentAccounts(accounts, { minCommits = 2 } = {}) {
  return accounts.filter((account) => account.commits >= minCommits && account.operations === 0)
    .sort((left, right) => right.commits - left.commits || left.userId.localeCompare(right.userId));
}

/**
 * Every native account's attended commits of the last `days` days, summed, from the commit ledger.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} database @param {{ days?: number }} [options]
 */
export async function attendedCommitTotals(database, { days = 7 } = {}) {
  const result = await database.query(`SELECT c.user_id, count(*)::integer AS commits, coalesce(sum(c.operations), 0)::integer AS operations,
      count(*) FILTER (WHERE c.operations > 0)::integer AS productive, max(c.created_at)::text AS last_commit
    FROM evimed_memory.native_commits c
    WHERE c.origin = ANY($1::text[]) AND c.state = 'completed' AND c.created_at > clock_timestamp() - make_interval(days => $2::integer)
    GROUP BY c.user_id`, [[...ATTENDED_COMMIT_ORIGINS], days]);
  return result.rows.map((row) => ({
    userId: String(row.user_id), commits: Number(row.commits) || 0, operations: Number(row.operations) || 0,
    productive: Number(row.productive) || 0, lastCommit: row.last_commit ?? null,
  }));
}

/**
 * The audit as data: the window, how many accounts committed at all, and the silent ones.
 * @param {{ query: Function }} database @param {{ days?: number, minCommits?: number }} [options]
 */
export async function silentZeroAudit(database, { days = 7, minCommits = 2 } = {}) {
  const accounts = await attendedCommitTotals(database, { days });
  return { days, minCommits, accountsCommitted: accounts.length, silent: silentAccounts(accounts, { minCommits }) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const report = await silentZeroAudit(/** @type {any} */ (database), options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${report.silent.map((account) => [account.userId, `${account.commits} attended commits`, `last ${account.lastCommit ?? "?"}`, "0 operations"].join("\t")).join("\n")}${report.silent.length ? "\n" : ""}`);
      process.stdout.write(`# ${report.accountsCommitted} native accounts had an attended commit in the last ${report.days} days; ${report.silent.length} with at least ${report.minCommits} of them wrote nothing\n`);
    }
    if (options.failIfAny && report.silent.length) process.exitCode = 2;
  } finally {
    await store.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`native_silent_zero_audit_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
