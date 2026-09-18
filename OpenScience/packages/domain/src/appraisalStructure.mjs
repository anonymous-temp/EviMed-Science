/**
 * Structured appraisal on an evidence-matrix claim: the PICO the claim
 * measured, the GRADE certainty of its outcome taken apart into GRADE's own
 * parts, and the risk of bias of its source by a named instrument.
 *
 * Hidden knowledge: until this module nothing in the platform recomputed an
 * appraisal and everything declared one (review appendix E §7.4–§7.5). GRADE
 * lived in report prose — 「按 GRADE 评为低确定性」 — where a level two rungs
 * away from its own reasons reads exactly like a level that follows from them,
 * and the only checks were prose patterns. The arithmetic of GRADE is not
 * language: a start, five integer moves down and three up, clamped to four
 * rungs. So the model makes every judgement — which domain is serious and why,
 * which instrument, how each of its domains came out — and records it in parts;
 * code recomputes the level from the parts and says when the stated level
 * disagrees. Principle 1: the model judges, code re-verifies the checkable
 * half.
 *
 * Everything here is optional and advisory. An absent field raises nothing, a
 * malformed one raises a notice that says exactly what it expected, and a
 * disagreement raises a notice. None of it withholds a package or unverifies a
 * claim — owner decision 5 (2026-09-18, 「不要过度门禁和安全拦截」) and
 * principle 4 (the blocking budget is spent). The notices exist so the run can
 * fix its own table while it still can, and so a reader sees when a label and
 * its parts disagree.
 *
 * Lenient wherever leniency costs nothing. The shape the skill taught before
 * this module, `pico: {population, intervention, outcome}`, is read as it
 * stands (one outcome): every clinical package since has carried it, and a
 * notice on each of them would be noise about a shape we asked for. GRADE's own
 * words (`serious`, `very serious`) are read beside the numbers, because that is
 * how a summary-of-findings table writes them. A certainty given as a bare level
 * is a stated level with no parts — shown, never recomputed, never reproached.
 *
 * The check ids these findings are recorded under are declared by the clinical
 * validator that runs them (`auditClaimAppraisal` in `clinicalEvidence.mjs`),
 * where every clinical check declares its id; this module returns findings
 * grouped by what they are about and knows nothing about the gate. The reader
 * draws its badge from `claimAppraisal`, the same analysis the gate checks with,
 * so the note a reader sees and the notice the run was given cannot disagree.
 *
 * Build to delete: a model that keeps a GRADE ladder and a tool's overall rule
 * straight on its own makes the recomputation redundant; the structured fields
 * stay, because a reader wants the parts either way.
 *
 * @module @evimed/domain/src/appraisalStructure
 */

/** @typedef {'very-low' | 'low' | 'moderate' | 'high'} CertaintyLevel */
/** @typedef {'randomized' | 'observational' | 'unknown'} EvidenceDesign */

/** GRADE's ladder, lowest rung first: the index is the arithmetic. */
export const CERTAINTY_LEVELS = /** @type {readonly CertaintyLevel[]} */ (Object.freeze(['very-low', 'low', 'moderate', 'high']))

/** The badge a reader sees for each rung. */
export const CERTAINTY_LEVEL_LABELS_ZH = /** @type {Readonly<Record<CertaintyLevel, string>>} */ (
  Object.freeze({ high: '高', moderate: '中', low: '低', 'very-low': '极低' })
)

/**
 * The five reasons to rate down, and how far each may go.
 *
 * GRADE Handbook §5.2, table 5.2: every one of the five moves "↓ 1 or 2
 * levels" — publication bias included, so it is not held to one here.
 * Risk of bias alone may take a third step: when a non-randomized body is
 * assessed with ROBINS-I it starts at high, and "three levels for rating down
 * for risk of bias are required so that NRS can arrive at a rating of very low
 * certainty" (GRADE guidelines 18, Schünemann et al., J Clin Epidemiol
 * 2019;111:105–114, PMC6692166).
 * https://gdt.gradepro.org/app/handbook/handbook.html#h.9rdkd7qa9z6r
 */
const DOWNGRADE_LIMITS = Object.freeze({
  riskOfBias: 3,
  inconsistency: 2,
  indirectness: 2,
  imprecision: 2,
  publicationBias: 2,
})

/**
 * The three reasons to rate up, and how far each may go (Handbook §5.3, table
 * 5.3): a large effect one level or two, a dose-response gradient one, and
 * plausible residual confounding that would reduce the effect one.
 */
const UPGRADE_LIMITS = Object.freeze({
  largeEffect: 2,
  doseResponse: 1,
  confounding: 1,
})

/** The spellings a summary-of-findings table uses for a move down, as steps. */
const DOWNGRADE_WORDS = Object.freeze({
  none: 0,
  no: 0,
  'not-serious': 0,
  undetected: 0,
  serious: 1,
  'strongly-suspected': 1,
  'very-serious': 2,
  'extremely-serious': 3,
  'very-very-serious': 3,
})

/** And for a move up. `yes` means one step, which is all two of the three can take. */
const UPGRADE_WORDS = Object.freeze({
  none: 0,
  no: 0,
  yes: 1,
  present: 1,
  large: 1,
  'very-large': 2,
})

/** Where a body may start (Handbook §5.1.1): randomized at high, observational at low. */
const STARTS = Object.freeze(['high', 'low'])

/**
 * Evidence source types (`sourceTypes.mjs`, contract C8) that decide a design.
 * `clinical-trial` is absent on purpose: PubMed's generic "Clinical Trial"
 * covers single-arm and randomized trials alike, and systematic reviews,
 * meta-analyses and guidelines say nothing about what they contain — the same
 * reasoning `appraisalContract.mjs` gives for leaving `systematic-review` out
 * of its observational designs.
 */
const RANDOMIZED_SOURCE_TYPES = Object.freeze(['rct'])
const OBSERVATIONAL_SOURCE_TYPES = Object.freeze(['observational', 'case-report'])

