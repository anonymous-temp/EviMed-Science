// A rewritten method, replayed against the runs the person already accepted (Designer-RSI's replay gate, without the gate: nothing waits).
//
// The method ledger is the real `LearningService` over the in-memory product store, so a rollback here is the one Postgres would make; only
// the model call, the accepted-run query and the trajectory reader are stubbed. What is asserted is what the job wrote, what it counted, and
// that a judge which fails, or a quotation that is not there, changes nothing.
import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, trajectoryDigest } from "@evimed/domain";

import { LearningService, effectiveStatusReason, learnedMethodId } from "../src/learningService.mjs";
import { LearningMetrics, learningMetricFamilies } from "../src/learningMetrics.mjs";
import {
  MethodReplay, MethodReplayJudge, REPLAY_MAX_RUNS, REPLAY_REGRESSION_AT, createTrajectoryReader, methodReplayText, replayVerdictFrom, trajectoryReplayText,
} from "../src/methodReplay.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const NOW = new Date("2026-10-25T10:00:00.000Z");

/** @param {string} extra @param {string} [purpose] */
const sections = (extra = "", purpose = "Do a thing.") => [
  "## Purpose", purpose, "",
  "## When to Use", "When needed.", "",
  "## Inputs", "An input.", "",
  "## Workflow", "1. Do it.", "",
  "## Verification", "- The quote still matches its source.", "",
  "## Constraints", "- Never widen a claim.", extra, "",
  "## Output", "The thing.",
].join("\n");

/** @param {string} name */
const frontmatter = (name) => ({
  name,
  description: `A method about ${name}, written for the tests.`,
  whenToUse: `When ${name} comes up.`,
  metadata: { role: "functional", applies_when: `${name} exists.`, not_when: "It does not.", derived_from: "run:run_1", evimed_schema: METHOD_SKILL_SCHEMA },
});

/** The digest of one accepted run, as `trajectoryDigest` makes it from a transcript with one request. */
const accepted = (/** @type {string} */ request, /** @type {string[]} */ tools = ["web_search"]) => trajectoryDigest({
  messages: [
    { sessionId: "s", role: "user", source: "user", seq: 1, turn: 1, turnStartSeq: 1, parts: [{ type: "text", text: request }] },
    ...tools.map((tool, index) => ({ sessionId: "s", role: "assistant", source: "user", seq: 2 + index, turn: 1, turnStartSeq: 1, parts: [{ type: "tool", tool, status: "completed", input: {}, output: "ok" }] })),
  ],
}, { id: "r", sessionId: "s", status: "succeeded", outputFiles: ["report/weekly.md"] }, { shapes: { "report/weekly.md": { format: "md", labels: ["Summary", "Findings"] } } });

/**
 * The replay over a real ledger. `accepted` are the runs the evidence ledger would hand back, `requests` what each of them asked, and `answer(run)` what
 * the judge says about one of them (a string is the model's text; null is a call that failed).
 * @param {{ runs?: string[], answer?: (runId: string, shown: { methodText: string, runText: string }) => string | null, enabled?: boolean, available?: boolean }} [options]
 */
