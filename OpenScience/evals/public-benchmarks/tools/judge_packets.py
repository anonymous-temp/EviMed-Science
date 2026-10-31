#!/usr/bin/env python3
"""Write judge packets: one directory per item with everything a Claude judge reads, nothing it should not.

  judge_packets.py drb      -> <out>/drb/<id>/{task.txt, criteria.json, target.md, reference.md, meta.json}
  judge_packets.py bixbench -> <out>/bixbench/<id>/{questions.json (question + ideal answer), answer.md, meta.json}
  judge_packets.py rcb      -> <out>/rcb/<id>/{task.txt, target_study/ (copied), report.md, run_files/, meta.json}

  options: --out DIR (default $BENCH_ROOT/judge/packets)   --queue NAME (answers/<NAME>.jsonl, default v1-<bench>)
           --only ID[,ID...]   --repeats N   --modes llm_verifier[,...] (bixbench: only those questions)
           --bix-unsettled (bixbench: only the questions score_bixbench.py leaves to a judge)

The judge sees the system's answer only as "the assistant's answer"; no model, route or cost is in a packet.

Delivery. A run that ended on its own is `complete`. A run that TIMED OUT but had written a report-like file (the driver records
it as result.json `lastReport`, saved under files/) is `at-cap`: the packet carries that file, meta.json says `"delivery":
"at-cap"`, and the judge copies the field into its verdict line. report.py reads both figures: strict (a timeout is 0) and at-cap
(the judged score of what existed at the cap). A run with nothing to read is `none` and its packet holds an empty target.

Repeats. `--repeats N` (N >= 2) writes N independent copies of every packet, <out>/<bench>/p1 … pN/<id>/, for judging the same
report several times. A pass directory holds only the packet: no verdict, no other pass's output, nothing that says it is a repeat of
another (meta.json says `pass`). Large trees (target_study/, run_files/) are symlinks to pass 1's copy. Each pass goes to a separate
judge call, which writes its own verdict file (judge/<bench>.p<k>... — see judge/PROTOCOL.md); report.py aggregates the passes
(mean, SD). BENCH_ROOT (default '.') is the work directory with the data; nothing here is ever written into the repository.
"""
import argparse
import ast
import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(os.environ.get('BENCH_ROOT', '.')).resolve()
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path


def items(name):
    return [json.loads(l) for l in (ROOT / 'items' / f'{name}.jsonl').read_text().splitlines() if l.strip()]


def answers(queue):
    path = ROOT / 'answers' / f'{queue}.jsonl'
    return {json.loads(l)['key']: json.loads(l) for l in path.read_text().splitlines() if l.strip()}


def result_of(a):
    """The driver's result.json of an answers row, or {}."""
    if not a:
        return {}
    try:
        return json.loads((pathlib.Path(a['dir']) / 'result.json').read_text())
    except (OSError, ValueError, KeyError):
        return {}


def at_cap_file(a):
    """The saved lastReport file of a timed-out run (a Path), or None."""
    if not a or a.get('status') != 'timeout':
        return None
    last = result_of(a).get('lastReport') or {}
    if not last.get('saved') or not last.get('path'):
        return None
    f = pathlib.Path(a['dir']) / 'files' / last['path']
    return f if f.exists() else None


def read_report(f):
    """A report file as text: Markdown as it is, Word through pandoc (tables kept)."""
    if f.suffix.lower() == '.docx':
        return subprocess.run(['pandoc', '-t', 'gfm', '--wrap=none', str(f)], capture_output=True, text=True, check=True).stdout
    return f.read_text(errors='replace')


def gold_of(it):
    g = it['gold']
    return g if isinstance(g, dict) else ast.literal_eval(g)


def put_tree(src, dst, link_from):
    """Copy a tree, or link it to the copy already made for pass 1."""
    if link_from is not None:
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        dst.symlink_to((link_from / dst.name).resolve())
    else:
        shutil.copytree(src, dst, dirs_exist_ok=True)


def build_drb(it, a, d, k, link_from):
    gold = gold_of(it)
    (d / 'task.txt').write_text(it['prompt'])
    shutil.copy(gold['criteria'].replace('/bench/data', str(ROOT / 'data')), d / 'criteria.json')
    shutil.copy(gold['reference'].replace('/bench/data', str(ROOT / 'data')), d / 'reference.md')
    # The product delivers a long report as a file (report.md beside a .docx) and a short summary in the reply;
    # the judge reads the delivered Markdown report when there is one, the reply otherwise.
    text, source, delivery = '', 'none', 'none'
    if a and a['status'] == 'succeeded':
        delivery = 'complete'
        run_dir = pathlib.Path(a['dir'])
        result = result_of(a)
        delivered = result.get('presentedFiles') or result.get('outputFiles') or []
        md = [run_dir / 'files' / f for f in delivered if f.endswith('.md') and (run_dir / 'files' / f).exists()]
        docs = [run_dir / 'files' / f for f in delivered if f.endswith('.docx') and (run_dir / 'files' / f).exists()]
        if md:
            best = max(md, key=lambda f: f.stat().st_size)
            text, source = best.read_text(), f'file:{best.name}'
        elif docs:
            best = max(docs, key=lambda f: f.stat().st_size)  # a report delivered only as Word: the judge reads its text
            text, source = read_report(best), f'docx:{best.name}'
        else:
            text, source = a['text'], 'reply'
    elif at_cap_file(a):
        best = at_cap_file(a)
        text, source, delivery = read_report(best), f'at-cap:{best.name}', 'at-cap'
    (d / 'target.md').write_text(text)
    return {'key': it['key'], 'language': it['meta']['language'], 'status': a['status'] if a else 'missing', 'delivery': delivery,
            'target_source': source, 'target_chars': len(text)}


