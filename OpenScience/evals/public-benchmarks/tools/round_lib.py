#!/usr/bin/env python3
"""Shared pieces of the development-side scoring path of an RSI round (build_round_gold.py, score_round.py, judged_packets_round.py).

Nothing here reads a confirmation row: `check_development` refuses any id that is not on a pool's development list, and names a
confirmation id as such. Gold, rubrics and scores live under `$BENCH_ROOT/rsi/score/` on the development box and never enter a lane
request, a tree, a prompt or a commit. Python 3.10 compatible; callers run with `python3 -I`.

What lives here
  domains and their benchmark, scorer, pool file and request-key mapping (the names of evals/harness-adaptation `families.py`)
  rows files                   {domain: [ids]}, several files merged
  pool check                   development ids only, with a named refusal for a confirmation id
  run bundles                  `<rid>.tgz` + `<rid>.meta.json` of the lanes' inbox: safe extraction, sha256 check, classification
                               by export_harness_arms.classify (infrastructure is never a score)
  scorer calls                 one `node score_runs.mjs` per batch, over evals/rsi-campaigns/harness_scorers.mjs; nothing is ported
  small statistics             percentile bootstrap (report.py's), medians, script-based language of a text
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import tarfile

TOOLS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))  # python -I does not put the script's directory on sys.path

import export_harness_arms as eha  # noqa: E402

SCHEMA_GOLD = 'rsi-round-gold/1'
SCHEMA_SCORE = 'rsi-round-score/1'
SCORER_JS = TOOLS / 'score_runs.mjs'

DOMAINS = ('medcalc', 'arb-deep', 'arb-wide', 'mbc', 'bixbench', 'drb', 'rcb')
BENCHMARK = {'medcalc': 'medcalc-bench', 'arb-deep': 'autoresearchbench-deep', 'arb-wide': 'autoresearchbench-wide', 'mbc': 'medbrowsecomp',
             'bixbench': 'bixbench', 'drb': 'deepresearchbench', 'rcb': 'researchclawbench'}
SCORER = {'medcalc': 'medcalc', 'arb-deep': 'arb-deep', 'arb-wide': 'arb-wide', 'mbc': 'mbc-normalized', 'bixbench': 'bixbench-deterministic',
          'drb': 'judged-verdicts', 'rcb': 'judged-verdicts'}
JUDGED = ('drb', 'rcb')
# The request key (`item.key`) of a domain: <bench name>/<id>, as evals/harness-adaptation families.Task.key.
KEY_BENCH = {'medcalc': 'medcalc', 'arb-deep': 'arb', 'arb-wide': 'arb', 'mbc': 'medbrowsecomp', 'bixbench': 'bixbench', 'drb': 'drb', 'rcb': 'researchclawbench'}
POOL_FILES = {'medcalc': ('medcalc.json', 'main'), 'arb-deep': ('arb.json', 'deep'), 'arb-wide': ('arb.json', 'wide'), 'mbc': ('medbrowsecomp.json', 'main'),
              'bixbench': ('bixbench.json', 'main'), 'drb': ('drb.json', 'main'), 'rcb': ('rcb.json', 'main')}
# The slice of each domain's rows the tables break down by (the field of the lab row, as evals/rsi-campaigns scorers name them).
SLICE_FIELD = {'medcalc': 'calculatorId', 'arb-deep': 'category', 'arb-wide': 'category', 'mbc': 'task', 'bixbench': 'topic', 'drb': 'category', 'rcb': 'category'}

BOOTSTRAP_SEED = 20261028
BOOTSTRAP_RESAMPLES = 2000


class RoundError(Exception):
    """A request that cannot be served; the message says why."""


class Refused(RoundError):
    """Ids that are not development rows of their pool. `problems` is {id: reason}; nothing was read or written."""

    def __init__(self, domain, problems):
        self.domain, self.problems = domain, problems
        listed = ', '.join(f'{i} ({why})' for i, why in list(problems.items())[:12])
        super().__init__(f'{domain}: refused {len(problems)} id(s) that are not development rows: {listed}')


def natural_key(text):
    return [int(part) if part.isdigit() else part for part in re.split(r'(\d+)', str(text))]


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def write_atomic(path, data, mode=None):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_bytes(data.encode('utf-8') if isinstance(data, str) else data)
    if mode is not None:
        tmp.chmod(mode)
    tmp.replace(path)


def bench_root(arg=None):
    return pathlib.Path(arg or os.environ.get('BENCH_ROOT', '.')).resolve()


def score_dir(root):
    return pathlib.Path(root) / 'rsi' / 'score'


def runs_root():
    scratch = pathlib.Path(os.environ.get('RSI1_SCRATCH', '/tmp/rsi1-scratch'))
    return pathlib.Path(os.environ.get('H2_RUNS_ROOT', scratch / 'h2-runs'))


# ------------------------------------------------------------------------------------------------------------------ rows files

def load_rows_files(paths, domains=None):
    """{domain: [ids]} from rows files ({domain: [ids]}), merged in order without duplicates; restricted to `domains` when given."""
    merged = {}
    for path in paths:
        try:
            data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
        except (OSError, ValueError) as error:
            raise RoundError(f'rows file {path}: {error}')
        if not isinstance(data, dict):
            raise RoundError(f'rows file {path} is {{domain: [ids]}}')
        for domain, ids in data.items():
            if domain not in DOMAINS:
                raise RoundError(f'rows file {path}: unknown domain {domain!r}; expected one of {", ".join(DOMAINS)}')
            if not isinstance(ids, list):
                raise RoundError(f'rows file {path}: {domain} is not a list')
            seen = merged.setdefault(domain, [])
            for i in map(str, ids):
                if i not in seen:
                    seen.append(i)
    if domains:
        unknown = [d for d in domains if d not in DOMAINS]
        if unknown:
            raise RoundError(f'unknown domain(s) {unknown}')
        merged = {d: v for d, v in merged.items() if d in domains}
    if not merged:
        raise RoundError('no rows: give --rows FILE')
    return {d: merged[d] for d in DOMAINS if d in merged}


# ------------------------------------------------------------------------------------------------------------------ pool check

def load_pool_lists(root, domain):
    name, pool = POOL_FILES[domain]
    path = pathlib.Path(root) / 'pools' / name
    try:
        document = json.loads(path.read_text(encoding='utf-8'))
        entry = document['pools'][pool]
    except (OSError, ValueError, KeyError) as error:
        raise RoundError(f'{domain}: pool {name}#{pool} cannot be read under {root}/pools ({error!r})')
    return document, entry


def check_development(root, domain, ids):
    """Raises Refused unless every id is on the pool's development list. A confirmation id is named as such; a dropped one (a
    confirmation-role id left out for sharing material with development), a baseline-v1 one and an unknown one are named too.
    Returns the pool digest. The confirmation list is read only to recognise an id and is never printed or kept."""
    document, entry = load_pool_lists(root, domain)
    development = {str(i) for i in entry['development']}
    confirmation = {str(i) for i in entry['confirmation']}
    dropped = {str(i) for i in entry.get('dropped') or []}
    baseline = {str(i) for i in entry.get('excludedBaseline') or []}
    problems = {}
    for i in ids:
        if i in development:
            continue
        problems[i] = ('on the confirmation list' if i in confirmation else 'dropped from confirmation' if i in dropped
                       else 'baseline v1 row, not a development row' if i in baseline else 'not in the pool')
    if problems:
        raise Refused(domain, problems)
    return document.get('digest')


# ------------------------------------------------------------------------------------------------------------------ gold rows

def gold_path(root, domain, suffix='items.jsonl'):
    return score_dir(root) / 'gold' / f'{domain}.{suffix}'


def load_gold_rows(root, domain, ids):
    """{id: lab row} of the built development gold (items file read by export_harness_arms.row_from_item). Every id must be there."""
    path = gold_path(root, domain)
    if not path.exists():
        raise RoundError(f'{domain}: no gold at {path}; run build_round_gold.py --rows ... first')
    rows = {}
    for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = eha.row_from_item(BENCHMARK[domain], json.loads(line))
        except (KeyError, TypeError, ValueError, eha.ExportError) as error:
            raise RoundError(f'{path}:{number}: {error!r}')
        if row is not None:
            rows[row['id']] = row
    missing = [i for i in ids if i not in rows]
    if missing:
        raise RoundError(f'{domain}: gold lacks {len(missing)} row(s) ({", ".join(missing[:8])}); run build_round_gold.py with the same --rows')
    return {i: rows[i] for i in ids}


def load_gold_items(root, domain):
    path = gold_path(root, domain)
    if not path.exists():
        raise RoundError(f'{domain}: no gold at {path}; run build_round_gold.py --rows ... first')
    return {str(json.loads(l)['id']): json.loads(l) for l in path.read_text(encoding='utf-8').splitlines() if l.strip()}


# ------------------------------------------------------------------------------------------------------------------ requests

def load_requests(paths):
    """{rid: request} from requests.jsonl files (the lane requests: item, image, probe). Unreadable lines are skipped."""
    out = {}
    for path in paths:
        try:
            lines = pathlib.Path(path).read_text(encoding='utf-8').splitlines()
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                request = json.loads(line)
            except ValueError:
                continue
            if isinstance(request, dict) and isinstance(request.get('rid'), str):
                out[request['rid']] = request
    return out


# ------------------------------------------------------------------------------------------------------------------ run bundles

def rid_of(prefix, domain, row, repeat):
    return f'{prefix}.{domain}.{row}.r{repeat}'.replace('/', '_')


def default_inboxes():
    inbox = runs_root() / 'inbox'
    return [inbox, inbox / 'archive']


def find_bundle(rid, inboxes):
    """(tgz, meta) paths of a run's bundle, looking for `<rid>.tgz` and the archived `done.<rid>.tgz`, or None."""
    for directory in inboxes:
        for stem in (rid, f'done.{rid}'):
            tgz = pathlib.Path(directory) / f'{stem}.tgz'
            if tgz.is_file():
                return tgz, pathlib.Path(directory) / f'{stem}.meta.json'
    return None


