/**
 * The one place 「虚拟临研」 looks at the evidence zones (flywheel F26, 2026-10-06): which official zone is about the same disease as a
 * knowledge pack, by entity keys, so the platform pack can say where its zone is and the zone page can link the pack.
 *
 * Hidden knowledge:
 *
 * - **Read-only, one statement, and never an import of the zone module.** The module's own code never touches the frontier schema
 *   anywhere else; this file is the seam, and a deployment without the zones (the frontier off, the tables absent) answers `null`,
 *   which a platform pack records as having no zone. Nothing is written.
 * - **A zone is about a disease when its published cards are.** Zones carry no keys of their own; their published cards do
 *   (`evidence_cards.entity_keys`), so the official zone whose cards share the most of the pack's disease keys is the one.
 *
 * @module vcrZoneLink
 */

/**
 * @param {{ database: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> } }} dependencies
 * @returns {(keys: string[]) => Promise<string | null>}
 */
export function createOfficialZoneLookup({ database }) {
  return async (keys) => {
    const wanted = [...new Set(keys.map(String).filter(Boolean))].slice(0, 32);
    if (!wanted.length) return null;
    try {
      const found = await database.query(
        `SELECT z.id FROM evimed_frontier.evidence_zones z
           JOIN evimed_frontier.evidence_cards c ON c.zone_id = z.id AND c.state = 'published' AND c.entity_keys && $1::text[]
          WHERE z.kind = 'official' AND z.state = 'published' GROUP BY z.id ORDER BY count(*) DESC, z.id LIMIT 1`, [wanted]);
      return found.rows[0]?.id == null ? null : String(found.rows[0].id);
    } catch {
      return null;
    }
  };
}
