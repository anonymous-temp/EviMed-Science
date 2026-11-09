#!/usr/bin/env node
/**
 * Learning-loop and general-baseline data. Content is written by Kimi; code decides every rule, validates it and derives gold.
 *
 *   L2  hidden-rule simulated users (MultiSessionCollab design, SkillPyramid's three curves): each person has 3 hidden rules
 *       that a closed format check decides, 12 session requests in project A, 3 frozen-phase tasks, 2 project-B probes.
 *       node synthetic/learnsets.mjs --set l2 --split dev|sealed --out DIR --count N --concurrency 2
 *   L1 / L4 / L5 / L10  the learning-loop sets of plan 5.5 (rings, library scale, bad methods, tool chains): see learnsets-loop.mjs
 *       node synthetic/learnsets.mjs --set l1|l5|l10 --split dev|sealed --out DIR ;  --set l4 --out DIR
 *   G10 seed memories for the 29 general-task cases (one set, no split: the cases are public).
 *       node synthetic/learnsets.mjs --set g10 --out DIR
 *
 * Runtime input is separate from gold: `inputs.json` carries what a run sees, `persons.json` carries rules, checks, correction
 * lines and gold. A sealed split prints counts only. Resumable: each step is a file, finished steps go to `<out>/STATUS`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATOR, KIMI_MODEL, callKimi } from './kimi.mjs';
import { CHECK_KINDS, checkReply } from './taskChecks.mjs';
import * as loop from './learnsets-loop.mjs';

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
export const RULE_KINDS = ['pattern', 'forbidPattern', 'maxChars', 'startsWith', 'endsWith', 'table'];
export const L2_COUNTS = { rules: 3, sessions: 12, frozen: 3, probes: 2, minSessionsPerRule: 4 };
export const G10_COUNTS = { min: 8, max: 15, relevantMin: 2, relevantMax: 4, maxChars: 60 };

// ---------- L2: validators (pure) ----------

/** The check object of one rule, in the shape `checkReply` reads; problems as strings. */
export function checkProblems(c) {
  const p = [];
  if (!c || !RULE_KINDS.includes(c.kind)) return [`check.kind must be one of ${RULE_KINDS.join('/')}`];
  if (['pattern', 'forbidPattern'].includes(c.kind)) { try { new RegExp(c.value, 'u'); } catch { p.push('check.value is not a valid regular expression'); } }
  if (c.kind === 'maxChars' && !(Number(c.value) >= 20 && Number(c.value) <= 300)) p.push('maxChars needs a number between 20 and 300');
  if (['startsWith', 'endsWith'].includes(c.kind) && !nonEmpty(c.value)) p.push(`${c.kind} needs value`);
  if (c.kind === 'table' && c.value != null && c.value !== '') p.push('table takes no value');
  return p;
}

/** One rule's problems: the check must be valid, the passing example must pass and the failing one must fail. */
export function ruleProblems(r) {
  const p = [];
  const tag = r?.id ?? '?';
  for (const k of ['id', 'description', 'passExample', 'failExample', 'correctionFirst', 'correctionClear']) if (!nonEmpty(r?.[k])) p.push(`${tag}: ${k} missing`);
  const cp = checkProblems(r?.check);
  if (cp.length) return [...p, ...cp.map((x) => `${tag}: ${x}`)];
  if (nonEmpty(r.passExample) && checkReply(r.check, r.passExample) !== true) p.push(`${tag}: passExample does not pass the check`);
  if (nonEmpty(r.failExample) && checkReply(r.check, r.failExample) !== false) p.push(`${tag}: failExample does not fail the check`);
  if (nonEmpty(r.correctionFirst) && r.correctionFirst === r.correctionClear) p.push(`${tag}: the two correction levels are identical`);
  if (nonEmpty(r.correctionClear) && nonEmpty(r.correctionFirst) && r.correctionClear.length <= r.correctionFirst.length) p.push(`${tag}: correctionClear must be the clearer, longer line`);
  return p;
}

/** The persona/rules call: three rules with distinct kinds, and one reply that satisfies all three together. */
export function rulesProblems(doc, kinds) {
  const p = [];
  for (const k of ['name', 'occupation', 'city', 'bio']) if (!nonEmpty(doc?.persona?.[k])) p.push(`persona.${k} missing`);
  for (const j of ['projectA', 'projectB']) for (const k of ['title', 'goal']) if (!nonEmpty(doc?.[j]?.[k])) p.push(`${j}.${k} missing`);
  const rules = Array.isArray(doc?.rules) ? doc.rules : [];
  if (rules.length !== L2_COUNTS.rules) return [...p, `need exactly ${L2_COUNTS.rules} rules`];
  const ids = rules.map((r) => r?.id);
  if (new Set(ids).size !== ids.length || ids.some((x, i) => x !== `r${i + 1}`)) p.push('rule ids must be r1, r2, r3');
  for (const r of rules) p.push(...ruleProblems(r));
  if (kinds) rules.forEach((r, i) => { if (r?.check?.kind !== kinds[i]) p.push(`rule r${i + 1} must use check kind ${kinds[i]}`); });
  if (!p.length) {
    if (!nonEmpty(doc.combinedExample)) p.push('combinedExample missing');
    else for (const r of rules) if (checkReply(r.check, doc.combinedExample) !== true) p.push(`combinedExample does not satisfy ${r.id}`);
  }
  return p;
}

