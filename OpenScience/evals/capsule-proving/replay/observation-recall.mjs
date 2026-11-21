// Check recorded material only. Whether an answer treats an observation as a
// durable preference is a semantic judgement bound to the exact reviewed reply.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recallDigest } from '../../../apps/server/src/memoryRecallReceipt.mjs';
import { answersFrom } from './recall-ranking.mjs';

const cases = JSON.parse(await readFile(new URL('./observation-cases.json', import.meta.url),'utf8'));
const recording = new URL('../../memory-write-quality/results/2026-10-27-native-full-final.json',import.meta.url);
const marker = '[seen once — observed choice, not a standing preference]';

export async function observationFixtures(bindings = []) {
  const rows = JSON.parse(await readFile(recording,'utf8')).rows;
  return cases.map(item => {
    if (item.row) {
      const body = rows.find(row => row.id === item.row)?.files[item.file];
      if (!body?.includes(item.quote)) throw Error('source snapshot changed: '+item.qid);
      return {...item,source:'2026-10-27-native-full-final.json#'+item.row, bodyHash:recallDigest(body),
        question:item.kind === 'shared' ? '我在这个项目里提出过哪些格式要求？' : '先前关于“'+item.file.split('/').at(-1).replace(/\.md$/,'')+'”有什么记录？这是我长期的要求吗？'};
    }
    const bound = bindings.find(row => row.qid === item.qid && row.arm === item.arm);
    if (!bound?.quote?.trim() || !bound.source || !bound.question || !bound.file && item.kind === 'once') return {...item,missing:'recorded_target'};
    return {...item,quote:bound.quote,source:bound.source,question:bound.question,file:bound.file};
  });
}

