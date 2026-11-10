/**
 * A round's money, in the three places it is metered (design section 21): the lab's ledger, the solver runs of the lane stack and Claude. The lab ledger sees
 * only what the lab spends, so the other two reached no report; this reads what the round already recorded and writes it as one digested `round-spend.json`,
 * which `harness_report.mjs` and `skill_report.mjs` print as a three-line money section (未提供 when the file is absent). It measures nothing new and changes no
 * statistic or cost the procedure tests.
 *
 *   node round_spend.mjs --label <id> --out <campaign-dir>/round-spend.json [--source export.json]... [--h2-ledger rsi1-ledger.jsonl [--h2-domain <family>]]
 *     [--judge-parts <dir>]... [--improvement improvement.json] [--force] [--no-checksums]
 *
 * On the operator's box, where the Claude records are; the file then travels to the lab beside improvement.json.
 *
 *  - lanes: the settled CNY of each arm's runs in the sources (`--source`, the exports the assembly takes: harness-arms, skill-arms or module-arms, each read through its
 *    `.sha256` sidecar and kept by that digest), runs without a settled cost counted apart (a missing cost is never a zero: the total is then a lower bound), and the
 *    solver rollouts of Harness2's improvement phase (`kind: rollout` rows of its ledger, DeepSeek on the same lane stack).
 *  - claude: tokens by role and model, never converted to CNY and never summed with it. Harness2's ledger records every improver call's tokens; claude_judge.py records the
 *    CLI's API-equivalent USD per call and no tokens; a source's `judged` section records the judge's verdict lines; the improvement record names roles and records nothing
 *    else. A role that recorded no tokens is `"unmetered"`, not 0.
 *  - lab: the lab's ledger reading. No campaign file carries one, so it is null (`lab_ledger_not_recorded`), shown as 未提供.
 * Every input is named by the sha256 of its bytes (a Harness2 ledger and a judge log are not signed sources; their digest says which bytes were read), and the file
 * carries the digest of its own body.
 */
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { rsiDigest } from '../../apps/server/src/rsiCampaignBundle.mjs';

export const ROUND_SPEND_SCHEMA = 'rsi-round-spend/1';
export const ROUND_SPEND_FILE = 'round-spend.json';
/** The exports whose runs carry a settled `cost` in CNY, and where that cost was settled. */
const SOURCE_KINDS = Object.freeze({ 'harness-arms': 'lane', 'skill-arms': 'production', 'module-arms': 'operator-box' });
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const CLAUDE_MODEL = /^claude-[a-z0-9-]+$/;
const TOKEN_FIELDS = Object.freeze([['input', 'input_tokens'], ['output', 'output_tokens'], ['cacheRead', 'cache_read_input_tokens'], ['cacheCreation', 'cache_creation_input_tokens']]);

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const fail = (code) => { throw new Error(code); };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------------- lanes

/**
 * One export's settled cost: per arm and in all, with the runs that have none counted apart.
 * @param {string} file @param {string} text the export's bytes, already checked against their sidecar
 * @param {string | null} uncertainText `<export>.uncertain-costs.json`, which the exporter writes beside a source whose runs carry a ledger sum that is a lower bound (an uncertain call or an open
 *   reservation); those runs have a cost, so only this file says it is not complete
 */
