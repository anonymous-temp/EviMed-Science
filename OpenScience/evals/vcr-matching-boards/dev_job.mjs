#!/usr/bin/env node
/**
 * The fast debug loop for the patient-matching feature: the feature's real judging code against a board, with no conversation.
 *
 * It composes the platform's own VCR module on a scratch PostgreSQL (the real stores, the real `matching.judge` executor, the
 * real prompts, `callModelForControlPlane` and the usage ledger), stages each patient's note through the data plane like an upload,
 * reads the trials from the board's sealed collection through `vcrTrialCorpus.mjs`, starts the same judging job a conversation or
 * a page starts, and reads the result back through the same reader the pages use. What it writes is the JSONL `to_official.py`
 * takes; `score.py` then scores it. Labels are never read here: the scorer is a separate process.
 *
 *   node dev_job.mjs --board sigir --arm flash-high --mode fit --thinking high --concurrency 8
 *
 * An arm is an experiment name. Each arm has its own study per board, so results never mix; the same arm run again continues
 * from the judgment ledger and pays nothing twice. Guards, in the order they act: the peak window (full price), the campaign's
 * cap (one append-only spend ledger across every arm), the DeepSeek balance floor (`budget.py`), then the same three again while
 * it runs. A stop is clean: the pair in flight finishes, what was judged is kept, the export is written.
 *
 * Exit: 0 finished; 1 error; 2 refused before any paid call; 3 stopped by a guard or a signal with partial results kept;
 * 4 finished with pairs that failed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPeak, priceUsage } from '@evimed/domain';
import { loadConfig } from '../../apps/server/src/config.mjs';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { UsageLedger } from '../../apps/server/src/usageLedger.mjs';
import { composeVcr } from '../../apps/server/src/vcrComposition.mjs';
import { pseudonymOf, studyPseudonymKey } from '../../apps/server/src/vcrDataPlane.mjs';
import { planMatchJudge } from '../../apps/server/src/vcrMatchJudge.mjs';
import { createVcrTrialCorpus } from '../../apps/server/src/vcrTrialCorpus.mjs';
import { BOARDS, JOB_TRIALS, SPLITS, chunk, collectionManifestOf, criterionRecord, fail, loadCases, noteForUpload, protocolOf, rankingRecord } from './board_cases.mjs';
import { DEFAULT_DB_NAME, dropDatabase, ensureDatabase, scratchUrl, takeRunnerLock } from './devdb.mjs';
import { DEFAULT_CAP_CNY, DEFAULT_FLOOR_CNY, GuardStop, createBalanceChecker, createSpendLedger, preflight, watch } from './spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNER = 'vmdev';
const MODES = ['fit', 'criteria', 'both'];
const REAL_PROVIDER = 'https://api.deepseek.com';
const ARM = /^[a-z0-9][a-z0-9_-]{0,39}$/u;

export const EXIT = Object.freeze({ finished: 0, error: 1, refused: 2, stopped: 3, failedPairs: 4 });

const OPTIONS = {
  board: { type: 'string' }, split: { type: 'string', default: 'dev' }, arm: { type: 'string' }, mode: { type: 'string' },
  thinking: { type: 'string', default: 'high' }, 'top-k': { type: 'string' }, concurrency: { type: 'string', default: '8' },
  'limit-patients': { type: 'string' }, out: { type: 'string' }, 'cap-cny': { type: 'string', default: String(DEFAULT_CAP_CNY) },
  'floor-cny': { type: 'string', default: String(DEFAULT_FLOOR_CNY) }, 'allow-peak': { type: 'boolean', default: false },
  'plan-only': { type: 'boolean', default: false }, score: { type: 'string', default: 'auto' },
  'data-dir': { type: 'string' }, boards: { type: 'string' }, 'key-file': { type: 'string' }, 'base-url': { type: 'string', default: 'https://api.deepseek.com' },
  model: { type: 'string', default: 'deepseek-flash' }, 'db-url': { type: 'string' }, 'db-name': { type: 'string', default: DEFAULT_DB_NAME },
  tg2: { type: 'string' }, tg1: { type: 'string' }, labels: { type: 'string' }, 'eval-python': { type: 'string' },
  'expected-output-tokens': { type: 'string' }, 'progress-seconds': { type: 'string', default: '60' }, 'check-minutes': { type: 'string', default: '5' }, help: { type: 'boolean', default: false },
};

/** @param {string | undefined} value @param {string} name @param {number} min @param {number} max */
function whole(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw fail(`${name} is a whole number from ${min} to ${max}.`, 'option_invalid');
  return number;
}

