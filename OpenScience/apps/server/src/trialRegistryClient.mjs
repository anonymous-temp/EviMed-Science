/**
 * Structured reads of the trial registries 「虚拟临研」 parameterizes from
 * (build plan 2026-09-28 §6.2, §6.4; attachment A2 conclusion 4).
 *
 * Hidden knowledge:
 *
 * - **A registry record is evidence, so it is preserved before it is read.**
 *   Every number this module hands on carries a quotation and a locator, and
 *   the quotation has to be findable in `record.text` — the deterministic
 *   rendering of the record this module also returns. Extraction and
 *   verification are separate code paths on purpose (`vcrEvidence.mjs` does
 *   the checking): a client that invented a number would have to invent the
 *   same number twice, in two different shapes, to get it past AC-25.
 * - **The rendering is of a reduced record, not of the bytes the registry
 *   sent.** NCT04368728 answers 2.1 MB — 628 serious-event rows and 175 sites
 *   — and none of that is a design parameter. `REDUCED_MODULES` is the
 *   whitelist, so the preserved text is reproducible from the registry id plus
 *   this constant, and `recordHash` is the sha256 of the reduced record, not
 *   of the wire body (the wire body carries `lastUpdatePostDateStruct`, which
 *   changes without any field we read changing).
 * - **ESTIMATED and ACTUAL never merge.** CT.gov marks enrollment and all
 *   three milestone dates with their type; the planned figure is the sponsor's
 *   intention and the actual figure is what happened. Both are kept, both are
 *   labelled, and `historicalBaseline` is false for everything ESTIMATED —
 *   「计划入组 120 例 18 个月，实际 96 例 26 个月」 is the most useful accrual
 *   prior there is precisely because the two are apart (plan §6.4).
 * - **What the registry does not carry is named, never zeroed.** Screening
 *   failure rate, per-site accrual and site activation dates are not in
 *   CT.gov, AACT, ICTRP or CTIS (attachment A2 conclusion 4). They come back
 *   in `unavailable` with a reason, so the page can print 「不可得」 and the
 *   pipeline can refuse to treat an absent field as 0.
 * - **Derived is not extracted.** The number of sites, the number of
 *   countries and the accrual duration in months are computed here from fields
 *   that were quoted, so they carry `valueSource: "calculated"` and name their
 *   inputs. Only a figure copied out of a field is `extracted`.
 * - **Offline is a named answer.** With no network, a refused host or a
 *   deadline, every entry point returns `{ status: "registry_unavailable",
 *   reason }` and no items. A registry that answered nothing is never an empty
 *   result set: 「查不到」 and 「没查」 are different findings, and the second
 *   one must not become a precedent library with no precedents in it.
 * - **One deadline, a retry cap, and a bounded body.** Every attempt for one
 *   call shares one deadline, retries stop at `maxAttempts`, and a response is
 *   abandoned at `MAX_RESPONSE_BYTES` while it streams rather than buffered
 *   whole and then refused.
 * - **ChiCTR has no public API** (`source_catalog.json` says
 *   `blocked_no_api`), and WHO ICTRP's own export is not a query API either.
 *   The seat for them is `chictrAdapter` — an injected function over EviMed's
 *   `/review/api/clinical-trial` (`registry: 0`), which the control plane
 *   already reaches through `publicSourceGateway`. Unconfigured means
 *   `registry_unavailable`, never an empty list.
 *
 * Wire facts, recorded from the live API on 2026-09-28 (not from the docs):
 * `GET /api/v2/studies/{nctId}?format=json` answers the record at top level
 * (`protocolSection`, `resultsSection`, `documentSection`, `derivedSection`,
 * `hasResults`) with no envelope; `GET /api/v2/studies?...&countTotal=true`
 * answers `{ totalCount, studies: [...], nextPageToken }`; `fields=` takes a
 * `|`-separated list of dotted paths and prunes the record to them, which is
 * what keeps a search page at 1 KB instead of 2 MB. An outcome measure's
 * effect estimate lives in `analyses[]` as `{ paramType: "Hazard Ratio (HR)",
 * paramValue, ciPctValue, ciLowerLimit, ciUpperLimit, pValue,
 * statisticalMethod }`; the arm-wise values live in
 * `classes[].categories[].measurements[]` keyed by `groupId`, with the
 * denominators in `denoms[].counts[]`.
 *
 * @module trialRegistryClient
 */

import { createHash } from "node:crypto";

import { VCR_ENROLLMENT_KINDS } from "@evimed/domain";

/** The registries this module speaks, by the name a precedent row stores. */
export const TRIAL_REGISTRIES = Object.freeze(["clinicaltrials.gov", "chictr"]);

export const CTGOV_BASE_URL = "https://clinicaltrials.gov/api/v2";
/** A study page on the registry, for a citation a reader can open. */
export const CTGOV_STUDY_URL = "https://clinicaltrials.gov/study/";

/** Answers this module gives instead of data. Named so a page can print them. */
export const REGISTRY_UNAVAILABLE = "registry_unavailable";
export const REGISTRY_NOT_FOUND = "registry_not_found";

/** At most this much of one answer is read, counted while it streams. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** At most this much preserved text per record (the reduction keeps it far below). */
const MAX_RECORD_TEXT_CHARS = 400_000;
/** Waits between attempts, inside the call's one deadline. */
const RETRY_BACKOFF_MS = Object.freeze([500, 2_000, 5_000]);
/** Sites are listed for the country counts; the full list is not a design parameter. */
const MAX_LOCATIONS_KEPT = 200;
/** A registry id, as a path segment. Anything else is refused before a request. */
const REGISTRY_ID = /^[A-Za-z][A-Za-z0-9-]{2,63}$/;

