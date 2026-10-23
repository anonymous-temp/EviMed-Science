// A commit that wrote nothing says why (2026-10-23, rectification T0.2): the engine's skipped operations with their reason codes, the
// task's extracted categories and the memory types it was allowed go on the ledger row and into the counters, and the operator's
// report reads the same off the engine's retained archives — for a commit the ledger never recorded them for, too.
import assert from "node:assert/strict";
import test from "node:test";

import { extractionFacts } from "../src/nativeMemoryWorker.mjs";
import { nativeMemoryCounters, nativeMemoryMetricFamilies, recordNativeExtraction, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";
import { parseArchiveUri, nativeMemoryFile } from "../src/openVikingSessions.mjs";
import { commitReport, messageShape, parseArguments, renderText, verdictOf } from "../../../scripts/ops/native-commit-report.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();

test("the facts of an extraction: reason codes counted, the diff before the task, anything unreadable named or left out", () => {
  const diff = { summary: { total_skipped: 3 }, skipped_operations: [
    { reason_code: "memory_type_filtered", memory_type: "events", text: "never kept" }, { reason_code: "memory_type_filtered" }, { reason_code: "Not A Code!" }, { nothing: true }] };
  const task = { status: "completed", result: { memories_extracted: { memory_write: 2, "bad key": 9, empty: 0 }, memory_extraction: { skipped: 1, skipped_operations: [{ reason_code: "ambiguous_target" }] },
    effective_memory_types: ["profile", "preferences", 7, "Bad Type"] } };
  const both = extractionFacts(diff, task);
  assert.deepEqual(both.skipReasons, { memory_type_filtered: 2, unknown: 2 }, "the diff names the reasons; the task's list is read only when the diff names none");
  assert.equal(both.skipped, 4, "the larger of the summary and the lists");
  assert.deepEqual(both.extracted, { memory_write: 2 });
  assert.deepEqual(both.memoryTypes, ["profile", "preferences"]);
  assert.equal(both.fromTask, true);
  assert.ok(!JSON.stringify(both).includes("never kept"), "a skipped operation's own text is not kept");

  const empty = extractionFacts({ operations: {}, skipped_operations: [], summary: { total_skipped: 0 } }, task);
  assert.deepEqual(empty.skipReasons, { ambiguous_target: 1 }, "an empty diff takes its reasons from the task");
  assert.equal(empty.skipped, 1);
  assert.deepEqual(extractionFacts({}), { skipped: 0, skipReasons: {}, extracted: {}, memoryTypes: [], fromTask: false });
  assert.deepEqual(extractionFacts(null, { status: "completed" }), { skipped: 0, skipReasons: {}, extracted: {}, memoryTypes: [], fromTask: false });
});

test("the counters tell a model that proposed nothing from an engine that refused, and an unknown reason is counted as other", () => {
  resetNativeMemoryMetrics();
  recordNativeExtraction(2, { skipped: 0, skipReasons: {} });
  recordNativeExtraction(1, { skipped: 1, skipReasons: { memory_type_filtered: 1 } });
  recordNativeExtraction(0, { skipped: 2, skipReasons: { memory_type_filtered: 1, brand_new_reason: 1 } });
  recordNativeExtraction(0, { skipped: 0, skipReasons: {} });
  const counters = nativeMemoryCounters();
  assert.deepEqual(counters.extractionOutcomes, { wrote: 1, wrote_and_skipped: 1, only_skipped: 1, proposed_nothing: 1 });
  assert.equal(counters.skippedOperations.memory_type_filtered, 2);
  assert.equal(counters.skippedOperations.other, 1);
  const families = nativeMemoryMetricFamilies();
  const outcome = families.find((family) => family.name === "open_science_native_memory_commit_operations_total");
  assert.ok(outcome && outcome.series.every((entry) => typeof entry.labels?.outcome === "string") && outcome.series.length === 4);
  const reasons = families.find((family) => family.name === "open_science_native_memory_skipped_operations_total");
  assert.ok(reasons && reasons.series.some((entry) => entry.labels?.reason === "other"));
  resetNativeMemoryMetrics();
});

test("the report's arguments, verdicts and message shape", () => {
  assert.deepEqual(parseArguments(["--user", "u1", "--limit", "5", "--since", "2026-10-19", "--text"]), { user: "u1", limit: 5, since: "2026-10-19T00:00:00.000Z", text: true, backfill: false });
  assert.throws(() => parseArguments([]), /--user/);
  assert.throws(() => parseArguments(["--user", "u", "--limit", "0"]), /--limit/);
  assert.throws(() => parseArguments(["--user", "u", "--since", "yesterday-ish"]), /--since/);
  assert.throws(() => parseArguments(["--user", "u", "--nope"]), /unknown argument/);
  assert.equal(verdictOf({ state: "completed", failed: false, diff: true, operations: 0, skipped: 0 }), "proposed_nothing");
  assert.equal(verdictOf({ state: "completed", failed: false, diff: true, operations: 0, skipped: 2 }), "only_skipped");
  assert.equal(verdictOf({ state: "completed", failed: false, diff: true, operations: 1, skipped: 2 }), "wrote_and_skipped");
  assert.equal(verdictOf({ state: "pending", failed: true, diff: false, operations: 0, skipped: 0 }), "failed");
  assert.equal(verdictOf({ state: "pending", failed: false, diff: false, operations: 0, skipped: 0 }), "no_diff_yet");
  const shape = messageShape(['{"role":"user","parts":[{"type":"text","text":"hello there"}]}', '{"role":"assistant","content":"hi"}', "not json"].join("\n"));
  assert.deepEqual(shape, { total: 2, user: 1, assistant: 1, userCharacters: 11 });
  assert.equal(messageShape(null), null);
});

test("a commit that wrote nothing is told apart from one the engine refused, on the ledger row and in the counters", options, async (t) => {
  const refuse = [{ reason_code: "memory_type_filtered", memory_type: "events", text: "a person's words that must not be kept" }];
  /** @type {{ skipped: any[], adds: any[] }} */
  const next = { skipped: [], adds: [] };
  const { userId, worker, overlay, stub, commitConversation, engineUser } = await fixture(t, { extract: () => ({ adds: next.adds, skipped: next.skipped }) });
  const talk = [{ role: "user", text: "Please summarise the attached protocol in 200 words." }, { role: "assistant", text: "Here is the summary." }];

  // 1. The model proposed nothing at all.
  const nothing = await commitConversation("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", talk);
  // 2. Everything it proposed was refused.
  next.skipped = refuse;
  const refused = await commitConversation("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", talk);
  // 3. One file written, one refused.
  next.skipped = refuse;
  next.adds = [{ uri: `viking://user/${engineUser}/memories/preferences/length.md`, memory_type: "preferences", after: "Summaries in about 200 words." }];
  const mixed = await commitConversation("cccccccccccccccccccccccccccccccc", talk);
  assert.equal(await worker.processCommits({ userId }), 3);

  const row = async (committed) => overlay.commit(userId, committed.archive_uri);
  assert.equal((await row(nothing)).state, "completed");
  const proposedNothing = (await row(nothing)).extraction;
  assert.deepEqual({ ...proposedNothing, memoryTypes: null }, { skipped: 0, skipReasons: {}, extracted: {}, memoryTypes: null, fromTask: true });
  assert.ok(proposedNothing.memoryTypes.includes("preferences"), "the types the engine allowed are kept");
  assert.equal((await row(refused)).extraction.skipped, 1);
  assert.deepEqual((await row(refused)).extraction.skipReasons, { memory_type_filtered: 1 });
  assert.equal((await row(refused)).operations, 0);
  // A commit that wrote a file has its operations on the row and its task is not asked about: the diff is the account of it.
  assert.deepEqual((await row(mixed)).extraction.extracted, {});
  assert.equal((await row(mixed)).extraction.fromTask, false);
  assert.equal((await row(mixed)).operations, 1);
  assert.ok(!JSON.stringify([await row(nothing), await row(refused), await row(mixed)]).includes("must not be kept"), "no text of a skipped operation reaches the ledger");

  const counters = nativeMemoryCounters();
  assert.deepEqual(counters.extractionOutcomes, { wrote: 0, wrote_and_skipped: 1, only_skipped: 1, proposed_nothing: 1 });
  assert.equal(counters.skippedOperations.memory_type_filtered, 2);
  assert.equal(counters.workerCommits.empty, 2);
  assert.equal(counters.workerCommits.ingested, 1);
  // The task is asked about only when the diff is empty: two of the three commits.
  assert.equal(stub.sent("GET", "/api/v1/tasks/").length, 2);
  assert.ok(await overlay.commitsOf(userId, { limit: 10 }).then((rows) => rows.length === 3));
});

test("a task the engine no longer keeps leaves the diff's own account, and a failure to read it never fails the commit", options, async (t) => {
  const { userId, worker, overlay, stub, commitConversation } = await fixture(t, { extract: () => ({ skipped: [{ reason_code: "ambiguous_target" }] }) });
  const committed = await commitConversation("dddddddddddddddddddddddddddddddd", [{ role: "user", text: "A question with nothing to remember." }]);
  stub.tasks.delete(committed.task_id);
  assert.equal(await worker.processCommits({ userId }), 1);
  const row = await overlay.commit(userId, committed.archive_uri);
  assert.equal(row.state, "completed");
  assert.deepEqual(row.extraction.skipReasons, { ambiguous_target: 1 });
  assert.equal(row.extraction.fromTask, false);
});

test("the report reads each commit off the engine's archives, ledger or not, and a backfill fills only what is missing", options, async (t) => {
  /** @type {any} */
  let outcome = {};
  const { userId, worker, overlay, sessions, stub, commitConversation, engineUser, database } = await fixture(t, { extract: () => outcome });
  const deps = { overlay, sessions, extractionFacts, parseArchiveUri, nativeMemoryFile };
  // A commit the ledger settled before it kept extraction (the owner's two of 10-19): completed, nothing recorded.
  outcome = { skipped: [{ reason_code: "memory_type_filtered", memory_type: "events" }] };
  const old = await commitConversation("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", [
    { role: "user", text: "Compare the two dosing schedules for me." }, { role: "assistant", text: "Here is the comparison." }, { role: "user", text: "Make it a table." }]);
  assert.equal(await worker.processCommits({ userId }), 1);
  await database.query("UPDATE evimed_memory.native_commits SET extraction='{}'::jsonb WHERE user_id=$1", [userId]);
  // A commit the engine made by itself that the control plane never saw, which wrote a file.
  outcome = { adds: [{ uri: `viking://user/${engineUser}/memories/preferences/tables.md`, memory_type: "preferences", after: "Prefers tables." }] };
  const session = "dsh-session_ffffffffffffffffffffffffffffffff";
  stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, archives: 0, commitCount: 0, messages: [{ role: "user", parts: [{ type: "text", text: "I like tables." }] }] });
  stub.commitSession(engineUser, session);

  const report = await commitReport(deps, { user: userId, limit: 10 });
  assert.equal(report.archives, 2);
  assert.equal(report.considered, 2);
  assert.deepEqual(report.totals, { only_skipped: 1, wrote: 1 });
  const refused = report.commits.find((commit) => commit.verdict === "only_skipped");
  assert.deepEqual(refused.skipReasons, { memory_type_filtered: 1 });
  assert.equal(refused.operations, 0);
  assert.equal(refused.task, "read");
  assert.equal(refused.ledger.recorded, false, "the ledger row has no extraction yet");
  assert.deepEqual(refused.messages, { total: 3, user: 2, assistant: 1, userCharacters: "Compare the two dosing schedules for me.".length + "Make it a table.".length });
  const wrote = report.commits.find((commit) => commit.verdict === "wrote");
  assert.equal(wrote.ledger, null, "an idle commit is read from the engine alone");
  assert.deepEqual(wrote.files, [{ change: "added", type: "preferences", file: "preferences/tables.md" }]);
  const text = JSON.stringify(report);
  assert.ok(!text.includes("dosing") && !text.includes("Prefers tables"), "no message and no memory text is printed");
  assert.match(renderText(report), /only_skipped.*memory_type_filtered×1/);
  assert.equal((await overlay.commit(userId, old.archive_uri)).extraction.skipped ?? 0, 0, "a plain report writes nothing");

  const filled = await commitReport(deps, { user: userId, backfill: true });
  assert.equal(filled.commits.filter((commit) => commit.backfilled).length, 1);
  assert.deepEqual((await overlay.commit(userId, old.archive_uri)).extraction.skipReasons, { memory_type_filtered: 1 });
  const again = await commitReport(deps, { user: userId, backfill: true });
  assert.equal(again.commits.filter((commit) => commit.backfilled).length, 0, "a row that has it is left alone");
  assert.equal(again.commits.find((commit) => commit.verdict === "only_skipped").ledger.recorded, true);
  // Since: only commits from then on.
  const none = await commitReport(deps, { user: userId, since: "2999-01-01" });
  assert.equal(none.commits.length, 0);
});
