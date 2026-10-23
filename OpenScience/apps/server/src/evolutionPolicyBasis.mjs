import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSourceIdentifier } from '@evimed/domain';
import { evolutionRecordPin } from './evolutionRecordPins.mjs';
import { EVOLUTION_PROJECT_ID } from './internalProjects.mjs';
import { MODULE_CONFIRMATION_MINIMUM } from './moduleEvolutionAdapters.mjs';

const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const textHash = value => createHash('sha256').update(value).digest('hex');
const TASK_ACCOUNTING = new Set(['pool', 'feedbackCount', 'uses', 'reservedFor', 'exposedToDevelopment', 'retiredAuditQuarter', 'baselineKnownCorrect', 'evaluatorVersion']);
const SOURCE_ACCOUNTING = new Set(['exposedToDevelopment', 'feedbackCount', 'uses', 'reservedFor', 'exposureTier']);
const BATCH_ACCOUNTING = new Set(['status', 'attempt', 'attemptedAt', 'result', 'completedAt']);
const semantic = (payload, excluded) => Object.fromEntries(Object.entries(payload).filter(([key]) => !excluded.has(key)));
class BasisError extends Error {
  constructor(reason, knownInvalid = true) { super(reason); this.reason = reason; this.knownInvalid = knownInvalid; }
}
const refuse = (reason, knownInvalid = true) => { throw new BasisError(reason, knownInvalid); };
const disposition = error => ({ usable: false, knownInvalid: error instanceof BasisError && error.knownInvalid,
  reason: error instanceof BasisError ? error.reason : 'public-basis-unavailable' });

