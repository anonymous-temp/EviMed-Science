// R29 to R31 on the page: the drug effect's tier and the claim that tier can carry, read from the engine's real results (fixtures made by the engine itself:
// a donepezil 10 mg arm with a background donepezil under posterior draws, and the aducanumab chain) into the one block of premises.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { progressionCard } from "../src/vcrProgression.mjs";
import { drugOriginPremises } from "../src/vcrDrugOriginPremises.mjs";

const fixture = (name) => ({ ...JSON.parse(readFileSync(new URL(`./fixtures/vcr-progression/${name}.json`, import.meta.url), "utf8")), id: "res_1", version: 1, kind: "progression_simulation", createdAt: "2026-11-09T00:00:00Z" });
const row = (card, key) => card.premises.find((premise) => premise.key === key);

test("a marketed inhibitor is tier A: the drug, the dose, where its parameters came from, and what the number is not", () => {
  const card = progressionCard(fixture("alzheimer-reference-inhibitor"));
  const tier = row(card, "progression:ad:tier");
  assert.ok(tier.decisive);
  assert.match(tier.value, /第一档：已上市药物的拟合/);
  assert.match(tier.value, /多奈哌齐，每天 10 mg（参考剂量 5 mg 的 2 倍）/);
  assert.match(tier.value, /每次试验用自己抽到的那一组后验参数/);
  assert.match(tier.value, /不是对任何新药的预测/);
  assert.match(row(card, "progression:ad:tier-dose").value, /剂量范围在引擎携带的资料里没有公布/);
  assert.match(row(card, "progression:ad:tier-check").value, /不是独立验证/);
  assert.match(row(card, "progression:ad:background").value, /基线前 26 周开始/);
  assert.match(row(card, "progression:ad:effect").value, /多奈哌齐/, "the effect row names the drug instead of saying that no effect was stated");
  assert.doesNotMatch(row(card, "progression:ad:effect").value, /没有设定药物效果/);
});

test("the antibody chain is tier B: what follows if it holds, and its three mismatches", () => {
  const card = progressionCard(fixture("alzheimer-mechanism-chain"));
  const tier = row(card, "progression:ad:tier");
  assert.match(tier.value, /第二档：机制链（探索性）/);
  assert.match(tier.value, /如果这条机制链成立/);
  assert.match(tier.value, /这不是药物有效的结论/);
  assert.match(row(card, "progression:ad:tier-scale").value, /CDR-SB/);
  assert.match(row(card, "progression:ad:tier-population").value, /MMSE 20–30/);
  assert.match(row(card, "progression:ad:tier-link").value, /拟合它的试验也是用来核对这条链的试验/);
  assert.match(row(card, "progression:ad:tier-link").value, /0\.33 分，95% 区间 0\.12–0\.55/);
  assert.equal(card.powerQuantity, "assurance", "the chain's number is an assurance, named so");
  // the page carries no back-office word
  for (const text of card.premises.flatMap((premise) => [premise.label, premise.value])) assert.doesNotMatch(text, /empirical_draws|objectRef|model_result|posterior_draws|tier/);
});

test("an effect from earlier evidence is tier C and says that its estimand may not be this study's", () => {
  const progression = { effectDistributions: [{ key: "treatment.symptomatic.pointsAt", family: "normal", tier: "C", source: { kind: "model_result", objectRef: "res_pool1", note: "pooled studies; estimand: donepezil, mild AD" } }], treatment: {} };
  const rows = drugOriginPremises(progression);
  assert.equal(rows.length, 1);
  assert.match(rows[0].value, /第三档：已有证据/);
  assert.match(rows[0].value, /ICH E9\(R1\) A\.4/);
  assert.match(rows[0].value, /pooled studies; estimand: donepezil, mild AD/);
  assert.deepEqual(drugOriginPremises({ effectDistributions: [{ tier: "stated" }], treatment: {} }), [], "a researcher's own distribution is already named by the effect row");
});
