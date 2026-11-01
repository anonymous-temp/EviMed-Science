#!/usr/bin/env python3
"""Pre-register one family of an RSI round (harness-patch campaign): rows, repeats, scorer, failure slice, margin, error budget.

  register_round.py --round rsi1-2026-11 --family drb --benchmark deepresearchbench --scorer judged-verdicts \\
      --pools pools/drb.json --ppc rsi/ppc-tasks.json --development-rows 12 --confirmation-rows 30 \\
      --failure-slice "Science & Technology" --judge-id <id> --judge-provider anthropic --judge-form pairwise ... --out rsi/drb.registration.json
  register_round.py --check rsi/drb.registration.json [--pools pools/drb.json [--ppc rsi/ppc-tasks.json]]

The file is written before any confirmation run exists and decides nothing about outcomes: it names the rows, how they were
ordered, and the parameters the lab will hold the campaign to. What it fixes:
  rows        the pool's registered development / confirmation ids (evals/public-benchmarks/tools/register_pools.py), minus the
              ids of --ppc (the tasks the task-level recursion has already read; removed from BOTH roles) and minus any id on the
              other role's list, ordered by ascending sha256("<salt>|<id>") (ties: natural id order), the first N and M kept
  repeats     per role (the lab holds the confirmation to the repeats registered here)
  scorer      an id of the lab's closed scorer table, consistent with the benchmark
  failure slice, margin, cost ratio (the registered procedure's targeted-repair bound is 1.1 and the registration cannot ask
              for another), alpha allocation (0.05 per quarter divided by the campaigns planned in it), K (the most candidates
              the development gate may carry), and the A/A control arm of the development gate
  judge       judged-verdicts only: the fixed judge identity, its passes and call budget, and its qualification (agreement and the
              noise band of repeated judging, from judge-noise.txt or given) with the thresholds it must meet
`groupsBelowMinimum` states an observation (fewer confirmation rows than the procedure's minimum groups: the report will call
the result directional); it is not a decision. The digest is the sha256 of the canonical JSON (sorted keys, compact, UTF-8) of
the file without `digest` and `registeredAt`, so the same inputs always give the same digest. An existing --out is never
overwritten without --force. `--check` recomputes the digest, the hash order and the disjointness of the two lists, and with
--pools (and --ppc) re-derives the whole row selection from the parameters in the file; exit 1 on any difference.

Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import hashlib
import json
import pathlib
import re
import sys
from datetime import datetime, timezone

SCHEMA = 'rsi-round-registration/1'
TOOL = 'register_round.py/1'
QUARTER_ALPHA = 0.05
COST_RATIO = 1.1
HASH_RULE = 'ascending sha256(salt|id)'
CONTROL_RULE = ('a candidate is eligible only if its failure-slice gain exceeds the absolute failure-slice difference '
                'the A/A arm shows against the baseline')
SCORER_BENCHMARKS = {
    'medcalc': {'medcalc-bench'},
    'bixbench-deterministic': {'bixbench'},
    'arb-deep': {'autoresearchbench-deep'},
    'arb-wide': {'autoresearchbench-wide'},
    'mbc-normalized': {'medbrowsecomp'},
    'judged-verdicts': {'deepresearchbench', 'researchclawbench'},
}
JUDGE_ARGS = ('judge_id', 'judge_provider', 'judge_form', 'judge_passes', 'judge_max_calls', 'judge_agreement', 'judge_noise_sd',
              'judge_noise_band', 'judge_measured_on', 'judge_min_agreement', 'judge_max_noise_band', 'judge_noise', 'judge_noise_key')


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
    "<bench>:<id>" (the prefix is stripped when it names this family or pool) or {"id": ...}."""
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


def select_rows(pool, salt, ppc, development_rows, confirmation_rows):
    """(rows by role, available by role, ppc ids actually removed)."""
    removed = sorted((set(ppc) & (set(pool['development']) | set(pool['confirmation']))), key=natural_key)
    skip = set(ppc)
    rows, available = {}, {}
    for role, other in (('development', 'confirmation'), ('confirmation', 'development')):
        keep = [i for i in dict.fromkeys(pool[role]) if i not in skip and i not in set(pool[other])]
        ordered = hash_order(salt, keep)
        available[role] = len(ordered)
        want = development_rows if role == 'development' else confirmation_rows
        if want is None:
            want = len(ordered)
        if want < 1 or want > len(ordered):
            raise RegistrationError(f'{role}: {want} rows asked, {len(ordered)} available after the exclusions')
        rows[role] = ordered[:want]
    return rows, available, removed


# --------------------------------------------------------------------------------------------------------------- judge

