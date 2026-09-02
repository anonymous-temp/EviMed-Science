/**
 * The `appraisal-table` contract: what an appraisal of a body of evidence has
 * to make checkable.
 *
 * Hidden knowledge: appraisal is not synthesis, and the failure modes are not
 * the ones `clinical-evidence-report` was built against. A synthesis run is
 * judged on whether it went and found the literature; an appraisal run is
 * handed the studies and judged on what it says about them. So the rules here
 * are about a table rather than about retrieval — one row per study, a rating
 * from a fixed vocabulary in every cell, and a rolled-up certainty that follows
 * from the rows above it rather than from the author's impression of them.
 *
 * The one genuinely decidable thing in an appraisal is the arithmetic. GRADE's
 * ladder is four rungs and the moves are integers: a randomized body starts at
 * `high`, an observational one at `low`, each downgrade step drops one rung and
 * each upgrade step raises one. A table whose stated certainty does not equal
 * its own starting point minus its own downgrades is wrong in a way nobody can
 * see by reading it — the rungs are far apart in judgement and adjacent in
 * prose. Everything else an appraisal contains (whether a bias judgement is
 * right, whether the appraisal is fair to a study the author dislikes) is
 * language and belongs to the model; it lives in
 * `capabilities/evidence-appraisal/SKILL.md`.
 *
 * ## Severity
 *
 * Every finding this module raises is `advisory`, and `advisory()` is the only
 * constructor in the file so that stays true by construction rather than by
 * discipline. The blocking budget is six system-wide and it is spent; a check
 * that has never seen a real distribution may not become the seventh. Blocking
 * for this kind therefore remains exactly where it already was — the capability
 * manifest's `requiredOutputsExist`, applied by the registry's own
 * `requiredOutputIssues` — and adding this module changes no verdict from ok to
 * not-ok. The metrics below are how the distribution gets collected; when the
 * shape of real failures is known, the checks that earn it can be promoted from
 * data rather than from how bad the failure sounds.
 *
 * ## Wiring (the registry owns these lines, not this file)
 *
 * This exports findings, not a `GateVerdict`, so it composes with the default
 * validator instead of replacing it:
 *
 *   'appraisal-table': (input) => {
 *     const base = validateReportShaped(input, proseFilesOf(input))
 *     const found = appraisalTableFindings(input)
 *     // Advisory-only by construction, so `ok` and `errorCode` carry over.
 *     return { ...base, issues: [...base.issues, ...found.issues], metrics: { ...base.metrics, ...found.metrics } }
 *   }
 *
 * Returning a whole verdict instead would mean carrying this module's own copy
 * of `requiredOutputIssues` and `proseHygieneIssues`, because the registry keeps
 * both private — and a second copy of the prose-hygiene rules is the shape of
 * the drift that cost three finished packages in production and that
 * `clinicalEvidenceSingleImplementation.test.mjs` now exists to stop. Dropping
 * them instead is worse: the manifest's required-output check would stop running
 * for this kind, which is the only place it blocks. So the composition stands
 * until the registry exports the two helpers. Wiring this function directly as
 * the validator would leave `ok` undefined, which reads as a rejection with no
 * error code.
 *
 * and these eleven check ids belong on `GATE_CHECK_IDS`, which is the one axis a
 * false-positive distribution is computed along:
 *
 *   'appraisal-json-parse', 'appraisal-document-shape', 'appraisal-study-identifier',
 *   'appraisal-study-design', 'appraisal-domain-rating', 'appraisal-study-coverage',
 *   'appraisal-body-certainty', 'appraisal-downgrade-domain',
 *   'appraisal-certainty-arithmetic', 'appraisal-citation-coverage',
 *   'appraisal-table-rendered'
 *
 * ## One more thing the registry owns
 *
 * `appraisal-table` is not in `CLINICAL_CONTRACT_KINDS`, so the shared
 * `proseHygieneIssues` rejects any appraisal whose prose names a trigger entity
 * with `clinical_content_without_clinical_contract` — advice no appraisal of
 * that medicine's trials can act on, because removing the medicine removes the
 * deliverable. It is the same defect `geo-content-pack` was fixed for. If the
 * kind is moved into `CLINICAL_CONTRACT_KINDS` to close it, the registry must
 * apply `evaluateClinicalSafetyRules` to this kind in the same change: a kind
 * that calls itself clinical and enforces nothing is a label.
 *
 * The vocabularies are deliberately module-local. They are the same words
 * SKILL.md teaches, and a run that reads them out of an export would be reading
 * the checker rather than the instructions — which is the one way to pass this
 * gate that produces a worse table.
 */

