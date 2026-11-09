"""Stream WildChat-1M one shard at a time, keep Chinese conversations, delete each shard.
Run: python3 -I wildchat_shards.py SOURCES_JSON OUT_DIR
Resumable through OUT_DIR/done.txt (one shard path per line)."""
import gzip, hashlib, json, os, subprocess, sys
import pyarrow.parquet as pq

sources_path, out = sys.argv[1], sys.argv[2]
work = os.path.join(out, 'work')
os.makedirs(work, exist_ok=True)
info = json.load(open(sources_path))['public']['wildchat-1m']
shards = [f for f in info['files'] if f['path'].endswith('.parquet')]
done_path = os.path.join(out, 'done.txt')
done = set(open(done_path).read().split('\n')) if os.path.exists(done_path) else set()
COLS = ['conversation_hash', 'timestamp', 'conversation', 'turn', 'language', 'hashed_ip', 'header', 'toxic', 'redacted']

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

for shard in shards:
    if shard['path'] in done:
        continue
    name = os.path.basename(shard['path'])
    local = os.path.join(work, name)
    for attempt in range(4):
        subprocess.run(['curl', '-sSfL', '-A', 'capsule-proving-fetch/1', '--retry', '3', '-o', local + '.part', shard['url']], check=True)
        if os.path.getsize(local + '.part') == shard['bytes'] and sha256(local + '.part') == shard['sha256']:
            os.rename(local + '.part', local)
            break
        os.remove(local + '.part')
    else:
        raise SystemExit(f'{name}: size/sha mismatch')
    kept = 0
    target = os.path.join(work, name + '.zh.jsonl.gz')
    with gzip.open(target + '.tmp', 'wt', encoding='utf8') as w:
        pf = pq.ParquetFile(local)
        for batch in pf.iter_batches(batch_size=500, columns=COLS):
            for r in batch.to_pylist():
                if r['language'] != 'Chinese':
                    continue
                turns = [{'role': t['role'], 'text': t['content']} for t in r['conversation']]
                w.write(json.dumps({'hash': r['conversation_hash'], 'ts': r['timestamp'].isoformat() if r['timestamp'] else None,
                                    'ip': r['hashed_ip'], 'header': r['header'], 'turn': r['turn'], 'toxic': r['toxic'],
                                    'redacted': r['redacted'], 'turns': turns}, ensure_ascii=False) + '\n')
                kept += 1
    os.rename(target + '.tmp', target)
    os.remove(local)
    with open(done_path, 'a') as f:
        f.write(shard['path'] + '\n')
    with open(os.path.join(os.environ.get('CAPSULE_PROVING_DATA', '.'), 'STATUS'), 'a') as f:
        import datetime
        f.write(f"{datetime.datetime.utcnow().isoformat()}Z public DONE wildchat shard {name} zh={kept} sha256={shard['sha256']}\n")
    print(name, kept, flush=True)