function harness({ runs = ["run_a", "run_b", "run_c"], answer = () => JSON.stringify({ contradicts: false, methodQuote: null, runQuote: null }), enabled = true } = {}) {
  const documents = productDocumentsDouble();
  const learning = new LearningService({ documents, now: () => NOW });
  /** @type {any[]} */ const windows = [];
  /** @type {any[]} */ const judged = [];
  const metrics = new LearningMetrics();
  const feedback = { cleanSettledRuns: async (/** @type {string} */ _userId, /** @type {any} */ window) => { windows.push(window); return runs.map((runId, index) => ({ runId, projectId: "p1", at: `2026-10-2${index}T00:00:00.000Z`, endedAt: `2026-10-2${index}T00:00:00.000Z`, shape: [] })); } };
  const replay = new MethodReplay({
    learning, feedback,
    readTrajectory: async (_userId, run) => accepted(`Asked by ${run.runId}: a weekly report in three sections`),
    judge: { available: true, read: async (shown, owner) => { judged.push({ ...owner, ...shown }); return answer(owner.runId, shown); } },
    enabled: async () => enabled,
    onOutcome: (outcome) => metrics.observeReplayOutcome(outcome),
    onVerdict: (verdict) => metrics.observeReplayVerdict(verdict),
    onStopped: (code) => metrics.observeRetirement(code),
    now: () => NOW,
  });
  /** @param {string} name @param {string} [body] @param {any} [input] */
  const make = (name, body = sections(), input = {}) => learning.createCandidate("u1", { projectId: "p1", frontmatter: frontmatter(name), body, provenance: { origin: "inferred", runId: "run_1", scope: "conversation" }, ...input });
  /** @param {any} document @param {string} body */
  const amend = (document, body) => learning.amendMethod("u1", document.id, { expectedRevision: document.revision, frontmatter: frontmatter(document.payload.frontmatter.name), body });
  /** @param {any} payload */
  const run = (payload) => replay.run({ job: { id: "job_replay", userId: "u1", projectId: "p_learning", payload: { action: "replay", ...payload } } });
  return { documents, learning, replay, metrics, windows, judged, make, amend, run };
}

/** An answer that contradicts, grounded in what the judge was shown: the method's own quoted line and the run's own quoted request. */
const contradiction = (/** @type {string} */ methodQuote, /** @type {string} */ runQuote) => JSON.stringify({ contradicts: true, methodQuote, runQuote });

test("a verdict is grounded in code: both quotations are substrings of what the judge was shown, white space folded, of a length a quotation has", () => {
  const shown = { methodText: "name: report\n\n## Workflow\n1. Always\n   write ten sections.", runText: "asked: a weekly report in three sections\nleft: report/weekly.md (md)" };
  assert.deepEqual(replayVerdictFrom(JSON.stringify({ contradicts: false }), shown), { verdict: "agreed" });
  assert.deepEqual(replayVerdictFrom(contradiction("Always write ten sections", "a weekly report in three sections"), shown),
    { verdict: "contradiction", methodQuote: "Always write ten sections", runQuote: "a weekly report in three sections" }, "a quotation spanning a line break still matches");
  assert.deepEqual(replayVerdictFrom(contradiction("Always write twenty sections", "a weekly report in three sections"), shown), { verdict: "unverified", reason: "quote_not_found" });
  assert.deepEqual(replayVerdictFrom(contradiction("Always write ten sections", "something the run never said"), shown), { verdict: "unverified", reason: "quote_not_found" });
  assert.deepEqual(replayVerdictFrom(contradiction("ten", "three sections"), shown), { verdict: "unverified", reason: "quote_length" }, "a word is not a quotation");
  assert.deepEqual(replayVerdictFrom(JSON.stringify({ contradicts: true, methodQuote: null, runQuote: null }), shown), { verdict: "unverified", reason: "quote_length" });
  for (const bad of [null, "", "not json", JSON.stringify({ contradicts: "true" }), JSON.stringify({ verdict: "contradiction" }), JSON.stringify([1])]) {
    assert.equal(replayVerdictFrom(bad, shown).verdict, "failed", String(bad));
  }
  assert.equal(replayVerdictFrom(`\`\`\`json\n${contradiction("Always write ten sections", "a weekly report in three sections")}\n\`\`\``, shown).verdict, "contradiction", "a fenced answer is read");
});

test("what the judge is shown is the method's own text and the run as text: the requests, what it left with its structure, the tools in order", async () => {
  const h = harness();
  const method = await h.make("weekly-report", sections("- Always write ten sections."));
  const text = methodReplayText(method);
  assert.match(text, /name: weekly report/);
  assert.match(text, /Always write ten sections/);
  assert.match(text, /when to use: When weekly-report comes up/);
  const runText = trajectoryReplayText(accepted("a weekly report in three sections", ["web_search", "read"]));
  assert.match(runText, /^asked: a weekly report in three sections$/m);
  assert.match(runText, /^left: report\/weekly\.md \(md\) with sections summary; findings$/m);
  assert.match(runText, /^tools, in order: web_search, read$/m);
});

