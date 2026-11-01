/**
 * The thirteen criteria of n2c2 2018 Track 1 (cohort selection), written the way the matching skill's requirement grammar
 * takes them, from the wording of the annotation guide and nothing else.
 *
 * What is decided here, once, before any model is called, and then frozen with the rest of the harness:
 *
 * - Each criterion's `sourceText` is the guide's own wording (the guide's definitions of "major complication" and "advanced"
 *   are part of the wording the annotators were given, so they are part of it here). No clinical rule, threshold or synonym
 *   list is added: what counts as intra-abdominal surgery, as a supplement or as over the weekly limit is the model's reading
 *   of the note, as it is in a study.
 * - The structure is the grammar's, used the way a protocol would use it: a condition the grammar can say as presence, a
 *   number against a range, or a window counted back from "now" is written that way, so the evaluator, not the model,
 *   combines and times it. A condition the grammar cannot say (a count of medications, a capability, "above the upper limit
 *   of normal" with no number) is a `language` node the model answers with a quotation. Nothing here was chosen after seeing
 *   a result, and nothing in it is per-criterion tuning: it is the translation of the guide into the grammar.
 * - Every criterion is an inclusion of the form "the patient meets this", so `satisfied` is the gold's `met`.
 * - "Now" is the date of the patient's most recent record (the guide, section 2); `data.mjs` reads it from the file.
 *
 * @module n2c2/criteria
 */
import { validateRequirement } from '@evimed/domain';

/** The tags in the order the official scorer prints them. */
export const TAGS = Object.freeze([
  'ABDOMINAL', 'ADVANCED-CAD', 'ALCOHOL-ABUSE', 'ASP-FOR-MI', 'CREATININE', 'DIETSUPP-2MOS', 'DRUG-ABUSE',
  'ENGLISH', 'HBA1C', 'KETO-1YR', 'MAJOR-DIABETES', 'MAKES-DECISIONS', 'MI-6MOS',
]);

/** The two tags for which the guide says an unmentioned criterion is probably met (section 4). */
export const ABSENT_MEANS_MET = Object.freeze(['ENGLISH', 'MAKES-DECISIONS']);

/** @param {string} variable */
const present = (variable) => ({ op: 'present', variable });

/**
 * Variables the model is asked about, with the guide's words for each. A criterion that splits into parts says each part in the
 * guide's own words; the variable name only has to be unique and legible.
 * @type {Readonly<Record<string, string>>}
 */
export const VARIABLES = Object.freeze({
  drug_abuse: 'Drug abuse, current or past',
  alcohol_use_over_weekly_limit: 'Current alcohol use over weekly recommended limits',
  intra_abdominal_surgery: 'History of intra abdominal surgery',
  intestine_resection: 'History of small or large intestine resection',
  small_bowel_obstruction: 'History of small bowel obstruction',
  diabetic_amputation: 'Major diabetes-related complication: amputation (a result of, or strongly correlated with, uncontrolled diabetes)',
  diabetic_kidney_damage: 'Major diabetes-related complication: kidney damage (a result of, or strongly correlated with, uncontrolled diabetes)',
  diabetic_skin_condition: 'Major diabetes-related complication: skin conditions (a result of, or strongly correlated with, uncontrolled diabetes)',
  diabetic_retinopathy: 'Major diabetes-related complication: retinopathy (a result of, or strongly correlated with, uncontrolled diabetes)',
  diabetic_nephropathy: 'Major diabetes-related complication: nephropathy (a result of, or strongly correlated with, uncontrolled diabetes)',
  diabetic_neuropathy: 'Major diabetes-related complication: neuropathy (a result of, or strongly correlated with, uncontrolled diabetes)',
  myocardial_infarction: 'Myocardial infarction (history of; and in the past 6 months)',
  current_angina: 'Currently experiencing angina',
  ischemia: 'Ischemia, past or present',
  ketoacidosis: 'Diagnosis of ketoacidosis (in the past year)',
  dietary_supplement: 'Taken a dietary supplement (excluding Vitamin D) (in the past 2 months)',
  aspirin_to_prevent_myocardial_infarction: 'Use of aspirin to prevent myocardial infarction',
  hba1c: 'HbA1c value (any value between 6.5 and 9.5%)',
});

/**
 * Criteria only language can decide: the model answers with a state and a quotation.
 * @type {Readonly<Record<string, string>>}
 */
export const LANGUAGE_CRITERIA = Object.freeze({
  speaks_english: 'Patient must speak English',
  makes_own_medical_decisions: 'Patient must make their own medical decisions',
  cad_two_or_more_medications: 'Advanced cardiovascular disease, one of the four parts: taking two or more medications to treat CAD',
  serum_creatinine_above_upper_limit_of_normal: 'Serum creatinine > upper limit of normal',
});

const meds = { op: 'language', key: 'cad_two_or_more_medications', text: LANGUAGE_CRITERIA.cad_two_or_more_medications };
const infarction = present('myocardial_infarction');
const angina = present('current_angina');
const ischemia = present('ischemia');
const parts = [meds, infarction, angina, ischemia];
/** Two or more of four, said in the grammar's own connectives: any pair. */
const twoOfFour = parts.flatMap((first, i) => parts.slice(i + 1).map((second) => ({ op: 'all', operands: [first, second] })));

/**
 * @type {ReadonlyArray<{ tag: string, id: string, kind: 'inclusion', criterionType: string, sourceText: string, requirement: any }>}
 */
