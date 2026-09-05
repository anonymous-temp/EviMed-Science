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

/** @param {unknown} value @returns {value is string} */
function nonEmpty(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

/** @param {unknown} value @returns {boolean} */
function meaningfulDescription(value) {
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

/** Validate the same bounded context shape the specialist transport accepts.
 * @param {unknown} value @returns {Record<string, any> | null} */
function normalizedContext(value) {
  if (!record(value)) return null
  /** @type {Record<string, number>} */
  const textLimits = { availableData: 4000, population: 1000, studySetting: 1000 }
  const allowed = new Set([...Object.keys(textLimits), 'resourceConstraints'])
  if (Object.keys(value).some((key) => !allowed.has(key))) return null
  /** @type {Record<string, any>} */
  const output = {}
  for (const key of Object.keys(textLimits)) {
    if (!Object.hasOwn(value, key)) continue
    if (!nonEmpty(value[key]) || value[key].length > textLimits[key]) return null
    output[key] = value[key]
  }
  if (Object.hasOwn(value, 'resourceConstraints')) {
    const constraints = value.resourceConstraints
    if (!Array.isArray(constraints) || constraints.length > 20
      || constraints.some((item) => !nonEmpty(item) || item.length > 200)) return null
    output.resourceConstraints = [...constraints]
  }
  return output
}

/** @param {unknown} left @param {unknown} right @returns {boolean} */
function sameContext(left, right) {
  const leftContext = normalizedContext(left)
  const rightContext = normalizedContext(right)
  return leftContext !== null && rightContext !== null
    && JSON.stringify(leftContext) === JSON.stringify(rightContext)
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
      evidenceFilesConsistent: false,
      contextFilesConsistent: false,
    },
  }
  if (!record(portfolio)) {
    notice(issues, 'topic-portfolio-schema', `${PORTFOLIO_FILE} must contain a JSON object with schemaVersion 1.0.0.`)
    return { issues, metrics: baseMetrics }
  }
  const candidates = Array.isArray(portfolio.candidates) ? portfolio.candidates : null
  const portfolioContext = normalizedContext(portfolio.researchContext)
  if (portfolio.schemaVersion !== '1.0.0' || !nonEmpty(portfolio.researchDirection) || candidates === null) {
    notice(issues, 'topic-portfolio-schema', `${PORTFOLIO_FILE} must declare schemaVersion 1.0.0, researchDirection, researchContext, and candidates[].`)
    return { issues, metrics: baseMetrics }
  }
  if (portfolioContext === null) {
    notice(issues, 'topic-research-context', `${PORTFOLIO_FILE}.researchContext must use the bounded fields accepted by the specialist transport.`)
    return { issues, metrics: baseMetrics }
  }

  const evidenceValue = parsed(input.files, EVIDENCE_FILE)
  const evidenceById = new Map()
  let evidenceFilesConsistent = Array.isArray(evidenceValue)
  if (!Array.isArray(evidenceValue)) {
    notice(issues, 'topic-evidence-lineage', `${EVIDENCE_FILE} is missing or invalid, so candidate source lineage cannot be reconciled.`, EVIDENCE_FILE)
  } else {
    for (const [index, item] of evidenceValue.entries()) {
      if (!record(item) || !nonEmpty(item.id) || item.id !== item.id.trim()) {
        notice(issues, 'topic-evidence-lineage', `${EVIDENCE_FILE}[${index}] needs a trimmed string id.`, EVIDENCE_FILE)
        evidenceFilesConsistent = false
        continue
      }
      if (evidenceById.has(item.id)) {
        notice(issues, 'topic-evidence-lineage', `${EVIDENCE_FILE} contains duplicate evidence record id ${item.id}.`, EVIDENCE_FILE)
        evidenceFilesConsistent = false
        continue
      }
      evidenceById.set(item.id, item)
    }
  }

  let structurallyCompleteCandidates = 0
  let unresolvedDesignFields = 0
  const candidateIds = new Set()
  const opportunityIds = new Set()
  for (const [index, candidate] of candidates.entries()) {
    const label = `candidates[${index}]`
    if (!record(candidate) || !nonEmpty(candidate.candidateId) || candidate.candidateId !== candidate.candidateId.trim()
      || !nonEmpty(candidate.title) || !nonEmpty(candidate.sourceOpportunityId)
      || candidate.sourceOpportunityId !== candidate.sourceOpportunityId.trim()
      || !['direct', 'indirect', 'speculative'].includes(candidate.supportLevel)
      || !Array.isArray(candidate.sourceEvidenceIds) || candidate.sourceEvidenceIds.length === 0
      || candidate.sourceEvidenceIds.some((id) => !nonEmpty(id) || id !== id.trim())
      || !Array.isArray(candidate.sourceEvidencePmids)
      || candidate.sourceEvidencePmids.some((id) => !nonEmpty(id) || id !== id.trim())
      || !Array.isArray(candidate.gaps) || candidate.gaps.some((gap) => typeof gap !== 'string')) {
      notice(issues, 'topic-portfolio-schema', `${label} is missing its candidate identity, opportunity lineage, support level, evidence ids, or gaps array.`)
      evidenceFilesConsistent = false
      continue
    }
    if (candidateIds.has(candidate.candidateId) || opportunityIds.has(candidate.sourceOpportunityId)) {
      notice(issues, 'topic-portfolio-schema', `${label} has a duplicate candidateId or sourceOpportunityId.`)
      evidenceFilesConsistent = false
      continue
    }
    candidateIds.add(candidate.candidateId)
    opportunityIds.add(candidate.sourceOpportunityId)
    if (new Set(candidate.sourceEvidenceIds).size !== candidate.sourceEvidenceIds.length) {
      notice(issues, 'topic-evidence-lineage', `${label}.sourceEvidenceIds contains duplicates.`)
      evidenceFilesConsistent = false
    }
    const unknown = candidate.sourceEvidenceIds.filter((id) => !evidenceById.has(id))
    if (unknown.length) {
      notice(issues, 'topic-evidence-lineage', `${label} names ${unknown.length} source evidence id(s) that do not resolve to ${EVIDENCE_FILE}.`)
      evidenceFilesConsistent = false
    }
    const preservedPmids = candidate.sourceEvidenceIds
      .map((id) => evidenceById.get(id)?.pmid)
      .filter((pmid) => typeof pmid === 'string' && pmid.trim())
    if (JSON.stringify(candidate.sourceEvidencePmids) !== JSON.stringify(preservedPmids)) {
      notice(issues, 'topic-evidence-lineage', `${label}.sourceEvidencePmids does not match the PMID values of its preserved source evidence ids.`)
      evidenceFilesConsistent = false
    }
    const missing = DESIGN_FIELDS.filter((field) => !meaningfulDescription(candidate[field]))
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
  const contextFilesConsistent = record(runValue)
    && sameContext(portfolioContext, runValue.researchContext)
  if (!contextFilesConsistent) {
    notice(issues, 'topic-research-context', `${PORTFOLIO_FILE}.researchContext and ${RUN_FILE}.researchContext are not internally consistent; authoritative request preservation is established by the transport receipt, not this file comparison.`, RUN_FILE)
  }

  return {
    issues,
    metrics: {
      topicPortfolio: {
        present: true,
        schemaValid: !issues.some((item) => item.check === 'topic-portfolio-schema'),
        candidates: candidateIds.size,
        structurallyCompleteCandidates,
        unresolvedDesignFields,
        evidenceFilesConsistent,
        contextFilesConsistent,
      },
    },
  }
}