export function laneSource(file, text, uncertainText = null) {
  const source = JSON.parse(text);
  if (!record(source) || !Object.hasOwn(SOURCE_KINDS, source.kind) || !Array.isArray(source.runs) || !record(source.arms)) fail('round_spend_source_invalid');
  const byArm = {};
  for (const run of source.runs) {
    if (!record(run) || typeof run.arm !== 'string' || !(run.cost === null || (finite(run.cost) && run.cost >= 0))) fail('round_spend_source_invalid');
    const slot = (byArm[run.arm] ??= { runs: 0, runsWithoutCost: 0, settledCny: 0 });
    slot.runs += 1;
    if (run.cost === null) slot.runsWithoutCost += 1; else slot.settledCny += run.cost;
  }
  for (const slot of Object.values(byArm)) slot.settledCny = round6(slot.settledCny);
  const uncertain = uncertainText === null ? null : JSON.parse(uncertainText);
  if (uncertain !== null && (!record(uncertain) || uncertain.kind !== 'harness-uncertain-costs' || !Array.isArray(uncertain.runs))) fail('round_spend_source_invalid');
  const arms = Object.fromEntries(Object.entries(byArm).sort(([a], [b]) => cmp(a, b)));
  const slots = Object.values(arms);
  return { file, sha256: sha(text), kind: source.kind, settledOn: SOURCE_KINDS[source.kind], role: typeof source.role === 'string' ? source.role : null, benchmark: typeof source.benchmark === 'string' ? source.benchmark : null,
    runs: source.runs.length, runsWithoutCost: slots.reduce((n, s) => n + s.runsWithoutCost, 0), settledCny: round6(slots.reduce((n, s) => n + s.settledCny, 0)), byArm: arms, ...(uncertain ? { uncertainRuns: uncertain.runs.length, uncertainSha256: sha(uncertainText) } : {}),
    ...(record(source.judged) ? { judged: { judge: record(source.judged.judge) ? { id: source.judged.judge.id, provider: source.judged.judge.provider, model: source.judged.judge.model, effort: source.judged.judge.effort } : null, verdictLines: Number.isInteger(source.judged.calls) ? source.judged.calls : null, recordedCny: finite(source.judged.cost?.settledCny) ? source.judged.cost.settledCny : null } } : {}) };
}

// -------------------------------------------------------------------------------------------------------- Harness2's ledger

/**
 * Harness2's `rsi1-ledger.jsonl` (evals/harness-adaptation/evimed_h2/ledger.py): one keyed row per paid thing, a torn last line being a key that is not there.
 * Improver rows are grouped by stage and model; a call whose usage the CLI did not report (a timeout) is counted apart and does not make the tokens zero.
 * Rollout rows are the improvement phase's solver runs: settled CNY, or none.
 * @param {string} file @param {string} text @param {string | null} domain only the rows of this Harness2 domain (a family); null: the whole ledger
 */
export function harness2Spend(file, text, domain = null) {
  const seen = new Set(), rows = [];
  let unreadable = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { /* a torn line */ }
    if (!record(row) || typeof row.key !== 'string') { unreadable += 1; continue; }
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    if (row.cached !== true && (domain === null || row.domain === domain)) rows.push(row);
  }
  const groups = new Map();
  for (const row of rows.filter((r) => r.kind === 'improver')) {
    const key = `${row.stage}\0${row.model}`;
    if (!groups.has(key)) groups.set(key, { stage: String(row.stage ?? '?'), model: String(row.model ?? '?'), rows: [] });
    groups.get(key).rows.push(row);
  }
  const roles = [...groups.values()].sort((a, b) => cmp(a.stage, b.stage) || cmp(a.model, b.model)).map(({ stage, model, rows: calls }) => {
    // A call counts as metered only with all four fields: a usage that lacks some is a call without usage, never zeros.
    const metered = calls.filter((c) => record(c.usage) && TOKEN_FIELDS.every(([, field]) => finite(c.usage[field])));
    const usd = calls.filter((c) => finite(c.usd_reported));
    return { role: `harness2/${stage}`, model, claude: CLAUDE_MODEL.test(model), source: 'harness2-ledger', calls: calls.length,
      tokens: metered.length ? Object.fromEntries(TOKEN_FIELDS.map(([name, field]) => [name, metered.reduce((n, c) => n + c.usage[field], 0)])) : 'unmetered',
      callsWithoutUsage: calls.length - metered.length, usdReported: usd.length ? round6(usd.reduce((n, c) => n + c.usd_reported, 0)) : null };
  });
  const rollouts = rows.filter((r) => r.kind === 'rollout');
  const settled = rollouts.filter((r) => finite(r.cny));
  return { input: { kind: 'harness2-ledger', file, sha256: sha(text), domain, rowsRead: seen.size, unreadableLines: unreadable },
    rollouts: { runs: rollouts.length, runsWithoutCost: rollouts.length - settled.length, uncertain: rollouts.filter((r) => finite(r.cost_uncertain) && r.cost_uncertain > 0).length, settledCny: round6(settled.reduce((n, r) => n + r.cny, 0)) },
    roles };
}

