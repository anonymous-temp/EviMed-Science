// The last two stages of the sharing funnel: a run that opened a received pack's method is `applied`, and the researcher's correction of
// that run is `corrected`, each once per run and pack, by the channel the pack reached the account by (capsuleShareOutcomes.mjs).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { LEARNING_EVIDENCE_TRIGGER } from "@evimed/domain";
import { capsuleShareMetricFamilies, resetCapsuleShareMetrics } from "../src/capsuleShareMetrics.mjs";
import { createReceivedPackOutcomes, methodFilesRead } from "../src/capsuleShareOutcomes.mjs";

const funnel = () => Object.fromEntries(capsuleShareMetricFamilies().find((family) => family.name === "open_science_capsule_share_funnel_total").series
  .filter((row) => row.value > 0).map((row) => [`${row.labels.stage}/${row.labels.channel}`, row.value]));

/**
 * The account's documents as the module reads them: capsules (`imported` or its own) and the facts of each.
 * @param {{ packs: Record<string, any>[], entries: Record<string, any>[] }} store
 */
function documentsOf(store) {
  const matches = (/** @type {any} */ payload, /** @type {any} */ filter) => Object.entries(filter ?? {}).every(([key, value]) => payload[key] === value);
  return { documents: { list: async (/** @type {string} */ _user, /** @type {string} */ kind, /** @type {any} */ { filter }) => {
    const rows = kind === "capsule" ? store.packs : store.entries;
    return { items: rows.filter((row) => matches(row.payload, filter)), nextCursor: null };
  } } };
}

const pack = (id, channel, extra = {}) => ({ id, payload: { imported: true, transfer: { channel }, ...extra } });
const entry = (id, capsuleId, status = "approved") => ({ id, payload: { capsuleId, status, factKind: "method_preference" } });
/** The mounted file of an entry's method, as the model is told to open it. */
const fileOf = (id) => `/runtime/capsule-methods/${id}/SKILL.md`;
/** One session whose model opened the mounted files of these entries, with the `read` tool. */
const session = (ids, sessionId = "ses_1") => ({ sessionId, transcript: { messages: [{ role: "assistant", parts: ids.map((id) => ({ type: "tool", status: "completed", tool: "read", input: { path: fileOf(id) } })) }] } });
/** One session that ran these shell commands. */
const shell = (...commands) => ({ sessionId: "ses_1", transcript: { messages: [{ role: "assistant", parts: commands.map((command) => ({ type: "tool", status: "completed", tool: "bash", input: { command } })) }] } });
const run = (id = "run_1", extra = {}) => ({ id, sessionId: "ses_1", ...extra });
const correction = (runId, detail = { evidence: "follow-up", verdict: "correction" }) => ({ trigger: LEARNING_EVIDENCE_TRIGGER, runId, detail });

const store = {
  packs: [pack("pack-link", "link"), pack("pack-delivery", "delivery"), pack("pack-file", "file"), pack("pack-platform", "official", { official: { packId: "daily-writing" } }),
    { id: "own-capsule", payload: { imported: false } }],
  entries: [entry("e-link-1", "pack-link"), entry("e-link-2", "pack-link"), entry("e-link-retired", "pack-link", "retired"), entry("e-delivery", "pack-delivery"),
    entry("e-file", "pack-file"), entry("e-platform", "pack-platform"), entry("e-own", "own-capsule")],
};
const outcomes = () => createReceivedPackOutcomes({ capsules: documentsOf(store) });
const project = { userId: "usr_1" };

beforeEach(() => resetCapsuleShareMetrics());

test("a run that opened a received pack's method is that pack applied, once per run however many of its methods it opened", async () => {
  const packs = outcomes();
  assert.equal(await packs.afterRun({ project, run: run(), sessions: [session(["e-link-1", "e-link-2"])] }), 1);
  assert.deepEqual(funnel(), { "applied/link": 1 });
  assert.equal(await packs.afterRun({ project, run: run(), sessions: [session(["e-link-1"])] }), 0, "the same run read again is counted once");
  assert.deepEqual(funnel(), { "applied/link": 1 });
  assert.equal(await packs.afterRun({ project, run: run("run_2"), sessions: [session(["e-link-1"])] }), 1, "another run is another application");
  assert.deepEqual(funnel(), { "applied/link": 2 });
});

