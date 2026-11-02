#!/usr/bin/env python3
"""Judging packets for a round's runs: what a Claude judge reads, blinded, and (apart) the key that maps a verdict back to an arm.

  judged_packets_round.py --arm base=s1 [--arm cand=s2 ...] --rows rsi/screen/rows.json [--rows rsi/screen-bix/rows.json]
      [--benchmarks drb,rcb,bixbench,mbc] [--drb-form auto|pairwise|absolute|both] [--passes N] [--seed N] [--at-cap]
      [--name NAME] [--out DIR] [--inbox DIR ...] [--requests FILE ...] [--cache DIR] [--bench-root DIR]

Nothing here calls a model, a judge or a paid API. The protocol the judge follows is judge/PROTOCOL.md and the per-benchmark file named
in manifest.json (drb-pairwise.md, drb.md, rcb.md, bixbench.md, mbc.md); the formats are those of tools/drb_pairwise.py and
tools/judge_packets.py. Rows must be development rows (build_round_gold.py's refusal applies); gold, rubrics and references come from
build_round_gold.py's output.

Layout under <out> (default $BENCH_ROOT/rsi/score/packets/<name>/):
  judge/      what judges are given, by path, one packet to one judge call that has seen no verdict of the same packet. Arm names, order and
              rids appear nowhere in it; packet ids are opaque (sha256 of seed and rid).
    drb-pair-<k>/<task>/pass<m>/{task.txt, criteria.json, report_1.md, report_2.md, meta.json}   pairwise, report order swapped in couples
    drb-abs/<id>/pass<m>/{task.txt, criteria.json, target.md, reference.md, meta.json}            one report against the reference (RACE)
    rcb/<id>/pass<m>/{task.txt, target_study/, report.md, run_files/, meta.json}                  rubric scoring against the target study
    bixbench/<id>/pass<m>/{questions.json, answer.md, meta.json}                                  only the questions code leaves to a judge
    mbc.needs_judge.jsonl                                                                         extra: the cases the code rules cannot settle
  operator/   never given to a judge: keys.json (packet id -> arm, rid, row, repeat), order/drb-pair-<k>/order.json (+ task links, for
              `drb_pairwise.py aggregate`), pair-map/drb-pair-<k>.json (for export_harness_arms.py --pair-map), manifest.json (what was
              written, what was skipped and why, the verdict line of each benchmark, the sha256 of keys.json).

Pairwise needs two arms: the reference arm (the first, or --ref) is called `baseline` in order.json, each other arm is compared with it
in its own drb-pair-<k>, repeat r against repeat r. With one arm, `auto` writes the absolute packets instead. A pairwise or absolute packet
exists only for a run that SUCCEEDED (a run that did not deliver scores 0 in the lab and takes no verdict); a pair whose candidate
succeeded and whose reference did not is written with an empty reference report. `--at-cap` adds packets for timed-out runs that left a
saved draft (`delivery: at-cap` in meta.json, listed apart in the manifest and not for the lab). Infrastructure and missing runs are
skipped and listed, never written as empty reports.

Passes: pairwise default 6 (three swapped couples), absolute 3 (the registered 3 repeats; a single pass for mbc). A pass directory holds the
packet and nothing else; large trees of later passes link to pass 1.

Python 3.10 compatible; run with `python3 -I`; needs node >= 22 (the scorers that tell which questions a judge must settle) and pandoc for
a report delivered only as .docx.
"""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path
import drb_pairwise as dp  # noqa: E402
import round_lib as rl  # noqa: E402
import score_round as sr  # noqa: E402

DEFAULT_SEED = 20261028
RUN_FILE_CAP = 2 * 1024 * 1024       # one run file copied into a packet
RUN_FILES_TOTAL_CAP = 24 * 1024 * 1024  # all run files of one packet
VERDICT_LINES = {
    'drb-pair': {'protocol': 'judge/drb-pairwise.md', 'line': '{"key": "drb-pair/<task>/p<k>", "scores": {dimension: [{"idx": i, "pref": -3..3}]}, "notes": ...}',
                 'next': 'drb_pairwise.py aggregate --order operator/order/drb-pair-<k>/order.json --verdicts ...'},
    'drb-abs': {'protocol': 'judge/drb.md', 'line': '{"key": <meta.key>, "race": float, "target_total", "reference_total", "dims", "criteria_scored", "notes"}',
                'next': 'export_harness_arms.py --dialect race (one file per pass: <name>.p<k>.jsonl)'},
    'rcb': {'protocol': 'judge/rcb.md', 'line': '{"key": <meta.key>, "score": 0..100, "items": [{"id","weight","score","why"}], "notes", "delivery", "pass"}',
            'next': 'export_harness_arms.py --dialect percent'},
    'bixbench': {'protocol': 'judge/bixbench.md', 'line': '{"key": "<meta.key>#<question id>", "capsule", "question_id", "verdict": correct|incorrect, "assistant", "ideal", "rationale"}',
                 'next': 'counted with the code verdicts of score_round.py: correct = code correct + judge correct'},
    'mbc': {'protocol': 'judge/mbc.md', 'line': '{"key": ..., "verdict": correct|incorrect, "rationale"}', 'next': 'counted with the code verdicts'},
}


