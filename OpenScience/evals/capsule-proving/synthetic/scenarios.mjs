#!/usr/bin/env node
/**
 * Scenarios the memory templates never mention: does the open retention policy keep what is useful in a domain nobody
 * wrote an example for? The generator first picks domains outside the policy's own examples, then writes, per domain, a
 * short multi-session history and questions whose answers are planted anchors. Code checks every anchor is said by the
 * planned speaker; answers come from the plan, not from the prose.
 *
 *   node synthetic/scenarios.mjs --out DIR --split dev --count 20
 *   node synthetic/scenarios.mjs --out DIR --split sealed --count 60      # prints counts only, never a domain or a question
 *
 * Resumable: the domain list and each batch are files; finished steps are appended to `<out>/STATUS`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { GENERATOR, KIMI_MODEL, callKimi } from './kimi.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]] : a), []));
const out = args.out ?? (() => { throw new Error('--out required'); })();
const split = args.split ?? 'dev';
const count = Number(args.count ?? (split === 'sealed' ? 60 : 20));
const per = 4;
const sealed = split === 'sealed';
const root = join(out, `scenarios-${split}`);
mkdirSync(root, { recursive: true });
const now = () => new Date().toISOString();
const status = (line) => appendFileSync(join(out, 'STATUS'), `${now()} scenarios-${split} ${line}\n`);
const say = (line) => process.stdout.write(`${now()} ${line}\n`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 1)}\n`);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/** The policy's own examples, which the domains must avoid (read from the shared policy text the templates carry). */
const POLICY_EXAMPLES = 'who the user is, how they work, the people and things their work or life revolves around, current states and changes, decisions, constraints, preferences, corrections, useful names, numbers and dates; health (allergies, diagnoses, medications and doses, numeric values, dates, plans, contraindications, wishes); people (one person per file); research projects, documents, data analysis, writing, office files';

const SCENARIO_TYPES = ['stated', 'changed', 'third_party', 'assistant_suggestion', 'detail'];

function domainsPrompt(n, avoid) {
  return `为一个 AI 助手的长期记忆评测，列出 ${n} 个中国普通人生活或工作中会找 AI 助手帮忙、并且之后会希望助手记得相关信息的具体领域/场景。
要求：彼此差异大；不要落在下面这些已经被写进记忆规则示例里的范围：${POLICY_EXAMPLES}。${avoid.length ? `也不要和这些重复：${avoid.join('、')}。` : ''}
例如（只是示意，不要照抄）：宠物就医、装修报价、法律纠纷、课程排期。
只输出 JSON：{"domains": ["…", …]}，每项 4–12 个字。`;
}

function scenarioPrompt(domains, problems) {
  return `为一个 AI 助手的长期记忆评测，每个领域写一个场景：一位虚构的中国用户和助手在几周内的 3–5 场对话（每场 4–8 条消息，用户先说，交替），之后用户会问助手几件事。
领域：${domains.map((d, i) => `${i + 1}. ${d}`).join('；')}

每个场景埋 3 条信息（anchor 是这条信息里一小段要逐字出现的原文，2–15 字，数字用阿拉伯数字，尽量是数字+单位、日期、名称、型号；同一场景内 anchor 互不包含）：
- 类型从 ${SCENARIO_TYPES.join(' / ')} 里选，每个场景至少两种不同类型：stated 用户说的事实；changed 用户先说一个值、后面某场说变了（给 anchor 和 laterAnchor）；third_party 用户说的别人的事；assistant_suggestion 助手给的建议、用户没表态；detail 用户顺口提的一个细节。
- 每条写 "speaker"（stated/changed/third_party/detail 为 user，assistant_suggestion 为 assistant）、"session"（第几场首次出现，从 1 起；changed 再给 "laterSession"）、"question"（很久后用户怎么问，答案应含 anchor；changed 问现在的值）。

只输出 JSON，不要代码块标记：
{"scenarios": [{"domain": "…", "plants": [{"type", "anchor", "laterAnchor"?, "speaker", "session", "laterSession"?, "question"}], "sessions": [{"messages": [{"role": "user"|"assistant", "text": "…"}]}], "abstainQuestion": "一个场景里从没说过的具体问题"}]}
硬性要求：anchor/laterAnchor 在指定场次由指定的一方逐字说出，之前的场次不出现；不要写旁白。${problems ? `\n上次的问题必须改正：${problems}` : ''}`;
}

