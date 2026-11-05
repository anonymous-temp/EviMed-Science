// A model's words and the closed vocabularies of a write (2026-11-01 live runs: 14 refused calls in a design comparison, one matching write
// refused on 19 lines). The gateway reads the spellings that mean one word, says it did, and refuses the rest with the words and what each is
// for; a number a paper reports is bound to the paper, and one the platform could not check is kept and says so.
import assert from "node:assert/strict";
import test from "node:test";
import { vcrRuntimeWrite, citationOf } from "../src/vcrGateway.mjs";
import { vcrContractsRead, VCR_WRITE_EXAMPLES, VCR_WRITE_FIELDS } from "../src/vcrWriteContracts.mjs";
import { premiseReasonOfCard } from "../src/vcrPremises.mjs";
import { vcrNormalizeWriteRow } from "@evimed/domain";

const study = { id: "std_1", userId: "u1", projectId: "default", scope: "conversation", dataTier: "T0", intendedUse: "exploratory", status: "active" };

/** An evidence pipeline that answers as the real one does for the state it is told to. @param {string} state @param {Record<string, any>} [more] */
function evidenceAnswering(state, more = {}) {
  /** @type {any[]} */ const asked = [];
  return { asked, async addEvidenceItem(/** @type {any} */ input) { asked.push(input); return { status: "ok", id: `evd_${asked.length}`, state, ...more }; } };
}
const paperItem = (/** @type {Record<string, any>} */ more = {}) => ({
  registry: "pubmed", registryId: "37676259", parameter: "control_median_os", arm: "sorafenib", armRole: "control", value: 13.8, unit: "months",
  ciLow: 12.3, ciHigh: 16.1, valueSource: "reported", quote: "13.8 months (95% CI, 12.3–16.1) with sorafenib", endpointKey: "os", evidenceKind: "outcome", ...more,
});
const write = (/** @type {string} */ what, /** @type {any[]} */ items, /** @type {Record<string, any>} */ deps = {}) =>
  vcrRuntimeWrite({ store: {}, service: {}, orchestrator: null, study, what, items, data: null, ...deps });

test("a paper's number written as the model wrote it: pubmed as the registry, reported as the source, the paper by PMID; the answer says what was read as what", async () => {
  const evidence = evidenceAnswering("verified", { publication: { kind: "pmid", id: "37676259", read: true, contentRead: "abstract" } });
  const written = await write("evidence_item", [paperItem({ armRole: "experimental" })], { evidence });
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  assert.deepEqual(written.issues, []);
  const sent = evidence.asked[0].item;
  assert.deepEqual(sent.publication, { kind: "pmid", id: "37676259" });
  assert.equal(sent.valueSource, "extracted");
  assert.equal(sent.armRole, "treatment");
  assert.equal(sent.registryId, undefined, "the PMID is the paper's identity, not a registry id");
  const applied = written.results.find((/** @type {any} */ entry) => entry.applied)?.applied;
  assert.deepEqual(applied.map((/** @type {any} */ entry) => [entry.field, entry.from, entry.value]), [["valueSource", "reported", "extracted"], ["armRole", "experimental", "treatment"]]);
  assert.deepEqual(written.results.find((/** @type {any} */ entry) => entry.publication).publication, { kind: "pmid", id: "37676259", read: true, contentRead: "abstract" });
});

test("a paper is named by publication {pmid} or {doi}, or by the registry field naming a publication; two sources, or an identifier of no shape, are refused with what to write", async () => {
  for (const row of [paperItem({ registry: undefined, registryId: undefined, publication: { pmid: "37676259" } }), paperItem({ registry: "PMID", registryId: "PMID: 37676259" }),
    paperItem({ registry: "doi", registryId: "https://doi.org/10.1056/NEJMoa1915745" })]) {
    const evidence = evidenceAnswering("verified");
    const written = await write("evidence_item", [row], { evidence });
    assert.equal(written.ok, true, JSON.stringify([row, written.issues]));
    assert.ok(["pmid", "doi"].includes(evidence.asked[0].item.publication.kind));
  }
  const both = await write("evidence_item", [paperItem({ registry: undefined, publication: { pmid: "1" }, registryId: "NCT03434379" })], { evidence: evidenceAnswering("verified") });
  assert.equal(both.ok, false);
  assert.match(both.issues[0].message, /一条数只有一个出处/);
  const shapeless = await write("evidence_item", [paperItem({ registryId: "the HIMALAYA trial" })], { evidence: evidenceAnswering("verified") });
  assert.equal(shapeless.ok, false);
  assert.match(shapeless.issues[0].message, /PMID/);
  assert.match(shapeless.issues[0].message, /DOI/);
  // a real registry is unchanged
  const registry = evidenceAnswering("verified");
  const real = await write("evidence_item", [paperItem({ registry: "clinicaltrials.gov", registryId: "NCT03434379" })], { evidence: registry });
  assert.equal(real.ok, true);
  assert.equal(registry.asked[0].item.registry, "clinicaltrials.gov");
  assert.equal(registry.asked[0].item.publication, undefined);
});