// Bind only exact, unambiguous gold spans. Checkpoint fragments without a unique
// observation leaf need a human binding, never a similarity guess.
export async function bindRecordedCases(root) {
  const wanted = new Map(cases.filter(item => item.arm).map(item => [item.qid,item]));
  const results = [];
  async function walk(dir) {
    for (const entry of await readdir(dir,{withFileTypes:true})) {
      const file = path.join(dir,entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      const item = wanted.get(path.basename(file,'.json'));
      if (!entry.isFile() || !item || !file.includes(item.arm)) continue;
      const pack = JSON.parse(await readFile(file,'utf8'));
      const record = pack.answer ?? pack['answerRecords(answers.jsonl=chosen arm; other files = ablation variants of same questions)']?.['answers.jsonl']?.[0];
      const gold = pack.gold?.runtimeQuestion ?? pack.gold?.question;
      const candidates = (item.kind === 'once' ? gold?.expect?.mustContain : gold?.expect?.mustNotContain) ?? [];
      const snapshot = pack.snapshot?.files ?? pack.snapshotInForce?.snapshot?.files ??
        pack.snapshotAfterPlant?.find(s => !s.TEXT_OMITTED)?.matchingFiles ?? {};
      const hits = [];
      for (const quote of candidates.filter(v => typeof v === 'string' && v.trim())) {
        if (item.kind === 'withdrawn') { hits.push({quote}); continue; }
        const files = Object.entries(snapshot).filter(([key,value]) => key.startsWith('observations/') && String(value?.body ?? value).includes(quote));
        if (files.length === 1) hits.push({quote,file:files[0][0]});
      }
      if (hits.length === 1 && record?.question) results.push({...item,...hits[0],question:record.question,source:path.relative(root,file)});
    }
  }
  await walk(root);
  return results;
}

function returnedItems(call) {
  return (call.blocks ?? []).flatMap(block => {
    const value = typeof block === 'string' ? block : block.text ?? '';
    if (call.name.endsWith('search')) {
      try { return JSON.parse(value).memories?.map(hit => ({uri:hit.uri,text:hit.abstract})) ?? []; } catch { return []; }
    }
    // The gateway labels each explicit read with the actual address, followed by its rendered text.
    return value.split(/\n\n(?=viking:\/\/|Memory read status:)/).flatMap(part => {
      const [uri,...lines] = part.split('\n');
      return uri.startsWith('viking://') ? [{uri,text:lines.join('\n')}] : [];
    });
  });
}

export function checkObservation(fixture, answer, review) {
  const unknown = reason => ({qid:fixture.qid,outcome:'unknown',reason});
  if (fixture.missing || !fixture.quote) return unknown('missing_recorded_target');
  if (!answer?.answer || answer.error || answer.question !== fixture.question) return unknown('missing_matching_answer');
  const calls = answer.toolCalls?.filter(call => /^(?:mcp__openviking__)?(?:read|search)$/.test(call.name)) ?? [];
  const allText = [answer.answer,answer.opening?.profileBlock,answer.opening?.residentBlock,
    ...calls.flatMap(call => call.blocks ?? []).map(block => typeof block==='string' ? block : block.text)].filter(Boolean).join('\n');
  const negative = ['withdrawn','shared'].includes(fixture.kind);
  const fail = reason => ({qid:fixture.qid,outcome:'fail',reason});
  if (negative && allText.includes(fixture.quote)) return fail('excluded_span_returned');
  if (!calls.length || calls.some(call => call.isError || !call.blocks?.length)) return unknown('incomplete_tool_response');
  const hits = calls.flatMap(returnedItems).filter(hit => hit.uri?.endsWith('/'+fixture.file) && hit.text?.includes(fixture.quote));
  if (!negative && !hits.length) return fail('target_not_returned');
  if (fixture.kind === 'once' && !hits.every(hit => hit.text.startsWith(marker))) return fail('once_label_missing');
  if (fixture.kind === 'preference' && hits.some(hit => hit.text.startsWith(marker))) return fail('preference_mislabeled');
  const answerHash = recallDigest(answer.answer);
  if (review?.answerHash !== answerHash || review.qid !== fixture.qid || !review.reviewer || !review.evidence
    || typeof review.correct !== 'boolean') return {...unknown('answer_review_required'),answerHash};
  if (negative && review.scopeOrWithdrawalVerified !== true) return unknown('scope_or_withdrawal_proof_required');
  return {qid:fixture.qid,outcome:review.correct ? 'pass' : 'fail', reason:'bound_answer_review',answerHash};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command,bindingsFile,answersDir,reviewsFile] = process.argv.slice(2);
  const read = async file => JSON.parse(await readFile(file,'utf8'));
  if (command === 'bind') {
    const bindings = await bindRecordedCases(bindingsFile);
    process.stdout.write(JSON.stringify(bindings,null,2)+'\n');
    if (new Set(bindings.map(row => row.qid)).size !== 5) process.exitCode = 1;
  } else {
  const fixtures = await observationFixtures(bindingsFile && bindingsFile !== '-' ? await read(bindingsFile) : []);
  if (command === 'prepare') process.stdout.write(JSON.stringify(fixtures,null,2)+'\n');
  else if (command === 'check') {
    const answers = new Map(), reviews = reviewsFile ? await read(reviewsFile) : [];
    for await (const {answer} of answersFrom(answersDir)) {
      if (!fixtures.some(f => f.qid === answer.qid)) continue;
      if (answers.has(answer.qid)) throw Error('multiple answer arms for '+answer.qid);
      answers.set(answer.qid,answer);
    }
    const outcomes = fixtures.map(f => checkObservation(f,answers.get(f.qid),reviews.find(r => r.qid === f.qid)));
    process.stdout.write(JSON.stringify(outcomes,null,2)+'\n');
    if (outcomes.some(r=>r.outcome!=='pass')) process.exitCode=1;
  } else throw Error('usage: bind PACKS_DIR | prepare [bindings.json] | check bindings.json|- RECORDINGS_DIR [reviews.json]');
  }
}
