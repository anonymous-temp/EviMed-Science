/**
 * What the memory page calls a memory: the closed vocabulary of its `kind`, and the words a person reads for each.
 *
 * The page's records are the native engine's files, each labelled with the kind its engine type maps to
 * (`PAGE_KIND_OF_TYPE` in `nativeMemoryStore.mjs`: `preferences` is a `preference`, `project_context` a `project_fact`, ...), and the
 * capsule's notes carry a kind of their own (`@evimed/domain`'s `CAPSULE_FACT_KINDS`). A record's `key`
 * (`preference.response_length`) is an identifier, never a name on screen: this is the name.
 */
export const MEMORY_KINDS = Object.freeze([
  "profile", "preference", "behavior", "project_fact", "analysis",
  "decision", "correction", "follow_up", "run_summary",
]);

/** What a person calls each kind — the memory page's own words. */
export const MEMORY_KIND_LABELS_ZH = Object.freeze({
  profile: "用户画像", preference: "偏好", behavior: "行为习惯", project_fact: "项目事实", analysis: "分析要素",
  decision: "决定", correction: "纠正", follow_up: "待跟进", run_summary: "运行摘要",
});
