#!/usr/bin/env python3
"""Pre-register one family of an RSI round (harness-patch campaign): rows, repeats, scorer, failure slice, margin, error budget.

  register_round.py --round rsi1-2026-11 --family drb --benchmark deepresearchbench --scorer judged-verdicts \\
      --pools pools/drb.json --ppc rsi/ppc-tasks.json --development-rows 12 --confirmation-rows 30 \\
      --failure-slice "Science & Technology" --judge-id <id> --judge-provider anthropic --judge-model claude-sonnet-5-5 --judge-effort medium \\
      --judge-form pairwise --judge-passes 2 --judge-max-calls N --judge-noise judge-noise.json --judge-noise-key drb --out rsi/drb.registration.json
  register_round.py --check rsi/drb.registration.json [--pools pools/drb.json [--ppc rsi/ppc-tasks.json]]

The file is written before any confirmation run exists and decides nothing about outcomes: it names the rows, how they were
ordered, and the parameters the lab will hold the campaign to. What it fixes:
  rows        the pool's registered development / confirmation ids (evals/public-benchmarks/tools/register_pools.py), minus the
              ids of --ppc (the tasks the task-level recursion has already read; removed from BOTH roles) and minus any id on the
              other role's list, ordered by ascending sha256("<salt>|<id>") (ties: natural id order), the first N and M kept.
              --development-salt orders the DEVELOPMENT role by another salt: development rows that were chosen and run before
              the registration (a round's screen) keep the order they were chosen by, and the registration says which salt that
              was (`hashOrder.developmentSalt`); the confirmation role is always ordered by --salt
  repeats     per role (the lab holds the confirmation to the repeats registered here)
  scorer      an id of the lab's closed scorer table, consistent with the benchmark
  failure slice, margin, cost ratio (the registered procedure's targeted-repair bound is 1.1 and the registration cannot ask
              for another), alpha allocation (0.05 per quarter divided by the campaigns planned in it), K (the most candidates
              the development gate may carry), and the A/A control arm of the development gate
  judge       judged-verdicts only: the fixed judge identity (an id, provider anthropic, a pinned claude-* --judge-model and the CLI
              --judge-effort it runs at: every offline judge is Claude, owner 2026-11-03, and the same model at another effort is another
              judge), its passes and call budget, and its qualification, the measurement noise_sample.py `band` wrote (--judge-noise, a
              `judge-noise/2` file) for this family (--judge-noise-key) and the registered form, copied as it is: agreement and the noise
              band of one judging, both computed by the tool on the 0-1 scale of the verdict the lab scores (`scale: verdict-0-1`). A
              measurement of another form (the RACE band of absolute judging for a pairwise judge), on another scale (rubric points) or
              without an agreement (a judge that never states a preference) is refused; nothing of it can be typed in. The thresholds are
              the procedure's, fixed in code and never registered: agreement at least 0.9, and the noise band of the verdict the procedure
              uses (the mean of the passes: noiseBand95 / sqrt(passes)) within --margin. The call budget is
              computed from the registration itself (rows x repeats x arms x passes, development and confirmation; pairwise judging
              records the arms that are not the baseline) and a maximum below it is refused (`judge.callsRequired` says the figure)
--exclude-opened FILE (repeatable) takes the rows earlier campaigns opened, so this registration's confirmation rows are fresh. A file is an
earlier registration (its confirmation rows are the opened ones, removed from both roles; its development rows were seen, removed from the
confirmation role), or a list / {"opened": [...]} of opened ids. The excluded ids and each file's sha256 are recorded and re-checked.
--exclude-ids FILE (repeatable) takes {"reason": "<why>", "ids": [...]}: ids that cannot be run or built (a task the hosted runtime cannot run, a capsule whose
files are over the upload limit or that the request builder cannot name) leave BOTH roles, and the registration records each file's name, sha256, reason and the
ids the pool held. It is the honest way to say "these rows are not part of the corpus" without calling them opened; `--check` re-derives the selection with the same files.
--surface tool-patch registers the family for the tool-patch surface (a candidate that holds code; its own error-budget ledger and
consumer identity); the default is harness-patch and writes no `surface` field.
`groupsBelowMinimum` states an observation (fewer confirmation rows than the procedure's minimum groups: the report will call
the result directional and the campaign draws no error budget); it is not a decision. The digest is the sha256 of the canonical JSON (sorted keys, compact, UTF-8) of
the file without `digest` and `registeredAt`, so the same inputs always give the same digest. An existing --out is never
overwritten without --force. `--check` recomputes the digest, the hash order and the disjointness of the two lists, holds a judge to the rule above, and with
--pools (and --ppc) re-derives the whole row selection from the parameters in the file; exit 1 on any difference.

Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import hashlib
import json
import math
import pathlib
import re
import sys
from datetime import datetime, timezone

SCHEMA = 'rsi-round-registration/1'
TOOL = 'register_round.py/1'
QUARTER_ALPHA = 0.05
COST_RATIO = 1.1
SURFACES = ('harness-patch', 'tool-patch')
HASH_RULE = 'ascending sha256(salt|id)'
CONTROL_RULE = ('a candidate is eligible only if its failure-slice gain exceeds the absolute failure-slice difference '
                'the A/A arm shows against the baseline')
SCORER_BENCHMARKS = {
    'medcalc': {'medcalc-bench'},
    'bixbench-deterministic': {'bixbench'},
    'arb-deep': {'autoresearchbench-deep'},
    'arb-wide': {'autoresearchbench-wide'},
    'mbc-normalized': {'medbrowsecomp'},
    'judged-verdicts': {'deepresearchbench', 'researchclawbench', 'bixbench'},
}
JUDGE_ARGS = ('judge_id', 'judge_provider', 'judge_model', 'judge_effort', 'judge_form', 'judge_passes', 'judge_max_calls', 'judge_noise', 'judge_noise_key')
# Every offline judge is Claude (the owner's role policy, 2026-11-03); the domain's rule (packages/domain/src/rsiCampaign.mjs) in Python, and the
# Claude CLI's effort levels (claude_judge.py EFFORTS).
JUDGE_PROVIDER = 'anthropic'
JUDGE_MODEL = re.compile(r'claude-[a-z0-9-]+')
JUDGE_EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')
# The procedure's judge thresholds, the same as harness_campaign.mjs: the registrant records the measurement, never the threshold.
JUDGE_MINIMUM_AGREEMENT = 0.9
# The measurement noise_sample.py `band` writes, and the one scale a qualification is read on: the verdict's own, 0 to 1.
NOISE_SCHEMA = 'judge-noise/2'
NOISE_SCALE = 'verdict-0-1'
QUALIFICATION_KEYS = ('measuredOn', 'form', 'scale', 'agreement', 'noiseSd', 'noiseBand95')


class RegistrationError(Exception):
    """A registration that cannot be made or a file that does not verify; the message says why."""


def sha256_hex(data):
    return hashlib.sha256(data.encode('utf-8') if isinstance(data, str) else data).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def content_digest(doc):
    return sha256_hex(canonical({k: v for k, v in doc.items() if k not in ('digest', 'registeredAt')}))


def natural_key(text):
    return [int(part) if part.isdigit() else part for part in re.split(r'(\d+)', str(text))]


def hash_order(salt, ids):
    return sorted(ids, key=lambda i: (sha256_hex(f'{salt}|{i}'), natural_key(i)))


# ------------------------------------------------------------------------------------------------------------- inputs

def read_json(path, what):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise RegistrationError(f'{what} {path} cannot be read: {error}')


def read_pool(path, name):
    pool_file = read_json(path, 'the pools file')
    pool = (pool_file.get('pools') or {}).get(name) if isinstance(pool_file, dict) else None
    if not isinstance(pool, dict) or not isinstance(pool.get('development'), list) or not isinstance(pool.get('confirmation'), list):
        raise RegistrationError(f'{path} has no pool {name!r} with development and confirmation lists')
    digest = pool_file.get('digest') or sha256_hex(pathlib.Path(path).read_bytes())
    return pool_file, {'development': [str(i) for i in pool['development']], 'confirmation': [str(i) for i in pool['confirmation']]}, digest


def ppc_ids(data, prefixes):
    """The ids of a ppc-tasks file: a list, {"tasks": [...]} or {"<family|bench|domain>": [...]}; an entry is an id, "<bench>/<id>",
    "<bench>:<id>" (the prefix is stripped when it names this family or pool) or {"id": ...}. The file evals/harness-adaptation writes
    (`rsi1-ppc-tasks/1`: {"domains": {"<family>": {"ids": [...], ...}}}) contributes the ids of this family's entry only: an id of another
    family (a MedBrowseComp index, a DeepResearch Bench id) must never remove a row here, and a file with no entry for this family is an
    error, never an empty exclusion."""
    def one(entry):
        if isinstance(entry, dict):
            entry = entry.get('id')
        if isinstance(entry, bool) or not isinstance(entry, (str, int)):
            raise RegistrationError(f'a ppc entry is an id, "<bench>/<id>", "<bench>:<id>" or {{"id": ...}}, not {entry!r}')
        text = str(entry)
        for separator in ('/', ':'):
            head, found, tail = text.partition(separator)
            if found and head in prefixes:
                return tail
        return text
    if isinstance(data, list):
        return [one(e) for e in data]
    if isinstance(data, dict):
        if isinstance(data.get('domains'), dict):
            mine = [value for key, value in data['domains'].items() if key in prefixes]
            if not mine:
                raise RegistrationError(f'the ppc file has no entry for {" or ".join(sorted(map(str, prefixes)))} under "domains"')
            out = []
            for entry in mine:
                if not isinstance(entry, dict) or not isinstance(entry.get('ids'), list):
                    raise RegistrationError('a ppc "domains" entry must be {"ids": [...]}')
                out += [one(e) for e in entry['ids']]
            return out
        if 'tasks' in data:
            if not isinstance(data['tasks'], list):
                raise RegistrationError('ppc "tasks" must be a list')
            return [one(e) for e in data['tasks']]
        out = []
        for key, value in data.items():
            if not isinstance(value, list):
                raise RegistrationError(f'ppc key {key!r} must hold a list of ids')
            out += [one(e) for e in value]
        return out
    raise RegistrationError('the ppc file must be a list, {"tasks": [...]} or {"<family or bench or domain>": [...]}')


def opened_ids(paths):
    """(opened ids, seen-in-development ids, [{name, sha256}]) of the files --exclude-opened names: earlier registrations (rows.confirmation are
    the opened rows, rows.development the seen ones) or a list / {"opened": [...]} of opened ids."""
    opened, seen, files = set(), set(), []
    for path in paths or []:
        raw = pathlib.Path(path).read_bytes()
        data = read_json(path, '--exclude-opened file')
        if isinstance(data, dict) and isinstance(data.get('rows'), dict):
            confirmation, development = data['rows'].get('confirmation'), data['rows'].get('development')
            if not isinstance(confirmation, list) or not isinstance(development, list):
                raise RegistrationError(f'{path}: a registration\'s rows hold the lists development and confirmation')
            opened |= {str(i) for i in confirmation}
            seen |= {str(i) for i in development}
        elif isinstance(data, dict) and isinstance(data.get('opened'), list):
            opened |= {str(i) for i in data['opened']}
        elif isinstance(data, list):
            opened |= {str(i) for i in data}
        else:
            raise RegistrationError(f'{path}: --exclude-opened takes a registration, a list of ids or {{"opened": [...]}}')
        files.append({'name': pathlib.Path(path).name, 'sha256': sha256_hex(raw)})
    return opened, seen - opened, files


def listed_ids(paths):
    """(listed ids, [{name, sha256, reason, ids}]) of the files --exclude-ids names: {"reason": "<why>", "ids": [...]} each."""
    listed, files = set(), []
    for path in paths or []:
        raw = pathlib.Path(path).read_bytes()
        data = read_json(path, '--exclude-ids file')
        if not isinstance(data, dict) or not isinstance(data.get('ids'), list) or not isinstance(data.get('reason'), str) or not data['reason'].strip():
            raise RegistrationError(f'{path}: --exclude-ids takes {{"reason": "<why these rows leave the corpus>", "ids": [...]}}')
        ids = [str(i) for i in data['ids']]
        listed |= set(ids)
        files.append({'name': pathlib.Path(path).name, 'sha256': sha256_hex(raw), 'reason': data['reason'].strip(), 'ids': ids})
    return listed, files


def listed_removed(pool, files):
    """What each --exclude-ids file actually removed from the pool, in natural order, as the registration records it."""
    held = set(pool['development']) | set(pool['confirmation'])
    return [{'name': f['name'], 'sha256': f['sha256'], 'reason': f['reason'], 'removed': sorted(set(f['ids']) & held, key=natural_key)} for f in files]


def select_rows(pool, salt, ppc, development_rows, confirmation_rows, development_salt=None, opened=(), seen=()):
    """(rows by role, available by role, ppc ids actually removed). The development role is ordered by `development_salt` when given.
    Opened rows leave both roles (`opened_removed` lists the ones the pool held); rows seen in an earlier development leave the confirmation role."""
    removed = sorted((set(ppc) & (set(pool['development']) | set(pool['confirmation']))), key=natural_key)
    skip = set(ppc) | set(opened)
    rows, available = {}, {}
    for role, other in (('development', 'confirmation'), ('confirmation', 'development')):
        keep = [i for i in dict.fromkeys(pool[role]) if i not in skip and i not in set(pool[other]) and not (role == 'confirmation' and i in set(seen))]
        ordered = hash_order(development_salt if role == 'development' and development_salt else salt, keep)
        available[role] = len(ordered)
        want = development_rows if role == 'development' else confirmation_rows
        if want is None:
            want = len(ordered)
        if want < 1 or want > len(ordered):
            raise RegistrationError(f'{role}: {want} rows asked, {len(ordered)} available after the exclusions')
        rows[role] = ordered[:want]
    return rows, available, removed


def opened_removed(pool, opened):
    """The opened ids the pool held, in natural order: what --exclude-opened actually removed."""
    return sorted((set(opened) & (set(pool['development']) | set(pool['confirmation']))), key=natural_key)


# --------------------------------------------------------------------------------------------------------------- judge

def judge_calls_required(form, passes, development_rows, confirmation_rows, repeats_development, repeats_confirmation, candidates_max):
    """The verdict records a judged registration will produce. Development carries the baseline, the A/A control and up to K candidates;
    confirmation the baseline and one candidate. Absolute judging scores every arm; pairwise judging records the arms that are not the
    baseline (the baseline is the 0.5 reference). `harness_assemble.mjs` computes the same figure (`judgeCallsRequired`)."""
    pairwise = form == 'pairwise'
    development_arms = (0 if pairwise else 1) + 1 + candidates_max
    confirmation_arms = 1 if pairwise else 2
    return (development_rows * repeats_development * development_arms + confirmation_rows * repeats_confirmation * confirmation_arms) * passes


def judge_qualification_problems(judge, margin):
    """What keeps a registered judge from the procedure's rule (empty when it meets it): a Claude identity at a CLI effort, a measurement of its
    form on the verdict's 0-1 scale, and the measured agreement and the noise band of the averaged verdict against the code's thresholds.
    `harnessJudgeRegistrationIssue` (harness_campaign.mjs) is the same rule."""
    problems = []
    if judge.get('provider') != JUDGE_PROVIDER or not isinstance(judge.get('model'), str) or not JUDGE_MODEL.fullmatch(judge['model']):
        problems.append(f'the judge must be {JUDGE_PROVIDER} with a pinned claude-* model id (it is {judge.get("provider")!r} {judge.get("model")!r})')
    if judge.get('effort') not in JUDGE_EFFORTS:
        problems.append(f'the judge\'s effort {judge.get("effort")!r} is not one of {", ".join(JUDGE_EFFORTS)}')
    q = judge.get('qualification') if isinstance(judge.get('qualification'), dict) else {}
    extra = sorted(set(q) - set(QUALIFICATION_KEYS))
    if extra:
        problems.append(f'the qualification records the measurement only; {", ".join(extra)} is a threshold the procedure fixes')
    if q.get('scale') != NOISE_SCALE or q.get('form') != judge.get('form') or not all(_finite(q.get(k)) and 0 <= q[k] <= 1 for k in ('noiseSd', 'noiseBand95')):
        problems.append(f'the noise record is not on the {NOISE_SCALE} scale of the {judge.get("form")} form (scale {q.get("scale")!r}, form {q.get("form")!r}): '
                        f'measure it with noise_sample.py band and register it with --judge-noise')
    if not isinstance(q.get('measuredOn'), str) or not q['measuredOn'].strip():
        problems.append('the qualification does not say what it was measured on')
    agreement, band, passes = q.get('agreement'), q.get('noiseBand95'), judge.get('passes')
    if not _finite(agreement) or agreement < JUDGE_MINIMUM_AGREEMENT:
        problems.append(f'the judge\'s agreement {agreement} is below the procedure\'s {JUDGE_MINIMUM_AGREEMENT}')
    verdict_band = band / passes ** 0.5 if _finite(band) and isinstance(passes, int) and passes >= 1 else None
    if verdict_band is None or not _finite(margin) or verdict_band > margin:
        shown = 'unknown' if verdict_band is None else f'{verdict_band:.4f}'
        problems.append(f'the noise band of the averaged verdict (noiseBand95 {band} / sqrt({passes} passes) = {shown}) exceeds the margin {margin}')
    return problems


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def noise_record(path, key, form):
    """The qualification of a judge of `form` for family `key`: the measurement noise_sample.py `band` wrote, copied as it is, and where it came from.
    A file that is not `judge-noise/2` on the verdict-0-1 scale, or that has no record of this family in this form, is refused."""
    raw = pathlib.Path(path).read_bytes() if pathlib.Path(path).is_file() else None
    data = read_json(path, 'the judge-noise file')
    if not isinstance(data, dict) or data.get('schema') != NOISE_SCHEMA or data.get('scale') != NOISE_SCALE or not isinstance(data.get('families'), dict):
        raise RegistrationError(f'{path} is not a {NOISE_SCHEMA} measurement on the {NOISE_SCALE} scale (noise_sample.py band): '
                                f'a band in another unit (rubric points, a flip rate) cannot be held to a margin on 0-1')
    entry = (data['families'].get(key) or {}).get(form)
    if not isinstance(entry, dict):
        raise RegistrationError(f'{path} measured no {form} judging of {key!r}: a judge is qualified by a measurement of the form it is registered in')
    if entry.get('scale') != NOISE_SCALE or entry.get('form') != form:
        raise RegistrationError(f'{path}: the {key}/{form} record is not a {form} measurement on the {NOISE_SCALE} scale')
    if not _finite(entry.get('agreement')):
        raise RegistrationError(f'{path}: the {key}/{form} measurement has no agreement (no comparison free of a tie: a judge that never states a preference)')
    for name in ('noiseSd', 'noiseBand95'):
        if not _finite(entry.get(name)) or not 0 <= entry[name] <= 1:
            raise RegistrationError(f'{path}: the {key}/{form} {name} is not a number on the {NOISE_SCALE} scale')
    return {'measuredOn': f'{pathlib.Path(path).name} sha256:{sha256_hex(raw)[:16]} {key}/{form}', 'form': form, 'scale': NOISE_SCALE,
            'agreement': entry['agreement'], 'noiseSd': entry['noiseSd'], 'noiseBand95': entry['noiseBand95']}


def judge_block(args):
    given = {name: getattr(args, name) for name in JUDGE_ARGS if getattr(args, name) is not None}
    if args.scorer != 'judged-verdicts':
        if given:
            raise RegistrationError('judge arguments belong to --scorer judged-verdicts only')
        return None
    required = {name: getattr(args, name) for name in JUDGE_ARGS}
    missing = [name.replace('_', '-') for name, value in required.items() if value is None]
    if missing:
        raise RegistrationError('judged-verdicts needs ' + ', '.join(f'--{m}' for m in missing))
    if args.judge_provider != JUDGE_PROVIDER or not JUDGE_MODEL.fullmatch(args.judge_model):
        raise RegistrationError(f'every offline judge is Claude: --judge-provider {JUDGE_PROVIDER} and a pinned claude-* --judge-model (given {args.judge_provider} {args.judge_model})')
    if args.judge_effort not in JUDGE_EFFORTS:
        raise RegistrationError(f'--judge-effort is one of {", ".join(JUDGE_EFFORTS)} (the CLI effort the judge runs at)')
    if args.judge_form not in ('absolute', 'pairwise'):
        raise RegistrationError('--judge-form is absolute or pairwise')
    passes = args.judge_passes
    if passes < 2 or (args.judge_form == 'pairwise' and passes % 2):
        raise RegistrationError('--judge-passes is at least 2 (even for pairwise: every pair is judged in both orders)')
    if args.judge_max_calls < 1:
        raise RegistrationError('--judge-max-calls is at least 1')
    judge = {'id': args.judge_id, 'provider': args.judge_provider, 'model': args.judge_model, 'effort': args.judge_effort, 'form': args.judge_form, 'passes': passes,
             'maxCalls': args.judge_max_calls, 'qualification': noise_record(args.judge_noise, args.judge_noise_key, args.judge_form)}
    problems = judge_qualification_problems(judge, args.margin)
    if problems:
        raise RegistrationError('the judge does not qualify: ' + '; '.join(problems))
    return judge


# ---------------------------------------------------------------------------------------------------------- registration

def failure_slice(text, scorer):
    values = [v.strip() for v in text.split(',')]
    if not values or any(not v for v in values):
        raise RegistrationError('--failure-slice is a comma-separated list of values')
    if scorer == 'medcalc':
        try:
            return sorted({int(v) for v in values})
        except ValueError:
            raise RegistrationError('--failure-slice for medcalc is calculator ids (integers)')
    return sorted(set(values))


def register(args):
    if args.scorer not in SCORER_BENCHMARKS:
        raise RegistrationError(f'--scorer {args.scorer!r} is not in the lab\'s closed table: {", ".join(SCORER_BENCHMARKS)}')
    if args.benchmark not in SCORER_BENCHMARKS[args.scorer]:
        raise RegistrationError(f'scorer {args.scorer} scores {sorted(SCORER_BENCHMARKS[args.scorer])}, not {args.benchmark}')
    if args.surface not in SURFACES:
        raise RegistrationError(f'--surface is one of {", ".join(SURFACES)}')
    if args.cost_ratio != COST_RATIO:
        raise RegistrationError(f'the registered procedure\'s targeted-repair cost bound is {COST_RATIO}; a registration cannot ask for {args.cost_ratio}')
    if not 0 < args.margin < 1:
        raise RegistrationError('--margin is in (0, 1)')
    if args.campaigns_per_quarter < 1 or args.candidates_max < 1 or args.minimum_groups < 1:
        raise RegistrationError('--campaigns-per-quarter, --candidates-max and --minimum-groups are at least 1')
    for name in ('repeats_development', 'repeats_confirmation'):
        if not 1 <= getattr(args, name) <= 10:
            raise RegistrationError(f'--{name.replace("_", "-")} is in 1..10')
    pool_name = args.pool or 'main'
    pool_file, pool, pool_digest = read_pool(args.pools, pool_name)
    salt = str(args.salt if args.salt is not None else pool_file.get('salt'))
    if salt in ('None', ''):
        raise RegistrationError('no salt: give --salt or use a pools file that records one')
    ppc, ppc_name, ppc_sha = [], None, None
    if args.ppc:
        ppc = ppc_ids(read_json(args.ppc, 'the ppc file'), {args.family, str(pool_file.get('bench'))})
        ppc_name, ppc_sha = pathlib.Path(args.ppc).name, sha256_hex(pathlib.Path(args.ppc).read_bytes())
    development_salt = args.development_salt if args.development_salt not in (None, salt) else None
    opened, seen, opened_files = opened_ids(args.exclude_opened)
    listed, listed_files = listed_ids(args.exclude_ids)
    rows, available, removed = select_rows(pool, salt, ppc, args.development_rows, args.confirmation_rows, development_salt, opened | listed, seen)
    removed_opened = opened_removed(pool, opened)
    judge = judge_block(args)
    if judge is not None:
        required = judge_calls_required(judge['form'], judge['passes'], len(rows['development']), len(rows['confirmation']),
                                        args.repeats_development, args.repeats_confirmation, args.candidates_max)
        if judge['maxCalls'] < required:
            raise RegistrationError(
                f'--judge-max-calls {judge["maxCalls"]} is below the {required} verdict records this registration needs '
                f'({len(rows["development"])} development rows x {args.repeats_development} + {len(rows["confirmation"])} confirmation rows x {args.repeats_confirmation}, '
                f'{judge["passes"]} passes, {judge["form"]}, up to {args.candidates_max} candidates and the A/A control); raise it to at least {required}')
        judge['callsRequired'] = required
    doc = {
        'schema': SCHEMA, 'tool': TOOL, 'round': args.round, 'family': args.family, 'benchmark': args.benchmark, 'scorer': args.scorer,
        'pool': {'file': pathlib.Path(args.pools).name, 'name': pool_name, 'digest': pool_digest},
        'hashOrder': {'salt': salt, 'rule': HASH_RULE, **({'developmentSalt': development_salt} if development_salt else {})},
        'rows': rows, 'available': available,
        'excluded': {'ppc': removed, 'ppcFile': ppc_name, 'ppcFileSha256': ppc_sha, **({'opened': removed_opened, 'openedFiles': opened_files, 'seen': sorted(seen & set(pool['development']), key=natural_key)} if opened_files else {}),
                     **({'listed': listed_removed(pool, listed_files)} if listed_files else {})},
        'repeats': {'development': args.repeats_development, 'confirmation': args.repeats_confirmation},
        'failureSlice': failure_slice(args.failure_slice, args.scorer),
        'failureSliceKey': 'failureCalculators' if args.scorer == 'medcalc' else 'failureSlice',
        'margin': args.margin, 'costRatio': COST_RATIO,
        'alpha': {'quarterTotal': QUARTER_ALPHA, 'campaignsPerQuarter': args.campaigns_per_quarter, 'perCampaign': QUARTER_ALPHA / args.campaigns_per_quarter},
        'candidatesMax': args.candidates_max,
        'control': {'arm': args.control_arm, 'kind': 'A/A', 'rule': CONTROL_RULE},
        'minimumGroups': args.minimum_groups, 'groupsBelowMinimum': len(rows['confirmation']) < args.minimum_groups,
    }
    if judge is not None:
        doc['judge'] = judge
    if args.surface != 'harness-patch':
        doc['surface'] = args.surface
    doc['registeredAt'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    doc['digest'] = content_digest(doc)
    return doc


# ------------------------------------------------------------------------------------------------------------------ check

def check(path, pools, pool_name, ppc_path, exclude_opened=(), exclude_ids=()):
    """A list of differences (empty when the file verifies)."""
    doc = read_json(path, 'the registration')
    problems = []
    if doc.get('schema') != SCHEMA:
        problems.append(f'schema is {doc.get("schema")!r}, not {SCHEMA}')
    if doc.get('digest') != content_digest(doc):
        problems.append('digest differs from the content')
    salt = doc.get('hashOrder', {}).get('salt')
    development_salt = doc.get('hashOrder', {}).get('developmentSalt')
    rows = doc.get('rows') or {}
    for role in ('development', 'confirmation'):
        ids = [str(i) for i in rows.get(role, [])]
        role_salt = development_salt if role == 'development' and development_salt else salt
        if ids != hash_order(role_salt, ids):
            problems.append(f'{role} rows are not in ascending sha256({role_salt}|id) order')
        if len(set(ids)) != len(ids):
            problems.append(f'{role} rows repeat an id')
    if set(rows.get('development', [])) & set(rows.get('confirmation', [])):
        problems.append('an id is in both roles')
    judge = doc.get('judge')
    if isinstance(judge, dict) and isinstance(judge.get('maxCalls'), int) and judge.get('form') in ('absolute', 'pairwise') and isinstance(judge.get('passes'), int):
        repeats = doc.get('repeats') or {}
        required = judge_calls_required(judge['form'], judge['passes'], len(rows.get('development', [])), len(rows.get('confirmation', [])),
                                        repeats.get('development', 1), repeats.get('confirmation', 1), doc.get('candidatesMax', 1))
        if judge['maxCalls'] < required:
            problems.append(f'the judge call maximum {judge["maxCalls"]} is below the {required} verdict records the registration needs')
        if 'callsRequired' in judge and judge['callsRequired'] != required:
            problems.append(f'judge.callsRequired is {judge["callsRequired"]}, the registration needs {required}')
    if isinstance(judge, dict):
        problems.extend(judge_qualification_problems(judge, doc.get('margin')))
    if pools:
        pool_file, pool, pool_digest = read_pool(pools, pool_name or doc.get('pool', {}).get('name', 'main'))
        if pool_digest != doc.get('pool', {}).get('digest'):
            problems.append('the pools file is not the one registered (digest differs)')
        ppc = []
        if ppc_path:
            ppc = ppc_ids(read_json(ppc_path, 'the ppc file'), {doc.get('family'), str(pool_file.get('bench'))})
        recorded = doc.get('excluded', {}).get('openedFiles') or []
        if recorded and not exclude_opened:
            problems.append('the registration excluded opened rows: give the same --exclude-opened files to re-derive the selection')
        opened, seen, opened_files = opened_ids(exclude_opened)
        if opened_files != recorded:
            problems.append('the --exclude-opened files are not the ones recorded in the registration (names or sha256 differ)')
        recorded_listed = doc.get('excluded', {}).get('listed') or []
        if recorded_listed and not exclude_ids:
            problems.append('the registration excluded listed ids: give the same --exclude-ids files to re-derive the selection')
        listed, listed_files = listed_ids(exclude_ids)
        if listed_removed(pool, listed_files) != recorded_listed:
            problems.append('the --exclude-ids files are not the ones recorded in the registration (names, sha256, reasons or removed ids differ)')
        try:
            again, _, removed = select_rows(pool, salt, ppc, len(rows['development']), len(rows['confirmation']), development_salt, opened | listed, seen)
            removed_opened = opened_removed(pool, opened)
        except RegistrationError as error:
            problems.append(f'rows cannot be re-derived: {error}')
        else:
            if again != {k: [str(i) for i in rows[k]] for k in again}:
                problems.append('the rows differ from a fresh selection over the pools file')
            if removed != doc.get('excluded', {}).get('ppc'):
                problems.append('the excluded ppc ids differ from a fresh selection')
            if opened_files and removed_opened != doc.get('excluded', {}).get('opened'):
                problems.append('the excluded opened ids differ from a fresh selection')
    return problems


def build_parser():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--check', metavar='FILE')
    p.add_argument('--round')
    p.add_argument('--family')
    p.add_argument('--benchmark')
    p.add_argument('--scorer')
    p.add_argument('--pools')
    p.add_argument('--pool', help='the pool inside the pools file (default main)')
    p.add_argument('--ppc')
    p.add_argument('--exclude-opened', action='append', default=[], metavar='FILE', help='earlier registration(s) or id lists whose opened rows leave this registration (repeatable)')
    p.add_argument('--exclude-ids', action='append', default=[], metavar='FILE', help='{"reason", "ids"} files: rows that cannot be run or built leave both roles (repeatable)')
    p.add_argument('--surface', default='harness-patch', help='tool-patch: the candidate holds code (its own error-budget ledger and consumer identity)')
    p.add_argument('--salt')
    p.add_argument('--development-salt', help='order the development role by this salt instead of --salt (rows chosen and run before the registration)')
    p.add_argument('--development-rows', type=int)
    p.add_argument('--confirmation-rows', type=int)
    p.add_argument('--repeats-development', type=int, default=1)
    p.add_argument('--repeats-confirmation', type=int, default=3)
    p.add_argument('--failure-slice')
    p.add_argument('--margin', type=float, default=0.05)
    p.add_argument('--cost-ratio', type=float, default=COST_RATIO)
    p.add_argument('--campaigns-per-quarter', type=int, default=3)
    p.add_argument('--candidates-max', type=int, default=3)
    p.add_argument('--control-arm', default='aa')
    p.add_argument('--minimum-groups', type=int, default=25)
    p.add_argument('--judge-id')
    p.add_argument('--judge-provider')
    p.add_argument('--judge-model', help='the pinned claude-* model id the judge calls')
    p.add_argument('--judge-effort', help='the CLI effort the judge runs at (claude_judge.py --effort)')
    p.add_argument('--judge-form')
    p.add_argument('--judge-passes', type=int)
    p.add_argument('--judge-max-calls', type=int)
    p.add_argument('--judge-noise', help='the judge-noise/2 measurement noise_sample.py band wrote: agreement and noise band of --judge-noise-key in --judge-form, on 0-1')
    p.add_argument('--judge-noise-key', choices=['drb', 'rcb', 'bixbench'])
    p.add_argument('--out')
    p.add_argument('--force', action='store_true')
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.check:
            problems = check(args.check, args.pools, args.pool, args.ppc, args.exclude_opened, args.exclude_ids)
            for problem in problems:
                print(f'register_round: {problem}', file=sys.stderr)
            print('register_round: ' + ('differences found' if problems else 'verified'), file=sys.stderr)
            return 1 if problems else 0
        for name in ('round', 'family', 'benchmark', 'scorer', 'pools', 'failure_slice', 'out'):
            if getattr(args, name) is None:
                raise RegistrationError(f'--{name.replace("_", "-")} is required')
        out = pathlib.Path(args.out)
        if out.exists() and not args.force:
            raise RegistrationError(f'{out} exists; a registered file is never overwritten without --force')
        doc = register(args)
        out.parent.mkdir(parents=True, exist_ok=True)
        payload = (json.dumps(doc, ensure_ascii=False, indent=1) + '\n').encode('utf-8')
        out.write_bytes(payload)
        # The lab's inbox takes every file with its digest beside it (`sha256sum -c` format).
        pathlib.Path(f'{out}.sha256').write_text(f'{hashlib.sha256(payload).hexdigest()}  {out.name}\n', encoding='utf-8')
    except RegistrationError as error:
        print(f'register_round: {error}', file=sys.stderr)
        return 2
    print(f'{out} digest {doc["digest"]} (development {len(doc["rows"]["development"])}, confirmation {len(doc["rows"]["confirmation"])})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
