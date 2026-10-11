# N1 - New-code sweep for Jev fits (release worktree 229c2846f)

Paths are relative to /workspace/evimed-wt/release/OpenScience/apps/server/src (S/) unless noted. Read-only sweep.
Areas read: flywheel (zones, cards, subscription, search, challenges, currency, editorial, programme, requests, community, incidents),
platform handbooks, method observations/feedback, frontier profiles/daily/subscriptions, evolution (scout, maintenance, integration,
lead sources, decisions, composition), notifications, skill library, memory validity, autopilot outcome, kb search, GEO cards/bank.

## Candidates

### C1. Card relevance for zone-subscription recall and the runtime evidence-card search (STRONG)
- S/evidenceZoneSubscription.mjs:52-66 (queryTerms/termScore), :256-276 (recall); S/evidenceCardSearch.mjs:49-52 (cardQueryTerms), SQL strpos term_hits ~:140.
- Today: no model. A user message is cut into Latin 3+ letter words plus every adjacent Chinese character pair; a card is "relevant" when it holds >=2 of
  those terms (1 for short queries); ranked by hit count. evidence_card_search ranks by identifier/entity keys, then substring term_hits. Chinese bigrams
  make "relevant" mean "shares common bigrams". Injected into a recall (capsuleGateway) on a language judgment made by a bag of bigrams.
- Jev question: score(2-5 levels) or noul "does this card (title + question + one-line answer) answer / bear on this message?" over the lexical shortlist (top 10-15).
- Volume: per recall (per user turn in a project that follows a zone) x <=15 cards; per evidence_card_search call (runtime tool) x <=6 cards.
- Fallback: lexical order as today (fail-open, same as the KB reranker).
- Labelled data: none direct; cheap proxy = whether the run opened/cited the card afterwards (evidence_card_runs, EvidenceOrigins).
- Verdict: STRONG. Short item vs short question is exactly Jev's case; the KB and memory have a reranker, cards do not; wrong cards in a recall violate principle 12.

### C2. Topic-request dedupe (STRONG)
- S/evidencePublicRequests.mjs:9-10, normalizeTopicTitle :37-47, filing at :121.
- Today: "same topic" = NFKC + whitespace + case fold string equality, so "SGLT2抑制剂治疗心衰" and "心衰患者用SGLT2i" are two rows; votes split, and the ordering
  (count of distinct accounts) is the programme's demand signal (evidenceProgramme.mjs readTopicRequests ~:393-410). Header says "a format fold, not a reading".
- Jev question: same / related / different between a new title (<=200 chars) and each of the top-N open requests (N<=20, shortlisted by entity-key overlap or trigram).
- Volume: per filing (rate-limited per account per day), tiny.
- Fallback: current exact fold; a new row if Jev is down.
- Labelled data: none, but a human can label 100 pairs in minutes; titles are short.
- Verdict: STRONG. Closed three-way on two short texts; failure only splits a vote (low harm), success concentrates demand.

### C3. Reader comment / zone question triage (POSSIBLE+)
- S/evidenceZoneService.mjs:1209-1262 (feedback, comments, reviews stored raw); S/evidenceEditorial.mjs:1028-1034 (latest 8 comments + zone questions fed verbatim to
  the card-writing model); S/evidenceCurrency.mjs:459-464 (any comment/review/question since the quiet period = "attended" and prevents retirement).
- Today: no classification. Every comment (spam, "thanks", a real objection, a new-paper pointer) is equal: it is context for the editor draft and it keeps a card alive.
- Jev question: choice {question about content, objection or correction of a claim, pointer to new evidence, thanks/praise, off-topic or promotional}.
  Use: objection -> offer the existing challenge flow (evidenceChallenges); off-topic/promotional -> not fed to the editor and not "attended"; pointer -> raise as pending item.
