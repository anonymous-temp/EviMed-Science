import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { vcrDocumentsSeam } from "../src/vcrComposition.mjs";
import { createPatientTrials } from "../src/vcrPatientTrials.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { createVcrGatewayHandler } from "../src/vcrGateway.mjs";

const STUDY = { id: "s1", userId: "u1", cloudContext: { sessionId: "native1", runId: "r1" } };
const QUOTE = "ECOG 1";
const EVIDENCE = [{ quote: QUOTE, locator: { documentId: "d1", start: 0, end: QUOTE.length } }];
function fixture() {
  const trial = { id: "t1", registry: "chictr", registryId: "ChiCTR1", title: "Synthetic trial", status: "Recruiting", retrievedAt: "2026-10-25T00:00:00Z", eligibilityText: "ECOG <= 1" };
  const full = { id: "a1", summary: "eligible", counts: { satisfied: 1, unknown: 0, total: 1 }, asOf: "2026-10-25T00:00:00Z", evidenceGaps: [],
    judgments: [{ criterionId: "c1", state: "satisfied", applicable: true, decidedBy: "code", evidence: EVIDENCE }] };
  let withdrawn = false, authorized = true;
  const reads = [];
  const documents = vcrDocumentsSeam({ dataPlane: { async projectionText(input) { reads.push(input); return authorized ? { id: "d1", subjectKey: "P1", text: QUOTE } : null; } } });
  const candidates = { async getCandidateTrial() { return trial; }, async listCriteria() { return []; }, async latestAssessments() { return new Map([[trial.id, full]]); }, async getAssessment() { return full; } };
  const patientTrials = createPatientTrials({ candidateStore: candidates, matchStore: { async withdrawnSubjects() { return new Set(withdrawn ? ["P1"] : []); } }, documents });
  return { patientTrials, reads, setWithdrawn: value => { withdrawn = value; }, setAuthorized: value => { authorized = value; } };
}
test("patient-to-trial runtime detail revalidates criterion quotations and preserves individual criteria counts", async () => {
  const f = fixture();
  const result = await f.patientTrials.runtimeRead(STUDY, { id: "t1", subjectKey: "P1" });
  assert.deepEqual(result.assessment.judgments[0].evidence, EVIDENCE);
  assert.deepEqual(result.assessment.criteriaCounts, { satisfied: 1, unknown: 0 });
  const shown = new VcrService({ store: {}, config: {} }).forModel(result);
  assert.equal(shown.assessment.criteriaCounts.satisfied, 1);
  f.setAuthorized(false);
  const denied = await f.patientTrials.runtimeRead(STUDY, { id: "t1", subjectKey: "P1" });
  assert.deepEqual(denied.assessment.judgments[0].evidence, []);
  assert.equal(denied.assessment.evidenceCoverage.withheld, 1);
});
test("a withdrawn patient has no runtime candidate assessment, evidence or work requests", async () => {
  const f = fixture(); f.setWithdrawn(true);
  const result = await f.patientTrials.runtimeRead(STUDY, { id: "t1", subjectKey: "P1" });
  assert.equal(result.withdrawn, true);
  assert.equal(result.assessment, null);
  assert.deepEqual(result.requests, []);
  assert.equal(f.reads.length, 0);
});
test("selected source-bound table evidence is reconstructed under its current grant, source permission and snapshot", async () => {
  const reads = [];
  const documents = vcrDocumentsSeam({ dataPlane: { async subjectTableEvidence(input) { reads.push(input); return { quote: "ecog = 1", value: 1, unit: null, locator: { snapshotId: "ss1", field: "ecog", subjectKey: "P1", sourceHash: "h1" } }; } } });
  const original = { quote: "ecog（数据表列 ecog）", variable: "ecog", locator: { snapshotId: "ss1", field: "ecog" }, quoteKind: "snapshot_cell" };
  const result = await documents.runtimeEvidence(STUDY, [original], "P1");
  assert.equal(result[0].quote, "ecog = 1");
  assert.equal(result[0].value, 1);
  assert.equal(reads[0].principal, "u1");
  assert.deepEqual(reads[0].cloudContext, STUDY.cloudContext);
  const page = await documents.viewEvidence(STUDY, [original], "P1", { id: "member2" });
  assert.equal(page[0].value, 1);
  assert.equal(reads[1].principal, "member2");
  assert.equal(reads[1].external, false);
  const shown = new VcrService({ store: {}, config: {} }).forModel({ subjectKey: "P1", evidence: result,
    diagnostics: { arms: [{ arm: "A", n: 3, mean: 1 }, { arm: "B", n: 15, mean: 4 }] } });
  assert.equal(shown.evidence[0].value, 1, "an authorized selected individual's value is not a group count");
  assert.equal(shown.diagnostics.arms[0].n, null);
  assert.equal(shown.diagnostics.arms[0].mean, undefined, "small-group summaries remain suppressed");
});

test("the reverse matching gateway attributes patient evidence to the exact native run before reading sources", async () => {
  const read = [];
  const handler = createVcrGatewayHandler({ vcrEnabled: true }, { assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "p1" }) }, {
    vcr: { store: { async studyByControlProject() { return { id: "s1", userId: "u1", projectId: "p1", conversationSessionId: "native1" }; } },
      service: { allows: () => true, async runtimeRead(study) { read.push(study.cloudContext); return { assessment: null }; } } },
    resolveInvocation: async () => ({ userId: "u1", projectId: "p1", rootSessionId: "native1", sessionId: "native1", runId: "r1" }),
    readProducerRun: async (_study, runId) => ({ id: runId, sessionId: "native1" }),
  });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ what: "candidate_trials", filter: { id: "trial1", subjectKey: "P1" } }))]),
    { method: "POST", url: "/internal/vcr/v1/read", headers: { authorization: "Bearer test", "x-evimed-execution-context": "trusted-fixture" } });
  const response = { status: 0, writeHead(status) { this.status = status; }, end() {} };
  await handler(req, response);
  assert.equal(response.status, 200);
  assert.deepEqual(read, [{ runId: "r1", sessionId: "native1" }]);
});