export const CRITERIA = Object.freeze([
  { tag: 'ABDOMINAL', id: 'abdominal', kind: 'inclusion', criterionType: 'prior_treatment',
    sourceText: 'History of intra abdominal surgery, small or large intestine resection or small bowel obstruction',
    requirement: { op: 'any', operands: [present('intra_abdominal_surgery'), present('intestine_resection'), present('small_bowel_obstruction')] } },
  { tag: 'ADVANCED-CAD', id: 'advanced_cad', kind: 'inclusion', criterionType: 'diagnosis',
    sourceText: 'Advanced cardiovascular disease. We define "advanced" as having two or more of the following: taking two or more medications to treat CAD; history of myocardial infarction; currently experiencing angina; ischemia, past or present',
    requirement: { op: 'any', operands: twoOfFour } },
  { tag: 'ALCOHOL-ABUSE', id: 'alcohol_abuse', kind: 'inclusion', criterionType: 'comorbidity',
    sourceText: 'Current alcohol use over weekly recommended limits', requirement: present('alcohol_use_over_weekly_limit') },
  { tag: 'ASP-FOR-MI', id: 'asp_for_mi', kind: 'inclusion', criterionType: 'concomitant_medication',
    sourceText: 'Use of aspirin to prevent myocardial infarction', requirement: present('aspirin_to_prevent_myocardial_infarction') },
  { tag: 'CREATININE', id: 'creatinine', kind: 'inclusion', criterionType: 'lab',
    sourceText: 'Serum creatinine > upper limit of normal',
    requirement: { op: 'language', key: 'serum_creatinine_above_upper_limit_of_normal', text: LANGUAGE_CRITERIA.serum_creatinine_above_upper_limit_of_normal } },
  { tag: 'DIETSUPP-2MOS', id: 'dietsupp_2mos', kind: 'inclusion', criterionType: 'concomitant_medication',
    sourceText: 'Taken a dietary supplement (excluding Vitamin D) in the past 2 months',
    requirement: { op: 'present', variable: 'dietary_supplement', window: { months: 2 } } },
  { tag: 'DRUG-ABUSE', id: 'drug_abuse', kind: 'inclusion', criterionType: 'comorbidity',
    sourceText: 'Drug abuse, current or past', requirement: present('drug_abuse') },
  { tag: 'ENGLISH', id: 'english', kind: 'inclusion', criterionType: 'other',
    sourceText: 'Patient must speak English', requirement: { op: 'language', key: 'speaks_english', text: LANGUAGE_CRITERIA.speaks_english } },
  { tag: 'HBA1C', id: 'hba1c', kind: 'inclusion', criterionType: 'lab',
    sourceText: 'Any HbA1c value between 6.5 and 9.5%',
    requirement: { op: 'compare', variable: 'hba1c', comparator: 'between', value: 6.5, highValue: 9.5, unit: '%', aggregate: 'any' } },
  { tag: 'KETO-1YR', id: 'keto_1yr', kind: 'inclusion', criterionType: 'diagnosis',
    sourceText: 'Diagnosis of ketoacidosis in the past year', requirement: { op: 'present', variable: 'ketoacidosis', window: { years: 1 } } },
  { tag: 'MAJOR-DIABETES', id: 'major_diabetes', kind: 'inclusion', criterionType: 'comorbidity',
    sourceText: 'Major diabetes-related complication. We define "major complication" (as opposed to "minor complication") as any of the following that are a result of (or strongly correlated with) uncontrolled diabetes: amputation; kidney damage; skin conditions; retinopathy; nephropathy; neuropathy',
    requirement: { op: 'any', operands: ['diabetic_amputation', 'diabetic_kidney_damage', 'diabetic_skin_condition', 'diabetic_retinopathy', 'diabetic_nephropathy', 'diabetic_neuropathy'].map(present) } },
  { tag: 'MAKES-DECISIONS', id: 'makes_decisions', kind: 'inclusion', criterionType: 'consent_capacity',
    sourceText: 'Patient must make their own medical decisions',
    requirement: { op: 'language', key: 'makes_own_medical_decisions', text: LANGUAGE_CRITERIA.makes_own_medical_decisions } },
  { tag: 'MI-6MOS', id: 'mi_6mos', kind: 'inclusion', criterionType: 'time_window',
    sourceText: 'Myocardial infarction in the past 6 months', requirement: { op: 'present', variable: 'myocardial_infarction', window: { months: 6 } } },
]);

/** The criterion for a tag. @param {string} tag */
export function criterionOf(tag) {
  const found = CRITERIA.find((item) => item.tag === tag);
  if (!found) throw new Error(`Unknown n2c2 tag: ${tag}`);
  return found;
}

/** Every variable any requirement or applicability names, in first-seen order. @param {readonly any[]} [criteria] */
export function variablesOf(criteria = CRITERIA) {
  /** @type {string[]} */
  const seen = [];
  /** @param {any} node */
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.variable === 'string' && !seen.includes(node.variable)) seen.push(node.variable);
    for (const child of node.operands ?? []) walk(child);
    if (node.operand) walk(node.operand);
  };
  for (const criterion of criteria) walk(criterion.requirement);
  return seen;
}

/** The keys of the language nodes. @param {readonly any[]} [criteria] */
export function languageKeysOf(criteria = CRITERIA) {
  /** @type {string[]} */
  const seen = [];
  /** @param {any} node */
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.op === 'language' && typeof node.key === 'string' && !seen.includes(node.key)) seen.push(node.key);
    for (const child of node.operands ?? []) walk(child);
    if (node.operand) walk(node.operand);
  };
  for (const criterion of criteria) walk(criterion.requirement);
  return seen;
}

/** The grammar's own verdict on the criteria: an empty list when every requirement is one the platform would accept. */
export function criteriaIssues() {
  return CRITERIA.flatMap((criterion) => validateRequirement(criterion.requirement, { path: criterion.id }).map((issue) => ({ id: criterion.id, issue })));
}
