#!/usr/bin/env python3
"""Development-role gold for the rows a round names, in the shape the lab's scorers and export_harness_arms.py read.

  build_round_gold.py --rows rsi/screen/rows.json [--rows rsi/screen-bix/rows.json ...] [--domains medcalc,arb-deep,...]
                      [--bench-root DIR] [--out DIR] [--fetch]

Rows files are {domain: [ids]} (the `rows.json` that evals/harness-adaptation `make_screen.py` writes); domains: medcalc, arb-deep,
arb-wide, mbc, bixbench, drb, rcb. BENCH_ROOT (default '.') is the benchmark work directory with data/ and pools/; the output goes under
`$BENCH_ROOT/rsi/score/` (dev box only: gold is never in git, never in a lane request, never in a prompt).

REFUSAL. Before anything is read or written, every id is checked against its registered pool (register_pools.py): an id that is on the
CONFIRMATION list is refused by name, so are the ids dropped from confirmation, baseline-v1 rows and ids the pool does not know. One
refusal stops the whole call (exit 2); nothing is written. Only the development list ever reaches a builder.

Output, per domain, under `<out>` (default `$BENCH_ROOT/rsi/score/gold`, mode 0700; files 0600), deterministic and idempotent:
  <domain>.items.jsonl   bench-driver item shape of tools/build_*.py with gold (key, bench, id, group, gold, scorer, meta), the shape
                         `export_harness_arms.py --items` reads; the solver-facing prompt is left out (it is in the lane request)
  <domain>.rows.json     {"rows": [...]} in the lab's row form (export_harness_arms.row_from_item), what `--rows` of that tool reads
  manifest.json          per domain: pool file and digest, row count, sha256 of the raw source files and of the two outputs
Judged families (drb, rcb) have no answer key: their rows are {id, category}; the rubric material the judge reads (DeepResearch Bench
criteria and reference, ResearchClawBench checklist and rubric images) is copied for the development ids only to
`$BENCH_ROOT/rsi/score/assets/` from `data/` when it is there, else fetched with --fetch from the pinned upstream revisions the
baseline builders use (build_drb.py, build_rcb.py); the complete upstream files are held in memory and never written.

BixBench: the lab's `bixbench-deterministic` refuses a capsule row with no question code can settle (all `llm_verifier`) and one with a
dataset range whose lower bound is above its upper one. Such rows are kept and listed with the reason under `unscorableByCode` in
manifest.json (score_round.py carries them as judge-only); `--fix-reversed-ranges` swaps the reversed bounds (recorded in the item's
meta) so the rest of that capsule can be read by code on the development box. The lab does not do that.

MedCalc gold comes from the original test set because the lane prompts do; the rows whose MedCalc-Bench-Verified record differs are
listed in the summary (their label and note may differ there).

Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import csv
import hashlib
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path
import export_harness_arms as eha  # noqa: E402
import round_lib as rl  # noqa: E402

DRB_REV = 'f2735b5c'
DRB_RAW = f'https://raw.githubusercontent.com/Ayanami0730/deep_research_bench/{DRB_REV}/data/'
DRB_QUERY_URL = DRB_RAW + 'prompt_data/query.jsonl'
DRB_CRITERIA_URL = DRB_RAW + 'criteria_data/criteria.jsonl'
DRB_REFERENCE_URL = DRB_RAW + 'test_data/cleaned_data/reference.jsonl'
RCB_REV = 'fa82414b2ead64ea3a4df2c0688512198c42ba59'
RCB_BASE = f'https://huggingface.co/datasets/InternScience/ResearchClawBench/resolve/{RCB_REV}/'
RCB_ASSET_CAP = 60 * 1024 * 1024  # bytes of rubric images per task; more is a surprise, not a download
ARB_DEEP_NONE = ['none']


class BuildError(rl.RoundError):
    pass


def fetch_bytes(url, timeout=120):
    request = urllib.request.Request(url, headers={'User-Agent': 'evimed-rsi1-gold/1'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


class Context:
    """The work directory, the switch for the network and the scratch counters a builder reports."""

    def __init__(self, root, fetch, fix_ranges=False):
        self.root, self.fetch, self.fix_ranges = pathlib.Path(root), fetch, fix_ranges
        self.score = rl.score_dir(root)
        self.assets = self.score / 'assets'
        self.notes = {}

    def need(self, relative):
        path = self.root / relative
        if not path.is_file():
            raise BuildError(f'raw data {relative} is not under {self.root}')
        return path

    def sources(self, relatives):
        return [{'path': r, 'sha256': rl.sha256_file(self.need(r))} for r in relatives]

    def get(self, url, what):
        if not self.fetch:
            raise BuildError(f'{what} is not on this box; run with --fetch to take it from {urllib.parse.urlsplit(url).netloc}')
        try:
            return fetch_bytes(url)
        except OSError as error:
            raise BuildError(f'{what}: fetching failed ({error!r})')


# ------------------------------------------------------------------------------------------------------------- code-scored families

def build_medcalc(ctx, ids, pool_document):
    path = ctx.need('data/medcalc/test_data.csv')
    want, found = set(ids), {}
    with open(path, newline='', encoding='utf-8') as handle:
        for r in csv.DictReader(handle):
            if r['Row Number'] in want:
                found[r['Row Number']] = r
    items = []
    for i in ids:
        r = found.get(i)
        if r is None:
            raise BuildError(f'medcalc: row {i} is not in the test set')
        items.append({
            'key': f'medcalc/{i}', 'bench': 'medcalc', 'id': i, 'group': 'medcalc-main',
            'gold': {'calculator_id': int(r['Calculator ID']), 'answer': r['Ground Truth Answer'], 'lower': r['Lower Limit'], 'upper': r['Upper Limit'],
                     'output_type': r['Output Type']},
            'scorer': 'medcalc',
            'meta': {'calculator_id': int(r['Calculator ID']), 'calculator': r['Calculator Name'], 'category': r['Category'], 'output_type': r['Output Type'],
                     'note_id': r['Note ID'], 'note_type': r['Note Type'], 'row_number': int(r['Row Number'])}})
    changed = {str(x) for x in ((pool_document.get('verified') or {}).get('changedRowIds') or [])}
    ctx.notes['medcalc'] = {'verifiedRecordDiffers': sorted(set(ids) & changed, key=rl.natural_key)}
    return items, ['data/medcalc/test_data.csv']


def build_mbc(ctx, ids, pool_document):
    path = ctx.need('data/medbrowsecomp/MedBrowseComp_605.csv')
    want, found = set(ids), {}
    with open(path, newline='', encoding='utf-8') as handle:
        for index, r in enumerate(csv.DictReader(handle)):
            if str(index) in want:
                found[str(index)] = r
    items = []
    for i in ids:
        r = found.get(i)
        if r is None:
            raise BuildError(f'mbc: row {i} is not in MedBrowseComp_605.csv')
        nct = re.search(r'NCT\d{8}', r['prompt'])
        items.append({
            'key': f'medbrowsecomp/{i}', 'bench': 'medbrowsecomp', 'id': i, 'group': 'medbrowsecomp-main',
            'gold': {'task_name': r['task_name'], 'answer': r['gold']}, 'scorer': 'medbrowsecomp',
            'meta': {'task_name': r['task_name'], 'nct': nct.group(0) if nct else None, 'csv_row': int(i)}})
    return items, ['data/medbrowsecomp/MedBrowseComp_605.csv']


def build_arb(kind):
    def build(ctx, ids, pool_document):
        path = ctx.need('data/autoresearchbench_data/AutoResearchBench.jsonl')
        want, found = set(ids), {}
        with open(path, encoding='utf-8') as handle:
            for index, line in enumerate(handle):
                raw = json.loads(line)
                rid = f"{raw['type']}-{index}"
                if raw['type'] == kind and rid in want:
                    found[rid] = (index, raw)
        items = []
        for i in ids:
            if i not in found:
                raise BuildError(f'arb-{kind}: {i} is not a {kind} row of the bundle')
            index, r = found[i]
            is_none = kind == 'deep' and [a.strip().lower() for a in r['answer']] == ARB_DEEP_NONE
            items.append({
                'key': f'arb/{i}', 'bench': 'arb', 'id': i, 'group': 'arb-main',
                'gold': {'type': kind, 'titles': r['answer'], 'arxiv_ids': r['arxiv_id'], 'is_none': is_none},
                'scorer': f'arb-{kind}',
                'meta': {'type': kind, 'category': r['category'], 'bundle_index': index, 'is_none': is_none,
                         'gold_count': 0 if is_none else len(r['answer']), 'topic': r.get('topic')}})
        return items, ['data/autoresearchbench_data/AutoResearchBench.jsonl']
    return build


def bix_topic(categories):
    # The stratum of build_bixbench.py, kept identical.
    s = ' '.join(categories) if isinstance(categories, list) else categories
    if 'Imaging' in s:
        return 'imaging'
    if 'Genomic Variant' in s:
        return 'variant'
    if 'Epigenomics' in s:
        return 'epigenomics'
    if 'Functional Genomics' in s or 'Machine Learning' in s:
        return 'functional_ml'
    if s.strip() == 'Other':
        return 'other_stats'
    return 'transcriptomics'


def build_bixbench(ctx, ids, pool_document):
    uuids = pool_document.get('capsuleUuids') or {}
    path = ctx.need('data/bixbench_meta/BixBench.jsonl')
    by_uuid = {}
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            raw = json.loads(line)
            by_uuid.setdefault(raw['capsule_uuid'], []).append(raw)
    items = []
    for i in ids:
        uuid = uuids.get(i)
        qs = sorted(by_uuid.get(uuid, []), key=lambda r: r['question_id']) if uuid else []
        if not qs:
            raise BuildError(f'bixbench: capsule {i} has no questions in BixBench.jsonl')
        gq, swapped = [], []
        for n, q in enumerate(qs, 1):
            rg = None
            if q['eval_mode'] == 'range_verifier':
                m = re.fullmatch(r'\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)', q['ideal'].strip())
                rg = [float(m.group(1)), float(m.group(2))] if m else None
                if rg and rg[0] > rg[1] and ctx.fix_ranges:
                    rg = [rg[1], rg[0]]  # a reversed range in the dataset, swapped on request; recorded in meta.rangesSwapped
                    swapped.append(q['question_id'])
            gq.append({'n': n, 'qid': q['question_id'], 'question': q['question'].strip(), 'ideal': q['ideal'], 'eval_mode': q['eval_mode'],
                       'range': rg, 'distractors': q['distractors']})
        modes = {}
        for q in qs:
            modes[q['eval_mode']] = modes.get(q['eval_mode'], 0) + 1
        items.append({
            'key': f'bixbench/{i}', 'bench': 'bixbench', 'id': i, 'group': f'bixbench-{i}',
            'gold': {'questions': gq, 'hypothesis': qs[0]['hypothesis'], 'paper': qs[0]['paper']}, 'scorer': 'claude-open',
            'meta': {'short_id': qs[0]['short_id'], 'capsule_uuid': uuid, 'topic': bix_topic(qs[0]['categories']), 'n_questions': len(gq),
                     'categories': qs[0]['categories'], 'eval_modes': modes, **({'rangesSwapped': swapped} if swapped else {})}})
    return items, ['data/bixbench_meta/BixBench.jsonl']


# ------------------------------------------------------------------------------------------------------------------- judged families

def drb_query(ctx):
    """{id: query} of DeepResearch Bench (prompts, topic, language: nothing secret), from the box or fetched once into assets/."""
    cached = ctx.assets / 'drb' / 'query.jsonl'
    candidates = [cached, rl.runs_root() / 'cache' / 'drb-query.jsonl']
    text = next((p.read_text(encoding='utf-8') for p in candidates if p.is_file()), None)
    if text is None:
        text = ctx.get(DRB_QUERY_URL, 'the DeepResearch Bench query file').decode('utf-8')
        rl.write_atomic(cached, text, 0o600)
    return {str(json.loads(l)['id']): json.loads(l) for l in text.splitlines() if l.strip()}


def drb_assets(ctx, ids):
    """Copy (or fetch) criteria and reference of the development ids only into assets/drb/. Returns the sources note (always the same)."""
    out = ctx.assets / 'drb'
    upstream = [{'upstream': f'deep_research_bench@{DRB_REV}', 'files': ['criteria_data/criteria.jsonl', 'test_data/cleaned_data/reference.jsonl']}]
    need = [i for i in ids if not ((out / 'criteria' / f'{i}.json').is_file() and (out / 'reference' / f'{i}.md').is_file())]
    if not need:
        return upstream
    criteria, refs = {}, {}
    for i in list(need):
        local_c, local_r = ctx.root / 'data' / 'drb' / 'criteria' / f'{i}.json', ctx.root / 'data' / 'drb' / 'reference' / f'{i}.md'
        if local_c.is_file() and local_r.is_file():
            criteria[i], refs[i] = json.loads(local_c.read_text(encoding='utf-8')), local_r.read_text(encoding='utf-8')
            need.remove(i)
    if need:
        want = set(need)
        for url, what, target, keep in ((DRB_CRITERIA_URL, 'the DeepResearch Bench criteria', criteria, lambda r: r),
                                        (DRB_REFERENCE_URL, 'the DeepResearch Bench reference reports', refs, lambda r: r['article'])):
            data = ctx.get(url, what).decode('utf-8')
            for line in data.splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                if str(row['id']) in want:  # the rest of the file (confirmation rows included) is dropped here, unread beyond the id
                    target[str(row['id'])] = keep(row)
            del data
        lost = [i for i in need if i not in criteria or i not in refs]
        if lost:
            raise BuildError(f'drb: no criteria or reference for {lost[:6]} at upstream {DRB_REV}')
    for i in ids:
        if i in criteria:
            rl.write_atomic(out / 'criteria' / f'{i}.json', json.dumps(criteria[i], ensure_ascii=False, indent=1), 0o600)
            rl.write_atomic(out / 'reference' / f'{i}.md', refs[i], 0o600)
    return upstream


def build_drb(ctx, ids, pool_document):
    queries = drb_query(ctx)
    sources = drb_assets(ctx, ids)
    items = []
    for i in ids:
        q = queries.get(i)
        if q is None:
            raise BuildError(f'drb: task {i} is not in the query file')
        criteria = json.loads((ctx.assets / 'drb' / 'criteria' / f'{i}.json').read_text(encoding='utf-8'))
        if q['prompt'] != criteria['prompt']:
            raise BuildError(f'drb: the criteria of task {i} are for another prompt')
        reference = (ctx.assets / 'drb' / 'reference' / f'{i}.md').read_text(encoding='utf-8')
        items.append({
            'key': f'drb/{i}', 'bench': 'drb', 'id': i, 'group': 'drb-main', 'prompt': q['prompt'],
            'gold': {'criteria': f'assets/drb/criteria/{i}.json', 'reference': f'assets/drb/reference/{i}.md', 'dimension_weight': criteria['dimension_weight']},
            'scorer': 'claude-race',
            'meta': {'topic': q['topic'], 'language': q['language'], 'source_id': i, 'reference_chars': len(reference)}})
    return items, sources


def rcb_task(ctx, task):
    for path in (ctx.root / 'data' / 'rcb_meta' / task / 'task_info.json', rl.runs_root() / 'cache' / 'rcb' / task / 'task_info.json'):
        if path.is_file():
            return json.loads(path.read_text(encoding='utf-8'))
    url = RCB_BASE + urllib.parse.quote(f'tasks/{task}/task_info.json')
    return json.loads(ctx.get(url, f'the task statement of {task}').decode('utf-8'))


def rcb_assets(ctx, task):
    """The rubric and the images it references, for one development task, into assets/rcb/<task>/ (local data first, else fetched)."""
    out = ctx.assets / 'rcb' / task
    local = ctx.root / 'data' / 'rcb_judge' / task
    checklist_file = out / 'checklist.json'
    if checklist_file.is_file():
        checklist = json.loads(checklist_file.read_text(encoding='utf-8'))
    else:
        source = local / 'checklist.json'
        raw = source.read_bytes() if source.is_file() else ctx.get(RCB_BASE + urllib.parse.quote(f'tasks/{task}/target_study/checklist.json'), f'the rubric of {task}')
        checklist = json.loads(raw.decode('utf-8'))
        rl.write_atomic(checklist_file, json.dumps(checklist, ensure_ascii=False, indent=1), 0o600)
    total = 0
    for item in checklist:
        if not item.get('path'):
            continue
        rel = item['path'].lstrip('./')
        target = out / rel
        if target.is_file():
            total += target.stat().st_size
            continue
        source = local / rel
        raw = source.read_bytes() if source.is_file() else ctx.get(RCB_BASE + urllib.parse.quote(f'tasks/{task}/target_study/{rel}'), f'a rubric image of {task}')
        total += len(raw)
        if total > RCB_ASSET_CAP:
            raise BuildError(f'rcb: the rubric images of {task} exceed {RCB_ASSET_CAP >> 20} MB')
        rl.write_atomic(target, raw, 0o600)
    return checklist


def build_rcb(ctx, ids, pool_document):
    items = []
    for i in ids:
        info = rcb_task(ctx, i)
        checklist = rcb_assets(ctx, i)
        items.append({
            'key': f'researchclawbench/{i}', 'bench': 'researchclawbench', 'id': i, 'group': f'researchclawbench-{i}',
            'gold': {'rubric': f'assets/rcb/{i}/checklist.json', 'images_dir': f'assets/rcb/{i}/images/', 'report_path': 'report/report.md', 'task': info['task']},
            'scorer': 'claude-rubric',
            'meta': {'domain': i.split('_')[0], 'task': i, 'rubric_items': len(checklist), 'rubric_text': sum(c['type'] == 'text' for c in checklist),
                     'rubric_image': sum(c['type'] == 'image' for c in checklist)}})
    return items, [{'upstream': f'ResearchClawBench@{RCB_REV}', 'files': ['tasks/<task>/target_study/checklist.json']}]


BUILDERS = {'medcalc': build_medcalc, 'arb-deep': build_arb('deep'), 'arb-wide': build_arb('wide'), 'mbc': build_mbc, 'bixbench': build_bixbench,
            'drb': build_drb, 'rcb': build_rcb}


# ------------------------------------------------------------------------------------------------------------------------------ main

def jsonl(rows):
    return ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows)


def refuse_before_reading(root, wanted):
    """Check every domain's ids against its pool; returns {domain: pool digest}. Raises Refused for the first domain that has a problem
    after collecting all of them."""
    digests, refusals = {}, []
    for domain, ids in wanted.items():
        try:
            digests[domain] = rl.check_development(root, domain, ids)
        except rl.Refused as refusal:
            refusals.append(refusal)
    if refusals:
        raise rl.RoundError('; '.join(str(r) for r in refusals))
    return digests


def unscorable_reason(row):
    """Why harness_scorers.mjs refuses a BixBench row for bixbench-deterministic, in words (the refusal itself is the scorer's)."""
    qs = row['gold']['questions']
    if not any(q['eval_mode'] == 'str_verifier' or (q['eval_mode'] == 'range_verifier' and q.get('range')) for q in qs):
        return 'every question is for a judge'
    if any(q.get('range') and q['range'][0] > q['range'][1] for q in qs):
        return 'a range with lower > upper in the dataset'
    return 'rejected by the scorer\'s row check'


def build(root, wanted, out=None, fetch=False, fix_ranges=False):
    """Build the gold of {domain: [ids]} under `out`. Returns (summary, manifest). Raises RoundError (Refused included) before writing."""
    root = pathlib.Path(root)
    digests = refuse_before_reading(root, wanted)
    ctx = Context(root, fetch, fix_ranges)
    out = pathlib.Path(out) if out else rl.score_dir(root) / 'gold'
    built, summary = {}, {}
    for domain, ids in wanted.items():
        document, _ = rl.load_pool_lists(root, domain)
        items, sources = BUILDERS[domain](ctx, sorted(ids, key=rl.natural_key), document)
        rows = []
        for item in items:
            row = eha.row_from_item(rl.BENCHMARK[domain], item)
            if row is None:
                raise BuildError(f'{domain}: item {item["id"]} is not a {rl.BENCHMARK[domain]} row')
            rows.append(row)
        built[domain] = (items, rows, sources, digests[domain])
        summary[domain] = {'rows': len(rows)}
    # Every row of a code-scored family must pass the lab scorer's own validity check. The one exception is a BixBench capsule whose
    # questions are all for a judge (no str_verifier, no range with a range): the lab refuses it for `bixbench-deterministic`, so it is
    # kept, listed as `unscorableByCode`, and the tables carry it as judge-only.
    jobs = [{'id': f'{d}:{r["id"]}', 'scorer': rl.SCORER[d], 'row': r, 'answer': None} for d, (_, rows, _, _) in built.items() if d not in rl.JUDGED for r in rows]
    rejected = {k for k, v in rl.run_scorer(jobs).items() if v.get('error')}
    bad = sorted(k for k in rejected if not k.startswith('bixbench:'))
    if bad:
        raise BuildError(f'rows rejected by the lab scorers\' validRow: {bad[:8]}')
    unscorable = {d: {k.split(':', 1)[1]: unscorable_reason(next(r for r in built[d][1] if r['id'] == k.split(':', 1)[1]))
                      for k in sorted(rejected) if k.startswith(f'{d}:')} for d in built}
    manifest_path = out / 'manifest.json'
    manifest = {'schema': rl.SCHEMA_GOLD, 'role': 'development', 'domains': {}}
    if manifest_path.is_file():
        previous = rl.read_json(manifest_path)
        if isinstance(previous, dict) and previous.get('schema') == rl.SCHEMA_GOLD:
            manifest['domains'].update(previous.get('domains') or {})
    out.mkdir(parents=True, exist_ok=True)
    out.chmod(0o700)
    for domain, (items, rows, sources, digest) in built.items():
        items_text, rows_text = jsonl(items), json.dumps({'rows': rows}, ensure_ascii=False, indent=1) + '\n'
        rl.write_atomic(out / f'{domain}.items.jsonl', items_text, 0o600)
        rl.write_atomic(out / f'{domain}.rows.json', rows_text, 0o600)
        pool_name, pool = rl.POOL_FILES[domain]
        manifest['domains'][domain] = {
            'pool': f'pools/{pool_name}#{pool}', 'poolDigest': digest, 'role': 'development', 'rows': len(rows), 'ids': [r['id'] for r in rows],
            'sources': ctx.sources([s for s in sources if isinstance(s, str)]) + [s for s in sources if isinstance(s, dict)],
            'unscorableByCode': {i: unscorable[domain][i] for i in sorted(unscorable[domain], key=rl.natural_key)},
            'itemsSha256': hashlib.sha256(items_text.encode('utf-8')).hexdigest(), 'rowsSha256': hashlib.sha256(rows_text.encode('utf-8')).hexdigest()}
    manifest['domains'] = {d: manifest['domains'][d] for d in rl.DOMAINS if d in manifest['domains']}
    rl.write_atomic(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=1) + '\n', 0o600)
    for domain in built:
        if unscorable[domain]:
            summary[domain]['unscorableByCode'] = len(unscorable[domain])
    summary['notes'] = ctx.notes
    return summary, manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--rows', action='append', required=True, help='rows.json {domain: [ids]} (repeatable; merged)')
    parser.add_argument('--domains', help='comma list; default every domain in the rows files')
    parser.add_argument('--bench-root')
    parser.add_argument('--out')
    parser.add_argument('--fix-reversed-ranges', action='store_true',
                        help='BixBench: swap a dataset range whose lower bound is above its upper one (the lab refuses such a row; default: keep it as given)')
    parser.add_argument('--fetch', action='store_true', help='fetch missing judge material (DRB criteria and reference, RCB rubric) from the pinned upstream')
    args = parser.parse_args(argv)
    try:
        root = rl.bench_root(args.bench_root)
        wanted = rl.load_rows_files(args.rows, args.domains.split(',') if args.domains else None)
        summary, manifest = build(root, wanted, args.out, args.fetch, args.fix_reversed_ranges)
    except rl.RoundError as error:
        print(f'build_round_gold: {error}', file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
