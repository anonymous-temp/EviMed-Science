/**
 * The sentences a run's notices carry (C2 `text`), for tests that assert on
 * what a notice said. A run's `qualityNotices` are structured items now — code,
 * check, severity, a Chinese title — and the sentence is only their `text`.
 * @param {{ qualityNotices?: readonly any[] } | null | undefined} run
 * @returns {string[]}
 */
export function noticeTexts(run) {
  return (run?.qualityNotices ?? []).map((notice) => (typeof notice === "string" ? notice : String(notice?.text ?? "")));
}
