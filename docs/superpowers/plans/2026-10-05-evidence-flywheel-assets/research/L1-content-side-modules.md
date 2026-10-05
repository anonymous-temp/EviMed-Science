# L1 — Content-side modules: what they produce/consume, existing links, gaps
Repo: /home/coder/workspace/EviMedScience (branch codex/research-evolution-engine-20261004, HEAD c1f02c3cc).
Paths below are relative to `OpenScience/` unless absolute. "READ" = read in code; "INFER" = my inference.

## (a) Evidence zones & cards (证据专区 / 证据卡片)

History (git): 332cc01cf 2026-10-01 "integrate evidence zones and simplify reading" (service/routes/persistence + web pages);
5c98b5742 "operate reviewed evidence content and upkeep" (evidenceCardContent, evidenceEditorial, evidenceSourceReader, content/evidence seed + import script);
edd7993c3, aacd47d6d, 3f0ffed89, 246698666, 4b6a15aeb, a2b78dbef, c91369199 (all 2026-10-01; maintenance/retention fixes).
PROGRESS.md:115 (3 zones + 8 AI-reviewed cards imported), :98 (9 cards, 3 scheduled zones live on Aliyun), :31 (pilot zones imported into Tencent prod 2026-10-04).
Design review: docs/ui-ux-audit/2026-10-01-frontier-fusion/review.html — explicitly EXCLUDED: "extra first-party-only facet", public RSS, editorial workstation, global evidence destination; "No implicit legacy migration" of the Vue platform's zones.

### Data model (READ apps/server/src/evidenceZonePersistence.mjs)
Schema `evimed_frontier` (same schema as the frontier feed, but NOT the product documents/revisions ledger):
- evidence_zones (:3-10): id `ez_*`, user_id (owner), title, description, background, state draft|published, revision.
- evidence_cards (:11-22): id `ec_*`, zone_id, user_id, title, subtype knowledge|academic, summary, body, sources jsonb, limitations, provenance (free text), source_item_id (frontier items.public_id), state draft|published, revision, content jsonb, editorial jsonb.
- evidence_card_revisions (:23-27) snapshot per revision.
- evidence_automation (:28-35) per zone: enabled (default false), query, source_types (default journal,regulator,evidence-body), interval_hours 24, max_cards_per_run 2, discovery_turn.
- evidence_editorial_jobs (:36-44) leased jobs, identity_key, card_id, source_item_id/url/title, payload.
- evidence_zone_follows (:47-51), evidence_comments (:52-56), evidence_reviews (:57-62, 1-5 score bound to card_revision), evidence_zone_feedback (:63-67), evidence_zone_meta version counter (:68-71).
- No `claims` column: cardView always returns `claims: []` and zoneView `experts: []` (evidenceZoneService.mjs:217, :166).

### Card structure (READ evidenceCardContent.mjs, evidenceZoneService.mjs)
- sources[] (evidenceZoneService.mjs:79-101): title, url (http/https, no creds), excerpt, sha256 (= hash of documentText||excerpt, verified), fetchedSha256, checkedAt, coverage full-text|abstract|excerpt (full-text requires documentText), documentText (≤2 MB, never returned to readers :218), publicationStatus {kind retracted|corrected|concern, notices[]} (evidenceCardContent.mjs:31-39).
- content (evidenceCardContent.mjs:70-176): question, answer, population, context, nextStep, sections[{title,text,sourceIndexes}], tables[{columns,rows,caption,sourceIndexes}], comparisons[{outcome,timeframe,denominator,measure risk|rate,control/intervention {label,events},relativeEffect,certainty,sourceIndexes}]. sourceIndexes are 1-based into sources[].
- editorial receipt (evidenceCardContent.mjs:178-267): author {kind ai|human,name,model,userId}, lastEditor, reviewer (ai only), contentHash (evidenceContentHash :41-57), sourceFingerprint (:59-68), sourceChecks[{sourceIndex,status checked|retained,attemptedAt,code}], sourceCheckedAt, sourceChangedAt, reviewedAt, status ai-reviewed|review-pending, findings[{kind,text,sourceIndex}], reviewRevision. "ai-reviewed" is refused if any source has a publicationStatus (:208-216).
- Only an internal operation may write `editorial` or retained source metadata (evidenceZoneService.mjs:447-448); HTTP users can only send {title,url,excerpt} sources.
- Publish requires body + ≥1 source (evidenceZoneService.mjs:587-595).

### Who may create / publish / see (READ)
- Routes (evidenceZoneRoutes.mjs): all under /api/frontier/zones*, /api/frontier/evidence; require session user (`ensureSessionUser`, allowDevAuth false, :26-28), CSRF (:29), and `frontier.allows(user)` (:30) = frontierAudienceAllows (frontierService.mjs:140-145): frontier enabled AND (audience "all" OR operator OR preview user). Default audience "all" (config.mjs:263), frontier itself off by default (config.mjs:305).
- ANY allowed logged-in user may create a zone (`canCreate: true` hard-coded, evidenceZoneService.mjs:388; POST /api/frontier/zones :65-66).
- Cards: only the zone owner may create/edit cards in that zone (evidenceZoneService.mjs:489-494, :502-507). There is no co-author / editor role and no operator override.
- Visibility: a zone is visible if published or own (:122); a card if (card published AND zone published) or own (:135). "Published" = visible to every logged-in account the frontier audience allows. No unauthenticated route, no share token, no sitemap/RSS/SEO anywhere (grep of apps/server/src, apps/web/src, deploy/web/Caddyfile: none; Caddyfile only reverse-proxies everything to the web server). Web routes /app/frontier/zones[/:zoneId[/evidence/:cardId]] sit under the authenticated AppShell (apps/web/src/app/router.tsx:94-96).
- Readers can: follow zone, zone feedback (owner-only visible :425-434), card comments, card peer review score 1-5 (creator cannot self-review :869-874).
- `research` action (:708-844): builds a Chinese prompt draft from the zone + up to 10 published cards (or one card), returned as `{draft}`; web navigates to /app/chat with runtimeUiIntent prefill, unsent (apps/web/src/app/routes/EvidenceZonePage.tsx:215-233 "问这个专区"; EvidenceReadingPage.tsx:83-92). Draft embeds `[相关动态](/app/frontier?item=…)` when sourceItemId set (:836-839). This is the ONLY zone→research link: a user-initiated, unsent chat draft; nothing records which run came from which card.