class PacketError(rl.RoundError):
    pass


def opaque(seed, bench, rid):
    return hashlib.sha256(f'{seed}|{bench}|{rid}'.encode('utf-8')).hexdigest()[:10]


def write_text(path, text):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def link_or_copy(src, dst, link):
    """Large trees of passes 2.. link to the copy made for pass 1 (judge_packets.py's rule)."""
    dst = pathlib.Path(dst)
    if link is not None:
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        dst.symlink_to(os.path.relpath(pathlib.Path(link).resolve(), dst.parent.resolve()))  # relative: the packet directory can be moved
    elif pathlib.Path(src).is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        shutil.copy(src, dst)


# ---------------------------------------------------------------------------------------------------------------- staging

def stage(record, stage_root):
    """Unpack what a judge needs of a run (files/, result.json, answer.md) into stage_root/<rid>/; returns that folder."""
    folder = pathlib.Path(stage_root) / record.rid
    if not folder.exists():
        rl.extract_members(record.tgz, record.rid, folder, lambda rel: rel in rl.LIGHT_FILES or rel.startswith('files/'))
    return folder


def delivery_of(record, at_cap):
    """'complete' for a run that succeeded, 'at-cap' for a timeout with a saved draft when asked for, else None (no packet)."""
    status = record.facts['status']
    if status == 'succeeded':
        return 'complete'
    draft = record.facts['draft']
    if at_cap and status == 'timeout' and draft and draft['saved']:
        return 'at-cap'
    return None


def usable(records, at_cap):
    """Split the runs of one arm/domain into (packet candidates, skipped [(rid, why)]). Only ok runs have packets."""
    ready, skipped = [], []
    for record in records:
        if record.state == 'missing':
            skipped.append((record.rid, 'missing'))
        elif record.state != 'ok':
            skipped.append((record.rid, f'{record.state}: {record.reason}'))
        elif delivery_of(record, at_cap) is None:
            skipped.append((record.rid, f'not delivered ({record.facts["status"]})'))
        elif record.tgz is None:
            skipped.append((record.rid, 'the bundle has left the inbox and its files are not at hand'))
        else:
            ready.append(record)
    return ready, skipped


def prompt_of(requests, record, fallback):
    item = (requests.get(record.rid) or {}).get('item') or {}
    return item.get('prompt') or fallback


# ---------------------------------------------------------------------------------------------------------------------- drb

