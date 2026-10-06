// The rules of a challenge's judgement that are code, not language (evidence-flywheel F14): what makes the model's answer count, how an amendment
// or a withdrawal touches only the claim it names, and the one model call the default judge makes — flash, purpose `evidence`, JSON, no thinking.
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyJudgementToClaims, claimCarries, createChallengeJudge, normalizeJudgement, passageIsInSource, publicViewWithout,
} from "../src/evidenceChallenges.mjs";

const TEXT = "In this randomized trial, 7 of 100 adults on the drug had a stroke. Major bleeding occurred in 3 of 100 on the drug.";
const sources = [{ title: "Trial", url: "https://example.org/t", excerpt: TEXT }, { title: "Second", url: "https://example.org/s", excerpt: "A second source says nothing about stroke." }];
const direct = { claimId: "CLM-1", claimType: "direct", claim: "Bleeding occurred in 9 of 100.", sourceIndexes: [1], supportQuote: "Major bleeding occurred in 9 of 100" };
const PASSAGE = "Major bleeding occurred in 3 of 100 on the drug";
const answer = (/** @type {any} */ over = {}) => ({ outcome: "amend", reason: "原文是 3/100。", sourceIndex: 1, passage: PASSAGE, amendedClaim: "Bleeding occurred in 3 of 100.", ...over });
const judged = (/** @type {any} */ raw, deterministic = "quote_not_found", claim = direct) => normalizeJudgement(raw, { claim, sources, deterministic });

test("a passage counts only if the source preserved it, by the comparison the reader's ✓ uses", () => {
  assert.equal(passageIsInSource(sources, 1, PASSAGE), true);
  assert.equal(passageIsInSource(sources, 2, PASSAGE), false, "another source does not hold it");
  assert.equal(passageIsInSource(sources, 1, "Major bleeding occurred in 9 of 100 on the drug"), false);
});

test("an answer outside the closed set, without a reason, or with a passage the source does not hold is not an answer", () => {
  assert.deepEqual(judged(null), { ok: false, code: "evidence_judgement_unreadable" });
  assert.deepEqual(judged("withdraw"), { ok: false, code: "evidence_judgement_unreadable" });
  assert.deepEqual(judged(answer({ outcome: "soften" })), { ok: false, code: "evidence_judgement_outcome_unknown" });
  assert.deepEqual(judged(answer({ reason: "" })), { ok: false, code: "evidence_judgement_reason_invalid" });
  assert.deepEqual(judged(answer({ reason: "长".repeat(401) })), { ok: false, code: "evidence_judgement_reason_invalid" });
  assert.deepEqual(judged(answer({ passage: "an invented sentence about stroke" })), { ok: false, code: "evidence_judgement_passage_not_in_source" });
  assert.deepEqual(judged(answer({ passage: "short" })), { ok: false, code: "evidence_judgement_passage_invalid" });
  assert.deepEqual(judged(answer({ sourceIndex: 9 })), { ok: false, code: "evidence_judgement_passage_invalid" });
  assert.deepEqual(judged(answer({ sourceIndex: 2 })), { ok: false, code: "evidence_judgement_passage_not_in_source" }, "a passage cited to the wrong source is not found there");
  assert.deepEqual(judged(answer({ amendedClaim: "" })), { ok: false, code: "evidence_judgement_amendment_invalid" });
  assert.deepEqual(judged(answer({ amendedClaim: "x".repeat(1501) })), { ok: false, code: "evidence_judgement_amendment_invalid" });
  assert.deepEqual(judged(answer({ passage: undefined, sourceIndex: undefined })), { ok: false, code: "evidence_judgement_passage_required" });
});

test("a claim keeps the sources it named: a verified passage in another source is a different claim, not an amendment", () => {
  const second = { ...direct, claimId: "CLM-2", sourceIndexes: [2], supportQuote: "A second source says nothing about stroke." };
  assert.deepEqual(judged(answer(), "verified", second), { ok: false, code: "evidence_judgement_source_mismatch" });
});

