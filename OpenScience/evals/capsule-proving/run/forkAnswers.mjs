#!/usr/bin/env node
/** Freeze a completed ingestion and its prior answers, then use the canonical read-only answer runner on the same engine user.
 * Usage: node run/forkAnswers.mjs --source-run DIR <ordinary run.mjs arguments; --answers-only is implicit>
 * No source file is modified. A resume keeps the first frozen answer prefix; it never selects between duplicate answers.
 */
import { readFile, writeFile, mkdir, readdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadCases } from './cases.mjs';
import { main, parseArguments } from './run.mjs';
import { openLab } from './lab.mjs';
import { nativeMemoryFile } from '../../../apps/server/src/openVikingSessions.mjs';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const lines = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const visibleForkFiles = snapshot => Object.fromEntries(Object.entries(snapshot.files ?? {}).filter(([rel]) => nativeMemoryFile(`root/${rel}`, 'root')));
const exists = async file => access(file).then(() => true, () => false);

/** Validate the complete frozen prefix BEFORE creating output. Source/target cases are injected for small proof-boundary tests. */
export async function prepareAnswerFork({ source, out, cases, sourceCases, sourceRun, set, split }) {
  source = path.resolve(source); out = path.resolve(out);
  if (source === out || path.basename(out) === sourceRun.runId || split !== 'dev' || sourceRun.split !== 'dev') throw new Error('fork_requires_distinct_development_output');
  if (sourceRun.arm !== 'product' || sourceRun.flags?.maintain !== 'none' || sourceRun.flags?.plantCorruptionsAfter != null
    || sourceRun.flags?.config?.memoryOpeningByUseEnabled === true) throw new Error('fork_source_must_have_stable_read_only_answer_state');
  const held = path.join(out, 'answer-fork.json');
  const identity = { source, sourceRunId: sourceRun.runId, set, split, caseIds: cases.map(c => c.caseId),
    sessionsDigest: hash(JSON.stringify(cases.map(c => [c.caseId, c.userKey, c.sessions]))),
    questionsDigest: hash(JSON.stringify(cases.map(c => [c.caseId, c.questions]))) };
  if (await exists(held)) {
    const previous = await json(held);
    for (const [key, value] of Object.entries(identity)) if (!isDeepStrictEqual(previous[key], value)) throw new Error('fork_resume_identity_changed');
    return previous;
  }
  if (await exists(path.join(out, 'run.json'))) throw new Error('fork_output_already_has_a_run');
  const status = (await readFile(path.join(source, 'STATUS'), 'utf8')).split('\n');
  const done = new Set(status.flatMap(line => /^\S+ DONE (\S+)/.exec(line)?.slice(1) ?? []));
  const frozen = [];
  for (const c of cases) {
    const original = sourceCases.find(item => item.caseId === c.caseId);
    if (!original || original.userKey !== c.userKey || !isDeepStrictEqual(original.sessions, c.sessions)) throw new Error(`fork_history_changed:${c.caseId}`);
    const dir = path.join(source, 'cases', c.caseId), count = c.sessions.length;
    if (c.sessions.some(s => !done.has(`${c.caseId}/ingest/${s.sessionId}`))) throw new Error(`fork_ingestion_incomplete:${c.caseId}`);
    const ingest = await lines(path.join(dir, 'ingest.jsonl'));
    if (ingest.length !== count || count && (ingest.at(-1).commit?.status !== 'completed' || ingest.at(-1).settle?.open !== 0)) throw new Error(`fork_ingestion_unsettled:${c.caseId}`);
    const finalSnapshot = await readFile(path.join(dir, 'snapshots', `${count}.json`));
    const answers = await lines(path.join(dir, 'answers.jsonl'));
    const accepted = answers.filter(a => c.questions.some(q => q.qid === a.qid && q.text === a.question && q.asOf === a.asOf) && a.arm === 'product');
    if (new Set(accepted.map(a => a.qid)).size !== accepted.length) throw new Error(`fork_duplicate_answer:${c.caseId}`);
    for (const q of c.questions) if (q.afterSession < count && !accepted.some(a => a.qid === q.qid)) throw new Error(`fork_past_answer_missing:${c.caseId}:${q.qid}`);
    frozen.push({ c, dir, answers: accepted, snapshotSha256: hash(finalSnapshot), ingestSha256: hash(JSON.stringify(ingest)),
      answersSha256: hash(JSON.stringify(accepted)), preservedErrors: accepted.filter(a => a.error).map(a => a.qid) });
  }
  await mkdir(out, { recursive: true, mode: 0o700 });
  const keys = new Set();
  for (const f of frozen) {
    const dest = path.join(out, 'cases', f.c.caseId);
    await mkdir(path.join(dest, 'snapshots'), { recursive: true, mode: 0o700 });
    await copyFile(path.join(f.dir, 'ingest.jsonl'), path.join(dest, 'ingest.jsonl'));
    for (const file of await readdir(path.join(f.dir, 'snapshots'))) if (/^\d+\.json$/.test(file)) {
      await copyFile(path.join(f.dir, 'snapshots', file), path.join(dest, 'snapshots', file));
      keys.add(`${f.c.caseId}/snapshot/${file.slice(0, -5)}`);
    }
    for (const s of f.c.sessions) keys.add(`${f.c.caseId}/ingest/${s.sessionId}`);
    for (const a of f.answers) if (!a.error) keys.add(`${f.c.caseId}/answer/${a.qid}`);
    await writeFile(path.join(dest, 'answers.jsonl'), f.answers.map(a => JSON.stringify(a)+'\n').join(''), { mode: 0o600 });
  }
  const imported = frozen.flatMap(f => f.answers.filter(a => a.error || !done.has(`${f.c.caseId}/answer/${a.qid}`)).map(a =>
    `${new Date().toISOString()} DONE ${f.c.caseId}/answer/${a.qid} source-record-frozen${a.error ? ': error retained for scoring; never retried' : ''}`));
  await writeFile(path.join(out, 'STATUS'), [...status.filter(line => keys.has(/^\S+ DONE (\S+)/.exec(line)?.[1])), ...imported].join('\n')+'\n', { mode: 0o600 });
  const receipt = { ...identity, at: new Date().toISOString(), sourceRunnerDigest: sourceRun.runnerDigest ?? null,
    sourceCommit: sourceRun.commit ?? null, readOnly: true, rule: 'Copy the first source prefix, retain every recorded error without retry, ask only pending questions at the final checkpoint. No new ingestion or source-file writes.',
    cases: frozen.map(f => ({ caseId: f.c.caseId, sessions: f.c.sessions.length, copiedAnswers: f.answers.length,
      snapshotSha256: f.snapshotSha256, ingestSha256: f.ingestSha256, answersSha256: f.answersSha256, preservedErrors: f.preservedErrors })) };
  await writeFile(held, JSON.stringify(receipt,null,2)+'\n', { mode: 0o600 });
  return receipt;
}

