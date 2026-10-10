---
name: geo-drug-value
description: Use comprehensive drug evaluation to guide GEO decisions, research, content and measurement, with partial evidence and contextual benefit-risk interpretation.
---

# Drug value throughout GEO

The objective is useful, accurate understanding of a medicine in real decisions.
Start from its clinical value and the audience's unmet need, then decide how GEO
can help. Corrections and citations are parts of this work, not its whole purpose.
Apply this guidance to all four GEO capabilities. It takes precedence over fixed
article lengths, mandatory statistics, clinical metadata checklists and stage or
sample quotas in an older method pack. It never overrides tenant access, source
integrity, spending authorization or the existing publication safety boundary.

## One evolving analysis, several uses

Read `geo_read {what:"value"}` and `geo_read {what:"research"}` at the start.
Reuse the project's knowledge base, preserved sources, claims and prior reports.
Write only new or amended observations with `geo_write {what:"value",data:{...}}`.
The server merges observations, assigns identities and versions automatically.
Use a returned id/key to amend a finding; use status `superseded` or `retired`
when it no longer applies. An empty list preserves prior work; explicit null
clears a field. Missing information is unknown, never zero or fabricated.

The optional data below is a vocabulary for useful context, not a required form:

- `scope`: medicine, form, indication, population, comparator, setting, region,
  asOf, audience, objective, lifecycle. Capture what changes the decision. The
  same molecule, brand, formulation and indication are not interchangeable.
- `findings`: statement, dimension, sourceRefs/sources, claimIds, scope,
  population, comparator, outcomes, timeframe, certainty, limitations, basis
  (direct/synthesized/derived), methods and assumptions where applicable.
  Include negative and conflicting evidence, preferences and treatment burden.
- `landscape`, `audiences`, `decisions`, `opportunities`: preserve a useful
  sentence even if structured details cannot yet be established. Optional
  findingIds/groupIds link analysis to questions and content. Opportunities
  may name a priority, rationale, nextAction and expected outcome, with measured
  versus inferred origins. Avoid unsupported numeric scores.
- `researchResults`, `sourceChanges`, `lessons`: link existing work and changed
  sources, explain what merits re-examination, preserve reusable methods and
  their scope. The platform imports available specialist reports on completion,
  including partial runs. Optional `geo-value.json` beside a report is another
  import route; it is never a required delivery artifact.

Keep provenance and scope in these backend records and source-linked reports.
Do not ask the user to fill every field. When identity is ambiguous, continue
safe disease/molecule analysis, label the identity limit, and ask only the
question that matters for product-specific work. Do not withhold the entire task.

## Choose methods to resolve a decision

Consider effectiveness, safety, economics, suitability, accessibility and
innovation together where relevant. This is a set of perspectives, not six
mandatory chapters or a synthetic overall score. An early medicine, mature
generic, OTC product and narrow indication need different evidence and outputs.

| Decision or gap | Existing capability / method to reuse |
|---|---|
| Overall value in a population and clinical setting | comprehensive-drug-evaluation |
| What the studies establish, and why they disagree | clinical-evidence-synthesis, evidence-appraisal |
| A justified pooled effect with compatible data | meta-analysis; no pooling when inputs are incomparable |
| Adverse events, signals, interactions, vulnerable groups | adr-analysis plus labels and comparative clinical evidence |
| Choice among treatments, including no treatment | drug-selection |
| Use outside the approved context | off-label-analysis, with that distinction explicit |
| Research landscape, knowledge gaps, future studies | bibliometric-analysis, research-topic-selection |
| Analysis of an available dataset | statistical-analysis, with dataset semantics |

Use an available research tool directly for a small gap. Queue a specialist
only for a question that warrants it: `geo_write {what:"research",data:{
capabilityId:"adr-analysis",question:"...",rationale:"...",findingIds:[],groupIds:[]}}`.
Optional context/contextKey disambiguates population or evidence time. Repeated
requests reuse the task; `retry:true` explicitly retries a finished failed task.
Finish the current GEO run with its usable findings. The platform runs queued
research afterwards; do not wait inside this run or recursively queue work.
Check completed results before requesting more. A failed source or method is a
named gap, not a reason to erase findings or keep retrying indefinitely.

