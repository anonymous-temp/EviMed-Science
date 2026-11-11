#!/usr/bin/env python3
"""Freeze a pre-score, capacity-screened stratified pilot and verify its data pins."""
import argparse
import hashlib
import json
import pathlib
import re
import tomllib
from collections import defaultdict
import yaml

PINS = {'sb': 'f860ecf02ef53412a030f8661c83d644b739ff01',
        'slb': '726e1f79b96b0cb3d729d0e55a1c847e0b5353ae'}
CATEGORIES = {
    'Software Engineering': ['python-scala-translation', 'nlp-paper-reproduction', 'dependency-vulnerability-check', 'github-repo-analytics', 'fix-security-bug'],
    'Information Retrieval': ['enterprise-information-search', 'travel-planning'],
    'Productivity Tools': ['schedule-planning', 'offer-letter-generator', 'court-form-filling'],
    'Data & Analytics': ['earthquake-plate-calculation', 'financial-analysis', 'weighted-gdp-calculation', 'dbscan-parameter-tuning', 'stock-data-visualization'],
    'Content & Creative': ['anthropic-poster-design', 'chinese-poem-generator', 'video-object-counting'],
    'Utilities & Other': ['organize-messy-files', 'temperature-simulation'],
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def order(name, seed):
    return hashlib.sha256(f'{seed}:{name}'.encode()).hexdigest()


def feasibility(path):
    docker = (path / 'environment/Dockerfile').read_text()
    reasons = []
    if re.search(r'torch|tensorflow|kokoro|SpeechMOS|base-builder|syzkaller|cuda|OTP_VERSION|make -j|mvn |git lfs', docker, re.I):
        reasons.append('large ML/compiler/download dependency')
    if not re.search(r'FROM (?:--platform=\S+ )?(ubuntu:|python:|node:)', docker, re.I):
        reasons.append('specialized base image')
    if (path / 'task.toml').exists():
        cfg = tomllib.loads((path / 'task.toml').read_text())
        if cfg.get('environment', {}).get('required_env'):
            reasons.append('external credentials required')
    return reasons


def select(data, seed):
    groups = defaultdict(list)
    excluded = []
    for path in sorted((data / 'skillsbench/tasks').iterdir()):
        if not (path / 'task.md').exists():
            continue
        cfg = yaml.safe_load((path / 'task.md').read_text().split('---', 2)[1])
        reasons = feasibility(path)
        if reasons:
            excluded.append({'bench': 'sb', 'id': path.name, 'reasons': reasons})
        else:
            groups[cfg['metadata']['category']].append(path)
    tasks, practice = [], []
    counts = {}
    for category, paths in sorted(groups.items()):
        paths.sort(key=lambda p: order(p.name, seed))
        counts[category] = {'eligible': len(paths), 'test': 1, 'practice': min(1, len(paths) - 1)}
        for phase, path in [('test', paths[0])] + ([('practice', paths[1])] if len(paths) > 1 else []):
            item = {'bench': 'sb', 'id': path.name, 'category': category, 'path': str(path), 'family': path.name}
            (tasks if phase == 'test' else practice).append(item)
    slb_counts = {}
    for category, families in sorted(CATEGORIES.items()):
        eligible = []
        for family in families:
            variants = sorted((data / 'skilllearnbench/tasks' / family).glob('*/instruction.md'))
            reasons = feasibility(variants[0].parent)
            if reasons:
                excluded.append({'bench': 'slb', 'id': family, 'reasons': reasons})
            else:
                eligible.append((family, variants))
        eligible.sort(key=lambda fv: order(fv[0], seed))
        if not eligible:
            slb_counts[category] = {'eligibleFamilies': 0, 'test': 0, 'practice': 0}
            continue
        family, variants = eligible[0]
        # Variant 1 is the authors' prescribed learning input. Never read test verifiers during practice.
        variants.sort(key=lambda p: int(p.parent.name.rsplit('-', 1)[1]))
        train = variants[0]
        remaining = sorted(variants[1:], key=lambda p: order(p.parent.name, seed))[:2]
        for phase, paths in [('practice', [train]), ('test', remaining)]:
            for path in paths:
                item = {'bench': 'slb', 'id': path.parent.name, 'category': category,
                        'path': str(path.parent), 'family': family}
                (tasks if phase == 'test' else practice).append(item)
        slb_counts[category] = {'eligibleFamilies': len(eligible), 'family': family, 'practice': 1, 'test': len(remaining)}
    return {'schema': 1, 'seed': seed, 'pins': PINS, 'tasks': tasks, 'practice': practice,
            'perDomain': {'sb': counts, 'slb': slb_counts}, 'excluded': excluded,
            'samplingRule': 'Before scores: screen Dockerfile for large ML/compiler/download dependencies, specialized base images and task-required credentials; rank eligible names by SHA256(seed + colon + name). SkillsBench: first per domain test, second practice. SkillLearnBench: first family per README category, variant 1 practice, first two remaining variants by the same hash test. This is a feasibility-conditioned pilot, not a representative full-benchmark estimate.'}


def verify(manifest, sources):
    entries = json.loads(sources.read_text())['learning']
    checks = []
    for task in manifest['tasks'] + manifest['practice']:
        name = 'skillsbench' if task['bench'] == 'sb' else 'skilllearnbench'
        root = pathlib.Path(task['path'])
        base = root.parents[1] if task['bench'] == 'sb' else root.parents[2]
        prefix = root.relative_to(base).as_posix() + '/'
        files = [f for f in entries[name]['files'] if f['path'].startswith(prefix)]
        for entry in files:
            path = base / entry['path']
            content = path.read_bytes()
            if len(content) != entry['bytes']:
                raise ValueError(f'Pin size mismatch: {path}')
            actual = hashlib.sha256(content).hexdigest() if entry.get('sha256') else hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()
            if actual != (entry.get('sha256') or entry['gitBlobSha1']):
                raise ValueError(f'Pin digest mismatch: {path}')
        task['pinnedFiles'] = len(files)
        verifier = root / ('verifier' if task['bench'] == 'sb' else 'tests')
        task['verifierSha256'] = {p.relative_to(verifier).as_posix(): digest(p) for p in sorted(verifier.rglob('*')) if p.is_file()}
        checks.append({'id': task['id'], 'files': len(files)})
    return checks


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--data', type=pathlib.Path, default=pathlib.Path('/srv/evimed/data/memdata-data/public'))
    p.add_argument('--sources', type=pathlib.Path, required=True)
    p.add_argument('--out', type=pathlib.Path, default=pathlib.Path('/srv/evimed/sb/manifest.json'))
    p.add_argument('--seed', default='20261111')
    args = p.parse_args()
    if args.out.exists():
        raise SystemExit('Manifest already frozen; use a new output path to change the sample')
    manifest = select(args.data, args.seed)
    manifest['pinVerification'] = verify(manifest, args.sources)
    args.out.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest['perDomain'], indent=2))
