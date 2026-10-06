// The public 「模拟研究」 column (flywheel plan §5.6, ruling 10, 2026-10-06): the lead publishes a report, the public reads a frozen
// copy of it. Two invariants are held here: nothing patient-level reaches the column (the report model passes the runtime's own
// small-cell boundary before the template is rendered, and a subject key in the words is refused), and a simulated number is
// published as what it is — labelled, with the sentence that it is not evidence — and never lands in an evidence card.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { evidenceValueSourceIssues } from "@evimed/domain";

import { createVcrPublications, createVcrPublicSimulations, VCR_SIMULATION_NOT_EVIDENCE } from "../src/vcrPublications.mjs";
import { seedEngineResult, skipWithoutDatabase, startVcr } from "./helpers/vcrFlywheelFixture.mjs";

/** @type {Awaited<ReturnType<typeof startVcr>>} */
let fixture;
/** @type {any} */
let study;
/** @type {any} */
let publications;
/** @type {any} */
let reader;
const LEAD = { id: "u-lead", name: "李研究" };
const TEMPLATE = "按 1000 次模拟，试验的把握度约为 {{n:measure(power).value|pct1}}（蒙特卡洛标准误 {{n:measure(power).mcse|f3}}）。"
  + "真实队列 {{n:counts.realPatients|int}} 例，事件 {{n:counts.events|int}} 例。";

before(async () => {
  if (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL) return;
  fixture = await startVcr({ label: "vcrpub", config: { vcrPublicSimulationsEnabled: true, vcrMinCellSize: 10 }, withFrontier: true, users: ["u-lead"] });
  study = await fixture.vcr.store.createStudy({ userId: LEAD.id, projectId: "prj-pub", name: "EV-401 模拟", question: "q", dataTier: "T0" });
  publications = createVcrPublications({ store: fixture.vcr.store, service: fixture.vcr.service, matchStore: fixture.vcr.matchStore });
  reader = createVcrPublicSimulations({ store: fixture.vcr.store });
});
after(async () => { await fixture?.close(); });

/** An export whose cover holds a report model with the given counts, and one report written against it. */
async function exportWith({ counts, template = TEMPLATE, kind = "simulation_report", withResult = true }) {
  const seeded = withResult ? await seedEngineResult(fixture.vcr, study, { kind: "trial_scenario", subjectId: "scn_a",
    measures: [{ name: "power", value: 0.8123, mcse: 0.0124, source: "predicted", simulated: true }], counts: {} }) : null;
  const model = {
    study: { id: study.id, name: study.name, question: "q", dataTier: "T0", intendedUse: "exploratory" }, intendedUse: "exploratory",
    counts, measures: [{ name: "power", value: 0.8123, mcse: 0.0124, source: "predicted", simulated: true }],
    results: seeded ? { trial_scenario: { id: seeded.result.id, measures: [], counts: {} } } : {}, scenarioResults: {}, assumptions: [
      { key: "dropout", name: "脱落率", version: 1, value: 0.12, unit: null, valueSource: "extracted", distribution: {}, reviewState: "ai_set" }],
    review: { records: [] }, stale: [{ node: "result:x@1", reason: "assumption_changed" }], seal: { required: false },
  };
  const row = await fixture.vcr.store.createExport({ studyId: study.id, userId: LEAD.id, kind, cover: { results: model, reports: [{ section: "main", template }], reviewed: false } });
  return row;
}

