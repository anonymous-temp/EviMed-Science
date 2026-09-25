/**
 * The four 「循证 GEO」 contracts' own findings: `geo-insight-pack`,
 * `geo-strategy-pack`, `geo-content-pack` and `geo-proposal-pack`.
 *
 * Hidden knowledge: which of these findings may be `required`, and why so few.
 *
 * The owner's method pack (geo-skills 3.0.0) carries 133 rules, 99 of them
 * BLOCK when it runs on its own. Inside the platform a rule may hold a
 * delivery's attention only in the two tiers the 2026-09-17 ruling left —
 * `blocking` (the package cannot be read, or its defect is one a reader cannot
 * see) and `safety` (clinical framing) — and even those never withhold it: a
 * required finding tells the run "must fix", and a package delivered with one
 * open is labelled unverified with the finding first. The method pack records
 * the same decision per rule as `platform_tier`; the handful of those this
 * module can decide from the bytes of a package are the only required ones
 * here:
 *
 *   - a required index file that does not parse, or names a file the package
 *     does not have (unreadable);
 *   - a claim bound to no source or no quote, and a quote that is not in the
 *     preserved source it names (EF-G02, and the gate's own quote check);
 *   - a "real phrasing" with no source (DM-G01: a composed question passed off
 *     as a patient's words, which no reader can tell apart);
 *   - a number labelled measured that carries no numerator and denominator, or
 *     a target labelled anything but a forecast (IRON-06, SE-G02, VF-G01);
 *   - the pharmacist-owned clinical safety rules over an article a patient may
 *     read (the safety tier, as the old GEO pack already had it).
 *
 * Everything else — counts, pool coverage, control-group share, layer lengths,
 * the T/CAPT 026 evidence elements, gap classes, tier shape — is a notice
 * (principle 4: a new check ships as a notice and earns more from an observed
 * distribution). Measurement is the platform's now (build spec 2026-09-25
 * §0.3): no GEO contract requires a probe ledger, and the old measurement
 * notices speak only when a run did record an ad-hoc probe.
 *
 * The vocabularies below are the few this module needs to read a package.
 * `geoVocabulary.mjs` (package M of the same build) is the platform's closed
 * vocabulary; where both exist the words are the same, and a later change may
 * import them from there.
 *
 * Zero dependencies beyond this package, like the rest of it.
 */

import { checkIdOf, citationIntegrityIssues, clinicalSafetyRuleHits, quoteIsPresent, runtimeLeakageLine } from './clinicalEvidence.mjs'

/** @typedef {'required'|'advisory'} GeoSeverity */
/**
 * @typedef {object} GeoIssue
 * @property {string} code
 * @property {string} message
 * @property {GeoSeverity} severity
 * @property {string} [path]
 * @property {string} [check]
 * @property {string} [rule]
 * @property {number} [line]
 */
/** @typedef {{ issues: GeoIssue[], metrics: Record<string, unknown> }} GeoFindings */
/**
 * @typedef {object} GeoInput
 * @property {string} contractKind
 * @property {Map<string, string>} files
 * @property {Record<string, string>} [sourceArtifacts]
 */

/** The files each contract is read through. */
export const GEO_CONTRACT_FILES = Object.freeze({
  insight: Object.freeze({ report: 'geo-insight.md', claims: 'claims.json', questions: 'question-map.json' }),
  strategy: Object.freeze({ report: 'geo-strategy.md', strategy: 'strategy.json' }),
  content: Object.freeze({ report: 'geo-content.md', index: 'articles.json' }),
  proposal: Object.freeze({ report: 'geo-proposal.md', index: 'proposal-package.json' }),
})

/**
 * Per-article work records are backstage by design (principle 10a): the
 * clinical path, the claim map and what the rewrite changed are written there
 * so the article can be held to a register the record is not. They are read
 * for presence and never scanned as prose.
 */
export const GEO_RECORDS_PREFIX = 'records/'

