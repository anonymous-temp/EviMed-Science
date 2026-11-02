// The closed words of a write's fields, and the spellings that mean exactly one of them (2026-11-01: `valueSource: "reported"`,
// `sourceKind: "literature"` and `criterionType: "prior_therapy"` each cost a round, and one matching write was refused on 19 lines for
// six spellings). A spelling is read as the word it means only when it means one thing; the rest is refused with the words and what
// each is for.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_CRITERION_TYPES, VCR_WRITE_WORDS, vcrNormalizeWriteRow, vcrReadWord, vcrWordKey, vcrWordList } from "../index.mjs";

test("the words of each field are the vocabulary's own, and every synonym lands on one of them", () => {
  assert.deepEqual(Object.keys(VCR_WRITE_WORDS.criterion.criterionType.meanings), [...VCR_CRITERION_TYPES]);
  assert.deepEqual(Object.keys(VCR_WRITE_WORDS.evidence_item.armRole.meanings), ["control", "treatment", "contrast", "single_arm", "overall", "unknown"]);
  assert.deepEqual(Object.keys(VCR_WRITE_WORDS.assumption.sourceKind.meanings), ["expert_set", "scenario", "external_evidence"]);
  for (const [table, fields] of Object.entries(VCR_WRITE_WORDS)) {
    for (const [field, entry] of Object.entries(fields)) {
      for (const [word, canonical] of Object.entries(entry.synonyms ?? {})) {
        assert.ok(Object.hasOwn(entry.meanings, canonical), `${table}.${field}: ${word} -> ${canonical} is not a word of the field`);
        assert.equal(Object.hasOwn(entry.meanings, word), false, `${table}.${field}: ${word} is a word of the field and a synonym of another`);
        assert.equal(vcrWordKey(word), word, `${table}.${field}: ${word} is not in the table's spelling`);
      }
      for (const meaning of Object.values(entry.meanings)) assert.ok(meaning.length > 2);
    }
  }
  assert.match(vcrWordList("evidence_item", "evidenceKind"), /^baseline（.+）、outcome（.+）、design（.+）$/);
  assert.equal(vcrWordList("nothing", "nothing"), "");
});

test("a word is read as itself, as its one synonym in any case and separator, and as nothing when it means nothing here", () => {
  assert.equal(vcrReadWord("evidence_item", "valueSource", "extracted"), "extracted");
  assert.equal(vcrReadWord("evidence_item", "valueSource", "Reported"), "extracted");
  assert.equal(vcrReadWord("criterion", "criterionType", "Prior-Therapy"), "prior_treatment");
  assert.equal(vcrReadWord("criterion", "criterionType", "organ function"), "lab");
  assert.equal(vcrReadWord("evidence_item", "evidenceKind", "rct"), null, "a study design is not a kind of number");
  assert.equal(vcrReadWord("criterion", "criterionType", "cns"), null);
  assert.equal(vcrReadWord("evidence_item", "evidenceKind", 7), null);
  assert.equal(vcrReadWord("evidence_item", "nothing", "x"), null);
});

test("an evidence item's near-miss words are read and said; a word with no meaning here is left for the refusal", () => {
  const item = { parameter: "control_median_os", armRole: "experimental", valueSource: "reported", evidenceKind: "rct", value: 13.8, quote: "q" };
  const read = vcrNormalizeWriteRow("evidence_item", item);
  assert.deepEqual(read.row, { ...item, armRole: "treatment", valueSource: "extracted" }, "evidenceKind: rct is left as it was written");
  assert.deepEqual(read.applied, [{ field: "valueSource", from: "reported", value: "extracted" }, { field: "armRole", from: "experimental", value: "treatment" }]);
  assert.equal(item.valueSource, "reported", "the input is not edited");
  const clean = vcrNormalizeWriteRow("evidence_item", { armRole: "control", valueSource: "extracted", evidenceKind: "outcome" });
  assert.deepEqual(clean.applied, []);
});

