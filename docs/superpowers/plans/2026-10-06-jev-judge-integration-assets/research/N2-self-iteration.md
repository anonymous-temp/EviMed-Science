# N2 - Where a cheap judge (Jev) belongs in the self-improvement and newly planned mechanisms

Read-only review, 2026-10-06. Sources read in full or in the relevant sections:
`2026-10-06-research-evolution-2.md` (2.0), `2026-10-05-evidence-flywheel.md`, `2026-10-04-research-evolution-engine.md` (headings plus judge-relevant lines),
`2026-10-06-jev-judge-integration.md` (decided plan). Code checked in `/workspace/evimed-wt/release/OpenScience/apps/server/src` (release line, `229c2846f`):
`evolutionIntegration.mjs`, `evolutionLeadSources.mjs`, `evolutionScout.mjs`, `evidenceCurrency.mjs`, `learningPlatformHandbooks.mjs`, `handbookConsolidation.mjs`,
`predictionRegistry.mjs`, `sourceChanges.mjs`, `geoJudge.mjs`, `geoCardCitations.mjs`.
Volumes below are my estimates unless a plan states them; they are marked "est.".

## 0. Ground rules I applied

1. Already-closed codes are not judged. A signal that the platform already writes as a closed code is read by code; a judge adds only noise.
2. A judge label is an input to ranking, routing, dedupe or a notice. It is never an input to promotion (2.0 section 4.5), the confirmation score, the meta objective
   (section 8.2/8.5), the corroboration or admission of anything into the platform handbook (flywheel section 7), or a security/privacy check.
   Implementation consequence: every judge-derived field is stored with `source: judge` and the version-pinned site id, and the selection/promotion functions
   (`evolutionSelection.mjs` in 2.0 section 13.2) take no judge-derived input. This is the "must not grade its own platform's promotion" rule made mechanical.
3. Short states only: <= ~1,500 chars per question; one question per pair; conservative option first; pairs asked in both orders where order matters
   (jev plan section 3 rules 1-8). Numbers, dates, counts and "is the data shape compatible" stay in code.
4. Fallback is always today's behaviour, and where today's behaviour is "nothing", the fallback is "no label" (never a default label).
5. Calibration sets come from records the platform already keeps (outcomes of scout runs, editor verdicts, consolidation decisions, researcher edits),
   plus about 100 hand-labelled local items per site as in jev plan section 7. No bake-offs, no shadow phase.

## 1. Finding that changes the ranking: the paper lead gate does not exist today

`evolutionIntegration.mjs:137-163`: every frontier paper that is published becomes `enqueue("scout", { paper })`, bounded only by one run per paper and
`evolutionMaxPaperScoutsPerDay` (default 8). There is no relevance step. `EvolutionFrontierSignals.tick` reads 25 papers per tick in `seq` order, so the 8 daily
scout runs go to the first 8 papers that arrive, relevant or not; a scout run is paid, runtime-less work. 2.0 section 5.2/6.1 asks the platform to pull methods,
data and AI-paper mechanisms out of an ever larger stream (papers, news, AI/CS sources), so this gate becomes the most important cheap decision in the new
design. It is also exactly the "relevance of a short item to a short question" shape Jev is good at.

## 2. Mechanism by mechanism

Format: plan section / what the judge answers / input / volume / calibration labels / fallback / verdict.

### 2.1 Fresh paper -> capability-map cell (and "already covered?") - ADOPT when 2.0 phase 2 starts
- Plan: 2.0 section 4.3 (map cells), 5.2 (paper row: "method five-tuple"), 6.1 (new-method source), 3.1 (paper leads, max 8/day); code gap in section 1 above.
- Questions (all on the extracted short description, not the full paper):
  1. choice over task families (closed list from the map, plus "none of these"; <= 255) - which cell would a method in this paper serve;
  2. noul "does the paper report a computational method with a reproducible numeric output" (code later checks that numbers exist, per Jev weakness);
  3. per-pair same/related/different of the paper's method one-liner against each candidate existing tool/capability/tool-graph node description
     (the 2.0 section 5.2/7.1 of the 10-04 plan "dedupe against catalogue, method records, tool graph" step). Prefilter: question 1 top-3 cells, then pairs
     only against tools of those cells (so <= ~30 pairs per paper, not catalogue-wide).
