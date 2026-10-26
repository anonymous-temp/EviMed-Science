/**
 * The lab's evaluator (2026-10-26): a separate step, with its own Ed25519 key, that the runner cannot impersonate.
 * It recomputes what the runner measured instead of taking it on trust — the development choice from the development
 * source and the registration, the confirmation observations twice from the sealed corpus and the frozen policy (a
 * deterministic consumer gives the same bytes twice) — and signs a receipt bound to the runner's request only when every
 * recomputation agrees. It also signs the month's report, whatever the verdict, so every campaign leaves a signed record.
 *
 *   node evaluator.mjs receipt <manifest.json> <inputs.json> <request.json> <checkpoint.json> <key.pem> <out.json>
 *   node evaluator.mjs report  <report.json> <key.pem> <out.json>
 *   node evaluator.mjs evidence <manifest.json> <inputs.json> <checkpoint.json> <qualification-report.json> <key.pem> <out.json>
 *
 * `evidence` is for a qualified campaign only: the finalizer's signed input (`rsi-finalizer-evidence-v1`), naming the
 * candidate file, the consumer's dependency closure, the day-group proof and the procedure qualification it rests on.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { canonicalRsiJson, rsiDigest } from '../../apps/server/src/rsiCampaignBundle.mjs';
import { chooseFrontierCandidate, evaluateFrontierDays, frontierCampaignConsumerIdentity, frontierObservations } from './frontier_campaign.mjs';

const fail = (reason) => { throw new Error(reason); };
const RECEIPT_DAYS = 7;

/** Ed25519 key from a PEM file; the public key's SPKI SHA-256 is its identity. @param {string} pem */
export function evaluatorKey(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') fail('campaign_evaluator_key_invalid');
  const publicKey = createPublicKey(key);
  return { key, publicKey, publicKeySha256: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
}

/** Sign a payload the way `signedEvaluatorReceipt` verifies it: Ed25519 over the canonical JSON. */
export function signEnvelope(payload, key) {
  return { payload, signature: sign(null, Buffer.from(canonicalRsiJson(payload)), key).toString('base64') };
}

/**
 * Recompute and attest. Throws a closed `campaign_*` code when anything the runner reports cannot be reproduced.
 * @param {{manifest:any, inputs:any, request:any, checkpoint:any, now?:string}} input
 */
export async function evaluatorReceiptPayload({ manifest, inputs, request, checkpoint, now = new Date().toISOString() }) {
  if (manifest.surface !== 'frontier-selection') fail('campaign_consumer_not_qualified');
  const binding = rsiDigest({ manifest, inputs });
  if (request.binding !== binding || checkpoint.binding !== binding) fail('campaign_evaluator_binding_changed');
  const registration = inputs.registration, statistics = registration.statistics;
  const development = manifest.data.sources.find((row) => row.role === 'development');
  const confirmation = manifest.data.sources.find((row) => row.role === 'confirmation');
  for (const source of [development, confirmation]) if (rsiDigest(inputs.sources[source.id]) !== source.digest) fail('campaign_source_changed');
  if (request.corpusDigest !== confirmation.digest || request.registrationDigest !== rsiDigest(statistics ?? null)) fail('campaign_evaluator_binding_changed');
  const identity = await frontierCampaignConsumerIdentity();
  if (statistics?.consumer_id !== identity.implementationSha256 || statistics?.corpus_digest !== confirmation.digest) fail('campaign_evaluation_consumer_or_corpus_changed');
  // The freeze followed the registered rule on the development source alone.
  const developed = evaluateFrontierDays(inputs.sources[development.id], registration);
  const choice = chooseFrontierCandidate(developed, registration);
  const frozen = checkpoint.frozenPolicy;
  if (!choice.frozen || !frozen || choice.frozen.threshold !== frozen.threshold || rsiDigest(frozen) !== request.frozenPolicyDigest
    || rsiDigest({ evaluation: developed, candidates: choice.candidates }) !== frozen.developmentResultDigest) fail('campaign_evaluator_development_differs');
  if (!(Date.parse(checkpoint.frozenAt) < Date.parse(request.confirmationOpenedAt))) fail('campaign_evaluator_chronology_invalid');
  // The confirmation, twice: equal bytes are the determinism the paired-t registration assumes.
  const runs = [0, 1].map(() => {
    const evaluation = evaluateFrontierDays(inputs.sources[confirmation.id], { ...registration, thresholds: [frozen.threshold], labelThresholds: registration.thresholds });
    const measured = frontierObservations(evaluation, registration, frozen.threshold);
    return { result: { evaluation, observations: measured.observations, volumeRatio: measured.volumeRatio }, reason: measured.reason };
  });
  if (runs[0].reason || rsiDigest(runs[0].result) !== rsiDigest(runs[1].result)) fail('campaign_evaluator_nondeterministic');
  if (rsiDigest(runs[0].result) !== request.confirmationResultDigest) fail('campaign_evaluator_recomputation_differs');
  if (request.look !== 1) fail('campaign_evaluator_repeated_look');
  if (statistics.cost_identity !== 'deterministic-no-model-call') fail('campaign_cost_identity_unsupported');
  const observations = runs[0].result.observations;
  const costs = observations.map((row) => ({ group: row.group, arm: row.arm, form: row.form, repeat: row.repeat, cost: 0 }));
  const expiresAt = new Date(Math.min(Date.parse(now) + RECEIPT_DAYS * 86400000, Date.parse(manifest.deadline))).toISOString();
  return {
    type: 'rsi-evaluator-receipt-v1', ...request, issuedAt: now, expiresAt,
    observationDigest: rsiDigest(observations),
    costProvenance: { type: 'measured-normalized-cny', receiptId: `deterministic-selection:${rsiDigest(observations).slice(0, 16)}`, complete: true,
      normalization: 'Selection is deterministic code: neither arm makes a model call, so both measured model costs are zero; compute is not claimed.' },
    costs,
    receipt: {
      deterministic_qualification: { type: 'trusted-deterministic-consumer', consumer_id: identity.implementationSha256, corpus_digest: confirmation.digest,
        qualification_id: `replayed-twice:${rsiDigest(runs[0].result).slice(0, 16)}`, externally_verified: true },
      attestations: { registration_digest: rsiDigest(statistics), confirmation_exposed: false, look: 1, complete_costs: true,
        cost_identity: statistics.cost_identity, expired_budget: Date.parse(now) >= Date.parse(statistics.expires_at) },
    },
    consumer: identity,
  };
}

/** The procedure qualification a release rests on: the statistics' own simulation report, for the claim. */
/** Deterministic in the report and the consumer, so the owner can pin its digest in the finalizer profile at install time;
 * it lapses 180 days after the report was generated (a re-run of qualify_statistics.py renews it). */
export function procedureQualification(report, { claim, procedure, consumerDigest }) {
  const scenarios = [...(report?.development?.scenarios ?? []), ...(report?.held_back?.scenarios ?? [])].filter((row) => row.claim === claim);
  if (report?.qualification_passed !== true || !scenarios.length || rsiDigest(report.development?.procedure ?? null) !== rsiDigest(procedure)
    || !Number.isFinite(Date.parse(report.generatedAt))) fail('campaign_procedure_not_qualified');
  return { status: 'qualified', claims: [claim], consumerDigest, procedureDigest: rsiDigest(procedure), evidenceScope: 'population-task-family',
    expiresAt: new Date(Date.parse(report.generatedAt) + 180 * 86400000).toISOString(), qualificationId: `statistics-qualification:${rsiDigest(report).slice(0, 16)}` };
}

/** The digests the finalizer profile pins: the registered procedure and this tree's qualification for a claim. */
export async function qualificationDigests(report, { claim, rootDir }) {
  const { computeRsiDependencyClosure } = await import('../../apps/server/src/rsiDependencyClosure.mjs');
  const closure = await computeRsiDependencyClosure({ rootDir, surface: 'frontier-selection', settings: { model: 'deepseek-flash', provider: 'deepseek' } });
  if (!closure.qualified) fail('campaign_consumer_changed');
  const q = procedureQualification(report, { claim, procedure: report.development.procedure, consumerDigest: closure.dependencyDigest });
  return { procedureDigest: q.procedureDigest, qualificationDigest: rsiDigest(q), consumerDigest: closure.dependencyDigest, expiresAt: q.expiresAt };
}

/** The finalizer's signed input for a qualified campaign. @param {{manifest:any, inputs:any, checkpoint:any, report:any, rootDir:string, now?:string}} input */
export async function finalizerEvidencePayload({ manifest, inputs, checkpoint, report, rootDir, now = new Date().toISOString() }) {
  if (checkpoint.evaluation?.decision !== 'qualified') fail('campaign_statistics_not_qualified');
  const { computeRsiDependencyClosure } = await import('../../apps/server/src/rsiDependencyClosure.mjs');
  const closure = await computeRsiDependencyClosure({ rootDir, surface: manifest.surface, settings: { model: 'deepseek-flash', provider: 'deepseek' } });
  if (!closure.qualified) fail('campaign_consumer_changed');
  const files = [{ path: 'policy.json', content: canonicalRsiJson({ selectionThreshold: checkpoint.frozenPolicy.threshold }) }];
  const candidateDigest = rsiDigest(files), confirmation = manifest.data.sources.find((row) => row.role === 'confirmation');
  const statistics = checkpoint.evaluation.statisticsInput;
  return { type: 'rsi-finalizer-evidence-v1', expiresAt: new Date(Math.min(Date.parse(now) + RECEIPT_DAYS * 86400000, Date.parse(manifest.deadline))).toISOString(),
    confirmationOpenedAt: checkpoint.confirmationOpenedAt, binding: checkpoint.binding, candidateDigest, frozenPolicyDigest: checkpoint.frozenPolicyDigest,
    registrationDigest: manifest.registration.digest, datasetDigest: rsiDigest(inputs.sources), consumerDigest: closure.dependencyDigest, corpusDigest: confirmation.digest,
    qualification: procedureQualification(report, { claim: manifest.claim, procedure: statistics.registration.procedure, consumerDigest: closure.dependencyDigest }),
    statistics,
    consumerProof: { executed: true, consumerDigest: closure.dependencyDigest, candidateDigest, baselineRevision: manifest.target.baselineRevision, corpusDigest: confirmation.digest, resultDigest: checkpoint.stages.confirmation.resultDigest },
    sourceGroupProof: statistics.registration.groups.map((group) => ({ id: group.id, day: group.day, exposure: confirmation.exposure })),
    files };
}

async function main() {
  const [command, ...paths] = process.argv.slice(2);
  const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
  if (command === 'receipt') {
    const [manifestPath, inputsPath, requestPath, checkpointPath, keyPath, outPath] = paths;
    const { key, publicKeySha256 } = evaluatorKey(await readFile(keyPath, 'utf8'));
    const stored = await json(checkpointPath);
    const payload = await evaluatorReceiptPayload({ manifest: await json(manifestPath), inputs: await json(inputsPath), request: await json(requestPath), checkpoint: stored.checkpoint ?? stored });
    await writeFile(outPath, `${JSON.stringify(signEnvelope(payload, key))}\n`, { mode: 0o640 });
    console.log(JSON.stringify({ status: 'signed', type: payload.type, publicKeySha256, expiresAt: payload.expiresAt }));
  } else if (command === 'report') {
    const [reportPath, keyPath, outPath] = paths;
    const { key, publicKeySha256 } = evaluatorKey(await readFile(keyPath, 'utf8'));
    const report = await json(reportPath);
    const payload = { type: 'rsi-campaign-report-v1', signedAt: new Date().toISOString(), reportDigest: rsiDigest(report), report };
    await writeFile(outPath, `${JSON.stringify(signEnvelope(payload, key))}\n`, { mode: 0o640 });
    console.log(JSON.stringify({ status: 'signed', type: payload.type, publicKeySha256, reportDigest: payload.reportDigest }));
  } else if (command === 'evidence') {
    const [manifestPath, inputsPath, checkpointPath, reportPath, keyPath, outPath] = paths;
    const { key, publicKeySha256 } = evaluatorKey(await readFile(keyPath, 'utf8'));
    const stored = await json(checkpointPath);
    const payload = await finalizerEvidencePayload({ manifest: await json(manifestPath), inputs: await json(inputsPath), checkpoint: stored.checkpoint ?? stored,
      report: await json(reportPath), rootDir: resolve(new URL('../..', import.meta.url).pathname) });
    const { files, ...signed } = payload;
    const envelope = { payload: signed, signature: sign(null, Buffer.from(`evimed-rsi-evaluation-input-v1\n${canonicalRsiJson(signed)}`), key).toString('base64') };
    await writeFile(outPath, `${JSON.stringify({ evidenceEnvelope: envelope, files })}\n`, { mode: 0o640 });
    console.log(JSON.stringify({ status: 'signed', type: signed.type, publicKeySha256, candidateDigest: signed.candidateDigest }));
  } else if (command === 'qualification') {
    const [reportPath, claim = 'superiority'] = paths;
    console.log(JSON.stringify(await qualificationDigests(await json(reportPath), { claim, rootDir: resolve(new URL('../..', import.meta.url).pathname) })));
  } else throw new Error('Usage: evaluator.mjs receipt|report|evidence|qualification ...');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(JSON.stringify({ status: 'refused', reason: /^campaign_[a-z_]+$/.test(error.message) ? error.message : 'campaign_evaluator_failed' })); process.exitCode = 1; });
}