### Where cards come from — `origin` values (READ)
1. Manual HTTP editing by the zone owner (POST/PATCH; editorial=null for human-authored cards).
2. Frontier item → owned zone: FrontierCard menu "整理为证据卡片" navigates to /app/frontier/zones?fromItem=<item.id> (apps/web/src/components/frontier/FrontierCard.tsx:104); EvidenceZonePage fetches the item and opens the add editor (EvidenceZonePage.tsx:99-116); server validates sourceItemId against `evimed_frontier.items.public_id` published + source enabled (evidenceZoneService.mjs:539-555).
3. `saveEditorial(..., origin="import"|"model", lease)` (evidenceZoneService.mjs:438-443) — "Internal operator import / model worker entry; never mounted as an HTTP route":
   - origin "import": scripts/ops/import-evidence-content.mjs (operator CLI; content/evidence/seed-cards.json + source-manifest.json + independent review file; creates AI actor accounts `evidence-editor-ai` / `evidence-review-ai` :118-123; owner = an existing user given by --owner; `--enable-updates` turns on automation with hard-coded queries per zone key :138-147).
   - origin "model": EvidenceEditorial worker (below).
- No other caller of saveEditorial / evidence_cards exists in apps, packages, runtime, capabilities or scripts (grep; only accountExport.mjs:52-55 reads them for export).
- => NO path from a research run deliverable (clinical-evidence-synthesis package, claims, claimVerification) to a card. NO runtime tool reads or writes zones/cards (grep runtime/, packages/socket, capabilities: none).

### Maintenance / upkeep (READ evidenceEditorial.mjs)
- Per-zone opt-in by the owner: GET/PUT/POST /api/frontier/zones/:id/automation (evidenceZoneRoutes.mjs:74-75; evidenceEditorial.mjs:71-251). POST with {cardId,expectedRevision} = request a rewrite of an AI-managed card (:142-176); POST {} = refresh now and retry failed/skipped (:177-200).
- Ticked by FrontierWorker (wired server.mjs:1728-1732, `evidence: evidenceEditorial`), shares frontier budget (`budget` = pipeline.budget, server.mjs:1690) and frontierEditor model (purpose `frontier`, billed to operator internal project — frontierEditor.mjs:29-30).
- schedule() (:252-329): discovery candidates = published frontier items from enabled sources whose source_type ∈ zone source_types AND whose title_raw/title_zh/summary_zh contains the zone's query substring (:268-282) — lexical, not semantic; alternated with maintenance of AI-authored cards (editorial.author.kind='ai') (:260-267).
- process() (:375-903): read source via evidenceSourceReader (PubMed/PMC/DOI→Europe PMC, NCT→ClinicalTrials.gov v2, else web_read; publication-status from Europe PMC pubType/commentCorrection :10-41) → skip retracted/corrected/concern sources (:434-443) → editor.evidenceTarget (new card vs update existing card, or skip) (:450-485) → read ≤8 sources per tick with rotating cursor (:557-634) → if fingerprint unchanged & ai-reviewed: refresh check metadata only (:680-710) → else editor.evidenceCard (inputs include 2 reviewed example cards and up to 8 reader comments/zone feedback as `readerQuestions` :726-773) → saveEditorial state "published" immediately, subtype academic, provenance "AI-authored synthesis…" (:775-812) → editor.evidenceReview → saveEditorial status ai-reviewed with findings (:837-891).
- A human edit to an AI card stops automation for that card (automationContentHash ≠ contentHash, :516-534).
- AI-discovered cards are auto-published WITHOUT human approval, inside the owner's zone, owned by the zone owner (user = {id: zone.user_id} :389).

### Links to other modules (READ)
- Frontier items → cards: source_item_id + editorial discovery from items (above). Cards → frontier: only a link back `/app/frontier?item=` (EvidenceReadingPage.tsx:212-215). Nothing inserts a card into items/events/daily/hot list (grep frontier*.mjs for evidence_cards: none).
- Followed zones' latest cards shown on the frontier 关注 tab (apps/web/src/components/frontier/FollowedEvidenceZones.tsx).
- Account export includes zones/cards/revisions/automation/follows (accountExport.mjs:52-55, :426).
- NOT linked: autopilot, evolution, learning, memory/capsules, knowledge base, GEO, VCR, inbox/notifications (no follow notification on new card; grep frontierNotifications/notificationService for evidence: none — verify below), runs/deliverables.
- Name collision (INFER relevant): GEO has its own "证据卡片" article layer (`card`, packages/domain/src/geoVocabulary.mjs:170; capability-skills geo-content SKILL.md:53 "seven panels"), and VCR has "证据卡/假设卡" (packages/socket/capability-skills/vcr-evidence/SKILL.md:24). Neither reads or writes evimed_frontier.evidence_cards.

### Gaps (INFER from the above)
- No run-deliverable → card publisher; no claim-level mapping (card has no claims; run packages have typed claims).
- No card → frontier item/first-party source; feed review excluded a first-party facet.
- No public/anonymous reading, no SEO/sitemap, no share token — "published" means "all logged-in accounts in the frontier audience".
- No co-editing/operator roles; a zone is a single-owner collection.
- No notification to followers when a card is published/updated (to verify in (b)).
- Discovery query is a lexical substring; no relevance from the reader's profile/memory.

## (b) Frontier feed (前沿动态)