- Input: title + first ~1,200 chars of abstract (today the code carries a 24,000-char excerpt: cut it for the judge) plus option labels.
- Volume (est.): published frontier items that pass a cheap code filter (medical research type) a few hundred/day; ~5 questions each, ~1,000 tokens each: about 1-2M
  tokens/day, well under 0.1 USD/day.
- Calibration: for the last N weeks, scout runs and their dossier outcome (`evolutionResearchEligibility` reason, or "no dossier") give free labels for question 2/3;
  question 1 needs the ~100 local items (hand-label to the map cells once, a calibration corpus, not a per-run adjudication).
- Use: order and filter which papers consume the 8 daily scout slots; recall-oriented threshold (a miss costs a lost lead; a false pass costs one scout run).
  The same answer fills the map's "demand/neighbour" evidence. It never decides eligibility (`evolutionResearchEligibility` stays code on measured features).
- Fallback: today's arrival-order behaviour.
- The same site serves 2.0 section 5.3 "build a confirmation item from a fresh paper" only as the relevance pre-gate (does this paper concern tool X?).
  The item itself (numbers, first-public date, identity) is Flash extraction with code verification; Jev must not score it (jev plan section 0 rules out
  confirmation scoring).

### 2.2 Self-research relevance screen and mechanism-card dedupe (2.0 section 8.3) - ADOPT when phase 4 starts
- Plan: 8.3 "every Monday Flash batch-screens titles and abstracts ... writes a mechanism card ... dedupe against existing cards and tried candidates".
- Questions: (a) per recorded platform problem (a short list, 2.0 section 6.1 "self-research" needs "platform problems on record"), one noul "does this paper's
  mechanism address this problem" - one problem per question, never batched (jev plan: batched yes/no biases to yes); (b) choice over evolvable-object classes
  (the nine of section 4.1 plus "none"); (c) same/related/different of a new mechanism one-liner against existing cards' one-liners and against the failure archive
  entries (section 6.5 "renaming does not make a new hypothesis").
