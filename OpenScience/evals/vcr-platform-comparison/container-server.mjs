import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWebApiApp } from '../../apps/server/src/server.mjs';
import { installBudgetGuard } from './budget-guard.mjs';
import { closedCorpusFetch, installClosedCorpusFence, runtimeSocketFence } from './container-boundary.mjs';

const launch = JSON.parse(await fs.readFile('/audit/launch.json'));
const configFile = '/audit/collection.json';
const budgetFile = '/budget/budget.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const collectionBytes = await fs.readFile(configFile);
let vcrFetchAllowed = 0;
let vcrFetchBlocked = 0;
if (sha256(collectionBytes) !== launch.collectionManifestSha256) throw new Error('Collection bytes differ');
const password = (await fs.readFile('/audit/secrets/postgres', 'utf8')).trim();
const app = createWebApiApp({
  authMode: 'local', devAuth: false, selfRegistrationEnabled: true, localAutoConfig: false,
  sessionCookieName: 'os_vcr_container_benchmark',
  host: '0.0.0.0', port: 8787, publicUrl: launch.origin,
  dataDir: '/data', stateStore: 'postgres',
  databaseUrl: `postgresql://vcr_bench:${password}@${launch.name}-pg:5432/evimed_test_vcr`,
  runtimeMode: 'kernel', runtimeProvider: 'docker', runtimeSandboxMode: 'docker',
  runtimeControllerMode: 'direct', allowDirectDockerControl: true,
  runtimeContainerBin: '/audit/docker', runtimeContainerImage: launch.image,
  runtimeRequireImageLocal: true, runtimeDataVolume: launch.volume, runtimeTransport: 'unix',
  runtimeNetworkMode: launch.network, runtimeInternalNetworkName: launch.network, allowRuntimeNetworkEgress: false,
  runtimeUiProxyEnabled: true, runtimeUiPort: 8788, runtimeUiPublicOrigin: launch.uiOrigin,
  modelGatewayInternalUrl: `http://${launch.name}:8787/internal/model/v1`,
  publicSourceGatewayInternalUrl: `http://${launch.name}:8787/internal/sources/v1/fetch`,
  deepseekApiKeyFile: launch.paid ? '/audit/deepseek.api-key' : '',
  deepseekBaseUrl: 'https://api.deepseek.com', deepseekModel: 'deepseek-flash',
  modelGatewaySigningSecretFile: '/audit/secrets/model',
  evimedWorkloadSigningSecretFile: '/audit/secrets/workload',
  nativeMemoryTurnCommitEnabled: false, memoryEnabled: false, memoryRecallEnabled: false,
  learningEnabled: false, evolutionEnabled: false, autopilotEnabled: false, loopxEnabled: false,
  ovKnowledgeEnabled: false, jevEnabled: false, runTitlesEnabled: false,
  webReadEnabled: false, webReadEdgeFallback: false, webReadDeepseekFallbackEnabled: false,
  webSearchDeepseekEnabled: false, webSearchBailianEnabled: false, webSearchUrl: '', webSearchEdgeUrl: '',
  sourceIngestionEnabled: false, sourceUpdatesEnabled: false, sourceMaterialsEnabled: false, kbSearchEnabled: false,
  approvalMode: 'never', maxProjectsPerUser: 100,
  userDailySpendLimit: 5, userRunSpendLimit: 4, userWeeklySpendLimit: 5,
  vcrEnabled: true, vcrAudience: 'all', vcrProviderAgreements: true,
  vcrProviderAgreementReference: 'Public synthetic TrialGPT and TREC evaluation inputs; no clinical enrollment decisions',
  vcrFetch: closedCorpusFetch((...args) => {
    vcrFetchAllowed += 1;
    return fetch(...args);
  }, () => { vcrFetchBlocked += 1; }),
  vcrTrialCorpusManifest: configFile, vcrDataPlaneDir: '/data/vcr', vcrEngineUrl: '',
});
const expected = {
  production: false, authMode: 'local', selfRegistrationEnabled: true, devAuth: false,
  runtimeMode: 'kernel', runtimeProvider: 'docker', runtimeSandboxMode: 'docker',
  runtimeControllerMode: 'direct', allowDirectDockerControl: true,
  runtimeRequireImageLocal: true, runtimeDataVolume: launch.volume, runtimeTransport: 'unix',
  runtimeNetworkMode: launch.network, runtimeInternalNetworkName: launch.network,
  allowRuntimeNetworkEgress: false, runtimeUiProxyEnabled: true, approvalMode: 'never',
  deepseekModel: 'deepseek-flash', deepseekBaseUrl: 'https://api.deepseek.com',
  nativeMemoryTurnCommitEnabled: false, memoryEnabled: false, memoryRecallEnabled: false,
  learningEnabled: false, evolutionEnabled: false, autopilotEnabled: false, loopxEnabled: false,
  webReadEnabled: false, webReadEdgeFallback: false, webReadDeepseekFallbackEnabled: false,
  webSearchDeepseekEnabled: false, webSearchBailianEnabled: false, webSearchUrl: '', webSearchEdgeUrl: '',
  sourceIngestionEnabled: false, sourceUpdatesEnabled: false, sourceMaterialsEnabled: false, kbSearchEnabled: false,
  vcrEnabled: true, vcrTrialCorpusManifest: configFile, vcrEngineUrl: '', userDailySpendLimit: 5,
};
const resolvedConfig = {};
for (const [key, value] of Object.entries(expected)) {
  if (app.config[key] !== value) throw new Error(`Benchmark configuration differs: ${key}`);
  resolvedConfig[key] = app.config[key];
}
if (Boolean(app.config.deepseekApiKey) !== launch.paid) throw new Error('Provider key does not match paid mode');
const modules = {};
for (const module of [
  'apps/server/src/server.mjs', 'apps/server/src/vcrService.mjs', 'apps/server/src/vcrPatientTrials.mjs',
  'apps/server/src/vcrTrialCorpus.mjs', 'apps/server/src/vcrCandidateTrialStore.mjs',
  'apps/server/src/vcrGateway.mjs', 'apps/server/src/vcrRoutes.mjs', 'apps/server/src/config.mjs',
  'evals/vcr-platform-comparison/container-server.mjs', 'evals/vcr-platform-comparison/container-launch.mjs',
  'evals/vcr-platform-comparison/container-probe.mjs', 'evals/vcr-platform-comparison/container-boundary.mjs',
  'evals/vcr-platform-comparison/container-resources.mjs',
  'evals/vcr-platform-comparison/container-runtime.Dockerfile', 'evals/vcr-platform-comparison/budget-guard.mjs',
]) modules[module] = sha256(await fs.readFile(new URL('../../'+module, import.meta.url)));