def build_bixbench(it, a, d, k, link_from, modes=None, only_questions=None):
    gold = dict(gold_of(it))
    qs = [q for q in gold['questions'] if (not modes or q['eval_mode'] in modes) and (only_questions is None or q['qid'] in only_questions)]
    gold['questions'] = qs
    (d / 'questions.json').write_text(json.dumps(gold, ensure_ascii=False, indent=1))
    (d / 'answer.md').write_text(a['text'] if a and a['status'] == 'succeeded' else '')
    return {'key': it['key'], 'status': a['status'] if a else 'missing', 'delivery': 'complete' if a and a['status'] == 'succeeded' else 'none',
            'questions': [q['qid'] for q in qs]}


def build_rcb(it, a, d, k, link_from):
    (d / 'task.txt').write_text(it['prompt'])
    src = ROOT / 'data' / 'rcb_judge' / it['id']
    if src.exists():
        put_tree(src, d / 'target_study', link_from)
    run_dir = pathlib.Path(a['dir']) if a else None
    report, delivery = None, 'none'
    if run_dir and a['status'] == 'timeout':
        # What existed when the cap cancelled the run (the driver's lastReport), not whatever report.md the workspace holds.
        report, delivery = at_cap_file(a), 'at-cap'
        if report is None:
            delivery = 'none'
    elif run_dir:
        for cand in [run_dir / 'files' / 'report' / 'report.md', *run_dir.glob('files/**/report.md')]:
            if cand.exists():
                report, delivery = cand, 'complete'
                break
    (d / 'report.md').write_text(read_report(report) if report else (a['text'] if a else ''))
    if run_dir and (run_dir / 'files').exists():
        put_tree(run_dir / 'files', d / 'run_files', link_from)
    return {'key': it['key'], 'status': a['status'] if a else 'missing', 'delivery': delivery, 'report_file': str(report) if report else None}


def bix_unsettled(its, ans):
    """{item key: set of question ids} that score_bixbench.py leaves to a judge (an answered capsule's range/str/llm questions)."""
    import score_bixbench
    out = {}
    for it in its:
        a = ans.get(it['key'])
        text = a['text'] if a and a['status'] == 'succeeded' else ''
        rows = score_bixbench.score(text, gold_of(it))['questions']
        out[it['key']] = {r['qid'] for r in rows if r['verdict'] == 'needs_judge'}
    return out


def write_packets(bench, out=None, queue=None, repeats=1, only=None, modes=None, unsettled=False, root=None):
    """Build the packets; returns the list of written directories. `root` overrides BENCH_ROOT (tests)."""
    global ROOT
    saved_root = ROOT
    if root is not None:
        ROOT = pathlib.Path(root).resolve()
    try:
        out = pathlib.Path(out) if out else ROOT / 'judge' / 'packets'
        names = {'drb': ('drb', 'v1-drb'), 'bixbench': ('bixbench', 'v1-bixbench'), 'rcb': ('researchclawbench', 'v1-rcb')}
        item_file, default_queue = names[bench]
        its = items(item_file)
        if only:
            its = [i for i in its if i['id'] in only]
        ans = answers(queue or default_queue)
        keep_questions = bix_unsettled(its, ans) if bench == 'bixbench' and unsettled else None
        written = []
        for k in range(1, max(1, repeats) + 1):
            base = out / bench / (f'p{k}' if repeats > 1 else '')
            for it in its:
                only_q = keep_questions[it['key']] if keep_questions is not None else None
                if bench == 'bixbench' and (modes or only_q is not None) and not any(
                        (not modes or q['eval_mode'] in modes) and (only_q is None or q['qid'] in only_q) for q in gold_of(it)['questions']):
                    continue  # nothing of this capsule is for the judge
                d = base / it['id']
                d.mkdir(parents=True, exist_ok=True)
                link_from = (out / bench / 'p1' / it['id']) if k > 1 else None
                a = ans.get(it['key'])
                if bench == 'drb':
                    meta = build_drb(it, a, d, k, link_from)
                elif bench == 'bixbench':
                    meta = build_bixbench(it, a, d, k, link_from, modes, only_q)
                else:
                    meta = build_rcb(it, a, d, k, link_from)
                if repeats > 1:
                    meta['pass'] = k
                (d / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False))
                written.append(d)
        return written
    finally:
        ROOT = saved_root


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('bench', choices=['drb', 'bixbench', 'rcb'])
    ap.add_argument('--out')
    ap.add_argument('--queue')
    ap.add_argument('--only')
    ap.add_argument('--repeats', type=int, default=1)
    ap.add_argument('--modes')
    ap.add_argument('--bix-unsettled', action='store_true')
    a = ap.parse_args()
    written = write_packets(a.bench, a.out, a.queue, a.repeats, set(a.only.split(',')) if a.only else None,
                            set(a.modes.split(',')) if a.modes else None, a.bix_unsettled)
    print(a.bench, len(written), 'packets', f'({a.repeats} pass(es))' if a.repeats > 1 else '')


if __name__ == '__main__':
    main()
