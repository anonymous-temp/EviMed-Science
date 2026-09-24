/**
 * What kind of study a deliverable reports or designs, declared when it is
 * planned.
 *
 * Hidden knowledge: why the plan declares it rather than the platform working
 * it out. A reporting guideline belongs to a study design, not to a contract
 * kind: `manuscript-section` is one section of whatever the researcher ran — a
 * trial, a prediction model, a cohort — and a proposal designs whichever study
 * it proposes. Reading the design off the prose would be a keyword wall over
 * open language (principle 2); the planner has it from the brief, so the plan
 * says it (owner ruling 2026-09-24: 「计划阶段先声明研究类型再挂，同时交付物里也
 * 放上」). Two things hang off the declaration: the independent reviewer
 * attaches that design's reporting checklist, and a deliverable whose contract
 * carries one writes the completed checklist beside itself — every item, and
 * where it is reported — as a journal asks its authors to.
 *
 * Absent means the deliverable reports no one study: an evidence review, an
 * evaluation, a brief. Which study types have a guideline, and which one, is
 * data (`study-types.json`).
 *
 * The reviewer's item texts are not here. This package ships inside the
 * runtime, and what the editor checks a package against is the control
 * plane's own (`apps/server/src/reviewChecklists.json`, keyed by the same
 * guideline ids — runtime-can-read-the-gate). The item tables the writer fills
 * are the guidelines' own published checklists, which are public and are not
 * the gate; they ship with the capability skills, under
 * `REPORTING_GUIDELINE_TEMPLATE_DIR`.
 */

import studyTypeTable from './study-types.json' with { type: 'json' }

/** @typedef {{ id: string, name: string, citation: string, url: string, template: string }} ReportingGuideline */

/** Every study type a plan may declare, in the table's order. */
export const STUDY_TYPES = /** @type {readonly string[]} */ (
  Object.freeze(studyTypeTable.studyTypes.map((row) => String(row.id)))
)

/** Chinese display names (§23.2 rule 11). */
export const STUDY_TYPE_LABELS_ZH = /** @type {Readonly<Record<string, string>>} */ (
  Object.freeze(Object.fromEntries(studyTypeTable.studyTypes.map((row) => [String(row.id), String(row.labelZh)])))
)

/**
 * Where the writer's item table of each guideline lives, relative to the
 * capability-skills root (`RUNTIME_SKILL_ROOTS`): the shared
 * `reporting-guidelines` skill's own `checklists/` directory.
 */
export const REPORTING_GUIDELINE_TEMPLATE_DIR = 'reporting-guidelines/checklists'

/** The completed checklist, in the deliverable's own directory. */
export const REPORTING_CHECKLIST_FILE = 'reporting-checklist.md'

/** Each reporting guideline a study type is written to, by id. */
export const REPORTING_GUIDELINES = /** @type {Readonly<Record<string, ReportingGuideline>>} */ (
  Object.freeze(Object.fromEntries(Object.entries(studyTypeTable.guidelines).map(([id, row]) => [id, Object.freeze({
    id,
    name: String(row.name),
    citation: String(row.citation),
    url: String(row.url),
    template: `${REPORTING_GUIDELINE_TEMPLATE_DIR}/${id}.md`,
  })])))
)

/** The guideline id of each study type, or null. */
const GUIDELINE_OF = new Map(studyTypeTable.studyTypes.map((row) => [String(row.id), row.guideline == null ? null : String(row.guideline)]))

for (const [type, guideline] of GUIDELINE_OF) {
  if (guideline !== null && !Object.hasOwn(REPORTING_GUIDELINES, guideline)) {
    throw new Error(`study-types.json: study type "${type}" names guideline "${guideline}", which the table does not define`)
  }
}

/** @param {unknown} value @returns {boolean} */
export function isStudyType(value) {
  return typeof value === 'string' && STUDY_TYPES.includes(value)
}

/** The Chinese name of a study type; an unknown value is returned as given. @param {unknown} value @returns {string} */
export function studyTypeLabel(value) {
  const text = String(value ?? '')
  return STUDY_TYPE_LABELS_ZH[text] ?? text
}

/**
 * The reporting guideline a study type is written to, or null — for a type
 * with none yet, for an unknown value, and for no value at all.
 * @param {unknown} studyType @returns {ReportingGuideline | null}
 */
export function reportingGuidelineFor(studyType) {
  const id = GUIDELINE_OF.get(String(studyType ?? ''))
  return id ? REPORTING_GUIDELINES[id] ?? null : null
}
