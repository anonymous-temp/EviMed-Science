import { isAbsolute, normalize } from 'node:path';
import { rsiLabBindingIssues, RSI_CAMPAIGN_LIMITS } from '../../../packages/domain/src/rsiCampaign.mjs';
import { HttpError } from './security.mjs';

/**
 * Deployment-owned configuration only; no customer or serving fallback. The lab holds no provider credential and calls no model (every model role runs on
 * the operator's box, owner 2026-11-03): the configuration names none, and a key it does not list, `providers` included, is refused.
 * @param {any} configuration
 */
export function rsiLabConfigurationIssues(configuration) {
  const issues = rsiLabBindingIssues(configuration);
  if (configuration?.host?.role !== undefined && configuration.host.role !== 'rsi-lab') issues.push('campaign_host_unavailable');
  if (configuration && Object.keys(configuration).some(key => !['host', 'transport', 'signer', 'authority', 'budget'].includes(key))) issues.push('campaign_lab_configuration_invalid');
  const sections = {host:['provider','purpose','instanceId','region','role'],transport:['kind','endpoint','region','incidentBucket','bundleBucket'],signer:['keyId','publicKeySha256'],authority:['role','accountId','dataDir','databaseRole'],budget:['campaignCny','monthCny']};
  for (const [section, allowed] of Object.entries(sections)) {
    const value = configuration?.[section];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) issues.push('campaign_lab_configuration_invalid');
  }
  const authority = configuration?.authority;
  if (authority?.role !== 'rsi-lab' || typeof authority.accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(authority.accountId)
    || typeof authority.dataDir !== 'string' || !isAbsolute(authority.dataDir) || normalize(authority.dataDir) !== authority.dataDir || !authority.dataDir.split('/').includes('rsi-lab')
    || typeof authority.databaseRole !== 'string' || !/^rsi_lab(?:_[a-z0-9_]+)?$/.test(authority.databaseRole)) issues.push('campaign_lab_authority_invalid');
  for (const key of ['campaignCny', 'monthCny']) if (!Number.isFinite(configuration?.budget?.[key]) || configuration.budget[key] < 1e-8 || configuration.budget[key] > RSI_CAMPAIGN_LIMITS[key] || Math.abs(configuration.budget[key] * 1e8 - Math.round(configuration.budget[key] * 1e8)) > 1e-5) issues.push('campaign_budget_invalid');
  return [...new Set(issues)];
}
/** @param {any} configuration */
export function assertRsiLabConfiguration(configuration) {
  const issues = rsiLabConfigurationIssues(configuration);
  if (issues.length) throw new HttpError(503, 'campaign_lab_unavailable', issues.join(', '));
  return configuration;
}
