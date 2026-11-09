#!/usr/bin/env node
/**
 * Repeated-task families for the learning loop: the same kind of work asked again in later conversations after one
 * correction. Does the next attempt follow the correction without being told? Each family carries its first request, the
 * person's correction, four later requests that never mention it, and a check: a closed format check code can decide
 * (a date pattern, a length bound, a leading phrase, a table, a closing line) or a rubric for the offline judge.
 *
 *   node synthetic/tasks.mjs --out DIR --split dev --count 6
 *   node synthetic/tasks.mjs --out DIR --split sealed --count 14     # prints counts only
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { GENERATOR, KIMI_MODEL, callKimi } from './kimi.mjs';
import { CHECK_KINDS } from './taskChecks.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]] : a), []));
const out = args.out ?? (() => { throw new Error('--out required'); })();
const split = args.split ?? 'dev';
const count = Number(args.count ?? (split === 'sealed' ? 14 : 6));
const sealed = split === 'sealed';
const root = join(out, `tasks-${split}`);
mkdirSync(root, { recursive: true });
const now = () => new Date().toISOString();
const status = (line) => appendFileSync(join(out, 'STATUS'), `${now()} tasks-${split} ${line}\n`);
const say = (line) => process.stdout.write(`${now()} ${line}\n`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 1)}\n`);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

function familyProblems(f) {
  const p = [];
  for (const k of ['family', 'firstRequest', 'correction']) if (!nonEmpty(f?.[k])) p.push(`${k} missing`);
  const c = f?.check ?? {};
  if (!(c.kind in CHECK_KINDS)) p.push(`check.kind must be one of ${Object.keys(CHECK_KINDS).join('/')}`);
  if (c.kind === 'judge' && !nonEmpty(c.rubric)) p.push('judge check needs rubric');
  if (['pattern', 'forbidPattern'].includes(c.kind)) { try { new RegExp(c.value, 'u'); } catch { p.push('check.value is not a valid regular expression'); } }
  if (c.kind === 'maxChars' && !(Number(c.value) > 0)) p.push('maxChars needs a positive number');
  if (['startsWith', 'endsWith'].includes(c.kind) && !nonEmpty(c.value)) p.push(`${c.kind} needs value`);
  const later = Array.isArray(f?.laterRequests) ? f.laterRequests : [];
  if (later.length !== 4 || later.some((x) => !nonEmpty(x))) p.push('need exactly 4 laterRequests');
  if (nonEmpty(f?.ruleKeyword)) for (const x of later) if (x.includes(f.ruleKeyword)) p.push('a later request mentions the rule');
  if (!nonEmpty(f?.ruleKeyword)) p.push('ruleKeyword missing');
  if (nonEmpty(f?.firstRequest) && nonEmpty(f?.ruleKeyword) && f.firstRequest.includes(f.ruleKeyword)) p.push('the first request already states the rule');
  return p;
}

function prompt(n, avoid, problems) {
  return `为一个 AI 助手"从纠正中学习"的评测，设计 ${n} 类中国用户会反复找助手做的工作或生活任务（彼此差异大，七成通用、三成医学相关${avoid.length ? `；不要和这些重复：${avoid.join('、')}` : ''}）。
每类：用户第一次提出请求（附上做这件事需要的全部材料，比如要整理的笔记原文、数据、要回复的邮件），助手做完后用户给出一句具体纠正；之后在另外的对话里，用户又 4 次提出同类请求（各自附新材料），但不再提那条纠正。我们看助手后几次会不会自己照纠正做。

纠正要具体、可检验，并给出检查方式 check，kind 只能是：
${Object.entries(CHECK_KINDS).map(([k, v]) => `- ${k}：${v}`).join('\n')}
尽量用代码能判的格式检查（日期写法、编号方式、字数上限、开头/结尾固定字样、要表格），只有无法用格式表达时才用 judge。pattern 只能检查格式，不能检查意思。

只输出 JSON，不要代码块标记：
{"families": [{"family": "任务类名", "medical": true|false, "firstRequest": "…（含材料）", "correction": "用户的纠正原话", "ruleKeyword": "纠正里最有辨识度的几个字（后续请求里不能出现）", "check": {"kind": "…", "value": "…", "rubric": "仅 judge 需要"}, "laterRequests": ["…（含新材料）", "…", "…", "…"]}]}${problems ? `\n上次的问题必须改正：${problems}` : ''}`;
}

const file = join(root, 'families.json');
if (!existsSync(file)) {
  const devFile = join(out, 'tasks-dev', 'families.json');
  const avoid = sealed && existsSync(devFile) ? readJson(devFile).families.map((f) => f.family) : [];
  const families = [];
  let problems = '';
  for (let attempt = 1; attempt <= 6 && families.length < count; attempt++) {
    const r = await callKimi(prompt(Math.min(7, count - families.length), [...avoid, ...families.map((f) => f.family)], problems));
    if (!r.ok || !Array.isArray(r.value?.families)) { problems = r.ok ? 'no families array' : r.error; say(`attempt ${attempt}: unusable`); continue; }
    const notes = [];
    for (const f of r.value.families) { const p = familyProblems(f); if (p.length) notes.push(`${f.family ?? '?'}：${p.join('；')}`); else if (families.length < count) families.push(f); }
    problems = notes.join(' | ');
    say(`attempt ${attempt}: kept ${families.length}/${count}, rejected ${notes.length} (${Math.round(r.ms / 1000)} s)`);
  }
  if (families.length < count) throw new Error(`only ${families.length} families pass`);
  writeJson(file, { schema: 'capsule-proving-task-families/1', split, generator: GENERATOR, families });
  status(`DONE families (${families.length})`);
}
const doc = readJson(file);
const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
const kinds = doc.families.reduce((m, f) => ({ ...m, [f.check.kind]: (m[f.check.kind] ?? 0) + 1 }), {});
writeJson(join(root, 'manifest.json'), { split, families: doc.families.length, laterRequests: doc.families.length * 4, checkKinds: kinds, medical: doc.families.filter((f) => f.medical).length, sha256: { 'families.json': sha } });
say(sealed ? `${doc.families.length} families, checks ${JSON.stringify(kinds)}` : doc.families.map((f) => `${f.family} [${f.check.kind}] ${f.correction}`).join('\n'));
