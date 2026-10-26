import { isAbsolute } from 'node:path';
import { readRsiDeploymentRecord } from './rsiDeploymentAuthority.mjs';
import { rsiOssConfigurationIssues } from './rsiOssClient.mjs';

/** A deployment file contains references and public identities only, never credentials. @param {any} value */
export function rsiOnlineConfigurationIssues(value) {
  const issues = [];
  if (value && Object.keys(value).some(key => !['schemaVersion','agreementRef','transport','trustedKeyRefs','evaluatorRegistryRef','extractionDailyCny'].includes(key))) issues.push('rsi_online_configuration_invalid');
  if (value?.transport?.identityRefs && Object.keys(value.transport.identityRefs).some(key => !['production','lab'].includes(key))) issues.push('rsi_online_configuration_invalid');
  if (value?.transport && Object.keys(value.transport).some(key => !['role','region','endpoint','incidentBucket','bundleBucket','identityRefs'].includes(key))) issues.push('rsi_online_configuration_invalid');
  if (!value || value.schemaVersion !== 1) issues.push('rsi_online_configuration_missing');
  if (typeof value?.agreementRef !== 'string' || !isAbsolute(value.agreementRef)) issues.push('rsi_online_agreement_missing');
  if (value?.transport?.role !== 'production' || value?.transport?.region !== 'cn-beijing') issues.push('rsi_online_transport_invalid');
  issues.push(...rsiOssConfigurationIssues(value?.transport));
  if (!Array.isArray(value?.trustedKeyRefs) || !value.trustedKeyRefs.length || value.trustedKeyRefs.some(ref => typeof ref !== 'string' || !isAbsolute(ref))) issues.push('rsi_online_trust_missing');
  if (typeof value?.evaluatorRegistryRef !== 'string' || !isAbsolute(value.evaluatorRegistryRef)) issues.push('rsi_online_evaluator_registry_missing');

  if (!Number.isFinite(value?.extractionDailyCny) || value.extractionDailyCny <= 0 || value.extractionDailyCny > 20) issues.push('rsi_online_extraction_budget_invalid');
  return [...new Set(issues)];
}
/** The production transport section alone: what publishing a withdrawal needs. @param {any} value */
function rsiWithdrawalTransport(value) {
  const transport = value?.transport;
  if (!transport || typeof transport !== 'object' || Array.isArray(transport) || value.schemaVersion !== 1) return null;
  if (Object.keys(transport).some(key => !['role','region','endpoint','incidentBucket','bundleBucket','identityRefs'].includes(key))
    || transport.identityRefs && Object.keys(transport.identityRefs).some(key => !['production','lab'].includes(key))) return null;
  return transport.role === 'production' && transport.region === 'cn-beijing' && !rsiOssConfigurationIssues(transport).length ? transport : null;
}
/** Invalid or missing bindings cannot initialize a cloud client. A withdrawal is owed whatever else changed, so a valid
 * transport section and the agreement reference are returned even when the full configuration is not.
 * @param {string|null|undefined} file
 * @returns {Promise<{configuration:any, transport:any, agreementRef:string|null, issues:string[]}>} */
export async function loadRsiOnlineConfiguration(file) {
  if (!file) return { configuration: null, transport: null, agreementRef: null, issues: ['rsi_online_configuration_missing'] };
  try {
    if (!isAbsolute(file)) throw new Error('invalid');
    const configuration = await readRsiDeploymentRecord(file);
    const issues = rsiOnlineConfigurationIssues(configuration);
    const agreementRef = typeof configuration?.agreementRef === 'string' && isAbsolute(configuration.agreementRef) ? configuration.agreementRef : null;
    return { configuration: issues.length ? null : configuration, transport: rsiWithdrawalTransport(configuration), agreementRef, issues };
  } catch { return { configuration: null, transport: null, agreementRef: null, issues: ['rsi_online_configuration_unreadable'] }; }
}
