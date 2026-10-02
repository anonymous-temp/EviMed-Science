# vcr-engine — the deterministic statistics and simulation engine for
# 「虚拟临研」 (plan §11.4).
#
# Hidden knowledge:
#
# - **R version and package versions are both pinned, and the build proves
#   it.** Two locks, one rule: a lock lists every package the build installs
#   into the site library -- the whole Depends/Imports/LinkingTo closure, not
#   only the names the code loads -- at an exact version, and the verification
#   step fails the build on a package that is missing, at another version, or
#   installed without being listed. A lock file nobody checks is a comment.
#     `R/package-lock.json` is the runtime lock: what `R/*.R` needs at run
#     time (jsonlite, digest, mvtnorm, synthpop, and their closure). Its
#     package list is what `packageLockHash` in every manifest hashes.
#     `tests/package-lock.crosscheck.json` is the cross-check lock: what the
#     numeric acceptance cases load to check the engine against other software
#     (rpact, gsDesign, WeightIt, cobalt, MatchIt, RBesT, metafor, EValue, ...),
#     minus what the runtime lock already holds.
# - **The default image is the lean runtime.** It installs the runtime lock
#   only and does not copy tests/. `--build-arg WITH_CROSSCHECK=1` builds the
#   CI test image, which also installs the cross-check lock (and the system
#   libraries only it needs); CI mounts the cases rather than baking them in:
#     docker run --rm -e VCR_TEST_CORES=2 \
#       -v "$PWD/tests:/opt/vcr-engine/tests:ro" \
#       --entrypoint /opt/vcr-engine/tests/run_all.sh <image>
# - **Base and recommended packages are in neither lock.** They ship inside
#   the pinned R (survival, MASS, Matrix, nlme, lattice, rpart, nnet, ...),
#   move only with `R_BASE_IMAGE`, and the locks' `rVersion` records which.
#   The install step never installs one, and the checks refuse a lock that
#   lists one and a site library that shadows one: a dated snapshot serves
#   their newest versions (MASS and Matrix there already require R 4.4), and a
#   shadowing copy would make the version a case ran against depend on
#   library order rather than on the pin.
# - **The locks are read with python3, not R.** jsonlite is itself in the
#   runtime lock, so no R JSON reader exists before the first install.
# - **Package versions come from a dated snapshot, not from "latest".** The
#   Posit public package manager serves CRAN as of a date; plain
#   `install.packages` on a build a month later silently picks up WeightIt 2.1
#   or cobalt 5.1 and every cross-software case shifts. The date is the pin.
# - **Mirrors are build arguments** because the production host cannot reach
#   the Ubuntu archives, CRAN or PyPI directly (the same reason every other
#   image takes `APT_MIRROR` / `CRAN_MIRROR` / `PIP_INDEX_URL`). Trust does
#   not move with the URL: the version checks below check whatever any mirror
#   served.
# - **No model client, no secret, no network egress at run time.** The engine
#   opens exactly the files a job names under the read-only /data-plane. The
#   token and the receipt key are files compose mounts and names in
#   VCR_ENGINE_TOKEN_FILE / VCR_ENGINE_RECEIPT_KEY_FILE; none is set here, and
#   without them the service refuses to start.
# - **One BLAS thread.** The core ceiling is VCR_ENGINE_CORES, applied by the
#   engine; a BLAS that spawned its own threads would take cores nobody
#   granted and make a job's CPU seconds a function of the host.
# - **Runs as a non-root user with a read-only root filesystem in mind**: the
#   only writable paths are the job work directory (/jobs, uid 10001) and
#   /tmp, which is why the R library lives under /opt and the self-check runs
#   at build time.
#
# R 4.3.3 on Ubuntu 22.04, including its recommended packages. r-base:4.3.3
# carries Debian testing: installing Python there years later partially
# upgrades the distribution. The digest fixes both R and the underlying OS;
# a registry mirror may replace the registry but must preserve this digest.
ARG R_BASE_IMAGE=docker.io/rocker/r-ver:4.3.3@sha256:732d15020af326da9e919c07f70ca32bf5d3e409220af32e0a4b6d0a89437309
FROM ${R_BASE_IMAGE}

