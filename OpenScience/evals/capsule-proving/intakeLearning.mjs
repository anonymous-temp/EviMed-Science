#!/usr/bin/env node
/**
 * Structure-only intake of the sets added on 2026-11-09 (adapters in inputsLearning.mjs): the MedMemoryBench Hugging Face
 * version, MedLoCoMo, the brand/generic probe and the WildChat pseudo-users. No model call. Registers pools with the same
 * seed as intake.mjs and writes results/intake-learning-pools-<date>.json (merged into results/intake-learning-<date>.json
 * by pools/tools/learning_counts.py).
 *
 *   node evals/capsule-proving/intakeLearning.mjs --data DIR [--only medmemorybench-hf,...] [--date 20261109]
 *
 * DIR is the --out of fetch-public.mjs. Derived JSONL files (pools/tools/parquet_to_jsonl.py) carry the digest of the pinned
 * file they came from in their first line and are refused when it differs from sources.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@evimed/domain';
import { registerQuestionPools, sourceSetSha256, validateFrozenPools } from './inputs.mjs';
import { brandGenericGold, brandGenericRuntimeInput, buildBrandGenericItems, medLoCoMoGold, medLoCoMoRuntimeInput, medMemoryHfGold, medMemoryHfKey, medMemoryHfRuntimeInput, rabbitsPairs, templateOk,
  wildChatPseudoUserRuntimeInput } from './inputsLearning.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 'capsule-proving-20261109-v1';
const args = Object.fromEntries(process.argv.slice(2).reduce((out, arg, i, all) => (arg.startsWith('--') ? [...out, [arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]] : out), []));
if (!args.data) { console.error('usage: intakeLearning.mjs --data DIR [--only set,set] [--date YYYYMMDD]'); process.exit(2); }
const data = resolve(args.data);
const date = args.date ?? '20261109';
const sources = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const RUNTIME_KEYS = new Set(['schema', 'benchmark', 'id', 'question', 'histories', 'roleMapping', 'conversationKey', 'protocol', 'structure', 'harnessMeta']);

function jsonl(path, expectedSha256) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  if (header.sha256 !== expectedSha256) throw new Error(`${path} was derived from a file that is not the pinned one`);
  return lines.slice(1).map(line => JSON.parse(line));
}
const pinnedEntry = (setKey, path) => {
  const entry = sources.public[setKey].files.find(file => file.path === path);
  if (!entry) throw new Error(`${setKey}/${path} is not pinned`);
  return entry;
};
const learningFile = (setKey, path) => {
  const entry = sources.learning?.[setKey]?.files.find(file => file.path === path);
  if (!entry) throw new Error(`${setKey}/${path} is not pinned`);
  const bytes = readFileSync(join(data, setKey, path));
  if (sha(bytes) !== entry.sha256) throw new Error(`${setKey}/${path} does not match its pinned sha256`);
  return { entry, bytes };
};
function writePool(name, rows, { benchmark, filesForDigest, developmentCount = 120 }) {
  const pools = registerQuestionPools(rows, { seed: SEED, developmentCount, sourceSha256: sourceSetSha256(filesForDigest), benchmark });
  if (!validateFrozenPools(pools).ok) throw new Error(`${name}: pools failed their own integrity check`);
  mkdirSync(join(HERE, 'pools'), { recursive: true });
  writeFileSync(join(HERE, `pools/${name}-${date}.json`), `${JSON.stringify(pools, null, 2)}\n`);
  return { poolFile: `pools/${name}-${date}.json`, poolDigest: pools.digest, development: pools.pools.development.length, confirmation: pools.pools.confirmation.length, sourceOverlap: pools.sourceOverlap };
}
function leakCheck(input) {
  const extra = Object.keys(input).filter(key => !RUNTIME_KEYS.has(key));
  if (extra.length) throw new Error(`runtime input carries unexpected keys: ${extra.join(',')}`);
}

const intakes = {
  'medmemorybench-hf'() {
    const set = 'medmemorybench-hf';
    const queries = {};
    for (const language of ['zh', 'en']) {
      const path = `data/${language}/queries.parquet`;
      queries[language] = jsonl(join(data, set, 'derived', `queries.${language}.jsonl`), pinnedEntry(set, path).sha256);
    }
    const keys = { zh: queries.zh.map(medMemoryHfKey), en: queries.en.map(medMemoryHfKey) };
    for (const language of ['zh', 'en']) if (new Set(keys[language]).size !== keys[language].length) throw new Error(`${language}: duplicate (persona, query) keys`);
    const enSet = new Set(keys.en);
    const parity = { onlyZh: keys.zh.filter(key => !enSet.has(key)).length, onlyEn: keys.en.filter(key => !new Set(keys.zh).has(key)).length };
    // Runtime inputs are built for every zh question from the pinned zh dialogues (en dialogues are 386 MB and not fetched by default).
    const dialoguePath = join(data, set, 'derived', 'dialogues.zh.jsonl');
    let built = 0; const failures = [];
    if (existsSync(dialoguePath)) {
      const rows = jsonl(dialoguePath, pinnedEntry(set, 'data/zh/dialogues.parquet').sha256);
      const byPersona = new Map();
      for (const row of rows) byPersona.set(row.persona_id, [...(byPersona.get(row.persona_id) ?? []), row]);
      for (const query of queries.zh) {
        try {
          const input = medMemoryHfRuntimeInput(byPersona.get(query.persona_id) ?? [], query, { language: 'zh' });
          leakCheck(input);
          if (medMemoryHfGold(query, { language: 'zh' }).id !== input.id) throw new Error('gold and input identities differ');
          if (JSON.stringify(input).includes('knowledge_points')) throw new Error('input names knowledge_points');
          built += 1;
        } catch (error) { failures.push({ id: medMemoryHfKey(query), reason: error.message }); }
      }
    }
    for (const language of ['zh', 'en']) for (const query of queries[language]) medMemoryHfGold(query, { language });
    // One frozen split for both languages: the key is language-neutral, so zh and en share development and confirmation questions.
    const poolRows = queries.zh.map(query => ({ question_id: medMemoryHfKey(query),
      haystack_session_ids: Array.from({ length: query.session_id }, (_x, i) => `persona_${query.persona_id}/session_${i + 1}`) }));
    const files = ['data/zh/queries.parquet', 'data/en/queries.parquet'].map(path => ({ path, sha256: pinnedEntry(set, path).sha256 }));
    const pool = writePool('medmemorybench-hf', poolRows, { benchmark: 'medmemorybench-hf', filesForDigest: files });
    const byType = {}; for (const query of queries.zh) byType[query.query_type] = (byType[query.query_type] ?? 0) + 1;
    return { benchmark: 'medmemorybench-hf', denominator: poolRows.length, languages: { zh: queries.zh.length, en: queries.en.length }, keyParity: parity,
      zhRuntimeInputsBuilt: built, zhRuntimeInputFailures: failures.length, failures: failures.slice(0, 20), queryTypes: byType,
      emptyQuestions: [...queries.zh, ...queries.en].filter(query => !query.question.trim()).length, ...pool,
      note: 'ids are language-neutral (persona_N:query_id); the runtime id is "<lang>:<id>". Pool context ids are persona_N/session_1..anchor (sessions 1-101 per persona, read from the zh dialogues). The en dialogues (386 MB) are large-only; the en inputs are built the same way from them.' };
  },
  medlocomo() {
    const set = 'medlocomo';
    const patients = sources.learning[set].files.map(file => /^MedLoCoMo\/([^/]+)\/combined_conversation\.json$/.exec(file.path)?.[1]).filter(Boolean).sort();
    const units = []; const byType = {}; const byScope = {}; let messages = 0; const failures = []; let admissions = 0;
    const seen = new Set();
    for (const subject of patients) {
      const base = `MedLoCoMo/${subject}`;
      const patient = JSON.parse(learningFile(set, `${base}/combined_conversation.json`).bytes.toString('utf8'));
      const qas = JSON.parse(learningFile(set, `${base}/benchmark_qa.json`).bytes.toString('utf8')).qas;
      const cross = JSON.parse(learningFile(set, `${base}/cross_admission_qa.json`).bytes.toString('utf8')).qas;
      learningFile(set, `${base}/patient_summary.json`);
      const benchmarkIds = new Set(qas.map(qa => qa.qa_id));
      const crossOutside = cross.filter(qa => !benchmarkIds.has(qa.qa_id)).length;
      if (crossOutside) throw new Error(`${subject}: cross_admission_qa holds ${crossOutside} questions that benchmark_qa lacks`);
      admissions += patient.admissions.length;
      const contextIds = patient.admissions.map(admission => `${subject}/${admission.hadm_id}`);
      for (const qa of qas) {
        if (seen.has(qa.qa_id)) throw new Error(`duplicate qa id ${qa.qa_id}`);
        seen.add(qa.qa_id);
        byType[qa.question_type] = (byType[qa.question_type] ?? 0) + 1; byScope[qa.scope] = (byScope[qa.scope] ?? 0) + 1;
        units.push({ id: qa.qa_id, contextIds, build: () => ({ input: medLoCoMoRuntimeInput(patient, qa), gold: medLoCoMoGold(qa) }) });
      }
    }
    for (const unit of units) {
      try {
        const { input, gold } = unit.build(); leakCheck(input);
        if (gold.id !== input.id) throw new Error('gold and input identities differ');
        for (const history of input.histories) messages += history.messages.length;
      } catch (error) { failures.push({ id: unit.id, reason: error.message }); }
    }
    // The pool is a seeded sample of 600 of the universe (hash ranking, same rule as the pools): a control for abstention, not a full run.
    const ranked = units.map(unit => ({ unit, rank: sha(`${SEED}|sample|${unit.id}`) })).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)).slice(0, 600).map(item => item.unit);
    const adversarialInSample = ranked.filter(unit => unit.build().gold.adversarial).length;
    const files = sources.learning[set].files.filter(file => /\/(combined_conversation|benchmark_qa|cross_admission_qa)\.json$/.test(file.path)).map(({ path, sha256 }) => ({ path, sha256 }));
    const pool = writePool('medlocomo', ranked.map(unit => ({ question_id: unit.id, haystack_session_ids: unit.contextIds })), { benchmark: 'medlocomo', filesForDigest: files });
    return { benchmark: 'medlocomo', patients: patients.length, admissions, universe: units.length, byScope, byType, adversarial: byType.adversarial ?? 0, validated: units.length - failures.length, failed: failures.length,
      failures: failures.slice(0, 20), messagesAcrossInputs: messages, sampleSize: ranked.length, adversarialInSample, ...pool,
      note: 'benchmark_qa.json holds every question; cross_admission_qa.json is its cross-admission half (checked). No license is declared in the repository; derived from MIMIC-IV, local use only.' };
  },
  'l9-long-tasks'() {
    const set = 'researchclawbench';
    const ids = sources.learning[set].files.map(file => /^tasks\/([^/]+)\/task_info\.json$/.exec(file.path)?.[1]).filter(Boolean).sort();
    const rows = ids.map(id => {
      const info = JSON.parse(learningFile(set, `tasks/${id}/task_info.json`).bytes.toString('utf8'));
      const checklist = JSON.parse(learningFile(set, `tasks/${id}/target_study/checklist.json`).bytes.toString('utf8'));
      return { id, domain: id.replace(/_\d+$/, ''), checklistItems: checklist.length, checklistWeightSum: Number(checklist.reduce((sum, item) => sum + (item.weight ?? 0), 0).toFixed(6)),
        dataFiles: info.data.length, taskChars: info.task.length, tiebreak: sha(`${SEED}|l9|${id}`) };
    });
    // Length signal: the rubric's size (the number of expected deliverables, each a figure or a numeric result the run has to produce), then the number of input
    // data files named in task_info, then a seeded hash. Nothing in the data records wall-clock time or step counts.
    const ranked = [...rows].sort((a, b) => b.checklistItems - a.checklistItems || b.dataFiles - a.dataFiles || (a.tiebreak < b.tiebreak ? -1 : 1));
    const selected = ranked.slice(0, 10);
    const files = sources.learning[set].files.filter(file => /\/(task_info|checklist)\.json$/.test(file.path)).map(({ path, sha256 }) => ({ path, sha256 }));
    const document = { schema: 'capsule-proving-l9-selection/1', benchmark: 'researchclawbench', seed: SEED, universe: rows.length, selected: selected.map(({ tiebreak: _t, ...row }) => row).map(row => row.id),
      signal: 'checklistItems desc, then dataFiles desc, then sha256(seed|l9|id); only information in the pinned task_info.json and checklist.json is used',
      sourceSha256: sourceSetSha256(files), rows: selected.map(({ tiebreak: _t, ...row }) => row) };
    const digest = sha(canonicalJson(document));
    mkdirSync(join(HERE, 'pools'), { recursive: true });
    writeFileSync(join(HERE, `pools/l9-long-tasks-${date}.json`), `${JSON.stringify({ ...document, digest }, null, 2)}\n`);
    const items = {}; for (const row of rows) items[row.checklistItems] = (items[row.checklistItems] ?? 0) + 1;
    return { benchmark: 'researchclawbench', denominator: rows.length, selected: document.selected, checklistItemDistribution: items, poolFile: `pools/l9-long-tasks-${date}.json`, poolDigest: digest,
      note: 'the README says 40 tasks (plus 10 ResearchClawBench-Self ones); the pinned revision holds more task folders than that, counted from the data' };
  },
  'wildchat-pseudo-users'() {
    const dir = join(data, 'wildchat-pseudo-users');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const bytes = readFileSync(join(dir, 'sample.jsonl'));
    if (sha(bytes) !== manifest.sampleSha256) throw new Error('sample.jsonl does not match its manifest');
    const users = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    let conversations = 0; let messages = 0; let emptyText = 0;
    for (const user of users) {
      const input = wildChatPseudoUserRuntimeInput(user); leakCheck(input);
      conversations += input.histories.length;
      for (const history of input.histories) for (const message of history.messages) { messages += 1; if (!message.text) emptyText += 1; }
    }
    return { benchmark: 'wildchat-pseudo-users', users: users.length, conversations, messages, emptyTextMessages: emptyText, sampleSha256: manifest.sampleSha256, counts: manifest.counts, sample: manifest.sample,
      note: 'pseudo-users (hashed IP + header), not people; no gold; real user text, local only' };
  },
  'brand-generic-probe'() {
    const { bytes } = learningFile('rabbits', 'data/generic_to_brand.csv');
    const dir = join(data, 'brand-generic-probe');
    const templates = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf8'));
    if (![...templates.statements, ...templates.questions].every(templateOk)) throw new Error('a template lost its single {drug} slot');
    const pairs = rabbitsPairs(bytes.toString('utf8'));
    const items = buildBrandGenericItems(pairs, templates, { seed: SEED });
    const inputs = items.map(item => { const input = brandGenericRuntimeInput(item); leakCheck(input); return input; });
    const golds = items.map(brandGenericGold);
    for (const [i, input] of inputs.entries()) {
      const flat = JSON.stringify(input).toLowerCase();
      if (flat.includes('"direction"') || flat.includes('accept')) throw new Error('input carries gold fields');
      if (golds[i].id !== input.id) throw new Error('gold and input identities differ');
    }
    writeFileSync(join(dir, 'inputs.jsonl'), `${inputs.map(input => JSON.stringify(input)).join('\n')}\n`);
    writeFileSync(join(dir, 'gold.jsonl'), `${golds.map(gold => JSON.stringify(gold)).join('\n')}\n`);
    const templatesSha = sha(readFileSync(join(dir, 'templates.json')));
    const developmentCount = Math.min(120, Math.max(1, Math.round(items.length * 0.2)));
    const pool = writePool('brand-generic-probe', items.map(item => ({ question_id: item.id, haystack_session_ids: [`${item.id}/${item.id}`] })), { benchmark: 'brand-generic-probe',
      filesForDigest: [{ path: 'rabbits/data/generic_to_brand.csv', sha256: sha(bytes) }, { path: 'templates.json', sha256: templatesSha }], developmentCount });
    const directions = {}; for (const item of items) directions[item.direction] = (directions[item.direction] ?? 0) + 1;
    const manifest = { schema: 'capsule-proving-brand-generic/1', seed: SEED, pairsFile: { set: 'rabbits', path: 'data/generic_to_brand.csv', sha256: sha(bytes) }, templatesSha256: templatesSha,
      templateGenerator: templates.generator, statements: templates.statements.length, questions: templates.questions.length, items: items.length, directions,
      inputsSha256: sha(readFileSync(join(dir, 'inputs.jsonl'))), goldSha256: sha(readFileSync(join(dir, 'gold.jsonl'))) };
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { benchmark: 'brand-generic-probe', denominator: items.length, pairsEligible: pairs.length, directions, statements: templates.statements.length, questions: templates.questions.length, ...pool,
      note: 'pass = reply names the stated name or its pair (the plan check); bridged = reply names the stated form although the question used the other one (the memory signal). Kimi wrote the templates and never saw a drug name or the gold.' };
  },
};

const wanted = (args.only ?? Object.keys(intakes).join(',')).split(',');
const result = {};
for (const key of wanted) {
  if (!intakes[key]) throw new Error(`unknown set ${key}`);
  result[key] = intakes[key]();
  console.log(key, JSON.stringify({ denominator: result[key].denominator, failed: result[key].zhRuntimeInputFailures ?? result[key].failed ?? 0 }));
}
const target = join(HERE, `results/intake-learning-pools-${date}.json`);
const previous = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
const sourcesBytes = readFileSync(join(HERE, 'sources.json'));
writeFileSync(target, `${JSON.stringify({ schema: 'capsule-proving-intake-learning-pools/1', modelCalls: 0, seed: SEED, ...previous, ...result }, null, 2)}\n`);
void sha; void sourcesBytes;
