/**
 * The consistency check on extracted values, as the server reads it (algorithm round E2): the stored row as the domain's function wants it, a
 * registry's own p-value text, a card that carries the notes of the evidence it cites, and a write whose answer names the numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { VCR_PARAMETER_KINDS } from "../src/vcrEvidence.mjs";
import { QUANTITIES, RATE_PARAMETERS, evidenceValueFindings, extractedValueOfRow, parsePrintedP } from "../src/vcrValueChecks.mjs";
import { presentDataTab } from "../src/vcrViewsTabs.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";

/** @param {Record<string, any>} fields a stored row, with the columns a check reads */
const row = (fields) => ({ id: "e1", parameter: "hazard_ratio", arm: "Drug vs placebo", arm_role: "contrast", unit: "", endpoint_key: "os", precedent_id: "p1",
  source_ref: "ctgov:NCT1", locator: { verification: "verified" }, detail: {}, created_at: new Date("2026-11-03T10:00:00Z"), ...fields });

test("the parameters the check knows by name are the pipeline's own, and a share of people is a proportion", () => {
  for (const name of [...Object.keys(QUANTITIES), ...RATE_PARAMETERS]) assert.ok(name in VCR_PARAMETER_KINDS, `${name} is a parameter of the evidence pipeline`);
  for (const name of RATE_PARAMETERS) assert.equal(VCR_PARAMETER_KINDS[/** @type {keyof typeof VCR_PARAMETER_KINDS} */ (name)], "proportion", name);
  for (const [name, quantity] of Object.entries(QUANTITIES)) {
    const kind = VCR_PARAMETER_KINDS[/** @type {keyof typeof VCR_PARAMETER_KINDS} */ (name)];
    assert.equal(quantity.scale, kind === "ratio" ? "log" : "identity", name);
  }
});

test("a printed p-value is read by its format, as a number or as the registry's text, and nothing else is guessed", () => {
  assert.deepEqual(parsePrintedP("0.0123"), { pValue: 0.0123, pRelation: "=" });
  assert.deepEqual(parsePrintedP("<0.001"), { pValue: 0.001, pRelation: "<" });
  assert.deepEqual(parsePrintedP(" < .001 "), { pValue: 0.001, pRelation: "<" });
  assert.deepEqual(parsePrintedP("= 0.03"), { pValue: 0.03, pRelation: "=" });
  assert.deepEqual(parsePrintedP("≥0.05"), { pValue: 0.05, pRelation: ">" });
  assert.deepEqual(parsePrintedP(0.04, "<"), { pValue: 0.04, pRelation: "<" });
  for (const bad of ["", "NS", "significant", "p<0.05", "1.5", "-0.1", null, undefined, Number.NaN, 2]) assert.equal(parsePrintedP(bad), null, String(bad));
});

test("a registry effect row is read with its p-text and interval level; counts of participants are sizes", () => {
  const effect = extractedValueOfRow(row({ value: "0.82", ci_low: "0.62", ci_high: "1.09", detail: { pValue: "0.0004", confidenceLevel: 0.95, outcome: "OS" } }));
  assert.deepEqual([effect.scale, effect.nullValue, effect.pValue, effect.pRelation, effect.ciLevel], ["log", 1, 0.0004, "=", 0.95]);
  assert.equal(effect.label, "风险比");
  const enrolment = extractedValueOfRow(row({ id: "e2", parameter: "enrollment_actual", arm: null, arm_role: "overall", unit: "participants", value: 500 }));
  assert.deepEqual([enrolment.sampleSize, enrolment.value], [500, null]);
  const started = extractedValueOfRow(row({ id: "e3", parameter: "arm_started", arm: "Placebo", arm_role: "control", unit: "participants", value: 260 }));
  assert.equal(started.sampleSize, 260);
  const withEvent = extractedValueOfRow(row({ id: "e4", parameter: "participants_with_event", arm_role: "control", unit: "participants", value: 300, sample_size: 250 }));
  assert.deepEqual([withEvent.events, withEvent.sampleSize], [300, 250]);
  // A parameter the check does not know has no symmetry and no null, and no rate.
  const unknown = extractedValueOfRow(row({ parameter: "geometric_mean", value: 3 }));
  assert.deepEqual([unknown.scale, unknown.nullValue, unknown.rate], [undefined, undefined, false]);
});