/**
 * Instruments whose overall judgement is a published function of their domain
 * judgements, each on its own scale — never converted into another tool's
 * words, the rule `appraisalContract.mjs` states for the appraisal table.
 * `levels` is best first; `domains` is how many the instrument rates, below
 * which the best overall cannot be claimed (an unrated domain is not a clean
 * one). The overall rules are read from each tool's own guidance:
 *
 *   - RoB 2 — Cochrane Handbook v6.5 ch. 8, table 8.2.b: low only when every
 *     domain is low; high when any is high, "or ... some concerns for multiple
 *     domains in a way that substantially lowers confidence"; otherwise some
 *     concerns. The second route to high is a judgement, so several
 *     some-concerns domains allow either answer.
 *     https://training.cochrane.org/handbook/current/chapter-08
 *   - ROBINS-I — Sterne et al., BMJ 2016;355:i4919, table 2: low / moderate /
 *     serious / critical by the most severe domain; "no information" when there
 *     is "no clear indication that the study is at serious or critical risk of
 *     bias and there is a lack of information in one or more key domains (a
 *     judgement is required for this)". Six domains in V2 (2025 draft), seven
 *     in V1, so six rated counts as complete.
 *   - ROBINS-E — Higgins et al., Environ Int 2024;186:108602, §6: "the default
 *     ... overall risk-of-bias judgement is that for the domain with the
 *     greatest risk of bias", which the user may raise to very high "if they
 *     judge that so many domains were rated as at 'High' risk of bias".
 *   - QUADAS-2 — Whiting et al., Ann Intern Med 2011;155:529–536 and the
 *     background document: "low" on all domains is an overall "low"; "high" or
 *     "unclear" on one or more "may be judged 'at risk of bias'".
 *   - AMSTAR 2 — Shea et al., BMJ 2017;358:j4008, box 1 and box 2: critical
 *     items 2, 4, 7, 9, 11, 13, 15, which the paper says appraisers may change;
 *     more than one critical flaw is critically low, one is low, more than one
 *     non-critical weakness is moderate ("it may be appropriate to move the
 *     overall appraisal down from moderate to low"), otherwise high.
 *
 * @type {Readonly<Record<string, { id: string, name: string, domains: number, levels: readonly string[], overall?: readonly string[], extra?: readonly string[], aliases?: Readonly<Record<string, string>>, rule: string }>>}
 */
const RISK_OF_BIAS_TOOLS = Object.freeze({
  rob2: {
    id: 'rob2',
    name: 'RoB 2',
    domains: 5,
    levels: Object.freeze(['low', 'some-concerns', 'high']),
    aliases: Object.freeze({ some: 'some-concerns', 'some-concern': 'some-concerns' }),
    rule: 'RoB 2 is low only when every domain is low, high when any domain is high, and otherwise some-concerns — or high, when several domains raise some concerns.',
  },
  'robins-i': {
    id: 'robins-i',
    name: 'ROBINS-I',
    domains: 6,
    levels: Object.freeze(['low', 'moderate', 'serious', 'critical']),
    extra: Object.freeze(['no-information']),
    aliases: Object.freeze({ ni: 'no-information', 'no-info': 'no-information' }),
    rule: 'ROBINS-I\'s overall judgement is its most severe domain judgement: low only when every domain is low; no-information when a key domain lacks information and nothing is serious or critical.',
  },
  'robins-e': {
    id: 'robins-e',
    name: 'ROBINS-E',
    domains: 7,
    levels: Object.freeze(['low', 'some-concerns', 'high', 'very-high']),
    aliases: Object.freeze({ some: 'some-concerns', 'some-concern': 'some-concerns' }),
    rule: 'ROBINS-E\'s overall judgement is its most severe domain judgement, or very-high when several domains are high.',
  },
  quadas2: {
    id: 'quadas2',
    name: 'QUADAS-2',
    domains: 4,
    levels: Object.freeze(['low', 'unclear', 'high']),
    rule: 'QUADAS-2 is low only when every domain is low; a domain rated high or unclear puts the study at risk of bias — high, or unclear when no domain is high.',
  },
  amstar2: {
    id: 'amstar2',
    name: 'AMSTAR 2',
    domains: 16,
    levels: Object.freeze(['yes', 'partial-yes', 'no', 'not-applicable']),
    overall: Object.freeze(['high', 'moderate', 'low', 'critically-low']),
    aliases: Object.freeze({ py: 'partial-yes', partial: 'partial-yes', na: 'not-applicable', 'n/a': 'not-applicable' }),
    rule: 'AMSTAR 2: more than one critical flaw is critically-low and one is low; with none, more than one non-critical weakness is moderate (or low), otherwise high. A flaw is an item answered no; the critical items are 2, 4, 7, 9, 11, 13 and 15 — if you treated others as critical, list them in criticalItems.',
  },
})

/** The instruments whose overall judgement is recomputed. */
export const RISK_OF_BIAS_TOOL_IDS = Object.freeze(Object.keys(RISK_OF_BIAS_TOOLS))

/** A tool name as people write it, compacted: 「RoB 2」, 「ROBINS-I」, 「AMSTAR-2」. */
const TOOL_KEYS = Object.freeze({
  rob2: 'rob2',
  rob20: 'rob2',
  cochranerob2: 'rob2',
  robinsi: 'robins-i',
  robinsiv2: 'robins-i',
  robinsi2: 'robins-i',
  robinse: 'robins-e',
  quadas2: 'quadas2',
  amstar2: 'amstar2',
})

/**
 * Which design an instrument implies, for a body whose sources carry no
 * decisive type: RoB 2 and Jadad appraise randomized trials; ROBINS-I,
 * ROBINS-E and Newcastle-Ottawa appraise non-randomized studies.
 * @type {Readonly<Record<string, 'randomized' | 'observational'>>}
 */
const TOOL_DESIGNS = Object.freeze({
  rob2: 'randomized',
  jadad: 'randomized',
  'robins-i': 'observational',
  'robins-e': 'observational',
  nos: 'observational',
  newcastleottawa: 'observational',
})

/** AMSTAR 2's critical items (box 1). */
const AMSTAR2_CRITICAL_ITEMS = Object.freeze([2, 4, 7, 9, 11, 13, 15])

/** The reader's words for each risk-of-bias judgement, on whichever tool's scale it is. */
export const RISK_OF_BIAS_LEVEL_LABELS_ZH = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  low: '低',
  'some-concerns': '存在一定风险',
  moderate: '中等',
  serious: '严重',
  critical: '极严重',
  'no-information': '信息不足',
  high: '高',
  'very-high': '很高',
  unclear: '不清楚',
  'critically-low': '极低',
}))

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {boolean} */
function present(value) {
  return value !== undefined && value !== null
}

