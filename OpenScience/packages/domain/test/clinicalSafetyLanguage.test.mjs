// The clinical safety checks on an English report (2026-10-28 review).
//
// Every safety wording was Chinese while an English deliverable became an ordinary request, so on an English report the checks
// were silent ("Call emergency services if pain persists after nitroglycerin" drew no emergency-trigger-conditioned) and one was
// wrong the other way: "Suxiao Jiuxin Wan (速效救心丸)" tripped the rule that asks for a Chinese sentence about the medicine.
// The English wordings are closed phrase lists in the pharmacists' rules file; the rule that applies is the one in the report's
// own language, and a rule with no wording in that language is reported as not checked, never as passed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import rulesData from "../src/clinical-safety-rules.json" with { type: "json" };
import {
  clinicalEvidenceAdvisoryNotes,
  clinicalSafetyRuleHits,
  clinicalSafetyRulesNotChecked,
  compileClinicalSafetyRule,
  evaluateClinicalSafetyRules,
  reportLanguage,
  validateLoadedSafetyRules,
} from "../src/clinicalEvidence.mjs";
import {
  compilePhraseVariant,
  englishConditionedEmergencyTriggers,
  englishEmergencyDispatchPattern,
  englishExclusiveSafetyPattern,
  phrasePattern,
  rulesNotChecked,
} from "../src/clinicalSafetyLanguage.mjs";

const rulesDocument = JSON.parse(await readFile(new URL("../src/clinical-safety-rules.json", import.meta.url), "utf8"));

/** The practical section of an English report, and the rule ids that fire on it. */
function firedOnEnglish(/** @type {string} */ practical, { gloss = true, question = "Chest pain and Suxiao Jiuxin Wan: what do guidelines advise?" } = {}) {
  const reportText = [
    "# Management of acute chest pressure",
    "",
    "## Results",
    `The review identified guideline statements on Suxiao Jiuxin Wan${gloss ? " (速效救心丸)" : ""} and on sublingual nitroglycerin.`,
    "",
    "## Practice points",
    practical,
    "",
    "## References",
    "1. Guideline. 2020.",
  ].join("\n");
  assert.equal(reportLanguage(reportText), "en");
  return clinicalSafetyRuleHits({ reportText, practical, question }).map((hit) => hit.ruleId);
}

test("an English instruction that makes the call depend on the medicine is found, and its compliant forms are not", () => {
  const spans = (/** @type {string} */ sentence) => englishConditionedEmergencyTriggers(sentence).map((found) => found.span);
  // The incident, and the ways to write it.
  assert.deepEqual(spans("Call emergency services if pain persists after nitroglycerin."), ["persists"]);
  assert.deepEqual(spans("If the pain persists after nitroglycerin, call 999."), ["persists"]);
  assert.deepEqual(spans("If nitroglycerin does not relieve the pain, call an ambulance."), ["does not relieve"]);
  assert.deepEqual(spans("If nitroglycerin fails, call emergency services."), ["fails"]);
  assert.deepEqual(spans("Take nitroglycerin 0.4 mg. If the pain still persists, call 999."), ["persists"], "the medicine stated one sentence earlier is carried");
  assert.deepEqual(spans("Give the first dose and call 911 immediately if the pain does not ease after the dose."), ["does not ease"]);
  // The unconditional rule, and instructions whose trigger is a symptom, are what the section is for.
  for (const compliant of [
    "Call 999 regardless of whether the pain persists after nitroglycerin.",
    "Call emergency services immediately; do not wait to see whether nitroglycerin works.",
    "Take nitroglycerin and call 999 at the same time, whether or not it helps.",
    "Call 999 even if the pain is relieved after the dose.",
    "Do not wait for the dose to work before you call 999 if the pain persists.",
    "Call 999 immediately. If the pain persists after the dose, stay seated and wait.",
    "Call 999 and take nitroglycerin; if pain persists, lie still.",
    "Call 999 immediately if the pain persists, then give nitroglycerin.",
    "Call 999 if chest pain persists for more than 15 minutes.",
    "Call emergency services if CPR fails.",
  ]) assert.deepEqual(spans(compliant), [], compliant);
  // Reported by line, so a notice names the sentence to fix.
  const [found] = englishConditionedEmergencyTriggers("First line.\nCall 999 if the pain persists after nitroglycerin. Rest.");
  assert.equal(found.line, 2);
  assert.match(found.sentence, /^Call 999 if the pain persists/);
});

