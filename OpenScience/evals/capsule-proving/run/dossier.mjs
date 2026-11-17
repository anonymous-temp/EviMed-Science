#!/usr/bin/env node
/** Export lossless, case-bound error evidence from an already scored run; never runs a judge. */
import { readFile, readdir, realpath, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadGold, caseEvidence, transcriptCase, questionContext, findAnswer, snapshotFor, storeEvidence, scopeMemory } from './score.mjs';
import { rowKey } from './judgePackets.mjs';

const optional = async (fn, fallback) => { try { return await fn(); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
/** Check names and resolved symlinks before opening bytes. A traversal checks only the requested input tree. */
export async function guardPath(file, allowSealed = false, tree = false, seen = new Set()) {
  const resolved = path.resolve(file);
  if (!allowSealed && /sealed/i.test(resolved)) throw new Error('sealed_path_forbidden');
  const target = await optional(() => realpath(resolved), resolved);
  if (!allowSealed && /sealed/i.test(target)) throw new Error('sealed_path_forbidden');
  if (!tree || seen.has(target)) return;
  seen.add(target);
  const info = await optional(() => lstat(target), null);
  if (info?.isDirectory()) for (const name of await readdir(target)) {
    // Refuse before the fixed-layout loader could open a forbidden descendant.
    await guardPath(path.join(target, name), allowSealed, true, seen);
  }
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const readLines = async file => optional(async () => (await readFile(file, 'utf8')).split('\n').filter(l => l.trim()).map(l => JSON.parse(l)), []);
const identity = (runId, caseId, kind, id, checkpoint) => ({ runId, caseId, kind, id, checkpoint: checkpoint ?? null });
const packetIdentity = packet => { const [runId, , , caseId, kind, id] = JSON.parse(packet.rowKey); return { runId, caseId, kind, id }; };

export async function exportDossiers({ run: runDir, data, out, scores, allowSealed = false }) {
  if (!runDir || !data || !out) throw new Error('run_data_out_required');
  runDir = path.resolve(runDir); data = path.resolve(data); out = path.resolve(out);
  for (const file of [runDir, data, out]) await guardPath(file, allowSealed);
  const manifestPath = path.join(runDir, 'run.json');
  await guardPath(manifestPath, allowSealed);
  const manifest = await readJson(manifestPath);
  const scoreDirs = scores ? [path.resolve(scores)] : (await readdir(runDir, { withFileTypes: true }))
    .filter(d => d.isDirectory() && d.name.startsWith('scores') && (allowSealed || !/sealed/i.test(d.name))).map(d => path.join(runDir, d.name));
  // Gold readers use fixed set-specific locations. Inspect selected trees for symlink escapes before invoking them.
  const publicNames = { 'longmemeval-s': 'longmemeval', medmemorybench: 'medmemorybench-hf', 'brand-generic': 'brand-generic-probe', locomo: 'locomo-refined', 'locomo-original': 'locomo', realmem: 'realmem', halumem: 'halumem', memsyco: 'memsyco' };
  const goldRoot = publicNames[manifest.set] ? path.join(data, 'public', publicNames[manifest.set])
    : manifest.set === 'synthetic-users' ? path.join(data, manifest.split) : path.join(data, manifest.set === 'g6' ? 'g6' : `${manifest.set}-${manifest.split}`);
  await guardPath(goldRoot, allowSealed, true);
  const entries = await loadGold(data, manifest, { allowSealed });
  const goldByCase = new Map();
  for (const entry of entries) {
    if (goldByCase.has(entry.caseId)) throw new Error('duplicate_gold_case');
    if (entry.gold.userId !== undefined && entry.gold.userId !== entry.caseId) throw new Error('gold_case_mismatch');
    goldByCase.set(entry.caseId, entry);
  }
  await mkdir(out, { recursive: true, mode: 0o700 });
  const exported = [];
  for (const directory of scoreDirs.sort()) {
    await guardPath(directory, allowSealed, true);
    const rows = await readLines(path.join(directory, 'rows.jsonl'));
    const packets = await readLines(path.join(directory, 'judge-packets.jsonl'));
    const results = await readLines(path.join(directory, 'judge-results.jsonl'));
    const summary = await optional(() => readJson(path.join(directory, 'summary.json')), {});
    const inferredVariant = /^scores\.(.+?)(?:\.official)?$/.exec(path.basename(directory))?.[1];
    const variantName = Object.hasOwn(summary, 'variant') ? summary.variant ?? undefined : inferredVariant === 'official' ? undefined : inferredVariant;
    for (const row of rows.filter(r => !['pass', 'policy-allowed'].includes(r.verdict) || r.redLineOutcome?.verdict === 'fail')) {
      if (row.runId !== manifest.runId) throw new Error('score_run_mismatch');
      const entry = goldByCase.get(row.caseId);
      if (!entry) throw new Error('gold_case_missing');
      if (typeof row.caseId !== 'string' || /[/\\\0]/.test(row.caseId) || ['.', '..'].includes(row.caseId)) throw new Error('case_id_invalid');
      const caseDir = path.join(runDir, 'cases', row.caseId);
      if (path.dirname(caseDir) !== path.join(runDir, 'cases')) throw new Error('case_id_invalid');
      await guardPath(caseDir, allowSealed, true);
      const evidence = await caseEvidence(runDir, row.caseId, variantName);
      const loaded = await transcriptCase(data, manifest, entry);
      const question = entry.gold.questions?.find(q => q.qid === row.id) ?? (manifest.set === 'm7' ? { qid: row.id, question: entry.input?.[row.variant]?.ask, expect: { mustContainAny: entry.input?.[row.variant]?.given ?? [] } } : null);
      const store = row.kind === 'store' ? entry.gold.store?.find(s => `store:${s.plantId}` === row.id) : null;
      if (row.kind === 'store' && !store) throw new Error('gold_store_missing');
      const matches = evidence.answers.filter(a => a.qid === row.id);
      if (matches.length > 1) throw new Error('ambiguous_answer');
      const answer = matches[0] ?? (question && manifest.set === 'm7' ? findAnswer(evidence, question, { fallback: true }) : null)
        ?? (row.kind === 'redline' ? evidence.answers.find(a => a.qid === `${row.id}-probe`) : null);
      const context = question ? questionContext(entry, loaded, question, answer, evidence) : null;
      const selected = store ? storeEvidence(entry, loaded, evidence, store, manifest.set) : null;
      const checkpoint = row.checkpoint ?? context?.checkpoint ?? selected?.snapshot?.afterSession ?? null;
      const key = identity(row.runId, row.caseId, row.kind, row.id, checkpoint);
      const relevantPackets = packets.filter(p => {
        const k = packetIdentity(p);
        return k.runId === row.runId && k.caseId === row.caseId && k.id === row.id
          && [row.kind, 'redline-check'].includes(k.kind) && (p.checkpoint == null || checkpoint == null || p.checkpoint === checkpoint);
      });
      if (relevantPackets.filter(p => packetIdentity(p).kind === row.kind).length > 1) throw new Error('ambiguous_judge_packet');
      const packetIds = new Set(relevantPackets.map(p => p.id));
      const boundResults = results.filter(r => packetIds.has(r.id));
      for (const result of boundResults) if (result.hash !== relevantPackets.find(p => p.id === result.id).hash) throw new Error('judge_result_identity_mismatch');
      const sourceSessions = (loaded.item?.sessions ?? []).slice(0, checkpoint ?? undefined)
        .filter(s => !context?.asOf || !s.at || Date.parse(s.at) <= Date.parse(context.asOf));
      const ids = new Set(sourceSessions.map(s => s.sessionId ?? s.id));
      const answerRecords = [];
      for (const file of await optional(() => readdir(caseDir), [])) if (/^answers(?:\..+)?\.jsonl$/.test(file)) {
        await guardPath(path.join(caseDir, file), allowSealed);
        for (const record of await readLines(path.join(caseDir, file))) {
          if (record.caseId !== undefined && record.caseId !== row.caseId) throw new Error('answer_case_mismatch');
          if (record.qid === row.id) answerRecords.push({ file, record });
        }
      }
      const snapshot = selected ? selected.snapshot : snapshotFor(evidence, { checkpoint: checkpoint ?? undefined });
      await guardPath(path.join(runDir, 'maintenance.jsonl'), allowSealed);
      const missingRecords = [...(!answer && row.kind === 'answer' ? ['answer-record'] : []), ...(!snapshot ? ['snapshot'] : []),
        ...(!sourceSessions.length ? ['source-sessions'] : []), ...(!relevantPackets.length && row.by === 'judge' ? ['judge-packet'] : [])];
      const pack = { schema: 'capsule-proving-dossier/1', key, scoreDirectory: path.basename(directory), row, judgePackets: relevantPackets,
        judgeResults: boundResults, answer, answerRecords, gold: { caseId: entry.caseId, definition: entry.gold, question: question ?? null, store },
        sourceSessions, snapshot, subjectSnapshot: selected ? scopeMemory(selected.snapshot, store, entry.gold.subjectLabels) : null, snapshots: selected?.snapshots ?? [],
        ingest: evidence.ingest.filter(r => ids.has(r.sessionId)),
        maintenance: [...await readLines(path.join(caseDir, 'maintenance.jsonl')), ...(await readLines(path.join(runDir, 'maintenance.jsonl'))).filter(r => r.caseId === row.caseId)],
        missingRecords };
      // Every exported record has the complete binding, even when its local plant/session ID repeats in another case.
      pack.records = Object.entries(pack).filter(([name]) => !['schema', 'key', 'scoreDirectory'].includes(name))
        .map(([recordType, value]) => ({ key, recordType, value }));
      const hash = createHash('sha256').update(JSON.stringify([path.basename(directory), key])).digest('hex');
      const destination = path.join(out, `${hash}.json`);
      await guardPath(destination, allowSealed);
      await writeFile(destination, JSON.stringify(pack, null, 2) + '\n', { mode: 0o600 });
      exported.push({ key, scoreRowKey: rowKey(row), path: destination });
    }
  }
  await guardPath(path.join(out, 'index.json'), allowSealed);
  await writeFile(path.join(out, 'index.json'), JSON.stringify(exported, null, 2) + '\n', { mode: 0o600 });
  return exported;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const options = {}, args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-sealed') { options.allowSealed = true; continue; }
    const name = { '--run': 'run', '--data': 'data', '--out': 'out', '--scores': 'scores' }[args[i]];
    if (!name || !args[i + 1] || args[i + 1].startsWith('--') || options[name]) throw new Error('invalid_dossier_option');
    options[name] = args[++i];
  }
  try { const result = await exportDossiers(options); process.stdout.write(`Exported ${result.length} evidence packs.\n`); }
  catch (error) { process.stderr.write(`dossier: ${error.message}\n`); process.exitCode = 1; }
}
