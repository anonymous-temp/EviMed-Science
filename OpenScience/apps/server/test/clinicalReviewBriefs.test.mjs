import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const fixture = new URL("../../../evals/clinical-review-quality/briefs.json", import.meta.url);

test("clinical review briefs are executable questions with identified replay sources", async () => {
  const document = JSON.parse(await readFile(fixture, "utf8"));
  assert.equal(document.schemaVersion, "1.0.0");
  assert.equal(document.capability, "clinical-evidence-synthesis");
  assert.equal(document.briefs.length, 4);
  for (const item of document.briefs) {
    assert.match(item.id, /^review-\d{3}-/);
    assert.ok(item.inputs.question.length >= 60, item.id + " needs a concrete clinical question");
    assert.ok(["narrative", "systematic", "scoping", "rapid"].includes(item.inputs.reviewType));
    assert.ok(item.inputs.sources.length >= 2, item.id + " needs identified replay sources");
    for (const source of item.inputs.sources) {
      assert.ok(source.identifier);
      assert.match(source.url, /^https:\/\//);
      assert.ok(source.role);
    }
    assert.ok(item.mustDo.length >= 3);
    assert.ok(item.mustNotDo.length >= 2);
  }
});

test("the overlapping-report brief names one verified trial identity", async () => {
  const { briefs } = JSON.parse(await readFile(fixture, "utf8"));
  const item = briefs.find((entry) => entry.id === "review-001-empa-kidney-report-family");
  const reports = item.inputs.sources.filter((source) => source.expectedStudyId === "NCT03594110");
  assert.equal(reports.length, 3);
  assert.equal(new Set(reports.map((source) => source.identifier)).size, 3);
});

test("the sparse-evidence brief keeps zero results separate from source failure", async () => {
  const { briefs } = JSON.parse(await readFile(fixture, "utf8"));
  const item = briefs.find((entry) => entry.id === "review-002-aripiprazole-sparse-safety");
  const searched = item.inputs.replaySearches.find((entry) => entry.status === "searched");
  const unavailable = item.inputs.replaySearches.find((entry) => entry.status === "unavailable");
  assert.equal(searched.resultsRetrieved, 0);
  assert.ok(unavailable.reason);
});


test("the English outline brief reuses verified sources and asks for a named GRADE outline in English", async () => {
  // 2026-10-28: a requested outline with a "Values and preferences" section was read as the reference list by the gate, and an English
  // report's safety rules read nothing at all. The brief asks for exactly that shape; its sources are review-001's, verified 2026-09-06.
  const { briefs } = JSON.parse(await readFile(fixture, "utf8"));
  const item = briefs.find((entry) => entry.id === "review-004-english-grade-outline");
  const first = briefs.find((entry) => entry.id === "review-001-empa-kidney-report-family");
  assert.deepEqual(item.inputs.sources, first.inputs.sources, "no unverified identifier is introduced");
  assert.match(item.inputs.question, /Values and preferences/);
  assert.match(item.inputs.question, /in English/);
  assert.ok(item.mustNotDo.some((entry) => /Chinese/.test(entry)));
});
