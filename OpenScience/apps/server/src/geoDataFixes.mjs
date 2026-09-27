/**
 * The one-off corrections of a GEO project's data after the 2026-09-26 audit,
 * as one transaction an operator runs on the host
 * (`scripts/ops/geo-data-fixes.mjs`): dry run by default — everything is done
 * and then rolled back, so the report shows exactly what `--apply` would
 * write — and idempotent, so a second `--apply` changes nothing.
 *
 * In order, each optional but the recount:
 *
 *  1. **Disown** domains recorded as ours that are not (G22: `lillymedical.cn`
 *     and `lm.qa.lilly.cn` — Lilly co-developed 玛仕度肽 but holds the rival
 *     穆峰达): their layer is cleared, so they leave the citation family's
 *     numerator.
 *  2. **Identity**: whether our generic, and each named rival's, is
 *     single-source (G5) — the one fact the symmetric counting rule needs.
 *  3. **Strategy** from the run's own `strategy.json` (G4): the fields the
 *     platform used to drop, written once through `geo_write` (merge-forward,
 *     sources in pages of the write's limit).
 *  4. **Materials**: the correction articles each content batch wrote, attached
 *     to the errors that batch was given, which move to 处置中 (G7).
 *  5. **Collected**: a real phrasing without its day is dated to when its
 *     question set was first written (G9).
 *  6. **Recount and re-measure** (G2): every stored answer counted again under
 *     the registry as it now stands — no model asked — and every measured
 *     round of the project re-measured, in the order they finished, with the
 *     headline numbers before and after.
 *
 * Runs against the tables the running server migrated; it migrates first
 * outside its transaction (a DDL lock held for the length of the fix would
 * hold every GEO page with it).
 *
 * @module geoDataFixes
 */

import { brandRegistry, registryKey } from "./geoParse.mjs";
import { recountRegistryFacts } from "./geoJudge.mjs";
import { GeoMeasureStore } from "./geoMeasureStore.mjs";
import { GEO_METRIC_ROUND_KINDS, measureRound } from "./geoMetricsJob.mjs";
import { GeoStore, geoProjectFromRow, mergedExpectations } from "./geoStore.mjs";
import { GEO_WRITE_LIMITS, geoRuntimeWrite, geoStrategyDraft } from "./geoWrites.mjs";

/** The two domains ruled not ours on 2026-09-26 (the owner: Lilly holds a competitor). */
export const GEO_NOT_OWNED_DOMAINS = Object.freeze(["lillymedical.cn", "lm.qa.lilly.cn"]);
/** What a strategy write carries, out of the run's `strategy.json`. */
const STRATEGY_FIELDS = Object.freeze(["battlefield", "secondary", "expectations", "gaps", "layout", "summary"]);
/** The numbers the report states before and after, per full measurement. */
const HEADLINE = Object.freeze(["M-19", "M-01S", "M-06", "M-08", "M-08S"]);

