import assert from "node:assert/strict";
import test from "node:test";

import {
  DURABLE_RECALL_BUDGET_SHARE,
  DURABLE_RECALL_KINDS,
  recallContent,
  selectWithinBudget,
} from "../src/memoryRecallPolicy.mjs";

// What these cases defend is a reservation, not a cap. The cap was already
// there and was not enough: ranking is score-descending, an episodic
// run_summary of an earlier attempt at the same question matches many query
// terms while a profile record matches none, so episodes were always selected
// first and the character budget was gone before the first durable row was
// reached. On production that made a researcher's profile unreachable behind
// 44 accumulated run summaries, silently.

const row = (kind, content, scale = 1) => ({ memo: { id: `${kind}-${content.length}-${scale}`, kind, content }, score: scale });
const episode = (chars, n = 1) => row("run_summary", "E".repeat(chars), n);
const profile = (chars, n = 1) => row("preference", "P".repeat(chars), n);

test("an episode flood cannot push the profile out of the recall", () => {
  // The shape measured in production: several long run summaries ranked above
  // one short preference. Before the reservation the preference never made it.
  const ranked = [episode(9000), episode(9000), episode(9000), profile(40)];
  const selected = selectWithinBudget(ranked, { contextLimit: 8, contextMaxChars: 20_000 });
  const kinds = selected.map((memo) => memo.kind);
  assert.ok(kinds.includes("preference"), `the profile must survive the flood: ${JSON.stringify(kinds)}`);
  assert.ok(selected.reduce((sum, memo) => sum + memo.content.length, 0) <= 20_000);
});

test("the profile is still capped at its share, so it cannot crowd out the episodes either", () => {
  // The original property, which the reservation must not break.
  const ranked = [profile(10), profile(10), profile(10), profile(10), profile(10), profile(10), episode(10)];
  const selected = selectWithinBudget(ranked, { contextLimit: 8, contextMaxChars: 20_000 });
  const durable = selected.filter((memo) => DURABLE_RECALL_KINDS.has(memo.kind));
  assert.equal(durable.length, Math.floor(8 * DURABLE_RECALL_BUDGET_SHARE), "durable rows stay at their ceiling");
  assert.ok(selected.some((memo) => memo.kind === "run_summary"), "a question-specific memory still fits");
});

test("an account with no profile is not charged for one", () => {
  // The reservation is claimed, not withheld: unused durable budget goes back
  // to the episodes, or every user without a profile would silently lose half
  // their recall.
  const ranked = [episode(30), episode(30), episode(30), episode(30), episode(30), episode(30), episode(30), episode(30)];
  const selected = selectWithinBudget(ranked, { contextLimit: 8, contextMaxChars: 20_000 });
  assert.equal(selected.length, 8, "all eight slots are usable when there is no profile to reserve for");
});

test("results come back in rank order, not in the order the passes picked them", () => {
  // The prompt numbers these index="1..n"; a reader should see them ranked as
  // they were scored, not profile-first because of how selection works.
  const ranked = [episode(10, 9), profile(10, 8), episode(10, 7), profile(10, 6)];
  const selected = selectWithinBudget(ranked, { contextLimit: 8, contextMaxChars: 20_000 });
  assert.deepEqual(selected.map((memo) => memo.kind), ["run_summary", "preference", "run_summary", "preference"]);
});

test("a zero budget selects nothing, and a budget of one still admits a durable row", () => {
  assert.deepEqual(selectWithinBudget([profile(10), episode(10)], { contextLimit: 0, contextMaxChars: 20_000 }), []);
  assert.deepEqual(selectWithinBudget([profile(10), episode(10)], { contextLimit: 8, contextMaxChars: 0 }), []);
  const one = selectWithinBudget([episode(10), profile(10)], { contextLimit: 1, contextMaxChars: 20_000 });
  assert.equal(one.length, 1);
  assert.equal(one[0].kind, "preference", "with one slot the reservation claims it");
});

test("content is truncated to the remaining budget, never silently dropped whole", () => {
  const selected = selectWithinBudget([profile(50_000)], { contextLimit: 8, contextMaxChars: 20_000 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].content.length, Math.floor(20_000 * DURABLE_RECALL_BUDGET_SHARE));
});

test("a run summary reaches the prompt as the exchange it describes, not as its JSON", () => {
  // Unchanged behaviour, asserted here because the selection now hands these
  // rows to the model in cases where they previously never got that far.
  const projected = recallContent({
    kind: "run_summary",
    summary: "Earlier question: X",
    value: JSON.stringify({ runId: "run_1", model: "deepseek" }),
  });
  assert.match(projected, /Earlier question: X/);
  assert.doesNotMatch(projected, /run_1/, "internal identifiers are not content");
});
