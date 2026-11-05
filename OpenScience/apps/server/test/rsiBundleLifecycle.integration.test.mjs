// The lifecycle of design §15 Step 3 on a real PostgreSQL through real code: the real runner and statistics reach a verdict, the real finalize.mjs signs it, the bundle lies in a
// directory under the name of its bytes as the pull leaves it, the real runtime composes (transport chosen by the deployment file, poller, worker, importer, serving adapters,
// trust read from the records the installer's own script writes), and the real module policy reader and the real selector read and use what was imported.
//
// The candidate is a benign controlled activation fixture and claims no benefit: seeded rows filed `public` the way finalize's release rules require (`profiles/benign_fixture.mjs`,
// also the finalizer's own tests), whose only purpose is to carry a qualified verdict. What a real month would measure is not measured here, and neither is the network: the
// way the file gets here is `evals/rsi-campaigns/tests/bundleCarrier.test.mjs`. `FrontierPipeline#mix` is not run; `evaluateFrontierSelection` is the call it makes. The second month's export and the
// operator's stop are the real scripts, run as they run in the web container, against the same database.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { frontierMixSelect, PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain';
import { finalizeCampaign } from '../../../evals/rsi-campaigns/finalize.mjs';
import { exportIncumbent } from '../../../evals/rsi-campaigns/frontier_assemble.mjs';
import { finalizerEvidencePayload, qualificationDigests } from '../../../evals/rsi-campaigns/evaluator.mjs';
import { frontierDayPool, frontierRow, procedureReport, registeredCampaignFixture, runToVerdict, STATISTICS_MODULE_PATH, STATISTICS_PYTHON } from '../../../evals/rsi-campaigns/profiles/benign_fixture.mjs';
import { replayFrontierPool } from '../../../evals/rsi-campaigns/frontier_selection.mjs';
import { frontierMixCandidate } from '../src/frontierSelection.mjs';
import { loadConfig } from '../src/config.mjs';
import { migrateFrontier } from '../src/frontierPersistence.mjs';
import { createModuleEvolutionPolicies } from '../src/moduleEvolutionPolicies.mjs';
import { ProductJobs } from '../src/productJobs.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { canonicalRsiJson, rsiDigest } from '../src/rsiCampaignBundle.mjs';
import { rsiClosureSettings } from '../src/rsiClosureSettings.mjs';
import { computeRsiDependencyClosure } from '../src/rsiDependencyClosure.mjs';
import { createRsiOnlineRuntime } from '../src/rsiOnlineRuntime.mjs';
import { createRsiServingAdapters, rsiIncumbent, rsiPolicyDefaults } from '../src/rsiServingAdapters.mjs';
import { PostgresStore } from '../src/store.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { timeout: 400_000, skip: !databaseUrl && 'Disposable localhost PostgreSQL required' };
const repo = new URL('../../../', import.meta.url).pathname;
const SURFACE = 'frontier-selection';
const closureSettings = rsiClosureSettings(SURFACE);
const servingConfig = (threshold) => ({ frontierModel: 'deepseek-flash', frontierSelectThreshold: threshold });
const SIGNED_AT = '2026-10-26T12:00:00.000Z', EXPIRES = '2026-10-30T00:00:00.000Z';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pem = (key) => key.export({ type: 'spki', format: 'pem' });
const signer = (keyId) => { const keys = generateKeyPairSync('ed25519'); return { keyId, ...keys, sign: (bytes) => sign(null, bytes, keys.privateKey) }; };
const fingerprint = (key) => sha(key.export({ type: 'spki', format: 'der' }));
const incumbentFor = (threshold) => rsiIncumbent('frontier', null, rsiPolicyDefaults('frontier', servingConfig(threshold))).revisionId;
const POLICY_ID = 'evolution-module-policy-frontier';

/** The keys of the lab, the consumer of this tree and the qualification the owner pins. */
const base = {};
before(async () => {
  if (!databaseUrl) return;
  base.scratch = await mkdtemp(path.join(tmpdir(), 'rsi-lifecycle-'));
  const closure = await computeRsiDependencyClosure({ rootDir: repo, surface: SURFACE, settings: closureSettings });
  assert.equal(closure.qualified, true, JSON.stringify(closure.issues));
  const issuer = signer('input-evaluator'), report = procedureReport({ generatedAt: '2026-10-20T00:00:00Z' });
  const pinned = await qualificationDigests(report, { claim: 'superiority', rootDir: repo });
  Object.assign(base, { consumer: closure.dependencyDigest, publisher: signer('rsi-lab-publisher'), evaluator: signer('rsi-lab-evaluator'), issuer, report, pinned,
    profile: { publicKey: pem(issuer.publicKey), publicKeySha256: fingerprint(issuer.publicKey), qualificationDigests: [pinned.qualificationDigest], procedureDigests: [pinned.procedureDigest] } });
});
after(async () => { if (base.scratch) await rm(base.scratch, { recursive: true, force: true }); });

const verdicts = new Map();
/** A month's qualified verdict, reached once by the real runner and statistics, bound to the baseline production names. @param {{id?:string, baselineRevision?:string}} [campaign] */
function verdict({ id = 'benign-activation-fixture', baselineRevision = incumbentFor(64) } = {}) {
  const key = `${id}|${baselineRevision}`;
  if (!verdicts.has(key)) verdicts.set(key, (async () => {
    const fixture = await registeredCampaignFixture({ classification: 'public', id });
    fixture.manifest.target = { surface: SURFACE, dependencyDigest: base.consumer, baselineRevision };
    fixture.inputs.target = structuredClone(fixture.manifest.target);
    const run = await runToVerdict(fixture, { dir: path.join(base.scratch, `verdict-${verdicts.size}`) });
    assert.equal(run.completed?.status, 'completed', JSON.stringify(run.awaiting).slice(0, 300));
    assert.equal(run.completed.qualification, 'qualified', JSON.stringify(run.completed.checkpoint?.evaluation?.reasons));
    const { files, ...signed } = await finalizerEvidencePayload({ manifest: fixture.manifest, inputs: fixture.inputs, checkpoint: run.completed.checkpoint, report: base.report, rootDir: repo, now: SIGNED_AT });
    assert.deepEqual(JSON.parse(files[0].content), { selectionThreshold: 72 }, 'the controlled candidate');
    return { fixture, completed: run.completed, files, evidenceEnvelope: { payload: signed, signature: base.issuer.sign(Buffer.from(`evimed-rsi-evaluation-input-v1\n${canonicalRsiJson(signed)}`)).toString('base64') } };
  })());
  return verdicts.get(key);
}

const finalized = new Map();
/** What `finalize.mjs` writes for the month: its bytes, and the name those bytes have in the outbox and in production's directory. One signing per distinct bundle (each starts the statistics
 * process); on a box under load that process can pass the finalizer's 30 s bound, and that one refusal, by its own code, is tried again. */
