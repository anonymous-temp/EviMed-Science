/**
 * The capability-skill campaign's improver (2026-10-28): a model other than the solver's family (Qwen, the lab's own
 * DashScope key) reads the baseline arm's development failures — the question, the run's stated answer, the gold value and
 * the calculator — and writes K candidate personal skills (title, description, instructions). Each candidate is
 * content-addressed (sha256 of its canonical JSON), so the arm id `cand-<12 hex>` names exactly one text. It never reads a
 * confirmation row: the caller hands it development records only, and the runner later checks the confirmation rows are
 * disjoint.
 *
 * Money goes through the lab budget ledger: reserve an upper bound per call, begin the spend, call, settle the priced
 * actual — the same discipline as the label jury.
 *
 *   node skill_improver.mjs --failures dev-failures.json --credential key --config lab.json --campaign id --out candidates.json [--k 2]
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { canonicalRsiJson } from '../../apps/server/src/rsiCampaignBundle.mjs';
import { priceListAt, priceUsage } from '../../packages/domain/src/metering.mjs';

export const SKILL_IMPROVER_MODEL = 'qwen3.8-max';
const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MAX_OUTPUT_TOKENS = 4000;
const MAX_SKILL_CHARS = 6000;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const ceilCny = (value) => Math.ceil(value * 1e8 - 1e-6) / 1e8;

/** The two registered angles; the k-th candidate takes the k-th. */
export const IMPROVER_ANGLES = Object.freeze([
  'Write the skill around the failure classes you see: for each class, the concrete step the assistant skipped or got wrong, and what to do instead.',
  'Write a short, general calculation discipline that would have prevented these failures, without naming individual cases.',
  'Write a short PROCESS skill (under 2500 characters). Do not restate any scoring table, cutoff, coefficient or unit-conversion factor from memory: earlier skills that did so introduced errors. Say how to work instead: find the standard published version of the named calculator (or use the exact calculation tool), check each criterion against a quoted phrase of the note, state the unit the question asks for (a percentage stays a percentage), and keep the arithmetic in a tool.',
  'Write a very short checklist skill (under 1200 characters) that only adds verification steps after the assistant has computed its answer: re-read the question for the requested unit, scale and sign; recount every scored criterion against the note; recompute with a tool. No tables, no formulas, no factors.',
]);

/** A candidate as the campaign registers it: its text, digest, size and arm id. @param {{title:string, description:string, instructions:string}} skill */
export function candidateRecord(skill) {
  const text = { title: skill.title.trim(), description: skill.description.trim(), instructions: skill.instructions.trim() };
  const digest = sha(canonicalRsiJson(text));
  return { arm: `cand-${digest.slice(0, 12)}`, digest, chars: text.title.length + text.description.length + text.instructions.length, ...text };
}

/**
 * The improver's messages. Failures are records the lab holds; no gold of a confirmation row can reach here.
 * @param {Array<{calculator:string, question:string, answer:string|null, gold:string}>} failures @param {number} angle
 */
export function improverMessages(failures, angle, feedback = null) {
  const cases = failures.map((f, index) => `### Case ${index + 1} — ${f.calculator}\nQuestion (abridged): ${f.question.slice(0, 1200)}\nAssistant's final answer: ${f.answer ?? '(none)'}\nCorrect value: ${f.gold}`).join('\n\n');
  const previous = feedback ? `\n\nEarlier skills were tried on similar questions and made the assistant WORSE (accuracy fell by about 10 points). Where they changed an answer:\n${feedback.map((f) => `- ${f.calculator}: without the skill ${f.baseline}, with the skill ${f.candidate}, correct ${f.gold}`).join('\n')}\nThe earlier skills restated scoring tables and conversion factors in detail; several of those details were wrong or differed from the standard convention.` : '';
  return [
    { role: 'system', content: 'You improve an AI research assistant by writing a skill: a short instruction document it loads when a task matches. You never see the assistant\'s code. You write in English, concretely, without mentioning any benchmark, test or case number.' },
    { role: 'user', content: `The assistant answers clinical calculator questions about a patient note (scores, formulas, unit conversions, dates). Below are questions it answered wrongly, with its final answer and the correct value.\n\n${cases}${previous}\n\n${IMPROVER_ANGLES[angle]}\n\nReturn JSON with: title (under 60 characters), description (one sentence saying when to use the skill), instructions (Markdown, under ${MAX_SKILL_CHARS} characters).` },
  ];
}

const schema = { type: 'object', additionalProperties: false, required: ['title', 'description', 'instructions'],
  properties: { title: { type: 'string', maxLength: 60 }, description: { type: 'string', maxLength: 300 }, instructions: { type: 'string', maxLength: MAX_SKILL_CHARS } } };

