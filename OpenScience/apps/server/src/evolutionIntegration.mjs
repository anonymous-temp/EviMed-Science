import { createHash } from "node:crypto";
import { autopilotEpisodeCapability, evolutionDataMatch } from "@evimed/domain";
import { isInternalProject } from "./internalProjects.mjs";

/** @param {any} value */
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** @param {any} value */
const fact = (value) => value && typeof value === "object" && "value" in value ? value.value : value;

/** Metadata projection only: patient rows and sample values never enter platform evolution. @param {any} asset */
export function evolutionDatasetMetadata(asset) {
  const tables = Array.isArray(asset?.tables) ? asset.tables : [];
  const checks = asset?.lastCheck;
  return {
    fields: tables.flatMap((table) => (table.variables ?? table.columns ?? []).map((column) => ({
      name: column.name, type: fact(column.facts?.type ?? column.type) === 'text' ? 'string' : fact(column.facts?.type ?? column.type), unit: fact(column.facts?.unit ?? column.unit),
      coding: fact(column.facts?.codeSystem), categories: fact(column.facts?.allowedValues)?.map(value => value.code),
    }))),
    rowRepresents: fact(tables[0]?.facts?.observationUnit),
    population: fact(asset?.facts?.population ?? asset?.population),
    semanticsChecks: { checkedAt: checks?.checkedAt ?? null, passedFamilies: [...new Set([...(checks?.clean ?? []).map(item => item.family), ...((checks?.findings ?? []).some(item => item.family === 'drift' && item.outcome === 'source_unchanged') && !(checks?.findings ?? []).some(item => item.family === 'drift' && (item.severity === 'attention' || item.outcome === 'source_changed')) && !(checks?.notChecked ?? []).some(item => item.family === 'drift') ? ['drift'] : [])])], attentionFamilies: (checks?.findings ?? []).filter(item => item.severity === "attention").map(item => item.family), unavailableFamilies: (checks?.notChecked ?? []).map(item => item.family) },
    semanticsChecksPassed: Boolean(checks?.checkedAt && checks.clean?.length > 0 && !checks.findings?.some((item) => item.severity === "attention")
      && !checks.notChecked?.length),
    sourceVersions: (asset?.bindings ?? []).map((binding) => ({ sha256: binding.sha256 ?? binding.source?.sha256 })),
  };
}

/**
 * What a failed run says about a missing method, if anything. A run fails for a spent budget, a stopped container, a
 * cancel, a provider outage; none of those is a tool the platform lacks, and turning each into a lead made every failure
 * of every researcher a job for the module. Only the one closed code that names a tool or engine the run could not use
 * is a gap in the platform's methods; the tools a run found missing are read from its own transcript (the handbook gap).
 * @param {{errorCode?: string | null}} run @returns {"method-implementation" | null}
 */
export function evolutionRunGap(run) { return run?.errorCode === "runtime_tool_error" ? "method-implementation" : null; }

/** The other modules publish observations through the durable evolution queue. */
export class EvolutionIntegration {
  /** @param {{service:any,autopilot:any,judgeService?:any,report?:(code:string)=>void}} input */
  constructor({ service, autopilot, judgeService = null, report = () => {} }) {
    this.service = service; this.autopilot = autopilot; this.report = report; this.judgeService = judgeService;
    this.counters = { published: 0, failed: 0, scoutsQueued: 0, scoutsSkipped: 0 };
  }

  /** An optional consumer cannot undo the scientific work that emitted its event.
   * @param {any} event @param {{runAfter?:Date}} [options] */
  async publish(event, options = {}) {
    try { const saved = await this.service.ingestEvent(event, options); this.counters.published++; return saved; }
    catch (error) { this.counters.failed++; this.report(error?.code ?? "evolution_event_unavailable"); return null; }
  }

  /** @param {any} agenda */
  async availableTools(agenda) {
    const capabilities = (agenda.payload?.taskTypes ?? []).map(autopilotEpisodeCapability).filter(Boolean);
    const tools = await this.service.availableTools();
    return tools.filter((tool) => !tool.capabilityIds?.length || tool.capabilityIds.some((id) => capabilities.includes(id)));
  }