async function finalize({ campaign = {}, bundleId = 'benign-activation-bundle', expiresAt = EXPIRES, publisher = base.publisher, evaluator = base.evaluator } = {}) {
  const key = [JSON.stringify(campaign), bundleId, expiresAt, publisher.keyId, fingerprint(publisher.publicKey), evaluator.keyId, fingerprint(evaluator.publicKey)].join('|');
  if (finalized.has(key)) return finalized.get(key);
  const month = await verdict(campaign);
  for (let attempt = 1; ; attempt++) {
    try {
      const envelope = await finalizeCampaign({ completed: month.completed, manifest: month.fixture.manifest, inputs: month.fixture.inputs, files: month.files, evidenceEnvelope: month.evidenceEnvelope, profile: base.profile,
        currentTarget: month.fixture.manifest.target, root: repo, bundleId, expiresAt, now: SIGNED_AT, loadSigners: async () => ({ publisher, evaluator }),
        statisticsPython: STATISTICS_PYTHON, statisticsModulePath: STATISTICS_MODULE_PATH, closureSettings });
      const bytes = `${JSON.stringify(envelope)}\n`;
      const bundle = { envelope, bytes, digest: sha(bytes) };
      finalized.set(key, bundle);
      return bundle;
    } catch (error) { if (error.message !== 'campaign_statistics_timeout' || attempt === 3) throw error; }
  }
}

/** A deployment on a database of its own: the records written by the installer's own script, the real runtime over them, a clock the test moves. `activation` replaces the installed exposure for a test about something else. */
async function deployment({ threshold = 64, activation = null }, operation) {
  const isolated = await createGeoTestDatabase(databaseUrl, 'rsilife');
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-deployment-'));
  const store = new PostgresStore(loadConfig({ dataDir: path.join(dir, 'data'), databaseUrl: isolated.url, stateStore: 'postgres', devAuth: true, operatorUsers: [] }));
  try {
    const online = path.join(dir, 'online'), bundles = path.join(online, 'bundles'), registryFile = path.join(online, 'evaluators.json');
    await mkdir(bundles, { recursive: true });
    const facts = path.join(dir, 'facts.json');
    await writeFile(facts, JSON.stringify({ publisher: { keyId: base.publisher.keyId, publicKey: pem(base.publisher.publicKey) }, evaluator: { keyId: base.evaluator.keyId, publicKey: pem(base.evaluator.publicKey) }, procedureDigests: [base.pinned.procedureDigest] }));
    execFileSync('python3', ['-I', path.join(repo, 'deploy/rsi-campaign/production/rsi-online-records.py'), online, facts, base.consumer]);
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    if (activation) await writeFile(registryFile, JSON.stringify({ ...registry, activationPolicies: { [SURFACE]: { ...registry.activationPolicies[SURFACE], ...activation } } }), { mode: 0o600 });
    // The one line that differs from a host: the file names this directory, not the container's mount.
    const file = path.join(online, 'online.local.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, transport: { kind: 'directory', role: 'production', path: bundles }, trustedKeyRefs: [path.join(online, 'publisher.json')], evaluatorRegistryRef: registryFile }), { mode: 0o600 });
    const database = store.database;
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('rsi_operator','RSI operator','development') ON CONFLICT DO NOTHING");
    const documents = new ProductDocuments(database), jobs = new ProductJobs(database);
    let instant = '2026-10-26T13:00:00.000Z';
    const said = [];
    const start = async () => {
      const serving = createRsiServingAdapters({ config: servingConfig(threshold), service: { owner: async () => 'rsi_operator' }, database, documents, report: (code) => said.push(code) });
      const runtime = await createRsiOnlineRuntime({ config: { rsiOnlineConfigFile: file }, store, documents, jobs, database, agentRuns: { list: () => assert.fail('no run is read on this deployment') }, servingAdapters: serving,
        model: () => assert.fail('no model is called on this deployment'), report: (code) => said.push(code), now: () => new Date(instant) });
      // As the server composes it: the module policy reader over the serving adapters.
      return { serving, runtime, policies: createModuleEvolutionPolicies({ readPolicy: (moduleId, scope) => serving.readPolicy(moduleId, scope) }) };
    };
    const { serving, runtime, policies } = await start();
    const journal = async (id = 'benign-activation-bundle') => (await database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND payload->>'recordType'='rsi-campaign-import' AND payload->>'id'=$2", [PLATFORM_PUBLISHER_USER_ID, id])).rows[0]?.payload ?? null;
    const journals = async () => (await database.query("SELECT 1 FROM evimed_product.documents WHERE user_id=$1 AND payload->>'recordType'='rsi-campaign-import'", [PLATFORM_PUBLISHER_USER_ID])).rowCount;
    const count = async (recordType) => (await database.query("SELECT 1 FROM evimed_product.documents WHERE user_id=$1 AND payload->>'recordType'=$2", [PLATFORM_PUBLISHER_USER_ID, recordType])).rowCount;
    const intake = async (digest) => (await documents.get(PLATFORM_PUBLISHER_USER_ID, 'knowledge', `rsi-bundle-intake-${digest}`))?.payload ?? null;
    /** The states a journal went through, in the order the ledger recorded them, runs of one state as one. */
    const milestones = async (id = 'benign-activation-bundle') => {
      const rows = await database.query("SELECT payload->>'state' AS state FROM evimed_product.revisions WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='rsi-campaign-import' AND payload->>'id'=$2 ORDER BY revision", [PLATFORM_PUBLISHER_USER_ID, id]);
      return rows.rows.map((row) => row.state).filter((state, index, states) => state !== states[index - 1]);
    };
    const policyDocument = () => documents.get('rsi_operator', 'knowledge', POLICY_ID);
    /** A script of scripts/ops as it runs in the web container: this release's code, this deployment's database, the module policy's owner. */
    const script = (name, args) => {
      const done = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: execFileSync('cat', [path.join(repo, 'scripts/ops', name)]), encoding: 'utf8', cwd: dir, maxBuffer: 1 << 24,
        env: { PATH: process.env.PATH, RSI_EXPORT_APP_ROOT: repo.replace(/\/$/, ''), OPEN_SCIENCE_DATABASE_URL: isolated.url, OPEN_SCIENCE_DATA_DIR: path.join(dir, 'data'), OPEN_SCIENCE_OPERATOR_USERS: 'rsi_operator', OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD: String(threshold), OPEN_SCIENCE_RELEASE_ID: 'release-lifecycle.1' } });
      return { status: done.status, stderr: done.stderr, json: done.stdout.trim() ? JSON.parse(done.stdout) : null };
    };
    const pollWith = async (worker) => { const job = await worker.tick(); assert.equal(job?.status, 'succeeded', JSON.stringify(job)); return job.result; };
    await operation({ runtime, serving, policies, documents, jobs, database, bundles, registryFile, said, journal, journals, count, intake, milestones, policyDocument, script, start, pollWith,
      put: (bundle) => writeFile(path.join(bundles, `${bundle.digest}.json`), bundle.bytes),
      /** One turn of the worker: the poll job it claims is the real one, and the next is queued by the clock the test moves. */
      poll: () => pollWith(runtime.worker),
      at: (value) => { instant = value; } });
    await runtime.worker.close();
  } finally {
    await store.database.close();
    await isolated.drop();
    await rm(dir, { recursive: true, force: true });
  }
}

const candidate = (id, score) => ({ id, genre: 'news', zh: false, score, selected: false, rule: null, safety: false, sourceId: `s${id}`, sourceCap: 3, eligible: true, summarized: false, besideSelected: false, eventId: null });
const pool = (low, high, lowScore = 70) => ({ candidates: [...Array.from({ length: low }, (_, i) => candidate(`a${i}`, lowScore)), ...Array.from({ length: high }, (_, i) => candidate(`b${i}`, 90))], threshold: 64, events: {}, congressActive: false, preprintPlaces: 2, preprintMinScore: 60, genreFloors: {} });
const round = pool(6, 6);
const ctx = { userId: 'researcher', projectId: 'research' };
const at = (day) => ({ now: `${day}T15:00:00Z`, day });
/** A deployment's exposure short enough for a test about something else: two executions over two days to each stage. */
const SHORT = { minExecutions: 2, minDays: 2 };
/** Through shadow to the global stage, on rounds inside the bound. */
async function toGlobal(d, next = 'mix') {
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: `${next}-1`, ...at('2026-10-26') });
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: `${next}-2`, ...at('2026-10-27') });
  assert.equal((await d.journal()).mode, 'global');
}