/** A value as text with its keys in order, so a jsonb read back compares equal to what was written. @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => /** @type {any} */ (value)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(/** @type {any} */ (value)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A store whose migration the caller ran already, outside the fix's transaction. */
class MigratedGeoStore extends GeoStore {
  async ready() { return true; }
}
class MigratedMeasureStore extends GeoMeasureStore {
  async ready() { return true; }
}

/**
 * The database as one open transaction: every query of the fix on one client,
 * every inner transaction a savepoint, committed only when `commit`.
 * @template T @param {any} database @param {(db: any) => Promise<T>} work @param {{ commit: boolean }} options
 */
async function inOneTransaction(database, work, { commit }) {
  return database.withClient(async (/** @type {any} */ client) => {
    await client.query("BEGIN");
    let savepoints = 0;
    const db = {
      query: (/** @type {string} */ text, /** @type {unknown[]} */ values = []) => client.query(text, values),
      withClient: (/** @type {(client: any) => Promise<any>} */ operation) => operation(client),
      async transaction(/** @type {(client: any) => Promise<any>} */ operation) {
        const name = `geo_fix_${++savepoints}`;
        await client.query(`SAVEPOINT ${name}`);
        try {
          const out = await operation(client);
          await client.query(`RELEASE SAVEPOINT ${name}`);
          return out;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          throw error;
        }
      },
    };
    try {
      const out = await work(db);
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      return out;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

/**
 * The headline cells of each full measurement of a project, oldest first.
 * @param {any} db @param {string} geoProjectId
 */
async function headline(db, geoProjectId) {
  const rows = (await db.query(`SELECT r.id AS round_id, r.kind, r.sample_date::text AS day, m.metric_id, m.value::float8 AS value, m.status, m.reason,
      m.numerator::float8 AS numerator, m.denominator::float8 AS denominator
    FROM evimed_geo.rounds r LEFT JOIN evimed_geo.metrics m ON m.round_id = r.id AND m.scope = 'project' AND m.metric_id = ANY($2::text[])
      AND m.variant IS NULL AND m.rival IS NULL AND m.pool IS NULL AND m.arm IS NULL AND m.group_id IS NULL
    WHERE r.geo_project_id = $1 AND r.kind IN ('baseline', 'weekly', 'single_step') AND r.status IN ('done', 'partial')
    ORDER BY r.finished_at NULLS LAST, r.created_at, m.metric_id`, [geoProjectId, [...HEADLINE]])).rows;
  const rivals = (await db.query(`SELECT round_id, count(DISTINCT rival)::integer AS n FROM evimed_geo.metrics WHERE geo_project_id = $1 AND metric_id = 'M-16'
    AND rival IS NOT NULL AND status = 'ok' GROUP BY round_id`, [geoProjectId])).rows;
  /** @type {Map<string, Record<string, any>>} */
  const byRound = new Map();
  for (const row of rows) {
    const entry = byRound.get(row.round_id) ?? { round: row.round_id, kind: row.kind, day: row.day, rivalsMeasured: 0 };
    if (row.metric_id) entry[row.metric_id] = row.status === "ok" ? row.value : `${row.status}${row.reason ? `:${row.reason}` : ""}`;
    byRound.set(row.round_id, entry);
  }
  for (const row of rivals) if (byRound.has(row.round_id)) /** @type {any} */ (byRound.get(row.round_id)).rivalsMeasured = Number(row.n);
  return [...byRound.values()];
}

/**
 * @typedef {object} GeoDataFixOptions
 * @property {any} database            the control-plane database (a ControlPlaneDatabase)
 * @property {string} geoProjectId
 * @property {boolean} [apply]         commit; the default rolls everything back
 * @property {string[]} [disown]       domains that are not ours (default: the 2026-09-26 ruling's two)
 * @property {boolean | null} [ourSingleSource]
 * @property {string[]} [ourGenericAliases]   the generic as answers write it, counted when single-source
 * @property {Record<string, boolean>} [competitorSingleSource]  by brand or generic name
 * @property {Record<string, any> | null} [strategy]  the run's parsed strategy.json
 * @property {boolean} [materials]
 * @property {boolean} [collected]
 * @property {() => Date} [now]
 */

/**
 * Run the fixes for one GEO project. Returns what was (or, without `apply`,
 * would be) changed, and the headline numbers before and after.
 * @param {GeoDataFixOptions} options
 */
export async function runGeoDataFixes({ database, geoProjectId, apply = false, disown = [...GEO_NOT_OWNED_DOMAINS], ourSingleSource = null, ourGenericAliases = [],
  competitorSingleSource = {}, strategy = null, materials = true, collected = true, now = () => new Date() }) {
  // Migrated once, committed, outside the fix (the server does the same at boot).
  await new GeoMeasureStore(database).ready();
  return inOneTransaction(database, async (db) => {
    const store = new MigratedGeoStore({ database: db, statementTimeoutMs: 60_000 });
    const measure = new MigratedMeasureStore(db);
    const row = (await db.query(`SELECT * FROM evimed_geo.projects WHERE id = $1 AND deleted_at IS NULL`, [geoProjectId])).rows[0];
    if (!row) throw Object.assign(new Error(`GEO project ${geoProjectId} not found.`), { code: "geo_project_not_found" });
    let project = geoProjectFromRow(row);
    /** @type {Record<string, any>} */
    const report = { applied: apply, geoProjectId, before: await headline(db, geoProjectId) };
    const contextBefore = await measure.projectContext(geoProjectId);
    report.registryBefore = contextBefore ? registryKey(brandRegistry(contextBefore.project.product, contextBefore.project.competitors), contextBefore.owned) : null;

    // 1. Domains recorded as ours that are not.
    const suffixes = disown.map((domain) => `%.${domain.toLowerCase()}`);
    report.disowned = (await db.query(`UPDATE evimed_geo.sources SET layer = NULL, updated_at = now()
      WHERE geo_project_id = $1 AND layer = 'owned' AND (lower(domain) = ANY($2::text[]) OR lower(domain) LIKE ANY($3::text[]))
      RETURNING domain`, [geoProjectId, disown.map((domain) => domain.toLowerCase()), suffixes])).rows.map((/** @type {any} */ entry) => String(entry.domain)).sort();

    // 2. Whether each generic is one holder's.
    /** @type {string[]} */
    const identity = [];
    const product = { ...project.product };
    if (typeof ourSingleSource === "boolean" && product.singleSource !== ourSingleSource) {
      product.singleSource = ourSingleSource;
      identity.push(`ours:${ourSingleSource}`);
    }
    // The generic as answers write it (「玛仕度肽」 for 「玛仕度肽注射液」): named,
    // never derived from the registered name's shape.
    const known = new Set(Array.isArray(product.genericAliases) ? product.genericAliases.map(String) : []);
    const added = ourGenericAliases.map((name) => name.trim()).filter((name) => name && !known.has(name));
    if (added.length) {
      product.genericAliases = [...known, ...new Set(added)];
      identity.push(...[...new Set(added)].map((name) => `ours:genericAlias:${name}`));
    }
    const competitors = project.competitors.map((competitor) => {
      const name = [competitor?.brandName, competitor?.genericName].find((value) => typeof value === "string" && value in competitorSingleSource);
      if (!name || competitor.singleSource === competitorSingleSource[name]) return competitor;
      identity.push(`${name}:${competitorSingleSource[name]}`);
      return { ...competitor, singleSource: competitorSingleSource[name] };
    });
    const unmatched = Object.keys(competitorSingleSource).filter((name) => !project.competitors.some((entry) => entry?.brandName === name || entry?.genericName === name));
    if (identity.length) project = /** @type {any} */ (await store.updateProject(project.userId, project.id, { product, competitors })) ?? project;
    report.identity = { changed: identity, unmatchedCompetitors: unmatched };

    // 3. The strategy the run wrote in its own file.
    if (strategy && typeof strategy === "object") {
      const data = Object.fromEntries(STRATEGY_FIELDS.filter((field) => strategy[field] != null).map((field) => [field, strategy[field]]));
      const sources = Array.isArray(strategy.sources) ? strategy.sources : [];
      const draft = geoStrategyDraft({ ...data, sources });
      // Idempotent: a strategy the latest version already says is not written again.
      const latest = await store.latestStrategy(project.id);
      const same = Object.entries(draft.strategy).every(([field, value]) => canonical(field === "expectations"
        ? mergedExpectations(latest?.expectations ?? null, value) : value) === canonical(/** @type {any} */ (latest)?.[field] ?? null));
      const written = Object.keys(draft.strategy).length && !same ? await geoRuntimeWrite({ store, project, what: "strategy", body: { data } }) : null;
      let sourcesWritten = 0;
      /** @type {any[]} */
      const sourceIssues = [];
      for (let offset = 0; offset < sources.length; offset += GEO_WRITE_LIMITS.sources) {
        const page = await geoRuntimeWrite({ store, project, what: "sources", body: { items: sources.slice(offset, offset + GEO_WRITE_LIMITS.sources) } });
        sourcesWritten += page.ids.length;
        sourceIssues.push(...page.issues.filter((issue) => issue.code !== "notice").map((issue) => ({ ...issue, index: (issue.index ?? 0) + offset })));
      }
      report.strategy = {
        version: written?.version ?? null, unchanged: same, fields: Object.keys(draft.strategy),
        expectations: Array.isArray(draft.strategy.expectations) ? draft.strategy.expectations.length : 0,
        sourcesGiven: sources.length, sourcesWritten,
        sourcesWithConditions: draft.sources.filter((source) => [source.icpMatches, source.newsIndexed, source.medicalVertical].some((value) => typeof value === "boolean")).length,
        refused: [...(written?.issues ?? []).filter((/** @type {any} */ issue) => issue.code !== "notice"), ...sourceIssues].slice(0, 40)
          .map((/** @type {any} */ issue) => `${issue.field ?? ""}:${issue.code}`),
      };
    }

    // 4. Each content batch's corrections, attached to the errors it was given.
    if (materials) {
      const pairs = (await db.query(`SELECT a.id AS article_id, a.path, a.layer, a.title, a.run_id, e.error_id
        FROM evimed_geo.schedule_marks m
          CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.detail -> 'errorIds') = 'array' THEN m.detail -> 'errorIds' ELSE '[]'::jsonb END) AS e(error_id)
          JOIN evimed_geo.articles a ON a.geo_project_id = m.geo_project_id AND a.run_id = m.run_id AND a.layer = 'correction' AND a.status <> 'withdrawn'
        WHERE m.geo_project_id = $1 AND m.kind = 'run' AND starts_with(m.key, 'run:content:') AND m.run_id IS NOT NULL
        ORDER BY a.created_at, e.error_id`, [geoProjectId])).rows;
      /** @type {Set<string>} */
      const acting = new Set();
      let attached = 0;
      for (const pair of pairs) {
        const moved = await store.attachCorrection(geoProjectId, [String(pair.error_id)], {
          articleId: String(pair.article_id), path: String(pair.path ?? ""), layer: String(pair.layer), title: pair.title ?? null, runId: pair.run_id ?? null,
        });
        attached += moved.length;
        for (const id of moved) acting.add(id);
      }
      report.materials = { pairs: pairs.length, attached, errors: acting.size };
    }

    // 5. A real phrasing's day, where the run wrote none.
    if (collected) {
      report.collected = (await db.query(`UPDATE evimed_geo.questions q SET collected_at = first.at
        FROM (SELECT q2.id, (SELECT min(s.created_at) FROM evimed_geo.questions q3 JOIN evimed_geo.question_sets s
              ON s.geo_project_id = q3.geo_project_id AND s.version = q3.set_version
            WHERE q3.geo_project_id = q2.geo_project_id AND q3.text = q2.text) AS at
          FROM evimed_geo.questions q2 WHERE q2.geo_project_id = $1 AND q2.kind = 'real' AND q2.collected_at IS NULL) first
        WHERE q.id = first.id AND first.at IS NOT NULL RETURNING q.id`, [geoProjectId])).rows.length;
    }

    // 6. Every stored answer counted again under the registry as it now stands, every round measured again.
    const recount = await recountRegistryFacts({ store: measure, config: {}, now, force: true, geoProjectIds: [geoProjectId],
      state: /** @type {any} */ ({ recountAt: 0 }) });
    const rounds = (await db.query(`SELECT id FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind = ANY($2::text[]) AND status IN ('done', 'partial')
      ORDER BY finished_at NULLS LAST, created_at`, [geoProjectId, [...GEO_METRIC_ROUND_KINDS]])).rows.map((/** @type {any} */ entry) => String(entry.id));
    for (const roundId of rounds) await measureRound({ store: measure, now }, roundId);
    const contextAfter = await measure.projectContext(geoProjectId);
    report.registryAfter = contextAfter ? registryKey(brandRegistry(contextAfter.project.product, contextAfter.project.competitors), contextAfter.owned) : null;
    report.recounted = recount.facts;
    report.remeasured = rounds.length;
    report.after = await headline(db, geoProjectId);
    return report;
  }, { commit: apply });
}
