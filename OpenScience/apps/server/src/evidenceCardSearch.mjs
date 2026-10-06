// Evidence cards as results of a run's `frontier_search` (flywheel F12, plan §5.3 and §4.3 rule 2, 2026-10-05).
//
// A card is EviMed's own reading of sources, so what a run gets from this module is an index entry and nothing
// else: who made the card, how sure it says it is, how many of its claims passed the verbatim check, and — the
// point of the rule — the primary sources it stands on, with a fixed instruction that the run cites those and
// never the card. Platform content cited as evidence amplifies itself (the plan's rule 2); the instruction rides
// every result so no run has to remember it, and a report that cites a card page anyway is told once more by the
// gate (`citedSources.mjs`, `platform-card-citation`).
//
// Hidden knowledge:
//
// - **Which cards a run may see.** A card the platform lists to every signed-in account: its own state published
//   in a zone that is published (visibility `platform` or `internet`, whatever the zone's kind). That is the
//   `public` scope of `EvidenceZoneService.list` — the narrowest reading of `cardRow`'s rule, which also lets an
//   owner read their own drafts. A draft is not an index entry for a run to point at, so the owner's drafts and
//   unpublished zones are left out, and another account's draft is never read at all: the predicate is in the
//   statement, not applied to what came back.
// - **How a card is found.** By identifier or entity keys first — the vocabulary tags the query (`keysForText`: a
//   DOI, a PMID, a registry number, a drug, a disease, a trial) and a card carries its own keys (`entity_keys`) —
//   then by the words of the query in the card's title, summary, question and answer. A name the glossary does not
//   hold is only a word; no model reads the query and nothing here guesses what it means.
// - **What leaves.** The projection is fixed. A source's text (`documentText`, a retained excerpt) never leaves:
//   a source is its title, address and identifiers, which is what a run needs to read the original itself.
// - **The currency label is said only when something was checked.** `currencyLabel` answers "current" for a card
//   whose sources nobody ever looked up, so the label is left off unless the source-change record holds a check of
//   at least one of the card's sources.

import { currencyLabel, evidenceCardIdentifiers, evidenceOriginalityIsPrimary, verifyEvidenceCardClaims } from "@evimed/domain";
import { splitKeys } from "@evimed/domain/entity-keys";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

/** Cards one search returns at most: an index entry is a pointer, and the run has other tools for the rest. */
export const CARD_SEARCH_MAX = 5;
/** Primary sources named per card. */
const SOURCES_PER_CARD = 6;
/** Words of a query matched as text, and the shortest word that counts. */
const MAX_TERMS = 6;
const MIN_TERM_CHARS = 2;
const MAX_TERM_CHARS = 100;

/** What a run is told about every card, in one sentence: the rule, not a description of the card. */
export const CARD_INDEX_INSTRUCTION = "EviMed's own index, not evidence: read the primary sources below and cite them; never cite this card.";

/** @param {unknown} value */
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * The words of a query that are matched as text: whitespace-separated, lower-cased, repeats and one-character
 * words dropped. A mechanical keyword match, not a reading of the question.
 * @param {string} query
 */
export function cardQueryTerms(query) {
  return [...new Set(String(query).toLowerCase().split(/\s+/).map((term) => term.slice(0, MAX_TERM_CHARS)).filter((term) => [...term].length >= MIN_TERM_CHARS))].slice(0, MAX_TERMS);
}

/**
 * A source as a run is shown it: where it is and what it is called, plus the identifiers its address states.
 * @param {any} source
 */
function primarySource(source) {
  const keys = evidenceCardIdentifiers({ sources: [source] });
  const doi = keys.find((key) => key.startsWith("doi:"))?.slice(4) ?? null;
  const pmid = keys.find((key) => key.startsWith("pmid:"))?.slice(5) ?? null;
  const registry = keys.filter((key) => key.startsWith("registry:")).map((key) => key.slice(9).toUpperCase());
  const url = text(source?.url);
  return {
    title: text(source?.title),
    url: url && /^https?:\/\//i.test(url) ? url : null,
    doi, pmid,
    ...(registry.length ? { registryIds: registry } : {}),
  };
}

/**
 * One matched row as an index entry.
 * @param {any} row @param {{ matchedBy: string, currency: string | null }} extra
 */