test('a benign controlled activation fixture, claiming no benefit, goes from the real finalizer through the directory, the poller and the importer to the consumer, earns promotion on the installed exposure, and the next month starts from it', options, () => deployment({}, async (d) => {
  // Bound on its records alone: no agreement, no incident channel.
  assert.deepEqual([d.runtime.configured(), d.runtime.canExport(), d.runtime.canWithdraw()], [true, false, false]);
  assert.deepEqual(await d.poll(), { processed: 0, outcomes: {} }, 'an empty directory is an empty poll');
  const incumbentRevision = incumbentFor(64);
  const before = await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx);
  assert.deepEqual(before, { revisionId: incumbentRevision, policy: { selectionThreshold: 64 } }, 'no campaign, the incumbent');

  // Admitted and staged, then exposed in shadow: the journal holds the authenticated identity and the verified bundle's own digests.
  const bundle = await finalize();
  await d.put(bundle);
  assert.deepEqual(await d.poll(), { processed: 1, outcomes: { imported: 1 } });
  let row = await d.journal();
  assert.deepEqual(await d.milestones(), ['staged', 'exposed']);
  assert.deepEqual([row.state, row.phase, row.mode, row.previousRevision], ['exposed', 'stage', 'shadow', incumbentRevision]);
  assert.deepEqual([row.authenticatedAdmissionIdentity.issuerKeyId, row.authenticatedAdmissionIdentity.evaluatorKeyId, row.authenticatedAdmissionIdentity.scope], [base.publisher.keyId, base.evaluator.keyId, SURFACE]);
  assert.equal(row.authenticatedAdmissionIdentity.consumerDigest, base.consumer);
  assert.deepEqual(row.policy.volumeBound, { max: 1.1, min: 0.5, minPicks: 50 }, 'the installed bound rides with the campaign');
  assert.equal(row.envelopeDigest.length, 64);
  assert.ok(row.stagedAt && row.publishedAt);
  assert.deepEqual([(await d.intake(bundle.digest)).state, (await d.intake(bundle.digest)).objectKey], ['imported', `rsi/v1/bundles/${bundle.digest}.json`]);

  // The first import changes nothing for anyone: the module policy reader and the feed's round both serve the incumbent.
  assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), before);
  assert.deepEqual(await d.serving.evaluateFrontierSelection(round, { executionId: 'mix-0', ...at('2026-10-26') }), frontierMixSelect({ ...round, threshold: 64 }));
  row = await d.journal();
  assert.equal(row.state, 'consumer-observed', 'a real execution of the consumer, reported through the runtime');
  assert.deepEqual([row.observations.candidateExecutions, row.observations.errors, row.observations.days], [1, 0, ['2026-10-26']]);
  assert.deepEqual(row.observations.volumeByDay, { '2026-10-26': { incumbentPicks: 12, candidatePicks: 6 } }, 'the day\'s volume on each line, inside the bound');
  const [witnessRow] = (await d.database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND payload->>'recordType'='rsi-consumer-witness'", [PLATFORM_PUBLISHER_USER_ID])).rows;
  assert.deepEqual([witnessRow.payload.arm, witnessRow.payload.outcome, witnessRow.payload.revision], ['shadow', 'ok', row.revision]);
  assert.notEqual(witnessRow.payload.incumbentResultDigest, witnessRow.payload.candidateResultDigest, 'the shadow really computed the candidate');

  // The installed exposure (200 executions over at least two days, no error) is what ends the shadow: nothing moves before it, and time alone moves nothing.
  for (let n = 1; n < 199; n++) await d.serving.evaluateFrontierSelection(round, { executionId: `mix-${n}`, ...at('2026-10-26') });
  assert.deepEqual([(await d.journal()).mode, (await d.journal()).observations.candidateExecutions], ['shadow', 199]);
  d.at('2026-10-27T13:00:00.000Z');
  assert.deepEqual((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).policy, { selectionThreshold: 64 });
  await d.serving.evaluateFrontierSelection(round, { executionId: 'mix-199', ...at('2026-10-27') });
  row = await d.journal();
  assert.deepEqual([row.state, row.mode, row.phase, row.stageIndex], ['exposed', 'global', 'activate', 1]);
  assert.deepEqual(await d.milestones(), ['staged', 'exposed', 'consumer-observed', 'staged', 'exposed']);
  assert.equal(row.observations.volumeByDay, undefined, 'each stage reads its own volume');

  // Now the candidate serves: the reader names its revision and the round selects at its threshold, witnessed as the candidate's.
  const served = await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx);
  assert.deepEqual([served.revisionId, served.policy.selectionThreshold], [row.revision, 72]);
  assert.deepEqual(await d.serving.evaluateFrontierSelection(round, { executionId: 'mix-200', ...at('2026-10-27') }), frontierMixSelect({ ...round, threshold: 72 }));
  row = await d.journal();
  assert.deepEqual([row.state, row.observations.candidateExecutions, row.observations.witnessCount], ['consumer-observed', 1, 201]);
  const candidateRevision = row.revision;

  // The global stage's own exposure earns promotion, in one transaction: the module's own policy, and the journal ended.
  for (let n = 201; n < 399; n++) await d.serving.evaluateFrontierSelection(round, { executionId: `mix-${n}`, ...at('2026-10-27') });
  assert.equal((await d.journal()).state, 'consumer-observed');
  assert.equal(await d.policyDocument(), null, 'nothing is written before it is earned');
  d.at('2026-10-28T13:00:00.000Z');
  assert.deepEqual(await d.serving.evaluateFrontierSelection(round, { executionId: 'mix-399', ...at('2026-10-28') }), frontierMixSelect({ ...round, threshold: 72 }));
  row = await d.journal();
  assert.deepEqual([row.state, row.promotedRevision, row.revision], ['promoted', `${POLICY_ID}:1`, candidateRevision]);
  assert.ok(row.promotedAt);
  assert.deepEqual(await d.milestones(), ['staged', 'exposed', 'consumer-observed', 'staged', 'exposed', 'consumer-observed', 'promoted']);
  const document = await d.policyDocument();
  assert.equal(document.revision, 1);
  assert.deepEqual(document.payload, { recordType: 'evolution-module-policy', surface: SURFACE, status: 'active', policy: { selectionThreshold: 72 }, campaignId: 'benign-activation-fixture', operationId: row.operationId, candidateDigest: row.candidateDigest, previousRevision: incumbentRevision });

  // The reader serves the promoted policy with no campaign row in the way, and no more witnesses are written.
  const promoted = { revisionId: `${POLICY_ID}:1`, policy: { selectionThreshold: 72 } };
  assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), promoted);
  assert.equal(await d.runtime.importer.hasCampaign(SURFACE), false, 'the surface is free');
  assert.deepEqual(await d.runtime.importer.select(SURFACE, ctx), { revision: `${POLICY_ID}:1`, arm: 'control' });
  const witnesses = await d.count('rsi-consumer-witness');
  assert.deepEqual(await d.serving.evaluateFrontierSelection(round, { executionId: 'mix-after', ...at('2026-10-28') }), frontierMixSelect({ ...round, threshold: 72 }));
  assert.equal(await d.count('rsi-consumer-witness'), witnesses);

  // Expiry no longer applies, and neither does a change of trust: the campaign has ended.
  d.at('2026-11-20T00:00:00.000Z');
  assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), promoted);
  await rename(d.registryFile, `${d.registryFile}.away`);
  assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), promoted);
  assert.equal((await d.journal()).state, 'promoted');
  await rename(`${d.registryFile}.away`, d.registryFile);
  d.at('2026-10-29T00:00:00.000Z');

  // The next export names it, by the real script: the incumbent, its threshold and the consumer's digest.
  await migrateFrontier(d.database, { dimension: 1536 });
  const exported = d.script('rsi-frontier-export.mjs', ['--from', '2026-10-01', '--to', '2026-10-01']);
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(exported.json.incumbent, { revisionId: `${POLICY_ID}:1`, threshold: 72 });
  assert.deepEqual([exported.json.settings.threshold, exported.json.settings.thresholdSource], [72, 'module-policy']);
  assert.deepEqual(exportIncumbent(exported.json), { revisionId: `${POLICY_ID}:1`, threshold: 72 }, 'the lab reads it as a registered form');
  assert.equal(exported.json.consumerDigest, base.consumer, 'the digest production says it serves is this tree\'s');

  // A bundle targeting the old baseline is refused; the next campaign, bound to the promoted revision, takes the free surface.
  const stale = await finalize({ bundleId: 'old-baseline-bundle' });
  await d.put(stale);
  await d.poll();
  assert.deepEqual([(await d.intake(stale.digest)).state, (await d.intake(stale.digest)).reason], ['rejected', 'campaign_baseline_changed']);
  const nextMonth = await finalize({ campaign: { id: 'benign-activation-month-2', baselineRevision: exported.json.incumbent.revisionId }, bundleId: 'month-2-bundle' });
  await d.put(nextMonth);
  await d.poll();
  const second = await d.journal('month-2-bundle');
  assert.deepEqual([second.state, second.mode, second.previousRevision, second.target.baselineRevision], ['exposed', 'shadow', `${POLICY_ID}:1`, `${POLICY_ID}:1`]);
  assert.equal(await d.runtime.importer.hasCampaign(SURFACE), true);
  assert.deepEqual((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).policy, { selectionThreshold: 72 }, 'in shadow the promoted policy serves');
  assert.deepEqual(d.said.filter((code) => code !== 'campaign_baseline_changed'), []);
}));