test("a published report is a frozen public copy whose numbers each carry their value source, with the fixed sentence", skipWithoutDatabase, async () => {
  const row = await exportWith({ counts: { realPatients: 3412, events: 241 } });
  const published = await publications.publish(LEAD, study, { exportId: row.id, title: "EV-401 试验模拟", summary: "两臂随机试验的把握度模拟。" });
  assert.equal(published.existing, false);

  const read = await reader.get(published.id);
  assert.equal(read.studyKind, "simulation_report");
  assert.deepEqual(read.producer, { kind: "researcher", name: "李研究" });
  assert.equal(read.intendedUse, "探索");
  assert.equal(read.notEvidence, VCR_SIMULATION_NOT_EVIDENCE);
  assert.equal(read.limitations.at(-1), VCR_SIMULATION_NOT_EVIDENCE);
  assert.equal(read.limitations.some((line) => line.includes("尚未重算")), true, "an unrecomputed result is a stated limitation");
  const [section] = read.sections;
  assert.equal(section.text.includes("81.2%"), true, "the number is rendered by code from the model");
  const power = section.values.find((entry) => entry.label.includes("功效") || entry.value === 0.8123);
  assert.equal(power.valueSource, "predicted", "a simulated measure says so");
  assert.equal(power.valueSourceLabel, "预测");
  assert.equal(section.values.every((entry) => ["observed", "extracted", "calculated", "imputed", "aggregate", "reconstructed", "predicted", "assumed", "synthetic"].includes(entry.valueSource)), true);
  assert.equal(read.receipts.length, 1);
  assert.equal(read.receipts[0].engineJobId, "engine-job-1");
  assert.equal(Object.hasOwn(read.receipts[0], "location"), false);

  const list = await reader.list({ limit: 10 });
  assert.deepEqual(list.map((entry) => entry.id), [published.id]);
  assert.deepEqual(Object.keys(list[0]).sort(), ["id", "producer", "publishedAt", "studyKind", "summary", "title"]);

  // Asking again returns the live one; the numbers are the form that was published, not a re-render of a changed study.
  const again = await publications.publish(LEAD, study, { exportId: row.id, title: "改名", summary: "x" });
  assert.equal(again.existing, true);
  assert.equal(again.id, published.id);
});

test("a small cell is suppressed by the runtime's own boundary before the template is rendered: the column never carries it", skipWithoutDatabase, async () => {
  // Seven people and three events are under the floor of ten; 3412 is not.
  const row = await exportWith({ counts: { realPatients: 7, events: 3 }, withResult: false });
  const published = await publications.publish(LEAD, study, { exportId: row.id, title: "小格子", summary: "" });
  const read = await reader.get(published.id);
  const text = read.sections.map((section) => section.text).join("\n");
  assert.equal(text.includes("未计算"), true, "a hidden count reads 「未计算」, as it does to a run");
  assert.equal(/真实队列 7 例|事件 3 例/.test(text), false);
  const stored = JSON.stringify((await fixture.vcr.store.one("SELECT sections FROM evimed_vcr.published_simulations WHERE id = $1", [published.id])).sections);
  assert.equal(stored.includes('"value":7') || stored.includes('"value":3'), false, "and no row of the table holds the small number");

  // Control: the same report with a count above the floor publishes it.
  const open = await publications.publish(LEAD, study, { exportId: (await exportWith({ counts: { realPatients: 3412, events: 241 }, withResult: false })).id, title: "大格子", summary: "" });
  assert.equal((await reader.get(open.id)).sections[0].text.includes("3412 例") || (await reader.get(open.id)).sections[0].text.includes("3,412"), true);
});

test("a subject key of the study in the words of a report is refused by name; nothing is stored", skipWithoutDatabase, async () => {
  const row = await exportWith({ counts: { realPatients: 3412, events: 241 }, template: "受试者 P-001 的事件最早发生。{{n:counts.realPatients|int}} 例。", withResult: false });
  const before = (await fixture.vcr.store.one("SELECT count(*)::int AS n FROM evimed_vcr.published_simulations")).n;
  const guarded = createVcrPublications({ store: fixture.vcr.store, service: fixture.vcr.service,
    matchStore: { factSubjects: async () => [{ subjectKey: "P-001" }], subjectSummaries: async () => [] } });
  await assert.rejects(guarded.publish(LEAD, study, { exportId: row.id, title: "含受试者", summary: "" }),
    (error) => error.code === "vcr_publication_patient_data" && error.status === 422);
  await assert.rejects(guarded.publish(LEAD, study, { exportId: (await exportWith({ counts: {}, withResult: false })).id, title: "标题里有 P-001", summary: "" }),
    (error) => error.code === "vcr_publication_patient_data");
  assert.equal((await fixture.vcr.store.one("SELECT count(*)::int AS n FROM evimed_vcr.published_simulations")).n, before);
});

