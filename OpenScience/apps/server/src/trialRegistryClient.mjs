/**
 * Structured reads of the trial registries 「虚拟临床研究」 parameterizes from
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
 * - **WHO ICTRP is not integrated, and the coverage row says why.** Its terms
 *   forbid commercial use; the row reads `registry_terms_forbid_commercial_use`
 *   (not the generic `registry_unsupported`) so a page can tell a reader that
 *   the registry is left out by its own terms and not for want of work.
 * - **EU CTIS is read through the portal's public JSON API** (2026-10-04):
 *   `POST {base}/search` with `{ pagination: { page, size }, sort, searchCriteria }`
 *   answers `{ showWarning, pagination: { totalRecords, currentPage, totalPages,
 *   nextPage }, data: [...] }`, and `GET {base}/retrieve/{ctNumber}` answers the
 *   whole authorised application. No credential, no rate limit announced. The
 *   endpoints are the ones the public site's own pages call
 *   (`euclinicaltrials.eu/ctis-public`); EMA publishes no API document for them,
 *   so everything below is recorded from live answers (fixtures under
 *   `test/fixtures/ctis/`, recorded 2026-10-04), not from a specification. EMA's
 *   legal notice permits reuse of what its pages publish, commercial or not, with
 *   the source acknowledged — every CTIS precedent names EMA's CTIS as its
 *   source and links the trial's page. Three wire facts the client is built on:
 *   a search body with no `searchCriteria` object is answered `200` with
 *   `showWarning: true` and zero records (a refusal that looks exactly like
 *   「查到 0 条」, so it is read as `registry_answer_unreadable`, never as empty);
 *   an unknown CT number is `200` with `{}` (that is `registry_not_found`) and a
 *   malformed one is `400`; and a page past the last still answers `200` with
 *   the real `totalRecords` and no rows.
 *   What the public record carries: status, phase, conditions, products,
 *   objectives, principal inclusion and exclusion criteria, primary and
 *   secondary endpoints, arms as free text (no structured arm type), planned
 *   enrolment per member state, and notified start, recruitment and end events
 *   per member state. What it does not: actual enrolment, outcome results (the
 *   summary of results is a document, listed with its dates), screening failure.
 *   The personal contacts of sponsors and sites are never read into a record.
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
export const TRIAL_REGISTRIES = Object.freeze(["clinicaltrials.gov", "chictr", "ctis"]);

export const CTGOV_BASE_URL = "https://clinicaltrials.gov/api/v2";
/** A study page on the registry, for a citation a reader can open. */
export const CTGOV_STUDY_URL = "https://clinicaltrials.gov/study/";
/** The EU CTIS public portal's JSON API (the one its own pages call) and a trial's page on it. */
export const CTIS_BASE_URL = "https://euclinicaltrials.eu/ctis-public-api";
export const CTIS_STUDY_URL = "https://euclinicaltrials.eu/ctis-public/view/";
/** An EU CT number: year, six digits, two, two. Anything else is refused before a request (the API answers a malformed one with 400). */
const CTIS_NUMBER = /^\d{4}-\d{6}-\d{2}-\d{2}$/;

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

/** Public coverage never copies an arbitrary transport error or adapter payload. */
const COVERAGE_REASONS = new Set([
  "timeout", "request_failed", "response_too_large", "registry_answer_unreadable",
  "registry_record_unreadable", "registry_not_found", "evimed_trials_unavailable",
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
]);

/**
 * @typedef {{ key: string, label: string, configured: boolean,
 *   coverage: "structured" | "list_only" | "unsupported",
 *   availability: "not_queried" | "available" | "unavailable",
 *   reason: string | null, lastCheckedAt: string | null }} RegistryCoverage
 */

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
 * Every number the item carries is anchored: the value by `quote`, and each
 * sibling number (a confidence bound, a denominator) by its own line in
 * `parts`, because those live in fields of their own and a quotation of the
 * value's line alone proves none of them (review E-9).
 *
 * @param {{ parameter: string, arm?: string | null, armRole?: string, value?: number | null, valueText?: string,
 *   unit?: string, ciLow?: number | null, ciHigh?: number | null, sampleSize?: number | null,
 *   events?: number | null, valueSource?: string, quote: string, path: string, sourceRef: string,
 *   enrollmentKind?: string | null, historicalBaseline?: boolean, inputs?: string[], detail?: Record<string, unknown>,
 *   parts?: Record<string, { path: string, raw: unknown } | null | undefined> }} input
 */
