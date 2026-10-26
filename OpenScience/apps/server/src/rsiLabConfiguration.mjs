import { isAbsolute, normalize } from 'node:path';
import { rsiLabBindingIssues, RSI_CAMPAIGN_LIMITS } from '../../../packages/domain/src/rsiCampaign.mjs';
import { HttpError } from './security.mjs';

/** Deployment-owned configuration only; no customer or serving fallback. @param {any} configuration */
export function rsiLabConfigurationIssues(configuration) {
  const issues = rsiLabBindingIssues(configuration);
  if (configuration?.host?.role !== undefined && configuration.host.role !== 'rsi-lab') issues.push('campaign_host_unavailable');
  if (configuration && Object.keys(configuration).some(key => !['host', 'transport', 'signer', 'authority', 'budget', 'providers'].includes(key))) issues.push('campaign_lab_configuration_invalid');
  const authority = configuration?.authority;
  if (authority?.role !== 'rsi-lab' || typeof authority.accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(authority.accountId)
    || typeof authority.dataDir !== 'string' || !isAbsolute(authority.dataDir) || normalize(authority.dataDir) !== authority.dataDir || !authority.dataDir.split('/').includes('rsi-lab')
    || typeof authority.databaseRole !== 'string' || !/^rsi_lab(?:_[a-z0-9_]+)?$/.test(authority.databaseRole)) issues.push('campaign_lab_authority_invalid');
  for (const key of ['campaignCny', 'monthCny']) if (!Number.isFinite(configuration?.budget?.[key]) || configuration.budget[key] <= 0 || configuration.budget[key] > RSI_CAMPAIGN_LIMITS[key]) issues.push('campaign_budget_invalid');
  for (const [role, provider, model] of [['deepseekFlash', 'deepseek', 'deepseek-flash'], ['qwenMax', 'dashscope', 'qwen3.8-max']]) {
    const value = configuration?.providers?.[role];
    if (!value || Object.keys(value).some(key => !['provider', 'model', 'credentialRef'].includes(key)) || value.provider !== provider || value.model !== model
      || typeof value.credentialRef !== 'string' || !/^lab:[A-Za-z0-9_:-]{1,150}$/.test(value.credentialRef)) issues.push('campaign_lab_provider_unavailable');
  }
  return [...new Set(issues)];
}
/** @param {any} configuration */
export function assertRsiLabConfiguration(configuration) {
  const issues = rsiLabConfigurationIssues(configuration);
  if (issues.length) throw new HttpError(503, 'campaign_lab_unavailable', issues.join(', '));
  return configuration;
}