def drb_packets(ctx):
    root, judge, operator, records, arms, ref = ctx['root'], ctx['judge'], ctx['operator'], ctx['records'], ctx['arms'], ctx['reference']
    wanted, form, items = ctx['wanted'].get('drb', []), ctx['drb_form'], ctx['items'].get('drb', {})
    if not wanted:
        return
    pairwise = len(arms) > 1 and form in ('auto', 'pairwise', 'both')
    absolute = form in ('absolute', 'both') or (form == 'auto' and len(arms) == 1)
    if form in ('pairwise', 'both') and len(arms) < 2:
        raise PacketError('--drb-form pairwise needs two arms')
    criteria_of = lambda row: root / 'rsi' / 'score' / items[row]['gold']['criteria']  # noqa: E731
    by = {(r.arm, r.row, r.repeat): r for r in records if r.domain == 'drb'}
    if pairwise:
        for k, (name, _) in enumerate([a for a in arms if a[0] != ref], 1):
            pair_dir = judge / f'drb-pair-{k}'
            pair_map, skipped, tasks = {}, [], 0
            for row in wanted:
                for repeat in range(ctx['repeats']):
                    cand, base = by.get((name, row, repeat)), by.get((ref, row, repeat))
                    label = row if ctx['repeats'] == 1 else f'{row}r{repeat}'
                    if cand is None or base is None:
                        continue
                    ready_c, skip_c = usable([cand], ctx['at_cap'])
                    if not ready_c:
                        skipped += [(rid, f'{label}: {why}') for rid, why in skip_c]
                        continue
                    if base.state != 'ok' or base.tgz is None:  # the reference run is infrastructure or missing: no comparison, nothing written as empty
                        skipped.append((base.rid, f'{label}: reference {base.state if base.state != "ok" else "bundle not at hand"}'))
                        continue
                    if delivery_of(cand, ctx['at_cap']) == 'at-cap':
                        ctx['atCap'].append(cand.rid)
                    try:
                        dp.build_packets(label, stage(base, ctx['stage']), stage(cand, ctx['stage']), 'baseline', name, ctx['passes_pair'], ctx['seed'],
                                         pair_dir, criteria_of(row))
                    except dp.PairwiseError as error:
                        skipped.append((cand.rid, f'{label}: {error}'))
                        continue
                    pair_map[label] = {'row': row, 'repeat': repeat, 'arm': name}
                    ctx['keys'].setdefault(f'drb-pair-{k}', {})[label] = {'arm': name, 'reference': ref, 'rid': cand.rid, 'referenceRid': base.rid, 'row': row, 'repeat': repeat}
                    tasks += 1
            order_file = pair_dir / 'order.json'
            if order_file.exists():
                target = operator / 'order' / f'drb-pair-{k}'
                target.mkdir(parents=True, exist_ok=True)
                shutil.move(str(order_file), str(target / 'order.json'))
                for label in pair_map:
                    link = target / label
                    if link.is_symlink() or link.exists():
                        link.unlink()
                    link.symlink_to(os.path.relpath((pair_dir / label).resolve(), target.resolve()))
                rl.write_atomic(operator / 'pair-map' / f'drb-pair-{k}.json', json.dumps(pair_map, indent=1, sort_keys=True) + '\n')
            ctx['summary'].append({'bench': 'drb-pair', 'packet': f'drb-pair-{k}', 'tasks': tasks, 'passes': ctx['passes_pair'], 'skipped': skipped})
    if absolute:
        tasks, skipped = 0, []
        for name, _ in arms:
            ready, skip = usable([r for r in records if r.arm == name and r.domain == 'drb'], ctx['at_cap'])
            skipped += skip
            for record in ready:
                folder = stage(record, ctx['stage'])
                text, _source = dp.read_report(folder)
                criteria_text = criteria_of(record.row).read_text(encoding='utf-8')
                reference = (root / 'rsi' / 'score' / items[record.row]['gold']['reference']).read_text(encoding='utf-8')
                key = f'drb-abs/{opaque(ctx["seed"], "drb-abs", record.rid)}'
                delivery = delivery_of(record, ctx['at_cap'])
                if delivery == 'at-cap':
                    ctx['atCap'].append(record.rid)
                prompt = prompt_of(ctx['requests'], record, json.loads(criteria_text)['prompt'])
                for m in range(1, ctx['passes_abs'] + 1):
                    d = judge / key / f'pass{m}'
                    write_text(d / 'task.txt', prompt)
                    write_text(d / 'criteria.json', criteria_text)
                    write_text(d / 'target.md', text)
                    write_text(d / 'reference.md', reference)
                    write_text(d / 'meta.json', json.dumps({'key': key, 'pass': m, 'delivery': delivery, 'language': (items[record.row].get('meta') or {}).get('language'),
                                                           'target_chars': len(text)}))
                ctx['keys'][key] = {'bench': 'drb', 'form': 'absolute', 'arm': record.arm, 'rid': record.rid, 'row': record.row, 'repeat': record.repeat, 'delivery': delivery}
                tasks += 1
        ctx['summary'].append({'bench': 'drb-abs', 'packet': 'drb-abs', 'tasks': tasks, 'passes': ctx['passes_abs'], 'skipped': skipped})


# ---------------------------------------------------------------------------------------------------------------------- rcb

def rcb_report(folder, record):
    """(text, delivery source) of the run's research report: report/report.md, any report.md, else the saved draft, else the reply."""
    files = folder / 'files'
    candidates = [files / 'report' / 'report.md', *sorted(files.rglob('report.md'))] if files.is_dir() else []
    last = (record.result.get('lastReport') or {}).get('path')
    if last and files.is_dir():
        candidates.append(files / last)
    for candidate in candidates:
        if candidate.is_file():
            if candidate.suffix.lower() == '.docx':
                return dp.pandoc_text(candidate), candidate.name
            return candidate.read_text(encoding='utf-8', errors='replace'), candidate.name
    return (record.answer or ''), 'reply'


