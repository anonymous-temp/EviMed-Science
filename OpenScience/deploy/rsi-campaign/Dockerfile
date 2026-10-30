# The offline RSI lab (2026-10-26): Python 3.12 for the registered statistics, Node 22 for the runner and production's selector,
# nothing from the serving runtime. Built on the lab host from an archive of the campaign's exact source tree (build context =
# OpenScience/, see rsi-lab-install.sh) and run read-only as uid 10001 by rsi-lab-monthly.sh.
ARG PYTHON_IMAGE=docker.m.daocloud.io/library/python:3.12-slim-bookworm
FROM ${PYTHON_IMAGE}
ARG NODE_VERSION=22.22.0
ARG NODE_MIRROR=https://registry.npmmirror.com/-/binary/node
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PIP_INDEX=https://mirrors.aliyun.com/pypi/simple/
COPY deploy/rsi-campaign/fetch-node.py /tmp/fetch-node.py
RUN python3 /tmp/fetch-node.py "$NODE_MIRROR" "$NODE_VERSION" /opt/node && rm /tmp/fetch-node.py
ENV PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
COPY evals/rsi-campaigns/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --index-url "$PIP_INDEX" --target /opt/evimed/rsi-python -r /tmp/requirements.txt && rm /tmp/requirements.txt
# The runner's whole package surface (the import graph of run.mjs, frontier_assemble.mjs, frontier_labels.mjs, evaluator.mjs and
# finalize.mjs): pg, yaml and es-module-lexer at the lockfile's versions, plus the domain package itself.
RUN mkdir -p /opt/evimed/lab-deps && cd /opt/evimed/lab-deps \
  && printf '{"private":true,"dependencies":{"pg":"8.16.3","yaml":"2.8.3","es-module-lexer":"1.7.0"}}' > package.json \
  && npm install --omit=dev --no-audit --no-fund --registry "$NPM_REGISTRY" && npm ls --all > /opt/evimed/lab-deps/npm-ls.txt
COPY . /opt/evimed/OpenScience
RUN mkdir -p /opt/evimed/lab-deps/node_modules/@evimed \
  && ln -s /opt/evimed/OpenScience/packages/domain /opt/evimed/lab-deps/node_modules/@evimed/domain \
  && ln -sfn /opt/evimed/lab-deps/node_modules /opt/evimed/OpenScience/apps/server/node_modules
ENV RSI_STATISTICS_PYTHONPATH=/opt/evimed/rsi-python
USER 10001:10001
WORKDIR /opt/evimed/OpenScience
ENTRYPOINT ["node"]