- Input: title + abstract <= 1,200 chars (English: Jev's strong language); card one-liners <= 200 chars (the plan already requires a <= 200-char description).
- Volume (est.): a few hundred AI/CS abstracts per week x ~20 problems = ~10k short questions/week, ~5M tokens/week, ~0.2 USD/week.
- Calibration: no history exists. Use the ~40 papers of 2.0 Appendix A as positives for the problems they were adopted for, plus ~60 deliberately off-topic
  abstracts as negatives. Keep thresholds high and read the result as a reading priority (top-k per week), not a verdict.
- Risk: source text is untrusted and can carry instructions (the plan says to execute none). Worst case a steered label buys a card that still needs candidate,
  screening, confirmation and promotion; Flash reads the same abstract afterwards anyway. Acceptable.
- Fallback: today's design - Flash batch screening.
- Not judged here: "evidence strength of the mechanism" (conference vs preprint, sample size - code/numbers) and the falsifiable prediction (generation).

### 2.3 Handbook entry dedupe / merge prefilter (2.0 section 11.2, 11.3) - ADOPT when phase 3 starts
- Plan: 11.2 "one call extracts candidate entries, another does dedupe, merge, retire", entries <= 6 per capability injection / 8 KB, so each entry is short.
- Question: per pair of entries of the same capability: same/related/different (order both ways, average), exactly the J1/J6 form already decided. Output feeds the
  merge proposal that Flash writes; "different" with high confidence removes the pair from that step. Retirement is not judged (see no-list).
- Input: two entries <= 1,300 chars each (entry text + applicability line, nothing else).
- Volume (est.): <= ~20 entries per capability x 28 capabilities, pairs only inside a capability and only for new/changed entries: low thousands/week.
- Calibration: `handbookConsolidation.mjs` decisions (merged / kept apart / queued) are the label store; the 48-pair `methodConsolidation` corpus is the template.
- Fallback: unchanged consolidation call over the whole list.
- Note: the same-capability + same-class "corroboration" in `learningPlatformHandbooks.mjs` is a weak match (8 coarse classes), and it is an anti-poisoning gate.
  A same-lesson judge would make it stronger but it is admission control, steerable by the lesson text, so it stays out of Jev (no-list).

### 2.4 Lead and proposal dedupe beyond ticket dedupe (E1 item 2 extended) - ADOPT with the ticket dedupe (same machinery)
- Plan: 2.0 section 4.4/13.1 (signal dedupe key, ticket dedupe: already E1.2), plus three places E1 does not name:
  (a) 4.5 "dedupe: a candidate nearly identical to one already evaluated is not evaluated again" - judge the proposal's <= 200-char statement, never the diff;
  (b) 6.5 failure archive "retry under a new name is not a new hypothesis" - same statement-vs-archive pair question;
  (c) 10-04 lead dedupe against catalogue and tool graph (covered by 2.1 question 3).
- Question: same/related/different, conservative first option "different" (a false "same" blocks a candidate; a miss only wastes one evaluation). Verdict
  "same" only at high confidence, and the blocked candidate is logged with the matched id so a human or the next cycle can see it.
- Volume (est.): proposals are a handful per day; archives hundreds; trivial.
- Calibration: archive records with their wake-up conditions; plus ~100 synthetic near-duplicate pairs written once.
- Boundary: this is input dedupe, not scoring. Code-level dedupe (hash of artifact, `evolutionCandidateIdentity.mjs`) stays first.

### 2.5 Researcher corrections and implicit feedback, as closed types (2.0 section 5.4, 6.6, 9.7, Learning-on-the-Job/ReSpect) - ADOPT the message-level one, POSSIBLE the diff-level one
- E1 item 1 covers "real questions -> closed demand codes". Section 5.4 names a second, different input: corrections ("researcher edits a report, rejects a citation,
  rewrites a question, reselects a capability"), and implicit feedback inside a conversation ("rephrasing, giving up, dissatisfaction", ReSpect).
  The first four event kinds are already closed by code (the UI action is the code). What is free text is:
  - (a) message-level: a follow-up turn -> {correction of the previous answer, rephrase because it was not understood, same task with added data, new question,
    thanks/accept, abandon}. This is "intent of a short message", Jev's home turf. Input: the previous assistant answer's first ~300 chars + the user message <= 300 chars.
    ADOPT, own-scope only (it feeds L1/L2 learning for that account, same scope rule as today), never cross-tenant text; cross-tenant only the closed label, counted per
    >= 5 accounts as section 5.4 already requires.
  - (b) diff-level: a researcher's edit hunk (before/after, <= ~300 chars each) -> {number fix, claim reversal or scope change, citation swap, wording only, format only}.
    Number changes are detected by code first (Jev is weak at numbers), the judge handles the rest. POSSIBLE: lower volume, more sensitive text (it is the
    researcher's own manuscript, same egress class as J8), and the label set needs ~100 real edits that do not exist yet.
  - (c) rewritten question vs original: same/related/different (refinement vs new question). POSSIBLE; fold into (a).
- Volume (est.): (a) every follow-up turn on the platform, on the order of thousands/day at ~600 tokens: a few million tokens/day, ~0.2 USD/day. Gate it to the
  learning loop's windows and to accounts with learning on, so it is bounded.
- Calibration: the plan's `choice:` overrides and the existing "reply-check adopted/not adopted" (2.0 section 5.5 row 8) give a few hard positives for "correction";
  otherwise ~100 local conversations.
- Fallback: no label (the event is still counted as an unlabelled follow-up). A label is a signal for ranking lessons; it never changes the user's run.

### 2.6 Memory inference edited by the researcher: what kind of edit (2.0 section 5.5 row 7, 9.7) - POSSIBLE
- Feedback events (accepted / modified / rejected) exist. "Modified" has the old and new text (short facts). Question: choice {factual correction, narrower scope,
  wording only, contradicts the original}. Purpose: calibrate extraction thresholds ("the code comment says it will one day answer this"). Volume: low.
  Verdict possible, not first: the plan's own ask is only a rate ("how often are inferences rewritten"), and a rate does not need a class. Add only if the rate
  proves too coarse to steer the extractor.

### 2.7 Card <-> newly published frontier item: does it bear on this claim (flywheel F13, `evidenceCurrency.mjs`) - POSSIBLE, after labels exist
- Today: items sharing >= 2 entity keys (or an identifier) are matched in code, the card is labelled `new_evidence_pending`, and "whether a new item changes the card's
  answer is the editor's judgement (`evidenceTarget`)". The jev plan ruled `evidenceTarget` out because its state is 12k chars of source plus up to 20 cards.
- A different shape was not evaluated: per (single claim sentence, item abstract <= 1,200 chars) pair, choice {unrelated, same topic only, addresses this claim}.
  That is short, closed and pairwise. It would cut how many matched items per card reach the editor, and let the notice to producers say which claim, instead of
  "2 new studies may affect your card". It must not include a "contradicts/supports" direction (needs effect sizes, numbers; contradiction is for the editor).
- Why only possible: the flywheel is brand new, so there are no recorded editor verdicts to calibrate on; the notices go to users (company, doctor) so a false
  positive costs trust, though it is only a notice. Re-examine once about 100 editor `evidenceTarget` verdicts accumulate; they are free labels.
- Fallback: today's behaviour (every matched item goes to the editor).

### 2.8 Plain-language sentence supported by the cited card conclusion (flywheel F21, section 8 rule 3 "every sentence traces to a card claim") - POSSIBLE-LOW
- Today `claim_refs` records which card claims an article cites (`geoCardCitations.mjs`); nothing reads whether the sentence is supported by the claim. This is
  "support of a sentence by a short passage", the one task Jev is deployed on (replyCheckJev, 100/101). The same client could mark unsupported sentences as a notice.
- Reasons for low: card claims are drug claims, and the decided plan already keeps drug-name sentences out of the Jev tick (escalates to Qwen); `geoJudge.mjs` already
  mixes extraction, verdict and code re-verification of numbers, and the jev plan declined it. So mostly escalations. Do it only as a label that reuses `replyCheckJev`
  unchanged, after F21 exists.

### 2.9 Paraphrase-equivalence filter for confirmation variants (2.0 section 10.3 "equivalent transformations") - POSSIBLE, boundary case, last
- Transformed confirmation items must keep meaning (reworded question, unit and date formats). same/related/different of original vs variant would drop a variant that
  drifted. Errors are safe in both directions (a dropped variant is cheap; an admitted non-equivalent variant makes the candidate fail, the conservative direction).
  But: unit and date variants are numbers/dates (Jev weak; do them by template and code), and this sits inside the promotion evidence path, so only wording variants,
  only as a filter on items, never as a score. If the owner reads the promotion-isolation rule strictly, drop it.

### 2.10 Contested data-semantic facts: what is the dispute about (2.0 section 5.5 row 4) - POSSIBLE-LOW
- `contested` facts carry the two statements; a closed kind {unit, population, time window, definition, value} would help the data-semantics small loop. The facts are short.
  But the outcomes are already named by the deterministic checks; volume is tiny. Mention only for completeness.

## 3. The "classify each of the nine unread signals" candidate - NO for seven, and why (2.0 section 5.5)

| Signal | Already | Judge? |
|---|---|---|
| `choice:` route reason (runRoute.mjs: `choice:answer`, `choice:<capabilityId>`) | closed code on the run ledger; the pair (routed -> chosen) is the confusion table, built by code (9.8) | No. A judge adds nothing to a closed pair. |
| Router classifier verdict and failure code | closed codes | No. |
| Planner `selection.source` / `fallbackReason` | closed codes (`autopilotService.mjs:1997`) | No. |
| `omissionAudit` | status plus `omissionRate` (a number) | No. Numbers. |
| Contested facts / basis rewritten | closed basis levels; counts | Only the "kind of dispute" (2.10), low. |
| Availability ledger (per version) | labels, counts | No. |
| `tool-edges/`, `tool-traces/` for workflow induction (AWM) | long ordered sequences | No. Long, sequence, distractor-heavy; this is mining, not classification. |
| Memory feedback events | accepted/modified/rejected, closed | Edit kind only (2.6), possible. |
| Reply-check adoption | closed | No. |
| Daily programme-decision scoring by later reads/citations | counts and joins | No. |
So the real use of a judge in 5.5 is not reading these signals; it is the free-text *inputs* next to them (2.5, 2.6).

## 4. Candidates I checked and reject (with reason)

| Candidate | Plan section | Why not |
|---|---|---|
| Label a handbook entry helpful/harmful from a run | 11.2, 11.3 | Causal and long-state; the outcome is already derived by code from verified/corrected results (N14, `methodFeedback`). A judge label would drive retirement and effectiveness, i.e. the platform's own promotion path. The "was it applied" part is a log fact (mounted + tool/skill call), not language. |
| "General method knowledge, no project fact" gate and same-lesson corroboration | flywheel 7, `learningPlatformHandbooks.mjs` gates 2, 3 | Privacy/poisoning admission; steerable by the lesson text; a re-check by another family is already required. Never Jev. (Observation: corroboration today is "same capability + same of 8 classes", weak as a match, but fixing that is not a judge job.) |
| Candidate screening of six classes (special-casing, disabled safety, grader gaming ...) | 4.5 rule 2 | The submitter is an adversarial developer model, the text is the attack surface; Jev is steerable. Code checks plus the independent-family review stay. |
| Pairwise pre-ranking of candidates (SIFT) | 10.3 | Already ruled out in the jev plan (multi-step quality comparison; weak on the best few). |
| Confirmation-set scoring, promotion evaluation, anchor scoring | 4.5, 10.3 | Ruled out by the jev plan; also "grading own platform". |
| Meta-loop "wasted step" labelling of ticket decision chains | 8.2 step 1, 8.5 | Feeds the meta objective that adopts or rolls back P. Never. Code can count repeated calls and dead ends from the ledger. |
| Capability-map "unlocks" / adjacency | 4.3, 6.2 | Derived from dependency records, graph and counts (`3 x ln(1 + n)`); numbers and a graph, no language. Free-text dependency names are mapped to closed codes at ingestion by Flash extraction, with code verification. |
| Upload data shape <-> tool data requirements | 5.4, 5.2 | The plan itself says column-name agreement is not enough; this is the data-semantics deterministic check. |
| Reader question <-> card match | flywheel F12, F06 | There is no free-text question-to-card routing in the plan; retrieval ordering belongs to the reranker (jev plan 4.3). The "ask this zone" path is a click. |
| Publication-status classification (retraction/correction/concern/withdrawal) | flywheel 5.4, `sourceChanges.mjs` | Kinds come from Retraction Watch, Europe PMC and frontier relations as structured data; a title classifier would be a weaker second source. Possible only for frontier's own relation assertions, and that is the frontier pipeline's, not the flywheel's. |
| geoJudge (statement vs claim, severity S0-S4) | flywheel F21 | Multi-field extraction with code re-verification of doses and numbers; the jev plan declined; severity has no pharmacist-labelled set. |
| Challenge text -> which claim | flywheel F14 | The reader clicks a specific claim; nothing to route. |
| Opportunity-source assignment (eight sources) | 6.1 | The trigger is the source (code). The only language part, "success extrapolation", is a Flash generation. |
| Card verdict "contradicts / supports" direction for new evidence | 6.1 "contradiction and update" | Needs effect sizes, directions and numbers; leave to editor and code checks. |
| Failure-case classification (E1 item 3) | 5.5 | Already decided; add only that the input is the failure code + the last ~500 chars of the final text, never the trace. |
| Closed demand codes (E1 item 1) | 5.2/5.4 | Already decided; note below. |

## 5. Notes on the three already-decided uses (E1) that affect how they are built
- Demand codes have four fields (capability, operation family, data shape, reason). Ask them as four separate choice questions. The reason field is mostly known
  from the event source (refusal code, planner stop, "no match") and should be taken from code, not asked. The two free fields (operation family, data shape) need their
  closed lists written first from the capability map; keep an explicit "none of these" and report the size of that bucket as a metric, since capability growth will
  make it grow. Aggregation needs >= 5 accounts, so noise is tolerated, but a label on a single account's request also feeds that account's own list: labels are per request.
- Opportunity-ticket dedupe: ask in both orders, "different" first, and merge only on high confidence, as J6; merging is of ticket display and counters, never of evidence roots.
- Failure-case classification: produces the failure *class* used to cluster tickets; ticket creation still requires a reproducible failing example (Phantom Guardrails
  rule in 4.5), which code checks.

## 6. Cross-cutting requirements for any of the above
- One `judgeSites.mjs` row per site (jev plan section 7), tagged as an evolution-side site so its spend counts under the `evolution` purpose and 40/30/15/10/5 budget split
  (the evolution daily cap of 50 CNY applies to Jev too; Jev spend is tiny, but the counter must exist).
- The corpus lives under `evals/judge-sites/<site>/`; these sites need their own corpora, none exists.
- Judge-derived columns are excluded from the confirmation score, promotion functions, pruning contributions, P' adoption and the monthly report's headline numbers;
  they may appear in the report only as labelled counts. Add a test that the selection module's inputs contain no `source: judge` field.
- Data egress: 2.1/2.2/2.3/2.4 send public paper text, platform-authored handbook text and proposal one-liners. 2.5 sends researcher messages (already true of J2/J3);
  2.5(b) sends manuscript fragments (same class as J8). Add the rows to the egress table in jev plan section 9.
- Phase placement in 2.0 section 14: 2.1 and 2.4 in phase 2 (map, ticket, confirmation set assembly); 2.5(a) in phase 2 beside the unmet-demand record;
  2.3 in phase 3 (handbook increments); 2.2 in phase 4 (self-research).

## 7. Ranked table (value x confidence x readiness)

| Rank | Mechanism | Plan section | Judge answers | Input | Volume (est.) | Calibration labels | Fallback | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | Paper/method -> map cell, method-vs-existing-tool coverage; gates the 8 daily scout runs | 2.0 4.3, 5.2, 6.1; code gap `evolutionIntegration.mjs:137-163` | choice(cell), noul(method with numeric output), same/related/different vs tool | title + abstract <= 1.2k chars | few hundred papers/day, ~1-2M tokens/day | past scout-run outcomes + ~100 local | arrival order, first 8/day | ADOPT (phase 2) |
| 2 | Lead/proposal/failure-archive dedupe (extends E1 item 2) | 2.0 4.5, 6.5, 4.4 | same/related/different on <= 200-char statements | two one-liners | tens/day | archive records + ~100 synthetic pairs | treat as different | ADOPT (with E1 item 2) |
| 3 | Handbook entry dedupe/merge prefilter | 2.0 11.2 | same/related/different, both orders | two entries <= 1.3k chars | thousands/week | consolidation decisions; 48-pair corpus pattern | full-list consolidation call | ADOPT (phase 3) |
| 4 | Self-research relevance screen + mechanism-card dedupe | 2.0 8.3 | noul per recorded platform problem; choice(object class); same/related/different vs cards | abstract <= 1.2k chars | ~10k questions/week | ~40 appendix papers + ~60 negatives | Flash batch screen | ADOPT (phase 4), as reading priority |
| 5 | Follow-up message intent (correction / rephrase / data supplement / new / accept / abandon) | 2.0 5.4, 9.7 | choice | prev answer 300 chars + user msg 300 chars | thousands/day, ~0.2 USD/day | `choice:` overrides, reply-check adoption + ~100 local | no label | ADOPT (phase 2), own-scope, label only |
| 6 | Card claim <-> new frontier item relevance | flywheel F13; `evidenceCurrency.mjs` | choice{unrelated, topic only, addresses claim} per (claim, item) | claim <= 300 chars + abstract <= 1.2k | hundreds of matches/day | editor `evidenceTarget` verdicts (after ~100) | all matched items to editor | POSSIBLE (after labels) |
| 7 | Report edit hunk -> closed edit type | 2.0 5.4 | choice | before/after <= 300 chars each | low | none yet | no label | POSSIBLE |
| 8 | Memory "modified" inference -> edit kind | 2.0 5.5, 9.7 | choice | old/new short fact | low | none yet | rate only | POSSIBLE (only if the rate is too coarse) |
| 9 | Paraphrase equivalence filter for confirmation variants | 2.0 10.3 | same/related/different | original + variant question | low | ~100 synthetic | drop variant | POSSIBLE, boundary (input filter, never score) |
| 10 | 科普 sentence <- cited card claim | flywheel F21, 8 rule 3 | support (reuses replyCheckJev) | sentence + claim | per article | reply-check corpus | no label | POSSIBLE-LOW (drug-name sentences escalate) |
| 11 | Contested-fact dispute kind | 2.0 5.5 | choice | two short statements | tiny | none | none | POSSIBLE-LOW |
| - | Closed-code signals (choice:, classifier verdict, selection.source, omissionAudit, availability, tool-edges, programme decisions) | 2.0 5.5 | - | - | - | - | - | NO: already closed, numeric, or long sequences |
| - | Handbook helpful/harmful label; corroboration/general-knowledge gate; candidate screening; pairwise pre-ranking; confirm/promotion scoring; meta "wasted step" label; map unlocks; data-shape match; reader-question<->card; notice kinds; geoJudge | various | - | - | - | - | - | NO: promotion/admission/security, numbers or graph, structured source exists, or no use in plan |