ARG APT_MIRROR=http://archive.ubuntu.com/ubuntu
ARG UBUNTU_SECURITY_MIRROR=http://security.ubuntu.com/ubuntu
ARG UBUNTU_PORTS_MIRROR=http://ports.ubuntu.com/ubuntu-ports
ARG PIP_INDEX_URL=https://pypi.org/simple
# A dated CRAN snapshot: the versions in both locks are the ones this date
# serves. Moving the date is a numerics change and reruns tests/run_all.sh.
ARG CRAN_SNAPSHOT_DATE=2026-09-28
ARG CRAN_MIRROR=https://packagemanager.posit.co/cran/${CRAN_SNAPSHOT_DATE}
# 0 = the lean runtime image; 1 = the CI test image with the cross-check lock.
ARG WITH_CROSSCHECK=0
ARG R_BUILD_NCPUS=1

ENV DEBIAN_FRONTEND=noninteractive \
    R_LIBS_SITE=/opt/vcr-rlib \
    VCR_R_LIBS=/opt/vcr-rlib \
    VCR_ENGINE_ROOT=/opt/vcr-engine \
    VCR_ENGINE_WORK_DIR=/jobs \
    VCR_ENGINE_DATA_ROOT=/data-plane \
    VCR_ENGINE_CORES=1 \
    VCR_ENGINE_MAX_REPLICATES=200000 \
    OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=UTC

ENV PATH=/opt/vcr-venv/bin:${PATH}

COPY scripts/configure-apt.sh /usr/local/bin/vcr-configure-apt

