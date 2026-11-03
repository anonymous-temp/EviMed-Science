// frontier_labels.mjs as the lab runs it, with the two things a test cannot have for real stood in through the script's own seams (`main(argv, {openBudget, fetchImpl})`):
// the lab's budget ledger and DashScope. The rest is the real command: the key is read from its file by the real caller, the real exemplars, prompts, cache, pricing and
// calibration run, and the labels and calibration files are the real ones.
//
// The ledger is a JSON file (FAKE_BUDGET_LEDGER) so that it outlives a process, as the lab's database does: reserve / begin / settle with the real ledger's states
// (a record that is begun or settled answers `campaign_budget_already_dispatched`). FAKE_BUDGET_ALLOW_RESERVES caps the reservations granted over the whole month, and
// FAKE_BUDGET_REFUSAL is the reason it then answers (default campaign_budget_exceeded).
//
// DashScope is `fetchImpl`: it appends one line per request to FAKE_DASHSCOPE_LOG (the title it read, a digest of the system message, whether the bearer was the key file's
// content; never the key) and answers by FAKE_DASHSCOPE_MODE: ok (default) | http-<status> (an error whose body echoes the key, as vendors do). FAKE_DASHSCOPE_WORTH is the label
// it answers with: `by-title` (default) is the anchor's own label when FAKE_DASHSCOPE_GOLD (the gold file) has the item's title, else the `[pick]`, `[ok]` or `[no]` the title
// carries, else ok. FAKE_DASHSCOPE_REJECT is a substring of titles it refuses, by default as the content check does: a 400 `data_inspection_failed`. FAKE_DASHSCOPE_REJECT_STATUS is
// another status and FAKE_DASHSCOPE_REJECT_CODE another provider code (`Arrearage`, a 400 about the account), which `http-<status>` answers with too. An error body echoes the key.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rsiLabConfigurationIssues } from '../../../../apps/server/src/rsiLabConfiguration.mjs';
import { main } from '../../frontier_labels.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(`--${name}`) + 1];
const env = process.env;

const loadLedger = () => (existsSync(env.FAKE_BUDGET_LEDGER) ? JSON.parse(readFileSync(env.FAKE_BUDGET_LEDGER, 'utf8')) : { records: {}, granted: 0, settles: [] });
const budget = {
  async reserve({ campaignId, stageKey, amountCny }) {
    const ledger = loadLedger(), key = `${campaignId}|${stageKey}`, existing = ledger.records[key];
    if (existing && existing.state !== 'reserved') return { authorized: false, reason: 'campaign_budget_already_dispatched' };
    if (!existing && ledger.granted >= Number(env.FAKE_BUDGET_ALLOW_RESERVES ?? Infinity)) return { authorized: false, reason: env.FAKE_BUDGET_REFUSAL ?? 'campaign_budget_exceeded' };
    if (!existing) ledger.granted++;
    ledger.records[key] = { state: 'reserved', amountCny, campaignId };
    writeFileSync(env.FAKE_BUDGET_LEDGER, JSON.stringify(ledger));
    return { authorized: true, reason: null };
  },
  async beginSpend({ campaignId, stageKey }) {
    const ledger = loadLedger();
    ledger.records[`${campaignId}|${stageKey}`].state = 'in-flight';
    writeFileSync(env.FAKE_BUDGET_LEDGER, JSON.stringify(ledger));
    return { authorized: true, reason: null };
  },
  async settle({ campaignId, stageKey, outcome, actualCny }) {
    const ledger = loadLedger(), record = ledger.records[`${campaignId}|${stageKey}`];
    record.state = 'settled';
    ledger.settles.push({ campaignId, stageKey, outcome, actualCny, reservedCny: record.amountCny });
    writeFileSync(env.FAKE_BUDGET_LEDGER, JSON.stringify(ledger));
    return { authorized: true, reason: null };
  },
};
const openBudget = async (configPath) => {
  const configuration = JSON.parse(readFileSync(configPath, 'utf8'));
  const issues = rsiLabConfigurationIssues(configuration);
  if (issues.length) throw Object.assign(new Error(issues[0]), { code: issues[0] });
  return { budget, close: async () => {}, model: configuration.providers.qwenMax.model };
};

const gold = env.FAKE_DASHSCOPE_GOLD ? readFileSync(env.FAKE_DASHSCOPE_GOLD, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const fetchImpl = async (url, { headers, body }) => {
  const request = JSON.parse(body);
  const system = request.messages.find((message) => message.role === 'system')?.content ?? '', user = request.messages.find((message) => message.role === 'user')?.content ?? '';
  const title = /标题 Title: (.*)/.exec(user)?.[1] ?? '';
  const key = readFileSync(flag('credential'), 'utf8').trim();
  appendFileSync(env.FAKE_DASHSCOPE_LOG, `${JSON.stringify({ url, model: request.model, title, system: createHash('sha256').update(system).digest('hex').slice(0, 8), authorized: headers.authorization === `Bearer ${key}` })}\n`);
  const mode = env.FAKE_DASHSCOPE_MODE ?? 'ok';
  if (headers.authorization !== `Bearer ${key}`) return new Response('{}', { status: 401 });
  if (mode.startsWith('http-')) return new Response(JSON.stringify({ error: { code: env.FAKE_DASHSCOPE_REJECT_CODE, message: `rejected ${key}` } }), { status: Number(mode.slice(5)) });
  if (env.FAKE_DASHSCOPE_REJECT && title.includes(env.FAKE_DASHSCOPE_REJECT)) return new Response(JSON.stringify({ error: { code: env.FAKE_DASHSCOPE_REJECT_CODE || 'data_inspection_failed', message: `rejected ${key}` } }), { status: Number(env.FAKE_DASHSCOPE_REJECT_STATUS || 400) });
  let worth = env.FAKE_DASHSCOPE_WORTH ?? 'by-title';
  if (worth === 'by-title') worth = gold.find((row) => row.title_raw === title)?.label?.worth ?? /\[(pick|ok|no)\]/.exec(title)?.[1] ?? 'ok';
  return new Response(JSON.stringify({ id: 'chatcmpl-fake', choices: [{ message: { content: JSON.stringify({ worth, why: 'fake' }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1500, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 1000 } } }), { status: 200, headers: { 'x-request-id': 'rid-fake' } });
};

main(argv, { openBudget, fetchImpl }).catch((error) => {
  console.error(JSON.stringify({ error: error?.code ?? error?.message ?? 'jury_cli_failed' }));
  process.exitCode = 1;
});
