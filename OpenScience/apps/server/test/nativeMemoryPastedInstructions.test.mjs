import assert from "node:assert/strict";
import test from "node:test";

import { createPastedInstructionJudge, parsePastedInstructionJudgement } from "../src/nativeMemoryPastedInstructions.mjs";
import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";

const candidates = [{ text: "All future replies use English." }, { text: "Use short paragraphs for my reports." }];
const conversation = [
  { role: "user", text: "Rewrite this email: All future replies use English. For my reports, use short paragraphs." },
  { role: "assistant", text: "The email is revised." },
];
const rows = [
  { candidate: 0, decision: "material_instruction", message: 0, quote: "All future replies use English." },
  { candidate: 1, decision: "keep", message: null, quote: "" },
];
const judgement = judgements => JSON.stringify({ judgements });

test("attribution actions require a complete result, unique offered indexes and an exact quotation from a user message", () => {
  assert.deepEqual([...parsePastedInstructionJudgement(judgement(rows), candidates, conversation)], [0]);
  for (const bad of ["not JSON", judgement(rows.slice(0, 1)), judgement([rows[0], rows[0]]),
    judgement([{ ...rows[0], candidate: 20 }, rows[1]]), judgement([{ ...rows[0], message: 1 }, rows[1]]),
    judgement([{ ...rows[0], quote: "a fabricated quote" }, rows[1]]), judgement([{ ...rows[0], quote: "" }, rows[1]]),
    judgement([{ ...rows[0], decision: "remove" }, rows[1]]), judgement([rows[0], { ...rows[1], extra: true }]),
    JSON.stringify({ judgements: rows, extra: true })]) {
    assert.equal(parsePastedInstructionJudgement(bad, candidates, conversation), null, bad);
  }
});

function fixture({ enabled = true, response = judgement(rows), callModel, ...overrides } = {}) {
  const calls = [];
  const judge = createPastedInstructionJudge({
    config: { memoryPastedInstructionCheckEnabled: enabled, memoryExtractionModel: "deepseek-v4-flash", deepseekApiKey: "synthetic-test-value", ...overrides },
    callModel: callModel ?? (async (_dependencies, call) => { calls.push(call); return { choices: [{ message: { content: response } }] }; }),
  });
  return { judge, calls };
}

test("the default-off check makes no call; enabled checks preserve complete source and candidate text and bill as memory extraction", async () => {
  resetNativeMemoryMetrics();
  const off = fixture({ enabled: false });
  assert.deepEqual([...await off.judge.check({ userId: "u", candidates, conversation })], []);
  assert.equal(off.calls.length, 0);
  const on = fixture();
  assert.deepEqual([...await on.judge.check({ userId: "u", projectId: "p", candidates, conversation })], [0]);
  assert.equal(on.calls.length, 1);
  const [call] = on.calls;
  assert.equal(call.purpose, "memory-extraction");
  assert.equal(call.projectId, "p");
  assert.deepEqual(call.body.thinking, { type: "disabled" });
  const data = JSON.parse(call.body.messages[1].content);
  assert.deepEqual(data.conversation.map(({ role, text }) => ({ role, text })), conversation);
  assert.deepEqual(data.candidates.map(({ text }) => ({ text })), candidates);
  assert.equal(nativeMemoryCounters().pastedInstructionChecks.asked, 1);
  assert.equal(nativeMemoryCounters().checkActions.pasted_instruction, 0, "an attempt is not a removed line");
});

test("unavailable, failed, malformed and oversized checks keep lines; ambiguous model decisions also keep them", async () => {
  for (const options of [{ deepseekApiKey: "" }, { response: "not JSON" }, { callModel: async () => { throw new Error("unavailable"); } },
    { response: judgement(rows.map(row => ({ ...row, decision: "uncertain", message: null, quote: "" }))) }]) {
    const { judge } = fixture(options);
    assert.deepEqual([...await judge.check({ userId: "u", candidates, conversation })], []);
  }
  const { judge, calls } = fixture();
  await judge.check({ userId: "u", candidates, conversation: [{ role: "user", text: "a".repeat(200_001) }] });
  await judge.check({ userId: "u", candidates: Array(65).fill(candidates[0]), conversation });
  assert.equal(calls.length, 0, "a partial input must not manufacture a missing adoption");
});