function scenarioProblems(sc) {
  const p = [];
  if (!nonEmpty(sc?.domain)) p.push('domain missing');
  const sessions = Array.isArray(sc?.sessions) ? sc.sessions : [];
  if (sessions.length < 3 || sessions.length > 5) p.push('need 3–5 sessions');
  for (const s of sessions) if (!Array.isArray(s?.messages) || s.messages.length < 4 || s.messages[0]?.role !== 'user' || s.messages.some((m) => !['user', 'assistant'].includes(m?.role) || !nonEmpty(m?.text))) { p.push('bad session messages'); break; }
  const plants = Array.isArray(sc?.plants) ? sc.plants : [];
  if (plants.length !== 3) p.push('need exactly 3 plants');
  if (new Set(plants.map((x) => x?.type)).size < 2) p.push('need two plant types');
  const anchors = plants.flatMap((x) => [x?.anchor, x?.laterAnchor].filter(nonEmpty));
  for (const a of anchors) for (const b of anchors) if (a !== b && b.includes(a)) p.push(`anchor "${a}" inside "${b}"`);
  const said = (k, role) => (sessions[k - 1]?.messages ?? []).filter((m) => m.role === role).map((m) => m.text).join('\n');
  const before = (k) => sessions.slice(0, k - 1).flatMap((s) => s.messages ?? []).map((m) => m.text).join('\n');
  for (const x of plants) {
    if (!SCENARIO_TYPES.includes(x?.type)) { p.push(`unknown type ${x?.type}`); continue; }
    if (!nonEmpty(x.anchor) || !nonEmpty(x.question)) { p.push('plant needs anchor and question'); continue; }
    const role = x.type === 'assistant_suggestion' ? 'assistant' : 'user';
    if (!said(x.session, role).includes(x.anchor)) p.push(`"${x.anchor}" not said by ${role} in session ${x.session}`);
    if (before(x.session).includes(x.anchor)) p.push(`"${x.anchor}" appears before session ${x.session}`);
    if (x.type === 'changed') {
      if (!nonEmpty(x.laterAnchor) || !(x.laterSession > x.session)) p.push('changed needs laterAnchor and a later laterSession');
      else {
        if (!said(x.laterSession, 'user').includes(x.laterAnchor)) p.push(`"${x.laterAnchor}" not said by user in session ${x.laterSession}`);
        if (before(x.laterSession).includes(x.laterAnchor)) p.push(`"${x.laterAnchor}" appears before session ${x.laterSession}`);
      }
    }
  }
  if (!nonEmpty(sc?.abstainQuestion)) p.push('abstainQuestion missing');
  return p;
}

const domainsFile = join(root, 'domains.json');
let domains;
if (existsSync(domainsFile)) domains = readJson(domainsFile).domains;
else {
  // Sealed domains must differ from dev ones; dev ones are visible, so they are what is avoided.
  const devFile = join(out, 'scenarios-dev', 'domains.json');
  const avoid = sealed && existsSync(devFile) ? readJson(devFile).domains : [];
  const r = await callKimi(domainsPrompt(count + 10, avoid));
  if (!r.ok || !Array.isArray(r.value?.domains)) throw new Error(`domains: ${r.ok ? 'no list' : r.error}`);
  domains = [...new Set(r.value.domains.filter(nonEmpty))].filter((d) => !avoid.includes(d)).slice(0, count);
  if (domains.length < count) throw new Error(`only ${domains.length} domains`);
  writeJson(domainsFile, { generator: GENERATOR, domains });
  status(`DONE domains (${domains.length})`);
}
say(sealed ? `domains: ${domains.length}` : `domains: ${domains.join('、')}`);