/** The literal text of a rule a request must never state (startsWith/endsWith/literal patterns). */
const leakTexts = (rules) => rules.flatMap((r) => (['startsWith', 'endsWith'].includes(r.check.kind) ? [r.check.value] : []));

/** Sessions, frozen tasks and probes; every rule applies in at least four sessions; no request states a rule. */
export function requestsProblems(doc, rules) {
  const p = [];
  const ids = rules.map((r) => r.id);
  const sessions = Array.isArray(doc?.sessions) ? doc.sessions : [];
  const frozen = Array.isArray(doc?.frozen) ? doc.frozen : [];
  const probes = Array.isArray(doc?.probes) ? doc.probes : [];
  if (sessions.length !== L2_COUNTS.sessions) p.push(`need exactly ${L2_COUNTS.sessions} sessions`);
  if (frozen.length !== L2_COUNTS.frozen) p.push(`need exactly ${L2_COUNTS.frozen} frozen tasks`);
  if (probes.length !== L2_COUNTS.probes) p.push(`need exactly ${L2_COUNTS.probes} probes`);
  const all = [...sessions, ...frozen, ...probes];
  if (all.some((x) => !nonEmpty(x?.request) || x.request.length < 20)) p.push('every request needs real text (20+ characters)');
  const per = Object.fromEntries(ids.map((i) => [i, 0]));
  sessions.forEach((s, i) => {
    const rs = Array.isArray(s?.rules) ? s.rules : [];
    if (!rs.length || rs.some((x) => !ids.includes(x)) || new Set(rs).size !== rs.length) p.push(`session ${i + 1}: rules must be a non-empty list of ${ids.join('/')}`);
    for (const x of rs) if (x in per) per[x]++;
  });
  for (const [id, n] of Object.entries(per)) if (n < L2_COUNTS.minSessionsPerRule) p.push(`rule ${id} applies in only ${n} sessions (need ${L2_COUNTS.minSessionsPerRule}+)`);
  probes.forEach((x, i) => {
    const u = Array.isArray(x?.unnaturalFor) ? x.unnaturalFor : [];
    if (!u.length || u.some((v) => !ids.includes(v))) p.push(`probe ${i + 1}: unnaturalFor must list the rule ids whose form is unnatural here`);
  });
  const texts = new Set();
  for (const x of all) { if (texts.has(x?.request)) p.push('duplicate request'); texts.add(x?.request); }
  for (const r of rules) if (r.check.kind === 'pattern') for (const x of all) if (nonEmpty(x?.request) && new RegExp(r.check.value, 'u').test(x.request)) p.push(`${r.id}: a request already contains the required format (it hands over the rule); write dates, numbers and labels in the requests another way`);
  for (const t of leakTexts(rules)) for (const x of all) if (nonEmpty(x?.request) && x.request.includes(t)) p.push(`a request contains the rule text 「${t}」`);
  return p;
}

// ---------- L2: gold and the runtime simulated user (pure) ----------

/** Gold from structure only: per session the applicable checks; per frozen task all rules; per probe the leak checks. */
export function deriveGold(person) {
  const byId = Object.fromEntries(person.rules.map((r) => [r.id, r]));
  const entry = (r) => ({ ruleId: r.id, check: r.check });
  return {
    sessions: person.sessions.map((s, index) => ({ index, checks: s.rules.map((id) => entry(byId[id])) })),
    frozen: person.frozen.map((_, index) => ({ index, checks: person.rules.map(entry) })),
    probes: person.probes.map((x, index) => ({
      index,
      // A passing rule check in a project where the rule does not apply is a possible leak; `unnatural` marks the rules whose form the request makes unnatural.
      leakChecks: person.rules.map((r) => ({ ...entry(r), unnatural: x.unnaturalFor.includes(r.id) })),
    })),
  };
}

/**
 * The runtime simulated user, no model: for the session's applicable rules, the first one the reply violates gets one
 * correction. `priorCorrections` lists the rule ids already corrected earlier (every earlier turn counts); a rule corrected
 * before is answered with the clearer line. Returns `{ line, ruleId, level }` or null.
 */
