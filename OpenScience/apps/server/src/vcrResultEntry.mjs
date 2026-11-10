/**
 * The way from a conversation to the page that holds its result (VCR remediation F3, 2026-11-01).
 *
 * A tool's answer in a conversation carries `resultEntry`: the study, the tab that holds what the call produced, the words to say it
 * in and -- when the deployment knows its own address -- the absolute address, built here from `OPEN_SCIENCE_PUBLIC_URL`. The model
 * is given all four and spells none: an address it wrote would be a guess, and a relative one would resolve to the conversation's own
 * origin, not the application's. A reply that links the address is clicked in the frame, which hands a link of exactly this shape to
 * the shell as a closed message (`open-vcr-result`) and otherwise opens it in the reader's own tab.
 *
 * Nothing here decides whether a result is good or whether a reply may be sent: the entry is a place to go, added to an answer that
 * stands without it.
 *
 * @module vcrResultEntry
 */

import { VCR_MATCHING_WRITE_WHATS, VCR_RESULT_KIND_TABS, VCR_TABS, VCR_TAB_LABELS_ZH } from "@evimed/domain";

/** A study id the application is willing to put in an address (the same shape the shell bounds it by). */
const STUDY_ID = /^[A-Za-z0-9_-]{1,160}$/;
/** What the trial tab is asked about: the id of a saved design, or the key a computed design is filed under (`cd:design:endpoint:digest`). */
const TRIAL_OBJECT = /^[A-Za-z0-9_:.-]{1,200}$/;

/**
 * The absolute address of one tab of one study, or null when the deployment has no public address (a relative one would resolve to
 * the conversation's own origin).
 * @param {unknown} publicUrl @param {string} studyId @param {string} tab @param {string | null} [object] the saved object of the tab the link is about
 * @returns {string | null}
 */
export function vcrResultAddress(publicUrl, studyId, tab, object = null) {
  let base;
  try { base = new URL(String(publicUrl ?? "").trim()); } catch { return null; }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  const address = new URL(`/app/virtual-research/${encodeURIComponent(studyId)}/${tab}`, base.origin);
  if (object) address.searchParams.set("object", object);
  return address.href;
}

/**
 * The entry to one tab of one study. Null for a study or a tab the application has no such page for.
 *
 * The comparison tab shows one saved comparison as its headline, the newest unless the link says which: a reply that cites a result
 * computed for one comparison links that comparison, so a later sensitivity analysis written in the same study does not change the
 * number the reader finds (2026-11-02: the reply said an E-value of 3.0 and the page 2.22). `object` is that comparison's id. The trial tab
 * reads one too (2026-11-04): a page of four designs and a re-estimation had a first sentence about the first three and premises about the
 * last, so a link names the design the reply is about. The matching tab reads one too:
 * a patient's key, and the page opens on that patient's trials (2026-11-04); no other tab reads one.
 * @param {{ studyId: unknown, tab: unknown, publicUrl?: unknown, object?: unknown }} input
 * @returns {{ studyId: string, tab: string, label: string, url?: string, object?: string } | null}
 */
export function vcrResultEntry({ studyId, tab, publicUrl = null, object = null }) {
  if (typeof studyId !== "string" || !STUDY_ID.test(studyId) || typeof tab !== "string" || !/** @type {readonly string[]} */ (VCR_TABS).includes(tab)) return null;
  // (the key of a card's subject is not an id: `cd:` + design + endpoint + a digest, `wr:` + a digest; the trial tab reads it)
  const saved = (tab === "comparator" || tab === "trial" || tab === "matching") && typeof object === "string" && (tab === "trial" ? TRIAL_OBJECT : STUDY_ID).test(object) ? object : null;
  const url = vcrResultAddress(publicUrl, studyId, tab, saved);
  return { studyId, tab, label: `在“${/** @type {Record<string, string>} */ (VCR_TAB_LABELS_ZH)[tab]}”页查看`, ...(saved ? { object: saved } : {}), ...(url ? { url } : {}) };
}

/**
 * The tab that holds what a job of this result kind produced (the domain's one table), the overview for a kind it does not name.
 * @param {string} resultKind
 */
export function vcrResultTab(resultKind) {
  return /** @type {Record<string, string>} */ (VCR_RESULT_KIND_TABS)[resultKind] ?? "overview";
}

/**
 * A job's answer with its entry: every answer that names a job, whatever state it is in -- a running job's page is where its progress
 * and then its result appear. A refusal that started nothing has nowhere to go.
 * `object` is the saved object the job was computed for (the answer's own `subject`, or the job's record of it), so the link names the
 * result the reply is about.
 * @param {Record<string, any>} answer @param {{ study: any, resultKind: string, publicUrl?: unknown, object?: unknown }} context
 */
export function withJobEntry(answer, { study, resultKind, publicUrl = null, object = answer?.subject?.id }) {
  if (!answer || typeof answer !== "object" || typeof answer.jobId !== "string" || answer.state === "not_started") return answer;
  const entry = study?.completionOrigin ? vcrResultEntry({ studyId: study.id, tab: vcrResultTab(resultKind), publicUrl, object }) : null;
  return entry ? { ...answer, resultEntry: entry } : answer;
}

/**
 * A write's answer with its entry when it put a patient's matching on the matching tab. A write that wrote nothing has nowhere to go.
 * @param {string} what @param {Record<string, any>} answer @param {{ study: any, publicUrl?: unknown }} context
 */
export function withWriteEntry(what, answer, { study, publicUrl = null }) {
  if (!answer || answer.ok !== true || !/** @type {readonly string[]} */ (VCR_MATCHING_WRITE_WHATS).includes(what)) return answer;
  // The patient the write is about, so that the link opens on that person.
  const entry = study?.completionOrigin ? vcrResultEntry({ studyId: study.id, tab: "matching", publicUrl, object: typeof answer.subjectKey === "string" ? answer.subjectKey : null }) : null;
  return entry ? { ...answer, resultEntry: entry } : answer;
}
