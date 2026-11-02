# Research: general scientific analysis on DeepSeek and DSH

Date: 2026-11-02 (Asia/Shanghai).
Goal: improve the existing analyst and expose a reusable API without rebuilding the agent kernel.

## Questions
- Which existing platform routes already provide authenticated runs, files, events and continuation?
- What do scientific-agent benchmarks measure beyond successful execution?
- Which mature products expose data connections, reproducibility, tables and figures?
- Which public and locally available biomedical datasets provide defensible reference answers?
- How can analysis work be isolated while preserving multi-turn state?

## Findings
Pending research.

## Sources
Sources and access dates will be retained as evidence, with product claims separated from measured behavior.

### Research round 1
- BixBench evaluates multi-step biological analysis and interpretation, not merely code execution. Primary source: https://arxiv.org/abs/2503.00096 and https://www.futurehouse.org/research/bixbench (accessed 2026-11-02).
- Data Interpreter motivates dependency-aware task graphs and iterative execution checks; our existing optional analysis_session graph already addresses this boundary, so no new orchestrator is justified. https://arxiv.org/abs/2402.18679 (accessed 2026-11-02).
- Hex documents natural-language notebook work over Python, SQL and charts with file/data connections. This supports discoverable outputs and source context, not copying a second notebook UI. https://learn.hex.tech/docs/explore-data/notebook-view/notebook-agent and https://learn.hex.tech/docs/getting-started/develop-your-notebook (accessed 2026-11-02).
- Follow up primary studies ChatDA, BixBench3 and SciVisAgentBench, and Julius official API documentation. Search snippets are leads, not validated performance claims.

### Research round 2
- BixBench3 expands evaluation to research-study-scale analyses (published 2026-08-26, revised 2026-09-22). We will borrow multi-stage/artifact evaluation principles, not claim scores on its full suite. https://arxiv.org/abs/2608.25286
- SciVisAgentBench explicitly evaluates scientific visualization; our acceptance must check figure files, underlying plotted data, labels and retrieval, not just successful JSON. https://arxiv.org/abs/2603.29139
- UCI Heart Failure Clinical Records has 299 patients and a CC BY 4.0 license; follow-up duration is not a baseline mortality predictor. Source and license: https://archive.ics.uci.edu/dataset/519/heart+failure+clinical+records
- MIMIC-IV Demo 2.2 is open access, unlike the full credentialed dataset. Use only the demo if a multi-table public fixture is needed. https://physionet.org/content/mimic-iv-demo/2.2/
- Local discovery found Desktop/data including deidentified tables and a large TCM Parquet file. Only local aggregate inspection is authorized for sensitive rows; model-backed cases will use public or synthetic datasets, unless an existing controlled data route prevents private-row transmission.

### Stage summary
Retain DSH as the single agent runtime; strengthen data boundaries, numerical/semantic verification and typed output delivery. Do not build an algorithm catalogue or equate an installed scientific library with validated product coverage. A dedicated analysis project using the existing per-project runtime is the smallest reliable isolation unit; continuations reuse that project's state.

### Research round 3
- Julius official docs organize files, containers, plotting and downloads around one conversation. Adopt that connected workflow through the existing native DSH UI, keeping the interface API-first instead of adding a second composer. https://julius.ai/docs/llms.txt and https://julius.ai/docs/get-started/welcome (accessed 2026-11-02).
- Hex documents API data import and stored secrets. EviMed's stronger existing boundary keeps provider and source credentials in the control plane; expose a configured source ID rather than arbitrary auth headers in model prompts. https://learn.hex.tech/docs/connect-to-data/import-data-via-api (accessed 2026-11-02).
- BixBench3 grades generated artifacts against study artifacts; SciVisAgentBench combines deterministic checks with visualization review. We will separate execution, numerical agreement, semantic interpretation, figure validity, continuation and isolation verdicts. These benchmarks inform test design; no full benchmark performance is asserted.

### Research round 4
- BLADE treats variable definitions, transformations and model choices as independently assessable scientific decisions; multiple valid methods must not be graded against one arbitrary algorithm. https://arxiv.org/abs/2408.09667 and https://blade-bench.github.io/ (accessed 2026-11-02).
- Anthropic's life-sciences product describes existing code execution combined with domain skills and connectors. This is vendor positioning, not independent accuracy evidence. https://www.anthropic.com/news/claude-for-life-sciences (accessed 2026-11-02).
- Decision: retain the existing analysis agent, native Python/R and scientific skills; add only a versioned API facade, controlled data import, durable ownership and output manifests. Public fixtures and deterministic references measure numerical correctness; natural-language real-model cases measure interpretation and recovery separately.

### Verified product and dataset details
Julius documents CSV/Excel/JSON/Parquet and plots using Matplotlib/Seaborn/Plotly; downloadable and interactive results are core output forms. We retain static scientific figures plus optional HTML downloads, with plotted data attached. Sources: https://julius.ai/docs/get-started/files and https://julius.ai/docs/get-started/data-visualizations (2026-11-02).

UCI Heart Failure CSV was downloaded from the official archive (12,239 bytes, SHA-256 9c73cea7468ff5d517801ec050fe9993da5912fce4b56f296f8df3b38dd75912); attribution DOI 10.24432/C5Z89R, CC BY 4.0. Evaluation separates follow-up time/censoring from baseline predictors.

Local aggregate inspection found 810 admissions across 508 patient keys and 503 demographic patient keys: a five-patient left-join gap. The 58,062-row TCM Parquet contains literature chunks and embeddings, not clinical outcomes. These facts become data-semantics controls; patient rows and source text remain local.

### Candidate finding and response
The first real Linux diagnostic run completed and correctly declined to treat a nonsignificant variance diagnostic as proof. It nevertheless expanded a ten-row comparison into many alternative tests and power simulations (83 tool calls), and described ordinary label permutation too broadly. Preserve this attempt. Tighten proportional-work/stopping guidance and null/exchangeability wording, then rerun the case. SciPy's documented independent permutation null is sampling from the same distribution: https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.permutation_test.html (accessed 2026-11-02). Numerical agreement alone is insufficient to close interpretation findings.

### Scientific review findings retained
The first heart-failure API case has correct landmark estimates but an invalid full-curve presentation: its generated event-only table retains 30 of 203 censorings and stops at day 241 instead of 285. Record figure semantics as failed. Add full-timeline/event/censor/risk-set checks and require source-library timelines, then replay. The paired report also overstated signed-rank as an unconditional median test; the heart report confused finite-cohort missing-outcome scenarios with population bounds and treated unique rows as proof of independence. Clarify these classes in the skill rather than adding new algorithm-selection machinery. Both original attempts remain preserved.

## Implemented evaluation outcome

The candidate retains the existing DeepSeek + DSH execution path and native composer. The API is a bounded authenticated facade, with file/HTTPS/configured-source inputs and immutable versioned outputs. Real tests exposed errors beyond primary statistics: truncated censor timelines, a Greenwood scale label, conversion metadata corruption, missing nested figures and historical bundles overriding current results. These defects have targeted implementation corrections and independent regressions. The public attempt ledger retains all execution failures and scientific interpretation findings; artifact readability and primary numeric agreement are not a blanket scientific pass. This delivery is source/code/evidence plus a branch push, with no deployment.
