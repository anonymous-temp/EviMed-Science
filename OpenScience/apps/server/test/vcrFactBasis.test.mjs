// What a fact may claim: the rule that reaches the run where it writes a fact, and the one structural notice the platform can
// draw without judging a sentence (the 「58 岁女性」 → 「未妊娠」 incident of 2026-10-29).
import assert from "node:assert/strict";
import test from "node:test";
import { CLINICAL_FACT_CONTRACT, FACT_EVIDENCE_RULE } from "@evimed/domain";
import { factsOnSameWords, surfaceBasis } from "../src/vcrFactBasis.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { vcrContractsRead } from "../src/vcrWriteContracts.mjs";

const study = { id: "std_1", userId: "u1", projectId: "prj_1", dataTier: "T1" };

test("a fact's basis is where its surface sits in the document, not in its quotation", () => {
  const fact = { source: { documentId: "doc_1", start: 10, quote: "58岁女性" }, surface: "女性" };
  assert.deepEqual(surfaceBasis(fact), { documentId: "doc_1", from: 13, to: 15 });
  assert.equal(surfaceBasis({ source: { documentId: "doc_1", start: 10, quote: "58岁女性" }, surface: "男性" }), null, "a surface the quotation lacks is no basis");
  assert.equal(surfaceBasis({ source: null, surface: "女性" }), null, "a cell of a frozen snapshot has no characters");
});

test("an affirmed and a negated reading of the same characters, about different variables, are found; nothing else is", () => {
  const sex = { id: "f1", variable: "sex", polarity: "affirmed", basis: { documentId: "d", from: 3, to: 5 } };
  const pregnancy = { variable: "pregnancy", polarity: "negated", basis: { documentId: "d", from: 3, to: 5 } };
  assert.deepEqual(factsOnSameWords(pregnancy, [sex]), [{ id: "f1", variable: "sex", polarity: "affirmed" }]);
  // Overlap is enough: the whole phrase covers the words of the age and of the sex.
  assert.equal(factsOnSameWords({ ...pregnancy, basis: { documentId: "d", from: 0, to: 5 } }, [sex]).length, 1);
  // Touching is not overlapping, another document is another text, the same variable is a conflict the evaluator already shows.
  assert.deepEqual(factsOnSameWords({ ...pregnancy, basis: { documentId: "d", from: 5, to: 8 } }, [sex]), []);
  assert.deepEqual(factsOnSameWords({ ...pregnancy, basis: { documentId: "other", from: 3, to: 5 } }, [sex]), []);
  assert.deepEqual(factsOnSameWords({ ...pregnancy, variable: "sex" }, [sex]), []);
  // Two negations, two affirmations, a plan or a family history make no such pair.
  assert.deepEqual(factsOnSameWords(pregnancy, [{ ...sex, polarity: "negated" }]), []);
  assert.deepEqual(factsOnSameWords({ ...pregnancy, polarity: "affirmed" }, [sex]), []);
  assert.deepEqual(factsOnSameWords({ ...pregnancy, polarity: "hypothetical" }, [sex]), []);
  assert.deepEqual(factsOnSameWords({ ...pregnancy, basis: null }, [sex]), []);
});

test("the rule is in the contract a run reads before it writes a fact, in each place that serves one", () => {
  assert.equal(CLINICAL_FACT_CONTRACT.evidenceRule, FACT_EVIDENCE_RULE);
  assert.match(FACT_EVIDENCE_RULE, /unknown, not negated/);
  assert.match(FACT_EVIDENCE_RULE, /pregnancy/);
  const shape = vcrContractsRead();
  assert.equal(shape.factContract.evidenceRule, FACT_EVIDENCE_RULE);
  assert.equal(shape.writes.fact.rule, FACT_EVIDENCE_RULE);
  assert.deepEqual(shape.writes.fact.fields.slice(0, 2), ["subjectKey", "variable"], "the field list is still the closed one");
  assert.equal(vcrContractsRead("fact").writes.fact.rule, FACT_EVIDENCE_RULE);
});

/**
 * A fact write against doubles: one patient document, the facts the ledger already holds, and whatever the store was asked to keep.
 * @param {{ text: string, known?: any[] }} input
 */
function chart({ text, known = [] }) {
  /** @type {any[]} */
  const saved = [];
  const documents = { async runtimeRead(/** @type {any} */ _study, /** @type {{ subjectKey: string, documentId: string }} */ { subjectKey, documentId }) {
    return subjectKey === "P-1" && documentId === "doc_1" ? { id: "doc_1", text, visibleAt: null, subjectKey } : null;
  } };
  const matchStore = {
    async matchingFactsByIds() { return []; },
    async listFacts() { return [...known, ...saved]; },
    async saveFact(/** @type {{ fact: any }} */ { fact }) { const row = { ...fact, id: `fct_${saved.length + 1}` }; saved.push(row); return { id: row.id }; },
  };
  return { saved, write: (/** @type {Record<string, any>[]} */ items) => vcrRuntimeWrite({ study, store: {}, service: {}, orchestrator: null, what: "fact", items, documents, matchStore }) };
}
const PATIENT = { schema: 1, experiencer: "patient" };
/** @param {string} variable @param {string} surface @param {string} quote @param {Record<string, any>} [more] */
const fact = (variable, surface, quote, more = {}) => ({ subjectKey: "P-1", documentId: "doc_1", variable, surface, quote, ...more });
/** @param {any} outcome */
const warningsOf = (outcome) => (outcome.results ?? []).flatMap((/** @type {any} */ entry) => entry.warnings ?? []);

