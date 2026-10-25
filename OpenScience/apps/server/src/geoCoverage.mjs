/**
 * What each round of a project measured, read from its snapshots — the input of the coverage key (`@evimed/domain` `geoCoverageKey`,
 * R14 N-4).
 *
 * The engines of a round are the ones with an answer in it (status `valid` or `refusal`), the same set the diagnosis states as
 * 「按 N 个引擎」, and the pools are those of the questions that were answered. They are read from the snapshots, not from what the
 * round was planned with or what the metrics job noted on it: a round measured before the balance was recorded has them too, and a
 * round whose engine was paused names the engines that actually spoke. Nothing is stored; the key follows the data.
 *
 * An engine whose jobs the round skipped (paused, or no channel) is not in the key even when it answered some questions first: the
 * metrics job leaves every answer of such an engine out of the round's cells (`geoMetricsJob.measureRound`), so its cells are over the
 * other engines. 2026-10-25: a round in which 豆包 answered three questions and was then paused carried 豆包 in its key, read as
 * comparable with a baseline that heard all five engines, and a four-engine rate was set against a five-engine one as a change.
 *
 * @module geoCoverage
 */

import { createHash } from "node:crypto";
import { geoCoverageKey } from "@evimed/domain";
import { balanceRows } from "./geoMetricsJob.mjs";

/**
 * @typedef {object} RoundCoverage
 * @property {number | null} setVersion
 * @property {string[]} pools
 * @property {string[]} engines
 * @property {Record<string, unknown> | null} surface
 * @property {string[]} questionIds
 * @property {Record<string, { questionIds: string[], pools: string[] }>} byEngine
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
  const result = await db.query(`SELECT r.id, r.set_version, r.surface, s.id AS snapshot_id, s.engine, s.status, s.question_id,
      s.asked_at, coalesce(j.repeat_index, 0) AS repeat_index, coalesce(q.pool, g.pool) AS pool,
      f.snapshot_id IS NOT NULL AND (f.judged_at IS NOT NULL OR s.surface ->> 'mode' = 'inclusion') AS judged
    FROM evimed_geo.rounds r
      LEFT JOIN evimed_geo.snapshots s ON s.round_id = r.id AND s.geo_project_id = r.geo_project_id AND s.user_id = r.user_id
        AND NOT EXISTS (SELECT 1 FROM evimed_geo.probe_jobs skipped WHERE skipped.round_id = r.id AND skipped.engine = s.engine
          AND skipped.status = 'skipped' AND skipped.error_code IN ('engine_paused', 'engine_unavailable'))
      LEFT JOIN evimed_geo.questions q ON q.id = s.question_id AND q.geo_project_id = r.geo_project_id
      LEFT JOIN evimed_geo.question_groups g ON g.id = q.group_id AND g.geo_project_id = r.geo_project_id
      LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id
      LEFT JOIN evimed_geo.probe_jobs j ON j.id = s.probe_job_id
    WHERE r.id = ANY($1::text[]) ORDER BY r.id, s.asked_at, s.id`, [ids]);
  /** @type {Map<string, any[]>} */ const observations = new Map();
  for (const row of result.rows) {
    const id = String(row.id);
    if (!byRound.has(id)) byRound.set(id, { setVersion: row.set_version == null ? null : Number(row.set_version), pools: [], engines: [], questionIds: [], byEngine: {},
      surface: row.surface && typeof row.surface === "object" ? row.surface : null });
    if (!row.snapshot_id) continue;
    const members = observations.get(id) ?? [];
    members.push({ roundId: id, questionId: row.question_id, engine: row.engine, status: row.status, pool: row.pool,
      repeatIndex: Number(row.repeat_index), askedAt: row.asked_at?.toISOString?.() ?? row.asked_at, facts: row.judged ? {} : null });
    observations.set(id, members);
  }
  for (const [id, rows] of observations) {
    const coverage = byRound.get(id);
    if (!coverage) continue;
    const balance = balanceRows(rows);
    const eligible = (/** @type {any[]} */ members) => members.filter((row) => row.status === "refusal" || row.status === "valid" && row.facts);
    const selection = (/** @type {any[]} */ members) => ({ pools: [...new Set(members.map((row) => row.pool).filter(Boolean))].sort(),
      questionIds: [...new Set(members.map((row) => row.questionId).filter(Boolean))].sort() });
    const across = eligible(balance.rows);
    Object.assign(coverage, selection(across), { engines: [...new Set(across.map((row) => row.engine))].sort() });
    for (const engine of balance.engines) coverage.byEngine[engine] = selection(eligible(balance.deduped).filter((row) => row.engine === engine));
  }
  return byRound;
}

/**
 * The key of a reading of one round: of the whole round, or — for a reading that is one engine's — of that engine alone, since an
 * engine's rate does not depend on which other engines answered.
 * @param {RoundCoverage | undefined | null} coverage @param {{ engine?: string | null, methodVersion?: string | null }} [options]
 * @returns {string | null}
 */
export function coverageKeyOf(coverage, { engine = null, methodVersion = undefined } = {}) {
  if (!coverage) return null;
  const subset = engine ? coverage.byEngine[engine] : coverage;
  const engines = engine ? subset?.questionIds.length ? [engine] : [] : coverage.engines;
  const key = geoCoverageKey({ setVersion: coverage.setVersion, pools: subset?.pools ?? [], engines, surface: coverage.surface, methodVersion });
  if (!key || methodVersion == null) return key;
  const questions = createHash("sha256").update(JSON.stringify(subset?.questionIds ?? [])).digest("hex").slice(0, 24);
  return `${key};questions=${questions}`;
}
