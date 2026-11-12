"""Freeze original TrialGPT prompts and exact annotation-to-criterion mapping."""
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path
from upstream import load, PIN

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / '.evimed-local/acceptance'
RUN = BASE / 'vcr-trialgpt-reproduction-20261102'
INPUT = BASE / 'vcr-benchmark-20261029/matching/inputs/trialgpt-all-criteria.json'
SPLIT = BASE / 'vcr-model-comparison-20261102/matching/FROZEN.json'
ASSUMPTION = 'If there is no direct evidence, try to infer from existing evidence, and answer one question: If the criterion is true, is it possible that a good patient note will miss such information? If impossible, then you can assume that the criterion is not true. Otherwise, there is not enough information.'
LABEL_ASSUMPTION = 'Try to use as less "not enough information" as possible because if the note does not mention a medically important fact, you can assume that the fact is not true for the patient.'


def norm(s):
    return ' '.join(s.split())


def preserve_json(path, value):
    text = json.dumps(value, ensure_ascii=False, indent=2)
    if path.exists():
        if path.read_text() != text:
            raise ValueError(f'Frozen preparation differs: {path.name}')
    else:
        path.write_text(text)


def prepare(aligned=False):
    funcs, digest = load(RUN / 'upstream/TrialGPT.py')
    inputs = json.loads(INPUT.read_text())
    retrieved = json.loads((RUN / 'upstream/sigir-retrieved_trials.json').read_text())
    split = json.loads(SPLIT.read_text())
    index = defaultdict(list)
    for patient in retrieved:
        for key in ('0', '1', '2'):
            for trial in patient.get(key, []):
                index[(patient['patient_id'], trial['NCTID'])].append(trial)
    global_index = defaultdict(list)
    for (_, trial_id), trials in index.items():
        global_index[trial_id].extend(trials)
    with (RUN / 'upstream/corpus.jsonl').open() as source:
        corpus = {r['_id']: r['metadata'] for r in map(json.loads, source)}
    grouped = defaultdict(list)
    for row in inputs:
        grouped[(row['patient_id'], row['trial_id'])].append(row)
    requests, mapping = [], []
    for (patient, trial_id), rows in sorted(grouped.items()):
        unique = {json.dumps(t, sort_keys=True): t for t in (index[(patient, trial_id)] or global_index[trial_id] or [corpus[trial_id]])}
        if len(unique) != 1:
            raise ValueError(f'Expected one unique retrieved trial: {patient} {trial_id}: {len(unique)}')
        trial = next(iter(unique.values())).copy()
        if aligned:
            for kind in ('inclusion', 'exclusion'):
                trial[kind + '_criteria'] = '\n\n'.join(dict.fromkeys(r['criterion_text'] for r in rows if r['criterion_type'] == kind and r['criterion_text']))
        notes = {r['note'] for r in rows}
        if len(notes) != 1:
            raise ValueError('Inconsistent patient notes')
        for kind in ('inclusion', 'exclusion'):
            parsed = funcs['parse_criteria'](trial[kind + '_criteria'])
            parts = re.split(r'(?m)^(\d+)\. ', parsed)[1:]
            criteria = {parts[i]: parts[i + 1].strip() for i in range(0, len(parts), 2)}
            cm = {}
            for row in rows:
                if row['criterion_type'] != kind:
                    continue
                matches = [k for k, v in criteria.items() if row['criterion_text'] and norm(v) == norm(row['criterion_text'])]
                entry = {'annotation_id': row['annotation_id'], 'indexes': matches,
                         'status': 'matched' if len(matches) == 1 else ('missing' if not matches else 'ambiguous')}
                mapping.append(entry)
                cm[str(row['annotation_id'])] = entry
            system, user = funcs['get_matching_prompt'](trial, kind, next(iter(notes)))
            assert system.count(ASSUMPTION) == 1 and system.count(LABEL_ASSUMPTION) == 1
            strict = system.replace(ASSUMPTION, 'If the patient note does not provide sufficient information, there is not enough information.').replace(LABEL_ASSUMPTION, 'Do not assume that unmentioned facts are false.')
            requests.append({'id': f'{patient}|{trial_id}|{kind}', 'patient_id': patient, 'trial_id': trial_id,
                             'criterion_type': kind, 'system': system, 'strict_system': strict, 'user': user,
                             'criterion_map': cm, 'expected_indexes': list(criteria), 'criteria': criteria})
    output = RUN / ('aligned' if aligned else 'prepared')
    output.mkdir(parents=True, exist_ok=True)
    preserve_json(output / 'requests.json', requests)
    preserve_json(output / 'mapping.json', mapping)
    manifest = {'mode': 'annotation_aligned' if aligned else 'raw_source',
                'qualification': 'Original prompt and full trial background; criterion units replaced by benchmark annotation text' if aligned else 'Original source criterion segmentation',
                'upstream_commit': PIN, 'trialgpt_sha256': digest,
                'input_sha256': hashlib.sha256(INPUT.read_bytes()).hexdigest(),
                'corpus_sha256': hashlib.sha256((RUN / 'upstream/corpus.jsonl').read_bytes()).hexdigest(),
                'trial_source_policy': 'patient retrieval, then another patient retrieval, then pinned official corpus metadata',
                'retrieval_sha256': hashlib.sha256((RUN / 'upstream/sigir-retrieved_trials.json').read_bytes()).hexdigest(),
                'requests_sha256': hashlib.sha256((output / 'requests.json').read_bytes()).hexdigest(),
                'pairs': len(grouped), 'requests': len(requests), 'annotations': len(mapping),
                'mapping_counts': {s: sum(x['status'] == s for x in mapping) for s in ('matched','missing','ambiguous')},
                'dev_patients': split['dev_patients'], 'evaluation_patients': split['evaluation_patients']}
    preserve_json(output / 'manifest.json', manifest)
    return manifest


def build_requests(arm, mode='annotation_aligned'):
    rows = json.loads((RUN / ('aligned' if mode == 'annotation_aligned' else 'prepared') / 'requests.json').read_text())
    for row in rows:
        row['system'] = row.pop('strict_system') if arm == 'strict' else row['system']
        row.pop('strict_system', None)
    return rows

if __name__ == '__main__':
    print(json.dumps(prepare(aligned=True), indent=2))
