/**
 * Features the platform used to have and no longer does, each named by the literal strings a lesson uses for it.
 *
 * Hidden knowledge: a learned method or a capability handbook is text the model is told to follow, and it was learnt from a
 * run, so it carries whatever the run's platform was doing at the time. The 2026-09-17 ruling deleted six files a clinical
 * evidence package used to keep about itself and the checks that read them, and 2026-10-10 deleted the paired evaluation of
 * a method; handbooks and methods learnt before those days kept telling runs to write the files, to stay within a count of
 * submissions, or to wait for an evaluation, and were mounted into runs for as long as nothing proved them harmful
 * (`methodHarmTest` reads only runs that opened a method, and a method that tells a run to do something pointless is still
 * opened and still "works"). Nothing swept them when a ruling removed a feature (audit 2026-10-23, B defect 4).
 *
 * This is the one place that says what is gone. It is a closed list of names, never a reading of what a lesson means
 * (development principle 5: no open-vocabulary prose pattern): a lesson is stale when it contains one of these literal strings,
 * compared without regard to case. Two uses, one list — a lesson that names one is refused when it is written
 * (`validateMethodSkill`, `method_stale_feature`), and a sweep puts away what was learnt before the ruling
 * (`scripts/ops/learning-sweep.mjs`, reason `stale_feature`, restorable in one click).
 *
 * What does NOT belong here: a name that is still a deliverable of some capability. `citation-ledger.csv` was one of the six
 * files of the clinical evidence package and is still written by `evidence-appraisal`, `manuscript-support` and
 * `research-grant-development`, so a method about a manuscript's citation ledger is as true as ever. The test beside this
 * module reads the shipped capability table and fails when a name here is produced by a capability again.
 *
 * @module @evimed/domain/src/retiredFeatures
 */

/**
 * @typedef {object} RetiredFeature
 * @property {string} id       a stable name for the feature, written on the sweep's report
 * @property {string} since    the day it was removed (`YYYY-MM-DD`), for a reader of the report
 * @property {readonly string[]} terms   the literal strings a lesson uses for it, compared without regard to case
 */

/** @type {readonly Readonly<RetiredFeature>[]} */
export const RETIRED_FEATURES = Object.freeze([
  // The clinical evidence package is the report and the matrix (ruling 2026-09-17, `1ab70f990`): the files below were written by
  // the run about itself and judged by checks that withheld deliveries, and went with those checks.
  Object.freeze({ id: 'search-log', since: '2026-09-17', terms: Object.freeze(['clinical-evidence-search.json']) }),
  Object.freeze({ id: 'run-receipt', since: '2026-09-17', terms: Object.freeze(['clinical-evidence-run.json']) }),
  Object.freeze({ id: 'question-ledger', since: '2026-09-17', terms: Object.freeze(['question-coverage.json']) }),
  Object.freeze({ id: 'citation-audit', since: '2026-09-17', terms: Object.freeze(['citation-audit.md']) }),
  Object.freeze({ id: 'bibliography', since: '2026-09-17', terms: Object.freeze(['references.bib']) }),
  // The count of submissions a run was held to. A gate verdict is a return value and never withholds a delivery, so a lesson
  // that teaches how to stay inside a count is teaching about a limit that no longer decides anything.
  Object.freeze({ id: 'submit-limit', since: '2026-09-17', terms: Object.freeze(['submit limit', 'submission limit', '提交次数', '提交上限']) }),
  // A method's paired on/off evaluation, deleted on 2026-10-10 (no paid method study): a method takes effect when it is learnt.
  Object.freeze({ id: 'paired-evaluation', since: '2026-10-10', terms: Object.freeze(['paired evaluation', '配对评测', '配对评估', '成对评测']) }),
])

/**
 * The retired features a text names.
 * @param {unknown} text
 * @returns {{ feature: string, since: string, term: string }[]}  one entry per feature, with the first term of it the text holds
 */
export function retiredFeaturesIn(text) {
  const haystack = String(text ?? '').toLowerCase()
  if (!haystack) return []
  /** @type {{ feature: string, since: string, term: string }[]} */
  const found = []
  for (const feature of RETIRED_FEATURES) {
    const term = feature.terms.find((candidate) => haystack.includes(candidate.toLowerCase()))
    if (term) found.push({ feature: feature.id, since: feature.since, term })
  }
  return found
}

/**
 * Every text of a learned method or handbook a reader of it (the model) is given: the frontmatter's name, description,
 * routing hint and metadata, the body, the attached files, and the line a researcher reads (`display`). One function so the
 * write-time refusal and the sweep read the same thing.
 * @param {{ frontmatter?: any, body?: unknown, files?: Record<string, unknown> | null, display?: any } | null | undefined} method
 * @returns {string}
 */
export function methodTextOf(method) {
  const frontmatter = method?.frontmatter ?? {}
  const metadata = frontmatter.metadata && typeof frontmatter.metadata === 'object' ? Object.values(frontmatter.metadata) : []
  const display = method?.display && typeof method.display === 'object' ? [method.display.title, method.display.summary] : []
  const files = method?.files && typeof method.files === 'object' ? Object.values(method.files) : []
  return [frontmatter.name, frontmatter.description, frontmatter.whenToUse, ...metadata, method?.body, ...files, ...display]
    .filter((part) => typeof part === 'string' && part)
    .join('\n')
}

/**
 * The retired features a learned method or handbook names, anywhere a reader of it would meet them.
 * @param {Parameters<typeof methodTextOf>[0]} method
 * @returns {{ feature: string, since: string, term: string }[]}
 */
export function retiredFeaturesOfMethod(method) {
  return retiredFeaturesIn(methodTextOf(method))
}