/** @param {unknown} value @returns {string} */
function nonEmptyText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** A closed-vocabulary word in one spelling: `Very Serious` → `very-serious`. @param {unknown} value */
function word(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/** @param {unknown} value @returns {string} */
function quoted(value) {
  return JSON.stringify(value === undefined ? null : value)
}

/** @param {Map<string, string> | Record<string, string> | null | undefined} types @param {unknown} path */
function sourceTypeAt(types, path) {
  if (typeof path !== 'string' || !path) return null
  if (types instanceof Map) return types.get(path) ?? null
  if (isRecord(types)) return typeof types[path] === 'string' ? types[path] : null
  return null
}

/**
 * The design a body of evidence has, from the types stamped on the sources it
 * cites: `randomized` when every one is a randomized trial, `observational`
 * when every one is an observational study or a case report, `unknown`
 * otherwise — a mixed body, a review, a source with no stamped type.
 * @param {Iterable<string | null | undefined>} sourceTypes
 * @returns {EvidenceDesign}
 */
export function evidenceDesignOf(sourceTypes) {
  const types = [...sourceTypes]
  if (!types.length || types.some((type) => !type)) return 'unknown'
  if (types.every((type) => RANDOMIZED_SOURCE_TYPES.includes(String(type)))) return 'randomized'
  if (types.every((type) => OBSERVATIONAL_SOURCE_TYPES.includes(String(type)))) return 'observational'
  return 'unknown'
}

/** @param {unknown} value @returns {string} the tool's canonical id, or its compact spelling when it is not one we recompute */
function toolKey(value) {
  const compact = String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return TOOL_KEYS[/** @type {keyof typeof TOOL_KEYS} */ (compact)] ?? compact
}

// ---------------------------------------------------------------- GRADE ---

/**
 * One move read from a certainty entry, as a number of steps.
 * @param {unknown} value @param {number} limit @param {'down' | 'up'} direction
 * @returns {{ steps: number } | { problem: string }}
 */
function readMove(value, limit, direction) {
  if (!present(value)) return { steps: 0 }
  if (direction === 'up' && typeof value === 'boolean') return { steps: value ? 1 : 0 }
  let steps = null
  if (typeof value === 'number') steps = value
  else if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) steps = Number(value)
  else if (typeof value === 'string') {
    const table = direction === 'down' ? DOWNGRADE_WORDS : UPGRADE_WORDS
    const known = table[/** @type {keyof typeof table} */ (word(value))]
    if (known !== undefined) steps = known
  }
  if (steps === null || !Number.isInteger(steps)) {
    return { problem: direction === 'down' ? `a move down is 0, -1 (serious) or -2 (very serious)${limit > 2 ? ', or -3 for risk of bias assessed with ROBINS-I from a high start' : ''}` : `a move up is 0 or 1${limit > 1 ? ', or 2 for a very large effect' : ''}` }
  }
  // Rating down is written with either sign — "-1" and "1" both mean one step
  // down in a domain that can only lower the rating. Rating up cannot be
  // negative: that would be a downgrade filed under an upgrade.
  const magnitude = direction === 'down' ? Math.abs(steps) : steps
  if (magnitude < 0 || magnitude > limit) {
    return { problem: direction === 'down' ? `a move down is at most ${limit} step(s) in this domain` : `a move up is between 0 and ${limit} step(s) in this domain` }
  }
  return { steps: magnitude }
}

/**
 * @typedef {object} CertaintyParts
 * @property {'high' | 'low' | null} start
 * @property {Record<string, number>} down  steps rated down, by domain, nonzero only
 * @property {Record<string, number>} up    steps rated up, by domain, nonzero only
 * @property {CertaintyLevel | null} stated
 * @property {string | null} outcome
 * @property {boolean} computable  every part read, so the level can be recomputed
 * @property {string[]} problems   what could not be read, each a whole sentence
 * @property {string[]} unexplained  domains moved with no rationale
 */

/**
 * One certainty entry read into its parts. `at` names it in the sentences.
 * @param {unknown} value @param {string} at @returns {CertaintyParts}
 */
function readCertainty(value, at) {
  /** @type {CertaintyParts} */
  const parts = { start: null, down: {}, up: {}, stated: null, outcome: null, computable: false, problems: [], unexplained: [] }
  // A bare level is a stated level with no parts: shown, not recomputed.
  if (typeof value === 'string') {
    const level = word(value)
    if (CERTAINTY_LEVELS.includes(/** @type {CertaintyLevel} */ (level))) parts.stated = /** @type {CertaintyLevel} */ (level)
    else parts.problems.push(`${at} is ${quoted(value)}, which is not a certainty level. Give the level as label (high, moderate, low or very-low) inside an object with the parts it follows from: { start, riskOfBias, inconsistency, indirectness, imprecision, publicationBias, upgrades, rationale, label }.`)
    return parts
  }
  if (!isRecord(value)) {
    parts.problems.push(`${at} must be an object: { start: "high" | "low", riskOfBias, inconsistency, indirectness, imprecision, publicationBias, upgrades: { largeEffect, doseResponse, confounding }, rationale, label }.`)
    return parts
  }
  parts.outcome = nonEmptyText(value.outcome) || null

  const start = word(value.start)
  if (STARTS.includes(start)) parts.start = /** @type {'high' | 'low'} */ (start)
  else parts.problems.push(`${at}.start is ${quoted(value.start)}; use "high" (randomized evidence, or non-randomized evidence assessed with ROBINS-I) or "low" (other non-randomized evidence).`)

  let readable = parts.start !== null
  for (const [domain, limit] of Object.entries(DOWNGRADE_LIMITS)) {
    const move = readMove(value[domain], limit, 'down')
    if ('problem' in move) {
      readable = false
      parts.problems.push(`${at}.${domain} is ${quoted(value[domain])}; ${move.problem}.`)
    } else if (move.steps) parts.down[domain] = move.steps
  }
  // Under `upgrades`, which is where the skill puts them; failing that,
  // directly on the entry — a rating that exists is read wherever it is.
  const upgrades = isRecord(value.upgrades) ? value.upgrades : {}
  if (present(value.upgrades) && !isRecord(value.upgrades)) {
    readable = false
    parts.problems.push(`${at}.upgrades must be an object: { largeEffect: 0 | 1 | 2, doseResponse: 0 | 1, confounding: 0 | 1 }.`)
  }
  for (const [domain, limit] of Object.entries(UPGRADE_LIMITS)) {
    const raw = upgrades[domain] ?? value[domain] ?? (domain === 'confounding' ? upgrades.plausibleConfounding ?? value.plausibleConfounding : undefined)
    const move = readMove(raw, limit, 'up')
    if ('problem' in move) {
      readable = false
      parts.problems.push(`${at}.upgrades.${domain} is ${quoted(raw)}; ${move.problem}.`)
    } else if (move.steps) parts.up[domain] = move.steps
  }

  if (present(value.label)) {
    const label = word(value.label)
    if (CERTAINTY_LEVELS.includes(/** @type {CertaintyLevel} */ (label))) parts.stated = /** @type {CertaintyLevel} */ (label)
    else parts.problems.push(`${at}.label is ${quoted(value.label)}; use high, moderate, low or very-low.`)
  }

  // Every step GRADE takes carries its reason: the number is the size of the
  // move, the rationale is its content. One sentence for the whole entry is
  // accepted as covering it.
  const rationale = value.rationale
  if (typeof rationale !== 'string' || !rationale.trim()) {
    const reasons = isRecord(rationale) ? rationale : {}
    parts.unexplained = [...Object.keys(parts.down), ...Object.keys(parts.up)].filter((domain) => !nonEmptyText(reasons[domain]))
  }
  parts.computable = readable
  return parts
}