test("two grounded contradictions take the newer version out and give the earlier body back, restorably, with what was found said in plain words", async () => {
  const h = harness({
    answer: (runId) => runId === "run_c" ? JSON.stringify({ contradicts: false }) : contradiction("Always write ten sections", "a weekly report in three sections"),
  });
  const original = await h.make("weekly-report");
  const newer = await h.amend(original, sections("- Always write ten sections."));
  assert.notEqual(newer.payload.contentDigest, original.payload.contentDigest);
  const result = await h.run({ methodId: newer.id, digest: newer.payload.contentDigest, previousDigest: original.payload.contentDigest });
  assert.deepEqual([result.outcome, result.reason, result.restored, result.replayed, result.contradictions], ["regressed", "replay_regressed", "rollback", 3, 2]);
  assert.equal(result.found.length, 2);
  const after = await h.learning.getMethod("u1", newer.id);
  assert.equal(after.payload.contentDigest, original.payload.contentDigest, "the earlier body is the one in force");
  assert.equal(after.payload.status, "approved");
  assert.match(after.payload.statusReason, /较新的一版和你之前认可过的工作对不上（核对了 3 次，其中 2 次冲突），已回到这一版/);
  assert.equal(after.payload.links.at(-1).type, "rolled_back_for_replay");
  assert.equal(after.payload.links.at(-1).fromDigest, newer.payload.contentDigest);
  assert.equal(after.payload.links.at(-1).toDigest, original.payload.contentDigest);
  assert.equal(effectiveStatusReason(after.payload), after.payload.statusReason, "said from the record, so it stays true");
  // The newer body is in the history, one click away.
  const versions = await h.learning.history("u1", newer.id);
  assert.ok(versions.some((version) => version.contentDigest === newer.payload.contentDigest));
  const restored = await h.learning.rollback("u1", newer.id, { expectedRevision: after.revision, targetDigest: newer.payload.contentDigest });
  assert.equal(restored.payload.contentDigest, newer.payload.contentDigest);
  assert.deepEqual([h.metrics.replayOutcomes.regressed, h.metrics.replayVerdicts.contradiction, h.metrics.replayVerdicts.agreed, h.metrics.retirements.replay_regressed], [1, 2, 1, 1]);
});

test("one contradiction, or contradictions whose quotations are not in what the judge was shown, change nothing", async () => {
  const one = harness({ answer: (runId) => runId === "run_a" ? contradiction("Always write ten sections", "a weekly report in three sections") : JSON.stringify({ contradicts: false }) });
  const original = await one.make("weekly-report");
  const newer = await one.amend(original, sections("- Always write ten sections."));
  const clean = await one.run({ methodId: newer.id, digest: newer.payload.contentDigest, previousDigest: original.payload.contentDigest });
  assert.deepEqual([clean.outcome, clean.contradictions], ["clean", 1]);
  assert.equal((await one.learning.getMethod("u1", newer.id)).payload.contentDigest, newer.payload.contentDigest);
  assert.ok(REPLAY_REGRESSION_AT >= 2, "one disagreement is not a regression");

  const invented = harness({ answer: () => contradiction("a rule the method never states", "a request nobody made") });
  const base = await invented.make("weekly-report");
  const changed = await invented.amend(base, sections("- Always write ten sections."));
  const result = await invented.run({ methodId: changed.id, digest: changed.payload.contentDigest, previousDigest: base.payload.contentDigest });
  assert.deepEqual([result.outcome, result.contradictions, result.replayed], ["clean", 0, 3]);
  assert.equal((await invented.learning.getMethod("u1", changed.id)).payload.contentDigest, changed.payload.contentDigest, "the model's word that it was quoting is not evidence");
  assert.equal(invented.metrics.replayVerdicts.unverified, 3);
  assert.equal(invented.metrics.replayOutcomes.regressed, 0);
});

