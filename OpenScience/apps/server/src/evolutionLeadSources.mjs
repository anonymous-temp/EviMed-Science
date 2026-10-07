/**
 * What the platform's own modules could not do, handed to 循证进化 as research leads (evidence-flywheel plan §5.5, F20, 2026-10-06): the
 * evidence programme (a topic that needed an analysis its engine did not deliver), 循证 GEO (a question that needs an analysis no capability
 * offers) and 虚拟临研 (a method the engine does not publish).
 *
 * Hidden knowledge:
 *
 * - **A lead from these sources is a closed code and closed entity keys, and nothing else.** The evolution module has always reduced a
 *   tenant's lead to a closed gap code (`addLead` keeps that reduction); here the code itself is chosen from a list this module owns — a
 *   capability id the programme runs, a fixed "no capability offers it" code, or the family of the method a study asked for — and the entity
 *   keys are the drug, disease and trial keys of the shared glossary. A method name a researcher typed is dropped to its family
 *   (`comparator`, `design`, …) and a closed endpoint type: the name itself could carry anything. Identifiers (DOI, PMID, registry numbers) are
 *   dropped too — they name a particular study. What remains says "someone needed a comparator analysis for a time-to-event endpoint in
 *   atrial fibrillation", which an operator may read, and carries no account, project, study or sentence.
 * - **Only the programme is read; the other two are asked.** The programme records, on each day's decision, which episode ended
 *   `no_engine_receipt` (an analysis engine ran and left no receipt of its calculation), so the daily scan reads those records and nothing is
 *   pushed. 循证 GEO has no closed field marking a question as needing an analysis nobody offers, and 虚拟临研 persists no asked method outside the
 *   engine's published list (a job's method is fixed by its kind): both are exposed as an `offer` the module can call where it learns this, and
 *   neither is called by anything today. That is said here so that nobody reads an adapter's presence as a signal flowing.
 * - **A lead costs a scouting run, so the intake is bounded.** A lead is idempotent by its content (the same code and keys, from any number of
 *   accounts, is one lead and one run), and no more than `perDay` new leads of these sources are taken in a day; the rest are counted as
 *   deferred, not queued for later — the scan or the module offers them again.
 * - **Off is nothing.** Composed only when the evolution module is on and its own switch is; an adapter whose module is off is not composed.
 *
 * @module evolutionLeadSources
 */
import { VCR_ENGINE_METHOD_IDS, autopilotEpisodeCapability } from "@evimed/domain";
import { ENTITY_TEXT_KINDS, keyKind, splitKeys } from "@evimed/domain/entity-keys";
import { HttpError } from "./security.mjs";
import { EVIDENCE_PROJECT_ID } from "./internalProjects.mjs";
import { ORIGINAL_ANALYSIS_ENGINES, programmeZoneByKey } from "./evidenceProgrammeData.mjs";

/** The lead sources of this module, which the domain's `EVOLUTION_LEAD_SOURCES` lists and a test holds equal. */
export const MODULE_LEAD_SOURCES = Object.freeze(["evidence-programme", "communication", "virtual-study"]);
/** What the study's endpoint may be, in the engine's own words. */
export const LEAD_ENDPOINTS = Object.freeze(["continuous", "binary", "time_to_event"]);
/** The method families the engine publishes, from its method ids. */
export const VCR_METHOD_FAMILIES = Object.freeze([...new Set(VCR_ENGINE_METHOD_IDS.map((id) => id.split(".")[0]))].sort());
/** The most entity keys one lead carries. */
export const LEAD_ENTITY_KEY_LIMIT = 8;
export const COMMUNICATION_CODE = "analysis-not-offered";
/** New leads of these sources taken in a day, by default. */
export const MODULE_LEADS_DEFAULT_PER_DAY = 5;
/** How many recent decisions the programme scan reads. */
const PROGRAMME_DECISIONS_READ = 14;

/** The closed codes each source may use, and the gap code each states. */
const SOURCE_RULES = Object.freeze({
  "evidence-programme": { gapCode: "method-implementation", codes: Object.keys(ORIGINAL_ANALYSIS_ENGINES) },
  communication: { gapCode: "method-missing", codes: [COMMUNICATION_CODE] },
  "virtual-study": { gapCode: "method-missing", codes: [...VCR_METHOD_FAMILIES.map((family) => `vcr-${family}`), "vcr-other"] },
});

/** The drug, disease and trial keys of a list, sorted and bounded: the subjects, never an organisation or an identifier. @param {unknown} keys */
export function leadEntityKeys(keys) {
  return splitKeys(keys).entityKeys.filter((key) => ENTITY_TEXT_KINDS.includes(/** @type {any} */ (keyKind(key)))).slice(0, LEAD_ENTITY_KEY_LIMIT);
}