test("only the two reports are published, and only once they are written", skipWithoutDatabase, async () => {
  const pack = await fixture.vcr.store.createExport({ studyId: study.id, userId: LEAD.id, kind: "study_package", cover: {} });
  await assert.rejects(publications.publish(LEAD, study, { exportId: pack.id, title: "t", summary: "" }), (error) => error.code === "vcr_export_kind_invalid");
  const unwritten = await fixture.vcr.store.createExport({ studyId: study.id, userId: LEAD.id, kind: "simulation_report", cover: {} });
  await assert.rejects(publications.publish(LEAD, study, { exportId: unwritten.id, title: "t", summary: "" }), (error) => error.code === "vcr_publication_not_ready" && error.status === 409);
  await assert.rejects(publications.publish(LEAD, study, { exportId: "exp_nope", title: "t", summary: "" }), (error) => error.code === "vcr_export_not_found");
});

test("withdrawing hides the publication from the reader and keeps the record; a withdrawn one cannot be withdrawn again", skipWithoutDatabase, async () => {
  const row = await exportWith({ counts: { realPatients: 3412, events: 241 }, withResult: false });
  const published = await publications.publish(LEAD, study, { exportId: row.id, title: "待撤回", summary: "" });
  assert.equal((await reader.list({ limit: 100 })).some((entry) => entry.id === published.id), true);
  await publications.withdraw(LEAD, study, published.id);
  assert.equal(await reader.get(published.id), null);
  assert.equal((await reader.list({ limit: 100 })).some((entry) => entry.id === published.id), false);
  assert.equal((await fixture.vcr.store.one("SELECT withdrawn_by FROM evimed_vcr.published_simulations WHERE id = $1", [published.id])).withdrawn_by, LEAD.id, "the row stays");
  await assert.rejects(publications.withdraw(LEAD, study, published.id), (error) => error.code === "vcr_publication_not_found");
  // A publication of another study is not this study's to withdraw.
  const other = await fixture.vcr.store.createStudy({ userId: LEAD.id, projectId: "prj-pub-2", name: "另一个", question: "q", dataTier: "T0" });
  const live = await publications.publish(LEAD, study, { exportId: (await exportWith({ counts: {}, withResult: false })).id, title: "留着", summary: "" });
  await assert.rejects(publications.withdraw(LEAD, other, live.id), (error) => error.code === "vcr_publication_not_found");
  // A study deleted from the module takes its publications out of the column at once.
  await fixture.vcr.store.query("UPDATE evimed_vcr.studies SET deleted_at = now() WHERE id = $1", [other.id]);
  assert.equal((await reader.get(live.id)) !== null, true, "a different study's deletion does not matter");
  await fixture.vcr.store.query("UPDATE evimed_vcr.studies SET deleted_at = now() WHERE id = $1", [study.id]);
  assert.equal(await reader.get(live.id), null);
  await fixture.vcr.store.query("UPDATE evimed_vcr.studies SET deleted_at = NULL WHERE id = $1", [study.id]);
});

test("invariant: a published simulation is never an evidence card, and the card contract refuses the very values it carries", skipWithoutDatabase, async () => {
  const cards = async () => (await fixture.database.query("SELECT count(*)::int AS n FROM evimed_frontier.evidence_cards")).rows[0].n;
  const before = await cards();
  const row = await exportWith({ counts: { realPatients: 3412, events: 241 } });
  const published = await publications.publish(LEAD, study, { exportId: row.id, title: "不是证据", summary: "" });
  assert.equal(await cards(), before, "publishing writes no evidence card");
  const read = await reader.get(published.id);
  const simulated = read.sections.flatMap((section) => section.values).filter((entry) => ["predicted", "assumed", "synthetic"].includes(entry.valueSource));
  assert.equal(simulated.length > 0, true);
  for (const entry of simulated) {
    const issues = evidenceValueSourceIssues({ content: { comparisons: [{ label: entry.label, value: entry.value, valueSource: entry.valueSource }] } });
    assert.equal(issues.length, 1, `a card carrying ${entry.valueSource} is refused by name`);
    assert.equal(issues[0].code, "evidence_value_source_refused");
  }
});
