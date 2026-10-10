/**
 * 「循证 GEO」's upkeep of each project's value profile: the housekeeping that keeps what the profile accumulates bounded (G10c), and
 * the consumer that tells a profile when a source one of its findings rests on has been retracted or corrected (G10e).
 *
 * A profile is written as a new version whenever its content really changes, and every version stores the whole merged profile,
 * so a project the research programme works on for months holds hundreds of copies. The owner ruled on 2026-10-10 which to keep:
 * the latest twenty, and the milestones — a version another stored object points to, and the first version of each calendar month.
 * Everything else is pruned.
 *
 * The profile reacted to one kind of change in a source: a knowledge-base file that was replaced (`geoValueSourceReplaced`). The platform
 * keeps one fact per source identifier — whether a published work was retracted, corrected or put under an expression of concern
 * (`sourceChanges.mjs`) — and the frontier feed flags the items it carries for the same notices; the owner ruled that a source a finding
 * rests on being retracted or corrected flags that finding too. The watch below is a consumer and nothing else: it adds a
 * `sourceChanges` entry to the profile, `needs_review`, in the shape the replaced-file entry has, and asks nothing of anyone —
 * no form, no block, no notice. What a changed source means for the finding is the researcher's and the model's to argue.
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
 * - **A finding rests on the sources it names, and on those of the claims it links.** The identifiers are read where they are written
 *   (`sources`, `sourceRef`, `sourceId`, `sourceRefs`, a DOI, a PMID or a registry number on the finding or on a source, and a linked
 *   claim's `sourceRef`) in the one form the platform compares (`canonicalSourceIdentifier`); a knowledge-base id or a label is no
 *   identifier and is not looked up. A retraction, withdrawal, expression of concern or correction found for one — in the source-change
 *   record, or as a flag on a published frontier item that names it — becomes one entry, `change:<identifier>:<kind>`, linking the
 *   findings by id (`findingIds`), so the page's count of changed sources and the impact list reach them as they reach a replaced file.
 *   A new version of a work is news about it, not a warning, and is not read.
 * - **Written once, and left to the researcher after.** An entry that is already in the profile is not written again, whatever status the
 *   researcher gave it since; a finding added later that rests on the same source is linked to an entry that still asks for a look.
 *   A source that failed to be read, a store that is not there, or a frontier that is off is counted and the pass goes on: nothing is
 *   invented for the source that could not be asked about.
 * - **A bounded number of projects a tick, in turn.** The project looked at longest ago first (`watch:sources`, a mark of the module's
 *   own), `OPEN_SCIENCE_GEO_SOURCE_WATCH_PROJECTS_PER_TICK` at most, so a project past the bound is reached by a later tick.
 *
 * @module geoValueUpkeep
 */

import {
  SOURCE_CHANGE_NOTICE_KINDS, canonicalSourceIdentifier, geoValueActive, geoValueList, geoValueObject, sourceIdentifierScheme,
} from "@evimed/domain";
import { FRONTIER_MATCH_MAX_LIMIT } from "./entityVocabulary.mjs";
import { sourceIdentifiersOf } from "./sourceChanges.mjs";

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
 * (a result carries the version its request was made on). $1 is the project. A union, not a concatenation: a project's answers are
 * thousands of rows and name a handful of versions, and what is held for the comparison is the versions.
 */
const POINTED = [
  ...GEO_VALUE_REFERENCES.map((reference) => `SELECT ${numberOf(reference.value)} AS v FROM evimed_geo.${reference.table} WHERE geo_project_id = $1`),
  `SELECT ${numberOf("entry -> 'basisVersion'")} AS v FROM evimed_geo.value_profiles latest
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(latest.data -> 'researchResults') = 'array' THEN latest.data -> 'researchResults' ELSE '[]'::jsonb END) entry
    WHERE latest.geo_project_id = $1 AND latest.version = (SELECT max(version) FROM evimed_geo.value_profiles WHERE geo_project_id = $1) AND jsonb_typeof(entry) = 'object'`,
].join("\n      UNION ");

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

/** What each notice says of a source, in the profile's words: the reason an entry carries and the clause of its sentence. */
const CHANGE = Object.freeze(/** @type {Record<string, { reason: string, says: string }>} */ ({
  retraction: { reason: "source_retracted", says: "已被撤稿" },
  withdrawal: { reason: "source_retracted", says: "已被撤回" },
  correction: { reason: "source_corrected", says: "有更正" },
  concern: { reason: "source_concern", says: "被编辑部发出关注声明" },
}));

