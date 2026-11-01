import { CTGOV_BASE_URL, CTGOV_STUDY_URL } from "./trialRegistryClient.mjs";
import { fetchWebTransport, headerValue, nodeWebTransport } from "./webReadNetwork.mjs";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const MAX_STUDIES = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const FIELDS = "NCTId,BriefTitle,Condition,LeadSponsorName,LastUpdatePostDate,StudyFirstPostDate,StudyType";
const NCT_ID = /^NCT(?!00000000$)\d{8}$/;

/** @typedef {{ id: string, title: string, conditions: string[], sourceName: string, sponsor: string | null,
 * updatedDate: string, firstPostedDate: string | null, url: string }} RecentTrialRecord */

/** @param {unknown} value @param {number} max */
function text(value, max) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/** Full registry calendar dates only: neither partial precision nor rollover is invented. @param {unknown} value */
function calendarDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}

function unavailable() {
  return Object.assign(new Error("Recent ClinicalTrials.gov updates are unavailable."), { code: "search_topics_trials_unavailable" });
}

/**
 * Read a bounded sample of genuine recently updated trial registrations, without medical judgement.
 * The official API documents the date area, descending sort and field projection at
 * https://clinicaltrials.gov/data-api/api (live response checked on 2026-10-30).
 * Reuse the public-source network transport: checked DNS is pinned to the socket,
 * private addresses and redirects are refused, and bytes are bounded while streaming.
 * The generic registry client intentionally strips update dates from its design-candidate
 * view, so this source keeps its narrow query/projection without changing that view.
 * @param {{ fetchImpl?: typeof fetch, transport?: import("./webReadNetwork.mjs").WebTransport,
 * now?: () => Date, timeoutMs?: number, maxStudies?: number }} [options]
 */
export function createSearchTopicsTrialSource({ fetchImpl, transport, now = () => new Date(), timeoutMs = 10_000, maxStudies = 100 } = {}) {
  // A supplied fetch is for deterministic replay; production uses the DNS-pinned transport.
  const request = transport ?? (fetchImpl ? fetchWebTransport(fetchImpl) : nodeWebTransport());
  const limit = Number.isFinite(maxStudies) ? Math.max(1, Math.min(MAX_STUDIES, Math.floor(maxStudies))) : 100;
  const budget = Number.isFinite(timeoutMs) ? Math.max(100, Math.min(20_000, Math.floor(timeoutMs))) : 10_000;
  return {
    /** @param {{ signal?: AbortSignal }} [options] */
    async read({ signal } = {}) {
      const started = now();
      if (!(started instanceof Date) || !Number.isFinite(started.getTime())) throw unavailable();
      const windowEnd = started.toISOString().slice(0, 10);
      const windowStart = new Date(started.getTime() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
      const url = new URL(`${CTGOV_BASE_URL}/studies`);
      url.search = new URLSearchParams({
        "filter.advanced": `AREA[StudyType]INTERVENTIONAL AND AREA[LastUpdatePostDate]RANGE[${windowStart},${windowEnd}]`,
        sort: "LastUpdatePostDate:desc", pageSize: String(limit), format: "json", fields: FIELDS,
      }).toString();
      const deadline = AbortSignal.timeout(budget);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let answer;
      try {
        const response = await request({ url, headers: { accept: "application/json", "user-agent": "EviMed-Science/0.1" }, signal: requestSignal, maxBytes: MAX_BYTES });
        if (response.status !== 200 || response.body.byteLength > MAX_BYTES
          || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(headerValue(response.headers, "content-type"))) throw unavailable();
        answer = JSON.parse(response.body.toString("utf8"));
        if (!answer || !Array.isArray(answer.studies)) throw unavailable();
      } catch {
        throw unavailable();
      }
      /** @type {RecentTrialRecord[]} */
      const records = [];
      const seen = new Set();
      const page = answer.studies.slice(0, limit);
      let nonInterventional = 0;
      for (const study of page) {
        const protocol = study?.protocolSection;
        const id = text(protocol?.identificationModule?.nctId, 64);
        const title = text(protocol?.identificationModule?.briefTitle, 500);
        const studyType = protocol?.designModule?.studyType;
        const updatedDate = calendarDay(protocol?.statusModule?.lastUpdatePostDateStruct?.date);
        const firstPostedValue = protocol?.statusModule?.studyFirstPostDateStruct?.date;
        const firstPostedDate = firstPostedValue == null ? null : calendarDay(firstPostedValue);
        const conditions = [...new Set((Array.isArray(protocol?.conditionsModule?.conditions) ? protocol.conditionsModule.conditions : [])
          .map((/** @type {unknown} */ value) => text(value, 160)).filter(Boolean))].slice(0, 40);
        if (!NCT_ID.test(id) || seen.has(id) || !title || !conditions.length || !updatedDate
          || updatedDate < windowStart || updatedDate > windowEnd
          || firstPostedValue != null && (!firstPostedDate || firstPostedDate > windowEnd || firstPostedDate > updatedDate)) continue;
        if (studyType === "OBSERVATIONAL" || studyType === "EXPANDED_ACCESS") { nonInterventional += 1; continue; }
        if (studyType !== "INTERVENTIONAL") continue;
        seen.add(id);
        records.push({ id, title, conditions, sourceName: "ClinicalTrials.gov", sponsor: text(protocol?.sponsorCollaboratorsModule?.leadSponsor?.name, 200) || null,
          updatedDate, firstPostedDate, url: `${CTGOV_STUDY_URL}${id}` });
      }
      if (page.length && !records.length && nonInterventional !== page.length) throw unavailable();
      records.sort((a, b) => b.updatedDate.localeCompare(a.updatedDate) || a.id.localeCompare(b.id));
      const fetchedAt = now().toISOString();
      return { records, fetchedAt, dataThrough: records[0] ? `${records[0].updatedDate}T00:00:00.000Z` : null,
        windowStart, windowEnd, hasMore: typeof answer.nextPageToken === "string" && !!answer.nextPageToken };
    },
  };
}
