/**
 * Public synthetic frontier-days campaign generator, with the helpers the lifecycle tests share. It certifies no medical or
 * statistical benefit: the rows are invented, the labels are a seeded rule, and nothing here is release evidence.
 *
 * A campaign source is `{kind: 'frontier-days', schema: 1, days, labels, band}`. Every synthetic row is unsummarised and
 * from its own source, so production's selector takes a row only when its versioned score reaches the threshold (no floor
 * place, no source cap, no event rule can move it) and the registered thresholds select visibly different sets. Each day
 * draws a label cutoff, a row is a `pick` at or above it, so a higher threshold is genuinely better on days whose cutoff is
 * high and worse on the others: development has something to freeze, and the day differences have real variance.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, confirmationDecision, signedEvaluatorReceipt } from '../campaign_runner.mjs';
import { FRONTIER_DAYS_SCHEMA, evaluateFrontierDays, frontierCampaignConsumerIdentity } from '../frontier_campaign.mjs';
import { evaluatorReceiptPayload, signEnvelope } from '../evaluator.mjs';

/** What an `authorized-incident` campaign carries: a minimised, platform-quality authorization naming its incident. */
export const INCIDENT_AUTHORIZATION = Object.freeze({ id: 'authorization-test', incidentId: 'incident-test', incidentDigest: 'a'.repeat(64), sourceRunId: 'source-run', sourceRevision: 'source-rev', purpose: 'platform-quality', minimized: true });
export const BENIGN_BASELINE = 64;
export const BENIGN_THRESHOLDS = Object.freeze([60, 68, 72, 76]);
export const BENIGN_FLOOR = 60;
export const BENIGN_PICK_WEIGHT = 3;
/** The supported procedure of statistics.py, as the registration must pin it. */
export const BENIGN_PROCEDURE = Object.freeze({ id: 'rsi-paired-group-v5', digest_codec: 'rfc8785-sha256-v1', test_alpha_fraction: 0.5, minimum_slice_groups: 25 });
export const BENIGN_CLAIM_ALPHA = 0.05 / 3;
export const BENIGN_DEADLINE = '2026-10-31T16:00:00.000Z';
export const BENIGN_CLOCK_START = '2026-10-26T01:00:00.000Z';
/** The pinned numpy / scipy / rfc8785 the statistics process imports. */
export const STATISTICS_PYTHON = process.env.RSI_TEST_PYTHON ?? 'python3';
// Where `pnpm test:rsi`'s CI step installs them (`pip install --target ../.evimed-local/toolchains/rsi-python`, relative to
// OpenScience/), not a path one machine happened to have: /tmp/rsi-python passed here and failed every statistics case on CI.
export const STATISTICS_MODULE_PATH = process.env.RSI_TEST_PYTHONPATH
  ?? fileURLToPath(new URL('../../../../.evimed-local/toolchains/rsi-python', import.meta.url));