test("a number the platform could not check is saved, and the answer says it is unchecked and why, as a reminder and not a refusal", async () => {
  for (const [because, pattern] of [["publication_not_read", /还没有读到这篇文献的原文/], ["quote_not_found", /引文不在平台读到的摘要/], ["calculated_from_publication", /不核对派生值/]]) {
    const evidence = evidenceAnswering("reported_unverified", { publication: { kind: "pmid", id: "37676259", read: because === "quote_not_found", contentRead: "abstract" }, because });
    const written = await write("evidence_item", [paperItem()], { evidence });
    assert.equal(written.ok, true, "the number is saved");
    assert.deepEqual(written.ids, ["evd_1"]);
    assert.equal(written.issues.length, 1);
    assert.equal(written.issues[0].code, "vcr_evidence_reported_unverified");
    assert.match(written.issues[0].message, /未核对/);
    assert.match(written.issues[0].message, pattern);
    assert.doesNotMatch(written.issues[0].message, /就会核对/, "the reminder promises what will happen: a quotation that is in the text read is checked, not that fetching checks it");
  }
  // a registry value that fails its check is still refused as it always was
  const failed = await write("evidence_item", [paperItem({ registry: "clinicaltrials.gov", registryId: "NCT03434379" })], { evidence: evidenceAnswering("quote_not_found") });
  assert.equal(failed.issues[0].code, "vcr_evidence_unverified");
});

test("a word of no single meaning is refused with every word of the field and what each is for", async () => {
  const written = await write("evidence_item", [paperItem({ evidenceKind: "rct" })], { evidence: evidenceAnswering("verified") });
  assert.equal(written.ok, false);
  const message = written.issues.find((/** @type {any} */ entry) => entry.field === "evidenceKind").message;
  for (const word of ["baseline（", "outcome（", "design（"]) assert.ok(message.includes(word), message);
  assert.match(message, /中位生存期/);
  const role = await write("evidence_item", [paperItem({ armRole: "sorafenib arm" })], { evidence: evidenceAnswering("verified") });
  assert.match(role.issues[0].message, /control（对照组）/);
});

test("external evidence without an evidence id says the exact next call; a literature source kind is read as external evidence", async () => {
  const card = { key: "control_median_os", name: "对照组中位 OS", parameter: "control_median_os", endpoint: "os", unit: "months" };
  for (const sourceKind of ["external_evidence", "literature", "published"]) {
    const written = await write("assumption", [{ ...card, sourceKind, valueSource: "同类试验的对照臂", pointValue: 13.5 }], { evidenceStore: {} });
    assert.equal(written.ok, false);
    const message = written.issues.find((/** @type {any} */ entry) => entry.field === "evidenceIds").message;
    assert.match(message, /先 vcr_write what=evidence_item/);
    assert.match(message, /publication: \{ pmid \}/);
    assert.match(message, /expert_set/, "and the way out when the number is only the researcher's setting");
  }
});