function extraction(input) {
  /** @type {Record<string, { path: string, quote: string }>} */
  const parts = {};
  for (const [field, part] of Object.entries(input.parts ?? {})) {
    if (part?.path && part.raw !== undefined && part.raw !== null) parts[field] = { path: part.path, quote: quoteOf(part.path, part.raw) };
  }
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
    armRole: input.armRole ?? "unknown",
    locator: {
      kind: "registry_field",
      path: input.path,
      ...(input.inputs?.length ? { inputs: input.inputs } : {}),
      ...(Object.keys(parts).length ? { parts } : {}),
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

/**
 * Which arm a registry group is, from the record's own arm types. A control
 * arm and a treatment arm pool separately: 「对照组事件率」 pooled over both is
 * a number about nobody (review CS-26). A group whose title matches no arm
 * label, or whose arm is typed OTHER, is `unknown` and stays out of a pool
 * that names a role.
 * @param {string} title @param {ReadonlyArray<{ label: string, type: string }>} armGroups
 */
export function armRoleOf(title, armGroups) {
  const wanted = text(title).toLowerCase();
  const arm = armGroups.find((group) => text(group.label).toLowerCase() === wanted)
    ?? (wanted ? armGroups.find((group) => wanted.includes(text(group.label).toLowerCase()) && text(group.label)) : undefined);
  const type = text(arm?.type).toUpperCase();
  if (type === "EXPERIMENTAL") return "treatment";
  if (["ACTIVE_COMPARATOR", "PLACEBO_COMPARATOR", "SHAM_COMPARATOR", "NO_INTERVENTION"].includes(type)) return "control";
  return "unknown";
}

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

/**
 * The confidence level a registry's dispersion label states, or null when the
 * label is not a confidence interval. CT.gov's `dispersionType` is a closed set
 * of labels ("95% Confidence Interval", "Standard Deviation", "Full Range",
 * "Inter-Quartile Range" …): a measurement's `lowerLimit` and `upperLimit` are a
 * confidence interval only under the first kind. Under a range or an IQR they are
 * the extremes or the quartiles, and reading them as a CI would give a pooling
 * job a standard error a hundred times too large.
 * @param {unknown} label
 */
export function confidenceLevelOfDispersion(label) {
  const match = /^(\d{2}(?:\.\d+)?)\s*%\s*confidence interval$/i.exec(text(label));
  if (!match) return null;
  const level = Number(match[1]) / 100;
  return level > 0.5 && level < 1 ? level : null;
}

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
  const armGroups = (Array.isArray(arms.armGroups) ? arms.armGroups : []).map((/** @type {any} */ group) => ({
    label: text(group?.label),
    type: text(group?.type),
    interventions: Array.isArray(group?.interventionNames) ? group.interventionNames.map(text) : [],
  }));

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
      armRole: "overall",
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
      armRole: "overall",
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
      armRole: "overall",
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
      armRole: "overall",
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
        const flowArm = flowGroups.get(String(achievement?.groupId)) ?? String(achievement?.groupId ?? "");
        extractions.push(extraction({
          parameter,
          arm: flowArm,
          armRole: armRoleOf(flowArm, armGroups),
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
        const withdrawnArm = flowGroups.get(String(reason?.groupId)) ?? String(reason?.groupId ?? "");
        extractions.push(extraction({
          parameter: "arm_withdrawn",
          arm: withdrawnArm,
          armRole: armRoleOf(withdrawnArm, armGroups),
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
    /** @type {Map<string, { value: number, path: string, raw: unknown }>} */
    const denominators = new Map();
    (Array.isArray(measure?.denoms) ? measure.denoms : []).forEach((/** @type {any} */ denom, /** @type {number} */ denomIndex) => {
      (Array.isArray(denom?.counts) ? denom.counts : []).forEach((/** @type {any} */ count, /** @type {number} */ countIndex) => {
        const value = number(count?.value);
        if (value !== null && count?.groupId) {
          denominators.set(String(count.groupId), {
            value, raw: count.value,
            path: `resultsSection.outcomeMeasuresModule.outcomeMeasures[${measureIndex}].denoms[${denomIndex}].counts[${countIndex}].value`,
          });
        }
      });
    });
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
            const measuredArm = groups.get(String(measurement?.groupId)) ?? String(measurement?.groupId ?? "");
            const denominator = denominators.get(String(measurement?.groupId)) ?? null;
            const base = path.slice(0, -".value".length);
            // The limits are a confidence interval only when the measure's own
            // dispersion label says so; otherwise they stay in `detail`.
            const level = confidenceLevelOfDispersion(measure?.dispersionType);
            const lower = number(measurement?.lowerLimit);
            const upper = number(measurement?.upperLimit);
            extractions.push(extraction({
              parameter: mapped.parameter,
              arm: measuredArm,
              armRole: armRoleOf(measuredArm, armGroups),
              value,
              unit: text(measure?.unitOfMeasure),
              ciLow: level === null ? null : lower,
              ciHigh: level === null ? null : upper,
              sampleSize: denominator?.value ?? null,
              parts: {
                ciLow: level === null || lower === null ? null : { path: `${base}.lowerLimit`, raw: measurement.lowerLimit },
                ciHigh: level === null || upper === null ? null : { path: `${base}.upperLimit`, raw: measurement.upperLimit },
                sampleSize: denominator,
              },
              quote: quoteOf(path, measurement.value),
              path,
              sourceRef,
              historicalBaseline: true,
              detail: {
                outcome: outcomeTitle,
                outcomeType: text(measure?.type),
                timeFrame,
                dispersion: text(measure?.dispersionType),
                ...(level === null ? {} : { confidenceLevel: level }),
                ...(level === null && (lower !== null || upper !== null) ? { limitsAreNotACi: { lower, upper } } : {}),
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
      const analysisBase = path.slice(0, -".paramValue".length);
      extractions.push(extraction({
        parameter: effect.parameter,
        arm: (Array.isArray(analysis?.groupIds) ? analysis.groupIds : [])
          .map((/** @type {any} */ id) => groups.get(String(id)) ?? String(id)).join(" vs ") || null,
        armRole: "contrast",
        value,
        ciLow: number(analysis?.ciLowerLimit),
        ciHigh: number(analysis?.ciUpperLimit),
        parts: {
          ciLow: number(analysis?.ciLowerLimit) === null ? null : { path: `${analysisBase}.ciLowerLimit`, raw: analysis.ciLowerLimit },
          ciHigh: number(analysis?.ciUpperLimit) === null ? null : { path: `${analysisBase}.ciUpperLimit`, raw: analysis.ciUpperLimit },
        },
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
      armRole: "overall",
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

// ---------------------------------------------------------------------------
// EU CTIS
// ---------------------------------------------------------------------------

/**
 * The portal's own public trial status codes, as its search page lists them
 * (read from the site's code table, 2026-10-04). A search item's `ctStatus` and
 * a record's `ctPublicStatusCode` are these numbers; a code this build does not
 * know reads as the empty string, never as a guess.
 */
export const CTIS_PUBLIC_STATUS = Object.freeze({
  1: "Under evaluation", 2: "Authorised, recruitment pending", 3: "Authorised, recruiting", 4: "Ongoing, recruiting",
  5: "Ongoing, recruitment ended", 6: "Temporarily halted", 7: "Suspended", 8: "Ended", 9: "Expired", 10: "Revoked",
  11: "Not authorised", 12: "Cancelled",
});

/**
 * The portal's trial phases by code, with the `phases` array CT.gov would write
 * for the same phase, so a CTIS precedent is ranked and pooled on the same words.
 * `trialPhase` in a record is the code as text; in a search item it is the label.
 */
export const CTIS_PHASES = Object.freeze([
  { code: 1, label: "Human Pharmacology (Phase I)- First administration to humans", phases: ["PHASE1"] },
  { code: 2, label: "Human Pharmacology (Phase I)- Bioequivalence Study", phases: ["PHASE1"] },
  { code: 3, label: "Human Pharmacology (Phase I)- Other", phases: ["PHASE1"] },
  { code: 4, label: "Therapeutic exploratory (Phase II)", phases: ["PHASE2"] },
  { code: 5, label: "Therapeutic confirmatory (Phase III)", phases: ["PHASE3"] },
  { code: 6, label: "Therapeutic use (Phase IV)", phases: ["PHASE4"] },
  { code: 7, label: "Phase I and Phase II (Integrated)- First administration to humans", phases: ["PHASE1", "PHASE2"] },
  { code: 8, label: "Phase I and Phase II (Integrated)- Bioequivalence Study", phases: ["PHASE1", "PHASE2"] },
  { code: 9, label: "Phase I and Phase II (Integrated)- Other", phases: ["PHASE1", "PHASE2"] },
  { code: 10, label: "Phase II and Phase III (Integrated)", phases: ["PHASE2", "PHASE3"] },
  { code: 11, label: "Phase III and phase IV (Integrated)", phases: ["PHASE3", "PHASE4"] },
]);
const CTIS_AGE_RANGES = Object.freeze({ 1: "In utero", 2: "0-17 years", 3: "18-64 years", 4: "65+ years" });
const CTIS_PRODUCT_ROLES = Object.freeze({ 1: "Test", 2: "Comparator", 3: "Placebo", 4: "Auxiliary" });
/** The notification types a member state reports, and the parameter each date is stored under. */
const CTIS_EVENT_PARAMETERS = Object.freeze({
  START_OF_TRIAL: "msc_trial_start_date", START_OF_RECRUITMENT: "msc_recruitment_start_date",
  END_OF_RECRUITMENT: "msc_recruitment_end_date", END_OF_TRIAL: "msc_trial_end_date",
  EARLY_TERMINATION: "msc_early_termination_date", TEMPORARY_HALT: "msc_temporary_halt_date",
  RESTART_OF_TRIAL: "msc_restart_date", RESTART_OF_RECRUITMENT: "msc_recruitment_restart_date",
});
/** Hospitals and clinics are listed for the site count; the whole list is not a design parameter. */
const MAX_CTIS_SITES_KEPT = 200;

/** @param {unknown} label */
const squashed = (label) => text(label).replace(/\s+/g, " ").toLowerCase();

/**
 * The CT.gov-style phases of a CTIS phase, from its code (a record) or its
 * label (a search item).
 * @param {unknown} codeOrLabel @returns {string[]}
 */
export function ctisPhasesOf(codeOrLabel) {
  const wanted = squashed(codeOrLabel);
  const found = CTIS_PHASES.find((phase) => String(phase.code) === wanted || squashed(phase.label) === wanted);
  return found ? [...found.phases] : [];
}

/**
 * The phase codes a CT.gov-style phase list asks for: every CTIS phase whose own
 * phases are all among the ones named (`PHASE2` asks for phase II alone, not for
 * the integrated I/II).
 * @param {readonly string[]} phases @returns {number[]}
 */
export function ctisPhaseCodes(phases) {
  const wanted = new Set(phases.map((phase) => text(phase).toUpperCase()).filter(Boolean));
  if (!wanted.size) return [];
  return CTIS_PHASES.filter((phase) => phase.phases.every((name) => wanted.has(name))).map((phase) => phase.code);
}

/**
 * A date as `YYYY-MM-DD`: the portal writes `dd/mm/yyyy` in a search list and
 * ISO in a record. A closed format check, not a reading of language; anything
 * else is the empty string.
 * @param {unknown} value
 */
export function ctisDate(value) {
  const raw = text(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(raw);
  const european = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : european ? [european[3], european[2], european[1]] : [];
  if (!year) return "";
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() === Number(month) - 1 && parsed.getUTCDate() === Number(day)
    ? `${year}-${month}-${day}` : "";
}

/** The page of a trial on the public portal, for a citation a reader can open. @param {string} ctNumber */
const ctisUrl = (ctNumber) => (ctNumber ? `${CTIS_STUDY_URL}${encodeURIComponent(ctNumber)}` : "");

/**
 * One search-list item as a candidate precedent. The list says `totalNumberEnrolled`
 * of a trial that has not started, so it is the application's plan and not a
 * count of anybody: it is kept with `enrollmentKind: null`, as ChiCTR's sample
 * size is, and no pooling job will take it for a baseline.
 * @param {any} item
 */
export function ctisListItem(item) {
  const ctNumber = text(item?.ctNumber);
  const statusCode = number(item?.ctStatus);
  return {
    registry: "ctis",
    registryId: ctNumber,
    title: text(item?.ctTitle),
    shortTitle: text(item?.shortTitle),
    overallStatus: statusCode === null ? "" : /** @type {Record<number, string>} */ (CTIS_PUBLIC_STATUS)[statusCode] ?? "",
    statusCode,
    decisionDate: ctisDate(item?.decisionDateOverall),
    studyType: "",
    phases: ctisPhasesOf(item?.trialPhase),
    phaseLabel: text(item?.trialPhase),
    allocation: "",
    enrollment: number(item?.totalNumberEnrolled),
    enrollmentKind: null,
    conditions: [text(item?.conditions)].filter(Boolean),
    interventions: [text(item?.product)].filter(Boolean),
    therapeuticAreas: Array.isArray(item?.therapeuticAreas) ? item.therapeuticAreas.map(text).filter(Boolean) : [],
    sponsor: text(item?.sponsor),
    sponsorType: text(item?.sponsorType),
    countries: (Array.isArray(item?.trialCountries) ? item.trialCountries : [])
      .map((/** @type {unknown} */ entry) => text(entry).split(":")[0].trim()).filter(Boolean),
    ageGroup: text(item?.ageGroup),
    gender: text(item?.gender),
    primaryEndpoint: text(item?.primaryEndPoint),
    hasResults: text(item?.resultsFirstReceived).toLowerCase() === "yes",
    url: ctisUrl(ctNumber),
  };
}

/** @param {unknown} value @returns {any[]} */
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * The record, reduced to what a design parameter can come from — and nothing a
 * person owns: sponsors are their organisations, never the named contacts with
 * their e-mail and telephone; sites are their names. Returns a new object.
 * `trialSitesTotal` is stated when the site list is cut, the way CT.gov's
 * `locationsTotal` is, because a count read off a slice is a wrong number that
 * looks right.
 * @param {any} record
 */
export function reducedCtisRecord(record) {
  const application = record?.authorizedApplication ?? {};
  const partOne = application.authorizedPartI ?? {};
  const details = partOne.trialDetails ?? {};
  const information = details.trialInformation ?? {};
  const identifiers = details.clinicalTrialIdentifiers ?? {};
  /** @param {any[]} entries @param {string} key */
  const numbered = (entries, key) => listOf(entries).map((entry) => ({ number: entry?.number, [key]: entry?.[key] }))
    .filter((entry) => text(entry[key]));
  const sponsors = listOf(partOne.sponsors).flatMap((sponsor) => {
    const organisation = listOf(sponsor?.publicContacts)[0]?.organisation ?? listOf(sponsor?.scientificContacts)[0]?.organisation;
    return organisation?.name ? [{ name: organisation.name, type: organisation.type, primary: sponsor?.primary === true }] : [];
  });
  /** @type {Record<string, any>} */
  const reduced = {
    ctNumber: record?.ctNumber, ctStatus: record?.ctStatus, ctPublicStatusCode: record?.ctPublicStatusCode,
    decisionDate: record?.decisionDate, publishDate: record?.publishDate, startDateEU: record?.startDateEU, endDateEU: record?.endDateEU,
    trialRegion: record?.trialRegion,
    authorizedApplication: {
      authorizedPartI: {
        isLowIntervention: partOne.isLowIntervention, rowSubjectCount: partOne.rowSubjectCount,
        trialDetails: {
          clinicalTrialIdentifiers: { fullTitle: identifiers.fullTitle, publicTitle: identifiers.publicTitle, shortTitle: identifiers.shortTitle },
          trialInformation: {
            trialCategory: { trialPhase: information.trialCategory?.trialPhase, trialCategory: information.trialCategory?.trialCategory },
            medicalCondition: {
              partIMedicalConditions: listOf(information.medicalCondition?.partIMedicalConditions).map((entry) => ({ medicalCondition: entry?.medicalCondition })),
              meddraConditionTerms: listOf(information.medicalCondition?.meddraConditionTerms).map((entry) => ({ termName: entry?.termName, level: entry?.level })),
            },
            trialObjective: {
              mainObjective: information.trialObjective?.mainObjective,
              secondaryObjectives: numbered(information.trialObjective?.secondaryObjectives, "secondaryObjective"),
            },
            eligibilityCriteria: {
              principalInclusionCriteria: numbered(information.eligibilityCriteria?.principalInclusionCriteria, "principalInclusionCriteria"),
              principalExclusionCriteria: numbered(information.eligibilityCriteria?.principalExclusionCriteria, "principalExclusionCriteria"),
            },
            endPoint: {
              primaryEndPoints: numbered(information.endPoint?.primaryEndPoints, "endPoint"),
              secondaryEndPoints: numbered(information.endPoint?.secondaryEndPoints, "endPoint"),
            },
            trialDuration: {
              estimatedRecruitmentStartDate: information.trialDuration?.estimatedRecruitmentStartDate,
              estimatedEndDate: information.trialDuration?.estimatedEndDate,
            },
            populationOfTrialSubjects: {
              ageRanges: listOf(information.populationOfTrialSubjects?.ageRanges).map((entry) => ({ ageRangeCategoryCode: entry?.ageRangeCategoryCode })),
              clinicalTrialGroups: listOf(information.populationOfTrialSubjects?.clinicalTrialGroups).map((entry) => ({ name: entry?.name })),
              isFemaleSubjects: information.populationOfTrialSubjects?.isFemaleSubjects,
              isMaleSubjects: information.populationOfTrialSubjects?.isMaleSubjects,
            },
          },
          protocolInformation: {
            studyDesign: {
              periodDetails: listOf(details.protocolInformation?.studyDesign?.periodDetails).map((period) => ({
                title: period?.title, description: period?.description, blindingMethodCode: period?.blindingMethodCode,
                blindingDetails: period?.blindingDetails, allocationMethod: period?.allocationMethod,
                blindedRoles: listOf(period?.blindedRoles).map((entry) => ({ name: entry?.name })),
                armDetails: listOf(period?.armDetails).map((arm) => ({ title: arm?.title, description: arm?.description })),
              })),
            },
          },
        },
        products: listOf(partOne.products).map((product) => ({
          productName: product?.productName ?? product?.productDictionaryInfo?.prodName,
          activeSubstanceName: product?.productDictionaryInfo?.activeSubstanceName,
          roleCode: product?.part1MpRoleTypeCode, atcCode: product?.productDictionaryInfo?.atcCode, routes: listOf(product?.routes),
        })),
        sponsors,
      },
      authorizedPartsII: listOf(application.authorizedPartsII).map((part) => {
        const sites = listOf(part?.trialSites).map((site) => site?.organisationAddressInfo?.organisation?.name).filter((name) => text(name));
        return {
          countryName: part?.mscInfo?.countryName, trialStatus: part?.mscInfo?.trialStatus, firstDecisionDate: part?.mscInfo?.firstDecisionDate,
          recruitmentSubjectCount: part?.recruitmentSubjectCount,
          trialSites: sites.slice(0, MAX_CTIS_SITES_KEPT),
          ...(sites.length > MAX_CTIS_SITES_KEPT ? { trialSitesTotal: sites.length } : {}),
        };
      }),
    },
    events: {
      trialEvents: listOf(record?.events?.trialEvents).map((entry) => ({
        mscName: entry?.mscName,
        events: listOf(entry?.events).map((event) => ({ notificationType: event?.notificationType, date: event?.date })),
        earlyTerminationReason: entry?.earlyTerminationReason?.name ? { name: entry.earlyTerminationReason.name } : undefined,
      })),
    },
    results: {
      summaryResults: listOf(record?.results?.summaryResults).map((entry) => ({
        summaryType: entry?.summaryType, versionType: entry?.versionType, submissionDate: entry?.submissionDate,
      })),
      laypersonResults: listOf(record?.results?.laypersonResults).map((entry) => ({
        summaryType: entry?.summaryType, versionType: entry?.versionType, submissionDate: entry?.submissionDate,
      })),
    },
  };
  return JSON.parse(JSON.stringify(reduced));
}

/**
 * A CTIS record, as a precedent row plus the values that can be quoted out of
 * it. Pure, as `ctgovPrecedent` is: no network, no clock, no store.
 *
 * What is stored as what:
 *
 * - The enrolment the application states per member state is `enrollment_estimated`
 *   and never `actual`: the public record carries no count of anybody enrolled.
 *   The portal's trial-wide dates are notifications of events that happened
 *   (`actual`); the application's `estimatedRecruitmentStartDate` and
 *   `estimatedEndDate` are plans (`estimated`).
 * - An arm is a title and a free-text description. CTIS has no structured arm type,
 *   so none is read out of the words: every arm's `type` is empty and its role is
 *   `unknown` until the run judges it.
 * - A code the portal does not publish a table for (the blinding method, the
 *   allocation method) is carried as the code and not interpreted.
 * @param {any} record the record as the portal answered it
 * @param {{ retrievedAt?: string }} [options]
 */
export function ctisPrecedent(record, { retrievedAt = "" } = {}) {
  const reduced = reducedCtisRecord(record);
  const partOne = reduced.authorizedApplication?.authorizedPartI ?? {};
  const information = partOne.trialDetails?.trialInformation ?? {};
  const identifiers = partOne.trialDetails?.clinicalTrialIdentifiers ?? {};
  const periods = listOf(partOne.trialDetails?.protocolInformation?.studyDesign?.periodDetails);
  const partsTwo = listOf(reduced.authorizedApplication?.authorizedPartsII);
  const registryId = text(reduced.ctNumber);
  const sourceRef = `ctis:${registryId}`;
  const recordHash = registryRecordHash(reduced);
  const url = ctisUrl(registryId);
  const recordText = renderRegistryRecordText(reduced, {
    header: `${registryId} · EU CTIS (EMA, euclinicaltrials.eu)${retrievedAt ? ` · retrieved ${retrievedAt}` : ""}`,
  });
  const phaseCode = number(information.trialCategory?.trialPhase);
  const phaseOf = CTIS_PHASES.find((phase) => phase.code === phaseCode);
  const statusCode = number(reduced.ctPublicStatusCode);
  const overallStatus = text(reduced.ctStatus) || (statusCode === null ? "" : /** @type {Record<number, string>} */ (CTIS_PUBLIC_STATUS)[statusCode] ?? "");

  /** @type {ReturnType<typeof extraction>[]} */
  const extractions = [];

  // -- planned enrolment, per member state and for the rest of the world ----
  partsTwo.forEach((part, index) => {
    const count = number(part.recruitmentSubjectCount);
    if (count === null) return;
    const path = `authorizedApplication.authorizedPartsII[${index}].recruitmentSubjectCount`;
    extractions.push(extraction({
      parameter: "enrollment_estimated", armRole: "overall", value: count, unit: "participants",
      quote: quoteOf(path, part.recruitmentSubjectCount), path, sourceRef, enrollmentKind: "estimated", historicalBaseline: false,
      detail: { country: text(part.countryName), scope: "member state", note: "申请书里的计划人数，不是实际入组" },
    }));
  });
  const outsideCount = number(partOne.rowSubjectCount);
  if (outsideCount !== null && outsideCount > 0) {
    const path = "authorizedApplication.authorizedPartI.rowSubjectCount";
    extractions.push(extraction({
      parameter: "enrollment_estimated_rest_of_world", armRole: "overall", value: outsideCount, unit: "participants",
      quote: quoteOf(path, partOne.rowSubjectCount), path, sourceRef, enrollmentKind: "estimated", historicalBaseline: false,
      detail: { scope: "outside the EU/EEA", note: "申请书里的计划人数，不是实际入组" },
    }));
  }

  // -- trial-wide dates: notified events are actual, the application's are plans ----
  /** @type {Record<string, { date: string, type: "actual" | "estimated" }>} */
  const milestones = {};
  for (const [field, name, path, kind] of /** @type {const} */ ([
    [reduced.startDateEU, "start_date", "startDateEU", "actual"],
    [reduced.endDateEU, "completion_date", "endDateEU", "actual"],
    [information.trialDuration?.estimatedRecruitmentStartDate, "recruitment_start_date", "authorizedApplication.authorizedPartI.trialDetails.trialInformation.trialDuration.estimatedRecruitmentStartDate", "estimated"],
    [information.trialDuration?.estimatedEndDate, "completion_date", "authorizedApplication.authorizedPartI.trialDetails.trialInformation.trialDuration.estimatedEndDate", "estimated"],
  ])) {
    const date = ctisDate(field);
    if (!date) continue;
    // The planned end is not stored beside an actual one: the actual date is the fact.
    if (name === "completion_date" && kind === "estimated" && milestones.completion_date) continue;
    milestones[name] = { date, type: kind };
    extractions.push(extraction({
      parameter: name, armRole: "overall", valueText: text(field), quote: quoteOf(path, field), path, sourceRef,
      enrollmentKind: kind, historicalBaseline: kind === "actual", detail: { registryType: kind },
    }));
  }
  const duration = milestones.start_date && milestones.completion_date
    ? monthsBetween(milestones.start_date.date, milestones.completion_date.date) : null;
  if (duration !== null) {
    extractions.push(extraction({
      parameter: "trial_duration_months", armRole: "overall", value: duration, unit: "months", valueSource: "calculated",
      quote: quoteOf("startDateEU", reduced.startDateEU), path: "startDateEU", sourceRef, inputs: ["startDateEU", "endDateEU"],
      historicalBaseline: milestones.start_date.type === "actual" && milestones.completion_date.type === "actual",
      detail: { from: milestones.start_date.date, to: milestones.completion_date.date },
    }));
  }
  // The dates each member state was notified of, apart: they differ by country.
  listOf(reduced.events?.trialEvents).forEach((entry, entryIndex) => {
    listOf(entry.events).forEach((event, eventIndex) => {
      const parameter = /** @type {Record<string, string>} */ (CTIS_EVENT_PARAMETERS)[text(event?.notificationType)];
      const date = ctisDate(event?.date);
      if (!parameter || !date) return;
      const path = `events.trialEvents[${entryIndex}].events[${eventIndex}].date`;
      extractions.push(extraction({
        parameter, armRole: "overall", valueText: text(event.date), quote: quoteOf(path, event.date), path, sourceRef,
        enrollmentKind: "actual", historicalBaseline: true,
        detail: { country: text(entry.mscName), notificationType: text(event.notificationType), ...(entry.earlyTerminationReason?.name && event.notificationType === "EARLY_TERMINATION" ? { reason: text(entry.earlyTerminationReason.name) } : {}) },
      }));
    });
  });

  // -- sites: counted from the lists, so a calculation that names its inputs ----
  const sitePaths = partsTwo.flatMap((part, index) => (listOf(part.trialSites).length ? [`authorizedApplication.authorizedPartsII[${index}].trialSites`] : []));
  const siteCount = partsTwo.reduce((sum, part) => sum + (number(part.trialSitesTotal) ?? listOf(part.trialSites).length), 0);
  if (siteCount > 0 && sitePaths.length) {
    const firstIndex = partsTwo.findIndex((part) => listOf(part.trialSites).length);
    extractions.push(extraction({
      parameter: "site_count", armRole: "overall", value: siteCount, unit: "sites", valueSource: "calculated",
      quote: quoteOf(`${sitePaths[0]}[0]`, partsTwo[firstIndex].trialSites[0]), path: "authorizedApplication.authorizedPartsII",
      sourceRef, inputs: sitePaths, historicalBaseline: true,
      detail: { truncated: partsTwo.some((part) => number(part.trialSitesTotal) !== null) },
    }));
  }
  const countries = [...new Set(partsTwo.map((part) => text(part.countryName)).filter(Boolean))].sort();

  const arms = periods.flatMap((period) => listOf(period.armDetails).map((arm) => ({
    label: text(arm.title), type: "", description: text(arm.description), interventions: [],
  }))).filter((arm) => arm.label);
  const inclusion = listOf(information.eligibilityCriteria?.principalInclusionCriteria).map((entry) => text(entry.principalInclusionCriteria)).filter(Boolean);
  const exclusion = listOf(information.eligibilityCriteria?.principalExclusionCriteria).map((entry) => text(entry.principalExclusionCriteria)).filter(Boolean);
  const eligibilityText = [
    inclusion.length ? `Principal inclusion criteria:\n${inclusion.map((line) => `- ${line}`).join("\n")}` : "",
    exclusion.length ? `Principal exclusion criteria:\n${exclusion.map((line) => `- ${line}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const female = information.populationOfTrialSubjects?.isFemaleSubjects === true;
  const male = information.populationOfTrialSubjects?.isMaleSubjects === true;
  const summaries = [...listOf(reduced.results?.summaryResults), ...listOf(reduced.results?.laypersonResults)];
  const hasResults = summaries.length > 0;
  const planned = partsTwo.map((part) => number(part.recruitmentSubjectCount)).filter((count) => count !== null);

  const precedent = {
    registry: "ctis",
    registryId,
    title: text(identifiers.publicTitle) || text(identifiers.fullTitle) || text(identifiers.shortTitle) || registryId,
    pico: {
      conditions: listOf(information.medicalCondition?.partIMedicalConditions).map((entry) => text(entry.medicalCondition)).filter(Boolean),
      keywords: [],
      interventions: listOf(partOne.products).map((product) => ({
        type: /** @type {Record<number, string>} */ (CTIS_PRODUCT_ROLES)[/** @type {number} */ (number(product.roleCode))] ?? "", name: text(product.productName) || text(product.activeSubstanceName),
        ...(text(product.activeSubstanceName) ? { activeSubstance: text(product.activeSubstanceName) } : {}),
      })).filter((item) => item.name),
      mesh: listOf(information.medicalCondition?.meddraConditionTerms).map((entry) => text(entry.termName)).filter(Boolean),
      sex: female && male ? "ALL" : female ? "FEMALE" : male ? "MALE" : "",
      minimumAge: "",
      maximumAge: "",
      stdAges: listOf(information.populationOfTrialSubjects?.ageRanges)
        .map((entry) => /** @type {Record<number, string>} */ (CTIS_AGE_RANGES)[/** @type {number} */ (number(entry.ageRangeCategoryCode))] ?? "").filter(Boolean),
      healthyVolunteers: listOf(information.populationOfTrialSubjects?.clinicalTrialGroups).some((group) => text(group.name) === "Healthy volunteers") ? true
        : listOf(information.populationOfTrialSubjects?.clinicalTrialGroups).length ? false : null,
    },
    design: {
      studyType: "",
      phases: phaseOf ? [...phaseOf.phases] : [],
      phaseLabel: phaseOf?.label ?? "",
      allocation: "",
      allocationCode: text(periods[0]?.allocationMethod),
      interventionModel: "",
      primaryPurpose: "",
      masking: "",
      blindingMethodCode: text(periods[0]?.blindingMethodCode),
      whoMasked: [...new Set(periods.flatMap((period) => listOf(period.blindedRoles).map((role) => text(role.name))).filter(Boolean))],
      arms,
      leadSponsor: text(listOf(partOne.sponsors).find((sponsor) => sponsor.primary === true)?.name ?? listOf(partOne.sponsors)[0]?.name),
      sponsorType: text(listOf(partOne.sponsors).find((sponsor) => sponsor.primary === true)?.type ?? listOf(partOne.sponsors)[0]?.type),
      overallStatus,
      hasResults,
      isLowIntervention: partOne.isLowIntervention === true,
    },
    enrollment: {
      planned: planned.length ? planned.reduce((sum, count) => sum + count, 0) : null,
      actual: null,
      registryType: "planned in the application, per member state",
      milestones,
      accrualToPrimaryCompletionMonths: null,
      trialDurationMonths: duration,
    },
    enrollmentKind: planned.length ? "estimated" : null,
    sites: { count: siteCount || null, countries, countryCount: countries.length || null, listTruncated: partsTwo.some((part) => number(part.trialSitesTotal) !== null) },
    eligibilityText,
    endpoints: [
      ...listOf(information.endPoint?.primaryEndPoints).map((entry) => ({ role: "primary", measure: text(entry.endPoint), timeFrame: "", description: "" })),
      ...listOf(information.endPoint?.secondaryEndPoints).map((entry) => ({ role: "secondary", measure: text(entry.endPoint), timeFrame: "", description: "" })),
    ].filter((entry) => entry.measure),
    results: {
      hasResults,
      outcomeMeasures: 0,
      baselineDenominators: [],
      summaryDocuments: summaries.map((entry) => ({
        type: text(entry.summaryType), version: text(entry.versionType), submitted: ctisDate(entry.submissionDate),
      })),
    },
    sources: [{ kind: "registry", registry: "ctis", registryId, url, recordHash, retrievedAt }],
    fetchedAt: retrievedAt || null,
    unavailable: [
      ...Object.entries(REGISTRY_UNAVAILABLE_PARAMETERS).map(([parameter, reason]) => ({ parameter, reason })),
      { parameter: "enrollment_actual", reason: "CTIS 的公开记录只有申请书里的计划人数，没有实际入组人数" },
      { parameter: "arm_types", reason: "CTIS 的分组只有标题和自由文字描述，没有结构化的分组类型" },
      { parameter: "outcome_measures", reason: hasResults ? "结果摘要是随记录发布的文档，公开记录里只有它的类型和提交日期，没有结构化的结局数值" : "这条记录没有结果摘要" },
      ...(arms.length ? [] : [{ parameter: "arm_definitions", reason: "这条记录的公开部分没有写明分组" }]),
    ],
  };

  return { precedent, extractions, record: { sourceRef, url, text: recordText, hash: recordHash, reduced } };
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
 *   chictrAdapter?: ((request: { query: string, limit: number, userId?: string }) => Promise<any>) | null,
 *   ctisBaseUrl?: string }} [options]
 */
export function createTrialRegistryClient({
  baseUrl = CTGOV_BASE_URL,
  ctisBaseUrl = CTIS_BASE_URL,
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
  const configured = Boolean(origin) && typeof fetchImpl === "function";
  const ctisOrigin = text(ctisBaseUrl).replace(/\/+$/, "");
  const ctisConfigured = Boolean(ctisOrigin) && typeof fetchImpl === "function";
  const chictrConfigured = typeof chictrAdapter === "function";
  /** @type {RegistryCoverage[]} */
  const sourceCoverage = [
    { key: "clinicaltrials.gov", label: "ClinicalTrials.gov", configured, coverage: "structured",
      availability: configured ? "not_queried" : "unavailable", reason: configured ? null : "registry_not_configured", lastCheckedAt: null },
    { key: "chictr", label: "ChiCTR", configured: chictrConfigured, coverage: "list_only",
      availability: chictrConfigured ? "not_queried" : "unavailable", reason: chictrConfigured ? null : "registry_not_configured", lastCheckedAt: null },
    { key: "ctis", label: "EU CTIS", configured: ctisConfigured, coverage: "structured",
      availability: ctisConfigured ? "not_queried" : "unavailable", reason: ctisConfigured ? null : "registry_not_configured", lastCheckedAt: null },
    { key: "cde", label: "CDE", configured: false, coverage: "unsupported", availability: "unavailable", reason: "registry_unsupported", lastCheckedAt: null },
    // Left out by its own terms, and the row says so: WHO ICTRP forbids commercial use of its data.
    { key: "ictrp", label: "WHO ICTRP", configured: false, coverage: "unsupported", availability: "unavailable",
      reason: "registry_terms_forbid_commercial_use", lastCheckedAt: null },
  ];

  /** @param {string} key @param {"available" | "unavailable"} availability @param {string | null} [reason] @param {string} [checkedAt] */
  function observed(key, availability, reason = null, checkedAt = now().toISOString()) {
    const source = sourceCoverage.find((entry) => entry.key === key);
    if (!source) return;
    source.availability = availability;
    source.reason = reason === null ? null : COVERAGE_REASONS.has(reason) || /^http_[45]\d{2}$/.test(reason) ? reason : "request_failed";
    source.lastCheckedAt = checkedAt;
  }

  /**
   * One GET, retried inside one deadline and never throwing a network error
   * at the caller: an answer this module cannot get is `registry_unavailable`
   * with a reason, so nothing downstream can mistake it for 「查到 0 条」.
   * `init` carries a POST's method, body and content type (CTIS's search): the
   * same deadline, retries and bound apply, and a search is safe to repeat.
   * @param {string} url @param {number} deadline epoch ms
   * @param {{ method?: string, body?: string }} [init]
   */
  async function getJson(url, deadline, init = {}) {
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
        const response = await fetchImpl(url, {
          ...(init.method ? { method: init.method, body: init.body } : {}),
          headers: { accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
          signal: controller.signal,
        });
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

  /** @param {string} reason @param {string | null} [registry] */
  function unavailable(reason, registry = null) {
    counters.unavailable += 1;
    if (registry) observed(registry, "unavailable", reason);
    return { status: REGISTRY_UNAVAILABLE, reason, items: [], total: null, nextPageToken: null };
  }

  return {
    get configured() { return configured; },
    get chictrConfigured() { return chictrConfigured; },
    get ctisConfigured() { return ctisConfigured; },
    /**
     * No I/O: lastCheckedAt is the last completed operation observed by this
     * client in this process, not persisted registry health or a study search.
     * A new client starts configured sources at not_queried; callers own their
     * copy. List-only coverage describes candidates, not complete study data.
     * @returns {RegistryCoverage[]}
     */
    coverage() { return sourceCoverage.map((source) => ({ ...source })); },
    /**
     * The coverage as one researcher meets it. The shared view has no user, so
     * it cannot say that the ChiCTR seat — whose key may be the researcher's own
     * (`chictrAdapter.availableFor`) — is closed to a researcher who has none; this
     * says so, as 未配置, instead of leaving it at 尚未查询 for good. A seat that
     * answers for everyone (a deployment key) or an adapter that cannot say
     * leaves the shared view as it is.
     * @param {string} userId @returns {Promise<RegistryCoverage[]>}
     */
    async coverageFor(userId) {
      const view = sourceCoverage.map((source) => ({ ...source }));
      const availableFor = chictrAdapter && /** @type {any} */ (chictrAdapter).availableFor;
      if (typeof availableFor !== "function") return view;
      const open = await availableFor(text(userId)).then(Boolean, () => false);
      return open ? view : view.map((source) => (source.key === "chictr"
        ? { ...source, configured: false, availability: /** @type {const} */ ("unavailable"), reason: "registry_not_configured" } : source));
    },
    status() {
      return {
        configured,
        chictrConfigured,
        ctisConfigured,
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
      if (!answer.ok) return unavailable(answer.reason, "clinicaltrials.gov");
      const studies = Array.isArray(answer.body?.studies) ? answer.body.studies
        : answer.body?.studies === undefined && answer.body?.totalCount === 0 ? [] : null;
      if (!studies) return unavailable("registry_answer_unreadable", "clinicaltrials.gov");
      const retrievedAt = now().toISOString();
      observed("clinicaltrials.gov", "available", null, retrievedAt);
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
        if (answer.reason === REGISTRY_NOT_FOUND) {
          observed("clinicaltrials.gov", "available");
          return { status: REGISTRY_NOT_FOUND, reason: REGISTRY_NOT_FOUND, registryId: id };
        }
        return { ...unavailable(answer.reason, "clinicaltrials.gov"), registryId: id };
      }
      const retrievedAt = now().toISOString();
      const built = ctgovPrecedent(answer.body, { retrievedAt });
      if (!built.precedent.registryId) return { ...unavailable("registry_record_unreadable", "clinicaltrials.gov"), registryId: id };
      observed("clinicaltrials.gov", "available", null, retrievedAt);
      return { status: "ok", ...built };
    },

    /**
     * Candidate EU CTIS trials, one page. Like `search`, a query and not a
     * judgment; and like it, an answer the registry did not give is
     * `registry_unavailable` with a reason and never an empty list.
     *
     * `pageToken` is the page number as text (CTIS pages by number); the answer's
     * `nextPageToken` is the next one, or null on the last. A search body the
     * portal refuses is not an error status — it is `200`, `showWarning: true`
     * and no rows — so that answer is `registry_answer_unreadable`: reading it as
     * 「查到 0 条」 is exactly the mistake this module exists to prevent.
     * @param {{ condition?: string, intervention?: string, term?: string, phases?: string[],
     *   statuses?: number[], hasResults?: boolean | null, limit?: number, pageToken?: string | null }} request
     */
    async searchCtis({ condition = "", intervention = "", term = "", phases = [], statuses = [], hasResults = null, limit = 20, pageToken = null } = {}) {
      if (!ctisConfigured) return unavailable("registry_not_configured");
      counters.searches += 1;
      const page = Math.max(1, Math.floor(Number(text(pageToken))) || 1);
      /** @type {Record<string, unknown>} */
      const criteria = {};
      if (text(term)) criteria.containAll = text(term);
      if (text(condition)) criteria.medicalCondition = text(condition);
      if (text(intervention)) criteria.productName = text(intervention);
      const phaseCodes = ctisPhaseCodes(phases);
      if (phaseCodes.length) criteria.trialPhaseCode = phaseCodes;
      const codes = statuses.map(Number).filter((code) => Number.isInteger(code) && code >= 1 && code <= 12);
      if (codes.length) criteria.status = codes;
      if (hasResults === true || hasResults === false) criteria.hasStudyResults = hasResults;
      const body = JSON.stringify({
        pagination: { page, size: Math.max(1, Math.min(100, Math.floor(limit))) },
        sort: { property: "decisionDate", direction: "DESC" },
        searchCriteria: criteria,
      });
      const answer = await getJson(`${ctisOrigin}/search`, Date.now() + timeoutMs, { method: "POST", body });
      // A 404 on the search endpoint is the endpoint gone, not a trial that is not there.
      if (!answer.ok) return unavailable(answer.reason === REGISTRY_NOT_FOUND ? "http_404" : answer.reason, "ctis");
      const data = answer.body;
      const paging = data?.pagination;
      if (!data || typeof data !== "object" || !Array.isArray(data.data) || !paging || typeof paging !== "object"
        || data.showWarning === true || !Number.isFinite(Number(paging.totalRecords))) {
        return unavailable("registry_answer_unreadable", "ctis");
      }
      const retrievedAt = now().toISOString();
      observed("ctis", "available", null, retrievedAt);
      return {
        status: "ok",
        registry: "ctis",
        total: Number(paging.totalRecords),
        nextPageToken: paging.nextPage === true ? String(page + 1) : null,
        retrievedAt,
        items: data.data.map(ctisListItem).filter((/** @type {{registryId: string}} */ item) => CTIS_NUMBER.test(item.registryId)),
      };
    },

    /**
     * One EU CTIS record, in full, with the values that can be quoted out of it.
     * An unknown CT number is `200` and `{}` on the wire; that is not an outage.
     * @param {string} registryId an EU CT number, `2024-513060-26-00`
     */
    async recordCtis(registryId) {
      const id = text(registryId);
      if (!CTIS_NUMBER.test(id)) return unavailable("registry_id_invalid");
      if (!ctisConfigured) return unavailable("registry_not_configured");
      counters.records += 1;
      const answer = await getJson(`${ctisOrigin}/retrieve/${encodeURIComponent(id)}`, Date.now() + timeoutMs);
      if (!answer.ok) {
        if (answer.reason === REGISTRY_NOT_FOUND) {
          observed("ctis", "available");
          return { status: REGISTRY_NOT_FOUND, reason: REGISTRY_NOT_FOUND, registryId: id };
        }
        return { ...unavailable(answer.reason, "ctis"), registryId: id };
      }
      const body = answer.body;
      if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) {
        observed("ctis", "available");
        return { status: REGISTRY_NOT_FOUND, reason: REGISTRY_NOT_FOUND, registryId: id };
      }
      const retrievedAt = now().toISOString();
      const built = ctisPrecedent(body, { retrievedAt });
      if (built.precedent.registryId !== id) return { ...unavailable("registry_record_unreadable", "ctis"), registryId: id };
      observed("ctis", "available", null, retrievedAt);
      return { status: "ok", ...built };
    },

    /**
     * The ChiCTR / 一级注册库 seat. With no adapter this answers
     * `registry_unavailable`; it never answers an empty list, because 「没查」
     * and 「查不到」 are different findings (plan §6.2).
     *
     * `userId` is whose credential the seat may use: the deployment's key is
     * the adapter's first choice and the researcher's own EviMed key (saved
     * under 设置 → 数据源) its second, so a researcher who brought one gets the
     * listing and one who did not is told by name. That "no credential for this
     * researcher" is a fact about them and not about the registry, so it does
     * not mark the shared coverage unavailable.
     * @param {{ query: string, limit?: number, userId?: string }} request
     */
    async searchChictr({ query, limit = 20, userId = "" } = { query: "" }) {
      if (typeof chictrAdapter !== "function") return unavailable("registry_not_configured");
      counters.searches += 1;
      try {
        const answer = await chictrAdapter({ query: text(query), limit: Math.max(1, Math.min(100, Math.floor(limit))), userId: text(userId) });
        const items = Array.isArray(answer?.items) ? answer.items : Array.isArray(answer) ? answer : null;
        if (!items) return unavailable("registry_answer_unreadable", "chictr");
        const retrievedAt = now().toISOString();
        observed("chictr", "available", null, retrievedAt);
        return {
          status: "ok",
          registry: "chictr",
          total: Number.isFinite(Number(answer?.total)) ? Number(answer.total) : items.length,
          nextPageToken: null,
          retrievedAt,
          items: items.map((/** @type {any} */ item) => chictrPrecedent(item, { retrievedAt })),
        };
      } catch (error) {
        const code = text(/** @type {any} */ (error)?.code) || "request_failed";
        if (code === "registry_not_configured") return unavailable(code);
        lastError = code;
        return unavailable(lastError, "chictr");
      }
    },
  };
}

/**
 * The ChiCTR seat, over EviMed's evidence API (`POST /review/api/clinical-trial`,
 * `registry: 0`). ChiCTR's own site answers direct requests with 405, so the
 * only door is the platform's evidence API; the caller hands in the function
 * that makes the call with the evidence credential (`search(body)` answers the
 * API's `{ data: { total, list } }`), and this only names the registry and reads
 * the answer. Without such a function the client has no ChiCTR seat and answers
 * `registry_not_configured`, as it always did — the credential is the
 * deployment's or the researcher's own, not this module's.
 *
 * @param {{ search: (body: { query: string, count: number, registry: 0 }) => Promise<any> }} options
 * @returns {(request: { query: string, limit: number }) => Promise<{ items: any[], total: number | null }>}
 */
export function createChictrAdapter({ search }) {
  if (typeof search !== "function") throw new TypeError("The ChiCTR adapter needs the evidence API's search function.");
  return async ({ query, limit }) => {
    const answer = await search({ query, count: limit, registry: 0 });
    const data = answer?.data ?? answer;
    const items = Array.isArray(data?.list) ? data.list : Array.isArray(data?.items) ? data.items : null;
    if (!items) throw Object.assign(new Error("The evidence API's clinical-trial answer has no list."), { code: "registry_answer_unreadable" });
    return { items, total: Number.isFinite(Number(data?.total)) ? Number(data.total) : null };
  };
}
