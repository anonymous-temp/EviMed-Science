#!/usr/bin/env node
// Offline recorded-data replay. No credentials, provider discovery or network by default.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { NativeMemoryVerification, parseVerificationJudgement } from '../../../apps/server/src/nativeMemoryVerification.mjs';
import { createPastedInstructionJudge } from '../../../apps/server/src/nativeMemoryPastedInstructions.mjs';
import { keepUnexplainedLines } from '../../../apps/server/src/nativeMemoryKeepLines.mjs';
import { lineFingerprint, memoryLines } from '../../../apps/server/src/nativeMemoryOverlay.mjs';
import { memoryNameKey, mergeNormalizedMemoryText } from '../../../apps/server/src/nativeMemoryNames.mjs';
import { renderMemoryTemplates } from '../../../deploy/web/openviking/memory-templates-src/build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sourceRoot = path.join(root, 'OpenScience/apps/server/src');
const memoryRoot = 'viking://user/replay/memories';
const read = async name => JSON.parse(await fs.readFile(name, 'utf8'));
async function files(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(name)); else result.push(name);
  }
  return result.sort();
}
const countLines = values => Object.values(values).reduce((count, body) => count + memoryLines(body).length, 0);
const sourcesOf = pack => (pack.sources?.sessions ?? []).filter(session => !session.afterCheckpoint).flatMap(session =>
  session.messages.filter(message => ['user', 'assistant'].includes(message.role)).map(message => ({ role: message.role, text: message.text ?? message.content ?? '', created_at: session.at ?? null })));

/** Adapter methods are optional: judge({caseId,userId,lines,maxAttempts}) => {results:Map,calls,usage};
 * extract({caseId,sources,before,templates}) => {files,usage}; basicCall(deps,request) => OpenAI-shaped response.
 * The real adapter is supplied by the lab. The runner never loads operator configuration or secrets.
 * @param {{packs:string,adapter?:any,verdicts?:Record<string,any>,limit?:number}} options */