test("the researcher's own setting, with a sentence where the one legal word goes: saved, the sentence in the note", async () => {
  /** @type {any[]} */ const saved = [];
  const evidenceStore = { async saveAssumption(/** @type {any} */ input) { saved.push(input.card); return { id: "asm_1", key: input.card.key, version: 1 }; } };
  const sentence = "同类一线 III 期试验对索拉非尼达到的 OS 风险比在 0.66–0.78 之间";
  const store = { async assumptions() { return []; } };
  const written = await write("assumption", [{ key: "hazard_ratio", name: "目标 OS 风险比", endpoint: "os", unit: "ratio", pointValue: 0.75, sourceKind: "literature_assumed", valueSource: sentence, note: "取 0.75" }], { evidenceStore, store });
  // `literature_assumed` is not a word; the same card with a word that is
  assert.equal(written.ok, false);
  assert.match(written.issues[0].message, /expert_set（/);
  const ok = await write("assumption", [{ key: "hazard_ratio", name: "目标 OS 风险比", endpoint: "os", unit: "ratio", pointValue: 0.75, sourceKind: "assumption", valueSource: sentence, note: "取 0.75", effectRole: "realistic_expectation" }], { evidenceStore, store });
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.equal(saved[0].sourceKind, "expert_set");
  assert.equal(saved[0].valueSource, "assumed");
  assert.equal(saved[0].note, `取 0.75；${sentence}`);
  assert.deepEqual(ok.results.find((/** @type {any} */ entry) => entry.applied).applied.map((/** @type {any} */ entry) => entry.field), ["sourceKind", "valueSource"]);
});

test("an external-evidence card takes the number of a publication the platform could not check, carries the paper and that it is unchecked, and says so on the page", async () => {
  /** @type {any[]} */ const saved = [];
  const row = { id: "evd_1", parameter: "control_median_os", value: "13.8", ci_low: "12.3", ci_high: "16.1", value_source: "extracted", arm_role: "control", detail: {},
    locator: { kind: "publication_text", publication: { kind: "pmid", id: "37676259" }, verification: "reported_unverified" } };
  const evidenceStore = {
    async citableEvidenceIds() { return ["evd_1"]; },
    async citableItemsById() { return [row]; },
    async verifiedEvidenceIds() { return []; },
    async saveAssumption(/** @type {any} */ input) { saved.push(input.card); return { id: "asm_1", key: input.card.key, version: 1 }; },
  };
  const written = await write("assumption", [{ key: "control_median_os", name: "对照组中位 OS", parameter: "control_median_os", endpoint: "os", unit: "months", sourceKind: "external_evidence", evidenceIds: ["evd_1"] }], { evidenceStore });
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  const card = saved[0];
  assert.equal(card.pointValue, 13.8);
  assert.equal(card.sourceKind, "external_evidence");
  assert.deepEqual(card.pooling, { k: 1, note: "单项研究直接取值，没有预测区间", citation: "PMID 37676259", unchecked: true });
  assert.equal(premiseReasonOfCard(card), "引自 PMID 37676259，引文没有在平台读到的原文里找到，数值未核对");
  assert.equal(premiseReasonOfCard({ pooling: { k: 1, citation: "DOI 10.1056/x" } }), "引自 DOI 10.1056/x");
  assert.equal(premiseReasonOfCard({ pooling: { k: 3 } }), null, "a pooled card or a registry value says nothing here");
  assert.deepEqual(citationOf({ locator: { kind: "registry_field" } }), {});
  // an id of another parameter, or of no evidence the study holds, is refused as before
  const other = await write("assumption", [{ key: "control_median_os", name: "x", parameter: "control_median_os", sourceKind: "external_evidence", evidenceIds: ["evd_other"] }], { evidenceStore });
  assert.equal(other.ok, false);
  assert.equal(other.issues[0].code, "vcr_evidence_unverified");
});

