// What the matching page reads of the saved judgments, without a database: the five stances, a verdict from counts equal to the domain's verdict over
// the rows themselves (every combination), the words of the failure of a pair, and a CSV cell Excel will not run.
import assert from "node:assert/strict";
import test from "node:test";
import { trialVerdict, VCR_CRITERION_LABELS, VCR_MATCH_FAILURE_REASONS_ZH, vcrMatchConfidenceLevel, vcrMatchFailureReason, vcrMatchFitLevel } from "@evimed/domain";
import { csvCell, csvLine, stanceOf, verdictOfCounts } from "../src/vcrMatchResults.mjs";

test("a clause's stance: only a stated conflict disqualifies, and a silence is read the way the verdict reads it", () => {
  const stance = (label, basis) => stanceOf({ label, basis });
  assert.deepEqual(["included", "not_excluded"].map((label) => stance(label, "stated")), ["support", "support"]);
  assert.deepEqual(["excluded", "not_included"].map((label) => stance(label, "stated")), ["against", "against"]);
  // The note says nothing and the model read it in the patient's favour: 「未见记载，按未排除」 is silent. Read against, or in need of confirming, it is open.
  assert.deepEqual(["included", "not_excluded"].map((label) => stance(label, "silent")), ["silent", "silent"]);
  assert.deepEqual(["excluded", "not_included", "not_enough_information"].map((label) => stance(label, "silent")), ["open", "open", "open"]);
  assert.equal(stance("not_enough_information", "stated"), "open");
  assert.equal(stance("not_applicable", "stated"), "not_applicable");
  assert.equal(stance("not_applicable", "silent"), "not_applicable");
  // Every label the vocabulary has lands in one of the five.
  for (const label of VCR_CRITERION_LABELS) for (const basis of ["stated", "silent"]) assert.ok(["support", "against", "silent", "open", "not_applicable"].includes(stance(label, basis)), `${label} ${basis}`);
});

/** The counts of rows as the database computes them, from the stance this module defines. */
function countsFrom(rows, unanswered) {
  const stances = rows.map(stanceOf);
  return {
    answered: rows.length, unanswered,
    against: stances.filter((entry) => entry === "against").length,
    // Open in the rows: what the database counts as `nei` plus `silent_against`.
    open: stances.filter((entry) => entry === "open").length,
  };
}

test("a verdict from the counts is the verdict of the rows, for every mix of rows, scores and unanswered clauses", () => {
  const kinds = [];
  for (const label of VCR_CRITERION_LABELS) for (const basis of ["stated", "silent"]) kinds.push({ label, basis });
  /** Every multiset of up to three kinds, which is every combination of what the count can tell apart. */
  const mixes = [[]];
  for (const a of kinds) { mixes.push([a]); for (const b of kinds) { mixes.push([a, b]); for (const c of kinds) mixes.push([a, b, c]); } }
  let compared = 0;
  for (const mix of mixes) {
    for (const fit of [null, 0, 19, 20, 49, 50, 79, 80, 100]) {
      for (const unanswered of [0, 2]) {
        for (const missingReasons of [0, 1]) {
          const rows = mix.map((entry, index) => ({ ...entry, number: index + 1 }));
          const expected = trialVerdict({ fit, criteria: rows.length ? rows : null, missing: Array.from({ length: unanswered }), missingReasons: Array.from({ length: missingReasons }) });
          const counted = verdictOfCounts({ fit, counts: countsFrom(rows, unanswered), missingReasons });
          assert.equal(counted.verdict, expected.verdict, JSON.stringify({ mix, fit, unanswered, missingReasons }));
          compared += 1;
        }
      }
    }
  }
  assert.ok(compared > 20_000, `${compared} combinations`);
  // A pair with a score and no clause rows reads from the score and its missing reasons.
  assert.equal(verdictOfCounts({ fit: 90, counts: null, missingReasons: 0 }).verdict, "eligible");
  assert.equal(verdictOfCounts({ fit: 90, counts: null, missingReasons: 2 }).verdict, "possible");
  assert.equal(verdictOfCounts({ fit: null, counts: null }).verdict, "insufficient");
});

test("a score is a plain level on the bands the verdict reads, and the confidence a word", () => {
  assert.deepEqual([100, 80, 79, 50, 49, 20, 19, 0].map(vcrMatchFitLevel), ["high", "high", "medium", "medium", "low", "low", "minimal", "minimal"]);
  assert.equal(vcrMatchFitLevel(null), null);
  assert.equal(vcrMatchFitLevel("x"), null);
  assert.deepEqual([1, 0.8, 0.79, 0.5, 0.49, 0].map(vcrMatchConfidenceLevel), ["high", "high", "medium", "medium", "low", "low"]);
  assert.equal(vcrMatchConfidenceLevel(undefined), null);
});

test("a pair that failed says why in plain words, and an internal code never reaches a person", () => {
  for (const [code, words] of Object.entries(VCR_MATCH_FAILURE_REASONS_ZH)) {
    assert.equal(vcrMatchFailureReason(code), words);
    assert.doesNotMatch(words, /[A-Za-z_]{4,}/u, code);
  }
  assert.equal(vcrMatchFailureReason("vcr_match_judge_brand_new"), "这一对没有判成");
  assert.equal(vcrMatchFailureReason(null), "这一对没有判成");
});

test("a CSV cell is quoted where it must be, and a text Excel would read as a formula stays text", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(72), "72");
  assert.equal(csvCell(-3), "-3", "a number is a number");
  assert.equal(csvCell(true), "是");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "x"'), '"say ""x"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell("line\r\nbreak"), '"line\nbreak"');
  for (const risky of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "=HYPERLINK(\"http://x\")"]) {
    const cell = csvCell(risky);
    assert.match(cell.replace(/^"/u, ""), /^'/u, `${JSON.stringify(risky)} is prefixed: ${cell}`);
  }
  // A sentence that starts with a dash in a note, the commonest real one.
  assert.equal(csvCell("- 无糖尿病史"), "'- 无糖尿病史");
  assert.equal(csvLine(["a", 1, null, "=x"]), "a,1,,'=x\r\n");
});
