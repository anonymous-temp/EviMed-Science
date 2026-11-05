#!/usr/bin/env python3
"""Claude judge runner: one independent `claude -p` call per packet and pass, blind, resumable; and the remap of its verdicts to the exporter's run keys.

  claude_judge.py judge PACKETS_DIR --model claude-sonnet-5-5 --effort medium --judge-id ID --dialect questions|score|race|pairwise --brief judge/briefs/<name>.md
                        --parts DIR [--concurrency 2] [--attempts 3] [--timeout 1800] [--retry-wait 5] [--log FILE] [--claude BIN]
  claude_judge.py remap --keys operator/keys.json --parts DIR --dialect questions|score|race --bench-key KEY --repeats N --out STEM [--key-template T]

Judges are Claude (owner 2026-11-03; an offline judge is never DeepSeek or Qwen): --model is required and refused unless it is a `claude-*` id, and
--effort (one of the CLI's levels: low, medium, high, xhigh, max) and --judge-id (the id the round registration names) are required: the same model at
another effort is another judge, and what judged is bound to every verdict line.
The packets are the ones judged_packets_round.py / drb_pairwise.py / judge_packets.py write: a directory with a meta.json that has a `key` (and
optionally `pass`, `delivery`), found under PACKETS_DIR. A call is blind by construction:

  * it runs in a fresh scratch directory that holds a copy of that one packet (links followed, so a pass-2 packet's linked trees are real files);
    the CLI runs `--effort <level> --safe-mode --restricted --tools Read,Glob,Grep --permission-mode dontAsk --no-session-persistence`: no shell, no web, no
    write, no MCP, no CLAUDE.md or settings of this box, file access confined to that directory, no session kept, so no call has seen another's verdict;
  * the environment is the box's own Claude login: ANTHROPIC_*, CLAUDE_CODE_*, CLAUDE_AGENT_*, CLAUDE_CONFIG*, DEEPSEEK_*, DASHSCOPE_* and the like of
    the starting shell are dropped (the list of the frontier jury, evals/rsi-campaigns/frontier_labels.mjs);
  * arm names, run ids and order are not in a packet (the key to the arms is in operator/, which this tool never reads in `judge`).

A verdict is accepted only when it matches its packet (the checks of each dialect below) and is otherwise asked again (--attempts); what is accepted is
written, canonical and stamped with the packet's `delivery` and `pass` and with what judged it (`judge`, `model`, `effort`), to PARTS/<key>.p<pass>.jsonl,
atomically. A part that exists is never asked for again, so running the same command after any stop continues it. PARTS records the model, effort, judge id,
dialect and brief digest (judge.json) and refuses a resume with another. A spent usage window (429, usage limit), a refused login or a CLI that cannot be
started ends the run at once with exit 3; an overloaded or failing service is transient and asked again; a packet that failed all its attempts ends the
run with exit 3 too. What the CLI printed is never written to judge.log or into an error: a failed call is named by a closed code (CALL_FAILURES).

  questions  bixbench: one line per question of questions.json, {"key": "<meta.key>#<qid>", "verdict": "correct"|"incorrect", "rationale"}
  score      rcb: one line {"key", "score": 0-100, "items": [{"id", "weight", "score", "why"}], "notes"}, one item per rubric item of target_study/checklist.json
  race       drb absolute: {"key", "race": 0-1, "target_total", "reference_total", ...}; race must be target / (target + reference) when both are given
  pairwise   drb pairwise: {"key", "scores": {dimension: [{"idx", "pref": -3..3}]}, "notes"}, every criterion of criteria.json once (drb_pairwise.pass_prefs)

`remap` turns the opaque packet keys of the three absolute dialects into the exporter's run keys, one file per pass, `STEM.p<k>.jsonl`, the shape
export_harness_arms.py --verdicts reads (--dialect percent for score, race for race, questions for questions):
`{"key": <run key>[#qid], "score"|"race"|"verdict", "judge", "model", "effort"}`. It reads PARTS/judge.json (required, of this dialect) and every part line's
stamps, which must be judge.json's; what judged travels into every line it writes. Every packet of keys.json must have a verdict in every pass (never a
half-set). Pairwise parts need no remap: drb_pairwise.py aggregate --order ... reads
them as they are. The packets of judged_packets_round.py repeat a pairwise key in every drb-pair-<k> directory (each has its own order.json), so a pairwise run
is one `judge` per drb-pair-<k> directory with its own --parts; two packets that share a key and pass in one run are refused. Python 3.10 compatible; run with `python3 -I`.

Exit: 0 done, 2 refusal or usage, 3 stopped or some packet failed (run the same command again).
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path
import drb_pairwise as dp  # noqa: E402
import export_harness_arms as eha  # noqa: E402

MODEL = re.compile(r'claude-[a-z0-9-]+')
# The Claude CLI's effort levels.
EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')
JUDGE_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}')
CLI_TOOLS = 'Read,Glob,Grep'
# What would point the CLI at another account, endpoint or provider.
SCRUB_PREFIXES = ('ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_', 'CLAUDE_CONFIG', 'CLAUDE_EFFORT', 'CLAUDE_PID', 'AWS_BEARER', 'GOOGLE_CLOUD_', 'VERTEX', 'DEEPSEEK_',
                  'DASHSCOPE_')
SCRUB_EXACT = {'CLAUDECODE', 'AI_AGENT', 'CLOUD_ML_REGION'}
# The frontier jury's classification (frontier_labels.mjs cliFailure): a spent window and a refused login stop the run; an overloaded service is transient.
QUOTA_TEXT = re.compile(r'usage limit|rate limit|limit reached|quota|credit balance|too many requests|resets? at', re.I)
AUTH_TEXT = re.compile(r'invalid api key|please run /login|not logged in|unauthori[sz]ed|authentication|oauth', re.I)
OVERLOADED_TEXT = re.compile(r'overloaded', re.I)
# Every way a call can fail, by a closed code (what the CLI printed is never kept). The first three stop the run: a retry would change nothing.
CALL_FAILURES = ('judge_quota', 'judge_auth', 'judge_cli_unavailable', 'judge_transport', 'judge_cli_error', 'judge_timeout', 'judge_bad_response',
                 'judge_verdict_mismatch', 'judge_packet_unstaged')
HALTING = ('judge_quota', 'judge_auth', 'judge_cli_unavailable')
MAX_CONCURRENCY = 4
SCHEMA = 'claude-judge/2'


class JudgingError(Exception):
    pass


class CallFailure(Exception):
    """A call that gave no accepted verdict, by its closed code (CALL_FAILURES); it carries nothing the CLI printed."""

    def __init__(self, code):
        assert code in CALL_FAILURES, code
        super().__init__(code)
        self.code = code


# ---------------------------------------------------------------------------------------------------------------------------------- packets

class Packet:
    def __init__(self, directory, meta):
        self.dir, self.meta, self.key = pathlib.Path(directory), meta, meta['key']
        self.pass_no = meta['pass'] if isinstance(meta.get('pass'), int) and not isinstance(meta.get('pass'), bool) and meta['pass'] >= 1 else 1

    @property
    def part(self):
        return re.sub(r'[^A-Za-z0-9_.-]+', '__', self.key) + f'.p{self.pass_no}.jsonl'


def find_packets(root):
    """Every packet under root: a directory whose meta.json has a string `key`. A packet's own subdirectories are not searched."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        if 'meta.json' not in filenames:
            continue
        try:
            meta = json.loads((pathlib.Path(dirpath) / 'meta.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(meta, dict) and isinstance(meta.get('key'), str) and meta['key']:
            found.append(Packet(dirpath, meta))
            dirnames[:] = []
    found.sort(key=lambda p: (p.key, p.pass_no))
    names = {}
    for p in found:
        if p.part in names:
            raise JudgingError(f'two packets share the verdict file {p.part} ({names[p.part]} and {p.dir}): same key and pass, or keys that differ only in punctuation')
        names[p.part] = p.dir
    return found


def stage(packet, scratch):
    """A copy of the packet in a fresh directory, links followed (a pass-2 packet's linked trees become real files), nothing else beside it."""
    target = pathlib.Path(scratch) / 'packet'
    try:
        shutil.copytree(packet.dir, target, symlinks=False)
    except (OSError, shutil.Error):
        raise CallFailure('judge_packet_unstaged') from None
    return target


# ---------------------------------------------------------------------------------------------------------------------------------- verdicts

def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _first_object(text):
    start = text.find('{')
    if start < 0:
        raise CallFailure('judge_bad_response')
    try:
        obj, _ = json.JSONDecoder().raw_decode(text[start:])
    except ValueError:
        raise CallFailure('judge_bad_response') from None
    if not isinstance(obj, dict):
        raise CallFailure('judge_bad_response')
    return obj


def _notes(obj, limit=400):
    return str(obj.get('notes', ''))[:limit]


def parse_questions(text, packet):
    questions = [q['qid'] for q in json.loads((packet.dir / 'questions.json').read_text(encoding='utf-8'))['questions']]
    seen = {}
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw.startswith('{'):
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        key, _, question = str(obj.get('key', '')).rpartition('#')
        if key != packet.key or question not in questions or obj.get('verdict') not in ('correct', 'incorrect'):
            raise CallFailure('judge_verdict_mismatch')
        if question in seen:
            raise CallFailure('judge_verdict_mismatch')
        seen[question] = {'key': f'{packet.key}#{question}', 'verdict': obj['verdict'], 'rationale': str(obj.get('rationale', ''))[:300]}
    if set(seen) != set(questions):
        raise CallFailure('judge_verdict_mismatch')
    return [seen[q] for q in questions]


def parse_score(text, packet):
    obj = _first_object(text)
    score = obj.get('score')
    if obj.get('key') != packet.key or not _number(score) or not 0 <= score <= 100:
        raise CallFailure('judge_verdict_mismatch')
    items = obj.get('items')
    if not isinstance(items, list) or not items or any(not isinstance(i, dict) or not _number(i.get('score')) or not 0 <= i['score'] <= 100 for i in items):
        raise CallFailure('judge_verdict_mismatch')
    checklist = packet.dir / 'target_study' / 'checklist.json'
    if checklist.is_file():
        rubric = json.loads(checklist.read_text(encoding='utf-8'))
        if len(items) != len(rubric):
            raise CallFailure('judge_verdict_mismatch')
    return [{'key': packet.key, 'score': score, 'items': items, 'notes': _notes(obj)}]


def parse_race(text, packet):
    obj = _first_object(text)
    race = obj.get('race')
    if obj.get('key') != packet.key or not _number(race) or not 0 <= race <= 1:
        raise CallFailure('judge_verdict_mismatch')
    record = {'key': packet.key, 'race': race}
    target, reference = obj.get('target_total'), obj.get('reference_total')
    if _number(target) and _number(reference):
        if target < 0 or reference < 0 or target + reference <= 0 or abs(race - target / (target + reference)) > 0.005:
            raise CallFailure('judge_verdict_mismatch')
        record.update({'target_total': target, 'reference_total': reference})
    record['notes'] = _notes(obj)
    return [record]


def parse_pairwise(text, packet):
    obj = _first_object(text)
    if obj.get('key') != packet.key:
        raise CallFailure('judge_verdict_mismatch')
    criteria = json.loads((packet.dir / 'criteria.json').read_text(encoding='utf-8'))
    shown, why = dp.pass_prefs([obj], criteria, packet.key)
    if shown is None:
        raise CallFailure('judge_verdict_mismatch')
    return [{'key': packet.key, 'scores': obj['scores'], 'notes': _notes(obj)}]


DIALECTS = {'questions': parse_questions, 'score': parse_score, 'race': parse_race, 'pairwise': parse_pairwise}


def stamped(records, packet, who):
    """The accepted records as part lines: the packet's `delivery` and `pass`, and what judged them (`who`: judge, model, effort)."""
    out = []
    for record in records:
        record = dict(record)
        if 'delivery' in packet.meta:
            record['delivery'] = packet.meta['delivery']
        if 'pass' in packet.meta:
            record['pass'] = packet.meta['pass']
        record.update(who)
        out.append(json.dumps(record, ensure_ascii=False))
    return out


# ---------------------------------------------------------------------------------------------------------------------------------- the call

def child_env():
    env = {k: v for k, v in os.environ.items() if not (k in SCRUB_EXACT or k.startswith(SCRUB_PREFIXES))}
    env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
    env['DISABLE_TELEMETRY'] = '1'
    return env


def argv_of(cli, model, effort):
    return [cli, '-p', '--output-format', 'json', '--model', model, '--effort', effort, '--safe-mode', '--restricted', '--tools', CLI_TOOLS, '--permission-mode', 'dontAsk',
            '--permission-prompts', 'none', '--no-session-persistence']


def run_cli(argv, prompt, cwd, timeout):
    """(returncode, stdout). A call past its time takes its whole process group with it (judge_timeout); a CLI that cannot be started is judge_cli_unavailable."""
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=child_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    except OSError:
        raise CallFailure('judge_cli_unavailable') from None
    try:
        out, _ = process.communicate(prompt, timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise CallFailure('judge_timeout') from None
    return process.returncode, out


def failure_of(status, text, said_failed):
    """The closed code of a failed call, as the frontier jury classifies it (frontier_labels.mjs cliFailure): a spent window or a refused login stops
    the run; an overloaded or failing service (5xx) and a CLI that never reached the model are transient."""
    if status == 429 or QUOTA_TEXT.search(text):
        return 'judge_quota'
    if status in (401, 403) or AUTH_TEXT.search(text):
        return 'judge_auth'
    if (isinstance(status, int) and status >= 500) or OVERLOADED_TEXT.search(text):
        return 'judge_transport'
    return 'judge_cli_error' if said_failed else 'judge_transport'


def judge_once(cli, model, effort, parse, prompt, packet, scratch_dir, timeout):
    """(canonical records, API-equivalent USD the CLI reported). Raises CallFailure: a halting code stops the run, any other is asked again."""
    with tempfile.TemporaryDirectory(prefix='claude-judge-', dir=scratch_dir) as scratch:
        staged = stage(packet, scratch)
        code, out = run_cli(argv_of(cli, model, effort), prompt, staged, timeout)
    try:
        result = json.loads(out)
    except ValueError:
        result = None
    if not isinstance(result, dict):
        raise CallFailure(failure_of(None, str(out or '')[:2000], False) if code != 0 else 'judge_bad_response')
    text = str(result.get('result') or '')
    status = result.get('api_error_status') if isinstance(result.get('api_error_status'), int) and not isinstance(result.get('api_error_status'), bool) else None
    if result.get('is_error') or code != 0:
        raise CallFailure(failure_of(status, text, True))
    usd = float(result['total_cost_usd']) if _number(result.get('total_cost_usd')) else None  # None: the CLI reported no cost, which is not a zero
    return parse(text, packet), usd


def usd_text(usd):
    """The log's figure for a call: the API-equivalent USD, or `none` when the CLI reported none (round_spend.mjs reads `none` as unreported)."""
    return 'none' if usd is None else f'{usd:.4f}'


def claim_parts(parts, record):
    """PARTS belongs to one model, dialect and brief; a resume with another is refused."""
    path = parts / 'judge.json'
    if path.is_file():
        have = json.loads(path.read_text(encoding='utf-8'))
        differs = sorted(k for k in record if have.get(k) != record[k])
        if differs:
            raise JudgingError(f'{parts} was judged with a different {", ".join(differs)}: resume with the same, or use a new --parts')
        return
    path.write_text(json.dumps(record, indent=1) + '\n', encoding='utf-8')


def judge(args):
    if not MODEL.fullmatch(args.model):
        raise JudgingError(f'--model {args.model!r}: judges are Claude (owner 2026-11-03), a claude-* id')
    if not JUDGE_ID.fullmatch(args.judge_id):
        raise JudgingError(f'--judge-id {args.judge_id!r} is an identifier (letters, digits, _.:-), the id the round registration names')
    brief = pathlib.Path(args.brief).read_bytes()
    prompt = brief.decode('utf-8')
    packets = find_packets(args.packets)
    if not packets:
        raise JudgingError(f'no packet under {args.packets} (a directory with a meta.json that has a key)')
    parts = pathlib.Path(args.parts)
    if any(parts.resolve() == p.dir.resolve() or p.dir.resolve() in parts.resolve().parents for p in packets):
        raise JudgingError('--parts is inside a packet')
    parts.mkdir(parents=True, exist_ok=True)
    who = {'judge': args.judge_id, 'model': args.model, 'effort': args.effort}
    claim_parts(parts, {'schema': SCHEMA, **who, 'dialect': args.dialect, 'briefSha256': hashlib.sha256(brief).hexdigest()})
    cli = args.claude or os.environ.get('CLAUDE_JUDGE_BIN') or shutil.which('claude') or 'claude'
    parse = DIALECTS[args.dialect]
    pending = [p for p in packets if not (parts / p.part).is_file()]
    log = pathlib.Path(args.log) if args.log else parts / 'judge.log'
    lock, stop = threading.Lock(), threading.Event()
    state = {'done': 0, 'failed': 0, 'skipped': 0, 'usd': 0.0, 'halted': None}

    def note(text):
        with open(log, 'a', encoding='utf-8') as handle:
            handle.write(f'{time.strftime("%FT%TZ", time.gmtime())} {text} ({state["done"]} done, {state["failed"]} failed of {len(pending)})\n')

    def one(packet):
        if stop.is_set():
            with lock:
                state['skipped'] += 1
            return
        last, records, usd = 'judge_not_asked', None, None
        for attempt in range(1, args.attempts + 1):
            if stop.is_set():
                break
            try:
                records, usd = judge_once(cli, args.model, args.effort, parse, prompt, packet, args.scratch, args.timeout)
                break
            except CallFailure as error:
                last = error.code
            except (ValueError, KeyError, OSError):
                last = 'judge_verdict_mismatch'  # a packet file the check reads is not what it should be
            if last in HALTING:
                stop.set()
                break
            time.sleep(args.retry_wait)
        with lock:
            if records is None:
                state['skipped' if last in HALTING or last == 'judge_not_asked' else 'failed'] += 1
                note(f'FAILED {packet.key} p{packet.pass_no}: {last}')
                if last in HALTING:
                    state['halted'] = last
                return
            target = parts / packet.part
            tmp = target.with_suffix('.tmp')
            tmp.write_text('\n'.join(stamped(records, packet, who)) + '\n', encoding='utf-8')
            tmp.replace(target)
            state['done'] += 1
            state['usd'] += usd or 0.0
            note(f'ok {packet.key} p{packet.pass_no} usd {usd_text(usd)}')

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        list(pool.map(one, pending))
    print(f'judge: {len(packets)} packet(s), {len(packets) - len(pending)} already judged, {state["done"]} done, {state["failed"]} failed, '
          f'{state["skipped"]} not asked after a stop; API-equivalent USD {state["usd"]:.2f}')
    if stop.is_set():
        print({'judge_quota': 'judge: stopped (judge_quota): the usage window of the Claude login is spent; run the same command again after the reset',
               'judge_auth': 'judge: stopped (judge_auth): the Claude login was refused; log in again on this box and run the same command',
               'judge_cli_unavailable': 'judge: stopped (judge_cli_unavailable): the claude CLI cannot be started (--claude, CLAUDE_JUDGE_BIN or PATH)'}[state['halted']],
              file=sys.stderr)
    return 0 if not state['failed'] and not stop.is_set() else 3


# ---------------------------------------------------------------------------------------------------------------------------------- remap

def judge_record(parts, dialect):
    """PARTS/judge.json: what judged these parts (model, effort, judge id), of this dialect. A part directory without it has no judge to name."""
    path = pathlib.Path(parts) / 'judge.json'
    if not path.is_file():
        raise JudgingError(f'{path} is missing: parts without the record of what judged them cannot be exported')
    record = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(record, dict) or record.get('schema') != SCHEMA or record.get('dialect') != dialect:
        raise JudgingError(f'{path} is not a {SCHEMA} record of the {dialect} dialect')
    if not isinstance(record.get('model'), str) or not MODEL.fullmatch(record['model']) or record.get('effort') not in EFFORTS \
            or not isinstance(record.get('judge'), str) or not JUDGE_ID.fullmatch(record['judge']):
        raise JudgingError(f'{path} does not name the judge (a claude-* model, an effort, a judge id)')
    return {'judge': record['judge'], 'model': record['model'], 'effort': record['effort']}


def remap(args):
    keys = json.loads(pathlib.Path(args.keys).read_text(encoding='utf-8'))
    parts = pathlib.Path(args.parts)
    who = judge_record(parts, args.dialect)
    template = args.key_template or eha.DEFAULT_KEY_TEMPLATE
    by_part = {}
    for packet_key, entry in keys.items():
        by_part[re.sub(r'[^A-Za-z0-9_.-]+', '__', packet_key)] = (packet_key, entry)
    passes = {}
    for path in sorted(parts.glob('*.jsonl')):
        found = re.fullmatch(r'(.+)\.p(\d+)', path.stem)
        if not found or found.group(1) not in by_part:
            raise JudgingError(f'{path.name} is not a verdict file of a packet in {args.keys}')
        passes.setdefault(int(found.group(2)), {})[found.group(1)] = path
    if not passes:
        raise JudgingError(f'no verdict files in {parts}')
    field = {'questions': 'verdict', 'score': 'score', 'race': 'race'}[args.dialect]
    written = {}
    for k in sorted(passes):
        lines = []
        for stem, (packet_key, entry) in by_part.items():
            path = passes[k].get(stem)
            if path is None:
                raise JudgingError(f'packet {packet_key} has no verdict for pass {k}')
            run_key = eha.run_key(template, args.bench_key, entry['arm'], entry['row'], entry['repeat'], args.repeats)
            for raw in path.read_text(encoding='utf-8').splitlines():
                obj = json.loads(raw)
                if any(obj.get(name) != value for name, value in who.items()):
                    raise JudgingError(f'{path.name}: a line was not judged by the judge judge.json names ({", ".join(f"{n} {v}" for n, v in who.items())})')
                if args.dialect == 'questions':
                    key, _, question = obj['key'].rpartition('#')
                    if key != packet_key:
                        raise JudgingError(f'{path.name}: a line names another packet')
                    lines.append(json.dumps({'key': f'{run_key}#{question}', 'verdict': obj['verdict'], **who}))
                else:
                    if obj['key'] != packet_key:
                        raise JudgingError(f'{path.name}: a line names another packet')
                    lines.append(json.dumps({'key': run_key, field: obj[field], **who}))
        written[k] = lines
    for k, lines in written.items():  # nothing is written before every pass of every packet has been read
        out = pathlib.Path(f'{args.out}.p{k}.jsonl')
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('remap:', ', '.join(f'pass {k}: {len(lines)} line(s)' for k, lines in sorted(written.items()))
          + f"; judged by {who['judge']} ({who['model']} at {who['effort']}): export with --registration naming that judge and --judge-record {parts / 'judge.json'}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    j = sub.add_parser('judge')
    j.add_argument('packets')
    j.add_argument('--model', required=True)
    j.add_argument('--effort', required=True, choices=EFFORTS, help='the CLI effort the judge runs at (the registration names it)')
    j.add_argument('--judge-id', required=True, help='the judge id the round registration names; stamped on every verdict line')
    j.add_argument('--dialect', required=True, choices=sorted(DIALECTS))
    j.add_argument('--brief', required=True)
    j.add_argument('--parts', required=True)
    j.add_argument('--concurrency', type=int, default=2)
    j.add_argument('--attempts', type=int, default=3)
    j.add_argument('--timeout', type=int, default=1800)
    j.add_argument('--retry-wait', type=float, default=5.0)
    j.add_argument('--log')
    j.add_argument('--claude')
    j.add_argument('--scratch', help='where the per-call copies of a packet are made (default: the system temporary directory)')
    r = sub.add_parser('remap')
    r.add_argument('--keys', required=True)
    r.add_argument('--parts', required=True)
    r.add_argument('--dialect', required=True, choices=['questions', 'score', 'race'])
    r.add_argument('--bench-key', required=True)
    r.add_argument('--repeats', type=int, required=True)
    r.add_argument('--key-template')
    r.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    if args.command == 'judge' and not 1 <= args.concurrency <= MAX_CONCURRENCY:
        parser.error(f'--concurrency is 1 to {MAX_CONCURRENCY}')
    try:
        return {'judge': judge, 'remap': remap}[args.command](args) or 0
    except (JudgingError, eha.ExportError, OSError, KeyError, ValueError) as error:
        print(f'claude_judge: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
