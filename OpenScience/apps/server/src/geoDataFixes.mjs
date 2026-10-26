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
 *  4. **Materials**: a content batch's correction articles attached to the
 *     error it was given, which moves to 处置中 (G7) — only where the pairing
 *     is certain, a batch given one error. A batch given several errors never
 *     pairs its corrections by itself: each names the errors it corrects
 *     (`errorIds`) when it is registered. Until 2026-10-25 this step paired
 *     every correction of a batch with every error of it, so an error of a
 *     five-error batch held all five corrections (production: the two batches
 *     of 2026-09-25, attached by the 09-26 run). Such cross-attached errors
 *     are reported; with `correctionPairs` (which correction answers which
 *     error, read off the articles and the errors by a person or a model) the
 *     corrections of that batch not paired with an error are detached, and an
 *     error left with no correction goes back from 处置中 to 待处理.
 *  5. **Collected**: a real phrasing without its day is dated to when its
 *     question set was first written (G9).
 *  6. **Recount and re-measure** (G2): every stored answer counted again under
 *     the registry as it now stands — no model asked — and every measured
 *     round of the project re-measured, in the order they finished, with the
 *     headline numbers before and after. A round that heard no answer is not
 *     measured, and the empty cells the metrics loop wrote for such rounds
 *     before 2026-10-25 (209 a day for a sentinel whose engines were all
 *     paused) are removed: they are derived, all without a value, and the
 *     loop no longer writes them.
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
import { migrateGeo } from "./geoPersistence.mjs";
import { GEO_METRIC_ROUND_KINDS, measureRound } from "./geoMetricsJob.mjs";
import { GeoStore, geoProjectFromRow, mergedExpectations } from "./geoStore.mjs";
import { GEO_WRITE_LIMITS, geoRuntimeWrite, geoStrategyDraft, geoStrategyWriteOfFile } from "./geoWrites.mjs";

/** The two domains ruled not ours on 2026-09-26 (the owner: Lilly holds a competitor). */
export const GEO_NOT_OWNED_DOMAINS = Object.freeze(["lillymedical.cn", "lm.qa.lilly.cn"]);
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

/**
 * Stores whose migration the caller ran already, outside the fix's
 * transaction: `ready()` answers with that migration's own result instead of
 * running it again on the transaction's client.
 */
class MigratedGeoStore extends GeoStore {
  /** @param {ConstructorParameters<typeof GeoStore>[0]} options @param {Awaited<ReturnType<GeoStore["ready"]>>} migrated */
  constructor(options, migrated) {
    super(options);
    this.migrated = migrated;
  }