// ----------------------------------------------------------------------------------------------------------- the judge's log

const JUDGE_OK = /^\S+ ok (\S+) p(\d+) usd (\d+(?:\.\d+)?|none) \(/;
const JUDGE_FAILED = /^\S+ FAILED (\S+) p(\d+): \S+ \(/;

/**
 * claude_judge.py's parts directory: `judge.json` (who judged) and `judge.log` (one `ok <packet> p<pass> usd <x>` line per judged packet and pass, `FAILED` per failed
 * attempt). The CLI result's token counts are not kept anywhere, so the judge is unmetered in tokens; the API-equivalent USD per call is what the log holds.
 * @param {string} dir @param {string} recordText judge.json @param {string | null} logText judge.log, or null when it is not there
 */
export function judgeParts(dir, recordText, logText) {
  const who = JSON.parse(recordText);
  if (!record(who) || typeof who.judge !== 'string' || !CLAUDE_MODEL.test(who.model ?? '')) fail('round_spend_judge_record_invalid');
  const ok = new Map(), failed = new Set();
  for (const line of (logText ?? '').split('\n')) {
    const done = JUDGE_OK.exec(line), lost = done ? null : JUDGE_FAILED.exec(line);
    if (done) ok.set(`${done[1]}\0${done[2]}`, done[3] === 'none' ? null : Number(done[3]));
    else if (lost) failed.add(`${lost[1]}\0${lost[2]}`);
  }
  for (const key of ok.keys()) failed.delete(key);
  return { id: who.judge, model: who.model, effort: typeof who.effort === 'string' ? who.effort : null, input: { kind: 'judge-parts', file: basename(dir), sha256: sha(recordText), log: logText === null ? null : sha(logText) },
    calls: logText === null ? null : ok.size, failedCalls: logText === null ? null : failed.size, ...usdOf(logText === null ? null : ok),
    entries: logText === null ? null : [...ok], failedKeys: [...failed] };
}

/** `usd none` lines are calls whose cost the CLI did not report: counted apart, and the sum of the others is then a lower bound. @param {Map<string, number | null> | null} ok */
function usdOf(ok) {
  if (ok === null) return { usdReported: null, callsWithoutCost: null };
  const known = [...ok.values()].filter((usd) => usd !== null);
  return { usdReported: known.length ? round6(known.reduce((n, usd) => n + usd, 0)) : null, callsWithoutCost: ok.size - known.length };
}

/** One judge's parts directories as one: packets and passes are the union (the same packet in two logs is one call), a different cost for the same packet, or a different model, is a conflict. @param {ReturnType<typeof judgeParts>[]} parts */
function mergeJudgeParts(parts) {
  const first = parts[0];
  if (parts.length === 1) return { ...first, conflicts: 0 };
  if (parts.some((p) => p.entries === null)) return { ...first, calls: null, failedCalls: null, usdReported: null, callsWithoutCost: null, conflicts: 0 };
  const ok = new Map(); let conflicts = parts.filter((p) => p.model !== first.model).length;
  for (const [key, usd] of parts.flatMap((p) => p.entries)) { if (ok.has(key)) { if (ok.get(key) !== usd) conflicts += 1; } else ok.set(key, usd); }
  const failed = new Set(parts.flatMap((p) => p.failedKeys).filter((key) => !ok.has(key)));
  return { ...first, calls: ok.size, failedCalls: failed.size, ...usdOf(ok), conflicts };
}

/** The judge roles: what the sources' `judged` sections record, with a parts directory's log where the operator has one. @param {any[]} sources @param {ReturnType<typeof judgeParts>[]} parts */
function judgeRoles(sources, parts) {
  const judges = new Map();
  for (const { judged } of sources) {
    const j = judged?.judge;
    if (!record(j) || typeof j.id !== 'string') continue;
    const entry = judges.get(j.id) ?? { id: j.id, model: String(j.model ?? '?'), effort: typeof j.effort === 'string' ? j.effort : null, verdictLines: 0, recordedCny: 0 };
    // One source without a count makes the sum unknown, not smaller.
    entry.verdictLines = entry.verdictLines === null || judged.verdictLines == null ? null : entry.verdictLines + judged.verdictLines;
    entry.recordedCny = entry.recordedCny === null || judged.recordedCny == null ? null : round6(entry.recordedCny + judged.recordedCny);
    judges.set(j.id, entry);
  }
  const byId = Map.groupBy(parts, (p) => p.id), logs = new Map([...byId].map(([id, list]) => [id, mergeJudgeParts(list)]));
  for (const p of logs.values()) if (!judges.has(p.id)) judges.set(p.id, { id: p.id, model: p.model, effort: p.effort, verdictLines: null, recordedCny: null });
  return [...judges.values()].sort((a, b) => cmp(a.id, b.id)).map((entry) => {
    const log = logs.get(entry.id);
    return { role: `judge:${entry.id}`, model: log?.model ?? entry.model, claude: CLAUDE_MODEL.test(log?.model ?? entry.model), source: log ? 'judge-log' : 'source-judged', effort: entry.effort,
      calls: log?.calls ?? entry.verdictLines, callsBasis: log?.calls != null ? 'cli-calls' : 'verdict-lines', failedCalls: log?.failedCalls ?? null,
      tokens: 'unmetered', callsWithoutUsage: null, usdReported: log?.usdReported ?? null, callsWithoutCost: log?.callsWithoutCost ?? null, conflicts: log?.conflicts ?? null, recordedCny: entry.recordedCny };
  });
}

// ------------------------------------------------------------------------------------------------------- the whole file

/**
 * @param {{ label: string, sources?: { file: string, text: string }[], harness2?: { file: string, text: string, domain?: string | null }[],
 *   judge?: { dir: string, record: string, log: string | null }[], improvement?: { file: string, text: string } | null }} input
 */
export function buildRoundSpend({ label, sources = [], harness2 = [], judge = [], improvement = null }) {
  if (typeof label !== 'string' || !LABEL.test(label)) fail('round_spend_label_invalid');
  if (!sources.length && !harness2.length && !judge.length && !improvement) fail('round_spend_nothing_to_read');
  const lanes = sources.map(({ file, text, uncertain }) => laneSource(file, text, uncertain?.text ?? null));
  const ledgers = harness2.map(({ file, text, domain }) => harness2Spend(file, text, domain ?? null));
  const parts = judge.map(({ dir, record: recordText, log }) => judgeParts(dir, recordText, log));
  const improvers = improvement ? JSON.parse(improvement.text) : null;
  if (improvement && (!record(improvers) || !Array.isArray(improvers.improvers) || !improvers.improvers.length)) fail('round_spend_improvement_invalid');
  const improvementRoles = (improvers?.improvers ?? []).map((who) => {
    if (!record(who) || typeof who.role !== 'string' || typeof who.model !== 'string') fail('round_spend_improvement_invalid');
    return { role: who.role, model: who.model, claude: who.provider === 'anthropic' && CLAUDE_MODEL.test(who.model), source: 'improvement-record', calls: null, tokens: 'unmetered', callsWithoutUsage: null, usdReported: null };
  });
  const rollouts = ledgers.reduce((sum, l) => ({ runs: sum.runs + l.rollouts.runs, runsWithoutCost: sum.runsWithoutCost + l.rollouts.runsWithoutCost, uncertain: sum.uncertain + l.rollouts.uncertain, settledCny: round6(sum.settledCny + l.rollouts.settledCny) }),
    { runs: 0, runsWithoutCost: 0, uncertain: 0, settledCny: 0 });
  const uncertainRuns = lanes.reduce((n, s) => n + (s.uncertainRuns ?? 0), 0) + rollouts.uncertain;
  const withoutCost = lanes.reduce((n, s) => n + s.runsWithoutCost, 0) + rollouts.runsWithoutCost;
  const body = {
    schema: ROUND_SPEND_SCHEMA, label,
    lab: { ledgerCny: null, reason: 'lab_ledger_not_recorded' },
    lanes: { sources: lanes, ...(ledgers.length ? { improvementRollouts: rollouts } : {}), runsWithoutCost: withoutCost, uncertain: uncertainRuns,
      settledCny: round6(lanes.reduce((n, s) => n + s.settledCny, 0) + rollouts.settledCny), complete: withoutCost === 0 && uncertainRuns === 0 },
    claude: { unit: 'tokens', roles: [...ledgers.flatMap((l) => l.roles), ...judgeRoles(lanes, parts), ...improvementRoles],
      inputs: [...ledgers.map((l) => l.input), ...parts.map((p) => p.input), ...(improvement ? [{ kind: 'improvement-record', file: improvement.file, sha256: sha(improvement.text) }] : [])] },
  };
  return { ...body, digest: rsiDigest(body) };
}

/**
 * `<dir>/round-spend.json`, read: the file when its digest is its body's, otherwise nothing and the reason. An absent file is no problem, only absent.
 * @param {string} dir @returns {Promise<{ spend: any, problem: string | null }>}
 */
export async function readRoundSpend(dir) {
  let text;
  try { text = await readFile(join(dir, ROUND_SPEND_FILE), 'utf8'); } catch { return { spend: null, problem: null }; }
  try {
    const { digest, ...body } = JSON.parse(text);
    if (body.schema !== ROUND_SPEND_SCHEMA) return { spend: null, problem: 'round_spend_schema' };
    return rsiDigest(body) === digest ? { spend: { ...body, digest }, problem: null } : { spend: null, problem: 'round_spend_digest_mismatch' };
  } catch { return { spend: null, problem: 'round_spend_unreadable' }; }
}

// ---------------------------------------------------------------------------------------------------------------- the report

const yuan = (value) => `${Number(value.toFixed(4))} 元`;
const count = (value) => value.toLocaleString('en-US');
const ROLE_ZH = Object.freeze({ development: '开发期', confirmation: '确认期' });
const BASIS_ZH = Object.freeze({ lane: 'lane 账本', production: '生产账本', 'operator-box': '操作员机器按参考价目表折算' });
const STAGE_ZH = Object.freeze({ inv: '不变量编辑', dom: '领域编辑', agg: '组合', select: '选择', experience: '反思' });

/** A Claude role as the money section says it. @param {any} role */
function claudeItem(role) {
  const name = role.role.startsWith('harness2/') ? `Harness2 ${STAGE_ZH[role.role.slice(9)] ?? role.role.slice(9)}` : role.role.startsWith('judge:') ? `裁判 ${role.role.slice(6)}` : role.role;
  const who = `${name} ${role.model}${role.claude ? '' : '（非 Claude）'}`;
  if (role.tokens === 'unmetered') {
    const calls = role.calls == null ? '' : `${count(role.calls)} 次${role.callsBasis === 'verdict-lines' ? '判决' : ''}，`;
    return `${who} ${calls}token 未计量${role.usdReported == null ? '' : `（CLI 报告的 API 等价约 $${Number(role.usdReported.toFixed(2))}${role.callsWithoutCost ? `，另有 ${role.callsWithoutCost} 次未报告，是下限` : ''}，不是计费）`}${role.conflicts ? `（${role.conflicts} 处记录互相矛盾）` : ''}`;
  }
  const t = role.tokens;
  return `${who} ${count(role.calls)} 次，输入 ${count(t.input)} 输出 ${count(t.output)} 缓存读 ${count(t.cacheRead)} 缓存写 ${count(t.cacheCreation)}${role.callsWithoutUsage ? `（另有 ${role.callsWithoutUsage} 次无用量记录）` : ''}`;
}

/**
 * The money section's three lines (实验机账本, 求解器, Claude), from a read `round-spend.json`. Three currencies of record are never added: CNY of the lab, CNY of
 * the solver runs and Claude's tokens are three lines. A line the file cannot fill says 未提供.
 * @param {{ spend: any, problem: string | null }} read
 */
export function moneyLines({ spend, problem }) {
  const why = problem ? `（${problem === 'round_spend_digest_mismatch' ? 'round-spend.json 的摘要与内容不符，未采用' : 'round-spend.json 无法读取，未采用'}）` : '';
  if (!spend) return [`- 实验机账本：未提供${why}`, `- 求解器（DeepSeek，已结算）：未提供${why}`, `- Claude：未提供${why}`];
  const lab = finite(spend.lab?.ledgerCny) ? yuan(spend.lab.ledgerCny) : '未提供（战役记录里没有实验机支出读数）';
  const lanes = spend.lanes ?? {};
  const pieces = (lanes.sources ?? []).map((s) => `${ROLE_ZH[s.role] ?? s.role ?? '来源'}${s.benchmark ? `（${s.benchmark}）` : ''} ${yuan(s.settledCny)}（${count(s.runs)} 次运行，${BASIS_ZH[s.settledOn] ?? s.settledOn}）`);
  if (lanes.improvementRollouts) pieces.push(`Harness2 改进阶段 ${yuan(lanes.improvementRollouts.settledCny)}（${count(lanes.improvementRollouts.runs)} 次运行）`);
  const solver = pieces.length ? `${pieces.join('；')}；合计 ${yuan(lanes.settledCny)}${lanes.complete ? '' : `；${lanes.runsWithoutCost + (lanes.uncertain ?? 0)} 次运行没有结算完的成本，以上是下限`}` : '未提供';
  const roles = spend.claude?.roles ?? [];
  const claude = roles.length ? roles.map(claudeItem).join('；') : '未提供';
  return [`- 实验机账本：${lab}`, `- 求解器（DeepSeek，按各自账本已结算，元）：${solver}`,
    `- Claude（订阅，按 token 计，不折算为元，不与上两行相加；操作员机器上的记录，实验机未复核）：${claude}`];
}

// ------------------------------------------------------------------------------------------------------------------- command

async function main() {
  const { values } = parseArgs({ options: { label: { type: 'string' }, out: { type: 'string' }, source: { type: 'string', multiple: true }, 'h2-ledger': { type: 'string', multiple: true }, 'h2-domain': { type: 'string' },
    'judge-parts': { type: 'string', multiple: true }, improvement: { type: 'string' }, force: { type: 'boolean' }, 'no-checksums': { type: 'boolean' } } });
  if (!values.out) fail('round_spend_out_missing');
  if (values['h2-domain'] !== undefined && !values['h2-ledger']?.length) fail('round_spend_domain_without_ledger');
  if (!values.force && await stat(values.out).then(() => true, () => false)) fail('round_spend_out_exists');
  // The assembly's own sidecar check, loaded here only: the reports import this file for the money section and need none of the assembly's graph.
  const { readChecked } = await import('./harness_assemble.mjs');
  const checked = !values['no-checksums'];
  const file = async (path) => ({ file: basename(path), text: await readChecked(path, checked) });
  // The exporter's list of runs whose cost is a lower bound sits beside its source, with a sidecar of its own.
  const source = async (path) => ({ ...(await file(path)), ...(await stat(`${path}.uncertain-costs.json`).then(() => true, () => false) ? { uncertain: await file(`${path}.uncertain-costs.json`) } : {}) });
  const spend = buildRoundSpend({
    label: values.label ?? '',
    sources: await Promise.all((values.source ?? []).map(source)),
    harness2: await Promise.all((values['h2-ledger'] ?? []).map(async (path) => ({ file: basename(path), text: await readFile(path, 'utf8'), domain: values['h2-domain'] ?? null }))),
    judge: await Promise.all((values['judge-parts'] ?? []).map(async (dir) => ({ dir, record: await readFile(join(dir, 'judge.json'), 'utf8'), log: await readFile(join(dir, 'judge.log'), 'utf8').catch(() => null) }))),
    improvement: values.improvement ? await file(values.improvement) : null,
  });
  await writeFile(values.out, `${JSON.stringify(spend, null, 2)}\n`);
  console.log(JSON.stringify({ label: spend.label, digest: spend.digest, laneSettledCny: spend.lanes.settledCny, laneComplete: spend.lanes.complete, claudeRoles: spend.claude.roles.length,
    unmetered: spend.claude.roles.filter((role) => role.tokens === 'unmetered').map((role) => role.role) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error?.message ?? error); process.exit(1); });
