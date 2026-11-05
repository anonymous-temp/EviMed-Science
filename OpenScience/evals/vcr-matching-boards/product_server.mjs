#!/usr/bin/env node
/**
 * The product server of the real-kernel runs: the platform's own control plane on this host with a real DSH kernel, through the
 * general-tasks harness (it replaces only the container launch). Started by `run_product.mjs`, which passes everything in the
 * environment; nothing here is read from a default path.
 *
 * This is configuration, not a second harness: the comparison campaign's `server.mjs` sets the same environment and imports the
 * same file. It differs in three ways a diagnostic needs: the model provider's base URL is a parameter (so a plumbing check can
 * point at a local stand-in), the budget is a parameter, and the receipt it writes says what it is, a host-kernel diagnostic run,
 * which the formal path (`verifyContainerStartup` in the comparison's `run.mjs`) refuses by design.
 *
 * Environment (all required unless marked): OS, TREE_DIR, LIVE_DIR, LIVE_DATA, LIVE_PORT, LIVE_DATABASE_URL (a local evimed_test_*),
 * DSH_BIN, EVAL_DEEPSEEK_KEY_FILE, VCR_BENCHMARK_BUDGET_FILE (absolute), VCR_BENCHMARK_BUDGET_CNY, VCR_STARTUP_RECEIPT,
 * VCR_COLLECTION_MANIFEST (optional: the frozen trial collection of a ranking board), PRODUCT_MODEL_BASE_URL (optional), PRODUCT_ENGINE_STANDIN (optional, 1),
 * PRODUCT_JUDGE_CONCURRENCY (optional).
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const key of ['OS', 'TREE_DIR', 'LIVE_DIR', 'LIVE_DATA', 'LIVE_DATABASE_URL', 'DSH_BIN', 'EVAL_DEEPSEEK_KEY_FILE', 'VCR_BENCHMARK_BUDGET_FILE', 'VCR_STARTUP_RECEIPT']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
for (const key of ['EVAL_PERSONA', 'EVAL_FAULT', 'LIVE_HOOK', 'EVAL_KERNEL_ENV']) {
  if (process.env[key]) throw new Error(`${key} is prohibited in this benchmark`);
}
const port = Number(process.env.LIVE_PORT ?? 58903);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const database = new URL(process.env.LIVE_DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost'].includes(database.hostname)
    || database.search || database.hash || !/^\/evimed_test_[a-z0-9_]+$/.test(database.pathname)) throw new Error('A dedicated local test database is required');
if (!path.isAbsolute(process.env.VCR_BENCHMARK_BUDGET_FILE)) throw new Error('A persistent campaign budget file is required');
const modelBase = process.env.PRODUCT_MODEL_BASE_URL || 'https://api.deepseek.com';
const manifest = process.env.VCR_COLLECTION_MANIFEST || '';
const judgeConcurrency = Math.max(1, Math.min(64, Number(process.env.PRODUCT_JUDGE_CONCURRENCY ?? 8) || 8));
const instance = randomUUID();
process.env.VCR_BENCHMARK_INSTANCE = instance;
process.env.EVAL_CAPTURE_REQUEST_BODIES = 'false';
process.env.LIVE_PORT = String(port);

// `vcr_simulate`, the tool that starts the judging job, is offered without the deterministic VCR engine (judging patients is local to the control plane,
// and only `evidence_pool` waits for the engine), so no stand-in engine is composed here. PRODUCT_ENGINE_STANDIN=1 brings back the old one: a URL
// nothing listens on and a random token, for a run that wants the engine-backed tools offered and refusing.
const engineToken = path.join(process.env.LIVE_DATA, 'engine-token');
const standIn = process.env.PRODUCT_ENGINE_STANDIN === '1';
if (standIn && !fsSync.existsSync(engineToken)) fsSync.writeFileSync(engineToken, randomBytes(48).toString('base64url'), { mode: 0o600 });
process.env.LIVE_ENV = JSON.stringify({
  OPEN_SCIENCE_NATIVE_MEMORY_TURN_COMMIT_ENABLED: 'false', OPEN_SCIENCE_MEMORY_ENABLED: 'false', OPEN_SCIENCE_MEMORY_RECALL_ENABLED: 'false', OPEN_SCIENCE_LEARNING_ENABLED: 'false',
  OPEN_SCIENCE_EVOLUTION_ENABLED: 'false', OPEN_SCIENCE_AUTOPILOT_ENABLED: 'false', OPEN_SCIENCE_LOOPX_ENABLED: 'false',
  OPEN_SCIENCE_DEV_AUTH: 'false', OPEN_SCIENCE_SELF_REGISTRATION_ENABLED: 'true',
  OPEN_SCIENCE_VCR_ENABLED: 'true', OPEN_SCIENCE_VCR_AUDIENCE: 'all', OPEN_SCIENCE_VCR_PROVIDER_AGREEMENTS: 'true',
  OPEN_SCIENCE_VCR_DATA_PLANE_DIR: path.join(process.env.LIVE_DATA, 'vcr'), OPEN_SCIENCE_MAX_PROJECTS_PER_USER: '100',
  ...(manifest ? { OPEN_SCIENCE_VCR_TRIAL_CORPUS_MANIFEST: manifest } : {}),
});
process.env.LIVE_OVERRIDES = JSON.stringify({
  devAuth: false, authMode: 'local', selfRegistrationEnabled: true, databaseUrl: process.env.LIVE_DATABASE_URL, databaseUrlFile: '', deepseekBaseUrl: modelBase, ...(standIn ? { vcrEngineUrl: 'http://127.0.0.1:9', vcrEngineTokenFile: engineToken } : {}),
  publicUrl: `http://127.0.0.1:${port}`, localAutoConfig: false, deepseekModel: 'deepseek-flash', runtimeUiProxyEnabled: true, host: '127.0.0.1', runtimeUiPort: 0,
  maxProjectsPerUser: 100, userDailySpendLimit: Number(process.env.PRODUCT_ACCOUNT_CAP_CNY ?? 5), userRunSpendLimit: Number(process.env.PRODUCT_RUN_CAP_CNY ?? 4),
  nativeMemoryTurnCommitEnabled: false, memoryEnabled: false, memoryRecallEnabled: false, learningEnabled: false, evolutionEnabled: false, autopilotEnabled: false, loopxEnabled: false,
  vcrEnabled: true, vcrAudience: 'all', vcrProviderAgreements: true, vcrProviderAgreementReference: 'Public synthetic patient vignettes and registry records; no clinical enrollment decisions',
  vcrTrialCorpusManifest: manifest, vcrDataPlaneDir: path.join(process.env.LIVE_DATA, 'vcr'), vcrMatchJudgeConcurrency: judgeConcurrency,
});
process.env.VCR_BENCHMARK_BUDGET_CNY ??= '30';

const harness = await import(path.resolve(HERE, '../general-tasks/runner/harness.mjs'));
const digest = (/** @type {Buffer | string} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const repo = path.resolve(process.env.OS, '..');
const git = (/** @type {string[]} */ ...args) => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim(); } catch { return ''; } };
const kernelVersion = execFileSync(process.env.DSH_BIN, ['--version'], { encoding: 'utf8' }).trim();
const pinned = JSON.parse(await fs.readFile(path.join(process.env.OS, 'deps-version.json'), 'utf8')).dsh.version;
if (kernelVersion !== pinned) throw new Error(`The kernel is ${kernelVersion}; deps-version.json pins ${pinned}`);
const resolved = harness.harnessConfiguration();
if (!resolved || resolved.production || resolved.runtimeMode !== 'kernel' || resolved.deepseekModel !== 'deepseek-flash' || resolved.vcrEnabled !== true
    || ['memoryEnabled', 'memoryRecallEnabled', 'nativeMemoryTurnCommitEnabled', 'learningEnabled'].some((key) => resolved[key] !== false)) {
  throw new Error('The isolation configuration did not take effect');
}
// What this receipt is: a host-kernel diagnostic. `verifyContainerStartup` (the formal path) reads `sandboxBackend`, `closedCorpus` and the container
// fields and refuses this file, which is the point: a number from this stack is a diagnostic, never a benchmark result.
const receipt = {
  schema: 1, diagnostic: true, createdAt: new Date().toISOString(), sourceSha: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain', '--', 'OpenScience')),
  origin: `http://127.0.0.1:${port}`, instance, pid: process.pid, isolation: 'host-kernel diagnostic: host DSH with the container launch replaced; no container isolation',
  sandboxBackend: 'host-kernel', approvalPolicy: 'never', kernelVersion, kernelPinned: pinned, modelBaseUrl: modelBase,
  budget: { file: process.env.VCR_BENCHMARK_BUDGET_FILE, totalLimit: Number(process.env.VCR_BENCHMARK_BUDGET_CNY), accountLimit: 5, allModelPurposes: true },
  collectionManifestSha256: manifest ? digest(await fs.readFile(manifest)) : null, resolvedConfig: resolved,
  modelRequestsHostPath: path.join(process.env.LIVE_DATA, 'model-requests.jsonl'),
};
await fs.mkdir(path.dirname(process.env.VCR_STARTUP_RECEIPT), { recursive: true, mode: 0o700 });
await fs.writeFile(process.env.VCR_STARTUP_RECEIPT, JSON.stringify(receipt, null, 2), { mode: 0o600 });