  async ready() { return this.migrated; }
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
 * @property {Array<{ errorId: string, articleId: string }> | null} [correctionPairs]  which correction answers which error, for the
 *   cross-attached errors of a several-error batch
 * @property {boolean} [collected]
 * @property {() => Date} [now]
 */

/**
 * Run the fixes for one GEO project. Returns what was (or, without `apply`,
 * would be) changed, and the headline numbers before and after.
 * @param {GeoDataFixOptions} options
 */
export async function runGeoDataFixes({ database, geoProjectId, apply = false, disown = [...GEO_NOT_OWNED_DOMAINS], ourSingleSource = null, ourGenericAliases = [],
  competitorSingleSource = {}, strategy = null, materials = true, correctionPairs = null, collected = true, now = () => new Date() }) {
  // Migrated once, committed, outside the fix (the server does the same at boot).
  await new GeoMeasureStore(database).ready();
  const migrated = await migrateGeo(database);
  return inOneTransaction(database, async (db) => {
    const store = new MigratedGeoStore({ database: db, statementTimeoutMs: 60_000 }, migrated);
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
      // The file's parts under the names the write reads (`geoStrategyWriteOfFile`: the layout and the source table sit under `sources`).
      const { sources: fileSources, ...data } = geoStrategyWriteOfFile(strategy);
      const sources = Array.isArray(fileSources) ? fileSources : [];
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

    // 4. A content batch's corrections, attached to the error it was given — where that is certain — and the corrections an
    //    error of a several-error batch holds from that batch beyond its own, detached by the pairs given.
    if (materials) {
      const batches = (await db.query(`SELECT m.key, m.run_id, m.detail -> 'errorIds' AS error_ids,
          coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'path', a.path, 'layer', a.layer, 'title', a.title, 'withdrawn', a.status = 'withdrawn')
            ORDER BY a.created_at, a.id) FROM evimed_geo.articles a
            WHERE a.geo_project_id = m.geo_project_id AND a.run_id = m.run_id AND a.layer = 'correction'), '[]'::jsonb) AS articles
        FROM evimed_geo.schedule_marks m
        WHERE m.geo_project_id = $1 AND m.kind = 'run' AND starts_with(m.key, 'run:content:') AND m.run_id IS NOT NULL
          AND jsonb_typeof(m.detail -> 'errorIds') = 'array'
        ORDER BY m.key`, [geoProjectId])).rows;
      /** @type {Map<string, Set<string>>} */
      const paired = new Map();
      for (const pair of Array.isArray(correctionPairs) ? correctionPairs : []) {
        if (typeof pair?.errorId !== "string" || typeof pair?.articleId !== "string") continue;
        paired.set(pair.errorId, new Set([...(paired.get(pair.errorId) ?? []), pair.articleId]));
      }
      /** @type {Set<string>} */
      const acting = new Set();
      let pairs = 0;
      let attached = 0;
      /** @type {string[]} */
      const crossAttached = [];
      /** @type {string[]} */
      const unlisted = [];
      let detached = 0;
      let reopened = 0;
      for (const batch of batches) {
        const errorIds = [...new Set((/** @type {unknown[]} */ (batch.error_ids)).filter((id) => typeof id === "string").map(String))];
        const articles = /** @type {Array<{ id: string, path: string | null, layer: string, title: string | null, withdrawn: boolean }>} */ (batch.articles);
        if (errorIds.length === 1) {
          for (const article of articles.filter((entry) => !entry.withdrawn)) {
            pairs += 1;
            const moved = await store.attachCorrection(geoProjectId, errorIds, {
              articleId: article.id, path: String(article.path ?? ""), layer: article.layer, title: article.title ?? null, runId: batch.run_id ?? null,
            });
            attached += moved.length;
            for (const id of moved) acting.add(id);
          }
          continue;
        }
        const ofBatch = new Set(articles.map((article) => article.id));
        for (const errorId of errorIds) {
          const errorRow = (await db.query(`SELECT status, materials FROM evimed_geo.errors WHERE geo_project_id = $1 AND id = $2`, [geoProjectId, errorId])).rows[0];
          if (!errorRow) continue;
          const held = (Array.isArray(errorRow.materials) ? errorRow.materials : []).filter((entry) => ofBatch.has(String(entry?.articleId ?? "")));
          if (held.length <= 1) continue;
          crossAttached.push(errorId);
          const keep = paired.get(errorId);
          if (!keep) { unlisted.push(errorId); continue; }
          const materialsLeft = (Array.isArray(errorRow.materials) ? errorRow.materials : [])
            .filter((entry) => !ofBatch.has(String(entry?.articleId ?? "")) || keep.has(String(entry.articleId)));
          const hasCorrection = materialsLeft.some((entry) => entry?.kind === "article");
          const status = errorRow.status === "acting" && !hasCorrection ? "open" : errorRow.status;
          await db.query(`UPDATE evimed_geo.errors SET materials = $3::jsonb, status = $4, updated_at = now() WHERE geo_project_id = $1 AND id = $2`,
            [geoProjectId, errorId, JSON.stringify(materialsLeft), status]);
          detached += (Array.isArray(errorRow.materials) ? errorRow.materials.length : 0) - materialsLeft.length;
          if (status !== errorRow.status) reopened += 1;
        }
      }
      report.materials = { pairs, attached, errors: acting.size, crossAttached: crossAttached.length, detached, reopened, unlisted };
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
    const answered = `EXISTS (SELECT 1 FROM evimed_geo.snapshots s WHERE s.round_id = r.id AND s.status IN ('valid', 'refusal'))`;
    const rounds = (await db.query(`SELECT r.id FROM evimed_geo.rounds r WHERE r.geo_project_id = $1 AND r.kind = ANY($2::text[]) AND r.status IN ('done', 'partial')
      AND ${answered} ORDER BY r.finished_at NULLS LAST, r.created_at`, [geoProjectId, [...GEO_METRIC_ROUND_KINDS]])).rows.map((/** @type {any} */ entry) => String(entry.id));
    for (const roundId of rounds) await measureRound({ store: measure, now }, roundId);
    const cleared = (await db.query(`DELETE FROM evimed_geo.metrics m USING evimed_geo.rounds r WHERE m.round_id = r.id AND r.geo_project_id = $1
      AND m.geo_project_id = $1 AND r.status IN ('done', 'partial') AND NOT ${answered} RETURNING m.round_id`, [geoProjectId])).rows;
    report.emptyRounds = { rounds: new Set(cleared.map((/** @type {any} */ entry) => String(entry.round_id))).size, cells: cleared.length };
    const contextAfter = await measure.projectContext(geoProjectId);
    report.registryAfter = contextAfter ? registryKey(brandRegistry(contextAfter.project.product, contextAfter.project.competitors), contextAfter.owned) : null;
    report.recounted = recount.facts;
    report.remeasured = rounds.length;
    report.after = await headline(db, geoProjectId);
    return report;
  }, { commit: apply });
}
