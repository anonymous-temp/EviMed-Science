#!/usr/bin/env node
/**
 * One patient-grouped evaluation of VCR matching on real clinical notes: n2c2 2018 Track 1 (cohort selection).
 *
 *   node run_n2c2.mjs predict    --split dev|test --run <name> [--max-seconds N] [--limit N]
 *   node run_n2c2.mjs report-dev --run <name> [--round N]
 *   node run_n2c2.mjs freeze
 *   node run_n2c2.mjs score-test --run <name>
 *   node run_n2c2.mjs freeze --manifest 2 --dev-run <name> --rounds <n>      (a second measurement; see below)
 *   node run_n2c2.mjs predict --split heldout --run <name>
 *   node run_n2c2.mjs score-heldout --run <name> [--control-run <name>]
 *
 * The order is the protocol, and the code holds it:
 *
 * 1. `predict --split dev` and `report-dev` are the development rounds, on 40 training patients and nothing else. They may be
 *    repeated while the form of the prompt is tuned (at most three rounds; the README keeps the log).
 * 2. `freeze` writes FROZEN.json: the digests of the harness, of the shipping skill and the evaluator it quotes and runs, the
 *    model and its settings, the scoring readings and the patient lists. It is committed before anything touches the test set.
 * 3. `predict --split test` refuses without a FROZEN.json whose digests all match what is on disk, calls the model for the 86
 *    unannotated test patients and writes their verdicts. The sealed gold is not opened.
 * 4. `score-test` refuses unless the manifest matches, the predictions were made under it and the test has not been scored
 *    before. It alone unpacks the gold, scores once, and leaves a marker that the test has been scored.
 *
 * A second measurement (FROZEN-2.json) follows the same order on the 162 training patients that were never used to tune: the product
 * was changed after the first measurement was scored, so those patients are the nearest thing to unseen that is left. The baseline
 * is learnt from the forty development patients only. The first measurement stands and is not run again.
 *
 * The model's raw answers are cached per patient beside the data (never in the repository), so a re-run costs nothing and an
 * interrupted run resumes. Everything written into the repository is aggregate: counts, rates and intervals.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { TAGS } from './criteria.mjs';
import { DEV_SPLIT, SEALED_ARCHIVE, dataPaths, dataRoot, developmentIds, idsDigest, patientIds, readPatient, sha256 } from './data.mjs';
import { assessPatient } from './assess.mjs';
import { BudgetExceeded, HARD_BUDGET_CNY, MODEL, createDeepSeek } from './deepseek.mjs';
import { BOOTSTRAP, labelsFor, majorityStates, patientCounts, summarize, summarizePaired } from './metrics.mjs';
import { promptDigest, readSkill, systemPrompt, userMessage } from './prompt.mjs';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '../../..');
const FROZEN_PATH = path.join(HERE, 'FROZEN.json');
const FROZEN_2_PATH = path.join(HERE, 'FROZEN-2.json');
const RESULTS = path.join(HERE, 'results');
const SCORER_WRAPPER = path.join(HERE, 'run_official_scorer.py');

/** The model call's settings: part of what is frozen. */
export const SETTINGS = Object.freeze({ model: MODEL, temperature: 0, thinking: 'disabled', responseFormat: 'json_object', maxTokens: 4000, retries: 2, concurrency: 3 });

/** What decides a prediction: checked when the test is predicted, and recorded with the predictions. */
const PREDICT_FILES = Object.freeze([
  'evals/vcr-matching/n2c2/criteria.mjs', 'evals/vcr-matching/n2c2/data.mjs', 'evals/vcr-matching/n2c2/prompt.mjs',
  'evals/vcr-matching/n2c2/deepseek.mjs', 'evals/vcr-matching/n2c2/assess.mjs', 'evals/vcr-matching/n2c2/run_n2c2.mjs',
  'capabilities/vcr-matching/SKILL.md', 'apps/server/src/vcrMatching.mjs', 'apps/server/src/vcrClinicalDateEvidence.mjs',
  'packages/domain/src/vcrMatchBatch.mjs', 'packages/domain/src/metering.mjs', 'packages/domain/src/clinicalUnits.mjs', 'packages/domain/src/clinical-units.json',
]);
/** What decides a score: checked when the test is scored. */
const SCORE_FILES = Object.freeze([
  'evals/vcr-matching/n2c2/criteria.mjs', 'evals/vcr-matching/n2c2/data.mjs', 'evals/vcr-matching/n2c2/metrics.mjs',
  'evals/vcr-matching/n2c2/gold.mjs', 'evals/vcr-matching/n2c2/run_n2c2.mjs', 'evals/vcr-matching/n2c2/run_official_scorer.py',
]);

