#!/usr/bin/env python3
"""Write judge packets: one directory per item with everything a Claude judge reads, nothing it should not.

  judge_packets.py drb   -> judge/packets/drb/<id>/{task.txt, criteria.json, target.md, reference.md, meta.json}
  judge_packets.py bixbench -> judge/packets/bixbench/<id>/{questions.json (question + ideal answer), answer.md}
  judge_packets.py rcb   -> judge/packets/rcb/<id>/{task.txt, rubric (copied), report.md, figures/}

The judge sees the system's answer only as "the assistant's answer"; no model, route or cost is in a packet.
"""
import json
import pathlib
import shutil
import sys

ROOT = pathlib.Path('/home/coder/evimed-wt/bench')


def items(name):
    return [json.loads(l) for l in (ROOT / 'items' / f'{name}.jsonl').read_text().splitlines() if l.strip()]


def answers(queue):
    return {json.loads(l)['key']: json.loads(l) for l in (ROOT / 'answers' / f'{queue}.jsonl').read_text().splitlines() if l.strip()}


def main():
    bench = sys.argv[1]
    out = ROOT / 'judge' / 'packets' / bench
    out.mkdir(parents=True, exist_ok=True)
    if bench == 'drb':
        ans = answers('v1-drb')
        for it in items('drb'):
            d = out / it['id']; d.mkdir(exist_ok=True)
            gold = it['gold'] if isinstance(it['gold'], dict) else eval(it['gold'])
            (d / 'task.txt').write_text(it['prompt'])
            shutil.copy(gold['criteria'].replace('/bench/data', str(ROOT / 'data')), d / 'criteria.json')
            shutil.copy(gold['reference'].replace('/bench/data', str(ROOT / 'data')), d / 'reference.md')
            a = ans.get(it['key'])
            # The product delivers a long report as a file (report.md beside a .docx) and a short summary in the reply;
            # the judge reads the delivered Markdown report when there is one, the reply otherwise.
            text, source = '', 'none'
            if a and a['status'] == 'succeeded':
                run_dir = pathlib.Path(a['dir'])
                result = json.loads((run_dir / 'result.json').read_text())
                delivered = result.get('presentedFiles') or result.get('outputFiles') or []
                md = [run_dir / 'files' / f for f in delivered if f.endswith('.md') and (run_dir / 'files' / f).exists()]
                docs = [run_dir / 'files' / f for f in delivered if f.endswith('.docx') and (run_dir / 'files' / f).exists()]
                if md:
                    best = max(md, key=lambda f: f.stat().st_size)
                    text, source = best.read_text(), f'file:{best.name}'
                elif docs:
                    # A report delivered only as Word: the judge reads its text (pandoc to Markdown, tables kept).
                    best = max(docs, key=lambda f: f.stat().st_size)
                    import subprocess
                    text = subprocess.run(['pandoc', '-t', 'gfm', '--wrap=none', str(best)], capture_output=True, text=True, check=True).stdout
                    text, source = text, f'docx:{best.name}'
                else:
                    text, source = a['text'], 'reply'
            (d / 'target.md').write_text(text)
            (d / 'meta.json').write_text(json.dumps({'key': it['key'], 'language': it['meta']['language'], 'status': a['status'] if a else 'missing', 'target_source': source, 'target_chars': len(text)}))
    elif bench == 'bixbench':
        ans = answers('v1-bixbench')
        for it in items('bixbench'):
            d = out / it['id']; d.mkdir(exist_ok=True)
            (d / 'questions.json').write_text(json.dumps(it['gold'], ensure_ascii=False, indent=1))
            a = ans.get(it['key'])
            (d / 'answer.md').write_text(a['text'] if a and a['status'] == 'succeeded' else '')
            (d / 'meta.json').write_text(json.dumps({'key': it['key'], 'status': a['status'] if a else 'missing'}))
    elif bench == 'rcb':
        ans = answers('v1-rcb')
        for it in items('researchclawbench'):
            d = out / it['id']; d.mkdir(exist_ok=True)
            (d / 'task.txt').write_text(it['prompt'])
            src = ROOT / 'data' / 'rcb_judge' / it['id']
            if src.exists():
                shutil.copytree(src, d / 'target_study', dirs_exist_ok=True)
            a = ans.get(it['key'])
            run_dir = pathlib.Path(a['dir']) if a else None
            report = None
            if run_dir:
                for cand in [run_dir / 'files' / 'report' / 'report.md', *run_dir.glob('files/**/report.md')]:
                    if cand.exists():
                        report = cand; break
            (d / 'report.md').write_text(report.read_text() if report else (a['text'] if a else ''))
            if run_dir and (run_dir / 'files').exists():
                shutil.copytree(run_dir / 'files', d / 'run_files', dirs_exist_ok=True)
            (d / 'meta.json').write_text(json.dumps({'key': it['key'], 'status': a['status'] if a else 'missing', 'report_file': str(report) if report else None}))
    print(bench, len(list(out.iterdir())), 'packets')


if __name__ == '__main__':
    main()
