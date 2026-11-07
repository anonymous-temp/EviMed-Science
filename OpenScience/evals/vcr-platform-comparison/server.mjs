#!/usr/bin/env node
// Local control plane and real host DSH; container isolation is not exercised.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

for (const key of ['OS', 'TREE_DIR', 'LIVE_DIR', 'LIVE_DATA', 'LIVE_DATABASE_URL', 'DSH_BIN', 'EVAL_DEEPSEEK_KEY_FILE', 'VCR_COLLECTION_MANIFEST']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
for (const key of ['EVAL_PERSONA', 'EVAL_FAULT', 'LIVE_HOOK', 'EVAL_KERNEL_ENV']) {
  if (process.env[key]) throw new Error(`${key} is prohibited in this benchmark`);
}
const port = Number(process.env.LIVE_PORT ?? 58903);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const database = new URL(process.env.LIVE_DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1','localhost'].includes(database.hostname)
    || database.search || database.hash || !/^\/evimed_test_[a-z0-9_]+$/.test(database.pathname)) throw new Error('A dedicated local test database is required');
if (!process.env.VCR_BENCHMARK_BUDGET_FILE || !path.isAbsolute(process.env.VCR_BENCHMARK_BUDGET_FILE)) throw new Error('A persistent campaign budget file is required');
process.env.LIVE_PORT=String(port);
process.env.VCR_BENCHMARK_INSTANCE=randomUUID();
const env = {
  OPEN_SCIENCE_NATIVE_MEMORY_TURN_COMMIT_ENABLED: 'false', OPEN_SCIENCE_MEMORY_ENABLED: 'false',
  OPEN_SCIENCE_MEMORY_RECALL_ENABLED: 'false', OPEN_SCIENCE_LEARNING_ENABLED: 'false',
  OPEN_SCIENCE_EVOLUTION_ENABLED: 'false', OPEN_SCIENCE_AUTOPILOT_ENABLED: 'false', OPEN_SCIENCE_LOOPX_ENABLED: 'false',
  OPEN_SCIENCE_DEV_AUTH: 'false', OPEN_SCIENCE_SELF_REGISTRATION_ENABLED: 'true',
  OPEN_SCIENCE_VCR_ENABLED: 'true', OPEN_SCIENCE_VCR_AUDIENCE: 'all', OPEN_SCIENCE_VCR_PROVIDER_AGREEMENTS: 'true',
  OPEN_SCIENCE_VCR_TRIAL_CORPUS_MANIFEST: process.env.VCR_COLLECTION_MANIFEST,
  OPEN_SCIENCE_VCR_DATA_PLANE_DIR: path.join(process.env.LIVE_DATA, 'vcr'), OPEN_SCIENCE_MAX_PROJECTS_PER_USER: '100',
};
process.env.EVAL_CAPTURE_REQUEST_BODIES = 'false';
process.env.LIVE_ENV = JSON.stringify(env);
process.env.LIVE_OVERRIDES = JSON.stringify({ devAuth: false, authMode: 'local', selfRegistrationEnabled: true,
  databaseUrl:process.env.LIVE_DATABASE_URL,databaseUrlFile:'',deepseekBaseUrl:'https://api.deepseek.com',vcrEngineUrl:'',
  publicUrl: `http://127.0.0.1:${port}`, localAutoConfig: false, deepseekModel: 'deepseek-flash',
  runtimeUiProxyEnabled:true,host:'127.0.0.1',runtimeUiPort:0,
  maxProjectsPerUser: 100, userDailySpendLimit: 5, userRunSpendLimit: 4,
  nativeMemoryTurnCommitEnabled: false,
  memoryEnabled: false, memoryRecallEnabled: false, learningEnabled: false, evolutionEnabled: false,
  autopilotEnabled: false, loopxEnabled: false, vcrEnabled: true, vcrAudience: 'all', vcrProviderAgreements: true,
  vcrProviderAgreementReference:'Public synthetic TrialGPT and TREC evaluation inputs; no clinical enrollment decisions',
  vcrTrialCorpusManifest: process.env.VCR_COLLECTION_MANIFEST, vcrDataPlaneDir: path.join(process.env.LIVE_DATA, 'vcr') });
const harness = await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../general-tasks/runner/harness.mjs'));
// The receipt uses the same resolved configuration passed to the real runtime manager.
// A dirty tree is useful only for readiness probes, never a paid baseline.
if (process.env.VCR_STARTUP_RECEIPT) {
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const fs = await import('node:fs/promises');
  const repo = path.resolve(process.env.OS, '..');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const modules = ['apps/server/src/server.mjs', 'apps/server/src/vcrService.mjs',
    'apps/server/src/vcrTrialCorpus.mjs', 'apps/server/src/vcrGateway.mjs',
    'apps/server/src/vcrRoutes.mjs', 'apps/server/src/config.mjs', 'evals/general-tasks/runner/harness.mjs', 'evals/vcr-platform-comparison/server.mjs', 'evals/vcr-platform-comparison/budget-guard.mjs'];
  const hashes = {};
  for (const module of modules) hashes[module] = createHash('sha256').update(await fs.readFile(path.join(process.env.OS, module))).digest('hex');
  const resolvedConfig = harness.harnessConfiguration();
  if (!resolvedConfig || resolvedConfig.production || resolvedConfig.runtimeMode !== 'kernel' || resolvedConfig.deepseekModel !== 'deepseek-flash' || resolvedConfig.runtimeUiProxyEnabled !== true
      || ['memoryEnabled','memoryRecallEnabled','nativeMemoryTurnCommitEnabled','learningEnabled'].some(key => resolvedConfig[key] !== false)) throw new Error('Benchmark isolation configuration did not take effect');
  const stageChecks = [];
  const checkTree = async (source, staged) => {
    for (const entry of await fs.readdir(source,{withFileTypes:true})) {
      if (entry.isDirectory()) await checkTree(path.join(source,entry.name),path.join(staged,entry.name));
      else if (entry.isFile()) {
        const digest = bytes => createHash('sha256').update(bytes).digest('hex');
        if (digest(await fs.readFile(path.join(source,entry.name))) !== digest(await fs.readFile(path.join(staged,entry.name)))) throw new Error('Staged runtime differs: '+entry.name);
      }
    }
    stageChecks.push(path.relative(process.env.OS,source));
  };
  for (const component of ['domain','harness-port','design-tokens']) await checkTree(path.join(process.env.OS,'packages',component,'src'),path.join(process.env.TREE_DIR,'opt/socket/node_modules/@evimed',component,'src'));
  for (const component of ['src','plugins']) await checkTree(path.join(process.env.OS,'packages/socket',component),path.join(process.env.TREE_DIR,'opt/socket',component));
  await checkTree(path.join(process.env.OS,'capability-skills/vcr-matching'),path.join(process.env.TREE_DIR,'opt/socket/capability-skills/vcr-matching'));
  const version=execFileSync(process.env.DSH_BIN,['--version'],{encoding:'utf8'}).trim();
  const pinned=JSON.parse(await fs.readFile(path.join(process.env.OS,'deps-version.json'),'utf8')).dsh.version;
  if(version!==pinned)throw new Error('Native kernel version differs');
  if(process.platform==='darwin'){
    execFileSync('/usr/bin/sandbox-exec',['-p','(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))','--','/usr/bin/true'],{stdio:'pipe'});
  }
  const receipt = { schema: 1, createdAt: new Date().toISOString(), sourceSha: git('rev-parse', 'HEAD'),
    dirty: Boolean(git('status', '--porcelain')), treeDir: process.env.TREE_DIR, modules: hashes,
    origin:`http://127.0.0.1:${port}`,instance:process.env.VCR_BENCHMARK_INSTANCE,pid:process.pid,
    sandboxBackend:process.platform==='darwin'?'native-seatbelt':'image-runner',approvalPolicy:'never',
    budget:{file:process.env.VCR_BENCHMARK_BUDGET_FILE,totalLimit:Number(process.env.VCR_BENCHMARK_BUDGET_CNY??200),accountLimit:5,allModelPurposes:true,
      basis:'reference-price estimated reservations, with actual settlement and conservative uncertain retention; not an invoice guarantee'},
    collectionManifestSha256:createHash('sha256').update(await fs.readFile(process.env.VCR_COLLECTION_MANIFEST)).digest('hex'),
    configurationEvidence: 'resolved configuration verified', resolvedConfig, kernelVersion:version, stageChecks,
    seedSha256:createHash('sha256').update(await fs.readFile(path.join(process.env.TREE_DIR,'dsh-seed/.evimed-profile-seed.json'))).digest('hex'),
    isolation: 'host DSH with mapped container launch; no container isolation' };
  await fs.mkdir(path.dirname(process.env.VCR_STARTUP_RECEIPT), { recursive: true, mode: 0o700 });
  await fs.writeFile(process.env.VCR_STARTUP_RECEIPT, JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
