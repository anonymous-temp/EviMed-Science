#!/usr/bin/env node
// One page over every LX output directory that exists: L1 ring x link per arm (with the first broken link and the record that
// shows it), L10 per family, L5 per item, L2 per person-arm, and the account spend. Read-only.
//   node evals/capsule-proving/lx/report.mjs [--runs /srv/evimed/runs] > /srv/evimed/runs/lx-REPORT.md
import fs from 'node:fs';
import path from 'node:path';
import { L1_LINKS } from './verdicts.mjs';

const runs = process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : '/srv/evimed/runs';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const units = dir => fs.existsSync(`${dir}/units`) ? fs.readdirSync(`${dir}/units`).filter(n => !n.includes('.attempt-')).map(n => ({ id: n, v: read(`${dir}/units/${n}/verdict.json`), p: read(`${dir}/units/${n}/progress.json`) })) : [];
const cost = vs => vs.reduce((n, v) => n + (v?.usage?.account?.actualCost ?? 0), 0);
const out = [];
const say = line => out.push(line);
for (const [exp, arms] of Object.entries({ l1: ['tc-on', 'tc-off'], l10: ['tc-on', 'tc-off'], l5: ['base'], l2: ['evolve', 'frozen', 'add-only'] })) {
  for (const arm of arms) {
    const dir = path.join(runs, `lx-${exp}-${arm}-1`);
    if (!fs.existsSync(dir)) { say(`\n## ${exp} ${arm}: not started`); continue; }
    const us = units(dir);
    const done = us.filter(u => u.v);
    say(`\n## ${exp} ${arm}: ${done.length}/${us.length} units with a verdict; account spend CNY ${cost(done.map(u => u.v)).toFixed(3)}`);
    for (const u of us.filter(u => !u.v)) say(`- running/unfinished: ${u.id} (steps done: ${Object.keys(u.p?.steps ?? {}).join(',') || '-'}; in flight: ${u.p?.inFlight ?? '-'})`);
    if (exp === 'l1') {
      say(`| ring | ${L1_LINKS.join(' | ')} | first broken |`);
      say(`|---|${L1_LINKS.map(() => '---').join('|')}|---|`);
      for (const { v } of done.filter(u => u.v.links)) say(`| ${v.ring} | ${L1_LINKS.map(k => (v.links[k].expected ? (v.links[k].reached ? 'Y' : 'N') : '-')).join(' | ')} | ${v.firstBroken ?? '-'} |`);
      for (const { v } of done.filter(u => u.v.links && u.v.firstBroken)) say(`- ${v.ring} broken at ${v.firstBroken}: ${v.links[v.firstBroken].evidence}`);
      for (const { v } of done.filter(u => u.v.links)) {
        const later = L1_LINKS.filter(k => v.links[k].expected && v.links[k].reached === false && k !== v.firstBroken);
        if (later.length) say(`  - ${v.ring} also: ${later.map(k => `${k} (${v.links[k].evidence.slice(0, 160)})`).join('; ')}`);
      }
      for (const { v } of done.filter(u => u.v.ring === 'sleep(seeded)')) say(`- sleep(seeded): consolidated=${v.consolidated}; sleep job ${v.sleepJob?.status} ${JSON.stringify(v.sleepJob?.result ?? v.sleepJob?.error ?? null).slice(0, 300)}; statuses ${JSON.stringify(v.statuses)}`);
    } else if (exp === 'l10') {
      say('| family | routine lessons | learned | expected | false routine | chain before | chain after (mounted?) |');
      say('|---|---|---|---|---|---|---|');
      for (const { v } of done) say(`| ${v.family} | ${v.lessons} | ${v.routinesLearned} | ${v.expectedRoutines} | ${v.falseRoutine} | ${(v.chainBefore ?? []).join('>')} | ${(v.chainAfter ?? []).join('>')} (${(v.probeMount ?? []).map(m => `${m.name}:${m.selected ? 'sel' : '-'}/${m.opened ? 'open' : '-'}`).join(',') || 'no routine'}) |`);
      for (const { v } of done) say(`- ${v.family} fingerprints: ${v.fingerprints.map(f => `${f.run}=${f.verdict}:${(f.toolchain ?? []).join('>') || 'none'}[${(f.chain ?? []).join('>')}]`).join(' ')}; lessons ${JSON.stringify(v.rows)}`);
    } else if (exp === 'l5') {
      say('| item | class | shouldStop | stopped (after task) | final | follow-up verdicts | counters | mounted/opened per task |');
      say('|---|---|---|---|---|---|---|---|');
      for (const { v } of done) say(`| ${v.id} | ${v.class} | ${v.shouldStop} | ${v.stopped}${v.stopped ? ` (${v.stoppedAfterTask})` : ''} | ${v.finalStatus} | ${v.verdicts.join(',')} | clean=${v.counts.appliedClean ?? 0} corr=${v.counts.appliedCorrected ?? 0} read=${v.counts.read ?? 0} carried=${v.counts.carried ?? 0} | ${v.mounts.map(m => `${m.selected ? 'S' : '-'}${m.opened ? 'O' : '-'}${m.status === 'succeeded' ? '' : `(${m.status})`}`).join(' ')} |`);
      for (const { v } of done) if (v.lessons.length) say(`- ${v.id} lessons: ${JSON.stringify(v.lessons)}`);
    } else {
      say('| person | corrections per session | first-time-right | frozen compliance | probe leaks / positive checks | methods (status) |');
      say('|---|---|---|---|---|---|');
      for (const { v } of done) say(`| ${v.id} | ${v.correctionsPerSession.join(' ')} | ${v.firstTimeRight?.toFixed(2)} | ${v.frozenCompliance?.toFixed(2)} | ${v.probeLeaks.length}/${v.probePositiveChecks} | ${v.methods.map(m => `${m.name}:${m.status}`).join(', ')} |`);
    }
  }
}
process.stdout.write(`# LX learning-loop experiments (product path, dev data)\n${out.join('\n')}\n`);