LIGHT_FILES = ('result.json', 'lane.json', 'answer.md')
MAX_MEMBER_BYTES = 64 * 1024 * 1024


def _member_rel(member, rid):
    """The path of a regular member below `<rid>/`, or None for anything else (links, devices, escapes, other prefixes)."""
    if not member.isreg():
        return None
    parts = pathlib.PurePosixPath(member.name).parts
    if len(parts) < 2 or parts[0] != rid or any(p in ('', '.', '..') for p in parts) or member.name.startswith('/'):
        return None
    return '/'.join(parts[1:])


def bundle_members(tgz, rid):
    """[(relative path, size)] of the regular files of a bundle below `<rid>/`."""
    with tarfile.open(tgz, 'r:gz') as archive:
        return [(rel, m.size) for m in archive if (rel := _member_rel(m, rid)) is not None]


def extract_members(tgz, rid, dest, want):
    """Write the members whose relative path satisfies `want` below `dest` (each file at most MAX_MEMBER_BYTES). Only regular files are
    ever written, and only under `dest`. Returns the relative paths written."""
    dest = pathlib.Path(dest)
    written = []
    with tarfile.open(tgz, 'r:gz') as archive:
        for member in archive:
            rel = _member_rel(member, rid)
            if rel is None or not want(rel) or member.size > MAX_MEMBER_BYTES:
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            with open(target, 'wb') as handle:
                shutil.copyfileobj(source, handle)
            written.append(rel)
    return written