const instance = randomUUID();
let budget;
const onRuntimeNetwork = runtimeSocketFence(launch.internalSubnet);
installClosedCorpusFence(app.server, { onRuntimeNetwork, instance });
installClosedCorpusFence(app.runtimeUi.server, { onRuntimeNetwork, instance, ui: true });
try {
  const collection = JSON.parse(collectionBytes).id;
  // Read the real index through the product service without manufacturing a
  // native call or opening a patient study. The separate runtime probe checks
  // the live workload token and leaves native invocation proof in place.
  const scope = { userId: 'benchmark-startup-probe', id: null };
  const frozen = await app.vcr.service.runtimeRead(scope, 'candidates', { collection, condition: 'diabetes', limit: 1 });
  const live = await app.vcr.service.runtimeRead(scope, 'trial_registry_record', {
    registry: 'clinicaltrials.gov', registryId: 'NCT00000000',
  });
  if (!frozen.available || frozen.collection?.id !== collection || !frozen.collection?.revision
      || live.available !== false || vcrFetchBlocked < 1 || vcrFetchAllowed !== 0) {
    throw new Error('Frozen collection or registry egress boundary failed');
  }
  budget = await installBudgetGuard(app.usageLedger, { file: budgetFile });
  await app.listen(8787, '0.0.0.0');
  const receipt = {
    schema: 1, createdAt: new Date().toISOString(), sourceSha: launch.sourceSha, dirty: launch.dirty,
    origin: launch.origin, instance, modules, sandboxBackend: 'docker', approvalPolicy: 'never',
    configurationEvidence: 'resolved configuration verified', resolvedConfig,
    image: launch.image, baseImage: launch.baseImage, overlaySha256: launch.overlaySha256, kernelVersion: launch.kernelVersion,
    paid: launch.paid, closedCorpus: true, internalSubnet: launch.internalSubnet,
    corpusProbe: { collection, revision: frozen.collection.revision, liveAvailable: live.available,
      blockedRegistryFetches: vcrFetchBlocked, allowedFetches: vcrFetchAllowed }, collectionManifestHostPath: launch.collectionManifestHostPath,
    collectionManifestSha256: launch.collectionManifestSha256, collectionDatabaseSha256: launch.collectionDatabaseSha256,
    budget: { file: launch.budgetHostPath, totalLimit: budget.totalLimit, accountLimit: budget.accountLimit,
      allModelPurposes: true, basis: 'Reference-price estimated reservations with settlement and conservative uncertain retention' },
  };
  await fs.writeFile('/audit/startup.json', JSON.stringify(receipt, null, 2)+'\n', { mode: 0o600, flag: 'wx' });
} catch (error) {
  try { await app.close(); } finally { await budget?.close(); }
  throw error;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    try { await app.close(); } finally { await budget?.close(); }
  });
}