function projectedCard(row, { matchedBy, currency }) {
  const claims = Array.isArray(row.claims) ? row.claims : [];
  const sources = Array.isArray(row.sources) ? row.sources : [];
  const verification = verifyEvidenceCardClaims({ claims, sources });
  const answer = text(row.content?.answer) ?? text(row.summary);
  const checked = text(row.disclosure?.lastCheckedAt) ?? text(row.editorial?.sourceCheckedAt) ?? (row.updated_at ? new Date(row.updated_at).toISOString() : null);
  return {
    kind: "card",
    id: String(row.id),
    zoneId: String(row.zone_id),
    title: text(row.title),
    question: text(row.content?.question),
    answer,
    zone: { title: text(row.zone_title), kind: String(row.zone_kind) },
    producer: row.producer ? { kind: row.producer.kind ?? null, name: text(row.producer.name), relation: row.producer.relation ?? null } : null,
    originality: row.originality ?? null,
    primary: evidenceOriginalityIsPrimary(row.originality),
    // An index entry counts the quotations it can check here; a claim the platform computed is checked against its receipt on the card itself.
    claims: { total: verification.counts.total - (verification.counts.calculation_unverified ?? 0), verified: verification.counts.verified },
    lastCheckedAt: checked,
    revision: Number(row.revision),
    ...(currency ? { currency } : {}),
    matchedBy,
    primarySources: sources.slice(0, SOURCES_PER_CARD).map(primarySource),
    primarySourcesTotal: sources.length,
    instruction: CARD_INDEX_INSTRUCTION,
  };
}

/**
 * The currency label of a card, or null when no source of it has been checked: the record says "current" of
 * anything it holds no change for, and a label of that kind is a claim nobody made.
 * @param {any} sourceChanges the source-change store, or null @param {any[]} sources
 * @returns {Promise<string | null>}
 */
async function cardCurrency(sourceChanges, sources) {
  if (!sourceChanges?.changesForCardSources || !sources.length) return null;
  const found = await sourceChanges.changesForCardSources(sources);
  if (!found.some((entry) => entry.lastCheckedAt || entry.changes?.length)) return null;
  return currencyLabel({ changes: found.flatMap((entry) => entry.changes ?? []) });
}

/**
 * @param {{ database: any, entityVocabulary?: { keysForText: (input: { texts: string[] }) => Promise<string[]> } | null,
 *           sourceChanges?: any }} dependencies
 *   `entityVocabulary` tags the query with keys, `sourceChanges` supplies the currency label; either may be absent.
 */
export function createEvidenceCardSearch({ database, entityVocabulary = null, sourceChanges = null }) {
  const counters = { searches: 0, found: 0, failures: 0 };
  return {
    /**
     * Published cards that match a query, by shared keys first and by its words after.
     * @param {{ id: string }} _user the runtime's account: every account sees the same published cards, so it only names the reader
     * @param {{ q: string, limit?: number }} request
     * @returns {Promise<{ cards: ReturnType<typeof projectedCard>[], more: boolean }>}
     */
    async search(_user, { q, limit = CARD_SEARCH_MAX }) {
      counters.searches += 1;
      const size = Math.max(1, Math.min(CARD_SEARCH_MAX, Math.trunc(Number(limit)) || CARD_SEARCH_MAX));
      try {
        await migrateEvidenceZones(database);
        const tagged = entityVocabulary ? await entityVocabulary.keysForText({ texts: [q] }).catch(() => []) : [];
        const { entityKeys, identifierKeys } = splitKeys(tagged);
        const terms = cardQueryTerms(q);
        if (!entityKeys.length && !identifierKeys.length && !terms.length) return { cards: [], more: false };
        const rows = (await database.query(`SELECT * FROM (
            SELECT c.id, c.zone_id, c.title, c.summary, c.content, c.sources, c.claims, c.producer, c.originality, c.entity_keys,
              c.disclosure, c.editorial, c.revision, c.updated_at, z.title AS zone_title, z.kind AS zone_kind,
              (SELECT count(*) FROM unnest(c.entity_keys) k WHERE k = ANY($1::text[]))::integer AS shared_identifiers,
              (SELECT count(*) FROM unnest(c.entity_keys) k WHERE k = ANY($2::text[]))::integer AS shared_entities,
              (SELECT count(*) FROM unnest($3::text[]) t WHERE strpos(lower(concat_ws(' ', c.title, c.summary, c.content->>'question', c.content->>'answer')), t) > 0)::integer AS term_hits
            FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id
            WHERE c.state = 'published' AND z.state = 'published' AND c.withdrawn IS NULL) matched
          WHERE shared_identifiers > 0 OR shared_entities > 0 OR term_hits > 0
          ORDER BY shared_identifiers DESC, shared_entities DESC, term_hits DESC, updated_at DESC, id
          LIMIT $4`, [identifierKeys, entityKeys, terms, size + 1])).rows ?? [];
        const kept = rows.slice(0, size);
        const cards = [];
        for (const row of kept) {
          const currency = await cardCurrency(sourceChanges, Array.isArray(row.sources) ? row.sources : []).catch(() => null);
          cards.push(projectedCard(row, { matchedBy: row.shared_identifiers > 0 ? "identifier" : row.shared_entities > 0 ? "entity" : "text", currency }));
        }
        counters.found += cards.length;
        return { cards, more: rows.length > size };
      } catch (error) {
        counters.failures += 1;
        throw error;
      }
    },
    stats: () => ({ ...counters }),
  };
}