/**
 * @typedef {object} AppraisalIssue
 * @property {string} code
 * @property {string} message
 * @property {'required'|'advisory'|'optional'} severity
 * @property {string} [path]
 * @property {string} [check]
 */

/** Study designs, closed. `other` exists so an unusual design is named rather
 *  than mislabelled as the nearest familiar one, and it costs a `designNote`. */
const STUDY_DESIGNS = Object.freeze([
  'systematic-review',
  'randomized-controlled-trial',
  'non-randomized-interventional',
  'prospective-cohort',
  'retrospective-cohort',
  'case-control',
  'cross-sectional',
  'case-series',
  'case-report',
  'diagnostic-accuracy',
  'modelling-study',
  'guideline',
  'other',
])

/**
 * Designs that make a body observational, which is what decides where its
 * certainty starts. `systematic-review` is absent on purpose: a review can be
 * of trials or of cohorts, and the design of a review says nothing about the
 * design of what is in it.
 */
const OBSERVATIONAL_DESIGNS = Object.freeze([
  'prospective-cohort',
  'retrospective-cohort',
  'case-control',
  'cross-sectional',
  'case-series',
  'case-report',
])

/**
 * Concern levels for one domain of one study.
 *
 * Ours, not RoB 2's and not ROBINS-I's, and the difference is the point: this
 * capability appraises without claiming to be a certified run of either
 * instrument, and borrowing an instrument's level names would make that claim
 * silently. A run that did apply a named instrument records the instrument and
 * its own verbatim level alongside, never converted into these words.
 */
const DOMAIN_RATINGS = Object.freeze(['low', 'moderate', 'serious', 'critical', 'unclear'])

/** The domains a single study can be rated on. The other two GRADE domains are
 *  properties of a set of studies and cannot be assessed one row at a time. */
const STUDY_DOMAINS = Object.freeze(['riskOfBias', 'indirectness', 'imprecision'])

/** What a body of evidence may be downgraded for. */
const DOWNGRADE_DOMAINS = Object.freeze([
  'riskOfBias',
  'inconsistency',
  'indirectness',
  'imprecision',
  'publicationBias',
])

/** What an observational body may be upgraded for. */
const UPGRADE_DOMAINS = Object.freeze([
  'largeEffect',
  'doseResponse',
  'plausibleConfoundingReducesEffect',
])

/** The certainty ladder, lowest rung first — the index is the arithmetic. */
const CERTAINTY_LADDER = Object.freeze(['very-low', 'low', 'moderate', 'high'])

/** Where a body may start before any domain is applied. */
const STARTING_CERTAINTY = Object.freeze(['high', 'low'])

/**
 * Identifier formats. Format checks over closed shapes, never over language:
 * whether a DOI is well formed is decidable, whether a study is well chosen is
 * not.
 * @type {readonly [string, RegExp][]}
 */
const IDENTIFIER_PATTERNS = Object.freeze([
  ['doi', /^10\.\d{4,9}\/\S+$/],
  ['pmid', /^\d{1,8}$/],
  ['pmcid', /^PMC\d{4,10}$/i],
  ['nct', /^NCT\d{8}$/i],
  ['isrctn', /^ISRCTN\d{8}$/i],
  ['url', /^https?:\/\/\S+$/i],
])

const IDENTIFIER_TYPES = Object.freeze(IDENTIFIER_PATTERNS.map(([type]) => type))

/**
 * The same object shape the contract registry's own `issue()` builds, with the
 * severity fixed. See the severity note in the module header: the constructor
 * is the enforcement.
 * @param {string} code @param {string} message
 * @param {{ path?: string, check: string }} extra
 * @returns {AppraisalIssue}
 */