export async function forkAnswers(argv) {
  const args = [...argv], at = args.indexOf('--source-run');
  if (at < 0 || !args[at+1]) throw new Error('--source-run DIR is required');
  const source = path.resolve(args[at+1]); args.splice(at,2);
  if (!args.includes('--answers-only')) args.push('--answers-only');
  const options = parseArguments(args);
  if (options.split !== 'dev') throw new Error('fork_development_only');
  const sourceRun = await json(path.join(source,'run.json'));
  if (sourceRun.split !== 'dev') throw new Error('fork_development_only');
  const urls = sourceRun.engine?.urls ?? [sourceRun.engine?.url];
  if (options.arm !== 'product' || options.stockEngine || options.maxSessions || options.limitQuestions || options.retrievalOnly || options.answerVariants.length
    || sourceRun.memorySource || sourceRun.engine?.account !== `evlab-${sourceRun.runId}`
    || sourceRun.model?.answer !== (options.answerModel || 'deepseek-flash')
    || sourceRun.flags?.historySearch !== options.historySearch || sourceRun.options?.maxRounds !== options.maxRounds
    || !isDeepStrictEqual(options.engineUrls,urls)
    || sourceRun.engine?.templates === 'stock' || sourceRun.model?.thinking !== options.thinking || options.reasoningEffort !== 'high'
    || !isDeepStrictEqual(sourceRun.flags?.config ?? {}, options.config)) throw new Error('fork_answer_configuration_changed');
  const cases = await loadCases({set:options.set,split:options.split,dataDir:options.data,only:options.only || null});
  const sourceCases = await loadCases({set:sourceRun.set,split:sourceRun.split,dataDir:sourceRun.options.dataDir,only:cases.map(c=>c.caseId)});
  const receipt = await prepareAnswerFork({ source, out:options.out, cases, sourceCases, sourceRun, set:options.set, split:options.split });
  try {
    return await main(args, { openLab: async selected => {
      const lab = await openLab({ ...selected, account:sourceRun.engine.account, runId:sourceRun.runId });
      const userFor = lab.user.bind(lab);
      lab.user = async userKey => {
        const user = await userFor(userKey), c = cases.find(c => c.userKey === userKey);
        const expected = await json(path.join(options.out,'cases',c.caseId,'snapshots',`${c.sessions.length}.json`));
        const actual = await lab.snapshot(user);
        // The source may build a derived opening index while its other variants answer. Compare actual readable facts only.
        if (!isDeepStrictEqual(visibleForkFiles(expected),visibleForkFiles(actual))) throw new Error(`fork_live_memory_changed:${c.caseId}`);
        return user;
      };
      return lab;
    } });
  } finally {
    const file = path.join(path.resolve(options.out),'run.json');
    if (await exists(file)) { const run = await json(file); run.memorySource = receipt; await writeFile(file,JSON.stringify(run,null,2)+'\n',{mode:0o600}); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) forkAnswers(process.argv.slice(2))
  .catch(error => { process.stderr.write(`answer_fork: ${error.code ?? error.message}\n`); process.exitCode=1; });
