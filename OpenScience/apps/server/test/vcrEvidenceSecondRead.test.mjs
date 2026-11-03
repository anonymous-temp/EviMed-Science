/**
 * The second, independent reading of the passage a number was read from (algorithm round E1). Tests use a stub model client: no real model is
 * called here. What they hold is the shape of the mechanism: the second reader is blind to the first reading, code compares and re-verifies,
 * an agreement is silent, a disagreement is a note with both numbers and the quotation, the first value stands, a failed reading says
 * nothing, and no card write is held longer than the stated limit.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createVcrEvidencePipeline, SECOND_READ_CARD_WAIT_MS } from "../src/vcrEvidence.mjs";
import {
  SECOND_READ_PASSAGE_MAX, SECOND_READ_WINDOW_CHARS, compareReadings, createSecondReader, secondReadPassage,
} from "../src/vcrEvidenceSecondRead.mjs";
import { createVcrEvidenceSources } from "../src/vcrEvidenceSources.mjs";

const sha = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");
const QUOTE = "Overall survival: HR 0.62 (95% CI 0.48 to 0.80), n = 500.";
const PAPER = `${"Methods paragraph. ".repeat(150)}\n${QUOTE}\n${"Discussion paragraph. ".repeat(150)}`;

test("the passage is the window of the preserved text around the quotation, found by its words, and nothing when it cannot be located", () => {
  const passage = secondReadPassage(PAPER, QUOTE);
  assert.ok(passage);
  assert.ok(passage.text.includes(QUOTE));
  assert.ok(passage.text.length <= QUOTE.length + 2 * SECOND_READ_WINDOW_CHARS);
  assert.ok(passage.start > 0 && passage.end < PAPER.length, "a window, not the paper");
  // The quotation with its whitespace changed, and with an elision: the first words locate it.
  assert.ok(secondReadPassage(PAPER, "Overall survival:\n HR 0.62   (95% CI 0.48 to 0.80), n = 500.")?.text.includes(QUOTE));
  assert.ok(secondReadPassage(PAPER, "Overall survival: HR 0.62 … n = 500.")?.text.includes(QUOTE));
  assert.equal(secondReadPassage(PAPER, "A sentence the paper does not contain"), null);
  assert.equal(secondReadPassage("", QUOTE), null);
  assert.equal(secondReadPassage(PAPER, ""), null);
  // A very long quotation keeps within the call's bound.
  const long = `${"x ".repeat(2900)}`;
  assert.ok(secondReadPassage(`a ${long} b`, long.trim())?.text.length <= SECOND_READ_PASSAGE_MAX);
});

test("two readings agree when they are the same number, written as a fraction or a percentage, and are never rounded into agreement", () => {
  const passage = `${QUOTE} Response 40% (95% CI 30% to 50%), 0.40 as a proportion.`;
  const same = compareReadings({ first: { value: 0.62, ciLow: 0.48, ciHigh: 0.8, sampleSize: 500 }, second: { value: 0.62, ciLow: 0.48, ciHigh: 0.8, sampleSize: 500 }, passage });
  assert.deepEqual([same.outcome, same.agreed, same.differs, same.message], ["agree", ["value", "ciLow", "ciHigh", "sampleSize"], [], null]);
  const share = compareReadings({ first: { value: 0.4, ciLow: 0.3, ciHigh: 0.5 }, second: { value: 40, ciLow: 30, ciHigh: 50 }, unit: "%", passage });
  assert.equal(share.outcome, "agree", "0.4 and 40 are one share when the unit is a percentage");
  const notShare = compareReadings({ first: { value: 0.4 }, second: { value: 40 }, unit: "", passage });
  assert.equal(notShare.outcome, "differ", "without a percentage unit they are two numbers");
  // 0.62 and 0.6 are different numbers; the second is in the passage here only because the passage prints it.
  const rounded = compareReadings({ first: { value: 0.62 }, second: { value: 0.6 }, passage: `${QUOTE} (0.6 in the abstract)` });
  assert.equal(rounded.outcome, "differ");
});

test("a disagreement names both numbers and the quotation, in a sentence a reader can use", () => {
  const passage = `${QUOTE} The upper limit in the abstract is 0.95.`;
  const result = compareReadings({ first: { value: 0.62, ciLow: 0.48, ciHigh: 0.8 }, second: { value: 0.62, ciLow: 0.48, ciHigh: 0.95 }, passage,
    label: "风险比", arm: "Drug vs placebo", quote: QUOTE });
  assert.equal(result.outcome, "differ");
  assert.deepEqual(result.differs, [{ field: "ciHigh", first: 0.8, second: 0.95 }]);
  assert.deepEqual(result.agreed, ["value", "ciLow"]);
  assert.match(result.message ?? "", /^风险比（Drug vs placebo）：同一段原文读了两次，结果不一致——区间上限 第一次读到 0\.8，第二次读到 0\.95。/);
  assert.match(result.message ?? "", /原文：“Overall survival: HR 0\.62 \(95% CI 0\.48 to 0\.80\), n = 500\.”/);
  assert.match(result.message ?? "", /已按第一次读到的保存/);
});

test("what only one reading carries cannot disagree, and a number that is not in the passage was not read from it", () => {
  const onlyFirst = compareReadings({ first: { value: 0.62, ciLow: 0.48 }, second: { value: 0.62, ciLow: null }, passage: QUOTE });
  assert.deepEqual([onlyFirst.outcome, onlyFirst.agreed], ["agree", ["value"]]);
  const invented = compareReadings({ first: { value: 0.62 }, second: { value: 0.71 }, passage: QUOTE });
  assert.deepEqual([invented.outcome, invented.dropped, invented.differs], ["inconclusive", ["value"], []]);
  assert.equal(compareReadings({ first: {}, second: { value: 0.62 }, passage: QUOTE }).outcome, "inconclusive");
});

/** A stub client: records the call, answers what it is told to. */
function stubClient(/** @type {(call: any) => any} */ answer) {
  /** @type {any[]} */ const calls = [];
  const callModel = async (/** @type {any} */ _deps, /** @type {any} */ call) => { calls.push(call); return answer(call); };
  return { calls, callModel };
}
const reply = (/** @type {unknown} */ content, finish = "stop") => ({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(content) } }] });
const item = { parameter: "hazard_ratio", arm: "Drug vs placebo", armRole: "contrast", endpointKey: "os", unit: "", quote: QUOTE, value: 0.62, ciLow: 0.48, ciHigh: 0.8, sampleSize: 500, detail: { outcome: "OS" } };