/**
 * @typedef {object} CertaintyResult
 * @property {CertaintyLevel} level        the rung the parts land on
 * @property {'high' | 'low'} start
 * @property {number} down                 total steps rated down
 * @property {number} up                   total steps rated up, as stated
 * @property {boolean} upgradesCounted     whether `up` was applied
 * @property {'randomized' | 'observational'} design  what the upgrade rule read the body as
 * @property {'sources' | 'tool' | 'start'} designFrom  where that came from
 * @property {Record<string, number>} moves  every nonzero move, down negative
 */

/**
 * Whether to read a body as randomized or observational, in order of how much
 * the answer is the platform's rather than the author's: the types stamped on
 * its preserved sources; the instrument its risk of bias was assessed with;
 * failing both, where the author started it (GRADE's own convention — high
 * for randomized evidence, low for observational).
 * @param {'high' | 'low'} start @param {EvidenceDesign} sourceDesign @param {readonly string[]} tools
 * @returns {{ design: 'randomized' | 'observational', from: 'sources' | 'tool' | 'start' }}
 */
function resolveDesign(start, sourceDesign, tools) {
  if (sourceDesign === 'randomized' || sourceDesign === 'observational') return { design: sourceDesign, from: 'sources' }
  const implied = tools.map((tool) => TOOL_DESIGNS[tool]).filter(Boolean)
  if (implied.length && implied.length === tools.length && implied.every((design) => design === implied[0])) {
    return { design: implied[0], from: 'tool' }
  }
  return { design: start === 'low' ? 'observational' : 'randomized', from: 'start' }
}

/**
 * The GRADE certainty a set of parts lands on.
 *
 * Start at high or low, take every step down, then every step up — but only
 * for observational evidence: "the GRADE approach identifies three factors
 * that may lead to rating up", and "although it is theoretically possible to
 * rate up results from randomized control trials, we have yet to find a
 * compelling example" (Handbook §5.3). Clamped to the ladder, high to very
 * low. The rest of GRADE's advice on rating up — rarely when a serious
 * limitation is present, cautiously when the interval is wide — is judgement,
 * and stays in the rationale and the skill.
 *
 * Null when a part cannot be read; the entry's own notice says which.
 *
 * @param {unknown} certainty  one certainty entry: { start, riskOfBias, …, upgrades, label }
 * @param {{ design?: EvidenceDesign, tools?: readonly string[] }} [context]
 *   `design` from the cited sources' stamped types (`evidenceDesignOf`);
 *   `tools` the risk-of-bias instruments recorded for the same sources.
 * @returns {CertaintyResult | null}
 */
export function gradeCertaintyFromParts(certainty, context = {}) {
  const parts = readCertainty(certainty, 'certainty')
  return certaintyResult(parts, context.design ?? 'unknown', (context.tools ?? []).map(toolKey))
}

/**
 * @param {CertaintyParts} parts @param {EvidenceDesign} sourceDesign @param {readonly string[]} tools
 * @returns {CertaintyResult | null}
 */
function certaintyResult(parts, sourceDesign, tools) {
  if (!parts.computable || !parts.start) return null
  const down = Object.values(parts.down).reduce((sum, steps) => sum + steps, 0)
  const up = Object.values(parts.up).reduce((sum, steps) => sum + steps, 0)
  const { design, from } = resolveDesign(parts.start, sourceDesign, tools)
  const upgradesCounted = design === 'observational'
  const index = CERTAINTY_LEVELS.indexOf(parts.start) - down + (upgradesCounted ? up : 0)
  const level = CERTAINTY_LEVELS[Math.min(CERTAINTY_LEVELS.length - 1, Math.max(0, index))]
  /** @type {Record<string, number>} */
  const moves = {}
  for (const [domain, steps] of Object.entries(parts.down)) moves[domain] = -steps
  for (const [domain, steps] of Object.entries(parts.up)) moves[domain] = steps
  return { level, start: parts.start, down, up, upgradesCounted, design, designFrom: from, moves }
}

// --------------------------------------------------------- risk of bias ---

/**
 * @typedef {object} RiskOfBiasResult
 * @property {string} tool          the canonical id when recomputed, else the tool as written
 * @property {string} toolName      how a reader names it
 * @property {boolean} recomputed   whether the tool's overall rule was applied
 * @property {string | null} stated the overall judgement as recorded
 * @property {string | null} computed the overall the domains determine, or null when they leave a judgement open
 * @property {string[]} allowed     every overall the tool's rule admits for these domains
 * @property {number} rated         domains with a readable judgement
 * @property {number | null} expected how many domains the tool rates
 * @property {boolean | null} agrees  whether `stated` is one the rule admits (null: nothing to compare)
 */