/** The notice a flag of a frontier item stands for: the pipeline flags a published item when a notice names it (`FRONTIER_ITEM_FLAGS`). */
const FLAG_KIND = Object.freeze(/** @type {Record<string, string>} */ ({ retracted: "retraction", corrected: "correction", "expression-of-concern": "concern" }));

/** Identifiers asked about at a time: what the frontier's own match takes (64), and well inside what the source-change record takes (500). */
const BATCH = 64;

/** A reference in the one form the platform compares sources by, or null when it is no identifier (a label, a knowledge-base id). @param {unknown} value */
const identifierOf = (value) => canonicalSourceIdentifier(typeof value === "number" ? String(value) : value);
/** A PMID written as digits, which is what a `pmid` field holds, in that form; anything else as `identifierOf` reads it. @param {unknown} value */
const pmidOf = (value) => (/^\d{1,10}$/.test(String(value ?? "").trim()) ? `pmid:${String(value).trim()}` : identifierOf(value));

/**
 * Every source a finding rests on, as the identifiers the platform watches: what it names itself (`sourceRef`, `sourceId`, `sourceRefs`, a DOI,
 * a PMID or a registry number on it, and its `sources`, each a reference or an object with a link, a DOI, a PMID or a registry number),
 * and the source of each claim it links. A knowledge-base id, a label or a page that is no identifier of a work names nothing here.
 * @param {Record<string, any>} finding @param {Map<string, string>} [claimRefs] a linked claim's id → its `sourceRef`
 * @returns {Set<string>}
 */
export function findingIdentifiers(finding, claimRefs = new Map()) {
  /** @type {Set<string>} */
  const found = new Set();
  const add = (/** @type {string | null} */ identifier) => { if (identifier) found.add(identifier); };
  for (const value of [finding.sourceRef, finding.sourceId, finding.doi, finding.url, finding.registryId, ...geoValueList(finding.sourceRefs), ...geoValueList(finding.registryIds)]) add(identifierOf(value));
  add(pmidOf(finding.pmid));
  for (const source of geoValueList(finding.sources)) {
    if (typeof source === "string") add(identifierOf(source));
    else if (geoValueObject(source)) {
      for (const identifier of sourceIdentifiersOf(source)) add(identifier);
      add(identifierOf(source.sourceRef));
      add(identifierOf(source.sourceId));
      add(pmidOf(source.pmid));
    }
  }
  for (const claimId of geoValueList(finding.claimIds)) add(identifierOf(claimRefs.get(String(claimId))));
  return found;
}

/** A source as a reader names it. @param {string} identifier */
function sourceName(identifier) {
  const rest = identifier.slice(identifier.indexOf(":") + 1);
  const scheme = sourceIdentifierScheme(identifier);
  return scheme === "doi" ? `DOI ${rest}` : scheme === "pmid" ? `PMID ${rest}` : scheme === "reg" ? `注册号 ${rest}` : rest;
}

/**
 * The entry a changed source adds to a profile's `sourceChanges`: the shape the replaced-file entry has (`geoValueSourceReplaced` — an id,
 * the time, a sentence, `needs_review`, a reason), with the findings it reaches linked by id, so the page's impacts and the count of changed
 * sources reach them as they reach a replaced file. One entry for a source and a kind of notice, whoever saw it first.
 * @param {{ identifier: string, kind: string, findingIds: string[], at: string, notice?: string | null, detectedBy: string }} input
 */
export function sourceChangeEntry({ identifier, kind, findingIds, at, notice = null, detectedBy }) {
  const change = CHANGE[kind];
  return { id: `change:${identifier}:${kind}`, kind, sourceRef: identifier, findingIds, at, summary: `${sourceName(identifier)} ${change.says}，可检查引用它的结论与内容。`,
    status: "needs_review", reason: change.reason, ...(notice ? { noticeIdentifier: notice } : {}), detectedBy };
}

/** The projects whose turn it is: with a profile, the one looked at longest ago first (`watch:sources`, a mark of the module's own). $1 is the bound. */
const WATCH_TURN = `SELECT p.id, p.user_id FROM evimed_geo.projects p
  LEFT JOIN evimed_geo.schedule_marks m ON m.geo_project_id = p.id AND m.key = 'watch:sources'
  WHERE p.deleted_at IS NULL AND NOT p.internal AND EXISTS (SELECT 1 FROM evimed_geo.value_profiles v WHERE v.geo_project_id = p.id)
  ORDER BY m.updated_at NULLS FIRST, p.created_at, p.id LIMIT $1`;

