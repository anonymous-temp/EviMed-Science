// The study type a planned deliverable declares (owner ruling 2026-09-24:
// 「计划阶段先声明研究类型再挂，同时交付物里也放上」): a closed vocabulary, the
// reporting guideline each type is written to, and the plan's handling of it —
// absent is legal, unknown is an issue the model repairs, never a crash.
import assert from "node:assert/strict";
import test from "node:test";

import {
  REPORTING_CHECKLIST_FILE,
  REPORTING_GUIDELINES,
  REPORTING_GUIDELINE_TEMPLATE_DIR,
  STUDY_TYPES,
  STUDY_TYPE_LABELS_ZH,
  isStudyType,
  reportingGuidelineFor,
  studyTypeLabel,
  validateTaskPlan,
} from "../index.mjs";

test("the vocabulary is small, closed and labelled, and each guideline is named once", () => {
  assert.deepEqual([...STUDY_TYPES], [
    "rct", "prediction-model", "systematic-review", "mendelian-randomization", "observational", "diagnostic-accuracy", "other",
  ]);
  for (const type of STUDY_TYPES) {
    assert.match(type, /^[a-z][a-z-]*[a-z]$/, `${type} is not a kebab-case id`);
    assert.match(STUDY_TYPE_LABELS_ZH[type] ?? "", /[一-鿿]/, `${type} has no Chinese label`);
    assert.equal(isStudyType(type), true);
  }
  assert.deepEqual(
    Object.fromEntries(STUDY_TYPES.map((type) => [type, reportingGuidelineFor(type)?.id ?? null])),
    {
      rct: "consort-2025",
      "prediction-model": "tripod-ai",
      "systematic-review": "prisma-2020",
      "mendelian-randomization": "strobe-mr",
      observational: null,
      "diagnostic-accuracy": null,
      other: null,
    },
    "which design is written to which guideline is the ruling this module carries",
  );
  assert.deepEqual(Object.keys(REPORTING_GUIDELINES).sort(), ["consort-2025", "prisma-2020", "strobe-mr", "tripod-ai"]);
  for (const [id, guideline] of Object.entries(REPORTING_GUIDELINES)) {
    assert.equal(guideline.id, id);
    assert.ok(guideline.name.trim(), `${id} has no name`);
    assert.match(guideline.citation, /\b(?:BMJ|JAMA) 20\d\d;\d+/, `${id} does not cite where it was published`);
    assert.match(guideline.url, /^https:\/\/doi\.org\/10\.\d{4,}\//, `${id} names no DOI`);
    assert.equal(guideline.template, `${REPORTING_GUIDELINE_TEMPLATE_DIR}/${id}.md`);
  }
  assert.equal(REPORTING_GUIDELINES["consort-2025"].name, "CONSORT 2025");
  assert.equal(REPORTING_GUIDELINES["tripod-ai"].name, "TRIPOD+AI");
  assert.equal(REPORTING_CHECKLIST_FILE, "reporting-checklist.md");
});

test("a value outside the vocabulary has no guideline and reads as itself", () => {
  for (const value of ["", "cohort", "RCT", null, undefined, 3]) {
    assert.equal(isStudyType(value), false, String(value));
    assert.equal(reportingGuidelineFor(value), null, String(value));
  }
  assert.equal(studyTypeLabel("rct"), "随机对照试验");
  assert.equal(studyTypeLabel("cohort"), "cohort", "an unknown value is shown as given, never as a guess");
});

/** @param {Record<string, unknown>} extra */
const plan = (extra) => validateTaskPlan({
  revision: 1,
  clarifications: ["Assumed the uploaded trial data are final."],
  deliverables: [{ id: "results", contractKind: "manuscript-section", capability: "manuscript-support", title: "结果", dependsOn: [], ...extra }],
});

test("a deliverable that reports no one study declares nothing, and nothing is added for it", () => {
  const result = plan({});
  assert.ok(result.ok, JSON.stringify(result.issues));
  assert.equal(Object.hasOwn(result.plan?.deliverables[0] ?? {}, "studyType"), false);
  for (const empty of ["", "  ", null]) {
    const blank = plan({ studyType: empty });
    assert.ok(blank.ok, `${JSON.stringify(empty)} is the field left empty, not a study type: ${JSON.stringify(blank.issues)}`);
    assert.equal(Object.hasOwn(blank.plan?.deliverables[0] ?? {}, "studyType"), false);
  }
});

test("a declared study type is kept on the deliverable", () => {
  const result = plan({ studyType: " rct " });
  assert.ok(result.ok, JSON.stringify(result.issues));
  assert.equal(result.plan?.deliverables[0].studyType, "rct");
  assert.equal(plan({ studyType: "prediction-model" }).plan?.deliverables[0].studyType, "prediction-model");
});

test("an unknown study type is an issue the plan's author repairs, naming the deliverable and the vocabulary", () => {
  const result = plan({ studyType: "cohort" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => [issue.code, issue.deliverableId]), [["plan_invalid", "results"]]);
  assert.match(result.issues[0].message, /unknown studyType "cohort"/);
  for (const type of STUDY_TYPES) assert.ok(result.issues[0].message.includes(type), `the issue does not offer ${type}`);
  assert.equal(result.plan?.deliverables.length, 1, "the rest of the plan is still read");
  assert.equal(Object.hasOwn(result.plan?.deliverables[0] ?? {}, "studyType"), false, "an unknown value never travels on");
});
