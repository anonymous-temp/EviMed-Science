/** Pinned public readers. Only selected development questions enter either adapter; gold is opt-in for the scorer. */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { locomoRuntimeInput, locomoGold, haluMemRuntimeInput, haluMemGold,
  realMemRuntimeInput, realMemGold, realMemQueryRefs, memSycoRuntimeInput, memSycoGold, sourceSetSha256 } from '../inputs.mjs';

export const PUBLIC_MEMORY_SETS = ['locomo', 'locomo-original', 'realmem', 'halumem', 'memsyco'];
const sourceKey = set => set === 'locomo' ? 'locomo-refined' : set === 'locomo-original' ? 'locomo' : set;
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const sources = json(new URL('../sources.json', import.meta.url)).public;

/** Guard before any file access; confirmation is never an executable option in this lane. */
export function publicPool(set, split) {
  if (split !== 'dev') throw new Error('public_memory_development_only');
  if (!PUBLIC_MEMORY_SETS.includes(set)) throw new Error(`unknown_public_memory_set:${set}`);
  const key = sourceKey(set), pool = json(new URL(`../pools/${key}-20261109.json`, import.meta.url));
  return { key, ids: new Set(pool.pools.development), sourceSha256: pool.sourceSha256 };
}

async function pinnedFile(dataDir, key, file) {
  const entry = sources[key].files.find(f => f.path === file);
  if (!entry) throw new Error(`public_file_not_pinned:${key}/${file}`);
  const full = join(dataDir, 'public', key, file), hash = createHash('sha256');
  for await (const bytes of createReadStream(full)) hash.update(bytes);
  if (hash.digest('hex') !== entry.sha256) throw new Error(`public_pin_mismatch:${key}/${file}`);
  return full;
}

/** Parse only selected JSONL rows; public files can contain questions from both pools. */
async function* selectedLines(file, keep) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const id = /"(?:id|uuid)"\s*:\s*"([^"\\]+)"/.exec(line)?.[1];
    if (id && keep(id)) yield JSON.parse(line);
  }
}

/** @returns {Promise<{caseId: string, itemId: string, inputs: any[], gold?: any[]}[]>} */
export async function readPublicMemory({ set, split = 'dev', dataDir, only, withGold = false }) {
  const { key, ids, sourceSha256 } = publicPool(set, split);
  const pins = sources[key].files.filter(f => key === 'locomo-refined' ? f.path === 'data/raw/locomo_refined.json'
    : key === 'locomo' ? f.path === 'data/locomo10.json' : key === 'halumem' ? f.path === 'HaluMem-Medium.jsonl'
      : key === 'realmem' ? f.path.endsWith('.json') : f.path.startsWith('data/'));
  if (sourceSetSha256(pins) !== sourceSha256) throw new Error(`public_pool_pin_mismatch:${key}`);
  const groups = new Map(), seen = new Set();
  const wanted = id => !only?.length || only.includes(id);
  const add = (id, input, gold) => {
    if (!groups.has(id)) groups.set(id, { caseId: id, itemId: id, inputs: [], ...(withGold ? { gold: [] } : {}) });
    groups.get(id).inputs.push(input);
    if (withGold) groups.get(id).gold.push(gold);
    seen.add(input.id);
  };
  const excluded = new Set();
  if (key.startsWith('locomo')) {
    const file = key === 'locomo' ? 'data/locomo10.json' : 'data/raw/locomo_refined.json';
    for (const sample of json(await pinnedFile(dataDir, key, file))) {
      const caseId = sample.sample_id;
      // Inspect only pool-selected questions; adversarial rows have no reference answer.
      for (const id of ids) {
        if (!id.startsWith(`${caseId}:q`)) continue;
        const index = Number(id.slice(caseId.length + 2));
        if (!sample.qa[index]) throw new Error(`public_question_missing:${id}`);
        if (![1, 2, 3, 4].includes(sample.qa[index].category)) { excluded.add(id); continue; }
        if (!wanted(caseId)) continue;
        add(caseId, locomoRuntimeInput(sample, index, { benchmark: key }), withGold ? locomoGold(sample, index, { benchmark: key }) : null);
      }
    }
  } else if (key === 'halumem') {
    for await (const user of selectedLines(await pinnedFile(dataDir, key, 'HaluMem-Medium.jsonl'), id => wanted(id) && [...ids].some(q => q.startsWith(`${id}:`)))) {
      for (const id of ids) {
        if (!id.startsWith(`${user.uuid}:`)) continue;
        const [, s, q] = /:s(\d+):q(\d+)$/.exec(id) ?? [];
        add(user.uuid, haluMemRuntimeInput(user, Number(s), Number(q)), withGold ? haluMemGold(user, Number(s), Number(q)) : null);
      }
    }
  } else if (key === 'realmem') {
    for (const pin of pins) {
      const person = pin.path.slice('dataset/'.length).replace('_dialogues_256k.json', '');
      if (!wanted(person) || ![...ids].some(id => id.startsWith(`${person}:`))) continue;
      const persona = json(await pinnedFile(dataDir, key, pin.path));
      // Published protocol is chronological; retain session indices used by the selected query adapters.
      persona.dialogues.sort((a, b) => Date.parse(a.current_time) - Date.parse(b.current_time));
      for (const ref of realMemQueryRefs(persona)) {
        const qid = `${person}:${persona.dialogues[ref.sessionIndex].dialogue_turns[ref.turnIndex].query_id}`;
        if (ids.has(qid)) add(person, realMemRuntimeInput(persona, ref), withGold ? realMemGold(persona, ref) : null);
      }
    }
  } else {
    const manifest = json(await pinnedFile(dataDir, key, 'data/manifest.json'));
    for (const task of Object.values(manifest.tasks)) {
      for await (const row of selectedLines(await pinnedFile(dataDir, key, `data/${task.file}`), id => ids.has(id) && wanted(id))) {
        add(row.id, memSycoRuntimeInput(row), withGold ? memSycoGold(row) : null);
      }
    }
  }
  if (!only?.length && seen.size + excluded.size !== ids.size) throw new Error(`public_pool_question_missing:${key}:${seen.size}+${excluded.size}/${ids.size}`);
  return [...groups.values()];
}