### What it stores (READ apps/server/src/frontierPersistence.mjs)
Schema evimed_frontier, 22 tables (+ item_vectors; + the 10 evidence-zone tables migrated by the same call, frontierPersistence.mjs:1, :543).
- sources (:83-106) mirrored from the knowledge-source plugin registry; entries (:109-142) = plugin stream rows (plugin_entry_id, plugin_seq, identity_key, doi/pmid/registry_ids, facts, content_sha256); items (:149-200) = published units: public_id `^[a-z0-9]{12,32}$`, primary_source_id → sources, title_zh/summary_zh/reason_zh, lane, source_type, evidence_type + evidence_basis (pubmed-types|registry|model), specialties, entities, flags (retracted/corrected/preprint…), 4 scores + total, selected, safety_alert, verification (number check), state screened|scored|published|withdrawn|failed, editor_model.
- item_texts (:232-246), item_mentions, item_links (retraction/correction relations asserted by crossref/pubmed/europepmc/retraction-watch :257-268), glossary, events (:282-304) + event_items/links/revisions, hot_snapshots, dailies (:354-368), weeklies (:370-380), item_changes (:382-389 change stream), meta, reader tables user_state (star/hide/read :400-407), user_follows (topic|specialty|drug|source|event :411-420), user_profiles (:422-429), user_prefs (:431-436).
- Invariant (frontierPersistence.mjs:8-13; frontierIngest.mjs:9-14; design doc FRONTIER_FEED_TECHNICAL_DESIGN.md:106 "P3", :155): the plugin and platform have separate databases joined only by the HTTP contract; "The platform never reads a source itself"; the plugin never calls the platform. The ONLY inserts into entries/sources are frontierIngest.mjs:320,:423,:429; into items only frontierPipeline.mjs:1163 (from entries). => No first-party (platform-authored) item type exists.
- Source types closed vocabulary: journal, regulator, evidence-body, preprint, company, media (packages/domain/src/frontierVocabulary.mjs:77-84); no "evimed"/first-party type. Access methods include `evimed-api` (:198) — used by two plugin registry rows `evimed-chictr` (ChiCTR via the team's EviMed data API) and `evimed-guides` (EviMed guideline index) (项目代码/knowledge-plugin/registry/extra-sources.json:5-15, :56-66). That is the Vue team's data product entering the feed as an ordinary source — not OpenScience's own evidence zones or research outputs.

### What it publishes and to whom (READ)
- Routes /api/frontier/* (frontierRoutes.mjs:72-181): status, items (list/get), item actions star/unstar/hide/unhide/read, save-to-library, abstract-zh, for-you, hot (?window=week|month), events/:id (308 for merged), dailies, weeklies, sources, follows CRUD, operator ops (withdraw/pin/unpin item, enable source).
- Audience: session login required on every route (:78), CSRF (:79), `service.allows(user)` (:80) = frontierAudienceAllows (frontierService.mjs:140-145): OPEN_SCIENCE_FRONTIER_ENABLED (default false, config.mjs:305) and OPEN_SCIENCE_FRONTIER_AUDIENCE all|operators (default "all", config.mjs:263-266) + OPEN_SCIENCE_FRONTIER_PREVIEW_USERS. No anonymous access, no RSS (fusion review excluded "public RSS").
- Daily (frontierDaily.mjs:1-55): one issue/day 07:30 Asia/Shanghai from verified items; pushed as inbox `notify` (source digest, key frontier-daily:<day>) to readers active 14 days or following something, behind `frontier` notification switch. Weekly (frontierWeekly.mjs) + notice (frontierNotifications.mjs:29-33). Safety notices per followed/unmuted item (frontierNotifications.mjs:22-27, :53-70).
- Content is model-written once for everyone on deepseek-flash under purpose `frontier`, billed to the operator's internal `evimed-frontier` project, under OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY (default 10, config.mjs:281) (frontierEditor.mjs:29-30; server.mjs:1663-1667).

### 与你相关 signals (READ frontierProfiles.mjs:1-65)
Three inputs: (1) the reader's research memory records (active, non-sensitive, ≤40; WORK_KINDS project_fact/analysis/decision/follow_up :117), (2) questions of their own conversations, last 30 days, ≤30 (supplied by server.mjs:1701-1715 `conversations` → agentRuns.researcherRuns across non-internal projects; refreshed on run change via server.mjs:2653 `frontier.profiles.noteConversation`), (3) feed items starred/opened in last 60 days. One model call extracts ≤10 phrases (embedded) → ranks published items of 72 h/7 d by cosine ≥0.4 + 0.1×editorial score. NOT inputs: evidence-zone follows/cards, autopilot agendas, knowledge-base sources, capsules, evolution. Output ranks frontier items only.

### Runtime tool frontier_search (READ frontierGateway.mjs)
POST /internal/frontier/v1/search (:44), fields q/lane/specialty/window/mode/limit (:45), answer = projection of FrontierService.listItems for the runtime's account (:149-174: title, summary, reason, source name/type, evidence type, dates, url, doi, pmid, registryIds, flags, selected, safetyAlert). Items only — no evidence cards, no events. Route given to the runtime only when the audience admits the project owner (runtimeManager.mjs:1594-1596), else tool disabled (:1746).

### Consumes / existing links (READ)
- Knowledge-source plugin stream (knowledgePluginClient.mjs, frontierIngest.mjs) — only input of items.
- Research memory + conversation questions → 与你相关 (above).
- → Knowledge base: "存入知识库" writes an OA PDF or a Markdown record into the reader's project `knowledge-base/frontier/` through the upload path `writeProjectUpload`, which registers it as a source (frontierActions.mjs:8-24, :58, :221-263; wired server.mjs:1716-1722). Audited event frontier.item.save-to-library (frontierRoutes.mjs:117-121).
- → Chat: "深入研究" opens chat with an unsent drafted question (design doc :1198; web only).
- → Evidence zones: item → owned-zone card draft (FrontierCard.tsx:104) and AI discovery reads items by lexical query (evidenceEditorial.mjs:268-282).
- → Evolution: EvolutionFrontierSignals reads evimed_frontier.item_changes and publishes `frontier-publication` events (evolutionIntegration.mjs:289-306; composed only when frontierEnabled, evolutionComposition.mjs:328, ticked before each scout :343). Details in (e).
- No other module references frontier tables (grep autopilot*/learning*/source*/geo*/vcr*: only comments).