test("the second reader is asked what to look for and never what the first reading found; the call is Flash, purpose vcr, JSON, temperature 0", async () => {
  const { calls, callModel } = stubClient(() => reply({ found: true, value: 0.62, ciLow: 0.48, ciHigh: 0.8, sampleSize: 500, events: null }));
  const reader = createSecondReader({ config: { deepseekModel: "deepseek-flash", vcrEvidenceSecondReadTimeoutMs: 5000 }, callModel });
  assert.equal(reader.enabled, true);
  const result = await reader.check({ userId: "u1", projectId: "p1", evidenceId: "evd_1", item, sourceText: PAPER });
  assert.equal(result?.outcome, "agree");
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.deepEqual([call.userId, call.projectId, call.runId, call.purpose], ["u1", "p1", "evd_1", "vcr"]);
  assert.equal(call.body.model, "deepseek-flash");
  assert.equal(call.body.temperature, 0);
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  assert.equal(call.body.thinking.type, "disabled");
  const [system, user] = call.body.messages;
  // The question part of the request, before the passage, carries the quantity, the arm and the endpoint, and none of the first reading's numbers.
  const question = String(user.content).split("原文：")[0];
  assert.match(question, /风险比（hazard_ratio）/);
  assert.match(question, /Drug vs placebo/);
  assert.match(question, /os/);
  for (const number of ["0.62", "0.48", "0.8", "500"]) assert.ok(!question.includes(number), `the question does not tell the first reading's ${number}`);
  assert.ok(!system.content.includes("第一次"), "the instruction does not mention a first reading");
  assert.ok(String(user.content).includes(QUOTE), "the passage is the preserved text around the quotation");
});

