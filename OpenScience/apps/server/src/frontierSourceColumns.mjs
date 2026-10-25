/**
 * Two columns every query that names an item's source for a reader selects beside `s.name` (c3-select S6, 2026-10-25): the source's
 * `access` and the item's journal, so `frontierSourceDisplayName` can name an item of a stream (a PubMed query, an OpenAlex list, a
 * Europe PMC feed) for its journal instead of the feed. A subquery, so it works whichever of the item_texts joins the query has; it
 * needs the items row aliased `i` and the sources row aliased `s`.
 */
export const FRONTIER_SOURCE_STREAM_COLUMNS = frontierSourceStreamColumns("i");

/** The same two columns for a query that aliases the items row differently. @param {string} item the items alias */
export function frontierSourceStreamColumns(item) {
  return `s.access AS source_access, (SELECT j.journal FROM evimed_frontier.item_texts j WHERE j.item_id = ${item}.id) AS item_journal`;
}
