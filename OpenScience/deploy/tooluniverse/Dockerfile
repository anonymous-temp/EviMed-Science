# ToolUniverse as a sidecar MCP server.
#
# Hidden knowledge: this is deliberately NOT installed into the runtime image.
# ToolUniverse's ~2,700 tools call their upstreams directly from their own
# process and read their credentials from the environment. The runtime
# container is built to do neither: it is read-only, holds no key, and reaches
# the outside world only through the control plane's public-source gateway.
# Putting ToolUniverse inside it would have required giving that container both
# egress and secrets -- undoing the two properties the sandbox exists for.
#
# As a sidecar it keeps its own egress and its own keys, and the runtime
# reaches it over the internal network by MCP streamable-http. What the runtime
# gains is the tool surface; what it does not gain is the ability to leave.
FROM python:3.12-slim-bookworm

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

RUN pip install --no-cache-dir "tooluniverse==${TOOLUNIVERSE_VERSION}" \
  && python -c "import tooluniverse; print('tooluniverse', tooluniverse.__version__)"

# Unprivileged, like every other service we run.
RUN useradd --create-home --uid 10001 tooluniverse
USER tooluniverse
WORKDIR /home/tooluniverse

EXPOSE 8080

# `--compact-mode` exposes five discovery tools and reaches the rest through
# `execute_tool`. Without it a tool list larger than most context windows
# arrives before the question does.
#
# Bound to 0.0.0.0 because the only route to this port is the internal compose
# network; it is never published to the host.
CMD ["tooluniverse-smcp-server", "--host", "0.0.0.0", "--port", "8080", "--compact-mode"]
