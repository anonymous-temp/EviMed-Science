# MetaAgent

MetaAgent is an automated systematic-review and meta-analysis manuscript agent.
Give it one research topic; it plans the review, searches and screens the literature,
retrieves full text, extracts source-linked results, selects the validated statistical
route, generates figures and references, and writes a complete editable article.

The product surface is deliberately small. It does not ask users to configure a
workflow, approve an internal release, or manage statistical plugins.

## Run it

Requirements: Python 3.10–3.12 and an OpenAI-compatible LLM API.

```bash
python -m pip install -r requirements.txt
export LLM_API_KEY="your-api-key"
export LLM_BASE_URL="https://api.openai.com/v1"
export LLM_MODEL="your-model"

metaagent --topic "Incidence of catheter-related bloodstream infection in adults"
```

The normal mode proceeds automatically and pauses only when a defensible analysis
cannot be chosen uniquely:

- methodological certainty contains context-dependent domains; or
- multiple clinically distinct analysis sets could define the primary synthesis.

In either case MetaAgent returns two or three concise options with a recommended
choice. After the user selects an option, the same project resumes and writes the
article.

For a fully unattended run, use the documented conservative defaults:

```bash
metaagent --topic "Incidence of catheter-related bloodstream infection in adults" --skip-confirm
```

`--skip-confirm` ranks ambiguous analysis sets against the protocol-defined primary
outcome and applies the conservative recommended certainty option. The article says
when that fallback was used.

Automatic full-text retrieval runs before any upload request. MetaAgent tries open
PDF sources and verified Europe PMC full text. Abstract-only and metadata-only
records cannot supply quantitative extraction. If no usable full text exists, the
project stops at a resumable checkpoint and asks for source files instead of
inventing data.

## Production-released quantitative scope

Each released capability has deterministic numpy/scipy computation, typed inputs,
source-verification gates, edge-case tests, and an independent numerical reference
corpus.

| Review type | Released scope | Primary model |
|---|---|---|
| Pairwise parallel-group RCT | Aggregate dichotomous, continuous, time-to-event, and count outcomes | Fixed effect or REML/HKSJ random effects |
| Design-aware RCT | Cluster RCTs with adjusted precision or ICC/design effect, paired crossover estimates, and covariance-resolved multi-arm contrasts | Study-independent REML with HKSJ sensitivity |
| Network meta-analysis | Connected contrast networks with explicit multi-arm covariance and a recorded transitivity assessment | Frequentist contrast-based REML NMA with design-by-treatment and node-splitting diagnostics |
| Dose-response meta-analysis | Correlated category-level OR/RR/HR/MD data with harmonized doses; adjusted observational estimates require one common adjustment set | Two-stage restricted cubic spline with multivariate REML |
| Individual participant data | Parallel randomized trials with binary OR, continuous MD, or time-to-event HR outcomes | Study-specific participant models pooled by REML, with HKSJ and one-stage sensitivities |
| Single-arm prevalence | Verified events and denominators | Logit binomial-normal GLMM |
| Single-arm incidence | Verified events and one harmonized person-time unit | Log-link Poisson-normal GLMM |
| Diagnostic accuracy | Aggregate 2×2 data at one recorded common threshold | Reitsma bivariate REML |
| Adjusted cohort NRSI | One source-verified adjusted ratio estimate per study and a common adjustment set | REML with HKSJ sensitivity |
| Adjusted prognostic factor | Adjusted cohort associations at one recorded horizon | REML with HKSJ sensitivity |
| External-validation c-statistic | One exact prediction-model version, outcome, population stratum, and horizon | `valmeta`-compatible logit REML/HKSJ |
| External-validation O:E ratio | Calibration-in-the-large for one exact model version, outcome, population stratum, and horizon | `valmeta`-compatible log REML/HKSJ |
| External-validation calibration slope | One exact prediction-model version, outcome, population stratum, and horizon with reported precision | Identity-scale REML/HKSJ |