test("the pharmacists' rules read an English report in English", () => {
  const unconditional = "Suxiao Jiuxin Wan must not delay calling emergency services; call at the same time.";
  // The required sentence, in the report's language, satisfies the rule — with the Chinese gloss of the name beside it or not.
  assert.deepEqual(firedOnEnglish(unconditional), []);
  assert.deepEqual(firedOnEnglish(unconditional, { gloss: false }), []);
  for (const sentence of [
    "Taking Suxiao Jiuxin Wan is not a reason to wait: call an ambulance at once.",
    "Do not let any medicine delay calling emergency services.",
    "Do not wait for the dose to work before calling 999.",
  ]) assert.deepEqual(firedOnEnglish(sentence), [], sentence);
  // Without it the rule fires, and the medicine was named only in English.
  assert.deepEqual(firedOnEnglish("Take the pills and rest."), ["suxiao-must-not-delay-emergency"]);
  assert.deepEqual(firedOnEnglish("Take the pills and rest.", { gloss: false }), ["suxiao-must-not-delay-emergency"]);
  // And a Chinese sentence in an English report does not stand in for the English one (it used to be the only thing that did).
  assert.deepEqual(firedOnEnglish("速效救心丸不应延误急救，应同时拨打 120。"), ["suxiao-must-not-delay-emergency"]);
  // A report that never names the medicine is not asked for the sentence.
  const noMedicine = "# Chest pain\n\n## Practice points\nCall 999.\n";
  assert.deepEqual(clinicalSafetyRuleHits({ reportText: noMedicine, practical: "Call 999.", question: "Chest pain?" }).map((hit) => hit.ruleId), []);
});

test("an English practical answer that reads a medicine's response as a diagnosis, or advises an antacid and waiting, is found", () => {
  const response = [
    "Relief after nitroglycerin means the pain is cardiac, so you can stay at home.",
    "If the pain is relieved by nitroglycerin, it is just indigestion and you can watch at home.",
    "Sublingual response can be used to diagnose angina.",
    "Use the response to nitroglycerin to decide whether to go to hospital, and rule out a heart attack if the pain settles.",
  ];
  for (const sentence of response) assert.ok(firedOnEnglish(sentence).includes("medication-response-not-diagnostic"), sentence);
  for (const refutation of [
    "Relief after nitroglycerin does not distinguish cardiac from non-cardiac pain; call emergency services regardless.",
    "Response to sublingual nitroglycerin cannot be used to diagnose angina.",
    "Never rely on relief after the dose to rule out a heart attack.",
  ]) assert.ok(!firedOnEnglish(refutation).includes("medication-response-not-diagnostic"), refutation);

  const selfCare = [
    "You can take an antacid and wait to see if the pain goes away.",
    "Try an antacid first and observe the symptoms.",
    "You may wait and see how the symptoms change.",
  ];
  for (const sentence of selfCare) assert.ok(firedOnEnglish(sentence).includes("unsupported-self-care"), sentence);
  for (const compliant of [
    "Do not take an antacid and wait; call emergency services.",
    "Wait for the ambulance beside the patient and keep them seated.",
    "Antacids do not exclude a cardiac cause.",
  ]) assert.ok(!firedOnEnglish(compliant).includes("unsupported-self-care"), compliant);
});