export function simulateUserTurnDetailed(person, sessionIndex, reply, priorCorrections = []) {
  const session = person.sessions[sessionIndex];
  if (!session) return null;
  for (const id of session.rules) {
    const rule = person.rules.find((r) => r.id === id);
    if (!rule || checkReply(rule.check, reply) !== false) continue;
    const level = priorCorrections.includes(id) ? 'clear' : 'first';
    return { line: level === 'clear' ? rule.correctionClear : rule.correctionFirst, ruleId: id, level };
  }
  return null;
}

/** The correction line to send, or null. */
export const simulateUserTurn = (person, sessionIndex, reply, priorCorrections = []) => simulateUserTurnDetailed(person, sessionIndex, reply, priorCorrections)?.line ?? null;

/** What a run sees: persona, project names and requests; no rule, check or correction. */
export function runtimeInput(person) {
  return {
    id: person.id,
    persona: person.persona,
    projectA: person.projectA,
    projectB: person.projectB,
    sessions: person.sessions.map((s) => s.request),
    frozen: person.frozen.map((s) => s.request),
    probes: person.probes.map((s) => s.request),
  };
}

/** Three distinct kinds per person, rotated by code so the rules differ across people. */
export function kindTrio(index, offset = 0) {
  const combos = [];
  for (let a = 0; a < RULE_KINDS.length; a++) for (let b = a + 1; b < RULE_KINDS.length; b++) for (let c = b + 1; c < RULE_KINDS.length; c++) combos.push([RULE_KINDS[a], RULE_KINDS[b], RULE_KINDS[c]]);
  const pick = combos[(index * 7 + offset) % combos.length];
  return [pick[(index) % 3], pick[(index + 1) % 3], pick[(index + 2) % 3]];
}

const KIND_GUIDE = {
  pattern: '回复里必须出现某种固定格式（例如日期写成 YYYY/MM/DD、编号写成【1】、金额带“元整”）；value 是正则',
  forbidPattern: '回复里不能出现某类词或写法（例如禁用“您好”“首先”“总之”、禁用感叹号）；value 是正则',
  maxChars: '回复去掉空白后不超过 N 个字；value 是数字（20–300）',
  startsWith: '回复第一行必须以固定字样开头（例如“结论：”）；value 是这段字样',
  endsWith: '回复最后一行必须以固定字样结尾（例如“——如需调整请直说”）；value 是这段字样',
  table: '回复里必须有一张 Markdown 表格；不需要 value',
};

export function rulesPrompt(kinds, avoid, problems) {
  return `为一个 AI 助手“从纠正中学会隐藏偏好”的评测设计一位虚构的中国用户。他有两个项目：项目 A（日常反复找助手做事）和项目 B（完全不同的另一件事）。
他有 3 条隐藏规则，助手事先不知道，要靠用户在对话里纠正才能学会。规则必须能被代码判定，类型依次是：
${kinds.map((k, i) => `- r${i + 1}（${k}）：${KIND_GUIDE[k]}`).join('\n')}
规则要求：
- 默认的助手回复几乎不可能碰巧满足（不要“语气礼貌”“结构清晰”这种；要具体的格式或字数）。
- 三条规则必须能同时满足；同时给出一段 combinedExample（80–200 字，一个自然的回复）同时满足三条。
- 每条规则给：description（一句话说明规则）、check（kind 和 value）、passExample（满足本条的短回复）、failExample（一个看起来正常、但违反本条的回复，注意：很多助手默认就会这样写）、correctionFirst（用户第一次发现违反时说的话，只透露一部分，像真人：口语、不完整，例如“怎么又这么长”，不要把完整规则讲出来）、correctionClear（用户第二次纠正时说的话，更明确地说清规则，必须比 correctionFirst 长）。
- check 的 value 是严格匹配用的：pattern/forbidPattern 的 value 是能被 JS 正则编译的字符串（JSON 里反斜杠要写成双反斜杠）；startsWith/endsWith 的 value 是逐字文本。
人物：${avoid.length ? `不要和这些人物的职业或项目重复：${avoid.join('；')}。` : ''}职业、城市、年龄各异，项目 A 是他工作或生活里每周都要做的一类事。bio 一两句，不要写联系方式。
只输出 JSON，不要代码块标记：
{"persona": {"name": "…", "occupation": "…", "city": "…", "bio": "…"}, "projectA": {"title": "…", "goal": "…"}, "projectB": {"title": "…", "goal": "…"}, "rules": [{"id": "r1", "description": "…", "check": {"kind": "${kinds[0]}", "value": "…"}, "passExample": "…", "failExample": "…", "correctionFirst": "…", "correctionClear": "…"}, …共 3 条…], "combinedExample": "…"}${problems ? `\n上次的问题必须改正：${problems}` : ''}`;
}

