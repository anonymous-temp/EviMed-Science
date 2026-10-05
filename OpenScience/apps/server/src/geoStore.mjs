/**
 * 「循证 GEO」's content side (build spec 2026-09-25 §1, §2): the queries and
 * row mappers for projects, claims, the question map (sets, groups,
 * questions), the journey, strategy, targets, placement plans, sources,
 * articles and the links the brand published itself. The measurement tables (`geoMeasureStore.mjs`) and the market
 * tables (`geoMarketStore.mjs`) have their own stores; all three code against
 * `geoPersistence.mjs`.
 *
 * Hidden knowledge:
 *
 * - **Ownership is resolved once, by the project.** `getProject(userId, id)`
 *   and `projectByControlProject(userId, projectId)` are the only lookups
 *   that take an account; every other method takes the GEO project id the
 *   caller already resolved for that account. A caller that skips the lookup
 *   has skipped the tenancy check — the service and the gateway never do.
 * - **Every product is versioned, never edited in place** (spec ruling 4, so
 *   「把上一版问题地图换回来」 is one sentence in chat): a question-map write is
 *   a new set version, so are the journey, strategy, targets and placement
 *   plan; a claim whose statement, quote or source changes gets a new version
 *   under the same key. Only a claim's bookkeeping (level, dates, status) and
 *   an article's registration are updated in place.
 * - **A set is copied, not patched.** Removing one question from measurement
 *   (「移出测量问句」) writes the whole set again as the next version, with new
 *   ids, locked when its source was — measurement compares like with like only
 *   within one set version (MI-G02), and a version that changed under a round
 *   would make its numbers incomparable without saying so.
 * - **Deleting is explicit** (`deleteGeoProjectRows`, `deleteGeoUserRows`):
 *   the content and measurement rows go with the project or the account, in
 *   the caller's transaction; orders, their events and the ledger stay — they
 *   are money, and the platform's reconciliation reads them after the project
 *   is gone. Both check the schema exists first, so a deployment that never
 *   switched the module on deletes projects exactly as before. They return
 *   the screenshots no remaining snapshot references, which the caller
 *   removes from disk once its transaction has committed
 *   (`removeGeoScreenshotFiles`).
 * - **Every query runs under a five-second statement timeout**, reads
 *   included: a read is one statement inside its own short transaction, so a
 *   page that cannot answer is refused rather than held (the frontier's rule).
 * - **An article's clinical-safety stop is sticky.** Once an article is stored
 *   with safety `open`, re-registering it cannot clear that — only a person's
 *   「放行」 (`changeArticle` from the release route) moves it, and the status
 *   is recomputed from the stored safety, never from the run's word.
 *
 * @module geoStore
 */

import { rm } from "node:fs/promises";
import { canonicalGeoUrl, geoArticlePublishable, GEO_STEPS, STEP_WAITING_ALLOWANCE } from "@evimed/domain";
import { GEO_SCHEMA, migrateGeo } from "./geoPersistence.mjs";
import { geoScreenshotFile } from "./geoScreenshots.mjs";
import { randomId } from "./security.mjs";

/** The statement timeout every GEO transaction sets for itself. */
const STATEMENT_TIMEOUT_MS = 5_000;

/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());
/** @param {unknown} value */
const num = (value) => (value == null ? null : Number(value));
/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value : null);

/** @typedef {{ status: string, requested: boolean, runId?: string | null, roundId?: string | null, updatedAt: string | null, note?: string | null }} GeoStep */

/**
 * A step as the orchestrator and the page read it: every one of the eight
 * present, `none` and not requested until something happened.
 * @param {unknown} value @returns {Record<string, GeoStep>}
 */
export function normalizedSteps(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {};
  /** @type {Record<string, GeoStep>} */
  const steps = {};
  for (const step of GEO_STEPS) {
    const entry = raw[step] && typeof raw[step] === "object" ? raw[step] : {};
    steps[step] = {
      status: typeof entry.status === "string" ? entry.status : "none",
      requested: entry.requested === true,
      ...(entry.runId ? { runId: String(entry.runId) } : {}),
      ...(entry.roundId ? { roundId: String(entry.roundId) } : {}),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
      ...(typeof entry.note === "string" && entry.note ? { note: entry.note } : {}),
      // What a queued step is waiting on when its start was refused: the allowance (`STEP_WAITING_ALLOWANCE`).
      ...(STEP_WAITING_ALLOWANCE.includes(entry.waiting) ? { waiting: String(entry.waiting) } : {}),
    };
  }
  return steps;
}

/** @param {any} row */
export function geoProjectFromRow(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    projectId: String(row.project_id),
    product: row.product && typeof row.product === "object" ? row.product : {},
    competitors: Array.isArray(row.competitors) ? row.competitors : [],
    coverageDays: Number(row.coverage_days),
    engines: Array.isArray(row.engines) ? row.engines.map(String) : [],
    tier: String(row.tier),
    budget: row.budget && typeof row.budget === "object" ? row.budget : null,
    status: String(row.status),
    steps: normalizedSteps(row.steps),
    // What the product is about, by the shared entity vocabulary (`entityVocabulary.mjs`); none until it could be tagged.
    entityKeys: Array.isArray(row.entity_keys) ? row.entity_keys.map(String) : [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
  };
}