def copy_run_files(files, dest):
    """Figures and code a judge may open: files of at most RUN_FILE_CAP, RUN_FILES_TOTAL_CAP in all, smallest first."""
    total, kept, dropped = 0, 0, 0
    if not files.is_dir():
        return kept, dropped
    # The figures of the report come first: a rubric image item is judged on them.
    for path in sorted((p for p in files.rglob('*') if p.is_file()), key=lambda p: (not p.relative_to(files).parts[0] == 'report', p.stat().st_size, str(p))):
        size = path.stat().st_size
        if size > RUN_FILE_CAP or total + size > RUN_FILES_TOTAL_CAP:
            dropped += 1
            continue
        target = dest / path.relative_to(files)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(path, target)
        total += size
        kept += 1
    return kept, dropped


def rcb_packets(ctx):
    root, judge, records, items = ctx['root'], ctx['judge'], ctx['records'], ctx['items'].get('rcb', {})
    if not ctx['wanted'].get('rcb'):
        return
    tasks, skipped = 0, []
    for name, _ in ctx['arms']:
        ready, skip = usable([r for r in records if r.arm == name and r.domain == 'rcb'], ctx['at_cap'])
        skipped += skip
        for record in ready:
            folder = stage(record, ctx['stage'])
            text, source = rcb_report(folder, record)
            key = f'rcb/{opaque(ctx["seed"], "rcb", record.rid)}'
            delivery = delivery_of(record, ctx['at_cap'])
            if delivery == 'at-cap':
                ctx['atCap'].append(record.rid)
            gold = items[record.row]['gold']
            prompt = prompt_of(ctx['requests'], record, gold['task'])
            study = root / 'rsi' / 'score' / pathlib.Path(gold['rubric']).parent
            dropped_in_bundle = record.lane.get('dropped') or []
            for m in range(1, ctx['passes_abs'] + 1):
                d = judge / key / f'pass{m}'
                d.mkdir(parents=True, exist_ok=True)
                link = judge / key / 'pass1' if m > 1 else None
                write_text(d / 'task.txt', prompt)
                write_text(d / 'report.md', text)
                if m == 1:
                    shutil.copytree(study, d / 'target_study', dirs_exist_ok=True)
                    (d / 'run_files').mkdir(parents=True, exist_ok=True)
                    copy_run_files(folder / 'files', d / 'run_files')
                else:
                    link_or_copy(None, d / 'target_study', link / 'target_study')
                    link_or_copy(None, d / 'run_files', link / 'run_files')
                meta = {'key': key, 'pass': m, 'delivery': delivery, 'report_source': source, 'report_chars': len(text)}
                if dropped_in_bundle:
                    meta['bundle_dropped_files'] = len(dropped_in_bundle)
                write_text(d / 'meta.json', json.dumps(meta))
            ctx['keys'][key] = {'bench': 'rcb', 'form': 'absolute', 'arm': record.arm, 'rid': record.rid, 'row': record.row, 'repeat': record.repeat, 'delivery': delivery,
                                'bundleDropped': [x.get('path') for x in dropped_in_bundle]}
            tasks += 1
    ctx['summary'].append({'bench': 'rcb', 'packet': 'rcb', 'tasks': tasks, 'passes': ctx['passes_abs'], 'skipped': skipped})


# ---------------------------------------------------------------------------------------------------------------------- bixbench, mbc

