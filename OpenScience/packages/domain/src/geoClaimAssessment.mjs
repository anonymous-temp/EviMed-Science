import { canonicalJson } from './capsule.mjs'

/** The known applicability of a preserved claim; missing statement metadata remains unknown. @param {any} value */
export function geoClaimApplicability(value) {
  const source = value && typeof value === 'object' ? value : {}
  const conditions = Object.hasOwn(source, 'applicability') ? source.applicability : source.id && !Object.hasOwn(source, 'claimId') && (Object.hasOwn(source, 'quote') || Object.hasOwn(source, 'version')) ? source : null
  if (!conditions || typeof conditions !== 'object') return null
  return { population: conditions.population ?? null, elements: conditions.elements ?? null, inLabel: conditions.inLabel ?? null,
    validUntil: conditions.validUntil ?? null, evidenceLevel: conditions.evidenceLevel ?? null }
}

/** Exact claim/version/conditions, shared by judgment, error identity and answer presentation. @param {any} value */
export function geoClaimAssessmentIdentity(value) {
  const source = value && typeof value === 'object' ? value : {}
  const claimId = Object.hasOwn(source, 'claimId') ? source.claimId ?? null
    : Object.hasOwn(source, 'quote') || Object.hasOwn(source, 'version') ? source.id ?? null : null
  return canonicalJson({ claimId, claimKey: claimId ? null : source.claimKey ?? source.key ?? null,
    version: source.claimVersion ?? source.version ?? null, applicability: geoClaimApplicability(source) })
}

/** Exact answer sentence and preserved claim identity. @param {any} value */
export function geoStatementAssessmentIdentity(value) {
  return canonicalJson({ text: String(value?.text ?? '').trim(), claim: JSON.parse(geoClaimAssessmentIdentity(value)) })
}

/** Legacy statements may resolve only when the preserved claim choice is unambiguous. @param {any[]} claims @param {any} statement */
export function geoClaimForStatement(claims, statement) {
  if (!statement?.claimId) return null
  const candidates = claims.filter(claim => claim.id === statement.claimId
    && (statement.claimVersion == null || claim.version === statement.claimVersion)
    && (statement.applicability == null || canonicalJson(geoClaimApplicability(claim)) === canonicalJson(geoClaimApplicability(statement))))
  return candidates.length === 1 ? candidates[0] : null
}
