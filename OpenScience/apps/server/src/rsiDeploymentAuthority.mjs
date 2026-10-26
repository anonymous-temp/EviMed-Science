import { open, constants } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { RSI_CAMPAIGN_SURFACES } from '../../../packages/domain/src/rsiCampaign.mjs';
import { canonicalRsiJson, rsiDigest } from './rsiCampaignBundle.mjs';

/** Deployment records are local, non-symlink, private files; errors contain no file bytes. @param {string} file */
export async function readRsiDeploymentRecord(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536) throw new Error('rsi_deployment_record_invalid');
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536 || bytesRead !== stat.size) throw new Error('rsi_deployment_record_invalid');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}
const only = (record, keys) => record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).every(key => keys.includes(key));
/** The operator's agreement record is authority for this purpose, never a client consent flag. @param {any} online */
export async function createRsiDeploymentAuthority(online) {
  async function current() {
    const record = await readRsiDeploymentRecord(online.agreementRef);
    if (!only(record, ['id','version','purpose','providers','scope']) || typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(record.id)
      || !Number.isSafeInteger(record.version) || record.version < 1 || record.purpose !== 'platform-quality'
      || record.scope !== 'authorized-incident' || !Array.isArray(record.providers) || record.providers.length !== 2
      || !['deepseek','dashscope'].every(provider => record.providers.includes(provider))) throw new Error('rsi_deployment_agreement_invalid');
    return { record, authorizationId: `rsi-agreement-${rsiDigest(record)}` };
  }
  const initial = await current();
  return { agreementId: initial.authorizationId, isBound: () => true,
    async authorizeIncident({ agreementId, user, project, run }) {
      const latest = await current();
      return latest.authorizationId === agreementId && user?.id === project?.userId && typeof run?.id === 'string';
    } };
}
/** Deployment policy thresholds are operational exposure limits, never statistical benefit proof.
 * This profile applies to every independently qualified candidate on the registered surface.
 * @param {any} policies */
export function validateRsiActivationPolicies(policies) {
  if (policies === undefined) return {};
  if (!policies || typeof policies !== 'object' || Array.isArray(policies)) throw new Error('rsi_activation_policy_invalid');
  const result = {};
  for (const [surface, policy] of Object.entries(policies)) {
    if (!Object.hasOwn(RSI_CAMPAIGN_SURFACES, surface) || !only(policy, ['mode','allowGlobal','allowExpansion','afterShadow','cohortPercent','cohortSteps','minExecutions','minDays','maxErrors'])
      || !['shadow','cohort','global'].includes(policy.mode) || typeof policy.allowExpansion !== 'boolean' || typeof policy.allowGlobal !== 'boolean'
      || !Number.isSafeInteger(policy.minExecutions) || policy.minExecutions < 1 || policy.minExecutions > 1000000
      || !Number.isSafeInteger(policy.minDays) || policy.minDays < 1 || policy.minDays > 90
      || !Number.isSafeInteger(policy.maxErrors) || policy.maxErrors < 0 || policy.maxErrors > 1000
      || policy.mode === 'global' && !policy.allowGlobal
      || policy.afterShadow !== undefined && (policy.mode !== 'shadow' || surface !== 'frontier-selection' || policy.afterShadow !== 'global' || !policy.allowGlobal || !policy.allowExpansion)) throw new Error('rsi_activation_policy_invalid');
    if (policy.mode === 'cohort') {
      if (!Array.isArray(policy.cohortSteps) || policy.cohortSteps.length < 1 || policy.cohortSteps.length > 10
        || policy.cohortSteps.some((step, index) => !Number.isSafeInteger(step) || step < 1 || step > 100 || index > 0 && step <= policy.cohortSteps[index - 1])
        || policy.cohortPercent !== policy.cohortSteps[0] || policy.cohortSteps.at(-1) !== 100) throw new Error('rsi_activation_policy_invalid');
    } else if (policy.cohortSteps !== undefined || policy.cohortPercent !== undefined) throw new Error('rsi_activation_policy_invalid');
    result[surface] = JSON.parse(canonicalRsiJson(policy));
  }
  return result;
}
/** Public verification only. The online process has no lab signer or KMS private-key operation.
 * @param {any} online @param {any} servingAdapters */
