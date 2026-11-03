// What every account's runs say about one official method body, folded into the platform's record of it (`OfficialPacks.recordApplied`),
// against an in-memory ledger: the record is bounded and a run is counted once ever, and a body every account is given is stopped only on
// corrections from two accounts up to the harm boundary. The end-to-end shelf, on a real PostgreSQL, is `officialPacks.integration.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_PUBLISHER_USER_ID, methodHarmTest } from "@evimed/domain";

import { OfficialPacks } from "../src/officialPacks.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const KEY = "official:review:pooling";
const SHA = "f".repeat(64);
const RECORD = `official-method:review:pooling:${SHA.slice(0, 12)}`;
const START = Date.parse("2026-11-01T00:00:00.000Z");

function packs() {
  const documents = productDocumentsDouble();
  let clock = START + 400 * 60_000;
  /** @type {string[]} */ const reports = [];
  const official = new OfficialPacks({ documents: /** @type {any} */ (documents), database: { query: async () => ({ rows: [] }) },
    transfers: /** @type {any} */ (null), scanner: /** @type {any} */ (null), now: () => new Date(clock), report: (line) => reports.push(line) });
  /** One reaction, a minute after the one before it, by an account, to a run that began a minute earlier. @param {number} minute @param {"corrected" | "clean"} outcome @param {string} userId */
  const react = (minute, outcome, userId) => official.recordApplied({ key: KEY, sha: SHA, runId: `run_${minute}`, outcome, userId,
    at: new Date(START + minute * 60_000).toISOString(), since: new Date(START + (minute - 1) * 60_000).toISOString() });
  const record = async () => (await documents.get(PLATFORM_PUBLISHER_USER_ID, "preferences", RECORD))?.payload;
  return { official, react, record, reports, advance: (/** @type {number} */ ms) => { clock += ms; } };
}

test("one account's corrections, however many, and a second account's one long after, do not stop a body every account is given", async () => {
  // Review of 2026-11-03: the stop read `harm`, reached once and carried for good, beside a list of every account that ever corrected the
  // body, so account A's four early corrections, five hundred clean runs and one correction by account B stopped it for everyone.
  const f = packs();
  for (let minute = 0; minute < 4; minute += 1) assert.deepEqual(await f.react(minute, "corrected", "acct_a"), { changed: true, stopped: false });
  for (let minute = 4; minute < 504; minute += 1) assert.equal((await f.react(minute, "clean", minute % 2 ? "acct_a" : "acct_c")).stopped, false);
  assert.deepEqual(await f.react(504, "corrected", "acct_b"), { changed: true, stopped: false });
  const held = await f.record();
  assert.equal(held.status, "active");
  assert.equal(held.correctedBy, undefined, "the list the stop used to read is not kept");
  const read = methodHarmTest(held.learning, { minAccounts: 2 });
  assert.deepEqual([read.state, read.runs, read.bad], ["clear", 505, 5], "the whole record is read: 505 runs, though the record keeps 200");
  assert.ok(held.learning.observations.length <= 200);
  assert.ok(held.learning.observations.every((/** @type {any} */ observation) => /^[a-f0-9]{16}$/.test(observation.by)), "each reaction carries its account's one-way key");
});

test("corrections from two accounts while the sum is up stop the body, with the run they were stopped at, and a restore is not undone by the same runs", async () => {
  const f = packs();
  for (let minute = 0; minute < 4; minute += 1) assert.deepEqual(await f.react(minute, "corrected", "acct_a"), { changed: true, stopped: false });
  assert.deepEqual(await f.react(4, "corrected", "acct_b"), { changed: true, stopped: true });
  const stopped = await f.record();
  assert.deepEqual([stopped.status, stopped.stopped.reason, stopped.stopped.runs, stopped.stopped.bad], ["stopped", "harm", 5, 5]);
  assert.equal(f.official.stats().stopped, 1);
  assert.deepEqual(await f.react(5, "clean", "acct_c"), { changed: false, stopped: true }, "nothing more is counted for a stopped body");
  // Given back, counted from nothing: the hourly settlement reads its window again, and the corrections that stopped it are not read back.
  f.advance(60_000);
  assert.equal(await f.official.restore(KEY, SHA), true);
  for (let minute = 0; minute < 5; minute += 1) assert.deepEqual(await f.react(minute, "corrected", minute < 4 ? "acct_a" : "acct_b"), { changed: false, stopped: false });
  const restored = await f.record();
  assert.deepEqual([restored.status, methodHarmTest(restored.learning, { minAccounts: 2 }).runs], ["active", 0]);
  // A run that began after the restore is counted.
  assert.deepEqual(await f.react(500, "clean", "acct_c"), { changed: true, stopped: false });
  assert.equal(methodHarmTest((await f.record()).learning, { minAccounts: 2 }).runs, 1);
});

test("a run the bounded record let go of is not counted again when the settlement reads it a second time", async () => {
  const f = packs();
  for (let minute = 0; minute < 300; minute += 1) await f.react(minute, minute % 4 ? "clean" : "corrected", `acct_${minute % 7}`);
  const once = await f.record();
  assert.equal(once.learning.observations.length, 200, "no window was given, so the record is kept to 200");
  for (let minute = 0; minute < 300; minute += 1) assert.equal((await f.react(minute, "clean", `acct_${minute % 7}`)).changed, false, `run_${minute} again`);
  const twice = await f.record();
  assert.deepEqual(twice.learning, once.learning);
  const read = methodHarmTest(twice.learning, { minAccounts: 2 });
  assert.deepEqual([read.runs, read.bad, twice.learning.counts.appliedClean, twice.learning.counts.appliedCorrected], [300, 75, 225, 75]);
});