test("「58岁女性」 saved as sex and as a negated pregnancy on the same characters: both are kept, and the run is told which two share the words", async () => {
  const seam = chart({ text: "58岁女性，因咳嗽就诊。" });
  const outcome = await seam.write([
    fact("age", "58岁", "58岁女性", { value: 58, unit: "year", clinical: { ...PATIENT, assertion: "affirmed" } }),
    fact("sex", "女性", "58岁女性", { value: "female", clinical: { ...PATIENT, assertion: "affirmed" } }),
    fact("pregnancy", "女性", "58岁女性", { clinical: { ...PATIENT, assertion: "negated" } }),
    fact("lactation", "58岁女性", "58岁女性", { clinical: { ...PATIENT, assertion: "negated" } }),
  ]);
  assert.equal(outcome.ok, true, "the literal check passes these facts and no refusal is added");
  assert.deepEqual(outcome.issues, []);
  assert.equal(seam.saved.length, 4);
  const notices = warningsOf(outcome);
  assert.deepEqual(notices.map((/** @type {any} */ warning) => [warning.code, warning.variable, warning.withVariable]), [
    ["negated_on_words_of_another_fact", "pregnancy", "sex"],
    ["negated_on_words_of_another_fact", "lactation", "age"],
    ["negated_on_words_of_another_fact", "lactation", "sex"],
  ], "overlap with the age and the sex words is found as well as identity");
  assert.equal(notices[0].factId, "fct_3", "the notice names the fact it is about, so the run can correct it");
  assert.match(notices[0].message, /correctionOf/);
  assert.match(notices[0].message, /fct_3/);
  assert.match(outcome.note, /未知/, "the rule rides every fact write");
  assert.match(outcome.note, /妊娠/);
});

test("the order of the batch does not matter: the notice falls on whichever of the two arrives second", async () => {
  const seam = chart({ text: "58岁女性，因咳嗽就诊。" });
  const outcome = await seam.write([
    fact("pregnancy", "女性", "58岁女性", { clinical: { ...PATIENT, assertion: "negated" } }),
    fact("sex", "女性", "58岁女性", { value: "female", clinical: { ...PATIENT, assertion: "affirmed" } }),
  ]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(warningsOf(outcome).map((/** @type {any} */ warning) => [warning.factId, warning.variable, warning.withVariable]), [["fct_2", "sex", "pregnancy"]]);
  // And against a fact an earlier call already saved.
  const earlier = chart({ text: "58岁女性，因咳嗽就诊。", known: [{ id: "old", variable: "sex", polarity: "affirmed", surface: "女性", source: { documentId: "doc_1", start: 0, quote: "58岁女性" } }] });
  const later = await earlier.write([fact("pregnancy", "女性", "58岁女性", { clinical: { ...PATIENT, assertion: "negated" } })]);
  assert.equal(warningsOf(later).length, 1);
  assert.equal(warningsOf(later)[0].withFactId, "old");
});

test("an explicit denial is written without a notice: the words that deny it are not the words of another fact", async () => {
  const seam = chart({ text: "58岁女性，否认妊娠，无哺乳。" });
  const outcome = await seam.write([
    fact("age", "58岁", "58岁女性，否认妊娠", { value: 58, unit: "year", clinical: { ...PATIENT, assertion: "affirmed" } }),
    fact("sex", "女性", "58岁女性，否认妊娠", { value: "female", clinical: { ...PATIENT, assertion: "affirmed" } }),
    fact("pregnancy", "否认妊娠", "58岁女性，否认妊娠", { clinical: { ...PATIENT, assertion: "negated" } }),
    fact("lactation", "无哺乳", "无哺乳", { clinical: { ...PATIENT, assertion: "negated" } }),
  ]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.issues, []);
  assert.equal(seam.saved.length, 4);
  assert.deepEqual(warningsOf(outcome), []);
  assert.equal(seam.saved[2].polarity, "negated", "an explicit denial is stored as the denial it is");
});

test("a store that cannot list facts, or fails, costs the notice and never the fact", async () => {
  const text = "58岁女性，因咳嗽就诊。";
  const documents = { async runtimeRead() { return { id: "doc_1", text, visibleAt: null }; } };
  /** @type {any[]} */
  const saved = [];
  for (const listFacts of [undefined, async () => { throw new Error("down"); }]) {
    saved.length = 0;
    const matchStore = { async matchingFactsByIds() { return []; }, listFacts, async saveFact(/** @type {any} */ { fact: row }) { saved.push(row); return { id: `fct_${saved.length}` }; } };
    const outcome = await vcrRuntimeWrite({ study, store: {}, service: {}, orchestrator: null, what: "fact", documents, matchStore,
      items: [fact("pregnancy", "女性", "58岁女性", { clinical: { ...PATIENT, assertion: "negated" } })] });
    assert.equal(outcome.ok, true);
    assert.equal(saved.length, 1);
    assert.deepEqual(warningsOf(outcome), []);
  }
});
