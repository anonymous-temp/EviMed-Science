import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicationIdentity } from '../src/evolutionPublicationIdentity.mjs';
import { recordResearchPromotion } from '../src/evolutionResearchPromotion.mjs';

test('fixed official identity resolution binds DOI, PMID and PMC without trusting search similarity', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(new URL(url));
    return new Response(JSON.stringify(url.includes('crossref.org') ? { message: { DOI: '10.1234/example' } }
      : { resultList: { result: [{ id: '123', source: 'MED', pmcid: 'PMC456', doi: '10.1234/example' }] } }), { status: 200 });
  };
  for (const id of ['DOI:10.1234/Example', '123', 'PMID:123', 'PMC456']) {
    const result = await resolvePublicationIdentity(id, { fetchImpl });
    assert.equal(result.canonicalId, 'doi:10.1234/example'); assert.equal(result.verified, true); assert.match(result.evidenceId, /^[a-f0-9]{64}$/);
  }
  assert.ok(urls.every(url => ['api.crossref.org', 'www.ebi.ac.uk'].includes(url.hostname)));
  assert.equal(await resolvePublicationIdentity('PMID:999', { fetchImpl }), null);
  assert.equal(await resolvePublicationIdentity('https://private.example/paper', { fetchImpl }), null);
  assert.equal(await resolvePublicationIdentity('10.1234/example', { fetchImpl: async () => new Response(JSON.stringify({ message: { DOI: '10.1234/unrelated' } })) }), null);
  assert.equal(await resolvePublicationIdentity('PMC456', { fetchImpl: async () => new Response(JSON.stringify({ resultList: { result: [{ pmcid: 'PMC456', source: 'PMC', id: 'PMC456' }] } })) }), null);
});

test('aliases cannot count as five papers and unavailable identities cannot promote', async () => {
  const records = new Map(); let assessment;
  const uses = [], units = [];
  for (const identity of ['10.1234/example', 'PMID:123', 'PMC456', 'DOI:10.1234/EXAMPLE', '123']) for (let replicate = 0; replicate < 2; replicate++) {
    const runId = `${identity}-${replicate}`;
    uses.push({ payload: { projectId: 'project', runId, toolId: 'tool', digest: 'pin', result: { ok: true } } });
    const goldSourceHash = String(replicate).repeat(64);
    units.push({ publishedPaperId: identity, type: 'research', group: 'time-holdout', caseId: identity, producerProjectId: 'project', producerRunId: runId,
      fullResearchReproductionValid: true, codeVerified: true, verificationProof: { kind: 'isolated-independent-replay', replicates: 2, sourceHash: goldSourceHash, proofHash: 'a'.repeat(64) },
      independent: true, retracted: false, exposureTier: 'unexposed', goldSourceHash });
  }
  const tool = { id: 'tool', payload: { artifactDigest: 'pin', validationLevel: 'V0' } };
  const service = { withLock: async (_key, fn) => fn(), list: async type => type === 'use' ? uses : [...records.values()], get: async id => id === 'tool' ? tool : records.get(id),
    now: () => new Date('2026-10-04'), save: async (_type, id, payload) => { const row = { id, payload }; records.set(id, row); return row; }, recordAssessment: async (_id, value) => { assessment = value; } };
  const input = { service, userId: 'owner', toolId: 'tool', artifactDigest: 'pin', report: { units } };
  assert.equal((await recordResearchPromotion({ ...input, canonicalize: async () => null })).papers, 0);
  const result = await recordResearchPromotion({ ...input, canonicalize: async () => ({ verified: true, canonicalId: 'doi:10.1234/example', evidenceId: 'official-proof' }) });
  assert.equal(result.papers, 1); assert.equal(assessment.papers, 1); assert.equal(records.size, 1);
  assert.equal((await recordResearchPromotion({ ...input, canonicalize: async () => null })).papers, 0);
});
