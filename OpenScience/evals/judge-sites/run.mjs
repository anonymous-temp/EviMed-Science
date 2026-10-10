// Measures Jev judge sites against the corpora in evals/judge-sites/<site>/.
//
//   node evals/judge-sites/run.mjs [--site J2,J3] [--limit N]                          validate the corpora, no model call
//   node evals/judge-sites/run.mjs --live --output <private.json> [--site ...]          Jev alone, at each site's pinned threshold
//   ... --incumbent                 also run the path each site replaces, as production runs it (incumbents.mjs; J3 through the
//                                   production classifier and routing, J2 through ChannelIntentClassifier, J5 and J6 through the
//                                   frontier editor, J4 the frozen register pattern, J15 and J18 their fixed originals)
//   ... --resume                    skip the cases the output file already holds
//
// Keys come from the files the server itself reads (OPEN_SCIENCE_TYPESAFE_API_KEY_FILE, OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE); nothing here
// prints or stores one, and the output is kept private. `write-benefit.mjs` turns passes of such a report into a site's committed
// benefit record, and `benefit.mjs` holds the one rule that decides from it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { loadConfig } from '../../apps/server/src/config.mjs';
import { callJev } from '../../apps/server/src/jevModel.mjs';
import { createJudgeService, decodeJudgeAnswers } from '../../apps/server/src/judgeService.mjs';
import { buildJudgeRequest, JUDGE_SITE_IDS } from '../../apps/server/src/judgeSites.mjs';
import { SpecialistClassifier } from '../../apps/server/src/specialistClassifier.mjs';
import { verifiedIntent } from '../../apps/server/src/channels/intent.mjs';
import { lowerConfidenceBound, recommendThreshold } from './statistics.mjs';
import { routeRecordedDecision } from './routing-evaluation.mjs';
import { createIncumbents, createMeter } from './incumbents.mjs';
import { summarizeSite } from './benefit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback = null) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const live = argv.includes('--live');
const provider = option('--provider', 'jev');
if (!['jev', 'bailian'].includes(provider)) throw new Error('Unknown evaluation provider');
const sites = option('--site')?.split(',') ?? JUDGE_SITE_IDS.filter(site => site !== 'reply-check');
if (sites.some(site => !JUDGE_SITE_IDS.includes(site))) throw new Error('Unknown judge site');
const output = option('--output');
if (live && !output) throw new Error('Live evaluation requires a private --output path');
const catalog = [];
for (const name of (await fs.readdir(path.join(root, 'capabilities'))).sort()) {
  let capability;
  try { capability = parse(await fs.readFile(path.join(root, 'capabilities', name, 'capability.yaml'), 'utf8')); } catch { continue; }
  if (capability.visibility === 'internal') continue;
  catalog.push({ id: capability.id, title: capability.title, description: capability.description ?? '',
    requiredInputs: capability.inputs?.required ?? [], starterPrompts: capability.starterPrompts ?? [],
    version: capability.version, runtimeAgent: `evimed-${capability.id}` });
}
const catalogDigest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
const config = loadConfig({ requireDurableUsageLedger: false });
if (provider === 'bailian') {
  const keyFile = process.env.OPEN_SCIENCE_JUDGE_BAILIAN_API_KEY_FILE;
  if (live && !keyFile) throw new Error('Bailian evaluation requires its API key file');
  config.typesafeApiKey = keyFile ? (await fs.readFile(keyFile, 'utf8')).trim() : '';
  config.reviewJevModel = 'decision-model-preview';
  config.reviewJevApiBase = process.env.OPEN_SCIENCE_JUDGE_BAILIAN_API_BASE ?? 'https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
}
if (live && !config.typesafeApiKey) throw new Error('No judge key is configured');
// Use the provider's documented batch ceiling without changing site questions.
const meteredCall = async (deps, call) => {
  if (provider !== 'bailian') return callJev(deps, call);
  const entries = Object.entries(call.questions);
  const combined = { answers: {}, model: config.reviewJevModel, cost: 0 };
  for (let index = 0; index < entries.length; index += 16) {
    const result = await callJev(deps, { ...call, questions: Object.fromEntries(entries.slice(index, index + 16)) });
    Object.assign(combined.answers, result.answers);
    combined.cost += result.cost;
  }
  return combined;
};
const judge = createJudgeService({ config, callImpl: meteredCall, calibrationMode: true });
// `--incumbent` (or the older `--baseline flash`) also runs, for each case, the path the site replaces: the production class or pattern
// itself, measured for latency and cost (incumbents.mjs). Without it Jev is measured alone.
const incumbentOn = argv.includes('--incumbent') || option('--baseline') === 'flash';
const meter = createMeter();
const incumbents = incumbentOn ? createIncumbents({ config, meter }) : {};
const baseline = incumbentOn ? new SpecialistClassifier({ ...config, llmRoutingEnabled: true }, { fetchImpl: meter.fetchImpl }) : null;
const resume = argv.includes('--resume');
const baselineReplayFile = option('--baseline-replay');
const baselineReplay = baselineReplayFile ? JSON.parse(await fs.readFile(baselineReplayFile, 'utf8')) : null;
if (baselineReplay && baselineReplay.catalogDigest !== catalogDigest) throw new Error('Baseline catalog differs from the live catalog');
let previous = [];
if (resume && output) try { previous = JSON.parse(await fs.readFile(output, 'utf8')).rows ?? []; } catch { /* Nothing to resume from. */ }
const report = { schemaVersion: 1, provider, model: config.reviewJevModel, at: new Date().toISOString(),
  mode: live ? 'live-calibration' : 'corpus-validation-only', catalogCount: catalog.length, catalogDigest,
  independentHoldout: false, sites: {}, rows: [] };