### Gaps (INFER)
- No first-party content type: evidence cards, research packages, autopilot briefings, evolution decisions never become items/events/daily sections; the architecture (plugin-only items, closed source-type vocabulary, plugin never calls the platform) has no slot for them. Adding one means either a new control-plane-side item origin (breaks "platform never reads a source itself" only nominally — it would be its own content) or a separate "platform evidence" stream merged at read time.
- Daily/weekly/hot/for-you never include evidence cards; following a zone yields no notification (frontierNotifications only safety/weekly/daily).
- 与你相关 does not use zone follows or knowledge-base contents.
- frontier_search cannot return the platform's own verified cards, so a run cannot cite platform evidence.

## (c) Research outputs (run deliverables, result versions, claim verification)

### Where a finished run's deliverables live (READ)
- Files: in the project workspace under `deliverables/<deliverableId>/…` (workspaceLayout.deliverablesDir, packages/domain/src/workspaceLayout.mjs:50; resultDeliveryCapture.mjs:88-104). Preserved sources live under `.evimed-sources/<contentVersion>/` with a capture.json manifest of digests (resultDeliveryCapture.mjs:32-57).
- On finish, server.mjs `onRunFinished` (:2667-3132) is the hub. It calls, in order: evolution runtime completion + `runtime-gap` event for failed runs (:2668-2673); result capture `captureFinishedRun` (:2674-2694); availability collector (:2707); source-understanding / learning runtime release (:2708-2727); autopilot verification + `completeOwnedAutopilotRun` reading `agenda-delta.json` claims (:2733-2789); VCR / GEO orchestrators (:2794-2821); credits settlement (:2828-2842); inbox "run finished" item (:2853-2870); transcript persistence + `evolution.finishRun` + method-use / handbook observations (:2883-2970); reply review (:2988-2994); learning triggers + memory extraction (:2999-3060+). Also on every run change: frontier profiles noteConversation and GEO delivery import (:2653-2658).
- NOTHING in that hub touches evidence zones or the frontier feed's content tables.

### Result versions (immutable, per project) (READ resultProvenanceService.mjs, resultDeliveryCapture.mjs)
- `evimed_product.documents` kind `result-version` (productPersistence.mjs:4-15 kinds incl. result-version/result-impact/result-revision/result-replay/document-export; table :64-76 keyed (user_id, kind, id) with project_id FK). Snapshot bytes copied to project meta `result-snapshots/<sha256>` (resultProvenanceService.mjs:112-122). Ids: artifactId `ra_<sha>`, versionId `rv_<sha>` (:106-108).
- Payload (:141-147): path, digest, size, mimeType, capturedAt, producer {kind deliverable|workspace|tool…, runId, sessionId, eventId=deliverableId, parent/branch}, inputs (source refs with digest/versionId), code, environment, method, findings (run quality notices + per-claim findings with sourceRefs), machineValues, review, coverage {snapshot, producer bound|observed|unknown, inputs, code, environment, gaps[]}, supersedesVersionId, snapshot (producer snapshot), bindings (printed numbers ↔ machine values).
- Capture of a clinical package (resultDeliveryCapture.mjs:136-190): reads `clinical-evidence-matrix.json` (claims ≤500), captures each preserved source referenced by claims (≤48) as its own version, runs `claimVerification({matrix, sourceArtifacts})` + `attachClaimSourceLocations` (:175-178), builds `clinicalResultLinks` (resultImpact.mjs:61+), and stores `review = {status:"available", matrixText, verification, matrixVersionId, matrixDigest}` on every version of that deliverable (:186-187, :212-215).
- Visibility: strictly owner + project. Every read goes through `scope()` → authorizeProject (resultProvenanceService.mjs:38-47); routes /api/results, /api/results/:id(/raw|/lineage|/corrections) (resultProvenanceRoutes.mjs:13-40) and /api/results/:rv/export|revisions (resultReuseRoutes.mjs:6-20) require the session user. Restricted-source quotations are even withheld from the owner's raw read (:378-416).
- Enabled by OPEN_SCIENCE_RESULTS_ENABLED (default true, config.mjs:2691).

### Claim-level verification (READ packages/domain/src/clinicalEvidence.mjs)
- Claim shape (capabilities/clinical-evidence-synthesis/SKILL.md:1118-1211): claimId (CLM-nnn), claimType direct|synthesized|derived, claim (text), applicability, uncertainty, confidence (synthesized), sourceUrl, sourceTitle, artifactPath (.evimed-sources/…), accessLevel, supportQuote (verbatim), referenceNumber, identifier; synthesized → supportingSources[≥2]; derived → inputs/method/assumptions. Written via `evimed_claim_upsert`.
- `claimVerification` (:2270-2300): per claim status verified | quote_not_found | source_unavailable | no_quote | derived, per source status, counts. `claimEvidenceSources` (:2230-2247). `attachClaimSourceLocations` (:2326+) adds table/row/cell/page location. Same claim shape is reused by manuscript-support `section-claims.json` (capabilities/manuscript-support/capability.yaml:56-60).