/**
 * The quantities every trial registry is missing, with the reason a page
 * prints. A caller that wants one of these gets 「不可得」 and a source to ask,
 * never a zero (plan §6.2).
 */
export const REGISTRY_UNAVAILABLE_PARAMETERS = Object.freeze({
  screen_failure_rate: "登记平台不记录筛选失败率；只能来自合作方或申办方自己的漏斗",
  screened_count: "登记平台不记录筛选人数；只记录入组人数",
  accrual_per_site_per_month: "登记平台不记录每中心入组数；可由合作方历史漏斗替换",
  site_activation_date: "登记平台不记录中心启动日期；只记录研究整体的开始日期",
  protocol_amendment_count: "登记平台不公开方案修订次数",
});

/**
 * What the reduction keeps. A module not named here never reaches the
 * preserved text, so the text is reproducible from the registry id and this
 * list. `adverseEventsModule` is deliberately out: 628 rows of serious events
 * are a safety read, not a design parameter, and they would dominate the
 * preserved bytes a quote is checked against.
 */
export const REDUCED_MODULES = Object.freeze({
  protocolSection: Object.freeze([
    "identificationModule", "statusModule", "sponsorCollaboratorsModule", "descriptionModule",
    "conditionsModule", "designModule", "armsInterventionsModule", "outcomesModule",
    "eligibilityModule", "contactsLocationsModule",
  ]),
  resultsSection: Object.freeze(["participantFlowModule", "baselineCharacteristicsModule", "outcomeMeasuresModule"]),
  derivedSection: Object.freeze(["conditionBrowseModule", "interventionBrowseModule"]),
});

/** @param {unknown} value */
const text = (value) => String(value ?? "").trim();

/**
 * CT.gov's `ACTUAL` / `ESTIMATED` marker, as the word `evimed_vcr` stores.
 * The mapping goes through `@evimed/domain`'s vocabulary rather than two
 * string literals, so a registry word this build does not know reads as `null`
 * — 「不知道是计划还是实际」 — instead of quietly becoming a baseline.
 * @param {unknown} value @returns {string | null}
 */
function enrollmentKindOf(value) {
  const word = text(value).toLowerCase();
  return VCR_ENROLLMENT_KINDS.includes(word) ? word : null;
}
/** @param {unknown} value @returns {number | null} */
function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, "").replace(/^[<>=~]+/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** A bounded read of a response body: abandoned the moment it passes `limit`. */
export async function readBoundedBody(response, limit = MAX_RESPONSE_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("The registry answer is too large."), { code: "response_too_large" });
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The record, reduced to the modules a design parameter can come from. Returns
 * a new object; the input is never mutated.
 * @param {any} record
 */
export function reducedRegistryRecord(record) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [section, modules] of Object.entries(REDUCED_MODULES)) {
    const source = record?.[section];
    if (!source || typeof source !== "object") continue;
    /** @type {Record<string, any>} */
    const kept = {};
    for (const name of modules) {
      if (source[name] === undefined) continue;
      kept[name] = source[name];
    }
    if (Object.keys(kept).length) out[section] = kept;
  }
  const locations = out.protocolSection?.contactsLocationsModule?.locations;
  if (Array.isArray(locations) && locations.length > MAX_LOCATIONS_KEPT) {
    out.protocolSection.contactsLocationsModule = {
      ...out.protocolSection.contactsLocationsModule,
      locations: locations.slice(0, MAX_LOCATIONS_KEPT),
      // The count is what the design parameter needs, and it is stated rather
      // than inferred from a truncated array — a length read off a slice is a
      // wrong number that looks right.
      locationsTotal: locations.length,
    };
  }
  if (record?.hasResults !== undefined) out.hasResults = record.hasResults;
  return out;
}

/**
 * The record as the one text every quotation from it is checked against: one
 * line per leaf, `path: value`, in the record's own key order (stable, because
 * the reduction copies keys in `REDUCED_MODULES` order and JSON preserves
 * insertion order). Whitespace inside a value is kept as it came; the quote
 * comparison folds it.
 * @param {any} reduced
 * @param {{ header?: string }} [options]
 */
export function renderRegistryRecordText(reduced, { header = "" } = {}) {
  /** @type {string[]} */
  const lines = [];
  if (header) lines.push(header, "");
  /** @param {any} node @param {string} path */
  const walk = (node, path) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
      return;
    }
    lines.push(`${path}: ${String(node)}`);
  };
  walk(reduced, "");
  const body = lines.join("\n");
  return body.length > MAX_RECORD_TEXT_CHARS ? `${body.slice(0, MAX_RECORD_TEXT_CHARS)}\n…（记录过长，已截断）` : body;
}

/** The sha256 of the reduced record, which is what a locator refers to. @param {any} reduced */
export function registryRecordHash(reduced) {
  return createHash("sha256").update(JSON.stringify(reduced)).digest("hex");
}

/**
 * One extracted value, in the shape `evidence_items` stores and
 * `vcrEvidence.mjs` verifies.
 * @param {{ parameter: string, arm?: string | null, value?: number | null, valueText?: string,
 *   unit?: string, ciLow?: number | null, ciHigh?: number | null, sampleSize?: number | null,
 *   events?: number | null, valueSource?: string, quote: string, path: string, sourceRef: string,
 *   enrollmentKind?: string | null, historicalBaseline?: boolean, inputs?: string[], detail?: Record<string, unknown> }} input
 */
