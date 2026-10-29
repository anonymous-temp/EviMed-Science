import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_SELECT_THRESHOLD_DEFAULT, frontierSelectThreshold } from "../src/frontierPipeline.mjs";
import { frontierCardFacts, frontierScoreBand } from "../src/frontierService.mjs";

test("a card's facts: every enrichment key but the ones another part of the card says, bounded again", () => {
  const facts = frontierCardFacts({
    journal: "NEJM", impact_factor: 78.5, affiliation_countries: ["US", "CN"], evidence_grade: "B", listed: true,
    trial_facts: { phase: "3", enrollment: 500, nested: { x: 1 } },
    mesh: ["Heart Failure"], publication_types: ["Review"], drug_label_excerpt: "Warnings.", oa_pdf_url: "https://x.org/a.pdf",
    open_access: "gold", preprint_of_doi: "10.1/a", published_version_doi: "10.1/b",
    "Bad Key": "x", blank: " ", infinite: Number.POSITIVE_INFINITY, long: "y".repeat(400),
  });
  assert.deepEqual(Object.keys(facts), ["journal", "impact_factor", "affiliation_countries", "evidence_grade", "listed", "trial_facts", "long"]);
  assert.deepEqual(facts.trial_facts, { phase: "3", enrollment: 500 });
  assert.equal(/** @type {string} */ (facts.long).length, 300);
  assert.deepEqual(frontierCardFacts(null), {});
  assert.deepEqual(frontierCardFacts(["x"]), {});
  assert.equal(Object.keys(frontierCardFacts(Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k_${index}`, index])))).length, 12);
});

test("a card's AI 评分 tier (owner, 2026-10-23; lines moved with the score, 2026-10-25): high from 76, medium from 60, low below; no score, no tier", () => {
  assert.equal(frontierScoreBand(86), "high");
  assert.equal(frontierScoreBand(76), "high", "the line itself is the higher tier");
  assert.equal(frontierScoreBand(75), "medium");
  assert.equal(frontierScoreBand(60), "medium");
  assert.equal(frontierScoreBand(59), "low");
  assert.equal(frontierScoreBand("91"), "high", "a number the database sent as text");
  assert.ok(frontierScoreBand(FRONTIER_SELECT_THRESHOLD_DEFAULT) !== "low", "a selected card never reads as low");
  for (const nothing of [null, undefined, "", "n/a"]) assert.equal(frontierScoreBand(nothing), null, String(nothing));
});

test("the selection line is the config's, the calibrated default when it says nothing", () => {
  assert.equal(frontierSelectThreshold({ frontierSelectThreshold: 75 }), 75);
  assert.equal(frontierSelectThreshold({ frontierSelectThreshold: 0 }), 0);
  assert.equal(FRONTIER_SELECT_THRESHOLD_DEFAULT, 64);
  for (const unset of [{}, null, { frontierSelectThreshold: null }, { frontierSelectThreshold: "" }, { frontierSelectThreshold: "x" }]) {
    assert.equal(frontierSelectThreshold(unset), FRONTIER_SELECT_THRESHOLD_DEFAULT, JSON.stringify(unset));
  }
});