# System libraries. The runtime closure needs only a compiler toolchain (the
# base image ships make, g++ and gfortran) and ICU for stringi. The
# cross-check closure adds curl, xml2, V8 (RBesT's chain), fs and
# RcppParallel's build; the build fails loudly if the mirror omits any of them
# rather than degrading to a package set that silently drops a case.
RUN set -eux; \
    . /etc/os-release; \
    test "${ID}:${VERSION_CODENAME}" = "ubuntu:jammy"; \
    Rscript -e 'stopifnot(as.character(getRversion()) == "4.3.3")'; \
    sh /usr/local/bin/vcr-configure-apt; \
    case "${WITH_CROSSCHECK}" in \
      0) extra="" ;; \
      1) extra="libcurl4-openssl-dev libssl-dev libxml2-dev libv8-dev libuv1-dev cmake" ;; \
      *) echo "WITH_CROSSCHECK must be 0 or 1" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates python3 python3-venv libicu-dev ${extra}; \
    python3 -m venv /opt/vcr-venv; \
    rm -rf /var/lib/apt/lists/*

COPY R/package-lock.json /tmp/vcr-locks/runtime.json
COPY tests/package-lock.crosscheck.json /tmp/vcr-locks/crosscheck.json

# 1. python3 checks the locks' shape (exactly rVersion + packages, each entry
#    exactly package + version, one rVersion, no package twice) and flattens
#    the selected locks to "rVersion" then "package<TAB>version" lines.
# 2. R refuses a lock entry that ships with R, then installs exactly the listed
#    names from the dated snapshot. `type = "source"` because the snapshot
#    serves binaries only for some distributions and a silent fallback to a
#    different build is the class of thing this file exists to prevent.
#    A failed package only warns in install.packages; step 3 is the gate.
# 3. R verifies: the R version is the locks' rVersion; every listed package is
#    installed in the site library at exactly its version; the site library
#    holds nothing else (no dependency arrived unlisted); and, with the
#    library order run_job.R uses, every listed package loads from the site
#    library and every base or recommended one from R's own -- which is the
#    property that matters when a base image configures additional libraries.
# Inside R the path is read from VCR_R_LIBS, which is always one directory.
RUN set -eux; \
    locks="/tmp/vcr-locks/runtime.json"; \
    if [ "${WITH_CROSSCHECK}" = "1" ]; then locks="${locks} /tmp/vcr-locks/crosscheck.json"; fi; \
    python3 -c 'import json, sys; \
      paths = sys.argv[1:]; \
      locks = [json.load(open(path, encoding="utf-8")) for path in paths]; \
      entry_ok = lambda e: isinstance(e, dict) and set(e) == {"package", "version"} and all(isinstance(v, str) and v for v in e.values()); \
      shape_ok = all(isinstance(l, dict) and set(l) == {"rVersion", "packages"} and isinstance(l["packages"], list) and all(map(entry_ok, l["packages"])) for l in locks); \
      shape_ok or sys.exit("a lock holds exactly rVersion and packages, each entry exactly package and version"); \
      versions = {l["rVersion"] for l in locks}; \
      len(versions) == 1 or sys.exit("the locks name different R versions"); \
      names = [e["package"] for l in locks for e in l["packages"]]; \
      len(names) == len(set(names)) or sys.exit("a package is listed twice across the locks"); \
      print(versions.pop()); \
      [print(e["package"] + "\t" + e["version"]) for l in locks for e in l["packages"]]' \
      ${locks} > /tmp/vcr-locks/want.tsv; \
    mkdir -p "${VCR_R_LIBS}"; \
    Rscript -e 'lines <- readLines("/tmp/vcr-locks/want.tsv"); \
      want <- do.call(rbind, strsplit(lines[-1], "\t", fixed = TRUE)); \
      shipped <- rownames(installed.packages(lib.loc = .Library, priority = c("base", "recommended"))); \
      clash <- intersect(want[, 1], shipped); \
      if (length(clash)) stop("a lock lists packages that ship with R: ", paste(clash, collapse = ", ")); \
      install.packages(want[, 1], lib = Sys.getenv("VCR_R_LIBS"), repos = c(CRAN = Sys.getenv("CRAN_MIRROR")), \
                       type = "source", dependencies = NA, Ncpus = as.integer(Sys.getenv("R_BUILD_NCPUS", "2")))'; \
    Rscript -e 'site <- normalizePath(Sys.getenv("VCR_R_LIBS")); \
      .libPaths(c(site, .libPaths())); \
      lines <- readLines("/tmp/vcr-locks/want.tsv"); \
      stopifnot(identical(paste0(R.version$major, ".", R.version$minor), lines[1])); \
      want <- do.call(rbind, strsplit(lines[-1], "\t", fixed = TRUE)); \
      inst <- installed.packages(lib.loc = site)[, "Version"]; \
      got <- unname(inst[want[, 1]]); \
      differs <- !is.na(got) & got != want[, 2]; \
      shipped <- rownames(installed.packages(lib.loc = .Library, priority = c("base", "recommended"))); \
      from <- function(p) normalizePath(dirname(find.package(p))); \
      astray <- c(Filter(function(p) from(p) != site, want[!is.na(got), 1]), \
                  Filter(function(p) from(p) != normalizePath(.Library), shipped)); \
      bad <- c(sprintf("%s missing", want[is.na(got), 1]), \
               sprintf("%s is %s, lock says %s", want[differs, 1], got[differs], want[differs, 2]), \
               sprintf("%s is installed but no lock lists it", setdiff(names(inst), want[, 1])), \
               sprintf("%s would load from %s", astray, vapply(astray, from, ""))); \
      if (length(bad)) stop("package lock mismatch:\n", paste(bad, collapse = "\n")); \
      cat("package lock verified:", nrow(want), "packages\n")'; \
    rm -rf /tmp/vcr-locks

COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --no-cache-dir \
      --index-url "${PIP_INDEX_URL}" -r /tmp/requirements.txt

WORKDIR /opt/vcr-engine
COPY R/ ./R/
COPY service/ ./service/
COPY README.md ./

# Self-check at build time, from R/ alone (tests/ is not in this image): the
# engine's method registry must agree with the generated snapshot of
# @evimed/domain. A mismatch here is a mismatch the control plane would
# otherwise discover by queueing a job nothing answers.
RUN set -eux; \
    Rscript -e '.libPaths(c(Sys.getenv("VCR_R_LIBS"), .libPaths())); \
      source("/opt/vcr-engine/R/engine.R"); vcr_engine_load("/opt/vcr-engine"); \
      h <- vcr_engine_health(); \
      if (!isTRUE(h$ok)) stop("engine self-check failed: ", jsonlite::toJSON(h$issues, auto_unbox = TRUE)); \
      cat("engine", h$engineVersion, h$rVersion, "with", length(h$methods), "methods\n")'

# /jobs is the work directory (a named volume in compose, initialised from
# this directory and so owned by vcr); /data-plane is the mount point of the
# read-only patient data and stays root's.
RUN set -eux; \
    useradd --system --create-home --uid 10001 vcr; \
    mkdir -p /jobs /data-plane; \
    chown vcr:vcr /jobs; \
    chmod 0700 /jobs

USER vcr
EXPOSE 8080

# Global concurrency is one, in the application (a single worker thread) and
# here (a single uvicorn worker). Two workers would give two queues and make
# both the CPU ceiling and the "one job at a time" rule untrue.
CMD ["python3", "-m", "uvicorn", "service.app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]

ARG BUILD_CREATED
ARG RELEASE_ID
ARG SOURCE_REVISION
LABEL org.opencontainers.image.title="vcr-engine" \
      org.opencontainers.image.description="Deterministic statistics and simulation engine for EviMed 虚拟临研" \
      org.opencontainers.image.created="${BUILD_CREATED}" \
      org.opencontainers.image.version="${RELEASE_ID}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