### Export / share / publish (READ)
- Research package export = owner-only ZIP download GET /api/results/:rv/export (resultReuseRoutes.mjs:10-16; ResultExportService resultExport.mjs:75+, README :23-58: manifest, execution.json, verification.json, reproduction.json, verify.py; "Nothing in it is signed", "never gives access to the project").
- Document export (Word/PDF/HTML) via documentExport*.mjs (job kind document-export) — owner download.
- Share links: none for runs/deliverables/results (grep). Router note: no route carries a project id so pasted links do not grant project access (apps/web/src/app/router.tsx:53-55). The only "sharing" features: memory capsule export/import `.evimedcap` (MemoryHubPage 分享与导入, CapsuleTransferPanel.tsx) and knowledge-base source "所有项目可用" (shared across the owner's own projects, SourcesPage.tsx:506-507).
- "Publish": no publish action for a deliverable anywhere. The only researcher signal of acceptance is the feedback event `deliverable-adopted` / `deliverable-edited` posted by the client (server.mjs:5070-5110; feedbackEvents.mjs) — consumed by learning and by evolution (evolutionFeedback.mjs:13-14).
- Paper/manuscript representation: no "paper" document type; a manuscript is files of a run — `manuscript-section.md` + `section-claims.json` (manuscript-support), `meta-analysis-report.md` + `meta-analysis-run.json` (meta-analysis), `grant-proposal-package`, each captured as result versions. Capabilities may also emit `agenda-delta.json` (clinical-evidence-synthesis capability.yaml outputs; meta-analysis capability.yaml) consumed by autopilot (server.mjs:2768-2782).

### Result impact (source updates → continuation) (READ resultImpact.mjs)
- `result-impact` documents: advisory changes (retraction/correction/new version, `sourceUpdates.mjs` lookup) matched against a result version's recorded input identities (DOI, digest, src_ id) (:17-54). A change can, with the owner's authorization, schedule an autopilot continuation episode (`continuation` status awaiting_user → preparing/scheduled; assertContinuation :413-460; autopilot authorizeContinuation server.mjs:1657-1660, autopilotService.mjs:417-454).
- This is the closest existing "publication → re-research" loop, but it is per-owner and per-result; it never touches evidence cards (cards have their own publication-status check in evidenceEditorial).

### Gaps (INFER)
- A verified claim set (matrix + preserved sources with digests + verification verdict + locations) is structurally very close to an evidence card's sources/sections/findings, yet nothing maps one to the other: no "publish to evidence zone", no card origin "run", no back-link from card to result version.
- Results are private to the owner's project; there is no visibility state beyond that (no account-public, no platform-public, no anonymous), so any loop needs a new publication step with its own copy (cards store documentText) rather than exposing project files.
- The two retraction mechanisms (result-impact for results, publication-status in evidenceEditorial for cards, item_links in the frontier) are separate implementations over related identities (DOI).

## (d) Autopilot (主动科研)

Config: OPEN_SCIENCE_AUTOPILOT_ENABLED (default = production, config.mjs:2259), planner OPEN_SCIENCE_AUTOPILOT_PLANNER_ENABLED default true (:2270). Service composed when product documents/jobs exist (server.mjs:1650-1661); worker server.mjs:3404+.

### Produces (READ autopilotService.mjs, packages/domain/src/agenda.mjs)
All rows in evimed_product.documents (owner + project, private):
- `agenda` (create :458-492): title, topics, prompt, schedule, taskTypes (AUTOPILOT_TASK_TYPES — literature-sentinel, evidence-update, data-prospecting, hypothesis-suggestion, writing-pipeline, signal-monitoring; summaries autopilotNextAction.mjs:70-77), daily/weekly/episode budgets, starts paused (researcher must start), materials[] (knowledge-base source ids, addMaterials :1235-1266), outcomes, userSignal, plannerStop, evolutionWaiting.
- `episode`: one autonomous run of a capability (each capability manifest has an `autopilot:` block — taskTypes, costClass, unattendedInputs; e.g. capabilities/meta-analysis/capability.yaml:47-52). Dispatched through the ordinary AgentRun path (autopilotWorker.mjs:20-23).
- Agenda claims from the run's `agenda-delta.json` (read in server.mjs:2768-2782; validated completeRun :881-950): {id, statement, type direct|synthesized|derived, tier unverified→gated (by the run's own gate)→reproduced (only by an independent verification), sources[] (strings), provenance {episodeId, artifact}, what_would_change, confidence, effect.measure ∈ ALLOWED_EFFECT_MEASURES} (validateAgendaClaim agenda.mjs:202-246; tierRaiseAllowed :258+).
- Independent verification runs per claim (≤ STOPPING_RULES.verificationsPerEpisode), fresh session, scratch workspace, no memory, no KB (server.mjs:3443-3470; autopilotService.mjs:1007-1043) → refutation refuted|weakened|stands.
- `digest` (createDigest :1773-1801): headlines vs leads by digestPlacement (agenda.mjs:178-195: reproduced, or direct+gated+stands → headline), artifactRefs (≤24, same project), decisions; inbox notice noticeType "review" "主动科研简报：<title>" (:1794-1799).
- Digest decisions adopt|reject|question|withdraw (decide :1804-1827) → capsule memory candidates (rememberDecision :1843+, refuted claims never promoted) and userSignal scoring (USER_SIGNALS agenda.mjs:95).

### Consumes / existing links (READ)
- Knowledge base: agenda materials = KB `source` documents of the same project (addMaterials :1243-1248, sourceIdFor from sourceService.mjs).
- Capsules (memory) for decisions; notifications for digests and stops (:1715-1720).
- Result impact → continuation episodes (authorizeContinuation server.mjs:1657-1660; assertEpisodeContinuation autopilotService.mjs:418-429; resultImpact.mjs:413-460).
- Evolution (new): `autopilotService.evolution = evolution.integration` (server.mjs:4221-4224). Planner context gets `availableTools` = evolution.availableTools(agenda) (autopilotService.mjs:1665-1670 in 759f2502a; autopilotNextAction.mjs buildPlannerContext); planner may stop `needs_input` with `resourceNeed {kind tool|data, capabilityId, methodId, toolId, requirementId}` → agenda paused with `evolutionWaiting` + `evolution.plannerStopped(...)` (:1704-1724); evolution later calls `wakeForEvolution` to resume exactly that wait (:1729-1742).
- Capability outputs `agenda-delta.json` (optional output of clinical-evidence-synthesis, meta-analysis…).
- NOT linked: frontier feed (no capability lists frontier_search — only open-domain-answer does: runtime/skills/evimed/open-domain-answer/agent.yaml; literature-sentinel runs bibliometric-analysis with its own literature tools), evidence zones (none), GEO/VCR beyond their own dispatch prefixes.
- Visibility: agendas/episodes/digests are private to the owner's project; nothing is publishable.

