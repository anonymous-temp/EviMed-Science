/** Cloud permission and reversible, study-scoped text projections.
 * This is a span transformer, not a claim to detect identifiers in free text.
 * The source owner supplies the reviewed spans or an already deidentified source.
 *
 * A document may reach the configured model providers under one of two bases, and the basis is recorded wherever a read is:
 * the deployment's own record of the agreements it holds with those providers (`deploymentCloudPermission`, on by default,
 * 2026-10-10 owner ruling), or a permission an operator recorded for one source. An operator restricts a source by revoking
 * it, and nothing overrides that.
 */
import { createHash, createHmac } from 'node:crypto';
import { HttpError } from './security.mjs';

/** @param {string} text */
export const projectionHash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const kinds = ['person', 'identifier', 'address', 'contact', 'organization'];
/** @param {string} code */
const invalid = code => new HttpError(400, code, 'The cloud permission or reviewed projection is invalid.');
/** @param {unknown} input */
export function cloudOrigin(input) {
  try {
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

/** The data classes a record may state. The last two are patient text, so their terms are held to the private-terms rule. */
export const CLOUD_DATA_CLASSES = Object.freeze(['public', 'synthetic', 'deidentified', 'clinical']);
const PATIENT_CLASSES = Object.freeze(['deidentified', 'clinical']);
/** What a projection reviewed under the deployment's agreements carries as its permission hash: there is no record to hash. */
export const DEPLOYMENT_PERMISSION_HASH = 'deployment_agreements';
const DEFAULT_AGREEMENT_REFERENCE = 'Deployment agreements with the configured model providers: no retention, no training, no human review';

/** An attestation records what an authorized operator verified; it does not verify a provider's terms.
 * `{ status: 'default' }` clears the record: the source then follows the deployment's agreements.
 * @param {any} value @param {string} actor @param {string} at */
export function cloudPermission(value, actor, at) {
  const fields = ['status', 'dataClass', 'destinations', 'purpose', 'reference', 'retention', 'training', 'humanReview', 'expiresAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw invalid('vcr_cloud_permission_invalid');
  if (value.status === 'default' && Object.keys(value).length === 1) return null;
  if (value.status === 'revoked') return { schema: 1, status: 'revoked', actor, verifiedAt: at };
  if (value.status !== 'approved' || !CLOUD_DATA_CLASSES.includes(value.dataClass)
    || value.purpose !== 'vcr' || typeof value.reference !== 'string' || !value.reference.trim() || value.reference.length > 500
    || !Array.isArray(value.destinations) || !value.destinations.length || value.destinations.length > 10
    || value.destinations.some((/** @type {any} */ d) => cloudOrigin(d) !== d)
    || !['none', 'limited', 'unknown'].includes(value.retention)
    || !['disabled', 'unknown'].includes(value.training) || !['disabled', 'unknown'].includes(value.humanReview)
    || value.expiresAt != null && !Number.isFinite(Date.parse(value.expiresAt))) throw invalid('vcr_cloud_permission_invalid');
  return { schema: 1, status: 'approved', purpose: 'vcr', dataClass: value.dataClass,
    destinations: [...new Set(value.destinations)].sort(), reference: value.reference.trim(), retention: value.retention,
    training: value.training, humanReview: value.humanReview, expiresAt: value.expiresAt ?? null, actor, verifiedAt: at };
}

/**
 * The deployment's record of the agreements it holds with the model providers it is configured to call: no retention, no
 * training, no human review, for the destinations the model gateway and the configured reviewers reach, for identifiable
 * patient text as well as de-identified text. Null where the deployment does not claim them (`vcrProviderAgreements` off) or
 * has no destination to claim them for.
 * @param {any} config
 */
export function deploymentCloudPermission(config) {
  if (config?.vcrProviderAgreements !== true) return null;
  const destinations = vcrCloudDestinations(config);
  if (!destinations.length) return null;
  const reference = String(config.vcrProviderAgreementReference ?? '').trim().slice(0, 500) || DEFAULT_AGREEMENT_REFERENCE;
  return { schema: 1, status: 'approved', purpose: 'vcr', dataClass: 'clinical', destinations: [...destinations].sort(), reference,
    retention: 'none', training: 'disabled', humanReview: 'disabled', expiresAt: null, actor: 'deployment', basis: 'deployment_agreements' };
}

/** @param {any} policy @param {string[]} destinations @param {string} at */
function holds(policy, destinations, at) {
  const ready = policy?.schema === 1 && policy.status === 'approved' && policy.purpose === 'vcr'
    && destinations.length && destinations.every(origin => policy.destinations?.includes(origin))
    && (!policy.expiresAt || Date.parse(policy.expiresAt) > Date.parse(at));
  const privateTerms = !PATIENT_CLASSES.includes(policy?.dataClass) || policy.retention === 'none'
    && policy.training === 'disabled' && policy.humanReview === 'disabled';
  return Boolean(ready && privateTerms);
}

/**
 * Whether a document may go to `destinations`, and on which basis: a revoked record is a restriction nothing overrides; a
 * source's own approved record stands as it always has; otherwise the deployment's agreements, when it holds them. A refusal
 * is a named code and costs only this operation.
 * @param {any} policy the source's recorded permission, or null
 * @param {string[]} destinations @param {string} at @param {any} [deployment] `deploymentCloudPermission(config)`
 * @returns {{ basis: 'source_permission' | 'deployment_agreements', permission: any }}
 */
export function cloudAuthorization(policy, destinations, at, deployment = null) {
  if (policy?.status !== 'revoked') {
    if (holds(policy, destinations, at)) return { basis: 'source_permission', permission: policy };
    if (deployment && holds(deployment, destinations, at)) return { basis: 'deployment_agreements', permission: deployment };
  }
  throw notAuthorized();
}

/**
 * Where a source stands for the page, without throwing: `allowed` on a basis, `restricted` (an operator revoked it), or `closed`
 * (no permission recorded and no agreements to stand on).
 * @param {any} policy @param {string[]} destinations @param {string} at @param {any} [deployment]
 * @returns {{ state: 'allowed', basis: 'source_permission' | 'deployment_agreements' } | { state: 'restricted' | 'closed', basis: null }}
 */
export function cloudState(policy, destinations, at, deployment = null) {
  if (policy?.status === 'revoked') return { state: 'restricted', basis: null };
  try {
    return { state: 'allowed', basis: cloudAuthorization(policy, destinations, at, deployment).basis };
  } catch {
    return { state: 'closed', basis: null };
  }
}

/** The refusal of a document that may not go to the cloud: this operation only, never the study. */
export function notAuthorized() {
  return new HttpError(403, 'vcr_cloud_processing_not_authorized',
    'This document has no applicable cloud processing permission. Other study work can continue.');
}

/** @param {any} policy @param {string[]} destinations @param {string} at @param {any} [deployment] */
export function requireCloudPermission(policy, destinations, at, deployment = null) {
  cloudAuthorization(policy, destinations, at, deployment);
}

/** @param {string} value @param {number} offset */
function boundary(value, offset) {
  return offset === 0 || offset === value.length || !(value.charCodeAt(offset - 1) >= 0xD800 && value.charCodeAt(offset - 1) <= 0xDBFF
    && value.charCodeAt(offset) >= 0xDC00 && value.charCodeAt(offset) <= 0xDFFF);
}

/** @param {{text:string, spans:any[], key:Buffer, attestation:string}} input */
export function buildCloudProjection({ text, spans, key, attestation }) {
  if (!Array.isArray(spans) || spans.length > 10_000 || !attestation?.trim() || attestation.length > 500) throw invalid('vcr_projection_invalid');
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let cursor = 0; let projected = '';
  /** @type {any[]} */
  const segments = [];
  /** @param {number} start @param {number} end @param {string} output @param {boolean} replaced */
  const append = (start, end, output, replaced) => {
    if (end === start) return;
    segments.push({ originalStart: start, originalEnd: end, start: projected.length, end: projected.length + output.length, replaced });
    projected += output;
  };
  for (const span of ordered) {
    if (Object.keys(span).some(k => !['start', 'end', 'kind'].includes(k)) || !kinds.includes(span.kind)
      || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < cursor || span.end <= span.start
      || span.end > text.length || !boundary(text, span.start) || !boundary(text, span.end)) throw invalid('vcr_projection_span_invalid');
    append(cursor, span.start, text.slice(cursor, span.start), false);
    const surrogate = createHmac('sha256', key).update(`${span.kind}\0${text.slice(span.start, span.end)}`).digest('hex').slice(0, 16);
    append(span.start, span.end, `[${span.kind}:${surrogate}]`, true);
    cursor = span.end;
  }
  append(cursor, text.length, text.slice(cursor), false);
  return { schema: 1, offsetUnit: 'utf16', sourceHash: projectionHash(text), projectionHash: projectionHash(projected),
    text: projected, segments, attestation, dateShift: null };
}

/** Restore only inside the protected plane; never send this result to a model.
 * A partial surrogate cannot identify an original substring.
 * @param {any} projection @param {string} original @param {{start:number,end:number,quote:string}} span */
export function originalProjectionSpan(projection, original, span) {
  if (projectionHash(original) !== projection.sourceHash || projectionHash(projection.text) !== projection.projectionHash
    || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start
    || projection.text.slice(span.start, span.end) !== span.quote || !boundary(projection.text, span.start) || !boundary(projection.text, span.end)) throw invalid('vcr_projection_quote_invalid');
  const first = projection.segments.find((/** @type {any} */ s) => span.start >= s.start && span.start < s.end);
  const last = projection.segments.find((/** @type {any} */ s) => span.end > s.start && span.end <= s.end);
  if (!first || !last || first.replaced && span.start !== first.start || last.replaced && span.end !== last.end) throw invalid('vcr_projection_quote_invalid');
  const start = first.replaced ? first.originalStart : first.originalStart + span.start - first.start;
  const end = last.replaced ? last.originalEnd : last.originalStart + span.end - last.start;
  return { start, end, quote: original.slice(start, end), sourceHash: projection.sourceHash, offsetUnit: 'utf16' };
}

/** @param {any} config */
export function vcrCloudDestinations(config) {
  // All configured model reviewers are included: a projected report may reach them too.
  return [...new Set([config.deepseekBaseUrl, config.reviewApiBase, config.reviewJevApiBase].filter(Boolean).map(cloudOrigin))].filter((/** @type {any} */ v) => v !== null);
}