function extraction(input) {
  return {
    parameter: input.parameter,
    arm: input.arm ?? null,
    value: input.value ?? null,
    valueText: input.valueText ?? "",
    unit: input.unit ?? "",
    ciLow: input.ciLow ?? null,
    ciHigh: input.ciHigh ?? null,
    sampleSize: input.sampleSize ?? null,
    events: input.events ?? null,
    valueSource: input.valueSource ?? "extracted",
    quote: input.quote,
    sourceRef: input.sourceRef,
    locator: {
      kind: "registry_field",
      path: input.path,
      ...(input.inputs?.length ? { inputs: input.inputs } : {}),
    },
    enrollmentKind: input.enrollmentKind ?? null,
    // Only a figure the registry states as having happened may become a
    // historical baseline; a sponsor's plan never does (plan §6.2).
    historicalBaseline: input.historicalBaseline ?? false,
    detail: input.detail ?? {},
  };
}

/** `path: value` exactly as `renderRegistryRecordText` writes it. @param {string} path @param {unknown} value */
const quoteOf = (path, value) => `${path}: ${String(value)}`;

/** CT.gov's `paramType` strings, mapped to the parameter names an assumption card uses. */
const EFFECT_PARAMETERS = Object.freeze({
  "Hazard Ratio (HR)": { parameter: "hazard_ratio", scale: "log" },
  "Hazard Ratio": { parameter: "hazard_ratio", scale: "log" },
  "Odds Ratio (OR)": { parameter: "odds_ratio", scale: "log" },
  "Odds Ratio": { parameter: "odds_ratio", scale: "log" },
  "Risk Ratio (RR)": { parameter: "risk_ratio", scale: "log" },
  "Risk Ratio": { parameter: "risk_ratio", scale: "log" },
  "Mean Difference (Final Values)": { parameter: "mean_difference", scale: "identity" },
  "Mean Difference (Net)": { parameter: "mean_difference", scale: "identity" },
  "Risk Difference (RD)": { parameter: "risk_difference", scale: "identity" },
});

/** CT.gov's outcome `paramType`, mapped to what the value means. */
const OUTCOME_PARAMETERS = Object.freeze({
  MEDIAN: { parameter: "median_time", kind: "time" },
  NUMBER: { parameter: "outcome_value", kind: "value" },
  MEAN: { parameter: "mean_value", kind: "value" },
  COUNT_OF_PARTICIPANTS: { parameter: "participants_with_event", kind: "count" },
  COUNT_OF_UNITS: { parameter: "units_counted", kind: "count" },
  GEOMETRIC_MEAN: { parameter: "geometric_mean", kind: "value" },
  LEAST_SQUARES_MEAN: { parameter: "least_squares_mean", kind: "value" },
});

/** Months between two ISO-ish dates (`YYYY-MM` or `YYYY-MM-DD`), or null. */
export function monthsBetween(from, to) {
  const parse = (/** @type {string} */ value) => {
    const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text(value));
    return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3] ?? "1") } : null;
  };
  const start = parse(from);
  const end = parse(to);
  if (!start || !end) return null;
  const months = (end.year - start.year) * 12 + (end.month - start.month) + (end.day - start.day) / 30.4375;
  return Number.isFinite(months) ? Math.round(months * 10) / 10 : null;
}

/**
 * A CT.gov record, as a precedent row plus the values that can be quoted out
 * of it. Pure: no network, no clock, no store — which is why the offline tests
 * exercise the whole extraction.
 *
 * @param {any} record the record as the registry answered it
 * @param {{ retrievedAt?: string }} [options]
 */
