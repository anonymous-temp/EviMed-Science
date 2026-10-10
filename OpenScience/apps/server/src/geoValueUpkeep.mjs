/**
 * 「循证 GEO」's upkeep of each project's value profile: the housekeeping that keeps what the profile accumulates bounded (G10c).
 *
 * A profile is written as a new version whenever its content really changes, and every version stores the whole merged profile,
 * so a project the research programme works on for months holds hundreds of copies. The owner ruled on 2026-10-10 which to keep:
 * the latest twenty, and the milestones — a version another stored object points to, and the first version of each calendar month.
 * Everything else is pruned.
 *
 * Hidden knowledge:
 *
 * - **A reference is a stored version number, and the list of them is one table.** `GEO_VALUE_REFERENCES` names every place the
 *   module records which version of the profile something stood on: a round's frozen evaluation basis, the version an answer was
 *   judged against, an article's basis, a research request and the research results the profile itself holds, and the value context
 *   a question group or a source may carry. The prune statement is built from that table, and a test reads the module's sources
 *   for the words that write such a number, so a new reference that is not in the table fails a test instead of losing a version.
 *   No card and no export records one today: a card names its claims and an export is a file in the workspace.
 * - **A pruned version is not read as an empty one.** The latest twenty are never pruned and the profile's readers ask for the
 *   latest, so the only read a prune can touch is the one that names an old version; it is answered plainly (`GeoService.valueOf`).
 * - **Bounded per tick, counted, and not done twice.** One tick deletes at most `OPEN_SCIENCE_GEO_VALUE_PRUNE_PER_TICK` versions in
 *   all, project by project. A project whose pass finished is not looked at again until it gets a new version: the milestones it
 *   keeps are what keep it over the limit, and nothing but a new version moves what the pass would decide. The statement that
 *   chooses the versions is the statement that deletes them, and it runs under the lock a write of the profile takes, so the
 *   latest versions it spares are the latest there are.
 * - **Calendar months are the module's time zone's** (`OPEN_SCIENCE_GEO_TIMEZONE`), like its weekly slot and its night window.
 *
 * @module geoValueUpkeep
 */

/** Where a stored object records which version of a project's value profile it stood on: its table and the JSON value that holds the number. */
export const GEO_VALUE_REFERENCES = Object.freeze([
  Object.freeze({ by: "a round's frozen evaluation basis", table: "rounds", value: "ref #> '{evaluationBasis,value,version}'" }),
  Object.freeze({ by: "the version an answer was judged against", table: "facts", value: "judge_extract -> 'valueBasisVersion'" }),
  Object.freeze({ by: "an article's basis", table: "articles", value: "value_context -> 'basisVersion'" }),
  Object.freeze({ by: "a question group's value context", table: "question_groups", value: "value_context -> 'basisVersion'" }),
  Object.freeze({ by: "a source's value context", table: "sources", value: "value_context -> 'basisVersion'" }),
  Object.freeze({ by: "a research request", table: "schedule_marks", value: "detail -> 'basisVersion'" }),
]);

/** The JSON value `value` as a number, or NULL where it is anything else. @param {string} value */
const numberOf = (value) => `CASE WHEN jsonb_typeof(${value}) = 'number' THEN (${value})::text::numeric END`;

/**
 * Every version number a stored object of the project points to: the table above, and the research results the latest profile holds
 * (a result carries the version its request was made on). $1 is the project.
 */
const POINTED = [
  ...GEO_VALUE_REFERENCES.map((reference) => `SELECT ${numberOf(reference.value)} AS v FROM evimed_geo.${reference.table} WHERE geo_project_id = $1`),
  `SELECT ${numberOf("entry -> 'basisVersion'")} AS v FROM evimed_geo.value_profiles latest
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(latest.data -> 'researchResults') = 'array' THEN latest.data -> 'researchResults' ELSE '[]'::jsonb END) entry
    WHERE latest.geo_project_id = $1 AND latest.version = (SELECT max(version) FROM evimed_geo.value_profiles WHERE geo_project_id = $1) AND jsonb_typeof(entry) = 'object'`,
].join("\n      UNION ALL ");

/**
 * The versions of a project's profile that are not kept — not among the latest `$2`, not the first of their calendar month in the
 * zone `$3`, not pointed to — oldest first, at most `$4`, deleted and returned in one statement.
 */