Safety belongs beside benefits throughout positioning, journey, content and
measurement. Reporting databases such as FAERS generate signals: disproportionality
is not incidence, causal proof or a comparative safety ranking. Keep trial
harms, label cautions and reporting signals distinguishable. Compare compatible
populations, endpoints and timeframes; do not upgrade certainty from study type
alone. A full GRADE profile is used only if actually performed and warranted.

Distinguish cost-effectiveness, budget impact and patient out-of-pocket cost.
State payer/region/time where known; missing price means unknown economics.
Access includes availability, reimbursement and delivery constraints. Suitability
includes route, frequency, monitoring, adherence, comorbidity and caregiver
burden. Innovation means a meaningful clinical difference, not merely novelty.

## Turn analysis into GEO work

1. Position the medicine against real therapeutic alternatives, including
   non-drug care, without manufacturing superiority. Identify whom it benefits,
   limitations, and situations where it is a poor fit.
2. Work with patients, caregivers, doctors, pharmacists and institutional
   decision makers as relevant. Map nonlinear decisions: diagnosis, choice,
   initiation, use, monitoring, nonresponse, adverse events, switching and
   affordability. Do not force twelve stages or invent population sizes.
3. Discover opportunities from real questions, care barriers, comparative
   uncertainty, new/negative evidence, access/cost changes and AI answer gaps.
   Separate observed demand (with source) from analyst hypotheses. Use existing
   social search, knowledge and frontier sources when available; channel failure
   does not turn an inferred question into a real quotation.
4. Prioritize by decision importance, supportable value, unmet need, evidence
   gap, feasibility and effort. Explain tradeoffs in prose; no invented ROI or
   weighted clinical score. Preserve a stable control set for comparison where
   possible; a new question version is a changed measurement context.
5. Build a content portfolio around the actual questions and audiences from the
   same findings. Deep comparisons, practical use explanations, safety answers,
   affordability/access and decision aids are all legitimate. Select useful
   formats; do not generate four variants for every question. No required quote,
   statistic, word count or fixed number of articles. Qualitative evidence can
   support a useful article. Keep numeric conditions and uncertainty intact.
6. Distinguish scientific authority from likelihood of retrieval. A heavily
   cited marketing page is not stronger clinical evidence. Syndicated or copied
   pages are not independent sources. Choose channels by audience, topic,
   suitability and observed use, with explicit uncertainty about expected gains.
   Store optional valueContext on sources, groups and articles (findingIds,
   audience, decision, clinicalBasis, retrievalBasis, sourceFamily). Existing
   publication authorization and budget rules still apply. Check that published
   versions retain material conditions before attributing performance to them.
7. Diagnose visibility and semantic value uptake separately. Read value.coverage
   and observations alongside metrics, snapshots, control/noise results. Consider
   missing or distorted conditions, source retrieval, ambiguous product identity,
   topic mismatch, genuine evidence limitations and reasonable non-recommendation.
   Never equate more brand mentions with clinical quality or health benefit.
   Compare like engine/question-set/time/rubric/basis versions; changes and small
   samples limit attribution. No additional paid method-on/off experiment.
8. Proposals and weekly reports freeze one value version with their platform
   dataset. Separate measured, inferred and forecast statements; unknown stays
   unknown. Preserve contradictory findings across formats. New evidence updates
   linked findings/questions/articles/strategy selectively; the impact list is
   a review aid, never a global stop or automatic retraction of all content.
9. Use the existing researcher-scoped learning loop for reusable research and
   writing methods, with source and context. Record a lesson and its observed
   outcome when useful. GEO performance can improve communication methods; it
   cannot change the underlying scientific finding or confer clinical certainty.

Research and content continue with what is supported. Unavailable calculations,
unknown applicability and unresolved conflicts stay visible at the relevant
conclusion. Do not build an additional completeness gate or human approval step.
