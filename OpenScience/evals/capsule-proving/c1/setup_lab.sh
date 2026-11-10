#!/usr/bin/env bash
# Text-only upstream ALFWorld download recipe; no visual detector/checkpoints.
set -euo pipefail
umask 022
ROOT=/srv/evimed/c1
PUBLIC=/srv/evimed/data/memdata-data/public
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$ROOT/data/alfworld/archives" "$ROOT/data/scienceworld" "$ROOT/wheels" "$ROOT/tmp"
export PIP_CACHE_DIR="$ROOT/cache/pip" TMPDIR="$ROOT/tmp"
export UV_PYTHON_INSTALL_DIR="$ROOT/python" UV_CACHE_DIR="$ROOT/cache/uv" UV_PYTHON_BIN_DIR="$ROOT/bin"
export MAKEFLAGS=-j3 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
export PATH="$ROOT/venv/bin:$PATH"
if ! command -v java >/dev/null; then
  apt-get update -qq
  apt-get install -y --no-install-recommends default-jre-headless
fi
# TextWorld's grammar evaluator uses pre-3.13 locals() semantics.
PYTHON="$ROOT/python/cpython-3.12.12-linux-x86_64-gnu/bin/python3.12"
if [ ! -x "$PYTHON" ]; then
  python3 -m venv "$ROOT/bootstrap"
  "$ROOT/bootstrap/bin/pip" install uv==0.9.9
  "$ROOT/bootstrap/bin/uv" python install 3.12.12
fi
if [ -x "$ROOT/venv/bin/python" ] && [ "$("$ROOT/venv/bin/python" -c 'import sys; print(sys.version_info[:2] == (3, 12))')" != True ]; then
  mv "$ROOT/venv" "$ROOT/venv-before-python312-$(date +%s)"
fi
if [ ! -x "$ROOT/venv/bin/python" ]; then
  "$PYTHON" -m venv "$ROOT/venv"
fi
# The frozen source includes version 1.3.0, newer than the PyPI distribution.
if [ ! -f "$ROOT/wheels/scienceworld-1.3.0-py3-none-any.whl" ]; then
  mkdir -p "$ROOT/scienceworld-src"
  cp -a "$PUBLIC/scienceworld/." "$ROOT/scienceworld-src/"
  python -m pip wheel --no-deps "$ROOT/scienceworld-src" --wheel-dir "$ROOT/wheels"
fi
python -m pip install --find-links "$ROOT/wheels" -r "$HERE/requirements.txt"
export C1_PUBLIC="$PUBLIC" C1_ROOT="$ROOT"
python - <<'PY'
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile
import requests
import alfworld

root = Path(os.environ['C1_ROOT'])
public = Path(os.environ['C1_PUBLIC'])
data = root / 'data/alfworld'
archives = data / 'archives'
urls = {
    'json_2.1.1_json.zip': 'https://github.com/alfworld/alfworld/releases/download/0.2.2/json_2.1.1_json.zip',
    'json_2.1.1_pddl.zip': 'https://github.com/alfworld/alfworld/releases/download/0.2.2/json_2.1.1_pddl.zip',
    'json_2.1.3_tw-pddl.zip': 'https://github.com/alfworld/alfworld/releases/download/0.4.2/json_2.1.3_tw-pddl.zip',
}
for filename, url in urls.items():
    target = archives / filename
    pinned = public / 'alfworld/release-0.4.2' / filename
    if not target.exists():
        if pinned.exists():
            shutil.copyfile(pinned, target)
        else:
            temp = target.with_suffix('.partial')
            for attempt in range(6):
                try:
                    with requests.get(url, stream=True, timeout=(15, 180)) as response:
                        if not response.ok:
                            raise RuntimeError(f'ALFWorld download HTTP {response.status_code}')
                        with temp.open('wb') as stream:
                            for chunk in response.iter_content(1 << 20):
                                stream.write(chunk)
                    temp.replace(target)
                    break
                except (requests.RequestException, RuntimeError):
                    if attempt == 5:
                        raise SystemExit(f'ALFWorld download failed: {filename}') from None
                    import time
                    time.sleep(2 ** attempt)
    # Upstream unzip skips existing files. Atomic completion marker permits recovery.
    marker = data / (filename + '.extracted')
    if not marker.exists():
        with zipfile.ZipFile(target) as archive:
            archive.extractall(data)
        marker.touch()
logic = data / 'logic'
logic.mkdir(exist_ok=True)
for name in ['alfred.pddl', 'alfred.twl2']:
    shutil.copyfile(Path(alfworld.__file__).parent / 'data' / name, logic / name)
shutil.copyfile(public / 'scienceworld/scienceworld/scienceworld.jar', root / 'data/scienceworld/scienceworld.jar')

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

checksums = {str(p.relative_to(root)): digest(p) for p in sorted((root / 'data').rglob('*')) if p.is_file()}
manifest = {'python': subprocess.check_output(['python', '--version'], text=True).strip(),
            'java': subprocess.run(['java', '-version'], capture_output=True, text=True).stderr.splitlines(),
            'packages': subprocess.check_output(['python', '-m', 'pip', 'freeze'], text=True).splitlines(),
            'apt': subprocess.check_output(['dpkg-query', '-W', 'default-jre-headless', 'openjdk-21-jre-headless'], text=True).splitlines(),
            'upstreamDownloads': urls, 'textOnly': True, 'sha256': checksums,
            'dataBytes': sum(p.stat().st_size for p in (root / 'data').rglob('*') if p.is_file())}
path = root / 'setup-manifest.json'
if path.exists():
    previous = json.loads(path.read_text())
    if previous['sha256'] != checksums:
        raise SystemExit('Game data checksum changed since the previous setup')
path.write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'manifest': str(path), 'dataBytes': manifest['dataBytes'], 'hashedFiles': len(checksums),
                  'versions': {n: importlib.metadata.version(n) for n in ['alfworld', 'textworld', 'scienceworld', 'requests']}}))
PY
