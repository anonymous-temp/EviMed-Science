import { array, check, object, oneOf, strings, text } from './validation.mjs'

/**
 * Criterion logic the model writes and code evaluates (2026-11-08 review). A composite criterion ("at least two of: prior MI, prior
 * revascularisation, angina, ischaemia on testing") is answered as parts with a rule, and a time-window criterion ("MI within six
 * months") as dates with a window; the arithmetic of counting parts and of days between dates is done here, never by the model.
 * Both are optional: a criterion without parts or timing keeps the model's verdict.
 */
export const CRITERION_VERDICTS = Object.freeze(['satisfied', 'not-satisfied', 'unknown', 'not-applicable'])
export const CRITERION_BASES = Object.freeze(['stated', 'silent', 'inferred', 'computed'])
export const CRITERION_RULES = Object.freeze(['all', 'any', 'atLeast'])
export const TIMING_RELATIONS = Object.freeze(['within', 'beyond'])
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** @param {any} timing @param {string} path */
export function validateTiming(timing, path) {
  if (timing === null || timing === undefined) return
  object(timing, path, ['eventDate', 'referenceDate', 'windowDays', 'relation'])
  for (const key of ['eventDate', 'referenceDate']) check(timing[key] === null || (typeof timing[key] === 'string' && DATE.test(timing[key]) && Number.isFinite(Date.parse(`${timing[key]}T00:00:00Z`))), `${path}.${key}`, 'expected null or a YYYY-MM-DD date')
  check(timing.windowDays === null || (Number.isSafeInteger(timing.windowDays) && timing.windowDays >= 0 && timing.windowDays <= 36500), `${path}.windowDays`, 'expected null or whole days')
  oneOf(timing.relation, TIMING_RELATIONS, `${path}.relation`)
}

/** @param {any} criterion @param {string} path */
export function validateCriterionLogic(criterion, path) {
  if (criterion.missingFact !== undefined) check(typeof criterion.missingFact === 'string' && criterion.missingFact.length <= 300, `${path}.missingFact`, 'expected text of at most 300 characters')
  validateTiming(criterion.timing, `${path}.timing`)
  if (criterion.rule !== undefined && criterion.rule !== null) {
    object(criterion.rule, `${path}.rule`, ['kind', 'count'])
    oneOf(criterion.rule.kind, CRITERION_RULES, `${path}.rule.kind`)
    if (criterion.rule.kind === 'atLeast') check(Number.isSafeInteger(criterion.rule.count) && criterion.rule.count >= 1, `${path}.rule.count`, 'expected a whole number of parts')
    else check(criterion.rule.count === null || criterion.rule.count === undefined, `${path}.rule.count`, 'only atLeast takes a count')
  }
  if (criterion.parts !== undefined) array(criterion.parts, `${path}.parts`, (part, partPath) => {
    object(part, partPath, ['text', 'verdict', 'basis', 'evidenceIds', 'timing'])
    text(part.text, `${partPath}.text`)
    check(part.text.length <= 500, `${partPath}.text`, 'expected at most 500 characters')
    oneOf(part.verdict, CRITERION_VERDICTS, `${partPath}.verdict`)
    oneOf(part.basis, CRITERION_BASES, `${partPath}.basis`)
    strings(part.evidenceIds, `${partPath}.evidenceIds`)
    validateTiming(part.timing, `${partPath}.timing`)
  })
}

/**
 * The verdict a timing implies for the statement "the event happened within (or beyond) `windowDays` before the reference date", or
 * null when a date or the window is missing or the event lies after the reference date.
 * @param {any} timing
 * @returns {'satisfied' | 'not-satisfied' | null}
 */
export function timingVerdict(timing) {
  if (!timing || !timing.eventDate || !timing.referenceDate || !Number.isSafeInteger(timing.windowDays)) return null
  const days = Math.round((Date.parse(`${timing.referenceDate}T00:00:00Z`) - Date.parse(`${timing.eventDate}T00:00:00Z`)) / 86_400_000)
  if (!Number.isFinite(days) || days < 0) return null
  const within = days <= timing.windowDays
  return (timing.relation === 'beyond' ? !within : within) ? 'satisfied' : 'not-satisfied'
}

/**
 * The verdict of a criterion from its parts and rule, and from its timing; `derived` is false when neither applies and the model's
 * verdict stands. Parts that are not applicable do not count.
 * @param {any} criterion
 * @returns {{ verdict: string, derived: boolean, parts: any[] | undefined }}
 */
export function deriveCriterionVerdict(criterion) {
  const parts = Array.isArray(criterion.parts) ? criterion.parts.map((part) => {
    const timed = timingVerdict(part.timing)
    return timed && timed !== part.verdict ? { ...part, verdict: timed } : part
  }) : undefined
  const counted = (parts ?? []).filter((part) => part.verdict !== 'not-applicable')
  const rule = criterion.rule
  if (rule && counted.length) {
    const satisfied = counted.filter((part) => part.verdict === 'satisfied').length
    const unsatisfied = counted.filter((part) => part.verdict === 'not-satisfied').length
    const unknown = counted.length - satisfied - unsatisfied
    let verdict
    if (rule.kind === 'all') verdict = unsatisfied ? 'not-satisfied' : unknown ? 'unknown' : 'satisfied'
    else if (rule.kind === 'any') verdict = satisfied ? 'satisfied' : unknown ? 'unknown' : 'not-satisfied'
    else verdict = satisfied >= rule.count ? 'satisfied' : satisfied + unknown < rule.count ? 'not-satisfied' : 'unknown'
    return { verdict, derived: true, parts }
  }
  const timed = timingVerdict(criterion.timing)
  if (timed) return { verdict: timed, derived: true, parts }
  return { verdict: criterion.verdict, derived: false, parts }
}
