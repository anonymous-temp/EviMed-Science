// The two capability contracts added on 2026-09-02, and the properties that
// were wrong when they arrived.
//
// Both ship as *contributors* — they return `{issues, metrics}` and the
// registry merges them into `validateReportShaped`'s verdict — rather than as
// whole validators. That is what keeps the shared required-output pass and
// prose hygiene in one place; the manuscript module originally carried its own
// copies of both, which is the drift a single-implementation rule exists to
// prevent.
import assert from "node:assert/strict";
import test from "node:test";

import { appraisalTableFindings } from "../src/appraisalContract.mjs";
import { MANUSCRIPT_SCRATCH_FILE, manuscriptSectionFindings } from "../src/manuscriptContract.mjs";
import { citationIntegrityIssues } from "../src/clinicalEvidence.mjs";
import { runGate } from "../index.mjs";

const gateInput = (contractKind, files) => ({ contractKind, files: new Map(Object.entries(files)), declaredOutputs: [] });

/* ------------------------------------------------- the blocking budget */

test("neither contributor can raise a blocking issue", () => {
  // Blocking for these kinds stays where it already was: the manifest's
  // required outputs. A contributor that could return a `required` issue would
  // be a seventh blocking point arriving without anybody deciding on one.
  const cases = [
    ["appraisal-table", appraisalTableFindings, { "appraisal-table.json": "{ not json", "citation-ledger.csv": "" }],
    ["manuscript-section", manuscriptSectionFindings, { "manuscript-section.md": "无引用的一段话。", "section-claims.json": "{ not json", "citation-ledger.csv": "" }],
  ];
  let examined = 0;
  for (const [kind, contribute, files] of cases) {
    const { issues } = contribute(gateInput(kind, files));
    examined += 1;
    // Malformed input on purpose: a contributor that returns nothing here is
    // not proving it cannot block, it is proving it did not look.
    assert.ok(issues.length > 0, `${kind} found nothing in a deliberately malformed package; the probe, not the contract, is wrong`);
    const blocking = issues.filter((entry) => entry.severity !== "advisory");
    assert.deepEqual(blocking, [], `${kind} raised a non-advisory issue: ${blocking.map((entry) => entry.code).join(", ")}`);
  }
  assert.equal(examined, 2, "both contracts must be examined");
});

/* ------------------------------------------ the citation grammar V3 found */

test("the manuscript module reads citations with the same grammar as the check it composes", () => {
  // The module used to accept ranges (`[1-2]`) and expand them, while
  // `citationIntegrityIssues` — which the composed validator applies at
  // `required` severity to the same file — recognises comma-separated lists
  // only. A section written with `[1-2]` therefore read as clean here and was
  // then blocked by the shared check reporting those references as never
  // cited. A laxer parser beside a blocking one does not add tolerance; it
  // teaches runs to write citations the gate rejects.
  const withList = "结论如此[1,2]。\n\n## 参考文献\n\n1. A\n2. B\n";
  const withRange = "结论如此[1-2]。\n\n## 参考文献\n\n1. A\n2. B\n";

  const sharedOnList = citationIntegrityIssues(withList);
  const sharedOnRange = citationIntegrityIssues(withRange);
  assert.equal(sharedOnList.length, 0, "the shared check accepts a comma list");
  assert.ok(sharedOnRange.length > 0, "the shared check does not accept a range — if this changed, the module may follow");

  // The module must agree with it: a range is not a citation here either.
  const listFindings = manuscriptSectionFindings(gateInput("manuscript-section", {
    "manuscript-section.md": withList,
    "citation-ledger.csv": "claimId,referenceNumber,supportQuote\nCLM-001,1,q\nCLM-002,2,q\n",
  }));
  const rangeFindings = manuscriptSectionFindings(gateInput("manuscript-section", {
    "manuscript-section.md": withRange,
    "citation-ledger.csv": "claimId,referenceNumber,supportQuote\nCLM-001,1,q\nCLM-002,2,q\n",
  }));
  assert.equal(
    listFindings.metrics.manuscriptCitationsInSection,
    2,
    "a comma list is two citations",
  );
  assert.equal(
    rangeFindings.metrics.manuscriptCitationsInSection,
    0,
    "a range must read as no citation here, exactly as it does to the blocking check",
  );
});