export function requestsPrompt(person, problems) {
  const { persona, projectA, projectB, rules } = person;
  return `继续上面的评测设计。人物：${persona.name}，${persona.occupation}，${persona.city}。${persona.bio}
项目 A：${projectA.title}（${projectA.goal}）。项目 B：${projectB.title}（${projectB.goal}）。
他的 3 条隐藏规则（用户对助手从不直接宣布，请求里更不能出现）：
${rules.map((r) => `${r.id}：${r.description}`).join('\n')}

请写他给助手的请求（中文，口语，每条 40–200 字，带上做这件事要用的全部材料，比如要改的文字、数据、要回复的消息；不同条之间的材料和任务要不同）：
1. sessions：项目 A 里的 12 个会话请求。每条标 "rules"：这个请求里哪几条规则适用（如 ["r1","r3"]，1–2 条）。适用的意思是：助手按规则写回复是自然的、可行的。每条规则必须适用于至少 4 个会话。
2. frozen：3 个项目 A 的新任务（形式和 sessions 不同的新活儿），三条规则都仍然适用。
3. probes：2 个项目 B 的请求，三条规则都不适用，并且让按规则写的形式不自然或根本没被要求（例如规则 r1 要求“结论：”开头，而项目 B 的请求是让助手写一首短诗或一段代码）。每个标 "unnaturalFor"：哪几条规则的形式在这个请求里不自然（尽量列全）。
请求里不能出现规则要求的格式本身（例如规则要求日期写成 YYYY/MM/DD，请求里的日期就写成“11月9日”；规则要求编号写成【1】，请求里就不要出现【1】），也不能出现规则的原文或暗示（不要说“用表格”“不超过 N 字”“以某某开头”之类），不要写联系方式。
只输出 JSON，不要代码块标记：
{"sessions": [{"request": "…", "rules": ["r1"]}, …共 12 条…], "frozen": [{"request": "…"}, …共 3 条…], "probes": [{"request": "…", "unnaturalFor": ["r1","r2","r3"]}, …共 2 条…]}${problems ? `\n上次的问题必须改正：${problems}` : ''}`;
}

// ---------- G10: validators (pure) ----------

const SECRET_SHAPES = [/\b\d{11,}\b/, /\b\d{17}[\dXx]\b/, /[\w.+-]+@[\w-]+\.[\w.]+/, /\bsk-[A-Za-z0-9_-]{8,}/, /\b[A-Za-z0-9_-]{24,}\b/, /\b(?:password|passwd|token|secret|api[_ -]?key)\b/i, /(?:密码|密钥|口令|身份证号|银行卡号)/];
export const secretShaped = (s) => SECRET_SHAPES.some((re) => re.test(s));