### Gaps (INFER)
- Verified autopilot claims (tier reproduced / stands, with sources and provenance) are exactly the "AI-produced evidence" the loop needs, but they end in a private digest; no path to a card, zone, or frontier item.
- literature-sentinel duplicates what the frontier pipeline already ingests (new publications) instead of reading it; no agenda can subscribe to frontier items/events or to zone updates.
- Adopted digest claims become personal memory candidates only; no shared/platform memory.

## (e) Evolution module (循证进化 / EviMed Evolve), commit 759f2502a (2026-10-05)

Scope (commit message): default-off loop for literature scouting, isolated capability development, independent reference checks, versioned tool supply, daily decisions, data requirements, agenda continuation, maintenance; "publication-triggered continuation" accepted in isolated live acceptance; full scientific calibration and longitudinal outcomes NOT accepted.

### Switch / ownership (READ)
- OPEN_SCIENCE_EVOLUTION_ENABLED default false (config.mjs:2306); daily budget OPEN_SCIENCE_EVOLUTION_DAILY_BUDGET_CNY 50 (:2308), run budget 10, max 3 decision cards/day, 24 h decision timeout (:2309-2312).
- createEvolution (evolutionComposition.mjs:56-58) returns null unless enabled + database. Owner = first operator; internal projects EVOLUTION_PROJECT_ID "EviMed 循证进化" (:61-66) and 'evolution-research-opportunities' (:76). Model calls purpose `evolution`, deepseek-flash (:118-123); independent review requires a different model family (Qwen/dashscope) (:132-138, :177-182).
- Wired in server.mjs:4216-4224 (runtimeManager.platformSkillSupply = evolution.supply; autopilotService.evolution = evolution.integration).

