import { createHash } from "node:crypto";

import { migrateResearchMemory } from "./researchMemoryPersistence.mjs";
import { HttpError } from "./security.mjs";

/**
 * 「这条关联不对」: the researcher's word that a line of the relation view is wrong, and the line stays out of their map.
 *
 * The map's lines are *derived* — a memory resting on a document, a page linking another, two concepts the compile related — so
 * there is no record to edit and nothing to delete; the correction has to be kept beside what it corrects. It is one row per
 * account and line, `evimed_memory.map_edge_dismissals`, keyed by the line's stable id (`edgeIdOf`: its kind and both ends, and the
 * stable id of the relation when it has one), and applied when the map is assembled (`buildMemoryMap`). The source of the line is
 * untouched: a memory still rests on its document, the compile still relates its concepts, and the model is told nothing; the
 * correction is about what this person is shown. Their own word is the stronger basis: it holds until they take it back.
 *
 * Hidden knowledge:
 *
 * - **Only derived lines.** `belongs-to` (a memory in its project, the project in the account) is structure, not a claim, and is
 *   never dismissed — the map would stop being connected.
 * - **Bounded.** An account keeps at most `MAP_EDGE_DISMISSALS_MAX` corrections: past that a new one is refused by name rather
 *   than silently dropping an older one. The ids are opaque hashes, so a correction names no content.
 * - **Gone with the account** (`ON DELETE CASCADE`); a memory reset leaves them, because they name lines, not memories, and a line
 *   whose ends no longer exist is never drawn.
 *
 * @module memoryMapEdges
 */

/** The most corrections one account keeps. */
export const MAP_EDGE_DISMISSALS_MAX = 2000;

/** What a line's id looks like. */
export const MAP_EDGE_ID = /^e_[0-9a-f]{24}$/u;

/**
 * A line's stable id: the same line in two reads of the map has the same id, whatever order its ends came in.
 * @param {{ type: string, from: string, to: string, relation?: string | null }} edge
 */
export function edgeIdOf(edge) {
  return `e_${createHash("sha256").update([edge.type, edge.from, edge.to, edge.relation ?? ""].join("\u0000")).digest("hex").slice(0, 24)}`;
}

/** Whether the researcher may call a line of this kind wrong. @param {{ type: string }} edge */
export function isDismissable(edge) {
  return edge.type !== "belongs-to";
}

/** The databases whose table is made. @type {WeakMap<object, Promise<void>>} */
const made = new WeakMap();

export class MapEdgeCorrections {
  /** @param {{ database: any }} options */
  constructor({ database }) {
    this.database = database ?? null;
  }

  get configured() {
    return Boolean(this.database);
  }

  async #ready() {
    if (!this.database) throw new HttpError(503, "memory_unconfigured", "The research memory store is not configured.");
    if (!made.has(this.database)) {
      const attempt = (async () => {
        await migrateResearchMemory(this.database);
        await this.database.query(`CREATE TABLE IF NOT EXISTS evimed_memory.map_edge_dismissals (
          user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
          edge_id text NOT NULL CHECK (edge_id ~ '^e_[0-9a-f]{24}$'),
          created_at timestamptz(3) NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, edge_id)
        )`);
      })();
      made.set(this.database, attempt);
      attempt.catch(() => made.delete(this.database));
    }
    await made.get(this.database);
  }

  /** The lines this account has called wrong. @param {string} userId @returns {Promise<Set<string>>} */
  async dismissed(userId) {
    if (!this.configured) return new Set();
    await this.#ready();
    const result = await this.database.query("SELECT edge_id FROM evimed_memory.map_edge_dismissals WHERE user_id=$1", [userId]);
    return new Set(result.rows.map((/** @type {any} */ row) => String(row.edge_id)));
  }

  /**
   * Call a line wrong (`hidden`) or take it back. Idempotent either way.
   * @param {string} userId @param {string} edgeId @param {boolean} hidden
   */
  async set(userId, edgeId, hidden) {
    if (!MAP_EDGE_ID.test(String(edgeId))) throw new HttpError(400, "memory_map_invalid", "A line's id is e_ and 24 hexadecimal digits.");
    await this.#ready();
    if (!hidden) {
      await this.database.query("DELETE FROM evimed_memory.map_edge_dismissals WHERE user_id=$1 AND edge_id=$2", [userId, edgeId]);
      return { hidden: false };
    }
    await this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`map-edge-dismissals:${userId}`]);
      const held = await client.query("SELECT count(*)::integer AS n, bool_or(edge_id=$2) AS has FROM evimed_memory.map_edge_dismissals WHERE user_id=$1", [userId, edgeId]);
      if (held.rows[0].has) return;
      if (Number(held.rows[0].n) >= MAP_EDGE_DISMISSALS_MAX) throw new HttpError(409, "memory_map_edges_full", "Too many lines are hidden already.");
      await client.query("INSERT INTO evimed_memory.map_edge_dismissals(user_id, edge_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, edgeId]);
    });
    return { hidden: true };
  }
}