  /** No researcher prose is copied into a shared lead. @param {any} input */
  async plannerStopped(input) {
    if (isInternalProject(input.projectId)) return;
    return this.publish({ id: `autopilot:${input.agendaId}:${input.episodeId}`, type: "autopilot-gap", userId: input.userId,
      projectId: input.projectId, agendaId: input.agendaId, sourceEpisodeId: input.episodeId,
      gapCode: input.resourceNeed.kind === "tool" ? "method-missing" : "connector", waiting: input.resourceNeed,
      origin: "platform-inference" });
  }

  /** @param {any} input */
  async datasetChanged(input) {
    if (isInternalProject(input.projectId)) return;
    return this.publish({ id: `dataset:${input.projectId}:${input.datasetId}:${input.revision}`, type: "dataset-ready",
      userId: input.userId, projectId: input.projectId, datasetId: input.datasetId,
      dataset: evolutionDatasetMetadata(input.asset), origin: "tool-result" });
  }

  /** @param {any} event */
  async consume(event) {
    if (event.type === "researcher-feedback") {
      if (!this.service.callbacks.observeFeedback) throw new Error('Evolution feedback consumer is unavailable.');
      return this.service.callbacks.observeFeedback({ id: event.sourceFeedbackId, userId: event.userId, projectId: event.projectId,
        runId: event.runId, trigger: event.trigger, detail: { kind: event.correctionKind }, occurredAt: event.occurredAt });
    } else if (event.type === "evaluation-gap") {
      return this.service.addLead({source:"evaluation",track:event.track,gapCode:event.gapCode,method:event.methodId??event.capabilityId,origin:"platform-inference",features:{capabilityId:event.capabilityId??null,count:event.count}});
    } else if (event.type === "evaluation-adjudication") {
      const evaluation=await this.service.get(event.evaluationId);
      const unit=evaluation?.payload.units?.[event.unitIndex];
      const review=unit?.disagreement;
      if(review?.codeVerified!==true || review.verificationProof?.proofHash!==event.proofHash || !['paper_error','reasonable_difference'].includes(review.verdict)) return;
      return this.service.callbacks.adjudicationOpportunity?.({evaluationId:evaluation.id,proofHash:event.proofHash,verdict:review.verdict,publicPaperId:/^(?:10\.\d{4,9}\/[^\s]{1,180}|PMID:\d+|PMC\d+)$/i.test(unit?.publishedPaperId??'') ? unit.publishedPaperId : null});
    } else if (event.type === "handbook-gap-scan") {
      return this.service.callbacks.scanHandbookGaps?.();
    } else if (event.type === "lead-source-scan") {
      return this.service.callbacks.scanLeadSources?.();
    } else if (event.type === "source-facts-scan") {
      return this.observeSourceFacts();
    } else if (event.type === "autopilot-gap") {
      const need = event.waiting;
      if (!need || !["tool", "data"].includes(need.kind)) return;
      const matchedTool = need.toolId ? await this.service.get(need.toolId) : null;
      await this.service.waitFor({ userId: event.userId, projectId: event.projectId, agendaId: event.agendaId,
        sourceEpisodeId: event.sourceEpisodeId, kind: need.kind, capabilityId: need.capabilityId, methodId: need.methodId,
        toolId: need.toolId, requirementId: need.requirementId, dataRequirements: matchedTool?.payload?.dataRequirements ?? null });
      await this.service.addLead({ source: "autopilot", track: need.kind === "data" ? "U" : "M",
        gapCode: event.gapCode, code: need.capabilityId ?? event.gapCode });
    } else if (event.type === "dataset-ready") {
      await this.datasetOpportunities(event);
      return this.service.resolveWaiters(event);
    } else if (event.type === "tool-ready") {
      const owners = event.userId ? [event.userId] : await this.observationOwners();
      for (const owner of owners) {
        const latest = new Map();
        for (const row of await this.service.list("event", owner)) {
          const item = row.payload;
          if (item.type !== "dataset-ready" || (event.userId && item.projectId !== event.projectId)) continue;
          const key = `${item.projectId}:${item.datasetId}`;
          if (!latest.has(key) || item.createdAt > latest.get(key).createdAt) latest.set(key, item);
        }
        for (const item of latest.values()) { await this.datasetOpportunities(item); await this.service.resolveWaiters(item); }
      }
      return this.service.resolveWaiters(event);
    } else if (event.type === "prospective-target-scan") {
      return this.service.callbacks.pollProspectiveTargets?.();
    } else if (event.type === "prospective-target-result") {
      return this.matchProspectivePublication(event);
    } else if (event.type === "frontier-publication") {
      await this.temporalObservation(event);
      await this.matchProspectivePublication(event);
      return this.scoutPublication(event);
    } else if (event.type === "meta-evidence-update") {
      return this.metaUpdateOpportunity(event);
    } else if (["runtime-gap", "handbook-gap"].includes(event.type)) {
      return this.service.addLead({ source: event.type === "runtime-gap" ? "runtime-failure" : "handbook",
        track: event.track ?? "M", gapCode: event.gapCode, code: event.code });
    }
  }