- Volume: per comment (low today, grows with the public pages).
- Fallback: treat as today (all comments pass).
- Labelled data: none yet; collect once live. Steerable text: use only for routing/relevance, never to publish or hide from the author.
- Verdict: POSSIBLE+. Good closed intent task on short text; value depends on comment volume.

### C4. Tool-pair "same tool?" in monthly maintenance (STRONG)
- S/evolutionMaintenance.mjs:511-516 (merge proposal).
- Today: Jaccard of whitespace-less `[\p{L}\p{N}]+` word sets of two tools' descriptions >= 0.5, AND an identical holdout case, AND the same track. For Chinese
  descriptions that regex yields whole phrase runs as single tokens, so Jaccard is ~0 or ~1 by accident; for English it is a lexical test of a semantic claim.
- Jev question: same / related / different between two short tool descriptions (name + description), pairwise over active tools of one track.
- Volume: monthly, O(n^2) over tens of tools = hundreds of pairs; trivial cost.
- Fallback: current Jaccard (keep case-overlap as the code guard; Jev replaces only the `similar` term).
- Labelled data: the tool ledger holds merges that were approved/rejected (decisions) once any exist; otherwise label ~50 pairs.
- Verdict: STRONG. Same shape as the already-decided method-pair screen (methodConsolidation) but a separate code path (platform tools, not learned methods) that was missed.

### C5. Scout "is this method already covered?" (STRONG)
- S/evolutionScout.mjs:113 (covered), :104-106 (methodId slug), :108 fingerprint.
- Today: covered = exact slug equality of an LLM-chosen methodId against METHOD_RECORDS keys and tool methodIds. The slug is free text lowercased and de-punctuated
  ("cox-ph" vs "cox-proportional-hazards" vs "coxph"), so coverageGap (+3 priority, required for eligibility) is true for methods the platform already has, and a
  dossier fingerprint (methodId + capability ids) lets the same method be built twice under two names.
- Jev question: choice over the platform's existing method/tool ids (<=255), given the scout's method name + one-line description: which existing item is the same method, or "none".
  Second pass optional: same / related / different on the top match.
- Volume: per scout run (<= 8 paper scouts/day by config) - tiny.
- Fallback: current slug equality.
- Labelled data: METHOD_RECORDS + tool ledger names and aliases give ready positives; previous duplicate dossiers give negatives.
- Verdict: STRONG. A decision nobody makes today (synonym resolution), small volume, high leverage on build cost.

### C6. "Same question as an existing meta-analysis" (POSSIBLE, feature currently dead)
- S/evolutionIntegration.mjs:178-181 (design regex), :217-219 (supported needs original.questionId === incoming.questionId); S/evolutionIntegration.mjs:~198 missingFacts lists "exact-new-study-question".
- Today: (a) a regex /meta[- ]analysis|systematic review|荟萃|系统评价/i over the source-understanding slot value decides "this is an evidence synthesis"
  (open-vocabulary prose regex, principle 5); (b) no code produces `questionId` at all, so metaUpdateOpportunity can never be `supported` for real data - the
  "update a meta-analysis when a new study appears" feature waits forever on a decision nobody makes.
- Jev question: (a) choice over the closed design list for the slot value (or reuse the source docType classification); (b) same / related / different between the
  original synthesis question (PICO line) and a new study's question (PICO line).
- Volume: per source understanding finished (a); per new-study x preserved-meta pair (b), pre-filtered by entity keys.
- Fallback: today's behaviour (waiting).
- Labelled data: none; PICO lines are short so a hand-labelled set is cheap.
- Verdict: POSSIBLE. (a) is the easy part (a docType-style closed choice); (b) is a good Jev task but the downstream (publication date vs cutoff, preserved sources) is mostly missing.

