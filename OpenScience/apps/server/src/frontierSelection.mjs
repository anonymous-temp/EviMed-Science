/**
 * What decides the feed's selection, and nothing else: the line, and how a published row is read for the day's mix. Pure, and apart from
 * `frontierPipeline.mjs` so that the dependency closure of the `frontier-selection` surface (`rsiDependencyClosure.mjs`) is this module and
 * `frontierMix.mjs`: a release that changes how the pipeline reads, writes or notifies, or another part of the domain, does not invalidate a month's
 * campaign. Its domain pieces come by file path and not through the `@evimed/domain` index for the same reason. What a score means is bound beside it,
 * as a setting of that closure (`rsiClosureSettings.mjs`): a new scale changes what a threshold means.
 *
 * @module frontierSelection
 */

import { FRONTIER_MIX_COUNTED_RULES, frontierMixGenre, frontierMixSelect, frontierMixSourceCap } from "../../../packages/domain/src/frontierMix.mjs";
import { frontierFloorEligible } from "../../../packages/domain/src/frontierSelection.mjs";
import { frontierEvidenceFromPublicationTypes } from "../../../packages/domain/src/frontierVocabulary.mjs";

/**
 * The selection line when `OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD` is unset (config.mjs holds the same number; frontierConfig.test.mjs
 * holds them equal). Recalibrated 2026-10-25 (c3-select) with the score: the editor's scoring was rewritten (a ladder for impact and
 * novelty, a ceiling for each fact the platform holds - `@evimed/domain` `frontierScoreCeilings`), so its totals sit lower and spread
 * wider than the 82 of 2026-09-28 was drawn for. On the 248-item gold set (two labellers, kappa 0.87) chosen on the dev split alone as
 * the highest line that keeps the stored scores' recall of 0.50: at 64, 16 of 124 items reach the line, 12 of them picks (precision
 * 0.75, recall 0.60; the stored scores of the older prompts gave 0.145 / 0.50); the same line on the test split, reported once: 20
 * selected, precision 0.750, recall 0.714. The prompt of round 2 re-run on the same items puts 2 of 124 on the old line of 82 - a
 * release of round 2 without this move would fill 精选 from its floors alone. The expected day, from the dev split's weights over the
 * seven days to 2026-10-25, is 62 items a day above the line before the source caps, the one-pick-per-event rule and the day's size of
 * 60 (90% interval 38-87, wide: the dev split is 124 items); `scripts/ops/frontier-mix-replay.mjs` reads the first real week after the
 * rescore. Re-read a week's distribution before moving it.
 */
export const FRONTIER_SELECT_THRESHOLD_DEFAULT = 64;

/**
 * The selection line (`OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD`,
 * `FRONTIER_SELECT_THRESHOLD_DEFAULT` unless set): what the pipeline selects
 * by and what a card's score band is read against (`frontierService.mjs`),
 * from one reading of the config.
 * @param {Record<string, any> | null | undefined} config @returns {number}
 */
export function frontierSelectThreshold(config) {
  const value = Number(config?.frontierSelectThreshold);
  return config?.frontierSelectThreshold != null && config.frontierSelectThreshold !== "" && Number.isFinite(value)
    ? value : FRONTIER_SELECT_THRESHOLD_DEFAULT;
}

/**
 * Whether an item is a journal's without its abstract (flag `no-abstract`): never selected (2026-10-22).
 * @param {{ source: any, flags: string[] }} input
 */
export function frontierJournalWithoutAbstract({ source, flags }) {
  return source?.source_type === "journal" && flags.includes("no-abstract");
}

const CJK = /[㐀-鿿豈-﫿]/gu;
const LATIN = /[A-Za-z]/g;
/** Whether a title is a Chinese source's own (and so is not translated): Han
 *  characters, no kana, and Han at least half of its letters. @param {unknown} text */