test("a Chinese report is read by the Chinese wording and an English report by the English one, each as before", () => {
  const zh = (/** @type {string} */ practical, /** @type {string} */ reportText) => clinicalSafetyRuleHits({ reportText, practical, question: "胸痛与速效救心丸怎么办？" }).map((hit) => hit.ruleId);
  const report = (/** @type {string} */ practical) => `# 胸痛的处置\n\n## 结果\n速效救心丸与硝酸甘油均有指南陈述。\n\n## 临床实践要点\n${practical}\n\n## 参考文献\n1. 指南。\n`;
  assert.deepEqual(zh("速效救心丸不应延误急救，应同时拨打 120。", report("速效救心丸不应延误急救，应同时拨打 120。")), []);
  assert.deepEqual(zh("应休息。", report("应休息。")), ["suxiao-must-not-delay-emergency"]);
  assert.ok(zh("先含服硝酸甘油，如果缓解说明是心绞痛，可以先在家观察", report("先含服硝酸甘油，如果缓解说明是心绞痛，可以先在家观察")).includes("medication-response-not-diagnostic"));
  // English prose in a Chinese report is not read by the English wording.
  assert.deepEqual(zh("Rest.", report("Relief after nitroglycerin means the pain is cardiac.")), ["suxiao-must-not-delay-emergency"]);
  // The caller that already knows the language may say so.
  assert.deepEqual(
    clinicalSafetyRuleHits({ reportText: report("应休息。"), practical: "应休息。", question: "速效救心丸怎么办？", language: "en" }).map((hit) => hit.ruleId),
    [],
    "an English reading of Chinese prose finds nothing to trigger on",
  );
  // And the string form callers use keeps working.
  assert.ok(evaluateClinicalSafetyRules({ reportText: report("应休息。"), practical: "应休息。" }).length > 0);
});

test("an exclusive safety claim is found in English, and a study that was the only one is not it", () => {
  for (const claim of [
    "Immediate stenting is the only safe treatment option for these patients.",
    "This is the only recommended approach to dosing.",
    "Treatment is the only safe option.",
    "Observation is the sole reliable strategy.",
  ]) assert.ok(englishExclusiveSafetyPattern.test(claim), claim);
  for (const fine of [
    "This was the only trial that studied a safe dose in children.",
    "It is the only included study with safe follow-up.",
    "Immediate stenting is one safe treatment option; observation is another.",
    "The only reviewed paper on a recommended approach used a cohort design.",
  ]) assert.ok(!englishExclusiveSafetyPattern.test(fine), fine);
});

test("an English call-for-help claim is recognised by the same phrase list", () => {
  assert.ok(englishEmergencyDispatchPattern.test("Patients should call 999 at once."));
  assert.ok(englishEmergencyDispatchPattern.test("Call an ambulance if the pain is severe."));
  assert.ok(!englishEmergencyDispatchPattern.test("The ambulance service was not audited."));
});

test("a rule with no wording in the report's language is not checked, and says so", () => {
  const written = (/** @type {Record<string, any>} */ rule) => ({ kind: "practical_forbidden", message: "m", pattern: "x", ...rule });
  const rules = [
    written({ id: "chinese-only" }),
    written({ id: "both", languages: ["zh", "en"] }),
    written({ id: "with-english", en: { forms: [{ parts: [["aspirin"], ["bleeding"]] }] } }),
  ];
  assert.deepEqual(rulesNotChecked(rules, "en"), ["chinese-only"]);
  assert.deepEqual(rulesNotChecked(rules, "zh"), []);
  // Every rule this build ships is written in both, so no report goes unchecked today; a pharmacist's next Chinese-only rule will show.
  assert.deepEqual(clinicalSafetyRulesNotChecked("An English report about aspirin and bleeding risk in older adults.", "en"), []);
  assert.deepEqual(clinicalSafetyRulesNotChecked("关于阿司匹林出血风险的中文报告。", "zh"), []);
  assert.deepEqual(
    rulesDocument.rules.map((/** @type {Record<string, any>} */ rule) => [rule.id, Boolean(rule.en) || (rule.languages ?? []).includes("en")]).filter((/** @type {[string, boolean]} */ [, covered]) => !covered),
    [],
  );
});

