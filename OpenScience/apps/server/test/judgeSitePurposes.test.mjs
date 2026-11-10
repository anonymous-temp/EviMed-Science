// What a site's spend is booked to. The purpose decides which budget an observation draws on: `learning` is the
// per-account learning cap, `evolution` is the evolution module's own day (and the evolution owner's account), and the
// ledger's CHECK refuses a purpose it does not know. The plan (2026-10-06 §3) books each site's money to its own
// module's purpose. J10-J12 and J17, the evolution module's, left with the online engine (2026-11-04).
import assert from "node:assert/strict";
import test from "node:test";

import { USAGE_PURPOSES } from "@evimed/domain";
import { JUDGE_SITE_IDS, JUDGE_SITES } from "../src/judgeSites.mjs";
import { createJudgeService } from "../src/judgeService.mjs";

test("every registered site books to a purpose the usage ledger knows", () => {
  for (const id of JUDGE_SITE_IDS) assert.ok(USAGE_PURPOSES.includes(JUDGE_SITES[id].purpose), `${id} books to ${JUDGE_SITES[id].purpose}`);
});

test("the learning loop's own screen books to learning", () => {
  assert.equal(JUDGE_SITES.J1.purpose, "learning");
  for (const id of ["J10", "J11", "J12", "J17"]) assert.equal(Object.hasOwn(JUDGE_SITES, id), false, `${id} left with the online engine`);
});

test("the harm check of the promotion to everyone's pack books where the promotion's other calls do, never to evolution", () => {
  // Audit 2026-11-03, D6: J23 is online learning's (`officialPromotion.mjs`), and its spend under `evolution` was the one production call
  // left on that purpose once the module's experiments moved offline. The promotion's judge and review book `evidence` (server.mjs).
  assert.equal(JUDGE_SITES.J23.purpose, "evidence");
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
  await service.judge("J14", { left: { name: "a", description: "x" }, right: { name: "b", description: "y" } }, { userId: "owner", projectId: "p", purpose: "frontier" });
  assert.deepEqual(booked.filter(([operation]) => operation === "J14").map(([, purpose]) => purpose), ["learning", "learning"], "both orders of the pair");
  await service.close();
});
