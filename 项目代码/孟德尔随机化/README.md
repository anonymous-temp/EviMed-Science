# Mendelian Randomization Service

Python 服务默认使用 DeepSeek V4 的两档模型路由：意图、翻译和实体提取使用 Flash，科研推理、结果解读和报告生成使用 Pro。

## 本地配置

直接在项目原有的 `.env` 中配置：

```dotenv
DEEPSEEK_API_KEY=your_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
DEEPSEEK_PRO_MODEL=deepseek-v4-pro
```

Keep `.env` local and untracked. Commit only `.env.example`; each deployment
must inject its own credentials.

## 启动与验证

```bash
python start.py
curl http://127.0.0.1:8003/health
python -m pytest tests/test_deepseek_routing.py -q
python -m compileall mr_agent start.py
```

## Local summary-statistics analysis

`mr_agent.tools.mr_executor.run_mr_local` accepts paired `DataSource` objects.
Local exposure files use OpenGWAS LD clumping by default. A failed clumping
request stops analysis; it never silently substitutes unselected instruments.

For an already selected instrument set, set `instruments_preclumped=True` and
provide `clumping_provenance` identifying the source and its selection method.
This is a declared input property, not independent LD verification. The engine
records it in `instrument-selection.json` and the report states that LD was not
rechecked. Two local files in this mode require no OpenGWAS API request. The
hosted MCP accepts paired `exposureSource` / `outcomeSource` objects. The adapter
binds uploaded workspace-relative CSV/TSV files at admission, safely reopens them
in its worker and supplies standard-column job copies plus
`mendelian-randomization-inputs.json` to the fixed runner. The isolated adapter worker sends the authoritative preparation snapshot through
an anonymous pipe, and publishes artifacts through held directory descriptors.
The runner checks the manifest against that authority before and after analysis;
the editable manifest itself is never the trust root. Uploaded source objects
require the isolated hosted adapter; the same-container MCP fallback retains
legacy text requests only.
Explicit column mappings and boolean clumping declarations are required; a
bidirectional no-JWT analysis needs independent preclumped declarations and
provenance for both roles. Original uploads are preserved.

MR-PRESSO permutation bounds are represented by `presso_global_pval` together
with `presso_global_pval_relation` (`=` or `<`); consumers must preserve that
relation instead of rendering an upper bound as an exact p-value. Radial MR
reports the heterogeneity Q-test probability and the number of outlier rows,
not the causal-effect probability or the number of data-frame columns.


Hosted MR queue authority lives under the project's protected
`.openscience/mr-jobs` metadata, outside the customer's workspace/runtime mounts.
It is scoped to the authenticated account, project, active workspace and private
generation. Workspace JSON files are never imported as accepted queue records.
The original request, input bindings and source evidence are immutable; ordinary
status reads the same protected record. Account/project deletion removes this
metadata with the existing project tree.

## Portable local analysis replay

Paired local inputs with a declared-preclumped exposure produce an explicit
`analysis-data/<pair>/replay/` package in the fixed runner's returned artifacts.
It contains the exact CSV bytes used for analysis, the generated `analysis.R`
from the existing statistical template, and `run.R`, which is also the entry
executed in the original run. No remote extraction script is published.

`options.json` records column mappings, requested thresholds, the first threshold
actually used by the local engine, supplied instrument-selection declarations,
and the random seed. `run_mr_local(..., seed=73421)` uses that default seed before
analysis; callers may explicitly choose another nonnegative R integer seed.
`observed-environment.json` records the observed R version, platform, package
versions, RNG kinds and TwoSampleMR method/parameter defaults. The manifest
records byte counts, SHA-256 and MD5 digests of package files and original
outputs. Digests detect changes; they are not signatures or independent source
verification. The hosted input manifest and its original-upload provenance
remain separate and unchanged.

Copy the whole replay directory to a clean location, then run:

```bash
Rscript --vanilla run.R
```

The command also works with a path to `run.R` from another working directory.
It verifies package file digests and writes a new `results/` directory beside
the entry; it refuses to overwrite an existing `results/`. No Python service,
model, OpenGWAS JWT or network request is required. R and the recorded packages
must already be installed and discoverable by R (use `R_LIBS_USER` if needed).
Core dependencies are TwoSampleMR, ieugwasr, jsonlite and their dependencies;
MRPRESSO, RadialMR and MendelianRandomization enable the corresponding optional
sensitivity analyses. Use the recorded versions and platform to compare
seed-sensitive results. Version differences are reported with a warning and a
new environment receipt; unavailable sensitivity methods remain explicit skips.

This package covers local analysis of the supplied instrument set, including
the existing harmonization, primary methods and sensitivity analyses. It does
not independently verify LD selection, reproduce remote or mixed-source
extraction, establish cohort independence, or regenerate the model-written
manuscript. A reverse-direction package requires its exposure to have its own
preclumped declaration and provenance. Only claim a delivered replay package
when its complete manifest and files appear in the returned artifacts.
