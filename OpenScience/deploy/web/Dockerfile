ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:22.22.0-alpine
FROM ${NODE_BASE_IMAGE} AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate
RUN pnpm config set registry "${NPM_REGISTRY}"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/harness-port/package.json packages/harness-port/package.json
COPY packages/socket/package.json packages/socket/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN pnpm install --frozen-lockfile

COPY . .

# A clean Git context contains no ignored skill packs or generated assets.
# Hydrate the existing immutable AI4S pin inside the image, applying the same
# compatibility patch as local/CI installs. Caller environment cannot move it.
#
# The same mirror rewrite the runtime stage does. This stage installed from
# the default Alpine CDN, which the Tencent host reaches at tens of KB/s, so
# a build whose every other fetch was mirrored still spent seven minutes on
# twenty-five packages here (2026-09-09).
ARG APK_MIRROR=https://dl-cdn.alpinelinux.org/alpine
RUN sed -ri "s|https?://[^/]+/alpine|${APK_MIRROR}|g" /etc/apk/repositories \
  && apk add --no-cache bash curl python3 \
  && env -u AI4S_SKILLS_COMMIT bash scripts/dev/fetch-skills.sh

RUN pnpm --filter @evimed/dsh-socket prepack

ARG VITE_OPEN_SCIENCE_API_URL=/api
ENV VITE_OPEN_SCIENCE_API_URL=${VITE_OPEN_SCIENCE_API_URL}
RUN pnpm --filter @ai4s/web build
RUN pnpm --filter @ai4s/server deploy --prod /server

FROM ${NODE_BASE_IMAGE} AS runtime

ARG APK_MIRROR=https://dl-cdn.alpinelinux.org/alpine

LABEL org.opencontainers.image.title="EviMed Web"
LABEL org.opencontainers.image.description="Hosted Web API and browser application for EviMed."
LABEL org.opencontainers.image.source="https://github.com/ai4s-research/open-science"

WORKDIR /app
RUN sed -ri "s|https?://[^/]+/alpine|${APK_MIRROR}|g" /etc/apk/repositories \
  && apk add --no-cache aws-cli bash coreutils docker-cli tar python3
ENV NODE_ENV=production
ENV OPEN_SCIENCE_HOST=0.0.0.0
ENV OPEN_SCIENCE_PORT=8787
ENV OPEN_SCIENCE_DATA_DIR=/data
ENV OPEN_SCIENCE_STATIC_DIR=/app/apps/web/dist
ENV OPEN_SCIENCE_EXAMPLES_DIR=/app/examples

COPY --from=build /server ./apps/server
# The single definition of every tracked upstream pin, read by `config.mjs` at
# module load — so without it the server cannot start at all, and the failure is
# an ENOENT during import rather than anything about configuration. It became a
# config dependency during the kernel migration, after the last image was built,
# so nothing noticed until an image built from that code was first run.
COPY --from=build /app/deps-version.json ./deps-version.json
COPY --from=build /app/plugin-availability.json ./plugin-availability.json
COPY --from=build /app/capabilities ./capabilities
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/runtime/skills/core ./runtime/skills/core
COPY --from=build /app/runtime/skills/external/ai4s-skills ./runtime/skills/external/ai4s-skills
COPY --from=build /app/runtime/skills/curated-scientific ./runtime/skills/curated-scientific
COPY --from=build /app/runtime/skills/office ./runtime/skills/office
COPY --from=build /app/runtime/skills/evimed ./runtime/skills/evimed
COPY --from=build /app/runtime/mcp/evimed-research ./runtime/mcp/evimed-research
COPY --from=build /app/examples/climate-trends ./examples/climate-trends
COPY --from=build /app/scripts/ops ./scripts/ops
COPY --from=build /app/evals/method-quality ./evals/method-quality
COPY --from=build /app/evals/evidence-appraisal/briefs.json ./evals/evidence-appraisal/briefs.json
COPY --from=build /app/evals/evidence-appraisal/hidden ./evals/evidence-appraisal/hidden
# The ops scripts ship inside this image and several of them import workspace
# packages — the release gate, the runtime-image check, the gate health probe,
# the session-stream acceptance run. `pnpm deploy` puts those packages under
# `apps/server/node_modules`, and Node resolves from the importing file's
# directory upwards, so `/app/scripts/ops/x.mjs` never reaches them and every
# one of those scripts died on `Cannot find package '@evimed/domain'` the first
# time one was run in here.
#
# A link rather than a second copy: the same directory, reachable from the
# repository root the way it is in a checkout.
RUN ln -s apps/server/node_modules /app/node_modules

# Release metadata must not enter dependency or filesystem RUN cache keys.
ARG APP_VERSION=0.1.3
ARG RELEASE_ID=untracked
ARG SOURCE_REVISION=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00.000Z
LABEL org.opencontainers.image.version="${RELEASE_ID}"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
LABEL org.opencontainers.image.created="${BUILD_CREATED}"
LABEL io.open-science.app.version="${APP_VERSION}"
ENV OPEN_SCIENCE_APP_VERSION=${APP_VERSION}
ENV OPEN_SCIENCE_RELEASE_ID=${RELEASE_ID}
ENV OPEN_SCIENCE_SOURCE_REVISION=${SOURCE_REVISION}
ENV OPEN_SCIENCE_BUILD_CREATED=${BUILD_CREATED}

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "apps/server/src/index.mjs"]
