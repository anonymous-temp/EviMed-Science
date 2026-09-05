import assert from "node:assert/strict";
import test from "node:test";
import { runGate } from "@evimed/domain";

function packageFiles() {
  const context = { availableData: "A de-identified retrospective cohort", resourceConstraints: ["No prospective recruitment"] };
  const portfolio = {
    schemaVersion: "1.0.0", researchDirection: "A bounded research question", researchContext: context,
    candidates: [{
      candidateId: "R1", title: "A proposed validation study", sourceOpportunityId: "BOM1",
      sourceEvidenceIds: ["pubmed_100001"], sourceEvidencePmids: ["100001"],
      supportLevel: "indirect", supportRationale: "Evidence from a different setting.",
      hypothesis: "The prespecified estimate differs by setting.",
      studyDesign: "Retrospective cohort", estimand: "Adjusted association in the available cohort",
      dataRequirements: ["Exposure", "Outcome", "Prespecified confounders"],
      falsification: "The independent validation estimate is incompatible with the hypothesis.",
      feasibility: "Use existing data; verify access before analysis.",
      noveltyBasis: "The source motivates external validation; novelty is not established by one search.", gaps: [],
    }],
  };
  return new Map(Object.entries({
    "research-topic-report.md": "# Research topic\nAn explicitly provisional research agenda.",
    "research-topic-run.json": JSON.stringify({ researchContext: context }),
    "research-portfolio.json": JSON.stringify(portfolio),
    "evidence-records.json": JSON.stringify([{ id: "pubmed_100001", pmid: "100001" }]),
  }));
}

function run(files) {
  return runGate({
    contractKind: "research-topic-report", files,
    expectedOutputs: [
      { path: "research-topic-report.md", required: true },
      { path: "research-topic-run.json", required: true },
      { path: "research-portfolio.json", required: false },
      { path: "evidence-records.json", required: false },
    ],
  });
}

function changePortfolio(files, update) {
  const value = JSON.parse(files.get("research-portfolio.json"));
  update(value);
  files.set("research-portfolio.json", JSON.stringify(value));
}

test("topic portfolio reconciles recorded evidence and researcher constraints", () => {
  const result = run(packageFiles());
  assert.equal(result.ok, true);
  assert.equal(result.metrics.topicPortfolio?.candidates, 1);
  assert.equal(result.metrics.topicPortfolio?.structurallyCompleteCandidates, 1);
  assert.equal(result.metrics.topicPortfolio?.evidenceFilesConsistent, true);
  assert.equal(result.metrics.topicPortfolio?.contextFilesConsistent, true);
  assert.equal(result.metrics.topicPortfolio?.evidenceReconciled, undefined);
  assert.equal(result.metrics.topicPortfolio?.contextMatchesReceipt, undefined);
});

test("unknown source lineage is reported without adding a blocking gate", () => {
  const files = packageFiles();
  changePortfolio(files, (value) => { value.candidates[0].sourceEvidenceIds = ["invented"]; });
  const result = run(files);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.topicPortfolio?.evidenceFilesConsistent, false);
  assert.ok(result.issues.some((item) => item.check === "topic-evidence-lineage" && item.severity === "advisory"));
});

test("portfolio PMIDs must match the preserved records behind their source ids", () => {
  const files = packageFiles();
  changePortfolio(files, (value) => { value.candidates[0].sourceEvidencePmids = ["999999"]; });
  const result = run(files);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.topicPortfolio?.evidenceFilesConsistent, false);
  assert.ok(result.issues.some((item) => item.check === "topic-evidence-lineage"));
});

test("a missing source artifact is unreconciled, not verified by omission", () => {
  const files = packageFiles();
  files.delete("evidence-records.json");
  const result = run(files);
  assert.equal(result.metrics.topicPortfolio?.evidenceFilesConsistent, false);
  assert.ok(result.issues.some((item) => item.check === "topic-evidence-lineage"));
});

test("missing study plans remain explicit gaps, not actionable recommendations by default", () => {
  const files = packageFiles();
  changePortfolio(files, (value) => {
    value.candidates[0].estimand = null;
    value.candidates[0].falsification = null;
    value.candidates[0].gaps = ["estimand", "falsification"];
  });
  const result = run(files);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.topicPortfolio?.structurallyCompleteCandidates, 0);
  assert.equal(result.metrics.topicPortfolio?.unresolvedDesignFields, 2);
  assert.ok(result.issues.some((item) => item.check === "topic-study-plan" && item.severity === "advisory"));
});

test("unknown and false design gaps cannot make an incomplete candidate look reconciled", () => {
  const files = packageFiles();
  changePortfolio(files, (value) => {
    value.candidates[0].estimand = null;
    value.candidates[0].gaps = ["madeUpGap"];
  });
  const result = run(files);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.topicPortfolio?.structurallyCompleteCandidates, 0);
  assert.ok(result.issues.some((item) => item.check === "topic-study-plan"));
});

test("constraints cannot disappear between the engine receipt and portfolio unnoticed", () => {
  const files = packageFiles();
  changePortfolio(files, (value) => { value.researchContext.resourceConstraints = []; });
  const result = run(files);
  assert.equal(result.metrics.topicPortfolio?.contextFilesConsistent, false);
  assert.ok(result.issues.some((item) => item.check === "topic-research-context"));
});

test("candidate identifiers must be strings and duplicate candidate ids stay visible", () => {
  const malformed = packageFiles();
  changePortfolio(malformed, (value) => { value.candidates[0].candidateId = {}; });
  let result = run(malformed);
  assert.equal(result.metrics.topicPortfolio?.schemaValid, false);
  assert.ok(result.issues.some((item) => item.check === "topic-portfolio-schema"));

  const duplicated = packageFiles();
  changePortfolio(duplicated, (value) => { value.candidates.push({ ...value.candidates[0] }); });
  result = run(duplicated);
  assert.equal(result.metrics.topicPortfolio?.structurallyCompleteCandidates, 1);
  assert.ok(result.issues.some((item) => item.check === "topic-portfolio-schema" && item.message.includes("duplicate")));
});

test("deep optional context cannot escape the topic advisory validator", () => {
  const deep = '{"nested":'.repeat(5000) + 'null' + '}'.repeat(5000);
  const portfolio = '{"schemaVersion":"1.0.0","researchDirection":"Topic","researchContext":'
    + deep + ',"candidates":[]}';
  const files = new Map(Object.entries({
    "research-topic-report.md": "# Topic\nA bounded agenda.",
    "research-topic-run.json": '{"researchContext":' + deep + '}',
    "research-portfolio.json": portfolio,
    "evidence-records.json": "[]",
  }));
  let result;
  assert.doesNotThrow(() => { result = run(files); });
  assert.equal(result.ok, true);
  assert.equal(result.metrics.topicPortfolio?.contextFilesConsistent, false);
  assert.ok(result.issues.some((item) => item.check === "topic-research-context"));
});

test("a malformed optional portfolio has a specific repair notice", () => {
  const files = packageFiles();
  files.set("research-portfolio.json", "{broken");
  const result = run(files);
  assert.equal(result.ok, true);
  assert.ok(result.issues.some((item) => item.check === "topic-portfolio-schema"));
});

test("old topic packages do not gain a required portfolio artifact", () => {
  const files = packageFiles();
  files.delete("research-portfolio.json");
  files.delete("evidence-records.json");
  const result = run(files);
  assert.equal(result.ok, true);
  assert.ok(!result.issues.some((item) => item.check?.startsWith("topic-")));
});