export function ctgovPrecedent(record, { retrievedAt = "" } = {}) {
  const reduced = reducedRegistryRecord(record);
  const protocol = reduced.protocolSection ?? {};
  const identification = protocol.identificationModule ?? {};
  const status = protocol.statusModule ?? {};
  const design = protocol.designModule ?? {};
  const arms = protocol.armsInterventionsModule ?? {};
  const outcomes = protocol.outcomesModule ?? {};
  const eligibility = protocol.eligibilityModule ?? {};
  const contacts = protocol.contactsLocationsModule ?? {};
  const conditions = protocol.conditionsModule ?? {};
  const sponsors = protocol.sponsorCollaboratorsModule ?? {};
  const results = reduced.resultsSection ?? {};

  const registryId = text(identification.nctId);
  const sourceRef = `ctgov:${registryId}`;
  const recordHash = registryRecordHash(reduced);
  const url = registryId ? `${CTGOV_STUDY_URL}${encodeURIComponent(registryId)}` : "";
  const recordText = renderRegistryRecordText(reduced, {
    header: `${registryId} · ClinicalTrials.gov${retrievedAt ? ` · retrieved ${retrievedAt}` : ""}`,
  });

  /** @type {ReturnType<typeof extraction>[]} */
  const extractions = [];

  // -- enrollment, planned and actual kept apart -----------------------------
  const enrollment = design.enrollmentInfo ?? {};
  const enrollmentCount = number(enrollment.count);
  const enrollmentKind = enrollmentKindOf(enrollment.type);
  if (enrollmentCount !== null) {
    const path = "protocolSection.designModule.enrollmentInfo.count";
    extractions.push(extraction({
      parameter: enrollmentKind === "actual" ? "enrollment_actual" : "enrollment_estimated",
      value: enrollmentCount,
      unit: "participants",
      quote: quoteOf(path, enrollment.count),
      path,
      sourceRef,
      enrollmentKind,
      historicalBaseline: enrollmentKind === "actual",
      detail: { registryType: text(enrollment.type) },
    }));
  }

  // -- milestone dates, each with its own ACTUAL / ESTIMATED type ------------
  /** @type {Record<string, { date: string, type: string }>} */
  const milestones = {};
  for (const [field, name] of [
    ["startDateStruct", "start_date"],
    ["primaryCompletionDateStruct", "primary_completion_date"],
    ["completionDateStruct", "completion_date"],
  ]) {
    const struct = status[field];
    const date = text(struct?.date);
    if (!date) continue;
    // A milestone with no type is the sponsor's plan until it says otherwise.
    const kind = enrollmentKindOf(struct?.type) ?? "estimated";
    milestones[name] = { date, type: kind };
    const path = `protocolSection.statusModule.${field}.date`;
    extractions.push(extraction({
      parameter: name,
      valueText: date,
      quote: quoteOf(path, date),
      path,
      sourceRef,
      enrollmentKind: kind,
      historicalBaseline: kind === "actual",
      detail: { registryType: text(struct?.type) },
    }));
  }
  // Accrual duration is computed from two quoted dates, so it is `calculated`
  // and names them. It is only a historical baseline when both dates are.
  const accrual = monthsBetween(milestones.start_date?.date ?? "", milestones.primary_completion_date?.date ?? "");
  if (accrual !== null) {
    extractions.push(extraction({
      parameter: "accrual_to_primary_completion_months",
      value: accrual,
      unit: "months",
      valueSource: "calculated",
      quote: quoteOf("protocolSection.statusModule.startDateStruct.date", milestones.start_date.date),
      path: "protocolSection.statusModule",
      sourceRef,
      inputs: [
        "protocolSection.statusModule.startDateStruct.date",
        "protocolSection.statusModule.primaryCompletionDateStruct.date",
      ],
      historicalBaseline: milestones.start_date.type === "actual" && milestones.primary_completion_date.type === "actual",
      detail: { from: milestones.start_date.date, to: milestones.primary_completion_date.date },
    }));
  }

  // -- sites and countries: derived from the location list -------------------
  const locations = Array.isArray(contacts.locations) ? contacts.locations : [];
  const locationsTotal = number(contacts.locationsTotal) ?? locations.length;
  if (locationsTotal) {
    extractions.push(extraction({
      parameter: "site_count",
      value: locationsTotal,
      unit: "sites",
      valueSource: "calculated",
      quote: quoteOf("protocolSection.contactsLocationsModule.locations[0].country", text(locations[0]?.country)),
      path: "protocolSection.contactsLocationsModule.locations",
      sourceRef,
      inputs: ["protocolSection.contactsLocationsModule.locations"],
      historicalBaseline: true,
      detail: { truncated: locations.length < locationsTotal },
    }));
  }
  const countries = [...new Set(locations.map((/** @type {any} */ item) => text(item?.country)).filter(Boolean))].sort();

  // -- participant flow: started, completed, and every withdrawal reason -----
  const flow = results.participantFlowModule ?? {};
  /** @type {Map<string, string>} */
  const flowGroups = new Map();
  for (const group of Array.isArray(flow.groups) ? flow.groups : []) {
    if (group?.id) flowGroups.set(String(group.id), text(group.title));
  }
  const periods = Array.isArray(flow.periods) ? flow.periods : [];
  periods.forEach((period, periodIndex) => {
    for (const [milestoneIndex, milestone] of (Array.isArray(period?.milestones) ? period.milestones : []).entries()) {
      const type = text(milestone?.type).toUpperCase();
      const parameter = type === "STARTED" ? "arm_started" : type === "COMPLETED" ? "arm_completed"
        : type === "NOT COMPLETED" ? "arm_not_completed" : null;
      if (!parameter) continue;
      for (const [achievementIndex, achievement] of (Array.isArray(milestone?.achievements) ? milestone.achievements : []).entries()) {
        const subjects = number(achievement?.numSubjects);
        if (subjects === null) continue;
        const path = `resultsSection.participantFlowModule.periods[${periodIndex}].milestones[${milestoneIndex}].achievements[${achievementIndex}].numSubjects`;
        extractions.push(extraction({
          parameter,
          arm: flowGroups.get(String(achievement?.groupId)) ?? String(achievement?.groupId ?? ""),
          value: subjects,
          unit: "participants",
          quote: quoteOf(path, achievement.numSubjects),
          path,
          sourceRef,
          historicalBaseline: true,
          detail: { period: text(period?.title), groupId: text(achievement?.groupId) },
        }));
      }
    }
    for (const [dropIndex, drop] of (Array.isArray(period?.dropWithdraws) ? period.dropWithdraws : []).entries()) {
      for (const [reasonIndex, reason] of (Array.isArray(drop?.reasons) ? drop.reasons : []).entries()) {
        const subjects = number(reason?.numSubjects);
        if (subjects === null) continue;
        const path = `resultsSection.participantFlowModule.periods[${periodIndex}].dropWithdraws[${dropIndex}].reasons[${reasonIndex}].numSubjects`;
        extractions.push(extraction({
          parameter: "arm_withdrawn",
          arm: flowGroups.get(String(reason?.groupId)) ?? String(reason?.groupId ?? ""),
          value: subjects,
          unit: "participants",
          quote: quoteOf(path, reason.numSubjects),
          path,
          sourceRef,
          historicalBaseline: true,
          detail: { reason: text(drop?.type), period: text(period?.title), groupId: text(reason?.groupId) },
        }));
      }
    }
  });

  // -- outcome measures: arm-wise values and the effect estimates ------------
  const outcomeMeasures = Array.isArray(results.outcomeMeasuresModule?.outcomeMeasures)
    ? results.outcomeMeasuresModule.outcomeMeasures : [];
  outcomeMeasures.forEach((measure, measureIndex) => {
    const groups = new Map();
    for (const group of Array.isArray(measure?.groups) ? measure.groups : []) {
      if (group?.id) groups.set(String(group.id), text(group.title));
    }
    /** @type {Map<string, number>} */
    const denominators = new Map();
    for (const denom of Array.isArray(measure?.denoms) ? measure.denoms : []) {
      for (const count of Array.isArray(denom?.counts) ? denom.counts : []) {
        const value = number(count?.value);
        if (value !== null && count?.groupId) denominators.set(String(count.groupId), value);
      }
    }
    const paramType = text(measure?.paramType).toUpperCase();
    const mapped = OUTCOME_PARAMETERS[/** @type {keyof typeof OUTCOME_PARAMETERS} */ (paramType)];
    const outcomeTitle = text(measure?.title);
    const timeFrame = text(measure?.timeFrame);
    if (mapped) {
      (Array.isArray(measure?.classes) ? measure.classes : []).forEach((klass, classIndex) => {
        (Array.isArray(klass?.categories) ? klass.categories : []).forEach((category, categoryIndex) => {
          (Array.isArray(category?.measurements) ? category.measurements : []).forEach((measurement, measurementIndex) => {
            const value = number(measurement?.value);
            if (value === null) return;
            const path = `resultsSection.outcomeMeasuresModule.outcomeMeasures[${measureIndex}].classes[${classIndex}].categories[${categoryIndex}].measurements[${measurementIndex}].value`;
            extractions.push(extraction({
              parameter: mapped.parameter,
              arm: groups.get(String(measurement?.groupId)) ?? String(measurement?.groupId ?? ""),
              value,
              unit: text(measure?.unitOfMeasure),
              ciLow: number(measurement?.lowerLimit),
              ciHigh: number(measurement?.upperLimit),
              sampleSize: denominators.get(String(measurement?.groupId)) ?? null,
              quote: quoteOf(path, measurement.value),
              path,
              sourceRef,
              historicalBaseline: true,
              detail: {
                outcome: outcomeTitle,
                outcomeType: text(measure?.type),
                timeFrame,
                dispersion: text(measure?.dispersionType),
                class: text(klass?.title),
                category: text(category?.title),
                groupId: text(measurement?.groupId),
              },
            }));
          });
        });
      });
    }
    (Array.isArray(measure?.analyses) ? measure.analyses : []).forEach((analysis, analysisIndex) => {
      const effect = EFFECT_PARAMETERS[/** @type {keyof typeof EFFECT_PARAMETERS} */ (text(analysis?.paramType))];
      const value = number(analysis?.paramValue);
      if (!effect || value === null) return;
      const path = `resultsSection.outcomeMeasuresModule.outcomeMeasures[${measureIndex}].analyses[${analysisIndex}].paramValue`;
      extractions.push(extraction({
        parameter: effect.parameter,
        arm: (Array.isArray(analysis?.groupIds) ? analysis.groupIds : [])
          .map((/** @type {any} */ id) => groups.get(String(id)) ?? String(id)).join(" vs ") || null,
        value,
        ciLow: number(analysis?.ciLowerLimit),
        ciHigh: number(analysis?.ciUpperLimit),
        quote: quoteOf(path, analysis.paramValue),
        path,
        sourceRef,
        historicalBaseline: true,
        detail: {
          outcome: outcomeTitle,
          timeFrame,
          scale: effect.scale,
          statisticalMethod: text(analysis?.statisticalMethod),
          confidenceLevel: number(analysis?.ciPctValue),
          sides: text(analysis?.ciNumSides),
          pValue: text(analysis?.pValue),
          nonInferiorityType: text(analysis?.nonInferiorityType),
        },
      }));
    });
  });

  const armGroups = (Array.isArray(arms.armGroups) ? arms.armGroups : []).map((/** @type {any} */ group) => ({
    label: text(group?.label),
    type: text(group?.type),
    interventions: Array.isArray(group?.interventionNames) ? group.interventionNames.map(text) : [],
  }));

  const precedent = {
    registry: "clinicaltrials.gov",
    registryId,
    title: text(identification.briefTitle) || text(identification.officialTitle) || registryId,
    pico: {
      conditions: Array.isArray(conditions.conditions) ? conditions.conditions.map(text) : [],
      keywords: Array.isArray(conditions.keywords) ? conditions.keywords.map(text) : [],
      interventions: (Array.isArray(arms.interventions) ? arms.interventions : [])
        .map((/** @type {any} */ item) => ({ type: text(item?.type), name: text(item?.name) }))
        .filter((/** @type {{name: string}} */ item) => item.name),
      mesh: [
        ...(reduced.derivedSection?.conditionBrowseModule?.meshes ?? []),
        ...(reduced.derivedSection?.interventionBrowseModule?.meshes ?? []),
      ].map((/** @type {any} */ item) => text(item?.term)).filter(Boolean),
      sex: text(eligibility.sex),
      minimumAge: text(eligibility.minimumAge),
      maximumAge: text(eligibility.maximumAge),
      stdAges: Array.isArray(eligibility.stdAges) ? eligibility.stdAges.map(text) : [],
      healthyVolunteers: eligibility.healthyVolunteers ?? null,
    },
    design: {
      studyType: text(design.studyType),
      phases: Array.isArray(design.phases) ? design.phases.map(text) : [],
      allocation: text(design.designInfo?.allocation),
      interventionModel: text(design.designInfo?.interventionModel),
      primaryPurpose: text(design.designInfo?.primaryPurpose),
      masking: text(design.designInfo?.maskingInfo?.masking),
      whoMasked: Array.isArray(design.designInfo?.maskingInfo?.whoMasked) ? design.designInfo.maskingInfo.whoMasked.map(text) : [],
      arms: armGroups,
      leadSponsor: text(sponsors.leadSponsor?.name),
      overallStatus: text(status.overallStatus),
      hasResults: Boolean(reduced.hasResults),
    },
    enrollment: {
      planned: enrollmentKind === "estimated" ? enrollmentCount : null,
      actual: enrollmentKind === "actual" ? enrollmentCount : null,
      registryType: text(enrollment.type),
      milestones,
      accrualToPrimaryCompletionMonths: accrual,
    },
    enrollmentKind,
    sites: {
      count: locationsTotal || null,
      countries,
      countryCount: countries.length || null,
      listTruncated: locations.length < locationsTotal,
    },
    eligibilityText: text(eligibility.eligibilityCriteria),
    endpoints: [
      ...(Array.isArray(outcomes.primaryOutcomes) ? outcomes.primaryOutcomes : [])
        .map((/** @type {any} */ item) => ({ role: "primary", measure: text(item?.measure), timeFrame: text(item?.timeFrame), description: text(item?.description) })),
      ...(Array.isArray(outcomes.secondaryOutcomes) ? outcomes.secondaryOutcomes : [])
        .map((/** @type {any} */ item) => ({ role: "secondary", measure: text(item?.measure), timeFrame: text(item?.timeFrame), description: text(item?.description) })),
    ],
    results: {
      hasResults: Boolean(reduced.hasResults),
      outcomeMeasures: outcomeMeasures.length,
      baselineDenominators: (Array.isArray(results.baselineCharacteristicsModule?.denoms) ? results.baselineCharacteristicsModule.denoms : [])
        .flatMap((/** @type {any} */ denom) => (Array.isArray(denom?.counts) ? denom.counts : [])
          .map((/** @type {any} */ count) => ({ groupId: text(count?.groupId), value: number(count?.value), units: text(denom?.units) }))),
    },
    sources: [{ kind: "registry", registry: "clinicaltrials.gov", registryId, url, recordHash, retrievedAt }],
    fetchedAt: retrievedAt || null,
    // Named absences travel with the record so a page can print 「不可得」
    // beside the fields that do exist (plan §6.2).
    unavailable: Object.entries(REGISTRY_UNAVAILABLE_PARAMETERS).map(([parameter, reason]) => ({ parameter, reason })),
  };

  return {
    precedent,
    extractions,
    record: { sourceRef, url, text: recordText, hash: recordHash, reduced },
  };
}

