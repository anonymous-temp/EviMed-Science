import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Fixed official APIs only. Search results must match the requested identifier exactly.
 * Unknown identifiers, ambiguous results, unavailable APIs and unbound aliases remain unknown.
 * @param {string} identity @param {any} [options] */
export async function resolvePublicationIdentity(identity, { fetchImpl = fetch, signal } = {}) {
  const raw = String(identity ?? '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').toLowerCase();
  const kind = /^10\.\d{4,9}\/[^\s<>]+$/.test(raw) ? 'doi' : /^(?:pmid:)?\d+$/.test(raw) ? 'pmid' : /^(?:pmcid:)?pmc\d+$/.test(raw) ? 'pmcid' : null;
  if (!kind) return null;
  const id = raw.replace(/^(pmid:|pmcid:)/, '');
  const deadline = AbortSignal.timeout(30000);
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const evidence = [];
  const get = async url => {
    const response = await fetchImpl(url, { signal: boundedSignal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok || Number(response.headers?.get?.('content-length') ?? 0) > 4 * 1024 * 1024) return null;
    const reader = response.body?.getReader?.();
    let bytes;
    if (reader) {
      const chunks = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 4 * 1024 * 1024) { await reader.cancel(); return null; } chunks.push(Buffer.from(next.value)); } }
      finally { reader.releaseLock(); }
      bytes = Buffer.concat(chunks);
    } else { bytes = Buffer.from(await response.text()); if (bytes.length > 4 * 1024 * 1024) return null; }
    const data = JSON.parse(bytes.toString('utf8'));
    evidence.push({ url, sha256: createHash('sha256').update(bytes).digest('hex') });
    return data;
  };
  try {
    let doi = kind === 'doi' ? id : null;
    const aliases = [kind === 'doi' ? `doi:${id}` : kind === 'pmid' ? `pmid:${id}` : id.toUpperCase()];
    if (kind !== 'doi') {
      const query = kind === 'pmid' ? `EXT_ID:${id} AND SRC:MED` : `PMCID:${id.toUpperCase()}`;
      const response = await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=2&resultType=core`);
      const rows = (response?.resultList?.result ?? []).filter(row => kind === 'pmid' ? String(row.id) === id && row.source === 'MED' : String(row.pmcid ?? '').toLowerCase() === id);
      if (rows.length !== 1) return null;
      const row = rows[0];
      doi = row.doi ? String(row.doi).toLowerCase() : null;
      if (row.source === 'MED' && /^\d+$/.test(String(row.id))) aliases.push(`pmid:${row.id}`);
      if (/^\d+$/.test(String(row.pmid ?? ''))) aliases.push(`pmid:${row.pmid}`);
      if (/^PMC\d+$/i.test(row.pmcid ?? '')) aliases.push(String(row.pmcid).toUpperCase());
    }
    if (doi) {
      if (!/^10\.\d{4,9}\/[^\s<>]+$/.test(doi)) return null;
      const crossref = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      if (String(crossref?.message?.DOI ?? '').toLowerCase() !== doi) return null;
      aliases.push(`doi:${doi}`);
    }
    const canonicalId = doi ? `doi:${doi}` : aliases.find(alias => alias.startsWith('pmid:'));
    if (!canonicalId) return null;
    const proof = { canonicalId, aliases: [...new Set(aliases)], evidence };
    return { ...proof, evidenceId: digest(proof), verified: true };
  } catch (error) { if (signal?.aborted) throw error; return null; }
}
