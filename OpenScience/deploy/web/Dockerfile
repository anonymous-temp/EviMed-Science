ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:20-alpine
FROM ${NODE_BASE_IMAGE} AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate
RUN pnpm config set registry "${NPM_REGISTRY}"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY . .
ARG VITE_OPEN_SCIENCE_API_URL=/api
ENV VITE_OPEN_SCIENCE_API_URL=${VITE_OPEN_SCIENCE_API_URL}
RUN pnpm --filter @ai4s/desktop build
RUN pnpm --filter @ai4s/server deploy --prod /server

FROM ${NODE_BASE_IMAGE} AS runtime

ARG APP_VERSION=0.1.3
ARG RELEASE_ID=untracked
ARG SOURCE_REVISION=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00.000Z
ARG APK_MIRROR=https://dl-cdn.alpinelinux.org/alpine

LABEL org.opencontainers.image.title="EviMed Web"
LABEL org.opencontainers.image.description="Hosted Web API and browser application for EviMed."
LABEL org.opencontainers.image.source="https://github.com/ai4s-research/open-science"
LABEL org.opencontainers.image.version="${RELEASE_ID}"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
LABEL org.opencontainers.image.created="${BUILD_CREATED}"
LABEL io.open-science.app.version="${APP_VERSION}"

WORKDIR /app
RUN sed -ri "s|https?://[^/]+/alpine|${APK_MIRROR}|g" /etc/apk/repositories \
  && apk add --no-cache aws-cli bash coreutils docker-cli tar
ENV NODE_ENV=production
ENV OPEN_SCIENCE_HOST=0.0.0.0
ENV OPEN_SCIENCE_PORT=8787
ENV OPEN_SCIENCE_DATA_DIR=/data
ENV OPEN_SCIENCE_STATIC_DIR=/app/apps/desktop/dist
ENV OPEN_SCIENCE_EXAMPLES_DIR=/app/examples
ENV OPEN_SCIENCE_APP_VERSION=${APP_VERSION}
ENV OPEN_SCIENCE_RELEASE_ID=${RELEASE_ID}
ENV OPEN_SCIENCE_SOURCE_REVISION=${SOURCE_REVISION}
ENV OPEN_SCIENCE_BUILD_CREATED=${BUILD_CREATED}

COPY --from=build /server ./apps/server
COPY --from=build /app/apps/desktop/dist ./apps/desktop/dist
COPY --from=build /app/runtime/skills/core ./runtime/skills/core
COPY --from=build /app/runtime/skills/external/ai4s-skills ./runtime/skills/external/ai4s-skills
COPY --from=build /app/runtime/skills/curated-scientific ./runtime/skills/curated-scientific
COPY --from=build /app/runtime/skills/office ./runtime/skills/office
COPY --from=build /app/runtime/skills/evimed ./runtime/skills/evimed
COPY --from=build /app/runtime/mcp/evimed-research ./runtime/mcp/evimed-research
COPY --from=build /app/examples/climate-trends ./examples/climate-trends
COPY --from=build /app/scripts/ops ./scripts/ops

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "apps/server/src/index.mjs"]
