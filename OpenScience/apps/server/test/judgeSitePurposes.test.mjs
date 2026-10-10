// What a site's spend is booked to. The purpose decides which budget an observation draws on: `learning` is the
// per-account learning cap, `evolution` is the evolution module's own day (and the evolution owner's account), and the
// ledger's CHECK refuses a purpose it does not know. The plan (2026-10-06 §3) books each site's money to its own
// module's purpose, and §4.4 puts J10-J12 in the self-iteration batch; their callers say the same (`module: "evolution"`
// in the project `evimed-evolution`).
import assert from "node:assert/strict";
import test from "node:test";

import { USAGE_PURPOSES } from "@evimed/domain";
import { JUDGE_SITE_IDS, JUDGE_SITES } from "../src/judgeSites.mjs";
import { createJudgeService } from "../src/judgeService.mjs";

test("every registered site books to a purpose the usage ledger knows", () => {
  for (const id of JUDGE_SITE_IDS) assert.ok(USAGE_PURPOSES.includes(JUDGE_SITES[id].purpose), `${id} books to ${JUDGE_SITES[id].purpose}`);
});

test("the evolution module's sites book to evolution, not to the learning loop's per-account cap", () => {
  for (const id of ["J10", "J11", "J12", "J17", "J23"]) assert.equal(JUDGE_SITES[id].purpose, "evolution", id);
  // The learning loop's own screen stays where it was.
  assert.equal(JUDGE_SITES.J1.purpose, "learning");
});

test("the purpose reaches the ledger from the registry row, not from the caller", async () => {
  const config = { reviewJevEnabled: true, typesafeApiKey: "test-not-secret", reviewJevModel: "jev-1.13.0", reviewJevSupportConfidence: 0.8 };
  /** @type {Array<[string, string]>} */
  const booked = [];
  const service = createJudgeService({ calibrationMode: true, config, callImpl: async (_deps, call) => {
    booked.push([call.operation, call.purpose]);
    return { model: config.reviewJevModel, cost: 0, answers: Object.fromEntries(Object.entries(call.questions).map(([id, question]) => {
      const keys = Object.keys(question.criteria);
      return [id, { type: "choice", choice: keys[0], confidence: 1, probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])) }];
    })) };
  } });
  await service.judge("J11", { method: { id: "m", name: "Cox model", description: "hazards" }, methods: [{ id: "cox", name: "Cox", description: "hazards" }] }, { userId: "owner", projectId: "evimed-evolution", purpose: "learning" });
  await service.judge("J12", { left: { name: "a", description: "x" }, right: { name: "b", description: "y" } }, { userId: "owner", projectId: "evimed-evolution", purpose: "learning" });
  assert.deepEqual(booked.slice(0, 1), [["J11", "evolution"]]);
  assert.deepEqual(booked.filter(([operation]) => operation === "J12").map(([, purpose]) => purpose), ["evolution", "evolution"], "both orders of the pair");
  await service.close();
});