/** mulberry32: a small deterministic generator, so a fixture is the same bytes on every run. @param {number} seed */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isoDay = (start, offset) => new Date(Date.parse(`${start}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

/** A frozen full-day row with every key `replayFrontierPool` requires. */
export function frontierRow(id, day, extra = {}) {
  return {
    id, primary_source_id: `source-${id}`, genre: 'paper', platform: null, channel: null, source_type: 'journal', source_source_type: 'journal', source_authority: 3,
    lang: 'en', title_raw: 'Synthetic orchestration fixture', verification: 'passed', evidence_type: 'rct', lane: null, practice_changing: null, practice_zh: null,
    flags: [], publication_types: ['Journal Article'], summarized: false, selected: false, safety_alert: false, beside_selected: false, event_id: null,
    score_version: 'current', score_total: 70, selected_rule: null, adds_value: null, visible_at: `${day}T06:00:00Z`, ...extra,
  };
}

/** A day pool the production replay accepts: one window, no events, complete. */
export function frontierDayPool(day, rows, extra = {}) {
  return {
    complete: true, day, window: { start: `${day}T00:00:00Z`, end: isoDay(day, 1).concat('T00:00:00Z') }, rows, events: {}, genreFloors: {}, congressActive: false,
    preprintPlaces: 2, preprintMinScore: 50, scoreVersion: 'current', ...extra,
  };
}

/**
 * One source of `days` consecutive days. Per day: `rowsPerDay - 1` in-band rows with scores spread over 62..88 (a safety alert
 * replaces one of them on every fifth day), one row below the band floor, and a label cutoff drawn from `cutoffs`.
 * @param {{start:string, days:number, rowsPerDay:number, seed:number, prefix:string, cutoffs:number[], scoreLow?:number, scoreHigh?:number, abstainEvery?:number}} options
 */
export function frontierDaysSource({ start, days, rowsPerDay, seed, prefix, cutoffs, scoreLow = 62, scoreHigh = 88, abstainEvery = 13, floor = BENIGN_FLOOR, pickWeight = BENIGN_PICK_WEIGHT }) {
  const random = seededRandom(seed);
  const inBand = Math.max(1, rowsPerDay - 1);
  const dayPools = [], labels = [];
  let counter = 0;
  for (let d = 0; d < days; d++) {
    const day = isoDay(start, d);
    const cutoff = cutoffs[Math.floor(random() * cutoffs.length)];
    const rows = [];
    for (let j = 0; j < inBand; j++) {
      const id = `${prefix}-${day}-${String(j).padStart(2, '0')}`;
      const score = Math.round((scoreLow + ((j + random()) / inBand) * (scoreHigh - scoreLow)) * 10) / 10;
      const news = j % 3 === 2;
      const safety = j === 0 && d % 5 === 4;
      rows.push(frontierRow(id, day, {
        score_total: safety ? 35 : score,
        ...(news ? { genre: 'news', source_type: 'news', source_source_type: 'news', evidence_type: null, publication_types: null } : {}),
        ...(safety ? { genre: 'safety', safety_alert: true, selected: true, selected_rule: 'safety', evidence_type: 'safety-notice', source_type: 'regulator', source_source_type: 'regulator' } : {}),
      }));
    }
    rows.push(frontierRow(`${prefix}-${day}-low`, day, { score_total: Math.round((40 + random() * 10) * 10) / 10 }));
    // What production kept that day: the rows the baseline line selects, plus every alert.
    for (const row of rows) row.production_selected = row.safety_alert === true || (row.score_total >= BENIGN_BASELINE && row.score_version === 'current' && row.id !== `${prefix}-${day}-low`);
    dayPools.push(frontierDayPool(day, rows));
    for (const row of rows) {
      if (row.score_total < floor && row.safety_alert !== true) continue; // outside the band: never in the labelled set
      const roll = counter++;
      let worth;
      if (row.safety_alert === true) worth = 'pick';
      else if (row.score_total >= cutoff) worth = 'pick';
      else worth = row.score_total >= cutoff - 4 ? 'ok' : 'no';
      if (abstainEvery > 0 && roll % abstainEvery === abstainEvery - 1) worth = null;
      labels.push({ id: row.id, worth });
    }
  }
  return { kind: 'frontier-days', schema: FRONTIER_DAYS_SCHEMA, days: dayPools, labels, band: { floor, pickWeight } };
}

/** The registered selection, as the runner reads it from the campaign's inputs. */
export function benignRegistration({ baselineThreshold = BENIGN_BASELINE, thresholds = [...BENIGN_THRESHOLDS], minLabelled = 3, maxVolumeRatio, labelThresholds } = {}) {
  return {
    baselineThreshold, thresholds, minLabelled, ...(maxVolumeRatio === undefined ? {} : { maxVolumeRatio }), ...(labelThresholds ? { labelThresholds } : {}),
    selection: { objective: 'weighted-accuracy-difference', tieBreak: 'nearest-baseline' },
  };
}

/**
 * A synthetic (or, with `classification: 'public'`, a release-shaped) campaign: development days strictly before confirmation
 * days, no row in both, an unconfirmed registration (see `attachStatistics`). `development` / `confirmation` override a source's
 * generator options (a test shaping the score range or the label cutoffs).
 * @param {{days?:number, rowsPerDay?:number, classification?:'synthetic'|'public'|'authorized-incident', seed?:number, minLabelled?:number, maxVolumeRatio?:number,
 *   thresholds?:number[], baselineThreshold?:number, id?:string, confirmationExposure?:string, development?:object, confirmation?:object}} [options]
 */
export function benignCampaignFixture({ days = 30, rowsPerDay = 6, classification = 'synthetic', seed = 20261048, minLabelled = 3, maxVolumeRatio, thresholds, baselineThreshold,
  id = 'benign-frontier-campaign', confirmationExposure, createdAt = '2026-10-26T00:00:00Z', deadline = BENIGN_DEADLINE, development = {}, confirmation = {} } = {}) {
  const cutoffs = [72, 72, 73, 74, 75, 76];
  const base = { days, rowsPerDay, cutoffs };
  const sources = {
    development: frontierDaysSource({ ...base, start: '2026-07-01', seed, prefix: 'dev', ...development }),
    confirmation: frontierDaysSource({ ...base, start: '2026-09-01', seed: seed + 1, prefix: 'conf', ...confirmation }),
  };
  const registration = benignRegistration({ minLabelled, maxVolumeRatio, ...(thresholds ? { thresholds } : {}), ...(baselineThreshold === undefined ? {} : { baselineThreshold }) });
  const target = { surface: 'frontier-selection', dependencyDigest: 'a'.repeat(64), baselineRevision: 'benign-baseline' };
  const exposure = (role) => classification === 'synthetic' ? 'synthetic' : role === 'confirmation' ? 'sealed' : 'exposed';
  const manifest = {
    schemaVersion: 1, id, surface: 'frontier-selection', candidateKind: 'policy', claim: 'superiority', automated: true,
    createdAt, deadline, budget: { campaignCny: 1000, monthCny: 30000 },
    models: { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improver: { provider: 'none', model: 'registered-grid' }, reviewer: { provider: 'dashscope', model: 'qwen3.8-max' } },
    target, registration: { digest: digest(registration), procedure: BENIGN_PROCEDURE.id, claim: 'superiority' },
    data: { classification, ...(classification === 'authorized-incident' ? { authorization: { ...INCIDENT_AUTHORIZATION } } : {}),
      sources: Object.entries(sources).map(([role, source]) => ({ id: role, digest: digest(source), role, exposure: role === 'confirmation' && confirmationExposure ? confirmationExposure : exposure(role) })) },
  };
  return { manifest, inputs: { registration, target, sources } };
}

/** The days of a source the registration can measure (enough labelled rows), in order. */
export function measuredDays(source, registration) {
  const evaluation = evaluateFrontierDays(source, { ...registration, thresholds: [], labelThresholds: registration.thresholds });
  if (!evaluation.eligible) throw new Error(`fixture_source_ineligible:${JSON.stringify(evaluation.issues)}`);
  return evaluation.days.filter((day) => day.measured).map((day) => day.day);
}

/**
 * The `superiority` registration for the confirmation days: procedure v5, paired-t, a deterministic consumer, the consumer's
 * own identity and the corpus digest, one group per measured day, cost identity `deterministic-no-model-call`.
 * @param {{manifest:any, inputs:any}} fixture @param {{alpha?:number, expiresAt?:string, groupDays?:string[]}} [options]
 */
export async function frontierStatisticsRegistration({ manifest, inputs }, { alpha = BENIGN_CLAIM_ALPHA, expiresAt = manifest.deadline, groupDays } = {}) {
  const confirmation = manifest.data.sources.find((row) => row.role === 'confirmation');
  const source = inputs.sources[confirmation.id];
  const days = groupDays ?? measuredDays(source, inputs.registration);
  const identity = await frontierCampaignConsumerIdentity();
  return {
    procedure: { ...BENIGN_PROCEDURE }, version: 1, paid_cost_budget: 1, consumer_id: identity.implementationSha256, corpus_digest: digest(source),
    mode: 'paired-t', deterministicConsumer: true, G_target: days.length,
    groups: days.map((day) => ({ id: `day-${day}`, family: 'frontier-days', failure_slice: false, day })),
    families: { 'frontier-days': { repeats: 1, forms: { original: 1 }, score_type: 'bounded-continuous', pilot_rationale: 'Synthetic unit-test fixture: the unit is the day; no benefit is claimed.' } },
    claims: { superiority: alpha }, cost_identity: 'deterministic-no-model-call', expires_at: expiresAt,
  };
}

/** A copy of the fixture with the statistics registration attached and every digest that covers it recomputed. */
export async function attachStatistics(fixture, options = {}) {
  const manifest = structuredClone(fixture.manifest), inputs = structuredClone(fixture.inputs);
  inputs.registration.statistics = await frontierStatisticsRegistration({ manifest, inputs }, options);
  manifest.registration.digest = digest(inputs.registration);
  return { manifest, inputs };
}

/** A fixture whose registration is complete: statistics attached. */
export async function registeredCampaignFixture(options = {}) {
  const { statistics: statisticsOptions, ...fixtureOptions } = options;
  return attachStatistics(benignCampaignFixture(fixtureOptions), statisticsOptions);
}

/** Replace a source and recompute the digests that cover it (the manifest's source row, the statistics' corpus, the registration). */
export async function withSource(fixture, role, mutate) {
  const manifest = structuredClone(fixture.manifest), inputs = structuredClone(fixture.inputs);
  const row = manifest.data.sources.find((entry) => entry.role === role);
  mutate(inputs.sources[row.id]);
  row.digest = digest(inputs.sources[row.id]);
  if (role === 'confirmation' && inputs.registration.statistics) inputs.registration.statistics.corpus_digest = row.digest;
  manifest.registration.digest = digest(inputs.registration);
  return { manifest, inputs };
}

/** The lab configuration and isolation attestation `labPreflight` accepts. */
export const labConfiguration = Object.freeze({
  host: { provider: 'alibaba', purpose: 'rsi-lab', instanceId: 'i-lab', region: 'cn-shanghai' },
  transport: { endpoint: 'https://oss-cn-shanghai.aliyuncs.com', region: 'cn-shanghai', incidentBucket: 'lab-input', bundleBucket: 'lab-output' },
  signer: { keyId: 'kms-lab', publicKeySha256: 'a'.repeat(64) },
  authority: { role: 'rsi-lab', accountId: 'lab-test', dataDir: '/srv/rsi-lab', databaseRole: 'rsi_lab' },
  budget: { campaignCny: 1000, monthCny: 30000 },
  providers: { deepseekFlash: { provider: 'deepseek', model: 'deepseek-flash', credentialRef: 'lab:deepseek' }, qwenMax: { provider: 'dashscope', model: 'qwen3.8-max', credentialRef: 'lab:qwen' } },
});
export const labAttest = async () => ({ role: 'rsi_lab', database: 'evimed_rsi_lab', hostInstanceId: 'i-lab', hostPurpose: 'rsi-lab' });

/** A clock that advances one second a call, so the freeze strictly precedes the confirmation's opening. @param {string} [start] @param {number} [stepMs] */
export function tickingClock(start = BENIGN_CLOCK_START, stepMs = 1000) {
  let at = Date.parse(start);
  const now = () => { const value = new Date(at).toISOString(); at += stepMs; return value; };
  now.peek = () => new Date(at).toISOString();
  now.set = (instant) => { at = Date.parse(instant); };
  return now;
}

/**
 * An in-memory campaign store with the shape `runCampaign` takes: `withCampaign(id, fn)` hands `{read, write, reserveConfirmation}`.
 * The ledger and the opened-corpus records are shared by every campaign of one store, as the lab account's are, and apply
 * `confirmationDecision` to them. `writes()` counts checkpoint writes; `ledger` / `corpora` expose the records.
 */
export function memoryCampaignStore({ ledger = new Map(), corpora = new Map() } = {}) {
  const states = new Map();
  let writes = 0;
  return {
    withCampaign: async (id, operation) => operation({
      read: () => (states.has(id) ? structuredClone(states.get(id)) : null),
      write: async (payload) => { states.set(id, structuredClone(payload)); writes += 1; },
      reserveConfirmation: async (request) => {
        const ledgerId = `${request.surface}:${request.quarter}`;
        const decision = confirmationDecision(ledger.get(ledgerId), corpora.get(request.corpusDigest), request);
        if (decision.write) { ledger.set(ledgerId, structuredClone(decision.ledger)); corpora.set(request.corpusDigest, structuredClone(decision.corpus)); }
        return decision.result;
      },
    }),
    state: (id) => (states.has(id) ? structuredClone(states.get(id)) : null),
    putState: (id, payload) => { states.set(id, structuredClone(payload)); },
    writes: () => writes,
    ledger, corpora,
  };
}

/** What `runCampaign` takes besides the campaign itself. */
export function runnerEnvironment({ store = memoryCampaignStore(), now = tickingClock(), configuration = structuredClone(labConfiguration) } = {}) {
  return { configuration, attestLab: labAttest, store, now, statisticsPython: STATISTICS_PYTHON, statisticsModulePath: STATISTICS_MODULE_PATH };
}

/** A fresh Ed25519 evaluator key: `{privateKey, publicKey, publicKeySha256}`. */
export function generateEvaluatorKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, publicKeySha256: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
}

/**
 * Sign a valid evaluator receipt for a runner's `awaiting-evaluation` request: the receipt payload is recomputed from the
 * checkpoint by `evaluatorReceiptPayload` (it throws a closed `campaign_*` code on any mismatch), signed with a generated key,
 * and the trust profile plus the receipt are written to `dir` for `signedEvaluatorReceipt`.
 * @param {{manifest:any, inputs:any, request:any, checkpoint:any, dir:string, now:string, key?:ReturnType<typeof generateEvaluatorKey>, mutatePayload?:(payload:any)=>void}} input
 */
export async function writeSignedReceipt({ manifest, inputs, request, checkpoint, dir, now, key = generateEvaluatorKey(), mutatePayload }) {
  const payload = await evaluatorReceiptPayload({ manifest, inputs, request, checkpoint, now });
  if (mutatePayload) mutatePayload(payload);
  const envelope = signEnvelope(payload, key.privateKey);
  await mkdir(dir, { recursive: true });
  const profile = { publicKeyPath: join(dir, 'evaluator.pub.pem'), publicKeySha256: key.publicKeySha256, receiptPath: join(dir, 'receipt.json') };
  await writeFile(profile.publicKeyPath, key.publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(profile.receiptPath, JSON.stringify(envelope));
  return { profile, envelope, payload, key };
}

/** The attestation function `runCampaign` takes, from a receipt written by `writeSignedReceipt`. */
export const attestationFrom = (profile, now) => signedEvaluatorReceipt(profile, () => now);

/**
 * A minimal procedure-qualification report in the shape `procedureQualification` reads: passed, generated at `generatedAt`
 * (the qualification lapses 180 days after it), with a development scenario for the claim under the registered procedure.
 * @param {{generatedAt?:string, claim?:string, passed?:boolean}} [options]
 */
export function procedureReport({ generatedAt = '2026-10-20T00:00:00Z', claim = 'superiority', passed = true } = {}) {
  return { qualification_passed: passed, generatedAt, development: { procedure: { ...BENIGN_PROCEDURE }, scenarios: [{ claim, null_false_positive_rate: 0 }] }, held_back: { scenarios: [] } };
}

/**
 * Run a campaign to its evaluator request and, with a receipt the evaluator signed for it, to its verdict: the whole lifecycle
 * through the real runner, the real Python statistics and a real signed receipt on disk.
 * @param {{manifest:any, inputs:any}} fixture @param {{dir:string, store?:ReturnType<typeof memoryCampaignStore>, now?:ReturnType<typeof tickingClock>, receipt?:object}} options
 */
export async function runToVerdict(fixture, { dir, store = memoryCampaignStore(), now = tickingClock(), receipt = {} }) {
  const { runCampaign } = await import('../campaign_runner.mjs');
  const environment = runnerEnvironment({ store, now });
  const awaiting = await runCampaign({ ...fixture, ...environment });
  if (awaiting.status !== 'awaiting-evaluation') return { awaiting, environment };
  const checkpoint = store.state(fixture.manifest.id);
  const issuedAt = now();
  const signed = await writeSignedReceipt({ manifest: fixture.manifest, inputs: fixture.inputs, request: awaiting.request, checkpoint, dir, now: issuedAt, ...receipt });
  const attestEvaluation = await attestationFrom(signed.profile, issuedAt);
  const completed = await runCampaign({ ...fixture, ...environment, attestEvaluation });
  return { awaiting, completed, signed, environment, attestEvaluation, issuedAt, checkpoint };
}