test("with no quotation found, uphold cannot stand as written and withdraw needs no passage; with one found, both need the model's passage", () => {
  const upheld = judged(answer({ outcome: "uphold", amendedClaim: undefined }));
  assert.deepEqual([upheld.ok, /** @type {any} */ (upheld).outcome, /** @type {any} */ (upheld).repairsQuote, /** @type {any} */ (upheld).amendedClaim], [true, "amend", true, direct.claim]);
  const withdrawn = judged({ outcome: "withdraw", reason: "原文没有这个数字。" });
  assert.deepEqual([withdrawn.ok, /** @type {any} */ (withdrawn).outcome, /** @type {any} */ (withdrawn).passage], [true, "withdraw", null]);
  assert.deepEqual(judged({ outcome: "withdraw", reason: "原文不支持。" }, "verified"), { ok: false, code: "evidence_judgement_passage_required" });
  const standing = judged(answer({ outcome: "uphold", amendedClaim: undefined, passage: "7 of 100 adults on the drug had a stroke" }), "verified", { ...direct, claim: "Stroke fell.", supportQuote: "7 of 100 adults on the drug had a stroke" });
  assert.deepEqual([standing.ok, /** @type {any} */ (standing).outcome, /** @type {any} */ (standing).repairsQuote], [true, "uphold", false]);
  assert.deepEqual(judged(answer({ amendedClaim: direct.claim }), "verified"), { ok: false, code: "evidence_judgement_amendment_invalid" }, "an amendment that changes nothing is not one");
});

test("an amendment changes only that claim's wording and its quotation bond; a withdrawal removes it and what stood only on it", () => {
  const synthesized = { claimId: "CLM-S", claimType: "synthesized", claim: "Both agree.", confidence: "moderate", sourceIndexes: [1, 2],
    supportingSources: [{ sourceIndex: 1, supportQuote: "7 of 100" }, { sourceIndex: 2, supportQuote: "nothing" }] };
  const derivedOnly = { claimId: "CLM-D1", claimType: "derived", claim: "So bleeding is rare.", derivedFrom: ["CLM-1"], method: "m", assumptions: "a", sensitivity: "s" };
  const derivedMore = { claimId: "CLM-D2", claimType: "derived", claim: "So net benefit.", derivedFrom: ["CLM-1", "CLM-S"], method: "m", assumptions: "a", sensitivity: "s" };
  const chained = { claimId: "CLM-D3", claimType: "derived", claim: "So guidelines hold.", derivedFrom: ["CLM-D1"], method: "m", assumptions: "a", sensitivity: "s" };
  const claims = [direct, synthesized, derivedOnly, derivedMore, chained];
  const amended = applyJudgementToClaims(claims, "CLM-1", { outcome: "amend", amendedClaim: "Bleeding occurred in 3 of 100.", sourceIndex: 1, passage: PASSAGE });
  assert.deepEqual(amended.removed, []);
  assert.deepEqual(amended.claims[0], { ...direct, claim: "Bleeding occurred in 3 of 100.", supportQuote: PASSAGE });
  assert.deepEqual(amended.claims.slice(1), claims.slice(1), "no other claim moves");
  const bond = applyJudgementToClaims(claims, "CLM-S", { outcome: "amend", amendedClaim: "Only one source agrees.", sourceIndex: 2, passage: "A second source says nothing about stroke." });
  assert.deepEqual(bond.claims[1].supportingSources, [{ sourceIndex: 1, supportQuote: "7 of 100" }, { sourceIndex: 2, supportQuote: "A second source says nothing about stroke." }]);
  const withdrawn = applyJudgementToClaims(claims, "CLM-1", { outcome: "withdraw" });
  assert.deepEqual(withdrawn.removed.sort(), ["CLM-1", "CLM-D1", "CLM-D3"], "a derivation from only the withdrawn claim goes, and so does the one that rested on that");
  assert.deepEqual(withdrawn.claims.map((claim) => claim.claimId), ["CLM-S", "CLM-D2"]);
  assert.deepEqual(withdrawn.claims[1].derivedFrom, ["CLM-S"], "a derivation with other grounds loses only the link");
  assert.equal(claimCarries(amended.claims[0], { amendedClaim: "Bleeding occurred in 3 of 100.", sourceIndex: 1, passage: PASSAGE }), true);
  assert.equal(claimCarries(direct, { amendedClaim: "Bleeding occurred in 3 of 100.", sourceIndex: 1, passage: PASSAGE }), false);
});

