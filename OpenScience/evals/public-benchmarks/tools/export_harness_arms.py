#!/usr/bin/env python3
"""Build a `harness-arms` source (evals/rsi-campaigns/harness_campaign.mjs) from bench-driver/3 results.

A harness-patch candidate is a patched runtime image: always-on guidance text plus skills, measured on the image it was
built on. The baseline arm is the unmodified image; an optional `aa` arm is a second run of the unmodified image (the A/A
negative control of the development gate). This script turns the fetched run folders of the arms into the sources the RSI
lab consumes; the lab scores them, this script never does and never prints a score.

Usage (one invocation per role):
  export_harness_arms.py --role development --benchmark medcalc-bench --items items/medcalc-rsi-dev.jsonl \\
      --arm baseline=results/dev-base --arm aa=results/dev-aa --arm cand-0123456789ab=results/dev-c1 \\
      --bundles rsi/bundles.json --image-id evimed-5c740327bb8c-1 --image-digest <64 hex> --bench-key medcalc-rsi \\
      --repeats 1 --out rsi/development.json
  export_harness_arms.py --role confirmation ... --repeats 3 --out rsi/confirmation.json

Files written next to --out (stem = --out without `.json`), each with a `<file>.sha256` in `sha256sum -c` format:
  <stem>.json            the source: kind harness-arms, schema 1, role, benchmark, image, repeats, rows, arms, runs[, judged]
  <stem>.gold.json       confirmation only, benchmarks with gold: {kind: harness-gold, schema: 1, benchmark, gold: {rowId: gold}}.
                         The sealed confirmation source carries NO gold: the lab adds it in its own assembly step, so the single
                         exported artifact cannot be scored on the dev box before the runner opens it.
  <stem>.verdicts.jsonl  judged benchmarks, once verdicts are given: one record per line {row, arm, repeat, pass, score, judge}
  <out>.incomplete.json  only with --allow-incomplete and missing runs: [{arm, row, repeat, key, reason, status, errorCode}]

Benchmarks and rows (the id is a string; rows are natural-sorted):
  medcalc-bench                       {id, calculatorId, gold: {answer, lower, upper}}
  bixbench                            {id, topic, gold: {questions: [{n, qid, eval_mode, ideal, range}]}}
  autoresearchbench-deep / -wide      {id, category, gold: {type, titles, arxiv_ids, is_none}}
  medbrowsecomp                       {id, task, gold: {task_name, answer}}
  deepresearchbench / researchclawbench   {id, category}   (judged: no gold; scores come from verdict records)
Rows come from --items (bench-driver item files; `#r<k>` is stripped from ids and ids are deduplicated; for the autoresearchbench
benchmarks only items of the matching gold type are taken) or from --rows (already in lab form: {"rows": [...]}). --row-ids
FILE ({"rows": [ids]} or a round registration whose `rows` is {development: [...], confirmation: [...]}) must equal the exported
row ids exactly.

Run classification (bench-driver/3 result.json). A run is INFRASTRUCTURE, never scored and never zero-filled, when its status is
driver_error / dispatch_refused / interrupted / canceled or anything outside succeeded / failed / timeout, when
infrastructureFailure is true, when errorCode is in INFRASTRUCTURE_CODES (or given by --infrastructure-code), or when result.json
is missing or unreadable. Everything else is a delivery outcome kept in the source with its status: succeeded, timeout, and failed
with any other code (the solver's genuine non-delivery, which the lab scores 0). Missing runs: exit 3 before anything is written;
with --allow-incomplete the source is written WITHOUT them (the lab refuses it as incomplete) plus <out>.incomplete.json, exit 3.

Judged benchmarks (--verdicts FILE..., raw judge JSONL; the pass is the file's `.p<k>.jsonl` suffix, a plain file is pass 1):
  absolute dialects  unit (line.score in [0,1]), percent (line.score / 100), race (line.race): the verdict `key` is mapped to
                     (arm, row, repeat) by building the expected key of every run with --key-template and inverting it; an
                     unknown key is an error, never dropped.
  pairwise           drb_pairwise.aggregate over --pairwise-order (repeatable) and --pair-map; each pass gives the candidate
                     share (3 + s) / 6 with s the signed preference toward the candidate (-3..+3); the baseline has no record.
A record is required for exactly each succeeded run (pairwise: each succeeded run of a non-baseline arm); a verdict for a run that
did not succeed, a missing pass or a judge id that is not --judge-id is an error. A judge id or provider matching /deepseek/i is
refused. The judge runs under the operator's Claude subscription: `judged.cost.settledCny` is 0 and says so in `note`.

Exit: 0 written, 2 error, 3 incomplete. Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import ast
import hashlib
import json
import pathlib
import re
import sys

TOOLS = pathlib.Path(__file__).resolve().parent

BENCHMARKS = {
    'medcalc-bench': {'stratum': 'calculatorId', 'gold': True, 'judged': False},
    'bixbench': {'stratum': 'topic', 'gold': True, 'judged': False},
    'autoresearchbench-deep': {'stratum': 'category', 'gold': True, 'judged': False},
    'autoresearchbench-wide': {'stratum': 'category', 'gold': True, 'judged': False},
    'medbrowsecomp': {'stratum': 'task', 'gold': True, 'judged': False},
    'deepresearchbench': {'stratum': 'category', 'gold': False, 'judged': True},
    'researchclawbench': {'stratum': 'category', 'gold': False, 'judged': True},
}
INFRA_STATUSES = frozenset({'driver_error', 'dispatch_refused', 'interrupted', 'canceled'})
DELIVERY_STATUSES = frozenset({'succeeded', 'failed', 'timeout'})
INFRASTRUCTURE_CODES = frozenset({
    'runtime_stopped', 'runtime_session_not_found', 'runtime_history_unavailable', 'runtime_status_unavailable',
    'runtime_event_stream_unavailable', 'runtime_wire_protocol_mismatch', 'runtime_seam_missing', 'runtime_sandbox_unavailable',
    'runtime_preset_unavailable', 'runtime_bundle_version_mismatch', 'runtime_domain_version_mismatch', 'runtime_turn_end_unknown',
    'internal_error'})
SKILL_NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
IMAGE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
DEFAULT_KEY_TEMPLATE = '{bench}/{armtoken}/{row}{rep}'
DEFAULT_JUDGE_NOTE = "Judge calls run under the operator's Claude subscription; not metered in CNY."
BASELINE, CONTROL = 'baseline', 'aa'


class ExportError(Exception):
    """An export that cannot be made; the message says why."""


# --------------------------------------------------------------------------------------------------- the candidate form

def _utf8(text, where):
    if not isinstance(text, str):
        raise ExportError(f'{where} must be a string')
    try:
        text.encode('utf-8')
    except UnicodeEncodeError:
        raise ExportError(f'{where} holds an unpaired surrogate')
    return text


def _utf16_len(text):
    return len(text.encode('utf-16-le')) // 2


def normalize_bundle(bundle):
    """The bundle {guidanceSupplement, skills: [{name, description, body}]} with its skills sorted by name, or an ExportError."""
    if not isinstance(bundle, dict) or set(bundle) != {'guidanceSupplement', 'skills'}:
        raise ExportError('a bundle has exactly the keys guidanceSupplement and skills')
    guidance = _utf8(bundle['guidanceSupplement'], 'guidanceSupplement')
    if not isinstance(bundle['skills'], list):
        raise ExportError('skills must be a list')
    skills, seen = [], set()
    for skill in bundle['skills']:
        if not isinstance(skill, dict) or set(skill) != {'name', 'description', 'body'}:
            raise ExportError('a skill has exactly the keys name, description and body')
        name = _utf8(skill['name'], 'skill name')
        if not SKILL_NAME.match(name):
            raise ExportError(f'skill name {name!r} does not match {SKILL_NAME.pattern}')
        if name in seen:
            raise ExportError(f'skill name {name!r} appears twice')
        seen.add(name)
        skills.append({'name': name, 'description': _utf8(skill['description'], 'skill description'), 'body': _utf8(skill['body'], 'skill body')})
    if guidance == '' and not skills:
        raise ExportError('a bundle needs a guidanceSupplement or at least one skill')
    return {'guidanceSupplement': guidance, 'skills': sorted(skills, key=lambda s: s['name'])}


def check_image(image):
    if not isinstance(image, dict) or set(image) != {'id', 'digest'} or not isinstance(image['id'], str) or not IMAGE_ID.match(image['id']) \
            or not isinstance(image['digest'], str) or not HEX64.match(image['digest']):
        raise ExportError('an image identity is {id: identifier, digest: 64 lowercase hex}')
    return {'id': image['id'], 'digest': image['digest']}


def harness_patch_digest(bundle, image):
    """sha256 of the RFC 8785 canonical JSON of {guidanceSupplement, image, skills (sorted by name)}: the patch and the image it was measured on."""
    normal = normalize_bundle(bundle)
    body = {'guidanceSupplement': normal['guidanceSupplement'], 'image': check_image(image), 'skills': normal['skills']}
    canonical = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def harness_patch_sizes(bundle):
    """(chars, alwaysOnChars) in UTF-16 code units, as JavaScript counts them: all text, and the part every session carries."""
    normal = normalize_bundle(bundle)
    guidance = _utf16_len(normal['guidanceSupplement'])
    always = guidance + sum(_utf16_len(s['name']) + _utf16_len(s['description']) for s in normal['skills'])
    return guidance + sum(_utf16_len(s['name']) + _utf16_len(s['description']) + _utf16_len(s['body']) for s in normal['skills']), always


def candidate_arms(bundles_path, image):
    """{arm id: harness record} for every candidate of a bundles file ({"candidates": [{"title", "bundle"}]})."""
    data = json.loads(pathlib.Path(bundles_path).read_text(encoding='utf-8'))
    if not isinstance(data, dict) or not isinstance(data.get('candidates'), list):
        raise ExportError('--bundles must be {"candidates": [{"title", "bundle"}]}')
    arms = {}
    for index, candidate in enumerate(data['candidates']):
        if not isinstance(candidate, dict) or 'bundle' not in candidate:
            raise ExportError(f'candidate {index} has no bundle')
        bundle = normalize_bundle(candidate['bundle'])
        digest = harness_patch_digest(bundle, image)
        arm = f'cand-{digest[:12]}'
        if arm in arms:
            raise ExportError(f'candidates {arms[arm]["title"]!r} and {index} are the same patch')
        chars, always = harness_patch_sizes(bundle)
        title = candidate.get('title')
        arms[arm] = {'digest': digest, 'chars': chars, 'alwaysOnChars': always, 'title': title if isinstance(title, str) and title else arm, 'bundle': bundle}
    return arms


# --------------------------------------------------------------------------------------------------------------- rows

def natural_key(text):
    return [int(part) if part.isdigit() else part for part in re.split(r'(\d+)', str(text))]


def _gold_of(item):
    gold = item.get('gold')
    if isinstance(gold, str):
        try:
            gold = ast.literal_eval(gold)
        except (ValueError, SyntaxError):
            raise ExportError(f'item {item.get("key")}: gold is not a mapping')
    if not isinstance(gold, dict):
        raise ExportError(f'item {item.get("key")}: no gold mapping')
    return gold


def row_from_item(benchmark, item):
    """The lab row of a bench-driver item, or None for an item that belongs to another benchmark of the same file."""
    row_id = re.sub(r'#r\d+$', '', str(item['id']))
    meta = item.get('meta') or {}
    if benchmark == 'medcalc-bench':
        gold = _gold_of(item)
        return {'id': row_id, 'calculatorId': int(gold['calculator_id']),
                'gold': {'answer': str(gold['answer']), 'lower': gold.get('lower'), 'upper': gold.get('upper')}}
    if benchmark == 'bixbench':
        questions = [{'n': q['n'], 'qid': q['qid'], 'eval_mode': q['eval_mode'], 'ideal': q['ideal'], 'range': q.get('range')}
                     for q in _gold_of(item)['questions']]
        return {'id': row_id, 'topic': meta['topic'], 'gold': {'questions': questions}}
    if benchmark in ('autoresearchbench-deep', 'autoresearchbench-wide'):
        gold = _gold_of(item)
        if gold.get('type') != benchmark.rsplit('-', 1)[1]:
            return None
        return {'id': row_id, 'category': meta['category'],
                'gold': {'type': gold['type'], 'titles': gold['titles'], 'arxiv_ids': gold['arxiv_ids'], 'is_none': gold['is_none']}}
    if benchmark == 'medbrowsecomp':
        gold = _gold_of(item)
        return {'id': row_id, 'task': gold['task_name'], 'gold': {'task_name': gold['task_name'], 'answer': gold['answer']}}
    if benchmark == 'deepresearchbench':
        return {'id': row_id, 'category': meta['topic']}
    if benchmark == 'researchclawbench':
        return {'id': row_id, 'category': meta['domain']}
    raise ExportError(f'unknown benchmark {benchmark}')


def load_rows(benchmark, items, rows_file):
    spec = BENCHMARKS[benchmark]
    rows = {}
    if rows_file:
        data = json.loads(pathlib.Path(rows_file).read_text(encoding='utf-8'))
        listed = data.get('rows') if isinstance(data, dict) else None
        if not isinstance(listed, list):
            raise ExportError('--rows must be {"rows": [...]}')
        for row in listed:
            if not isinstance(row, dict) or 'id' not in row or spec['stratum'] not in row:
                raise ExportError(f'a row needs id and {spec["stratum"]}: {json.dumps(row)[:120]}')
            row = dict(row, id=str(row['id']))
            if spec['gold'] and 'gold' not in row:
                raise ExportError(f'row {row["id"]} has no gold')
            if not spec['gold']:
                row.pop('gold', None)
            if row['id'] in rows and rows[row['id']] != row:
                raise ExportError(f'row {row["id"]} is given twice with different content')
            rows[row['id']] = row
    for path in items or []:
        for number, line in enumerate(pathlib.Path(path).read_text(encoding='utf-8').splitlines(), 1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                row = row_from_item(benchmark, item)
            except (KeyError, TypeError, ValueError) as error:
                raise ExportError(f'{path}:{number}: {error!r}')
            if row is None:
                continue
            if row['id'] in rows and rows[row['id']] != row:
                raise ExportError(f'{path}:{number}: row {row["id"]} differs from an earlier item of the same id')
            rows[row['id']] = row
    if not rows:
        raise ExportError('no rows: give --items or --rows')
    return [rows[k] for k in sorted(rows, key=natural_key)]


def check_row_ids(rows, path, role):
    data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    listed = data.get('rows') if isinstance(data, dict) else None
    if isinstance(listed, dict):
        listed = listed.get(role)
    if not isinstance(listed, list):
        raise ExportError('--row-ids must be {"rows": [ids]} or a registration with rows.{development,confirmation}')
    want, got = {str(x) for x in listed}, {r['id'] for r in rows}
    if want != got:
        raise ExportError(f'the rows differ from --row-ids: missing {sorted(want - got, key=natural_key)[:10]}, extra {sorted(got - want, key=natural_key)[:10]}')


# ---------------------------------------------------------------------------------------------------------------- runs

def run_key(template, bench, arm, row, repeat, repeats):
    token = 'base' if arm == BASELINE else arm
    try:
        return template.format(bench=bench, armtoken=token, row=row, rep=f'#r{repeat}' if repeats > 1 else '')
    except (KeyError, IndexError, ValueError) as error:
        raise ExportError(f'--key-template {template!r} cannot be filled: {error!r}')


def result_folder(directory, key):
    # bench-driver's folder rule: '/' -> '__', any other character outside [A-Za-z0-9_.-] -> '_'
    return pathlib.Path(directory) / re.sub(r'[^A-Za-z0-9_.-]', '_', key.replace('/', '__'))


def classify(result, extra_codes):
    """None for a delivery outcome (kept), otherwise the reason the run is infrastructure."""
    if result is None:
        return 'missing'
    status, code = result.get('status'), result.get('errorCode')
    if result.get('infrastructureFailure') is True:
        return 'infrastructureFailure'
    if status in INFRA_STATUSES:
        return f'status {status}'
    if code in INFRASTRUCTURE_CODES or code in extra_codes:
        return f'errorCode {code}'
    if status not in DELIVERY_STATUSES:
        return f'status {status}'
    # A delivered run whose answer was not captured is a capture failure, not an empty answer: the answer is what is scored.
    transcript = (result.get('capture') or {}).get('transcript')
    if status == 'succeeded' and transcript not in (None, 'ok'):
        return f'transcript capture {transcript}'
    return None


def read_result(folder):
    path = folder / 'result.json'
    if not path.exists():
        return None, None
    try:
        return json.loads(path.read_text(encoding='utf-8')), None
    except ValueError:
        return None, 'unreadable'


def report_text(folder):
    """The report a judge reads, as drb_pairwise.read_report finds it; answer.md when it finds nothing."""
    sys.path.insert(0, str(TOOLS))  # python -I does not put the script's directory on sys.path
    import drb_pairwise
    try:
        text, _ = drb_pairwise.read_report(folder)
    except drb_pairwise.PairwiseError:
        text = ''
    if not text:
        answer = folder / 'answer.md'
        text = answer.read_text(encoding='utf-8') if answer.exists() else ''
    return text


def collect_runs(args, rows, arms, judged_benchmark):
    runs, incomplete = [], []
    for arm, directory in arms:
        for row in rows:
            for repeat in range(args.repeats):
                key = run_key(args.key_template, args.bench_key, arm, row['id'], repeat, args.repeats)
                result, why = read_result(result_folder(directory, key))
                reason = why or classify(result, args.infrastructure_code)
                if reason:
                    incomplete.append({'arm': arm, 'row': row['id'], 'repeat': repeat, 'key': key, 'reason': reason,
                                       'status': (result or {}).get('status'), 'errorCode': (result or {}).get('errorCode')})
                    continue
                folder = result_folder(directory, key)
                answer_path = folder / 'answer.md'
                answer = answer_path.read_text(encoding='utf-8') if answer_path.exists() else None
                cost = result.get('cost') or {}
                settled = cost.get('cost') if cost.get('openCost', 1) == 0 and cost.get('uncertain', 1) == 0 else None
                run = {'row': row['id'], 'arm': arm, 'repeat': repeat, 'runId': result.get('runId') or f'none:{key}',
                       'status': result.get('status'), 'answer': None if judged_benchmark else answer, 'cost': settled}
                if judged_benchmark:
                    text = report_text(folder)
                    run['answerChars'] = len(text)
                    run['reportSha256'] = hashlib.sha256(text.encode('utf-8')).hexdigest()
                runs.append(run)
    return runs, incomplete


# ------------------------------------------------------------------------------------------------------- judge verdicts

def _digest_file(path):
    data = pathlib.Path(path).read_bytes()
    return hashlib.sha256(data).hexdigest(), sum(1 for line in data.decode('utf-8').splitlines() if line.strip())


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def check_judge(args):
    if re.search('deepseek', f'{args.judge_id} {args.judge_provider}', re.I):
        raise ExportError('the judge may not be on the solver\'s family (a judge id or provider naming deepseek is refused)')
    if not args.judge_id or not args.judge_provider:
        raise ExportError('--judge-id and --judge-provider are required with verdicts')
    if args.judge_form not in ('absolute', 'pairwise'):
        raise ExportError('--judge-form is absolute or pairwise')
    if (args.dialect == 'pairwise') != (args.judge_form == 'pairwise'):
        raise ExportError('the pairwise dialect and the pairwise judge form go together')
    passes = args.judge_passes
    if not isinstance(passes, int) or passes < 2 or (args.judge_form == 'pairwise' and passes % 2):
        raise ExportError('--judge-passes is an integer of at least 2 (even for pairwise: every pair is judged in both orders)')


def _expected_keys(args, rows, arms):
    table = {}
    for arm, _ in arms:
        for row in rows:
            for repeat in range(args.repeats):
                table[run_key(args.key_template, args.bench_key, arm, row['id'], repeat, args.repeats)] = (arm, row['id'], repeat)
    return table


def absolute_records(args, rows, arms):
    table, found, calls = _expected_keys(args, rows, arms), {}, 0
    problems = []
    for path in args.verdicts:
        suffix = re.search(r'\.p(\d+)\.jsonl$', pathlib.Path(path).name)
        file_pass = int(suffix.group(1)) if suffix else 1
        for number, line in enumerate(pathlib.Path(path).read_text(encoding='utf-8').splitlines(), 1):
            if not line.strip():
                continue
            where = f'{pathlib.Path(path).name}:{number}'
            try:
                obj = json.loads(line)
            except ValueError:
                problems.append(f'{where}: not JSON')
                continue
            calls += 1
            if not isinstance(obj, dict) or obj.get('key') not in table:
                problems.append(f'{where}: unknown verdict key {obj.get("key") if isinstance(obj, dict) else obj!r}')
                continue
            if 'pass' in obj and obj['pass'] != file_pass:
                problems.append(f'{where}: pass {obj["pass"]!r} disagrees with the file name (pass {file_pass})')
                continue
            if 'judge' in obj and obj['judge'] != args.judge_id:
                problems.append(f'{where}: judge {obj["judge"]!r} is not {args.judge_id!r}')
                continue
            raw = obj.get({'unit': 'score', 'percent': 'score', 'race': 'race'}[args.dialect])
            score = raw / 100 if args.dialect == 'percent' and _is_number(raw) else raw
            if not _is_number(score) or not 0 <= score <= 1:
                problems.append(f'{where}: no score in [0, 1] for the {args.dialect} dialect')
                continue
            arm, row, repeat = table[obj['key']]
            slot = (arm, row, repeat, file_pass)
            if slot in found and found[slot] != score:
                problems.append(f'{where}: a different verdict for the same run and pass')
                continue
            found[slot] = score
    if problems:
        raise ExportError('verdicts rejected:\n  ' + '\n  '.join(problems[:20]) + (f'\n  ... and {len(problems) - 20} more' if len(problems) > 20 else ''))
    return found, calls


def pairwise_records(args, rows):
    sys.path.insert(0, str(TOOLS))
    import drb_pairwise
    pair_map = json.loads(pathlib.Path(args.pair_map).read_text(encoding='utf-8'))
    if not isinstance(pair_map, dict):
        raise ExportError('--pair-map is {task label: {row, repeat, arm}}')
    found, seen_tasks, problems = {}, set(), []
    for order_file in args.pairwise_order:
        order = drb_pairwise.load_order(order_file)
        names = order['arms']
        if BASELINE not in (names['a'], names['b']) or names['a'] == names['b']:
            raise ExportError(f'{order_file}: one of the two arms must be named {BASELINE!r}')
        candidate_side = 'b' if names['a'] == BASELINE else 'a'
        try:
            result = drb_pairwise.aggregate(order_file, args.verdicts)
        except drb_pairwise.PairwiseError as error:
            raise ExportError(f'pairwise aggregate: {error}')
        problems += [f'{e["task"]}: {e["reason"]}' for e in result['excluded']]
        for task in result['tasks']:
            label = task['task']
            mapped = pair_map.get(label)
            if not isinstance(mapped, dict) or {'row', 'repeat', 'arm'} - set(mapped):
                problems.append(f'{label}: not in --pair-map (needs row, repeat, arm)')
                continue
            if mapped['arm'] != names[candidate_side]:
                problems.append(f'{label}: --pair-map says arm {mapped["arm"]!r} but {order_file} compares {names[candidate_side]!r} with {BASELINE!r}')
                continue
            seen_tasks.add(label)
            passes = sorted(int(k) for k in task['perPass'])
            if len(passes) != args.judge_passes:
                problems.append(f'{label}: {len(passes)} passes, {args.judge_passes} registered')
                continue
            for k in passes:
                total = task['perPass'][str(k)]['total']
                signed = total if candidate_side == 'a' else -total
                slot = (mapped['arm'], str(mapped['row']), int(mapped['repeat']), k)
                if slot in found:
                    problems.append(f'{label}: the run {slot[:3]} is judged by two tasks')
                    continue
                found[slot] = (3 + signed) / 6
    problems += [f'{label}: in --pair-map but in no --pairwise-order' for label in pair_map if label not in seen_tasks and not any(
        label in drb_pairwise.load_order(o)['tasks'] for o in args.pairwise_order)]
    if problems:
        raise ExportError('pairwise verdicts rejected:\n  ' + '\n  '.join(problems[:20]))
    return found, len(found)


def judged_section(args, rows, arms, runs):
    """The verdict records (and the text of their file) once the run set is final; ExportError on any gap or surplus."""
    check_judge(args)
    status = {(r['arm'], r['row'], r['repeat']): r['status'] for r in runs}
    pairwise = args.judge_form == 'pairwise'
    found, calls = pairwise_records(args, rows) if pairwise else absolute_records(args, rows, arms)
    problems = []
    for (arm, row, repeat, k), _ in found.items():
        if status.get((arm, row, repeat)) is None:
            problems.append(f'verdict for {arm}/{row}#{repeat} but that run is not in the export')
        elif status[(arm, row, repeat)] != 'succeeded':
            problems.append(f'verdict for {arm}/{row}#{repeat} but that run did not succeed ({status[(arm, row, repeat)]})')
        elif pairwise and arm == BASELINE:
            problems.append(f'a pairwise verdict names the baseline run {row}#{repeat}')
        if k < 1 or k > args.judge_passes:
            problems.append(f'pass {k} of {arm}/{row}#{repeat} is outside 1..{args.judge_passes}')
    for (arm, row, repeat), st in status.items():
        if st != 'succeeded' or (pairwise and arm == BASELINE):
            continue
        missing = [k for k in range(1, args.judge_passes + 1) if (arm, row, repeat, k) not in found]
        if missing:
            problems.append(f'{arm}/{row}#{repeat} lacks pass {missing}')
    if problems:
        raise ExportError('verdicts do not match the runs:\n  ' + '\n  '.join(problems[:20]) + (f'\n  ... and {len(problems) - 20} more' if len(problems) > 20 else ''))
    records = [{'row': row, 'arm': arm, 'repeat': repeat, 'pass': k, 'score': score, 'judge': args.judge_id}
               for (arm, row, repeat, k), score in sorted(found.items(), key=lambda kv: (natural_key(kv[0][1]), kv[0][0], kv[0][2], kv[0][3]))]
    text = ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records)
    return {'records': records, 'text': text, 'calls': len(records) if pairwise else calls}


# ------------------------------------------------------------------------------------------------------------- writing

def write_checked(path, data):
    path = pathlib.Path(path)
    payload = data.encode('utf-8') if isinstance(data, str) else data
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    pathlib.Path(f'{path}.sha256').write_text(f'{digest}  {path.name}\n', encoding='utf-8')
    return digest


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=1) + '\n'


def parse_arms(specs, candidates, role):
    arms, seen = [], set()
    for spec in specs:
        if '=' not in spec:
            raise ExportError(f'--arm {spec!r} is ARM=RESULTS_DIR')
        arm, directory = spec.split('=', 1)
        if arm in seen:
            raise ExportError(f'arm {arm} is given twice')
        seen.add(arm)
        if arm not in (BASELINE, CONTROL) and arm not in candidates:
            raise ExportError(f'unknown candidate arm {arm}: no bundle in --bundles has that digest on this image')
        arms.append((arm, directory))
    if BASELINE not in seen:
        raise ExportError('an export needs the baseline arm')
    if role == 'confirmation':
        if CONTROL in seen:
            raise ExportError('the A/A control arm belongs to the development gate; a confirmation carries the baseline and one candidate')
        if len(seen) != 2:
            raise ExportError('a confirmation carries the baseline and exactly one candidate')
    arms.sort(key=lambda a: (0 if a[0] == BASELINE else 1 if a[0] == CONTROL else 2, a[0]))
    return arms


def export(args):
    """Returns (exit code, summary). Raises ExportError."""
    spec = BENCHMARKS.get(args.benchmark)
    if spec is None:
        raise ExportError(f'unknown benchmark {args.benchmark}')
    image = check_image({'id': args.image_id, 'digest': args.image_digest})
    if not isinstance(args.repeats, int) or not 1 <= args.repeats <= 10:
        raise ExportError('--repeats is an integer in 1..10')
    judged_args = bool(args.verdicts or args.pairwise_order or args.pair_map)
    if judged_args and not spec['judged']:
        raise ExportError(f'{args.benchmark} is scored by code in the lab; verdict files belong to judged benchmarks only')
    candidates = candidate_arms(args.bundles, image) if args.bundles else {}
    arms = parse_arms(args.arm, candidates, args.role)
    rows = load_rows(args.benchmark, args.items, args.rows)
    if args.row_ids:
        check_row_ids(rows, args.row_ids, args.role)
    runs, incomplete = collect_runs(args, rows, arms, spec['judged'])
    if incomplete and not args.allow_incomplete:
        return 3, {'written': False, 'incomplete': incomplete}
    out = pathlib.Path(args.out)
    stem = str(out)[:-5] if out.name.endswith('.json') else str(out)
    judged, records_name, written = None, None, []
    if args.verdicts:
        judged = judged_section(args, rows, arms, runs)
        records_name = pathlib.Path(f'{stem}.verdicts.jsonl').name
    # The seal: a confirmation source never carries gold; the lab adds it in its own step.
    gold_map = {}
    out_rows = []
    for row in rows:
        row = dict(row)
        if spec['gold'] and args.role == 'confirmation':
            gold_map[row['id']] = row.pop('gold')
        out_rows.append(row)
    source = {'kind': 'harness-arms', 'schema': 1, 'role': args.role, 'benchmark': args.benchmark, 'image': image, 'repeats': args.repeats,
              'rows': out_rows,
              'arms': {name: ({'harness': None} if name == BASELINE else {'harness': None, 'control': 'A/A'} if name == CONTROL else {'harness': candidates[name]})
                       for name, _ in arms},
              'runs': sorted(runs, key=lambda r: (natural_key(r['row']), [n for n, _ in arms].index(r['arm']), r['repeat']))}
    if judged is not None:
        write_checked(f'{stem}.verdicts.jsonl', judged['text'])
        written.append(f'{stem}.verdicts.jsonl')
        files = []
        for path in args.verdicts:
            digest, lines = _digest_file(path)
            files.append({'name': pathlib.Path(path).name, 'sha256': digest, 'lines': lines})
        records_digest = hashlib.sha256(judged['text'].encode('utf-8')).hexdigest()
        source['judged'] = {'schema': 1, 'judge': {'id': args.judge_id, 'provider': args.judge_provider, 'form': args.judge_form, 'passes': args.judge_passes},
                            'calls': judged['calls'], 'cost': {'settledCny': 0, 'note': args.judge_cost_note}, 'files': files,
                            'recordsFile': {'name': records_name, 'sha256': records_digest, 'lines': len(judged['records'])}}
    if gold_map:
        write_checked(f'{stem}.gold.json', dump({'kind': 'harness-gold', 'schema': 1, 'benchmark': args.benchmark, 'gold': gold_map}))
        written.append(f'{stem}.gold.json')
    write_checked(out, dump(source))
    written.append(str(out))
    if incomplete:
        write_checked(f'{out}.incomplete.json', dump(incomplete))
        written.append(f'{out}.incomplete.json')
    summary = {'written': True, 'role': args.role, 'rows': len(rows), 'arms': [a for a, _ in arms], 'runs': len(runs),
               'expectedRuns': len(rows) * len(arms) * args.repeats, 'incomplete': len(incomplete),
               'unsettled': sum(1 for r in runs if r['cost'] is None), 'files': written}
    if judged is not None:
        summary['records'] = len(judged['records'])
    return (3 if incomplete else 0), summary


def build_parser():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--role', required=True, choices=['development', 'confirmation'])
    p.add_argument('--benchmark', required=True, choices=sorted(BENCHMARKS))
    p.add_argument('--items', action='append', default=[])
    p.add_argument('--rows')
    p.add_argument('--row-ids')
    p.add_argument('--arm', action='append', required=True, help='ARM=RESULTS_DIR (baseline, aa or cand-xxxxxxxxxxxx)')
    p.add_argument('--bundles')
    p.add_argument('--image-id', required=True)
    p.add_argument('--image-digest', required=True)
    p.add_argument('--bench-key', required=True)
    p.add_argument('--key-template', default=DEFAULT_KEY_TEMPLATE)
    p.add_argument('--repeats', type=int, required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--allow-incomplete', action='store_true')
    p.add_argument('--infrastructure-code', action='append', default=[])
    p.add_argument('--verdicts', nargs='+')
    p.add_argument('--dialect', choices=['unit', 'percent', 'race', 'pairwise'])
    p.add_argument('--judge-id')
    p.add_argument('--judge-provider')
    p.add_argument('--judge-form')
    p.add_argument('--judge-passes', type=int)
    p.add_argument('--pairwise-order', action='append', default=[])
    p.add_argument('--pair-map')
    p.add_argument('--judge-cost-note', default=DEFAULT_JUDGE_NOTE)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.verdicts:
            if not args.dialect:
                raise ExportError('--dialect is required with --verdicts')
            if args.dialect == 'pairwise' and (not args.pairwise_order or not args.pair_map):
                raise ExportError('the pairwise dialect needs --pairwise-order and --pair-map')
        code, summary = export(args)
    except (ExportError, OSError) as error:
        print(f'export_harness_arms: {error}', file=sys.stderr)
        return 2
    if code == 3 and not summary.get('written'):
        print(f'export_harness_arms: {len(summary["incomplete"])} runs are missing or infrastructure failures; nothing written', file=sys.stderr)
        for entry in summary['incomplete'][:50]:
            print(f'  {entry["arm"]} {entry["key"]}: {entry["reason"]}', file=sys.stderr)
        return 3
    print(json.dumps(summary, ensure_ascii=False))
    if code == 3:
        print(f'export_harness_arms: {summary["incomplete"]} runs are incomplete and are NOT in the source; the lab will refuse it', file=sys.stderr)
    return code


if __name__ == '__main__':
    sys.exit(main())