test('the same benign fixture, claiming no benefit: the operator rolls it back on purpose from the global stage, the incumbent is read again, and nothing of it was ever written over the incumbent', options, () => deployment({ activation: SHORT }, async (d) => {
  await d.put(await finalize());
  await d.poll();
  await toGlobal(d);
  const row = await d.journal();
  assert.equal((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).policy.selectionThreshold, 72);
  const read = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE]);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual([read.json.status, read.json.actions, read.json.inForce, read.json.revision, read.json.previousRevision, read.json.campaign.id, read.json.campaign.mode], ['read', [], 'campaign', row.revision, incumbentFor(64), row.id, 'global']);
  const stopped = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--apply', '--reason', 'campaign_operator_stop']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual([stopped.json.status, stopped.json.actions, stopped.json.inForce, stopped.json.revision], ['applied', ['campaign-stopped'], 'default', incumbentFor(64)]);
  const ended = await d.journal();
  assert.deepEqual([ended.state, ended.stopReason], ['rolled-back', 'campaign_operator_stop']);
  assert.ok(ended.rolledBackAt);
  assert.deepEqual(await d.milestones(), ['staged', 'exposed', 'consumer-observed', 'staged', 'exposed', 'stopped', 'rolled-back']);
  assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), { revisionId: incumbentFor(64), policy: { selectionThreshold: 64 } });
  assert.deepEqual(await d.serving.evaluateFrontierSelection(round, { executionId: 'mix-after', ...at('2026-10-27') }), frontierMixSelect({ ...round, threshold: 64 }));
  assert.equal((await d.journal()).observations.witnessCount, ended.observations.witnessCount);
  assert.equal(await d.policyDocument(), null, 'the incumbent was never rewritten');
  assert.equal(await d.runtime.importer.hasCampaign(SURFACE), false, 'the surface is free');
  // Again: nothing is left to stop, and nothing moves.
  const again = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--apply', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([again.status, again.json.status, again.json.actions], [0, 'unchanged', []]);
  // The decided key is passed over: nothing is read or imported again, whatever the poll does.
  assert.deepEqual((await d.poll()).outcomes, { imported: 1 });
  assert.deepEqual(await d.milestones(), ['staged', 'exposed', 'consumer-observed', 'staged', 'exposed', 'stopped', 'rolled-back']);
  assert.deepEqual(d.said, []);
}));

