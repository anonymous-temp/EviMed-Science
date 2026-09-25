/**
 * Whether a probe answer is an answer (build spec §5, plan §4.3): the sanity
 * check every measured answer passes before anything counts it.
 *
 * Hidden knowledge:
 *
 * - **Three kinds of short text, three different fates.** A login page or a
 *   captcha, an empty shell, a capacity notice (「聊的人太多了」) or a page
 *   that is only the site's own chrome are *suspect*: the vendor was never
 *   really asked, so they leave the denominator and the operator is alerted. A
 *   compliance refusal (「无法提供医疗建议」) is the model's answer to the
 *   question and stays IN the denominator in its own bucket — taking it out
 *   would systematically raise every mention rate. And a probe that reported a
 *   status other than `ok` is `failed`: not a measurement at all.
 * - **The markers are data, not code**: `geo/sanity.json` in `@evimed/domain`,
 *   converted from the owner's `interfaces.yaml` (`probe.sanity`), with the
 *   precedence of the owner's `classify_answer` recorded beside them. They are
 *   closed lists of the probe hosts' own page texts, which is what makes them
 *   a code check (principle 5); whether a long answer is a refusal is language,
 *   and that is the model judge's call (`geoJudge.mjs`), not a pattern here.
 * - **Page chrome is cut from the tail only** (「相关视频」「推荐追问」…): a
 *   marker counts only inside the last `page_chrome_tail_ratio` of the text,
 *   because a long answer may say 「参考资料」 in its middle. The stored answer
 *   is never edited; the parser reads the stripped body.
 *
 * Deletable when the probe host reports session state and capacity failures
 * as statuses of its own instead of rendering them into the answer text.
 *
 * @module geoSanity
 */

import { GEO_PROBE_SANITY } from "@evimed/domain";

/** @typedef {"valid" | "suspect" | "refusal" | "failed"} GeoSnapshotStatus */
/**
 * @typedef {object} GeoSanityVerdict
 * @property {GeoSnapshotStatus} status
 * @property {string | null} reason  a code: raw_status, empty_shell, session_invalid, service_unavailable, refusal_marker, too_short, chrome_only
 * @property {string | null} marker  the marker that decided it, when one did
 */

const SANITY = GEO_PROBE_SANITY;

/**
 * The answer with trailing page chrome cut off, and how many characters were
 * cut. A marker cuts only when it falls inside the last `page_chrome_tail_ratio`
 * of the text (the owner's `strip_page_chrome`).
 * @param {unknown} answer
 * @returns {{ body: string, stripped: number }}
 */
export function stripPageChrome(answer) {
  const text = String(answer ?? "");
  if (!text) return { body: "", stripped: 0 };
  let cut = text.length;
  for (const marker of SANITY.page_chrome_markers) {
    const index = text.lastIndexOf(marker);
    if (index >= 0 && text.length - index <= text.length * SANITY.page_chrome_tail_ratio) cut = Math.min(cut, index);
  }
  if (cut >= text.length) return { body: text, stripped: 0 };
  return { body: text.slice(0, cut).trimEnd(), stripped: text.length - cut };
}

/**
 * Whether the text is only page chrome: it opens with a chrome marker, or
 * what is left once the tail chrome is cut is shorter than an answer can be.
 * @param {string} text  trimmed answer
 */
function chromeOnly(text) {
  if (SANITY.page_chrome_markers.some((marker) => text.startsWith(marker))) return true;
  const { body, stripped } = stripPageChrome(text);
  return stripped > 0 && body.trim().length < SANITY.min_answer_chars;
}

/**
 * Classify one probe answer, in the owner's precedence
 * (`GEO_PROBE_SANITY._provenance.classification_order`) plus the chrome-only
 * shell: raw status → empty → login/captcha → capacity notice → refusal
 * marker → too short → chrome only → valid.
 * @param {{ rawStatus?: unknown, answer?: unknown }} input
 * @returns {GeoSanityVerdict}
 */
export function classifyProbeAnswer({ rawStatus = "ok", answer = "" }) {
  const status = String(rawStatus ?? "").trim().toLowerCase();
  if (status && status !== "ok") return { status: "failed", reason: "raw_status", marker: null };
  const text = String(answer ?? "").trim();
  if (!text) return { status: "suspect", reason: "empty_shell", marker: null };

  const session = SANITY.session_invalid_markers.find((marker) => text.includes(marker));
  if (session) return { status: "suspect", reason: "session_invalid", marker: session };

  // Capacity before refusal: it is not the model's attitude, it is the vendor
  // having no capacity at that moment — and only on a short text, because a
  // real answer may say 「请稍后再试」 in its middle.
  const lower = text.toLowerCase();
  const busy = SANITY.service_unavailable_markers.find((marker) => lower.includes(marker.toLowerCase()));
  if (busy && text.length <= SANITY.service_unavailable_max_chars) {
    return { status: "suspect", reason: "service_unavailable", marker: busy };
  }

  const refusal = SANITY.refusal_markers.find((marker) => text.includes(marker));
  if (refusal && text.length <= SANITY.refusal_max_chars) return { status: "refusal", reason: "refusal_marker", marker: refusal };
  if (text.length < SANITY.min_answer_chars) {
    return refusal
      ? { status: "refusal", reason: "refusal_marker", marker: refusal }
      : { status: "suspect", reason: "too_short", marker: null };
  }
  if (chromeOnly(text)) return { status: "suspect", reason: "chrome_only", marker: null };
  return { status: "valid", reason: null, marker: null };
}

/** Raw probe statuses that mean "busy, ask again later" rather than a failed measurement. */
export const GEO_RETRIABLE_RAW_STATUSES = Object.freeze([...SANITY.retriable_raw_statuses]);

/** @param {unknown} rawStatus */
export function isRetriableRawStatus(rawStatus) {
  return GEO_RETRIABLE_RAW_STATUSES.includes(String(rawStatus ?? "").trim().toLowerCase());
}