test("nothing to read, a reading that found nothing, a model that is cut off or answers badly: nothing is concluded, and the failures are errors for the caller to count", async () => {
  const quiet = (/** @type {any} */ answer) => createSecondReader({ config: {}, callModel: stubClient(() => answer).callModel });
  assert.equal(await quiet(reply({ found: true, value: 1 })).check({ userId: "u1", evidenceId: "e", item: { ...item, quote: "not in the paper" }, sourceText: PAPER }), null, "no passage to read");
  assert.equal(await quiet(reply({ found: false, value: null })).check({ userId: "u1", evidenceId: "e", item, sourceText: PAPER }), null, "the model found nothing for the question");
  await assert.rejects(quiet(reply({ found: true, value: 0.62 }, "length")).check({ userId: "u1", evidenceId: "e", item, sourceText: PAPER }), { code: "second_read_cut_off" });
  await assert.rejects(quiet("not json").check({ userId: "u1", evidenceId: "e", item, sourceText: PAPER }).catch((error) => { throw error; }), { code: "second_read_unreadable" });
  const dead = createSecondReader({ config: {}, callModel: async () => { throw Object.assign(new Error("upstream"), { code: "model_gateway_upstream_error" }); } });
  await assert.rejects(dead.check({ userId: "u1", evidenceId: "e", item, sourceText: PAPER }), { code: "model_gateway_upstream_error" });
});

test("a count that is not a whole number is not a count, and a reading that outlives its deadline is stopped", async () => {
  const fractional = createSecondReader({ config: {}, callModel: stubClient(() => reply({ found: true, value: 0.62, sampleSize: 500.5 })).callModel });
  const result = await fractional.check({ userId: "u1", evidenceId: "e", item, sourceText: PAPER });
  assert.deepEqual(result?.second.sampleSize, null);
  const slow = createSecondReader({ config: { vcrEvidenceSecondReadTimeoutMs: 3000 }, callModel: (_deps, call) => new Promise((_resolve, reject) => {
    call.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }) });
  assert.equal(slow.timeoutMs, 3000);
  const started = Date.now();
  await assert.rejects(slow.check({ userId: "u1", evidenceId: "e", item, sourceText: PAPER }), { code: "second_read_timeout" });
  assert.ok(Date.now() - started < 6000);
}, { timeout: 15000 });

test("it can be switched off, and without a key of its own the control plane's client is not asked", async () => {
  const { calls, callModel } = stubClient(() => reply({ found: true, value: 0.62 }));
  const off = createSecondReader({ config: { vcrEvidenceSecondReadEnabled: false }, callModel });
  assert.equal(off.enabled, false);
  assert.equal(await off.check({ userId: "u1", evidenceId: "e", item, sourceText: PAPER }), null);
  assert.equal(calls.length, 0);
  assert.equal(createSecondReader({ config: {} }).enabled, false, "the real client with no key is not used");
  assert.equal(createSecondReader({ config: { deepseekApiKey: "set" } }).enabled, true);
});

test("at most three readings run at once, the rest wait their turn", async () => {
  let running = 0;
  let peak = 0;
  const releases = /** @type {Array<() => void>} */ ([]);
  const callModel = async () => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((resolve) => releases.push(() => resolve(undefined)));
    running -= 1;
    return reply({ found: true, value: 0.62 });
  };
  const reader = createSecondReader({ config: { vcrEvidenceSecondReadTimeoutMs: 30_000 }, callModel });
  const all = Array.from({ length: 7 }, (_, at) => reader.check({ userId: "u1", evidenceId: `e${at}`, item, sourceText: PAPER }));
  for (let turn = 0; turn < 20 && releases.length < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 3);
  for (let turn = 0; turn < 60 && (running > 0 || releases.length); turn += 1) { releases.shift()?.(); await new Promise((resolve) => setImmediate(resolve)); }
  await Promise.all(all);
  assert.equal(peak, 3);
});