### Produces (READ)
All records are `evimed_product.documents` kind `knowledge` with payload.recordType `evolution-<type>` (evolutionService.mjs:41-59), owner's internal project unless a tenant id is given:
- leads (addLead :66-77; tenant-derived leads reduced to closed codes :68-70), events (ingestEvent :79-89, stored under the tenant's own user id), dossiers = "research cards" (evolution-scout capability → `research-card.json`, contract `evolution-research-card`; evolutionScout.mjs:80-137) — tool R&D plans (method, papers, track, ranking features, eligibility), NOT evidence cards.
- tools (registerTool :103-109): versioned immutable packages built by the `tool-builder` capability (`tool-candidate.json`, contract `evolution-tool-candidate`; evolutionComposition.mjs:282-296), published through platformSkillSupply into every eligible runtime as platform skills under /opt/evimed/platform-skills ("Immutable shared methods only; researcher data/results never enter this store", platformSkillSupply.mjs:11, :38-40), executed via POST /internal/evolution/v1/execute (evolutionGateway.mjs:5-31). Validation levels V0–V4 from independent assessments only (packages/domain/src/evolution.mjs:28-37), data levels D0–D4, tracks E/P/M/U/X/T (:5-7).
- decisions (decision cards, operator inbox noticeType review; daily "进化日报" notify — evolutionDecisions.mjs:39, :129), failures, waiters, observations (temporal/prospective/meta-update/dataset-tool match), prospective registrations, research-proofs (evolutionResearchPromotion.mjs:40-45), uses (per researcher tool execution, evolutionComposition.mjs:414-420), feedback, evaluations, release replays.
- opportunities (addOpportunity :184) saved in the TENANT's own space: e.g. dataset-tool match "使用 … 检查已有数据的研究可行性" (evolutionIntegration.mjs:275-280), meta-update "核对新增研究是否需要更新已有荟萃分析" (:188-194), adjudication disagreement (evolutionComposition.mjs:74-79).
- Researcher-facing routes only: GET /api/evolution/project-tools, GET /api/evolution/opportunities, POST /api/evolution/opportunities/adopt → creates an autopilot agenda (5/30/2 CNY, daily 08:00 Asia/Shanghai) (evolutionRoutes.mjs:11-25; evolutionComposition.mjs:399-408). Everything else operator-only (evolutionRoutes.mjs:26-55). Web: EvolutionPanel in CapabilitiesPage and DatasetMeaningPanel, EvolutionOpportunities in AutopilotPage, EvolutionDecisionCard in InboxPage.
- Retired tool → inbox notice to every researcher whose result used it (evolutionComposition.mjs:211-215).

### Couplings (READ evolutionIntegration.mjs consume :67-124)
- Frontier → evolution: EvolutionFrontierSignals.tick reads evimed_frontier.item_changes ⋈ items (published) ⋈ item_texts, 25 per tick, cursor `evolution-frontier-cursor`, publishes `frontier-publication` {paper: id, title, url, publishedAt, identity, excerpt ≤24k} (:289-312); ticked before every scout (evolutionComposition.mjs:343). Consumption: temporalObservation (time-holdout candidates per tool, :233-257), matchProspectivePublication (preregistered predictions → awaiting-gold → prospective-score job, :214-231), and a `scout` job per published paper (:114-117). So every published frontier item can seed a tool-R&D scout. Nothing flows back to the frontier.
- Autopilot ↔ evolution: planner gets availableTools; needs_input + resourceNeed → `autopilot-gap` event → waiter + lead (:84-92); `tool-ready` / `dataset-ready` → resolveWaiters → autopilot.wakeForEvolution (evolutionService.mjs:137-162; evolutionIntegration.mjs:286).
- Knowledge base → evolution: daily `source-facts-scan` reads every tenant's current `source-understanding` records; meta-analysis/systematic-review → meta-update-candidate observation, research-protocol → prospective-registration-candidate (evolutionIntegration.mjs:127-163; worker evolutionWorker.mjs:96-98). Operator route registerMetaUpdate binds a tenant's preserved KB source quotes (evolutionEvidenceRegistration.mjs:152-163).
- Data semantics → evolution: datasetChanged on dataset meaning change (server.mjs:1945) → dataset-ready → dataset-tool opportunities (evolutionIntegration.mjs:59-64, :260-283).
- Feedback → evolution: feedback events (deliverable-adopted/edited, result-corrected) → observeFeedback → tool maintenance observations (server.mjs:1176-1188; evolutionFeedback.mjs:59-92).
- Runs → evolution: failed researcher run → `runtime-gap` lead (server.mjs:2669-2673); finishRun updates `use` records (evolutionComposition.mjs:436-456).
- Learning → evolution: handbook gaps (method-missing in ≥2 runs) → leads; and evolution writes `platformToolReferences` into every active capability handbook across users (evolutionLearningCoupling.mjs:97-116).
- NOT linked: evidence zones/cards (none), frontier publication of anything evolution makes (none), GEO/VCR (none), research results' claim verification (none; evolution evaluates tools against "paper gold", not research packages).

### Gaps (INFER)
- Evolution consumes the frontier feed as a literature stream but produces tools and private opportunities; no "platform published a new validated tool / reproduced paper" item goes back into the feed or into an evidence zone.
- The paper-gold machinery (independent reproduction of published papers with proof hashes, research-proofs) is a verified-evidence producer that never reaches readers.
- "Research card" (evolution dossier) vs "evidence card" (zone card) vs GEO "证据卡片" vs VCR "证据卡/假设卡": four unrelated "card" concepts; a plan must name them apart.

## (f) Knowledge base / sources (brief)

### Holds (READ)
- Per project: `source` documents (content-addressed `src_<sha>` ids hashing project+bytes, sourceIdFor used by autopilot), `source-unit`s, `knowledge` records with recordType `source-understanding` (internal capability `source-understanding`, dispatched by SourceUnderstandingRuns sourceUnderstandingRuns.mjs:8-30; schema per docType with slots e.g. design), per-source coverage ledger and structured materials (sourceMaterials.mjs). Readability states reading/ready/attention (sourceService.mjs:33-75). Files live under the project's `knowledge-base/` (mounted read-only into the runtime); searchable by the runtime tool `kb_search` (listed by almost every capability manifest).
- Account level: the personal library (`preferences` records recordType `library-item`, own copy under <dataDir>/users/<user>/library/, mounted read-only at /workspace/library; libraryService.mjs:10-45). Every read document's summary + key claims are auto-published as facts with verbatim quotes into the owner's capsule `sources` layer, which is in NEVER_SHARED_LAYERS (packages/domain/src/capsule.mjs:114) — never shared, recalled only in its project (libraryService.mjs:31-41).
- Visibility: owner only (project, or account library). No cross-account sharing of sources.

### Inflows (READ)
- Uploads and OpenList import (sourceService / openListSourceConnector.mjs).
- Frontier "存入知识库" → `knowledge-base/frontier/` (frontierActions.mjs:58, :221-263).
- Run-preserved sources → `knowledge-base/open-access/<group>/` via sourceIntakeHandoff.mjs (one intake path, verified against capture manifest, :1-30).

### Outflows (READ)
- kb_search in runs; autopilot agenda materials (autopilotService.mjs:1235-1266); evolution source-facts scan of `source-understanding` records (evolutionIntegration.mjs:127-163) and meta-update registration with preserved quotes (evolutionEvidenceRegistration.mjs:26-40, :152-163); result impact matches a KB document by contentDigest (resultImpact.mjs:17-31); capsule `sources` facts (libraryService.mjs).
- NOT to: evidence zones (cards keep their own `documentText` copies fetched by evidenceSourceReader, not KB sources), frontier, GEO/VCR content (VCR has its own data plane).

### Gaps (INFER)
- A researcher's KB document cannot be cited/published into a card; card sources and KB sources are separate stores of preserved text with separate hashing (evidenceHash of documentText vs source fingerprint sha256).

## (g) The team's Vue platform (www.evimed.com), read-only reference
Path: .evimed-local/evimed-web/evimed-web-feat-research-workflows-migration/src (functional facts only; no hosts/credentials/vulnerabilities copied).

### Evidence zone (Vue `/evidence-zone`, alias `/subjectDetails`) (READ)
- Backend: the team's Java "news-api" service, endpoint family `evidenceWindowController` (api/evidenceZone.js:1-272): topics = zones (`topic/info`, `topic/evidenceList`, `topic/recommendList|activeList|likeList|commentList|scoreList`, `topic/classificationList` (2-level classification), `searchTopicByClassification|ByTitle`, `topic/auth` = create permission, `topic/following|disFollowing|followingList`, `topic/feedback/create`, `msg/getUnReadCount`), expert info by the card's reviewUserId (`expert/info`), academic evidence (`evidence/info|likeInfo|comment/*|getScore|mark` = expert/peer scoring, `evidence/like`), knowledge cards (`knowledge-card/info`, `select-point-question`, `select-guide-question` votes), sensitive-text check, search history.
- Submission review ("与 app-5.0 专区投稿审核保持同一流程", :105-118): `topic/pendingEvidenceList`, `topic/processContentReview` — zone owners/reviewers approve submitted cards.
- Card fields seen (views/evidence-zone/evidenceZoneModel.js:215-348): id, name/cardName, summary/coreConclusion, credits (creator), reviewerProfile (reviewer + institution), score/totalScore/evidenceScore/qualityScore/mark, commentCount, `card === '证据卡片'` (knowledge vs academic), tags, topTags (rank lists "TopN …榜"), createBy, institution; zone background JSON with sections + numbered references (:119-213). Two card types: knowledge (`/clinicalCard` → cardType knowledge) and academic (`/evidenceDetails` → cardType academic) (router/index.js:141-161).
- Public navigation: the signed-out home shows 新建任务 / 科研工作流 / 证据卡片 / 证据专区 / 所有任务 with a 登录 link (captured anonymously, docs/ui-ux-audit/2026-10-01-frontier-fusion/research/evimed-public-zones.json). The router guards only `/knowledgebase` (staff check, router/index.js:180-201); `/evidence-zone` is unguarded (whether its API answers anonymously is not visible in front-end code — INFER: likely public read).

### Knowledge "Workshop" = 证据制作审核 (Vue `/knowledgebase/workshop`) (READ)
- Staff-only (isInternalFlag via getIsInStaff; router/index.js:180-201; sidebar entry only for staff, components/Sidebar/index.vue:70-74).
- Page = "专区投稿管理 · 待审核卡片" (components/knowledgeBase/Workshop/components/EvidenceReview.vue:1-160): list of pending submissions (topicName, createBy, createTime, summary, infoStatus; 3 = 正在重新生成), open in EvidenceCardPreview, actions 发布 (publish to zone, "发布后将面向用户展示") or 重新生成 with reasons + 1–300-char suggestion (calls `regenerateGeoCard` → the Python card service `process-batch`, api/geoCard.js), reward 5 灵豆 per valid review.
- Card production pipeline (api/knowledgeBase.js `knowledge-card/*`): upload files for card generation, file history/retry analysis, topic board (`all-card-name`), `create-evidence-card` (async generation), `operation` (ignore/restore; 定版 finalize/discard), `release-to-topic` (publish a finalized card to a zone), drafts, my released cards, `public-topic` (public zones to choose), `self-topic` (my zones), original-materials library (`release-file-info`, `release-list-file`).
- "证据卡片" nav = GEO card optimization (`/geo-card-optimization`, views/geo-card/GeoCardOptimization.vue): topic → Python task (`search/submit` with optional task_id/topic_id; list/status/stop/regenerate) → generated evidence cards (Markdown with numbered references, utils/generatedEvidenceMarkdown.js) → submitted to zones → staff review above.

### Personalized recommendations (Vue home) (READ)
- views/home/components/PersonalizedRecommendations.vue:1-60 (authenticated only) ← `/recommendation-api/api/recommend/personalized` (api/home.js:102-108); item kinds literature / guide / drug instruction / evidence card (views/home/homeRecommendations.js:19-40), evidence items carry creator, reviewer + institution, zone link.

### Relation to OpenScience (READ + INFER)
- Same concept, two implementations, no data link: Vue zones/cards live in the Java news-api; OpenScience zones/cards live in `evimed_frontier.evidence_*`. Neither calls the other's zone API (grep). The OpenScience review states "No implicit legacy migration … neither silently imported nor treated as public" (review.html, Native integration section).
- The Vue shell embeds OpenScience pages via wujie/iframe `/research/<page>` → `/app/<page>?embed=1` for chat, knowledge, memory, autopilot, frontier, geo, capabilities, inbox, report, account (components/science/ScienceSubApp.vue:60-130; api/science.js:472-515). So `/research/frontier/zones…` shows OpenScience zones inside the Vue shell, while the Vue sidebar's own 证据专区 opens the Java zones (Sidebar index.vue:606) — two "证据专区" in one product.
- The only data bridge in code: the knowledge-source plugin's `evimed-api` access reads the team's EviMed data API for two frontier sources (ChiCTR, guideline index) (项目代码/knowledge-plugin/registry/extra-sources.json:5-66). Not cards.
- Differences that matter for the loop: Vue has (1) upload→AI card generation→finalize→publish-to-zone submission→zone owner/staff review with reward, (2) expert reviewers with institutions, scores and rank lists, (3) a personalized recommendation feed that includes cards, (4) public navigation. OpenScience has (1) source-retained, hash-bound cards with AI author/AI reviewer receipts and publication-status maintenance, (2) single-owner zones without submission or co-editing, (3) no recommendation of cards, (4) login-only reading.

### Clarification (READ evals/acceptance/2026-10-04-evolution.json liveEvidence.toolWakeV2)
- "publication-triggered continuation" in the 759f2502a message = a newly PUBLISHED evolution TOOL (event `tool-ready`, evolutionComposition.mjs:313) resolving a waiting agenda (`evolution-waiter`) and resuming it via autopilot.wakeForEvolution — recorded as "Actual publication-triggered wake, copied engineering fixture; not a fourth developed method or genuine researcher use". It is NOT a paper/frontier publication triggering research. (Frontier publications trigger scouts and prospective/temporal matching, not agendas.)

## Cross-checks (READ)
- GEO / VCR: no reference to result versions, evidence zones/cards, or frontier content in geo*.mjs / vcr*.mjs (grep; "frontier" hits are comments only; "autopilot" hits are the shared error code autopilot_capability_unavailable in geoOrchestrator.mjs:82 / vcrOrchestrator.mjs:113). GEO's claim library is imported from its own geo-insight run (server.mjs:2654-2658); VCR has its own evidence store/pool.
- No notification on zone follow/new card: evidenceEditorial.mjs and evidenceZoneService.mjs never import notifications; frontierNotifications.mjs targets safety/weekly/daily only.
- Ownership/deletion: evidence_zones.user_id and evidence_cards.user_id REFERENCE evimed_control.users ON DELETE CASCADE (evidenceZonePersistence.mjs:5, :13) — platform-imported zones are owned by the operator account given to the import script (`--owner`), so deleting that account deletes the platform's published evidence.
- Frontier "深入研究" (FrontierCard.tsx:115) and zone "问这个专区/问这条证据" are unsent chat drafts; the resulting run keeps no reference to the item/card.
- Billing of zone automation: evidenceTarget/evidenceCard/evidenceReview go through FrontierEditor's call with userId/projectId = the operator's internal frontier project, purpose `frontier`, governed by the module's daily budget (frontierEditor.mjs:938-948). EvidenceEditorial.automation() checks only zone ownership (evidenceEditorial.mjs:84-90), not operator role — so any frontier-audience account that creates a zone and enables updates gets AI-written, auto-published cards paid from the platform's frontier budget.
