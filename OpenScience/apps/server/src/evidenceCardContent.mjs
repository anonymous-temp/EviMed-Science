import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";

const invalid = () =>
  new HttpError(
    400,
    "evidence_invalid",
    "Invalid evidence content or review receipt.",
  );
/** JSONB sorts object keys; hashes must be stable before and after persistence.
 * @param {any} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
/** @param {unknown} value */
export const evidenceHash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" ? value : JSON.stringify(canonical(value)),
    )
    .digest("hex");
/** Publisher status is evidence, not an AI judgement. Missing metadata never clears it.
 * @param {any} value */
export function evidencePublicationStatus(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["kind", "notices"].includes(key)) ||
      !["retracted", "corrected", "concern"].includes(value.kind) ||
      !Array.isArray(value.notices) || value.notices.length > 10 ||
      value.notices.some(notice => typeof notice !== "string" || !notice.trim() || notice.length > 1000)) throw invalid();
  return {kind:value.kind,notices:[...new Set(value.notices.map(notice=>notice.trim()))].sort()};
}
/** The final scientific payload, excluding attribution and volatile fetch timestamps. @param {any} value */
export function evidenceContentHash(value) {
  return evidenceHash([
    value.title,
    value.summary,
    value.body,
    value.content ?? null,
    value.limitations,
    (value.sources ?? []).map((/** @type {any} */ s) => [
      s.title,
      s.url,
      s.excerpt,
      s.sha256 ?? null,
      s.coverage ?? "excerpt",
      ...(s.publicationStatus ? [evidencePublicationStatus(s.publicationStatus)] : []),
    ]),
  ]);
}
/** @param {any[]} sources */
export function evidenceSourceFingerprint(sources) {
  return evidenceHash(
    sources.map((s) => [
      s.url,
      s.sha256 ?? evidenceHash(s.documentText ?? s.excerpt ?? ""),
      s.coverage ?? "excerpt",
      ...(s.publicationStatus ? [evidencePublicationStatus(s.publicationStatus)] : []),
    ]),
  );
}
/** @param {any} value @param {number} sourceCount */
export function evidenceStructuredContent(value, sourceCount) {
  if (value == null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 50000
  )
    throw invalid();
  const string = (/** @type {any} */ v, max = 12000) =>
    typeof v === "string" && v.length <= max;
  const indexes = (/** @type {any} */ v) =>
    v == null ||
    (Array.isArray(v) &&
      v.every((i) => Number.isSafeInteger(i) && i >= 1 && i <= sourceCount));
  if (
    Object.keys(value).some(
      (k) =>
        ![
          "question",
          "answer",
          "population",
          "context",
          "nextStep",
          "sections",
          "tables",
          "comparisons",
        ].includes(k),
    )
  )
    throw invalid();
  for (const key of ["question", "answer", "population", "context", "nextStep"])
    if (value[key] != null && !string(value[key])) throw invalid();
  if (
    value.sections != null &&
    (!Array.isArray(value.sections) ||
      value.sections.length > 30 ||
      value.sections.some(
        (s) =>
          !s ||
          typeof s !== "object" ||
          !string(s.title, 300) ||
          !string(s.text) ||
          !indexes(s.sourceIndexes),
      ))
  )
    throw invalid();
  if (
    value.tables != null &&
    (!Array.isArray(value.tables) ||
      value.tables.length > 10 ||
      value.tables.some(
        (t) =>
          !t ||
          typeof t !== "object" ||
          !string(t.title, 300) ||
          !Array.isArray(t.columns) ||
          !t.columns.length ||
          t.columns.length > 12 ||
          !t.columns.every((c) => string(c, 300)) ||
          !Array.isArray(t.rows) ||
          t.rows.length > 100 ||
          t.rows.some(
            (r) =>
              !Array.isArray(r) ||
              r.length !== t.columns.length ||
              !r.every((c) => string(c, 3000)),
          ) ||
          (t.caption != null && !string(t.caption)) ||
          !indexes(t.sourceIndexes),
      ))
  )
    throw invalid();
  if (
    value.comparisons != null &&
    (!Array.isArray(value.comparisons) ||
      value.comparisons.length > 10 ||
      value.comparisons.some(
        (c) =>
          !c ||
          typeof c !== "object" ||
          !string(c.title, 300) ||
          !string(c.outcome, 500) ||
          !string(c.timeframe, 500) ||
          !Number.isFinite(c.denominator) ||
          c.denominator <= 0 ||
          !["risk", "rate"].includes(c.measure ?? "risk") ||
          (c.denominatorUnit != null &&
            c.denominatorUnit !==
              ((c.measure ?? "risk") === "risk" ? "people" : "person-years")) ||
          ![c.control, c.intervention].every(
            (a) =>
              a &&
              string(a.label, 300) &&
              Number.isFinite(a.events) &&
              a.events >= 0 &&
              ((c.measure ?? "risk") === "rate" || a.events <= c.denominator),
          ) ||
          !indexes(c.sourceIndexes) ||
          !c.sourceIndexes?.length ||
          [c.relativeEffect, c.certainty, c.note].some(
            (v) => v != null && !string(v),
          ),
      ))
  )
    throw invalid();
  return value;
}
/** @param {any} value @param {any} card @param {number} revision */
export function evidenceEditorialReceipt(value, card, revision) {
  const contentHash = evidenceContentHash(card),
    sourceFingerprint = evidenceSourceFingerprint(card.sources);
  if (value == null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 20000
  )
    throw invalid();
  const lastEditor = value.lastEditor;
  if (lastEditor != null && (
    typeof lastEditor !== "object" || Array.isArray(lastEditor) ||
    Object.keys(lastEditor).some(key => !["userId", "name", "editedAt"].includes(key)) ||
    typeof lastEditor.userId !== "string" || !lastEditor.userId.trim() || lastEditor.userId.length > 300 ||
    typeof lastEditor.name !== "string" || !lastEditor.name.trim() || lastEditor.name.length > 300 ||
    typeof lastEditor.editedAt !== "string" || !Number.isFinite(Date.parse(lastEditor.editedAt))
  )) throw invalid();
  const author = value.author;
  if (
    !author ||
    !["ai", "human"].includes(author.kind) ||
    typeof author.name !== "string" ||
    author.name.length > 300 ||
    (author.kind === "ai" && typeof author.model !== "string")
  )
    throw invalid();
  const reviewed = value.status === "ai-reviewed";
  if (!["ai-reviewed", "review-pending"].includes(value.status))
    throw invalid();
  if (
    reviewed &&
    (value.contentHash !== contentHash ||
      card.sources.some(source => source.publicationStatus) ||
      value.reviewer?.kind !== "ai" ||
      typeof value.reviewer.name !== "string" ||
      typeof value.reviewer.model !== "string")
  )
    throw invalid();
  const findings = value.findings ?? [];
  if (
    !Array.isArray(findings) ||
    findings.length > 50 ||
    findings.some(
      (f) =>
        !f ||
        typeof f.kind !== "string" ||
        f.kind.length > 100 ||
        typeof f.text !== "string" ||
        f.text.length > 4000 ||
        (f.sourceIndex != null &&
          (!Number.isSafeInteger(f.sourceIndex) ||
            f.sourceIndex < 1 ||
            f.sourceIndex > card.sources.length)),
    )
  )
    throw invalid();
  const sourceChecks = value.sourceChecks ?? [];
  if (!Array.isArray(sourceChecks) || sourceChecks.length > card.sources.length || sourceChecks.some(check =>
    !check || typeof check!=="object" || !Number.isSafeInteger(check.sourceIndex) || check.sourceIndex<1 || check.sourceIndex>card.sources.length ||
    !["checked","retained"].includes(check.status) || typeof check.attemptedAt!=="string" || !Number.isFinite(Date.parse(check.attemptedAt)) ||
    (check.code!=null && (typeof check.code!=="string" || !/^[a-z0-9_]{2,100}$/.test(check.code)))
  ) || new Set(sourceChecks.map(check=>check.sourceIndex)).size !== sourceChecks.length) throw invalid();
  for (const date of [
    value.sourceCheckedAt,
    value.sourceChangedAt,
    value.reviewedAt,
  ])
    if (
      date != null &&
      (typeof date !== "string" || !Number.isFinite(Date.parse(date)))
    )
      throw invalid();
  return {
    author,
    ...(lastEditor ? {lastEditor:{userId:lastEditor.userId,name:lastEditor.name,editedAt:lastEditor.editedAt}} : {}),
    reviewer: reviewed ? value.reviewer : null,
    contentHash,
    sourceFingerprint,
    sourceChecks,
    sourceCheckedAt: value.sourceCheckedAt ?? null,
    sourceChangedAt: value.sourceChangedAt ?? null,
    reviewedAt: reviewed
      ? (value.reviewedAt ?? new Date().toISOString())
      : null,
    status: value.status,
    findings,
    reviewRevision: reviewed ? revision : null,
  };
}

/** Public source anchors stay short in languages that do not use spaces.
 * @param {string} documentText @param {string|null} [preserved] */
export function evidencePublicExcerpt(documentText, preserved = null) {
  const segmenter = new Intl.Segmenter("und", { granularity: "word" });
  const words = (/** @type {string} */ value) =>
    [...segmenter.segment(value)].filter((segment) => segment.isWordLike)
      .length;
  if (
    preserved &&
    preserved.length <= 300 &&
    words(preserved) <= 25 &&
    documentText.includes(preserved)
  )
    return preserved;
  const prefix = documentText.slice(0, 300);
  let count = 0,
    end = 0;
  for (const segment of segmenter.segment(prefix)) {
    if (segment.isWordLike) count++;
    end = segment.index + segment.segment.length;
    if (count >= 25) break;
  }
  return prefix.slice(0, end).trim();
}
