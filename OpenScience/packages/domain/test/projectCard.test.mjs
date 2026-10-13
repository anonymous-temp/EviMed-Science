import assert from "node:assert/strict";
import test from "node:test";

import {
  FRONTIER_SPECIALTIES,
  FRONTIER_SPECIALTY_LABELS_ZH,
  PROJECT_CARD_CLINICAL_SLOTS,
  PROJECT_CARD_EXTENSION_LABELS_ZH,
  PROJECT_CARD_EXTENSION_VALUE_MAX,
  PROJECT_CARD_GENERAL_SLOTS,
  PROJECT_CARD_SLOTS,
  PROJECT_CARD_SLOT_LABELS_ZH,
  PROJECT_FIELD_MAX,
  canonicalProjectField,
  isProjectCardKey,
  projectCardExtensionOfKey,
  projectCardExtensionValueFits,
  projectCardKey,
  projectCardSlotOfKey,
} from "../index.mjs";

test("the card is six general slots for any kind of work and the clinical elements as an extension, each with a name and a key that reads back as itself", () => {
  assert.deepEqual([...PROJECT_CARD_GENERAL_SLOTS], ["field", "goal", "subject", "data_source", "stage", "constraints"]);
  assert.deepEqual([...PROJECT_CARD_CLINICAL_SLOTS], ["population", "intervention", "comparator", "outcome", "design"]);
  assert.deepEqual([...PROJECT_CARD_SLOTS], [...PROJECT_CARD_GENERAL_SLOTS, ...PROJECT_CARD_CLINICAL_SLOTS]);
  for (const slot of PROJECT_CARD_SLOTS) {
    assert.ok(PROJECT_CARD_SLOT_LABELS_ZH[slot], `${slot} has a name`);
    assert.equal(projectCardSlotOfKey(projectCardKey(slot)), slot);
  }
  // The words the OpenViking project-context template uses, so the two engines present one card.
  assert.equal(PROJECT_CARD_SLOT_LABELS_ZH.goal, "目标");
  assert.equal(PROJECT_CARD_SLOT_LABELS_ZH.data_source, "材料与数据");
  assert.equal(PROJECT_CARD_SLOT_LABELS_ZH.field, "领域");
  assert.equal(projectCardSlotOfKey("project.primary_outcome"), null, "a key of the model's own making is no slot");
  assert.equal(projectCardSlotOfKey("preference.population"), null);
  assert.equal(projectCardSlotOfKey("Project.Outcome"), "outcome", "keys are compared as the store lowercases them");
  assert.equal(projectCardSlotOfKey(undefined), null);
});

test("another kind of work names its own slots under project.ext., checked for the shape of the name and the length of the value", () => {
  assert.equal(projectCardExtensionOfKey("project.ext.audience"), "audience");
  assert.equal(projectCardExtensionOfKey("Project.Ext.Peer_Venue"), "peer_venue");
  for (const key of ["project.ext.", "project.ext.Audience Name", "project.ext.1st", "project.ext.a.b", `project.ext.${"x".repeat(33)}`, "project.audience", "ext.audience", null]) {
    assert.equal(projectCardExtensionOfKey(key), null, String(key));
  }
  assert.ok(isProjectCardKey("project.stage") && isProjectCardKey("project.ext.method"));
  assert.ok(!isProjectCardKey("project.glory1.study_shape") && !isProjectCardKey("preference.output_language"));
  assert.equal(projectCardSlotOfKey("project.ext.method"), null, "an extension is not a named slot");
  assert.ok(projectCardExtensionValueFits("读者是临床内科医生"));
  assert.ok(!projectCardExtensionValueFits("   ") && !projectCardExtensionValueFits("长".repeat(PROJECT_CARD_EXTENSION_VALUE_MAX + 1)));
  for (const name of Object.keys(PROJECT_CARD_EXTENSION_LABELS_ZH)) assert.equal(projectCardExtensionOfKey(`project.ext.${name}`), name);
});

test("a project's field is open vocabulary: up to three short phrases in the researcher's words, any of them kept", () => {
  for (const [said, stored] of [
    ["软件工程", "软件工程"],
    ["市场营销", "市场营销"],
    ["机器学习 / 医学影像", "机器学习、医学影像"],
    ["后端架构, 支付系统", "后端架构、支付系统"],
    ["Software engineering", "Software engineering"],
    ["心血管流行病学", "心血管流行病学"],
    [" 法律；劳动法 ", "法律、劳动法"],
    ["历史学、中国近代史、社会史、思想史", "历史学、中国近代史、社会史"],
    ["金融、金融", "金融"],
  ]) assert.equal(canonicalProjectField(said), stored, said);
  assert.equal(PROJECT_FIELD_MAX, 3);
});

test("a phrase that is one of the frontier feed's specialties is stored under the feed's name so the two meet; the others are not touched", () => {
  assert.equal(canonicalProjectField("心血管"), "心血管");
  assert.equal(canonicalProjectField("cardiology"), "心血管", "the vocabulary's own id is read as its name");
  assert.equal(canonicalProjectField("肿瘤, 心血管"), "肿瘤、心血管");
  assert.equal(canonicalProjectField("心血管、软件工程"), "心血管、软件工程", "one phrase off the list does not spoil the other");
  assert.equal(canonicalProjectField("口腔正畸"), "口腔正畸", "a field the feed has no entry for is kept");
  for (const id of FRONTIER_SPECIALTIES) assert.equal(canonicalProjectField(FRONTIER_SPECIALTY_LABELS_ZH[id]), FRONTIER_SPECIALTY_LABELS_ZH[id]);
});

test("what is no field is nothing, or a sentence", () => {
  for (const value of ["", "   ", "，、", "我们课题是比较新型口服抗凝药和华法林在 75 岁以上非瓣膜性房颤患者里的大出血风险，设计是回顾性队列", null, undefined, 3]) {
    assert.equal(canonicalProjectField(value), null, String(value));
  }
});
