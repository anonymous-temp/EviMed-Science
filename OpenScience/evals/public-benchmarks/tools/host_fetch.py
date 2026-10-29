#!/usr/bin/env python3
"""Fetch benchmark files onto the production host through the deployment's edge proxy.

Run on the host as root (it reads the proxy URL from the live .env and the proxy credentials file; neither is printed):
  sudo python3 /srv/evimed-science/shared/benchmarks/tools/host_fetch.py /srv/evimed-science/shared/benchmarks/fetch/<name>.json

The list is JSON: [{"url", "bytes", "sha256" (or null), "dest" (absolute path under /srv/evimed-science/shared/benchmarks/data),
"unzip": null | {"into": dir, "only_prefix": "CapsuleData-<uuid>/", "strip_prefix": true}}]. A file already present with the
right size (and digest when given) is skipped, so a rerun resumes. Files over 16 MB are fetched as 8 ranged parts.
"""
import concurrent.futures
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import zipfile

ROOT = pathlib.Path('/srv/evimed-science/shared/benchmarks/data')
ENV = pathlib.Path('/srv/evimed-science/current/OpenScience/deploy/web/.env')
CREDS = pathlib.Path('/srv/evimed-science/shared/secrets/edge-proxy.credentials')


def proxy():
    url = next(line.split('=', 1)[1].strip() for line in ENV.read_text().splitlines() if line.startswith('OPEN_SCIENCE_EDGE_PROXY_URL='))
    return url, CREDS.read_text().strip()


def curl(url, out, proxy_url, creds, byte_range=None):
    # The proxy credentials go in on stdin as a curl config, never on the command line (visible in /proc/*/cmdline).
    args = ['curl', '-sS', '-L', '--fail', '--retry', '5', '--retry-delay', '3', '--max-time', '1800', '-K', '-', '-o', str(out)]
    if byte_range:
        args += ['-r', byte_range]
    config = f'proxy = "{proxy_url}"\nproxy-user = "{creds}"\n'
    subprocess.run(args + [url], check=True, input=config.encode(), stderr=subprocess.PIPE)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch(entry, proxy_url, creds):
    dest = pathlib.Path(entry['dest'])
    if ROOT not in dest.parents:
        raise ValueError(f'destination outside {ROOT}: {dest}')
    dest.parent.mkdir(parents=True, exist_ok=True)
    good = dest.exists() and (entry.get('bytes') is None or dest.stat().st_size == entry['bytes']) and (not entry.get('sha256') or sha256(dest) == entry['sha256'])
    if not good:
        size = entry.get('bytes') or 0
        if size > 16 * 1024 * 1024:
            parts, step = [], -(-size // 8)
            for i in range(8):
                part = dest.with_name(dest.name + f'.part{i}')
                lo, hi = i * step, min(size, (i + 1) * step) - 1
                parts.append((part, f'{lo}-{hi}', hi - lo + 1))
            with concurrent.futures.ThreadPoolExecutor(8) as pool:
                list(pool.map(lambda p: p[0].exists() and p[0].stat().st_size == p[2] or curl(entry['url'], p[0], proxy_url, creds, p[1]), parts))
            with open(dest, 'wb') as out:
                for part, _, _ in parts:
                    out.write(part.read_bytes())
                    part.unlink()
        else:
            curl(entry['url'], dest, proxy_url, creds)
        if entry.get('bytes') is not None and dest.stat().st_size != entry['bytes']:
            raise ValueError(f'size mismatch {dest}')
        if entry.get('sha256') and sha256(dest) != entry['sha256']:
            raise ValueError(f'sha256 mismatch {dest}')
    unzip = entry.get('unzip')
    if unzip:
        into = pathlib.Path(unzip['into'])
        if ROOT not in into.parents:
            raise ValueError(f'unzip target outside {ROOT}: {into}')
        marker = into / '.extracted'
        if not marker.exists():
            into.mkdir(parents=True, exist_ok=True)
            prefix = unzip.get('only_prefix') or ''
            with zipfile.ZipFile(dest) as z:
                for info in z.infolist():
                    name = info.filename
                    if prefix and not name.startswith(prefix) or info.is_dir():
                        continue
                    rel = name[len(prefix):] if unzip.get('strip_prefix') else name
                    target = (into / rel).resolve()
                    if into.resolve() not in target.parents:
                        raise ValueError(f'unsafe path in zip: {name}')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(info) as src, open(target, 'wb') as out:
                        out.write(src.read())
            marker.write_text('ok\n')
            if unzip.get('delete_zip'):
                dest.unlink()
    return str(dest)


def main():
    entries = json.loads(pathlib.Path(sys.argv[1]).read_text())
    proxy_url, creds = proxy()
    done, failed = 0, []
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        futures = {pool.submit(fetch, e, proxy_url, creds): e for e in entries}
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
                done += 1
            except Exception as error:  # report and continue: a rerun resumes
                failed.append((futures[future]['url'].rsplit('/', 1)[-1], str(error)[:200]))
    for path in ROOT.rglob('*'):
        os.chmod(path, 0o755 if path.is_dir() else 0o644)
    print(json.dumps({'done': done, 'failed': failed}))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