const groups = [];
for (let i = 0; i < domains.length; i += per) groups.push(domains.slice(i, i + per));
let failed = 0;
let next = 0;
await Promise.all(Array.from({ length: Number(args.concurrency ?? 3) }, async () => {
  while (next < groups.length) {
    const k = next++;
    const file = join(root, `g${String(k).padStart(2, '0')}.json`);
    if (existsSync(file)) continue;
    let problems = '';
    let done = false;
    for (let attempt = 1; attempt <= 4 && !done; attempt++) {
      const r = await callKimi(scenarioPrompt(groups[k], problems));
      if (!r.ok || !Array.isArray(r.value?.scenarios)) { problems = r.ok ? 'output had no scenarios array' : r.error; say(`g${k} attempt ${attempt}: unusable`); continue; }
      const each = r.value.scenarios.map(scenarioProblems);
      const bad = each.filter((x) => x.length).length + Math.max(0, groups[k].length - r.value.scenarios.length);
      say(`g${k} attempt ${attempt}: ${bad} scenarios with problems (${Math.round(r.ms / 1000)} s)`);
      if (!bad) { writeJson(file, { group: k, attempt, scenarios: r.value.scenarios }); status(`DONE g${k}`); done = true; }
      else problems = each.map((x, i) => (x.length ? `场景${i + 1}：${x.slice(0, 6).join('；')}` : '')).filter(Boolean).join(' | ');
    }
    if (!done) failed++;
  }
}));

// Assemble: runtime input (sessions per scenario, questions) and gold, kept apart.
const input = [];
const gold = [];
let n = 0;
for (let k = 0; k < groups.length; k++) {
  const file = join(root, `g${String(k).padStart(2, '0')}.json`);
  if (!existsSync(file)) continue;
  for (const sc of readJson(file).scenarios) {
    const id = `${split}-sc${String(++n).padStart(3, '0')}`;
    const questions = [];
    sc.plants.forEach((x, i) => {
      questions.push({ qid: `${id}-q${i + 1}`, text: x.question, expect: x.type === 'changed' ? { mustContain: [x.laterAnchor], mustNotContain: [x.anchor] } : x.type === 'assistant_suggestion' ? { mustContain: [x.anchor], judge: 'attributed to the assistant\'s suggestion, not the user\'s decision' } : { mustContain: [x.anchor] }, type: x.type });
    });
    questions.push({ qid: `${id}-q4`, text: sc.abstainQuestion, expect: { judge: 'never stated: must not invent a value' }, type: 'abstain' });
    input.push({ scenarioId: id, sessions: sc.sessions.map((s, i) => ({ sourceSessionId: `${id}-s${i + 1}`, messages: s.messages })), questions: questions.map(({ qid, text }) => ({ qid, text })) });
    gold.push({ scenarioId: id, domain: sc.domain, questions, plants: sc.plants });
  }
}
writeJson(join(root, 'input.json'), { schema: 'capsule-proving-scenarios-input/1', split, scenarios: input });
writeJson(join(root, 'gold.json'), { schema: 'capsule-proving-scenarios-gold/1', split, scenarios: gold });
const sha = (f) => createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
writeJson(join(root, 'manifest.json'), { split, scenarios: input.length, questions: gold.reduce((a, s) => a + s.questions.length, 0), failedGroups: failed, generator: GENERATOR, sha256: { 'input.json': sha('input.json'), 'gold.json': sha('gold.json') } });
status(`DONE assemble (${input.length} scenarios, ${failed} groups failed)`);
say(`assembled ${input.length} scenarios, ${failed} groups failed`);
if (failed) process.exitCode = 1;
