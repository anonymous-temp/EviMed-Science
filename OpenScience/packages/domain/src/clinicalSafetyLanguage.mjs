/**
 * The English wordings of the clinical safety checks, compiled from the closed
 * phrase lists in `clinical-safety-rules.json`.
 *
 * Hidden knowledge: why this is data and not a second set of patterns. Every
 * safety wording in `clinicalEvidence.mjs` was Chinese, while an English
 * deliverable is an ordinary request since the 3.0.0 capability. On an English
 * report the checks were silent (「call emergency services if pain persists after
 * nitroglycerin」 drew no `emergency-trigger-conditioned`) and one of them was
 * wrong the other way: 「Suxiao Jiuxin Wan (速效救心丸)」 tripped the rule that
 * requires a Chinese sentence about the medicine (2026-10-28 review).
 *
 * An English wording is a set of closed phrase lists a pharmacist reads and
 * edits, composed here into patterns: a phrase is compared whole and
 * case-insensitively, a form is phrases in order with a bounded gap that never
 * crosses a sentence end, and a negator inside the gap voids the match. Nothing
 * here is a free-text pattern over open language, which is why the
 * open-vocabulary pattern count in `test/vocabulary.test.mjs` does not move.
 *
 * The rule that applies to a report is the one written in the report's own
 * language (`reportLanguage`). A rule with no wording in that language is
 * reported as not checked (`rulesNotChecked`), never as passed.
 *
 * Pure: no I/O, no clock, browser-safe like the rest of the domain package.
 */

import rulesData from "./clinical-safety-rules.json" with { type: "json" };

/** The end of a sentence as a gap may not cross it: `;`, `!`, `?`, or a full stop followed by space or the end. */
const sentenceEnd = String.raw`[;!?]|\.(?:\s|$)`;
/** How many characters in front of a form's first part a negator still voids it. */
const negatorReach = 30;
/** The gap between two parts of a form when its list gives none. */
const defaultGap = 60;

/** @param {string} text @returns {string} */
function escapeForPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * One closed phrase as a pattern: matched whole (a word boundary wherever the
 * phrase starts or ends with a word character), spaces any whitespace. A
 * trailing space in the phrase means a word follows ("can " is not "can't").
 * @param {string} phrase @returns {string}
 */
export function phrasePattern(phrase) {
  const text = String(phrase);
  const lead = /^\w/.test(text) ? String.raw`\b` : "";
  const tail = /\w$/.test(text) ? String.raw`\b` : "";
  return `${lead}${escapeForPattern(text).replace(/\s+/g, String.raw`\s+`)}${tail}`;
}

/** Longest phrase first, so that the text a match reports is the whole phrase.
 *  @param {readonly string[]} phrases @returns {string} */
export function phraseAlternation(phrases) {
  return `(?:${[...phrases].sort((left, right) => right.length - left.length).map(phrasePattern).join("|")})`;
}

/**
 * @param {unknown} list @param {string} where
 * @returns {string[]}
 */
function phraseList(list, where) {
  if (!Array.isArray(list) || list.length === 0 || list.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`clinical-safety-rules.json: ${where} must be a non-empty list of phrases.`);
  }
  return list;
}

/**
 * A rule's wording in one language: closed phrase lists composed into the
 * pattern that fires (or, for a required sentence, satisfies) and the trigger.
 * Refuses a malformed wording at load, naming it, like every other rule here.
 * @param {Record<string, any>} variant
 * @param {string} where
 * @returns {{ pattern: RegExp, triggerPattern: RegExp | null }}
 */
