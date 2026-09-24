/**
 * What a reader of 「前沿动态」 calls a source (plan 2026-09-23 §6.2, §6.5 #5).
 *
 * Hidden knowledge:
 *
 * - **A reader sees an institution, never a feed.** The knowledge-source
 *   plugin's registry names each source by the channel it is read through —
 *   「openFDA 药品召回（enforcement）API」, 「PubMed 检索流 · 核心临床期刊 RCT」,
 *   「STAT Biotech 频道」 — which is right for the people who run the plugin and
 *   wrong on a card, a daily issue or a notification: a clinician wants to
 *   know it was the FDA. The registry also says who operates each source
 *   (`owner_entity`, the key heat counts independent institutions by), so the
 *   platform names the institution from that, in a table and not in code:
 *   `frontier-source-names.json` beside this module, which an editor extends
 *   without touching the plugin or a line of logic.
 * - **Three steps, the most specific first.** A source id named in the table
 *   (the NLM runs PubMed and ClinicalTrials.gov under one owner), then the
 *   owner entity, then the registry's own name. A publisher of many journals is
 *   deliberately not in the table: Elsevier is not what a reader of 《柳叶刀》
 *   wants to see, and a journal's registry name already is its title.
 * - **Every reader-facing surface asks here**: the card and its 「另有 N 家
 *   报道」, the event page, the daily issue and its Markdown, the model inputs
 *   whose prose a reader will read. Operator pages keep the registry name, which
 *   is what an operator searches the plugin's logs by.
 *
 * @module @evimed/domain/frontierSourceNames
 */

import sourceNameTable from './frontier-source-names.json' with { type: 'json' }

/** The longest institution name the table may hold: a card's meta line has room for this and no more. */
const MAX_NAME_CHARS = 40

/**
 * One half of the table, checked: every key a non-empty string, every value a
 * short, non-empty name. A table that breaks this fails at load, where the
 * editor who broke it sees it, never as an empty source on a card.
 * @param {unknown} entries @param {string} part @returns {Readonly<Record<string, string>>}
 */
function names(entries, part) {
  /** @type {Record<string, string>} */
  const table = {}
  for (const [key, value] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    const name = typeof value === 'string' ? value.trim() : ''
    if (!key.trim() || !name || [...name].length > MAX_NAME_CHARS) {
      throw new Error(`frontier-source-names.json: the ${part} ${JSON.stringify(key)} has no usable name`)
    }
    table[key] = name
  }
  return Object.freeze(table)
}

/**
 * The display-name table: by registry source id, and by owner entity.
 * @type {Readonly<{ sources: Readonly<Record<string, string>>, ownerEntities: Readonly<Record<string, string>> }>}
 */
export const FRONTIER_SOURCE_DISPLAY_NAMES = Object.freeze({
  sources: names(sourceNameTable.sources, 'source'),
  ownerEntities: names(sourceNameTable.ownerEntities, 'owner entity'),
})

/**
 * The name a reader sees for a source: the table's name for its id, else for
 * its owner entity, else the registry's own name (else its id).
 * @param {{ id?: unknown, name?: unknown, ownerEntity?: unknown } | null | undefined} source
 * @returns {string}
 */
export function frontierSourceDisplayName(source) {
  const id = typeof source?.id === 'string' ? source.id : ''
  const owner = typeof source?.ownerEntity === 'string' ? source.ownerEntity : ''
  const registered = typeof source?.name === 'string' && source.name.trim() ? source.name.trim() : id
  if (id && Object.hasOwn(FRONTIER_SOURCE_DISPLAY_NAMES.sources, id)) return FRONTIER_SOURCE_DISPLAY_NAMES.sources[id]
  if (owner && Object.hasOwn(FRONTIER_SOURCE_DISPLAY_NAMES.ownerEntities, owner)) return FRONTIER_SOURCE_DISPLAY_NAMES.ownerEntities[owner]
  return registered
}