/**
 * A ChiCTR / EviMed record, as far as the shared evidence API carries one.
 * The adapter's answer is the documented shape of
 * `POST /review/api/clinical-trial` (接口文档/EviMed医学证据检索.md): `title`,
 * `registrationNo`, `status`, `registrationDate`, `phase`, `sampleSize`,
 * `studyType`, `conditions`, `primarySponsor`, `interventions`, `url`.
 *
 * It carries no eligibility text, no arms, no outcome definitions and no
 * results, so the precedent it makes is a stub that says what is missing
 * rather than a record with empty fields. `sampleSize` there is not marked
 * planned or actual, which is exactly the distinction plan §6.2 refuses to
 * lose — so it is stored with `enrollmentKind: null` and
 * `historicalBaseline: false`, and a pooling job will leave it out.
 *
 * @param {any} item @param {{ retrievedAt?: string }} [options]
 */
export function chictrPrecedent(item, { retrievedAt = "" } = {}) {
  const registryId = text(item?.registrationNo) || text(item?.id);
  const sourceRef = `chictr:${registryId}`;
  const reduced = {
    registrationNo: registryId,
    title: text(item?.title),
    status: text(item?.status),
    registrationDate: text(item?.registrationDate),
    phase: text(item?.phase),
    sampleSize: item?.sampleSize ?? null,
    studyType: text(item?.studyType),
    conditions: Array.isArray(item?.conditions) ? item.conditions.map(text) : [],
    primarySponsor: text(item?.primarySponsor),
    interventions: Array.isArray(item?.interventions) ? item.interventions.map(text) : [],
    url: text(item?.url),
  };
  const recordHash = registryRecordHash(reduced);
  const recordText = renderRegistryRecordText(reduced, {
    header: `${registryId} · 中国临床试验注册中心（经 EviMed 证据接口）${retrievedAt ? ` · retrieved ${retrievedAt}` : ""}`,
  });
  /** @type {ReturnType<typeof extraction>[]} */
  const extractions = [];
  const sampleSize = number(reduced.sampleSize);
  if (sampleSize !== null) {
    extractions.push(extraction({
      parameter: "enrollment_unspecified",
      value: sampleSize,
      unit: "participants",
      quote: quoteOf("sampleSize", reduced.sampleSize),
      path: "sampleSize",
      sourceRef,
      enrollmentKind: null,
      historicalBaseline: false,
      detail: { note: "接口未区分计划与实际，故不进历史基准" },
    }));
  }
  return {
    precedent: {
      registry: "chictr",
      registryId,
      title: reduced.title || registryId,
      pico: { conditions: reduced.conditions, interventions: reduced.interventions.map((name) => ({ type: "", name })) },
      design: { studyType: reduced.studyType, phases: reduced.phase ? [reduced.phase] : [], overallStatus: reduced.status, leadSponsor: reduced.primarySponsor, hasResults: false, arms: [] },
      enrollment: { planned: null, actual: null, registryType: "", milestones: {}, accrualToPrimaryCompletionMonths: null },
      enrollmentKind: null,
      sites: { count: null, countries: [], countryCount: null, listTruncated: false },
      eligibilityText: "",
      endpoints: [],
      results: { hasResults: false, outcomeMeasures: 0, baselineDenominators: [] },
      sources: [{ kind: "registry", registry: "chictr", registryId, url: reduced.url, recordHash, retrievedAt }],
      fetchedAt: retrievedAt || null,
      unavailable: [
        ...Object.entries(REGISTRY_UNAVAILABLE_PARAMETERS).map(([parameter, reason]) => ({ parameter, reason })),
        { parameter: "eligibility_text", reason: "共享证据接口不返回入排条件原文" },
        { parameter: "arm_definitions", reason: "共享证据接口不返回分组定义" },
        { parameter: "outcome_definitions", reason: "共享证据接口不返回终点定义与时间框架" },
        { parameter: "results", reason: "共享证据接口不返回结果" },
      ],
    },
    extractions,
    record: { sourceRef, url: reduced.url, text: recordText, hash: recordHash, reduced },
  };
}