/** One priced call to Qwen. @returns {Promise<{skill:any, usage:{cacheHit:number,cacheMiss:number,output:number}}>} */
async function callQwen({ key, messages, model, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`${DASHSCOPE_BASE_URL}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: MAX_OUTPUT_TOKENS, enable_thinking: false,
      response_format: { type: 'json_schema', json_schema: { name: 'skill', strict: true, schema } } }),
  });
  if (!response.ok) throw new Error(`improver_http_${response.status}`);
  const data = await response.json();
  const skill = JSON.parse(data?.choices?.[0]?.message?.content ?? 'null');
  if (!skill || ['title', 'description', 'instructions'].some((field) => typeof skill[field] !== 'string' || !skill[field].trim())) throw new Error('improver_bad_response');
  const u = data.usage, prompt = Number(u?.prompt_tokens), output = Number(u?.completion_tokens);
  const cached = Math.min(Math.max(Number(u?.prompt_tokens_details?.cached_tokens) || 0, 0), prompt);
  return { skill, usage: { cacheHit: cached, cacheMiss: prompt - cached, output } };
}

/**
 * Write k candidates, each under a reserved, begun and settled budget record.
 * @param {{failures:any[], k:number, key:string, budget:any, campaignId:string, model?:string, now?:()=>string, fetchImpl?:typeof fetch}} input
 */
export async function improveSkills({ failures, k, key, budget, campaignId, model = SKILL_IMPROVER_MODEL, now = () => new Date().toISOString(), fetchImpl, angles = null, feedback = null }) {
  const list = priceListAt(now());
  const price = (usage) => {
    const priced = priceUsage({ resourceType: 'model', model, cacheHit: usage.cacheHit, cacheMiss: usage.cacheMiss, output: usage.output, peak: true }, list);
    if (!priced.priced) throw new Error('improver_unpriced');
    return priced.cost;
  };
  const candidates = [], spend = [];
  const chosen = angles ?? Array.from({ length: k }, (_, index) => index % IMPROVER_ANGLES.length);
  for (const angle of chosen) {
    const messages = improverMessages(failures, angle, feedback);
    const upper = ceilCny(price({ cacheHit: 0, cacheMiss: JSON.stringify(messages).length, output: MAX_OUTPUT_TOKENS }));
    const stageKey = `skill-improver:${sha(JSON.stringify([campaignId, angle, model, sha(JSON.stringify(messages))])).slice(0, 16)}`;
    const grant = await budget.reserve({ campaignId, stageKey, amountCny: upper });
    if (!grant?.authorized) throw new Error(grant?.reason ?? 'campaign_budget_refused');
    const begun = await budget.beginSpend({ campaignId, stageKey });
    if (!begun?.authorized) throw new Error(begun?.reason ?? 'campaign_budget_refused');
    let actual = 0;
    try {
      const { skill, usage } = await callQwen({ key, messages, model, fetchImpl });
      actual = ceilCny(price(usage));
      candidates.push({ ...candidateRecord(skill), angle });
      await budget.settle({ campaignId, stageKey, outcome: 'success', actualCny: actual });
    } catch (error) {
      await budget.settle({ campaignId, stageKey, outcome: 'failed', actualCny: actual });
      throw error;
    }
    spend.push({ stageKey, cny: actual });
  }
  const unique = [...new Map(candidates.map((c) => [c.arm, c])).values()];
  return { model, candidates: unique, spend, failures: failures.length };
}

async function main() {
  const { values } = parseArgs({ options: { failures: { type: 'string' }, credential: { type: 'string' }, config: { type: 'string' }, campaign: { type: 'string' }, out: { type: 'string' }, k: { type: 'string', default: '2' },
    angles: { type: 'string' }, feedback: { type: 'string' } } });
  for (const name of ['failures', 'credential', 'config', 'campaign', 'out']) if (!values[name]) throw new Error(`--${name} is required`);
  const failures = JSON.parse(await readFile(values.failures, 'utf8'));
  const key = (await readFile(values.credential, 'utf8')).trim();
  const url = process.env.RSI_LAB_DATABASE_URL;
  if (!url) throw new Error('lab_database_url_missing');
  const configuration = JSON.parse(await readFile(values.config, 'utf8'));
  const { ControlPlaneDatabase } = await import('../../apps/server/src/controlPlaneDatabase.mjs');
  const { RsiCampaignBudget } = await import('../../apps/server/src/rsiCampaignBudget.mjs');
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 5000 });
  try {
    const budget = new RsiCampaignBudget({ database, configuration });
    const angles = values.angles ? values.angles.split(',').map(Number) : null;
    const feedback = values.feedback ? JSON.parse(await readFile(values.feedback, 'utf8')) : null;
    const result = await improveSkills({ failures, k: Number(values.k), key, budget, campaignId: values.campaign, model: configuration.providers?.qwenMax?.model ?? SKILL_IMPROVER_MODEL, angles, feedback });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ candidates: result.candidates.map((c) => ({ arm: c.arm, chars: c.chars, title: c.title })), spend: result.spend }));
  } finally { await database.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error?.message ?? error); process.exit(1); });