/* ------------------------------------------------- the scratch file V2 found */

test("the pre-edit snapshot is caught by name rather than by asking the run to remember", () => {
  const shipped = manuscriptSectionFindings(gateInput("manuscript-section", {
    "manuscript-section.md": "一段正文。",
    [MANUSCRIPT_SCRATCH_FILE]: "一段正文。",
  }));
  const found = shipped.issues.filter((entry) => entry.code === "manuscript_scratch_file_delivered");
  assert.equal(found.length, 1, "a delivered snapshot is reported");
  assert.equal(found[0].severity, "advisory");

  const clean = manuscriptSectionFindings(gateInput("manuscript-section", { "manuscript-section.md": "一段正文。" }));
  assert.equal(clean.issues.filter((entry) => entry.code === "manuscript_scratch_file_delivered").length, 0);
});

test("the snapshot is not graded as report prose", () => {
  // Scanned as prose, a scratch file could block the package at `required`
  // severity for leakage the delivered section did not contain — the run would
  // be told to fix a file it was told to delete.
  const verdict = runGate(gateInput("manuscript-section", {
    "manuscript-section.md": "一段干净的正文。",
    [MANUSCRIPT_SCRATCH_FILE]: "我先用 bash 跑了 grep，再把结果贴进来。",
  }));
  const fromScratch = verdict.issues.filter((entry) => entry.path === MANUSCRIPT_SCRATCH_FILE && entry.severity === "required");
  assert.deepEqual(fromScratch, [], "the snapshot must not produce a blocking prose finding");
});

/* ---------------------------------------------- the appraisal arithmetic */

test("a certainty that does not follow from its own downgrades is reported", () => {
  // The one check that finds a table where every field is filled in and the
  // answer is still wrong.
  const table = (certainty) => JSON.stringify({
    question: "在 HFpEF 患者中，SGLT2 抑制剂能否降低心衰再住院？",
    studies: [
      {
        id: "S1",
        design: "randomized-controlled-trial",
        identifier: { type: "doi", value: "10.1056/NEJMoa2107038" },
        domains: {
          riskOfBias: { rating: "low", reason: "预注册，分配隐藏充分" },
          indirectness: { rating: "low", reason: "人群与问题一致" },
          imprecision: { rating: "serious", reason: "置信区间跨越临床决策阈值" },
        },
      },
    ],
    bodies: [
      { id: "B1", outcome: "心衰再住院", studyIds: ["S1"], startingCertainty: "high",
        downgrades: [{ domain: "imprecision", steps: 1, reason: "置信区间宽" }], upgrades: [],
        certainty, whatWouldChange: "一项更大样本的试验" },
    ],
  });
  const files = (certainty) => ({
    "appraisal-table.json": table(certainty),
    "appraisal-table.csv": "studyId\nS1\n",
    "citation-ledger.csv": "identifier\n10.1056/NEJMoa2107038\n",
  });

  const correct = appraisalTableFindings(gateInput("appraisal-table", files("moderate")));
  assert.equal(correct.metrics.appraisalCertaintyArithmeticMismatches, 0, "high minus one downgrade is moderate");

  const wrong = appraisalTableFindings(gateInput("appraisal-table", files("high")));
  assert.equal(wrong.metrics.appraisalCertaintyArithmeticMismatches, 1, "a downgrade that did not move the rating is reported");
  // Reported by code, not counted in silence. A metric nobody is told about is
  // a number, not a verdict: the run cannot repair what it is not shown.
  const reported = wrong.issues.filter((entry) => entry.code === "appraisal_certainty_does_not_follow");
  assert.equal(reported.length, 1, "the mismatch is reported, not only counted");
  assert.equal(reported[0].severity, "advisory");
  assert.match(reported[0].message, /lands on moderate/, "and the message names the rung the arithmetic reaches");
});