/** Evaluator-owned public evidence, separate from the private-derived trigger that suggested an investigation. */
export function createEvolutionPolicyBasis({ service, sourceChanges = () => null, calibrationCases = async () => [], verifyReproduction = (_payload, _identity) => false }) {
  async function readPin(pin, type) {
    if (!pin || typeof pin.id !== 'string' || !Number.isSafeInteger(pin.revision) || !/^[a-f0-9]{64}$/.test(pin.payloadHash ?? '')) refuse('public-basis-unpinned', false);
    const current = await service.get(pin.id);
    if (!current || current.projectId !== EVOLUTION_PROJECT_ID || current.payload.recordType !== `evolution-${type}`) refuse('public-basis-missing');
    if (current.payload.validationState && current.payload.validationState !== 'valid') refuse('public-basis-withdrawn');
    let payload = current.payload;
    if (current.revision !== pin.revision) {
      const history = await service.documents.history(await service.owner(), 'knowledge', pin.id, { beforeRevision: pin.revision + 1, limit: 1 });
      if (history[0]?.revision !== pin.revision || history[0]?.deletedAt) refuse('public-basis-missing');
      payload = history[0].payload;
    }
    if (hash(payload) !== pin.payloadHash) refuse('public-basis-mismatch');
    return { payload, current };
  }

  async function taskPin(pin, role) {
    const task = await readPin(pin, 'task'), p = task.payload;
    if (p.moduleId !== 'geo' || p.scope !== 'public') refuse('public-basis-mismatch');
    if (hash(semantic(task.current.payload, TASK_ACCOUNTING)) !== hash(semantic(p, TASK_ACCOUNTING))) refuse('public-basis-mismatch');
    const source = await readPin(p.sourceAssetRef, 'resource-asset'), s = source.payload;
    if (s.scope !== 'public' || typeof s.text !== 'string' || textHash(s.text) !== p.sourceHash || s.sourceHash !== p.sourceHash || s.sourceRoot !== p.sourceRoot) refuse('public-basis-mismatch');
    if (hash(semantic(source.current.payload, SOURCE_ACCOUNTING)) !== hash(semantic(s, SOURCE_ACCOUNTING))) refuse('public-basis-mismatch');
    const kind = s.sourceKind ?? (s.textScope === 'preserved-feed-abstract' ? 'public-abstract' : null);
    if (kind === 'repo-calibration') {
      if (role !== 'anchor') refuse('public-baseline-reproduction-required', false);
      const definition = (await calibrationCases()).find(entry => entry.id === s.fixtureId);
      if (!definition || textHash(JSON.stringify(definition)) !== p.sourceHash) refuse('public-basis-mismatch');
    } else if (kind !== 'public-abstract') refuse('public-basis-unpinned', false);
    if ((p.sourceQuotes ?? []).some(quote => typeof quote !== 'string' || !s.text.includes(quote))) refuse('public-basis-mismatch');
    const chronology = [];
    if (kind === 'public-abstract') {
      const evidence = p.provenanceEvidence ?? s.provenanceEvidence ?? [];
      const first = String(p.firstPublicEvidenceId ?? s.firstPublicEvidenceId ?? '');
      if (!evidence.length || !evidence.some(entry => first === entry.id || first.startsWith(`${entry.id}:`))) refuse('public-basis-unpinned', false);
      for (const entry of evidence) {
        const snapshot = await service.get(entry.id);
        if (!snapshot) refuse('public-basis-missing');
        const metadataPin = evolutionRecordPin(snapshot), metadata = (await readPin(metadataPin, 'public-source-version')).payload;
        if (typeof metadata.bodyBase64 !== 'string' || metadata.sha256 !== entry.sha256
          || textHash(Buffer.from(metadata.bodyBase64, 'base64')) !== entry.sha256) refuse('public-basis-mismatch');
        chronology.push(metadataPin);
      }
    }
    return { task: pin, source: p.sourceAssetRef, kind, chronology,
      identifiers: [...new Set([p.sourceRoot, ...(p.sourceIdentifiers ?? []), ...(s.sourceAliases ?? [])].map(canonicalSourceIdentifier).filter(Boolean))] };
  }

  async function checkBody(body) {
    if (body?.version !== 1 || body.moduleId !== 'geo' || body.confirmation?.tasks?.length < MODULE_CONFIRMATION_MINIMUM.geo) refuse('public-basis-unpinned', false);
    const batch = await readPin(body.confirmation.batch, 'confirmation-batch');
    if (hash(semantic(batch.current.payload, BATCH_ACCOUNTING)) !== hash(semantic(batch.payload, BATCH_ACCOUNTING))) refuse('public-basis-mismatch');
    if (batch.payload.moduleId !== 'geo' || batch.payload.candidateId !== body.candidateId
      || hash(batch.payload.taskRefs) !== hash(body.confirmation.tasks.map(entry => entry.task))) refuse('public-basis-mismatch');
    const refs = [];
    for (const [index, entry] of body.confirmation.tasks.entries()) {
      const verified = await taskPin(entry.task, 'confirmation');
      const original = (await readPin(entry.task, 'task')).payload;
      if (hash(verified) !== hash(entry) || original.taskHash !== batch.payload.taskHashes[index]
        || entry.task.id !== batch.payload.taskIds[index]) refuse('public-basis-mismatch');
      refs.push(verified);
    }
    for (const entry of body.anchors) {
      const verified = await taskPin(entry.task, 'anchor');
      if (hash(verified) !== hash(entry)) refuse('public-basis-mismatch');
      refs.push(verified);
    }
    if (body.reproduction) refs.push(await verifyReproductionBasis(body.reproduction, { missionId: body.missionId, baseline: body.baseline }));
    return sourceCurrency(refs);
  }

  async function verifyReproductionBasis(reproduction, identity) {
    const receipt = await readPin(reproduction.receipt, 'failure-reproduction');
    if (hash(receipt.current.payload) !== hash(receipt.payload) || !verifyReproduction(receipt.payload, {
      ...identity, moduleId: 'geo',
    })) refuse('public-baseline-reproduction-required', false);
    const task = await taskPin(reproduction.task.task, 'reproduction');
    if (hash(task) !== hash(reproduction.task)) refuse('public-basis-mismatch');
    const taskDefinition = (await readPin(task.task, 'task')).payload;
    if (receipt.payload.taskId !== task.task.id || receipt.payload.sourceRoot !== taskDefinition.sourceRoot || receipt.payload.sourceHash !== taskDefinition.sourceHash) refuse('public-basis-mismatch');
    const results = [];
    for (const [index, pin] of reproduction.checkpoints.entries()) {
      if (pin.id !== `${reproduction.receipt.id}-attempt-${index}`) refuse('public-basis-mismatch');
      const checkpoint = await readPin(pin, 'failure-replay');
      if (!checkpoint.payload.taskRef || hash(checkpoint.payload.taskRef) !== hash(receipt.payload.taskRef)) refuse('public-basis-unpinned', false);
      if (hash(checkpoint.current.payload) !== hash(checkpoint.payload)) refuse('public-basis-mismatch');
      results.push(checkpoint.payload.result);
    }
    if (results.length !== 2 || hash(results) !== receipt.payload.executionReceiptHash) refuse('public-basis-mismatch');
    return task;
  }


  async function sourceCurrency(refs) {
    const identifiers = [...new Set(refs.flatMap(entry => entry.identifiers))], reader = sourceChanges();
    if (!reader?.getMany) refuse('public-basis-unavailable', false);
    let unknown = false;
    for (let offset = 0; offset < identifiers.length; offset += 500) {
      const chunk = identifiers.slice(offset, offset + 500), facts = await reader.getMany(chunk);
      for (const identifier of chunk) {
        const fact = facts.get(identifier);
        if (!fact || fact.state === 'unknown') unknown = true;
        if ((fact?.changes ?? []).some(change => ['retraction', 'withdrawal', 'correction', 'concern'].includes(change.kind))) refuse('public-basis-source-changed');
      }
    }
    return { usable: true, knownInvalid: false, currency: unknown ? 'unknown' : 'checked' };
  }

  async function check(refs) {
    try {
      if (refs?.version !== 1 || typeof refs.basisId !== 'string' || !/^[a-f0-9]{64}$/.test(refs.basisHash ?? '')) refuse('public-basis-unpinned', false);
      const row = await service.get(refs.basisId);
      if (!row || row.projectId !== EVOLUTION_PROJECT_ID || row.payload.recordType !== 'evolution-policy-validation-basis') refuse('public-basis-missing');
      if (row.payload.validationState && row.payload.validationState !== 'valid') refuse('public-basis-withdrawn');
      if (refs.basisId !== `evolution-policy-validation-basis-${refs.basisHash}`) refuse('public-basis-mismatch');
      if (row.payload.basisHash !== refs.basisHash || hash(row.payload.body) !== refs.basisHash) refuse('public-basis-mismatch');
      return await checkBody(row.payload.body);
    } catch (error) { return disposition(error); }
  }

  async function reproductionBasis({ mission, baseline = mission.payload.baseline, receipt: supplied = null }) {
    const receipt = supplied ?? (mission.payload.failureReproductionReceiptId ? await service.get(mission.payload.failureReproductionReceiptId) : null);
    if (!verifyReproduction(receipt?.payload, { missionId: mission.id, moduleId: 'geo', baseline })) refuse('public-baseline-reproduction-required', false);
    const checkpoints = [];
    for (const index of [0, 1]) {
      const row = await service.get(`${receipt.id}-attempt-${index}`);
      if (!row) refuse('public-baseline-reproduction-required', false);
      checkpoints.push(evolutionRecordPin(row));
    }
    const reproduction = { receipt: evolutionRecordPin(receipt), task: await taskPin(receipt.payload.taskRef, 'reproduction'), checkpoints };

    await verifyReproductionBasis(reproduction, { missionId: mission.id, baseline });
    return reproduction;
  }

  async function checkReproduction(input) {
    try { const reproduction = await reproductionBasis(input); return await sourceCurrency([reproduction.task]); }
    catch (error) { return disposition(error); }
  }

  async function checkTask(row, { role = 'confirmation', reference = null } = {}) {
    try {
      if (reference && reference.id !== row?.id) refuse('public-basis-mismatch');
      return await sourceCurrency([await taskPin(reference ?? evolutionRecordPin(row), role)]);
    }
    catch (error) { return disposition(error); }
  }

  async function inputBasis({ mission, candidate, batch }) {
    if (mission?.payload.moduleId !== 'geo' || !batch?.payload.taskRefs || batch.payload.taskRefs.length < MODULE_CONFIRMATION_MINIMUM.geo) refuse('public-basis-unpinned', false);
    const candidateHash = hash(candidate);
    const confirmation = { batch: evolutionRecordPin(batch), tasks: [] };
    for (const pin of batch.payload.taskRefs) confirmation.tasks.push(await taskPin(pin, 'confirmation'));
    const anchors = [];
    for (const pin of mission.payload.smokeCaseRefs ?? []) {
      const row = await readPin(pin, 'task');
      if (!row.payload.baselineKnownCorrect) refuse('public-basis-unpinned', false);
      anchors.push(await taskPin(pin, 'anchor'));
    }
    if (anchors.length < 2) refuse('public-basis-unpinned', false);
    const needsReproduction = (mission.payload.sources ?? []).includes('repair') || mission.payload.kind === 'repair' || candidate.proposal?.opportunityKind === 'repair';
    const reproduction = needsReproduction ? await reproductionBasis({ mission }) : null;
    return { version: 1, moduleId: 'geo', missionId: mission.id, candidateId: candidate.id, candidateHash,
      baseline: mission.payload.baseline, baselineHash: hash(mission.payload.baseline), confirmation, anchors, reproduction };
  }

  async function checkInputs(input) {
    try { return await checkBody(await inputBasis(input)); } catch (error) { return disposition(error); }
  }

  async function seal({ mission, candidate, batch, measured, baselines, evaluatorCompatibility, evaluationReceiptHash }) {
    try {
      const candidateHash = hash(candidate);
      if (hash({ candidateHash, batch: batch.payload, measured, baselines, evaluatorCompatibility }) !== evaluationReceiptHash) refuse('public-basis-mismatch');
      const body = { ...await inputBasis({ mission, candidate, batch }), evaluationReceiptHash };
      await checkBody(body);
      const basisHash = hash(body), basisId = `evolution-policy-validation-basis-${basisHash}`;
      const prior = await service.get(basisId);
      const saved = prior ?? await service.save('policy-validation-basis', basisId, { body, basisHash });
      if (saved.payload.basisHash !== basisHash || hash(saved.payload.body) !== basisHash) refuse('public-basis-mismatch');
      return { status: 'sealed', validationRefs: { version: 1, basisId, basisHash } };
    } catch (error) { return { status: 'waiting', reason: disposition(error).reason }; }
  }

  /** Bind dependency validity to the authoritative sealed selection; this does not repeat quality scoring. */
  async function validateVerdict(verdict, candidate = null, { activation = true } = {}) {
    try {
      const authoritative = verdict?.id ? await service.get(verdict.id) : null;
      if (!authoritative || authoritative.projectId !== EVOLUTION_PROJECT_ID || hash(authoritative.payload) !== hash(verdict.payload)) refuse('public-basis-mismatch');
      const p = authoritative.payload;
      if (p.recordType !== 'evolution-candidate-verdict' || p.moduleId !== 'geo' || typeof p.promote !== 'boolean' || activation && !p.promote
        || !p.confirmatory || !p.receiptValid || !p.firstAttempt || activation && p.auditOnly) refuse('public-basis-mismatch');
      if (p.validationState && p.validationState !== 'valid') refuse('public-basis-withdrawn');
      const decision = await check(p.validationRefs);
      if (!decision.usable) return decision;
      const body = (await service.get(p.validationRefs.basisId)).payload.body;
      const archive = await service.get(p.candidateId), preserved = archive?.payload.candidate;
      if (!archive || archive.projectId !== EVOLUTION_PROJECT_ID || archive.payload.recordType !== 'evolution-archive') refuse('public-basis-missing');
      if (archive.payload.validationState && archive.payload.validationState !== 'valid') refuse('public-basis-withdrawn');
      if (!preserved || hash(preserved) !== body.candidateHash || candidate && hash(candidate) !== body.candidateHash
        || p.candidateId !== body.candidateId || p.candidateHash !== body.candidateHash || p.missionId !== body.missionId
        || p.evaluationReceiptHash !== body.evaluationReceiptHash || hash(body.baseline) !== body.baselineHash) refuse('public-basis-mismatch');
      const batch = (await readPin(body.confirmation.batch, 'confirmation-batch')).payload;
      if (hash({ candidateHash: body.candidateHash, batch, measured: p.measured, baselines: p.baselines,
        evaluatorCompatibility: p.evaluatorCompatibility }) !== body.evaluationReceiptHash) refuse('public-basis-mismatch');
      return decision;
    } catch (error) { return disposition(error); }
  }

  async function inspectPolicy(row) {
    try {
      if (!row?.payload.validationRefs || !row.payload.verdictRef) refuse('public-basis-unpinned', false);
      const pinned = await readPin(row.payload.verdictRef, 'candidate-verdict');
      if (hash(pinned.current.payload) !== hash(pinned.payload) || pinned.current.id !== row.payload.verdictId
        || pinned.payload.candidateId !== row.payload.candidateId || hash(pinned.payload.validationRefs) !== hash(row.payload.validationRefs)) refuse('public-basis-mismatch');
      const archive = await service.get(row.payload.candidateId);
      if (!archive?.payload.candidate) refuse('public-basis-missing');
      if (hash(archive.payload.candidate.policy) !== hash(row.payload.policy)) refuse('public-basis-mismatch');
      return await validateVerdict(pinned.current, archive.payload.candidate);
    } catch (error) { return disposition(error); }
  }

  async function stable(operation) {
    const reader = sourceChanges();
    if (!reader?.getMany) refuse('public-basis-unavailable', false);
    return reader.withStableSnapshot ? reader.withStableSnapshot(operation) : operation();
  }

  async function reconcile() {
    try {
      return await service.withLock('module-policy-activation:geo', () => stable(async () => {
        const row = await service.get('evolution-module-policy-geo');
        if (row?.payload.status !== 'active') return { status: row?.payload.status ?? 'default', resolved: null };
        const decision = await inspectPolicy(row);
        if (decision.usable) return { status: 'active', resolved: { revisionId: `${row.id}:${row.revision}`, policy: row.payload.policy }, currency: decision.currency };
        if (decision.knownInvalid || decision.reason === 'public-basis-unpinned') {
          await service.save('module-policy', row.id, { ...row.payload, status: 'suspended', suspension: {
            reason: decision.reason, basisHash: row.payload.validationRefs?.basisHash ?? null, at: service.now().toISOString(),
          } }, row);
          const archive = await service.get(row.payload.candidateId);
          if (archive?.payload.status === 'promoted' && archive.payload.verdictId === row.payload.verdictId) {
            await service.save('archive', archive.id, { ...archive.payload, status: 'suspended', validationState: 'invalidated' }, archive);
          }
          return { status: 'suspended', resolved: null, reason: decision.reason };
        }
        return { status: 'unavailable', resolved: null, reason: decision.reason };
      }));
    } catch (error) { return { status: 'unavailable', resolved: null, reason: disposition(error).reason }; }
  }

  async function readActive() { return (await reconcile()).resolved; }

  /** A delayed dispatch may use its old valid instructions; it may not revive a suspended basis. */
  async function revisionUsable(revisionId) {
    if (String(revisionId).startsWith('default:')) return true;
    const match = /^evolution-module-policy-geo:(\d+)$/.exec(String(revisionId));
    if (!match) return false;
    try {
      const current = await service.get('evolution-module-policy-geo');
      if (!current) return false;
      const revision = Number(match[1]);
      const payload = current.revision === revision ? current.payload
        : (await service.documents.history(await service.owner(), 'knowledge', current.id, { beforeRevision: revision + 1, limit: 1 })).find(row => row.revision === revision)?.payload;
      if (!payload || payload.status !== 'active' || (current.payload.status === 'suspended' && current.payload.candidateId === payload.candidateId)) return false;
      return (await inspectPolicy({ ...current, revision, payload })).usable;
    } catch { return false; }
  }
  return { seal, check, checkInputs, checkReproduction, checkTask, validateVerdict, inspectPolicy, stable, reconcile, readActive, revisionUsable };
}