/**
 * The options of a run, checked. Paths and the key come from flags or the environment, never from a default in code.
 * @param {string[]} argv @param {Record<string, string | undefined>} [env]
 */
export function parseOptions(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  if (values.help) return { help: true };
  const board = /** @type {keyof typeof BOARDS} */ (values.board);
  if (!board || !BOARDS[board]) throw fail(`--board is one of ${Object.keys(BOARDS).join(', ')}.`, 'option_invalid');
  if (!values.arm || !ARM.test(values.arm)) throw fail('--arm names the experiment: lowercase letters, digits, - and _ (at most 40).', 'option_invalid');
  if (!SPLITS.includes(String(values.split))) throw fail(`--split is one of ${SPLITS.join(', ')}.`, 'option_invalid');
  const criterionBoard = BOARDS[board].answer === 'criteria';
  const mode = values.mode ?? (criterionBoard ? 'criteria' : 'fit');
  if (!MODES.includes(mode)) throw fail(`--mode is one of ${MODES.join(', ')}.`, 'option_invalid');
  if (criterionBoard && mode === 'fit') throw fail('The criterion board is answered clause by clause: use --mode criteria or both.', 'option_invalid');
  if (!['off', 'high'].includes(String(values.thinking))) throw fail('--thinking is off or high.', 'option_invalid');
  const topKText = values['top-k'];
  const topK = topKText === 'all' ? 'all' : topKText == null ? (mode === 'criteria' || criterionBoard ? 'all' : 10) : whole(topKText, '--top-k', 0, 500);
  if (mode === 'criteria' && topK === 0) throw fail('--mode criteria with --top-k 0 judges nothing.', 'option_invalid');
  const score = String(values.score);
  if (!['auto', 'yes', 'no'].includes(score)) throw fail('--score is auto, yes or no.', 'option_invalid');
  const dataDir = values['data-dir'] ?? env.VCR_BOARDS_DATA;
  const boards = values.boards ?? env.VCR_BOARDS_INPUTS;
  if (!dataDir) throw fail('--data-dir (or VCR_BOARDS_DATA) names the private directory for outputs and the spend ledger.', 'option_missing');
  if (!boards) throw fail('--boards (or VCR_BOARDS_INPUTS) names the prepared inputs directory.', 'option_missing');
  const planOnly = Boolean(values['plan-only']);
  const keyFile = values['key-file'] ?? env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE;
  if (!keyFile && !planOnly) throw fail('--key-file (or OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE) names the DeepSeek key file; the key is never printed.', 'option_missing');
  return {
    help: false, board, split: String(values.split), arm: values.arm, mode, thinking: String(values.thinking), topK,
    concurrency: whole(values.concurrency, '--concurrency', 1, 64),
    limitPatients: values['limit-patients'] == null ? null : whole(values['limit-patients'], '--limit-patients', 1, 100_000),
    out: values.out ? path.resolve(values.out) : null, capCny: Number(values['cap-cny']), floorCny: Number(values['floor-cny']),
    allowPeak: Boolean(values['allow-peak']), planOnly, score,
    dataDir: path.resolve(dataDir), boardsDir: path.resolve(boards), keyFile: keyFile ? path.resolve(keyFile) : null, baseUrl: String(values['base-url']), model: String(values.model),
    dbUrl: values['db-url'] ?? env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? null, dbName: String(values['db-name']),
    tg2: values.tg2 ?? env.VCR_BOARDS_TG2 ?? null, tg1: values.tg1 ?? env.VCR_BOARDS_TG1 ?? null, labels: values.labels ?? env.VCR_BOARDS_LABELS ?? null,
    evalPython: values['eval-python'] ?? env.VCR_BOARDS_PYTHON ?? 'python3',
    expectedOutputTokens: values['expected-output-tokens'] == null ? (String(values.thinking) === 'high' ? 2500 : 500) : whole(values['expected-output-tokens'], '--expected-output-tokens', 50, 64_000),
    progressMs: Number(values['progress-seconds']) * 1000, checkMs: Number(values['check-minutes']) * 60_000,
  };
}