/**
 * The payload of a lead from one of these sources, or a refusal naming the lead vocabulary: a source the module does not own, a code outside that
 * source's closed list, a gap code the source does not state, an endpoint outside the engine's three. Nothing else of the input is read.
 * @param {{ source?: unknown, gapCode?: unknown, code?: unknown, endpoint?: unknown, entityKeys?: unknown, userId?: string, projectId?: string, sourceEventId?: string, evidenceVersion?: string }} input
 * @returns {{ track: "M", source: string, gapCode: string, code: string, entityKeys: string[], endpoint?: string }}
 */
export function moduleLeadPayload(input) {
  const rule = typeof input?.source === "string" && Object.hasOwn(SOURCE_RULES, input.source) ? SOURCE_RULES[/** @type {keyof typeof SOURCE_RULES} */ (input.source)] : null;
  if (!rule || input.gapCode !== rule.gapCode || typeof input.code !== "string" || !rule.codes.includes(input.code)) {
    throw new HttpError(400, "evolution_lead_invalid", "Unknown evolution lead vocabulary.");
  }
  const endpoint = typeof input.endpoint === "string" && LEAD_ENDPOINTS.includes(input.endpoint) ? input.endpoint : null;
  return { track: "M", source: /** @type {string} */ (input.source), gapCode: rule.gapCode, code: input.code, entityKeys: input.userId ? [] : leadEntityKeys(input.entityKeys), ...(endpoint ? { endpoint } : {}) };
}

/**
 * The evidence programme's recent decisions, as the platform publisher keeps them in its evidence project (a product document of kind `programme-decision`, one a
 * day), newest first, and the subject keys of an official zone from the glossary its topic terms are tagged with. Here and not in the composition because the
 * composition reads no document pages itself.
 * @param {{ documents: any, publisherId: string, decisionKind: string, entityVocabulary: any }} options
 */
export function programmeLeadReader({ documents, publisherId, decisionKind, entityVocabulary }) {
  return {
    decisions: async () => {
      const page = await documents.list(publisherId, decisionKind, { limit: PROGRAMME_DECISIONS_READ, projectId: EVIDENCE_PROJECT_ID });
      return page.items.map((/** @type {any} */ row) => row.payload);
    },
    keysForZone: async (/** @type {string} */ zoneKey) => leadEntityKeys(await entityVocabulary.keysForText({ texts: [...(programmeZoneByKey(zoneKey)?.topic.terms ?? [])] })),
  };
}

/**
 * @param {{ service: any, perDay?: number, now?: () => Date, report?: ((code: string) => void) | null,
 *   programme?: { decisions: () => Promise<any[]>, keysForZone: (zoneKey: string) => Promise<string[]> } | null,
 *   communication?: boolean, virtualStudy?: boolean }} options
 *   `programme` is composed when the evidence programme is; `communication` and `virtualStudy` when their modules are.
 */
