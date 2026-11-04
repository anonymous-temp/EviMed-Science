#!/usr/bin/env python3
"""A stand-in for `claude -p` as claude_judge.py calls it: the brief on stdin, one JSON result on stdout, the packet in the working directory.

It answers from what the working directory holds (questions.json = bixbench, target_study/checklist.json = rcb, criteria.json + report_1.md = pairwise,
criteria.json + target.md = race) and appends one line per call to FAKE_JUDGE_LOG: the packet key, the model, the flags, the files and links it could see,
the working directory's name and whether any inherited credential or endpoint variable reached it. FAKE_JUDGE_MODE:

  ok (default) | fence (the answer inside a code fence) | bad_first (the first call per packet is not a verdict) | always_bad | short (one question, item
  or criterion missing) | bad_race | quota (429) | auth (401) | overloaded (529, every call) | overloaded_first (529 on a packet's first call) | crash (exit 1, no
  JSON) | hang | fail_key (always_bad for packets whose key contains FAKE_JUDGE_FAIL_KEY). Every failure says LEAK-<mode> in its text, which must never reach a log.
FAKE_JUDGE_STATE is a directory the fake keeps its per-packet call counters in.
"""
import hashlib
import json
import os
import pathlib
import sys
import time

argv = sys.argv[1:]
prompt = sys.stdin.read()
cwd = pathlib.Path.cwd()
mode = os.environ.get('FAKE_JUDGE_MODE', 'ok')
meta = json.loads((cwd / 'meta.json').read_text())
key = meta['key']
leak = sorted(k for k in os.environ if k.startswith(('ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_', 'DEEPSEEK_', 'DASHSCOPE_', 'VERTEX')) and k not in
              ('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',))
state = pathlib.Path(os.environ['FAKE_JUDGE_STATE'])
counter = state / hashlib.sha256(f'{key}|{meta.get("pass")}'.encode()).hexdigest()[:16]
calls = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(calls))
with open(os.environ['FAKE_JUDGE_LOG'], 'a') as handle:
    handle.write(json.dumps({
        'key': key, 'pass': meta.get('pass'), 'call': calls, 'model': argv[argv.index('--model') + 1] if '--model' in argv else None,
        'effort': argv[argv.index('--effort') + 1] if '--effort' in argv else None,
        'flags': [a for a in argv if a.startswith('--') or a == '-p'], 'tools': argv[argv.index('--tools') + 1] if '--tools' in argv else None,
        'permission_mode': argv[argv.index('--permission-mode') + 1] if '--permission-mode' in argv else None,
        'files': sorted(str(p.relative_to(cwd)) for p in cwd.rglob('*') if p.is_file()), 'links': sorted(str(p.relative_to(cwd)) for p in cwd.rglob('*') if p.is_symlink()),
        'cwd_name': cwd.name, 'cwd_path': str(cwd), 'leaked_env': leak, 'prompt_sha': hashlib.sha256(prompt.encode()).hexdigest()[:12],
    }) + '\n')


def reply(text, **extra):
    out = {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': text, 'total_cost_usd': 0.02, 'num_turns': 3, 'api_error_status': None}
    out.update(extra)
    print(json.dumps(out))
    sys.exit(0)


if mode == 'quota':
    reply('LEAK-quota 5-hour limit reached - resets at 3pm', is_error=True, subtype='error_during_execution', api_error_status=429)
if mode == 'auth':
    reply('LEAK-auth Invalid API key - please run /login', is_error=True, subtype='error_during_execution', api_error_status=401)
if mode == 'overloaded' or (mode == 'overloaded_first' and calls == 1):
    reply('LEAK-overloaded API Error: Overloaded', is_error=True, subtype='error_during_execution', api_error_status=529)
if mode == 'crash':
    sys.stdout.write('LEAK-crash socket hang up\n')
    sys.stderr.write('LEAK-crash socket hang up\n')
    sys.exit(1)
if mode == 'hang':
    time.sleep(30)
if mode == 'always_bad' or (mode == 'bad_first' and calls == 1) or (mode == 'fail_key' and os.environ.get('FAKE_JUDGE_FAIL_KEY', '\0') in key):
    reply('LEAK-bad I could not judge this one.')

short = mode == 'short'
if (cwd / 'questions.json').is_file():
    questions = json.loads((cwd / 'questions.json').read_text())['questions']
    lines = [json.dumps({'key': f'{key}#{q["qid"]}', 'verdict': 'correct' if i % 2 == 0 else 'incorrect', 'rationale': 'matches' if i % 2 == 0 else 'does not'})
             for i, q in enumerate(questions)]
    text = '\n'.join(lines[:-1] if short else lines)
elif (cwd / 'target_study' / 'checklist.json').is_file():
    rubric = json.loads((cwd / 'target_study' / 'checklist.json').read_text())
    items = [{'id': i, 'weight': 1, 'score': 60, 'why': 'ok'} for i in range(len(rubric))]
    text = json.dumps({'key': key, 'score': 60, 'items': items[:-1] if short else items, 'notes': 'fine'})
elif (cwd / 'report_1.md').is_file():
    criteria = json.loads((cwd / 'criteria.json').read_text())
    scores = {dim: [{'idx': i, 'pref': 1} for i in range(len(lst))] for dim, lst in criteria['criterions'].items()}
    if short:
        scores[next(iter(scores))].pop()
    text = json.dumps({'key': key, 'scores': scores, 'notes': 'report 1 a little better'})
elif (cwd / 'target.md').is_file():
    text = json.dumps({'key': key, 'race': 0.9 if mode == 'bad_race' else 0.4, 'target_total': 4.0, 'reference_total': 6.0, 'dims': {}, 'notes': 'n'})
else:
    text = 'nothing to judge here'
reply(('```json\n' + text + '\n```') if mode == 'fence' else text)