test("registry rows are checked as a trial: arms against enrolment, events against the people counted, the p-text against the interval", () => {
  const rows = [
    row({ id: "t", parameter: "enrollment_actual", arm: null, arm_role: "overall", unit: "participants", value: 500, enrollment_kind: "actual" }),
    row({ id: "a", parameter: "arm_started", arm: "Placebo", arm_role: "control", unit: "participants", value: 260 }),
    row({ id: "b", parameter: "arm_started", arm: "Drug", arm_role: "treatment", unit: "participants", value: 250 }),
    row({ id: "c", parameter: "participants_with_event", arm: "Drug", arm_role: "treatment", unit: "participants", value: 300, sample_size: 250 }),
    row({ id: "d", value: 0.82, ci_low: 0.62, ci_high: 1.09, detail: { pValue: "0.0004", outcome: "OS" } }),
    row({ id: "z", parameter: "hazard_ratio", value: 0.7, ci_low: 0.55, ci_high: 0.89, detail: { pValue: "<0.01", outcome: "PFS" }, endpoint_key: "pfs" }),
    row({ id: "refused", value: null, locator: { verification: "quote_not_found" } }),
    row({ id: "none", value: null, locator: { verification: "not_reported" } }),
  ];
  const found = evidenceValueFindings(rows);
  assert.deepEqual(found.map((finding) => finding.code).sort(), ["arms_exceed_total", "events_exceed_n", "p_contradicts_interval"]);
  const arms = found.find((finding) => finding.code === "arms_exceed_total");
  assert.deepEqual(arms?.ids.sort(), ["a", "b"]);
  // Asked about one value, only its findings come back.
  assert.deepEqual(evidenceValueFindings(rows, { only: new Set(["c"]) }).map((finding) => finding.code), ["events_exceed_n"]);
  assert.deepEqual(evidenceValueFindings(rows, { only: new Set(["z"]) }), []);
});

test("of two rows for one arm the newer is the one compared, and one finding is told once", () => {
  const old = row({ id: "old", value: 0.62, ci_low: 0.48, ci_high: 0.95, created_at: new Date("2026-11-03T09:00:00Z") });
  const corrected = row({ id: "new", value: 0.62, ci_low: 0.48, ci_high: 0.8, created_at: new Date("2026-11-03T11:00:00Z") });
  assert.equal(evidenceValueFindings([old]).length, 1);
  assert.equal(evidenceValueFindings([old, old]).length, 1, "the same sentence once");
  assert.equal(evidenceValueFindings([corrected]).length, 0);
});

const emptyBundle = () => ({ study: { id: "std_1", dataTier: "T0" }, assumptions: [], scenarios: [], stale: [], decisions: [], reviews: [], edges: [], now: new Date("2026-11-03T12:00:00Z"),
  evidence: { available: true, precedents: [], items: [] }, dataPlane: { available: false }, assumptionVersions: new Map(), jobs: [], candidates: [] });

test("a card carries the notes of the evidence it cites, and a card made of nothing that disagrees carries none", () => {
  const bad = row({ id: "ev_bad", value: 0.62, ci_low: 0.48, ci_high: 0.95 });
  const fine = row({ id: "ev_ok", value: 0.62, ci_low: 0.48, ci_high: 0.8, endpoint_key: "pfs" });
  const card = (/** @type {string} */ key, /** @type {string[]} */ evidenceIds) => ({ id: `a_${key}`, key, name: key, version: 1, pointValue: 0.62, unit: null, reviewState: "ai_set",
    sourceKind: "external_evidence", valueSource: "extracted", pooling: {}, evidenceIds });
  const data = presentDataTab({ ...emptyBundle(), assumptions: [card("os_hr", ["ev_bad"]), card("pfs_hr", ["ev_ok"]), card("expert", [])],
    evidence: { available: true, precedents: [], items: [bad, fine] } });
  const [os, pfs, expert] = data.assumptions;
  assert.equal(os.valueChecks.length, 1);
  assert.equal(os.valueChecks[0].kind, "consistency");
  assert.match(os.valueChecks[0].message, /估计值 0\.62、区间 0\.48–0\.95/);
  assert.equal("valueChecks" in pfs, false);
  assert.equal("valueChecks" in expert, false);
  assert.doesNotMatch(JSON.stringify(os.valueChecks), /hazard_ratio|evidence_items|ev_bad|vcr_/, "no back-office word reaches a reader");
});

test("a card whose cited value was read differently the second time carries both numbers; an agreement is not on the page", () => {
  const card = (/** @type {string} */ key, /** @type {string[]} */ evidenceIds) => ({ id: `a_${key}`, key, name: key, version: 1, pointValue: 0.62, unit: null, reviewState: "ai_set",
    sourceKind: "external_evidence", valueSource: "extracted", pooling: {}, evidenceIds });
  const message = "风险比（Drug vs placebo）：同一段原文读了两次，结果不一致——区间上限 第一次读到 0.8，第二次读到 0.95。原文：“HR 0.62 (95% CI 0.48 to 0.80)”。已按第一次读到的保存，请回到原文核对是哪一个。";
  const data = presentDataTab({ ...emptyBundle(), assumptions: [card("os_hr", ["ev1"]), card("pfs_hr", ["ev2"])],
    evidence: { available: true, precedents: [], items: [row({ id: "ev1", value: 0.62, ci_low: 0.48, ci_high: 0.8 }), row({ id: "ev2", value: 0.7, ci_low: 0.55, ci_high: 0.89, endpoint_key: "pfs" })],
      secondReads: [{ evidence_id: "ev1", outcome: "differ", reading: { message } }, { evidence_id: "ev9", outcome: "differ", reading: { message: "another study's" } }] } });
  assert.deepEqual(data.assumptions[0].valueChecks, [{ kind: "second_read", message }]);
  assert.equal("valueChecks" in data.assumptions[1], false);
});

