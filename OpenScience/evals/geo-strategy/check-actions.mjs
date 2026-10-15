#!/usr/bin/env node
/**
 * Grades one stored geo-strategy run's `strategy.json` against the cases of the action contract (briefs 005–008): every gap has an
 * action or a stated reason, an action's expected metric is one of its pool's, no target number stands without its basis, and
 * nothing the run wrote is dropped without the platform having decided it.
 *
 * Deterministic: the checks are the platform's own functions — `geoActionNotices` (the notices a write returns to the run that
 * wrote it) and `geoStrategyFileCoverage` (the walk of a strategy file against what the platform keeps and what it has said it does
 * not) — so a stored run is graded by the rules it was written under. The model's wording is not graded here.
 *
 *   node evals/geo-strategy/check-actions.mjs <strategy.json> [...more]      exit 1 when any case fails
 */
import { readFileSync } from "node:fs";
import { GEO_GAP_CLASS_LABELS_ZH, geoActionNotices } from "../../packages/domain/index.mjs";
import { geoStrategyFileCoverage } from "../../apps/server/src/geoWrites.mjs";

const ID_OF_LABEL = Object.fromEntries(Object.entries(GEO_GAP_CLASS_LABELS_ZH).map(([id, label]) => [label, id]));

/**
 * @param {Record<string, any>} file a parsed strategy.json
 * @returns {{ cases: Record<string, boolean>, notices: Array<{ code: string, gapId?: string | null, message: string }>, dropped: string[], counts: { gaps: number, actions: number } }}
 */
export function gradeStrategyFile(file) {
  const gaps = (Array.isArray(file.gaps) ? file.gaps : []).filter((gap) => gap && typeof gap === "object")
    .map((gap) => ({ ...gap, class: ID_OF_LABEL[String(gap.class ?? gap.category ?? "").trim()] ?? gap.class ?? gap.category }));
  const actions = Array.isArray(file.actions) ? file.actions : [];
  const notices = geoActionNotices({ gaps, actions });
  const { dropped } = geoStrategyFileCoverage(file);
  const has = (/** @type {string} */ code) => notices.some((notice) => notice.code === code);
  return {
    cases: {
      everyGapAnswered: !has("gap_without_action"),
      metricInPool: !has("metric_not_in_pool"),
      noTargetWithoutBasis: !has("target_without_basis"),
      nothingDroppedUndecided: dropped.length === 0,
    },
    notices, dropped, counts: { gaps: gaps.length, actions: actions.length },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("usage: check-actions.mjs <strategy.json> [...]"); process.exit(2); }
  let failed = false;
  for (const path of files) {
    const graded = gradeStrategyFile(JSON.parse(readFileSync(path, "utf8")));
    if (Object.values(graded.cases).some((ok) => !ok)) failed = true;
    console.log(JSON.stringify({ file: path, ...graded }, null, 2));
  }
  process.exit(failed ? 1 : 0);
}
