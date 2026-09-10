# Local acceptance only: the scientific production image is built separately.
# Supply a verified closure image containing /app/harness/node_modules.
ARG BASE_IMAGE
FROM --platform=linux/amd64 ${BASE_IMAGE} AS published_closure
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim
COPY --from=published_closure /app/harness/node_modules /app/harness/node_modules
RUN npm install --prefix /opt/acceptance-addons --ignore-scripts --no-fund --no-audit \
    @deepseek-ai/node-addon-landlock-run-linux-arm64@0.1.1 \
    @vscode/ripgrep-linux-arm64@1.18.0 @koromix/koffi-linux-arm64@3.2.0 \
    node-addon-require-builtin-linux-arm64-gnu@0.1.5 \
    @img/sharp-libvips-linux-arm64@1.3.3 @img/sharp-linux-arm64@0.35.4 \
  && cp -a /opt/acceptance-addons/node_modules/. /app/harness/node_modules/
COPY packages/socket /opt/evimed/socket-source
COPY packages/domain /opt/evimed/socket-source/node_modules/@evimed/domain
COPY packages/harness-port /opt/evimed/socket-source/node_modules/@evimed/harness-port
RUN ln -s /app/harness/node_modules/@deepseek-ai /opt/evimed/socket-source/node_modules/@deepseek-ai \
  && ln -s /app/harness/node_modules/zod /opt/evimed/socket-source/node_modules/zod \
  && node /opt/evimed/socket-source/scripts/build-client.mjs
COPY deploy/runtime-dsh/capabilities /opt/evimed/capabilities
COPY capability-skills /opt/evimed/capability-skills
COPY runtime/skills/core /opt/evimed/skills/core
COPY runtime/skills/evimed/open-domain-answer /opt/evimed/skills/evimed/open-domain-answer
COPY runtime/skills/curated-scientific /opt/evimed/skills/curated-scientific
COPY runtime/skills/office /opt/evimed/skills/office
COPY runtime/skills/community /opt/evimed/skills/community
COPY deploy/runtime-dsh/profile-seed.mjs /opt/evimed/deploy/runtime-dsh/profile-seed.mjs
COPY scripts/ops/native-ui-local/prepare-seed.mjs /opt/evimed/scripts/ops/native-ui-local/prepare-seed.mjs
RUN node /opt/evimed/scripts/ops/native-ui-local/prepare-seed.mjs && chmod -R a-w /opt/evimed
ENTRYPOINT ["node", "/repo/scripts/ops/native-ui-local/server.mjs"]
