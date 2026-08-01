ARG PYTHON_BASE_IMAGE=docker.m.daocloud.io/library/python:3.10-slim-bookworm
FROM ${PYTHON_BASE_IMAGE}

ARG APP_VERSION=1.0.0
ARG APT_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG GITHUB_DOWNLOAD_PREFIX=
ARG CRAN_MIRROR=https://cloud.r-project.org

LABEL org.opencontainers.image.title="EviMed Specialist Adapter" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    MPLCONFIGDIR=/tmp/matplotlib \
    EVIMED_AGENT_ROOT=/agent \
    EVIMED_DATA_ROOT=/data \
    LLM_MODEL=deepseek-v4-pro \
    LLM_ENABLE_THINKING=true \
    LLM_REASONING_EFFORT=high

RUN set -eux; \
    sed -ri "s|https?://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|https?://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl fonts-noto-cjk; \
    rm -rf /var/lib/apt/lists/*

ARG AGENT_KIND
RUN set -eux; \
    if [ "${AGENT_KIND}" = "mendelian-randomization" ] \
      || [ "${AGENT_KIND}" = "peer-review" ] \
      || [ "${AGENT_KIND}" = "drug-safety-analysis" ]; then \
      apt-get update; \
    fi; \
    if [ "${AGENT_KIND}" = "mendelian-randomization" ]; then \
      apt-get install -y --no-install-recommends \
        build-essential git libcurl4-openssl-dev libfontconfig1-dev libssl-dev libuv1-dev libxml2-dev \
        r-base-core r-recommended r-cran-cowplot r-cran-data.table r-cran-dplyr \
        r-cran-ggplot2 r-cran-glmnet r-cran-httr r-cran-jsonlite r-cran-magrittr \
        r-cran-mnormt r-cran-psych r-cran-remotes r-cran-reshape2 \
        libgmp-dev gfortran libblas-dev liblapack-dev \
        r-cran-rcpparmadillo r-cran-quantreg r-cran-robustbase r-cran-sparsem \
        r-cran-matrixmodels r-cran-gmp r-cran-plotly r-cran-boot \
        r-cran-lavaan r-cran-gdata r-cran-stringr r-cran-tidyr r-cran-tibble \
        r-cran-tidyselect r-cran-rlang r-cran-matrix; \
    fi; \
    if [ "${AGENT_KIND}" = "peer-review" ]; then \
      apt-get install -y --no-install-recommends poppler-utils; \
    fi; \
    if [ "${AGENT_KIND}" = "drug-safety-analysis" ]; then \
      apt-get install -y --no-install-recommends libreoffice-writer; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /adapter
ARG AGENT_DIR
COPY OpenScience/deploy/specialist-adapter/requirements.txt /tmp/adapter-requirements.txt
COPY ${AGENT_DIR}/requirements.txt /tmp/agent-requirements.txt
RUN pip install --index-url "${PIP_INDEX_URL}" --no-cache-dir -r /tmp/agent-requirements.txt \
    && pip install --index-url "${PIP_INDEX_URL}" --no-cache-dir -r /tmp/adapter-requirements.txt \
    && rm -f /tmp/adapter-requirements.txt /tmp/agent-requirements.txt

COPY ${AGENT_DIR} /agent

# The agent's own installer is the single source of truth for the R environment,
# and it verifies every package loads and that the TwoSampleMR pin survived
# before it exits. A second list here is what let the image ship three GitHub
# packages while the analysis templates called seven, so the modes that needed
# the other four failed only at run time.
#
# This runs after the agent source is copied, so any change to that source
# rebuilds the R layer. Keeping the list in one place is worth more than the
# cache: the two lists silently diverged for as long as they both existed.
RUN if [ "${AGENT_KIND}" = "mendelian-randomization" ]; then \
      R_LIB_TARGET=/usr/local/lib/R/site-library \
      CRAN_MIRROR="${CRAN_MIRROR}" \
      GITHUB_DOWNLOAD_PREFIX="${GITHUB_DOWNLOAD_PREFIX}" \
      Rscript /agent/install_r_packages.R; \
    fi

COPY OpenScience/deploy/specialist-adapter/evimed_specialist_adapter ./evimed_specialist_adapter

RUN python -m compileall -q /adapter/evimed_specialist_adapter /agent \
    && test -f /agent/evimed_runner.py \
    && if [ "${AGENT_KIND}" = "mendelian-randomization" ]; then \
         PYTHONPATH=/agent python -c 'from mr_agent.output.figures import format_summary_card; assert callable(format_summary_card)'; \
       fi

VOLUME ["/data"]
EXPOSE 8025
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import json,urllib.request; value=json.load(urllib.request.urlopen('http://127.0.0.1:8025/health', timeout=3)); raise SystemExit(0 if value.get('ready') else 1)"

CMD ["uvicorn", "evimed_specialist_adapter.service:app", "--host", "0.0.0.0", "--port", "8025", "--no-access-log"]