/** @param {number} value */
const yuan = (value) => (Number.isFinite(value) ? value.toFixed(2) : '?');
/** @param {number} value */
const short = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(0)}k` : String(Math.round(value)));

/** What an arm was started with; a later run of the same arm has to agree, or its rows would be read as one experiment. @param {Record<string, any>} o */
const armSettings = (o) => ({ board: o.board, mode: o.mode, thinking: o.thinking, topK: o.topK, model: o.model });

/**
 * Run the loop. `deps` replaces the clock, the log and the balance check in tests; nothing else is replaced.
 * @param {Record<string, any>} o parsed options
 * @param {{ log?: (line: string) => void, now?: () => Date, balance?: (() => Promise<{ code: number, balance: number | null, line: string }>) | null, dropDatabaseAfter?: boolean, signals?: boolean }} [deps]
 */
export async function runDevJob(o, deps = {}) {
  const log = deps.log ?? ((/** @type {string} */ line) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const startedAt = Date.now();
  const spec = BOARDS[/** @type {keyof typeof BOARDS} */ (o.board)];
  const criterionBoard = spec.answer === 'criteria';
  const cases = loadCases(o.boardsDir, o.board, { split: o.split, limit: o.limitPatients });
  if (!cases.length) throw fail('No cases for this board and split.', 'no_cases');

  const outDir = o.out ?? path.join(o.dataDir, 'dev-job', o.arm, o.board);
  fs.mkdirSync(outDir, { recursive: true });
  const armFile = path.join(outDir, 'arm.json');
  const settings = armSettings(o);
  /** @type {Record<string, any>} */
  const arm = fs.existsSync(armFile) ? JSON.parse(fs.readFileSync(armFile, 'utf8')) : {};
  if (arm.settings && JSON.stringify(arm.settings) !== JSON.stringify(settings)) {
    throw fail(`Arm ${o.arm} on board ${o.board} was started with other settings (${JSON.stringify(arm.settings)}); give this experiment a new --arm name.`, 'arm_settings_differ');
  }

  const dbUrl = scratchUrl({ serverUrl: o.dbUrl, name: o.dbName });
  await ensureDatabase(dbUrl);
  const lock = await takeRunnerLock(dbUrl);
  const database = new ControlPlaneDatabase({ databaseUrl: dbUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 5000 });
  /** @type {Record<string, number>} */
  const reports = {};
  const planeDir = path.join(o.dataDir, 'dev-job', 'plane');
  const manifest = criterionBoard ? '' : collectionManifestOf(o.boardsDir, cases);
  let stopSignal = /** @type {GuardStop | null} */ (null);
  const onSignal = () => { stopSignal = stopSignal ?? new GuardStop('signal', 'Interrupted: the run stops cleanly and resumes from its ledger.'); };
  if (deps.signals !== false) for (const name of ['SIGINT', 'SIGTERM']) process.on(name, onSignal);
  let monitor = /** @type {NodeJS.Timeout | null} */ (null);
  let currentJob = /** @type {{ studyId: string, id: string } | null} */ (null);
  try {
    const config = loadConfig({
      databaseUrl: dbUrl, stateStore: 'postgres', deepseekBaseUrl: o.baseUrl, deepseekModel: o.model,
      ...(o.keyFile ? { deepseekApiKeyFile: o.keyFile } : { deepseekApiKey: 'plan-only-no-key' }),
      vcrEnabled: true, vcrAudience: 'all', vcrProviderAgreements: true, vcrProviderAgreementReference: 'Public benchmark inputs; no clinical decision is made here',
      vcrDataPlaneDir: planeDir, vcrTrialCorpusManifest: manifest, vcrMatchJudgeConcurrency: o.concurrency, vcrMatchJudgeThinking: o.thinking,
    });
    const usageLedger = new UsageLedger(database);
    const vcr = composeVcr({ config, productDatabase: database, usageLedger, report: (code) => { reports[code] = (reports[code] ?? 0) + 1; } });
    await vcr.store.ready();
    if (!vcr.dataPlane) throw fail('The data plane is not configured.', 'no_data_plane');

    // --- the account, the study of this arm and board, the notes ------------------------------------------------------
    const projectId = `vmdev-${o.arm}-${o.board}`.slice(0, 80);
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'VCR boards dev loop','development') ON CONFLICT (id) DO NOTHING", [OWNER]);
    await database.query('INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,$3,1000000000) ON CONFLICT DO NOTHING', [OWNER, projectId, `${o.arm} ${o.board}`]);
    const study = (await vcr.store.studyByControlProject(OWNER, projectId))
      ?? await vcr.store.createStudy({ userId: OWNER, projectId, name: `dev-job|${o.arm}|${o.board}`, question: `Board ${o.board}, arm ${o.arm}`, dataTier: 'T0' });
    const sources = await vcr.dataStore.listSourcesForStudy(study.id);
    const source = sources.find((/** @type {any} */ row) => row.name === 'board-notes') ?? await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: 'board-notes' });
    const pseudonymKey = await studyPseudonymKey(planeDir, study.id);
    const subjectOf = (/** @type {string} */ patientId) => pseudonymOf(pseudonymKey, patientId);
    const held = new Set((await vcr.dataPlane.listDocuments({ studyId: study.id, principal: OWNER })).map((/** @type {any} */ row) => row.subjectKey));
    let uploaded = 0;
    for (const row of cases) {
      if (held.has(subjectOf(row.patientId))) continue;
      const text = noteForUpload(o.board, row.note);
      await vcr.dataPlane.storeUpload({ actor: OWNER, studyId: study.id, sourceId: source.id, name: `${row.patientId}.txt`, role: 'document', subject: row.patientId, stream: (async function* () { yield Buffer.from(text, 'utf8'); })() });
      uploaded += 1;
    }
    fs.writeFileSync(armFile, `${JSON.stringify({ settings, studyId: study.id, sourceId: source.id, startedAt: arm.startedAt ?? now().toISOString() }, null, 2)}\n`);

    // --- what will be judged ------------------------------------------------------------------------------------------
    let collection = null;
    if (!criterionBoard) {
      const corpus = createVcrTrialCorpus(manifest);
      collection = { id: corpus?.id, revision: corpus?.revision };
      await corpus?.close();
    }
    /** @type {Array<{ key: string, patientIds: string[], subjectKeys: string[], targetIds: string[], selection: Record<string, any>, protocol?: ReturnType<typeof protocolOf> }>} */
    const items = [];
    /** @type {Map<string, ReturnType<typeof protocolOf> & { versionId: string }>} */
    const protocols = new Map();
    const fitOn = o.mode !== 'criteria';
    const topK = o.mode === 'fit' ? 0 : o.topK;
    if (!criterionBoard) {
      for (const row of cases) {
        chunk(row.candidateIds.map(String), JOB_TRIALS).forEach((ids, index) => {
          items.push({ key: `${row.patientId}#${index}`, patientIds: [row.patientId], subjectKeys: [subjectOf(row.patientId)], targetIds: ids,
            selection: { direction: 'patient_to_trial', subjectKey: subjectOf(row.patientId), registryIds: ids, collection: collection?.id, collectionRevision: collection?.revision, fit: fitOn, topK, thinking: o.thinking } });
        });
      }
    } else {
      const existing = await vcr.matchStore.protocols(study.id);
      /** @type {Map<string, { patientIds: string[] }>} */
      const groups = new Map();
      for (const row of cases) {
        for (const trial of row.trials) {
          const protocol = protocolOf(trial);
          if (!protocol.criteria.length) continue;
          if (!protocols.has(protocol.key)) {
            const found = existing.find((/** @type {any} */ version) => version.sourceRef === protocol.key);
            const versionId = found?.id ?? (await vcr.matchStore.saveProtocolVersion({ studyId: study.id, userId: OWNER, title: protocol.title, sourceRef: protocol.key, criteria: protocol.criteria })).id;
            protocols.set(protocol.key, { ...protocol, versionId });
          }
          const group = groups.get(protocol.key) ?? { patientIds: [] };
          group.patientIds.push(row.patientId);
          groups.set(protocol.key, group);
        }
      }
      for (const [key, group] of groups) {
        const protocol = /** @type {NonNullable<ReturnType<typeof protocols.get>>} */ (protocols.get(key));
        items.push({ key, patientIds: group.patientIds, subjectKeys: group.patientIds.map(subjectOf), targetIds: [protocol.versionId], protocol,
          selection: { direction: 'trial_to_patient', protocolVersionId: protocol.versionId, subjectKeys: group.patientIds.map(subjectOf), fit: fitOn, topK, thinking: o.thinking } });
      }
    }

    // --- the plan and the estimate ------------------------------------------------------------------------------------
    const peakNow = isPeak(now());
    const doneRows = await vcr.matchJudgments.list({ studyId: study.id });
    const doneBy = (/** @type {string} */ mode) => {
      /** @type {Map<string, Set<string>>} */
      const out = new Map();
      for (const row of doneRows) {
        if (row.status !== 'done' || row.mode !== mode) continue;
        const set = out.get(row.subjectKey) ?? new Set();
        set.add(row.targetId);
        out.set(row.subjectKey, set);
      }
      return out;
    };
    const fitDone = doneBy('fit'), criteriaDone = doneBy('criteria');
    let estimateCny = 0, expectedCny = 0, estimatedCalls = 0, pairsTotal = 0, pairsRemaining = 0;
    /** @type {typeof items} */
    const work = [];
    for (const item of items) {
      const own = item.subjectKeys.map((key) => ({ fit: fitDone.get(key) ?? new Set(), criteria: criteriaDone.get(key) ?? new Set() }));
      const remaining = item.targetIds.length * item.subjectKeys.length - own.reduce((sum, done) => sum + item.targetIds.filter((id) => (fitOn ? done.fit : done.criteria).has(id)).length, 0);
      const wantCriteria = o.mode === 'fit' ? 0 : (o.topK === 'all' ? item.targetIds.length : Math.min(Number(o.topK), item.targetIds.length)) * item.subjectKeys.length;
      const criteriaHeld = own.reduce((sum, done) => sum + Math.min(done.criteria.size, wantCriteria), 0);
      const complete = remaining === 0 && criteriaHeld >= wantCriteria;
      pairsTotal += item.targetIds.length * item.subjectKeys.length;
      pairsRemaining += remaining;
      if (complete) continue;
      work.push(item);
      const planned = await planMatchJudge({ study, selection: item.selection, matchStore: vcr.matchStore, documents: vcr.documents, subjectTable: null, config, peak: peakNow });
      if (!planned.ok) throw fail(`A job could not be planned: ${planned.message}`, 'plan_refused');
      const fraction = Math.max(0.05, remaining / Math.max(1, item.targetIds.length * item.subjectKeys.length));
      const scale = remaining ? fraction : 0.05;
      estimateCny += (planned.scenario.estimate.cost ?? 0) * scale;
      estimatedCalls += Math.ceil(planned.scenario.estimate.calls * scale);
      // The plan's figure charges every call its whole output allowance. The guard also reads what a call is expected to use.
      const expected = priceUsage({ resourceType: 'model', model: o.model, cacheHit: 0, cacheMiss: planned.scenario.estimate.inputTokens * scale, output: planned.scenario.estimate.calls * scale * o.expectedOutputTokens, peak: peakNow });
      expectedCny += expected.priced ? expected.cost : 0;
    }
    const spendLedger = createSpendLedger(path.join(o.dataDir, 'spend-ledger.jsonl'));
    // Jobs a killed run never wrote down: their cost is in the usage ledger, and the cap counts it.
    const known = spendLedger.jobIds();
    const jobsHere = await database.query("SELECT j.id, s.name FROM evimed_vcr.jobs j JOIN evimed_vcr.studies s ON s.id = j.study_id WHERE j.method = 'matching.judge'");
    const costOf = async (/** @type {string[]} */ ids) => {
      if (!ids.length) return new Map();
      const result = await database.query(`SELECT run_id, COALESCE(sum(CASE WHEN status = 'released' THEN 0 ELSE COALESCE(actual_cost, reserved_cost) END), 0)::float AS cny, count(*)::int AS calls,
        COALESCE(sum(COALESCE(cache_hit_tokens, 0) + COALESCE(cache_miss_tokens, 0)), 0)::float AS input_tokens, COALESCE(sum(COALESCE(output_tokens, 0)), 0)::float AS output_tokens,
        count(*) FILTER (WHERE status = 'uncertain')::int AS uncertain
        FROM evimed_usage.model_requests WHERE run_id = ANY($1::text[]) GROUP BY run_id`, [ids]);
      return new Map(result.rows.map((/** @type {any} */ row) => [row.run_id, { cny: Number(row.cny), calls: Number(row.calls), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), uncertain: Number(row.uncertain) }]));
    };
    const unwritten = jobsHere.rows.map((/** @type {any} */ row) => ({ id: String(row.id), name: String(row.name) })).filter((row) => !known.has(row.id));
    if (unwritten.length) {
      const costs = await costOf(unwritten.map((row) => row.id));
      for (const row of unwritten) {
        const [, armName = '', boardName = ''] = row.name.split('|');
        const cost = costs.get(row.id)?.cny ?? 0;
        spendLedger.append({ kind: 'reconcile', arm: armName, board: boardName, jobId: row.id, costCny: cost });
      }
    }
    const recordedBefore = spendLedger.recorded();
    log(`[dev_job] board=${o.board} arm=${o.arm} mode=${o.mode} thinking=${o.thinking} topK=${o.topK} concurrency=${o.concurrency} split=${o.split} patients=${cases.length} (uploaded ${uploaded} notes)`);
    log(`[dev_job] pairs ${pairsTotal}, still to judge ${pairsRemaining} in ${work.length} job(s); estimate CNY ${yuan(expectedCny)} expected (${estimatedCalls} calls, ${o.expectedOutputTokens} output tokens each), at most ${yuan(estimateCny)} if every call used its whole output allowance; recorded so far CNY ${yuan(recordedBefore)} of cap ${yuan(o.capCny)}${peakNow ? '; PEAK window (full price)' : ''}`);

    const balance = deps.balance !== undefined ? deps.balance
      : (o.keyFile && new URL(o.baseUrl).origin === REAL_PROVIDER ? createBalanceChecker({ python: o.evalPython, script: path.join(HERE, 'budget.py'), keyFile: o.keyFile, floor: o.floorCny }) : null);
    if (!balance) log('[dev_job] no balance check: this is not the real provider (or the test supplies none).');
    /** @type {Record<string, any>} */
    const summary = { board: o.board, arm: o.arm, mode: o.mode, thinking: o.thinking, topK: o.topK, split: o.split, model: o.model, concurrency: o.concurrency,
      patients: cases.length, pairsTotal, pairsRemainingAtStart: pairsRemaining, jobs: work.length, estimateCny: Number(expectedCny.toFixed(4)), estimateUpperBoundCny: Number(estimateCny.toFixed(4)), peakAtStart: peakNow, startedAt: new Date(startedAt).toISOString() };
    let balanceNow = null;
    if (o.planOnly) {
      summary.planOnly = true;
      fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      log('[dev_job] plan only: nothing was sent to a model.');
      return { exitCode: EXIT.finished, summary, outDir };
    }
    if (work.length) {
      // The collection must open before anything is paid for: a mismatched revision would fail every pair.
      if (!criterionBoard) {
        const first = await vcr.evidence.judgmentRecord({ userId: OWNER, registryId: String(cases[0].candidateIds[0]), collection: collection?.id, collectionRevision: collection?.revision });
        if (first.status !== 'ok') throw fail(`The board's collection does not open (${first.reason ?? first.status}).`, 'collection_unreadable');
      }
      try {
        balanceNow = await preflight({ estimateCny: expectedCny, capCny: o.capCny, recordedCny: recordedBefore, floor: o.floorCny, allowPeak: o.allowPeak, now: now(), balance });
      } catch (error) {
        if (error instanceof GuardStop) {
          log(`[dev_job] refused: ${error.message}`);
          summary.refused = { code: error.code, message: error.message };
          fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
          return { exitCode: EXIT.refused, summary, outDir };
        }
        throw error;
      }
      if (balanceNow != null) log(`[dev_job] balance CNY ${yuan(balanceNow)} (floor ${yuan(o.floorCny)})`);
    }

    // --- the loop -----------------------------------------------------------------------------------------------------
    // A job a killed run left queued or running would hold the account's one slow-lane place until its lease ran out.
    await database.query(`UPDATE evimed_vcr.jobs SET state = 'canceled', lease_owner = NULL, lease_until = NULL, finished_at = now()
      WHERE study_id = $1 AND method = 'matching.judge' AND state IN ('queued', 'running', 'awaiting_budget')`, [study.id]);
    /** @type {string[]} */
    const myJobs = [];
    let consecutiveUnreadable = 0;
    let lastCheck = Date.now();
    const progress = async () => {
      const counts = await database.query('SELECT status, count(*)::int AS n FROM evimed_vcr.match_judgments WHERE study_id = $1 GROUP BY status', [study.id]);
      const by = Object.fromEntries(counts.rows.map((/** @type {any} */ row) => [row.status, Number(row.n)]));
      const spent = [...(await costOf(myJobs)).values()];
      const cny = spent.reduce((sum, row) => sum + row.cny, 0);
      const tokensIn = spent.reduce((sum, row) => sum + row.inputTokens, 0), tokensOut = spent.reduce((sum, row) => sum + row.outputTokens, 0);
      log(`[dev_job] ${Math.round((Date.now() - startedAt) / 60_000)} min | judged ${by.done ?? 0} failed ${by.failed ?? 0} | tokens in ${short(tokensIn)} out ${short(tokensOut)} | cost CNY ${yuan(cny)} (campaign ${yuan(recordedBefore + cny)})`);
      if (Date.now() - lastCheck >= o.checkMs) {
        lastCheck = Date.now();
        const verdict = await watch({ spentThisRunCny: cny, recordedBeforeCny: recordedBefore, capCny: o.capCny, floor: o.floorCny, allowPeak: o.allowPeak, now: now(), balance });
        consecutiveUnreadable = verdict.unreadable ? consecutiveUnreadable + 1 : 0;
        if (verdict.stop) stopSignal = stopSignal ?? verdict.stop;
        else if (consecutiveUnreadable >= 3) stopSignal = stopSignal ?? new GuardStop('balance_unreadable', 'The balance could not be read three times in a row.');
      }
      if (stopSignal && currentJob) await vcr.jobs.cancel(currentJob.studyId, currentJob.id, { actor: OWNER }).catch(() => {});
    };
    monitor = setInterval(() => { progress().catch(() => {}); }, Math.max(50, o.progressMs));
    monitor.unref?.();
    for (const item of work) {
      if (stopSignal) break;
      const started = await vcr.matchJudge.start(study, item.selection, { actor: OWNER });
      myJobs.push(String(started.jobId));
      const claimed = await vcr.jobs.claim({ lane: 'slow' });
      const job = claimed.find((/** @type {any} */ row) => String(row.id) === String(started.jobId));
      if (!job) throw fail(`The job ${started.jobId} was not claimable (${claimed.length} other job(s) claimed).`, 'job_not_claimed');
      currentJob = { studyId: study.id, id: String(job.id) };
      await vcr.jobs.advance(job);
      currentJob = null;
      const cost = (await costOf([String(started.jobId)])).get(String(started.jobId));
      spendLedger.append({ kind: 'job', arm: o.arm, board: o.board, jobId: String(started.jobId), costCny: cost?.cny ?? 0, calls: cost?.calls ?? 0 });
    }
    clearInterval(monitor);
    monitor = null;
    await progress().catch(() => {});

    // --- what was saved, as the scorer reads it -----------------------------------------------------------------------
    const usageOf = async (/** @type {string} */ subjectKey) => {
      const result = await database.query(`SELECT COALESCE(sum((usage->>'inputTokens')::float), 0) AS i, COALESCE(sum((usage->>'outputTokens')::float), 0) AS o, COALESCE(sum((usage->>'cost')::float), 0) AS c
        FROM evimed_vcr.match_judgments WHERE study_id = $1 AND subject_key = $2`, [study.id, subjectKey]);
      const row = result.rows[0] ?? {};
      return { inputTokens: Number(row.i ?? 0), outputTokens: Number(row.o ?? 0), costCny: Number(row.c ?? 0) };
    };
    const failedOf = async (/** @type {string} */ subjectKey, /** @type {(row: any) => string} */ idOf) => {
      const rows = await vcr.matchJudgments.list({ studyId: study.id, subjectKey });
      const done = new Set(rows.filter((/** @type {any} */ row) => row.status === 'done').map((/** @type {any} */ row) => `${row.targetKind}\u0000${row.targetId}`));
      return rows.filter((/** @type {any} */ row) => row.status === 'failed' && !done.has(`${row.targetKind}\u0000${row.targetId}`))
        .map((/** @type {any} */ row) => ({ registryId: idOf(row), code: String(row.errorCode ?? 'unknown') }));
    };
    /** @type {Array<Record<string, any>>} */
    const records = [];
    for (const row of cases) {
      const subjectKey = subjectOf(row.patientId);
      if (!criterionBoard) {
        /** @type {any[]} */ const ranking = [];
        for (let offset = 0; ; offset += 500) {
          const page = await vcr.matchJudgmentReads.forSubject(study, subjectKey, { limit: 500, offset });
          ranking.push(...page.ranking);
          if (!page.more) break;
        }
        records.push(rankingRecord({ case: row, ranking, failed: await failedOf(subjectKey, (r) => String(r.targetId)), usage: await usageOf(subjectKey) }));
      } else {
        /** @type {Map<string, { ranking: any[], numbered: any[] }>} */
        const byTrial = new Map();
        for (const trial of row.trials) {
          const protocol = protocols.get(protocolOf(trial).key);
          if (!protocol) continue;
          const page = await vcr.matchJudgmentReads.forProtocol(study, protocol.versionId, { subjectKey, limit: 1, offset: 0 });
          byTrial.set(String(trial.registryId), { ranking: page.ranking, numbered: protocol.numbered });
        }
        const versionOf = new Map([...protocols.values()].map((protocol) => [protocol.versionId, protocol.registryId]));
        records.push(criterionRecord({ case: row, byTrial, failed: await failedOf(subjectKey, (r) => String(versionOf.get(String(r.targetId)) ?? r.targetId)), usage: await usageOf(subjectKey) }));
      }
    }
    const judgmentsFile = path.join(outDir, 'judgments.jsonl');
    fs.writeFileSync(`${judgmentsFile}.tmp`, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    fs.renameSync(`${judgmentsFile}.tmp`, judgmentsFile);

    const statusCounts = records.reduce((out, record) => ({ ...out, [record.status]: (out[record.status] ?? 0) + 1 }), /** @type {Record<string, number>} */ ({}));
    const failedByCode = records.flatMap((record) => record.failed).reduce((out, entry) => ({ ...out, [entry.code]: (out[entry.code] ?? 0) + 1 }), /** @type {Record<string, number>} */ ({}));
    const spentRun = [...(await costOf(myJobs)).values()];
    Object.assign(summary, {
      finishedAt: now().toISOString(), wallMinutes: Number(((Date.now() - startedAt) / 60_000).toFixed(2)), patientStatus: statusCounts, pairsFailedByCode: failedByCode,
      jobsRun: myJobs.length, calls: spentRun.reduce((s, r) => s + r.calls, 0), uncertainCalls: spentRun.reduce((s, r) => s + r.uncertain, 0),
      inputTokens: spentRun.reduce((s, r) => s + r.inputTokens, 0), outputTokens: spentRun.reduce((s, r) => s + r.outputTokens, 0),
      costCnyThisRun: Number(spentRun.reduce((s, r) => s + r.cny, 0).toFixed(4)), campaignCnyAfter: Number(spendLedger.recorded().toFixed(4)),
      ...(Object.keys(reports).length ? { reported: reports } : {}),
      ...(stopSignal ? { stopped: { code: stopSignal.code, message: stopSignal.message } } : {}),
    });
    if (balance && balanceNow != null) summary.balanceAtStart = balanceNow;
    fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    log(`[dev_job] ${stopSignal ? `stopped (${/** @type {GuardStop} */ (stopSignal).code}); partial results kept` : 'finished'} | patients ${JSON.stringify(statusCounts)} | failed pairs ${JSON.stringify(failedByCode)} | cost CNY ${yuan(summary.costCnyThisRun)} | wrote ${path.relative(process.cwd(), judgmentsFile) || judgmentsFile}`);

    // --- scoring ------------------------------------------------------------------------------------------------------
    const holdsTest = cases.some((row) => row.split === 'test');
    const wantsScore = o.score === 'yes' || (o.score === 'auto' && !holdsTest);
    if (o.score === 'auto' && holdsTest) log('[dev_job] the selection holds held-out (test) patients: not scored automatically; pass --score yes to score it.');
    if (wantsScore) summary.score = await scoreRun(o, spec, outDir, judgmentsFile, log);
    fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

    const failedPairs = Object.values(failedByCode).reduce((s, n) => s + n, 0);
    return { exitCode: stopSignal ? EXIT.stopped : failedPairs ? EXIT.failedPairs : EXIT.finished, summary, outDir };
  } finally {
    if (monitor) clearInterval(monitor);
    if (deps.signals !== false) for (const name of ['SIGINT', 'SIGTERM']) process.off(name, onSignal);
    await database.close().catch(() => {});
    await lock.release().catch(() => {});
    if (deps.dropDatabaseAfter) await dropDatabase(dbUrl).catch(() => {});
  }
}