/** @param {any} row */
export function claimFromRow(row) {
  return {
    id: String(row.id),
    claimKey: String(row.claim_key),
    version: Number(row.version),
    statement: String(row.statement),
    quote: String(row.quote),
    sourceRef: String(row.source_ref),
    sourceLabel: text(row.source_label),
    sourceKind: text(row.source_kind),
    evidenceLevel: text(row.evidence_level),
    population: text(row.population),
    inLabel: row.in_label == null ? null : Boolean(row.in_label),
    elements: row.elements && typeof row.elements === "object" ? row.elements : {},
    verifiedAt: iso(row.verified_at),
    validUntil: iso(row.valid_until),
    status: String(row.status),
    runId: text(row.run_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** @param {any} row */
export function questionGroupFromRow(row) {
  return {
    id: String(row.id),
    setVersion: Number(row.set_version),
    pool: text(row.pool),
    name: text(row.name),
    typicalQuestion: text(row.typical_question),
    journeyStage: text(row.journey_stage),
    audience: text(row.audience),
    bridge: text(row.bridge),
    weight: num(row.weight),
    isControl: row.is_control === true,
    signal: text(row.signal),
  };
}

/** @param {any} row */
export function questionFromRow(row) {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    setVersion: Number(row.set_version),
    text: String(row.text),
    kind: text(row.kind),
    pool: text(row.pool),
    platform: text(row.platform),
    sourceUrl: text(row.source_url),
    collectedAt: iso(row.collected_at),
    isMeasured: row.is_measured === true,
    retiredAt: iso(row.retired_at),
  };
}

/** @param {any} row */
export function geoSourceFromRow(row) {
  return {
    id: String(row.id),
    domain: String(row.domain),
    name: text(row.name),
    kind: text(row.kind),
    layer: text(row.layer),
    icpOwner: text(row.icp_owner),
    icpMatches: row.icp_matches == null ? null : Boolean(row.icp_matches),
    newsIndexed: row.news_indexed == null ? null : Boolean(row.news_indexed),
    medicalVertical: row.medical_vertical == null ? null : Boolean(row.medical_vertical),
    impostor: row.impostor === true,
    blacklistReason: text(row.blacklist_reason),
    checkedAt: iso(row.checked_at),
    cited: row.cited && typeof row.cited === "object" ? row.cited : {},
    mentionsOurs: Number(row.mentions_ours ?? 0),
    wrongOurs: Number(row.wrong_ours ?? 0),
    market: row.market && typeof row.market === "object" ? row.market : null,
    updatedAt: iso(row.updated_at),
  };
}

/** @param {any} row */
export function geoArticleFromRow(row) {
  return {
    id: String(row.id),
    runId: text(row.run_id),
    deliverableId: text(row.deliverable_id),
    path: text(row.path),
    layer: text(row.layer),
    title: text(row.title),
    groupId: text(row.group_id),
    claimIds: Array.isArray(row.claim_ids) ? row.claim_ids.map(String) : [],
    gate: text(row.gate),
    safety: String(row.safety),
    contentSha256: text(row.content_sha256),
    protectedSha256: text(row.protected_sha256),
    status: String(row.status),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * A link the brand published itself, as the page and `geo_read` show it.
 * @param {any} row
 */
export function geoOwnedLinkFromRow(row) {
  return {
    id: String(row.id),
    url: String(row.url),
    platform: String(row.platform),
    title: String(row.title),
    publishedAt: iso(row.published_at),
    articleId: text(row.article_id),
    groupId: text(row.group_id),
    status: String(row.status),
    retiredAt: iso(row.retired_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** The most owned links one project lists (and may hold active). */
export const GEO_OWNED_LINKS_MAX = 500;

/**
 * Hosts on the owned-link platforms whose page is named by its query string,
 * with the parameters that name it. `canonicalGeoUrl` — the owner's key for
 * an outlet's page — drops the query, and on these hosts that makes every
 * page one address: every 百家号 post is `baijiahao.baidu.com/s`.
 */
const QUERY_NAMED_HOSTS = Object.freeze({
  "baijiahao.baidu.com": Object.freeze(["id"]),
  "mp.weixin.qq.com": Object.freeze(["__biz", "mid", "idx", "sn"]),
});

/**
 * The key an owned link is stored and matched by: `canonicalGeoUrl`, plus
 * the parameters that name the page on a host that names pages by query
 * (in a fixed order, other parameters — Baidu's `wfr=spider&for=pc` — left
 * out). Everywhere else it is exactly `canonicalGeoUrl`. `generic` is an
 * address on such a host without what names the page: it would stand for
 * every page there, and is refused.
 * @param {string} url @returns {{ key: string, generic: boolean, named: boolean }}
 */
export function geoOwnedLinkKey(url) {
  const base = canonicalGeoUrl(url);
  let parsed;
  try { parsed = new URL(url); } catch { return { key: base, generic: false, named: false }; }
  const names = /** @type {Record<string, readonly string[]>} */ (QUERY_NAMED_HOSTS)[parsed.hostname.toLowerCase().replace(/^www\./, "")];
  if (!names) return { key: base, generic: false, named: false };
  const identity = names.filter((name) => parsed.searchParams.get(name)).map((name) => `${name}=${parsed.searchParams.get(name)}`);
  if (identity.length) return { key: `${base}?${identity.join("&")}`, generic: false, named: true };
  return { key: base, generic: /^\/s\/?$/.test(parsed.pathname), named: false };
}

const PROJECT_COLUMNS = `id, user_id, project_id, product, competitors, coverage_days, engines, tier, budget, status, steps,
  entity_keys, created_at, updated_at, deleted_at`;

/** The tables whose rows go with a project or an account; the money tables are not among them. */
const OWNED_TABLES = Object.freeze(["facts", "snapshots", "probe_jobs", "rounds", "metrics", "errors", "questions", "question_groups", "schedule_marks",
  "question_sets", "journeys", "claims", "strategy", "targets", "placement_plans", "sources", "articles", "owned_links"]);

/** Whether this database has the GEO schema at all. @param {any} client */
async function geoSchemaExists(client) {
  const found = await client.query(`SELECT to_regclass('${GEO_SCHEMA}.projects') IS NOT NULL AS present`);
  return found.rows[0]?.present === true;
}

/**
 * The screenshots of the snapshots about to be deleted, and — once they are —
 * which of those no other snapshot references any more (screenshots are
 * content-addressed, so one file can serve two snapshots).
 * @param {any} client @param {string} where @param {unknown[]} values
 */
async function screenshotsOf(client, where, values) {
  const result = await client.query(`SELECT DISTINCT screenshot_sha256 FROM evimed_geo.snapshots
    WHERE ${where} AND screenshot_sha256 IS NOT NULL`, values);
  return result.rows.map((/** @type {any} */ row) => String(row.screenshot_sha256));
}

/** @param {any} client @param {string[]} candidates */
async function orphanedScreenshots(client, candidates) {
  if (!candidates.length) return [];
  const still = await client.query(`SELECT DISTINCT screenshot_sha256 FROM evimed_geo.snapshots WHERE screenshot_sha256 = ANY($1::text[])`, [candidates]);
  const referenced = new Set(still.rows.map((/** @type {any} */ row) => String(row.screenshot_sha256)));
  return candidates.filter((sha) => !referenced.has(sha));
}

/**
 * Remove every GEO row of one control-plane project, inside the caller's
 * transaction (the project deletion's `beforeDelete`). Money rows stay.
 * @param {any} client @param {string} userId @param {string} projectId
 * @returns {Promise<{ projects: number, screenshots: string[] }>} GEO projects removed, and the screenshots nothing references now
 */
export async function deleteGeoProjectRows(client, userId, projectId) {
  if (!client || !(await geoSchemaExists(client))) return { projects: 0, screenshots: [] };
  const found = await client.query(`SELECT id FROM evimed_geo.projects WHERE user_id = $1 AND project_id = $2`, [userId, projectId]);
  const ids = found.rows.map((/** @type {any} */ row) => String(row.id));
  if (!ids.length) return { projects: 0, screenshots: [] };
  const candidates = await screenshotsOf(client, "geo_project_id = ANY($1::text[])", [ids]);
  for (const table of OWNED_TABLES) {
    await client.query(`DELETE FROM evimed_geo.${table} WHERE geo_project_id = ANY($1::text[])`, [ids]);
  }
  await client.query(`DELETE FROM evimed_geo.projects WHERE id = ANY($1::text[])`, [ids]);
  return { projects: ids.length, screenshots: await orphanedScreenshots(client, candidates) };
}

/**
 * Remove every GEO row of one account, inside the account deletion's
 * transaction. Money rows stay.
 * @param {any} client @param {string} userId
 * @returns {Promise<{ projects: number, screenshots: string[] }>} GEO projects removed, and the screenshots nothing references now
 */
export async function deleteGeoUserRows(client, userId) {
  if (!client || !(await geoSchemaExists(client))) return { projects: 0, screenshots: [] };
  const candidates = await screenshotsOf(client, "user_id = $1", [userId]);
  for (const table of OWNED_TABLES) {
    await client.query(`DELETE FROM evimed_geo.${table} WHERE user_id = $1`, [userId]);
  }
  const removed = await client.query(`DELETE FROM evimed_geo.projects WHERE user_id = $1`, [userId]);
  return { projects: removed.rowCount ?? 0, screenshots: await orphanedScreenshots(client, candidates) };
}

/**
 * Remove screenshot files from disk, after the deletion that orphaned them
 * has committed. A file that is already gone is fine; one that cannot be
 * removed is reported by its code and left (the rows are gone either way).
 * @param {string} dataDir @param {readonly string[]} shas @param {(code: string) => void} [report]
 * @returns {Promise<number>} files removed or already absent
 */
export async function removeGeoScreenshotFiles(dataDir, shas, report = () => {}) {
  let removed = 0;
  for (const sha of shas) {
    try {
      await rm(geoScreenshotFile(dataDir, sha), { force: true });
      removed += 1;
    } catch (error) {
      report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "screenshot_remove_failed");
    }
  }
  return removed;
}

/**
 * The expectations of a new strategy version: the previous ones, each
 * engine's replaced by the write's entry for it when it has one.
 * @param {unknown} previous @param {unknown} given @returns {any[] | null}
 */
export function mergedExpectations(previous, given) {
  const before = Array.isArray(previous) ? previous.filter((entry) => entry && typeof entry === "object") : [];
  if (!Array.isArray(given)) return before.length ? before : null;
  const engines = new Set(given.map((entry) => entry?.engine));
  return [...before.filter((entry) => !engines.has(entry.engine)), ...given];
}

/** Whitespace-folded text, for deciding whether a claim changed. @param {unknown} value */
const folded = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * The texts a product is tagged from: its brand, its generic name and its indication.
 * @param {Record<string, any> | null | undefined} product
 */
const productTexts = (product) => [product?.brandName, product?.genericName, product?.indication].filter((value) => typeof value === "string" && value.trim());

export class GeoStore {
  /**
   * @param {{ database: any, statementTimeoutMs?: number, entityVocabulary?: { tag: (input: { texts: string[] }) => Promise<string[] | null> } | null }} options
   *   `entityVocabulary` tags a product; without it, or while it cannot tag, a project has no keys.
   */
  constructor({ database, statementTimeoutMs = STATEMENT_TIMEOUT_MS, entityVocabulary = null }) {
    if (!database) throw new TypeError("The GEO store needs the product database.");
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1) throw new TypeError("The statement timeout is a positive whole number of ms.");
    this.database = database;
    this.statementTimeoutMs = statementTimeoutMs;
    this.entityVocabulary = entityVocabulary;
  }

  /** The entity keys of a product, or null where there is no vocabulary or it cannot tag. @param {Record<string, any>} product */
  async #entityKeys(product) {
    return (await this.entityVocabulary?.tag({ texts: productTexts(product) })) ?? null;
  }

  /**
   * Tag the projects that carry no entity keys yet, `limit` at a time, from the
   * product each holds; `userId` narrows a pass to one account's projects. A
   * project whose product changed meanwhile is tagged by that change, not here.
   * @param {{ userId?: string | null, limit?: number }} [options]
   * @returns {Promise<{ tagged: number }>}
   */
  async backfillEntityKeys({ userId = null, limit = 100 } = {}) {
    if (!this.entityVocabulary) return { tagged: 0 };
    const rows = (await this.query(`SELECT id, user_id, product FROM evimed_geo.projects
      WHERE entity_keys IS NULL AND deleted_at IS NULL AND ($1::text IS NULL OR user_id = $1::text) ORDER BY id LIMIT $2`,
    [userId, Math.max(1, Math.min(500, Math.trunc(limit) || 100))])).rows;
    let tagged = 0;
    for (const row of rows) {
      const keys = await this.#entityKeys(row.product ?? {});
      if (!keys) break;
      const result = await this.query(`UPDATE evimed_geo.projects SET entity_keys = $3::text[]
        WHERE id = $1 AND user_id = $2 AND entity_keys IS NULL AND deleted_at IS NULL`, [row.id, row.user_id, keys]);
      tagged += result.rowCount ?? 0;
    }
    return { tagged };
  }

  ready() { return migrateGeo(this.database); }

  /**
   * One transaction with the module's own statement timeout.
   * @template T @param {(client: any) => Promise<T>} operation @returns {Promise<T>}
   */
  async transaction(operation) {
    await this.ready();
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
      return operation(client);
    });
  }

  /**
   * One statement under the module's statement timeout (in a transaction of
   * its own, since `SET LOCAL` needs one).
   * @param {string} sql @param {unknown[]} [values]
   */
  async query(sql, values = []) {
    return this.transaction((client) => client.query(sql, values));
  }

  // --- projects ---------------------------------------------------------------

  /**
   * @param {{ userId: string, projectId: string, engines: readonly string[], coverageDays: number, product?: Record<string, any> }} input
   */
  async createProject({ userId, projectId, engines, coverageDays, product = {} }) {
    const id = randomId("geo_");
    const result = await this.query(`INSERT INTO evimed_geo.projects (id, user_id, project_id, product, engines, coverage_days, entity_keys)
      VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6, $7::text[]) RETURNING ${PROJECT_COLUMNS}`,
    [id, userId, projectId, JSON.stringify(product), [...engines], coverageDays, await this.#entityKeys(product)]);
    return geoProjectFromRow(result.rows[0]);
  }

  /** This account's GEO project, or null (another account's, deleted, or none). @param {string} userId @param {string} id */
  async getProject(userId, id) {
    const result = await this.query(`SELECT ${PROJECT_COLUMNS} FROM evimed_geo.projects
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, userId]);
    return result.rows[0] ? geoProjectFromRow(result.rows[0]) : null;
  }

  /** The GEO project a control-plane project is, or null. @param {string} userId @param {string} projectId */
  async projectByControlProject(userId, projectId) {
    const result = await this.query(`SELECT ${PROJECT_COLUMNS} FROM evimed_geo.projects
      WHERE user_id = $1 AND project_id = $2 AND deleted_at IS NULL`, [userId, projectId]);
    return result.rows[0] ? geoProjectFromRow(result.rows[0]) : null;
  }

  /** @param {string} userId */
  async listProjects(userId) {
    const result = await this.query(`SELECT ${PROJECT_COLUMNS} FROM evimed_geo.projects
      WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id LIMIT 500`, [userId]);
    return result.rows.map(geoProjectFromRow);
  }

  /**
   * Change a project's settings; only the keys present move.
   * @param {string} userId @param {string} id
   * @param {{ coverageDays?: number, engines?: readonly string[], tier?: string, status?: string, product?: Record<string, any>,
   *   competitors?: any[], budget?: Record<string, any> | null }} patch
   */
  async updateProject(userId, id, patch) {
    /** @type {string[]} */
    const sets = [];
    /** @type {unknown[]} */
    const values = [id, userId];
    const put = (/** @type {string} */ column, /** @type {unknown} */ value, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.coverageDays !== undefined) put("coverage_days", patch.coverageDays);
    if (patch.engines !== undefined) put("engines", [...patch.engines], "::text[]");
    if (patch.tier !== undefined) put("tier", patch.tier);
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.product !== undefined) {
      put("product", JSON.stringify(patch.product), "::jsonb");
      // The keys describe the product they were made from: a changed product has new ones, or none until they can be made.
      put("entity_keys", await this.#entityKeys(patch.product), "::text[]");
    }
    if (patch.competitors !== undefined) put("competitors", JSON.stringify(patch.competitors), "::jsonb");
    if (patch.budget !== undefined) put("budget", patch.budget == null ? null : JSON.stringify(patch.budget), "::jsonb");
    if (!sets.length) return this.getProject(userId, id);
    const result = await this.query(`UPDATE evimed_geo.projects SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING ${PROJECT_COLUMNS}`, values);
    return result.rows[0] ? geoProjectFromRow(result.rows[0]) : null;
  }

  /**
   * Merge one step's fields atomically (two writers of two steps never lose
   * each other's). `updatedAt` is stamped here.
   * @param {string} id @param {string} step @param {Partial<GeoStep>} fields
   */
  async setStep(id, step, fields) {
    const patch = { ...fields, updatedAt: new Date().toISOString() };
    const result = await this.query(`UPDATE evimed_geo.projects
      SET steps = jsonb_set(coalesce(steps, '{}'::jsonb), ARRAY[$2::text], coalesce(steps -> $2::text, '{}'::jsonb) || $3::jsonb),
          updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING ${PROJECT_COLUMNS}`, [id, step, JSON.stringify(patch)]);
    return result.rows[0] ? geoProjectFromRow(result.rows[0]) : null;
  }

  /** Hide a GEO project (「删除」 on its page); the control-plane project and its conversations stay. @param {string} userId @param {string} id */
  async softDeleteProject(userId, id) {
    const result = await this.query(`UPDATE evimed_geo.projects SET deleted_at = now(), status = 'archived', updated_at = now()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, userId]);
    return (result.rowCount ?? 0) > 0;
  }

  // --- claims -------------------------------------------------------------------

  /**
   * The latest version of every claim, oldest first. Ordered in SQL: the
   * column keeps microseconds and a JavaScript time milliseconds, so claims
   * one write stamped within a millisecond sorted by key instead of by when
   * they were written.
   * @param {string} geoId
   */
  async listClaims(geoId) {
    const result = await this.query(`SELECT * FROM (SELECT DISTINCT ON (claim_key) * FROM evimed_geo.claims
      WHERE geo_project_id = $1 ORDER BY claim_key, version DESC) latest ORDER BY created_at, claim_key`, [geoId]);
    return result.rows.map(claimFromRow);
  }

  /** Every claim id of the project, any version. @param {string} geoId */
  async claimIds(geoId) {
    const result = await this.query(`SELECT id FROM evimed_geo.claims WHERE geo_project_id = $1`, [geoId]);
    return new Set(result.rows.map((/** @type {any} */ row) => String(row.id)));
  }

  /**
   * Write validated claims by key: a new key is version 1; a changed
   * statement, quote or source is the next version; otherwise the claim's
   * bookkeeping is updated in place.
   * @param {string} userId @param {string} geoId
   * @param {Array<{ claimKey: string, statement: string, quote: string, sourceRef: string, sourceLabel?: string | null, sourceKind?: string | null,
   *   evidenceLevel?: string | null, population?: string | null, inLabel?: boolean | null, elements?: Record<string, any>,
   *   verifiedAt?: string | null, validUntil?: string | null, status?: string, runId?: string | null }>} items
   * @returns {Promise<Array<{ id: string, claimKey: string, version: number, change: 'created' | 'versioned' | 'updated' }>>}
   */
  async upsertClaims(userId, geoId, items) {
    return this.transaction(async (client) => {
      /** @type {Array<{ id: string, claimKey: string, version: number, change: 'created' | 'versioned' | 'updated' }>} */
      const written = [];
      for (const item of items) {
        const latest = (await client.query(`SELECT * FROM evimed_geo.claims WHERE geo_project_id = $1 AND claim_key = $2
          ORDER BY version DESC LIMIT 1 FOR UPDATE`, [geoId, item.claimKey])).rows[0];
        const values = [item.sourceKind ?? null, item.evidenceLevel ?? null, item.population ?? null, item.inLabel ?? null,
          JSON.stringify(item.elements ?? {}), item.verifiedAt ?? null, item.validUntil ?? null, item.status ?? "active", item.runId ?? null,
          item.sourceLabel ?? null];
        const same = latest && folded(latest.statement) === folded(item.statement) && folded(latest.quote) === folded(item.quote)
          && folded(latest.source_ref) === folded(item.sourceRef);
        if (same) {
          await client.query(`UPDATE evimed_geo.claims SET source_kind = $2, evidence_level = $3, population = $4, in_label = $5,
            elements = $6::jsonb, verified_at = $7, valid_until = $8, status = $9, run_id = coalesce($10, run_id),
            source_label = coalesce($11, source_label), updated_at = now()
            WHERE id = $1`, [latest.id, ...values]);
          written.push({ id: String(latest.id), claimKey: item.claimKey, version: Number(latest.version), change: "updated" });
          continue;
        }
        const id = randomId("gcl_");
        const version = latest ? Number(latest.version) + 1 : 1;
        // clock_timestamp, not the transaction's now(): a write of thirty
        // claims lists them in the order they were written.
        await client.query(`INSERT INTO evimed_geo.claims (id, user_id, geo_project_id, claim_key, version, statement, quote, source_ref,
            source_kind, evidence_level, population, in_label, elements, verified_at, valid_until, status, run_id, source_label, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, clock_timestamp(), clock_timestamp())`,
        [id, userId, geoId, item.claimKey, version, item.statement, item.quote, item.sourceRef, ...values]);
        written.push({ id, claimKey: item.claimKey, version, change: latest ? "versioned" : "created" });
      }
      return written;
    });
  }

  // --- the question map ---------------------------------------------------------

  /** Every set version, newest first. @param {string} geoId */
  async questionSets(geoId) {
    const result = await this.query(`SELECT version, locked_at, measured_count, note, run_id, created_at FROM evimed_geo.question_sets
      WHERE geo_project_id = $1 ORDER BY version DESC`, [geoId]);
    return result.rows.map((/** @type {any} */ row) => ({
      version: Number(row.version), lockedAt: iso(row.locked_at), measuredCount: row.measured_count == null ? null : Number(row.measured_count),
      note: text(row.note), runId: text(row.run_id), createdAt: iso(row.created_at),
    }));
  }

  /** The groups of one set version, each with its questions. @param {string} geoId @param {number} version */
  async questionMap(geoId, version) {
    const groups = (await this.query(`SELECT * FROM evimed_geo.question_groups WHERE geo_project_id = $1 AND set_version = $2
      ORDER BY pool NULLS LAST, position, id`, [geoId, version])).rows.map(questionGroupFromRow);
    const questions = (await this.query(`SELECT * FROM evimed_geo.questions WHERE geo_project_id = $1 AND set_version = $2
      ORDER BY position, id`, [geoId, version])).rows.map(questionFromRow);
    const byGroup = new Map(groups.map((group) => [group.id, /** @type {ReturnType<typeof questionFromRow>[]} */ ([])]));
    for (const question of questions) byGroup.get(question.groupId)?.push(question);
    return groups.map((group) => ({ ...group, questions: byGroup.get(group.id) ?? [] }));
  }

  /** One question of the project, any version. @param {string} geoId @param {string} questionId */
  async question(geoId, questionId) {
    const result = await this.query(`SELECT * FROM evimed_geo.questions WHERE geo_project_id = $1 AND id = $2`, [geoId, questionId]);
    return result.rows[0] ? questionFromRow(result.rows[0]) : null;
  }

  /**
   * Write a new, unlocked set version from validated groups.
   * @param {string} userId @param {string} geoId
   * @param {{ groups: Array<Record<string, any> & { questions: Array<Record<string, any>> }>, note?: string | null, runId?: string | null }} input
   * @returns {Promise<{ version: number, groupIds: string[], questionIds: string[][] }>}
   */
  async writeQuestionSet(userId, geoId, { groups, note = null, runId = null }) {
    return this.transaction(async (client) => this.#insertSet(client, userId, geoId, { groups, note, runId, lockedAt: null, measuredCount: null }));
  }

  /**
   * @param {any} client @param {string} userId @param {string} geoId
   * @param {{ groups: Array<Record<string, any> & { questions: Array<Record<string, any>> }>, note: string | null, runId: string | null,
   *   lockedAt: string | null, measuredCount: number | null }} input
   */
  async #insertSet(client, userId, geoId, { groups, note, runId, lockedAt, measuredCount }) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('evimed-geo-set:' || $1))`, [geoId]);
    const version = Number((await client.query(`SELECT coalesce(max(version), 0) + 1 AS next FROM evimed_geo.question_sets
      WHERE geo_project_id = $1`, [geoId])).rows[0].next);
    await client.query(`INSERT INTO evimed_geo.question_sets (geo_project_id, version, user_id, locked_at, measured_count, note, run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [geoId, version, userId, lockedAt, measuredCount, note, runId]);
    const groupRows = [];
    const questionRows = [];
    /** @type {string[]} */
    const groupIds = [];
    /** @type {string[][]} */
    const questionIds = [];
    for (const [position, group] of groups.entries()) {
      const id = randomId("ggr_");
      groupIds.push(id);
      groupRows.push({ id, pool: group.pool ?? null, name: group.name ?? null, typical_question: group.typicalQuestion ?? null,
        journey_stage: group.journeyStage ?? null, audience: group.audience ?? null, bridge: group.bridge ?? null,
        weight: group.weight ?? null, is_control: group.isControl === true, signal: group.signal ?? null, position });
      /** @type {string[]} */
      const ids = [];
      for (const question of group.questions ?? []) {
        const questionId = randomId("gq_");
        ids.push(questionId);
        questionRows.push({ id: questionId, group_id: id, text: question.text, kind: question.kind ?? null,
          pool: question.pool ?? group.pool ?? null, platform: question.platform ?? null, source_url: question.sourceUrl ?? null,
          collected_at: question.collectedAt ?? null, is_measured: question.isMeasured === true, retired_at: question.retiredAt ?? null,
          position: questionRows.length });
      }
      questionIds.push(ids);
    }
    if (groupRows.length) {
      await client.query(`INSERT INTO evimed_geo.question_groups (id, user_id, geo_project_id, set_version, pool, name, typical_question,
          journey_stage, audience, bridge, weight, is_control, signal, position)
        SELECT g.id, $2, $3, $4, g.pool, g.name, g.typical_question, g.journey_stage, g.audience, g.bridge, g.weight, g.is_control, g.signal, g.position
        FROM jsonb_to_recordset($1::jsonb) AS g(id text, pool text, name text, typical_question text, journey_stage text, audience text,
          bridge text, weight numeric, is_control boolean, signal text, position integer)`, [JSON.stringify(groupRows), userId, geoId, version]);
    }
    if (questionRows.length) {
      await client.query(`INSERT INTO evimed_geo.questions (id, user_id, geo_project_id, group_id, set_version, text, kind, pool, platform,
          source_url, collected_at, is_measured, retired_at, position)
        SELECT q.id, $2, $3, q.group_id, $4, q.text, q.kind, q.pool, q.platform, q.source_url, q.collected_at, q.is_measured, q.retired_at, q.position
        FROM jsonb_to_recordset($1::jsonb) AS q(id text, group_id text, text text, kind text, pool text, platform text, source_url text,
          collected_at timestamptz, is_measured boolean, retired_at timestamptz, position integer)`, [JSON.stringify(questionRows), userId, geoId, version]);
    }
    return { version, groupIds, questionIds };
  }

  /** Lock a set version for measurement. @param {string} geoId @param {number} version @param {number} measuredCount */
  async lockQuestionSet(geoId, version, measuredCount) {
    const result = await this.query(`UPDATE evimed_geo.question_sets SET locked_at = coalesce(locked_at, now()), measured_count = $3
      WHERE geo_project_id = $1 AND version = $2 RETURNING version, locked_at, measured_count`, [geoId, version, measuredCount]);
    const row = result.rows[0];
    return row ? { version: Number(row.version), lockedAt: iso(row.locked_at), measuredCount: Number(row.measured_count) } : null;
  }

  /**
   * 「移出测量问句」: the latest set written again as the next version, that
   * question no longer measured, locked when its source was — and then only
   * if the copy still passes the lock rule `check` names (a set that loses its
   * only P4 question, say, is not a set measurement may run on).
   * @param {string} userId @param {string} geoId @param {string} questionId
   * @param {{ check?: ((groups: any[]) => string[]) | null }} [options] refusals of a locked copy, empty when it may be locked
   * @returns {Promise<{ version: number } | { stale: true } | { refused: string[] } | null>}
   *   null when the question is not this project's; `stale` when it is not in the latest version
   */
  async unmeasureQuestion(userId, geoId, questionId, { check = null } = {}) {
    const question = await this.question(geoId, questionId);
    if (!question) return null;
    const sets = await this.questionSets(geoId);
    if (sets[0]?.version !== question.setVersion) return { stale: true };
    const source = sets[0];
    const groups = await this.questionMap(geoId, question.setVersion);
    const copied = groups.map((group) => ({
      ...group,
      questions: group.questions.map((item) => ({ ...item, isMeasured: item.id === questionId ? false : item.isMeasured })),
    }));
    const measured = copied.reduce((sum, group) => sum + group.questions.filter((item) => item.isMeasured).length, 0);
    if (source.lockedAt && check) {
      const refusals = check(copied);
      if (refusals.length) return { refused: refusals };
    }
    return this.transaction(async (client) => {
      const written = await this.#insertSet(client, userId, geoId, {
        groups: copied, note: `unmeasure:${questionId}`, runId: null,
        lockedAt: source?.lockedAt ? new Date().toISOString() : null, measuredCount: source?.lockedAt ? measured : null,
      });
      return { version: written.version };
    });
  }

  // --- versioned documents: journey, strategy, placement plan ---------------------

  /** @param {"journeys" | "placement_plans"} table @param {string} geoId */
  async #latestDocument(table, geoId) {
    const row = (await this.query(`SELECT version, data, run_id, created_at FROM evimed_geo.${table}
      WHERE geo_project_id = $1 ORDER BY version DESC LIMIT 1`, [geoId])).rows[0];
    return row ? { version: Number(row.version), data: row.data ?? {}, runId: text(row.run_id), createdAt: iso(row.created_at) } : null;
  }

  /** @param {"journeys" | "placement_plans"} table @param {string} userId @param {string} geoId @param {Record<string, any>} data @param {string | null} runId */
  async #writeDocument(table, userId, geoId, data, runId) {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('evimed-geo-doc:' || $1 || ':' || $2))`, [table, geoId]);
      const version = Number((await client.query(`SELECT coalesce(max(version), 0) + 1 AS next FROM evimed_geo.${table}
        WHERE geo_project_id = $1`, [geoId])).rows[0].next);
      await client.query(`INSERT INTO evimed_geo.${table} (geo_project_id, version, user_id, data, run_id) VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [geoId, version, userId, JSON.stringify(data), runId]);
      return { version };
    });
  }

  /** @param {string} geoId */
  latestJourney(geoId) { return this.#latestDocument("journeys", geoId); }
  /** @param {string} userId @param {string} geoId @param {Record<string, any>} data @param {string | null} [runId] */
  writeJourney(userId, geoId, data, runId = null) { return this.#writeDocument("journeys", userId, geoId, data, runId); }
  /** @param {string} geoId */
  latestPlacementPlan(geoId) { return this.#latestDocument("placement_plans", geoId); }
  /** @param {string} userId @param {string} geoId @param {Record<string, any>} data @param {string | null} [runId] */
  writePlacementPlan(userId, geoId, data, runId = null) { return this.#writeDocument("placement_plans", userId, geoId, data, runId); }

  /** @param {string} geoId */
  async latestStrategy(geoId) {
    const row = (await this.query(`SELECT * FROM evimed_geo.strategy WHERE geo_project_id = $1 ORDER BY version DESC LIMIT 1`, [geoId])).rows[0];
    return row ? {
      version: Number(row.version), battlefield: row.battlefield ?? null, expectations: row.expectations ?? null, gaps: row.gaps ?? null,
      layout: row.layout ?? null, summary: text(row.summary), runId: text(row.run_id), createdAt: iso(row.created_at),
    } : null;
  }

  /**
   * The next strategy version: the latest one with what this write carries
   * laid over it. A field the write does not carry keeps its value (G4,
   * 2026-09-26: every write used to be a version of only its own fields, so
   * a write of the sources alone left a version with no battlefield and no
   * expectations — and the page and the program read only the latest).
   * Expectations are laid over per engine: a write about two engines leaves
   * the others' as they were.
   * @param {string} userId @param {string} geoId
   * @param {{ battlefield?: any, expectations?: any, gaps?: any, layout?: any, summary?: string | null, runId?: string | null }} fields
   */
  async writeStrategy(userId, geoId, fields) {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('evimed-geo-doc:strategy:' || $1))`, [geoId]);
      const latest = (await client.query(`SELECT * FROM evimed_geo.strategy WHERE geo_project_id = $1 ORDER BY version DESC LIMIT 1`, [geoId])).rows[0] ?? null;
      const version = Number(latest?.version ?? 0) + 1;
      const json = (/** @type {unknown} */ value) => (value === undefined || value === null ? null : JSON.stringify(value));
      const carried = (/** @type {"battlefield" | "gaps" | "layout"} */ key) => (fields[key] !== undefined ? fields[key] : latest?.[key] ?? null);
      const expectations = mergedExpectations(latest?.expectations ?? null, fields.expectations);
      await client.query(`INSERT INTO evimed_geo.strategy (geo_project_id, version, user_id, battlefield, expectations, gaps, layout, summary, run_id)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)`,
      [geoId, version, userId, json(carried("battlefield")), json(expectations), json(carried("gaps")), json(carried("layout")),
        fields.summary !== undefined ? fields.summary : text(latest?.summary), fields.runId ?? null]);
      return { version };
    });
  }

  // --- targets --------------------------------------------------------------------

  /** The latest targets version's rows. @param {string} geoId */
  async latestTargets(geoId) {
    const result = await this.query(`SELECT * FROM evimed_geo.targets WHERE geo_project_id = $1
      AND version = (SELECT max(version) FROM evimed_geo.targets WHERE geo_project_id = $1) ORDER BY tier, metric_id, pool`, [geoId]);
    if (!result.rows.length) return null;
    return {
      version: Number(result.rows[0].version),
      rows: result.rows.map((/** @type {any} */ row) => ({
        tier: String(row.tier), metricId: String(row.metric_id), pool: String(row.pool), baseline: num(row.baseline), target: num(row.target),
        horizonWeeks: row.horizon_weeks == null ? null : Number(row.horizon_weeks), placements: row.placements == null ? null : Number(row.placements),
        budgetCny: num(row.budget_cny), dataType: String(row.data_type),
      })),
    };
  }

  /**
   * One new targets version from validated rows (no duplicate tier/metric/pool).
   * @param {string} userId @param {string} geoId
   * @param {Array<{ tier: string, metricId: string, pool: string, baseline?: number | null, target?: number | null, horizonWeeks?: number | null,
   *   placements?: number | null, budgetCny?: number | null, dataType: string }>} rows
   */
  async writeTargets(userId, geoId, rows) {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('evimed-geo-doc:targets:' || $1))`, [geoId]);
      const version = Number((await client.query(`SELECT coalesce(max(version), 0) + 1 AS next FROM evimed_geo.targets
        WHERE geo_project_id = $1`, [geoId])).rows[0].next);
      await client.query(`INSERT INTO evimed_geo.targets (geo_project_id, version, user_id, tier, metric_id, pool, baseline, target, horizon_weeks,
          placements, budget_cny, data_type)
        SELECT $2, $3, $4, t.tier, t.metric_id, t.pool, t.baseline, t.target, t.horizon_weeks, t.placements, t.budget_cny, t.data_type
        FROM jsonb_to_recordset($1::jsonb) AS t(tier text, metric_id text, pool text, baseline numeric, target numeric, horizon_weeks integer,
          placements integer, budget_cny numeric, data_type text)`,
      [JSON.stringify(rows.map((row) => ({ tier: row.tier, metric_id: row.metricId, pool: row.pool, baseline: row.baseline ?? null,
        target: row.target ?? null, horizon_weeks: row.horizonWeeks ?? null, placements: row.placements ?? null,
        budget_cny: row.budgetCny ?? null, data_type: row.dataType }))), geoId, version, userId]);
      return { version };
    });
  }

  // --- sources ----------------------------------------------------------------------

  /** @param {string} geoId */
  async listSources(geoId) {
    const result = await this.query(`SELECT * FROM evimed_geo.sources WHERE geo_project_id = $1 ORDER BY domain LIMIT 2000`, [geoId]);
    return result.rows.map(geoSourceFromRow);
  }

  /**
   * Upsert the run-judged fields of sources by domain. The counts (`cited`,
   * mentions, wrong) are measured, and the market cell is the market's.
   * @param {string} userId @param {string} geoId
   * @param {Array<{ domain: string, name?: string | null, kind?: string | null, layer?: string | null, icpOwner?: string | null,
   *   icpMatches?: boolean | null, newsIndexed?: boolean | null, medicalVertical?: boolean | null, impostor?: boolean,
   *   blacklistReason?: string | null, checkedAt?: string | null }>} items
   */
  async upsertSources(userId, geoId, items) {
    return this.transaction(async (client) => {
      /** @type {string[]} */
      const ids = [];
      for (const item of items) {
        const result = await client.query(`INSERT INTO evimed_geo.sources (id, user_id, geo_project_id, domain, name, kind, layer, icp_owner,
            icp_matches, news_indexed, medical_vertical, impostor, blacklist_reason, checked_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (geo_project_id, domain) DO UPDATE SET name = coalesce(EXCLUDED.name, sources.name),
            kind = coalesce(EXCLUDED.kind, sources.kind), layer = coalesce(EXCLUDED.layer, sources.layer),
            icp_owner = coalesce(EXCLUDED.icp_owner, sources.icp_owner), icp_matches = coalesce(EXCLUDED.icp_matches, sources.icp_matches),
            news_indexed = coalesce(EXCLUDED.news_indexed, sources.news_indexed),
            medical_vertical = coalesce(EXCLUDED.medical_vertical, sources.medical_vertical), impostor = EXCLUDED.impostor,
            blacklist_reason = EXCLUDED.blacklist_reason, checked_at = coalesce(EXCLUDED.checked_at, sources.checked_at), updated_at = now()
          RETURNING id`,
        [randomId("gsrc_"), userId, geoId, item.domain, item.name ?? null, item.kind ?? null, item.layer ?? null, item.icpOwner ?? null,
          item.icpMatches ?? null, item.newsIndexed ?? null, item.medicalVertical ?? null, item.impostor === true, item.blacklistReason ?? null,
          item.checkedAt ?? null]);
        ids.push(String(result.rows[0].id));
      }
      return ids;
    });
  }

  // --- articles ---------------------------------------------------------------------

  /** @param {string} geoId */
  async listArticles(geoId) {
    const result = await this.query(`SELECT * FROM evimed_geo.articles WHERE geo_project_id = $1 ORDER BY created_at, path, id LIMIT 2000`, [geoId]);
    return result.rows.map(geoArticleFromRow);
  }

  /** @param {string} geoId @param {string} articleId */
  async getArticle(geoId, articleId) {
    const result = await this.query(`SELECT * FROM evimed_geo.articles WHERE geo_project_id = $1 AND id = $2`, [geoId, articleId]);
    return result.rows[0] ? geoArticleFromRow(result.rows[0]) : null;
  }

  /**
   * Register validated articles by their path. A draft or publishable article
   * is publishable exactly when its gate passed and no safety finding is open
   * (`geoArticlePublishable`, the same rule in SQL below); a placed, published
   * or withdrawn one keeps its status — its lifecycle belongs to the market
   * from there. A stored `open` safety stays open whatever the run says now:
   * only the release route clears it. `gate` is the platform's (the run
   * ledger's verdict on the deliverable), never the run's own claim.
   * @param {string} userId @param {string} geoId
   * @param {Array<{ path: string, layer: string, title?: string | null, groupId?: string | null, claimIds: string[], gate: string, safety: string,
   *   contentSha256?: string | null, protectedSha256?: string | null, deliverableId?: string | null, runId?: string | null }>} items
   */
  async registerArticles(userId, geoId, items) {
    return this.transaction(async (client) => {
      /** @type {string[]} */
      const ids = [];
      for (const item of items) {
        const status = geoArticlePublishable(item) ? "publishable" : "draft";
        const result = await client.query(`INSERT INTO evimed_geo.articles (id, user_id, geo_project_id, run_id, deliverable_id, path, layer, title,
            group_id, claim_ids, gate, safety, content_sha256, protected_sha256, status, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12, $13, $14, $15, clock_timestamp(), clock_timestamp())
          ON CONFLICT (geo_project_id, path) WHERE path IS NOT NULL DO UPDATE SET run_id = coalesce(EXCLUDED.run_id, articles.run_id),
            deliverable_id = coalesce(EXCLUDED.deliverable_id, articles.deliverable_id), layer = EXCLUDED.layer, title = EXCLUDED.title,
            group_id = EXCLUDED.group_id, claim_ids = EXCLUDED.claim_ids, gate = EXCLUDED.gate,
            safety = CASE WHEN articles.safety = 'open' THEN 'open' ELSE EXCLUDED.safety END,
            content_sha256 = EXCLUDED.content_sha256, protected_sha256 = EXCLUDED.protected_sha256,
            status = CASE WHEN articles.status NOT IN ('draft', 'publishable') THEN articles.status
              WHEN EXCLUDED.gate = 'passed' AND (CASE WHEN articles.safety = 'open' THEN 'open' ELSE EXCLUDED.safety END) IN ('clear', 'released')
                THEN 'publishable' ELSE 'draft' END,
            updated_at = now()
          RETURNING id`,
        [randomId("gart_"), userId, geoId, item.runId ?? null, item.deliverableId ?? null, item.path, item.layer, item.title ?? null,
          item.groupId ?? null, item.claimIds, item.gate, item.safety, item.contentSha256 ?? null, item.protectedSha256 ?? null, status]);
        ids.push(String(result.rows[0].id));
      }
      return ids;
    });
  }

  /**
   * A correction article registered for errors: each open error of the
   * project it names gets the article as material (once — a second
   * registration of the same article adds nothing) and moves from 待处理 to
   * 处置中 (`acting`). A closed error is left alone: it reopens only when an
   * engine says it again. Returns the errors that took the material.
   * @param {string} geoId @param {string[]} errorIds
   * @param {{ articleId: string, path: string, layer: string, title: string | null, runId: string | null }} material
   * @returns {Promise<string[]>}
   */
  async attachCorrection(geoId, errorIds, material) {
    if (!errorIds.length) return [];
    const entry = { kind: "article", ...material, at: new Date().toISOString() };
    const result = await this.query(`UPDATE evimed_geo.errors
      SET materials = coalesce(materials, '[]'::jsonb) || jsonb_build_array($3::jsonb),
          status = CASE WHEN status = 'open' THEN 'acting' ELSE status END,
          updated_at = now()
      WHERE geo_project_id = $1 AND id = ANY($2::text[]) AND status <> 'closed'
        AND NOT (coalesce(materials, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('articleId', $4::text)))
      RETURNING id`, [geoId, [...new Set(errorIds)], JSON.stringify(entry), material.articleId]);
    return result.rows.map((/** @type {any} */ row) => String(row.id));
  }

  /**
   * Every citation in the project's answers on one of `hosts`, prefiltered by
   * host in SQL; the caller compares each by its own key.
   * @param {string} geoId @param {Iterable<string>} hosts
   * @returns {Promise<Array<{ url: string, engine: string | null, askedAt: string | null }>>}
   */
  async #citationsOn(geoId, hosts) {
    const wanted = [...new Set([...hosts].filter(Boolean))];
    if (!wanted.length) return [];
    const rows = (await this.query(`SELECT s.engine, s.asked_at, c.value ->> 'url' AS url
      FROM evimed_geo.snapshots s
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.citations) = 'array' THEN s.citations ELSE '[]'::jsonb END) AS c(value)
      WHERE s.geo_project_id = $1 AND lower(c.value ->> 'url') LIKE ANY($2::text[])`,
    [geoId, wanted.map((host) => `%${host.replace(/[\\%_]/g, (character) => `\\${character}`)}%`)])).rows;
    return rows.map((/** @type {any} */ row) => ({ url: String(row.url ?? ""), engine: text(row.engine), askedAt: iso(row.asked_at) }));
  }

  /**
   * The articles whose published address an engine has cited, first seen per
   * engine — the address an order published it at, matched by the owner's URL
   * key (`canonicalGeoUrl`: no scheme, no `www.`, no query, no trailing slash,
   * because an engine cites `http://www.x.com/a/` for the `https://x.com/a`
   * the outlet returned), or a link the brand published it at itself
   * (`owned_links` naming the article), matched by the link's own key.
   * @param {string} geoId
   * @returns {Promise<Array<{ articleId: string, title: string | null, engine: string | null, firstSeen: string | null }>>}
   */
  async citedArticles(geoId) {
    const [published, owned] = await Promise.all([
      this.query(`SELECT DISTINCT o.article_id, o.published_url, a.title FROM evimed_geo.orders o
        LEFT JOIN evimed_geo.articles a ON a.id = o.article_id
        WHERE o.geo_project_id = $1 AND o.published_url IS NOT NULL AND o.article_id IS NOT NULL`, [geoId]),
      this.query(`SELECT l.article_id, l.url_key, a.title FROM evimed_geo.owned_links l
          JOIN evimed_geo.articles a ON a.id = l.article_id AND a.geo_project_id = l.geo_project_id
        WHERE l.geo_project_id = $1`, [geoId]),
    ]);
    /** @param {Map<string, { articleId: string, title: string | null }[]>} map @param {string} key @param {any} row */
    const add = (map, key, row) => {
      if (!key) return;
      const entries = map.get(key) ?? [];
      if (!entries.some((entry) => entry.articleId === String(row.article_id))) entries.push({ articleId: String(row.article_id), title: text(row.title) });
      map.set(key, entries);
    };
    /** @type {Map<string, { articleId: string, title: string | null }[]>} */
    const byKey = new Map();
    for (const row of published.rows) add(byKey, canonicalGeoUrl(row.published_url), row);
    /** @type {Map<string, { articleId: string, title: string | null }[]>} */
    const byOwnedKey = new Map();
    for (const row of owned.rows) add(byOwnedKey, String(row.url_key), row);
    const hosts = [...byKey.keys(), ...byOwnedKey.keys()].map((key) => key.split("/")[0]);
    /** @type {Map<string, { articleId: string, title: string | null, engine: string | null, firstSeen: string | null }>} */
    const first = new Map();
    for (const citation of await this.#citationsOn(geoId, hosts)) {
      const articles = [...(byKey.get(canonicalGeoUrl(citation.url)) ?? []), ...(byOwnedKey.get(geoOwnedLinkKey(citation.url).key) ?? [])];
      for (const article of articles) {
        const at = citation.askedAt;
        const id = `${article.articleId}\u0000${citation.engine ?? ""}`;
        const seen = first.get(id);
        if (!seen || (at && (!seen.firstSeen || at < seen.firstSeen))) first.set(id, { ...article, engine: citation.engine, firstSeen: at });
      }
    }
    return [...first.values()].sort((left, right) => String(left.firstSeen).localeCompare(String(right.firstSeen)));
  }

  /**
   * The links the brand published itself, live ones first, newest
   * publication first, each with the engines that cited it and when first.
   * @param {string} geoId
   * @returns {Promise<Array<ReturnType<typeof geoOwnedLinkFromRow> & { citedBy: Array<{ engine: string, firstSeen: string | null }> }>>}
   */
  async ownedLinks(geoId) {
    const rows = (await this.query(`SELECT * FROM evimed_geo.owned_links WHERE geo_project_id = $1
      ORDER BY (status = 'retired'), published_at DESC, id LIMIT $2`, [geoId, GEO_OWNED_LINKS_MAX])).rows;
    const keys = new Set(rows.map((/** @type {any} */ row) => String(row.url_key)));
    /** @type {Map<string, Map<string, string | null>>} */
    const cited = new Map();
    for (const citation of await this.#citationsOn(geoId, [...keys].map((key) => key.split("/")[0]))) {
      const key = geoOwnedLinkKey(citation.url).key;
      if (!citation.engine || !keys.has(key)) continue;
      const engines = cited.get(key) ?? new Map();
      const seen = engines.get(citation.engine);
      if (seen === undefined || (citation.askedAt && (!seen || citation.askedAt < seen))) engines.set(citation.engine, citation.askedAt);
      cited.set(key, engines);
    }
    return rows.map((/** @type {any} */ row) => ({
      ...geoOwnedLinkFromRow(row),
      citedBy: [...(cited.get(String(row.url_key)) ?? new Map()).entries()]
        .map(([engine, firstSeen]) => ({ engine, firstSeen }))
        .sort((left, right) => String(left.firstSeen).localeCompare(String(right.firstSeen))),
    }));
  }

  /**
   * Register links the brand published itself. One row per project and URL
   * key: registering the same page again updates it and makes it live again.
   * @param {string} userId @param {string} geoId
   * @param {Array<{ url: string, urlKey: string, platform: string, title: string, publishedAt: string, articleId: string | null,
   *   groupId: string | null, runId?: string | null }>} links
   * @returns {Promise<string[]>} the ids, in the order given
   */
  async upsertOwnedLinks(userId, geoId, links) {
    return this.transaction(async (client) => {
      /** @type {string[]} */
      const ids = [];
      for (const link of links) {
        const result = await client.query(`INSERT INTO evimed_geo.owned_links (id, user_id, geo_project_id, url, url_key, platform, title, published_at,
            article_id, group_id, run_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (geo_project_id, url_key) DO UPDATE SET url = EXCLUDED.url, platform = EXCLUDED.platform, title = EXCLUDED.title,
            published_at = EXCLUDED.published_at, article_id = EXCLUDED.article_id, group_id = EXCLUDED.group_id,
            run_id = coalesce(EXCLUDED.run_id, owned_links.run_id), status = 'active', retired_at = NULL, updated_at = now()
          RETURNING id`,
        [randomId("gol_"), userId, geoId, link.url, link.urlKey, link.platform, link.title, link.publishedAt, link.articleId, link.groupId,
          link.runId ?? null]);
        ids.push(String(result.rows[0].id));
      }
      return ids;
    });
  }

  /**
   * Retire links of this project, each named by its id (or, without one, its
   * URL key); a link already retired keeps the day it was. What names no link of this
   * project is `null` in the answer.
   * @param {string} geoId @param {Array<{ id: string | null, urlKey: string | null }>} refs
   * @returns {Promise<Array<string | null>>}
   */
  async retireOwnedLinks(geoId, refs) {
    return this.transaction(async (client) => {
      /** @type {Array<string | null>} */
      const ids = [];
      for (const ref of refs) {
        const result = await client.query(`UPDATE evimed_geo.owned_links SET status = 'retired', retired_at = coalesce(retired_at, now()),
            updated_at = CASE WHEN status = 'retired' THEN updated_at ELSE now() END
          WHERE geo_project_id = $1 AND CASE WHEN $2::text IS NOT NULL THEN id = $2 ELSE url_key = $3 END RETURNING id`, [geoId, ref.id, ref.urlKey]);
        ids.push(result.rows[0] ? String(result.rows[0].id) : null);
      }
      return ids;
    });
  }

  /**
   * What a registration is checked against: the project's articles with
   * their question group, its groups, and the URL keys it holds live.
   * @param {string} geoId
   */
  async ownedLinkContext(geoId) {
    const [articles, groups, live] = await Promise.all([
      this.query(`SELECT id, group_id FROM evimed_geo.articles WHERE geo_project_id = $1`, [geoId]),
      this.query(`SELECT id FROM evimed_geo.question_groups WHERE geo_project_id = $1`, [geoId]),
      this.query(`SELECT url_key FROM evimed_geo.owned_links WHERE geo_project_id = $1 AND status = 'active'`, [geoId]),
    ]);
    return {
      articles: new Map(articles.rows.map((/** @type {any} */ row) => [String(row.id), text(row.group_id)])),
      groupIds: new Set(groups.rows.map((/** @type {any} */ row) => String(row.id))),
      liveKeys: new Set(live.rows.map((/** @type {any} */ row) => String(row.url_key))),
    };
  }

  /**
   * Give an article registered by its path inside the deliverable folder
   * (`articles/<id>.md`) its workspace path, its deliverable and its run.
   * @param {string} geoId @param {string} articleId
   * @param {{ path: string, deliverableId: string, runId: string | null }} location
   * @returns {Promise<boolean>} false when another article already holds that path (this one stays as it was)
   */
  async relocateArticle(geoId, articleId, { path, deliverableId, runId }) {
    try {
      const update = await this.query(`UPDATE evimed_geo.articles SET path = $3, deliverable_id = $4, run_id = coalesce($5, run_id), updated_at = now()
        WHERE geo_project_id = $1 AND id = $2 AND path IS DISTINCT FROM $3 RETURNING id`, [geoId, articleId, path, deliverableId, runId]);
      return update.rows.length > 0;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "23505") return false;
      throw error;
    }
  }

  /**
   * The run an article was written in, when it was registered without one (a
   * run does not know its own id; the page opens an article by run and path).
   * @param {string} geoId @param {string} articleId @param {string} runId
   * @returns {Promise<boolean>}
   */
  async attachArticleRun(geoId, articleId, runId) {
    const update = await this.query(`UPDATE evimed_geo.articles SET run_id = $3, updated_at = now()
      WHERE geo_project_id = $1 AND id = $2 AND run_id IS NULL RETURNING id`, [geoId, articleId, runId]);
    return update.rows.length > 0;
  }

  /**
   * An article's gate as the run ledger now records it, and the status that
   * follows (publishable exactly when passed and no safety finding is open; a
   * placed or published article keeps its status). Articles are registered
   * while their run is still going, before the deliverable is submitted, so
   * the first read is `unverified`; the run's end is when the verdict exists.
   * @param {string} geoId @param {string} articleId @param {"passed" | "unverified" | "failed"} gate
   * @returns {Promise<ReturnType<typeof geoArticleFromRow> | null>} null when nothing changed
   */
  async refreshArticleGate(geoId, articleId, gate) {
    const update = await this.query(`UPDATE evimed_geo.articles
      SET gate = $3,
          status = CASE WHEN status IN ('draft', 'publishable')
            THEN CASE WHEN $3 = 'passed' AND safety IN ('clear', 'released') THEN 'publishable' ELSE 'draft' END
            ELSE status END,
          updated_at = now()
      WHERE geo_project_id = $1 AND id = $2 AND gate IS DISTINCT FROM $3
      RETURNING *`, [geoId, articleId, gate]);
    return update.rows[0] ? geoArticleFromRow(update.rows[0]) : null;
  }

  /**
   * Move an article's status or safety, only from the states given (a
   * compare-and-set, so a market transition in between is not overwritten).
   * @param {string} geoId @param {string} articleId
   * @param {{ status?: string, safety?: string, fromStatuses?: readonly string[], fromSafety?: readonly string[] }} change
   * @returns {Promise<ReturnType<typeof geoArticleFromRow> | null>} null when the article was not in an allowed state
   */
  async changeArticle(geoId, articleId, { status, safety, fromStatuses, fromSafety }) {
    const update = await this.query(`UPDATE evimed_geo.articles
      SET safety = coalesce($4, safety),
          status = CASE
            WHEN $3::text IS NOT NULL THEN $3::text
            WHEN $4::text IS NOT NULL AND status IN ('draft', 'publishable') THEN
              CASE WHEN gate = 'passed' AND $4::text IN ('clear', 'released') THEN 'publishable' ELSE 'draft' END
            ELSE status END,
          updated_at = now()
      WHERE geo_project_id = $1 AND id = $2
        AND ($5::text[] IS NULL OR status = ANY($5::text[]))
        AND ($6::text[] IS NULL OR safety = ANY($6::text[]))
      RETURNING *`, [geoId, articleId, status ?? null, safety ?? null, fromStatuses ? [...fromStatuses] : null, fromSafety ? [...fromSafety] : null]);
    return update.rows[0] ? geoArticleFromRow(update.rows[0]) : null;
  }
}