class RunRecord:
    """One expected run: where its bundle is and what it says. `state` is missing | corrupt | infra | ok."""

    def __init__(self, arm, domain, row, repeat, rid):
        self.arm, self.domain, self.row, self.repeat, self.rid = arm, domain, row, repeat, rid
        self.state, self.reason = 'missing', None
        self.result, self.lane, self.meta, self.answer, self.dir = {}, {}, {}, None, None
        self.tgz, self.cached = None, False


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def load_run(record, inboxes, cache, extra_codes=()):
    """Fill `record` from its bundle (extracted into cache/<rid>/ once per bundle sha256). Classification is export_harness_arms's, so a
    run the exporter would call infrastructure is infrastructure here and never a score."""
    found = find_bundle(record.rid, inboxes)
    folder = pathlib.Path(cache) / record.rid
    marker = folder / '.sha256'
    if found is None:
        # A bundle another process has since moved away or deleted still counts if it was unpacked here once (its sha256 was checked then).
        if not (marker.is_file() and (folder / 'result.json').is_file()):
            return record
        record.cached = True
    else:
        tgz, meta_path = found
        record.tgz = tgz
        meta = read_json(meta_path) if meta_path.is_file() else None
        record.meta = meta if isinstance(meta, dict) else {}
        digest = sha256_file(tgz)
        if record.meta.get('sha256') and record.meta['sha256'] != digest:
            record.state, record.reason = 'corrupt', 'bundle sha256 differs from its meta'
            return record
        if not (marker.is_file() and marker.read_text(encoding='utf-8').strip() == digest):
            if folder.exists():
                shutil.rmtree(folder)
            try:
                extract_members(tgz, record.rid, folder, lambda rel: rel in LIGHT_FILES)
            except (tarfile.TarError, OSError, EOFError) as error:
                record.state, record.reason = 'corrupt', f'bundle unreadable ({type(error).__name__})'
                return record
            folder.mkdir(parents=True, exist_ok=True)
            marker.write_text(digest + '\n', encoding='utf-8')
    record.dir = folder
    result = read_json(folder / 'result.json')
    if not isinstance(result, dict):
        record.state, record.reason = 'corrupt', 'no readable result.json in the bundle'
        return record
    record.result = result
    lane = read_json(folder / 'lane.json')
    record.lane = lane if isinstance(lane, dict) else {}
    answer_path = folder / 'answer.md'
    record.answer = answer_path.read_text(encoding='utf-8') if answer_path.is_file() else None
    reason = eha.classify(result, set(extra_codes))
    if reason:
        record.state, record.reason = 'infra', reason
    else:
        record.state = 'ok'
    return record