test("an assumption: a source kind in other words, and a sentence in the one-word field goes to the note whole", () => {
  const sentence = "同类一线 III 期试验对索拉非尼达到的 OS 风险比在 0.66–0.78 之间";
  const read = vcrNormalizeWriteRow("assumption", { key: "hazard_ratio", sourceKind: "literature", valueSource: sentence, note: "取 0.75" });
  assert.equal(read.row.sourceKind, "external_evidence", "literature is external evidence: it then needs its evidenceIds");
  assert.equal("valueSource" in read.row, false, "an external-evidence card takes its source from its evidence: what was written there is left out");
  assert.deepEqual(read.applied.map((entry) => entry.field), ["sourceKind", "valueSource"]);
  assert.equal(read.row.pointValue, undefined);
  const own = vcrNormalizeWriteRow("assumption", { key: "hazard_ratio", sourceKind: "assumption", valueSource: sentence, note: "取 0.75", pointValue: 0.75 });
  assert.equal(own.row.sourceKind, "expert_set");
  assert.equal(own.row.valueSource, "assumed");
  assert.equal(own.row.note, `取 0.75；${sentence}`);
  assert.deepEqual(own.applied.map((entry) => [entry.field, entry.value]), [["sourceKind", "expert_set"], ["valueSource", "assumed"]]);
  const noNote = vcrNormalizeWriteRow("assumption", { key: "k", valueSource: sentence });
  assert.equal(noNote.row.note, sentence);
  const already = vcrNormalizeWriteRow("assumption", { key: "k", valueSource: sentence, note: sentence });
  assert.equal(already.row.note, sentence, "a sentence already in the note is not written twice");
  const word = vcrNormalizeWriteRow("assumption", { key: "k", valueSource: "Expert" });
  assert.equal(word.row.valueSource, "assumed");
  // a card made from pooling or an expert setting derived from evidence states none of these
  assert.equal(vcrNormalizeWriteRow("assumption", { key: "k", fromPooling: {}, valueSource: sentence }).row.valueSource, sentence);
});

test("criterion types are read in criteria, in a protocol's and in a candidate trial's; a word that is no type is saved as other, and said", () => {
  const criteria = [
    { criterionType: "disease", kind: "inclusion" }, { criterionType: "prior_therapy" }, { criterionType: "performance" }, { criterionType: "organ_function" },
    { criterionType: "histology" }, { criterionType: "cns" }, { criterionType: "biomarker" }, { kind: "exclusion" },
  ];
  const read = vcrNormalizeWriteRow("candidate_trial", { registryId: "NCT06927986", criteria });
  assert.deepEqual(read.row.criteria.map((/** @type {any} */ criterion) => criterion.criterionType), ["diagnosis", "prior_treatment", "performance_status", "lab", "diagnosis", "other", "biomarker", undefined]);
  assert.deepEqual(read.applied.map((entry) => entry.field), ["criteria[0].criterionType", "criteria[1].criterionType", "criteria[2].criterionType", "criteria[3].criterionType", "criteria[4].criterionType", "criteria[5].criterionType"]);
  const unknown = read.applied.find((entry) => entry.from === "cns");
  assert.equal(unknown?.value, "other");
  assert.match(String(unknown?.took), /demographic、diagnosis、biomarker、lab、prior_treatment/, "the types are listed so a later version can say which");
  assert.equal(criteria[0].criterionType, "disease");
  assert.equal(vcrNormalizeWriteRow("protocol", { criteria: [{ criterionType: "ecog" }] }).row.criteria[0].criterionType, "performance_status");
  // `criteria` writes a criterion on its own, or a list under criteria
  const alone = vcrNormalizeWriteRow("criteria", { criterionType: "prior_therapy", kind: "inclusion" });
  assert.equal(alone.row.criterionType, "prior_treatment");
  assert.deepEqual(alone.applied.map((entry) => entry.field), ["criterionType"]);
});

test("a plan's lists and sentences are kept as they were written", () => {
  const read = vcrNormalizeWriteRow("plan", { analysis: ["先解析后模拟", "再复核把握度"], sensitivity: "HR 0.80 与脱落率 10%", sealedFields: [] });
  assert.deepEqual(read.row, { analysis: { items: ["先解析后模拟", "再复核把握度"] }, sensitivity: { text: "HR 0.80 与脱落率 10%" }, sealedFields: [] });
  assert.deepEqual(read.applied.map((entry) => entry.field), ["analysis", "sensitivity"]);
  const objects = { analysis: { method: "logrank" }, sensitivity: { cases: ["a"] } };
  assert.deepEqual(vcrNormalizeWriteRow("plan", objects), { row: objects, applied: [] });
  assert.deepEqual(vcrNormalizeWriteRow("plan", { analysis: "   " }).applied, []);
  assert.deepEqual(vcrNormalizeWriteRow("definition", { title: "x" }), { row: { title: "x" }, applied: [] });
  assert.deepEqual(vcrNormalizeWriteRow("plan", "nope"), { row: "nope", applied: [] });
});