export function createEvolutionLeadSources({ service, perDay = MODULE_LEADS_DEFAULT_PER_DAY, now = () => new Date(), report = null, programme = null, communication = false, virtualStudy = false }) {
  const counters = {
    offered: /** @type {Record<string, number>} */ (Object.fromEntries(MODULE_LEAD_SOURCES.map((source) => [source, 0]))),
    outcomes: /** @type {Record<string, number>} */ ({ lead: 0, duplicate: 0, deferred: 0, refused: 0, supported: 0, failed: 0 }),
    scans: 0,
  };

  /** New leads of these sources the module took since the platform's local midnight (Asia/Shanghai). */
  async function takenToday() {
    const day = new Date(now().getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    const since = Date.parse(`${day}T00:00:00+08:00`);
    let taken = 0;
    for (const source of MODULE_LEAD_SOURCES) {
      for (const row of await service.list("lead", null, { source })) if (row.payload?.source === source && Date.parse(row.createdAt) >= since) taken += 1;
    }
    return taken;
  }

  /**
   * One lead, through the module's own intake. Never throws: a source offering a lead is never harmed by the loop refusing it.
   * @param {Parameters<typeof moduleLeadPayload>[0]} input
   */
  async function lead(input) {
    try {
      const payload = moduleLeadPayload(input);
      counters.offered[payload.source] += 1;
      const prior = await service.get(service.leadId(payload));
      if (!prior && await takenToday() >= perDay) { counters.outcomes.deferred += 1; return { state: "deferred" }; }
      const saved = await service.addLead({ ...payload, userId: input.userId, projectId: input.projectId, sourceEventId: input.sourceEventId, evidenceVersion: input.evidenceVersion });
      if (prior && saved?.revision === prior.revision) { counters.outcomes.duplicate += 1; return { state: "duplicate" }; }
      counters.outcomes.lead += 1;
      return { state: "lead" };
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "evolution_lead_invalid") { counters.outcomes.refused += 1; return { state: "refused" }; }
      counters.outcomes.failed += 1;
      report?.(typeof /** @type {any} */ (error)?.code === "string" ? `evolution_lead_source_${/** @type {any} */ (error).code}` : "evolution_lead_source_failed");
      return { state: "failed" };
    }
  }

  /**
   * The evidence programme's own record of what it could not compute: each episode of an analysis engine that ended `no_engine_receipt` becomes one lead
   * for that engine's capability, with the subject keys of the zone it was run for. Replayable: the same record is the same lead.
   */
  async function scanProgramme() {
    if (!programme) return { read: 0, leads: 0 };
    counters.scans += 1;
    let read = 0;
    let leads = 0;
    for (const decision of (await programme.decisions()).slice(0, PROGRAMME_DECISIONS_READ)) {
      for (const action of Array.isArray(decision?.actions) ? decision.actions : []) {
        const outcome = decision.outcomes?.[action?.episodeId];
        if (outcome?.outcome !== "no_engine_receipt" || !programmeZoneByKey(String(action.zone))) continue;
        const capabilityId = autopilotEpisodeCapability(String(action.taskType));
        if (typeof capabilityId !== "string") continue;
        read += 1;
        const result = await lead({ source: "evidence-programme", gapCode: "method-implementation", code: capabilityId, sourceEventId: `programme:${action.episodeId}`, entityKeys: await programme.keysForZone(String(action.zone)).catch(() => []) });
        if (result.state === "lead") leads += 1;
      }
    }
    return { read, leads };
  }

  /** @type {Record<string, any>} */
  const composed = {};
  if (programme) composed.programme = { scan: scanProgramme };
  if (communication) {
    /**
     * A question of a 循证 GEO project that needs an analysis no capability offers. Nothing calls this today: the module has no field marking it.
     * @param {{ entityKeys?: unknown, userId?: string, projectId?: string, sourceEventId?: string, evidenceVersion?: string }} input
     */
    composed.communication = { offer: (input) => input?.userId && input?.projectId && input?.sourceEventId
      ? lead({ source: "communication", gapCode: "method-missing", code: COMMUNICATION_CODE, userId: input.userId, projectId: input.projectId, sourceEventId: input.sourceEventId, evidenceVersion: input.evidenceVersion })
      : Promise.resolve({ state: "refused", reason: "owner-event-required" }) };
  }
  if (virtualStudy) {
    /**
     * A method a 虚拟临研 study asked for. One the engine publishes is not a lead; any other is, as its family and the study's endpoint. Nothing calls
     * this today: a job's method is fixed by its kind, so no asked method outside the list is persisted.
     * @param {{ asked?: unknown, endpoint?: unknown, entityKeys?: unknown, userId?: string, projectId?: string, sourceEventId?: string }} input
     */
    composed.virtualStudy = {
      offer: async (input) => {
        const asked = typeof input?.asked === "string" ? input.asked : "";
        if (VCR_ENGINE_METHOD_IDS.includes(/** @type {any} */ (asked))) { counters.outcomes.supported += 1; return { state: "supported" }; }
        if(!input.userId || !input.projectId || !input.sourceEventId)return {state:"refused",reason:"owner-event-required"};
        const family = asked.split(".")[0];
        return lead({ source: "virtual-study", gapCode: "method-missing", code: VCR_METHOD_FAMILIES.includes(family) ? `vcr-${family}` : "vcr-other", endpoint: input?.endpoint, userId:input.userId, projectId:input.projectId, sourceEventId:input.sourceEventId });
      },
    };
  }

  return { ...composed, scan: async () => (programme ? scanProgramme() : { read: 0, leads: 0 }), stats: () => ({ offered: { ...counters.offered }, outcomes: { ...counters.outcomes }, scans: counters.scans, perDay }) };
}

/**
 * @param {ReturnType<ReturnType<typeof createEvolutionLeadSources>["stats"]> | null | undefined} stats
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function evolutionLeadSourceMetricFamilies(stats) {
  if (!stats) return [];
  return [
    { name: "open_science_evolution_module_leads_offered_total", type: "counter", help: "Leads the platform's own modules offered 循证进化, by source: the evidence programme, 循证 GEO and 虚拟临研.",
      series: MODULE_LEAD_SOURCES.map((source) => ({ value: stats.offered[source] ?? 0, labels: { source } })) },
    { name: "open_science_evolution_module_leads_total", type: "counter", help: "What became of each offered lead: taken, already known, deferred past the day's bound, refused for its vocabulary, supported already by the engine, or failed.",
      series: Object.entries(stats.outcomes).map(([outcome, value]) => ({ value, labels: { outcome } })) },
    { name: "open_science_evolution_module_leads_per_day", type: "gauge", help: "The most new module leads taken in a day (OPEN_SCIENCE_EVOLUTION_MODULE_LEADS_PER_DAY).", series: [{ value: stats.perDay }] },
  ];
}