### C7. "与你相关" borderline relevance and twin-of-hidden (POSSIBLE)
- S/frontierProfiles.mjs:111 (MIN_COSINE 0.4, "starting point"), :120 (HIDDEN_COSINE 0.85, "Uncalibrated"), ranking :855; keyword fallback "tags" basis (header).
- Today: embedding cosine with two uncalibrated constants decides both "this item is relevant to a phrase the reader showed interest in" and "this is the same story as one
  they hid". Without vectors it falls back to lexeme match.
- Jev question: score or noul "does this item (title + one-line summary) bear on this phrase?" for the top ~3 per phrase near the floor (cosine 0.3-0.55); same / related / different
  between a candidate and a hidden item for pairs at cosine 0.7-0.95.
- Volume: per reader profile round (<=5 profiles per round, rank recomputed each 6h): ~16 phrases x a few borderline items = dozens of pairs, cheap.
- Fallback: current cosine floor.
- Labelled data: YES - stars/opens (positive) and 「不感兴趣」 hides (negative) are already stored per reader; measure Jev against them to set the floor.
- Verdict: POSSIBLE (strong on calibration data, modest on volume; the main gain is replacing two guessed thresholds with a measurable judge).

### C8. Implicit feedback from the user's next message after a delivery (POSSIBLE)
- S/evolutionFeedback.mjs:8-20, S/feedbackEvents.mjs:30-34, S/methodObservations.mjs (deliverableOutcome :~150).
- Today: method/tool outcome labels come from structural events only: deliverable adopted/edited, result corrected, gate verdict. A researcher who answers "这个数不对,
  再查一下" or "很好,继续" produces no feedback event. Loaded 34 / invoked 0 (incident 2026-09-28) shows the signal is already scarce.
- Jev question: choice on the first user message after a delivered result: {accepts/continues, asks a revision, reports an error, changes subject, unclear}.
- Volume: per user message that follows a delivered run in the same session (a small share of all messages).
- Fallback: no event (as today).
- Labelled data: partial - existing deliverable-adopted / deliverable-edited / result-corrected events are labelled by the same sessions' next messages.
- Verdict: POSSIBLE. Short closed intent; but label is "association not cause", so it must feed the sequential test as a soft label only. Check whether the platform may read chat text for this (memory/pause rules).

### C9. Platform-handbook lesson class (POSSIBLE for class only; NOT a fit for the privacy gate)
- S/learningPlatformHandbooks.mjs:36-39 (8 classes), :155-160 verdictOf, :330 handbookJudgeMessages; call at S/server.mjs:4764-4767 (deepseek-flash, thinking disabled, max_tokens 200, json_object).
- Today: one Flash call per candidate asks "general method knowledge? + class from 8"; an independent re-check by the review provider (Qwen) asks the same.
  Corroboration across accounts needs "same capability and same class".
- Jev question: class = choice over the 8 on the lesson description (name + description, not the 6000-char body). The "no project fact / no patient / unpublished" test is a
  privacy boundary on text the account wrote, so it stays on the model plus the code field checks (Jev is steerable by the text; do not move it).
- Volume: handbook candidates (<= 3/day).
- Fallback: model call as today.
- Labelled data: the candidate ledger holds judged lessons with class.
- Verdict: POSSIBLE for the class label only, but the volume is so low that the cost saving is nil; the real benefit is an independent-family second class vote. Low priority.