export function compilePhraseVariant(variant, where) {
  if (!variant || typeof variant !== "object" || !Array.isArray(variant.forms) || variant.forms.length === 0) {
    throw new Error(`clinical-safety-rules.json: ${where} needs at least one form.`);
  }
  const negators = variant.negators == null ? [] : phraseList(variant.negators, `${where}.negators`);
  const negation = negators.length ? phraseAlternation(negators) : null;
  const gap = (/** @type {number} */ reach) => `(?:(?!${negation ? `${negation}|` : ""}${sentenceEnd}).){0,${reach}}`;
  const guard = negation ? `(?<!${negation}[^.;!?\\n]{0,${negatorReach}})` : "";
  const forms = variant.forms.map((/** @type {any} */ form, /** @type {number} */ index) => {
    const label = `${where}.forms[${index}]`;
    if (!form || !Array.isArray(form.parts) || form.parts.length === 0) throw new Error(`clinical-safety-rules.json: ${label} needs at least one part.`);
    const reach = form.maxGap == null ? defaultGap : form.maxGap;
    if (!Number.isInteger(reach) || reach < 1 || reach > 400) throw new Error(`clinical-safety-rules.json: ${label}.maxGap must be an integer from 1 to 400.`);
    const parts = form.parts.map((/** @type {unknown} */ part, /** @type {number} */ at) => phraseAlternation(phraseList(part, `${label}.parts[${at}]`)));
    return guard + parts.join(gap(reach));
  });
  const triggers = variant.triggerPhrases == null ? null : phraseList(variant.triggerPhrases, `${where}.triggerPhrases`);
  return {
    pattern: new RegExp(forms.join("|"), "i"),
    triggerPattern: triggers ? new RegExp(phraseAlternation(triggers), "i") : null,
  };
}

/** @typedef {"zh" | "en"} SafetyLanguage */

/**
 * The languages a rule declares a wording in, without compiling anything. A
 * rule's own pattern is its Chinese wording unless `languages` says it reads
 * both; an English wording is either that declaration or an `en` object.
 * @param {Record<string, any>} rule
 * @returns {{ zh: boolean, en: boolean }}
 */
export function declaredLanguages(rule) {
  const declared = Array.isArray(rule.languages) ? rule.languages : ["zh"];
  return { zh: declared.includes("zh"), en: declared.includes("en") || Boolean(rule.en) };
}

/**
 * What a rule reads in each language: `zh` whether its own pattern is its
 * Chinese wording, `en` the compiled English wording, `"same"` when the rule's
 * own pattern reads English too, or null for none.
 * @param {Record<string, any>} rule
 * @returns {{ zh: boolean, en: { pattern: RegExp, triggerPattern: RegExp | null } | "same" | null }}
 */
export function ruleLanguages(rule) {
  const declared = declaredLanguages(rule);
  const same = Array.isArray(rule.languages) && rule.languages.includes("en");
  return {
    zh: declared.zh,
    en: same ? "same" : rule.en ? compilePhraseVariant(rule.en, `rule "${rule.id}".en`) : null,
  };
}

// --- The generic checks ------------------------------------------------------

/** @typedef {{ dispatch: RegExp, medication: RegExp, relief: RegExp, efficacy: RegExp, anaphora: RegExp, conditionals: RegExp, reject: RegExp }} EmergencyVocabulary */

/**
 * @param {Record<string, any>} vocabulary
 * @returns {EmergencyVocabulary}
 */
export function compileEmergencyVocabulary(vocabulary) {
  const where = "genericSafetyVocabularies.emergencyTriggerConditioned.en";
  const pattern = (/** @type {string} */ name, flags = "gi") => new RegExp(phraseAlternation(phraseList(vocabulary?.[name], `${where}.${name}`)), flags);
  return {
    dispatch: pattern("dispatch"),
    medication: pattern("medication"),
    relief: pattern("relief"),
    efficacy: pattern("efficacy"),
    anaphora: pattern("anaphora", "i"),
    conditionals: pattern("conditionals", "i"),
    reject: pattern("reject", "i"),
  };
}

const genericVocabularies = /** @type {Record<string, any>} */ (rulesData).genericSafetyVocabularies;
if (!genericVocabularies?.emergencyTriggerConditioned?.en || !genericVocabularies?.exclusiveSafety?.en) {
  throw new Error("clinical-safety-rules.json is missing genericSafetyVocabularies.");
}

/** The English emergency vocabulary, compiled once. */
const englishEmergency = compileEmergencyVocabulary(genericVocabularies.emergencyTriggerConditioned.en);

/** The phrases that send a reader to emergency care, in English: also what an English claim about calling for help is read by. */
export const englishEmergencyDispatchPattern = new RegExp(englishEmergency.dispatch.source, "i");

/** A bounded recommendation written as the only safe one, in English. */
export const englishExclusiveSafetyPattern = compilePhraseVariant(genericVocabularies.exclusiveSafety.en, "genericSafetyVocabularies.exclusiveSafety.en").pattern;

