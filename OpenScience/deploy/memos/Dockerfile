ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:24-alpine
ARG GO_BASE_IMAGE=docker.m.daocloud.io/library/golang:1.26.2-alpine
ARG RUNTIME_BASE_IMAGE=docker.m.daocloud.io/library/alpine:3.21

FROM ${NODE_BASE_IMAGE} AS frontend
WORKDIR /memos/web
RUN corepack enable && corepack prepare pnpm@11.0.1 --activate
COPY 记忆模块/web/package.json 记忆模块/web/pnpm-lock.yaml 记忆模块/web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY 记忆模块/web ./
RUN pnpm release

FROM ${GO_BASE_IMAGE} AS backend
WORKDIR /backend-build
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}
RUN apk add --no-cache ca-certificates git
COPY 记忆模块/go.mod 记忆模块/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY 记忆模块 ./
COPY --from=frontend /memos/server/router/frontend/dist ./server/router/frontend/dist
ARG TARGETOS TARGETARCH VERSION=0.31.1-evimed COMMIT=unknown
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build \
      -trimpath \
      -ldflags="-s -w -X github.com/usememos/memos/internal/version.Version=${VERSION} -X github.com/usememos/memos/internal/version.Commit=${COMMIT} -extldflags '-static'" \
      -tags netgo,osusergo \
      -o memos \
      ./cmd/memos

FROM ${RUNTIME_BASE_IMAGE} AS runtime
RUN apk add --no-cache ca-certificates su-exec tzdata \
    && addgroup -g 10001 -S nonroot \
    && adduser -u 10001 -S -G nonroot -h /var/opt/memos nonroot \
    && mkdir -p /var/opt/memos /usr/local/memos \
    && chown -R nonroot:nonroot /var/opt/memos
COPY --from=backend /backend-build/memos /usr/local/memos/memos
COPY --from=backend --chmod=755 /backend-build/scripts/entrypoint.sh /usr/local/memos/entrypoint.sh
WORKDIR /var/opt/memos
ENV TZ=UTC MEMOS_PORT=5230
VOLUME ["/var/opt/memos"]
EXPOSE 5230
ENTRYPOINT ["/usr/local/memos/entrypoint.sh", "/usr/local/memos/memos"]
