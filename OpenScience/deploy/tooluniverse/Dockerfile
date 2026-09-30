# Optional clinical API catalogue, isolated from research runtimes.
# The control plane holds the sidecar's service credential; runtimes reach it
# only through the workload-authenticated bridge. This initial catalogue uses
# public providers without API keys. The trusted profile excludes arbitrary-URL
# full-text tools; full-text retrieval stays on the managed source gateway.
ARG PYTHON_BASE_IMAGE=python:3.12-slim-bookworm
FROM ${PYTHON_BASE_IMAGE}

ARG APT_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ARG PIP_INDEX_URL=https://pypi.org/simple
# Pinned, not floating: a tool surface that changes under a running deployment
# changes what the model can do without anything recording that it changed.
ARG TOOLUNIVERSE_VERSION=1.4.1

ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN sed -ri "s|https?://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|https?://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY deploy/tooluniverse/constraints.txt /opt/evimed-tooluniverse/constraints.txt
RUN pip install --no-cache-dir -c /opt/evimed-tooluniverse/constraints.txt "tooluniverse==${TOOLUNIVERSE_VERSION}" \
  && python -c "import tooluniverse; print('tooluniverse', tooluniverse.__version__)"

COPY deploy/tooluniverse/sidecar.py deploy/tooluniverse/profile.yaml /opt/evimed-tooluniverse/

# Unprivileged, like every other service we run.
RUN useradd --create-home --uid 10001 tooluniverse
USER tooluniverse
WORKDIR /home/tooluniverse

EXPOSE 8080

# The trusted profile is seeded before importing ToolUniverse; otherwise the
# pinned CLI loads the full default catalogue before applying category flags.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["python", "/opt/evimed-tooluniverse/sidecar.py", "check", "--full"]
CMD ["python", "/opt/evimed-tooluniverse/sidecar.py", "serve"]