test('the operator\'s stop reads without writing, takes a closed reason, puts back what a promotion replaced as a new revision with history kept, and is idempotent', options, () => deployment({ activation: SHORT }, async (d) => {
  const ledger = async () => (await d.database.query("SELECT (SELECT count(*) FROM evimed_product.documents) AS documents, (SELECT count(*) FROM evimed_product.revisions) AS revisions, (SELECT count(*) FROM evimed_product.jobs) AS jobs")).rows[0];
  const quiet = await ledger();
  const empty = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE]);
  assert.deepEqual([empty.status, empty.json.inForce, empty.json.revision, empty.json.campaign, empty.json.policy], [0, 'default', incumbentFor(64), null, null]);
  assert.deepEqual(await ledger(), quiet, 'reading writes nothing');
  for (const [args, code] of [[['--surface', SURFACE, '--apply'], 'rsi_policy_arguments_invalid'], [['--surface', SURFACE, '--apply', '--reason', 'because I said so'], 'rsi_policy_arguments_invalid'], [['--surface', SURFACE, '--reason', 'campaign_x'], 'rsi_policy_arguments_invalid'],
    [['--surface', SURFACE, '--restore-promoted'], 'rsi_policy_arguments_invalid'], [['--surface', SURFACE, '--apply', '--restore-promoted', '--reason', 'campaign_x'], 'rsi_policy_arguments_invalid'],
    [[], 'rsi_policy_arguments_invalid'], [['--surface', 'no-such-surface'], 'rsi_policy_surface_unknown']]) {
    const bad = d.script('rsi-policy-stop.mjs', args);
    assert.deepEqual([bad.status, JSON.parse(bad.stderr).reason], [2, code], args.join(' '));
  }
  for (const act of ['--apply', '--restore-promoted']) {
    const nothing = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, act, '--reason', 'campaign_operator_stop']);
    assert.deepEqual([nothing.status, nothing.json.status, nothing.json.actions], [0, 'unchanged', []], act);
    assert.deepEqual(await ledger(), quiet, `${act}: nothing in force, nothing changes`);
  }

  /** A campaign through to promotion on the short exposure. */
  const promote = async (campaign, bundleId) => {
    await d.put(await finalize({ campaign, bundleId }));
    await d.poll();
    const run = bundleId;
    await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: `${run}-1`, ...at('2026-10-26') });
    await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: `${run}-2`, ...at('2026-10-27') });
    await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: `${run}-3`, ...at('2026-10-27') });
    await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: `${run}-4`, ...at('2026-10-28') });
    assert.equal((await d.journal(bundleId)).state, 'promoted', bundleId);
  };
  await promote({}, 'benign-activation-bundle');
  const first = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE]);
  assert.deepEqual([first.json.inForce, first.json.revision, first.json.previousRevision, first.json.policy.policy, first.json.policy.campaignId], ['promoted-policy', `${POLICY_ID}:1`, incumbentFor(64), { selectionThreshold: 72 }, 'benign-activation-fixture']);

  // Stopping a campaign and restoring a promoted policy are two acts: on top of a promoted policy `--apply` takes the campaign and, whatever its reason, never the policy under it.
  await d.put(await finalize({ campaign: { id: 'benign-activation-stopped', baselineRevision: `${POLICY_ID}:1` }, bundleId: 'stopped-bundle' }));
  await d.poll();
  const busy = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--restore-promoted', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([busy.status, JSON.parse(busy.stderr).reason], [1, 'rsi_policy_campaign_active'], 'a restore under a live campaign is refused: stop it first');
  const onTop = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--apply', '--reason', 'campaign_stop_first']);
  assert.deepEqual([onTop.json.actions, onTop.json.inForce, onTop.json.revision], [['campaign-stopped'], 'promoted-policy', `${POLICY_ID}:1`]);
  assert.equal((await d.journal('stopped-bundle')).state, 'rolled-back');
  for (const again of ['campaign_stop_first', 'campaign_another_reason']) {
    const unchanged = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--apply', '--reason', again]);
    assert.deepEqual([unchanged.json.status, unchanged.json.actions, unchanged.json.revision], ['unchanged', [], `${POLICY_ID}:1`], again);
  }
  assert.equal((await d.policyDocument()).revision, 1);

  // A policy on top of a promoted one: its restore goes back to the one before, as a new revision.
  await promote({ id: 'benign-activation-month-2', baselineRevision: `${POLICY_ID}:1` }, 'month-2-bundle');
  assert.equal((await d.policyDocument()).revision, 2);
  const restored = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--restore-promoted', '--reason', 'campaign_operator_stop']);
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual([restored.json.actions, restored.json.inForce, restored.json.revision], [['policy-restored'], 'module-policy', `${POLICY_ID}:3`]);
  const back = await d.policyDocument();
  assert.deepEqual(back.payload, { recordType: 'evolution-module-policy', surface: SURFACE, status: 'active', policy: { selectionThreshold: 72 }, restoredFrom: `${POLICY_ID}:1`, stoppedRevision: `${POLICY_ID}:2`, stoppedOperationId: (await d.journal('month-2-bundle')).operationId, stopReason: 'campaign_operator_stop', stoppedAt: back.payload.stoppedAt });
  assert.deepEqual((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)), { revisionId: `${POLICY_ID}:3`, policy: { selectionThreshold: 72 } });
  assert.equal((await d.database.query("SELECT 1 FROM evimed_product.revisions WHERE user_id='rsi_operator' AND id=$1", [POLICY_ID])).rowCount, 3, 'history kept');
  const revisions = await ledger();
  const twice = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--restore-promoted', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([twice.status, twice.json.status, twice.json.revision], [0, 'unchanged', `${POLICY_ID}:3`]);
  assert.deepEqual(await ledger(), revisions, 'a second restore changes nothing');
}));

test('the operator\'s stop of the only promoted policy puts the code default back in force, by the same document', options, () => deployment({ activation: SHORT }, async (d) => {
  await d.put(await finalize());
  await d.poll();
  await toGlobal(d);
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-3', ...at('2026-10-27') });
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-4', ...at('2026-10-28') });
  assert.equal((await d.journal()).state, 'promoted');
  const applied = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--apply', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([applied.status, applied.json.status, applied.json.inForce], [0, 'unchanged', 'promoted-policy'], '--apply never touches a promoted policy');
  const restored = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--restore-promoted', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([restored.status, restored.json.actions, restored.json.inForce, restored.json.revision], [0, ['policy-restored'], 'default', incumbentFor(64)]);
  const back = await d.policyDocument();
  assert.deepEqual([back.revision, back.payload.status, back.payload.restoredFrom, back.payload.stoppedRevision], [2, 'stopped', incumbentFor(64), `${POLICY_ID}:1`]);
  assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), { revisionId: incumbentFor(64), policy: { selectionThreshold: 64 } });
  // The default is the baseline again, so a campaign bound to it imports.
  const fresh = await finalize({ campaign: { id: 'benign-activation-again' }, bundleId: 'again-bundle' });
  await d.put(fresh);
  await d.poll();
  assert.equal((await d.journal('again-bundle')).state, 'exposed');
}));

test('a stopped journal that cannot roll back says so by a closed code and blocks nothing: a live campaign behind it is stopped, a promoted policy behind that is restored, and applied means something changed', options, () => deployment({ activation: SHORT }, async (d) => {
  await d.put(await finalize());
  await d.poll();
  await toGlobal(d);
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-3', ...at('2026-10-27') });
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-4', ...at('2026-10-28') });
  assert.equal((await d.journal()).state, 'promoted');
  // A campaign stopped under a consumer that has since moved: its rollback can no longer run.
  await d.put(await finalize({ campaign: { id: 'benign-activation-stuck', baselineRevision: `${POLICY_ID}:1` }, bundleId: 'stuck-bundle' }));
  await d.poll();
  const stuck = await d.journal('stuck-bundle');
  await d.database.query("UPDATE evimed_product.documents SET payload=payload||jsonb_build_object('state','stopped','stopReason','campaign_target_changed','rollbackOperationId',$3::text,'target',payload->'target'||jsonb_build_object('dependencyDigest',$4::text)) WHERE user_id=$1 AND payload->>'recordType'='rsi-campaign-import' AND payload->>'id'=$2", [PLATFORM_PUBLISHER_USER_ID, stuck.id, `${stuck.operationId}-rollback`, 'a'.repeat(64)]);
  const note = { journal: stuck.id, code: 'campaign_rollback_incompatible' };
  // Nothing else in force: tried, said, and not called applied.
  const alone = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--apply', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([alone.status, alone.json.status, alone.json.actions, alone.json.notes, alone.json.inForce], [0, 'unchanged', [], [note], 'promoted-policy'], alone.stderr);
  assert.equal((await d.journal('stuck-bundle')).state, 'stopped');
  // The surface is free behind it, a live campaign takes it, and the first branch no longer hides that campaign.
  await d.put(await finalize({ campaign: { id: 'benign-activation-live', baselineRevision: `${POLICY_ID}:1` }, bundleId: 'live-bundle' }));
  await d.poll();
  assert.equal((await d.journal('live-bundle')).state, 'exposed');
  const stopped = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--apply', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([stopped.status, stopped.json.status, stopped.json.actions, stopped.json.notes, stopped.json.inForce], [0, 'applied', ['campaign-stopped'], [note], 'promoted-policy'], stopped.stderr);
  assert.equal((await d.journal('live-bundle')).state, 'rolled-back');
  // And the policy behind them both is reachable, by its own act.
  const restored = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--restore-promoted', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([restored.status, restored.json.status, restored.json.actions, restored.json.inForce], [0, 'applied', ['policy-restored'], 'default'], restored.stderr);
  // A reverted release brings the consumer back: the same rollback then finishes, by itself.
  await d.database.query("UPDATE evimed_product.documents SET payload=jsonb_set(jsonb_set(payload,'{target,dependencyDigest}',to_jsonb($3::text)),'{target,baselineRevision}',to_jsonb($4::text)),revision=revision WHERE user_id=$1 AND payload->>'recordType'='rsi-campaign-import' AND payload->>'id'=$2", [PLATFORM_PUBLISHER_USER_ID, stuck.id, base.consumer, incumbentFor(64)]);
  await d.database.query("UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{previousRevision}',to_jsonb($3::text)) WHERE user_id=$1 AND payload->>'recordType'='rsi-campaign-import' AND payload->>'id'=$2", [PLATFORM_PUBLISHER_USER_ID, stuck.id, incumbentFor(64)]);
  const finished = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--apply', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([finished.status, finished.json.status, finished.json.actions, finished.json.notes], [0, 'applied', ['rollback-finished'], []], finished.stderr);
  assert.equal((await d.journal('stuck-bundle')).state, 'rolled-back');
}));

