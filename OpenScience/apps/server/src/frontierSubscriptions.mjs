import { FrontierGlossaryStore } from "./frontierGlossary.mjs";
import { tsqueryLiteral } from "./kbChunker.mjs";
import { HttpError } from "./security.mjs";

/** @typedef {{ id: string, kind: string, key: string, label: string, muted: boolean, createdAt: string }} FrontierSubscription */

/** Shared deterministic match predicates over already-published structured data.
 * Topic matching uses the feed's existing lexical index, never a new language
 * classifier. An event alias resolves to the existing survivor table.
 * @param {FrontierSubscription} follow @param {(value: unknown) => string} param
 */
export function frontierFollowPredicate(follow, param) {
  if (follow.kind === "source") return `i.primary_source_id = ${param(follow.key)}`;
  if (follow.kind === "specialty") return `${param(follow.key)} = ANY(i.specialties)`;
  if (follow.kind === "drug") return `${param(follow.key)} = ANY(i.entity_keys)`;
  if (follow.kind === "event") {
    const key = param(follow.key);
    return `i.event_id IN (SELECT id FROM evimed_frontier.events WHERE public_id = ${key}
      UNION SELECT event_id FROM evimed_frontier.event_aliases WHERE public_id = ${key})`;
  }
  if (follow.kind === "topic") {
    const query = tsqueryLiteral(follow.key);
    return query ? `i.lexemes @@ ${param(query)}::tsquery` : "FALSE";
  }
  return "FALSE";
}

export class FrontierSubscriptions {
  /** @param {{ database: any, glossary?: FrontierGlossaryStore }} options */
  constructor({ database, glossary = new FrontierGlossaryStore({ database }) }) {
    this.database = database;
    this.glossary = glossary;
  }

  /** A drug follow's public key stays a name; item matching uses its namespaced identity.
   * @param {string} key */
  async drugKey(key) {
    const glossary = await this.glossary.current();
    return glossary.entityKey("drug", key.startsWith("drug:") ? key.slice(5) : key)?.slice(5) ?? key;
  }

  /** @param {string} userId @param {string | null} [selectedId] */
  async read(userId, selectedId = null) {
    const result = await this.database.query(`SELECT id,kind,key,label,muted,created_at FROM evimed_frontier.user_follows WHERE user_id=$1 ORDER BY id`, [userId]);
    const glossary = await this.glossary.current();
    const follows = /** @type {FrontierSubscription[]} */ (result.rows.map((/** @type {any} */ row) => ({
      id: String(row.id), kind: row.kind, key: row.kind === "drug"
        ? glossary.entityKey("drug", String(row.key).startsWith("drug:") ? String(row.key).slice(5) : row.key) : row.key,
      label: row.label, muted: row.muted === true, createdAt: new Date(row.created_at).toISOString(),
    })));
    const selected = selectedId == null ? null : follows.find((follow) => follow.id === selectedId) ?? null;
    if (selectedId != null && !selected) throw new HttpError(404, "frontier_follow_not_found", "No such follow.");
    return { selected, muted: follows.filter((follow) => follow.muted), follows };
  }
}