test("a judge that fails changes nothing and is counted; the runs it did read still count", async () => {
  const none = harness({ answer: () => null });
  const original = await none.make("weekly-report");
  const newer = await none.amend(original, sections("- Always write ten sections."));
  const result = await none.run({ methodId: newer.id, digest: newer.payload.contentDigest, previousDigest: original.payload.contentDigest });
  assert.deepEqual([result.outcome, result.failed, result.replayed], ["judge_failed", 3, 0]);
  assert.equal((await none.learning.getMethod("u1", newer.id)).payload.contentDigest, newer.payload.contentDigest);
  assert.equal(none.metrics.replayVerdicts.failed, 3);

  // Two of three calls fail and the third reads clean: the job is clean, not failed.
  let calls = 0;
  const some = harness({ answer: () => (++calls === 1 ? JSON.stringify({ contradicts: false }) : null) });
  const base = await some.make("weekly-report");
  const changed = await some.amend(base, sections("- Always write ten sections."));
  const partial = await some.run({ methodId: changed.id, digest: changed.payload.contentDigest, previousDigest: base.payload.contentDigest });
  assert.deepEqual([partial.outcome, partial.replayed, partial.failed], ["clean", 1, 2]);
});

test("a method with no earlier body, a merge the pass just built, is stopped instead, its reason written, and one click gives it back", async () => {
  const h = harness({ answer: () => contradiction("Always write ten sections", "a weekly report in three sections") });
  const merged = await h.make("merged-report", sections("- Always write ten sections."));
  const result = await h.run({ methodId: merged.id, digest: merged.payload.contentDigest });
  assert.deepEqual([result.outcome, result.restored, result.reason], ["regressed", "retire", "replay_regressed"]);
  const stopped = await h.learning.getMethod("u1", merged.id);
  assert.equal(stopped.payload.status, "retired");
  assert.match(stopped.payload.statusReason, /它和你之前认可过的工作对不上（核对了 3 次，其中 3 次冲突），已先停用。觉得不对，可以在「记忆胶囊」里这条做法上点「回到上一版」恢复。/);
  assert.equal(stopped.payload.links.at(-1).type, "retired_for_replay");
  const restored = await h.learning.rollback("u1", merged.id, { expectedRevision: stopped.revision, targetRevision: stopped.revision });
  assert.equal(restored.payload.status, "approved");
  assert.equal(h.metrics.retirements.replay_regressed, 1);
});

test("it reads up to five accepted runs of the method's own scope, newest first, from the last ninety days", async () => {
  const h = harness({ runs: ["run_1", "run_2", "run_3", "run_4", "run_5", "run_6", "run_7"] });
  const scoped = await h.make("meta-step", sections(), { provenance: { origin: "inferred", runId: "run_1", scope: "meta-analysis" } });
  const changed = await h.amend(scoped, sections("- Another rule."));
  await h.run({ methodId: changed.id, digest: changed.payload.contentDigest, previousDigest: scoped.payload.contentDigest });
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].scope, "meta-analysis");
  assert.equal(h.windows[0].limit, REPLAY_MAX_RUNS);
  assert.equal(Math.round((h.windows[0].to.getTime() - h.windows[0].from.getTime()) / 86_400_000), 90);
  assert.equal(h.judged.length, REPLAY_MAX_RUNS, "never more than five calls, whatever the ledger returned");
  assert.deepEqual(h.judged.map((entry) => entry.runId), ["run_7", "run_6", "run_5", "run_4", "run_3"], "the most recent first");
  assert.ok(h.judged.every((entry) => entry.projectId === "p_learning" && entry.methodText.includes("meta step")));
  // A method that declares no scope is replayed against the conversation's.
  const plain = harness();
  const bare = await plain.make("no-scope", sections(), { provenance: { origin: "inferred", runId: "run_1" } });
  const bareChanged = await plain.amend(bare, sections("- Another rule."));
  await plain.run({ methodId: bareChanged.id, digest: bareChanged.payload.contentDigest, previousDigest: bare.payload.contentDigest });
  assert.equal(plain.windows[0].scope, "conversation");
});