def bix_packets(ctx):
    judge, records, items = ctx['judge'], ctx['records'], ctx['items'].get('bixbench', {})
    if not ctx['wanted'].get('bixbench'):
        return
    tasks, questions, skipped = 0, 0, []
    for name, _ in ctx['arms']:
        mine = [r for r in records if r.arm == name and r.domain == 'bixbench']
        for record in mine:
            if record.state != 'ok':
                skipped.append((record.rid, 'missing' if record.state == 'missing' else f'{record.state}: {record.reason}'))
            elif record.facts['status'] != 'succeeded':
                skipped.append((record.rid, f'not delivered ({record.facts["status"]})'))
        for record in (r for r in mine if r.state == 'ok' and r.facts['status'] == 'succeeded'):
            verdicts = {q['qid']: q for q in (record.detail or {}).get('questions', [])}
            gold = dict(items[record.row]['gold'])
            judged = [q for q in gold['questions'] if verdicts.get(q['qid'], {}).get('verdict') == 'needs_judge']
            if not judged:
                continue
            gold['questions'] = judged
            key = f'bixbench/{opaque(ctx["seed"], "bixbench", record.rid)}'
            for m in range(1, ctx['passes_abs'] + 1):
                d = judge / key / f'pass{m}'
                write_text(d / 'questions.json', json.dumps(gold, ensure_ascii=False, indent=1))
                write_text(d / 'answer.md', record.answer or '')
                write_text(d / 'meta.json', json.dumps({'key': key, 'pass': m, 'delivery': 'complete', 'questions': [q['qid'] for q in judged]}))
            ctx['keys'][key] = {'bench': 'bixbench', 'form': 'absolute', 'arm': record.arm, 'rid': record.rid, 'row': record.row, 'repeat': record.repeat,
                                'questions': {q['qid']: verdicts[q['qid']]['evalMode'] for q in judged}}
            tasks += 1
            questions += len(judged)
    ctx['summary'].append({'bench': 'bixbench', 'packet': 'bixbench', 'tasks': tasks, 'questions': questions, 'passes': ctx['passes_abs'], 'skipped': skipped})


def mbc_lines(ctx):
    items = ctx['items'].get('mbc', {})
    if not ctx['wanted'].get('mbc'):
        return
    lines, skipped = [], []
    for record in ctx['records']:
        if record.domain != 'mbc' or record.state != 'ok' or record.facts['status'] != 'succeeded':
            continue
        detail = record.detail or {}
        if detail.get('verdict') != 'needs_judge':
            continue
        key = f'mbc/{opaque(ctx["seed"], "mbc", record.rid)}'
        gold = items[record.row]['gold']
        lines.append({'key': key, 'question': prompt_of(ctx['requests'], record, ''), 'gold': gold['answer'], 'extracted': detail.get('extracted'),
                      'answer_tail': (record.answer or '')[-600:]})
        ctx['keys'][key] = {'bench': 'mbc', 'form': 'absolute', 'arm': record.arm, 'rid': record.rid, 'row': record.row, 'repeat': record.repeat}
    write_text(ctx['judge'] / 'mbc.needs_judge.jsonl', ''.join(json.dumps(l, ensure_ascii=False) + '\n' for l in lines))
    ctx['summary'].append({'bench': 'mbc', 'packet': 'mbc.needs_judge.jsonl', 'tasks': len(lines), 'passes': 1, 'skipped': skipped})


# ---------------------------------------------------------------------------------------------------------------------- main

