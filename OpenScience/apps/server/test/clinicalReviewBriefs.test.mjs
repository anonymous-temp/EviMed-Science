import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const fixture = new URL("../../../evals/clinical-review-quality/briefs.json", import.meta.url);

test("clinical review briefs are executable questions with identified replay sources", async () => {
  const document = JSON.parse(await readFile(fixture, "utf8"));
  assert.equal(document.schemaVersion, "1.0.0");
  assert.equal(document.capability, "clinical-evidence-synthesis");
  assert.equal(document.briefs.length, 3);
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

