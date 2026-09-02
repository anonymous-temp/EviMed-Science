# Drug Evidence Agent Architecture

Date: 2026-07-20

## Purpose

Drug selection, off-label use analysis, and comprehensive drug evaluation share
one evidence workflow, but they do not share one final decision. The hosted and
desktop products use the same EviMed packages and MCP contracts:

```text
bound question
  -> controlled EviMed retrieval
  -> deduplicated evidence snapshot
  -> source-linked domain rows
  -> deterministic assessment compiler
  -> report + tables + compiler JSON
  -> qualified human or institutional decision
```

The language model may organize evidence and draft explanations. It may not
create regulatory facts, silently repair missing data, invent scores, or issue
the final prescribing, formulary, procurement, HTA, reimbursement, or legal
decision.

## Runtime boundary

The three Agent packages are capability packages: `capability.yaml` plus SKILL.md
and scripts under `capabilities/`, with the shared skill bodies in
`capability-skills/`. The runtime image bakes both trees in at build time
(`/opt/evimed/capabilities`, `/opt/evimed/capability-skills`) rather than copying
a package per project — copying per project is what let a run reference a
directory the image does not have. The EviMed MCP server is installed and
registered separately (`/opt/evimed/mcp/evimed-research`), so Agent instructions
and evidence implementation stay independently versioned and testable.

The high-level tools retain their existing identifiers:

- `evimed_drug_selection_evaluation`
- `evimed_offlabel_evidence_packet`
- `evimed_comprehensive_drug_evaluation`

`action: retrieve` uses configured EviMed or controlled public connectors.
`action: compile` invokes `drug_assessment.py` locally and performs no network
call. This preserves API compatibility while making the decision boundary
explicit.

Every compile response includes a canonical input SHA-256, declares that no
automatic decision was made, and requires human review. An invalid evidence
reference or incompatible structured input returns an error rather than a
fallback conclusion.

## Shared evidence contract

All three workflows require:

- an exact question and decision jurisdiction when jurisdiction changes the
  conclusion;
- a source inventory with stable identifiers and retrieval timestamps;
- source-linked structured rows;
- a frozen `evidence-snapshot.json` before assessment;
- a compiler JSON artifact containing the exact result and audit hash;
- resolved citations and a qualified review gate.

Bibliographic metadata is discovery evidence only. It cannot establish study
design, outcomes, effect size, certainty, benefit, or causality without the
required evidence content. Empty retrieval and connector failure remain visible
evidence gaps.

## Workflow-specific boundaries

| Workflow | Deterministic output | Prohibited shortcut | Final authority |
| --- | --- | --- | --- |
| Drug selection | Qualitative matrix or conditional reproducible ranking | Equal-weight default, LLM score, missing-as-zero, incomparable economics | Authorized formulary and procurement process |
| Off-label use | Preliminary dimension-level label classification | Missing-label inference, cross-jurisdiction substitution, evidence support treated as approval or legality | Qualified clinical and institutional review under current local rules |
| Comprehensive evaluation | Domain coverage and structured synthesis | Highest-study shortcut, design-to-certainty shortcut, certainty-to-recommendation shortcut, automatic composite score | Qualified clinical, HTA, reimbursement, or procurement reviewers |

## Drug selection rules

A ranking is optional. It is generated only when:

1. `selectionDomains` is explicit and every candidate has exactly that domain
   set;
2. every observed row resolves to source evidence;
3. numeric scores come from a validated adapter or a versioned institutional
   rubric;
4. scale minimum/maximum, direction, weight, and rule version are compatible;
5. missing or unclear values are absent from ranked domains;
6. economic rows share currency, price date, dosage basis, treatment duration,
   jurisdiction, and perspective.

The compiler normalizes compatible scores deterministically, reports ties, and
runs leave-one-domain-out sensitivity when at least two domains are ranked. A
single-domain result cannot claim sensitivity stability.

## Off-label use rules

The compiler compares indication, population, dose, route, frequency, duration,
and formulation separately. `match` and `mismatch` require label evidence. The
comparison-row jurisdiction must match the requested jurisdiction exactly; a
missing target jurisdiction withholds classification.

The output keeps four axes independent:

1. regulatory label status;
2. evidence support;
3. patient-specific clinical appropriateness;
4. institutional, consent, reimbursement, ethics, and legal requirements.

`potentially_off_label` means only that at least one supplied dimension differs
from the verified target-jurisdiction label. It does not determine benefit,
appropriateness, reimbursement, or legality.

The bundled public label connector is FDA/US-only. It returns an explicit gap
for every other jurisdiction and never substitutes FDA labeling.

## Comprehensive evaluation rules

Effectiveness, safety, and applicability are core domains. A present row marked
`unclear` or `not_assessed` does not complete that domain. Other domains remain
separate so an attractive value in one area cannot conceal missing safety or
applicability evidence.

A certainty rating requires a documented basis and source references. The
compiler does not infer certainty and does not turn certainty into recommendation
strength. It deliberately returns `compositeScore: null` and
`recommendationStrength: not_automatically_determined`.

## Legacy defect disposition

| Legacy behavior | Risk | Disposition |
| --- | --- | --- |
| Off-label Boolean semantics were inverted in prompt and branch handling | Approved and off-label uses could be reversed | Removed; explicit dimension statuses replace the Boolean |
| Exceptions defaulted to compliant or critique parse failures defaulted to pass | Infrastructure failure became a clinical conclusion | Removed; validation and adapter failures are terminal errors or visible gaps |
| Missing labels were treated as mismatch, while absent labels could be generated by an LLM | Regulatory status was fabricated | Removed; only observed target-jurisdiction labels can support match or mismatch |
| Literature or RCT counts were treated as proof of efficacy | Quantity replaced outcome and bias appraisal | Removed; source-linked content appraisal is required |
| The highest study design directly set evidence and recommendation grades | Certainty and recommendation logic was invalid | Removed; body-of-evidence assessment and reviewer judgment stay separate |
| Model JSON supplied scores; parsing failures and missing values became zero | Rankings were unstable and biased | Removed; score origin, rule version, scale, direction, and missing-data gates are mandatory |
| A fixed legacy weight table was treated as universal policy | Local policy and indication differences disappeared | Removed; only an explicit versioned institutional rubric may be scored |
| Global web search and report fallback could continue without evidence | Unsupported claims could appear complete | Replaced by controlled connectors, source inventory, audit hash, and fail-closed compilation |
| Duplicated PC/app/service flows implemented different rules | Channel-specific clinical drift | Replaced by one shared MCP/compiler path and three thin workflow packages |

## SaaS and release acceptance

The source tree can claim that this module is adapted to the individual-account
SaaS runtime because it is packaged in the Web image, synchronized into isolated
project runtimes, uses server-controlled source routing, produces scoped
artifacts, and is covered by Agent-registry, MCP, security, and SaaS audits.

This does not prove a particular deployment or institution is ready. Production
acceptance still requires:

- a valid release manifest and target-host readiness evidence;
- current official label adapters or verified uploaded labels for each claimed
  jurisdiction;
- institution-approved formularies, scoring policies, consent/review procedures,
  and legal interpretation;
- authorized pricing and HTA inputs with declared economic context;
- monitored connector credentials, source-version controls, and retained audit
  artifacts;
- representative clinical and pharmacy acceptance cases reviewed by qualified
  users.

No codebase can guarantee that future evidence, policy, source outages, model
behavior, or every clinical scenario contains no defect. The release claim is
therefore bounded to tested behavior, traceable inputs, fail-closed rules, and
human decision ownership.
