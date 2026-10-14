/**
 * The question group as the spine of a 「循证 GEO」 project: what each group is, what the engines say about it, what is being done
 * for it and what came of it — read from the tables that already hold every part (rectification 2026-10-14, plan §4 item 1).
 *
 * Hidden knowledge:
 *
 * - **Nothing here is computed that the domain computes.** The rules — a group's reading is k of n and never a rate under the
 *   floor, the target is the chosen tier's row for the pool, a control group has no action, the status is the furthest stage
 *   reached, a placement is stale at eight weeks — are `@evimed/domain`'s `geoActions` (`deriveGeoActions`); this module reads
 *   the rows those functions take, and shapes what they return for the page and for `geo_read`. The page's route and the
 *   runtime's read call the same method and so reach the same verdicts (`geoActionsSingleImplementation.test.mjs`).
 * - **Group-scope metric rows are read here and nowhere else on a page.** The overview, 可见度 and 准确与安全 read project, pool
 *   and engine scope (`PLAIN_ROW` excludes the group rows); a group's own rows — written every round, and the orchestrator
 *   chooses its batches by them — are this module's. A group has no engine-scope row: its per-engine counts are the answers of
 *   the latest full round, counted as facts (`mentioned`, `wrong` of `answered`), never presented as a metric.
 * - **A group keeps its name across question-set versions and changes its id.** Everything that names a group by an id of an
 *   earlier version (a gap, an article, an error's question) is found under the current group through its name and pool.
 * - **Two groups that share a name** are not aliased (the name stands for neither); an id nothing answers for is a group the
 *   views do not show.
 *
 * @module geoSpine
 */

import {
  GEO_ACTION_READ_METRICS, GEO_ENGINES, GEO_MIN_CELL_SAMPLES, GEO_STEPS, GEO_TIERS, GEO_URGENT_SEVERITIES, GEO_VIEW_METRIC_IDS, deriveGeoActions, geoGroupReading, geoMetricName,
  geoMetricUnit, geoNeedsYou, geoStepSummary, geoTextKey, parseGeoActionKey,
} from "@evimed/domain";
import { coverageKeyOf, roundCoverages } from "./geoCoverage.mjs";
import { ORDER_SELECT, mapOrder } from "./geoMarketStore.mjs";
import { roundAnswers, tallySources } from "./geoSourceAnswers.mjs";

/** The rounds that measure the whole question set. */
const HEADLINE_KINDS = Object.freeze(["baseline", "weekly", "single_step"]);
/** The rounds a group's series is drawn from: the full ones, and the checks after a publication (flagged by their kind). */
const SERIES_KINDS = Object.freeze([...HEADLINE_KINDS, "post_publication"]);
/** The most sources one group lists. */
const TOP_SOURCES = 5;
/** The most real phrasings one group row lists. */
const REAL_PHRASINGS_SHOWN = 3;

/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());
/** @param {unknown} value */
const num = (value) => (value == null ? null : Number(value));
/** @param {unknown} value */
const text = (value) => (typeof value === "string" && value.trim() ? value : null);
/** What the store mints for a question group's id: a format, not language. */
const GROUP_ID_SHAPE = /^ggr_[0-9a-f]+$/i;

/**
 * A metric row as the pages' cell: the numbers with their numerator, denominator, interval, status and data type. A cell no row speaks
 * for is `absent` (「未测」), never zero.
 * @param {any} row
 */
function cellOf(row) {
  if (!row) return { value: null, numerator: null, denominator: null, ciLow: null, ciHigh: null, status: "absent", dataType: "measured", reason: null };
  return { value: num(row.value), numerator: num(row.numerator), denominator: num(row.denominator), ciLow: num(row.ci_low), ciHigh: num(row.ci_high),
    status: String(row.status), dataType: String(row.data_type ?? "measured"), reason: text(row.reason) };
}

/**
 * The open errors of a spine, counted by group (current ids).
 * @param {Array<Record<string, any>>} errors
 */
function errorCountsOf(errors) {
  /** @type {Map<string, { open: number, severe: number, total: number }>} */
  const byGroup = new Map();
  for (const error of errors) {
    const key = String(error.groupId ?? "");
    if (!key) continue;
    const entry = byGroup.get(key) ?? { open: 0, severe: 0, total: 0 };
    entry.total += 1;
    if (error.status !== "closed") {
      entry.open += 1;
      if (GEO_URGENT_SEVERITIES.includes(error.severity)) entry.severe += 1;
    }
    byGroup.set(key, entry);
  }
  return byGroup;
}

export class GeoSpine {
  /**
   * @param {{ store: import("./geoStore.mjs").GeoStore, now?: () => Date, marketConfigured?: () => boolean,
   *   placementPreview?: ((input: { project: any, groups: any[], candidates: Map<string, Array<Record<string, any>>>, choices: any[] }) =>
   *     Promise<Map<string, Array<Record<string, any>>>>) | null }} options
   *   `placementPreview` is the market's read-only ranking of the outlets an article of the group could go to (`geoMarket.mjs`
   *   `previewOutlets`): the same function the market places by, and nothing is ordered by asking.
   */
  constructor({ store, now = () => new Date(), marketConfigured = () => false, placementPreview = null }) {
    this.store = store;
    this.now = now;
    this.marketConfigured = marketConfigured;
    this.placementPreview = placementPreview;
  }

  /** @param {string} sql @param {unknown[]} [values] */
  #query(sql, values = []) { return this.store.query(sql, values); }