  /** J17 is the ranking-only interpretation of J10: never assign a capability, drop a paper,
   * or supply a scientific finding. Any unavailable judgment preserves the batch's FIFO order.
   * Existing scout admission alone owns the daily count and scheduling behind admitted work.
   * @param {any[]} events @returns {Promise<any[]>} */
  async rankPublications(events) {
    if (!this.judgeService || events.length < 2) return events;
    const ranked = [];
    for (const [index, event] of events.entries()) {
      try {
        const result = await this.judgeService.judge("J17", {
          title: String(event.paper?.title ?? "").slice(0, 400),
          abstract: String(event.paper?.excerpt ?? event.paper?.abstract ?? "").slice(0, 1500),
        }, { userId: await this.service.owner(), projectId: "evimed-evolution", taskId: event.id,
          module: "evolution", limits: { daily: 0, weekly: 0, moduleDaily: this.service.config?.evolutionDailyBudgetCny ?? 10 } });
        const probability = result?.value?.relevance;
        if (result?.outcome !== "settled" || !Number.isFinite(probability) || probability < 0 || probability > 1) return events;
        ranked.push({ event: { ...event, scoutRanking: { source: "judge", site: "J17", relevance: probability,
          model: result.model ?? null, promptFingerprint: result.promptFingerprint ?? null } }, index, probability });
      } catch { return events; }
    }
    return ranked.sort((left, right) => right.probability - left.probability || left.index - right.index)
      .map((item, slot) => ({ ...item.event, scoutRanking: { ...item.event.scoutRanking, slot } }));
  }

