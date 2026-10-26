# The owner passes the frozen release runtime digest from the dependency registry.
ARG RELEASE_IMAGE
FROM ${RELEASE_IMAGE}
USER root
RUN mkdir -p /srv/rsi-lab && chown 10001:10001 /srv/rsi-lab
USER 10001:10001
WORKDIR /opt/evimed/OpenScience
ENTRYPOINT ["node", "evals/rsi-campaigns/run.mjs"]