  /**
   * Everything the views read, once.
   * @param {{ id: string, userId: string, tier: string, engines: string[], steps?: any, budget?: any }} project
   */
  async load(project) {
    const geoId = project.id;
    const sets = await this.store.questionSets(geoId);
    const version = sets[0]?.version ?? null;
    const current = version == null ? [] : await this.store.questionMap(geoId, version);
    const everyGroup = (await this.#query(`SELECT id, name, pool, set_version FROM evimed_geo.question_groups WHERE geo_project_id = $1`, [geoId])).rows;
    // A group keeps its name and its pool across versions and changes its id: the current group of an older id.
    /** @type {Map<string, string[]>} */
    const aliases = new Map();
    /** @type {Map<string, string>} */
    const currentOf = new Map(current.map((group) => [group.id, group.id]));
    const byNamePool = new Map();
    for (const group of current) {
      const key = `${group.name ?? ""}\u0000${group.pool ?? ""}`;
      byNamePool.set(key, byNamePool.has(key) ? null : group);
    }
    for (const row of everyGroup) {
      if (currentOf.has(String(row.id))) continue;
      const match = byNamePool.get(`${row.name ?? ""}\u0000${row.pool ?? ""}`);
      if (!match) continue;
      currentOf.set(String(row.id), match.id);
      aliases.set(match.id, [...(aliases.get(match.id) ?? []), String(row.id)]);
    }
    const groups = current.map((group) => ({ ...group, aliasIds: aliases.get(group.id) ?? [] }));
    /** @type {Map<string, string | null>} */
    const groupNames = new Map(everyGroup.map((row) => [String(row.id), text(row.name)]));

    const [strategy, targets, headline, baseline] = await Promise.all([
      this.store.latestStrategy(geoId),
      this.store.latestTargets(geoId),
      this.#query(`SELECT id, kind, set_version, sample_date::text AS day, finished_at FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind = ANY($2::text[])
        AND status IN ('done', 'partial') ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 1`, [geoId, [...HEADLINE_KINDS]]),
      this.#query(`SELECT id, kind, set_version, sample_date::text AS day, finished_at FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind IN ('baseline', 'single_step')
        AND status IN ('done', 'partial') ORDER BY finished_at ASC NULLS LAST, created_at ASC LIMIT 1`, [geoId]),
    ]);
    const latestRound = headline.rows[0] ?? null;
    const baselineRound = baseline.rows[0] ?? null;

    const readingRows = (await this.#query(`SELECT DISTINCT ON (m.group_id, m.metric_id, m.round_id) m.group_id, m.metric_id, m.round_id, r.kind, r.sample_date::text AS day,
        m.numerator, m.denominator, m.value, m.status
      FROM evimed_geo.metrics m JOIN evimed_geo.rounds r ON r.id = m.round_id AND r.kind = ANY($3::text[])
      WHERE m.geo_project_id = $1 AND m.scope = 'group' AND m.group_id IS NOT NULL AND m.metric_id = ANY($2::text[])
        AND m.variant IS NULL AND m.rival IS NULL AND m.arm IS NULL AND m.engine IS NULL
      ORDER BY m.group_id, m.metric_id, m.round_id, m.computed_at DESC`, [geoId, [...GEO_ACTION_READ_METRICS], [...SERIES_KINDS]])).rows;
    const coverages = await roundCoverages(this.store, [...new Set(readingRows.map((row) => String(row.round_id)))]);
    const readings = readingRows.map((row) => ({
      groupId: String(currentOf.get(String(row.group_id)) ?? row.group_id), metricId: String(row.metric_id), roundId: String(row.round_id), date: text(row.day),
      kind: String(row.kind), k: num(row.numerator), n: num(row.denominator), value: num(row.value), status: String(row.status),
      coverage: coverageKeyOf(coverages.get(String(row.round_id))),
    }));

    const poolReadings = (await this.#query(`SELECT DISTINCT ON (m.pool, m.metric_id) m.pool, m.metric_id, m.value, m.status, m.numerator, m.denominator, m.round_id
      FROM evimed_geo.metrics m JOIN evimed_geo.rounds r ON r.id = m.round_id AND r.kind = ANY($3::text[])
      WHERE m.geo_project_id = $1 AND m.scope = 'pool' AND m.pool IS NOT NULL AND m.metric_id = ANY($2::text[])
        AND m.variant IS NULL AND m.rival IS NULL AND m.group_id IS NULL AND m.arm IS NULL AND m.engine IS NULL
      ORDER BY m.pool, m.metric_id, r.finished_at DESC NULLS LAST, m.computed_at DESC`, [geoId, [...GEO_ACTION_READ_METRICS], [...HEADLINE_KINDS]])).rows
      .map((row) => ({ pool: String(row.pool), metricId: String(row.metric_id), value: num(row.value), status: String(row.status),
        k: num(row.numerator), n: num(row.denominator), roundId: String(row.round_id) }));

    /** @type {Record<string, { netEffect: number | null, verdict: string | null, noiseBand: number | null, comparable: boolean, reason: string | null, roundId: string | null }>} */
    const arms = {};
    const netRows = (await this.#query(`SELECT DISTINCT ON (m.scope, coalesce(m.pool, ''), m.variant) m.scope, m.pool, m.variant, m.value, m.status, m.reason, m.noise_band, m.round_id
      FROM evimed_geo.metrics m WHERE m.geo_project_id = $1 AND m.metric_id = 'NET' AND m.scope IN ('project', 'pool') AND m.variant IS NOT NULL
      ORDER BY m.scope, coalesce(m.pool, ''), m.variant, m.computed_at DESC`, [geoId])).rows;
    for (const row of netRows) {
      const key = row.scope === "project" ? `all|${row.variant}` : `${row.pool}|${row.variant}`;
      const ok = row.status === "ok";
      arms[key] = { netEffect: ok ? num(row.value) : null, verdict: ok ? text(row.reason) : null, noiseBand: num(row.noise_band), comparable: ok,
        reason: ok ? null : text(row.reason), roundId: text(row.round_id) };
    }

    const errorRows = (await this.#query(`SELECT e.id, e.fingerprint, e.engine, e.question_id, e.first_snapshot_id, e.last_snapshot_id, e.statement, e.error_type,
        e.severity, e.claim_id, e.cited_source, e.action, e.status, e.materials, e.created_at, q.group_id
      FROM evimed_geo.errors e LEFT JOIN evimed_geo.questions q ON q.id = e.question_id
      WHERE e.geo_project_id = $1 ORDER BY e.created_at DESC LIMIT 1000`, [geoId])).rows;
    const errors = errorRows.map((row) => ({
      id: String(row.id), fingerprint: text(row.fingerprint), engine: String(row.engine), questionId: text(row.question_id),
      groupId: row.group_id ? String(currentOf.get(String(row.group_id)) ?? row.group_id) : null,
      statement: text(row.statement), errorType: text(row.error_type), severity: text(row.severity), claimId: text(row.claim_id),
      citedSource: row.cited_source && typeof row.cited_source === "object" ? row.cited_source : null, action: text(row.action), status: String(row.status),
      materials: Array.isArray(row.materials) ? row.materials : [], snapshotId: text(row.last_snapshot_id) ?? text(row.first_snapshot_id),
      firstSnapshotId: text(row.first_snapshot_id), createdAt: iso(row.created_at),
    }));

    const [articles, orderRows, ownedLinks, cited, batchRows, choices] = await Promise.all([
      this.store.listArticles(geoId),
      this.#query(`SELECT o.*, m.domain AS media_domain, m.name AS media_name FROM (${ORDER_SELECT} WHERE o.geo_project_id = $1 ORDER BY o.created_at DESC LIMIT 500) o
        LEFT JOIN evimed_geo.media m ON m.media_type = o.media_type AND m.resource_id = o.resource_id ORDER BY o.created_at DESC`, [geoId]),
      this.store.ownedLinks(geoId),
      this.store.citedArticles(geoId),
      this.#query(`SELECT key, state, detail FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND kind = 'run' AND starts_with(key, 'run:content:')`, [geoId]),
      this.store.actionChoices(geoId),
    ]);
    const orders = orderRows.rows.map((/** @type {any} */ row) => ({ ...mapOrder(row), domain: text(row.media_domain), mediaName: text(row.media_name) }));
    const batches = batchRows.rows.map((/** @type {any} */ row) => {
      const detail = row.detail && typeof row.detail === "object" ? row.detail : {};
      return { key: String(row.key), state: String(row.state),
        groups: (Array.isArray(detail.groups) ? detail.groups : []).map((/** @type {any} */ group) => String(group?.id ?? "")).filter(Boolean),
        errors: [...(Array.isArray(detail.errorIds) ? detail.errorIds : []), ...(Array.isArray(detail.errors) ? detail.errors.map((/** @type {any} */ error) => error?.id) : [])]
          .map(String).filter(Boolean) };
    });

    // The latest full round's answers, by group: the per-engine counts and the sources each group's answers cite.
    /** @type {Map<string, Array<Awaited<ReturnType<typeof roundAnswers>>[number]>>} */
    const answersByGroup = new Map();
    if (latestRound) {
      const questionGroup = new Map((await this.#query(`SELECT id, group_id FROM evimed_geo.questions WHERE geo_project_id = $1 AND set_version = $2`,
        [geoId, latestRound.set_version])).rows.map((/** @type {any} */ row) => [String(row.id), String(row.group_id)]));
      for (const answer of await roundAnswers(this.store, String(latestRound.id))) {
        const groupId = answer.questionId ? questionGroup.get(answer.questionId) : null;
        const resolved = groupId ? currentOf.get(groupId) ?? groupId : null;
        if (!resolved) continue;
        const list = answersByGroup.get(resolved) ?? [];
        list.push(answer);
        answersByGroup.set(resolved, list);
      }
    }
    const sources = await this.store.listSources(geoId);

    return {
      project, version, locked: sets[0]?.lockedAt != null, groups, currentOf, groupNames, strategy, targets,
      rounds: { latest: latestRound ? { id: String(latestRound.id), kind: String(latestRound.kind), sampleDate: text(latestRound.day) } : null,
        baseline: baselineRound ? { id: String(baselineRound.id), kind: String(baselineRound.kind), sampleDate: text(baselineRound.day) } : null },
      readings, poolReadings, arms, errors, articles, orders, ownedLinks, cited, batches, choices, answersByGroup, sources,
    };
  }

  /**
   * The sources an action of a group could go to, ranked as the platform would place them: the market's own ranking when it can be
   * read, then what the engines cite for this group, then the strategy's layout. An impostor is never one.
   * @param {Awaited<ReturnType<GeoSpine["load"]>>} spine
   * @returns {Promise<Map<string, Array<Record<string, any>>>>}
   */
  async candidates(spine) {
    const bySource = new Map(spine.sources.map((source) => [source.domain.toLowerCase().replace(/^www\./, ""), source]));
    const layout = spine.strategy?.layout && typeof spine.strategy.layout === "object" ? /** @type {Record<string, any>} */ (spine.strategy.layout) : {};
    // The layout is the method's `{ layers: { anchor: [...], coverage: [...], owned: [...] } }`, or the platform's own, keyed by engine.
    const layerLists = [layout.layers, ...Object.entries(layout).filter(([key]) => key !== "layers" && GEO_ENGINES.includes(key)).map(([, value]) => value)];
    const layered = layerLists.flatMap((lists) => Object.entries(lists && typeof lists === "object" && !Array.isArray(lists) ? lists : {})
      .filter(([layer]) => ["anchor", "coverage", "owned"].includes(layer))
      .flatMap(([layer, domains]) => (Array.isArray(domains) ? domains : []).filter((domain) => typeof domain === "string")
        .map((domain) => ({ domain: String(domain).toLowerCase().replace(/^www\./, ""), layer }))));
    const conditionsOf = (/** @type {any} */ source) => (source ? { icp: source.icpMatches, newsIndexed: source.newsIndexed, medical: source.medicalVertical } : {});
    const availableOf = (/** @type {any} */ source) => {
      if (!source) return null;
      if (source.impostor || source.blacklistReason) return false;
      const flags = [source.icpMatches, source.newsIndexed, source.medicalVertical];
      if (flags.some((flag) => flag === false)) return false;
      return flags.every((flag) => flag === true) ? true : null;
    };
    /** @type {Map<string, Array<Record<string, any>>>} */
    const out = new Map();
    for (const group of spine.groups) {
      if (group.isControl) continue;
      const tally = tallySources(spine.answersByGroup.get(group.id) ?? []);
      /** @type {Array<Record<string, any>>} */
      const list = [...tally].map(([domain, entry]) => ({ domain, entry })).sort((left, right) => {
        const total = (/** @type {{ entry: { byEngine: Record<string, { cited: number }> } }} */ item) => Object.values(item.entry.byEngine).reduce((sum, count) => sum + count.cited, 0);
        return total(right) - total(left) || left.domain.localeCompare(right.domain);
      }).map(({ domain, entry }) => {
        const source = bySource.get(domain) ?? null;
        return { domain, name: source?.name ?? null, kind: source?.kind ?? null, layer: source?.layer ?? null,
          citedFor: Object.fromEntries(Object.entries(entry.byEngine).map(([engine, count]) => [engine, count.cited])),
          mentionsOurs: entry.mentionsOurs, wrongOurs: entry.wrongOurs, conditions: conditionsOf(source), impostor: source?.impostor === true,
          price: null, available: availableOf(source), origin: "cited", cited: Object.values(entry.byEngine).reduce((sum, count) => sum + count.cited, 0) };
      }).filter((candidate) => !candidate.impostor);
      for (const { domain, layer } of layered) {
        if (list.some((candidate) => candidate.domain === domain)) continue;
        const source = bySource.get(domain) ?? null;
        if (source?.impostor) continue;
        list.push({ domain, name: source?.name ?? null, kind: source?.kind ?? null, layer, citedFor: {}, conditions: conditionsOf(source), impostor: false,
          price: null, available: availableOf(source), origin: "layout", cited: 0 });
      }
      out.set(group.id, list.slice(0, 12));
    }
    if (this.placementPreview) {
      try {
        const ranked = await this.placementPreview({ project: spine.project, groups: spine.groups, candidates: out, choices: spine.choices });
        for (const [groupId, list] of ranked) out.set(groupId, list);
      } catch {
        // The preview decorates: a market that cannot be read leaves the sources as they are, never the page.
      }
    }
    return out;
  }

  /**
   * The actions of a project, by the domain's one function.
   * @param {Awaited<ReturnType<GeoSpine["load"]>>} spine @param {{ candidates?: Map<string, Array<Record<string, any>>> }} [options]
   */
  async actions(spine, { candidates } = {}) {
    const ranked = candidates ?? await this.candidates(spine);
    return deriveGeoActions({
      now: this.now(),
      tier: spine.project.tier,
      engines: spine.project.engines,
      groups: spine.groups,
      strategy: spine.strategy,
      targets: spine.targets,
      readings: spine.readings,
      poolReadings: spine.poolReadings,
      errors: spine.errors,
      articles: spine.articles,
      orders: spine.orders,
      ownedLinks: spine.ownedLinks,
      cited: spine.cited,
      batches: spine.batches,
      choices: spine.choices,
      candidates: Object.fromEntries(ranked),
      arms: spine.arms,
    });
  }

  /**
   * The clusters list: every group with what the engines say about it, the errors against it, what is being done and what stands.
   * @param {Awaited<ReturnType<GeoSpine["load"]>>} spine @param {Awaited<ReturnType<GeoSpine["actions"]>>} derived
   */
  clusters(spine, derived) {
    const errorCounts = errorCountsOf(spine.errors);
    const readingOf = (/** @type {string} */ groupId) => {
      const rows = spine.readings.filter((row) => row.groupId === groupId && row.metricId === "M-01" && row.kind !== "post_publication");
      const row = rows[rows.length - 1];
      return row ? { ...geoGroupReading({ k: row.k, n: row.n }), roundId: row.roundId, date: row.date, coverage: row.coverage } : null;
    };
    /** @param {Array<Record<string, any>>} rows @param {string} field */
    const countBy = (rows, field) => rows.reduce((/** @type {Record<string, number>} */ acc, row) => ({ ...acc, [row[field]]: (acc[row[field]] ?? 0) + 1 }), {});
    return {
      version: spine.version,
      locked: spine.locked,
      round: spine.rounds.latest,
      floor: GEO_MIN_CELL_SAMPLES,
      engines: spine.project.engines,
      groups: spine.groups.map((group) => {
        const answers = spine.answersByGroup.get(group.id) ?? [];
        /** @type {Record<string, { answered: number, mentioned: number, wrong: number }>} */
        const byEngine = {};
        for (const engine of spine.project.engines) byEngine[engine] = { answered: 0, mentioned: 0, wrong: 0 };
        for (const answer of answers) {
          const entry = byEngine[answer.engine] ?? (byEngine[answer.engine] = { answered: 0, mentioned: 0, wrong: 0 });
          entry.answered += 1;
          if (answer.mentionsOurs) entry.mentioned += 1;
          if (answer.wrongOurs) entry.wrong += 1;
        }
        const real = group.questions.filter((question) => question.kind === "real" && !question.retiredAt);
        const mine = derived.actions.filter((action) => action.group?.id === group.id);
        const articles = spine.articles.filter((article) => article.groupId && [group.id, ...group.aliasIds].includes(article.groupId) && article.status !== "withdrawn");
        return {
          id: group.id, name: group.name, pool: group.pool, journeyStage: group.journeyStage, journeyStageNo: group.journeyStageNo ?? null, audience: group.audience,
          weight: group.weight, isControl: group.isControl, signal: group.signal,
          questionCount: group.questions.length,
          measuredCount: group.questions.filter((question) => question.isMeasured && !question.retiredAt).length,
          realCount: real.length,
          realPhrasings: real.slice(0, REAL_PHRASINGS_SHOWN).map((question) => ({ text: question.text, platform: question.platform, sourceUrl: question.sourceUrl,
            collectedAt: question.collectedAt })),
          mention: readingOf(group.id),
          byEngine,
          errors: errorCounts.get(group.id) ?? { open: 0, severe: 0, total: 0 },
          actions: { total: mine.length, byStatus: countBy(mine, "status") },
          articles: { total: articles.length, byStatus: countBy(articles, "status") },
        };
      }),
    };
  }

  /**
   * One group in full, or null when the project has no such group in its latest set.
   * @param {Awaited<ReturnType<GeoSpine["load"]>>} spine @param {Awaited<ReturnType<GeoSpine["actions"]>>} derived @param {string} groupId
   * @param {{ answersOf: (texts: string[]) => Promise<Map<string, Array<{ engine: string, snapshotId: string }>>>, claimsOf: (ids: string[]) => Promise<Array<Record<string, any>>>,
   *   answerFacts: (snapshotIds: string[]) => Promise<Map<string, Record<string, any>>> }} readers
   */
  async cluster(spine, derived, groupId, readers) {
    const wanted = spine.currentOf.get(groupId) ?? groupId;
    const group = spine.groups.find((entry) => entry.id === wanted);
    if (!group) return null;
    const row = this.clusters(spine, derived).groups.find((entry) => entry.id === group.id);
    const ids = new Set([group.id, ...group.aliasIds]);
    const answers = await readers.answersOf(group.questions.filter((question) => question.isMeasured).map((question) => question.text));
    const snapshotIds = [...answers.values()].flatMap((list) => list.map((entry) => entry.snapshotId));
    const facts = await readers.answerFacts(snapshotIds);
    const questions = group.questions.map((question) => ({
      id: question.id, text: question.text, kind: question.kind, isMeasured: question.isMeasured, platform: question.platform, sourceUrl: question.sourceUrl,
      collectedAt: question.collectedAt,
      answers: question.isMeasured ? (answers.get(question.text.trim()) ?? []).map((answer) => {
        const fact = facts.get(answer.snapshotId);
        return { engine: answer.engine, snapshotId: answer.snapshotId, status: fact?.status ?? null, askedAt: fact?.askedAt ?? null,
          mentionsOurs: fact?.mentionsOurs ?? null, wrongOurs: fact?.wrongOurs ?? null, citesOurs: fact?.citesOurs ?? null };
      }) : [],
    }));
    const tally = tallySources(spine.answersByGroup.get(group.id) ?? []);
    const bySource = new Map(spine.sources.map((source) => [source.domain.toLowerCase().replace(/^www\./, ""), source]));
    const topSources = [...tally].map(([domain, entry]) => ({ domain, entry }))
      .map(({ domain, entry }) => ({ domain, entry, total: Object.values(entry.byEngine).reduce((sum, count) => sum + count.cited, 0) }))
      .sort((left, right) => right.total - left.total || left.domain.localeCompare(right.domain)).slice(0, TOP_SOURCES)
      .map(({ domain, entry, total }) => {
        const source = bySource.get(domain) ?? null;
        return { domain, name: source?.name ?? null, kind: source?.kind ?? null, layer: source?.layer ?? null, cited: { total, byEngine: Object.fromEntries(
          Object.entries(entry.byEngine).map(([engine, count]) => [engine, count.cited])) }, mentionsOurs: entry.mentionsOurs, wrongOurs: entry.wrongOurs,
        conditions: source ? { icp: source.icpMatches, newsIndexed: source.newsIndexed, medical: source.medicalVertical } : null,
        impostor: source?.impostor === true, price: source?.market ? num(source.market.price ?? source.market.priceCny) : null };
      });
    const gaps = (Array.isArray(spine.strategy?.gaps) ? spine.strategy.gaps : []).filter((gap) => gap && typeof gap === "object"
      && (ids.has(String(gap.groupId)) || (gap.group && gap.group === group.name)));
    const claimIds = [...new Set(gaps.flatMap((gap) => (Array.isArray(gap.expectedPoints) ? gap.expectedPoints : [])
      .flatMap((/** @type {any} */ point) => (Array.isArray(point?.refs) ? point.refs.map((/** @type {any} */ ref) => ref?.id) : [])).filter((/** @type {unknown} */ id) => typeof id === "string")))];
    const claims = claimIds.length ? await readers.claimsOf(claimIds) : [];
    const mine = derived.actions.filter((action) => action.group?.id === group.id);
    const articleIds = new Set(mine.flatMap((action) => action.articleIds));
    const articles = spine.articles.filter((article) => articleIds.has(article.id) || (article.groupId && ids.has(article.groupId)));
    const orderIds = new Set(mine.flatMap((action) => action.orderIds));
    const errors = spine.errors.filter((error) => error.groupId === group.id);
    /** @type {Array<{ kind: string, at: string | null, articleId?: string | null, orderId?: string | null, engine?: string | null, errorId?: string | null }>} */
    const events = [];
    for (const article of articles) events.push({ kind: "article", at: article.createdAt, articleId: article.id });
    for (const order of spine.orders.filter((entry) => orderIds.has(entry.id) && entry.publishedAt)) events.push({ kind: "published", at: order.publishedAt, orderId: order.id, articleId: order.articleId });
    for (const link of spine.ownedLinks.filter((entry) => entry.groupId && ids.has(entry.groupId))) events.push({ kind: "published", at: link.publishedAt, articleId: link.articleId });
    for (const entry of spine.cited.filter((item) => articles.some((article) => article.id === item.articleId))) {
      events.push({ kind: "cited", at: entry.firstSeen, articleId: entry.articleId, engine: entry.engine });
    }
    for (const error of errors) events.push({ kind: "error_seen", at: error.createdAt, errorId: error.id, engine: error.engine });
    events.sort((left, right) => String(left.at ?? "").localeCompare(String(right.at ?? "")));
    // The series is of the metric the group's work is judged on: its first action's, else mention.
    const seriesMetric = mine.find((action) => action.expected.primaryMetricId)?.expected.primaryMetricId ?? "M-01";
    const series = spine.readings.filter((entry) => entry.groupId === group.id && entry.metricId === seriesMetric)
      .map((entry) => ({ round: entry.roundId, date: entry.date, kind: entry.kind, ...geoGroupReading({ k: entry.k, n: entry.n }), coverage: entry.coverage }));
    return {
      group: row,
      questions,
      sources: topSources,
      gaps: gaps.map((gap) => ({ gapId: text(gap.gapId), class: text(gap.class), judgment: text(gap.judgment) ?? text(gap.text), rank: num(gap.rank), consequence: gap.consequence ?? null,
        evidence: gap.evidence ?? null, expectedPoints: Array.isArray(gap.expectedPoints) ? gap.expectedPoints : [], handoff: text(gap.handoff), safetyPinned: gap.safetyPinned === true })),
      claims: Object.fromEntries(claims.map((claim) => [claim.id, claim])),
      actions: mine,
      articles: articles.map((article) => ({ id: article.id, layer: article.layer, title: article.title, status: article.status, gate: article.gate, safety: article.safety,
        channel: article.channel, channelNote: article.channelNote, audience: article.audience, audienceNote: article.audienceNote, path: article.path, runId: article.runId })),
      orders: spine.orders.filter((order) => orderIds.has(order.id)).map((order) => ({ id: order.id, articleId: order.articleId, state: order.state, domain: order.domain,
        publishedUrl: order.publishedUrl, publishedAt: order.publishedAt, priceCny: order.settledCny ?? order.priceCny ?? order.reserveCny })),
      ownedLinks: spine.ownedLinks.filter((link) => link.groupId && ids.has(link.groupId)).map((link) => ({ id: link.id, articleId: link.articleId, platform: link.platform,
        url: link.url, title: link.title, publishedAt: link.publishedAt, status: link.status, citedBy: link.citedBy })),
      errors: errors.map((error) => ({ id: error.id, fingerprint: error.fingerprint, engine: error.engine, statement: error.statement, severity: error.severity,
        status: error.status, snapshotId: error.snapshotId, claimId: error.claimId, citedSource: error.citedSource, action: error.action, createdAt: error.createdAt })),
      effect: { metricId: seriesMetric, series, events, arm: mine.find((action) => action.observed.arm)?.observed.arm ?? null },
    };
  }

  /**
   * The strategy page's one read (`/strategy`): the targets as baseline → now → target with the date of each, the battlefield with its
   * reasons and its groups, each engine's promise and layout with what the client has to do, the tiers in words, the assumptions.
   * It replaces the page's use of the all-sources endpoint.
   * @param {Awaited<ReturnType<GeoSpine["load"]>>} spine @param {Awaited<ReturnType<GeoSpine["actions"]>>} derived
   */
  async strategy(spine, derived) {
    const strategy = spine.strategy;
    const geoId = spine.project.id;
    const tier = String(spine.project.tier);
    const rounds = [spine.rounds.baseline, spine.rounds.latest].filter((round) => round != null);
    const roundIds = [...new Set(rounds.map((round) => /** @type {{ id: string }} */ (round).id))];
    /** @type {Map<string, any>} */
    const readings = new Map();
    if (roundIds.length) {
      const rows = (await this.#query(`SELECT DISTINCT ON (m.round_id, m.scope, coalesce(m.pool, ''), m.metric_id) m.round_id, m.scope, m.pool, m.metric_id, m.numerator,
          m.denominator, m.value, m.ci_low, m.ci_high, m.status, m.data_type, m.reason
        FROM evimed_geo.metrics m WHERE m.geo_project_id = $1 AND m.round_id = ANY($2::text[]) AND m.scope IN ('project', 'pool') AND m.variant IS NULL AND m.rival IS NULL
          AND m.group_id IS NULL AND m.arm IS NULL AND m.engine IS NULL
        ORDER BY m.round_id, m.scope, coalesce(m.pool, ''), m.metric_id, m.computed_at DESC`, [geoId, roundIds])).rows;
      for (const row of rows) readings.set(`${row.round_id}\u0000${row.scope === "project" ? "all" : row.pool}\u0000${row.metric_id}`, row);
    }
    /** @param {{ id: string, sampleDate: string | null } | null} round @param {string} pool @param {string} metricId */
    const readingOf = (round, pool, metricId) => {
      if (!round) return null;
      const row = readings.get(`${round.id}\u0000${pool}\u0000${metricId}`);
      return row ? { ...cellOf(row), date: round.sampleDate, roundId: round.id } : null;
    };
    /** @type {Map<string, any>} */
    const byTarget = new Map();
    for (const row of spine.targets?.rows ?? []) {
      const key = `${row.metricId}\u0000${row.pool}`;
      const entry = byTarget.get(key) ?? { metricId: row.metricId, name: geoMetricName(row.metricId), unit: geoMetricUnit(row.metricId), pool: row.pool, tiers: {} };
      entry.tiers[row.tier] = { target: row.target, written: row.baseline, horizonWeeks: row.horizonWeeks, placements: row.placements, budgetCny: row.budgetCny, dataType: row.dataType };
      byTarget.set(key, entry);
    }
    const baselineDate = spine.rounds.baseline?.sampleDate ?? null;
    const targets = [...byTarget.values()].map((entry) => {
      const chosen = entry.tiers[tier] ?? null;
      const dueAt = baselineDate && chosen?.horizonWeeks != null ? new Date(Date.parse(`${baselineDate}T00:00:00Z`) + chosen.horizonWeeks * 7 * 86_400_000).toISOString().slice(0, 10) : null;
      return { ...entry, target: chosen?.target ?? null, horizonWeeks: chosen?.horizonWeeks ?? null, dueAt,
        baseline: readingOf(spine.rounds.baseline, entry.pool, entry.metricId), latest: readingOf(spine.rounds.latest, entry.pool, entry.metricId) };
    }).sort((left, right) => left.metricId.localeCompare(right.metricId) || left.pool.localeCompare(right.pool));

    const retrieval = (await this.#query(`SELECT DISTINCT ON (m.engine) m.* FROM evimed_geo.metrics m
        JOIN evimed_geo.rounds r ON r.id = m.round_id AND r.kind = ANY($3::text[])
      WHERE m.geo_project_id = $1 AND m.scope = 'engine' AND m.metric_id = $2 AND m.pool IS NULL AND m.arm IS NULL AND m.variant IS NULL AND m.rival IS NULL
        AND m.group_id IS NULL AND m.status <> 'absent' ORDER BY m.engine, m.computed_at DESC`, [geoId, GEO_VIEW_METRIC_IDS.retrieval, [...HEADLINE_KINDS]])).rows;
    const retrievalByEngine = new Map(retrieval.map((row) => [String(row.engine), row]));
    const layout = strategy?.layout && typeof strategy.layout === "object" ? /** @type {Record<string, any>} */ (strategy.layout) : {};
    const layoutByEngine = new Map((Array.isArray(layout.byEngine) ? layout.byEngine : []).filter((/** @type {any} */ entry) => entry && typeof entry === "object")
      .map((/** @type {any} */ entry) => [String(entry.engine), entry]));
    const expectations = Array.isArray(strategy?.expectations) ? strategy.expectations.filter((/** @type {any} */ entry) => entry && typeof entry === "object") : [];
    const engineIds = [...new Set([...spine.project.engines, ...expectations.map((/** @type {any} */ entry) => String(entry.engine ?? "")).filter(Boolean)])];
    const engines = engineIds.map((engine) => {
      const entry = expectations.find((/** @type {any} */ item) => item.engine === engine) ?? {};
      const placed = layoutByEngine.get(engine) ?? null;
      return {
        engine,
        retrieval: retrievalByEngine.has(engine) ? cellOf(retrievalByEngine.get(engine)) : cellOf(null),
        promise: text(entry.promise), ceiling: text(entry.ceiling), ceilingBasis: text(entry.ceilingBasis), evidence: text(entry.evidence),
        layers: Array.isArray(entry.layers) ? entry.layers : [], cites: Array.isArray(entry.cites) ? entry.cites : [], leverage: text(entry.leverage),
        clusterLeverage: Array.isArray(entry.clusterLeverage) ? entry.clusterLeverage : [],
        layout: placed ? { account: text(placed.account), state: text(placed.state), evidence: text(placed.evidence) } : null,
      };
    });

    /** The groups a run named, by id or by name, as the current groups and their names. @param {unknown} entries */
    const groupsNamed = (entries) => (Array.isArray(entries) ? entries : []).filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => {
      const written = String(entry).trim();
      const id = spine.currentOf.get(written) ?? null;
      const byId = id ? spine.groups.find((group) => group.id === id) : null;
      const byName = byId ?? spine.groups.find((group) => group.name === written) ?? null;
      return { id: byName?.id ?? null, name: byName?.name ?? (spine.groupNames.get(written) ?? (GROUP_ID_SHAPE.test(written) ? null : written)) };
    }).filter((group) => group.name != null);
    const battlefield = strategy?.battlefield && typeof strategy.battlefield === "object" ? /** @type {Record<string, any>} */ (strategy.battlefield) : null;
    const why = (/** @type {any} */ entry) => (Array.isArray(entry?.why) ? entry.why.filter((/** @type {unknown} */ line) => typeof line === "string") : typeof entry?.why === "string" ? [entry.why] : []);
    const secondary = (Array.isArray(battlefield?.secondary) ? battlefield.secondary : []).map((/** @type {any} */ entry) => (typeof entry === "string"
      ? { id: null, name: entry, why: [], action: null, groups: [] }
      : { id: text(entry?.id), name: text(entry?.name), why: why(entry), action: text(entry?.action), groups: groupsNamed(entry?.groups) }));
    const clientActions = (Array.isArray(layout.clientActions) ? layout.clientActions : []).filter((/** @type {unknown} */ entry) => typeof entry === "string")
      .map((/** @type {string} */ entry) => {
        const key = `client:${geoTextKey(entry)}`;
        return { key, text: entry, done: spine.choices.some((choice) => choice.key === key && choice.skipped) };
      });
    const tiers = GEO_TIERS.map((value) => {
      const written = (Array.isArray(strategy?.tiers) ? strategy.tiers : []).find((/** @type {any} */ entry) => entry?.tier === value) ?? null;
      const rows = (spine.targets?.rows ?? []).filter((row) => row.tier === value);
      return {
        tier: value, chosen: value === tier,
        name: text(written?.name), summary: text(written?.summary), buys: text(written?.buys),
        notPromised: Array.isArray(written?.notPromised) ? written.notPromised : [], contentUnits: num(written?.contentUnits),
        placements: rows.reduce((/** @type {number | null} */ max, row) => (row.placements == null ? max : Math.max(max ?? 0, row.placements)), null),
        budgetCny: rows.reduce((/** @type {number | null} */ max, row) => (row.budgetCny == null ? max : Math.max(max ?? 0, row.budgetCny)), null),
        targetCount: rows.length,
      };
    }).filter((entry) => entry.targetCount > 0 || entry.name || entry.buys);
    const gaps = Array.isArray(strategy?.gaps) ? strategy.gaps : [];
    return {
      version: strategy?.version ?? null, createdAt: strategy?.createdAt ?? null, runId: strategy?.runId ?? null, summary: strategy?.summary ?? null,
      chosenTier: tier,
      targets: { tier, baselineRound: spine.rounds.baseline, latestRound: spine.rounds.latest, targetsVersion: spine.targets?.version ?? null, rows: targets },
      tiers,
      battlefield: battlefield ? {
        id: text(battlefield.id), name: text(battlefield.name), why: why(battlefield), action: text(battlefield.action),
        reason: text(battlefield.reason) ?? (why(battlefield).length ? why(battlefield).join("；") : null),
        groups: groupsNamed(battlefield.groups ?? battlefield.measuredOn), secondary,
      } : null,
      noGo: Array.isArray(strategy?.noGo) ? strategy.noGo : [],
      engines,
      layout: { layers: layout.layers && typeof layout.layers === "object" ? layout.layers : null, constraints: Array.isArray(layout.constraints) ? layout.constraints : [],
        clientActions },
      assumptions: Array.isArray(strategy?.assumptions) ? strategy.assumptions : [],
      gaps: { total: gaps.length, withoutAction: derived.counts.gapsWithoutEntry },
      actions: { total: derived.counts.total, byStatus: derived.counts.byStatus },
    };
  }

  /**
   * The needs-you list and the rail's counts, from what a project holds now.
   * @param {Awaited<ReturnType<GeoSpine["load"]>>} spine @param {{ canReview?: boolean }} [options]
   */
  needsYou(spine, { canReview = true } = {}) {
    const layout = spine.strategy?.layout && typeof spine.strategy.layout === "object" ? /** @type {Record<string, any>} */ (spine.strategy.layout) : {};
    return geoNeedsYou({
      project: { id: spine.project.id, budget: spine.project.budget ?? null, steps: spine.project.steps ?? {} },
      marketConfigured: this.marketConfigured(),
      canReview,
      articles: spine.articles,
      errors: spine.errors,
      clientActions: Array.isArray(layout.clientActions) ? layout.clientActions.filter((/** @type {unknown} */ entry) => typeof entry === "string") : [],
      choices: spine.choices,
    });
  }

  /**
   * One short count per programme step, for the rail.
   * @param {string} geoId
   * @returns {Promise<Record<string, { text: string, count: number, unit: string } | null>>}
   */
  async stepSummaries(geoId) {
    const row = (await this.#query(`SELECT
        (SELECT count(*) FROM (SELECT DISTINCT ON (claim_key) status FROM evimed_geo.claims WHERE geo_project_id = $1 ORDER BY claim_key, version DESC) c WHERE c.status = 'active')::integer AS claims,
        (SELECT coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(data -> 'stages') = 'array' THEN data -> 'stages' ELSE '[]'::jsonb END), 0)
           FROM evimed_geo.journeys WHERE geo_project_id = $1 ORDER BY version DESC LIMIT 1) AS stages,
        (SELECT count(*) FROM evimed_geo.question_groups g WHERE g.geo_project_id = $1
           AND g.set_version = (SELECT max(version) FROM evimed_geo.question_sets WHERE geo_project_id = $1))::integer AS groups,
        (SELECT coalesce(max(r.done), 0) FROM evimed_geo.rounds r WHERE r.geo_project_id = $1 AND r.kind IN ('baseline', 'weekly', 'single_step')
           AND r.status IN ('done', 'partial'))::integer AS answers,
        (SELECT count(*) FROM evimed_geo.sources WHERE geo_project_id = $1)::integer AS sources,
        (SELECT count(*) FROM evimed_geo.articles WHERE geo_project_id = $1 AND status <> 'withdrawn')::integer AS articles,
        ((SELECT count(*) FROM evimed_geo.orders WHERE geo_project_id = $1 AND state IN ('published', 'verified', 'settled'))
          + (SELECT count(*) FROM evimed_geo.owned_links WHERE geo_project_id = $1 AND status = 'active'))::integer AS published,
        (SELECT count(*) FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind IN ('baseline', 'weekly', 'single_step') AND status IN ('done', 'partial'))::integer AS rounds`,
    [geoId])).rows[0] ?? {};
    const counts = { claims: num(row.claims), stages: num(row.stages), groups: num(row.groups), answers: num(row.answers), sources: num(row.sources),
      articles: num(row.articles), published: num(row.published), rounds: num(row.rounds) };
    return Object.fromEntries(GEO_STEPS.map((step) => [step, geoStepSummary(step, counts)]));
  }

  /**
   * Whether a key is something a person may decide about in this project: one of its actions, or one of the strategy's client to-dos.
   * @param {Awaited<ReturnType<GeoSpine["load"]>>} spine @param {Awaited<ReturnType<GeoSpine["actions"]>>} derived @param {string} key
   */
  knowsKey(spine, derived, key) {
    if (parseGeoActionKey(key)) return derived.actions.some((action) => action.key === key);
    const match = /^client:([0-9a-f]{8})$/.exec(key);
    if (!match) return false;
    const layout = spine.strategy?.layout && typeof spine.strategy.layout === "object" ? /** @type {Record<string, any>} */ (spine.strategy.layout) : {};
    return (Array.isArray(layout.clientActions) ? layout.clientActions : []).some((/** @type {unknown} */ entry) => typeof entry === "string" && geoTextKey(entry) === match[1]);
  }
}