/**
 * The overall judgement a tool's own rule gives for a set of domain
 * judgements. Unrated domains can only make a study look worse than its rated
 * ones, so with some unrated the rule admits the rated floor and anything
 * worse — never the tool's best level, which needs every domain.
 * @param {typeof RISK_OF_BIAS_TOOLS[string]} tool @param {string[]} ratings
 * @param {{ criticalItems?: number[], items?: Map<number, string> }} [amstar]
 * @returns {{ computed: string | null, allowed: string[] }}
 */
function toolJudgement(tool, ratings, amstar = {}) {
  const complete = ratings.length >= tool.domains
  if (tool.id === 'amstar2') {
    const items = amstar.items ?? new Map()
    const critical = new Set(amstar.criticalItems ?? AMSTAR2_CRITICAL_ITEMS)
    let flaws = 0
    let weaknesses = 0
    for (const [item, answer] of items) {
      if (answer !== 'no') continue
      if (critical.has(item)) flaws += 1
      else weaknesses += 1
    }
    const scale = /** @type {readonly string[]} */ (tool.overall)
    const level = flaws > 1 ? 'critically-low' : flaws === 1 ? 'low' : weaknesses > 1 ? 'moderate' : 'high'
    const from = scale.indexOf(level)
    const allowed = complete ? [level] : scale.slice(Math.max(from, 1))
    // Box 2's own footnote: several non-critical weaknesses may move moderate
    // to low.
    if (level === 'moderate' && !allowed.includes('low')) allowed.push('low')
    return { computed: complete || level === 'critically-low' ? level : null, allowed }
  }
  const order = tool.levels
  const ranked = ratings.map((rating) => order.indexOf(rating)).filter((index) => index >= 0)
  const floor = ranked.length ? Math.max(...ranked) : 0
  const count = (/** @type {string} */ level) => ratings.filter((rating) => rating === level).length
  if (tool.id === 'robins-i' && count('no-information') > 0 && floor < order.indexOf('serious')) {
    // Low needs every domain low and moderate every domain low or moderate,
    // so a domain with no information rules both out as a matter of the
    // table; whether that domain is a key one — no-information overall, or a
    // moderate judgement that the gap is immaterial — is the judgement the
    // tool asks the assessor for, and either answer is the tool's.
    const judged = order[Math.max(floor, order.indexOf('moderate'))]
    return { computed: null, allowed: complete ? [judged, 'no-information'] : [...order.slice(Math.max(floor, 1)), 'no-information'] }
  }
  const allowed = complete ? [order[floor]] : order.slice(Math.max(floor, 1))
  const computed = complete || floor === order.length - 1 ? order[floor] : null
  /** @param {string} level */
  const admit = (level) => { if (!allowed.includes(level)) allowed.push(level) }
  if (tool.id === 'rob2' && order[floor] === 'some-concerns' && count('some-concerns') >= 2) admit('high')
  if (tool.id === 'robins-e' && order[floor] === 'high' && count('high') >= 2) admit('very-high')
  if (tool.id === 'quadas2' && order[floor] === 'unclear') admit('high')
  return { computed, allowed }
}

/**
 * @typedef {object} RiskOfBiasRead
 * @property {RiskOfBiasResult | null} result
 * @property {string[]} problems
 */

/**
 * One risk-of-bias record read and judged. `at` names it in the sentences.
 * @param {unknown} value @param {string} at @returns {RiskOfBiasRead}
 */