/** Article layers, as `evimed_geo.articles.layer` holds them. */
const ARTICLE_LAYERS = Object.freeze(['deep', 'card', 'popular', 'qa', 'correction'])
/** The four question pools. */
const POOLS = Object.freeze(['P1', 'P2', 'P3', 'P4'])
/** Where a claim's words come from. */
const CLAIM_SOURCE_KINDS = Object.freeze(['label', 'guideline', 'trial', 'review', 'literature', 'regulator', 'other'])
/** The seven classes an answer gap falls into (the method pack's own words). */
const GAP_CLASSES = Object.freeze(['缺证据', '丢条件', '过时', '信源弱', '只讲获益不讲安全', '讲错', '受众看不懂'])
/** The three target tiers. */
const TIERS = Object.freeze(['1', '2', '3'])
/** A target is a forecast or a commercial figure, never a measurement. */
const TARGET_DATA_TYPES = Object.freeze(['forecast', 'commercial'])
/** The two package modes of `geo-proposal`. */
const PROPOSAL_MODES = Object.freeze(['proposal', 'weekly'])
/** What each proposal mode hands a client, by file kind and count. */
const PROPOSAL_KINDS = Object.freeze({
  proposal: Object.freeze({ xlsx: 1, docx: 2, pptx: 1, html: 1 }),
  weekly: Object.freeze({ pdf: 1, docx: 1 }),
})

/** Measured-question bounds of a locked question set (build spec §4). */
export const GEO_QUESTION_SET_BOUNDS = Object.freeze({ min: 40, max: 120, minimal: 30, controlGroups: Object.freeze({ min: 3, max: 5 }), controlShare: Object.freeze({ min: 0.2, max: 0.3 }) })
/** A full claim library holds at least this many claims; a minimal one need not. */
export const GEO_CLAIM_LIBRARY_MIN = 30
/** A 问答 article is 300–600 characters (plan §3.6). */
const QA_LENGTH = Object.freeze({ min: 300, max: 600 })
/** How many companion files one index may name: a bound on what the gate reads. */
const COMPANION_LIMIT = 80
/** How many offenders one notice names. */
const NAMED = 6

/**
 * @param {string} code @param {string} message
 * @param {{ severity?: GeoSeverity, path?: string, check: string, rule?: string, line?: number }} extra
 * @returns {GeoIssue}
 */