/**
 * Hand the export to `score.py`, which reads the pinned labels and qrels in its own process; only its aggregate output reaches the log.
 * @param {Record<string, any>} o @param {typeof BOARDS[keyof typeof BOARDS]} spec @param {string} outDir @param {string} file @param {(line: string) => void} log
 */
async function scoreRun(o, spec, outDir, file, log) {
  const missing = [spec.scorer !== 'c' && !o.tg2 && '--tg2', spec.scorer === 'a' && !o.tg1 && '--tg1', spec.scorer === 'c' && !o.labels && '--labels'].filter(Boolean);
  if (missing.length) { log(`[dev_job] not scored: ${missing.join(', ')} needed (or VCR_BOARDS_TG2, VCR_BOARDS_TG1, VCR_BOARDS_LABELS).`); return { skipped: missing }; }
  const args = ['-I', '-B', path.join(HERE, 'score.py'), spec.scorer, '--boards', o.boardsDir, '--work', path.join(outDir, 'score-work'), '--out', path.join(outDir, 'score')];
  if (spec.scorer !== 'c') args.push('--tg2', o.tg2, '--python', o.evalPython);
  if (spec.scorer === 'a') args.push('--tg1', o.tg1, '--judgments', `${spec.cohort}=${file}`);
  else args.push('--judgments', file);
  if (spec.scorer === 'c') args.push('--labels', o.labels);
  const code = await new Promise((resolve) => {
    const child = spawn(o.evalPython, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', () => resolve(127));
    child.once('close', (status) => resolve(status ?? 1));
  });
  if (code !== 0) log(`[dev_job] score.py exited ${code}`);
  return { exitCode: code, out: path.join(outDir, 'score') };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try { options = parseOptions(argv, env); } catch (error) {
    process.stderr.write(`dev_job: ${/** @type {any} */ (error)?.message ?? error}\n`);
    return EXIT.error;
  }
  if (options.help) { process.stdout.write(`${fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^[^]*?\/\*\*\n/u, '').replace(/^ \* ?/gmu, '')}\n`); return EXIT.finished; }
  try { return (await runDevJob(options)).exitCode; } catch (error) {
    process.stderr.write(`dev_job: ${/** @type {any} */ (error)?.code ?? 'error'}: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 400)}\n`);
    return EXIT.error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
