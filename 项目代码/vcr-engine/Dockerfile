# vcr-engine — the deterministic statistics and simulation engine for
# 「虚拟临研」 (plan §11.4).
#
# Hidden knowledge:
#
# - **R version and package versions are both pinned, and the build proves
#   it.** `R/package-lock.json` is the single list; the verification step
#   below reads it and fails the build on any disagreement, so an image cannot
#   quietly ship different numerics from the ones the numeric acceptance cases
#   were run against. A lock file nobody checks is a comment.
# - **Package versions come from a dated snapshot, not from "latest".** The
#   Posit public package manager serves CRAN as of a date; plain
#   `install.packages` on a build a month later silently picks up WeightIt 2.1
#   or cobalt 5.1 and every cross-software case shifts. The date is the pin.
# - **Mirrors are build arguments** because the production host cannot reach
#   deb.debian.org, CRAN or PyPI directly (the same reason every other image in
#   this repo takes `APT_MIRROR` / `CRAN_MIRROR` / `PIP_INDEX_URL`). Trust does
#   not move with the URL: the version assertions below check whatever any
#   mirror served.
# - **No model client, no data volume, no network egress at run time.** The
#   engine opens exactly the files a job names in `inputs[].location`. There is
#   nothing in this image that can call a model or a gateway, and that is a
#   property of what is installed, not of a configuration flag.
# - **Runs as a non-root user with a read-only root filesystem in mind**: the
#   only writable paths are the job work directory and /tmp, which is why the
#   R library lives under /opt and the profile is baked at build time.
#
# This file is written, not built here (the development box has ~2 GB free).

ARG R_BASE_IMAGE=docker.m.daocloud.io/library/r-base:4.3.3
FROM ${R_BASE_IMAGE}

ARG APT_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ARG PIP_INDEX_URL=https://pypi.org/simple
# A dated CRAN snapshot: the versions in R/package-lock.json are the ones this
# date serves. Moving the date is a numerics change and reruns tests/run_all.sh.
ARG CRAN_SNAPSHOT_DATE=2026-09-28
ARG CRAN_MIRROR=https://packagemanager.posit.co/cran/${CRAN_SNAPSHOT_DATE}

ENV DEBIAN_FRONTEND=noninteractive \
    R_LIBS_SITE=/opt/vcr-rlib \
    VCR_R_LIBS=/opt/vcr-rlib \
    VCR_ENGINE_ROOT=/opt/vcr-engine \
    VCR_ENGINE_WORK_DIR=/var/lib/vcr-engine/jobs \
    VCR_ENGINE_CORES=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=UTC

# System libraries the pinned R packages compile against. `libv8-dev` is for
# V8 (RBesT's dependency chain), `libnlopt-dev` for the optimizers, and the
# build fails loudly if the mirror omits any of them rather than degrading to
# a package set that silently drops a method.
RUN set -eux; \
    sed -ri "s|https?://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|https?://deb.debian.org/debian|${APT_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-pip python3-venv \
      libcurl4-openssl-dev libssl-dev libxml2-dev libv8-dev libnlopt-dev \
      libgsl-dev libfontconfig1-dev libharfbuzz-dev libfribidi-dev \
      libfreetype6-dev libpng-dev libtiff5-dev libjpeg-dev; \
    rm -rf /var/lib/apt/lists/*

COPY R/package-lock.json /tmp/package-lock.json

# Install exactly the locked versions. `type = "source"` because the snapshot
# serves binaries only for some distributions and a silent fallback to a
# different build is the class of thing this file exists to prevent.
RUN set -eux; \
    mkdir -p "${R_LIBS_SITE}"; \
    Rscript -e 'lock <- jsonlite::fromJSON("/tmp/package-lock.json", simplifyDataFrame = FALSE); \
      repos <- c(CRAN = Sys.getenv("CRAN_MIRROR", "https://cloud.r-project.org")); \
      base <- rownames(installed.packages(priority = "base")); \
      want <- Filter(function(p) !(p$package %in% base), lock$packages); \
      install.packages(vapply(want, function(p) p$package, character(1)), \
                       lib = Sys.getenv("R_LIBS_SITE"), repos = repos, Ncpus = 4)' ; \
    Rscript -e 'lock <- jsonlite::fromJSON("/tmp/package-lock.json", simplifyDataFrame = FALSE); \
      stopifnot(identical(paste0(R.version$major, ".", R.version$minor), lock$rVersion)); \
      inst <- installed.packages(lib.loc = c(Sys.getenv("R_LIBS_SITE"), .libPaths())); \
      bad <- Filter(Negate(is.null), lapply(lock$packages, function(p) { \
        if (!(p$package %in% rownames(inst))) return(sprintf("%s missing", p$package)); \
        got <- as.character(inst[p$package, "Version"]); \
        if (!identical(got, p$version)) sprintf("%s is %s, lock says %s", p$package, got, p$version) else NULL })); \
      if (length(bad)) stop("package lock mismatch:\n", paste(unlist(bad), collapse = "\n")); \
      cat("package lock verified:", length(lock$packages), "packages\n")'

COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages \
      --index-url "${PIP_INDEX_URL}" -r /tmp/requirements.txt

WORKDIR /opt/vcr-engine
COPY R/ ./R/
COPY service/ ./service/
COPY tests/ ./tests/
COPY README.md ./

# Self-check at build time: the engine's method registry must agree with the
# generated snapshot of @evimed/domain. A mismatch here is a mismatch the
# control plane would otherwise discover by queueing a job nothing answers.
RUN set -eux; \
    Rscript -e '.libPaths(c(Sys.getenv("R_LIBS_SITE"), .libPaths())); \
      source("/opt/vcr-engine/R/engine.R"); vcr_engine_load("/opt/vcr-engine"); \
      h <- vcr_engine_health(); \
      if (!isTRUE(h$ok)) stop("engine self-check failed: ", jsonlite::toJSON(h$issues, auto_unbox = TRUE)); \
      cat("engine", h$engineVersion, h$rVersion, "with", length(h$methods), "methods\n")'

RUN set -eux; \
    useradd --system --create-home --uid 10001 vcr; \
    mkdir -p "${VCR_ENGINE_WORK_DIR}"; \
    chown -R vcr:vcr "${VCR_ENGINE_WORK_DIR}"

USER vcr
EXPOSE 8080

# Global concurrency is one, in the application (a single worker thread) and
# here (a single uvicorn worker). Two workers would give two queues and make
# both the CPU ceiling and the "one job at a time" rule untrue.
CMD ["python3", "-m", "uvicorn", "service.app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]

ARG BUILD_CREATED
ARG RELEASE_ID
LABEL org.opencontainers.image.title="vcr-engine" \
      org.opencontainers.image.description="Deterministic statistics and simulation engine for EviMed 虚拟临研" \
      org.opencontainers.image.created="${BUILD_CREATED}" \
      org.opencontainers.image.revision="${RELEASE_ID}"