test("the write names the numbers in an advisory issue and keeps the item; a p-value outside 0 to 1 is refused by name", async () => {
  /** @type {any[]} */ const asked = [];
  const evidence = { async addEvidenceItem(/** @type {any} */ call) {
    asked.push(call);
    return { status: "ok", id: "ev9", state: "verified", notes: [{ kind: "consistency", code: "interval_not_symmetric", evidenceIds: ["ev9"], message: "风险比：估计值 0.62、区间 0.48–0.95 对不上。" }], pValueNotInQuote: true };
  } };
  const study = { id: "std_1", userId: "u1", projectId: "prj_1" };
  const item = { registry: "clinicaltrials.gov", registryId: "NCT01234567", parameter: "hazard_ratio", armRole: "contrast", value: 0.62, ciLow: 0.48, ciHigh: 0.95,
    quote: "HR 0.62 (95% CI 0.48 to 0.95)", endpointKey: "os", pValue: 0.001, pRelation: "<" };
  const written = await vcrRuntimeWrite({ store: {}, service: {}, orchestrator: null, study, what: "evidence_item", items: [item], data: null, evidence });
  assert.equal(written.ok, true);
  assert.deepEqual(written.ids, ["ev9"]);
  assert.equal(asked[0].item.pValue, 0.001);
  assert.equal(asked[0].item.pRelation, "<");
  const codes = written.issues.map((/** @type {any} */ found) => found.code);
  assert.deepEqual(codes, ["vcr_evidence_values_inconsistent", "vcr_evidence_item_incomplete"]);
  assert.match(written.issues[0].message, /估计值 0\.62、区间 0\.48–0\.95/);
  const refused = await vcrRuntimeWrite({ store: {}, service: {}, orchestrator: null, study, what: "evidence_item", items: [{ ...item, pValue: 1.5 }], data: null, evidence });
  assert.equal(refused.ok, false);
  assert.equal(refused.issues[0].field, "pValue");
  assert.equal(asked.length, 1, "nothing was asked of the pipeline for the refused item");
});

test("a card made of evidence gets the notes of that evidence in the answer of the write, and the card is saved as it is", async () => {
  const evidenceRow = { id: "ev1", parameter: "hazard_ratio", arm_role: "contrast", value: 0.62, ci_low: 0.48, ci_high: 0.95, value_source: "extracted", detail: {}, locator: { verification: "verified" } };
  /** @type {any[]} */ const saved = [];
  const evidenceStore = {
    async citableEvidenceIds() { return ["ev1"]; },
    async citableItemsById() { return [evidenceRow]; },
    async saveAssumption(/** @type {any} */ call) { saved.push(call); return { id: "a1", key: "control_hr", version: 1 }; },
  };
  const store = { async assumptions() { return [{ id: "a1", key: "control_hr", version: 1, evidenceIds: ["ev1"] }]; } };
  /** @type {any[]} */ const asked = [];
  const evidence = { async valueNotes(/** @type {any} */ call) {
    asked.push(call);
    return [{ kind: "consistency", code: "interval_not_symmetric", evidenceIds: ["ev1"], message: "风险比：区间对不上。" },
      { kind: "second_read", code: "second_read_differs", evidenceIds: ["ev1"], message: "风险比：同一段原文读了两次，结果不一致。" }];
  } };
  const study = { id: "std_1", userId: "u1", projectId: "prj_1" };
  const written = await vcrRuntimeWrite({ store, service: {}, orchestrator: null, study, what: "assumption", data: null, evidence, evidenceStore,
    items: [{ key: "control_hr", name: "对照风险比", parameter: "hazard_ratio", sourceKind: "external_evidence", evidenceIds: ["ev1"], effectRole: "realistic_expectation" }] });
  assert.equal(written.ok, true);
  assert.equal(saved.length, 1, "the card is saved");
  assert.deepEqual(asked[0].ids, ["ev1"]);
  assert.equal(asked[0].wait, true, "the card's answer waits, within the pipeline's limit, for the second readings of what it cites");
  assert.deepEqual(written.issues.map((/** @type {any} */ found) => found.code), ["vcr_evidence_values_inconsistent", "vcr_evidence_second_read_differs"]);
});