test("a value calculated from a paper's numbers is not a card, as a registry's calculated value is not; and a card that already holds one does not say a quotation was not found", async () => {
  /** @type {any[]} */ const saved = [];
  const row = { id: "evd_1", parameter: "control_median_os", value: "13.8", ci_low: null, ci_high: null, value_source: "calculated", arm_role: "control",
    detail: { sourceStanding: "article_reported_unverified", verificationScope: "none", unverifiedBecause: "calculated_from_publication" },
    locator: { kind: "publication_text", publication: { kind: "pmid", id: "37676259" }, verification: "reported_unverified" } };
  const evidenceStore = {
    async citableEvidenceIds() { return ["evd_1"]; },
    async citableItemsById() { return [row]; },
    async verifiedEvidenceIds() { return []; },
    async saveAssumption(/** @type {any} */ input) { saved.push(input.card); return { id: "asm_1", key: input.card.key, version: 1 }; },
  };
  const card = { key: "control_median_os", name: "对照组中位 OS", parameter: "control_median_os", endpoint: "os", unit: "months", sourceKind: "external_evidence", evidenceIds: ["evd_1"] };
  const refused = await write("assumption", [card], { evidenceStore });
  assert.equal(refused.ok, false);
  assert.equal(refused.issues[0].code, "vcr_evidence_unverified");
  assert.match(refused.issues[0].message, /算出来的值/);
  assert.deepEqual(saved, [], "nothing is saved for it");
  // the same row from a registry, calculated and checked on its inputs, was already refused: both read the same
  const registryRow = { ...row, locator: { kind: "registry_field", verification: "verified" }, detail: { verificationScope: "quoted_inputs_only" } };
  const registry = await write("assumption", [card], { evidenceStore: { ...evidenceStore, async citableItemsById() { return [registryRow]; } } });
  assert.equal(registry.issues[0].code, "vcr_evidence_unverified");
  assert.match(registry.issues[0].message, /算出来的值/);
  // a paper's reported number that was not checked is still a card, as before
  const reported = await write("assumption", [card], { evidenceStore: { ...evidenceStore, async citableItemsById() { return [{ ...row, value_source: "extracted", detail: {} }]; } } });
  assert.equal(reported.ok, true, JSON.stringify(reported.issues));
  // a card that already holds a calculated number (written before) is not said to lack a quotation
  const old = { pooling: { k: 1, citation: "PMID 37676259", unchecked: true }, valueSource: "calculated" };
  assert.equal(premiseReasonOfCard(old), "引自 PMID 37676259，由论文里的数算出，数值未核对");
  assert.equal(premiseReasonOfCard({ ...old, valueSource: "extracted" }), "引自 PMID 37676259，引文没有在平台读到的原文里找到，数值未核对");
});

test("a plan takes the lists and sentences a model writes", async () => {
  /** @type {any[]} */ const frozen = [];
  const store = { latestDefinition: async () => ({ estimand: { variable: "OS" }, endpointType: "time_to_event", pico: { outcome: "OS" } }), latestPopulation: async () => null,
    latestComparatorDesign: async () => null, assumptions: async () => [] };
  const seal = { async freezePlan(/** @type {any} */ input) { frozen.push(input); return { planVersion: 1 }; } };
  const planned = await write("plan", [{ analysis: ["先解析后模拟", "再复核把握度"], sensitivity: ["HR 0.80", "脱落率 10%"], sealedFields: [] }], { store, seal });
  assert.equal(planned.ok, true, JSON.stringify(planned.issues));
  assert.deepEqual(frozen[0].plan.analysis, { items: ["先解析后模拟", "再复核把握度"] });
  assert.deepEqual(frozen[0].plan.sensitivity, { items: ["HR 0.80", "脱落率 10%"] });
});

test("the contract read carries each field's words with what they mean and one example that the closed fields accept", () => {
  const evidence = vcrContractsRead("evidence_item").writes.evidence_item;
  assert.equal(evidence.words.evidenceKind.outcome.includes("中位生存期"), true);
  assert.deepEqual(Object.keys(evidence.words), ["evidenceKind", "valueSource", "armRole"]);
  assert.match(evidence.source, /publication: \{ pmid \} or \{ doi \}/);
  assert.equal(vcrContractsRead("assumption").writes.assumption.words.sourceKind.external_evidence.includes("evidenceIds"), true);
  assert.equal(vcrContractsRead("criteria").writes.criteria.words.criterionType.prior_treatment.includes("治疗线数"), true);
  for (const what of ["evidence_item", "trial_scenario", "design_grid", "plan"]) {
    const example = /** @type {Record<string, any>} */ (VCR_WRITE_EXAMPLES)[what];
    const fields = /** @type {Record<string, readonly string[]>} */ (VCR_WRITE_FIELDS)[what];
    assert.deepEqual(Object.keys(example).filter((key) => !fields.includes(key)), [], `${what}: the example uses only the contract's fields`);
    assert.deepEqual(vcrNormalizeWriteRow(what, example).applied, [], `${what}: the example already speaks the closed words`);
  }
  for (const card of Object.values(VCR_WRITE_EXAMPLES.assumption)) {
    assert.deepEqual(Object.keys(card).filter((key) => !VCR_WRITE_FIELDS.assumption.includes(key)), []);
    assert.deepEqual(vcrNormalizeWriteRow("assumption", card).applied, []);
  }
  // the whole read stays one answer: all kinds together are not thousands of lines
  assert.ok(JSON.stringify(vcrContractsRead()).length < 120_000);
});
