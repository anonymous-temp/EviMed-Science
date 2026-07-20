FROM debian:bookworm-slim

ARG TARGETARCH
ARG OPENCODE_VERSION=1.17.13
ARG UV_VERSION=0.11.26
ARG OPENCODE_SHA256_AMD64=157afa289d1a8d9372de0ce19ac726119b937a1f6b201808d46f06e4e59bb348
ARG OPENCODE_SHA256_ARM64=bbaccdd374aaab66cd97c7f8ad1c080aa393610fa5f80ee8dfc007f9500afaf9
ARG UV_SHA256_AMD64=6426a73c3837e6e2483ee344cbc00f36394d179afcba6183cb77437e67db4af0
ARG UV_SHA256_ARM64=befa1a59c91e96eb601b0fd9a97c03dd666f17baba644b2b4db9c59a767e387e
ARG OPENCODE_LICENSE_SHA256=625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b
ARG UV_LICENSE_MIT_SHA256=860e3d7a86b84e6a7012c7a635fc64df475cebc6cce34dfeb73a5982ec58176c
ARG GITHUB_DOWNLOAD_PREFIX=
ARG APP_VERSION=0.1.3
ARG RELEASE_ID=untracked
ARG SOURCE_REVISION=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00.000Z

LABEL org.opencontainers.image.title="EviMed OpenCode runtime"
LABEL org.opencontainers.image.description="Server-managed OpenCode runtime image for hosted EviMed workspaces."
LABEL org.opencontainers.image.source="https://github.com/ai4s-research/open-science"
LABEL org.opencontainers.image.version="${RELEASE_ID}"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
LABEL org.opencontainers.image.created="${BUILD_CREATED}"
LABEL io.open-science.app.version="${APP_VERSION}"
LABEL io.open-science.opencode.version="${OPENCODE_VERSION}"
LABEL io.open-science.uv.version="${UV_VERSION}"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    curl \
    fonts-noto-cjk \
    git \
    gzip \
    python-is-python3 \
    python3 \
    python3-venv \
    r-base-core \
    r-recommended \
    socat \
    tar \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) OPENCODE_ARCH="x64"; OPENCODE_SHA256="${OPENCODE_SHA256_AMD64}"; UV_TRIPLE="x86_64-unknown-linux-gnu"; UV_SHA256="${UV_SHA256_AMD64}" ;; \
    arm64) OPENCODE_ARCH="arm64"; OPENCODE_SHA256="${OPENCODE_SHA256_ARM64}"; UV_TRIPLE="aarch64-unknown-linux-gnu"; UV_SHA256="${UV_SHA256_ARM64}" ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  tmp="$(mktemp -d)"; \
  curl_args=(--http1.1 --fail --show-error --location --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 600 --speed-limit 1024 --speed-time 60 --continue-at -); \
  curl "${curl_args[@]}" "${GITHUB_DOWNLOAD_PREFIX}https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${OPENCODE_ARCH}.tar.gz" \
    -o "${tmp}/opencode.tar.gz"; \
  printf '%s  %s\n' "${OPENCODE_SHA256}" "${tmp}/opencode.tar.gz" | sha256sum -c -; \
  tar -xzf "${tmp}/opencode.tar.gz" -C "${tmp}"; \
  install -m 0755 "$(find "${tmp}" -type f -name opencode | head -n 1)" /usr/local/bin/opencode; \
  curl "${curl_args[@]}" "${GITHUB_DOWNLOAD_PREFIX}https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TRIPLE}.tar.gz" \
    -o "${tmp}/uv.tar.gz"; \
  printf '%s  %s\n' "${UV_SHA256}" "${tmp}/uv.tar.gz" | sha256sum -c -; \
  tar -xzf "${tmp}/uv.tar.gz" -C "${tmp}"; \
  install -m 0755 "$(find "${tmp}" -type f -name uv | head -n 1)" /usr/local/bin/uv; \
  curl "${curl_args[@]}" "${GITHUB_DOWNLOAD_PREFIX}https://raw.githubusercontent.com/anomalyco/opencode/v${OPENCODE_VERSION}/LICENSE" \
    -o "${tmp}/opencode-LICENSE"; \
  printf '%s  %s\n' "${OPENCODE_LICENSE_SHA256}" "${tmp}/opencode-LICENSE" | sha256sum -c -; \
  curl "${curl_args[@]}" "${GITHUB_DOWNLOAD_PREFIX}https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}/LICENSE-MIT" \
    -o "${tmp}/uv-LICENSE-MIT"; \
  printf '%s  %s\n' "${UV_LICENSE_MIT_SHA256}" "${tmp}/uv-LICENSE-MIT" | sha256sum -c -; \
  install -d -m 0755 /usr/share/licenses/opencode /usr/share/licenses/uv; \
  install -m 0644 "${tmp}/opencode-LICENSE" /usr/share/licenses/opencode/LICENSE; \
  install -m 0644 "${tmp}/uv-LICENSE-MIT" /usr/share/licenses/uv/LICENSE-MIT; \
  rm -rf "${tmp}"; \
  opencode --version; \
  uv --version

