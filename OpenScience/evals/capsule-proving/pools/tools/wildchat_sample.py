"""Pseudo-user sample from the Chinese WildChat conversations kept by wildchat_shards.py.
Run: python3 -P wildchat_sample.py SOURCES_JSON OUT_DIR
Key = hashed_ip + header. Eligible: 3-50 conversations, spanning >= 2 UTC calendar days. Whole users, seeded order, until >= 2000 conversations."""
import datetime, glob, gzip, hashlib, json, os, statistics, sys

sources_path, out = sys.argv[1], sys.argv[2]
SEED = 'capsule-proving-20261109-v1'
TARGET = 2000
info = json.load(open(sources_path))['public']['wildchat-1m']
files = sorted(glob.glob(os.path.join(out, 'work', '*.zh.jsonl.gz')))
done = open(os.path.join(out, 'done.txt')).read().split()
assert len(files) == len([f for f in info['files'] if f['path'].endswith('.parquet')]) == len(done), 'not every shard is processed yet'

def key_of(r):
    return hashlib.sha256(json.dumps([r['ip'], r['header']], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]

def day(ts):
    return ts[:10]

# pass 1: light records only
users = {}
total = 0
for f in files:
    with gzip.open(f, 'rt', encoding='utf8') as r:
        for line in r:
            d = json.loads(line)
            total += 1
            if not d['ts'] or not d['ip']:
                continue
            users.setdefault(key_of(d), []).append((d['ts'], d['hash']))
span_days = lambda v: (datetime.date.fromisoformat(max(day(t) for t, _ in v)) - datetime.date.fromisoformat(min(day(t) for t, _ in v))).days
distinct_days = lambda v: len({day(t) for t, _ in v})
ge10 = [k for k, v in users.items() if len(v) >= 10]
eligible = [k for k, v in users.items() if 3 <= len(v) <= 50 and distinct_days(v) >= 2]
ranked = sorted(eligible, key=lambda k: hashlib.sha256(f'{SEED}|{k}'.encode()).hexdigest())
chosen, n = [], 0
for k in ranked:
    if n >= TARGET:
        break
    chosen.append(k); n += len(users[k])
want = {h for k in chosen for _, h in users[k]}
chosen_set = set(chosen)

# pass 2: write the conversations of the chosen users
by_user = {k: [] for k in chosen}
for f in files:
    with gzip.open(f, 'rt', encoding='utf8') as r:
        for line in r:
            d = json.loads(line)
            if d['hash'] in want:
                k = key_of(d)
                if k in chosen_set:
                    by_user[k].append({'conversationHash': d['hash'], 'timestamp': d['ts'], 'turnCount': d['turn'], 'toxic': d['toxic'], 'redacted': d['redacted'], 'messages': d['turns']})
with open(os.path.join(out, 'sample.jsonl.tmp'), 'w', encoding='utf8') as w:
    for k in chosen:
        convs = sorted(by_user[k], key=lambda c: (c['timestamp'], c['conversationHash']))
        w.write(json.dumps({'pseudoUserId': k, 'conversations': convs}, ensure_ascii=False) + '\n')
os.replace(os.path.join(out, 'sample.jsonl.tmp'), os.path.join(out, 'sample.jsonl'))

sizes = [len(users[k]) for k in chosen]
spans = [span_days(users[k]) for k in chosen]
q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
sha = hashlib.sha256(open(os.path.join(out, 'sample.jsonl'), 'rb').read()).hexdigest()
manifest = {
    'schema': 'capsule-proving-wildchat-pseudo-users/1', 'seed': SEED, 'target': TARGET,
    'source': {'huggingface': 'allenai/WildChat-1M', 'revision': info['revision'], 'license': 'ODC-By 1.0',
               'shards': [{'path': f['path'], 'sha256': f['sha256'], 'bytes': f['bytes']} for f in info['files'] if f['path'].endswith('.parquet')]},
    'rule': 'language == Chinese; key = sha256(hashed_ip + header)[:16]; 3-50 conversations; >= 2 distinct UTC calendar days; users ordered by sha256(seed|key); whole users added until >= target conversations',
    'counts': {'chineseConversations': total, 'pseudoUsers': len(users), 'usersWith10OrMore': len(ge10), 'eligibleUsers': len(eligible),
               'sampleUsers': len(chosen), 'sampleConversations': n},
    'sample': {'conversationsPerUser': {'min': min(sizes), 'median': statistics.median(sizes), 'max': max(sizes)},
               'spanDays': {'min': min(spans), 'p25': q(spans, .25), 'median': statistics.median(spans), 'p75': q(spans, .75), 'max': max(spans), 'over30': sum(s > 30 for s in spans)}},
    'sampleSha256': sha, 'privacy': 'hashed_ip and header are not written; only the derived key is. Real user text: keep local, never redistribute.',
}
json.dump(manifest, open(os.path.join(out, 'manifest.json'), 'w'), indent=2)
with open(os.path.join(os.environ.get('CAPSULE_PROVING_DATA', '.'), 'STATUS'), 'a') as st:
    st.write(f"{datetime.datetime.now(datetime.UTC).isoformat()} public DONE wildchat-pseudo-users sample users={len(chosen)} conversations={n}\n")
print(json.dumps(manifest['counts']), json.dumps(manifest['sample']))
