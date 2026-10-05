// The operator's counters for the evidence card's guardrails (flywheel plan §11, 2026-10-05).
//
// Three numbers must stay at zero and one must be watched: a card without a producer, a write that reached a zone
// from an origin the zone does not accept, a card refused for a simulated value, and what each origin writes. A
// counter is a label: counting a refusal never changes the refusal, and a counter that cannot be read costs the
// scrape one gauge and the write nothing.
//
// Module-level like `geneExpressionMetrics.mjs`: one process, one table, read by `/api/ops/metrics`. Every series exists
// from the start at zero, so the first refusal is an increase `increase()` can see. An unknown origin or value source
// is ignored, never counted under a made-up label.

import { EVIDENCE_DERIVED_ONLY_VALUE_SOURCES, EVIDENCE_SIMULATED_VALUE_SOURCES, EVIDENCE_WRITE_ORIGINS, EVIDENCE_ZONE_KINDS } from "@evimed/domain";

const REFUSED_VALUE_SOURCES = [...EVIDENCE_SIMULATED_VALUE_SOURCES, ...EVIDENCE_DERIVED_ONLY_VALUE_SOURCES];

/** @type {Map<string, number>} `origin\u0000zoneKind` -> refused writes */
const refused = new Map();
/** @type {Map<string, number>} origin -> accepted card writes */
const accepted = new Map(EVIDENCE_WRITE_ORIGINS.map((origin) => [origin, 0]));
/** @type {Map<string, number>} value source -> cards refused */
const simulated = new Map(REFUSED_VALUE_SOURCES.map((source) => [source, 0]));
for (const origin of EVIDENCE_WRITE_ORIGINS) for (const kind of EVIDENCE_ZONE_KINDS) refused.set(`${origin}\u0000${kind}`, 0);

/** A write the zone's kind does not accept from this origin. @param {string} origin @param {string} zoneKind */
export function recordEvidenceWriteRefused(origin, zoneKind) {
  const key = `${origin}\u0000${zoneKind}`;
  if (refused.has(key)) refused.set(key, (refused.get(key) ?? 0) + 1);
}

/** A card write that reached a zone. @param {string} origin */
export function recordEvidenceWriteAccepted(origin) {
  if (accepted.has(origin)) accepted.set(origin, (accepted.get(origin) ?? 0) + 1);
}

/** A card refused for a value source it may not carry. @param {string} valueSource */
export function recordEvidenceSimulatedRefused(valueSource) {
  if (simulated.has(valueSource)) simulated.set(valueSource, (simulated.get(valueSource) ?? 0) + 1);
}

/** The test hook: counters are process state. */
export function resetEvidenceCardMetrics() {
  for (const map of [refused, accepted, simulated]) for (const key of map.keys()) map.set(key, 0);
}

/**
 * @param {{ cardsWithoutProducer: number } | null} snapshot what `EvidenceZoneService.metrics()` read, or null when it could not be read
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function evidenceCardMetricFamilies(snapshot) {
  return [
    {
      name: "open_science_evidence_cards_without_producer",
      help: "Evidence cards that name no producer. Must be 0: every card says who made it and how that producer relates to the products it concerns.",
      type: "gauge",
      series: snapshot ? [{ value: snapshot.cardsWithoutProducer }] : [],
    },
    {
      name: "open_science_evidence_writes_refused_total",
      help: "Card writes refused because the zone's kind does not accept the write's origin, by origin and zone kind (plan §4.3 rule 1).",
      type: "counter",
      series: [...refused].map(([key, value]) => {
        const [origin, zoneKind] = key.split("\u0000");
        return { value, labels: { origin, zone_kind: zoneKind } };
      }),
    },
    {
      name: "open_science_evidence_card_writes_total",
      help: "Card writes accepted, by origin. A write from an origin outside the whitelist is refused, never counted here.",
      type: "counter",
      series: [...accepted].map(([origin, value]) => ({ value, labels: { origin } })),
    },
    {
      name: "open_science_evidence_cards_refused_simulated_total",
      help: "Cards refused for a value labelled predicted, assumed or synthetic (or imputed or reconstructed outside a derived claim with its method), by value source. Simulations never become evidence (plan §4.3 rule 3).",
      type: "counter",
      series: [...simulated].map(([valueSource, value]) => ({ value, labels: { value_source: valueSource } })),
    },
  ];
}
