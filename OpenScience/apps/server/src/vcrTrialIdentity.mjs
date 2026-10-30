/** The independent trial unit is distinct from the document that reports it. */
/** @type {Record<string, RegExp>} */
const registryIdentifiers = {
  'clinicaltrials.gov': /^NCT\d{8}$/i,
  chictr: /^ChiCTR[A-Z0-9-]{3,58}$/i,
  ctis: /^\d{4}-\d{6}-\d{2}-\d{2}$/,
};
/** @param {unknown} registry @param {unknown} id */
const registryKey = (registry, id) => {
  const kind = String(registry).toLowerCase() === 'ctgov' ? 'clinicaltrials.gov' : String(registry).toLowerCase();
  return registryIdentifiers[kind]?.test(String(id)) ? `${kind}:${String(id).toUpperCase()}` : null;
};
/** @param {string} quote @param {string} identity */
const identityInQuote = (quote, identity) => new RegExp(`(?<![\\p{L}\\p{N}_-])${identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'iu').test(quote);

/** Canonical, preserved trial identity. An evidence item id is never a study identity. */
/** @param {any} item */
export function evidenceTrialIdentity(item) {
  const declared = item?.trial_identity ?? item?.detail?.trialIdentity;
  const registered = typeof declared === 'string' && /^(clinicaltrials\.gov|chictr|ctis):([A-Z0-9-]+)$/i.exec(declared);
  if (registered) return registryKey(registered[1], registered[2]);
  if (typeof declared === 'string' && declared.startsWith('trial:') && declared.length > 6 && declared.length <= 256) return declared;
  const source = String(item?.source_ref ?? item?.sourceRef ?? '');
  const match = /^(clinicaltrials\.gov|ctgov|chictr|ctis):([a-z0-9-]+)$/i.exec(source);
  return match ? registryKey(match[1], match[2]) : null;
}

/** Registry records establish their identity; literature must bind its named trial to an exact preserved span. */
/** @param {{asked:any, registry:string, registryId:string, literature:any}} input */
export function bindEvidenceTrialIdentity({ asked, registry, registryId, literature }) {
  if (!literature) return registryKey(registry, registryId);
  if (asked == null) return null;
  if (!asked || typeof asked !== 'object' || Array.isArray(asked)
    || Object.keys(asked).some(key => !['registry', 'registryId', 'trialKey'].includes(key))) throw new TypeError('trial_identity_invalid');
  const span = literature.locator.parts?.trialIdentity;
  if (!span?.quote) throw new TypeError('trial_identity_span_required');
  if (asked.trialKey != null) {
    if (asked.registry != null || asked.registryId != null || typeof asked.trialKey !== 'string') throw new TypeError('trial_identity_invalid');
    const key = asked.trialKey.normalize('NFKC').trim();
    if (key.length < 2 || key.length > 240 || [...key].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !identityInQuote(span.quote.normalize('NFKC'), key)) throw new TypeError('trial_identity_not_in_source');
    for (const [kind, pattern] of Object.entries(registryIdentifiers)) if (pattern.test(key)) return registryKey(kind, key);
    return `trial:${key.toLowerCase()}`;
  }
  const key = registryKey(asked.registry, asked.registryId);
  const id = String(asked.registryId ?? '');
  if (!key || !identityInQuote(span.quote, id)) {
    throw new TypeError('trial_identity_not_in_source');
  }
  return key;
}

/** Stable first occurrence wins; the caller receives every excluded duplicate and its retained evidence id. */
/** @param {readonly any[]} items */
export function independentTrialItems(items) {
  const seen = new Map(); const selected = []; const excluded = [];
  for (const item of items ?? []) {
    const identity = evidenceTrialIdentity(item);
    if (!identity) { excluded.push({ item, reason: 'trial_identity_missing' }); continue; }
    if (seen.has(identity)) { excluded.push({ item, reason: 'duplicate_trial', retainedId: seen.get(identity) }); continue; }
    seen.set(identity, String(item.id)); selected.push(item);
  }
  return { selected, excluded };
}
