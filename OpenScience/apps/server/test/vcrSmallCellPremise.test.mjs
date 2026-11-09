// A count of real people below the small-cell floor is never printed (round-2 review P1-10): the individualization premise says 「少数人」 where the count is
// small, and the findings a model reads lose their `people` count like every other count of people.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_MIN_CELL_SIZE, suppressForModel } from "@evimed/domain";
import { modelUsePremises } from "../src/vcrPremises.mjs";

const finding = (people) => ({ code: "individual_laplace_untrusted", people });

test("the premise prints no count below the floor, and prints one at or above it", () => {
  const small = modelUsePremises([finding(2)])[0].value;
  assert.match(small, /^有少数人的后验用近似算出/);
  assert.doesNotMatch(small, /\d/);
  assert.match(modelUsePremises([finding(VCR_MIN_CELL_SIZE - 1)])[0].value, /少数人/);
  assert.match(modelUsePremises([finding(VCR_MIN_CELL_SIZE)])[0].value, new RegExp(`^有 ${VCR_MIN_CELL_SIZE} 个人的后验用近似算出`));
});

test("a finding's people count is hidden from the model like the batch ledger's", () => {
  const shown = suppressForModel({ summary: { useFindings: [finding(2)], accounting: { rejected: 2, submitted: 40 } } }, { minCell: 5 });
  assert.notEqual(shown.summary.useFindings[0].people, 2, "the count of a finding is a count of people");
  assert.equal(JSON.stringify(shown.summary.useFindings).includes('"people":2'), false);
  assert.ok(shown.summary.useFindings[0].suppressed?.length, "the cell says it was hidden");
  const large = suppressForModel({ summary: { useFindings: [finding(30)] } }, { minCell: 5 });
  assert.equal(large.summary.useFindings[0].people, 30);
});
