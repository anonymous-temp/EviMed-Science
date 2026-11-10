"""Frozen task samples for the paper replications C1 and C2 (plan section 5.5).

C1: ALFWorld valid_seen (140) and valid_unseen (134) are run whole; ScienceWorld is sampled, 60 seen (the dev fold) and
60 unseen (the test fold), spread over the task types. C2: InfiAgent-DABench is run whole (257); DA-Code is sampled to 100
over its six categories and ScienceAgentBench to 30 over its four domains. Every draw orders the items of a stratum by
sha256(seed|id) and takes them round-robin across strata, so the sample is the same on any machine and any Python.

Run: python3 -I c_samples.py PUBLIC_DIR OUT_JSON
"""
import csv, hashlib, json, os, sys, zipfile

SEED = 'capsule-proving-20261109-v1:c'


def key(item_id):
    return hashlib.sha256(f'{SEED}|{item_id}'.encode()).hexdigest()


def round_robin(strata, k):
    """Take k items, one per stratum in turn (strata sorted by name, items by seeded hash)."""
    queues = {name: sorted(ids, key=key) for name, ids in sorted(strata.items())}
    out = []
    while len(out) < k and any(queues.values()):
        for name in sorted(queues):
            if queues[name] and len(out) < k:
                out.append(queues[name].pop(0))
    return out


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def main(public, out):
    doc = {'schema': 'capsule-proving-c-samples/1', 'seed': SEED, 'sets': {}}

    # ALFWorld: whole splits, listed by game directory.
    alf = os.path.join(public, 'alfworld')
    doc['sets']['alfworld'] = {'run': 'whole', 'note': 'valid_seen 140 and valid_unseen 134 games of the pinned release (sources.json learning/alfworld)'}

    # ScienceWorld: dev fold = seen, test fold = unseen; one item = task index + variation.
    zpath = os.path.join(public, 'scienceworld', 'goldpaths', 'goldpaths-all.zip')
    with zipfile.ZipFile(zpath) as z:
        gold = json.loads(z.read(z.namelist()[0]))
    folds = {'dev': {}, 'test': {}}
    for task in gold.values():
        for seq in task['goldActionSequences']:
            if seq['fold'] in folds:
                folds[seq['fold']].setdefault(task['taskName'], []).append(f"{task['taskIdx']}:{task['taskName']}:var{seq['variationIdx']}")
    doc['sets']['scienceworld'] = {
        'run': 'sample', 'source': 'scienceworld/goldpaths/goldpaths-all.zip', 'sourceSha256': sha256_file(zpath),
        'seen': round_robin(folds['dev'], 60), 'unseen': round_robin(folds['test'], 60),
        'universe': {'seen': sum(map(len, folds['dev'].values())), 'unseen': sum(map(len, folds['test'].values())), 'taskTypes': len(gold)},
    }

    # InfiAgent-DABench: whole.
    doc['sets']['infiagent-dabench'] = {'run': 'whole', 'note': '257 questions of the pinned commit'}

    # DA-Code: the six category files under configs/task; strata = category.
    cfg = os.path.join(public, 'da-code', 'da_code', 'configs', 'task')
    strata = {}
    for name in ['di', 'dm', 'dw', 'ml', 'sa', 'visual']:
        with open(os.path.join(cfg, f'{name}.jsonl')) as f:
            strata[name] = [json.loads(line)['id'] for line in f if line.strip()]
    doc['sets']['da-code'] = {'run': 'sample', 'source': 'da-code/da_code/configs/task/{di,dm,dw,ml,sa,visual}.jsonl',
                              'tasks': round_robin(strata, 100), 'universe': sum(map(len, strata.values())),
                              'note': 'each task needs its folder under da_code/source (large-only in sources.json): fetch with fetch-public.mjs --large --only da-code'}

    # ScienceAgentBench: strata = domain.
    sab = os.path.join(public, 'scienceagentbench', 'ScienceAgentBench.csv')
    strata = {}
    with open(sab, newline='') as f:
        for row in csv.DictReader(f):
            strata.setdefault(row['domain'], []).append(row['instance_id'])
    doc['sets']['scienceagentbench'] = {'run': 'sample', 'source': 'scienceagentbench/ScienceAgentBench.csv', 'sourceSha256': sha256_file(sab),
                                        'tasks': round_robin(strata, 30), 'universe': sum(map(len, strata.values())),
                                        'byDomain': {d: len(v) for d, v in sorted(strata.items())}}
    with open(out, 'w') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(json.dumps({k: {kk: (len(vv) if isinstance(vv, list) else vv) for kk, vv in v.items() if kk in ('seen', 'unseen', 'tasks', 'universe')} for k, v in doc['sets'].items()}))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