test("nothing to replay against, a method amended again, stopped, deleted, or a person who paused learning: the job ends saying so and changes nothing", async () => {
  const empty = harness({ runs: [] });
  const original = await empty.make("weekly-report");
  const newer = await empty.amend(original, sections("- Always write ten sections."));
  assert.equal((await empty.run({ methodId: newer.id, digest: newer.payload.contentDigest, previousDigest: original.payload.contentDigest })).outcome, "no_runs");
  assert.equal(empty.judged.length, 0);

  const h = harness({ answer: () => contradiction("Always write ten sections", "a weekly report in three sections") });
  const base = await h.make("weekly-report");
  const first = await h.amend(base, sections("- Always write ten sections."));
  const second = await h.amend(first, sections("- Always write twelve sections."));
  const stale = await h.run({ methodId: second.id, digest: first.payload.contentDigest, previousDigest: base.payload.contentDigest });
  assert.equal(stale.outcome, "version_changed", "the newer body has a job of its own");
  assert.equal(h.judged.length, 0);
  assert.equal((await h.run({ methodId: "method:learned:gone", digest: "sha256:x" })).outcome, "method_gone");
  const retired = await h.learning.retire("u1", second.id, { expectedRevision: second.revision, reason: "你自己停用了它。" });
  assert.equal((await h.run({ methodId: retired.id, digest: retired.payload.contentDigest, previousDigest: first.payload.contentDigest })).outcome, "not_in_force");

  const paused = harness({ enabled: false, answer: () => contradiction("Always write ten sections", "a weekly report in three sections") });
  const pausedBase = await paused.make("weekly-report");
  const pausedNew = await paused.amend(pausedBase, sections("- Always write ten sections."));
  assert.equal((await paused.run({ methodId: pausedNew.id, digest: pausedNew.payload.contentDigest, previousDigest: pausedBase.payload.contentDigest })).outcome, "paused");
  assert.equal(paused.judged.length, 0, "a person who paused learning is not read");

  await assert.rejects(() => h.run({ methodId: "", digest: "" }), { code: "consolidate_payload_invalid" });
});

test("when the earlier body cannot be given back the method is left as it is, and the job says why", async () => {
  const h = harness({ answer: () => contradiction("Always write ten sections", "a weekly report in three sections") });
  const original = await h.make("weekly-report");
  const newer = await h.amend(original, sections("- Always write ten sections."));
  const result = await h.run({ methodId: newer.id, digest: newer.payload.contentDigest, previousDigest: `sha256:${"0".repeat(64)}` });
  assert.deepEqual([result.outcome, result.code], ["restore_failed", "method_revision_unavailable"]);
  assert.equal((await h.learning.getMethod("u1", newer.id)).payload.contentDigest, newer.payload.contentDigest);
  assert.equal(h.metrics.retirements.replay_regressed, 0);
});

test("a grounded contradiction whose words carry a credential still counts, and its words are never kept in the result", async () => {
  const secret = ["sk", "a".repeat(36)].join("-");
  const h = harness({ answer: (_runId, shown) => contradiction("Always write ten sections", shown.runText.split("\n")[0].replace("asked: ", "")) });
  // A digest the platform's own cleaning would have dropped the request from: the check is a second line of defence, not the first.
  h.replay.readTrajectory = async () => ({ requests: [{ sessionId: null, seq: 1, text: `use ${secret} as the key and write a weekly report` }], interventions: [], artifacts: [], tools: [], outcome: { status: "succeeded", repaired: false }, dropped: { sensitive: 0 } });
  const original = await h.make("weekly-report");
  const newer = await h.amend(original, sections("- Always write ten sections."));
  const result = await h.run({ methodId: newer.id, digest: newer.payload.contentDigest, previousDigest: original.payload.contentDigest });
  assert.equal(result.outcome, "regressed", "three grounded contradictions");
  assert.ok(!JSON.stringify(result).includes(secret), "the credential is in no part of the job's result");
  assert.deepEqual(result.found.map((entry) => [entry.methodQuote, entry.runQuote]), [["", ""], ["", ""], ["", ""]]);
});