export async function replayWriteClasses({ packs, adapter = {}, verdicts = {}, limit = 40 }) {
  limit = Math.min(40, Math.max(1, limit));
  const templates = renderMemoryTemplates({ variant: 'next' });
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, rows = [];
  const account = value => { for (const key of Object.keys(usage)) usage[key] += Number(value?.[key]) || 0; };
  const baselineRef = '717308708';
  const baselineSource = execFileSync('git', ['show', `${baselineRef}:OpenScience/apps/server/src/nativeMemoryKeepLines.mjs`], { cwd: root, encoding: 'utf8' })
    .replaceAll("'./nativeMemoryHardTokens.mjs'", JSON.stringify(pathToFileURL(path.join(sourceRoot, 'nativeMemoryHardTokens.mjs')).href))
    .replaceAll("'./nativeMemoryOverlay.mjs'", JSON.stringify(pathToFileURL(path.join(sourceRoot, 'nativeMemoryOverlay.mjs')).href));
  const baseline = await import(`data:text/javascript;base64,${Buffer.from(baselineSource).toString('base64')}`);
  // Exact before/after pairs, not the neighbouring run or an excerpt reconstructed as a full snapshot.
  for (const [run, from, to] of [['r2-P08', 20, 30], ['r3-P08', 8, 30], ['r3-P08', 12, 30]]) {
    if (rows.length >= limit) break;
    const prefix = path.join(packs, 'snapshots', run), beforePath = path.join(prefix, `${from}.json`), afterPath = path.join(prefix, `${to}.json`);
    const before = await read(beforePath).catch(() => null), after = await read(afterPath).catch(() => null);
    if (!before || !after) { rows.push({ id: `${run}:${from}->${to}`, kind: 'history', missing: [beforePath, afterPath] }); continue; }
    for (const [name, body] of Object.entries(before.files).filter(([name]) => name.startsWith('projects/'))) {
      if (rows.length >= limit) break;
      const next = after.files[name] ?? null;
      const options = { enabled: true, before: body, after: next, neverKept: () => false };
      const old = baseline.keepUnexplainedLines(options), fixed = keepUnexplainedLines(options);
      const present = new Set(memoryLines(next).map(lineFingerprint));
      const lost = memoryLines(body).filter(line => !present.has(lineFingerprint(line)));
      const retained = result => lost.filter(line => new Set(memoryLines(result.after).map(lineFingerprint)).has(lineFingerprint(line))).length;
      const key = memoryNameKey(`${memoryRoot}/${name}`, memoryRoot);
      const siblings = Object.keys(after.files).filter(other => other !== name && memoryNameKey(`${memoryRoot}/${other}`, memoryRoot) === key);
      rows.push({ id: `${run}:${from}->${to}:${name}`, kind: 'history', beforeLines: body.split('\n').length, afterLines: next?.split('\n').length ?? 0,
        lostStatements: lost.length, baselineRetained: retained(old), guardedRetained: retained(fixed), baselineOutcomes: old.outcomes, guardedOutcomes: fixed.outcomes,
        lostQuotes: lost, normalizedSiblings: siblings, mergedStatements: siblings.length ? memoryLines(mergeNormalizedMemoryText(next ?? '', after.files[siblings[0]])).length : null });
    }
  }
  // Primary recorded sessions with complete selected snapshots. These packs are checkpoint
  // evidence, not extraction diffs: no claim that all snapshot lines were newly extracted there.
  const wanted = new Set(['M01-q014', 'M02-q014', 'P05-q011', 'P01-q014', 'P03-q014', 'U02-q024', 'U03-q022', 'U04-q060', 'U04-q061', 'U02-q083', 'P08-q055']);
  const cases = [];
  for (const name of await files(path.join(packs, 'A'))) {
    if (!name.endsWith('.json') || !wanted.has(path.basename(name, '.json')) || !name.includes('r3-synthetic-users-dev-cand-1')) continue;
    const pack = await read(name), sources = sourcesOf(pack);
    const snapshot = pack.snapshotAfterPlant?.find(value => !value.TEXT_OMITTED)?.matchingFiles ?? pack.snapshot?.files ?? {};
    cases.push({ id: path.basename(name, '.json'), sources, files: snapshot, provenance: path.relative(packs, name), scope: 'checkpoint-reconstruction-not-exact-commit' });
  }
  cases.push({ id: 'F03-synthetic', sources: [{ role: 'user', text: '回复先结论后依据，200 字以内。', created_at: '2026-11-15' }],
    files: { 'preferences/self/replies.md': '- 回复先结论后依据，200 字以内；需要展开时先问。' }, scope: 'synthetic-reproduction' },
  { id: 'F06-synthetic', sources: [{ role: 'user', text: '我认为患者依从性最难。', created_at: '2026-11-15' }],
    files: { 'projects/study.md': '## 阶段\n- 项目已启动，用户认为患者依从性最难。' }, scope: 'synthetic-reproduction' });
  for (const item of cases) {
    if (rows.length >= limit - 3) break;
    const verification = new NativeMemoryVerification({ config: {}, sessions: {}, overlay: {}, judge: { judge: async input => {
      if (adapter.judge) { const answer = await adapter.judge({ ...input, caseId: item.id }); account(answer.usage); return answer; }
      const results = parseVerificationJudgement(JSON.stringify(verdicts[item.id] ?? {}), input.lines);
      return { results: results ?? new Map(), calls: 0 };
    } } });
    const changes = Object.entries(item.files).map(([name, after]) => ({ uri: `${memoryRoot}/${name}`, before: '', after }));
    const checked = await verification.assessCommit('offline-replay', changes, item.sources);
    let extracted = null;
    if (adapter.extract) { extracted = await adapter.extract({ caseId: item.id, sources: item.sources, before: {}, templates }); account(extracted.usage); }
    rows.push({ id: item.id, kind: 'source-and-template', scope: item.scope, provenance: item.provenance ?? null, calls: checked.calls, omitted: checked.omitted,
      findings: checked.results.map(row => ({ text: row.text, status: row.status, corrected: row.corrected })),
      originalStatements: countLines(item.files), resultingStatements: countLines(Object.fromEntries(checked.rewrites.map(row => [row.uri, row.after]))),
      extractionMeasured: Boolean(extracted), extractedStatements: extracted ? countLines(extracted.files) : null,
      extraStatements: extracted ? countLines(extracted.files) - countLines(item.files) : null,
      extractedFiles: extracted?.files ?? null });
  }
  // The owner's three basic-check fixtures. The verdict quotes are synthetic evidence,
  // some abbreviated: a fake verdict validates the existing parser, never a live-model claim.
  const triage = (await fs.readFile(path.join(packs, 'verdicts/store-triage-2.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const number of [132, 158, 194]) {
    if (rows.length >= limit) break;
    const row = triage.find(row => row.line === number);
    if (!row) { rows.push({ id: `basic:${number}`, missing: true }); continue; }
    const source = row.evidence.find(text => text.startsWith('session ')) ?? '';
    const text = row.evidence.find(text => text.includes('.md:')) ?? '';
    const candidates = [{ text }], conversation = [{ role: 'user', text: source }];
    const judge = createPastedInstructionJudge({ config: { memoryPastedInstructionCheckEnabled: true, memoryPastedInstructionRobustEnabled: false,
      deepseekModel: 'injected-replay', deepseekApiKey: 'not-a-provider-key' }, callModel: async (deps, request) => {
      if (adapter.basicCall) { const answer = await adapter.basicCall(deps, request); account(answer.usage); return answer; }
      return { choices: [{ message: { content: JSON.stringify({ judgements: [{ candidate: 0, decision: 'material_instruction', message: 0, quote: source }] }) } }] };
    } });
    const refused = await judge.check({ userId: 'offline-replay', candidates, conversation });
    rows.push({ id: `basic:${number}`, kind: 'basic-pasted-check', evidence: row.evidence, mode: adapter.basicCall ? 'injected-model' : 'recorded-verdict-fake', refused: [...refused], robust: false });
  }
  return { baselineRef, templateSet: 'memory-templates-next', cases: rows.length, templateFiles: Object.keys(templates), usage, rows,
    limits: { maximumCases: 40, maximumCommitCalls: 1, extraction: adapter.extract ? 'measured-by-injected-adapter' : 'not-measured-no-extraction-adapter',
      syntheticVerdicts: !adapter.judge, checkpointSources: 'Do not interpret a checkpoint reconstruction as an exact commit or a false-positive rate.' } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
  if (!args.includes('--packs')) throw Error('Usage: write-classes.mjs --packs <directory> [--adapter <module>] [--verdicts <json>] [--out <json>]');
  const adapter = args.includes('--adapter') ? await import(pathToFileURL(path.resolve(option('--adapter'))).href) : {};
  const verdicts = args.includes('--verdicts') ? await read(option('--verdicts')) : {};
  const result = await replayWriteClasses({ packs: path.resolve(option('--packs')), adapter, verdicts });
  if (args.includes('--out')) await fs.writeFile(option('--out'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, rows: result.rows.map(({ lostQuotes, findings, extractedFiles, ...row }) => row) }, null, 2));
}
