// The operator's counters for the co-creation loop (flywheel plan §5.2, F05–F07, 2026-10-05): a research result
// published as an evidence card, research continued from a card, the runs that card started, and the citation gift
// that is off. A counter is a label: counting never changes the answer, and a counter that cannot be read costs the
// scrape one series and the request nothing.
//
// Module-level like `evidenceCardMetrics.mjs`: one process, one table, read by `/api/ops/metrics`, every series at
// zero from the start so the first event is an increase `increase()` can see. An unknown label is ignored, never
// counted under a made-up name.

/** What happened to one 「发布为证据卡」: a new draft, the draft that already existed, a draft that follows an earlier card, or a refusal. */
export const RESULT_CARD_OUTCOMES = Object.freeze(["created", "existing", "next_version", "refused"]);
/** What one 「用这张卡继续研究」 did with the card's sources. */
export const CONTINUATION_OUTCOMES = Object.freeze(["started", "refused"]);
export const CONTINUATION_SOURCE_KINDS = Object.freeze(["saved_text", "saved_record", "failed"]);
/** Whose research a run started from a card was: the card's own author's, or another account's. */
export const CARD_RUN_ACTORS = Object.freeze(["author", "others"]);
export const CITATION_GIFT_OUTCOMES = Object.freeze(["granted", "duplicate", "failed"]);

/** @param {readonly string[]} names */
const table = (names) => new Map(names.map((name) => [name, 0]));
const resultCards = table(RESULT_CARD_OUTCOMES);
const continuations = table(CONTINUATION_OUTCOMES);
const continuationSources = table(CONTINUATION_SOURCE_KINDS);
const cardRuns = table(CARD_RUN_ACTORS);
const citationGifts = table(CITATION_GIFT_OUTCOMES);

/** @param {Map<string, number>} map @param {string} key @param {number} [by] */
const bump = (map, key, by = 1) => { if (map.has(key)) map.set(key, (map.get(key) ?? 0) + by); };

/** @param {string} outcome */
export const recordResultCard = (outcome) => bump(resultCards, outcome);
/** @param {string} outcome */
export const recordContinuation = (outcome) => bump(continuations, outcome);
/** @param {string} kind @param {number} [count] */
export const recordContinuationSource = (kind, count = 1) => bump(continuationSources, kind, count);
/** @param {string} actor */
export const recordCardRun = (actor) => bump(cardRuns, actor);
/** @param {string} outcome */
export const recordCitationGift = (outcome) => bump(citationGifts, outcome);

/** The test hook: counters are process state. */
export function resetEvidencePublishMetrics() {
  for (const map of [resultCards, continuations, continuationSources, cardRuns, citationGifts]) for (const key of map.keys()) map.set(key, 0);
}

/**
 * @param {{ citationGiftEnabled: boolean }} state
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function evidencePublishMetricFamilies({ citationGiftEnabled }) {
  /** @param {Map<string, number>} map @param {string} label */
  const series = (map, label) => [...map].map(([name, value]) => ({ value, labels: { [label]: name } }));
  return [
    {
      name: "open_science_evidence_result_cards_total",
      help: "Research results published as evidence-card drafts, by outcome: a new draft, the draft that already existed, a draft that follows an earlier card, or a refusal named by its code.",
      type: "counter",
      series: series(resultCards, "outcome"),
    },
    {
      name: "open_science_evidence_continuations_total",
      help: "Research continued from an evidence card (a project, the card's primary sources in its knowledge base, a prefilled question), by outcome.",
      type: "counter",
      series: series(continuations, "outcome"),
    },
    {
      name: "open_science_evidence_continuation_sources_total",
      help: "The primary sources a continuation wrote into the knowledge base: saved as a citation record (saved_record), or not saved. saved_text is retired and stays 0: a source's full text is never handed to another account (2026-10-06).",
      type: "counter",
      series: series(continuationSources, "kind"),
    },
    {
      name: "open_science_evidence_card_runs_total",
      help: "Research runs that started from an evidence card, by whose they were. Only another account's run counts as the card being cited by research.",
      type: "counter",
      series: series(cardRuns, "by"),
    },
    {
      name: "open_science_evidence_citation_gift_enabled",
      help: "1 when a card cited by other accounts' research may be thanked with a gifted lot of 灵豆; the owner has not chosen an amount, so this is 0 by default.",
      type: "gauge",
      series: [{ value: citationGiftEnabled ? 1 : 0 }],
    },
    {
      name: "open_science_evidence_citation_gifts_total",
      help: "Citation gifts the hook tried to grant, by outcome. A hook that is off does nothing and counts nothing.",
      type: "counter",
      series: series(citationGifts, "outcome"),
    },
  ];
}