function readRiskOfBias(value, at) {
  /** @type {string[]} */
  const problems = []
  if (!isRecord(value)) {
    problems.push(`${at} must be an object: { tool, domains: { <domain>: <judgement> }, overall } — a judgement with no instrument behind it cannot be read back.`)
    return { result: null, problems }
  }
  const written = nonEmptyText(value.tool)
  if (!written) {
    problems.push(`${at} names no tool. Name the instrument applied — rob2, robins-i, robins-e, quadas2, amstar2, or the one you used.`)
    return { result: null, problems }
  }
  const key = toolKey(written)
  const tool = RISK_OF_BIAS_TOOLS[key]

  /** @type {[string, unknown][]} */
  let entries = []
  let unreadableDomains = false
  if (Array.isArray(value.domains)) {
    // The list form a model reaches for as often as the map: one row per
    // domain, `{ domain, judgement }` — or `{ item, answer }` for AMSTAR 2.
    // A bare judgement in the list names no domain, so nothing can say which
    // one it rates.
    const rows = value.domains.filter(isRecord)
    if (rows.length < value.domains.length) {
      unreadableDomains = true
      problems.push(`${at}.domains lists ${value.domains.length - rows.length} judgement(s) with no domain; give each as { domain, judgement }, or map each domain to its judgement.`)
    }
    entries = rows.map((entry) => [
      nonEmptyText(entry.domain) || nonEmptyText(entry.name) || (present(entry.item) ? String(entry.item) : ''),
      entry.judgement ?? entry.judgment ?? entry.rating ?? entry.level ?? entry.answer ?? entry.response,
    ])
  } else if (isRecord(value.domains)) {
    entries = Object.entries(value.domains)
  } else if (present(value.domains)) {
    unreadableDomains = true
    problems.push(`${at}.domains must map each domain to its judgement: { <domain>: <judgement> }.`)
  }
  const stated = present(value.overall) ? String(value.overall).trim() : null

  if (!tool) {
    // An instrument we do not recompute is recorded as written; its scale is
    // its own and nothing here can say a value is off it.
    return {
      result: { tool: written, toolName: written, recomputed: false, stated: stated || null, computed: null, allowed: [], rated: entries.length, expected: null, agrees: null },
      problems,
    }
  }

  /** @param {unknown} raw @returns {string} */
  const level = (raw) => {
    const spelled = word(String(raw ?? '').replace(/\(.*\)\s*$/, '')).replace(/^-+|-+$/g, '').replace(/-risk(?:-of-bias)?$/, '')
    return tool.aliases?.[spelled] ?? spelled
  }
  const scale = [...tool.levels, ...(tool.extra ?? [])]
  /** @type {string[]} */
  const offScale = []
  /** @type {string[]} */
  const ratings = []
  /** @type {Map<number, string>} */
  const items = new Map()
  /** @type {string[]} */
  const unnumbered = []
  for (const [domain, raw] of entries) {
    const rating = level(raw)
    if (!scale.includes(rating)) {
      offScale.push(`${domain || '(unnamed)'} ${quoted(raw)}`)
      continue
    }
    if (tool.id === 'amstar2') {
      // Key each item by its number, or its critical items cannot be found.
      const number = /^(?:item|q|question)?[\s_-]*0*(\d{1,2})$/i.exec(String(domain).trim())
      const item = number ? Number(number[1]) : NaN
      if (!(item >= 1 && item <= 16)) {
        unnumbered.push(domain || '(unnamed)')
        continue
      }
      items.set(item, rating)
    }
    ratings.push(rating)
  }
  if (offScale.length) {
    problems.push(`${at}.domains rates ${offScale.slice(0, 6).join(', ')} off ${tool.name}'s scale; ${tool.name} rates each ${tool.id === 'amstar2' ? 'item' : 'domain'} ${tool.levels.join(' / ')}${tool.extra ? ` (or ${tool.extra.join(' / ')})` : ''}.`)
  }
  if (unnumbered.length) {
    problems.push(`${at}.domains names ${unnumbered.slice(0, 6).map((name) => quoted(name)).join(', ')}, which ${unnumbered.length === 1 ? 'is not an AMSTAR 2 item number' : 'are not AMSTAR 2 item numbers'} (1–16); key each item by its number so the critical ones can be found.`)
  }
  /** @type {number[] | undefined} */
  let criticalItems
  if (present(value.criticalItems)) {
    const list = Array.isArray(value.criticalItems) ? value.criticalItems.map(Number) : []
    if (tool.id !== 'amstar2' || !list.length || list.some((item) => !Number.isInteger(item) || item < 1 || item > 16)) {
      problems.push(`${at}.criticalItems ${tool.id === 'amstar2' ? 'must list AMSTAR 2 item numbers (1–16)' : `belongs to AMSTAR 2, not ${tool.name}`}.`)
    } else criticalItems = list
  }
  const overallScale = tool.overall ?? scale
  const statedLevel = stated === null ? null : level(stated)
  if (statedLevel !== null && !overallScale.includes(statedLevel)) {
    problems.push(`${at}.overall is ${quoted(value.overall)}; ${tool.name}'s overall judgement is ${overallScale.join(' / ')}.`)
  }
  // A domain that could not be read leaves the overall undecidable; the
  // notice above says which, and nothing is compared until it is fixed.
  const judgeable = !offScale.length && !unnumbered.length && !unreadableDomains
  const judged = judgeable ? toolJudgement(tool, ratings, { criticalItems, items }) : { computed: null, allowed: [] }
  const comparable = judgeable && statedLevel !== null && overallScale.includes(statedLevel)
  return {
    result: {
      tool: tool.id,
      toolName: tool.name,
      recomputed: judgeable,
      stated: statedLevel !== null && overallScale.includes(statedLevel) ? statedLevel : stated,
      computed: judged.computed,
      allowed: judged.allowed,
      rated: ratings.length,
      expected: tool.domains,
      agrees: comparable ? judged.allowed.includes(/** @type {string} */ (statedLevel)) : null,
    },
    problems,
  }
}

/**
 * The overall risk-of-bias judgement a record's own domains give, by its
 * tool's published rule; null when the record names no tool. For a tool this
 * module does not recompute, `recomputed` is false and only what was written
 * comes back.
 * @param {unknown} riskOfBias  { tool, domains: { <domain>: <judgement> }, overall, criticalItems? }
 * @returns {RiskOfBiasResult | null}
 */
export function riskOfBiasOverall(riskOfBias) {
  return readRiskOfBias(riskOfBias, 'riskOfBias').result
}

/** @param {string[]} values @param {string} [or] */
function either(values, or = 'or') {
  const shown = values.map((value) => `"${value}"`)
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} ${or} ${shown.at(-1)}` : shown[0] ?? ''
}

// ----------------------------------------------------------------- PICO ---

/**
 * @typedef {object} PicoQuote
 * @property {string} where         e.g. `claims[3].pico.population`
 * @property {string} quote
 * @property {string | null} artifactPath  the source the quote is checked in
 * @property {boolean} ownSource    the path is the claim's own, not named by the part
 */

/**
 * One PICO part: a string, or `{ text, quote?, artifactPath? }` when it is
 * bound to the source's wording.
 * @param {unknown} value @param {string} where
 * @returns {{ text: string | null, quote: string | null, artifactPath: string | null, problem: string | null }}
 */
function readPicoPart(value, where) {
  if (typeof value === 'string') return { text: value.trim() || null, quote: null, artifactPath: null, problem: null }
  if (!isRecord(value)) {
    return { text: null, quote: null, artifactPath: null, problem: `${where} must be a string, or { text, quote?, artifactPath? } to bind it to the source's wording.` }
  }
  const text = nonEmptyText(value.text)
  const quote = present(value.quote) ? nonEmptyText(value.quote) : null
  const artifactPath = present(value.artifactPath) ? nonEmptyText(value.artifactPath) : null
  const problems = []
  if (!text) problems.push('a non-empty text')
  if (quote === '') problems.push('a quote that is a non-empty passage of the source')
  if (artifactPath === '') problems.push('an artifactPath that is a preserved .evimed-sources/ path')
  return {
    text: text || null,
    quote: quote || null,
    artifactPath: artifactPath || null,
    problem: problems.length ? `${where} needs ${problems.join(', ')}.` : null,
  }
}

/**
 * @typedef {object} PicoView
 * @property {string | null} population
 * @property {string | null} intervention
 * @property {boolean} exposure     the second part was given as an exposure (PECO) rather than an intervention
 * @property {string | null} comparator
 * @property {string[]} outcomes
 * @property {string | null} timeframe
 * @property {string | null} setting
 */

/**
 * A claim's PICO read into its parts, the quotes to check, and what could not
 * be read. `intervention` may be spelled `exposure` (PECO, for an exposure or
 * harm question); `outcomes` may be the single `outcome` the skill taught
 * first.
 * @param {unknown} value @param {string} at @param {Record<string, any>} claim
 * @returns {{ view: PicoView | null, quotes: PicoQuote[], problems: string[] }}
 */