  /**
   * A paper in the feed is a lead for a scouting run, and a run is paid work, so it is bounded three ways: one run
   * per paper however many times the feed changes it, no more than `evolutionMaxPaperScoutsPerDay` in any 24 hours
   * (inside the module's own daily budget, which this only keeps from being spent on reading alone), and never ahead
   * of a build or an evaluation the module has already admitted, which the queue would otherwise serve after it.
   * A paper the day has no room for is not queued for later; the daily scan still looks at the literature.
   * @param {any} event
   * @returns {Promise<any>}
   */
  async scoutPublication(event) {
    const paper = event.paper;
    const key = `publication:${digest(paper?.identity ?? paper?.id ?? event.id).slice(0, 32)}`;
    const database = this.service.documents.database;
    const admit = async () => {
      let runAfter = this.service.now();
      if (database?.query) {
        const cap = this.service.config?.evolutionMaxPaperScoutsPerDay ?? 8;
        const state = await database.query(`SELECT count(*) FILTER (WHERE kind='evolution-scout' AND payload->'paper' IS NOT NULL AND created_at>$2)::integer AS scouts,
            max(run_after) FILTER (WHERE kind IN ('evolution-build','evolution-evaluate') AND status IN ('queued','running')) AS admitted_until
          FROM evimed_product.jobs WHERE user_id=$1 AND kind IN ('evolution-scout','evolution-build','evolution-evaluate')`,
        [await this.service.owner(), new Date(runAfter.getTime() - 86_400_000)]);
        const row = state.rows[0] ?? {};
        const exists = await database.query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND idempotency_key=$2", [await this.service.owner(), `evolution:${key}`]);
        if (!exists.rows.length && Number(row.scouts ?? 0) >= cap) { this.counters.scoutsSkipped++; return { scouted: false, reason: "daily-cap" }; }
        const admitted = row.admitted_until ? new Date(row.admitted_until) : null;
        if (admitted && admitted > runAfter) runAfter = admitted;
      }
      const slot = event.scoutRanking?.source === "judge" && event.scoutRanking.site === "J17"
        && Number.isInteger(event.scoutRanking.slot) && event.scoutRanking.slot >= 0 && event.scoutRanking.slot < 25
        ? event.scoutRanking.slot : 0;
      // The admitted-work floor must not collapse all scouts onto one timestamp.
      runAfter = new Date(runAfter.getTime() + slot);
      this.counters.scoutsQueued++;
      return this.service.enqueue("scout", { paper }, key, runAfter);
    };
    if (database?.transaction && database.withTransactionClient) {
      const owner = await this.service.owner();
      return database.transaction((/** @type {any} */ client) => database.withTransactionClient(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-evolution:paper-scout-admission:${owner}`]);
        return admit();
      }));
    }
    return admit();
  }

  /** Source contracts do not expose a verified cutoff or prediction; preserve that uncertainty. */
  async observeSourceFacts() {
    const owners = new Set([await this.service.owner(), ...await this.observationOwners()]);
    let observed = 0;
    for (const owner of owners) {
      let cursor = null;
      do {
        const page = await this.service.documents.list(owner, "knowledge", { limit: 100, cursor,
          filter: { recordType: "source-understanding" } });
        for (const row of page.items) {
          const record = row.payload;
          if (record.status !== "current") continue;
          const output = record.output;
          const design = output?.slots?.design;
          const meta = design?.state === "known" && /meta[- ]analysis|systematic review|荟萃|系统评价/i.test(design.value)
            && design.evidence?.length > 0;
          const protocol = output?.docType === "research-protocol";
          if (!meta && !protocol) continue;
          const source = await this.service.documents.get(owner, "source", record.sourceId);
          if (!source || !source.payload.fingerprint?.sha256
            || (source.payload.currentUnderstandingId && source.payload.currentUnderstandingId !== row.id)
            || (source.payload.generation != null && source.payload.generation !== record.generation)) continue;
          const id = `evolution-source-observation-${digest([owner, row.projectId, record.sourceId, record.generation, meta ? "meta" : "prospective"])}`;
          await this.service.save("observation", id, { projectId: row.projectId, sourceId: record.sourceId,
            sourceSha256: source.payload.fingerprint.sha256, sourceUnderstandingId: row.id, generation: record.generation,
            kind: meta ? "meta-update-candidate" : "prospective-registration-candidate", status: "waiting",
            missingFacts: meta ? ["verified-search-cutoff", "exact-new-study-question", "earliest-public-evidence"]
              : ["versioned-tool", "platform-prediction", "preregistered-target", "model-release-provenance"],
            reason: meta ? "The preserved source identifies an evidence synthesis, but its contract has no verified search cutoff or exact correspondence to a new study."
              : "A source protocol is not a frozen platform prediction. No prospective answer or scoring claim has been created.",
            origin: "tool-result" }, null, owner);
          observed++;
        }
        cursor = page.cursor ?? page.nextCursor ?? null;
      } while (cursor);
    }
    return { observed };
  }

  /** Discover tenant owners by record type, without selecting their source or dataset content. */
  async observationOwners() {
    const database = this.service.documents.database;
    if (!database?.query) return await this.service.callbacks.waiterOwners?.() ?? [];
    const result = await database.query("SELECT DISTINCT user_id FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND (payload->>'recordType'='source-understanding' OR (payload->>'recordType'='evolution-event' AND payload->>'type'='dataset-ready'))");
    return result.rows.map(row => row.user_id);
  }

  /** An update is a new research opportunity; the published analysis is immutable. @param {any} event */
  async metaUpdateOpportunity(event) {
    if (!event.userId || !event.projectId || isInternalProject(event.projectId)) return;
    const original = event.originalMeta;
    const incoming = event.newEvidence;
    const cutoff = Date.parse(original?.searchCutoff ?? "");
    const published = Date.parse(incoming?.firstPublicAt ?? "");
    const supported = Boolean(original?.sourceId && original?.sha256 && original?.questionId
      && incoming?.sourceId && incoming?.sha256 && incoming?.firstPublicEvidenceId
      && original.questionId === incoming.questionId && original.sourceId !== incoming.sourceId
      && Number.isFinite(cutoff) && Number.isFinite(published) && published > cutoff);
    const id = `evolution-meta-update-${digest([event.userId, event.projectId, original?.sourceId, original?.sha256, incoming?.sourceId, incoming?.sha256])}`;
    if (!supported) return this.service.save("observation", id, { projectId: event.projectId,
      kind: "meta-update-candidate", status: "waiting", origin: "platform-inference",
      reason: "Preserved source identities, search cutoff, exact question correspondence, or public provenance are incomplete." }, null, event.userId);
    return this.service.addOpportunity({ id, userId: event.userId, projectId: event.projectId,
      status: "available", title: "核对新增研究是否需要更新已有荟萃分析", taskTypes: ["evidence-update"],
      prompt: `保留原始荟萃分析 ${original.sourceId}（${original.sha256}）不变，检视新增研究 ${incoming.sourceId}（${incoming.sha256}）。先核对问题、纳入条件和重复发表，再判断是否值得开展独立的更新分析。新增文献不自动证明原结论失效。`,
      basis: { kind: "post-cutoff-preserved-evidence", originalSourceId: original.sourceId,
        originalSha256: original.sha256, searchCutoff: original.searchCutoff,
        newSourceId: incoming.sourceId, newSha256: incoming.sha256, firstPublicEvidenceId: incoming.firstPublicEvidenceId },
    });
  }

  /** Freeze a prospective question before the target result becomes public. @param {any} input */
  async freezeProspective(input) {
    if (!input.toolId || !input.artifactDigest || !input.question || !input.targetIdentity || !input.prediction
      || !input.modelReleaseEvidenceId || !input.preRegisteredProtocol) throw new TypeError("Prospective registration requires a versioned tool, exact target, prediction, and preregistered protocol.");
    const frozenAt = this.service.now().toISOString();
    const content = { question: input.question, prediction: input.prediction, targetIdentity: input.targetIdentity,
      toolId: input.toolId, artifactDigest: input.artifactDigest, preRegisteredProtocol: input.preRegisteredProtocol };
    const questionHash = digest(content);
    const id = `evolution-prospective-${questionHash}`;
    const prior = await this.service.get(id);
    if (prior) return prior;
    return this.service.save("prospective", id, {
      ...content, questionHash, frozenAt, status: "waiting-publication", modelReleaseEvidenceId: input.modelReleaseEvidenceId,
      modelReleasedAt: input.modelReleasedAt ?? null, origin: "platform-inference", exposed: null,
    });
  }

  /** Exact preregistered targets only; matching is not a verified prospective success. @param {any} event */
  async matchProspectivePublication(event) {
    const paper = event.paper;
    const registrations = await this.service.list("prospective");
    for (const row of registrations) {
      const record = row.payload;
      if (!["waiting-publication", "waiting-provenance"].includes(record.status) || record.targetIdentity !== paper?.identity) continue;
      const publicAt = Date.parse(paper.firstPublicAt ?? "");
      const frozenAt = Date.parse(record.frozenAt);
      const releasedAt = Date.parse(record.modelReleasedAt ?? "");
      const eligible = Boolean(record.registrationEligible !== false && paper.firstPublicEvidenceId && Number.isFinite(publicAt) && Number.isFinite(releasedAt)
        && publicAt > frozenAt && publicAt > releasedAt);
      await this.service.save("prospective", row.id, { ...record, status: eligible ? "awaiting-gold" : "waiting-provenance",
        paperId: paper.id, firstPublicAt: paper.firstPublicAt ?? null, firstPublicEvidenceId: paper.firstPublicEvidenceId ?? null,
        matchedPublicationEventId: event.id, caseGroup: "prospective" }, row);
      if (eligible) await this.service.enqueue("evaluate", { action: "prospective-score", registrationId: row.id, paperId: paper.id, publicationEventId: event.id }, `prospective-score:${row.id}:${event.id}`);
    }
    // The predictions a virtual study or an agenda registered for this trial are woken by the same publication (flywheel F25); it never throws.
    await this.service.callbacks.predictionPublication?.({ paper, eventId: event.id });
  }

  /** Public publication dates alone cannot establish absence of training exposure. @param {any} event */
  async temporalObservation(event) {
    const paper = event.paper;
    if (!paper?.id) return;
    const tools = await this.service.tools();
    for (const row of tools) {
      const tool = row.payload;
      if (tool.status === "retired") continue;
      const earliestPublic = Date.parse(paper.firstPublicAt ?? "");
      const modelReleased = Date.parse(tool.modelReleasedAt ?? "");
      const frozen = Date.parse(tool.frozenAt ?? "");
      const provenanceComplete = Boolean(paper.firstPublicEvidenceId && tool.modelReleaseEvidenceId
        && tool.artifactDigest && Number.isFinite(earliestPublic) && Number.isFinite(modelReleased) && Number.isFinite(frozen));
      const eligible = provenanceComplete && earliestPublic > modelReleased && earliestPublic > frozen;
      await this.service.save("observation", `evolution-temporal-${digest([paper.id, row.id, tool.artifactDigest])}`, {
        kind: "temporal-evaluation-candidate", status: eligible ? "awaiting-gold" : "waiting",
        caseGroup: eligible ? "time-holdout" : "development", paperId: paper.id, toolId: row.id, artifactDigest: tool.artifactDigest,
        publishedAt: paper.publishedAt, firstPublicAt: paper.firstPublicAt ?? null,
        firstPublicEvidenceId: paper.firstPublicEvidenceId ?? null,
        reason: eligible ? "Independent preserved gold and an exposure audit are required before evaluation."
          : "Earliest public appearance, model release, or frozen tool provenance is unknown or ineligible.",
        exposed: null, origin: "literature",
      });
    }
  }

  /** Matching metadata establishes feasibility, never a scientific finding. @param {any} event */
  async datasetOpportunities(event) {
    if (!event.userId || !event.projectId || isInternalProject(event.projectId)) return [];
    const tools = await this.service.availableTools();
    const results = [];
    for (const tool of tools) {
      if (!tool.dataRequirements) continue;
      const match = evolutionDataMatch(tool.dataRequirements, event.dataset);
      const id = `evolution-data-match-${digest([event.userId, event.projectId, event.datasetId, event.id, tool.id, tool.artifactDigest])}`;
      if (!match.matched) {
        results.push(await this.service.save("observation", id, {
          projectId: event.projectId, status: "waiting", kind: "dataset-tool-match", datasetId: event.datasetId, toolId: tool.id,
          matchStatus: "unmatched", reasons: match.issues ?? [], origin: "platform-inference",
        }, null, event.userId));
        continue;
      }
      results.push(await this.service.addOpportunity({ id, userId: event.userId, projectId: event.projectId,
        datasetId: event.datasetId, toolId: tool.id, toolVersion: tool.artifactDigest, status: "available",
        title: `使用 ${tool.name ?? tool.id} 检查已有数据的研究可行性`, taskTypes: ["data-prospecting"],
        prompt: `先核对数据 ${event.datasetId} 的版本和语义，再使用工具 ${tool.id}（版本 ${tool.artifactDigest ?? "unknown"}）进行自检。元数据匹配仅说明输入要求可满足，不能视为科研结果；未知或不符合要求时停止并说明需要补充的信息。`,
        basis: { kind: "metadata-contract-match", sourceEventId: event.id, sourceVersions: event.dataset.sourceVersions ?? [] },
      }));
    }
    return results;
  }

  /** @param {any} input */
  wakeAgenda(input) { return this.autopilot.wakeForEvolution(input); }
}

/** The furthest back the feed's changes are read when the module has not looked for longer than this. */
export const EVOLUTION_FRONTIER_LOOKBACK_MS = 3 * 86_400_000;

/**
 * Read the frontier's existing change stream; checkpoint only after the durable event exists.
 * The first look at a feed is its present, never its history (a deployment's feed may hold thousands of papers, each
 * of which would be a paid scouting run), a cursor that has fallen further behind than the look-back jumps to it,
 * and only a paper's publication is read: the feed also records every rescoring and selection of an item.
 */
export class EvolutionFrontierSignals {
  /** @param {{database:any,service:any,integration:EvolutionIntegration}} input */
  constructor({ database, service, integration }) { this.database = database; this.service = service; this.integration = integration; }
  async tick() {
    const id = "evolution-frontier-cursor";
    const cursor = await this.service.get(id);
    if (!cursor) {
      const head = Number((await this.database.query("SELECT coalesce(max(seq),0) AS head FROM evimed_frontier.item_changes")).rows[0]?.head ?? 0);
      await this.service.save("cursor", id, { sequence: head, startedAt: this.service.now().toISOString() }, null);
      return { sequence: head, count: 0, digest: digest(head) };
    }
    const saved = Number(cursor.payload?.sequence ?? 0);
    const floor = Number((await this.database.query("SELECT coalesce(max(seq),0) AS floor FROM evimed_frontier.item_changes WHERE changed_at<=$1",
      [new Date(this.service.now().getTime() - EVOLUTION_FRONTIER_LOOKBACK_MS)])).rows[0]?.floor ?? 0);
    const after = Math.max(saved, floor);
    const found = await this.database.query(`SELECT c.seq, i.id, i.title_raw, i.canonical_url, i.published_at,
      i.identity_key, t.abstract_raw, t.body_excerpt FROM evimed_frontier.item_changes c
      JOIN evimed_frontier.items i ON i.id=c.item_id LEFT JOIN evimed_frontier.item_texts t ON t.item_id=i.id
      WHERE c.seq>$1 AND c.op='upsert' AND c.reason='published' AND i.state='published' ORDER BY c.seq LIMIT 25`, [after]);
    const events = found.rows.map(row => ({ id: `frontier:${row.seq}`, type: "frontier-publication", origin: "literature",
      paper: { id: String(row.id), title: row.title_raw, url: row.canonical_url,
        publishedAt: row.published_at, identity: row.identity_key,
        excerpt: String(row.abstract_raw ?? row.body_excerpt ?? "").slice(0, 24_000) } }));
    const ordered = await this.integration.rankPublications(events);
    const persisted = new Set();
    const rankedAt = this.service.now().getTime();
    for (const [index, event] of ordered.entries()) {
      // The lease uses run_after then id, not creation order. Explicit millisecond
      // slots retain the ranking even when the clock and database timestamps tie.
      const options = event.scoutRanking?.source === "judge" ? { runAfter: new Date(rankedAt + index) } : {};
      if (!await this.integration.publish(event, options)) break;
      persisted.add(event.id);
    }
    // Ranked arrival is not cursor order. Checkpoint only the contiguous durable prefix,
    // so a failure after a high-sequence item can never lose an earlier publication.
    let sequence = after;
    for (const row of found.rows) {
      if (!persisted.has(`frontier:${row.seq}`)) break;
      sequence = Number(row.seq);
    }
    if (sequence > saved) await this.service.save("cursor", id, { sequence }, cursor);
    return { sequence, count: found.rows.length, digest: digest(sequence) };
  }
}