# The hosted notebook kernel and the OpenCode runtime intentionally share one
# reviewed image. Keep the scientific stack pinned so a green image build is
# evidence that production has the same Python/R capabilities tested in CI.
ENV VIRTUAL_ENV=/opt/evimed/venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"
RUN uv venv "${VIRTUAL_ENV}" --python /usr/bin/python3 \
  && uv pip install --python "${VIRTUAL_ENV}/bin/python" --no-cache \
    ipykernel==6.29.5 \
    jupyterlab==4.4.3 \
    matplotlib==3.10.3 \
    numpy==2.2.6 \
    openpyxl==3.1.5 \
    pandas==2.2.3 \
    Pillow==10.4.0 \
    playwright==1.58.0 \
    pypdf==6.7.0 \
    scikit-learn==1.6.1 \
    scipy==1.15.3 \
    statsmodels==0.14.6 \
  && python - <<'PY'
import importlib

for package in ("ipykernel", "jupyterlab", "matplotlib", "numpy", "openpyxl", "pandas", "PIL", "playwright", "pypdf", "sklearn", "scipy", "statsmodels"):
    importlib.import_module(package)
PY
RUN test -x /usr/bin/chromium && python -m playwright --version
RUN Rscript -e 'stopifnot(getRversion() >= "4.0.0", abs(mean(c(1, 2, 3)) - 2) < 1e-12)'

COPY runtime/skills/curated-scientific /usr/local/share/evimed/skills/curated-scientific
COPY runtime/skills/office /usr/local/share/evimed/skills/office

# Smoke every shared curated-skill implementation in the production dependency image.
# The two dedicated matplotlib/statistical-power chains are exercised below.
RUN python3 - <<'PY'
import importlib.util
import json
import pathlib
import tempfile

root = pathlib.Path("/usr/local/share/evimed/skills/curated-scientific")
inventory = json.loads((root / "inventory.json").read_text(encoding="utf-8"))
contracts = inventory["policy"]["delivery"]["executable"]
shared = {
    name: contract
    for name, contract in contracts.items()
    if "../_runtime/execute_skill.py" in contract["entrypoints"]
}
if len(contracts) != 38 or len(shared) != 36:
    raise SystemExit("curated delivery inventory is incomplete")

spec = importlib.util.spec_from_file_location("evimed_curated_executor", root / "_runtime/execute_skill.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    output_root = pathlib.Path(temporary)
    for name, contract in sorted(shared.items()):
        output_dir = output_root / name
        output_dir.mkdir()
        receipt = module.execute(name, module.smoke_request(name), output_dir, None)
        (output_dir / "execution-receipt.json").write_text(
            json.dumps(receipt, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        if receipt["skill"] != name or receipt["status"] not in {"success", "warning"}:
            raise SystemExit(f"curated smoke failed: {name}")
        for artifact in contract["artifacts"]:
            path = output_dir / artifact
            if not path.is_file() or path.stat().st_size == 0:
                raise SystemExit(f"curated smoke artifact missing: {name}/{artifact}")
print(f"smoked {len(shared)} shared curated skill implementations")
PY

RUN set -eux; \
  export MPLBACKEND=Agg; \
  tmp="$(mktemp -d)"; \
  python3 /usr/local/share/evimed/skills/curated-scientific/matplotlib/scripts/plot_template.py --plot-type line --output "${tmp}/figure.png"; \
  python3 /usr/local/share/evimed/skills/curated-scientific/matplotlib/scripts/plot_template.py --plot-type line --output "${tmp}/figure.svg"; \
  test -s "${tmp}/figure.png"; \
  test -s "${tmp}/figure.svg"; \
  python3 /usr/local/share/evimed/skills/curated-scientific/statistical-power/scripts/export_power_analysis.py --output-dir "${tmp}/power"; \
  test -s "${tmp}/power/power-analysis.md"; \
  test -s "${tmp}/power/power-curve.csv"; \
  test -s "${tmp}/power/power-curve.png"; \
  python3 /usr/local/share/evimed/skills/office/docx/scripts/create_docx.py --text "EviMed" --output "${tmp}/document.docx"; \
  python3 /usr/local/share/evimed/skills/office/pdf/scripts/create_pdf.py --text "EviMed" --output "${tmp}/document.pdf"; \
  python3 /usr/local/share/evimed/skills/office/pptx/scripts/create_pptx.py --title "EviMed" --body "Evidence" --output "${tmp}/presentation.pptx"; \
  printf 'name,value\ncontrol,1\n' > "${tmp}/input.csv"; \
  python3 /usr/local/share/evimed/skills/office/xlsx/scripts/create_xlsx.py --input "${tmp}/input.csv" --output "${tmp}/workbook.xlsx"; \
  python3 -c 'import pathlib,sys,zipfile; files=[pathlib.Path(sys.argv[1])/name for name in ("document.docx","presentation.pptx","workbook.xlsx")]; [zipfile.ZipFile(file).testzip() for file in files]' "${tmp}"; \
  rm -rf "${tmp}"

ENV PYTHONUNBUFFERED=1
ENV XDG_CONFIG_HOME=/runtime/xdg-config
ENV XDG_DATA_HOME=/runtime/xdg-data
ENV XDG_CACHE_HOME=/runtime/xdg-cache
ENV XDG_STATE_HOME=/runtime/xdg-state
ENV HOME=/runtime/home

COPY deploy/runtime-opencode/open-science-opencode-serve.sh /usr/local/bin/open-science-opencode-serve
RUN chmod 0755 /usr/local/bin/open-science-opencode-serve

WORKDIR /workspace
VOLUME ["/workspace", "/runtime"]

CMD ["opencode", "--version"]
