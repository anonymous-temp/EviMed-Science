// The eval cases for the judge against cards (`evals/geo-judge-cards/cases.json`) are data nobody runs a model over in a test, so this
// keeps them honest: each names claims the judge could be shown, expectations in the closed words, and an ideal judgement built from
// `mustContain` that code's own re-verification (`verifyJudgement`) keeps whole — a case whose ideal answer the platform would drop is not
// a case of this platform.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GEO_CITATION_SUPPORTS, GEO_ERROR_TYPES, GEO_STATEMENT_TOPICS } from "@evimed/domain";
import { buildJudgeInput, verifyJudgement } from "../src/geoJudge.mjs";

const data = JSON.parse(await readFile(new URL("../../../evals/geo-judge-cards/cases.json", import.meta.url), "utf8"));

test("the cases are well formed: claims the judge can be shown, closed words, sentences that are in the answer", () => {
  assert.ok(data.cases.length >= 3, "at least three realistic cases");
  assert.equal(new Set(data.cases.map((entry) => entry.id)).size, data.cases.length);
  for (const entry of data.cases) {
    assert.ok(entry.why.length > 80, `${entry.id}: says why it is a case`);
    assert.ok(entry.claims.length >= 1 && entry.question && entry.answer, entry.id);
    for (const claim of entry.claims) {
      assert.match(claim.alias, /^C\d+$/);
      assert.ok(claim.statement && claim.quote, `${entry.id} ${claim.alias}`);
      assert.equal(claim.cardId === null, claim.cardRevision === null, "a claim is in a card revision or in no card");
    }
    for (const expected of entry.mustContain) {
      if (expected.statement) {
        assert.ok(entry.answer.includes(expected.statement), `${entry.id}: the sentence is in the answer`);
        assert.ok(GEO_STATEMENT_TOPICS.includes(expected.topic), `${entry.id}: topic`);
        assert.ok(["correct", "wrong", "unverifiable"].includes(expected.verdict));
        if (expected.errorType) assert.ok(GEO_ERROR_TYPES.includes(expected.errorType));
      } else {
        assert.ok(["offLabel", "omittedSafety", "citation"].includes(expected.check), `${entry.id}: a known check`);
        if (expected.check === "offLabel") assert.ok(entry.answer.includes(expected.sentence));
        if (expected.check === "omittedSafety") assert.ok(entry.claims.some((claim) => claim.alias === expected.claim && claim.label));
        if (expected.check === "citation") {
          assert.ok((entry.links ?? []).some((link) => link.id === expected.link));
          assert.ok(GEO_CITATION_SUPPORTS.includes(expected.supports));
          assert.ok(!expected.evidenceInPage || entry.page?.text, "a quotation from a page needs the page");
        }
      }
    }
  }
});

test("the ideal judgement of each case survives code's re-verification, with the card revision the claim carries", () => {
  for (const entry of data.cases) {
    const claims = entry.claims.map((claim) => ({ id: `gcl_${claim.alias}`, key: claim.alias, statement: claim.statement, quote: claim.quote, inLabel: claim.label,
      sourceKind: claim.label ? "label" : "trial", cardId: claim.cardId, cardClaimId: claim.cardClaimId, cardRevision: claim.cardRevision }));
    const input = { owner: { userId: "u", projectId: "p" }, product: { brandName: "信尔美" }, competitors: [], claims, careFlags: [],
      question: { text: entry.question }, answer: entry.answer, links: (entry.links ?? []).map((link) => ({ url: link.url, title: link.title })) };
    const built = buildJudgeInput(input);
    const ideal = {
      statements: entry.mustContain.filter((expected) => expected.statement).map((expected) => {
        const claim = entry.claims[0];
        return { text: expected.statement, topic: expected.topic, verdict: expected.verdict, claim: claim.alias, evidence: claim.quote.slice(0, 8),
          ...(expected.verdict === "wrong" ? { errorType: expected.errorType ?? "label_conflict", severity: "S2" } : {}) };
      }),
      offLabel: entry.mustContain.filter((expected) => expected.check === "offLabel").map((expected) => expected.sentence),
      omittedSafety: entry.mustContain.filter((expected) => expected.check === "omittedSafety").map((expected) => expected.claim),
      citationClaims: entry.mustContain.filter((expected) => expected.check === "citation").map((expected) => ({ link: expected.link, statement: entry.answer.split("（")[0] })),
    };
    const verdict = verifyJudgement(ideal, built, input);
    const wanted = entry.mustContain.filter((expected) => expected.statement);
    assert.deepEqual(verdict.statements.map((statement) => [statement.text, statement.topic, statement.verdict, statement.cardRevision]),
      wanted.map((expected) => [expected.statement, expected.topic, expected.verdict, expected.cardRevision ?? null]), `${entry.id}: statements`);
    assert.deepEqual(verdict.dropped, [], `${entry.id}: nothing the ideal judgement says is dropped`);
    assert.equal(verdict.checks.offLabel.length, entry.mustContain.filter((expected) => expected.check === "offLabel").length, entry.id);
    assert.equal(verdict.checks.omittedSafety.length, entry.mustContain.filter((expected) => expected.check === "omittedSafety").length, entry.id);
    assert.equal(verdict.checks.citations.length, entry.mustContain.filter((expected) => expected.check === "citation").length, entry.id);
  }
});