/**
 * The upkeep as one worker loop: a tick prunes, then watches. Each pass is isolated — one that throws is counted and reported and does not stop the next.
 * @param {{ store: any, sourceChanges?: { getMany?: (identifiers: unknown[]) => Promise<Map<string, any>> } | null,
 *   entityVocabulary?: { frontierItemsMatching?: (query: any) => Promise<any[]> } | null, config?: Record<string, any>,
 *   now?: () => Date, report?: (code: string) => void }} dependencies
 *   `sourceChanges` is the platform's record of what was published about a work (`sourceChanges.mjs`) and `entityVocabulary` reads the frontier feed's
 *   items by identifier; without both the watch has nothing to ask and does not run.
 */
export function createGeoValueUpkeep({ store, sourceChanges = null, entityVocabulary = null, config = {}, now = () => new Date(), report = () => {} }) {
  if (!store) throw new TypeError("The value upkeep needs the GEO store.");
  const keep = Number.isSafeInteger(config.geoValueKeepVersions) && config.geoValueKeepVersions >= 1 ? config.geoValueKeepVersions : 20;
  const perTick = Number.isSafeInteger(config.geoValuePrunePerTick) && config.geoValuePrunePerTick >= 1 ? config.geoValuePrunePerTick : 200;
  const watchPerTick = Number.isSafeInteger(config.geoSourceWatchProjectsPerTick) && config.geoSourceWatchProjectsPerTick >= 1 ? config.geoSourceWatchProjectsPerTick : 20;
  const timeZone = String(config.geoTimeZone || "Asia/Shanghai");
  const counters = { ticks: 0, projectsChecked: 0, versionsPruned: 0, projectsPruned: 0,
    watchProjects: 0, watchIdentifiers: 0, changesFlagged: 0, changesExtended: 0, projectsFlagged: 0, failures: 0 };
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

  /**
   * What is on record against each of these sources: the notices of the source-change record, and the notices a published frontier item that
   * names the source is flagged with. One entry per source and kind of notice; the record is read first, so its time and notice stand.
   * @param {string[]} identifiers @param {boolean} frontier whether the frontier's tables are there to ask
   * @returns {Promise<Map<string, { identifier: string, kind: string, notice: string | null, at: string | null, by: string }>>}
   */
  async function heardAbout(identifiers, frontier) {
    /** @type {Map<string, { identifier: string, kind: string, notice: string | null, at: string | null, by: string }>} */
    const heard = new Map();
    const take = (/** @type {string} */ identifier, /** @type {string} */ kind, /** @type {string | null} */ notice, /** @type {string | null} */ at, /** @type {string} */ by) => {
      const key = `${identifier}\u0000${kind}`;
      if (!heard.has(key)) heard.set(key, { identifier, kind, notice, at, by });
    };
    for (let start = 0; start < identifiers.length; start += BATCH) {
      const batch = identifiers.slice(start, start + BATCH);
      if (sourceChanges?.getMany) {
        try {
          for (const [identifier, fact] of await sourceChanges.getMany(batch)) {
            for (const change of geoValueList(fact?.changes)) {
              if (SOURCE_CHANGE_NOTICE_KINDS.includes(change?.kind)) take(identifier, change.kind, change.noticeIdentifier ?? null, change.firstSeenAt ?? null, "source_changes");
            }
          }
        } catch (error) { counters.failures += 1; report(`watch:source_changes:${codeOf(error)}`); }
      }
      if (frontier && entityVocabulary?.frontierItemsMatching) {
        try {
          for (const item of await entityVocabulary.frontierItemsMatching({ identifierKeys: batch, limit: FRONTIER_MATCH_MAX_LIMIT })) {
            const kinds = geoValueList(item?.flags).map((flag) => FLAG_KIND[String(flag)]).filter(Boolean);
            for (const identifier of geoValueList(item?.matchedIdentifierKeys)) for (const kind of kinds) take(String(identifier), kind, null, item.timelineAt ?? null, "frontier");
          }
        } catch (error) { counters.failures += 1; report(`watch:frontier:${codeOf(error)}`); }
      }
    }
    return heard;
  }

  /**
   * One project: what its findings rest on, what is on record against it, and the entries the profile does not have yet.
   * @param {{ id: string, user_id: string }} project @param {boolean} frontier
   */
  async function watchProject(project, frontier) {
    const profile = await store.latestValue(project.id);
    const data = profile.data ?? {};
    const findings = geoValueList(data.findings).filter((entry) => geoValueObject(entry) && entry.id && geoValueActive(entry));
    if (!findings.length) return;
    const claimIds = [...new Set(findings.flatMap((finding) => geoValueList(finding.claimIds).map(String)))];
    const claimRefs = new Map(claimIds.length
      ? (await store.query("SELECT id, source_ref FROM evimed_geo.claims WHERE geo_project_id = $1 AND id = ANY($2::text[])", [project.id, claimIds]))
        .rows.map((/** @type {any} */ row) => [String(row.id), String(row.source_ref ?? "")]) : []);
    /** What the findings rest on: each source, with the findings that name it. @type {Map<string, Set<string>>} */
    const resting = new Map();
    for (const finding of findings) {
      for (const identifier of findingIdentifiers(finding, claimRefs)) {
        if (!resting.has(identifier)) resting.set(identifier, new Set());
        /** @type {Set<string>} */ (resting.get(identifier)).add(String(finding.id));
      }
    }
    counters.watchIdentifiers += resting.size;
    if (!resting.size) return;
    const existing = new Map(geoValueList(data.sourceChanges).filter(geoValueObject).map((entry) => [String(entry.id), entry]));
    /** @type {Array<Record<string, any>>} */
    const patch = [];
    let added = 0;
    let extended = 0;
    for (const heard of (await heardAbout([...resting.keys()], frontier)).values()) {
      const findingIds = [.../** @type {Set<string>} */ (resting.get(heard.identifier))].sort();
      const entry = sourceChangeEntry({ identifier: heard.identifier, kind: heard.kind, findingIds, at: heard.at ?? now().toISOString(), notice: heard.notice, detectedBy: heard.by });
      const known = existing.get(entry.id);
      if (!known) {
        patch.push(entry);
        added += 1;
      } else if (geoValueActive(known)) {
        // A change the researcher has dealt with is theirs; one that still asks for a look reaches a finding written since.
        const linked = new Set(geoValueList(known.findingIds).map(String));
        if (findingIds.some((id) => !linked.has(id))) {
          patch.push({ id: entry.id, findingIds: [...new Set([...linked, ...findingIds])].sort() });
          extended += 1;
        }
      }
    }
    if (!patch.length) return;
    await store.writeValue(String(project.user_id), project.id, { sourceChanges: patch });
    // Counted once it is in the profile: a write that failed added nothing.
    counters.changesFlagged += added;
    counters.changesExtended += extended;
    counters.projectsFlagged += 1;
  }

  /** The watch over the projects whose turn it is, within the tick's bound. */
  async function watch() {
    const counts = { projects: 0, flagged: 0 };
    if (!sourceChanges?.getMany && !entityVocabulary?.frontierItemsMatching) return counts;
    const turn = (await store.query(WATCH_TURN, [watchPerTick])).rows;
    if (!turn.length) return counts;
    let frontier = false;
    if (entityVocabulary?.frontierItemsMatching) {
      try { frontier = (await store.query("SELECT to_regclass('evimed_frontier.item_keys') IS NOT NULL AS present")).rows[0]?.present === true; }
      catch { frontier = false; }
    }
    const before = counters.changesFlagged;
    for (const project of turn) {
      counts.projects += 1;
      counters.watchProjects += 1;
      try { await watchProject(project, frontier); }
      catch (error) { counters.failures += 1; report(`watch:${codeOf(error)}`); }
      // Every project that had its turn goes behind the others, whatever came of it: one that fails every tick must not sit at the front for good.
      try {
        await store.query(`INSERT INTO evimed_geo.schedule_marks (geo_project_id, key, user_id, kind, state, done_at) VALUES ($1, 'watch:sources', $2, 'request', 'done', now())
          ON CONFLICT (geo_project_id, key) DO UPDATE SET updated_at = now(), done_at = now()`, [project.id, String(project.user_id)]);
      } catch (error) { report(`watch:turn:${codeOf(error)}`); }
    }
    counts.flagged = counters.changesFlagged - before;
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
      let watched = { projects: 0, flagged: 0 };
      try { watched = await watch(); }
      catch (error) { counters.failures += 1; report(`watch:${codeOf(error)}`); }
      return { projectsChecked: pruned.checked, versionsPruned: pruned.pruned, projectsPruned: pruned.projects,
        watchProjects: watched.projects, changesFlagged: watched.flagged };
    },
    metrics() {
      return { ...counters };
    },
  };
}
