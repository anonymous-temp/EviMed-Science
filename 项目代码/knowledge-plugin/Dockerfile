# EviMed knowledge-source plugin. Build context: this directory only.
# The Playwright package ships its Node driver (the browser exit's CDP client); no browser is
# installed here — pages render in frontier-browser (docker-compose.knowledge.yml).
#   docker build --build-arg PYTHON_BASE_IMAGE=... --build-arg PIP_INDEX_URL=... --build-arg PLUGIN_BUILD=<rev> .
# Runtime facts the image is built for: uid:gid 10002:10002 (compose sets `user:` too), a read-only
# root filesystem with a tmpfs /tmp, cap_drop ALL. Nothing is written at run time, so bytecode is
# compiled here and Python is told never to write it.
ARG PYTHON_BASE_IMAGE=docker.m.daocloud.io/library/python:3.12-slim-bookworm
FROM ${PYTHON_BASE_IMAGE}

ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PLUGIN_BUILD=dev

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    NODE_NO_WARNINGS=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    KNOWLEDGE_PLUGIN_REGISTRY=/opt/knowledge-plugin/registry/sources.json \
    KNOWLEDGE_PLUGIN_PORT=8080 \
    KNOWLEDGE_PLUGIN_BUILD=${PLUGIN_BUILD}

RUN groupadd --system --gid 10002 knowledge \
 && useradd --system --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin knowledge

WORKDIR /build
COPY requirements.txt ./
RUN pip install --index-url "${PIP_INDEX_URL}" -r requirements.txt

COPY pyproject.toml README.md ./
COPY knowledge_plugin ./knowledge_plugin
RUN pip install --index-url "${PIP_INDEX_URL}" --no-deps . \
 && python -m compileall -q "$(python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')" \
 && cd / && rm -rf /build

COPY registry/sources.json /opt/knowledge-plugin/registry/sources.json

LABEL org.opencontainers.image.title="evimed-knowledge-plugin" \
      org.opencontainers.image.revision="${PLUGIN_BUILD}"

WORKDIR /opt/knowledge-plugin
USER 10002:10002
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=6s --start-period=40s --retries=3 \
  CMD ["python", "-c", "import json, os, sys, urllib.request; body = json.load(urllib.request.urlopen('http://127.0.0.1:%s/v1/health' % os.environ.get('KNOWLEDGE_PLUGIN_PORT', '8080'), timeout=5)); sys.exit(0 if body.get('status') in ('ok', 'degraded') else 1)"]
CMD ["python", "-m", "knowledge_plugin", "serve"]