test("each pack is counted under the channel it reached the account by, and two packs in one run are two", async () => {
  const packs = outcomes();
  await packs.afterRun({ project, run: run(), sessions: [session(["e-delivery", "e-file", "e-link-1"])] });
  assert.deepEqual(funnel(), { "applied/delivery": 1, "applied/file": 1, "applied/link": 1 });
});

test("only what a received pack brought counts: the account's own methods, a platform pack and a method that is no longer approved count for nothing", async () => {
  const packs = outcomes();
  assert.equal(await packs.afterRun({ project, run: run("run_own"), sessions: [session(["e-own"])] }), 0);
  assert.equal(await packs.afterRun({ project, run: run("run_platform"), sessions: [session(["e-platform"])] }), 0, "the platform's own pack is no share");
  assert.equal(await packs.afterRun({ project, run: run("run_retired"), sessions: [session(["e-link-retired"])] }), 0);
  assert.equal(await packs.afterRun({ project, run: run("run_learned"), sessions: [session(["_lm0123456789abcdef0123456789abcdef"])] }), 0, "a learned method's file is no pack's");
  assert.equal(await packs.afterRun({ project, run: run("run_none"), sessions: [shell("ls /runtime/capsule-methods")] }), 0);
  assert.deepEqual(funnel(), {});
});

test("a pack's method opened in a child's session is the run's, and a failed or unfinished call is not an opening", async () => {
  const packs = outcomes();
  const failed = { sessionId: "ses_1", transcript: { messages: [{ parts: [{ type: "tool", status: "error", tool: "read", input: { path: fileOf("e-file") } }] }] } };
  assert.equal(await packs.afterRun({ project, run: run("run_failed"), sessions: [failed] }), 0);
  assert.equal(await packs.afterRun({ project, run: run("run_child"), sessions: [session([], "ses_1"), session(["e-file"], "ses_child")] }), 1);
  assert.deepEqual(funnel(), { "applied/file": 1 });
});

test("a method file is opened by a read, a search aimed at it, or a shell program that prints it, and by nothing that only looks at it", async () => {
  const packs = outcomes();
  const grep = { sessionId: "ses_1", transcript: { messages: [{ parts: [{ type: "tool", status: "completed", tool: "grep", input: { path: fileOf("e-link-1"), pattern: "x" } }] }] } };
  assert.equal(await packs.afterRun({ project, run: run("run_grep"), sessions: [grep] }), 1);
  assert.equal(await packs.afterRun({ project, run: run("run_cat"), sessions: [shell(`cat ${fileOf("e-delivery")}`)] }), 1);
  assert.equal(await packs.afterRun({ project, run: run("run_piped"), sessions: [shell(`cd /runtime/capsule-methods && sed -n 1,40p e-file/SKILL.md | head`)] }), 1);
  assert.deepEqual(funnel(), { "applied/link": 1, "applied/delivery": 1, "applied/file": 1 });
  // Listed, counted or checked is not read: `ls`, `wc`, `stat` and a `find` look at the file and do not open it.
  for (const [index, command] of [`ls -l ${fileOf("e-link-2")}`, `wc -l ${fileOf("e-link-2")}`, `stat ${fileOf("e-link-2")}`, `find /runtime/capsule-methods -name SKILL.md`].entries()) {
    assert.equal(await packs.afterRun({ project, run: run(`run_look_${index}`), sessions: [shell(command)] }), 0, command);
  }
  assert.deepEqual(funnel(), { "applied/link": 1, "applied/delivery": 1, "applied/file": 1 });
});

test("the files a session read are read off its completed tool calls only, by the directory they are in", () => {
  const read = methodFilesRead([session(["abc"]), shell("cat /runtime/capsule-methods/def/SKILL.md; ls"), shell("echo hi"),
    { sessionId: "s", transcript: { messages: [{ parts: [{ type: "tool", status: "running", tool: "read", input: { path: fileOf("running") } }, { type: "text", text: fileOf("said") }] }] } }]);
  assert.deepEqual([...read.directories], ["abc"]);
  assert.equal(read.commands.length, 1);
  assert.match(read.commands[0], /def\/SKILL\.md/);
  assert.deepEqual(methodFilesRead([]), { directories: new Set(), commands: [] });
});

