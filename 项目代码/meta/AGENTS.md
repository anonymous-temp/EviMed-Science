# AGENTS.md — Project Instructions for MetaAgent

## Project Overview
MetaAgent is an automated meta-analysis manuscript generator. It takes a research question and produces a complete systematic review manuscript with statistics, figures, and references.

## Build & Run
```bash
pip install -r requirements.txt
python -m new_meta.main --topic "Your research question" --skip-confirm
python -m new_meta.main --topic "..." --resume /path/to/existing/project  # Resume crashed runs
```

## Architecture
- **LLM agents** (`agents/`): Handle language tasks (PICO extraction, screening, extraction, RoB, GRADE, writing)
- **Deterministic engines** (`engines/`): Handle all statistics (effect sizes, pooling, NMA, publication bias, influence diagnostics) — numpy/scipy only, no LLM
- **Schemas** (`schemas/`): Pydantic v2 models for all data structures
- **Core** (`core/`): LLM client, project management, checkpointing

## Key Design Principles
- LLM-for-language, deterministic-for-math separation
- All statistical computations are numpy/scipy with no LLM involvement
- Pipeline steps are checkpointed; `--resume` skips completed steps
- Interactive decision points: when results are few at search/screening stages, the pipeline pauses with LLM-powered advice and lets the user adjust topic, continue, or abort (gated by `--skip-confirm`)
- Effect sizes stored on log scale for OR/RR/HR/IRR; `_to_original()` for reporting
- PubMed author format is "LastName ForeName" → `split()[0]` extracts last name

## Testing
```bash
python tests/test_deep.py   # 155 deterministic validation checks
python tests/test_e2e.py    # End-to-end with mocked LLM
```

## Common Patterns
- Effect measure types: OR, RR, RD, MD, SMD, HR, PROP, COR, IRR
- Model types: fixed, random (DL/REML/HKSJ via `protocol.tau_estimator`)
- Schemas use Pydantic v2 (`model_validate`, `model_dump`)
- All agents inherit from `BaseAgent` and implement `run()`

## File Organization
- `main.py`: Pipeline orchestrator (13 steps with checkpoint guards + interactive decision points)
- `config.py`: All env vars with defaults, loads `.env` via `python-dotenv`
- `engines/meta_engine.py`: Core pooling functions (fixed_effect, random_effects_dl/reml/hksj)
- `engines/influence.py`: Cook's D, DFBETAS, p-curve, Paule-Mandel τ²
- `tools/multi_search.py`: Semantic Scholar, OpenAlex, citation chaining (not yet wired into main pipeline)


<claude-mem-context>
# Memory Context

# [meta] recent context, 2026-05-31 9:31pm GMT+8

No previous sessions found.
</claude-mem-context>