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
import { ChannelIntentClassifier, verifiedIntent } from '../../apps/server/src/channels/intent.mjs';
import { lowerConfidenceBound, recommendThreshold } from './statistics.mjs';
import { routeRecordedDecision } from './routing-evaluation.mjs';

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
const baseline = option('--baseline') === 'flash' ? new SpecialistClassifier({ ...config, llmRoutingEnabled: true }) : null;
const intentBaseline = baseline ? new ChannelIntentClassifier(config) : null;
const baselineReplayFile = option('--baseline-replay');
const baselineReplay = baselineReplayFile ? JSON.parse(await fs.readFile(baselineReplayFile, 'utf8')) : null;
if (baselineReplay && baselineReplay.catalogDigest !== catalogDigest) throw new Error('Baseline catalog differs from the live catalog');
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
            cost: decision.cost, confidence: decision.confidence, promptFingerprint: decision.promptFingerprint });
          if (decision.answers) {
            const decoded = decodeJudgeAnswers(site, input, decision.answers, { threshold: 0, model: config.reviewJevModel });
            row.rawValue = comparableValue(site, decoded.value, input);
            row.value = comparableValue(site, decision.value, input);
            row.confidence = decoded.confidence;
            row.decisions = decoded.decisions;
            if (example.expected?.methodsReportingAnnotations) row.unscoredReason = 'Methods reporting annotations do not establish a complete CONSORT criterion pass.';
            else if (example.expected !== undefined) row.correct = includesExpected(row.rawValue, example.expected);
            else if (example.expectedPartial !== undefined) row.correct = includesExpected(row.rawValue, example.expectedPartial);
            else if (example.expectedNot !== undefined) row.correct = satisfiesConstraint(row.rawValue, example.expectedNot, 'not');
            else if (example.expectedAny !== undefined) row.correct = satisfiesConstraint(row.rawValue, example.expectedAny, 'any');
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
              const old = await baseline.classify(input.question, catalog, trace, { userId: 'judge-calibration', projectId: 'judge-calibration' });
              row.baseline = { agentId: old?.agentId ?? (trace.verdict === 'none' ? 'none' : null), failure: trace.failure ?? null };
            }
            row.finalRoute = await routeRecordedDecision(input.question, catalog, decision, row.baseline);
            row.baselineFinalRoute = row.baseline ? await routeRecordedDecision(input.question, catalog, null, row.baseline) : null;
            row.falseSpecialist = example.expected?.agentId === 'none' && row.finalRoute.agentId !== 'none';
            row.baselineFalseSpecialist = example.expected?.agentId === 'none' && row.baselineFinalRoute?.agentId !== 'none';
            row.finalCorrect = row.finalRoute.agentId === example.expected?.agentId;
          }
          if (site === 'J2' && intentBaseline) {
            const old = await intentBaseline.classifyWithModel({ userId: 'judge-calibration', projectId: input.currentProjectId,
              text: input.message, projects: input.projects, runningTask: input.currentTask ? { question: input.currentTask } : null });
            row.baseline = { switch_to: old.switchTo, has_request: old.hasRequest, continues_running_task: old.continuesRunningTask,
              failure: old.source === 'model' ? null : old.reason ?? 'baseline_unavailable' };
            row.baselineCorrect = !row.baseline.failure && includesExpected(row.baseline, example.expected);
            row.baselineAgreement = !row.baseline.failure && includesExpected(row.rawValue, {
              switch_to: old.switchTo, has_request: old.hasRequest, continues_running_task: old.continuesRunningTask });
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
      status: live ? 'measured-not-release-certified' : 'validated-not-measured' };
  }
} finally { await judge.close(); }
if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ ...report, rows: undefined }, null, 2) + '\n');
