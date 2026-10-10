import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeGeoValue, geoValueImpacts, summarizeGeoValueCoverage } from "@evimed/domain";
import { buildJudgeInput, verifyJudgement } from "../src/geoJudge.mjs";
import { importGeoValue } from "../src/geoValueImport.mjs";
import { GeoService } from "../src/geoService.mjs";

test("partial, conflicting and negative findings survive an incremental update without manufactured fields", () => {
  const first = { scope: { population: "Adults", region: "CN" }, findings: [
    { id: "f1", statement: "No established comparative advantage", dimension: "effectiveness", certainty: "uncertain" },
    { id: "f2", statement: "Reporting signal; causality unknown", dimension: "safety", sourceRefs: ["FAERS"] },
    "Out-of-pocket cost is unknown", null,
  ], customContext: { supply: "intermittent" } };
  const updated = mergeGeoValue(first, { scope: { region: null }, findings: [{ id: "f1", limitations: "No head-to-head trial" }], researchResults: [] });
  assert.equal(updated.findings.length, 4);
  assert.equal(updated.findings[0].statement, first.findings[0].statement);
  assert.equal(updated.scope.population, "Adults");
  assert.equal(updated.scope.region, null);
  assert.deepEqual(updated.customContext, first.customContext);
  assert.equal(updated.score, undefined);
  assert.equal(updated.findings[1].incidence, undefined);
  assert.deepEqual(mergeGeoValue(updated, { findings: [] }).findings, updated.findings);
});

test("source impact follows exact links and tolerates malformed optional observations", () => {
  const impacts = geoValueImpacts({ sourceChanges: [null, "A notice", { id: "change", sourceId: "src-old" }],
    findings: [null, { id: "linked", sources: [{ sourceId: "src-old" }], groupIds: ["g1"] }, { id: "unrelated", sourceRefs: ["other"] }] },
  [{ id: "a1", groupId: "g1" }, { id: "a2", valueContext: { findingIds: ["unrelated"] } }]);
  assert.equal(impacts.length, 1);
  assert.deepEqual(impacts[0].findingIds, ["linked"]);
  assert.deepEqual(impacts[0].articleIds, ["a1"]);
});

test("semantic coverage preserves unknowns and reasonable non-recommendation outside the denominator", () => {
  assert.equal(summarizeGeoValueCoverage([{ status: "uncertain" }, { status: "not_applicable" }]).value, null);
  const summary = summarizeGeoValueCoverage([{ status: "represented" }, { status: "partial" }, { status: "not_applicable" }, {}]);
  assert.equal(summary.assessed, 2);
  assert.equal(summary.value, 50);
});

test("answer interpretation retains clinical conditions, drops fabricated quotations only, and leaves absent observations unknown", () => {
  const input = { owner: { userId: "u", projectId: "p" }, product: {}, competitors: [], careFlags: [],
    claims: [{ id: "c1", statement: "Adults only", quote: "Only adults were enrolled", population: "adults", elements: { comparator: "placebo" } }],
    value: { version: 2, data: { findings: [{ id: "f1", statement: "Benefit uncertain" }, { id: "f2", statement: "Safety signal" }] } },
    question: { text: "Is it appropriate for me?" }, answer: "The benefit remains uncertain; the study enrolled adults." };
  const built = buildJudgeInput(input);
  assert.match(built.prefix, /"population":"adults"/);
  assert.match(built.prefix, /placebo/);
  const judged = verifyJudgement({ statements: [], valueCoverage: [
    { findingId: "f1", status: "represented", quote: "The benefit remains uncertain", conditionsPreserved: true },
    { findingId: "f2", status: "represented", quote: "This medicine is always safe" },
    { findingId: "foreign", status: "not_addressed" },
  ] }, built, input);
  assert.equal(judged.valueBasisVersion, 2);
  assert.equal(judged.valueCoverage.length, 1);
  assert.equal(judged.valueCoverage[0].findingId, "f1");
  assert.deepEqual(verifyJudgement({}, built, input).valueCoverage, []);
});

test("failed specialist runs keep usable reports, optional value JSON is not required", async () => {
  const writes = [];
  await importGeoValue({ store: { writeValue: async (...args) => writes.push(args) }, project: { userId: "u", workspaceDir: "/work" },
    geoProject: { id: "g" }, run: { id: "r1", status: "failed", deliverables: [{ id: "safety-review", capability: "adr-analysis" }] },
    readFile: async (_root, path) => {
      if (path.endsWith("safety-report.md")) return Buffer.from("Reporting signal, not incidence or proof of causality. The requested subgroup could not be calculated.");
      throw new Error("Not produced");
    }, report: () => {} });
  assert.equal(writes.length, 1);
  const result = writes[0][2].researchResults[0];
  assert.equal(result.runStatus, "failed");
  assert.equal(result.verification, "unverified");
  assert.equal(result.materials.length, 1);
  assert.match(result.materials[0].excerpt, /not incidence/);
});

test("declared specialist artifacts are reusable while unsafe paths remain outside the import", async () => {
  const writes = [], reads = [];
  await importGeoValue({ store: { writeValue: async (...args) => writes.push(args) },
    project: { userId: "u", workspaceDir: "/work" }, geoProject: { id: "g" },
    run: { id: "r2", status: "failed", effectiveAgentId: "meta-analysis", deliverables: [{ id: "meta", capability: "" }] },
    capabilityOutputs: async (id) => {
      assert.equal(id, "meta-analysis");
      return ["meta-analysis-report.md", "meta-analysis-run.json", "../secret.txt", "/outside.md", "plot.png"];
    },
    readFile: async (_root, path) => {
      reads.push(path);
      if (path.endsWith("meta-analysis-report.md")) return Buffer.from("Usable synthesis; subgroup unavailable.");
      if (path.endsWith("meta-analysis-run.json")) return Buffer.from('{"status":"partial"}');
      throw new Error("Not produced");
    }, report: () => {} });
  assert.equal(writes[0][2].researchResults[0].materials.length, 2);
  assert.ok(reads.every(path => !path.includes("secret") && !path.includes("outside") && !path.includes("plot")));
});

test("coverage never combines different value bases and passes audience/group/engine scope to the measurement read", async () => {
  let parameters;
  const store = { latestValue: async () => ({ version: 2, data: { findings: [] } }), researchRequests: async () => [], listArticles: async () => [],
    query: async (_sql, args) => {
      parameters = args;
      return { rows: [1, 2].map(version => ({ engine: "deepseek", judge_extract: { valueBasisVersion: version,
        valueCoverage: [{ findingId: "f1", status: "represented" }] } })) };
    } };
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const value = await service.valueOf({ id: "g" }, { groupId: "group", audience: "caregiver", engine: "deepseek" });
  assert.equal(value.coverage.assessed, 1);
  assert.ok(value.observations.every(observation => observation.basisVersion === 2));
  assert.deepEqual(parameters, ["g", "deepseek", "group", "caregiver"]);
});
