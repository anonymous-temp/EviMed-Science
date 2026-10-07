import test from "node:test";
import assert from "node:assert/strict";
import { createModuleEvolutionPolicies, validateModuleEvolutionPolicy } from "../src/moduleEvolutionPolicies.mjs";
import { createModuleEvolutionAdapters, geoInterventionIdentity, geoPolicyComparison } from "../src/moduleEvolutionAdapters.mjs";
import { recordFrontierExposure } from "../src/frontierEvolution.mjs";
import { deriveEvolutionCapabilityMap } from "../src/evolutionCapabilityMap.mjs";

test("an independently confirmed tool is supported only after its artifact activates", () => {
  const tool = {id:"tool",payload:{status:"staged",capabilityIds:["statistical-analysis"],artifactDigest:"digest",taskFamily:{operation:"calculate",inputShape:"table"}}};
  const input = {registry:[],methods:{},tools:[tool],evaluations:[{payload:{toolId:"tool",artifactDigest:"digest",passed:true,confirmatory:true,receiptValid:true}}]};
  assert.equal(deriveEvolutionCapabilityMap(input).cells[0].status,"untested");
  tool.payload.status = "active";
  assert.equal(deriveEvolutionCapabilityMap(input).cells[0].status,"supported");
});

test("policy reader rejects undeclared executable fields and falls back on unreadable revisions", async () => {
  assert.equal(validateModuleEvolutionPolicy("frontier", { code: "run()" }), false);
  const policies = createModuleEvolutionPolicies({ readPolicy: async () => ({ revisionId: "r1", policy: { selectionThreshold: 72 } }) });
  assert.deepEqual((await policies.resolve("frontier", { selectionThreshold: 82 })).policy, { selectionThreshold: 72 });
  const broken = createModuleEvolutionPolicies({ readPolicy: async () => { throw new Error("offline"); } });
  assert.equal((await broken.resolve("frontier", { selectionThreshold: 82 })).policy.selectionThreshold, 82);
  assert.equal(validateModuleEvolutionPolicy("geo", { supplements: [{ capabilityId: "vcr-analysis", text: "x" }] }), false);
});

test("development measurements and incomplete batches cannot activate policy", async () => {
  let published = false;
  const adapters = createModuleEvolutionAdapters({ enabled: { frontier: true }, runners: { frontier: async () => ({ pool: "development", units: [{ id: "a", score: 1, sourceHash: "hash" }] }) }, publish: async () => { published = true; } });
  assert.equal((await adapters.frontier.evaluate({ pool: "confirmation", batch: [] })).reason, "confirmation_batch_incomplete");
  assert.equal((await adapters.frontier.evaluate({ pool: "confirmation", batch: Array(30).fill({}) })).reason, "confirmation_not_measured");
  await adapters.frontier.publish({}, { status: "measured", pool: "development", accepted: true });
  assert.equal(published, false);
  assert.equal((await adapters.runtime.evaluate({})).status, "unavailable");
});

test("unknown assistant versions and concurrent placements prevent visibility attribution", () => {
  const intervention = geoInterventionIdentity({}, ["assistant"]);
  assert.equal(intervention.engines[0].observedVersion, "unknown");
  const baseline = { correctness: 1, visibility: 0.2, intervention };
  const candidate = { correctness: 0.9, visibility: 0.8, importantRiskOmissions: 0, intervention };
  assert.deepEqual(geoPolicyComparison(baseline, candidate), { correctnessPreserved: false, visibilityAttributable: false, visibilityGain: null });
});

test("exposure rejects items absent from the server snapshot before writing", async () => {
  let writes = 0;
  const database = { query: async (sql) => {
    if (sql.startsWith("SELECT")) return {rows: [{candidate_ids: ["1", "2"], surface: "feed", policy_revision_id: "r1"}]};
    writes++; return {rows: []};
  } };
  await assert.rejects(recordFrontierExposure(database, "user", {token: "token", items: [{id: "3",position: 0}]}), {code: "frontier_payload_invalid"});
  await recordFrontierExposure(database, "user", {token: "token",items: [{id: "1",position: 0}]});
  assert.equal(writes, 1);
});

test("an intended content treatment preserves attribution when confounders are fixed", () => {
  const identity = {questionSetVersion: 1, engines: [{engine: "assistant",observedVersion: "build-1"}],placements: [],channels: [],sourceRevision: "evidence-1"};
  const baseline = {correctness: 0.8,visibility: 0.2,intervention: {...identity,contentRevision: "old"}};
  const candidate = {correctness: 0.9,visibility: 0.4,importantRiskOmissions: 0,intervention: {...identity,contentRevision: "new"}};
  assert.equal(geoPolicyComparison(baseline,candidate).visibilityAttributable,true);
  candidate.intervention.channels = ["new-channel"];
  assert.equal(geoPolicyComparison(baseline,candidate).visibilityAttributable,false);
});

test("fresh curator requires exact public bytes, earliest-public proof and independent quote anchors", async () => {
  const {createModuleEvolutionCurator} = await import("../src/moduleEvolutionCurator.mjs");
  const {createHash} = await import("node:crypto");
  const sourceText = "The new study reports 12 events among 100 participants.";
  const sourceHash = createHash("sha256").update(sourceText).digest("hex");
  const added = [];
  const source = {sourceRoot:"study-1",sourceText,sourceHash,firstPublicAt:"2026-10-06T01:00:00Z",firstPublicEvidenceId:"gateway-source-1",provenanceResolved:true};
  const curator = createModuleEvolutionCurator({taskPool:{add:async task => added.push(task)},now:()=>new Date("2026-10-06T02:00:00Z"),
    readSnapshots:async()=>[source,{...source,sourceRoot:"wrong-bytes",sourceHash:"wrong"},{...source,sourceRoot:"old-study",firstPublicAt:"2026-10-01T00:00:00Z"}],
    extractTask:async()=>({id:"task-1",curatorIndependent:true,sourceQuotes:[sourceText],expect:["clinical"],edit:{}})});
  const result = await curator.curate({moduleId:"frontier",candidate:{frozenAt:"2026-10-05T00:00:00Z"},modelReleasedAt:"2026-10-04T00:00:00Z",epoch:"e1"});
  assert.equal(result.added,1);
  assert.equal(added[0].pool,"confirmation");
  assert.equal(added[0].sourceHash,sourceHash);
});

test("a candidate modifies one mutable component and its smoke executes known-correct units", async () => {
  const adapters = createModuleEvolutionAdapters({enabled:{frontier:true},runners:{frontier:async input=>({units:input.batch.map(item=>({id:item.id,score:1,sourceHash:"source"}))})}});
  const prepared = await adapters.frontier.prepare({policy:{selectionThreshold:81},proposal:{components:["selectionThreshold"]}});
  assert.equal(prepared.status,"prepared");
  assert.ok(prepared.baseline.policy.editInstructions);
  assert.equal((await adapters.frontier.prepare({policy:{selectionThreshold:81},proposal:{components:["editInstructions"]}})).reason,"declared_component_mismatch");
  assert.equal((await adapters.frontier.prepare({policy:{selectionThreshold:81,editInstructions:"changed"}})).reason,"candidate_must_change_one_component");
  assert.equal((await adapters.frontier.smoke({batch:[{id:"1"},{id:"2"}]})).passed,true);
});
