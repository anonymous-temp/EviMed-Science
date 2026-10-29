// The weekly silent-zero audit of native memory (2026-10-23): an account whose attended commits all completed with no operation
// looks like an account with nothing to keep, and the owner's account was that for ten days. The script counts it.
import assert from "node:assert/strict";
import test from "node:test";

import { ATTENDED_COMMIT_ORIGINS, attendedCommitTotals, parseArguments, silentAccounts, silentZeroAudit } from "../../../scripts/ops/native-silent-zero-audit.mjs";

const account = (userId, commits, operations, productive = operations > 0 ? 1 : 0) => ({ userId, commits, operations, productive, lastCommit: "2026-10-22 10:00:00+00" });

test("the arguments are a window and a floor, and nothing else", () => {
  assert.deepEqual(parseArguments([]), { days: 7, minCommits: 2, json: false, failIfAny: false });
  assert.deepEqual(parseArguments(["--days", "14", "--min-commits", "3", "--json", "--fail-if-any"]), { days: 14, minCommits: 3, json: true, failIfAny: true });
  assert.throws(() => parseArguments(["--days", "0"]), /whole number from 1 to 365/);
  assert.throws(() => parseArguments(["--days"]), /whole number/);
  assert.throws(() => parseArguments(["--everything"]), /unknown argument/);
});

test("an account is silent when enough attended commits completed and none of them wrote anything; one that wrote once is not", () => {
  const accounts = [account("quiet-a", 5, 0), account("quiet-b", 2, 0), account("working", 6, 4), account("once", 3, 1), account("too-few", 1, 0)];
  assert.deepEqual(silentAccounts(accounts).map((item) => item.userId), ["quiet-a", "quiet-b"], "most commits first; a single commit is not yet a pattern");
  assert.deepEqual(silentAccounts(accounts, { minCommits: 1 }).map((item) => item.userId), ["quiet-a", "quiet-b", "too-few"]);
  assert.deepEqual(silentAccounts(accounts, { minCommits: 6 }), []);
  assert.deepEqual(silentAccounts([]), []);
});

test("the totals are read from the commit ledger: attended commits of the window that completed, summed by account", async () => {
  /** @type {{ sql: string, params: unknown[] }[]} */
  const asked = [];
  const database = {
    async query(sql, params = []) {
      asked.push({ sql, params });
      return { rows: [{ user_id: "u1", commits: 4, operations: 0, productive: 0, last_commit: "2026-10-22 08:00:00+00" }, { user_id: "u2", commits: "3", operations: "5", productive: "2", last_commit: null }] };
    },
  };
  const totals = await attendedCommitTotals(database, { days: 7 });
  assert.deepEqual(totals, [
    { userId: "u1", commits: 4, operations: 0, productive: 0, lastCommit: "2026-10-22 08:00:00+00" },
    { userId: "u2", commits: 3, operations: 5, productive: 2, lastCommit: null },
  ]);
  assert.match(asked[0].sql, /FROM evimed_memory\.native_commits/);
  assert.match(asked[0].sql, /c\.state = 'completed'/, "a commit whose extraction failed or is pending is not a silent one");
  assert.deepEqual(asked[0].params, [["gateway"], 7]);
  assert.deepEqual([...ATTENDED_COMMIT_ORIGINS], ["gateway"], "the remember tool, the page and a replay are not an attended turn that produced nothing");
  const report = await silentZeroAudit(database, { days: 7, minCommits: 2 });
  assert.equal(report.accountsCommitted, 2);
  assert.deepEqual(report.silent.map((item) => item.userId), ["u1"]);
});
