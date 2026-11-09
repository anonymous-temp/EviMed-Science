#!/usr/bin/env node
/**
 * Structure-only intake of the public general-memory corpora pinned in
 * sources.json (`public`): builds every runtime input and gold record with the
 * adapters, never calls a model, registers development/confirmation pools and
 * writes results/intake-<date>.json. Denominators are never reduced: a source
 * row an adapter refuses is a failure with its reason, still in its pool.
 *
 *   node evals/capsule-proving/intake.mjs --data DIR [--only locomo,...] [--date 20261109]
 *
 * DIR is the --out of fetch-public.mjs. Pinned files are re-hashed before reading.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  haluMemGold, haluMemRuntimeInput, locomoGold, locomoRuntimeInput, memSycoGold, memSycoRuntimeInput,
  personaMemGold, personaMemRuntimeInput, realMemGold, realMemQueryRefs, realMemRuntimeInput,
  registerQuestionPools, sourceSetSha256, validateFrozenPools,
} from './inputs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 'capsule-proving-20261109-v1';
const RUNTIME_KEYS = new Set(['schema', 'benchmark', 'id', 'question', 'histories', 'roleMapping', 'conversationKey', 'protocol', 'structure', 'harnessMeta']);

const args = Object.fromEntries(process.argv.slice(2).reduce((out, arg, i, all) => (arg.startsWith('--') ? [...out, [arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]] : out), []));
const data = resolve(args.data ?? '');
const date = args.date ?? '20261109';
if (!args.data) { console.error('usage: intake.mjs --data DIR [--only set,set] [--date YYYYMMDD]'); process.exit(2); }
const sourcesBytes = readFileSync(join(HERE, 'sources.json'));
const sources = JSON.parse(sourcesBytes).public;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileCache = new Map();

function pinned(setKey, path) {
  const entry = sources[setKey].files.find(file => file.path === path);
  if (!entry) throw new Error(`${setKey}/${path} is not pinned`);
  const full = join(data, setKey, path);
  if (!existsSync(full)) throw new Error(`missing ${full}; run fetch-public.mjs first`);
  const bytes = readFileSync(full);
  if (sha(bytes) !== entry.sha256) throw new Error(`${setKey}/${path} does not match its pinned sha256`);
  return bytes;
}
const pinnedJson = (setKey, path) => JSON.parse(pinned(setKey, path).toString('utf8'));
const filesOf = (setKey, test) => sources[setKey].files.filter(file => test(file.path)).map(({ path, sha256 }) => ({ path, sha256 }));

function csvRows(textValue) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < textValue.length; i += 1) {
    const c = textValue[i];
    if (quoted) {
      if (c === '"') { if (textValue[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  return body.map(values => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])));
}

function tally(failures) {
  const reasons = {};
  for (const failure of failures) reasons[failure.reason] = (reasons[failure.reason] ?? 0) + 1;
  return { failureReasons: reasons, failures: failures.slice(0, 20) };
}

function leakCheck(input) {
  const extra = Object.keys(input).filter(key => !RUNTIME_KEYS.has(key));
  if (extra.length) throw new Error(`runtime input carries unexpected keys: ${extra.join(',')}`);
}

/** units: [{ id, contextIds, build: () => ({ input, gold }) }]; failures keep their pool row. */
function finish(setKey, benchmark, units, filesForPool, extra) {
  const failures = []; let validated = 0; let emptyOriginalText = 0; let messages = 0;
  for (const unit of units) {
    try {
      const { input, gold } = unit.build();
      leakCheck(input);
      if (gold.id !== input.id) throw new Error('gold and input identities differ');
      for (const history of input.histories) for (const message of history.messages) { messages += 1; if (!message.text) emptyOriginalText += 1; }
      validated += 1;
    } catch (error) { failures.push({ id: unit.id, reason: error.message }); }
  }
  const developmentCount = Math.min(120, Math.max(1, Math.round(units.length * 0.2)));
  const pools = registerQuestionPools(units.map(unit => ({ question_id: unit.id, haystack_session_ids: unit.contextIds })),
    { seed: SEED, developmentCount, sourceSha256: sourceSetSha256(filesForPool), benchmark });
  if (!validateFrozenPools(pools).ok) throw new Error(`${setKey}: pools failed their own integrity check`);
  mkdirSync(join(HERE, 'pools'), { recursive: true });
  const poolFile = `pools/${setKey}-${date}.json`;
  writeFileSync(join(HERE, poolFile), `${JSON.stringify(pools, null, 2)}\n`);
  return {
    benchmark, validated, failed: failures.length, ...tally(failures), denominator: units.length, denominatorMayBeReduced: false,
    messagesAcrossInputs: messages, emptyTextMessagesAcrossInputs: emptyOriginalText, development: pools.pools.development.length, confirmation: pools.pools.confirmation.length,
    sourceOverlap: pools.sourceOverlap, poolFile, poolDigest: pools.digest, ...extra,
  };
}

