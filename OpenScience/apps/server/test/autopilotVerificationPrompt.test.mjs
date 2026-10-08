// The independent verifier's instruction keeps the file's vocabulary out of its reply (design reference §8.6, E-10).
//
// Offline: it holds what can be decided without a model — that the instruction says it, that it names every word the file is written in,
// and that the checker the live eval uses (`evals/autopilot-verification-reply`) agrees with it about what a leak is. Whether the model
// obeys is the eval's question, asked on a new conversation; these hold the parts that cannot silently drift.
import assert from "node:assert/strict";
import test from "node:test";
import { REFUTATION_VERDICTS } from "@evimed/domain";
import { VERIFICATION_ARTIFACT, VERIFICATION_FILE_VOCABULARY, verificationBrief, verificationPrompt } from "../src/autopilotService.mjs";
import { backstageWordsIn } from "../../../evals/autopilot-verification-reply/check_reply.mjs";

const claim = { claimId: "claim-1", statement: "该药物使住院风险降低 21%（HR 0.79）。", sources: ["doi:10.9999/eval.1"], effect: { measure: "hazard-ratio", value: "0.79" } };
const prompt = verificationPrompt(verificationBrief(claim));
const lines = prompt.split("\n");
const replyAt = lines.findIndex((line) => line.startsWith("Your reply is read by the researcher"));

test("the instruction tells the verifier its reply is for the researcher, in the claim's language, and leaves the file's contract as it was", () => {
  assert.ok(replyAt > 0, "the reply paragraph is there");
  const reply = lines.slice(replyAt).join(" ");
  assert.match(reply, /language of the claim/);
  assert.match(reply, /plain sentences/);
  assert.match(reply, /Do not name the file, its fields or their values in the reply/);
  // The file is still asked for exactly as before: the control plane reads it.
  const file = lines.slice(0, replyAt).join("\n");
  assert.match(file, new RegExp(`Write ${VERIFICATION_ARTIFACT} in the workspace root with exactly:`));
  assert.match(file, /"schemaVersion":1,"verdict":"refuted\|weakened\|stands","numbersReproduced":true\|false,/);
  assert.match(file, /"recomputed":\{"measure":"…","value":"…"\}\|null,"checkedSources":\["…"\],"reason":"…"\}/);
  assert.ok(replyAt === lines.length - 4, "and the reply paragraph is the last thing the instruction says");
});

test("every word the file is written in is named as one the reply must not say, and a field added to the file has to join the list", () => {
  const reply = lines.slice(replyAt).join(" ");
  for (const word of VERIFICATION_FILE_VOCABULARY) assert.ok(reply.includes(word), `${word} is not named in the reply paragraph`);
  for (const verdict of REFUTATION_VERDICTS) assert.ok(VERIFICATION_FILE_VOCABULARY.includes(verdict));
  assert.ok(VERIFICATION_FILE_VOCABULARY.includes(VERIFICATION_ARTIFACT));
  // The template's own keys: each is in the list, but `reason`, which is an ordinary word a reply may use.
  const template = lines.find((line) => line.startsWith('{"schemaVersion":1'));
  const keys = [...String(template).matchAll(/"([A-Za-z]+)":/g)].map((match) => match[1]);
  assert.ok(keys.length >= 6, `only ${keys.length} keys found; the parse is wrong`);
  const unnamed = keys.filter((key) => key !== "reason" && key !== "measure" && key !== "value" && !VERIFICATION_FILE_VOCABULARY.includes(key));
  assert.deepEqual(unnamed, [], "a field the file carries would leak the day it was added");
});

test("the checker finds the file's names anywhere, and a verdict word only when it is used as a label", () => {
  // The words the owner's screenshots showed.
  assert.deepEqual(backstageWordsIn("核对结果已写入 verification.json，numbersReproduced 为 true，recomputed 为 0.79。"), ["verification.json", "numbersReproduced", "recomputed"]);
  assert.deepEqual(backstageWordsIn("结论：`weakened`；另一条为 “refuted”。"), ["weakened", "refuted"]);
  assert.deepEqual(backstageWordsIn("Verdict: weakened."), ["verdict", "weakened"], "reported as the vocabulary spells them, once each");
  assert.deepEqual(backstageWordsIn("checkedSources and schemaVersion are fine to leave out"), ["checkedSources", "schemaVersion"]);
  // The researcher's own words are clean, in either language, and an English verdict-like word in prose is not a label.
  assert.deepEqual(backstageWordsIn("来源只支持较小的效应：原文给出的风险比是 0.79，与结论中的数字一致，但亚组结论超出了来源所说的范围。"), []);
  assert.deepEqual(backstageWordsIn("The sources contradict the claim; the stated hazard ratio was reproduced."), []);
  assert.deepEqual(backstageWordsIn("The claim stands as written: the sources reproduce 0.79."), []);
  assert.deepEqual(backstageWordsIn(""), []);
  assert.deepEqual(backstageWordsIn(undefined), []);
});
