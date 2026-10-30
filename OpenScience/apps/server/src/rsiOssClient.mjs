import { open, constants } from 'node:fs/promises';

/** Validate deployment bindings without network access or an IAM claim. @param {any} config */
export function rsiOssConfigurationIssues(config) {
  const issues = [];
  if (!['production', 'lab'].includes(config?.role)) issues.push('rsi_oss_role_invalid');
  if (typeof config?.region !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(config.region) || config.endpoint !== `https://oss-${config.region}.aliyuncs.com`) issues.push('rsi_oss_endpoint_invalid');
  const bucket = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
  if (!bucket.test(config?.incidentBucket ?? '') || !bucket.test(config?.bundleBucket ?? '') || config.incidentBucket === config.bundleBucket) issues.push('rsi_oss_buckets_invalid');
  const refs = config?.identityRefs;
  if (!refs || typeof refs.production !== 'string' || typeof refs.lab !== 'string' || !refs.production.startsWith('/') || !refs.lab.startsWith('/') || refs.production === refs.lab) issues.push('rsi_oss_identity_refs_invalid');
  return issues;
}
/** File descriptors prevent symlink swaps; bytes and errors never include credential values. @param {string} path */
export async function readRsiOssCredentialFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) throw new Error('rsi_oss_credentials_invalid');
    const bytes = Buffer.alloc(8193); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8192) throw new Error('rsi_oss_credentials_invalid');
    let value;
    try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); } catch { throw new Error('rsi_oss_credentials_invalid'); }
    if (!value || Array.isArray(value) || Object.keys(value).some(key => !['accessKeyId', 'accessKeySecret', 'stsToken'].includes(key)) || ['accessKeyId', 'accessKeySecret'].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 4096) || value.stsToken !== undefined && (typeof value.stsToken !== 'string' || !value.stsToken || value.stsToken.length > 4096)) throw new Error('rsi_oss_credentials_invalid');
    return value;
  } finally { await file.close(); }
}
/** SDK import and credential access occur only after complete configuration. @param {any} config @param {any} options */
export async function createRsiOssClient(config, options = {}) {
  const issues = rsiOssConfigurationIssues(config);
  const preflight = { configured: !issues.length, issues, permissionsVerified: false, resourceBindingsVerified: false };
  if (issues.length) return { available: false, preflight };
  const credentials = await readRsiOssCredentialFile(config.identityRefs[config.role]);
  const OSS = options.sdkFactory ?? (await import('ali-oss')).default;
  const clients = Object.fromEntries(['incidentBucket', 'bundleBucket'].map(channel => [channel, new OSS({ ...credentials, region: `oss-${config.region}`, endpoint: config.endpoint, bucket: config[channel], secure: true, timeout: 30000 })]));
  return { available: true, preflight, clients };
}
