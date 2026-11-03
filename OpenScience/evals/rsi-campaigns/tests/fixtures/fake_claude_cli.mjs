#!/usr/bin/env node
// A stand-in for the operator's `claude` CLI as the frontier jury calls it (print mode, JSON output, system prompt from a file, user message on stdin).
// It appends one line per call to FAKE_CLAUDE_LOG (argv, the system file's content, stdin, the names of the environment variables it was given, cwd) and
// answers by FAKE_CLAUDE_MODE: ok (default) | quota | quota-text | auth | auth-text | overloaded | other-error | transport | timeout | badjson | empty | prose.
// FAKE_CLAUDE_WORTH is the label it answers with (default ok); FAKE_CLAUDE_WORTH=by-title answers the anchor's own label when FAKE_CLAUDE_GOLD (the gold file)
// has the item's title, else the `[pick]`, `[ok]` or `[no]` the item's title carries, else ok. It never prints a credential: the texts it fails with are fixed strings
// the tests must not see in an error.
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const systemFile = argv[argv.indexOf('--system-prompt-file') + 1];
appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, system: systemFile ? readFileSync(systemFile, 'utf8') : null, systemFile, stdin, env: Object.keys(process.env).sort(), cwd: process.cwd() })}\n`);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
let worth = process.env.FAKE_CLAUDE_WORTH ?? 'ok';
if (worth === 'by-title') {
  const title = /标题 Title: (.*)/.exec(stdin)?.[1] ?? '';
  const gold = process.env.FAKE_CLAUDE_GOLD ? readFileSync(process.env.FAKE_CLAUDE_GOLD, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.title_raw === title) : null;
  worth = gold?.label?.worth ?? /\[(pick|ok|no)\]/.exec(title)?.[1] ?? 'ok';
}
const usage = { input_tokens: 700, cache_creation_input_tokens: 40, cache_read_input_tokens: 1200, output_tokens: 33 };
const reply = (extra) => { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.01, session_id: 'sess-1', usage, ...extra })); process.exit(0); };
const failure = (result, extra = {}) => reply({ subtype: 'error_during_execution', is_error: true, result, usage: {}, ...extra });
if (mode === 'ok') reply({ result: JSON.stringify({ worth, why: 'fake' }) });
if (mode === 'prose') reply({ result: `Let me think first.\n{"worth":"pick","why":"x"}` });
if (mode === 'quota') failure('5-hour limit reached - resets at 3pm (sk-ant-LEAK)', { api_error_status: 429 });
if (mode === 'quota-text') failure('You have hit your usage limit (sk-ant-LEAK)');
if (mode === 'auth') failure('Invalid API key sk-ant-LEAK', { api_error_status: 401 });
if (mode === 'auth-text') { console.log('Not logged in - please run /login sk-ant-LEAK'); process.exit(1); }
if (mode === 'overloaded') failure('Overloaded sk-ant-LEAK', { api_error_status: 529 });
if (mode === 'other-error') failure('something odd sk-ant-LEAK');
if (mode === 'transport') { console.error('socket hang up sk-ant-LEAK'); process.exit(1); }
if (mode === 'timeout') setTimeout(() => {}, 60_000);
else if (mode === 'badjson') { console.log('not json sk-ant-LEAK'); process.exit(0); }
else if (mode === 'empty') reply({ result: '   ' });
