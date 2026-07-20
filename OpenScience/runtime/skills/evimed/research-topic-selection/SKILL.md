---
name: research-topic-selection
description: Run EviMed's evidence-grounded research-topic specialist to identify gaps, contradictions, feasible questions, and a prioritized research agenda.
metadata:
  evimed-agent: research-topic-selection
---

# Research topic selection

Use this skill when a user has a broad biomedical direction and needs concrete,
testable research questions. Topic novelty must be supported by the retrieved
evidence set; absence from a small search is not proof of novelty.

## Execute

1. Preserve the user's disease, population, intervention or exposure, outcomes,
   available data, methods, and feasibility constraints. State only assumptions
   that do not materially change the direction.
2. Call `evimed_research_topic_selection` with `action=capabilities`, start the
   job, record the job id, and poll with `waitSeconds=60` until terminal.
3. Keep the evidence landscape, contradictions, candidate gaps, proposed study
   designs, feasibility, risks, and prioritization rationale distinct. A topic
   is not high priority merely because it sounds novel.
4. Do not fabricate search counts, citations, data availability, sample sizes,
   effect assumptions, or publication probability.

## Deliverables

Write `research-topic-report.md` with search scope, field map, evidence gaps,
candidate questions, design and data needs, feasibility, risks, prioritization,
and a recommended next step. Write `research-topic-run.json` with the terminal
job state and exact returned artifacts.
