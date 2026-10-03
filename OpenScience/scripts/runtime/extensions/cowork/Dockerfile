ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /opt/cowork
COPY vendor/ ./vendor/
COPY policy.mjs runner.mjs ./
COPY dependency-closure.json source-manifest.json LICENSE ./
RUN chmod 0555 /opt/cowork/vendor
USER 10001:10001
ENTRYPOINT ["node", "--max-old-space-size=256", "/opt/cowork/runner.mjs"]