### C10. Zone for a paper / official-zone matching when the glossary finds no key (POSSIBLE)
- S/evidenceRecalculation.mjs:185-201 (createOfficialZoneMatcher): keysForText on the paper text; null if no key, else best shared-key count among official zones.
- Also S/evidenceEditorial.mjs:406: keyless zone falls back to strpos(lower(title/summary), lower(owner's query)) over the feed - a substring test deciding "this item is about the zone".
- Jev question: choice over official zones (<= ~10) + none for a paper title/abstract head; for the keyless-zone fallback, noul "is this item about <zone topic>?" per item.
- Volume: per recalculated paper (rare); the keyless-zone path per zone x up to 50 items per schedule tick (only for zones with no keys).
- Fallback: current key match / substring.
- Labelled data: published cards in official zones give (card title, zone) positives.
- Verdict: POSSIBLE. The keyless-zone substring path is the weaker spot (a user zone with a Chinese query like "糖尿病肾病" is matched by exact substring of the title/summary).

### C11. Pre-screen for the editor's "does this item change the card" call (POSSIBLE)
- S/evidenceEditorial.mjs:720 and :820 (editor.evidenceTarget per candidate; already ruled out as a Jev replacement because the state is long), S/evidenceCurrency.mjs:55,371 (>=2 entity keys).
- New angle (not the same as the ruled-out site): the candidates arrive after a shared-key match; a Jev pre-screen on card question + one-line answer vs item title + one-line summary
  ("does this item bear on the card's question?") could cut the Flash calls that end in `decision: skip` / `upkeep-not-relevant`, which is where most of the daily volume goes.
- Volume: per (card x matched item) per upkeep tick.
- Fallback: today's flow (Flash decides).
- Labelled data: YES - every past `skip` / `upkeep-not-relevant` job payload is a labelled negative; accepted updates are positives.
- Verdict: POSSIBLE (cost-driven; use only as an early-exit for clear negatives, never to suppress an identifier match).

### C12. Reader challenge pre-triage (POSSIBLE, mostly cost)
- S/evidenceChallenges.mjs:~331-350 (reason 8-N chars, one Flash judgement per challenge, daily ceiling, rate limit per reader).
- Today: any reason string (even "asdf asdf asdf") buys a model call of up to 12000 chars of source; rate limits are the only guard.
- Jev question: noul "is this a substantive objection to the claim, or noise/off-topic?" on claim + reason (<=1.9k chars total) - only to skip the paid recheck and tell the reader why.
- Volume: per challenge (<= 10 per reader per day).
- Fallback: run the Flash recheck (as today).
- Labelled data: none; the recheck outcomes (uphold/amend/withdraw) are weak labels (an upheld challenge is not necessarily noise).
- Verdict: POSSIBLE-WEAK. Do not use Jev for the actual support-judgement: it needs an `amend` text and a verbatim passage.

### C13. Topic follow / mute precision (POSSIBLE-WEAK)
- S/frontierSubscriptions.mjs:22 (topic follow = tsquery over item lexemes; comment says "never a new language classifier").
- Today: a muted topic hides every item whose lexemes match; false matches silently hide news ("COVID" in a screening-test item).
- Jev question: noul "is this item about <topic>?" on lexeme hits only (confirm step).
- Volume: per item x muted topic hit, per reader page/for-you read.
- Fallback: lexeme match.
- Labelled data: un-mute / un-hide events if recorded.
- Verdict: POSSIBLE-WEAK; the file states a deliberate design choice, so check with its owner first.

### C14. Communication-module lead (decision nobody makes) (POSSIBLE-WEAK)
- S/evolutionLeadSources.mjs:158-167 (communication.offer "Nothing calls this today: the module has no field marking [a question as needing an analysis nobody offers]").
- Jev question: choice over the closed analysis families (VCR_METHOD_FAMILIES + other + none) for a short reader question.
- Volume: per GEO/communication question. Fallback: none (feature dead today).
- Verdict: POSSIBLE-WEAK; needs a decision on what "offered" means first; low volume.

## Not a fit (checked)
- S/evidenceChallenges.mjs support judgement, S/evidenceEditorial.mjs evidenceCard/evidenceReview, S/evolutionComposition.mjs (reference curation, temporal gold, prospective prediction extraction,
  decision refresh/review): generate text, quotes or numbers; Jev cannot (also independence requirement from another model family).
- S/evolutionMaintenance.mjs retirement score, S/evolutionScout.mjs evolutionPriority, S/autopilotOutcome.mjs, S/evidenceFlywheelMetrics.mjs, S/notificationService.mjs severity: counts and closed fields, no language.
- S/evidenceIncidents.mjs class: decided from change-log fields on purpose.
- S/memoryValidity.mjs conflict labelling: conflicts are created by the extraction model's `supersedes` (memory extraction dedupe is already ruled out); validity is columns.
- S/kbIndex.mjs: already has the qwen3-rerank step.
- platformSkillSupply search_tools script (platformSkillSupply.mjs:212): term-count ranking, but it runs inside the runtime container for the model's own query (no provider key there).
- S/skillLibraryService.mjs, extension center: structural (digests, frontmatter); a skill-text safety review would be security, which Jev must not do.
- S/evidenceCommunity.mjs / evidenceFeed.mjs / evidenceAuthorStanding.mjs: key and count based by design; public-page content moderation of company/doctor product zones is safety/authorization-adjacent (steerable), keep off Jev.
- S/geoQuestionBank.mjs, S/geoCards.mjs: judge split is ruled out; class lookup is data-file based.
- S/agentMemoryObservations.mjs (TCM prescription habits): syndrome-name equality across "related edits" is a synonym problem, but TCM CDSS integration is an owner-settled non-goal.

## VCR sites - not now (owner: untouched until ready)
- vcrMatching.mjs three-valued criterion matching, vcrEvidence.mjs evidence parameterization, vcrRecruit.mjs/vcrContact.mjs, vcrKnowledge.mjs, evidenceProgramme topic -> engine routing for VCR leads.

## Ranked table

| # | Candidate | Site | Volume | Labelled data | Verdict |
|---|-----------|------|--------|---------------|---------|
| 1 | C1 card relevance for recall + evidence_card_search | evidenceZoneSubscription.mjs:52-276, evidenceCardSearch.mjs:49 | per turn x <=15 | proxy (card opened/cited) | STRONG |
| 2 | C4 tool-pair same/related/different | evolutionMaintenance.mjs:511-516 | monthly, hundreds of pairs | decisions ledger | STRONG |
| 3 | C5 scout method already covered | evolutionScout.mjs:113 | <=8/day | method records + aliases | STRONG |
| 4 | C2 topic-request dedupe | evidencePublicRequests.mjs:37,121 | per filing | hand-label 100 pairs | STRONG |
| 5 | C3 comment / question triage | evidenceZoneService.mjs:1209-1262, evidenceEditorial.mjs:1028, evidenceCurrency.mjs:460 | per comment | none yet | POSSIBLE+ |
| 6 | C7 for-you borderline relevance + hidden twin | frontierProfiles.mjs:111,120,855 | dozens/reader/6h | YES (stars/opens/hides) | POSSIBLE |
| 7 | C11 editor pre-screen (early exit) | evidenceEditorial.mjs:720,820 | per card x item | YES (skip jobs) | POSSIBLE |
| 8 | C6 meta-analysis design regex + same-question | evolutionIntegration.mjs:180,217 | per source | none | POSSIBLE |
| 9 | C8 next-message feedback on deliveries | evolutionFeedback.mjs, feedbackEvents.mjs | per post-delivery message | partial | POSSIBLE |
| 10 | C10 official-zone / keyless-zone matching | evidenceRecalculation.mjs:185, evidenceEditorial.mjs:406 | rare | published cards | POSSIBLE |
| 11 | C9 handbook lesson class | learningPlatformHandbooks.mjs:36,330; server.mjs:4764 | <=3/day | candidate ledger | POSSIBLE (low value) |
| 12 | C12 challenge pre-triage | evidenceChallenges.mjs:~331 | <=10/reader/day | weak | POSSIBLE-WEAK |
| 13 | C13 topic follow/mute precision | frontierSubscriptions.mjs:22 | per item x mute | un-hide events | POSSIBLE-WEAK |
| 14 | C14 communication lead | evolutionLeadSources.mjs:166 | per question | none | POSSIBLE-WEAK |