def expected_key(domain, row):
    return f'{KEY_BENCH[domain]}/{row}'


# ------------------------------------------------------------------------------------------------------------------ scorer calls

def run_scorer(jobs, node='node'):
    """[{id, scorer, answer, atCapAnswer?, row}] -> {id: {score, scoreAtCap?, detail?} | {error}} through score_runs.mjs (one process)."""
    if not jobs:
        return {}
    if shutil.which(node) is None:
        raise RoundError('node is needed to run the lab scorers (evals/rsi-campaigns/harness_scorers.mjs)')
    done = subprocess.run([node, str(SCORER_JS)], input=json.dumps({'jobs': jobs}, ensure_ascii=False), capture_output=True, text=True, encoding='utf-8')
    if done.returncode != 0:
        raise RoundError(f'score_runs.mjs failed ({done.returncode}): {done.stderr.strip()[-400:]}')
    try:
        return {r['id']: r for r in json.loads(done.stdout)['results']}
    except (ValueError, KeyError) as error:
        raise RoundError(f'score_runs.mjs answered something unreadable ({error!r})')


# ------------------------------------------------------------------------------------------------------------------ statistics

def bootstrap_ci(values, seed=BOOTSTRAP_SEED, resamples=BOOTSTRAP_RESAMPLES):
    """Percentile bootstrap 95% interval of the mean (report.py's rule: seed 20261028, 2,000 resamples), or None for no values."""
    import random
    if not values:
        return None
    rng = random.Random(seed)
    means = sorted(statistics.fmean(rng.choice(values) for _ in values) for _ in range(resamples))
    return [means[int(0.025 * resamples)], means[int(0.975 * resamples) - 1]]


def mean_ci(values):
    if not values:
        return {'n': 0, 'mean': None, 'ci95': None}
    return {'n': len(values), 'mean': statistics.fmean(values), 'ci95': bootstrap_ci(values)}


def median_or_none(values):
    return statistics.median(values) if values else None


CJK = re.compile(r'[㐀-䶿一-鿿぀-ヿ가-힯]')
LATIN = re.compile(r'[A-Za-z]')
CODE_FENCE = re.compile(r'```.*?```', re.S)
URL_RE = re.compile(r'https?://\S+')


def script_language(text):
    """'zh' | 'en' | None from the share of CJK letters among CJK and Latin letters (code fences and URLs left out). A script property,
    not a reading of the prose: None when the text is too short or mixed to say."""
    body = URL_RE.sub(' ', CODE_FENCE.sub(' ', text or ''))
    cjk, latin = len(CJK.findall(body)), len(LATIN.findall(body))
    if cjk + latin < 30:
        return None
    share = cjk / (cjk + latin)
    return 'zh' if share >= 0.30 else 'en' if share <= 0.05 else None