test("an acceptance driver's run, a platform project and a read that fails are not counted, and never throw", async () => {
  const packs = outcomes();
  assert.equal(await packs.afterRun({ project, run: run("run_auto", { automated: true }), sessions: [session(["e-link-1"])] }), 0, "an automated run teaches and counts nothing");
  assert.equal(await packs.afterRun({ project, run: run("run_internal"), sessions: [session(["e-link-1"])], skip: true }), 0);
  const broken = createReceivedPackOutcomes({ capsules: { documents: { list: async () => { throw new Error("store down"); } } } });
  assert.equal(await broken.afterRun({ project, run: run("run_broken"), sessions: [session(["e-link-1"])] }), 0);
  assert.deepEqual(funnel(), {});
});

test("a correction of a run that applied a pack is that pack corrected, once however often the event is recorded, and only for that run", async () => {
  const packs = outcomes();
  await packs.afterRun({ project, run: run("run_a"), sessions: [session(["e-link-1"])] });
  await packs.afterRun({ project, run: run("run_b"), sessions: [session(["e-delivery"])] });
  assert.deepEqual(funnel(), { "applied/link": 1, "applied/delivery": 1 });
  packs.onEvidence(correction("run_a"));
  assert.deepEqual(funnel(), { "applied/link": 1, "applied/delivery": 1, "corrected/link": 1 });
  packs.onEvidence(correction("run_a"));
  packs.onEvidence(correction("run_a", { evidence: "steer", verdict: "correction" }));
  assert.equal(funnel()["corrected/link"], 1, "replayed or repeated, one run and pack is corrected once");
  assert.equal(funnel()["corrected/delivery"], undefined, "another run's pack is not touched");
});

test("what is not a correction is not counted: an acceptance, silence, a message about something else, another trigger, and a run no pack was applied in", async () => {
  const packs = outcomes();
  await packs.afterRun({ project, run: run("run_a"), sessions: [session(["e-link-1"])] });
  packs.onEvidence(correction("run_a", { evidence: "follow-up", verdict: "accept" }));
  packs.onEvidence(correction("run_a", { evidence: "silent" }));
  packs.onEvidence(correction("run_a", { evidence: "follow-up", verdict: "none" }));
  packs.onEvidence({ trigger: "edit_diff", runId: "run_a", detail: { evidence: "follow-up", verdict: "correction" } });
  packs.onEvidence(correction("run_without_a_pack"));
  packs.onEvidence({ trigger: LEARNING_EVIDENCE_TRIGGER, runId: null, detail: { evidence: "follow-up", verdict: "correction" } });
  packs.onEvidence(null);
  assert.deepEqual(funnel(), { "applied/link": 1 });
});

test("a correction recorded while the run was still going (a steer) and one recorded after are the same event, in either order", async () => {
  const packs = outcomes();
  packs.onEvidence(correction("run_steered", { evidence: "steer", verdict: "correction" }));
  assert.deepEqual(funnel(), {}, "a correction of a run no pack was applied in counts for nothing");
  await packs.afterRun({ project, run: run("run_steered"), sessions: [session(["e-file"])] });
  assert.deepEqual(funnel(), { "applied/file": 1, "corrected/file": 1 }, "known before the run's transcript was read, counted when the pack is");
  packs.onEvidence(correction("run_steered"));
  assert.equal(funnel()["corrected/file"], 1);
});

test("the memory is bounded: the oldest pairs are forgotten and a forgotten pair would count again, which is the price of not keeping a ledger", async () => {
  const packs = createReceivedPackOutcomes({ capsules: documentsOf(store), remembered: 2 });
  for (const id of ["run_1", "run_2", "run_3"]) await packs.afterRun({ project, run: run(id), sessions: [session(["e-link-1"])] });
  assert.equal(funnel()["applied/link"], 3);
  assert.equal(await packs.afterRun({ project, run: run("run_3"), sessions: [session(["e-link-1"])] }), 0, "a recent pair is still held");
  assert.equal(await packs.afterRun({ project, run: run("run_1"), sessions: [session(["e-link-1"])] }), 1, "the oldest was forgotten");
});
