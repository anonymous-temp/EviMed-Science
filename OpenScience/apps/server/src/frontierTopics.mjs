/**
 * The reader's 主题 and 标签 (「前沿动态」 reader, contract B, 2026-10-22).
 *
 * The topics are data, `frontierTopics.json` beside this module — the way the
 * glossary's hand-kept rows are held (`frontierGlossarySeed.json`) — so an
 * editor adds a topic or an alias without touching code. Shape after AIHOT's
 * `industry/topics.json` and its membership rule in
 * `packages/backend/src/publication/topics.ts` (MIT, KKKKhazix/AIHOT 47531fa).
 *
 * Hidden knowledge:
 *
 * - **Membership is decided at read time, by equality, from what the item
 *   already carries**: its specialties, entity names, the editor's tags, its
 *   evidence type, lane and flags, and its source's name. A topic lists the
 *   names that put an item in it — `tags` (typed keys like
 *   `specialty:cardiology` and `evidence:rct`, or the Chinese tag the editor is
 *   offered) and `aliases` (other names: English, synonyms, the member drugs of
 *   a class) — and an item is in the topic when one of its own names equals one
 *   of them after NFKC, lower case and the removal of spaces. Equality, never a
 *   substring: 「1型糖尿病」 is not in a topic only because 「糖尿病」 is. Nothing
 *   is stored per item, so a new alias reaches every old item at once.
 * - **A tag is the editor's word, and the evidence type is the code's.** The
 *   reader's `tags` are the editor's tags (at most seven, verified one by one in
 *   `verifyEdit`) and then the evidence type's label, eight at most.
 * - The editor is offered the disease and drug topics' Chinese tags as its tag
 *   vocabulary (`frontierTopicTagNames`), in the stable prompt prefix: a tag
 *   written the vocabulary's way joins its topic, any other tag is still shown.
 *
 * @module frontierTopics
 */

import { readFileSync } from "node:fs";

/** The topic groups, in the order a reader's topics are listed. */
export const FRONTIER_TOPIC_GROUPS = Object.freeze(/** @type {const} */ (["specialty", "disease", "drug", "organisation", "genre"]));

/** At most this many topics on one item; the reader's tags stop at eight. */
export const FRONTIER_ITEM_TOPICS_MAX = 8;
export const FRONTIER_ITEM_TAGS_MAX = 8;

/**
 * @typedef {"specialty" | "disease" | "drug" | "organisation" | "genre"} FrontierTopicGroup
 * @typedef {{ slug: string, name: string, group: FrontierTopicGroup, tags: string[], aliases: string[], definition: string }} FrontierTopic
 */

/** A name in the form topics are matched by. @param {unknown} value */
export function topicKey(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/**
 * The table, checked once when the module loads: a bad row stops the start by its slug, never a silently missing topic.
 * @param {any} table @returns {FrontierTopic[]}
 */
export function frontierTopicTable(table) {
  const rows = Array.isArray(table?.topics) ? table.topics : null;
  if (!rows) throw new TypeError("frontierTopics.json: no topics.");
  const seen = new Set();
  return rows.map((/** @type {any} */ row) => {
    const slug = typeof row?.slug === "string" ? row.slug : "";
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug) || seen.has(slug)) throw new TypeError(`frontierTopics.json: the slug ${JSON.stringify(slug)} is invalid or repeated.`);
    seen.add(slug);
    if (!FRONTIER_TOPIC_GROUPS.includes(row.group)) throw new TypeError(`frontierTopics.json: ${slug} has no known group.`);
    const strings = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []).filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const definition = typeof row.definition === "string" ? row.definition.trim() : "";
    if (!name || !definition) throw new TypeError(`frontierTopics.json: ${slug} needs a name and a definition.`);
    return Object.freeze({ slug, name, group: row.group, tags: Object.freeze(strings(row.tags)), aliases: Object.freeze(strings(row.aliases)), definition });
  });
}

/** @type {readonly FrontierTopic[]} */
export const FRONTIER_TOPICS = Object.freeze(frontierTopicTable(JSON.parse(readFileSync(new URL("./frontierTopics.json", import.meta.url), "utf8"))));

/** Each topic with the keys that put an item in it. */
const MATCHERS = FRONTIER_TOPICS.map((topic) => ({ topic, keys: new Set([topic.name, ...topic.tags, ...topic.aliases].map(topicKey)) }));

/**
 * The tags the editor is offered: the disease and drug topics' Chinese tags (what a reader of a clinical item would follow),
 * in table order, each once.
 * @returns {string[]}
 */
export function frontierTopicTagNames() {
  return [...new Set(FRONTIER_TOPICS.filter((topic) => topic.group === "disease" || topic.group === "drug").flatMap((topic) => topic.tags))];
}

/**
 * @typedef {{ specialties?: string[] | null, entities?: Record<string, unknown> | null, tags?: string[] | null,
 *   evidenceType?: string | null, lane?: string | null, flags?: string[] | null, sourceName?: string | null }} FrontierTopicInput
 */

/**
 * The topics an item is in, in group order and then table order, at most `limit`.
 * @param {FrontierTopicInput} item @param {{ limit?: number }} [options]
 * @returns {Array<{ slug: string, name: string, group: FrontierTopicGroup }>}
 */
export function frontierItemTopics(item, { limit = FRONTIER_ITEM_TOPICS_MAX } = {}) {
  const names = new Set();
  for (const key of item?.specialties ?? []) names.add(topicKey(`specialty:${key}`));
  for (const list of Object.values(item?.entities && typeof item.entities === "object" ? item.entities : {})) {
    for (const name of Array.isArray(list) ? list : []) if (typeof name === "string") names.add(topicKey(name));
  }
  for (const tag of item?.tags ?? []) names.add(topicKey(tag));
  if (item?.evidenceType) names.add(topicKey(`evidence:${item.evidenceType}`));
  if (item?.lane) names.add(topicKey(`lane:${item.lane}`));
  for (const flag of item?.flags ?? []) names.add(topicKey(`flag:${flag}`));
  if (item?.sourceName) names.add(topicKey(item.sourceName));
  names.delete("");
  const found = MATCHERS.filter(({ keys }) => [...keys].some((key) => names.has(key))).map(({ topic }) => topic);
  found.sort((left, right) => FRONTIER_TOPIC_GROUPS.indexOf(left.group) - FRONTIER_TOPIC_GROUPS.indexOf(right.group));
  return found.slice(0, Math.max(0, limit)).map(({ slug, name, group }) => ({ slug, name, group }));
}

/**
 * The reader's tags: the editor's (in its order, each once) and then the evidence type's label, eight at most.
 * @param {{ tags?: string[] | null, evidenceTypeLabel?: string | null }} item @returns {string[]}
 */
export function frontierItemTags({ tags = [], evidenceTypeLabel = null }) {
  const out = [];
  const seen = new Set();
  for (const tag of [...(tags ?? []).slice(0, FRONTIER_ITEM_TAGS_MAX - 1), evidenceTypeLabel]) {
    if (typeof tag !== "string" || !tag.trim() || seen.has(topicKey(tag))) continue;
    seen.add(topicKey(tag));
    out.push(tag.trim());
  }
  return out.slice(0, FRONTIER_ITEM_TAGS_MAX);
}