function readPico(value, at, claim) {
  /** @type {PicoQuote[]} */
  const quotes = []
  /** @type {string[]} */
  const problems = []
  if (!isRecord(value)) {
    problems.push(`${at} must be an object: { population, intervention, comparator?, outcomes: [...], timeframe?, setting? }, each part a string or { text, quote?, artifactPath? }.`)
    return { view: null, quotes, problems }
  }
  // A part's quote is checked in the source the part names, or in the claim's
  // own source when it names none — a direct claim quotes one document.
  const ownSource = (claim.claimType ?? 'direct') === 'direct' ? nonEmptyText(claim.artifactPath) || null : null
  /** @param {unknown} raw @param {string} where */
  const part = (raw, where) => {
    const read = readPicoPart(raw, where)
    if (read.problem) problems.push(read.problem)
    if (read.quote) {
      quotes.push({ where, quote: read.quote, artifactPath: read.artifactPath ?? ownSource, ownSource: !read.artifactPath })
    }
    return read.text
  }
  /** @param {string} name @param {unknown} raw */
  const optional = (name, raw) => (present(raw) && raw !== '' ? part(raw, `${at}.${name}`) : null)

  const interventionKey = present(value.intervention) ? 'intervention' : 'exposure'
  const population = present(value.population) ? part(value.population, `${at}.population`) : null
  const intervention = present(value[interventionKey]) ? part(value[interventionKey], `${at}.${interventionKey}`) : null

  /** @type {string[]} */
  const outcomes = []
  const outcomeList = present(value.outcomes) ? value.outcomes : value.outcome
  const outcomeKey = present(value.outcomes) ? 'outcomes' : 'outcome'
  const listed = Array.isArray(outcomeList) ? outcomeList : present(outcomeList) ? [outcomeList] : []
  listed.forEach((raw, index) => {
    const text = part(raw, Array.isArray(outcomeList) ? `${at}.${outcomeKey}[${index}]` : `${at}.${outcomeKey}`)
    if (text) outcomes.push(text)
  })

  const missing = [
    ...(population ? [] : ['population']),
    ...(intervention ? [] : ['intervention']),
    ...(outcomes.length ? [] : ['outcomes']),
  ]
  // Missing and unreadable are one problem each, not two: a part that is
  // present and malformed already has its own sentence.
  const unreported = missing.filter((name) => {
    const raw = name === 'intervention' ? value[interventionKey] : name === 'outcomes' ? outcomeList : value[name]
    return !present(raw) || raw === '' || (Array.isArray(raw) && raw.length === 0)
  })
  if (unreported.length) {
    problems.push(`${at} names no ${unreported.join(', ')}. A PICO names the population, the intervention (or exposure) and at least one outcome the source actually studied.`)
  }
  return {
    view: {
      population,
      intervention,
      exposure: interventionKey === 'exposure' && intervention !== null,
      comparator: optional('comparator', value.comparator),
      outcomes,
      timeframe: optional('timeframe', value.timeframe),
      setting: optional('setting', value.setting),
    },
    quotes,
    problems,
  }
}

// --------------------------------------------------------------- claims ---

/**
 * @typedef {object} CertaintyView
 * @property {string | null} outcome
 * @property {CertaintyLevel | null} stated
 * @property {CertaintyLevel | null} computed
 * @property {boolean | null} agrees
 * @property {boolean} upgradesCounted
 */

/**
 * @typedef {RiskOfBiasResult & { source: number | null }} RiskOfBiasView
 *   `source` is the supporting source's index for a synthesized claim, null for the claim's own record.
 */

/**
 * @typedef {object} ClaimAppraisalView
 * @property {PicoView} [pico]
 * @property {CertaintyView[]} [certainty]
 * @property {RiskOfBiasView[]} [riskOfBias]
 */

/**
 * @typedef {object} ClaimAppraisalFindings
 * @property {string[]} picoSchema
 * @property {PicoQuote[]} picoQuotes          checked by the validator, which holds the quote comparison
 * @property {string[]} certaintySchema
 * @property {string[]} certaintyArithmetic
 * @property {string[]} certaintyDesign
 * @property {string[]} robSchema
 * @property {string[]} robOverall
 */

/**
 * The whole analysis of one claim, once, for both of its readers.
 * @param {Record<string, any>} claim @param {string} label
 * @param {Map<string, string> | Record<string, string> | null | undefined} sourceTypes
 * @returns {{ findings: ClaimAppraisalFindings, view: ClaimAppraisalView }}
 */
