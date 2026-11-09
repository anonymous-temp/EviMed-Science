#!/usr/bin/env python3
"""Fetch the public inputs of the frozen batch evaluation into a NEW, empty directory and verify every byte against the manifest.

  python3 -I fetch_public_data.py <new dir>

Writes <dir>/raw/ (PhysioNet Challenge 2012 sets A/B/C and outcomes, the layout prepare.py reads as VCR_EVAL_RAW_DIR) and
<dir>/input/actg_survival.csv (ACTG175 from the CRAN package's data file). Downloads are untrusted: the tarballs are only read
(the CRAN package is read for its one data member, never extracted), nothing is executed, and a hash that differs from
public-data-manifest-20261109.json is an error that deletes the file. A generic client name is sent; no contact identity.
"""
import hashlib, io, json, pathlib, sys, tarfile, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / 'public-data-manifest-20261109.json').read_text())
AGENT = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) python-urllib'}

def fetch(url, limit=64 * 1024 * 1024):
    with urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=300) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise SystemExit(f'{url}: larger than {limit} bytes')
    return data

def verified(name, data, spec):
    if len(data) != spec['bytes'] or hashlib.sha256(data).hexdigest() != spec['sha256']:
        raise SystemExit(f'{name}: bytes differ from the manifest (got {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()})')
    if 'md5' in spec and hashlib.md5(data).hexdigest() != spec['md5']:
        raise SystemExit(f'{name}: md5 differs from the manifest')

def main(target):
    out = pathlib.Path(target)
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f'{out} is not empty; give a new directory')
    (out / 'raw').mkdir(parents=True, exist_ok=True); (out / 'input').mkdir(parents=True, exist_ok=True)
    physionet = MANIFEST['physionet-challenge-2012']
    for name, spec in physionet['files'].items():
        data = fetch(physionet['base'] + name); verified(name, data, spec)
        (out / 'raw' / name).write_bytes(data)
    actg = MANIFEST['actg175-speff2trial']
    (name, spec), = actg['files'].items()
    package = fetch(actg['base'] + name); verified(name, package, spec)
    (member, mspec), = actg['member'].items()
    with tarfile.open(fileobj=io.BytesIO(package), mode='r:gz') as archive:
        info = archive.getmember(member)
        if not info.isfile() or info.size > 4 * 1024 * 1024:
            raise SystemExit(f'{member}: not a plain small file')
        text = archive.extractfile(info).read()
    if hashlib.sha256(text).hexdigest() != mspec['sha256'] or hashlib.md5(text).hexdigest() != mspec['md5InPackageMD5File']:
        raise SystemExit(f'{member}: differs from the manifest')
    lines = text.decode('ascii').strip().splitlines()
    if len(lines) - 1 != mspec['rows']:
        raise SystemExit(f'{member}: {len(lines) - 1} rows, expected {mspec["rows"]}')
    (out / 'input' / 'actg_survival.csv').write_text('\n'.join(','.join(line.split()) for line in lines) + '\n')
    print(json.dumps({'raw': sorted(p.name for p in (out / 'raw').iterdir()), 'actg_rows': mspec['rows']}))

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