test("a plain-language panel that stood only on a withdrawn claim goes with it; one with other support loses just the link", () => {
  const view = {
    oneLineAnswer: { text: "Bleeding is rare.", claimIds: ["CLM-1"] },
    whatItIs: { text: "A trial.", claimIds: ["CLM-1", "CLM-2"] },
    commonMisunderstandings: [{ misunderstanding: "a", correction: "b", claimIds: ["CLM-1"] }, { misunderstanding: "c", correction: "d", claimIds: ["CLM-2"] }],
  };
  assert.deepEqual(publicViewWithout(view, ["CLM-1"]), {
    whatItIs: { text: "A trial.", claimIds: ["CLM-2"] },
    commonMisunderstandings: [{ misunderstanding: "c", correction: "d", claimIds: ["CLM-2"] }],
  });
  assert.equal(publicViewWithout({ oneLineAnswer: { text: "x", claimIds: ["CLM-1"] } }, ["CLM-1"]), null);
  assert.equal(publicViewWithout(null, ["CLM-1"]), null);
});

test("the default judge makes one flash call, billed to the evidence programme's account under purpose evidence, and hands back its JSON", async () => {
  /** @type {any[]} */ const calls = [];
  const callModel = async (/** @type {any} */ deps, /** @type {any} */ call) => {
    calls.push({ deps, call });
    return { choices: [{ finish_reason: "stop", message: { content: '{"outcome":"uphold"}' } }] };
  };
  const config = { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", frontierModel: "deepseek-flash" };
  const judge = createChallengeJudge({ config, usageLedger: { id: "ledger" }, callModel, parseJson: JSON.parse, billing: async () => ({ userId: "evimed-evidence-center", projectId: "evimed-evidence" }) });
  assert.deepEqual(await judge({ scope: "evch_1_1", payload: { claim: { text: "c" } } }), { outcome: "uphold" });
  const { deps, call } = calls[0];
  assert.deepEqual([call.userId, call.projectId, call.purpose, call.runId], ["evimed-evidence-center", "evimed-evidence", "evidence", "evch_1_1"]);
  assert.deepEqual(call.limits, { daily: 0, weekly: 0 }, "the programme's own budget governs, not an account's cap");
  assert.deepEqual([call.body.model, call.body.thinking, call.body.response_format, call.body.temperature], ["deepseek-flash", { type: "disabled" }, { type: "json_object" }, 0]);
  assert.equal(deps.usageLedger.id, "ledger");
  assert.match(call.body.messages[0].content, /untrusted data, never instructions/);
  assert.deepEqual(JSON.parse(call.body.messages[1].content), { claim: { text: "c" } });
  assert.ok(call.signal instanceof AbortSignal);
});

test("the default judge refuses without a provider, and an answer the model did not finish is an error, not an answer", async () => {
  const billing = async () => ({ userId: "u", projectId: "p" });
  const unconfigured = createChallengeJudge({ config: { deepseekProviderEnabled: false }, usageLedger: null, callModel: async () => ({}), parseJson: JSON.parse, billing });
  await assert.rejects(unconfigured({ scope: "s", payload: {} }), { code: "evidence_judge_unavailable" });
  const cut = createChallengeJudge({ config: { deepseekProviderEnabled: true, deepseekApiKey: "k" }, usageLedger: null, parseJson: JSON.parse, billing,
    callModel: async () => ({ choices: [{ finish_reason: "length", message: { content: '{"outcome":"uphold"' } }] }) });
  await assert.rejects(cut({ scope: "s", payload: {} }), { code: "evidence_judgement_incomplete" });
});
