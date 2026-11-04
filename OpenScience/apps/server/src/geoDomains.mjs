export { dnsKey, registrableDomain } from '@evimed/domain';
import { dnsKey, registrableDomain } from '@evimed/domain';

/** Current evidence gate for a new placement; it does not apply to accepted orders. @param {any} media */
export function geoMediaProofProblem(media) {
  if (!media?.domain || !media.caseLink || !media.flags?.domainFinalHost
    || !Number.isFinite(Date.parse(String(media.flags?.domainCheckedAt ?? '')))) return 'missing';
  let caseHost;
  try { caseHost = new URL(media.caseLink).hostname; } catch { return 'missing'; }
  const domain = dnsKey(media.domain);
  const mismatch = !domain || registrableDomain(domain) !== domain || registrableDomain(caseHost) !== domain
    || registrableDomain(media.flags.domainFinalHost) !== domain;
  if (mismatch && (media.domainVerified === true || media.flags?.domainCheck === 'left_domain')) return 'mismatch';
  if (media.domainVerified !== true || media.flags?.domainCheck !== 'ok') return 'missing';
  if (mismatch) return 'mismatch';
  return null;
}