export function isChineseTitle(text) {
  const value = String(text ?? "");
  if (/[぀-ヿ]/u.test(value)) return false;
  const han = value.match(CJK)?.length ?? 0;
  const latin = value.match(LATIN)?.length ?? 0;
  return han >= 2 && han >= 0.5 * (han + latin);
}

/** Project the published SQL row into the production mix consumer.
 * @param {any} row
 */
export function frontierMixCandidate(row) {
  const flags = Array.isArray(row.flags) ? row.flags : [];
  const source = { source_type: row.source_source_type, authority: row.source_authority };
  return {
    id: String(row.id), genre: frontierMixGenre(row),
    zh: String(row.lang ?? "").startsWith("zh") || isChineseTitle(row.title_raw),
    // A score is weighed against the line only once the scoring of 2026-10-25 wrote it (`scoreVersion`): an older score sits on
    // another scale, and selection is sticky, so a total of 64-81 from the old prompts would fill the day until the rescore
    // (`frontier-rewrite.mjs --steps score`) reached it. Such an item waits for that, or for its next edit; a safety alert does not.
    score: row.score_total == null || !row.score_version ? null : Number(row.score_total),
    selected: row.selected === true, rule: row.selected_rule ?? null, safety: row.safety_alert === true,
    sourceId: String(row.primary_source_id), sourceCap: frontierMixSourceCap(source),
    eligible: ["passed", "repaired"].includes(row.verification) && !flags.includes("retracted")
      && !frontierJournalWithoutAbstract({ source, flags })
      && !frontierEvidenceFromPublicationTypes(row.publication_types, { modelType: row.evidence_type }).demote,
    summarized: row.summarized === true, besideSelected: row.beside_selected === true,
    // A republisher (frontier-selection.json) takes no place under the line.
    floorEligible: frontierFloorEligible(row.primary_source_id),
    // The research's own record (a journal's or a preprint server's item) fills a research place before a report of research.
    primary: row.source_source_type === "journal" || row.source_source_type === "preprint",
    addsValue: typeof row.adds_value === "boolean" ? row.adds_value : null,
    eventId: row.event_id == null ? null : String(row.event_id),
  };
}

/**
 * What a selection leaves selected of a day: what was selected already (a safety alert, a pin) and what it picked, less what a safety alert superseded.
 * @param {{id:string, selected?:boolean}[]} candidates @param {{picks:{id:string}[], superseded:{id:string}[]}} result @returns {string[]}
 */
export function frontierSelectedIds(candidates, result) {
  return [...new Set([...candidates.filter((c) => c.selected).map((c) => c.id), ...result.picks.map((p) => p.id)])]
    .filter((id) => !result.superseded.some((entry) => entry.id === id)).sort();
}

/**
 * The day's selected volume on a line, as the offline replay counts it: the mix's own picks taken back, what stays selected (a safety alert, a pin) on both sides. Selection is sticky, so a round's own
 * picks would be only what the rounds before it left, whichever line made those. One reading, so the online volume bound and the offline rule agree on what a ratio is.
 * @param {any} input the mix's input as a round has it @param {number} threshold @returns {number}
 */
export function frontierDayVolume(input, threshold) {
  const mixPick = (/** @type {any} */ row) => row.selected === true && (row.rule == null || /** @type {readonly any[]} */ (FRONTIER_MIX_COUNTED_RULES).includes(row.rule));
  const takenBack = new Set(input.candidates.filter(mixPick).map((/** @type {any} */ row) => row.id));
  const back = (/** @type {any} */ row) => (takenBack.has(row.id) ? { ...row, selected: false, rule: null } : row);
  const candidates = input.candidates.map(back);
  const result = frontierMixSelect({ ...input, threshold, candidates, events: Object.fromEntries(Object.entries(input.events ?? {}).map(([event, members]) => [event, /** @type {any[]} */ (members).map(back)])) });
  return frontierSelectedIds(candidates, result).length;
}