test('a stop answers for its own surface: a promotion records whose it is, another surface cannot restore it, and an automatic stop of a campaign on top leaves the promoted policy alone until it is restored on purpose', options, () => deployment({ activation: SHORT }, async (d) => {
  await d.put(await finalize());
  await d.poll();
  await toGlobal(d);
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-3', ...at('2026-10-27') });
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-4', ...at('2026-10-28') });
  assert.equal((await d.policyDocument()).payload.surface, SURFACE);
  const promoted = { revisionId: `${POLICY_ID}:1`, policy: { selectionThreshold: 72 } };
  // The module's other surfaces read the same document and do not own what it holds.
  const other = d.script('rsi-policy-stop.mjs', ['--surface', 'frontier-edit']);
  assert.deepEqual([other.status, other.json.inForce, other.json.policy.surface], [0, 'module-policy', SURFACE], other.stderr);
  const appliedElsewhere = d.script('rsi-policy-stop.mjs', ['--surface', 'frontier-edit', '--apply', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([appliedElsewhere.status, appliedElsewhere.json.status], [0, 'unchanged'], appliedElsewhere.stderr);
  const refused = d.script('rsi-policy-stop.mjs', ['--surface', 'frontier-edit', '--restore-promoted', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([refused.status, JSON.parse(refused.stderr).reason], [1, 'campaign_policy_surface_mismatch']);
  assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), promoted, 'the threshold is where it was');
  assert.equal((await d.policyDocument()).revision, 1);
  // A campaign on top is stopped automatically (its bytes changed). The operator's first act changes nothing further.
  await d.put(await finalize({ campaign: { id: 'benign-activation-on-top', baselineRevision: `${POLICY_ID}:1` }, bundleId: 'on-top-bundle' }));
  await d.poll();
  const onTop = await d.journal('on-top-bundle');
  await d.database.query("UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{files,0,content}','\"{\\\"selectionThreshold\\\":99}\"') WHERE user_id=$1 AND id=$2", [PLATFORM_PUBLISHER_USER_ID, onTop.revision]);
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-on-top', ...at('2026-10-28') });
  assert.equal((await d.journal('on-top-bundle')).state, 'rolled-back');
  const first = d.script('rsi-policy-stop.mjs', ['--surface', SURFACE, '--apply', '--reason', 'campaign_operator_stop']);
  assert.deepEqual([first.status, first.json.status, first.json.actions, first.json.inForce, first.json.revision], [0, 'unchanged', [], 'promoted-policy', `${POLICY_ID}:1`], first.stderr);
  assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), promoted, 'the promoted policy stands');
}));

test('an activation that fails after its intent committed is resumed by the poll, without a new approval: after one thrown publish and after a restart', options, () => deployment({ activation: SHORT }, async (d) => {
  await d.put(await finalize());
  await d.poll();
  // The intent commits on the witness that ends the shadow, and the activation's publish throws once.
  const { publish } = d.serving.adapters.policy;
  let thrown = 0, published = 0;
  d.serving.adapters.policy.publish = async (input) => { if (input.phase === 'activate') { published += 1; if (thrown === 0) { thrown += 1; throw new Error('process lost after the intent'); } } return publish(input); };
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-1', ...at('2026-10-26') });
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-2', ...at('2026-10-27') });
  assert.equal(thrown, 1);
  assert.deepEqual(d.serving.observationFailures(), { rsi_serving_observation_failed: 1 }, 'a round goes on through it');
  const held = await d.journal();
  assert.deepEqual([held.state, held.phase, held.mode], ['staged', 'activate', 'global'], 'the intent stands');
  assert.deepEqual((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).policy, { selectionThreshold: 64 }, 'nothing serves yet');
  // The next poll finishes it, under the same operation, and the candidate serves.
  const resumed = await d.poll();
  assert.equal(resumed.resumed, 1);
  const row = await d.journal();
  assert.deepEqual([row.state, row.phase, row.mode, row.revision, row.operationId], ['exposed', 'activate', 'global', held.revision, held.operationId]);
  assert.deepEqual((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).policy, { selectionThreshold: 72 });
  assert.equal(published, 2);
  // Idempotent: nothing staged, nothing resumed, nothing published again.
  assert.equal((await d.poll()).resumed, undefined);
  assert.equal(published, 2);
}));

test('an activation left staged by a restart is resumed by the new process\'s first poll', options, () => deployment({ activation: SHORT }, async (d) => {
  await d.put(await finalize());
  await d.poll();
  const { publish } = d.serving.adapters.policy;
  d.serving.adapters.policy.publish = async (input) => { if (input.phase === 'activate') throw new Error('the process died here'); return publish(input); };
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-1', ...at('2026-10-26') });
  await d.serving.evaluateFrontierSelection(pool(0, 6), { executionId: 'mix-2', ...at('2026-10-27') });
  assert.equal((await d.journal()).state, 'staged');
  await d.runtime.worker.close();
  // A new process: no patched adapter, the intake says imported, and only the staged journal says there is work.
  const after = await d.start();
  assert.equal((await d.intake((await finalize()).digest)).state, 'imported');
  assert.equal((await d.pollWith(after.runtime.worker)).resumed, 1);
  assert.deepEqual([(await d.journal()).state, (await d.journal()).mode], ['exposed', 'global']);
  assert.deepEqual((await after.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).policy, { selectionThreshold: 72 });
  await after.runtime.worker.close();
}));

test('the online bound reads a day as the offline rule does: 40 to 46 picks with 20 safety alerts is 1.10 on both, so what the development choice admitted is not stopped in shadow', options, async () => {
  const news = { genre: 'news', source_type: 'news', source_source_type: 'news', evidence_type: null, publication_types: null };
  const dayOf = (day) => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => frontierRow(`safety-${day}-${i}`, day, { genre: 'safety', safety_alert: true, selected: true, selected_rule: 'safety-bypass', score_total: 35, source_type: 'regulator', source_source_type: 'regulator', evidence_type: 'safety-notice' })),
      ...Array.from({ length: 40 }, (_, i) => frontierRow(`high-${day}-${i}`, day, { ...news, score_total: 85 })),
      ...Array.from({ length: 6 }, (_, i) => frontierRow(`middle-${day}-${i}`, day, { ...news, score_total: 75 })),
    ];
    const frozen = frontierDayPool(day, rows);
    return { frozen, input: { candidates: rows.map(frontierMixCandidate), threshold: 80, events: frozen.events, congressActive: frozen.congressActive, preprintPlaces: frozen.preprintPlaces, preprintMinScore: frozen.preprintMinScore, genreFloors: frozen.genreFloors } };
  };
  await deployment({ threshold: 80, activation: { minExecutions: 100, minDays: 90 } }, async (d) => {
    await d.put(await finalize({ campaign: { id: 'benign-activation-high-line', baselineRevision: incumbentFor(80) } }));
    await d.poll();
    const first = dayOf('2026-10-26'), second = dayOf('2026-10-27');
    assert.deepEqual([replayFrontierPool(first.frozen, 80).selectedVolume, replayFrontierPool(first.frozen, 72).selectedVolume], [60, 66], 'the offline figures');
    await d.serving.evaluateFrontierSelection(first.input, { executionId: 'mix-1', ...at('2026-10-26') });
    await d.serving.evaluateFrontierSelection(second.input, { executionId: 'mix-2', ...at('2026-10-27') });
    const row = await d.journal();
    assert.deepEqual(row.observations.volumeByDay, { '2026-10-26': { incumbentPicks: 60, candidatePicks: 66 }, '2026-10-27': { incumbentPicks: 60, candidatePicks: 66 } }, 'the same figures online, past the floor');
    assert.equal(row.state, 'consumer-observed', 'picks alone would be 1.15 and stop it here');
  });
});

