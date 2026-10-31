"""A tiny synthetic work directory for the report / packet / noise tests (never the real data)."""
import json
import pathlib


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows))


def run_dir(root, queue, name, status, files=None, last_report=None, presented=None, answer=''):
    """A driver result folder: result.json, answer.md and files/…; returns the answers/ row for it."""
    d = root / 'results' / queue / name
    d.mkdir(parents=True, exist_ok=True)
    for rel, text in (files or {}).items():
        (d / 'files' / rel).parent.mkdir(parents=True, exist_ok=True)
        (d / 'files' / rel).write_text(text)
    result = {'status': status, 'presentedFiles': presented or [], 'outputFiles': list((files or {}).keys())}
    if last_report is not None:
        result['lastReport'] = last_report
    (d / 'result.json').write_text(json.dumps(result))
    (d / 'answer.md').write_text(answer)
    return {'dir': str(d), 'status': status, 'text': answer}


def make_root(tmp):
    """items + answers for drb (3 tasks: complete, at-cap, timed out with nothing), rcb (2) and bixbench (2 capsules)."""
    root = pathlib.Path(tmp)
    (root / 'data' / 'drb' / 'criteria').mkdir(parents=True)
    (root / 'data' / 'drb' / 'reference').mkdir(parents=True)
    drb_items = []
    for i in ('59', '27', '3'):
        (root / 'data' / 'drb' / 'criteria' / f'{i}.json').write_text(json.dumps({'id': int(i), 'dimension_weight': {'insight': 1.0}, 'criterions': {'insight': [{'criterion': 'c', 'weight': 1.0}]}}))
        (root / 'data' / 'drb' / 'reference' / f'{i}.md').write_text(f'reference {i}')
        drb_items.append({'key': f'drb/{i}', 'id': i, 'prompt': f'task {i}', 'meta': {'language': 'en'},
                          'gold': {'criteria': f'/bench/data/drb/criteria/{i}.json', 'reference': f'/bench/data/drb/reference/{i}.md'}})
    write_jsonl(root / 'items' / 'drb.jsonl', drb_items)
    answers = [
        {'key': 'drb/59', **run_dir(root, 'v1-drb', 'drb__59', 'succeeded', {'report/report.md': '# complete report'}, presented=['report/report.md'], answer='short reply')},
        {'key': 'drb/27', **run_dir(root, 'v1-drb', 'drb__27', 'timeout', {'report/draft.md': '# half a report'},
                                     last_report={'path': 'report/draft.md', 'bytes': 15, 'mtime': '2026-10-31T00:00:00.000Z', 'saved': True})},
        {'key': 'drb/3', **run_dir(root, 'v1-drb', 'drb__3', 'timeout', {}, last_report=None)},
    ]
    write_jsonl(root / 'answers' / 'v1-drb.jsonl', answers)

    rcb_items = [{'key': f'researchclawbench/{i}', 'id': i, 'prompt': f'rcb task {i}'} for i in ('Life_001', 'Life_000')]
    write_jsonl(root / 'items' / 'researchclawbench.jsonl', rcb_items)
    (root / 'data' / 'rcb_judge' / 'Life_001').mkdir(parents=True)
    (root / 'data' / 'rcb_judge' / 'Life_001' / 'rubric.json').write_text('{"items": []}')
    write_jsonl(root / 'answers' / 'v1-rcb.jsonl', [
        {'key': 'researchclawbench/Life_001', **run_dir(root, 'v1-rcb', 'rcb__Life_001', 'succeeded', {'report/report.md': '# rcb report', 'report/images/f.png': 'png'})},
        {'key': 'researchclawbench/Life_000', **run_dir(root, 'v1-rcb', 'rcb__Life_000', 'timeout', {'report/report.md': '# rcb draft'},
                                                         last_report={'path': 'report/report.md', 'bytes': 11, 'mtime': '2026-10-31T00:00:00.000Z', 'saved': True})},
    ])

    def gold(*qs):
        return {'questions': [{'n': n, 'qid': qid, 'question': f'question {qid}', 'ideal': ideal, 'eval_mode': mode, 'range': rng, 'distractors': []}
                              for n, (qid, mode, ideal, rng) in enumerate(qs, 1)]}
    write_jsonl(root / 'items' / 'bixbench.jsonl', [
        {'key': 'bixbench/bix-1', 'id': 'bix-1', 'prompt': 'p', 'gold': gold(('bix-1-q1', 'range_verifier', '(1,2)', [1, 2]), ('bix-1-q2', 'llm_verifier', 'yes', None), ('bix-1-q3', 'str_verifier', '166', None))},
        {'key': 'bixbench/bix-2', 'id': 'bix-2', 'prompt': 'p', 'gold': gold(('bix-2-q1', 'llm_verifier', '0.5', None))},
    ])
    write_jsonl(root / 'answers' / 'v1-bixbench.jsonl', [
        {'key': 'bixbench/bix-1', **run_dir(root, 'v1-bixbench', 'bix-1', 'succeeded', answer='Final answers:\n1. 1.5\n2. around yes\n3. 166 genes\n')},
        {'key': 'bixbench/bix-2', **run_dir(root, 'v1-bixbench', 'bix-2', 'timeout')},
    ])
    return root