/** Sentences of one line: a full stop, `!`, `?` or `;` followed by a space ends one. */
const sentenceSplit = /(?<=[.!?;])\s+/;
/** A comma, colon, semicolon or dash: a new clause. */
const clauseBreak = /[,;:–—]/;

/**
 * Every emergency-call sentence of an English practical section whose trigger
 * is how a self-administered medicine performed.
 *
 * The same rule as the Chinese check (`medicationConditionedEmergencyTriggers`):
 * emergency care is triggered by symptoms and signs, never by whether a
 * medicine worked. A failure phrase (persists, not relieved, does not work)
 * counts only when a medicine is named with it, and only when it is the
 * condition of the call: the call comes after it in the sentence ("If the pain
 * persists after nitroglycerin, call 999"), or comes before it and a
 * conditional word joins them within one clause ("Call 999 if the pain
 * persists after the dose"). A sentence that states the forbidden order in
 * order to forbid it ("regardless of whether", "do not wait") is the compliant
 * shape and is left alone.
 * @param {string} text the practical section, one report line per line
 * @param {EmergencyVocabulary} [vocabulary]
 * @returns {{ line: number, span: string, sentence: string }[]}
 */
export function englishConditionedEmergencyTriggers(text, vocabulary = englishEmergency) {
  /** @type {{ line: number, span: string, sentence: string }[]} */
  const found = [];
  for (const [lineIndex, line] of String(text ?? "").split("\n").entries()) {
    let medicationStated = false;
    for (const sentence of line.split(sentenceSplit)) {
      const medications = [...sentence.matchAll(vocabulary.medication)].map((match) => ({ at: match.index, end: match.index + match[0].length }));
      const dispatches = [...sentence.matchAll(vocabulary.dispatch)].map((match) => ({ at: match.index, end: match.index + match[0].length }));
      if (!dispatches.length) {
        medicationStated ||= medications.length > 0;
        continue;
      }
      const failures = [...sentence.matchAll(vocabulary.relief), ...sentence.matchAll(vocabulary.efficacy)]
        .map((match) => ({ at: match.index, end: match.index + match[0].length, span: match[0] }))
        .sort((left, right) => left.at - right.at);
      for (const failure of failures) {
        // A medicine named with the failure: before it, or just after it in the same clause. Or, for a sentence that
        // continues the line ("Take nitroglycerin. If the pain still persists, …"), one stated earlier and picked up.
        const named = medications.some((medication) => medication.end <= failure.at
          || (medication.at >= failure.end && medication.at - failure.end <= 40 && !clauseBreak.test(sentence.slice(failure.end, medication.at))));
        const carried = medicationStated && vocabulary.anaphora.test(sentence);
        if (!named && !carried) continue;
        // The call is conditioned on the failure.
        const after = dispatches.find((dispatch) => dispatch.at >= failure.end);
        const before = [...dispatches].reverse().find((dispatch) => dispatch.end <= failure.at);
        const callFollows = after !== undefined;
        const callPrecedes = before !== undefined
          && (() => {
            const between = sentence.slice(before.end, failure.at);
            return vocabulary.conditionals.test(between) && !clauseBreak.test(between);
          })();
        if (!callFollows && !callPrecedes) continue;
        // The forbidden order written in order to forbid it: a rejection ahead of the failure, or in its own clause.
        const ahead = sentence.slice(0, failure.at);
        const sameClause = sentence.slice(failure.end).split(clauseBreak)[0];
        if (vocabulary.reject.test(ahead) || vocabulary.reject.test(sameClause)) continue;
        found.push({ line: lineIndex + 1, span: failure.span, sentence });
      }
      medicationStated ||= medications.length > 0;
    }
  }
  return found;
}

/**
 * The rules with no wording in `language`, by id: what a report in that language
 * was not checked against.
 * @param {readonly Record<string, any>[]} rules the rules as the JSON holds them
 * @param {SafetyLanguage} language
 * @returns {string[]}
 */
export function rulesNotChecked(rules, language) {
  return rules.filter((rule) => !declaredLanguages(rule)[language]).map((rule) => String(rule.id));
}