test('the same benign fixture, claiming no benefit: past its floor a candidate selecting too little stops and rolls back in shadow; under the floor nothing fires, however many rounds read one small day', options, () => deployment({ activation: SHORT }, async (d) => {
  await d.put(await finalize());
  await d.poll();
  const thin = pool(25, 5); // 30 picks at the incumbent's 64, 5 at the candidate's 72: a ratio of 1/6, under the bound's 0.5
  for (let n = 0; n < 60; n++) await d.serving.evaluateFrontierSelection(thin, { executionId: `mix-${n}`, ...at('2026-10-26') });
  let row = await d.journal();
  assert.deepEqual([row.state, row.observations.candidateExecutions, row.observations.volumeByDay], ['consumer-observed', 60, { '2026-10-26': { incumbentPicks: 30, candidatePicks: 5 } }], 'one day\'s 30 picks are under the floor of 50, read once however often');
  assert.deepEqual(frontierMixSelect({ ...thin, threshold: 64 }), await d.serving.evaluateFrontierSelection(thin, { executionId: 'mix-more', ...at('2026-10-26') }));
  // A second day passes the floor: the ratio is out of bound.
  assert.deepEqual(await d.serving.evaluateFrontierSelection(thin, { executionId: 'mix-next', ...at('2026-10-27') }), frontierMixSelect({ ...thin, threshold: 64 }));
  row = await d.journal();
  assert.deepEqual([row.state, row.stopReason, row.fuse.state, row.fuse.reason, row.fuse.volume], ['rolled-back', 'registered-volume-bound', 'stop', 'registered-volume-bound', { incumbent: 60, candidate: 10 }]);
  assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), { revisionId: incumbentFor(64), policy: { selectionThreshold: 64 } });
  assert.equal(await d.policyDocument(), null);
}));

test('the same benign fixture, claiming no benefit: a candidate selecting too much stops in shadow, and in global, where that round gets the incumbent\'s picks', options, async () => {
  const rich = pool(25, 5, 75); // 5 picks at the incumbent's 80, 30 at the candidate's 72: a ratio of 6, over the bound's 1.1
  const campaign = { id: 'benign-activation-high-line', baselineRevision: incumbentFor(80) };
  const bundleId = 'benign-activation-bundle';
  await deployment({ threshold: 80, activation: SHORT }, async (d) => {
    await d.put(await finalize({ campaign, bundleId }));
    await d.poll();
    assert.equal((await d.journal()).mode, 'shadow');
    await d.serving.evaluateFrontierSelection(rich, { executionId: 'mix-1', ...at('2026-10-26') });
    assert.equal((await d.journal()).state, 'consumer-observed', '30 picks are under the floor');
    await d.serving.evaluateFrontierSelection(rich, { executionId: 'mix-2', ...at('2026-10-27') });
    const row = await d.journal();
    assert.deepEqual([row.state, row.stopReason, row.fuse.volume], ['rolled-back', 'registered-volume-bound', { incumbent: 10, candidate: 60 }]);
  });
  await deployment({ threshold: 80, activation: SHORT }, async (d) => {
    await d.put(await finalize({ campaign, bundleId }));
    await d.poll();
    await toGlobal(d);
    const row = await d.journal();
    assert.equal(row.observations.volumeByDay, undefined, 'the shadow\'s reading does not carry over');
    assert.deepEqual(await d.serving.evaluateFrontierSelection(rich, { executionId: 'mix-3', ...at('2026-10-27') }), frontierMixSelect({ ...rich, threshold: 72 }), 'under the floor the candidate serves');
    assert.equal((await d.journal()).state, 'consumer-observed');
    assert.deepEqual(await d.serving.evaluateFrontierSelection(rich, { executionId: 'mix-4', ...at('2026-10-28') }), frontierMixSelect({ ...rich, threshold: 80 }), 'the round the fuse stops it on is the incumbent\'s');
    const ended = await d.journal();
    assert.deepEqual([ended.state, ended.stopReason], ['rolled-back', 'registered-volume-bound']);
    assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 80 }, ctx), { revisionId: incumbentFor(80), policy: { selectionThreshold: 80 } });
    assert.equal(await d.policyDocument(), null, 'it never became the module\'s');
  });
});

test('the same benign fixture, claiming no benefit: the volume is read from the day with the mix\'s picks taken back, so what earlier rounds selected does not hide it', options, () => deployment({ activation: SHORT }, async (d) => {
  await d.put(await finalize());
  await d.poll();
  // The incumbent's rounds have selected the whole day already: this round has nothing left to pick on either line.
  const settled = { ...pool(6, 6), candidates: pool(6, 6).candidates.map((row) => ({ ...row, selected: true, rule: 'threshold' })) };
  assert.equal(frontierMixSelect({ ...settled, threshold: 64 }).picks.length, 0);
  await d.serving.evaluateFrontierSelection(settled, { executionId: 'mix-1', ...at('2026-10-26') });
  assert.deepEqual((await d.journal()).observations.volumeByDay, { '2026-10-26': { incumbentPicks: 12, candidatePicks: 6 } });
}));

test('the same benign fixture, claiming no benefit: corrupt installed bytes stop the campaign at that read, in shadow and in global, and the feed keeps the incumbent', options, async () => {
  const corrupt = (d, row) => d.database.query("UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{files,0,content}','\"{\\\"selectionThreshold\\\":99}\"') WHERE user_id=$1 AND id=$2", [PLATFORM_PUBLISHER_USER_ID, row.revision]);
  await deployment({}, async (d) => {
    await d.put(await finalize());
    await d.poll();
    await corrupt(d, await d.journal());
    assert.deepEqual(await d.serving.evaluateFrontierSelection(round, { executionId: 'mix-corrupt', ...at('2026-10-26') }), frontierMixSelect({ ...round, threshold: 64 }));
    const stopped = await d.journal();
    assert.deepEqual([stopped.state, stopped.stopReason], ['rolled-back', 'campaign_observation_unrecorded']);
    assert.deepEqual(d.serving.observationFailures(), { rsi_serving_witness_unavailable: 1 });
    assert.deepEqual((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).policy, { selectionThreshold: 64 });
    assert.equal(await d.runtime.importer.hasCampaign(SURFACE), false);
  });
  await deployment({ activation: SHORT }, async (d) => {
    await d.put(await finalize());
    await d.poll();
    await toGlobal(d);
    await corrupt(d, await d.journal());
    assert.deepEqual(await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx), { revisionId: incumbentFor(64), policy: { selectionThreshold: 64 } }, 'the read serves the incumbent');
    const stopped = await d.journal();
    assert.deepEqual([stopped.state, stopped.stopReason], ['rolled-back', 'campaign_installed_bytes_changed'], 'and the journal stopped at that read, long before its expiry');
    assert.ok(Date.parse(stopped.stoppedAt) < Date.parse(stopped.expiresAt));
    assert.equal(await d.runtime.importer.hasCampaign(SURFACE), false);
    assert.equal(await d.policyDocument(), null);
  });
});

