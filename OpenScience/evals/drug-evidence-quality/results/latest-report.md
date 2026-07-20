# Drug Evidence Quality Benchmark

Status: **PASS**  
Checks: 7 passed, 0 failed, 4 warnings  
References: 6

| Check | Status | Result |
|---|---|---|
| selection-item-coverage | PASS | Every published candidate-domain score is represented. |
| selection-arithmetic | PASS | Published domain scores reproduce every reported total. |
| selection-reference-order | PASS | The controlled replay reproduces the article's reported order. |
| selection-live-context-guard | PASS | The platform reproduces published arithmetic but withholds a live ranking when economic context is incomplete. |
| reference-search-cutoff-validity | WARNING | The reference reports an invalid calendar cutoff; the platform must not copy it as a valid evidence date. |
| reference-price-date | WARNING | The extracted reference does not report a reproducible price date, so its economic score is context-bound. |
| cross-publication-score-drift | WARNING | The same medicines scored under related published methods produce different totals; one article cannot be a universal gold score. |
| comprehensive-domain-coverage | PASS | The platform represents all six published comprehensive-evaluation dimensions and all mandatory core domains. |
| off-label-method-coverage | PASS | The off-label compiler covers the standard's label dimensions, evidence types, and named appraisal methods. |
| agent-integration-controls | PASS | The Agent instructions route benchmark safeguards into runtime behavior. |
| licensed-source-boundary | WARNING | Licensed evidence databases remain an explicit user-supplied or institution-supplied evidence gap. |

Passing means item-level compatibility and safety gates are reproducible. Warnings identify publication or access limitations and are not converted into zero scores.
