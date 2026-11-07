import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { vcrDocumentsSeam } from "../src/vcrComposition.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { createVcrGatewayHandler } from "../src/vcrGateway.mjs";

const STUDY = { id: "s1", userId: "u1", cloudContext: { sessionId: "native1", runId: "r1" } };
test("selected source-bound table evidence is reconstructed under its current grant, source permission and snapshot", async () => {
  const reads = [];
  const documents = vcrDocumentsSeam({ dataPlane: { async subjectTableEvidenceBatch(input) { reads.push(input); return { ecog: { quote: "ecog = 1", value: 1, unit: null, locator: { snapshotId: "ss1", field: "ecog", subjectKey: "P1", sourceHash: "h1" } } }; } } });
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


test("table evidence batches all fields of each snapshot once per viewer request", async () => {
 const calls=[];
 const documents=vcrDocumentsSeam({dataPlane:{async subjectTableEvidenceBatch(input){ calls.push(input); return Object.fromEntries(input.fields.map(field=>[field,{quote:`${field} = 1`,value:1,locator:{sourceHash:"h1",field}}])); }}});
 const entries=["age","ecog","age"].map(field=>({locator:{snapshotId:"snp1",field,sourceHash:"h1"}}));
 assert.equal((await documents.viewEvidence(STUDY,entries,"P1",{id:"viewer"})).length,3);
 assert.equal(calls.length,1); assert.deepEqual(calls[0].fields,["age","ecog"]);
 assert.equal(calls[0].principal,"viewer"); assert.equal(calls[0].external,false);
 await documents.viewEvidence(STUDY,entries,"P1",{id:"other"});
 assert.equal(calls.length,2,"no cross-viewer or cross-request cache");
 assert.equal(calls[1].principal,"other");
});