function advisory(code, message, extra) {
  return {
    code,
    message,
    severity: 'advisory',
    ...(extra.path ? { path: extra.path } : {}),
    check: extra.check,
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string} */
function trimmed(value) {
  return String(value ?? '').trim()
}

/**
 * `runGate` hands every validator a Map, but this function is also the thing a
 * test or a repair loop calls on its own, and being unable to ask it a question
 * without building a Map first is friction with no upside.
 * @param {any} input @param {string} path @returns {string}
 */
function fileText(input, path) {
  const files = input?.files
  if (files instanceof Map) return String(files.get(path) ?? '')
  if (isRecord(files)) return String(files[path] ?? '')
  return ''
}

/**
 * Parsed deliverable JSON, with the three outcomes kept apart: absent, present
 * and unparseable, present and parsed. Collapsing the first two is how a
 * missing file gets reported as a schema problem.
 * @param {any} input @param {string} path
 * @returns {{ state: 'absent'|'unparseable'|'parsed', value: any }}
 */
function parsedJson(input, path) {
  const raw = fileText(input, path)
  if (!raw.trim()) return { state: 'absent', value: null }
  try {
    return { state: 'parsed', value: JSON.parse(raw) }
  } catch {
    return { state: 'unparseable', value: null }
  }
}

/**
 * A DOI written the way a reference manager exports it. Only the two forms that
 * are unambiguously a prefix on the same identifier are stripped; anything
 * further would be guessing at what the run meant.
 * @param {string} type @param {string} value @returns {string}
 */
function bareIdentifier(type, value) {
  if (type !== 'doi') return value
  return value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
}

/**
 * Every finding this contract can raise about an appraisal, plus the numbers a
 * later blocking decision would have to be argued from.
 *
 * Pure: it reads the deliverable it is handed and nothing else. It never looks
 * at the request — a contract binds the deliverable, and an appraisal that
 * matched the brief's wording while contradicting its own table would pass an
 * input-side check and fail a reader.
 *
 * @param {{ files: Map<string, string> | Record<string, string> }} input
 * @returns {{ issues: AppraisalIssue[], metrics: Record<string, unknown> }}
 */
export function appraisalTableFindings(input) {
  /** @type {AppraisalIssue[]} */
  const issues = []
  const parsed = parsedJson(input, 'appraisal-table.json')

  if (parsed.state === 'unparseable') {
    // Reported alone. A syntax error is one problem, and the twenty schema
    // complaints that follow from reading `null` as a table are twenty ways of
    // saying the same thing to a run whose repair attempts are counted.
    return {
      issues: [advisory(
        'appraisal_table_unparseable',
        'appraisal-table.json is not valid JSON, so no row in it could be read. Fix the syntax first: a value containing a double quote must escape it (\\"), and every string must close before the next key.',
        { path: 'appraisal-table.json', check: 'appraisal-json-parse' },
      )],
      metrics: { appraisalStudies: 0, appraisalBodies: 0 },
    }
  }

  const table = isRecord(parsed.value) ? parsed.value : null
  const studies = table && Array.isArray(table.studies) ? table.studies : []
  const bodies = table && Array.isArray(table.bodies) ? table.bodies : []

  if (parsed.state === 'absent') {
    // The manifest's `requiredOutputsExist` is what blocks on this file; saying
    // it again here would report one absent file as two problems.
    return { issues, metrics: { appraisalStudies: 0, appraisalBodies: 0 } }
  }
  if (!table) {
    issues.push(advisory(
      'appraisal_table_shape',
      'appraisal-table.json must be an object with studies[] and bodies[].',
      { path: 'appraisal-table.json', check: 'appraisal-document-shape' },
    ))
  } else {
    if (!studies.length) {
      issues.push(advisory(
        'appraisal_table_empty',
        'appraisal-table.json lists no studies. An appraisal starts from the studies it was given; if none of them could be appraised, list them with appraised: false and the reason.',
        { path: 'appraisal-table.json', check: 'appraisal-document-shape' },
      ))
    }
    if (!bodies.length) {
      issues.push(advisory(
        'appraisal_no_rolled_up_judgement',
        'appraisal-table.json contains no bodies[]. Per-study ratings are the working, not the answer; without one rolled-up certainty per outcome the reader is left to combine the rows themselves, which is the judgement they asked for.',
        { path: 'appraisal-table.json', check: 'appraisal-document-shape' },
      ))
    }
    // Indirectness is a distance, and a distance needs both ends. Every
    // per-study indirectness rating in the table is unreadable — not merely
    // unverifiable — when the question it was measured against is not written
    // down anywhere a later reader can find it.
    if (!trimmed(table.question)) {
      issues.push(advisory(
        'appraisal_question_missing',
        'appraisal-table.json states no question. Indirectness is rated as the distance between what was studied and what is being asked; with the question absent, every indirectness cell in the table means nothing.',
        { path: 'appraisal-table.json', check: 'appraisal-document-shape' },
      ))
    }
  }

  /** @type {Map<string, any>} */
  const byId = new Map()
  /** @type {string[]} */
  const identifierValues = []
  /** @type {string[]} */
  const designs = []
  /** @type {string[]} */
  const instruments = []
  let notAppraised = 0

  studies.forEach((/** @type {any} */ study, /** @type {number} */ index) => {
    const where = `studies[${index}]`
    if (!isRecord(study)) {
      issues.push(advisory('appraisal_study_shape', `${where} must be an object.`, { path: 'appraisal-table.json', check: 'appraisal-document-shape' }))
      return
    }
    const id = trimmed(study.id)
    const label = id || where
    if (!id) {
      issues.push(advisory(
        'appraisal_study_unlabelled',
        `${where} has no id. Every row needs one, because the certainty judgement, the rendered table and the citation ledger all refer to a study by it.`,
        { path: 'appraisal-table.json', check: 'appraisal-study-coverage' },
      ))
    } else if (byId.has(id)) {
      issues.push(advisory(
        'appraisal_study_duplicate_id',
        `study id "${id}" is used twice. Two rows under one id make the body that cites it ambiguous.`,
        { path: 'appraisal-table.json', check: 'appraisal-study-coverage' },
      ))
    } else {
      byId.set(id, study)
    }

    // A study the researcher named and the run could not appraise. It stays in
    // the table on purpose: the alternative is that it disappears, and a study
    // that quietly left the appraisal is the one failure the person who handed
    // it over cannot see.
    if (study.appraised === false) {
      notAppraised += 1
      if (!trimmed(study.notAppraisedReason)) {
        issues.push(advisory(
          'appraisal_study_dropped_without_reason',
          `${label} is marked appraised: false with no notAppraisedReason. Say what stopped it — no full text, wrong population, retracted — or the reader cannot tell a judgement from an omission.`,
          { path: 'appraisal-table.json', check: 'appraisal-study-coverage' },
        ))
      }
    }

    const identifier = isRecord(study.identifier) ? study.identifier : null
    const identifierType = trimmed(identifier?.type).toLowerCase()
    const identifierValue = bareIdentifier(identifierType, trimmed(identifier?.value))
    if (!identifier || !identifierType || !identifierValue) {
      issues.push(advisory(
        'appraisal_study_identifier_missing',
        `${label} carries no identifier. Give it {type, value} with type one of ${IDENTIFIER_TYPES.join(' / ')} — a row nobody can resolve to a specific paper is a row nobody can check.`,
        { path: 'appraisal-table.json', check: 'appraisal-study-identifier' },
      ))
    } else {
      const pattern = IDENTIFIER_PATTERNS.find(([type]) => type === identifierType)?.[1]
      if (!pattern) {
        issues.push(advisory(
          'appraisal_study_identifier_type',
          `${label} declares identifier type "${identifierType}", which is not one of ${IDENTIFIER_TYPES.join(' / ')}.`,
          { path: 'appraisal-table.json', check: 'appraisal-study-identifier' },
        ))
      } else if (!pattern.test(identifierValue)) {
        issues.push(advisory(
          'appraisal_study_identifier_malformed',
          `${label}: "${identifierValue}" is not a well-formed ${identifierType}.`,
          { path: 'appraisal-table.json', check: 'appraisal-study-identifier' },
        ))
      } else {
        identifierValues.push(identifierValue)
      }
    }

    const design = trimmed(study.design)
    if (!STUDY_DESIGNS.includes(design)) {
      issues.push(advisory(
        'appraisal_study_design_unknown',
        `${label} declares design "${design || '(none)'}", which is not one of ${STUDY_DESIGNS.join(' / ')}. Design is the first thing a reader checks a bias judgement against, so it is a fixed word rather than a description.`,
        { path: 'appraisal-table.json', check: 'appraisal-study-design' },
      ))
    } else {
      designs.push(design)
      // `other` is an honest answer and a free pass at the same time unless it
      // costs a sentence. The note is what keeps it from being the cheapest
      // cell to fill.
      if (design === 'other' && !trimmed(study.designNote)) {
        issues.push(advisory(
          'appraisal_study_design_unexplained',
          `${label} is design "other" with no designNote. Say what it actually is.`,
          { path: 'appraisal-table.json', check: 'appraisal-study-design' },
        ))
      }
    }

    if (study.appraised === false) return

    const domains = isRecord(study.domains) ? study.domains : {}
    for (const domain of STUDY_DOMAINS) {
      const cell = isRecord(domains[domain]) ? domains[domain] : null
      if (!cell) {
        issues.push(advisory(
          'appraisal_domain_missing',
          `${label} has no ${domain} rating. Every appraised study is rated on all three of ${STUDY_DOMAINS.join(', ')}; an unrated domain reads as "no concern" and is usually "not looked at".`,
          { path: 'appraisal-table.json', check: 'appraisal-domain-rating' },
        ))
        continue
      }
      const rating = trimmed(cell.rating)
      if (!DOMAIN_RATINGS.includes(rating)) {
        issues.push(advisory(
          'appraisal_domain_rating_unknown',
          `${label} rates ${domain} as "${rating || '(none)'}", which is not one of ${DOMAIN_RATINGS.join(' / ')}.`,
          { path: 'appraisal-table.json', check: 'appraisal-domain-rating' },
        ))
      }
      if (!trimmed(cell.reason)) {
        issues.push(advisory(
          'appraisal_domain_reason_missing',
          `${label} rates ${domain} without a reason. A rating with no reason cannot be disagreed with, which is the only thing an appraisal is for.`,
          { path: 'appraisal-table.json', check: 'appraisal-domain-rating' },
        ))
      }
      // An instrument's own level is preserved verbatim or not recorded at all.
      // Half a record — a level with no instrument — is the shape a converted
      // rating takes, and conversion between appraisal systems is the thing
      // this platform refuses to do anywhere.
      const instrument = trimmed(cell.instrument)
      const instrumentRating = trimmed(cell.instrumentRating)
      if (instrument && !instrumentRating) {
        issues.push(advisory(
          'appraisal_instrument_unrated',
          `${label} names ${instrument} for ${domain} but records no instrumentRating. Naming an instrument is a promise that it was applied.`,
          { path: 'appraisal-table.json', check: 'appraisal-domain-rating' },
        ))
      }
      if (!instrument && instrumentRating) {
        issues.push(advisory(
          'appraisal_instrument_unnamed',
          `${label} records instrumentRating "${instrumentRating}" for ${domain} with no instrument. A level with no scale behind it cannot be read back.`,
          { path: 'appraisal-table.json', check: 'appraisal-domain-rating' },
        ))
      }
      if (instrument) instruments.push(instrument)
    }
  })

  /** @type {Record<string, number>} */
  const certaintyMix = { high: 0, moderate: 0, low: 0, 'very-low': 0, unrated: 0 }
  const citedStudyIds = new Set()
  let arithmeticMismatches = 0

  bodies.forEach((/** @type {any} */ body, /** @type {number} */ index) => {
    const where = `bodies[${index}]`
    if (!isRecord(body)) {
      issues.push(advisory('appraisal_body_shape', `${where} must be an object.`, { path: 'appraisal-table.json', check: 'appraisal-document-shape' }))
      certaintyMix.unrated += 1
      return
    }
    const outcome = trimmed(body.outcome)
    const label = outcome ? `${where} (${outcome})` : where
    if (!outcome) {
      issues.push(advisory(
        'appraisal_body_outcome_missing',
        `${where} names no outcome. Certainty is a judgement about one outcome; a body with no outcome is a certainty about nothing in particular.`,
        { path: 'appraisal-table.json', check: 'appraisal-body-certainty' },
      ))
    }

    const members = Array.isArray(body.studies) ? body.studies.map((/** @type {any} */ value) => trimmed(value)) : []
    if (!members.length) {
      issues.push(advisory(
        'appraisal_body_empty',
        `${label} cites no studies. The rolled-up judgement has to say which rows it rolled up.`,
        { path: 'appraisal-table.json', check: 'appraisal-study-coverage' },
      ))
    }
    const unresolved = members.filter((/** @type {string} */ id) => id && !byId.has(id))
    if (unresolved.length) {
      issues.push(advisory(
        'appraisal_body_unresolved_study',
        `${label} cites ${unresolved.slice(0, 5).join(', ')}, which ${unresolved.length === 1 ? 'is not a row' : 'are not rows'} in studies[].`,
        { path: 'appraisal-table.json', check: 'appraisal-study-coverage' },
      ))
    }
    for (const id of members) citedStudyIds.add(id)

    const certainty = trimmed(body.certainty)
    if (!CERTAINTY_LADDER.includes(certainty)) {
      issues.push(advisory(
        'appraisal_certainty_unknown',
        `${label} states certainty "${certainty || '(none)'}", which is not one of ${CERTAINTY_LADDER.join(' / ')}.`,
        { path: 'appraisal-table.json', check: 'appraisal-body-certainty' },
      ))
      certaintyMix.unrated += 1
    } else {
      certaintyMix[certainty] += 1
    }

    const start = trimmed(body.startingCertainty)
    if (!STARTING_CERTAINTY.includes(start)) {
      issues.push(advisory(
        'appraisal_starting_certainty_unknown',
        `${label} states startingCertainty "${start || '(none)'}", which is not one of ${STARTING_CERTAINTY.join(' / ')}. Where the body started is what makes every downgrade below it readable as a step rather than an opinion.`,
        { path: 'appraisal-table.json', check: 'appraisal-body-certainty' },
      ))
    }

    /** @param {string} field @param {readonly string[]} vocabulary @returns {number} */
    const stepsOf = (field, vocabulary) => {
      const entries = Array.isArray(body[field]) ? body[field] : []
      let total = 0
      entries.forEach((/** @type {any} */ entry, /** @type {number} */ position) => {
        const at = `${label} ${field}[${position}]`
        if (!isRecord(entry)) {
          issues.push(advisory('appraisal_step_shape', `${at} must be an object.`, { path: 'appraisal-table.json', check: 'appraisal-downgrade-domain' }))
          return
        }
        const domain = trimmed(entry.domain)
        if (!vocabulary.includes(domain)) {
          issues.push(advisory(
            'appraisal_step_domain_unknown',
            `${at} names domain "${domain || '(none)'}", which is not one of ${vocabulary.join(' / ')}. A move on the ladder that names no domain is a move nobody can argue with.`,
            { path: 'appraisal-table.json', check: 'appraisal-downgrade-domain' },
          ))
        }
        const steps = Number(entry.steps)
        if (!Number.isInteger(steps) || steps < 0 || steps > 3) {
          issues.push(advisory(
            'appraisal_step_size_invalid',
            `${at} has steps "${String(entry.steps)}". Use an integer from 0 to 3 — 0 records a concern that was noted and not acted on, which is a real GRADE outcome and not the same as no concern.`,
            { path: 'appraisal-table.json', check: 'appraisal-downgrade-domain' },
          ))
        } else {
          total += steps
        }
        if (!trimmed(entry.reason)) {
          issues.push(advisory(
            'appraisal_step_reason_missing',
            `${at} gives no reason. The reason is the whole content of the move; the number is only its size.`,
            { path: 'appraisal-table.json', check: 'appraisal-downgrade-domain' },
          ))
        }
      })
      return total
    }

    const down = stepsOf('downgrades', DOWNGRADE_DOMAINS)
    const up = stepsOf('upgrades', UPGRADE_DOMAINS)

    // The arithmetic. Everything above checks that a field was filled in; this
    // is the one check that can find a table where every field is filled in and
    // the answer is still wrong, because it recomputes the result from the
    // run's own inputs instead of reading its conclusion.
    if (CERTAINTY_LADDER.includes(certainty) && STARTING_CERTAINTY.includes(start)) {
      const from = CERTAINTY_LADDER.indexOf(start)
      const expectedIndex = Math.min(CERTAINTY_LADDER.length - 1, Math.max(0, from - down + up))
      const expected = CERTAINTY_LADDER[expectedIndex]
      if (expected !== certainty) {
        arithmeticMismatches += 1
        issues.push(advisory(
          'appraisal_certainty_does_not_follow',
          `${label} starts at ${start}, takes ${down} downgrade step(s) and ${up} upgrade step(s), which lands on ${expected} — but states ${certainty}. Either the steps or the conclusion is wrong; a reader checking the table will find this in one subtraction.`,
          { path: 'appraisal-table.json', check: 'appraisal-certainty-arithmetic' },
        ))
      }
    }

    // Where a body starts is decided by the designs in it, and both directions
    // are worth saying: an all-observational body starting at `high` skips the
    // step GRADE exists to impose, and an all-randomized body starting at `low`
    // buries a real downgrade inside the starting point where no domain has to
    // account for it.
    const memberDesigns = members
      .map((/** @type {string} */ id) => trimmed(byId.get(id)?.design))
      .filter(Boolean)
    if (memberDesigns.length && start === 'high' && memberDesigns.every((/** @type {string} */ design) => OBSERVATIONAL_DESIGNS.includes(design))) {
      issues.push(advisory(
        'appraisal_starting_certainty_high_for_observational',
        `${label} starts at high, but every study in it is observational (${[...new Set(memberDesigns)].join(', ')}). An observational body starts at low, and is raised again only by a named upgrade domain.`,
        { path: 'appraisal-table.json', check: 'appraisal-certainty-arithmetic' },
      ))
    }
    if (memberDesigns.length && start === 'low' && memberDesigns.every((/** @type {string} */ design) => design === 'randomized-controlled-trial')) {
      issues.push(advisory(
        'appraisal_starting_certainty_low_for_randomized',
        `${label} starts at low, but every study in it is a randomized controlled trial. A randomized body starts at high; if it deserves less, take the step in the domain that earns it so the reason is on the record.`,
        { path: 'appraisal-table.json', check: 'appraisal-certainty-arithmetic' },
      ))
    }
    if (up > 0 && start === 'high') {
      issues.push(advisory(
        'appraisal_upgrade_from_high',
        `${label} starts at high and still applies ${up} upgrade step(s). The upgrade domains exist to lift an observational body; from high there is nowhere to go, so the step changes nothing and hides whatever it was meant to say.`,
        { path: 'appraisal-table.json', check: 'appraisal-certainty-arithmetic' },
      ))
    }

    if (!trimmed(body.whatWouldChange)) {
      issues.push(advisory(
        'appraisal_body_no_falsifier',
        `${label} does not say what would change it. A certainty judgement that names no study, no result and no analysis capable of moving it is one the next reader has to redo from the beginning.`,
        { path: 'appraisal-table.json', check: 'appraisal-body-certainty' },
      ))
    }
  })

  // An appraised study that no body rolled up. It was read, rated, and then left
  // out of every conclusion — which is indistinguishable, on the page, from
  // having been excluded for a reason.
  const orphaned = [...byId.entries()]
    .filter(([id, study]) => study.appraised !== false && !citedStudyIds.has(id))
    .map(([id]) => id)
  if (bodies.length && orphaned.length) {
    issues.push(advisory(
      'appraisal_study_not_rolled_up',
      `${orphaned.length} appraised study/studies are in no body: ${orphaned.slice(0, 5).join(', ')}. Put each one under the outcome it speaks to, or mark it appraised: false with the reason it does not.`,
      { path: 'appraisal-table.json', check: 'appraisal-study-coverage' },
    ))
  }

  // Coverage by identifier and by id, never by reading the prose. The rendered
  // table and the ledger are separate files and drift from the JSON silently;
  // `includes` is enough because both are asked for a string the run itself
  // wrote into appraisal-table.json.
  const ledger = fileText(input, 'citation-ledger.csv')
  if (ledger.trim() && identifierValues.length) {
    const missing = identifierValues.filter((value) => !ledger.includes(value))
    if (missing.length) {
      issues.push(advisory(
        'appraisal_citation_not_in_ledger',
        `${missing.length} appraised study/studies are absent from citation-ledger.csv: ${missing.slice(0, 5).join(', ')}. The ledger is where a reader goes to get from a row to the paper.`,
        { path: 'citation-ledger.csv', check: 'appraisal-citation-coverage' },
      ))
    }
  }

  const rendered = fileText(input, 'appraisal-table.csv')
  if (rendered.trim() && byId.size) {
    const missing = [...byId.keys()].filter((id) => !rendered.includes(id))
    if (missing.length) {
      issues.push(advisory(
        'appraisal_row_not_rendered',
        `${missing.length} study/studies in appraisal-table.json have no row in appraisal-table.csv: ${missing.slice(0, 5).join(', ')}. The CSV is the copy a reviewer actually reads, so a row missing there is a row that was never delivered.`,
        { path: 'appraisal-table.csv', check: 'appraisal-table-rendered' },
      ))
    }
  }

  return {
    issues,
    metrics: {
      appraisalStudies: studies.length,
      appraisalStudiesNotAppraised: notAppraised,
      appraisalBodies: bodies.length,
      appraisalDesigns: [...new Set(designs)].sort(),
      appraisalInstruments: [...new Set(instruments)].sort(),
      appraisalCertaintyMix: certaintyMix,
      // The number a promotion argument would be made from: how often a
      // finished table's own conclusion disagrees with its own steps.
      appraisalCertaintyArithmeticMismatches: arithmeticMismatches,
    },
  }
}
