import assert from "node:assert/strict";
import test from "node:test";

import {
  FRONTIER_SPECIALTIES,
  FRONTIER_SPECIALTY_LABELS_ZH,
  PROJECT_CARD_SLOTS,
  PROJECT_CARD_SLOT_LABELS_ZH,
  PROJECT_FIELD_LABELS_ZH,
  canonicalProjectField,
  projectCardKey,
  projectCardSlotOfKey,
} from "../index.mjs";

test("every slot has a name and a key that reads back as itself", () => {
  assert.deepEqual([...PROJECT_CARD_SLOTS], ["field", "population", "intervention", "comparator", "outcome", "design", "data_source", "stage"]);
  for (const slot of PROJECT_CARD_SLOTS) {
    assert.ok(PROJECT_CARD_SLOT_LABELS_ZH[slot], `${slot} has a name`);
    assert.equal(projectCardSlotOfKey(projectCardKey(slot)), slot);
  }
  assert.equal(projectCardSlotOfKey("project.primary_outcome"), null, "a key of the model's own making is no slot");
  assert.equal(projectCardSlotOfKey("preference.population"), null);
  assert.equal(projectCardSlotOfKey("Project.Outcome"), "outcome", "keys are compared as the store lowercases them");
  assert.equal(projectCardSlotOfKey(undefined), null);
});

test("a project's field is the frontier feed's own twenty-one specialties, one to three of them", () => {
  assert.equal(PROJECT_FIELD_LABELS_ZH.length, FRONTIER_SPECIALTIES.length);
  assert.equal(canonicalProjectField("心血管"), "心血管");
  assert.equal(canonicalProjectField(" 心血管、肿瘤 "), "心血管、肿瘤");
  assert.equal(canonicalProjectField("肿瘤, 心血管"), "肿瘤、心血管");
  assert.equal(canonicalProjectField("cardiology"), "心血管", "the vocabulary's own id is read as its name");
  assert.equal(canonicalProjectField("心血管、心血管"), "心血管", "a repeat is one");
  for (const id of FRONTIER_SPECIALTIES) assert.equal(canonicalProjectField(FRONTIER_SPECIALTY_LABELS_ZH[id]), FRONTIER_SPECIALTY_LABELS_ZH[id]);
});

test("anything the list does not hold is no field", () => {
  for (const value of ["", "   ", "口腔正畸", "心血管疾病的真实世界研究", "心血管、肿瘤、神经、儿科", "心血管、口腔", null, undefined, 3]) {
    assert.equal(canonicalProjectField(value), null, String(value));
  }
});