/** A pipeline over a literature source that holds PAPER, a store that keeps what it is given, and the reader the test hands it. */
function pipelineFixture(/** @type {any} */ reader) {
  const source = { id: `src_${"e".repeat(32)}`, userId: "u1", projectId: "p1", payload: { generation: 1, analysis: { textSha256: sha(PAPER) } } };
  /** @type {any[]} */ const rows = [];
  /** @type {any[]} */ const filed = [];
  const store = {
    async appendEvidenceItems(/** @type {any} */ { items }) {
      return { ids: items.map((/** @type {any} */ entry, /** @type {number} */ at) => { const id = `ev${rows.length + at + 1}`; rows.push({ ...entry, id }); return id; }) };
    },
    async listEvidenceItems() { return []; },
    async saveSecondRead(/** @type {any} */ entry) { filed.push(entry); return true; },
    async secondReads(/** @type {any} */ { ids, outcome }) {
      return filed.filter((entry) => ids.includes(entry.evidenceId) && (!outcome || entry.outcome === outcome))
        .map((entry) => ({ evidence_id: entry.evidenceId, outcome: entry.outcome, reading: entry.reading }));
    },
  };
  const pipeline = createVcrEvidencePipeline({ store });
  pipeline.attachSources(createVcrEvidenceSources({ sources: { async get() { return source; }, async loadCapture() { return { input: { text: PAPER } }; } } }));
  if (reader) pipeline.attachSecondReader(reader);
  const write = (/** @type {Record<string, any>} */ fields = {}) => pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item: {
    literatureSource: { sourceId: source.id, generation: 1, textSha256: sha(PAPER) }, parameter: "hazard_ratio", armRole: "contrast", arm: "Drug vs placebo",
    endpointKey: "os", evidenceKind: "outcome", historicalBaseline: true, value: 0.62, ciLow: 0.48, ciHigh: 0.8, sampleSize: 500, quote: QUOTE,
    locator: { start: PAPER.indexOf(QUOTE), end: PAPER.indexOf(QUOTE) + QUOTE.length }, ...fields } });
  return { pipeline, rows, filed, write };
}
const settle = async () => { for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

test("the write of a value does not wait for its second reading; a disagreement is filed when it ends and told in the note of the card that cites it", async () => {
  /** @type {() => void} */ let finish = () => {};
  const reader = { enabled: true, async check(/** @type {any} */ call) {
    assert.equal(call.evidenceId, "ev1");
    assert.equal(call.item.value, 0.62);
    assert.ok(call.sourceText.includes(QUOTE));
    await new Promise((resolve) => { finish = () => resolve(undefined); });
    return { ...compareReadings({ first: call.item, second: { value: 0.62, ciLow: 0.48, ciHigh: 0.95 }, passage: `${QUOTE} (upper limit 0.95 in the abstract)`, label: "风险比", arm: call.item.arm, quote: call.item.quote }),
      second: { value: 0.62, ciLow: 0.48, ciHigh: 0.95 }, model: "deepseek-flash" };
  } };
  const f = pipelineFixture(reader);
  const written = await f.write();
  assert.equal(written.state, "verified");
  assert.equal(f.filed.length, 0, "the write returned before the reading ended");
  assert.equal(f.rows[0].value, 0.62, "the first value is what is stored");
  assert.deepEqual(await f.pipeline.valueNotes({ userId: "u1", studyId: "s1", ids: ["ev1"] }), [], "nothing to tell yet, and no wait was asked for");
  const waiting = f.pipeline.valueNotes({ userId: "u1", studyId: "s1", ids: ["ev1"], wait: true });
  await settle();
  finish();
  const notes = await waiting;
  assert.equal(f.filed.length, 1);
  assert.equal(f.filed[0].outcome, "differ");
  assert.equal(f.filed[0].evidenceId, "ev1");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "second_read");
  assert.match(notes[0].message, /区间上限 第一次读到 0\.8，第二次读到 0\.95/);
  assert.equal(f.pipeline.counters.valueChecks["second_read:differ"], 1);
});

