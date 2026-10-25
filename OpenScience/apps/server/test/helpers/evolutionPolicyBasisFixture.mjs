import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { evolutionServiceFixture } from './evolutionServiceFixture.mjs';
import { evolutionRecordPin } from '../../src/evolutionRecordPins.mjs';
import { createEvolutionPolicyBasis } from '../../src/evolutionPolicyBasis.mjs';
import { validEvolutionFailureReproduction } from '../../src/evolutionMissions.mjs';

const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const textHash = value => createHash('sha256').update(value).digest('hex');
export async function policyBasisFixture({ providedService = null, sourceChanges = null } = {}) {
  const service = providedService ?? evolutionServiceFixture().service, history = new Map();
  if (!providedService) {
    const save = service.save.bind(service);
    service.save = async (...args) => { const row = await save(...args); history.set(`${row.id}:${row.revision}`, structuredClone(row)); return row; };
    service.documents.history = async (_owner, _kind, id, { beforeRevision, limit }) => [...history.values()].filter(row => row.id === id && row.revision < beforeRevision).sort((a, b) => b.revision - a.revision).slice(0, limit);
  }
  const notices = new Map(), cases = [{ id: 'smoke-a', answer: 'Fixture A' }, { id: 'smoke-b', answer: 'Fixture B' }];
  const basis = createEvolutionPolicyBasis({ service, sourceChanges: () => sourceChanges ?? ({ getMany: async ids => new Map(ids.map(id => [id, notices.get(id) ?? { state: 'unknown', changes: [] }])) }), calibrationCases: async () => cases, verifyReproduction: validEvolutionFailureReproduction });
  const anchors = [];
  for (const definition of cases) {
    const text = JSON.stringify(definition), sourceHash = textHash(text), sourceRoot = `development:geo:${definition.id}`;
    const source = await service.save('resource-asset', `source-${definition.id}`, { scope: 'public', sourceKind: 'repo-calibration', sourceRoot, sourceHash, text, fixtureId: definition.id });
    anchors.push(await service.save('task', definition.id, { ...definition, moduleId: 'geo', scope: 'public', sourceKind: 'repo-calibration', sourceRoot, sourceHash, sourceAssetRef: evolutionRecordPin(source), baselineKnownCorrect: true, pool: 'development' }));
  }
  const tasks = [], sources = [];
  for (let i = 0; i < 30; i++) {
    const text = `Public fixture abstract ${i}.`, sourceHash = textHash(text), sourceRoot = `doi:10.1234/paper-${i}`;
    const metadata = JSON.stringify({ doi: sourceRoot, published: '2026-10-03' }), sha256 = textHash(metadata);
    const provenance = await service.save('public-source-version', `chronology-${i}`, { sha256, bodyBase64: Buffer.from(metadata).toString('base64') });
    const provenanceEvidence = [{ id: provenance.id, sha256 }];
    const source = await service.save('resource-asset', `source-${i}`, { scope: 'public', sourceKind: 'public-abstract', sourceRoot, sourceHash, text, provenanceEvidence, firstPublicEvidenceId: provenance.id }); sources.push(source);
    tasks.push(await service.save('task', `task-${i}`, { id: `input-${i}`, moduleId: 'geo', scope: 'public', pool: 'confirmation', sourceRoot, sourceHash,
      sourceAssetRef: evolutionRecordPin(source), sourceIdentifiers: [sourceRoot], taskHash: hash(i), sourceQuotes: [text], expected: 'Fixture answer', curatorIndependent: true }));
  }
  const batch = await service.save('confirmation-batch', 'batch', { moduleId: 'geo', candidateId: 'candidate', taskIds: tasks.map(row => row.id), taskHashes: tasks.map(row => row.payload.taskHash), taskRefs: tasks.map(evolutionRecordPin), minimum: 30, status: 'sealed' });
  const candidate = { id: 'candidate', policy: { supplements: [{ capabilityId: 'geo-content', text: 'Preserve source qualifiers.' }] } };
  const mission = await service.save('mission', 'mission', { moduleId: 'geo', sources: ['demand'], baseline: { revisionId: 'default:fixture', policy: {} }, smokeCaseIds: anchors.map(row => row.id), smokeCaseRefs: anchors.map(evolutionRecordPin) });
  const measured = { units: [] }, baselines = [{ units: [] }, { units: [] }, { units: [] }], evaluatorCompatibility = { version: 'fixture' };
  const input = { mission, candidate, batch, measured, baselines, evaluatorCompatibility,
    evaluationReceiptHash: hash({ candidateHash: hash(candidate), batch: batch.payload, measured, baselines, evaluatorCompatibility }) };
  return { service, basis, notices, cases, tasks, sources, batch, input };
}

export async function activatePolicyFixture(f, { publish = null } = {}) {
  const { validationRefs } = await f.basis.seal(f.input), { candidate, mission, measured, baselines, evaluatorCompatibility, evaluationReceiptHash } = f.input;
  await f.service.save('archive', candidate.id, { candidate, status: 'promoted', verdictId: 'verdict' });
  const verdict = await f.service.save('candidate-verdict', 'verdict', { moduleId: 'geo', candidateId: candidate.id, candidateHash: hash(candidate), missionId: mission.id,
    promote: true, confirmatory: true, receiptValid: true, firstAttempt: true, auditOnly: false, validationRefs, measured, baselines, evaluatorCompatibility, evaluationReceiptHash });
  if (publish) {
    const publication = await publish('geo', candidate, { verdictId: verdict.id });
    return { policy: await f.service.get('evolution-module-policy-geo'), verdict, validationRefs, publication };
  }
  const policy = await f.service.save('module-policy', 'evolution-module-policy-geo', { status: 'active', policy: candidate.policy, candidateId: candidate.id,
    verdictId: verdict.id, verdictRef: evolutionRecordPin(verdict), validationRefs });
  return { policy, verdict, validationRefs };
}
