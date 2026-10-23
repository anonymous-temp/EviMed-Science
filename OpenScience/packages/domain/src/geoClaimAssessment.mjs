import { canonicalJson } from './capsule.mjs'

/** The known applicability of a preserved claim; missing statement metadata remains unknown. @param {any} value */
export function geoClaimApplicability(value) {
  const source = value && typeof value === 'object' ? value : {}
  const conditions = Object.hasOwn(source, 'applicability') ? source.applicability : source.id ? source : null
  if (!conditions || typeof conditions !== 'object') return null
  return { population: conditions.population ?? null, elements: conditions.elements ?? null, inLabel: conditions.inLabel ?? null,
    validUntil: conditions.validUntil ?? null, evidenceLevel: conditions.evidenceLevel ?? null }
}

/** Exact claim/version/conditions, shared by judgment, error identity and answer presentation. @param {any} value */
export function geoClaimAssessmentIdentity(value) {
  const source = value && typeof value === 'object' ? value : {}
  const claimId = source.claimId ?? source.id ?? null
  return canonicalJson({ claimId, claimKey: claimId ? null : source.claimKey ?? source.key ?? null,
    version: source.claimVersion ?? source.version ?? null, applicability: geoClaimApplicability(source) })
}
