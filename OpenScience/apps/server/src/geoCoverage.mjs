/**
 * What each round of a project measured, read from its snapshots — the input of the coverage key (`@evimed/domain` `geoCoverageKey`,
 * R14 N-4).
 *
 * The engines of a round are the ones with an answer in it (status `valid` or `refusal`), the same set the diagnosis states as
 * 「按 N 个引擎」, and the pools are those of the questions that were answered. They are read from the snapshots, not from what the
 * round was planned with or what the metrics job noted on it: a round measured before the balance was recorded has them too, and a
 * round whose engine was paused names the engines that actually spoke. Nothing is stored; the key follows the data.
 *
 * @module geoCoverage
 */

import { geoCoverageKey } from "@evimed/domain";

/**
 * @typedef {object} RoundCoverage
 * @property {number | null} setVersion
 * @property {string[]} pools
 * @property {string[]} engines
 * @property {Record<string, unknown> | null} surface
 */

/**
 * The measured coverage of rounds.
 * @param {{ query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }} db @param {readonly string[]} roundIds
 * @returns {Promise<Map<string, RoundCoverage>>}
 */
export async function roundCoverages(db, roundIds) {
  const ids = [...new Set(roundIds.filter((id) => typeof id === "string" && id))];
  /** @type {Map<string, RoundCoverage>} */
  const byRound = new Map();
  if (ids.length === 0) return byRound;
  const result = await db.query(`SELECT r.id, r.set_version, r.surface,
      coalesce(array_agg(DISTINCT s.engine) FILTER (WHERE s.id IS NOT NULL), '{}') AS engines,
      coalesce(array_agg(DISTINCT coalesce(q.pool, g.pool)) FILTER (WHERE s.id IS NOT NULL AND coalesce(q.pool, g.pool) IS NOT NULL), '{}') AS pools
    FROM evimed_geo.rounds r
      LEFT JOIN evimed_geo.snapshots s ON s.round_id = r.id AND s.status IN ('valid', 'refusal')
      LEFT JOIN evimed_geo.questions q ON q.id = s.question_id
      LEFT JOIN evimed_geo.question_groups g ON g.id = q.group_id
    WHERE r.id = ANY($1::text[]) GROUP BY r.id`, [ids]);
  for (const row of result.rows) {
    byRound.set(String(row.id), {
      setVersion: row.set_version == null ? null : Number(row.set_version),
      pools: Array.isArray(row.pools) ? row.pools.map(String) : [],
      engines: Array.isArray(row.engines) ? row.engines.map(String) : [],
      surface: row.surface && typeof row.surface === "object" ? row.surface : null,
    });
  }
  return byRound;
}

/**
 * The key of a reading of one round: of the whole round, or — for a reading that is one engine's — of that engine alone, since an
 * engine's rate does not depend on which other engines answered.
 * @param {RoundCoverage | undefined | null} coverage @param {{ engine?: string | null }} [options]
 * @returns {string | null}
 */
export function coverageKeyOf(coverage, { engine = null } = {}) {
  if (!coverage) return null;
  const engines = engine ? coverage.engines.filter((name) => name === engine) : coverage.engines;
  return geoCoverageKey({ setVersion: coverage.setVersion, pools: coverage.pools, engines, surface: coverage.surface });
}