function analyseClaim(claim, label, sourceTypes) {
  /** @type {ClaimAppraisalFindings} */
  const findings = { picoSchema: [], picoQuotes: [], certaintySchema: [], certaintyArithmetic: [], certaintyDesign: [], robSchema: [], robOverall: [] }
  /** @type {ClaimAppraisalView} */
  const view = {}
  const claimType = claim.claimType ?? 'direct'
  const sources = claimType === 'synthesized'
    ? (Array.isArray(claim.supportingSources) ? claim.supportingSources : [])
    : claimType === 'direct' ? [claim] : []

  if (present(claim.pico)) {
    const pico = readPico(claim.pico, `${label}.pico`, claim)
    findings.picoSchema.push(...pico.problems)
    findings.picoQuotes.push(...pico.quotes)
    if (pico.view) view.pico = pico.view
  }

  /** @type {RiskOfBiasView[]} */
  const robViews = []
  /** @type {{ at: string, value: unknown, source: number | null }[]} */
  const robRecords = []
  if (present(claim.riskOfBias)) robRecords.push({ at: `${label}.riskOfBias`, value: claim.riskOfBias, source: null })
  if (claimType === 'synthesized') {
    sources.forEach((/** @type {any} */ source, /** @type {number} */ index) => {
      if (isRecord(source) && present(source.riskOfBias)) {
        robRecords.push({ at: `${label}.supportingSources[${index}].riskOfBias`, value: source.riskOfBias, source: index })
      }
    })
  }
  for (const record of robRecords) {
    const read = readRiskOfBias(record.value, record.at)
    findings.robSchema.push(...read.problems)
    if (!read.result) continue
    robViews.push({ ...read.result, source: record.source })
    const { result } = read
    if (result.agrees === false) {
      const expected = result.computed ? `"${result.computed}"` : either(result.allowed)
      const partial = result.expected !== null && result.rated < result.expected
        ? ` It rates ${result.rated} of the ${result.expected} ${result.tool === 'amstar2' ? 'items' : 'domains'} ${result.toolName} has, and an unrated ${result.tool === 'amstar2' ? 'item' : 'domain'} is not a clean one.`
        : ''
      findings.robOverall.push(`${record.at}.overall is "${result.stated}", but its ${result.tool === 'amstar2' ? 'items give' : 'domains give'} ${expected}. ${RISK_OF_BIAS_TOOLS[result.tool]?.rule ?? ''}${partial}`)
    }
  }
  if (robViews.length) view.riskOfBias = robViews

  if (present(claim.certainty)) {
    const value = claim.certainty
    const entries = Array.isArray(value) ? value : [value]
    if (Array.isArray(value) && !value.length) {
      findings.certaintySchema.push(`${label}.certainty is an empty list; give one certainty per outcome the claim rates, or leave the field out.`)
    }
    const design = evidenceDesignOf(sources.map((/** @type {any} */ source) => sourceTypeAt(sourceTypes, source?.artifactPath)))
    const tools = robViews.map((rob) => toolKey(rob.tool))
    /** @type {CertaintyView[]} */
    const certaintyViews = []
    entries.forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => {
      const at = Array.isArray(value) ? `${label}.certainty[${index}]` : `${label}.certainty`
      const parts = readCertainty(entry, at)
      findings.certaintySchema.push(...parts.problems)
      if (entries.length > 1 && isRecord(entry) && !parts.outcome) {
        findings.certaintySchema.push(`${at} names no outcome. When a claim rates more than one outcome, each certainty names the outcome it rates.`)
      }
      if (parts.unexplained.length) {
        findings.certaintySchema.push(`${at} moves the rating for ${parts.unexplained.join(', ')} with no rationale. Each step GRADE takes carries its reason under rationale.<domain>; the number is only its size.`)
      }
      const result = certaintyResult(parts, design, tools)
      const stated = parts.stated
      if (result) {
        const upStated = Object.entries(parts.up).map(([domain, steps]) => `${domain} +${steps}`)
        if (stated && stated !== result.level) {
          const downList = Object.entries(parts.down).map(([domain, steps]) => `${domain} -${steps}`)
          findings.certaintyArithmetic.push(
            `${at} is labelled "${stated}", but its parts give "${result.level}": it starts at ${result.start}, is rated down ${result.down}${downList.length ? ` (${downList.join(', ')})` : ''}`
            + ` and up ${result.upgradesCounted ? result.up : 0}${upStated.length && !result.upgradesCounted ? ' (the stated upgrades apply to observational evidence only and were not counted)' : upStated.length ? ` (${upStated.join(', ')})` : ''}.`
            + ' Correct the label or the part that is wrong; the reader is shown both.',
          )
        }
        if (result.designFrom === 'sources' && result.design === 'randomized' && result.start === 'low') {
          findings.certaintyDesign.push(`${at} starts at low, but every source it cites is a randomized trial. Randomized evidence starts at high; if it deserves less, rate it down in the domain that earns it, so the reason is on the record.`)
        }
        if (result.designFrom === 'sources' && result.design === 'observational' && result.start === 'high' && !tools.some((tool) => TOOL_DESIGNS[tool] === 'observational')) {
          findings.certaintyDesign.push(`${at} starts at high, but every source it cites is an observational study. Non-randomized evidence starts at low, unless its risk of bias was assessed with ROBINS-I, which starts it at high and rates it down for risk of bias — if so, record riskOfBias.tool "robins-i".`)
        }
        if (upStated.length && !result.upgradesCounted) {
          const why = result.designFrom === 'sources'
            ? 'every source it cites is a randomized trial'
            : result.designFrom === 'tool'
              ? 'its risk of bias was assessed with an instrument for randomized trials'
              : 'it starts at high, which marks randomized evidence — if it is non-randomized evidence assessed with ROBINS-I, record riskOfBias.tool "robins-i"'
          findings.certaintyDesign.push(`${at} rates up for ${upStated.join(', ')}, but ${why}. GRADE rates up observational evidence, so the upgrade was not counted.`)
        }
      }
      certaintyViews.push({
        outcome: parts.outcome,
        stated,
        computed: result?.level ?? null,
        agrees: stated && result ? stated === result.level : null,
        upgradesCounted: result?.upgradesCounted ?? false,
      })
    })
    if (certaintyViews.length) view.certainty = certaintyViews
  }
  return { findings, view }
}

/**
 * Every finding the structured appraisal of one claim can raise, grouped by
 * what it is about, so the validator can record each group under its own
 * check. PICO quotes are handed back unchecked: the comparison belongs to the
 * validator's own verbatim-quote check, and a second copy of it here is the
 * drift `clinicalEvidenceSingleImplementation.test.mjs` exists to stop.
 *
 * Pure and total: a claim that is not an object has nothing to say here, and
 * the claim schema check says so for it.
 *
 * @param {unknown} claim
 * @param {{ label: string, sourceTypes?: Map<string, string> | Record<string, string> | null }} context
 *   `label` names the claim in every sentence (`claims[3]`, `CLM-004`);
 *   `sourceTypes` maps a preserved source's path to its stamped evidence type.
 * @returns {ClaimAppraisalFindings}
 */
export function claimAppraisalFindings(claim, { label, sourceTypes = null }) {
  if (!isRecord(claim)) {
    return { picoSchema: [], picoQuotes: [], certaintySchema: [], certaintyArithmetic: [], certaintyDesign: [], robSchema: [], robOverall: [] }
  }
  return analyseClaim(claim, label, sourceTypes).findings
}

/**
 * A claim's structured appraisal as a reader or a tool result shows it: the
 * PICO parts, each certainty stated beside the level its parts give, each
 * risk-of-bias record's overall stated beside the one its domains give. Null
 * when the claim carries none of the three.
 * @param {unknown} claim
 * @param {{ sourceTypes?: Map<string, string> | Record<string, string> | null }} [context]
 * @returns {ClaimAppraisalView | null}
 */
export function claimAppraisal(claim, { sourceTypes = null } = {}) {
  if (!isRecord(claim)) return null
  const { view } = analyseClaim(claim, 'claim', sourceTypes)
  return Object.keys(view).length ? view : null
}