const intakes = {
  locomo() { return locomoLike('locomo', 'locomo', 'data/locomo10.json', 'locomo'); },
  'locomo-refined'() { return locomoLike('locomo-refined', 'locomo-refined', 'data/raw/locomo_refined.json', 'locomo-refined'); },
  halumem() {
    const path = 'HaluMem-Medium.jsonl';
    const users = pinned('halumem', path).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const units = [];
    let sessions = 0;
    for (const user of users) {
      sessions += user.sessions.length;
      user.sessions.forEach((session, s) => (session.questions ?? []).forEach((_q, q) => units.push({
        id: `${user.uuid}:s${s}:q${q}`, contextIds: user.sessions.slice(0, s + 1).map((_x, i) => `${user.uuid}/session_${i}`),
        build: () => ({ input: haluMemRuntimeInput(user, s, q), gold: haluMemGold(user, s, q) }),
      })));
    }
    return finish('halumem', 'halumem-medium', units, filesOf('halumem', p => p === path), { users: users.length, sessions });
  },
  realmem() {
    const paths = sources.realmem.files.map(file => file.path).filter(path => path.startsWith('dataset/') && path.endsWith('.json'));
    const units = []; const typeCounts = {}; let sessions = 0;
    for (const path of paths) {
      const persona = pinnedJson('realmem', path);
      sessions += persona.dialogues.length;
      for (const dialogue of persona.dialogues) for (const turn of dialogue.dialogue_turns) { const key = `${typeof turn.is_query}:${turn.is_query}`; typeCounts[key] = (typeCounts[key] ?? 0) + 1; }
      for (const ref of realMemQueryRefs(persona)) {
        const turn = persona.dialogues[ref.sessionIndex].dialogue_turns[ref.turnIndex];
        units.push({
          id: `${persona._metadata.person_name}:${turn.query_id}`,
          contextIds: persona.dialogues.slice(0, ref.sessionIndex).map(item => `${persona._metadata.person_name}/${item.session_uuid}`),
          build: () => ({ input: realMemRuntimeInput(persona, ref), gold: realMemGold(persona, ref) }),
        });
      }
    }
    return finish('realmem', 'realmem', units, filesOf('realmem', p => p.endsWith('.json')), { personas: paths.length, sessions, isQueryValueCounts: typeCounts });
  },
  'personamem-v2'() {
    const set = 'personamem-v2';
    const rows = csvRows(pinned(set, 'benchmark/text/benchmark.csv').toString('utf8'));
    const byPersona = new Map();
    for (const file of sources[set].files) {
      const match = /^data\/chat_history_32k\/.*persona(\d+)\.json$/.exec(file.path);
      if (match) byPersona.set(match[1], [...(byPersona.get(match[1]) ?? []), file.path]);
    }
    const staleLinks = new Set(); const histories = new Map(); let malformedMessages = 0;
    const historyOf = row => {
      const exact = row.chat_history_32k_link;
      const candidates = byPersona.get(row.persona_id) ?? [];
      const path = candidates.includes(exact) ? exact : candidates.length === 1 ? candidates[0] : null;
      if (!path) throw new Error(candidates.length ? 'ambiguous chat history files for the persona' : 'no chat history file for the persona');
      if (path !== exact) staleLinks.add(row.persona_id);
      if (!histories.has(path)) {
        const history = pinnedJson(set, path);
        if (String(history.metadata?.persona_id) !== row.persona_id) throw new Error('chat history persona does not match the benchmark row');
        malformedMessages += history.chat_history.filter(message => Object.keys(message).some(key => key !== 'role' && key !== 'content') || !Object.hasOwn(message, 'content')).length;
        histories.set(path, history);
      }
      return histories.get(path);
    };
    const units = rows.map((row, index) => ({
      id: `persona${row.persona_id}:q${index}`, contextIds: [`persona${row.persona_id}/persona${row.persona_id}`],
      build: () => { const history = historyOf(row); return { input: personaMemRuntimeInput(row, history, { index }), gold: personaMemGold(row, history, { index }) }; },
    }));
    const result = finish(set, 'personamem-v2-32k', units, filesOf(set, p => p === 'benchmark/text/benchmark.csv' || p.startsWith('data/chat_history_32k/')),
      { personas: new Set(rows.map(row => row.persona_id)).size });
    return { ...result, personasWithStaleLink: staleLinks.size, historyFilesRead: histories.size, malformedHistoryMessages: malformedMessages,
      note: 'benchmark.csv links name chat_history_250913_163134_* files; the pinned repository holds chat_history_250911_213118_* for the same personas, so the history is resolved by persona id and checked against its metadata' };
  },
  memsyco() {
    const set = 'memsyco';
    const manifest = pinnedJson(set, 'data/manifest.json');
    const units = []; const tasks = {};
    for (const [task, info] of Object.entries(manifest.tasks)) {
      const lines = pinned(set, `data/${info.file}`).toString('utf8').split('\n').filter(Boolean);
      tasks[task] = lines.length;
      if (lines.length !== info.samples) throw new Error(`${task}: manifest says ${info.samples} samples, file has ${lines.length}`);
      for (const line of lines) {
        const row = JSON.parse(line);
        units.push({ id: row.id, contextIds: [`${row.id}/${row.id}`], build: () => ({ input: memSycoRuntimeInput(row), gold: memSycoGold(row) }) });
      }
    }
    return finish(set, 'memsyco-bench', units, filesOf(set, p => p.startsWith('data/')), { tasks });
  },
};

