# The owner passes the frozen release runtime digest from the dependency registry.
ARG RELEASE_IMAGE
FROM ${RELEASE_IMAGE}
USER root
COPY . /opt/evimed/OpenScience
RUN uv pip install --python python3 --target /opt/evimed/rsi-python --requirement /opt/evimed/OpenScience/evals/rsi-campaigns/requirements.txt
RUN mkdir -p /srv/rsi-lab && chown 10001:10001 /srv/rsi-lab
USER 10001:10001
WORKDIR /opt/evimed/OpenScience
ENTRYPOINT ["node", "evals/rsi-campaigns/run.mjs"]
