/** Advisory structural checks for a research-topic portfolio. */

const PORTFOLIO_FILE = 'research-portfolio.json'
const EVIDENCE_FILE = 'evidence-records.json'
const RUN_FILE = 'research-topic-run.json'
const DESIGN_FIELDS = Object.freeze([
  'hypothesis',
  'studyDesign',
  'estimand',
  'dataRequirements',
  'falsification',
  'feasibility',
  'noveltyBasis',
])

/** @typedef {import('./contractRegistry.mjs').GateInput} GateInput */
/** @typedef {import('./contractRegistry.mjs').GateIssue} GateIssue */

/** @param {unknown} value @returns {value is Record<string, any>} */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {boolean} */
function meaningful(value) {
  if (typeof value === 'string') return Boolean(value.trim())
  if (Array.isArray(value)) return value.length > 0
  return record(value) && Object.keys(value).length > 0
}

/** @param {Map<string, string>} files @param {string} path @returns {unknown} */
function parsed(files, path) {
  const source = files.get(path)
  if (source == null) return null
  try {
    return JSON.parse(source)
  } catch {
    return undefined
  }
}

/** Stable comparison for JSON values without trusting object key order.
 * @param {unknown} value @returns {unknown} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!record(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

/** @param {unknown} left @param {unknown} right @returns {boolean} */
function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

/** @param {GateIssue[]} issues @param {string} check @param {string} message @param {string} [path] */
function notice(issues, check, message, path = PORTFOLIO_FILE) {
  issues.push({
    code: 'topic_portfolio_notice',
    message,
    severity: 'advisory',
    path,
    check,
  })
}

/** @param {GateInput} input @returns {{ issues: GateIssue[], metrics: Record<string, any> }} */
export function researchTopicPortfolioFindings(input) {
  const issues = /** @type {GateIssue[]} */ ([])
  if (!input.files.has(PORTFOLIO_FILE)) return { issues, metrics: {} }

  const portfolio = parsed(input.files, PORTFOLIO_FILE)
  const baseMetrics = {
    topicPortfolio: {
      present: true,
      schemaValid: false,
      candidates: 0,
      structurallyCompleteCandidates: 0,
      unresolvedDesignFields: 0,
      evidenceReconciled: false,
      contextMatchesReceipt: false,
    },
  }
  if (!record(portfolio)) {
    notice(issues, 'topic-portfolio-schema', `${PORTFOLIO_FILE} must contain a JSON object with schemaVersion 1.0.0.`)
    return { issues, metrics: baseMetrics }
  }
  const candidates = Array.isArray(portfolio.candidates) ? portfolio.candidates : null
  if (portfolio.schemaVersion !== '1.0.0' || !meaningful(portfolio.researchDirection)
    || !record(portfolio.researchContext) || candidates === null) {
    notice(issues, 'topic-portfolio-schema', `${PORTFOLIO_FILE} must declare schemaVersion 1.0.0, researchDirection, researchContext, and candidates[].`)
    return { issues, metrics: baseMetrics }
  }

  const evidenceValue = parsed(input.files, EVIDENCE_FILE)
  const evidenceById = new Map(
    Array.isArray(evidenceValue)
      ? evidenceValue
        .filter((item) => record(item) && typeof item.id === 'string' && item.id.trim())
        .map((item) => [item.id, item])
      : [],
  )
  let evidenceReconciled = Array.isArray(evidenceValue)
  if (!Array.isArray(evidenceValue)) {
    notice(issues, 'topic-evidence-lineage', `${EVIDENCE_FILE} is missing or invalid, so candidate source lineage cannot be reconciled.`, EVIDENCE_FILE)
  }

  let structurallyCompleteCandidates = 0
  let unresolvedDesignFields = 0
  for (const [index, candidate] of candidates.entries()) {
    const label = `candidates[${index}]`
    if (!record(candidate) || !meaningful(candidate.candidateId) || !meaningful(candidate.title)
      || !meaningful(candidate.sourceOpportunityId) || !['direct', 'indirect', 'speculative'].includes(candidate.supportLevel)
      || !Array.isArray(candidate.sourceEvidenceIds) || candidate.sourceEvidenceIds.length === 0
      || candidate.sourceEvidenceIds.some((id) => typeof id !== 'string' || !id.trim())
      || !Array.isArray(candidate.sourceEvidencePmids)
      || candidate.sourceEvidencePmids.some((id) => typeof id !== 'string' || !id.trim())
      || !Array.isArray(candidate.gaps) || candidate.gaps.some((gap) => typeof gap !== 'string')) {
      notice(issues, 'topic-portfolio-schema', `${label} is missing its candidate identity, opportunity lineage, support level, evidence ids, or gaps array.`)
      evidenceReconciled = false
      continue
    }
    const unknown = candidate.sourceEvidenceIds.filter((id) => !evidenceById.has(id))
    if (unknown.length) {
      notice(issues, 'topic-evidence-lineage', `${label} names ${unknown.length} source evidence id(s) that do not resolve to ${EVIDENCE_FILE}.`)
      evidenceReconciled = false
    }
    const preservedPmids = candidate.sourceEvidenceIds
      .map((id) => evidenceById.get(id)?.pmid)
      .filter((pmid) => typeof pmid === 'string' && pmid.trim())
    if (!sameJson(candidate.sourceEvidencePmids, preservedPmids)) {
      notice(issues, 'topic-evidence-lineage', `${label}.sourceEvidencePmids does not match the PMID values of its preserved source evidence ids.`)
      evidenceReconciled = false
    }
    const missing = DESIGN_FIELDS.filter((field) => !meaningful(candidate[field]))
    unresolvedDesignFields += missing.length
    const declared = new Set(candidate.gaps)
    const undeclared = missing.filter((field) => !declared.has(field))
    const falseGaps = candidate.gaps.filter((field) => DESIGN_FIELDS.includes(field) && !missing.includes(field))
    const unknownGaps = candidate.gaps.filter((field) => !DESIGN_FIELDS.includes(field))
    if (undeclared.length || falseGaps.length || unknownGaps.length) {
      notice(issues, 'topic-study-plan', `${label}.gaps must exactly expose absent design fields; unresolved: ${missing.join(', ') || 'none'}.`)
    }
    if (missing.length) {
      notice(issues, 'topic-study-plan', `${label} remains provisional because ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unresolved.`)
    } else {
      structurallyCompleteCandidates += 1
    }
  }

  const runValue = parsed(input.files, RUN_FILE)
  const contextMatchesReceipt = record(runValue) && record(runValue.researchContext)
    && sameJson(portfolio.researchContext, runValue.researchContext)
  if (!contextMatchesReceipt) {
    notice(issues, 'topic-research-context', `${PORTFOLIO_FILE}.researchContext does not match the validated context in ${RUN_FILE}.`, RUN_FILE)
  }

  return {
    issues,
    metrics: {
      topicPortfolio: {
        present: true,
        schemaValid: !issues.some((item) => item.check === 'topic-portfolio-schema'),
        candidates: candidates.length,
        structurallyCompleteCandidates,
        unresolvedDesignFields,
        evidenceReconciled,
        contextMatchesReceipt,
      },
    },
  }
}