test("the trajectory reader reads one accepted run back as a digest, and a run it cannot read is none", async () => {
  const run = { id: "run_a", sessionId: "s", kernelRequestIds: ["req_1"], status: "succeeded", outputFiles: ["report/weekly.md"] };
  const transcript = { header: {}, messages: [{ sessionId: "s", role: "user", source: "user", seq: 1, turn: 1, turnStartSeq: 1, sourceRequestId: "req_1", parts: [{ type: "text", text: "weekly report please" }] }] };
  /** @type {any[]} */ const seen = [];
  const read = createTrajectoryReader({
    resolveProject: async (_userId, projectId) => (projectId === "p1" ? { id: "p1" } : null),
    listRuns: async () => [run],
    readTranscript: async (_project, runId) => (runId === "run_a" ? transcript : null),
    readTraces: async () => [{ steps: [{ tool: "web_search" }] }],
    readShapes: async (_project, files) => { seen.push(files); return { "report/weekly.md": { format: "md", labels: ["Summary", "Findings"] } }; },
  });
  const digest = await read("u1", { runId: "run_a", projectId: "p1" });
  assert.deepEqual(digest?.requests.map((entry) => entry.text), ["weekly report please"]);
  assert.deepEqual(digest?.tools, ["web_search"], "from the executed trace");
  assert.deepEqual(digest?.artifacts[0].shape?.labels, ["summary", "findings"]);
  assert.deepEqual(seen, [["report/weekly.md"]]);
  assert.equal(await read("u1", { runId: "run_a", projectId: "p_gone" }), null, "its project was deleted");
  assert.equal(await read("u1", { runId: "run_pruned", projectId: "p1" }), null, "no run record, no transcript");
  assert.equal(await read("u1", { runId: "run_a", projectId: null }), null);
});

test("the judge is one small call through the control plane's gateway, reads nothing without a key, and never throws", async () => {
  /** @type {any[]} */ const calls = [];
  const config = { deepseekProviderEnabled: true, deepseekApiKey: "k", deepseekModel: "deepseek-flash", modelGatewayTimeoutMs: 5000 };
  const judge = new MethodReplayJudge(config, { callModel: async (_deps, call) => { calls.push(call); return { choices: [{ message: { content: "{\"contradicts\":false}" } }] }; } });
  assert.equal(await judge.read({ methodText: "m", runText: "r" }, { userId: "u1", projectId: "p", runId: "run_a" }), "{\"contradicts\":false}");
  assert.equal(calls[0].purpose, "learning");
  assert.equal(calls[0].body.thinking.type, "disabled");
  assert.deepEqual(JSON.parse(calls[0].body.messages[1].content), { method: "m", run: "r" });
  assert.equal(await new MethodReplayJudge({ ...config, deepseekApiKey: "" }).read({ methodText: "m", runText: "r" }, { userId: "u1", projectId: "p", runId: "run_a" }), null);
  const broken = new MethodReplayJudge(config, { callModel: async () => { throw Object.assign(new Error("down"), { code: "upstream_unavailable" }); } });
  assert.equal(await broken.read({ methodText: "m", runText: "r" }, { userId: "u1", projectId: "p", runId: "run_a" }), null);
});

test("the replay counters have a closed vocabulary and appear on the scrape", () => {
  const metrics = new LearningMetrics();
  metrics.observeReplayOutcome("regressed");
  metrics.observeReplayOutcome("something-new");
  metrics.observeReplayVerdict("contradiction");
  metrics.observeReplayVerdict("something-new");
  const families = learningMetricFamilies(true, null, metrics);
  const outcomes = families.find((family) => family.name === "open_science_learning_replay_total");
  const verdicts = families.find((family) => family.name === "open_science_learning_replay_judged_total");
  assert.equal(outcomes?.series.find((entry) => entry.labels?.outcome === "regressed")?.value, 1);
  assert.equal(outcomes?.series.find((entry) => entry.labels?.outcome === "other")?.value, 1);
  assert.equal(verdicts?.series.find((entry) => entry.labels?.verdict === "contradiction")?.value, 1);
  assert.equal(verdicts?.series.find((entry) => entry.labels?.verdict === "other")?.value, 1);
  assert.ok(learningMetricFamilies(true, null, metrics).find((family) => family.name === "open_science_learning_method_retirements_total")?.series.some((entry) => entry.labels?.code === "replay_regressed"));
  assert.equal(learnedMethodId("x"), "method:learned:x");
});
