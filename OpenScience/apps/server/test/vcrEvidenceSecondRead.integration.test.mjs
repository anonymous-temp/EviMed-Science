// The second reading of an extracted value on a real PostgreSQL (algorithm round E1): the filing is one row per value, beside the
// append-only item; it is scoped to the account and the study; the study's deletion takes it; and the data tab carries a disagreement on the
// card that cites the value. The model is a stub.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { compareReadings } from "../src/vcrEvidenceSecondRead.mjs";
import { createVcrEvidenceSources } from "../src/vcrEvidenceSources.mjs";
import { VcrEvidenceStore } from "../src/vcrEvidenceStore.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { presentDataTab } from "../src/vcrViewsTabs.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required" };
let database, isolated, store, studies;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrsr");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 2000 });
  store = new VcrEvidenceStore({ database }); studies = new VcrStore({ database }); await store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); });

const QUOTE = "Overall survival: HR 0.62 (95% CI 0.48 to 0.95), p < 0.001; the upper limit is 0.80 in the abstract.";

test("a second reading is filed once per value, scoped to the account and the study; the card that cites the value carries the disagreement", options, async () => {
  const study = await studies.createStudy({ userId: "u1", projectId: "p1", name: "Synthetic second reading", question: "q", dataTier: "T0" });
  const other = await studies.createStudy({ userId: "u1", projectId: "p2", name: "Synthetic other study", question: "q", dataTier: "T0" });
  const hash = createHash("sha256").update(QUOTE).digest("hex");
  const sources = { async get(userId, id) { return { id, userId, projectId: "p1", payload: { generation: 1, analysis: { textSha256: hash } } }; },
    async loadCapture() { return { input: { text: QUOTE } }; } };
  const pipeline = createVcrEvidencePipeline({ store });
  pipeline.attachSources(createVcrEvidenceSources({ sources }));
  pipeline.attachSecondReader({ enabled: true, async check({ item }) {
    const second = { value: 0.62, ciLow: 0.48, ciHigh: 0.8 };
    return { ...compareReadings({ first: item, second, passage: QUOTE, label: "风险比", arm: item.arm, quote: item.quote }), second, model: "deepseek-flash" };
  } });
  const written = await pipeline.addEvidenceItem({ userId: "u1", studyId: study.id, projectId: "p1", item: {
    literatureSource: { sourceId: "src_one", generation: 1, textSha256: hash }, parameter: "hazard_ratio", arm: "Drug vs placebo", armRole: "contrast",
    value: 0.62, ciLow: 0.48, ciHigh: 0.95, quote: QUOTE, locator: { start: 0, end: QUOTE.length }, historicalBaseline: true, evidenceKind: "outcome", endpointKey: "os",
    pValue: 0.001, pRelation: "<" } });
  assert.equal(written.state, "verified");
  const notes = await pipeline.valueNotes({ userId: "u1", studyId: study.id, ids: [written.id], wait: true });
  // The value 0.62 (0.48 to 0.95) is also not symmetric on the log scale: the two checks tell different things about the same number.
  assert.deepEqual(notes.map((note) => note.kind), ["consistency", "second_read"]);
  assert.match(notes[1].message, /区间上限 第一次读到 0\.95，第二次读到 0\.8/);

  // One row per value: a repeated filing is dropped. The item itself is unchanged (append-only), and the first value stands.
  assert.equal(await store.saveSecondRead({ userId: "u1", studyId: study.id, evidenceId: written.id, outcome: "agree", reading: {} }), false);
  const [stored] = await store.itemsById({ userId: "u1", studyId: study.id, ids: [written.id] });
  assert.equal(Number(stored.ci_high), 0.95);
  assert.equal(stored.detail.pValue, 0.001, "the p-value the quotation prints is kept on the item");
  // Scoped: another account, another study, and an id that is not the study's value read nothing and write nothing.
  assert.deepEqual(await store.secondReads({ userId: "other", studyId: study.id }), []);
  assert.deepEqual(await store.secondReads({ userId: "u1", studyId: other.id }), []);
  assert.equal(await store.saveSecondRead({ userId: "u1", studyId: other.id, evidenceId: written.id, outcome: "differ", reading: {} }), false);
  assert.equal(await store.saveSecondRead({ userId: "other", studyId: study.id, evidenceId: written.id, outcome: "differ", reading: {} }), false);
  assert.equal((await store.secondReads({ userId: "u1", studyId: study.id })).length, 1);
  assert.deepEqual((await store.secondReads({ userId: "u1", studyId: study.id, outcome: "agree" })), []);
  assert.equal((await store.secondReads({ userId: "u1", studyId: study.id, ids: [written.id], outcome: "differ" })).length, 1);
  assert.equal((await store.secondReads({ userId: "u1", studyId: study.id, ids: ["evd_nobody"] })).length, 0);

  // The data tab: the card that cites the value carries both numbers; the p-value stated in the quotation held the interval to its verdict.
  const card = { id: "a1", key: "os_hr", name: "os_hr", version: 1, pointValue: 0.62, unit: null, reviewState: "ai_set", sourceKind: "external_evidence",
    valueSource: "extracted", pooling: {}, evidenceIds: [written.id] };
  const evidence = { available: true, precedents: [], items: await store.listEvidenceItems({ userId: "u1", studyId: study.id }),
    secondReads: await store.secondReads({ userId: "u1", studyId: study.id, outcome: "differ" }) };
  const data = presentDataTab({ study, assumptions: [card], scenarios: [], stale: [], decisions: [], reviews: [], edges: [], now: new Date(), evidence,
    dataPlane: { available: false }, assumptionVersions: new Map(), jobs: [], candidates: [] });
  assert.deepEqual(data.assumptions[0].valueChecks.map((check) => check.kind), ["consistency", "second_read"]);

  // The study's deletion takes the filing with it.
  await studies.query("DELETE FROM evimed_vcr.studies WHERE id = $1", [study.id]);
  assert.equal((await studies.rows("SELECT id FROM evimed_vcr.evidence_second_reads WHERE study_id = $1", [study.id])).length, 0);
});