export async function createRsiTrustRegistry(online, servingAdapters) {
  const issuers = Object.create(null);
  for (const ref of online.trustedKeyRefs) {
    const row = await readRsiDeploymentRecord(ref);
    if (!only(row, ['keyId','publicKey','surfaces','kinds']) || typeof row.keyId !== 'string' || issuers[row.keyId]
      || !Array.isArray(row.surfaces) || !row.surfaces.length || !Array.isArray(row.kinds) || !row.kinds.length) throw new Error('rsi_trust_issuer_invalid');
    if (typeof row.publicKey !== 'string' || !row.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('rsi_trust_public_key_required');
    const publicKey = createPublicKey(row.publicKey);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('rsi_trust_algorithm_invalid');
    issuers[row.keyId] = { publicKey, surfaces: row.surfaces, kinds: row.kinds };
  }
  const registry = await readRsiDeploymentRecord(online.evaluatorRegistryRef);
  if (!only(registry, ['schemaVersion','version','evaluators','activationPolicies']) || registry.schemaVersion !== 1 || !Number.isSafeInteger(registry.version) || registry.version < 1 || !Array.isArray(registry.evaluators) || !registry.evaluators.length) throw new Error('rsi_evaluator_registry_invalid');
  const activationPolicies = validateRsiActivationPolicies(registry.activationPolicies);
  const evaluators = new Map();
  for (const row of registry.evaluators) {
    if (!only(row, ['keyId','publicKey','surfaces','procedureDigests','consumerDigests']) || typeof row.keyId !== 'string' || evaluators.has(row.keyId)
      || !['surfaces','procedureDigests','consumerDigests'].every(name => Array.isArray(row[name]) && row[name].length)) throw new Error('rsi_evaluator_registry_invalid');
    if (typeof row.publicKey !== 'string' || !row.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('rsi_trust_public_key_required');
    const key = createPublicKey(row.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('rsi_trust_algorithm_invalid');
    if (Object.values(issuers).some(issuer => issuer.publicKey.export({ type: 'spki', format: 'der' }).equals(key.export({ type: 'spki', format: 'der' })))) throw new Error('rsi_evaluator_not_independent');
    evaluators.set(row.keyId, { ...row, key });
  }
  return { isBound: () => true, registryVersion: registry.version,
    activationPolicy: async manifest => activationPolicies[manifest.surface]
      ? JSON.parse(canonicalRsiJson(activationPolicies[manifest.surface]))
      : { mode: 'shadow', allowGlobal: false, allowExpansion: false, reason: 'campaign_activation_policy_unconfigured' },
    async verificationOptions(envelope) {
      const receipt = envelope?.evaluatorReceipt;
      if (!receipt || typeof receipt.payload !== 'string' || Buffer.byteLength(receipt.payload) > 16384 || !/^[A-Za-z0-9+/]{86}==$/.test(receipt.signature ?? '')) throw new Error('rsi_evaluator_receipt_invalid');
      const evaluator = evaluators.get(receipt.keyId);
      if (!evaluator || receipt.keyId === envelope.keyId || !verify(null, Buffer.from(`evimed-rsi-evaluator-v1\n${receipt.keyId}\n${receipt.payload}`), evaluator.key, Buffer.from(receipt.signature, 'base64'))) throw new Error('rsi_evaluator_receipt_untrusted');
      const proof = JSON.parse(receipt.payload);
      const names = ['candidateDigest','registrationDigest','datasetDigest','measurementDigest','consumerDigest','evaluatorDigest','procedureDigest','qualificationDigest','corpusDigest'];
      if (canonicalRsiJson(proof) !== receipt.payload || !only(proof, ['schemaVersion','bundleId','campaignId','scope','status',...names]) || proof.schemaVersion !== 1 || proof.status !== 'qualified'
        || !names.every(name => /^[a-f0-9]{64}$/.test(proof[name] ?? '')) || !evaluator.surfaces.includes(proof.scope)
        || !evaluator.procedureDigests.includes(proof.procedureDigest) || !evaluator.consumerDigests.includes(proof.consumerDigest)) throw new Error('rsi_evaluator_scope_forbidden');
      const currentTarget = await servingAdapters.currentTarget(proof.scope);
      return { trustStore: issuers, currentTarget, expectedIdentity: { id: proof.bundleId, campaignId: proof.campaignId },
        qualification: { ...Object.fromEntries([...names,'scope'].map(name => [name,proof[name]])), verifyReceipt: async ({ verdict, manifest, candidateDigest }) =>
          candidateDigest === proof.candidateDigest && manifest.id === proof.bundleId && manifest.campaignId === proof.campaignId && [...names,'scope','status'].every(name => verdict[name] === proof[name]) } };
    } };
}
