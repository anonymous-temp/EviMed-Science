"""Convert one pinned parquet file to JSONL with a header line naming its source digest.
Run: python3 -P parquet_to_jsonl.py PARQUET OUT_JSONL SOURCE_SHA256 [--json-columns a,b,c] [--columns a,b,c]
JSON-string columns listed in --json-columns are parsed; everything else is copied as is. Streams in batches."""
import json, sys
import pyarrow.parquet as pq

src, out, digest = sys.argv[1:4]
jcols = set(sys.argv[sys.argv.index('--json-columns') + 1].split(',')) if '--json-columns' in sys.argv else set()
cols = sys.argv[sys.argv.index('--columns') + 1].split(',') if '--columns' in sys.argv else None
n = 0
with open(out + '.tmp', 'w', encoding='utf8') as w:
    w.write(json.dumps({'derivedFrom': src.split('/public/')[-1], 'sha256': digest}) + '\n')
    for batch in pq.ParquetFile(src).iter_batches(batch_size=500, columns=cols):
        for r in batch.to_pylist():
            for c in jcols:
                if isinstance(r.get(c), str):
                    r[c] = json.loads(r[c])
            w.write(json.dumps(r, ensure_ascii=False) + '\n'); n += 1
import os
os.replace(out + '.tmp', out)
print(out, n)