function includesExpected(actual, expected) {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (!actual || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => includesExpected(actual[i], v));
  return Object.entries(expected).every(([key, value]) => includesExpected(actual[key], value));
}
function satisfiesConstraint(actual, expected, mode) {
  if (Array.isArray(expected) && expected.every(value => value === null || typeof value !== 'object')) {
    return mode === 'any' ? expected.includes(actual) : !expected.includes(actual);
  }
  if (!expected || typeof expected !== 'object') return mode === 'any' ? actual === expected : actual !== expected;
  if (!actual || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((value, index) => satisfiesConstraint(actual[index], value, mode));
  return Object.entries(expected).every(([key, value]) => key === 'id' ? actual[key] === value : satisfiesConstraint(actual[key], value, mode));
}
/** Whether `value` is what the case's label says, by the first kind of label the case carries; undefined when it carries none the runner can score. */
function labelCorrect(example, value) {
  if (example.expected?.methodsReportingAnnotations) return undefined;
  if (example.expected !== undefined) return includesExpected(value, example.expected);
  if (example.expectedPartial !== undefined) return includesExpected(value, example.expectedPartial);
  if (example.expectedNot !== undefined) return satisfiesConstraint(value, example.expectedNot, 'not');
  if (example.expectedAny !== undefined) return satisfiesConstraint(value, example.expectedAny, 'any');
  return undefined;
}
/** What a caller does with an answer Jev did not settle, for the sites whose caller does something other than ask the original path
 *  (J4: no notice). J2 asked for the safe default intent until 2026-10-10 (`JEV_J2_BEFORE`) and asks the original classifier now. */
const DEFAULTS = { J4: { leakage: false } };
const JEV_J2_BEFORE = { switch_to: null, has_request: true, continues_running_task: false };
function comparableValue(site, value, input) {
  if (site !== 'J2' || !value) return value;
  const verified = verifiedIntent(value, { projectIds: input.projects.map(p => p.id), currentProjectId: input.currentProjectId, running: Boolean(input.currentTask) });
  return verified ? { switch_to: verified.switchTo, has_request: verified.hasRequest, continues_running_task: verified.continuesRunningTask } : null;
}

try {
  for (const site of sites) {
    let corpus;
    try { corpus = JSON.parse(await fs.readFile(path.join(root, 'evals/judge-sites', site, 'cases.json'), 'utf8')); }
    catch { report.sites[site] = { cases: 0, status: 'missing-corpus' }; continue; }
    const rows = [];
    let supplemental = [];
    try { supplemental = JSON.parse(await fs.readFile(path.join(root, 'evals/judge-sites', site, 'supplemental.json'), 'utf8')); } catch { /* Optional independent controls. */ }
    const cases = [...corpus.cases, ...supplemental].slice(0, Number(option('--limit', '100000')));
    const evaluate = async example => {
      const done = resume ? previous.find(item => item.site === site && item.id === example.id && item.outcome !== 'invalid') : null;
      if (done) { rows.push(done); report.rows.push(done); return; }
      const input = { ...example.input, ...(site === 'J3' ? { capabilities: catalog } : {}) };
      const row = { site, id: example.id, tag: example.tag, source: example.source, labelBasis: example.labelBasis,
        releaseEligible: example.releaseEligible !== false, group: example.group ?? example.id,
        inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
      try {
        buildJudgeRequest(site, input);
        if (live) {
          const started = Date.now();
          const decision = await judge.judge(site, input, { userId: 'judge-calibration', projectId: 'judge-calibration' });
          Object.assign(row, { outcome: decision.outcome, code: decision.code, ms: Date.now() - started,
            cost: decision.cost, confidence: decision.confidence, promptFingerprint: decision.promptFingerprint, ...(decision.cause ? { cause: decision.cause } : {}) });
          if (decision.answers) {
            const decoded = decodeJudgeAnswers(site, input, decision.answers, { threshold: 0, model: config.reviewJevModel });
            row.rawValue = comparableValue(site, decoded.value, input);
            row.value = comparableValue(site, decision.value, input);
            row.confidence = decoded.confidence;
            row.decisions = decoded.decisions;
            if (example.expected?.methodsReportingAnnotations) row.unscoredReason = 'Methods reporting annotations do not establish a complete CONSORT criterion pass.';
            else if (labelCorrect(example, row.rawValue) !== undefined) row.correct = labelCorrect(example, row.rawValue);
            else if (example.acceptableIds) {
              const best = [...(decoded.value.candidates ?? [])].sort((a, b) => b.relevance - a.relevance)[0];
              row.correct = example.acceptableIds.includes(best?.id);
            }
            row.falseSpecialist = site === 'J3' && example.expected?.agentId === 'none' && decision.value?.agentId && decision.value.agentId !== 'none';
          }
          if (site === 'J3') {
            const recorded = baselineReplay?.rows.find(item => item.site === site && item.id === example.id);
            if (recorded?.baseline) {
              if (recorded.inputSha256 !== row.inputSha256) throw new Error('baseline_input_mismatch');
              row.baseline = { ...recorded.baseline, source: 'recorded-live-baseline' };
            }
            else if (baseline) {
              const trace = {};
              const arm = await meter.measure(() => baseline.classify(input.question, catalog, trace, { userId: 'judge-calibration', projectId: 'judge-calibration' }));
              row.baseline = { agentId: arm.result?.agentId ?? (trace.verdict === 'none' ? 'none' : null), failure: trace.failure ?? null };
              row.incumbent = { value: { agentId: row.baseline.agentId }, ms: arm.ms, cost: arm.cost, billedCny: arm.billedCny, failure: row.baseline.failure };
            }
            row.finalRoute = await routeRecordedDecision(input.question, catalog, decision, row.baseline);
            row.baselineFinalRoute = row.baseline ? await routeRecordedDecision(input.question, catalog, null, row.baseline) : null;
            row.falseSpecialist = example.expected?.agentId === 'none' && row.finalRoute.agentId !== 'none';
            row.baselineFalseSpecialist = example.expected?.agentId === 'none' && row.baselineFinalRoute?.agentId !== 'none';
            row.finalCorrect = row.finalRoute.agentId === example.expected?.agentId;
            // What the researcher gets is the final route, regex net included: that is what both arms are scored on.
            row.hybridCorrect = row.finalCorrect;
            if (row.incumbent && row.baselineFinalRoute) row.incumbent.correct = row.baselineFinalRoute.agentId === example.expected?.agentId;
          } else if (incumbents[site]) {
            try {
              const arm = await incumbents[site](example);
              row.incumbent = { value: arm.value, ms: arm.ms, cost: arm.cost, billedCny: arm.billedCny, failure: arm.failure,
                correct: labelCorrect(example, comparableValue(site, arm.value, input)) };
              if (site === 'J2' && !arm.failure && row.rawValue) row.baselineAgreement = includesExpected(row.rawValue, arm.value);
            } catch (error) { row.incumbent = { failure: /^[a-z_]+$/.test(error.message) ? error.message : 'incumbent_failed' }; }
          }
          // The site with Jev on: Jev where it settled; elsewhere what its caller does (a fixed default for J2 and J4), else the original path.
          if (site !== 'J3') {
            if (Object.hasOwn(DEFAULTS, site)) row.hybridCorrect = row.outcome === 'settled' ? row.correct : labelCorrect(example, DEFAULTS[site]);
            else if (row.incumbent) row.hybridCorrect = row.outcome === 'settled' ? row.correct : row.incumbent.correct;
            // What J2 did before it handed unsettled messages on, scored beside what it does now.
            if (site === 'J2') row.hybridBeforeCorrect = row.outcome === 'settled' ? row.correct : labelCorrect(example, JEV_J2_BEFORE);
          }
        } else row.outcome = 'validated-input';
      } catch (error) { row.outcome = 'invalid'; row.code = /^[a-z_]+$/.test(error.message) ? error.message : 'eval_case_failed'; }
      rows.push(row); report.rows.push(row);
      if (live) {
        await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        process.stdout.write(`${site} ${rows.length}/${cases.length} ${row.outcome}\n`);
      }
    };
    const concurrency = Math.max(1, Math.min(4, Number(option('--concurrency', '1')) || 1));
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < cases.length) await evaluate(cases[next++]);
    }));
    const measured = rows.filter(row => typeof row.correct === 'boolean');
    const settled = measured.filter(row => row.outcome === 'settled');
    const correct = settled.filter(row => row.correct).length;
    const calibration = measured.filter(row => row.releaseEligible);
    report.sites[site] = { cases: rows.length, measured: measured.length, settled: settled.length, correct,
      lower95: lowerConfidenceBound(correct, settled.length), agreement: settled.length ? correct / settled.length : null,
      falseSpecialists: rows.filter(row => row.falseSpecialist).length,
      baselineFalseSpecialists: rows.filter(row => row.baselineFalseSpecialist).length,
      titleToPaperFalseSpecialists: rows.filter(row => row.tag === 'title-to-paper' && row.falseSpecialist).length,
      recommendation: recommendThreshold(calibration), independentGroups: new Set(calibration.map(row => row.group)).size,
      finalCorrect: rows.filter(row => row.finalCorrect).length,
      baselineAgreement: settled.filter(row => typeof row.baselineAgreement === 'boolean').length
        ? settled.filter(row => row.baselineAgreement).length / settled.filter(row => typeof row.baselineAgreement === 'boolean').length : null,
      missingReleaseEvidence: [...(calibration.length < 100 ? ['approximately-100-labelled-examples'] : [])],
      ...(incumbentOn && live ? { benefit: summarizeSite(rows) } : {}),
      status: live ? 'measured-not-release-certified' : 'validated-not-measured' };
  }
} finally { await judge.close(); }
if (incumbentOn) report.incumbentMeter = { ...meter.totals };
if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ ...report, rows: undefined }, null, 2) + '\n');