function finding(code, message, extra) {
  return {
    code,
    message,
    severity: extra.severity ?? 'advisory',
    ...(extra.path ? { path: extra.path } : {}),
    check: extra.check,
    ...(extra.rule ? { rule: extra.rule } : {}),
    ...(extra.line ? { line: extra.line } : {}),
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * A declared JSON file: absent (`null`), unparseable (`undefined`) or its value.
 * @param {GeoInput} input @param {string} path @returns {any}
 */
function readJson(input, path) {
  const raw = input.files.get(path)
  if (raw == null || !raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** @param {readonly string[]} items @returns {string} */
function named(items) {
  return items.length > NAMED ? `${items.slice(0, NAMED).join(', ')} and ${items.length - NAMED} more` : items.join(', ')
}

/**
 * A path an index may name: relative, inside the deliverable, no parent
 * segment, no hidden or machinery directory.
 * @param {unknown} value @returns {value is string}
 */
export function isGeoPackagePath(value) {
  if (typeof value !== 'string' || !value || value.length > 200) return false
  if (value.startsWith('/') || value.includes('\\') || value.includes('\u0000')) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
}

/**
 * The index file a GEO contract reads, parsed, with the unreadable half of the
 * verdict: a required file that does not parse, or parses to the wrong shape,
 * is a package nothing downstream can read.
 * @param {GeoInput} input @param {string} path @param {(value: Record<string, any>) => string | null} shape
 * @param {GeoIssue[]} issues
 * @returns {Record<string, any> | null}
 */
function readIndex(input, path, shape, issues) {
  const value = readJson(input, path)
  if (value === null) return null // the manifest's required-output pass names it
  if (value === undefined) {
    issues.push(finding('deliverable_rejected', `${path} is not valid JSON. Fix the syntax first: a value containing a double quote must escape it (\\"), and every string must close before the next key.`, { severity: 'required', path, check: 'deliverable-json-parse' }))
    return null
  }
  if (!isRecord(value)) {
    issues.push(finding('deliverable_rejected', `${path} must be a JSON object.`, { severity: 'required', path, check: 'deliverable-json-parse' }))
    return null
  }
  const problem = shape(value)
  if (problem) {
    issues.push(finding('deliverable_rejected', `${path} ${problem}`, { severity: 'required', path, check: 'deliverable-json-parse' }))
    return null
  }
  return value
}

/**
 * Files an index names that a reader will open: every one must be in the
 * package, and none may be empty.
 * @param {GeoInput} input @param {string} index @param {readonly string[]} paths @param {GeoIssue[]} issues
 */
function namedFilesPresent(input, index, paths, issues) {
  for (const path of paths) {
    const body = input.files.get(path)
    if (body == null) {
      issues.push(finding('required_output_missing', `${path} is named in ${index} and is not in the package.`, { severity: 'required', path, check: 'required-output' }))
    } else if (!body.trim()) {
      issues.push(finding('required_output_empty', `${path} is named in ${index} and is empty.`, { severity: 'required', path, check: 'required-output' }))
    }
  }
}

/**
 * Report prose held to the platform's hygiene, as notices. The same two
 * checks every report-shaped kind runs — machinery named in prose, citation
 * numbers that do not resolve — raised here as advice, because a reader can
 * see either for themselves and neither is on the blocking tier.
 * @param {GeoInput} input @param {readonly string[]} prose @returns {GeoIssue[]}
 */
export function geoProseNotices(input, prose) {
  /** @type {GeoIssue[]} */
  const issues = []
  for (const path of prose) {
    const body = input.files.get(path) ?? ''
    if (!body) continue
    const leak = runtimeLeakageLine(body)
    if (leak) {
      issues.push(finding('runtime_leakage', `${path} line ${leak.line} names the machinery (matched "${leak.match}"): ${leak.text}`, { path, line: leak.line, check: checkIdOf(runtimeLeakageLine) }))
    }
    for (const message of citationIntegrityIssues(body)) {
      issues.push(finding('citation_integrity', `${path}: ${message}`, { path, check: checkIdOf(citationIntegrityIssues) }))
    }
  }
  return issues
}

/**
 * The files beyond the manifest's declared outputs that a GEO index names, so
 * the reader of a deliverable (the run-side gate) can bring them in before the
 * validator runs. A manifest can only declare fixed paths; an article is
 * `articles/<id>.md` with an id the run chooses.
 *
 * Only text a reader opens: articles and their work records; for a proposal,
 * the HTML and Markdown it lists. A binary office file is the platform's to
 * check (its bytes are not text), and a path that could leave the deliverable
 * is not a path at all.
 * @param {string} contractKind @param {Map<string, string>} files @returns {string[]}
 */
export function geoCompanionPaths(contractKind, files) {
  /** @param {string} path @returns {any} */
  const parse = (path) => {
    const raw = files.get(path)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }
  /** @type {string[]} */
  let paths = []
  if (contractKind === 'geo-content-pack') {
    const index = parse(GEO_CONTRACT_FILES.content.index)
    const articles = isRecord(index) && Array.isArray(index.articles) ? index.articles : []
    paths = articles.flatMap((/** @type {any} */ article) => (isRecord(article) ? [article.path, article.recordPath] : []))
  } else if (contractKind === 'geo-proposal-pack') {
    const index = parse(GEO_CONTRACT_FILES.proposal.index)
    const listed = isRecord(index) && Array.isArray(index.files) ? index.files : []
    paths = listed.map((/** @type {any} */ file) => (isRecord(file) ? file.path : null))
      .filter((/** @type {unknown} */ path) => typeof path === 'string' && /\.(md|html?)$/i.test(path))
  }
  return [...new Set(paths.filter(isGeoPackagePath))].slice(0, COMPANION_LIMIT)
}

// ---------------------------------------------------------------- insight

/**
 * `geo-insight-pack`: the product's identity, its claim library and the
 * question map (steps 1–3).
 * @param {GeoInput} input @returns {GeoFindings}
 */
export function geoInsightFindings(input) {
  /** @type {GeoIssue[]} */
  const issues = []
  const files = GEO_CONTRACT_FILES.insight
  const artifacts = new Map(Object.entries(isRecord(input.sourceArtifacts) ? input.sourceArtifacts : {}))

  const library = readIndex(input, files.claims, (value) => (Array.isArray(value.claims) ? null : 'has no claims[] list: the claim library is that list.'), issues)
  const claims = library ? /** @type {any[]} */ (library.claims) : []
  const minimal = library?.minimal === true
  let verified = 0
  /** @type {string[]} */ const unbound = []
  /** @type {string[]} */ const unchecked = []
  /** @type {string[]} */ const incomplete = []
  claims.forEach((claim, index) => {
    const label = isRecord(claim) && text(claim.claimKey) ? text(claim.claimKey) : `claims[${index}]`
    if (!isRecord(claim)) { unbound.push(label); return }
    const quote = text(claim.quote)
    const artifactPath = text(claim.artifactPath)
    const sourceRef = text(claim.sourceRef)
    if (!text(claim.statement) || !quote || (!artifactPath && !sourceRef)) { unbound.push(label); return }
    if (!CLAIM_SOURCE_KINDS.includes(text(claim.sourceKind)) || !isRecord(claim.elements) || !text(claim.verifiedAt) || typeof claim.inLabel !== 'boolean') {
      incomplete.push(label)
    }
    const source = artifactPath ? artifacts.get(artifactPath) : undefined
    if (!source) { unchecked.push(label); return }
    if (quoteIsPresent(source, quote)) { verified += 1; return }
    issues.push(finding('geo_claim_quote_not_found', `${files.claims} ${label}: the quote is not in ${artifactPath}, the preserved source it names. Quote the passage as the source words it, or cite the source that does.`, { severity: 'required', path: files.claims, check: 'claim-quote-verbatim' }))
  })
  if (unbound.length) {
    issues.push(finding('geo_claim_unbound', `${files.claims}: ${unbound.length} claim(s) lack a statement, a verbatim quote, or any source (${named(unbound)}). A claim bound to nothing reads exactly like one that is bound, and every later step judges against it.`, { severity: 'required', path: files.claims, check: 'geo-claim-source' }))
  }
  if (unchecked.length) {
    issues.push(finding('geo_claim_unverified', `${files.claims}: ${unchecked.length} claim quote(s) could not be checked because no preserved source text reached the check (${named(unchecked)}). Cite the .evimed-sources/ path a reading tool preserved (a label read through drug_label_search is preserved), or preserve the source first.`, { path: files.claims, check: 'geo-claim-source' }))
  }
  if (incomplete.length) {
    issues.push(finding('geo_claim_library_notice', `${files.claims}: ${incomplete.length} claim(s) miss a source kind, the evidence elements, the verification date or whether it is in the label (${named(incomplete)}).`, { path: files.claims, check: 'geo-claim-schema' }))
  }
  if (library && !minimal && claims.length < GEO_CLAIM_LIBRARY_MIN) {
    issues.push(finding('geo_claim_library_notice', `${files.claims} holds ${claims.length} claim(s); a full claim library usually holds at least ${GEO_CLAIM_LIBRARY_MIN}. Mark the library minimal: true if it was built as the minimal upstream of a single step.`, { path: files.claims, check: 'geo-claim-schema' }))
  }

  const map = readIndex(input, files.questions, (value) => (Array.isArray(value.groups) ? null : 'has no groups[] list: the question map is that list.'), issues)
  const groups = map ? /** @type {any[]} */ (map.groups).filter(isRecord) : []
  const mapMinimal = map?.minimal === true
  const measuredGroups = groups.filter((group) => (Array.isArray(group.questions) ? group.questions : []).some((/** @type {any} */ question) => isRecord(question) && question.measured === true))
  const measured = groups.flatMap((group) => (Array.isArray(group.questions) ? group.questions : []).filter((/** @type {any} */ question) => isRecord(question) && question.measured === true))
  const controls = measuredGroups.filter((group) => group.isControl === true)
  /** @type {string[]} */ const unsourced = []
  for (const group of groups) {
    for (const question of Array.isArray(group.questions) ? group.questions : []) {
      if (isRecord(question) && question.kind === 'real' && (!text(question.sourceUrl) || !text(question.platform))) unsourced.push(text(question.text).slice(0, 40) || text(group.name))
    }
  }
  if (unsourced.length) {
    issues.push(finding('geo_real_phrasing_unsourced', `${files.questions}: ${unsourced.length} question(s) are marked kind "real" with no platform or source URL (${named(unsourced)}). A real phrasing is a person's words with the place they were said; a question written for them is kind "typical".`, { severity: 'required', path: files.questions, check: 'geo-question-map' }))
  }
  if (map) {
    /** @type {string[]} */
    const notes = []
    const pools = new Set(groups.map((group) => text(group.pool)))
    const badPools = [...pools].filter((pool) => !POOLS.includes(pool))
    if (badPools.length) notes.push(`pool(s) ${named(badPools)} are not one of ${POOLS.join('/')}`)
    const missingPools = POOLS.filter((pool) => !pools.has(pool))
    if (missingPools.length) notes.push(`no group in ${missingPools.join(', ')}`)
    const floor = mapMinimal ? GEO_QUESTION_SET_BOUNDS.minimal : GEO_QUESTION_SET_BOUNDS.min
    if (measured.length < floor || measured.length > GEO_QUESTION_SET_BOUNDS.max) {
      notes.push(`${measured.length} measured question(s), where a ${mapMinimal ? 'minimal' : 'full'} set holds ${floor}–${GEO_QUESTION_SET_BOUNDS.max}`)
    }
    if (!mapMinimal && measuredGroups.length) {
      const share = controls.length / measuredGroups.length
      if (controls.length < GEO_QUESTION_SET_BOUNDS.controlGroups.min || controls.length > GEO_QUESTION_SET_BOUNDS.controlGroups.max
        || share < GEO_QUESTION_SET_BOUNDS.controlShare.min || share > GEO_QUESTION_SET_BOUNDS.controlShare.max) {
        notes.push(`${controls.length} control group(s) of ${measuredGroups.length} measured (${Math.round(share * 100)}%), where the net effect needs 3–5, about 20–30%`)
      }
    }
    if (notes.length) {
      issues.push(finding('geo_question_map_notice', `${files.questions}: ${notes.join('; ')}.`, { path: files.questions, check: 'geo-question-map' }))
    }
  }

  return {
    issues,
    metrics: {
      geoClaims: claims.length,
      geoClaimsVerified: verified,
      geoQuestionGroups: groups.length,
      geoMeasuredQuestions: measured.length,
      geoControlGroups: controls.length,
    },
  }
}

// ---------------------------------------------------------------- strategy

/**
 * A number cell that says it was measured and cannot say out of what.
 * @param {unknown} cell @returns {boolean}
 */
function measuredWithoutDenominator(cell) {
  if (!isRecord(cell)) return false
  const type = text(cell.dataType ?? cell.data_type)
  if (type !== 'measured') return false
  const denominator = Number(cell.denominator)
  return cell.numerator == null || !Number.isFinite(denominator) || denominator <= 0
}

/**
 * `geo-strategy-pack`: sources, expectations per engine, the battlefield, the
 * layout and three tiers of targets (step 5).
 * @param {GeoInput} input @returns {GeoFindings}
 */
export function geoStrategyFindings(input) {
  /** @type {GeoIssue[]} */
  const issues = []
  const path = GEO_CONTRACT_FILES.strategy.strategy
  const strategy = readIndex(input, path, () => null, issues)
  const sources = Array.isArray(strategy?.sources) ? strategy.sources.filter(isRecord) : []
  const gaps = Array.isArray(strategy?.gaps) ? strategy.gaps.filter(isRecord) : []
  const expectations = Array.isArray(strategy?.expectations) ? strategy.expectations.filter(isRecord) : []
  const tiers = Array.isArray(strategy?.tiers) ? strategy.tiers.filter(isRecord) : []
  if (strategy) {
    /** @type {string[]} */
    const mislabelled = []
    expectations.forEach((expectation, index) => {
      if (measuredWithoutDenominator(expectation.retrieval)) mislabelled.push(`expectations[${index}].retrieval (${text(expectation.engine) || 'engine?'})`)
    })
    tiers.forEach((tier, index) => {
      for (const [at, target] of (Array.isArray(tier.targets) ? tier.targets : []).entries()) {
        if (!isRecord(target)) continue
        const type = text(target.dataType ?? target.data_type)
        if (!TARGET_DATA_TYPES.includes(type)) mislabelled.push(`tiers[${index}].targets[${at}] (${text(target.metricId) || 'metric?'} is "${type || 'unlabelled'}")`)
      }
    })
    if (mislabelled.length) {
      issues.push(finding('geo_data_type_mislabelled', `${path}: ${mislabelled.length} number(s) claim a data type they cannot have — a measured value with no numerator and denominator, or a target that is not a forecast or a commercial figure: ${named(mislabelled)}. A reader cannot tell a forecast from a measurement unless the file says which it is.`, { severity: 'required', path, check: 'geo-data-type' }))
    }
    /** @type {string[]} */
    const notes = []
    const badGaps = [...new Set(gaps.map((gap) => text(gap.class)).filter((name) => !GAP_CLASSES.includes(name)))]
    if (badGaps.length) notes.push(`gap class(es) ${named(badGaps)} are not one of the seven (${GAP_CLASSES.join('、')})`)
    const tierIds = tiers.map((tier) => String(tier.tier ?? ''))
    if (tierIds.length !== TIERS.length || !TIERS.every((tier) => tierIds.includes(tier))) notes.push(`tiers are [${tierIds.join(', ')}], where the targets come in exactly three: 1, 2, 3`)
    if (!expectations.length) notes.push('no per-engine expectation')
    if (!isRecord(strategy.battlefield) || !Array.isArray(strategy.battlefield.groups) || !strategy.battlefield.groups.length) notes.push('no battlefield group')
    if (!sources.length) notes.push('no source table')
    if (notes.length) issues.push(finding('geo_strategy_notice', `${path}: ${notes.join('; ')}.`, { path, check: 'geo-strategy-shape' }))
  }
  return {
    issues,
    metrics: {
      geoSources: sources.length,
      geoGaps: gaps.length,
      geoEnginesExpected: expectations.length,
      geoTiers: tiers.length,
    },
  }
}

// ---------------------------------------------------------------- content

/**
 * The probe ledger an ad-hoc question inside a run may leave. Present only
 * when the run asked one; measurement is the platform's otherwise.
 * @param {GeoInput} input @returns {{ rounds: Record<string, any>[], unreadable: number, present: boolean }}
 */
function probeLedger(input) {
  // Read directly rather than through a helper that collapses a missing file
  // and an empty one: the two are different facts.
  const raw = input.files.get('geo-probe-log.jsonl')
  if (raw == null) return { rounds: [], unreadable: 0, present: false }
  /** @type {Record<string, any>[]} */
  const rounds = []
  let unreadable = 0
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (isRecord(parsed)) rounds.push(parsed)
      else unreadable += 1
    } catch {
      unreadable += 1
    }
  }
  return { rounds, unreadable, present: true }
}

/**
 * Measurement honesty over an ad-hoc probe ledger, as notices.
 *
 * A number computed over rounds that never happened is wrong in a way the page
 * cannot show: "answered and did not mention us", "errored" and "was never
 * logged in" produce one identical-looking absence. Measurement proper is the
 * platform's (build spec 2026-09-25 §0.3), so these speak only when a run did
 * record a probe of its own; an absent ledger is not a finding any more.
 *
 * The probe host in client prose is checked whether or not a ledger exists: it
 * is the one machinery shape the shared leakage rule does not match.
 * @param {GeoInput} input @param {readonly string[]} prose @returns {GeoFindings}
 */
export function geoMeasurementNotices(input, prose) {
  /** @type {GeoIssue[]} */
  const issues = []
  /** @param {string} code @param {string} message */
  const notice = (code, message) => issues.push(finding(code, message, { path: 'geo-probe-log.jsonl', check: 'geo-measurement' }))
  const { rounds, unreadable, present } = probeLedger(input)
  const measured = rounds.filter((row) => row.inDenominator === true)
  const failed = rounds.filter((row) => row.inDenominator !== true)
  if (present && !measured.length) {
    notice('geo_measurement_absent', rounds.length
      ? `all ${rounds.length} probe round(s) failed, so nothing was measured. A pack built on zero measurements states what the engines were not observed to say.`
      : 'the probe ledger is empty, so nothing was measured.')
  }
  if (unreadable) {
    notice('geo_probe_log_unreadable', `${unreadable} line(s) of geo-probe-log.jsonl could not be parsed; every rate computed from it is short by an unknown amount.`)
  }
  const countedFailures = rounds.filter((row) => row.inDenominator === true && String(row.status ?? 'ok') !== 'ok')
  if (countedFailures.length) {
    notice('geo_failed_round_counted', `${countedFailures.length} probe round(s) are marked as counting toward the denominator while their status is not ok. A failed probe is not a measurement.`)
  }
  const surfaceless = measured.filter((row) => {
    const surface = isRecord(row.surface) ? row.surface : {}
    return !String(surface.mode ?? '').trim() || !String(surface.session ?? '').trim()
  })
  if (surfaceless.length) {
    notice('geo_surface_undeclared', `${surfaceless.length} measured round(s) do not record both a mode and a session. Without the surface the measurement cannot be reproduced or compared with the next one.`)
  }
  for (const path of prose) {
    const found = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/.exec(input.files.get(path) ?? '')
    if (found) {
      issues.push(finding('geo_probe_host_in_prose', `${path} contains what looks like a probe host (${found[0]}). The reader needs the finding, not the machine it came from.`, { path, check: 'geo-probe-host' }))
    }
  }
  const platforms = [...new Set(measured.map((row) => String(row.provider ?? '').trim()).filter(Boolean))].sort()
  return {
    issues,
    metrics: {
      geoProbeRounds: rounds.length,
      geoMeasuredRounds: measured.length,
      geoFailedRounds: failed.length,
      geoUnreadableLedgerLines: unreadable,
      geoPlatformsMeasured: platforms,
      geoQuestionsMeasured: new Set(measured.map((row) => String(row.question ?? ''))).size,
    },
  }
}

/**
 * The clinical half of a content pack: the pharmacist-owned safety rules over
 * every piece a reader may be shown, one pass per piece so a hit says where it
 * is, plus the rules whose required sentence may live in any one piece, judged
 * over the whole pack. Required (the safety tier): an article is written to be
 * quoted by a machine that will not add the caveat back.
 *
 * Called, never reimplemented — a "GEO version" of these rules is how the pair
 * that drifted three times got started.
 * @param {GeoInput} input @param {readonly string[]} pieces @returns {GeoIssue[]}
 */
function contentSafetyIssues(input, pieces) {
  /** @type {GeoIssue[]} */
  const issues = []
  const seen = new Set()
  /** @type {Map<string, { path: string, line: number | null, match: string | null }>} */
  const triggerSites = new Map()
  const check = checkIdOf(clinicalSafetyRuleHits)
  for (const path of pieces) {
    const body = input.files.get(path) ?? ''
    if (!body) continue
    for (const hit of clinicalSafetyRuleHits({ reportText: body, practical: body })) {
      if (hit.where === 'trigger') {
        if (!triggerSites.has(hit.ruleId)) triggerSites.set(hit.ruleId, { path, line: hit.line, match: hit.match })
        continue
      }
      const key = `${hit.ruleId}\u0000${path}`
      if (seen.has(key)) continue
      seen.add(key)
      const where = `${path}${hit.line ? ` line ${hit.line}` : ''}${hit.match ? ` (matched "${hit.match}")` : ''}`
      issues.push(finding('clinical_safety_rule', `${where}: ${hit.message}`, { severity: 'required', path, check, rule: hit.ruleId, line: hit.line ?? undefined }))
    }
  }
  const whole = pieces.map((path) => input.files.get(path) ?? '').join('\n')
  for (const hit of clinicalSafetyRuleHits({ reportText: whole, practical: whole })) {
    if (hit.where !== 'trigger') continue
    const site = triggerSites.get(hit.ruleId)
    const where = site ? `${site.path}${site.line ? ` line ${site.line}` : ''}${site.match ? ` (triggered by "${site.match}")` : ''}: ` : ''
    issues.push(finding('clinical_safety_rule', `${where}${hit.message}`, { severity: 'required', path: site?.path, check, rule: hit.ruleId, line: site?.line ?? undefined }))
  }
  return issues
}

/**
 * `geo-content-pack` (2.0.0): layered articles and correction materials
 * (step 6). The articles are the deliverable; `articles.json` indexes them.
 * @param {GeoInput} input @param {readonly string[]} prose @returns {GeoFindings}
 */
export function geoContentFindings(input, prose) {
  /** @type {GeoIssue[]} */
  const issues = []
  const indexPath = GEO_CONTRACT_FILES.content.index
  const index = readIndex(input, indexPath, (value) => (Array.isArray(value.articles) ? null : 'has no articles[] list: the pack is that list.'), issues)
  const articles = index ? /** @type {any[]} */ (index.articles) : []
  /** @type {string[]} */ const unreadable = []
  /** @type {string[]} */ const bodies = []
  /** @type {string[]} */ const records = []
  /** @type {string[]} */ const notes = []
  /** @type {Record<string, number>} */ const byLayer = {}
  let safetyOpen = 0
  articles.forEach((article, at) => {
    const label = isRecord(article) && text(article.id) ? text(article.id) : `articles[${at}]`
    if (!isRecord(article) || !isGeoPackagePath(article.path)) { unreadable.push(label); return }
    bodies.push(article.path)
    const layer = text(article.layer)
    byLayer[layer || 'unknown'] = (byLayer[layer || 'unknown'] ?? 0) + 1
    if (isRecord(article.safety) && article.safety.status === 'open') safetyOpen += 1
    /** @type {string[]} */
    const wrong = []
    if (!ARTICLE_LAYERS.includes(layer)) wrong.push(`layer "${layer}" is not one of ${ARTICLE_LAYERS.join('/')}`)
    if (!text(article.question) && layer !== 'correction') wrong.push('answers no question')
    if (!Array.isArray(article.claimKeys) || !article.claimKeys.length) wrong.push('binds no claim')
    if (!isRecord(article.safety) || !['clear', 'open'].includes(String(article.safety.status))) wrong.push('states no safety status (clear or open)')
    if (isGeoPackagePath(article.recordPath)) records.push(article.recordPath)
    else wrong.push('names no work record')
    if (layer === 'qa') {
      const length = [...(input.files.get(article.path) ?? '').replace(/\s+/g, '')].length
      if (length && (length < QA_LENGTH.min || length > QA_LENGTH.max)) wrong.push(`is ${length} characters, where a 问答 is ${QA_LENGTH.min}–${QA_LENGTH.max}`)
    }
    if (wrong.length) notes.push(`${label} ${wrong.join(', ')}`)
  })
  if (unreadable.length) {
    issues.push(finding('deliverable_rejected', `${indexPath}: ${unreadable.length} article entr(ies) name no path inside the package (${named(unreadable)}). An article the index cannot point at is one nobody can open.`, { severity: 'required', path: indexPath, check: 'deliverable-json-parse' }))
  }
  if (index && !articles.length) {
    issues.push(finding('geo_article_notice', `${indexPath} lists no article.`, { path: indexPath, check: 'geo-article-shape' }))
  }
  namedFilesPresent(input, indexPath, bodies, issues)
  const missingRecords = records.filter((path) => input.files.get(path) == null)
  if (missingRecords.length) notes.push(`work record(s) ${named(missingRecords)} are named and absent`)
  if (notes.length) {
    issues.push(finding('geo_article_notice', `${indexPath}: ${notes.slice(0, NAMED).join('; ')}${notes.length > NAMED ? `; and ${notes.length - NAMED} more` : ''}.`, { path: indexPath, check: 'geo-article-shape' }))
  }
  // The index report and every article a reader may be shown; work records
  // are backstage and are not.
  const pieces = [...new Set([...prose.filter((path) => !path.startsWith(GEO_RECORDS_PREFIX)), ...bodies.filter((path) => input.files.has(path))])]
  issues.push(...contentSafetyIssues(input, pieces))
  const measurement = geoMeasurementNotices(input, pieces)
  issues.push(...measurement.issues)
  return {
    issues,
    metrics: {
      ...measurement.metrics,
      geoArticles: articles.length,
      geoArticlesByLayer: byLayer,
      geoArticlesSafetyOpen: safetyOpen,
    },
  }
}

// ---------------------------------------------------------------- proposal

/**
 * `geo-proposal-pack`: the client package (Excel, two Word reports, PPT,
 * HTML) or the weekly report (PDF + Word), from frozen platform data.
 * @param {GeoInput} input @returns {GeoFindings}
 */
export function geoProposalFindings(input) {
  /** @type {GeoIssue[]} */
  const issues = []
  const path = GEO_CONTRACT_FILES.proposal.index
  const index = readIndex(input, path, (value) => (Array.isArray(value.files) ? null : 'has no files[] list: the package is that list.'), issues)
  const listed = index ? /** @type {any[]} */ (index.files).filter(isRecord) : []
  const mode = text(index?.mode)
  const textFiles = listed.map((file) => file.path).filter((file) => isGeoPackagePath(file) && /\.(md|html?)$/i.test(file))
  namedFilesPresent(input, path, textFiles, issues)
  if (index) {
    /** @type {string[]} */
    const notes = []
    const unsafe = listed.filter((file) => !isGeoPackagePath(file.path)).map((file) => String(file.path ?? '?'))
    if (unsafe.length) notes.push(`file path(s) ${named(unsafe)} leave the package`)
    if (!PROPOSAL_MODES.includes(mode)) notes.push(`mode "${mode}" is not proposal or weekly`)
    else {
      /** @type {Record<string, number>} */
      const counts = {}
      for (const file of listed) {
        const kind = text(file.kind) || (String(file.path ?? '').split('.').pop() ?? '').toLowerCase()
        counts[kind] = (counts[kind] ?? 0) + 1
      }
      const short = Object.entries(PROPOSAL_KINDS[/** @type {'proposal'|'weekly'} */ (mode)])
        .filter(([kind, want]) => (counts[kind] ?? 0) < want)
        .map(([kind, want]) => `${want} ${kind}`)
      if (short.length) notes.push(`a ${mode} package hands over ${short.join(', ')} it does not list`)
    }
    if (!isRecord(index.dataset) || !text(index.dataset.frozenAt)) notes.push('names no frozen dataset (dataset.frozenAt), so its numbers cannot be traced to a snapshot')
    if (notes.length) issues.push(finding('geo_proposal_notice', `${path}: ${notes.join('; ')}.`, { path, check: 'geo-proposal-shape' }))
  }
  return {
    issues,
    metrics: {
      geoProposalFiles: listed.length,
      geoProposalMode: mode || null,
    },
  }
}