const PRUNE = `WITH pointed AS MATERIALIZED (
      ${POINTED}
    ), doomed AS (
      SELECT p.version FROM evimed_geo.value_profiles p
      WHERE p.geo_project_id = $1
        AND p.version NOT IN (SELECT version FROM evimed_geo.value_profiles WHERE geo_project_id = $1 ORDER BY version DESC LIMIT $2)
        AND p.version NOT IN (SELECT DISTINCT ON (date_trunc('month', created_at AT TIME ZONE $3)) version FROM evimed_geo.value_profiles
          WHERE geo_project_id = $1 ORDER BY date_trunc('month', created_at AT TIME ZONE $3), version)
        AND NOT EXISTS (SELECT 1 FROM pointed WHERE pointed.v = p.version)
      ORDER BY p.version LIMIT $4
    )
    DELETE FROM evimed_geo.value_profiles WHERE geo_project_id = $1 AND version IN (SELECT version FROM doomed) RETURNING version`;

/**
 * Prune one project's profile: the versions that are neither recent, nor a calendar month's first, nor pointed to. Takes the lock a
 * write of the profile takes (`writeGeoValue`), so a version cannot be written between choosing and deleting.
 * @param {{ transaction: (work: (client: any) => Promise<any>) => Promise<any> }} store
 * @param {string} geoId @param {{ keep: number, limit: number, timeZone: string }} options
 * @returns {Promise<number[]>} the versions deleted, oldest first
 */
export async function pruneGeoValueProfiles(store, geoId, { keep, limit, timeZone }) {
  return store.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-geo-value:' || $1))", [geoId]);
    const deleted = await client.query(PRUNE, [geoId, keep, timeZone, limit]);
    return deleted.rows.map((/** @type {any} */ row) => Number(row.version)).sort((left, right) => left - right);
  });
}

/** @param {unknown} error */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "geo_value_upkeep_failed");

/**
 * The upkeep as one worker loop: a tick prunes. Each pass is isolated — one that throws is counted and reported and does not stop the next.
 * @param {{ store: any, config?: Record<string, any>, report?: (code: string) => void }} dependencies
 */
export function createGeoValueUpkeep({ store, config = {}, report = () => {} }) {
  if (!store) throw new TypeError("The value upkeep needs the GEO store.");
  const keep = Number.isSafeInteger(config.geoValueKeepVersions) && config.geoValueKeepVersions >= 1 ? config.geoValueKeepVersions : 20;
  const perTick = Number.isSafeInteger(config.geoValuePrunePerTick) && config.geoValuePrunePerTick >= 1 ? config.geoValuePrunePerTick : 200;
  const timeZone = String(config.geoTimeZone || "Asia/Shanghai");
  const counters = { ticks: 0, projectsChecked: 0, versionsPruned: 0, projectsPruned: 0, failures: 0 };
  /** The newest version of each project a finished pass looked at: nothing it would decide moves until the project gets another. @type {Map<string, number>} */
  const settled = new Map();

  /** One pass over the projects with more versions than the limit, within the tick's bound. */
  async function prune() {
    const over = (await store.query(`SELECT geo_project_id AS id, max(version)::integer AS latest FROM evimed_geo.value_profiles
      GROUP BY geo_project_id HAVING count(*) > $1 ORDER BY geo_project_id`, [keep])).rows;
    const counts = { checked: 0, pruned: 0, projects: 0 };
    let left = perTick;
    for (const row of over) {
      if (left <= 0) break;
      const id = String(row.id);
      if (settled.get(id) === Number(row.latest)) continue;
      counts.checked += 1;
      const asked = left;
      const removed = await pruneGeoValueProfiles(store, id, { keep, limit: asked, timeZone });
      left -= removed.length;
      counts.pruned += removed.length;
      if (removed.length) counts.projects += 1;
      // Fewer than asked for: nothing more is prunable at this version. As many as asked for: there may be more, and the next tick looks again.
      if (removed.length < asked) settled.set(id, Number(row.latest));
    }
    counters.projectsChecked += counts.checked;
    counters.versionsPruned += counts.pruned;
    counters.projectsPruned += counts.projects;
    return counts;
  }

  return {
    counters,
    /** What the worker's status carries of the last tick, and what the metrics count. */
    async tick() {
      counters.ticks += 1;
      /** @type {{ checked: number, pruned: number, projects: number }} */
      let pruned = { checked: 0, pruned: 0, projects: 0 };
      try { pruned = await prune(); }
      catch (error) { counters.failures += 1; report(`prune:${codeOf(error)}`); }
      return { projectsChecked: pruned.checked, versionsPruned: pruned.pruned, projectsPruned: pruned.projects };
    },
    metrics() {
      return { ...counters };
    },
  };
}
