# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
MetaAgent is an automated meta-analysis manuscript generator. It takes a research question and produces a complete systematic review manuscript with statistics, figures, and references.

## Entry Points

**CLI pipeline** (primary):
```bash
pip install -r requirements.txt
python -m new_meta.main --topic "Your research question" --skip-confirm
python -m new_meta.main --topic "..." --resume /path/to/existing/project  # Resume crashed runs
python -m new_meta.main --topic "..." --analysis-type network              # Network meta-analysis
python -m new_meta.main --topic "..." --polish-manuscript                  # Force full manuscript polish
```

**Web server** (`start.py`): FastAPI + WebSocket server for the production Evimed platform. Connects to a Java backend via WebSocket and Alibaba Cloud OSS. Run with `python start.py`. Uses `deploy.env` for production secrets (OSS keys, Java WS URL, etc.).

## Testing
```bash
# Script-style tests (no pytest, run directly):
python tests/test_deep.py        # 155 deterministic validation checks, no API keys needed
python tests/test_e2e.py         # End-to-end with mocked LLM

# Pytest-collected tests:
pytest tests/                    # All collected tests (excludes test_deep, test_e2e, test_phase_fixes)
pytest tests/test_statistical_edge_behaviors.py -v   # Single test file
pytest tests/test_sprint0_hygiene.py::test_secret_and_runtime_paths_are_gitignored  # Single test
```

## Architecture

**Five-layer separation:**
- **`agents/`** — LLM language tasks: PICO extraction, query building, screening, extraction, RoB, GRADE, writing
- **`engines/`** — Deterministic statistics only (numpy/scipy, zero LLM): effect sizes, pooling, NMA, publication bias, influence diagnostics, visualization
- **`schemas/`** — Pydantic v2 data contracts (`model_validate`, `model_dump`)
- **`core/`** — Infrastructure: LLM client, project/checkpoint management, evidence gate, manuscript polish, artifact packaging, benchmark reproduction
- **`tools/`** — External API wrappers: PubMed E-utilities, PDF download, MeSH/PubChem, multi-database search, reference manager

**Key architectural rules:**
- All statistical computations are numpy/scipy — never call LLM for math
- Effect sizes stored on log scale for OR/RR/HR/IRR; use `meta_engine._to_original(yi, measure)` for reporting
- Pipeline steps are checkpointed; `--resume` resumes from the last completed step
- Checkpoint step IDs (in order): `protocol → search_query → search → ta_screening → pdf_download → pdf_parsing → ft_screening → extraction → rob → effect_sizes → meta_analysis → grade → figures → manuscript`
- `DOWNSTREAM_STEPS` in `core/project.py` declares what gets invalidated when a step is re-run

**EvidenceGate** (`core/evidence_gate.py`): Deterministic gate that runs **after extraction, before RoB/effect sizes**. Decides `META` / `NARRATIVE` / `EVIDENCE_GAP` based on study count, outcome extractability, and PICO matching. All checks are rule-based, no LLM.

**Output language**: Auto-detected from topic text (CJK chars > 15% → `"zh"`); overridden with `--output-language zh|en`.

## Key Design Patterns
- All agents inherit from `BaseAgent` (`core/agent_base.py`) and implement `run()`; LLM access via `self.call_llm()`, `self.call_llm_structured()`, or `self.call_llm_vision()`
- Effect measure types: `OR, RR, RD, MD, SMD, HR, PROP, COR, IRR`
- Model types: `fixed`, `random` (DL/REML/HKSJ — method selected via `protocol.tau_estimator`)
- Interactive decision points: pipeline pauses when search/screening yields few results; gated by `--skip-confirm`
- PubMed author format is `"LastName ForeName"` → `split()[0]` extracts last name

## Configuration
All settings via `.env` file or environment variables (`config.py`). Key variables:
- `LLM_API_KEY` — also reads `DASHSCOPE_API_KEY` as fallback
- `LLM_BASE_URL` — OpenAI-compatible endpoint (default: `https://api.openai.com/v1`); also reads `DASHSCOPE_BASE_URL`
- `LLM_MODEL` — model name (default: `gpt-4o`)
- `MANUSCRIPT_POLISH_ENABLED` — defaults to `False`; set to `1` to enable post-write polish
- `MINERU_TOKEN` — optional, enables better PDF parsing via MinEru API
- `MAX_SEARCH_RESULTS` — default `200`; `MAX_WORKERS` — default `4`

## File Organization
- `main.py`: Pipeline orchestrator — 14 checkpointed steps with interactive decision points
- `config.py`: All env vars with defaults, loads `.env` via `python-dotenv`
- `core/evidence_gate.py`: Deterministic pre-analysis validity check; `GateDecision` enum (`META`/`NARRATIVE`/`EVIDENCE_GAP`)
- `core/artifact_package*.py`: Output packaging for web delivery (citation audit, HTML export, manifest)
- `core/benchmark_*.py`: Benchmark reproduction mode — constrains pooling to expected trial sets
- `core/manuscript_polish.py`: Conservative fact-preserving post-write copyedit
- `engines/meta_engine.py`: Core pooling functions (`fixed_effect`, `random_effects_dl/reml/hksj`)
- `engines/influence.py`: Cook's D, DFBETAS, p-curve, Paule-Mandel τ²
- `tools/multi_search.py`: Semantic Scholar, OpenAlex, citation chaining (not yet wired into main pipeline)