/** The `fields` projection a candidate list needs: a page, not a record. */
export const CTGOV_SEARCH_FIELDS = Object.freeze([
  "protocolSection.identificationModule.nctId",
  "protocolSection.identificationModule.briefTitle",
  "protocolSection.statusModule.overallStatus",
  "protocolSection.statusModule.startDateStruct",
  "protocolSection.statusModule.primaryCompletionDateStruct",
  "protocolSection.designModule.studyType",
  "protocolSection.designModule.phases",
  "protocolSection.designModule.designInfo",
  "protocolSection.designModule.enrollmentInfo",
  "protocolSection.conditionsModule.conditions",
  "protocolSection.armsInterventionsModule.interventions",
  "hasResults",
]);

/**
 * @param {{ baseUrl?: string, timeoutMs?: number, maxAttempts?: number, fetchImpl?: typeof fetch,
 *   now?: () => Date, sleep?: (ms: number) => Promise<unknown>,
 *   chictrAdapter?: ((request: { query: string, limit: number }) => Promise<any>) | null }} [options]
 */
export function createTrialRegistryClient({
  baseUrl = CTGOV_BASE_URL,
  timeoutMs = 20_000,
  maxAttempts = 3,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  sleep = (/** @type {number} */ ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  chictrAdapter = null,
} = {}) {
  const origin = text(baseUrl).replace(/\/+$/, "");
  const attempts = Math.max(1, Math.min(6, Math.floor(maxAttempts)));
  const counters = { searches: 0, records: 0, requests: 0, retried: 0, unavailable: 0, notFound: 0 };
  let lastError = /** @type {string | null} */ (null);

  /**
   * One GET, retried inside one deadline and never throwing a network error
   * at the caller: an answer this module cannot get is `registry_unavailable`
   * with a reason, so nothing downstream can mistake it for 「查到 0 条」.
   * @param {string} url @param {number} deadline epoch ms
   */
  async function getJson(url, deadline) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining < 250) {
        lastError = "timeout";
        return { ok: false, reason: "timeout" };
      }
      counters.requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      timer.unref?.();
      try {
        const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
        if (response.status === 404) {
          counters.notFound += 1;
          return { ok: false, reason: REGISTRY_NOT_FOUND };
        }
        if (!response.ok) {
          lastError = `http_${response.status}`;
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable) return { ok: false, reason: `http_${response.status}` };
        } else {
          return { ok: true, body: JSON.parse(await readBoundedBody(response)) };
        }
      } catch (error) {
        lastError = /** @type {any} */ (error)?.name === "AbortError" ? "timeout" : text(/** @type {any} */ (error)?.code) || "request_failed";
        if (lastError === "response_too_large") return { ok: false, reason: lastError };
      } finally {
        clearTimeout(timer);
      }
      const wait = RETRY_BACKOFF_MS[attempt];
      if (wait == null || attempt + 1 >= attempts || deadline - Date.now() < wait + 250) break;
      counters.retried += 1;
      await sleep(wait);
    }
    return { ok: false, reason: lastError ?? "request_failed" };
  }

  /** @param {string} reason */
  function unavailable(reason) {
    counters.unavailable += 1;
    return { status: REGISTRY_UNAVAILABLE, reason, items: [], total: null, nextPageToken: null };
  }

  return {
    get configured() { return Boolean(origin) && typeof fetchImpl === "function"; },
    get chictrConfigured() { return typeof chictrAdapter === "function"; },
    status() {
      return {
        configured: Boolean(origin) && typeof fetchImpl === "function",
        chictrConfigured: typeof chictrAdapter === "function",
        counters: { ...counters },
        lastError,
      };
    },

    /**
     * Candidate precedents. Similarity and eligibility for pooling are decided
     * later and elsewhere (plan §6.4: 「相似度只用来找候选」) — this is a query,
     * not a judgment.
     * @param {{ condition?: string, intervention?: string, term?: string, phases?: string[],
     *   status?: string[], studyType?: string, hasResults?: boolean | null, limit?: number,
     *   pageToken?: string | null }} request
     */
    async search({ condition = "", intervention = "", term = "", phases = [], status = [], studyType = "",
      hasResults = null, limit = 20, pageToken = null } = {}) {
      if (!origin || typeof fetchImpl !== "function") return unavailable("registry_not_configured");
      counters.searches += 1;
      const parameters = new URLSearchParams();
      if (text(condition)) parameters.set("query.cond", text(condition));
      if (text(intervention)) parameters.set("query.intr", text(intervention));
      if (text(term)) parameters.set("query.term", text(term));
      for (const phase of phases) if (text(phase)) parameters.append("filter.advanced", `AREA[Phase]${text(phase)}`);
      if (status.length) parameters.set("filter.overallStatus", status.map(text).filter(Boolean).join("|"));
      if (text(studyType)) parameters.append("filter.advanced", `AREA[StudyType]${text(studyType)}`);
      if (hasResults === true) parameters.set("aggFilters", "results:with");
      if (hasResults === false) parameters.set("aggFilters", "results:without");
      parameters.set("pageSize", String(Math.max(1, Math.min(100, Math.floor(limit)))));
      parameters.set("countTotal", "true");
      parameters.set("format", "json");
      parameters.set("fields", CTGOV_SEARCH_FIELDS.join("|"));
      if (text(pageToken)) parameters.set("pageToken", text(pageToken));

      const answer = await getJson(`${origin}/studies?${parameters.toString()}`, Date.now() + timeoutMs);
      if (!answer.ok) return unavailable(answer.reason);
      const studies = Array.isArray(answer.body?.studies) ? answer.body.studies : [];
      const retrievedAt = now().toISOString();
      return {
        status: "ok",
        registry: "clinicaltrials.gov",
        total: Number.isFinite(Number(answer.body?.totalCount)) ? Number(answer.body.totalCount) : null,
        nextPageToken: text(answer.body?.nextPageToken) || null,
        retrievedAt,
        items: studies.map((/** @type {any} */ study) => {
          const protocol = study?.protocolSection ?? {};
          const enrollment = protocol.designModule?.enrollmentInfo ?? {};
          const registryId = text(protocol.identificationModule?.nctId);
          return {
            registry: "clinicaltrials.gov",
            registryId,
            title: text(protocol.identificationModule?.briefTitle),
            overallStatus: text(protocol.statusModule?.overallStatus),
            startDate: text(protocol.statusModule?.startDateStruct?.date),
            primaryCompletionDate: text(protocol.statusModule?.primaryCompletionDateStruct?.date),
            studyType: text(protocol.designModule?.studyType),
            phases: Array.isArray(protocol.designModule?.phases) ? protocol.designModule.phases.map(text) : [],
            allocation: text(protocol.designModule?.designInfo?.allocation),
            enrollment: number(enrollment.count),
            enrollmentKind: enrollmentKindOf(enrollment.type),
            conditions: Array.isArray(protocol.conditionsModule?.conditions) ? protocol.conditionsModule.conditions.map(text) : [],
            interventions: (Array.isArray(protocol.armsInterventionsModule?.interventions) ? protocol.armsInterventionsModule.interventions : [])
              .map((/** @type {any} */ item) => text(item?.name)).filter(Boolean),
            hasResults: Boolean(study?.hasResults),
            url: registryId ? `${CTGOV_STUDY_URL}${encodeURIComponent(registryId)}` : "",
          };
        }).filter((/** @type {{registryId: string}} */ item) => item.registryId),
      };
    },

    /**
     * One record, in full, with the values that can be quoted out of it.
     * @param {string} registryId
     */
    async record(registryId) {
      const id = text(registryId).toUpperCase();
      if (!REGISTRY_ID.test(id)) return unavailable("registry_id_invalid");
      if (!origin || typeof fetchImpl !== "function") return unavailable("registry_not_configured");
      counters.records += 1;
      const answer = await getJson(`${origin}/studies/${encodeURIComponent(id)}?format=json`, Date.now() + timeoutMs);
      if (!answer.ok) {
        if (answer.reason === REGISTRY_NOT_FOUND) return { status: REGISTRY_NOT_FOUND, reason: REGISTRY_NOT_FOUND, registryId: id };
        return { ...unavailable(answer.reason), registryId: id };
      }
      const retrievedAt = now().toISOString();
      const built = ctgovPrecedent(answer.body, { retrievedAt });
      if (!built.precedent.registryId) return { ...unavailable("registry_record_unreadable"), registryId: id };
      return { status: "ok", ...built };
    },

    /**
     * The ChiCTR / 一级注册库 seat. With no adapter this answers
     * `registry_unavailable`; it never answers an empty list, because 「没查」
     * and 「查不到」 are different findings (plan §6.2).
     * @param {{ query: string, limit?: number }} request
     */
    async searchChictr({ query, limit = 20 } = { query: "" }) {
      if (typeof chictrAdapter !== "function") return unavailable("registry_not_configured");
      counters.searches += 1;
      const retrievedAt = now().toISOString();
      try {
        const answer = await chictrAdapter({ query: text(query), limit: Math.max(1, Math.min(100, Math.floor(limit))) });
        const items = Array.isArray(answer?.items) ? answer.items : Array.isArray(answer) ? answer : null;
        if (!items) return unavailable("registry_answer_unreadable");
        return {
          status: "ok",
          registry: "chictr",
          total: Number.isFinite(Number(answer?.total)) ? Number(answer.total) : items.length,
          nextPageToken: null,
          retrievedAt,
          items: items.map((/** @type {any} */ item) => chictrPrecedent(item, { retrievedAt })),
        };
      } catch (error) {
        lastError = text(/** @type {any} */ (error)?.code) || "request_failed";
        return unavailable(lastError);
      }
    },
  };
}