const canonical = (/** @type {unknown} */ value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));

/** @param {readonly string[]} files */
async function fileDigests(files) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const file of files) out[file] = sha256(await readFile(path.join(REPO, file)));
  return out;
}

/** @param {string} root @param {string} name */
const runDirectory = (root, name) => path.join(dataPaths(root).runs, name);

/** The manifest with its own digest checked. */
async function readFrozen(file = FROZEN_PATH) {
  if (!existsSync(file)) throw new Error(`There is no ${path.basename(file)}: run \`freeze\` and commit it first.`);
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const { digest, ...body } = manifest;
  if (digest !== sha256(canonical(body))) throw new Error(`${path.basename(file)} does not match its own digest: it was edited.`);
  return manifest;
}

/** Refuse when any file of `listed` differs from the digest the manifest recorded. @param {Record<string, string>} recorded */
async function assertFilesMatch(recorded, listed = Object.keys(recorded)) {
  const now = await fileDigests(listed);
  const changed = listed.filter((file) => recorded[file] !== now[file]);
  if (changed.length) throw new Error(`Frozen files have changed since the freeze: ${changed.join(', ')}.`);
  return now;
}

/** @param {string} root */
async function splitIds(root) {
  const paths = dataPaths(root);
  const train = await patientIds(paths.trainDir);
  const test = await patientIds(paths.testDir);
  const dev = developmentIds(train);
  // The training patients that were never used to tune anything: the second measurement's.
  return { train, test, dev, heldout: train.filter((id) => !dev.includes(id)) };
}

/** @param {Record<string, string>} sums */
function rawName(sums, name) { return sums[name]; }

