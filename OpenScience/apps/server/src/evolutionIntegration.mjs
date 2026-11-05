import { autopilotEpisodeCapability } from "@evimed/domain";
import { isInternalProject } from "./internalProjects.mjs";

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
 * What a finished run says about a missing method, if anything. A run fails for a spent budget, a stopped container, a
 * cancel, a provider outage; none of those is a tool the platform lacks, and turning each into a lead made every failure
 * of every researcher a job for the module. Only a tool or engine the run could not use is a gap in the platform's
 * methods: the closed code `runtime_tool_error` on a run recorded before 2026-10-04, and since then, when a tool failure
 * the run did not get past no longer ends it, the `run_tool_failed` notice on a run that finished (review D-E20). A tool
 * that is not mounted at all is `run_tool_unavailable`, a missing tool of its own; the tools a run found missing are
 * read from its own transcript (the handbook gap).
 * @param {{errorCode?: string | null, qualityNotices?: readonly {code?: string}[] | null}} run @returns {"method-implementation" | null}
 */
export function evolutionRunGap(run) {
  if (run?.errorCode === "runtime_tool_error") return "method-implementation";
  return (run?.qualityNotices ?? []).some((notice) => notice?.code === "run_tool_failed") ? "method-implementation" : null;
}

/** The other modules publish observations through the durable evolution queue. */
export class EvolutionIntegration {
  /** @param {{service:any,autopilot:any,report?:(code:string)=>void}} input */
  constructor({ service, autopilot, report = () => {} }) {
    this.service = service; this.autopilot = autopilot; this.report = report;
    this.counters = { published: 0, failed: 0 };
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

  /** The event types serving consumes (`EVOLUTION_SERVING_EVENT_TYPES`); the worker closes any other. @param {any} event */
  async consume(event) {
    if (event.type === "researcher-feedback") {
      if (!this.service.callbacks.observeFeedback) throw new Error('Evolution feedback consumer is unavailable.');
      return this.service.callbacks.observeFeedback({ id: event.sourceFeedbackId, userId: event.userId, projectId: event.projectId,
        runId: event.runId, trigger: event.trigger, detail: { kind: event.correctionKind }, occurredAt: event.occurredAt });
    } else if (event.type === "autopilot-gap") {
      const need = event.waiting;
      if (!need || !["tool", "data"].includes(need.kind)) return;
      const matchedTool = need.toolId ? await this.service.get(need.toolId) : null;
      await this.service.waitFor({ userId: event.userId, projectId: event.projectId, agendaId: event.agendaId,
        sourceEpisodeId: event.sourceEpisodeId, kind: need.kind, capabilityId: need.capabilityId, methodId: need.methodId,
        toolId: need.toolId, requirementId: need.requirementId, dataRequirements: matchedTool?.payload?.dataRequirements ?? null });
      await this.service.addLead({ source: "autopilot", track: need.kind === "data" ? "U" : "M",
        gapCode: event.gapCode, code: need.capabilityId ?? event.gapCode, userId: event.userId, projectId: event.projectId, sourceEventId: event.id });
    } else if (event.type === "dataset-ready") {
      await this.service.resolveWaiters(event);
      return this.service.retireEarlierDatasetEvents(event);
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
        for (const item of latest.values()) await this.service.resolveWaiters(item);
      }
      return this.service.resolveWaiters(event);
    } else if (event.type === "runtime-gap") {
      return this.service.addLead({ source: "runtime-failure",
        track: event.track ?? "M", gapCode: event.gapCode, code: event.code, userId: event.userId, projectId: event.projectId, sourceEventId: event.id });
    }
  }

  /** Discover tenant owners by record type, without selecting their source or dataset content. */
  async observationOwners() {
    const database = this.service.documents.database;
    if (!database?.query) return await this.service.callbacks.waiterOwners?.() ?? [];
    const result = await database.query("SELECT DISTINCT user_id FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-event' AND payload->>'type'='dataset-ready'");
    return result.rows.map(row => row.user_id);
  }

  /** @param {any} input */
  wakeAgenda(input) { return this.autopilot.wakeForEvolution(input); }
  /** Account-local completion only; shared reports use thresholded counts. @param {any} input */
  recordResumedResearchCompleted(input) { return this.service.callbacks.recordResumedResearchCompleted?.(input); }
}