test("the report says which pharmacist rule did not look at it", () => {
  // A rule added in Chinese alone is the realistic case: until its English wording is written, an English report is told it was
  // not checked against it (an advisory note), and a Chinese report is not told anything.
  const english = "# Aspirin and bleeding\n\n## Abstract\nOlder adults on aspirin bleed more often than those who are not given it, in the trials reviewed here.\n\n## Conclusions\nThe trials agree.\n";
  const chinese = "# 阿司匹林与出血\n\n## 摘要\n老年人服用阿司匹林后出血更常见，纳入的试验结果一致。\n\n## 结论\n试验一致。\n";
  const notes = (/** @type {string} */ text) => clinicalEvidenceAdvisoryNotes(text).filter((note) => /safety rule|临床安全规则/.test(note));
  assert.deepEqual(notes(english), []);
  const lone = /** @type {any} */ ({ id: "chinese-only-rule", kind: "practical_forbidden", message: "m", pattern: "甲" });
  /** @type {any[]} */
  const shipped = rulesData.rules;
  shipped.push(lone);
  try {
    assert.deepEqual(clinicalSafetyRulesNotChecked(english), ["chinese-only-rule"]);
    assert.deepEqual(clinicalSafetyRulesNotChecked(chinese), []);
    const [note] = notes(english);
    assert.match(note, /^clinical-evidence-report\.md: the clinical safety rule chinese-only-rule has no English wording yet, so this English report was not checked against it\./);
    assert.deepEqual(notes(chinese), []);
  } finally {
    shipped.splice(shipped.indexOf(lone), 1);
  }
  assert.deepEqual(notes(english), []);
});

test("an English wording is refused at load when it cannot work, naming the rule", () => {
  assert.throws(() => compilePhraseVariant({ forms: [] }, "rule \"r\".en"), /rule "r"\.en needs at least one form/);
  assert.throws(() => compilePhraseVariant({ forms: [{ parts: [] }] }, "rule \"r\".en"), /needs at least one part/);
  assert.throws(() => compilePhraseVariant({ forms: [{ parts: [["a"], []] }] }, "rule \"r\".en"), /parts\[1\] must be a non-empty list of phrases/);
  assert.throws(() => compilePhraseVariant({ forms: [{ parts: [["a"]], maxGap: 0 }] }, "rule \"r\".en"), /maxGap must be an integer/);
  assert.throws(() => compilePhraseVariant({ forms: [{ parts: [["a"]] }], negators: [""] }, "rule \"r\".en"), /negators must be a non-empty list/);
  // A rule that fires on an absence needs its own English trigger: the Chinese one cannot see English prose.
  const required = compileClinicalSafetyRule({
    id: "r", kind: "practical_required_when_report_matches", message: "m", pattern: "甲", triggerPattern: "乙",
    en: { forms: [{ parts: [["must not delay"]] }] },
  });
  assert.throws(() => validateLoadedSafetyRules([required]), /rule "r" is missing en\.triggerPhrases/);
  const complete = compileClinicalSafetyRule({
    id: "r", kind: "practical_required_when_report_matches", message: "m", pattern: "甲", triggerPattern: "乙",
    en: { triggerPhrases: ["aspirin"], forms: [{ parts: [["must not delay"]] }] },
  });
  assert.doesNotThrow(() => validateLoadedSafetyRules([complete]));
  assert.doesNotThrow(() => validateLoadedSafetyRules(null));
});

test("a phrase list is plain words compared whole, so editing it cannot write a pattern", () => {
  /** @type {string[]} */
  const lists = [];
  const collect = (/** @type {unknown} */ value) => {
    if (typeof value === "string") lists.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, entry]) => { if (key !== "maxGap") collect(entry); });
  };
  collect(rulesDocument.genericSafetyVocabularies);
  for (const rule of rulesDocument.rules) collect(rule.en);
  assert.ok(lists.length > 300, `only ${lists.length} phrases found — the walk did not read the lists`);
  for (const phrase of lists) assert.match(phrase, /^[A-Za-z0-9][A-Za-z0-9 '\-.]*$/, `not plain words: ${phrase}`);
  // Whole-word comparison: "can " is not "can't", and "no" is not inside "nothing".
  assert.ok(new RegExp(phrasePattern("can "), "i").test("you can take"));
  assert.ok(!new RegExp(phrasePattern("can "), "i").test("you can't take"));
  assert.ok(!new RegExp(phrasePattern("no"), "i").test("nothing"));
  assert.ok(new RegExp(phrasePattern("call 999"), "i").test("Please CALL   999 now"));
});