/** @param {string} root @returns {Promise<Record<string, string>>} the digests the data root records for the raw files */
async function readSums(root) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of (await readFile(dataPaths(root).sums, 'utf8')).split('\n')) {
    const match = /^([a-f0-9]{64})\s+(\S+)$/.exec(line.trim());
    if (match) out[match[2]] = match[1];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// predict
// ---------------------------------------------------------------------------------------------------------------------------

/** @param {string} root @param {string} run @param {string} id */
const rawPath = (root, run, id) => path.join(runDirectory(root, run), 'raw', `${id}.json`);

/**
 * @param {{ split: 'dev' | 'test' | 'heldout', run: string, root: string, keyFile?: string, maxSeconds?: number, limit?: number, log?: (line: string) => void,
 *   fetchImpl?: typeof fetch }} options
 */
export async function predict({ split, run, root, keyFile, maxSeconds, limit, log = () => {}, fetchImpl }) {
  const skill = await readSkill();
  const digest = promptDigest(skill);
  const ids = await splitIds(root);
  const everyone = split === 'dev' ? ids.dev : split === 'heldout' ? ids.heldout : ids.test;
  const wanted = everyone.slice(0, limit ?? Infinity);
  const directory = split === 'test' ? dataPaths(root).testDir : dataPaths(root).trainDir;

  /** @type {Record<string, any> | null} */
  let frozen = null;
  /** @type {Record<string, string>} */
  let predictDigests = await fileDigests(PREDICT_FILES);
  if (split === 'test' || split === 'heldout') {
    frozen = await readFrozen(split === 'test' ? FROZEN_PATH : FROZEN_2_PATH);
    predictDigests = await assertFilesMatch(frozen.predictFiles);
    if (frozen.prompt.sha256 !== digest) throw new Error('The prompt is not the frozen one.');
    if (split === 'test' && frozen.dataset.testIdsSha256 !== idsDigest(ids.test)) throw new Error('The test patients are not the frozen ones.');
    if (split === 'heldout' && frozen.dataset.heldoutIdsSha256 !== idsDigest(ids.heldout)) throw new Error('The held-out patients are not the frozen ones.');
    if (run === frozen.devRun) throw new Error('The measured run needs a name of its own.');
  }

  const directoryOfRun = runDirectory(root, run);
  await mkdir(path.join(directoryOfRun, 'raw'), { recursive: true });
  const metaPath = path.join(directoryOfRun, 'meta.json');
  const meta = { split, promptSha256: digest, model: SETTINGS.model, settings: SETTINGS };
  if (existsSync(metaPath)) {
    const earlier = JSON.parse(await readFile(metaPath, 'utf8'));
    if (earlier.split !== split || earlier.promptSha256 !== digest) throw new Error(`The run "${run}" was made with another prompt or split: use a new run name.`);
  } else {
    await writeFile(metaPath, `${JSON.stringify({ ...meta, createdAt: new Date().toISOString() }, null, 2)}\n`);
  }

  const system = systemPrompt(skill);
  const client = createDeepSeek({ keyFile: keyFile ?? process.env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE ?? path.join(root, '..', '..', 'secrets', 'deepseek.api-key'),
    ledgerPath: path.join(dataPaths(root).runs, 'ledger.jsonl'), budget: HARD_BUDGET_CNY, retries: SETTINGS.retries, maxTokens: SETTINGS.maxTokens, fetchImpl });

  const todo = wanted.filter((id) => !existsSync(rawPath(root, run, id)));
  log(`${split}: ${wanted.length} patients, ${wanted.length - todo.length} already answered, spent so far CNY ${client.spent.toFixed(4)}`);
  const started = Date.now();
  let next = 0;
  let stopped = null;
  const failures = [];
  const lane = async () => {
    while (next < todo.length && stopped === null) {
      if (maxSeconds && (Date.now() - started) / 1000 > maxSeconds) { stopped = 'time'; break; }
      const id = todo[next]; next += 1;
      try {
        const patient = await readPatient(directory, id);
        const result = await client.ask({ system, user: userMessage(patient), label: `${run}:${id}` });
        await writeFile(rawPath(root, run, id), `${JSON.stringify({ id, promptSha256: digest, model: SETTINGS.model, served: result.served, at: new Date().toISOString(),
          attempts: result.attempts, finishReason: result.finishReason, unreadable: result.unreadable, usage: result.usage, cost: result.cost, content: result.content })}\n`);
        log(`${id} ${result.unreadable ? 'UNREADABLE' : 'ok'} in=${result.usage.promptTokens} out=${result.usage.completionTokens} cost=${result.cost.toFixed(4)} total=${client.spent.toFixed(3)}`);
      } catch (error) {
        if (error instanceof BudgetExceeded) { stopped = 'budget'; log(error.message); break; }
        failures.push(id);
        log(`${id} failed: ${error instanceof Error ? error.message.slice(0, 160) : 'error'}`);
      }
    }
  };
  await Promise.all(Array.from({ length: SETTINGS.concurrency }, lane));

  const missing = everyone.filter((id) => !existsSync(rawPath(root, run, id)));
  if (missing.length) {
    log(`${missing.length} of ${everyone.length} patients have no answer yet (${stopped ?? (failures.length ? 'failures' : 'limit')}); run again to continue.`);
    return { complete: false, missing: missing.length, spent: client.spent, stopped };
  }
  // Every patient has an answer: the verdicts are computed now, from the cache, before any gold is looked at.
  /** @type {Record<string, any>} */
  const patients = {};
  let cost = 0, promptTokens = 0, completionTokens = 0, cacheHit = 0, calls = 0, retried = 0, unreadableCount = 0;
  const served = new Set();
  for (const id of everyone) {
    const raw = JSON.parse(await readFile(rawPath(root, run, id), 'utf8'));
    let answer = null;
    if (!raw.unreadable) { try { answer = JSON.parse(raw.content); } catch { answer = null; } }
    if (raw.unreadable) unreadableCount += 1;
    const patient = await readPatient(directory, id);
    patients[id] = assessPatient(patient, answer);
    cost += raw.cost; promptTokens += raw.usage.promptTokens; completionTokens += raw.usage.completionTokens; cacheHit += raw.usage.cacheHit; calls += 1;
    if (raw.attempts > 1) retried += 1;
    if (raw.served) served.add(raw.served);
  }
  const predictions = { schema: 1, run, split, promptSha256: digest, model: SETTINGS.model, servedModels: [...served].sort(), predictFiles: predictDigests,
    frozenDigest: frozen?.digest ?? null, madeAt: new Date().toISOString(), usage: { patients: calls, promptTokens, completionTokens, cacheHitTokens: cacheHit, costCny: Number(cost.toFixed(4)), patientsNeedingRetry: retried, unreadableAnswers: unreadableCount },
    patients };
  await writeFile(path.join(directoryOfRun, 'predictions.json'), `${JSON.stringify(predictions)}\n`);
  log(`predictions written for ${everyone.length} patients; this run cost CNY ${cost.toFixed(4)}, ledger total ${client.spent.toFixed(4)}`);
  return { complete: true, missing: 0, spent: client.spent, stopped };
}

// ---------------------------------------------------------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------------------------------------------------------

/** @param {Record<string, 'met' | 'not met'>} labels @param {string} file */
async function writeSystemXml(labels, file) {
  const body = TAGS.map((tag) => `<${tag} met="${labels[tag]}" />`).join('\n');
  await writeFile(file, `<?xml version="1.0" encoding="UTF-8" ?>\n<PatientMatching>\n<TAGS>\n${body}\n</TAGS>\n</PatientMatching>\n`);
}

/** The scorer's table, as numbers. @param {string} output */
export function parseScorerOutput(output) {
  /** @type {Record<string, any>} */
  const rows = {};
  for (const line of output.split('\n')) {
    const match = /^\s*(Overall \((?:micro|macro)\)|[A-Za-z0-9-]+)\s+((?:\d\.\d{4}\s*){9})$/.exec(line);
    if (!match) continue;
    const numbers = match[2].trim().split(/\s+/).map(Number);
    rows[match[1]] = { metPrecision: numbers[0], metRecall: numbers[1], metF1: numbers[3], notMetF1: numbers[6], overallF1: numbers[7] };
  }
  const files = /(\d+) files found/.exec(output);
  return { files: files ? Number(files[1]) : null, micro: rows['Overall (micro)'] ?? null, macro: rows['Overall (macro)'] ?? null,
    perCriterion: Object.fromEntries(Object.entries(rows).filter(([name]) => !name.startsWith('Overall')).map(([name, row]) => [name.toUpperCase(), row.overallF1])) };
}

/**
 * Run the official scorer, unchanged, on a gold folder and the system labels written beside it.
 * @param {{ goldFolder: string, labelsById: Record<string, Record<string, 'met' | 'not met'>>, scorer: string }} input
 */
async function officialScore({ goldFolder, labelsById, scorer }) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'n2c2-sys-'));
  try {
    for (const [id, labels] of Object.entries(labelsById)) await writeSystemXml(labels, path.join(scratch, `${id}.xml`));
    const ran = spawnSync('python3', ['-I', SCORER_WRAPPER, scorer, goldFolder, scratch], { encoding: 'utf8' });
    if (ran.status !== 0) throw new Error(`The official scorer failed: ${String(ran.stderr).slice(0, 300)}`);
    return parseScorerOutput(ran.stdout);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The aggregate record for one set of predictions against its gold.
 * @param {{ predictions: any, gold: Record<string, Record<string, 'met' | 'not met'>>, ids: readonly string[], goldFolder: string, scorer: string, trainGold: ReadonlyArray<Record<string, 'met' | 'not met'>> }} input
 */
export async function scoreSet({ predictions, gold, ids, goldFolder, scorer, trainGold }) {
  const perPatient = ids.map((id) => patientCounts(predictions.patients[id].states, gold[id]));
  const summary = summarize(perPatient);
  const baselineStates = majorityStates(trainGold);
  const baseline = summarize(ids.map((id) => patientCounts(baselineStates, gold[id])));
  /** @type {Record<string, any>} */
  const decided = {};
  /** @type {Record<string, Record<string, number>>} */
  const unknownReasons = {};
  /** @type {Record<string, number>} */
  const dropped = {};
  let proposed = 0, kept = 0, voided = 0, unitDropped = 0, unitByConvention = 0, datedByQuote = 0;
  for (const id of ids) {
    const p = predictions.patients[id];
    proposed += p.facts.proposed; kept += p.facts.kept; voided += p.facts.voidedByEvaluator;
    unitDropped += p.facts.unitDropped ?? 0; unitByConvention += p.facts.unitByConvention ?? 0; datedByQuote += p.facts.datedByQuote ?? 0;
    for (const [reason, n] of Object.entries(p.facts.dropped)) dropped[reason] = (dropped[reason] ?? 0) + /** @type {number} */ (n);
    for (const tag of TAGS) {
      decided[tag] ??= { code: 0, model: 0 };
      decided[tag][p.decidedBy[tag]] += 1;
      if (p.states[tag] === 'unknown') { unknownReasons[tag] ??= {}; unknownReasons[tag][p.reasons[tag] ?? 'not_recorded'] = (unknownReasons[tag][p.reasons[tag] ?? 'not_recorded'] ?? 0) + 1; }
    }
  }
  const labelsB = Object.fromEntries(ids.map((id) => [id, labelsFor(predictions.patients[id].states, 'b')]));
  const labelsC = Object.fromEntries(ids.map((id) => [id, labelsFor(predictions.patients[id].states, 'c')]));
  const official = { readingB: await officialScore({ goldFolder, labelsById: labelsB, scorer }), readingC: await officialScore({ goldFolder, labelsById: labelsC, scorer }) };
  const own = (/** @type {string} */ name) => summary[name]?.value;
  const agreement = {
    microB: { official: official.readingB.micro?.overallF1 ?? null, own: own('ALL.f1MicroB') },
    microC: { official: official.readingC.micro?.overallF1 ?? null, own: own('ALL.f1MicroC') },
    macroB: { official: official.readingB.macro?.overallF1 ?? null, own: own('ALL.f1MacroB') },
  };
  return { patients: ids.length, summary, baseline, decidedBy: decided, unknownReasons, facts: { proposed, kept, voidedByEvaluator: voided, dropped, unitDropped, unitByConvention, datedByQuote }, official, officialAgreement: agreement };
}

/** @param {Awaited<ReturnType<typeof scoreSet>>} scored */
function printSummary(scored) {
  const rows = (/** @type {string} */ key) => scored.summary[key];
  const f = (/** @type {number | null} */ x) => (x === null ? '  -  ' : x.toFixed(3));
  const line = (/** @type {string} */ tag) => `${tag.padEnd(16)} accA=${f(rows(`${tag}.accuracyA`).value)} accB=${f(rows(`${tag}.accuracyB`).value)} accC=${f(rows(`${tag}.accuracyC`).value)} unk=${f(rows(`${tag}.unknownShare`).value)} M>N=${f(rows(`${tag}.metToNotMetExplicit`).value)} N>M=${f(rows(`${tag}.notMetToMet`).value)}`;
  for (const tag of TAGS) process.stdout.write(`${line(tag)}\n`);
  process.stdout.write(`${line('ALL')}\n`);
  process.stdout.write(`F1 micro B ${f(rows('ALL.f1MicroB').value)} (official ${scored.officialAgreement.microB.official}) · micro C ${f(rows('ALL.f1MicroC').value)} (official ${scored.officialAgreement.microC.official}) · macro B ${f(rows('ALL.f1MacroB').value)} (official ${scored.officialAgreement.macroB.official})\n`);
  process.stdout.write(`baseline (training majority) accB ${f(scored.baseline['ALL.accuracyB'].value)} · F1 micro B ${f(scored.baseline['ALL.f1MicroB'].value)}\n`);
  process.stdout.write(`facts proposed ${scored.facts.proposed}, kept ${scored.facts.kept}, voided by evaluator ${scored.facts.voidedByEvaluator}; dropped ${JSON.stringify(scored.facts.dropped)}\n`);
}

/** @param {string} root @param {string} run @param {'dev' | 'test' | 'heldout'} split */
async function loadPredictions(root, run, split) {
  const file = path.join(runDirectory(root, run), 'predictions.json');
  if (!existsSync(file)) throw new Error(`No predictions for run "${run}": run \`predict\` until it reports them written.`);
  const predictions = JSON.parse(await readFile(file, 'utf8'));
  if (predictions.split !== split) throw new Error(`The run "${run}" holds ${predictions.split} predictions, not ${split}.`);
  return predictions;
}

/** @param {string} root @param {readonly string[]} ids */
async function trainGoldOf(root, ids) {
  const paths = dataPaths(root);
  /** @type {Record<string, Record<string, 'met' | 'not met'>>} */
  const out = {};
  for (const id of ids) out[id] = /** @type {any} */ ((await readPatient(paths.trainDir, id)).tags);
  return out;
}

/** @param {string} root @param {string} run @param {number | undefined} round */
export async function reportDev({ root, run, round }) {
  const paths = dataPaths(root);
  const ids = await splitIds(root);
  const predictions = await loadPredictions(root, run, 'dev');
  const all = await trainGoldOf(root, ids.train);
  const goldFolder = await mkdtemp(path.join(os.tmpdir(), 'n2c2-devgold-'));
  try {
    for (const id of ids.dev) await copyFile(path.join(paths.trainDir, `${id}.xml`), path.join(goldFolder, `${id}.xml`));
    // The baseline is learnt from the training patients who are not in the development set.
    const trainGold = ids.train.filter((id) => !ids.dev.includes(id)).map((id) => all[id]);
    const scored = await scoreSet({ predictions, gold: all, ids: ids.dev, goldFolder, scorer: paths.scorer, trainGold });
    const record = { schema: 1, kind: 'development', round: round ?? null, run, promptSha256: predictions.promptSha256, model: predictions.model, servedModels: predictions.servedModels,
      usage: predictions.usage, resamples: BOOTSTRAP.resamples, ...scored };
    await mkdir(RESULTS, { recursive: true });
    const out = path.join(RESULTS, `${run}.json`);
    await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
    printSummary(scored);
    process.stdout.write(`written ${path.relative(REPO, out)}\n`);
    return record;
  } finally {
    await rm(goldFolder, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// freeze and score-test
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Write a manifest. The first (FROZEN.json) froze the harness for the official test split; the second (FROZEN-2.json) freezes the
 * harness after the product fixes for the training patients that were never used to tune, and names the first measurement it follows.
 * @param {{ root: string, devRun: string, rounds: number, second?: boolean }} options
 */
export async function freeze({ root, devRun, rounds, second = false }) {
  const file = second ? FROZEN_2_PATH : FROZEN_PATH;
  if (existsSync(file)) throw new Error(`${path.basename(file)} exists already: a freeze is written once.`);
  const skill = await readSkill();
  // What is frozen is what was developed: the final development run must have been predicted under this very prompt.
  const developed = await loadPredictions(root, devRun, 'dev');
  if (developed.promptSha256 !== promptDigest(skill)) throw new Error(`The development run "${devRun}" was made with another prompt than the one on disk.`);
  const ids = await splitIds(root);
  const sums = await readSums(root);
  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const first = second ? await readFrozen(FROZEN_PATH) : null;
  const firstResult = first ? path.join(RESULTS, `test-${(await readdir(RESULTS)).find((name) => /^test-\d{4}-\d{2}-\d{2}\.json$/.test(name))?.slice(5, 15)}.json`) : null;
  const body = {
    schema: 1,
    frozenAt: new Date().toISOString(),
    treeAtFreeze: gitHead,
    devRun,
    developmentRounds: rounds,
    model: SETTINGS,
    prompt: { sha256: promptDigest(skill), skillSha256: skill.sha256, excerptsSha256: sha256(canonical(skill.excerpts)) },
    predictFiles: await fileDigests(PREDICT_FILES),
    scoreFiles: await fileDigests(SCORE_FILES),
    readings: { a: 'unknown is wrong and stays in the denominator', b: 'unknown is not met', c: 'unknown is not met, except ENGLISH and MAKES-DECISIONS where it is met' },
    bootstrap: BOOTSTRAP,
    dataset: {
      trainZipSha256: rawName(sums, 'train.zip'), testZipSha256: rawName(sums, 'unannotated_test_data.zip'), scorerZipSha256: rawName(sums, 'track1_eval_script.zip'),
      guideSha256: rawName(sums, 'Cohort_selection_AnnGuide_ver3.pdf'), sealedGoldZipSha256: rawName(sums, SEALED_ARCHIVE),
      trainPatients: ids.train.length, testPatients: ids.test.length, testIdsSha256: idsDigest(ids.test),
      developmentSplit: { ...DEV_SPLIT, idsSha256: idsDigest(ids.dev) },
      ...(second ? { heldout: { description: 'the training patients outside the development split: never used to tune, scored here once', patients: ids.heldout.length }, heldoutIdsSha256: idsDigest(ids.heldout) } : {}),
    },
    ...(second && first && firstResult ? {
      measurement: 'heldout-train',
      baseline: 'the class most of the forty development patients have for each criterion; the held-out patients\' labels are not used for it',
      // The first measurement stands and is never run again; the product changed after it, so this one is on other patients.
      follows: { manifest: 'FROZEN.json', digest: first.digest, treeAtFreeze: first.treeAtFreeze, result: path.relative(REPO, firstResult), resultSha256: sha256(await readFile(firstResult)) },
      // The same held-out patients are also run through the first measurement's own harness, prompt and product, unchanged, from a copy
      // of its tree, so that the change can be read on the same patients: its predictions must carry the first manifest's file digests.
      control: { arm: 'the first measurement\'s pipeline, unchanged', treeCommit: first.treeAtFreeze, predictFiles: first.predictFiles },
    } : {}),
    budgetCny: HARD_BUDGET_CNY,
  };
  const manifest = { ...body, digest: sha256(canonical(body)) };
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${path.basename(file)} written (digest ${manifest.digest})\n`);
  return manifest;
}

/** @param {{ root: string, run: string, date?: string }} options */
export async function scoreTest({ root, run, date = new Date().toISOString().slice(0, 10) }) {
  const frozen = await readFrozen();
  await assertFilesMatch(frozen.scoreFiles, SCORE_FILES);
  const directory = runDirectory(root, run);
  const marker = path.join(directory, 'scored.json');
  if (existsSync(marker)) throw new Error(`The test has been scored already (${marker}): it is scored once and the harness is never tuned after it.`);
  const predictions = await loadPredictions(root, run, 'test');
  if (predictions.frozenDigest !== frozen.digest) throw new Error('These predictions were not made under the frozen manifest.');
  for (const file of PREDICT_FILES) if (predictions.predictFiles[file] !== frozen.predictFiles[file]) throw new Error(`The predictions were made with a different ${file}.`);
  const ids = await splitIds(root);
  if (idsDigest(Object.keys(predictions.patients)) !== frozen.dataset.testIdsSha256 || idsDigest(ids.test) !== frozen.dataset.testIdsSha256) throw new Error('The predictions do not cover exactly the frozen test patients.');

  const { openSealedGold, sealedDigest } = await import('./gold.mjs');
  if (await sealedDigest(root) !== frozen.dataset.sealedGoldZipSha256) throw new Error('The sealed archive is not the one the freeze recorded.');
  const sealed = await openSealedGold(root);
  try {
    if (idsDigest(Object.keys(sealed.tags)) !== frozen.dataset.testIdsSha256) throw new Error('The gold does not cover exactly the test patients.');
    const trainGold = Object.values(await trainGoldOf(root, ids.train));
    const scored = await scoreSet({ predictions, gold: sealed.tags, ids: ids.test, goldFolder: sealed.folder, scorer: dataPaths(root).scorer, trainGold });
    const record = {
      schema: 1, kind: 'test', date, run, frozenDigest: frozen.digest, treeAtFreeze: frozen.treeAtFreeze, model: predictions.model, servedModels: predictions.servedModels,
      promptSha256: predictions.promptSha256, skillSha256: frozen.prompt.skillSha256, settings: frozen.model, resamples: BOOTSTRAP.resamples, usage: predictions.usage,
      developmentRounds: frozen.developmentRounds, ...scored,
    };
    await mkdir(RESULTS, { recursive: true });
    const out = path.join(RESULTS, `test-${date}.json`);
    await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(marker, `${JSON.stringify({ scoredAt: new Date().toISOString(), result: path.relative(REPO, out) })}\n`);
    printSummary(scored);
    process.stdout.write(`written ${path.relative(REPO, out)}\n`);
    return record;
  } finally {
    await sealed.cleanup();
  }
}

/**
 * Score the second measurement once: the held-out training patients against their (unsealed) gold, with the baseline learnt from the
 * development patients only, and, when a control run is named, the first measurement's pipeline on the same patients and the change
 * between the two, resampled together.
 * @param {{ root: string, run: string, controlRun?: string, date?: string }} options
 */
export async function scoreHeldout({ root, run, controlRun, date = new Date().toISOString().slice(0, 10) }) {
  const frozen = await readFrozen(FROZEN_2_PATH);
  await assertFilesMatch(frozen.scoreFiles);
  const marker = path.join(runDirectory(root, run), 'scored.json');
  if (existsSync(marker)) throw new Error(`The held-out patients have been scored already (${marker}): they are scored once and the harness is never tuned after.`);
  const predictions = await loadPredictions(root, run, 'heldout');
  if (predictions.frozenDigest !== frozen.digest) throw new Error('These predictions were not made under the second manifest.');
  for (const file of Object.keys(frozen.predictFiles)) if (predictions.predictFiles[file] !== frozen.predictFiles[file]) throw new Error(`The predictions were made with a different ${file}.`);
  const ids = await splitIds(root);
  const covers = (/** @type {any} */ held) => idsDigest(Object.keys(held.patients)) === frozen.dataset.heldoutIdsSha256;
  if (!covers(predictions) || idsDigest(ids.heldout) !== frozen.dataset.heldoutIdsSha256) throw new Error('The predictions do not cover exactly the frozen held-out patients.');
  /** @type {any} */
  let control = null;
  if (controlRun) {
    control = await loadPredictions(root, controlRun, 'heldout');
    if (existsSync(path.join(runDirectory(root, controlRun), 'scored.json'))) throw new Error(`The control run was scored already.`);
    // The control must be the first measurement's pipeline, byte for byte: its predictions carry that manifest's file digests.
    for (const [file, digest] of Object.entries(frozen.control.predictFiles)) if (control.predictFiles[file] !== digest) throw new Error(`The control run was made with a different ${file} than the first measurement.`);
    if (!covers(control)) throw new Error('The control run does not cover exactly the held-out patients.');
  }

  const paths = dataPaths(root);
  const all = await trainGoldOf(root, ids.train);
  const goldFolder = await mkdtemp(path.join(os.tmpdir(), 'n2c2-heldout-'));
  try {
    for (const id of ids.heldout) await copyFile(path.join(paths.trainDir, `${id}.xml`), path.join(goldFolder, `${id}.xml`));
    const baselineGold = ids.dev.map((id) => all[id]);
    const after = await scoreSet({ predictions, gold: all, ids: ids.heldout, goldFolder, scorer: paths.scorer, trainGold: baselineGold });
    const before = control ? await scoreSet({ predictions: control, gold: all, ids: ids.heldout, goldFolder, scorer: paths.scorer, trainGold: baselineGold }) : null;
    const paired = control ? summarizePaired(ids.heldout.map((id) => patientCounts(predictions.patients[id].states, all[id])), ids.heldout.map((id) => patientCounts(control.patients[id].states, all[id]))) : null;
    const record = {
      schema: 1, kind: 'heldout-train', date, run, controlRun: controlRun ?? null, frozenDigest: frozen.digest, treeAtFreeze: frozen.treeAtFreeze,
      follows: frozen.follows, model: predictions.model, servedModels: predictions.servedModels, promptSha256: predictions.promptSha256, skillSha256: frozen.prompt.skillSha256,
      settings: frozen.model, resamples: BOOTSTRAP.resamples, usage: predictions.usage, controlUsage: control?.usage ?? null, developmentRounds: frozen.developmentRounds,
      baselineFrom: frozen.baseline, ...after, ...(before ? { control: before, change: paired } : {}),
    };
    await mkdir(RESULTS, { recursive: true });
    const out = path.join(RESULTS, `heldout-${date}.json`);
    await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
    const stamp = JSON.stringify({ scoredAt: new Date().toISOString(), result: path.relative(REPO, out) });
    await writeFile(marker, `${stamp}\n`);
    if (controlRun) await writeFile(path.join(runDirectory(root, controlRun), 'scored.json'), `${stamp}\n`);
    printSummary(after);
    if (before) { process.stdout.write('-- control (the first measurement\'s pipeline on the same patients)\n'); printSummary(before); }
    process.stdout.write(`written ${path.relative(REPO, out)}\n`);
    return record;
  } finally {
    await rm(goldFolder, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
    split: { type: 'string' }, run: { type: 'string' }, round: { type: 'string' }, 'max-seconds': { type: 'string' }, limit: { type: 'string' },
    'data-root': { type: 'string' }, 'key-file': { type: 'string' }, 'dev-run': { type: 'string' }, rounds: { type: 'string' }, date: { type: 'string' },
    manifest: { type: 'string' }, 'control-run': { type: 'string' } } });
  const mode = positionals[0];
  const root = dataRoot(values['data-root']);
  const log = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);
  if (!existsSync(dataPaths(root).trainDir)) { process.stderr.write(`The n2c2 data are not unpacked under ${root}. Set EVIMED_N2C2_ROOT or --data-root.\n`); return 2; }
  try {
    if (mode === 'predict') {
      if (!values.run || (values.split !== 'dev' && values.split !== 'test' && values.split !== 'heldout')) { process.stderr.write('predict needs --split dev|test|heldout and --run <name>.\n'); return 2; }
      const result = await predict({ split: values.split, run: values.run, root, keyFile: values['key-file'], maxSeconds: values['max-seconds'] ? Number(values['max-seconds']) : undefined, limit: values.limit ? Number(values.limit) : undefined, log });
      return result.complete ? 0 : 3;
    }
    if (mode === 'report-dev') { if (!values.run) throw new Error('report-dev needs --run.'); await reportDev({ root, run: values.run, round: values.round ? Number(values.round) : undefined }); return 0; }
    if (mode === 'freeze') { if (!values['dev-run'] || !values.rounds) throw new Error('freeze needs --dev-run <name of the final development run> and --rounds <how many development rounds were run>.'); await freeze({ root, devRun: values['dev-run'], rounds: Number(values.rounds), second: values.manifest === '2' }); return 0; }
    if (mode === 'score-heldout') { if (!values.run) throw new Error('score-heldout needs --run.'); await scoreHeldout({ root, run: values.run, controlRun: values['control-run'], date: values.date }); return 0; }
    if (mode === 'score-test') { if (!values.run) throw new Error('score-test needs --run.'); await scoreTest({ root, run: values.run, date: values.date }); return 0; }
    process.stderr.write('Modes: predict, report-dev, freeze, score-test, score-heldout.\n');
    return 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = await main();
