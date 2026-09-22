import assert from "node:assert/strict";
import test from "node:test";
import { frontierCardFacts } from "../src/frontierService.mjs";

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