def judge_block(args):
    given = {name: getattr(args, name) for name in JUDGE_ARGS if getattr(args, name) is not None}
    if args.scorer != 'judged-verdicts':
        if given:
            raise RegistrationError('judge arguments belong to --scorer judged-verdicts only')
        return None
    sd, band = args.judge_noise_sd, args.judge_noise_band
    measured = args.judge_measured_on
    if args.judge_noise:
        if args.judge_noise_key is None:
            raise RegistrationError('--judge-noise needs --judge-noise-key (drb, rcb or bixbench)')
        entry = read_json(args.judge_noise, 'the judge-noise file').get(args.judge_noise_key)
        if not isinstance(entry, dict):
            raise RegistrationError(f'{args.judge_noise} has no {args.judge_noise_key!r}')
        sd = entry.get('sd') if sd is None else sd
        band = entry.get('band95') if band is None else band
        measured = measured or f'{pathlib.Path(args.judge_noise).name}:{args.judge_noise_key}'
    required = {'judge_id': args.judge_id, 'judge_provider': args.judge_provider, 'judge_form': args.judge_form, 'judge_passes': args.judge_passes,
                'judge_max_calls': args.judge_max_calls, 'judge_agreement': args.judge_agreement, 'judge_noise_sd': sd,
                'judge_noise_band': band, 'judge_measured_on': measured, 'judge_min_agreement': args.judge_min_agreement,
                'judge_max_noise_band': args.judge_max_noise_band}
    missing = [name.replace('_', '-') for name, value in required.items() if value is None]
    if missing:
        raise RegistrationError('judged-verdicts needs ' + ', '.join(f'--{m}' for m in missing))
    if re.search('deepseek', f'{args.judge_id} {args.judge_provider}', re.I):
        raise RegistrationError('the judge may not be on the solver\'s family (a judge id or provider naming deepseek is refused)')
    if args.judge_form not in ('absolute', 'pairwise'):
        raise RegistrationError('--judge-form is absolute or pairwise')
    passes = args.judge_passes
    if passes < 2 or (args.judge_form == 'pairwise' and passes % 2):
        raise RegistrationError('--judge-passes is at least 2 (even for pairwise: every pair is judged in both orders)')
    if args.judge_max_calls < 1:
        raise RegistrationError('--judge-max-calls is at least 1')
    for name, value in (('agreement', args.judge_agreement), ('min-agreement', args.judge_min_agreement)):
        if not 0 <= value <= 1:
            raise RegistrationError(f'--judge-{name} is in [0, 1]')
    for name, value in (('noise-sd', sd), ('noise-band', band)):
        if not value >= 0 or value == float('inf'):
            raise RegistrationError(f'--judge-{name} is a finite number of at least 0')
    if not args.judge_max_noise_band > 0:
        raise RegistrationError('--judge-max-noise-band is above 0')
    return {'id': args.judge_id, 'provider': args.judge_provider, 'form': args.judge_form, 'passes': passes, 'maxCalls': args.judge_max_calls,
            'qualification': {'agreement': args.judge_agreement, 'noiseSd': sd, 'noiseBand95': band, 'measuredOn': measured,
                              'minimumAgreement': args.judge_min_agreement, 'maximumNoiseBand': args.judge_max_noise_band}}


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
    rows, available, removed = select_rows(pool, salt, ppc, args.development_rows, args.confirmation_rows)
    judge = judge_block(args)
    doc = {
        'schema': SCHEMA, 'tool': TOOL, 'round': args.round, 'family': args.family, 'benchmark': args.benchmark, 'scorer': args.scorer,
        'pool': {'file': pathlib.Path(args.pools).name, 'name': pool_name, 'digest': pool_digest},
        'hashOrder': {'salt': salt, 'rule': HASH_RULE},
        'rows': rows, 'available': available,
        'excluded': {'ppc': removed, 'ppcFile': ppc_name, 'ppcFileSha256': ppc_sha},
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
    doc['registeredAt'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    doc['digest'] = content_digest(doc)
    return doc


# ------------------------------------------------------------------------------------------------------------------ check

def check(path, pools, pool_name, ppc_path):
    """A list of differences (empty when the file verifies)."""
    doc = read_json(path, 'the registration')
    problems = []
    if doc.get('schema') != SCHEMA:
        problems.append(f'schema is {doc.get("schema")!r}, not {SCHEMA}')
    if doc.get('digest') != content_digest(doc):
        problems.append('digest differs from the content')
    salt = doc.get('hashOrder', {}).get('salt')
    rows = doc.get('rows') or {}
    for role in ('development', 'confirmation'):
        ids = [str(i) for i in rows.get(role, [])]
        if ids != hash_order(salt, ids):
            problems.append(f'{role} rows are not in ascending sha256({salt}|id) order')
        if len(set(ids)) != len(ids):
            problems.append(f'{role} rows repeat an id')
    if set(rows.get('development', [])) & set(rows.get('confirmation', [])):
        problems.append('an id is in both roles')
    if pools:
        pool_file, pool, pool_digest = read_pool(pools, pool_name or doc.get('pool', {}).get('name', 'main'))
        if pool_digest != doc.get('pool', {}).get('digest'):
            problems.append('the pools file is not the one registered (digest differs)')
        ppc = []
        if ppc_path:
            ppc = ppc_ids(read_json(ppc_path, 'the ppc file'), {doc.get('family'), str(pool_file.get('bench'))})
        try:
            again, _, removed = select_rows(pool, salt, ppc, len(rows['development']), len(rows['confirmation']))
        except RegistrationError as error:
            problems.append(f'rows cannot be re-derived: {error}')
        else:
            if again != {k: [str(i) for i in rows[k]] for k in again}:
                problems.append('the rows differ from a fresh selection over the pools file')
            if removed != doc.get('excluded', {}).get('ppc'):
                problems.append('the excluded ppc ids differ from a fresh selection')
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
    p.add_argument('--salt')
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
    p.add_argument('--judge-form')
    p.add_argument('--judge-passes', type=int)
    p.add_argument('--judge-max-calls', type=int)
    p.add_argument('--judge-agreement', type=float)
    p.add_argument('--judge-noise-sd', type=float)
    p.add_argument('--judge-noise-band', type=float)
    p.add_argument('--judge-measured-on')
    p.add_argument('--judge-min-agreement', type=float)
    p.add_argument('--judge-max-noise-band', type=float)
    p.add_argument('--judge-noise', help='judge-noise.txt (JSON): sd and band95 of --judge-noise-key; explicit arguments win')
    p.add_argument('--judge-noise-key', choices=['drb', 'rcb', 'bixbench'])
    p.add_argument('--out')
    p.add_argument('--force', action='store_true')
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.check:
            problems = check(args.check, args.pools, args.pool, args.ppc)
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