test("an agreement is filed and silent; a reading that fails, finds nothing or is not attached changes nothing and is only counted", async () => {
  const outcome = async (/** @type {any} */ reader) => {
    const f = pipelineFixture(reader);
    const written = await f.write();
    await settle();
    return { f, written, notes: await f.pipeline.valueNotes({ userId: "u1", studyId: "s1", ids: ["ev1"], wait: true }) };
  };
  const agree = await outcome({ enabled: true, check: async (/** @type {any} */ call) => ({ ...compareReadings({ first: call.item, second: { value: 0.62 }, passage: QUOTE }), second: { value: 0.62 }, model: "m" }) });
  assert.equal(agree.f.filed[0].outcome, "agree");
  assert.deepEqual(agree.notes, [], "agreement says nothing");
  assert.equal(agree.f.pipeline.counters.valueChecks["second_read:agree"], 1);

  const failed = await outcome({ enabled: true, check: async () => { throw Object.assign(new Error("upstream"), { code: "model_gateway_upstream_error" }); } });
  assert.equal(failed.written.state, "verified");
  assert.equal(failed.f.rows[0].value, 0.62, "the value is untouched");
  assert.equal(failed.f.filed.length, 0, "a failed reading leaves no row");
  assert.deepEqual(failed.notes, []);
  assert.equal(failed.f.pipeline.counters.valueChecks["second_read:failed"], 1);

  const timedOut = await outcome({ enabled: true, check: async () => { throw Object.assign(new Error("The second reading timed out."), { code: "second_read_timeout" }); } });
  assert.equal(timedOut.f.pipeline.counters.valueChecks["second_read:timeout"], 1);

  const nothing = await outcome({ enabled: true, check: async () => null });
  assert.equal(nothing.f.pipeline.counters.valueChecks["second_read:nothing_to_read"], 1);

  const off = await outcome({ enabled: false, check: async () => { throw new Error("must not be called"); } });
  assert.deepEqual([off.f.filed.length, off.f.pipeline.counters.valueChecks["second_read:failed"]], [0, undefined]);
  const none = await outcome(null);
  assert.deepEqual([none.written.state, none.notes], ["verified", []]);
});

test("only a value read out of preserved text is read again: not a derived number, not a refused quotation, not a paper that does not report it", async () => {
  let calls = 0;
  const reader = { enabled: true, check: async () => { calls += 1; return null; } };
  const f = pipelineFixture(reader);
  await f.write({ valueSource: "calculated", locator: { start: PAPER.indexOf(QUOTE), end: PAPER.indexOf(QUOTE) + QUOTE.length, inputs: [{ start: PAPER.indexOf(QUOTE), end: PAPER.indexOf(QUOTE) + QUOTE.length, quote: QUOTE, value: 0.62 }] } }).catch(() => null);
  await f.write({ value: 0.99 }).catch(() => null);
  await f.write({ notReported: true, value: null, ciLow: null, ciHigh: null, sampleSize: null, quote: "" }).catch(() => null);
  await settle();
  assert.equal(calls, 0);
  await f.write();
  await settle();
  assert.equal(calls, 1);
});

test("a card is never held longer than the stated limit for a reading that does not end", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = pipelineFixture({ enabled: true, check: () => new Promise(() => {}) });
  await f.write();
  const waiting = f.pipeline.valueNotes({ userId: "u1", studyId: "s1", ids: ["ev1"], wait: true });
  await settle();
  t.mock.timers.tick(SECOND_READ_CARD_WAIT_MS - 1);
  let answered = false;
  waiting.then(() => { answered = true; });
  await settle();
  assert.equal(answered, false, "still waiting just before the limit");
  t.mock.timers.tick(1);
  assert.deepEqual(await waiting, [], "the answer comes at the limit, without the reading");
  assert.equal(SECOND_READ_CARD_WAIT_MS, 5000);
});