Not production-released: multi-threshold diagnostic models, observational or
cluster/crossover IPD models, count IPD models, IPD multiple imputation,
non-proportional-hazards IPD models, prediction calibration curves, and
clinical-utility synthesis. These routes fail closed; MetaAgent does not silently
substitute a pairwise model.

For IPD, supply a JSON dataset when starting or resuming the project:

```bash
metaagent --topic "Does Drug improve symptom score?" --ipd-data /absolute/path/ipd.json
```

The file may be a list of study objects, or an object with `studies` plus optional
`outcome_type`, `covariates`, and `effect_modifier` fields. Each study contains a
`study_id` and participant rows with `participant_id`, 0/1 `treatment`, and either
`outcome` or `time` plus 0/1 `event`. Missing required model data stop analysis;
they are not silently deleted or imputed.

When quantitative pooling is not justified, the agent can still produce a clearly
labelled narrative systematic review or evidence-gap article. It does not call that
output a meta-analysis.

## What the agent does

1. Converts the topic into a structured protocol and method plan.
2. Builds a reproducible search query and retrieves records from PubMed plus the
   configured academic/registry fallbacks.
3. Deduplicates records and performs title/abstract screening.
4. Retrieves machine-readable full text automatically, parses it, and performs
   full-text screening.
5. Extracts study characteristics and result-level data with quotations and source
   locations.
6. Assesses design-appropriate risk of bias.
7. Locks one clinically coherent analysis set and runs the matching deterministic
   engine.
8. Completes or requests confirmation for method-appropriate certainty assessment.
9. Generates figures, references, a fact-locked manuscript, and an export package.

Every stage is checkpointed. Resume an interrupted or source-supplemented project:

```bash
metaagent --topic "the original topic" --resume /absolute/path/to/project
```

## Main outputs

```text
output/<timestamp>_<topic>/
  protocol.json
  search_query.txt
  search_results.json
  prisma_flow.json
  screening/
  extraction/
    all_extractions.json
  evidence/
    ledger.jsonl
  risk_of_bias/
  analysis/
    method_plan.json
    analysis_set.json
    synthesis_result.json
    method_certainty.json
  figures/
  manuscript/
    draft.md
    manuscript_facts.json
    manuscript_validation.json
  references.bib
  package/
    metaagent_export.zip
```

The primary deliverable is `manuscript/draft.md`: a normal editable article with
title, abstract, introduction, methods, results, discussion, conclusions, tables,
figure references, and bibliography. Internal evidence artifacts remain beside it
so calculations and claims can be reproduced.

## Useful options

```text
--output-dir PATH
--output-language zh|en
--max-papers N
--model MODEL
--user-pdfs DIRECTORY
--resume PROJECT_DIRECTORY
--skip-confirm
--polish-manuscript
--no-polish-manuscript
```

`--user-pdfs` is optional and proactive; without it the agent still attempts
automatic full-text acquisition first.

## Configuration

Copy `.env.example` or set environment variables directly. The essential variables
are:

| Variable | Purpose |
|---|---|
| `LLM_API_KEY` | LLM credential |
| `LLM_BASE_URL` | OpenAI-compatible endpoint |
| `LLM_MODEL` | Model name |
| `PUBMED_EMAIL` | Contact address required by NCBI E-utilities |
| `PUBMED_API_KEY` | Optional higher PubMed rate limit |
| `MINERU_TOKEN` | Optional enhanced PDF parsing |
| `OUTPUT_DIR` | Project output root |

All statistical calculations are deterministic and never delegated to the LLM.
The LLM handles language tasks such as protocol interpretation, screening,
source-linked extraction, and prose generation.

## Verification

```bash
python -m pytest -q
python tests/test_deep.py
python tests/test_e2e.py
```

The repository also contains versioned external numerical corpora under
`validation/corpora/` and an integrity-checked capability manifest. A method is not
marked production until its required independent reference and boundary evidence
are present.

## License

MIT