test('the same benign fixture, claiming no benefit: a critical witness on the record rolls the candidate back through the real adapter, and the incumbent is read again', options, () => deployment({}, async (d) => {
  await d.put(await finalize());
  await d.poll();
  const row = await d.journal();
  // Written as the consumer writes one: the frontier consumer has no critical check of its own today, so it stands for the fuse and not for the selector.
  const id = 'rsi-witness:critical';
  await d.documents.put(PLATFORM_PUBLISHER_USER_ID, 'knowledge', id, { recordType: 'rsi-consumer-witness', id, operationId: row.operationId, candidateDigest: row.candidateDigest, revision: row.revision, arm: 'shadow', outcome: 'critical', criticalCode: 'deterministic-regression', stageIndex: 0, day: '2026-10-26', consumerDigest: base.consumer }, { expectedRevision: 0 });
  const stopped = await d.runtime.importer.observe(row.id, { id });
  assert.deepEqual([stopped.state, stopped.observations.criticalCode, stopped.fuse.state], ['rolled-back', 'deterministic-regression', 'stop']);
  assert.deepEqual(await d.milestones(), ['staged', 'exposed', 'stopped', 'rolled-back']);
  assert.ok(await d.documents.get(PLATFORM_PUBLISHER_USER_ID, 'knowledge', `rsi-serving:${rsiDigest(['revoked', SURFACE, row.revision])}`), 'the revision is revoked for good');
  assert.deepEqual((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).policy, { selectionThreshold: 64 });
}));

test('a bundle past its expiry is refused at import, and a campaign that reaches its expiry unpromoted goes back to the incumbent at the next read', options, () => deployment({}, async (d) => {
  const expired = await finalize({ bundleId: 'expired-bundle', expiresAt: '2026-10-26T12:30:00.000Z' });
  await d.put(expired);
  assert.deepEqual((await d.poll()).outcomes, { rejected: 1 });
  assert.deepEqual([(await d.intake(expired.digest)).state, (await d.intake(expired.digest)).reason], ['rejected', 'campaign_bundle_expired']);
  assert.equal(await d.journals(), 0);
  // Within its validity it imports; past it, the first read stops it.
  await d.put(await finalize());
  assert.deepEqual((await d.poll()).outcomes, { rejected: 1, imported: 1 });
  assert.equal((await d.journal()).state, 'exposed');
  d.at('2026-10-30T00:00:01.000Z');
  assert.deepEqual((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).revisionId, incumbentFor(64));
  const row = await d.journal();
  assert.deepEqual([row.state, row.stopReason], ['rolled-back', 'campaign_bundle_expired']);
}));

test('what the importer refuses leaves a closed reason and no journal: changed bytes, a wrong signer, an evaluator it does not know, a stale baseline; each is decided once', options, () => deployment({}, async (d) => {
  const good = await finalize();
  // Changed bytes: a file whose bytes are not its name, however good the signature inside it.
  const tampered = good.bytes.replace('"schemaVersion":1', '"schemaVersion":1 ');
  await writeFile(path.join(d.bundles, `${good.digest}.json`), tampered);
  assert.deepEqual((await d.poll()).outcomes, { rejected: 1 });
  assert.deepEqual([(await d.intake(good.digest)).state, (await d.intake(good.digest)).reason], ['rejected', 'rsi_oss_object_changed']);
  await rm(path.join(d.bundles, `${good.digest}.json`));

  // A wrong signer: the same key id with another key is refused for good; a signature is what it is, whatever the records say later.
  const forged = await finalize({ publisher: { ...signer(base.publisher.keyId) } });
  await d.put(forged);
  assert.deepEqual((await d.poll()).outcomes, { rejected: 1 });
  assert.equal((await d.intake(forged.digest)).reason, 'campaign_signature_invalid');

  // A key id, or an evaluator's receipt, the deployment does not know: a trust failure the deployment's records could answer, so it is retried, then decided.
  const unknown = await finalize({ publisher: signer('someone-else') });
  const stranger = await finalize({ bundleId: 'stranger-bundle', evaluator: signer('other-evaluator') });
  await d.put(unknown); await d.put(stranger);
  await d.poll(); await d.poll();
  for (const bundle of [unknown, stranger]) assert.deepEqual([(await d.intake(bundle.digest)).state, (await d.intake(bundle.digest)).lastCode, (await d.intake(bundle.digest)).attempts], ['retrying', 'campaign_trust_unavailable', 2]);
  await d.poll();
  for (const bundle of [unknown, stranger]) assert.deepEqual([(await d.intake(bundle.digest)).state, (await d.intake(bundle.digest)).reason], ['rejected', 'campaign_import_retry_exhausted']);

  // A stale baseline: the module's incumbent moved after the campaign was bound to it.
  const stale = await finalize({ bundleId: 'stale-bundle' });
  await d.documents.put('rsi_operator', 'knowledge', POLICY_ID, { status: 'active', policy: { selectionThreshold: 65 } }, { expectedRevision: 0 });
  await d.put(stale);
  await d.poll();
  assert.deepEqual([(await d.intake(stale.digest)).state, (await d.intake(stale.digest)).reason], ['rejected', 'campaign_baseline_changed']);

  assert.equal(await d.journals(), 0, 'none of them left a journal');
  assert.equal(await d.count('rsi-serving-version'), 0, 'nor a published version');
  assert.deepEqual((await d.policies.resolve('frontier', { selectionThreshold: 64 }, ctx)).policy, { selectionThreshold: 65 }, 'the moved incumbent serves');
  // A later poll decides none of them again.
  const decided = (await d.database.query("SELECT payload->>'digest' AS digest, revision FROM evimed_product.documents WHERE user_id=$1 AND payload->>'recordType'='rsi-bundle-intake' ORDER BY 1", [PLATFORM_PUBLISHER_USER_ID])).rows;
  await d.poll();
  assert.deepEqual((await d.database.query("SELECT payload->>'digest' AS digest, revision FROM evimed_product.documents WHERE user_id=$1 AND payload->>'recordType'='rsi-bundle-intake' ORDER BY 1", [PLATFORM_PUBLISHER_USER_ID])).rows, decided);
}));

test('a replay is refused for good: the same bytes are never read as new, and the same campaign under a new bundle id is rejected even after the first has ended', options, () => deployment({}, async (d) => {
  const first = await finalize();
  await d.put(first);
  await d.poll();
  const row = await d.journal();
  assert.equal(row.state, 'exposed');
  const again = await finalize({ bundleId: 'benign-activation-replay' });
  await d.put(again);
  assert.deepEqual((await d.poll()).outcomes, { imported: 1, rejected: 1 });
  assert.deepEqual([(await d.intake(again.digest)).state, (await d.intake(again.digest)).reason], ['rejected', 'campaign_replayed']);
  await d.runtime.importer.halt(row.operationId, 'campaign_lifecycle_rollback');
  const late = await finalize({ bundleId: 'benign-activation-late' });
  await d.put(late);
  await d.poll();
  assert.equal((await d.intake(late.digest)).reason, 'campaign_replayed');
  assert.equal(await d.journals(), 1);
  assert.equal((await d.journal()).state, 'rolled-back');
}));