function locomoLike(setKey, benchmark, path, label) {
  const samples = pinnedJson(setKey, path);
  const units = []; const categories = {}; let withoutAnswer = 0;
  for (const sample of samples) {
    const contextIds = Object.keys(sample.conversation).filter(key => /^session_\d+$/.test(key)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))).map(key => `${sample.sample_id}/${key}`);
    sample.qa.forEach((qa, qaIndex) => {
      categories[qa.category] = (categories[qa.category] ?? 0) + 1;
      if (qa.answer == null) withoutAnswer += 1;
      units.push({ id: `${sample.sample_id}:q${qaIndex}`, contextIds, build: () => ({ input: locomoRuntimeInput(sample, qaIndex, { benchmark }), gold: locomoGold(sample, qaIndex, { benchmark }) }) });
    });
  }
  const extra = { conversations: samples.length, categories, questionsWithoutAnswer: withoutAnswer };
  if (setKey === 'locomo-refined') {
    // Cross-check the raw file against the published per-question table: same text at the same index.
    const rows = pinned(setKey, 'data/public/questions.jsonl').toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const bySample = new Map(samples.map(sample => [sample.sample_id, sample]));
    extra.questionsJsonlRows = rows.length;
    extra.questionsJsonlAgreeWithRaw = rows.filter(row => bySample.get(row.sample_id)?.qa[row.qa_index]?.question === row.question).length;
  }
  return finish(setKey, benchmark, units, filesOf(setKey, p => p === path), extra);
}

const wanted = (args.only ?? Object.keys(intakes).join(',')).split(',');
const result = {};
for (const key of wanted) {
  if (!intakes[key]) throw new Error(`unknown set ${key}`);
  result[key] = intakes[key]();
  console.log(key, result[key].validated, '/', result[key].denominator, 'failed', result[key].failed);
}
let revision = 'unknown';
try { revision = execFileSync('git', ['-C', HERE, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
const output = {
  adapterRevision: revision, adapterUncommitted: true, schema: 'capsule-proving-intake/1', kind: 'structure-only', modelCalls: 0,
  productAccuracyMeasured: false, extends: 'results/intake-20261105.json', seed: SEED, sourceManifestSha256: sha(sourcesBytes), ...result,
};
if (!args.only) writeFileSync(join(HERE, `results/intake-${date}.json`), `${JSON.stringify(output, null, 2)}\n`);
