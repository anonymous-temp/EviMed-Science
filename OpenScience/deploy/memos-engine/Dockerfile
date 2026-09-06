ARG PYTHON_BASE_IMAGE=docker.m.daocloud.io/library/python:3.11-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84
FROM ${PYTHON_BASE_IMAGE} AS build
WORKDIR /build
COPY deps-version.json /build/deps-version.json
COPY deploy/memos-engine/gpt2-tokenizer /build/gpt2-tokenizer
# The source commit lives with the other upstream pins, not in a second ARG.
RUN python - <<'PY'
import io, json, re, tarfile, urllib.request
from pathlib import Path
pin = json.loads(Path('/build/deps-version.json').read_text())['memos']
revision = pin['sourceRevision']
assert re.fullmatch(r'[a-f0-9]{40}', revision), 'A full MemOS source pin is required'
url = 'https://codeload.github.com/MemTensor/MemOS/tar.gz/' + revision
with urllib.request.urlopen(url, timeout=120) as response:
    archive = response.read(80 * 1024 * 1024 + 1)
assert len(archive) <= 80 * 1024 * 1024, 'Source archive exceeds the build limit'
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
    package.extractall('/build/upstream', filter='data')
root = next(Path('/build/upstream').iterdir())
for name in ['src', 'docker', 'LICENSE']:
    (root / name).rename(Path('/build') / name)
Path('/build/upstream-pin.json').write_text(json.dumps({'name': 'MemTensor/MemOS', 'version': pin['version'], 'revision': revision}))
PY
ARG APT_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
RUN sed -ri "s|https?://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|https?://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends gcc g++ libffi-dev \
    && rm -rf /var/lib/apt/lists/*
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --prefix=/install -r /build/docker/requirements.txt
RUN python - <<'PY'
import hashlib, json, shutil
from pathlib import Path
pin = json.loads(Path('/build/deps-version.json').read_text())['memos']
source = Path('/build/gpt2-tokenizer')
manifest = json.loads((source / 'manifest.json').read_text())
expected_files = {'config.json', 'merges.txt', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json'}
assert pin['tokenizer'] == 'gpt2', 'The image cache layout is bound to the reviewed GPT-2 alias'
assert manifest['schemaVersion'] == 1
assert manifest['repository'] == 'openai-community/gpt2'
assert manifest['revision'] == pin['tokenizerRevision']
assert manifest['license'] == 'MIT'
assert set(manifest['files']) == expected_files
assert {path.name for path in source.iterdir()} == expected_files | {'manifest.json'}
cache_root = Path('/build/hf-cache/hub/models--gpt2')
snapshot = cache_root / 'snapshots' / manifest['revision']
snapshot.mkdir(parents=True)
for name, expected in manifest['files'].items():
    payload = (source / name).read_bytes()
    assert len(payload) == expected['bytes'], f'{name} byte count differs from the reviewed manifest'
    assert hashlib.sha256(payload).hexdigest() == expected['sha256'], f'{name} digest differs from the reviewed manifest'
    shutil.copyfile(source / name, snapshot / name)
(cache_root / 'refs').mkdir()
(cache_root / 'refs' / 'main').write_text(manifest['revision'])
PY

FROM ${PYTHON_BASE_IMAGE} AS runtime
WORKDIR /app
RUN groupadd --gid 10001 memos && useradd --uid 10001 --gid 10001 --no-create-home memos \
    && mkdir -p /var/lib/memos && chown 10001:10001 /var/lib/memos
COPY --from=build /install /usr/local
COPY --from=build /build/src /app/src
COPY --from=build /build/docker /app/docker
COPY --from=build /build/LICENSE /usr/share/licenses/memos/LICENSE
COPY --from=build /build/upstream-pin.json /app/upstream-pin.json
COPY --from=build --chown=10001:10001 /build/hf-cache /opt/evimed/hf-cache
COPY deploy/memos-engine/serve.py deploy/memos-engine/index_profile.py /app/
ENV PYTHONPATH=/app/src PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 MEMOS_BASE_PATH=/var/lib/memos \
    HF_HOME=/opt/evimed/hf-cache HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
RUN python -c "from transformers import AutoTokenizer; AutoTokenizer.from_pretrained('gpt2', local_files_only=True)"
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD ["python", "/app/serve.py", "--health"]
CMD ["python", "/app/serve.py"]