/** Longest common substring length of two strings (code points). */
export function longestCommon(a, b) {
  const x = [...a];
  const y = [...b];
  let best = 0;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) if (x[i - 1] === y[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}

/** The task's own words: every turn's text and the case's pass_text. */
export const caseText = (c) => [...(c.turns ?? []).map((t) => t.text ?? ''), c.pass_text ?? ''].join('\n');
export const caseSha = (c) => createHash('sha256').update(`${c.id}\n${caseText(c)}`).digest('hex');

/** Seed statements of one case: 8–15 short first-person lines, 2–4 relevant, nothing carrying the task or a secret shape. */
export function seedProblems(doc, c, { sharedMax = 10 } = {}) {
  const p = [];
  const st = Array.isArray(doc?.statements) ? doc.statements : [];
  if (st.length < G10_COUNTS.min || st.length > G10_COUNTS.max) p.push(`need ${G10_COUNTS.min}-${G10_COUNTS.max} statements, got ${st.length}`);
  const text = caseText(c);
  const seen = new Set();
  st.forEach((s, i) => {
    const t = s?.text;
    const tag = `#${i + 1}`;
    if (!nonEmpty(t)) return p.push(`${tag}: text missing`);
    if (typeof s.relevant !== 'boolean') p.push(`${tag}: relevant must be true or false`);
    if ([...t].length >= G10_COUNTS.maxChars) p.push(`${tag}: ${[...t].length} characters, must be under ${G10_COUNTS.maxChars}`);
    if (!/我/.test(t)) p.push(`${tag}: not first person`);
    if (secretShaped(t)) p.push(`${tag}: secret-shaped`);
    if (seen.has(t)) p.push(`${tag}: duplicate`);
    seen.add(t);
    const shared = longestCommon(t, text);
    if (shared >= sharedMax) p.push(`${tag}: shares ${shared} characters with the task text`);
  });
  const rel = st.filter((s) => s?.relevant === true).length;
  if (rel < G10_COUNTS.relevantMin || rel > G10_COUNTS.relevantMax) p.push(`need ${G10_COUNTS.relevantMin}-${G10_COUNTS.relevantMax} relevant statements, got ${rel}`);
  if (c.kind === 'medical' && !st.some((s) => s?.medical === true)) p.push('a medical control needs at least one statement with medical:true (a medical background)');
  return p;
}

export function seedPrompt(c, problems) {
  const medical = c.kind === 'medical';
  return `为一个 AI 助手的评测写“用户的长期记忆”：助手记下的、关于这位用户的几句话。任务是下面这位用户之后会提的，但记忆里不能出现这个任务本身。
任务（仅供你判断哪些记忆相关，不要复述）：
${(c.turns ?? []).map((t, i) => `${i + 1}. ${t.text}`).join('\n').slice(0, 1800)}

要求：
- 8–15 条第一人称短句（每条少于 60 个字，含“我”），像助手从多次对话里记下的：个人背景、做事偏好（语气、格式、篇幅）、项目事实、使用习惯。
- 每条标 "relevant"：true 表示和上面这个任务有关（例如一条说明的语气或格式偏好，或回复可以用上的背景事实），false 表示无关（别的生活或工作细节）。relevant 为 true 的恰好 2–4 条，其余为 false。无关的要具体而真实，不要空话。
- 记忆里不能含任务的指令、任务里的材料或答案，不能和任务原文有连续 10 个字以上相同；不能含密码、证件号、银行卡、手机号、邮箱、密钥。${medical ? '\n- 这是医学任务：记忆里要有医学背景（如职业、专业方向、相关的诊疗或用药情况）；这类条目标 "medical": true。' : ''}
只输出 JSON，不要代码块标记：
{"statements": [{"text": "我…", "relevant": true|false${medical ? ', "medical": true|false' : ''}}, …]}${problems ? `\n上次的问题必须改正：${problems}` : ''}`;
}

// ---------- runners ----------

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 1)}\n`);
const now = () => new Date().toISOString();
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const stats = { calls: 0, retries: 0, failures: 0 };

/** Ask Kimi until the validator passes (at most `tries` calls); the problems are fed back into the next prompt. */
async function ask(label, makePrompt, validate, say, tries = 6) {
  let problems = '';
  for (let attempt = 1; attempt <= tries; attempt++) {
    stats.calls++;
    if (attempt > 1) stats.retries++;
    const r = await callKimi(makePrompt(problems));
    if (!r.ok) { stats.failures++; problems = r.error.slice(0, 300); say(`${label} attempt ${attempt}: unusable`); continue; }
    const p = validate(r.value);
    if (!p.length) { say(`${label} attempt ${attempt}: ok (${Math.round(r.ms / 1000)} s)`); return r.value; }
    stats.failures++;
    problems = p.slice(0, 8).join('；');
    say(`${label} attempt ${attempt}: ${p.length} problems`);
  }
  throw new Error(`${label}: no valid reply after ${tries} calls`);
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await fn(queue.shift()); }));
}

async function runL2(args) {
  const out = args.out ?? (() => { throw new Error('--out required'); })();
  const split = args.split ?? 'dev';
  const sealed = split === 'sealed';
  const count = Number(args.count ?? (sealed ? 12 : 4));
  const concurrency = Math.min(2, Number(args.concurrency ?? 2));
  const root = join(out, `l2-${split}`);
  mkdirSync(root, { recursive: true });
  const status = (line) => appendFileSync(join(out, 'STATUS'), `${now()} ${split} DONE ${line}\n`);
  const say = (line) => process.stdout.write(`${now()} ${line}\n`);
  const offset = sealed ? 10 : 0;
  const avoid = sealed && existsSync(join(out, 'l2-dev', 'persons.json')) ? readJson(join(out, 'l2-dev', 'persons.json')).persons.map((x) => `${x.persona.occupation}/${x.projectA.title}`) : [];
  const personFile = (i) => join(root, `person-${String(i + 1).padStart(2, '0')}.json`);
  await pool(Array.from({ length: count }, (_, i) => i), concurrency, async (i) => {
    if (existsSync(personFile(i))) return;
    const kinds = kindTrio(i, offset);
    const id = `${sealed ? 'S' : 'D'}${String(i + 1).padStart(2, '0')}`;
    const base = await ask(`${id} rules`, (pr) => rulesPrompt(kinds, avoid, pr), (d) => rulesProblems(d, kinds), say);
    const person = { id, persona: base.persona, projectA: base.projectA, projectB: base.projectB, rules: base.rules, combinedExample: base.combinedExample };
    const req = await ask(`${id} requests`, (pr) => requestsPrompt(person, pr), (d) => requestsProblems(d, person.rules), say);
    Object.assign(person, { sessions: req.sessions, frozen: req.frozen, probes: req.probes });
    writeJson(personFile(i), person);
    status(`l2 ${id} person`);
  });
  const persons = Array.from({ length: count }, (_, i) => readJson(personFile(i)));
  const golds = persons.map((x) => ({ id: x.id, ...deriveGold(x) }));
  writeJson(join(root, 'persons.json'), { schema: 'capsule-proving-l2-persons/1', split, generator: GENERATOR, persons });
  writeJson(join(root, 'inputs.json'), { schema: 'capsule-proving-l2-inputs/1', split, people: persons.map(runtimeInput) });
  writeJson(join(root, 'gold.json'), { schema: 'capsule-proving-l2-gold/1', split, people: golds });
  const kindsUsed = persons.flatMap((x) => x.rules.map((r) => r.check.kind)).reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
  writeJson(join(root, 'manifest.json'), {
    split, people: persons.length, rules: persons.length * 3, sessions: persons.length * 12, frozen: persons.length * 3, probes: persons.length * 2, checkKinds: kindsUsed,
    sha256: Object.fromEntries(['persons.json', 'inputs.json', 'gold.json'].map((f) => [f, sha256(join(root, f))])), kimi: stats,
  });
  status(`l2 manifest (${persons.length} people)`);
  say(sealed ? `${persons.length} people, checks ${JSON.stringify(kindsUsed)}, kimi ${JSON.stringify(stats)}` : persons.map((x) => `${x.id} ${x.persona.occupation} / ${x.projectA.title} | ${x.rules.map((r) => `${r.check.kind}:${r.description}`).join(' | ')}`).join('\n'));
}

async function runG10(args) {
  const out = args.out ?? (() => { throw new Error('--out required'); })();
  const root = join(out, 'g10-seeds');
  mkdirSync(root, { recursive: true });
  const status = (line) => appendFileSync(join(out, 'STATUS'), `${now()} public DONE g10 ${line}\n`);
  const say = (line) => process.stdout.write(`${now()} ${line}\n`);
  const casesPath = args.cases ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'general-tasks', 'cases.json');
  const cases = readJson(casesPath).cases;
  const dir = join(root, 'cases');
  mkdirSync(dir, { recursive: true });
  await pool(cases, Math.min(2, Number(args.concurrency ?? 2)), async (c) => {
    const f = join(dir, `${c.id}.json`);
    if (existsSync(f)) return;
    const doc = await ask(c.id, (pr) => seedPrompt(c, pr), (d) => seedProblems(d, c), say);
    writeJson(f, { caseId: c.id, caseSha256: caseSha(c), statements: doc.statements });
    status(`${c.id} seeds`);
  });
  const seeds = cases.map((c) => ({ ...readJson(join(dir, `${c.id}.json`)), kind: c.kind }));
  writeJson(join(root, 'seeds.json'), { schema: 'capsule-proving-g10-seeds/1', generator: GENERATOR, seeds });
  const relevant = seeds.reduce((n, s) => n + s.statements.filter((x) => x.relevant).length, 0);
  const total = seeds.reduce((n, s) => n + s.statements.length, 0);
  writeJson(join(root, 'manifest.json'), { cases: seeds.length, statements: total, relevant, caseSha256: Object.fromEntries(seeds.map((s) => [s.caseId, s.caseSha256])), sha256: { 'seeds.json': sha256(join(root, 'seeds.json')) }, kimi: stats });
  status(`manifest (${seeds.length} cases, ${total} statements)`);
  say(`${seeds.length} cases, ${total} statements, ${relevant} relevant, kimi ${JSON.stringify(stats)}`);
}


/** Common set-up of a runner: output dir, status line, logger, sealed flag. */
function setup(args, name, { split = true } = {}) {
  const out = args.out ?? (() => { throw new Error('--out required'); })();
  const sp = split ? (args.split ?? 'dev') : 'public';
  const sealed = sp === 'sealed';
  const root = join(out, split ? `${name}-${sp}` : name);
  mkdirSync(root, { recursive: true });
  return {
    out, sp, sealed, root, concurrency: Math.min(2, Number(args.concurrency ?? 2)),
    status: (line) => appendFileSync(join(out, 'STATUS'), `${now()} ${sp} DONE ${name} ${line}\n`),
    say: (line) => process.stdout.write(`${now()} ${line}\n`),
    cached: async (file, make) => { if (existsSync(file)) return readJson(file); const v = await make(); writeJson(file, v); return v; },
  };
}
const writeManifest = (c, extra, files) => writeJson(join(c.root, 'manifest.json'), { split: c.sp, ...extra, sha256: Object.fromEntries(files.map((f) => [f, sha256(join(c.root, f))])), kimi: stats });

async function runL10(args) {
  const c = setup(args, 'l10');
  const n = Number(args.count ?? (c.sealed ? 8 : 3));
  const off = c.sealed ? 3 : 0;
  const avoid = c.sealed && existsSync(join(c.out, 'l10-dev', 'families.json')) ? readJson(join(c.out, 'l10-dev', 'families.json')).families.map((f) => f.family) : [];
  const fams = [];
  await pool(Array.from({ length: n }, (_, i) => i), c.concurrency, async (i) => {
    const a = loop.l10Assign(i + off);
    const f = join(c.root, `family-${String(i + 1).padStart(2, '0')}.json`);
    const doc = await c.cached(f, async () => { const d = await ask(`L10 ${i + 1}`, (pr) => loop.l10Prompt(a, avoid, pr), (x) => loop.l10Problems(x, a), c.say); c.status(`family ${i + 1}`); return d; });
    fams[i] = { id: `F${c.sealed ? 'S' : 'D'}${String(i + 1).padStart(2, '0')}`, family: doc.family, requests: doc.requests, lookalikes: doc.lookalikes, gold: loop.l10Gold(doc, a) };
  });
  writeJson(join(c.root, 'families.json'), { schema: 'capsule-proving-l10/1', split: c.sp, generator: GENERATOR, chains: loop.TOOL_CHAINS, families: fams });
  writeJson(join(c.root, 'inputs.json'), { schema: 'capsule-proving-l10-inputs/1', families: fams.map((f) => ({ id: f.id, requests: f.requests, lookalikes: f.lookalikes })) });
  writeManifest(c, { families: fams.length, requests: fams.length * 4, lookalikes: fams.length * 2, chains: fams.reduce((m, f) => ({ ...m, [f.gold.chain]: (m[f.gold.chain] ?? 0) + 1 }), {}) }, ['families.json', 'inputs.json']);
  c.status(`manifest (${fams.length} families)`);
  c.say(c.sealed ? `${fams.length} families` : fams.map((f) => `${f.gold.chain}: ${f.family} | ${f.requests[0].slice(0, 50)} | ${f.lookalikes[0].slice(0, 50)}`).join('\n'));
}

async function runL5(args) {
  const c = setup(args, 'l5');
  const per = Number(args.count ?? (c.sealed ? 6 : 2));
  const off = c.sealed ? 2 : 0;
  const items = loop.L5_CLASSES.flatMap((cls) => Array.from({ length: per }, (_, k) => ({ cls, k, a: loop.l5Assign(cls, k + off) })));
  const avoid = c.sealed && existsSync(join(c.out, 'l5-dev', 'methods.json')) ? readJson(join(c.out, 'l5-dev', 'methods.json')).items.map((x) => x.method.name) : [];
  const done = [];
  await pool(items, c.concurrency, async (it) => {
    const f = join(c.root, `item-${it.cls}-${it.k + 1}.json`);
    const doc = await c.cached(f, async () => { const d = await ask(`L5 ${it.cls} ${it.k + 1}`, (pr) => loop.l5Prompt(it.a, avoid, pr), (x) => loop.l5Problems(x, it.a), c.say); c.status(`${it.cls} ${it.k + 1}`); return d; });
    done.push({ id: `${c.sealed ? 'MS' : 'MD'}-${it.cls}-${it.k + 1}`, method: doc.method, tasks: doc.tasks, followUp: { text: doc.followUp, verdict: loop.l5Expected[it.cls].followUp }, gold: loop.l5Gold(it.a, doc) });
  });
  done.sort((x, y) => x.id.localeCompare(y.id));
  writeJson(join(c.root, 'methods.json'), { schema: 'capsule-proving-l5/1', split: c.sp, generator: GENERATOR, items: done });
  writeJson(join(c.root, 'inputs.json'), { schema: 'capsule-proving-l5-inputs/1', items: done.map((x) => ({ id: x.id, method: x.method, tasks: x.tasks, followUp: x.followUp.text })) });
  writeJson(join(c.root, 'gold.json'), { schema: 'capsule-proving-l5-gold/1', items: done.map((x) => ({ id: x.id, followUpVerdict: x.followUp.verdict, ...x.gold })) });
  writeManifest(c, { items: done.length, classes: done.reduce((m, x) => ({ ...m, [x.gold.class]: (m[x.gold.class] ?? 0) + 1 }), {}) }, ['methods.json', 'inputs.json', 'gold.json']);
  c.status(`manifest (${done.length} methods)`);
  c.say(c.sealed ? `${done.length} methods` : done.map((x) => `${x.id}: ${x.method.name} | ${x.method.body.slice(0, 80).replace(/\n/g, ' ')} | ${x.followUp.text}`).join('\n'));
}

async function runL1(args) {
  const c = setup(args, 'l1');
  const per = Number(args.count ?? (c.sealed ? 3 : 1));
  const off = c.sealed ? 1 : 0;
  const avoid = c.sealed && existsSync(join(c.out, 'l1-dev', 'scripts.json')) ? readJson(join(c.out, 'l1-dev', 'scripts.json')).scripts.map((s) => s.topic) : [];
  const items = loop.RINGS.flatMap((ring) => Array.from({ length: per }, (_, k) => loop.l1Assign(ring, k + off)));
  const scripts = [];
  await pool(items, c.concurrency, async (a) => {
    const f = join(c.root, `script-${a.ring}-${a.index + 1}.json`);
    const doc = await c.cached(f, async () => { const d = await ask(`L1 ${a.ring} ${a.index + 1}`, (pr) => loop.l1Prompt(a, avoid, pr), (x) => loop.l1Problems(x, a), c.say); c.status(`${a.ring} ${a.index + 1}`); return d; });
    const s = loop.l1Script(a, doc);
    if (!s.gold.trigger.fired) throw new Error(`${s.id}: trigger not met: ${s.gold.trigger.reasons.join('; ')}`);
    scripts.push(s);
  });
  scripts.sort((x, y) => x.id.localeCompare(y.id));
  writeJson(join(c.root, 'scripts.json'), { schema: 'capsule-proving-l1/1', split: c.sp, generator: GENERATOR, scripts });
  writeJson(join(c.root, 'inputs.json'), { schema: 'capsule-proving-l1-inputs/1', scripts: scripts.map(loop.l1RuntimeScript) });
  writeJson(join(c.root, 'gold.json'), { schema: 'capsule-proving-l1-gold/1', scripts: scripts.map((s) => ({ id: s.id, ring: s.ring, ...s.gold })) });
  writeManifest(c, { scripts: scripts.length, rings: scripts.reduce((m, s) => ({ ...m, [s.ring]: (m[s.ring] ?? 0) + 1 }), {}) }, ['scripts.json', 'inputs.json', 'gold.json']);
  c.status(`manifest (${scripts.length} scripts)`);
  c.say(c.sealed ? `${scripts.length} scripts` : scripts.map((s) => `${s.id}: ${s.topic} | ${s.runs.map((r) => `${r.followUp.verdict}:${r.followUp.text}`).join(' / ')}`).join('\n'));
}

async function runL4(args) {
  const c = setup(args, 'l4', { split: false });
  const base = loop.officialMethods();
  const rel = {};
  await pool(base, c.concurrency, async (b) => {
    const f = join(c.root, `relatives-${b.id.replace(/[:/]/g, '_')}.json`);
    const doc = await c.cached(f, async () => { const d = await ask(`L4 ${b.id}`, (pr) => loop.l4RelativesPrompt(b, pr), (x) => loop.l4RelativesProblems(x, b), c.say); c.status(`relatives ${b.id}`); return d; });
    rel[b.id] = doc.relatives;
  });
  const need = Math.max(...loop.L4_SIZES) - base.length - base.length * 4;
  const batches = Math.ceil(need / loop.L4_FILLER_BATCH);
  const filler = [];
  const bodies = Object.values(rel).flatMap((r) => Object.values(r).map((x) => x.body)).concat(base.map((b) => b.body));
  const fdocs = [];
  await pool(Array.from({ length: batches }, (_, i) => i), c.concurrency, async (i) => {
    const topic = loop.L4_FILLER_TOPICS[i % loop.L4_FILLER_TOPICS.length];
    const f = join(c.root, `filler-${String(i + 1).padStart(2, '0')}.json`);
    const doc = await c.cached(f, async () => { const d = await ask(`L4 filler ${i + 1} ${topic}`, (pr) => loop.l4FillerPrompt(topic, pr), (x) => loop.l4FillerProblems(x, bodies), c.say); c.status(`filler ${i + 1}`); return d; });
    fdocs[i] = doc.methods.map((m, j) => ({ id: `L4:filler:${i + 1}-${j + 1}`, source: 'filler', topic, whenToUse: m.whenToUse, body: m.body }));
  });
  for (const d of fdocs) filler.push(...d);
  const libs = {};
  for (const size of loop.L4_SIZES) {
    const lib = loop.buildLibrary(size, base, rel, filler);
    libs[size] = lib;
    writeJson(join(c.root, `library-${size}.json`), { schema: 'capsule-proving-l4-library/1', size: lib.size, methods: lib.methods });
    writeJson(join(c.root, `gold-${size}.json`), { schema: 'capsule-proving-l4-gold/1', size: lib.size, note: 'relation pairs are the planted ones; every other pair is unlabelled (assumed none)', pairs: lib.gold });
  }
  const files = loop.L4_SIZES.flatMap((s) => [`library-${s}.json`, `gold-${s}.json`]);
  writeManifest(c, { sizes: Object.fromEntries(loop.L4_SIZES.map((s) => [s, { methods: libs[s].size, pairs: libs[s].gold.length }])), baseMethods: base.length, fillerPool: filler.length }, files);
  c.status(`manifest (${loop.L4_SIZES.join('/')})`);
  c.say(`libraries ${loop.L4_SIZES.map((s) => `${s}:${libs[s].size} methods ${libs[s].gold.length} pairs`).join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]] : a), []));
  if (args.set === 'l2') await runL2(args);
  else if (args.set === 'g10') await runG10(args);
  else if (args.set === 'l1') await runL1(args);
  else if (args.set === 'l4') await runL4(args);
  else if (args.set === 'l5') await runL5(args);
  else if (args.set === 'l10') await runL10(args);
  else throw new Error('--set l1|l2|l4|l5|l10|g10 required');
}