def build(args):
    root = rl.bench_root(args.bench_root)
    arms = sr.parse_arms(args.arm)
    if not arms:
        raise rl.RoundError('give at least one --arm NAME=PREFIX')
    reference = args.ref or arms[0][0]
    if reference not in [a[0] for a in arms]:
        raise rl.RoundError(f'--ref {reference} is not one of the arms')
    benches = args.benchmarks.split(',')
    if args.passes and args.passes % 2 and 'drb' in benches and len(arms) > 1 and args.drb_form in ('auto', 'pairwise', 'both'):
        raise rl.RoundError('--passes must be even for pairwise packets (every pair is judged in both orders)')
    unknown = [b for b in benches if b not in ('drb', 'rcb', 'bixbench', 'mbc')]
    if unknown:
        raise rl.RoundError(f'unknown benchmark(s) {unknown}; judged packets exist for drb, rcb, bixbench, mbc')
    wanted = rl.load_rows_files(args.rows, benches)
    for domain, ids in wanted.items():
        rl.check_development(root, domain, ids)
    gold = {d: rl.load_gold_rows(root, d, ids) for d, ids in wanted.items()}
    items = {d: rl.load_gold_items(root, d) for d in wanted}
    manifest = rl.read_json(rl.score_dir(root) / 'gold' / 'manifest.json') or {}
    inboxes = [pathlib.Path(p) for p in (args.inbox or rl.default_inboxes())]
    request_files = args.requests if args.requests is not None else sorted(str(p) for p in (root / 'rsi').glob('*/requests.jsonl'))
    requests = rl.load_requests(request_files)
    cache = pathlib.Path(args.cache) if args.cache else sr.scratch_runs()
    cache.mkdir(parents=True, exist_ok=True)
    sr_args = argparse.Namespace(repeats=args.repeats, infrastructure_code=args.infrastructure_code)
    records = sr.collect(arms, wanted, gold, items, sr_args, requests, inboxes, cache, manifest)
    name = args.name or '+'.join(a[0] for a in arms)
    out = pathlib.Path(args.out) if args.out else rl.score_dir(root) / 'packets' / name
    if out.exists() and any(out.iterdir()):
        if not args.replace:
            raise rl.RoundError(f'{out} is not empty; packets of another run must not mix (use --out, or --replace to rebuild it)')
        shutil.rmtree(out)
    judge, operator = out / 'judge', out / 'operator'
    stage_root = pathlib.Path(tempfile.mkdtemp(prefix='judged-stage-', dir=cache.parent))  # our own scratch, removed below
    ctx = {'root': root, 'judge': judge, 'operator': operator, 'records': records, 'arms': arms, 'reference': reference, 'wanted': wanted, 'items': items,
           'requests': requests, 'repeats': args.repeats, 'seed': args.seed, 'drb_form': args.drb_form, 'at_cap': args.at_cap, 'stage': stage_root,
           'passes_pair': args.passes if args.passes else 6, 'passes_abs': args.passes if args.passes else 3, 'keys': {}, 'summary': [], 'atCap': []}
    try:
        judge.mkdir(parents=True, exist_ok=True)
        operator.mkdir(parents=True, exist_ok=True)
        if 'drb' in benches:
            drb_packets(ctx)
        if 'rcb' in benches:
            rcb_packets(ctx)
        if 'bixbench' in benches:
            bix_packets(ctx)
        if 'mbc' in benches:
            mbc_lines(ctx)
    finally:
        shutil.rmtree(stage_root, ignore_errors=True)
    keys_text = json.dumps(ctx['keys'], indent=1, sort_keys=True) + '\n'
    rl.write_atomic(operator / 'keys.json', keys_text, 0o600)
    summary = [{**s, 'skipped': [{'rid': rid, 'why': why} for rid, why in s['skipped']]} for s in ctx['summary']]
    report = {'schema': 'rsi-round-packets/1', 'role': 'development', 'name': name, 'arms': dict(arms), 'reference': reference, 'seed': args.seed,
              'repeats': args.repeats, 'atCapIncluded': args.at_cap, 'atCapRids': sorted(ctx['atCap']), 'keysSha256': hashlib.sha256(keys_text.encode('utf-8')).hexdigest(),
              'protocols': VERDICT_LINES, 'packets': summary}
    rl.write_atomic(operator / 'manifest.json', json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    return out, report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--arm', action='append', required=True, help='NAME=PREFIX (repeatable; the first is the reference)')
    parser.add_argument('--rows', action='append', required=True, help='rows.json {domain: [ids]} (repeatable; merged)')
    parser.add_argument('--benchmarks', default='drb,rcb,bixbench', help='comma list of drb, rcb, bixbench, mbc (default drb,rcb,bixbench)')
    parser.add_argument('--drb-form', choices=['auto', 'pairwise', 'absolute', 'both'], default='auto')
    parser.add_argument('--ref', help='reference arm of the pairs (default: the first arm)')
    parser.add_argument('--passes', type=int, help='judge passes per packet (default 6 pairwise, 3 absolute)')
    parser.add_argument('--repeats', type=int, default=1, help='runs per arm and row (the rid suffix r0..r<n-1>)')
    parser.add_argument('--seed', type=int, default=DEFAULT_SEED)
    parser.add_argument('--at-cap', action='store_true', help='also write packets for timed-out runs that left a saved draft (marked at-cap; not for the lab)')
    parser.add_argument('--name')
    parser.add_argument('--replace', action='store_true', help='rebuild an existing output directory (it is removed first)')
    parser.add_argument('--out')
    parser.add_argument('--inbox', action='append')
    parser.add_argument('--requests', action='append')
    parser.add_argument('--cache')
    parser.add_argument('--infrastructure-code', action='append', default=[])
    parser.add_argument('--bench-root')
    args = parser.parse_args(argv)
    if args.repeats < 1 or (args.passes is not None and args.passes < 1):
        print('judged_packets_round: --repeats and --passes are at least 1', file=sys.stderr)
        return 2
    try:
        out, report = build(args)
    except (rl.RoundError, dp.PairwiseError) as error:
        print(f'judged_packets_round: {error}', file=sys.stderr)
        return 2
    for p in report['packets']:
        print(f'{p["packet"]}: {p["tasks"]} packet(s) x {p["passes"]} pass(es), {len(p["skipped"])} skipped')
    print(f'out: {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
