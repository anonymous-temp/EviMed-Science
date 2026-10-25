/** One authorized observation selection for GEO pages, the native read tool and exports. No metric formulas live here. */
import { compareGeoMetricCohorts, geoComparisonContractsMatch, geoComparisonKey as comparisonKey, geoComparableAnswer as comparableAnswer } from "./geoComparison.mjs";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { GEO_ENGINES, GEO_POOLS, GEO_MEASUREMENT_METHOD_VERSION, geoMetricMembers, geoJudgementCoverage,
  GEO_ERROR_STATUSES, GEO_ERROR_TYPES, GEO_SEVERITIES, geoCoverageKey } from "@evimed/domain";
import { computeRoundCells } from "./geoMetricsJob.mjs";
import { GeoMeasureStore } from "./geoMeasureStore.mjs";
import { HttpError } from "./security.mjs";

export const GEO_SCOPE_FIELDS = Object.freeze(["round", "from", "to", "compareFrom", "compareTo", "comparisonMode", "engines", "questionVersion",
  "groupIds", "pools", "clientTags", "timeZone", "timezone", "engine", "version", "pool", "groupId", "selectionRef"]);
export const GEO_ERROR_FILTER_FIELDS = Object.freeze(["errorStatuses", "errorSeverities", "errorTypes", "errorSearch", "errorLimit", "errorOffset", "questionId", "errorTrace", "errorJudgmentState", "errorFingerprint"]);
export const GEO_SOURCE_PAGE_FIELDS = Object.freeze(["answerLimit", "answerOffset"]);
export const GEO_SELECTION_MAX_ROWS = 20_000;
export const GEO_SELECTION_MAX_ROUNDS = 120;
export const GEO_MEMBER_PREVIEW_LIMIT = 200;
export const GEO_READ_PAGE_LIMIT = 50;
const ROUND_KINDS = ["baseline", "weekly", "single_step"];
const hasControls = (/** @type {string} */ value) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const idShape = /^[A-Za-z0-9_-]{1,80}$/u;
const digest = (/** @type {unknown} */ value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = (/** @type {string} */ message, status = 400) => new HttpError(status, "geo_read_filter_invalid", message);
const readTransactions = new AsyncLocalStorage();

/** @param {import('./geoStore.mjs').GeoStore} store */
export const geoReadTransactionActive = (store) => readTransactions.getStore()?.database === store.database;

/** Keep selection, aggregates and drilldown detail on one snapshot. Persist references after committing the read so concurrent
 * first readers of the same selection can safely converge on its deterministic id.
 * @template T @param {import('./geoStore.mjs').GeoStore} store @param {() => Promise<T>} operation @returns {Promise<T>}
 */
export async function withGeoReadTransaction(store, operation) {
  if (geoReadTransactionActive(store)) return operation();
  const database = /** @type {any} */ (store.database);
  await new GeoMeasureStore(database).ready();
  /** @type {Map<string, any>} */ const references = new Map();
  const result = await database.transaction(async (/** @type {any} */ client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL statement_timeout = '5s'");
    return database.withTransactionClient(client, () => readTransactions.run({ database, references }, operation));
  });
  for (const { selected, project } of references.values()) await store.query(`INSERT INTO evimed_geo.read_selections (id, user_id, geo_project_id, scope, round_ids, data_revision, subset)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb) ON CONFLICT (id) DO NOTHING`,
  [selected.selection.reference, project.userId, project.id, JSON.stringify(selected.scope), JSON.stringify(selected.selection.roundIds), selected.selection.dataRevision, JSON.stringify(selected.subset)]);
  return result;
}

/** @param {unknown} raw @param {string} field @param {readonly string[] | null} [vocabulary] @param {boolean} [tags] */
function values(raw, field, vocabulary = null, tags = false) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? tags ? [raw] : raw.split(",") : null;
  if (!list || list.length > 100 || list.some((value) => typeof value !== "string" || !value.trim() || value.length > (tags ? 120 : 80)
    || (tags ? [...value].some((character) => character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0))) : hasControls(value)) || (vocabulary ? !vocabulary.includes(value) : !tags && !idShape.test(value)))) {
    throw invalid(`${field} must contain valid ${tags ? "text labels" : "distinct identifiers"}.`);
  }
  return [...new Set(list.map((value) => tags ? value : value.trim()))].sort();
}

/** Closed normalization shared by URL and native JSON reads. Same dimension OR, different dimensions AND.
 * @param {unknown} [input] */
export function normalizeGeoReadScope(input = {}) {
  const raw = /** @type {Record<string, any>} */ (typeof input === "string" ? { round: input } : input ?? {});
  if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !GEO_SCOPE_FIELDS.includes(key))) throw invalid("Unknown GEO selection field.");
  const alias = (/** @type {string} */ name, /** @type {string} */ old) => {
    if (raw[name] != null && raw[old] != null) throw invalid(`Use ${name} or ${old}, not both.`);
    return raw[name] ?? raw[old] ?? null;
  };
  const timeZone = alias("timeZone", "timezone") ?? "Asia/Shanghai";
  if (typeof timeZone !== "string" || timeZone.length > 80) throw invalid("timeZone must be an IANA time zone.");
  try { new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(0)); } catch { throw invalid("timeZone must be an IANA time zone."); }
  const date = (/** @type {string} */ name) => {
    const value = raw[name];
    if (value == null || value === "") return null;
    if (typeof value !== "string" || value.startsWith("0000-") || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(`${name} must be a real YYYY-MM-DD date.`);
    return value;
  };
  const from = date("from"), to = date("to"), compareFrom = date("compareFrom"), compareTo = date("compareTo");
  if (from && to && from > to || compareFrom && compareTo && compareFrom > compareTo) throw invalid("The start date must not follow the end date.");
  if (Boolean(compareFrom) !== Boolean(compareTo)) throw invalid("A comparison needs compareFrom and compareTo.");
  const questionVersion = alias("questionVersion", "version");
  if (questionVersion != null && (!Number.isSafeInteger(questionVersion) || questionVersion < 1)) throw invalid("questionVersion must be a positive integer.");
  for (const key of ["round", "selectionRef"]) if (raw[key] != null && (typeof raw[key] !== "string" || !idShape.test(raw[key]))) throw invalid(`${key} must be an identifier.`);
  if (raw.comparisonMode != null && !["common", "separate"].includes(raw.comparisonMode)) throw invalid("comparisonMode must be common or separate.");
  return { round: raw.round ?? null, from, to, compareFrom, compareTo, comparisonMode: raw.comparisonMode ?? "common", timeZone,
    engines: values(alias("engines", "engine"), "engines", GEO_ENGINES), questionVersion,
    groupIds: values(alias("groupIds", "groupId"), "groupIds"), pools: values(alias("pools", "pool"), "pools", GEO_POOLS),
    clientTags: values(raw.clientTags, "clientTags", null, true), selectionRef: raw.selectionRef ?? null };
}

/** @param {URLSearchParams} query @param {readonly string[]} [extra]
 * @returns {ReturnType<typeof normalizeGeoReadScope> & Record<string, any>}
 */
export function geoScopeFromQuery(query, extra = GEO_ERROR_FILTER_FIELDS) {
  /** @type {Record<string, any>} */ const raw = {};
  const lists = new Set(["engines", "pools", "groupIds", "clientTags", "errorStatuses", "errorSeverities", "errorTypes"]);
  for (const key of new Set(query.keys())) {
    if (![...GEO_SCOPE_FIELDS, ...extra].includes(key)) throw invalid(`Unknown GEO query field: ${key}.`);
    const all = query.getAll(key);
    if (!lists.has(key) && all.length !== 1) throw invalid(`${key} may only be given once.`);
    raw[key] = lists.has(key) ? key === "clientTags" ? all : all.flatMap((value) => value.split(",")) : all[0];
    if (["questionVersion", "version", "strategyVersion", "targetVersion", "errorLimit", "errorOffset", "limit", "offset", "topN", ...GEO_SOURCE_PAGE_FIELDS].includes(key)) {
      if (!/^\d+$/u.test(raw[key])) throw invalid(`${key} must be a whole number.`);
      raw[key] = Number(raw[key]);
    }
  }
  const scope = normalizeGeoReadScope(Object.fromEntries(Object.entries(raw).filter(([key]) => GEO_SCOPE_FIELDS.includes(key))));
  return { ...scope, ...Object.fromEntries(Object.entries(raw).filter(([key]) => extra.includes(key))) };
}

/** @param {Record<string, any>} [input] */
export function geoErrorFilters(input = {}) {
  const integer = (/** @type {string} */ key, fallback = 0, max = 100_000) => {
    const n = input[key] ?? fallback;
    if (!Number.isSafeInteger(n) || n < (key === "errorLimit" ? 1 : 0) || n > max) throw invalid(`${key} is outside the supported page range.`);
    return n;
  };
  const search = input.errorSearch ?? "";
  if(input.errorFingerprint!=null&&(typeof input.errorFingerprint!=="string"||!input.errorFingerprint.trim()||input.errorFingerprint.length>240||hasControls(input.errorFingerprint)))throw invalid("errorFingerprint must be an exact bounded group key.");
  if (input.questionId != null && (typeof input.questionId !== "string" || !idShape.test(input.questionId))) throw invalid("questionId must be an identifier.");
  if (typeof search !== "string" || search.length > 240 || hasControls(search)) throw invalid("errorSearch must be short text.");
  if (input.errorTrace != null && !["traced", "unattributable", "noRetrieval"].includes(input.errorTrace)) throw invalid("errorTrace is unsupported.");
  if (input.errorJudgmentState != null && !["active", "withdrawn"].includes(input.errorJudgmentState)) throw invalid("errorJudgmentState is unsupported.");
  return { fingerprint:input.errorFingerprint??null, judgmentState: input.errorJudgmentState ?? null, trace: input.errorTrace ?? null, statuses: values(input.errorStatuses, "errorStatuses", GEO_ERROR_STATUSES), severities: values(input.errorSeverities, "errorSeverities", GEO_SEVERITIES),
    types: values(input.errorTypes, "errorTypes", [...GEO_ERROR_TYPES, "unknown"]), questionId: input.questionId ?? null, search: search.trim(), limit: integer("errorLimit", 100, 500), offset: integer("errorOffset") };
}

/** @param {any} input */
export function geoSourcePage(input = {}) {
  const limit = input.answerLimit ?? 200, offset = input.answerOffset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset > GEO_SELECTION_MAX_ROWS) {
    throw invalid("answerLimit must be 1–500 and answerOffset 0–20000.");
  }
  return { limit, offset };
}

/** @param {any} input */
export function geoReadPage(input = {}) {
  const limit = input.limit ?? 20, offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GEO_READ_PAGE_LIMIT || !Number.isSafeInteger(offset) || offset < 0 || offset > GEO_SELECTION_MAX_ROWS) {
    throw invalid(`limit must be 1–${GEO_READ_PAGE_LIMIT} and offset 0–${GEO_SELECTION_MAX_ROWS}.`);
  }
  return { limit, offset };
}

/** The same closed member selector crosses the HTTP and native boundaries. @param {any} member */
export function normalizeGeoMember(member) {
  const fields = ["metricId", "scope", "engine", "pool", "groupId", "arm", "variant", "rival", "observationDate", "observationRound"];
  if (!member || typeof member !== "object" || Array.isArray(member) || Object.keys(member).some((name) => !fields.includes(name))
    || typeof member.metricId !== "string" || !/^M-[0-9]{2}[A-Z]?$/u.test(member.metricId)
    || !["project", "pool", "engine", "pool_engine", "group", "arm"].includes(member.scope)
    || Object.values(member).some((value) => value !== null && (typeof value !== "string" || value.length > 120))) {
    throw invalid("member must name a metric returned by this selection.");
  }
  if (member.observationDate && member.observationRound) throw invalid("Choose a day or a round, not both.");
  if ("observationDate" in member) {
    if (typeof member.observationDate !== "string" || !member.observationDate) throw invalid("observationDate must be a nonempty date.");
    normalizeGeoReadScope({ from: member.observationDate });
  }
  return { ...member };
}

/** Scope fields only, so list filters and pagination cannot alter the observation universe. @param {any} input */
export function geoReadScopeInput(input) {
  return typeof input === "string" ? { round: input } : Object.fromEntries(Object.entries(input ?? {}).filter(([key]) => GEO_SCOPE_FIELDS.includes(key)));
}

/** @param {any[]} rows @param {Parameters<typeof computeRoundCells>[1]} options */
export function computeGeoSelection(rows, options) {
  const result = computeRoundCells(rows, options);
  const cells = result.cells.map((cell) => {
    const input = cell.scope === "engine" || cell.scope === "pool_engine" || cell.metricId === "M-20" ? result.balance.deduped : result.balance.rows;
    const members = geoMetricMembers(/** @type {any[]} */ (input), cell, options);
    const ids = [...new Set(members.rows.map((row) => row.snapshotId))];
    return { ...cell, snapshotIds: ids.slice(0, GEO_MEMBER_PREVIEW_LIMIT), members: { total: ids.length, shown: Math.min(ids.length, GEO_MEMBER_PREVIEW_LIMIT),
      more: ids.length > GEO_MEMBER_PREVIEW_LIMIT, nextOffset: ids.length > GEO_MEMBER_PREVIEW_LIMIT ? GEO_MEMBER_PREVIEW_LIMIT : null,
      unit: members.unit, basis: members.basis, exact: true, digest: digest(ids) } };
  });
  return { ...result, cells };
}

/** @param {ReturnType<typeof computeGeoSelection>} computed @param {string} reference @param {Record<string, string>} [extra] */
function bindMemberReferences(computed, reference, extra = {}) {
  for (const cell of computed.cells) Object.assign(cell.members, { selectionRef: reference, metric: { metricId: cell.metricId, scope: cell.scope, engine: cell.engine,
    pool: cell.pool, groupId: cell.groupId, arm: cell.arm, variant: cell.variant, rival: cell.rival, ...extra } });
}

/** Actual-day cohorts share the frozen selection, with the day carried in each exact member selector.
 * @param {Awaited<ReturnType<typeof readGeoSelection>>} selected @param {string | null} [onlyDay]
 */
export function geoDailyReadings(selected, onlyDay = null) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: selected.scope.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  /** @type {Map<string, any[]>} */ const buckets = new Map();
  for (const row of selected.rows) {
    if (!row.askedAt) continue;
    const date = formatter.format(new Date(row.askedAt));
    if (onlyDay && date !== onlyDay) continue;
    const members = buckets.get(date) ?? []; members.push(row); buckets.set(date, members);
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
    const roundIds = [...new Set(rows.map((row) => row.roundId))].sort();
    const versions = [...new Set(selected.rounds.filter((round) => roundIds.includes(round.id)).map((round) => round.set_version == null ? null : Number(round.set_version)))];
    const result = computeGeoSelection(rows, selected.metricOptions);
    bindMemberReferences(result, selected.selection.reference, { observationDate: date });
    return { date, roundIds, version: versions.length === 1 ? versions[0] : null, result };
  });
}

/** Round cohorts reuse domain metrics and carry the exact round in the existing member selector. */
export function geoRoundReadings(selected, roundId) {
  if (!selected.selection.roundIds.includes(roundId)) throw invalid("This round is outside the selection.");
  const result = computeGeoSelection(selected.rows.filter(row => row.roundId === roundId), selected.metricOptions);
  bindMemberReferences(result, selected.selection.reference, { observationRound: roundId });
  return result;
}

/** A subset key retains the existing four-part wire format; no snapshot or round id makes repeated questions incomparable.
 * @param {any[]} rows @param {number | null} setVersion @param {string | null} [engine]
 */
export function geoSelectionCoverage(rows, setVersion, engine = null) {
  const members = rows.filter((row) => (!engine || row.engine === engine) && (row.status === "refusal" || row.status === "valid" && row.facts));
  const modes = [...new Set(members.map((row) => JSON.stringify(row.surface ?? null)))];
  if (modes.length !== 1) return null;
  const key = geoCoverageKey({ setVersion, pools: [...new Set(members.map((row) => row.pool).filter(Boolean))],
    engines: [...new Set(members.map((row) => row.engine))], surface: JSON.parse(modes[0]), methodVersion: GEO_MEASUREMENT_METHOD_VERSION });
  return key ? `${key};questions=${digest([...new Set(members.map((row) => row.questionId).filter(Boolean))].sort()).slice(0, 24)}` : null;
}

/** @param {any} scope */
export const geoScopeIsFiltered = (scope) => Boolean(scope?.round || scope?.from || scope?.to || scope?.questionVersion || scope?.engines?.length
  || scope?.groupIds?.length || scope?.pools?.length || scope?.clientTags?.length || scope?.selectionRef);

/** Exact scoped error aggregation precedes the independently filtered, bounded list.
 * @param {import('./geoStore.mjs').GeoStore} store @param {any} project
 * @param {Awaited<ReturnType<typeof readGeoSelection>>} selected @param {any} [input]
 * @param {{allRows?: boolean}} [options] Internal bounded analytical admission; public list pagination is unchanged.
 */
export async function readGeoSelectionErrors(store, project, selected, input = {}, {allRows=false} = {}) {
  const filter = {...geoErrorFilters(input),...(allRows?{limit:20000,offset:0}:{})};
  const params = [project.id, project.userId, selected.rows.map((row) => row.snapshotId)];
  const where = ["e.geo_project_id = $1", "e.user_id = $2", "(e.first_snapshot_id = ANY($3::text[]) OR e.last_snapshot_id = ANY($3::text[]) OR e.closed_snapshot_id = ANY($3::text[]))"];
  const add = (/** @type {string} */ sql, /** @type {any} */ value) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };
  if (filter.judgmentState) add("e.judgment_state = ?", filter.judgmentState);
  if(filter.fingerprint)add("coalesce(nullif(btrim(e.fingerprint),''),nullif(btrim(e.claim_id),''),btrim(e.id)) = ?",filter.fingerprint);
  if (filter.questionId) add("e.question_id = ?", filter.questionId);
  if (filter.statuses.length) add("e.status = ANY(?::text[])", filter.statuses);
  if (filter.severities.length) add("e.severity = ANY(?::text[])", filter.severities);
  if (filter.types.length) add("coalesce(e.error_type, 'unknown') = ANY(?::text[])", filter.types);
  if (filter.search) add("strpos(lower(concat_ws(' ', e.statement, e.evidence_quote, e.cited_source ->> 'domain', e.cited_source ->> 'url')), lower(?)) > 0", filter.search);
  const traceSql = `CASE WHEN e.cited_source->>'basis'='inline_marker' THEN 'traced'
    WHEN e.cited_source->>'basis'='no_retrieval' THEN 'noRetrieval'
    WHEN e.cited_source->>'basis'='not_attributable' THEN 'unattributable'
    WHEN e.cited_source->>'attribute'='none' THEN 'noRetrieval'
    WHEN e.cited_source->>'domain' IS NOT NULL THEN 'traced' ELSE 'unattributable' END`;
  if (filter.trace) add(`${traceSql} = ?`, filter.trace);
  const aggregate = (await store.query(`SELECT ${traceSql} AS trace, e.status, e.judgment_state, e.severity, e.error_type, e.engine, coalesce(q.group_id,sq.group_id) AS group_id, count(*)::integer AS n,
      count(*) FILTER (WHERE e.status <> 'closed' AND e.cited_source IS NOT NULL)::integer AS sourced_open
    FROM evimed_geo.errors e LEFT JOIN evimed_geo.questions q ON q.id=e.question_id AND q.user_id=e.user_id AND q.geo_project_id=e.geo_project_id
    LEFT JOIN evimed_geo.snapshots es ON es.id=coalesce(e.last_snapshot_id,e.first_snapshot_id,e.closed_snapshot_id) AND es.user_id=e.user_id AND es.geo_project_id=e.geo_project_id
    LEFT JOIN evimed_geo.questions sq ON sq.id=es.question_id AND sq.user_id=e.user_id AND sq.geo_project_id=e.geo_project_id
    WHERE ${where.join(" AND ")} GROUP BY e.status, e.judgment_state, e.severity, e.error_type, e.engine, trace, coalesce(q.group_id,sq.group_id)`, params)).rows;
  /** @type {Record<string, number>} */ const counts = { total: 0, open: 0, acting: 0, awaiting_remeasure: 0, closed: 0, severe: 0, withdrawn: 0 };
  /** @type {Record<string, Record<string, number>>} */ const breakdown = { byType: {}, bySeverity: {}, byEngine: {}, byStatus: {}, byTrace: {}, byEngineSeverity: {} };
  const activeBreakdown = Object.fromEntries(Object.keys(breakdown).map(key => [key, {}]));
  let activeTotal = 0;
  /** @type {Record<string, { total: number, open: number, severe: number }>} */ const byGroup = {};
  let sourcedOpen = 0;
  for (const row of aggregate) {
    const n = Number(row.n); counts.total += n;
    const withdrawn = row.judgment_state === "withdrawn";
    if (withdrawn) counts.withdrawn += n;
    else { counts[row.status] = (counts[row.status] ?? 0) + n; activeTotal += n; }
    if (!withdrawn && row.status !== "closed" && ["S3", "S4"].includes(row.severity)) counts.severe += n;
    if (!withdrawn) sourcedOpen += Number(row.sourced_open);
    if (row.group_id && !withdrawn) {
      const group = byGroup[row.group_id] ??= { total: 0, open: 0, severe: 0 };
      group.total += n; if (row.status !== "closed") group.open += n;
      if (row.status !== "closed" && ["S3", "S4"].includes(row.severity)) group.severe += n;
    }
    for (const [key, value] of [["byTrace", row.trace], ["byEngineSeverity", `${row.engine}:${row.severity ?? "unknown"}`], ["byType", row.error_type], ["bySeverity", row.severity], ["byEngine", row.engine], ["byStatus", row.status]]) {
      const name = String(value ?? "unknown"); breakdown[key][name] = (breakdown[key][name] ?? 0) + n;
      if (!withdrawn) activeBreakdown[key][name] = (activeBreakdown[key][name] ?? 0) + n;
    }
  }
  if(allRows&&counts.total>20000)throw invalid("Narrow the selection to at most 20,000 error records.",422);
  const live = allRows?null:(await store.query(`SELECT e.id, e.status, e.severity, e.cited_source FROM evimed_geo.errors e
    WHERE ${where.join(" AND ")} AND e.judgment_state='active' AND e.status <> 'closed'`, params)).rows;
  // A drawer may span requests; a stable population digest prevents mixing revisions across pages.
  const populationRevision=filter.fingerprint?(await store.query(`SELECT md5(coalesce(string_agg(
    md5(jsonb_build_array(to_jsonb(e),to_jsonb(c),f.statements,r.ref->'evaluationBasis'->'claims')::text),'' ORDER BY e.id),'')) AS revision
    FROM evimed_geo.errors e
    LEFT JOIN evimed_geo.claims c ON c.id=e.claim_id AND c.geo_project_id=e.geo_project_id AND c.user_id=e.user_id
    LEFT JOIN evimed_geo.facts f ON f.snapshot_id=e.first_snapshot_id AND f.geo_project_id=e.geo_project_id AND f.user_id=e.user_id
    LEFT JOIN evimed_geo.snapshots original ON original.id=e.first_snapshot_id AND original.geo_project_id=e.geo_project_id AND original.user_id=e.user_id
    LEFT JOIN evimed_geo.rounds r ON r.id=original.round_id AND r.geo_project_id=e.geo_project_id AND r.user_id=e.user_id
    WHERE ${where.join(" AND ")}`,params)).rows[0].revision:null;
  params.push(filter.limit, filter.offset);
  const rows = (await store.query(`SELECT e.*, md5(to_jsonb(e)::text) AS error_revision, f.statements AS origin_statements,r.ref->'evaluationBasis'->'claims' AS origin_claims, c.version AS claim_version,
    CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('population',c.population,'elements',c.elements,'inLabel',c.in_label,'validUntil',c.valid_until,'evidenceLevel',c.evidence_level) END AS applicability
    FROM evimed_geo.errors e LEFT JOIN evimed_geo.claims c ON c.id=e.claim_id AND c.geo_project_id=e.geo_project_id AND c.user_id=e.user_id
    LEFT JOIN evimed_geo.facts f ON f.snapshot_id=e.first_snapshot_id AND f.geo_project_id=e.geo_project_id AND f.user_id=e.user_id
    LEFT JOIN evimed_geo.snapshots original ON original.id=e.first_snapshot_id AND original.geo_project_id=e.geo_project_id AND original.user_id=e.user_id
    LEFT JOIN evimed_geo.rounds r ON r.id=original.round_id AND r.geo_project_id=e.geo_project_id AND r.user_id=e.user_id WHERE ${where.join(" AND ")}
    ORDER BY (e.status = 'closed'), e.severity DESC NULLS LAST, e.updated_at DESC, e.id
    LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
  if(allRows&&rows.length!==counts.total)throw invalid("The selected error population changed. Read the selection again.",409);
  return { rows, live:live??rows.filter(row=>row.judgment_state==='active'&&row.status!=='closed').map(({id,status,severity,cited_source})=>({id,status,severity,cited_source})), claimRows: rows, counts, activeSummary: { unit: "error_rows", total: activeTotal, ...activeBreakdown, byGroup, sourcedOpen }, summary: { unit: "error_rows", total: counts.total, byGroup, ...breakdown, sourcedOpen },
    page: { ...(populationRevision?{populationRevision}:{}), offset: filter.offset, limit: filter.limit, total: counts.total, shown: rows.length, more: filter.offset + rows.length < counts.total,
      nextOffset: filter.offset + rows.length < counts.total ? filter.offset + rows.length : null }, filter };
}

/** Read under an already authorized project. The reference contains no authority and resolves only within that owner/project.
 * @param {import('./geoStore.mjs').GeoStore} store @param {any} project @param {any} [input]
 * @param {{ history?: boolean, historyLimit?: number, frozenRoundIds?: string[], persist?: boolean, subset?: { keys: string[], eligibleOnly: boolean } | null }} [options]
 * @returns {Promise<{scope: ReturnType<typeof normalizeGeoReadScope>, selection: any, rounds: any[], rows: any[], computed: ReturnType<typeof computeGeoSelection>, metricOptions: any, questions: any[], comparison: any, subset: any, sourceObservationPlan: any}>}
 */
export async function readGeoSelection(store, project, input = {}, options = {}) {
  return withGeoReadTransaction(store, async () => {
    const selected = await selectGeoRows(store, new GeoMeasureStore(store.database), project, input, options);
    if (options.persist !== false) readTransactions.getStore().references.set(selected.selection.reference, { selected, project });
    return selected;
  });
}

/** @param {import('./geoStore.mjs').GeoStore} store @param {GeoMeasureStore} measure @param {any} project @param {any} input
 * @param {{ history?: boolean, historyLimit?: number, frozenRoundIds?: string[], subset?: { keys: string[], eligibleOnly: boolean } | null }} options @returns {ReturnType<typeof readGeoSelection>}
 */
async function selectGeoRows(store, measure, project, input, { history = false, historyLimit, frozenRoundIds, subset = null } = {}) {
  let scope = normalizeGeoReadScope(geoReadScopeInput(input));
  let expectedRevision = null;
  if (scope.selectionRef) {
    const saved = (await store.query(`SELECT scope, round_ids, data_revision, subset FROM evimed_geo.read_selections
      WHERE id = $1 AND geo_project_id = $2 AND user_id = $3`, [scope.selectionRef, project.id, project.userId])).rows[0];
    if (!saved) throw invalid("This selection reference is unavailable in this project.", 404);
    if (Object.entries(scope).some(([key, value]) => !["selectionRef", "timeZone", "comparisonMode"].includes(key) && (Array.isArray(value) ? value.length : value != null))) {
      throw invalid("Use the saved selection reference without replacing its scope.");
    }
    scope = normalizeGeoReadScope(saved.scope);
    frozenRoundIds = saved.round_ids;
    subset = saved.subset ?? null;
    expectedRevision = String(saved.data_revision);
  }
  const params = [project.id, project.userId, ROUND_KINDS, scope.timeZone];
  // Shared predicates use stable parameter positions; each query binds only the positions it actually references.
  const selectionQuery = (/** @type {string} */ sql) => {
    /** @type {Map<number, number>} */ const positions = new Map();
    /** @type {any[]} */ const bound = [];
    const statement = sql.replace(/\$(\d+)\b/gu, (_token, number) => {
      const index = Number(number);
      if (!positions.has(index)) { bound.push(params[index - 1]); positions.set(index, bound.length); }
      return `$${positions.get(index)}`;
    });
    return store.query(statement, bound);
  };
  const where = ["r.geo_project_id = $1", "r.user_id = $2", "r.kind = ANY($3::text[])"];
  const add = (/** @type {string[]} */ clauses, /** @type {string} */ clause, /** @type {any} */ value) => { params.push(value); clauses.push(clause.replace("?", `$${params.length}`)); };
  if (scope.round) add(where, "r.id = ?", scope.round);
  if (scope.questionVersion) add(where, "r.set_version = ?", scope.questionVersion);
  const contextRoundWhere = [...where];
  if (frozenRoundIds) add(where, "r.id = ANY(?::text[])", frozenRoundIds);
  const observed = ["s.geo_project_id = $1", "s.user_id = $2", "s.round_id = r.id"];
  if (scope.engines.length) add(observed, "s.engine = ANY(?::text[])", scope.engines);
  if (scope.questionVersion) add(observed, "q.set_version = ?", scope.questionVersion);
  if (scope.groupIds.length) add(observed, "q.group_id = ANY(?::text[])", scope.groupIds);
  if (scope.pools.length) add(observed, "coalesce(q.pool, g.pool) = ANY(?::text[])", scope.pools);
  if (scope.clientTags.length) add(observed, "(jsonb_typeof(to_jsonb(q)->'client_tags') = 'array' AND jsonb_exists_any(to_jsonb(q)->'client_tags', ?::text[]))", scope.clientTags);
  if (subset) {
    add(observed, "jsonb_build_array(s.question_id, s.engine, coalesce(s.surface, '{\"mode\":\"web\"}'::jsonb)->>'mode') IN (SELECT value FROM jsonb_array_elements(?::jsonb))", JSON.stringify(subset.keys.map((key) => JSON.parse(key))));
    if (subset.eligibleOnly) observed.push("(s.status = 'refusal' OR s.status = 'valid' AND f.snapshot_id IS NOT NULL AND (f.judged_at IS NOT NULL OR s.surface->>'mode' = 'inclusion'))");
  }
  const beforeDates = [...observed];
  const dated = Boolean(scope.from || scope.to);
  const planned = [...contextRoundWhere];
  if (scope.from) {
    params.push(scope.from); const dateParam = `$${params.length}`;
    observed.push(`(s.asked_at AT TIME ZONE $4)::date >= ${dateParam}::date`);
    planned.push(`coalesce(r.sample_date, (coalesce(r.started_at, r.created_at) AT TIME ZONE $4)::date) >= ${dateParam}::date`);
  }
  if (scope.to) {
    params.push(scope.to); const dateParam = `$${params.length}`;
    observed.push(`(s.asked_at AT TIME ZONE $4)::date <= ${dateParam}::date`);
    planned.push(`coalesce(r.sample_date, (coalesce(r.started_at, r.created_at) AT TIME ZONE $4)::date) <= ${dateParam}::date`);
  }
  const joins = `LEFT JOIN evimed_geo.questions q ON q.id = s.question_id AND q.geo_project_id = s.geo_project_id AND q.user_id = s.user_id
    LEFT JOIN evimed_geo.question_groups g ON g.id = q.group_id AND g.geo_project_id = s.geo_project_id AND g.user_id = s.user_id
    LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id AND f.geo_project_id = s.geo_project_id AND f.user_id = s.user_id`;
  const paused = `EXISTS (SELECT 1 FROM evimed_geo.probe_jobs skipped WHERE skipped.round_id = r.id AND skipped.engine = s.engine
    AND skipped.geo_project_id = $1 AND skipped.user_id = $2 AND skipped.status = 'skipped' AND skipped.error_code IN ('engine_paused', 'engine_unavailable'))`;
  if (dated) where.push(`EXISTS (SELECT 1 FROM evimed_geo.snapshots s ${joins} WHERE ${observed.join(" AND ")} AND NOT ${paused})`);
  const ranged = Boolean(history || frozenRoundIds || scope.round || dated);
  // Context previews choose their actual rounds before observation admission. Explicit and frozen scopes are never truncated.
  const contextLimit = history && !frozenRoundIds && !scope.round && !dated ? historyLimit : null;
  if (contextLimit != null && (!Number.isSafeInteger(contextLimit) || contextLimit < 1 || contextLimit > GEO_SELECTION_MAX_ROUNDS)) throw invalid("Invalid history context limit.");
  const rounds = (await selectionQuery(`SELECT r.*, (coalesce(r.started_at, r.created_at) AT TIME ZONE $4)::date::text AS observation_date FROM evimed_geo.rounds r WHERE ${where.join(" AND ")}
    ORDER BY (r.status IN ('done', 'partial')) DESC, CASE WHEN r.status IN ('done', 'partial') THEN r.finished_at END DESC NULLS LAST, r.created_at DESC, r.id DESC
    LIMIT ${contextLimit ?? (ranged ? GEO_SELECTION_MAX_ROUNDS + 1 : 1)}`)).rows;
  if (rounds.length > GEO_SELECTION_MAX_ROUNDS) throw invalid(`Choose a shorter date range: at most ${GEO_SELECTION_MAX_ROUNDS} rounds can be analyzed together.`, 422);
  if (scope.round && !rounds.length) {
    const exists = (await selectionQuery(`SELECT 1 FROM evimed_geo.rounds r WHERE ${contextRoundWhere.join(" AND ")} LIMIT 1`)).rows.length;
    if (!exists) throw new HttpError(404, "geo_round_not_found", "The round is not a full measurement of this project.");
  }
  const roundIds = rounds.map((round) => String(round.id));
  const roundParam = `$${params.push(roundIds)}`;
  const selectedRounds = `r.id = ANY(${roundParam}::text[])`;
  const from = `FROM evimed_geo.rounds r JOIN evimed_geo.snapshots s ON s.round_id = r.id ${joins}`;
  const admitted = (await selectionQuery(`SELECT s.id, s.round_id, (s.asked_at AT TIME ZONE $4)::date::text AS observation_date ${from}
    WHERE ${selectedRounds} AND ${observed.join(" AND ")} AND NOT ${paused} ORDER BY s.asked_at, s.id LIMIT ${GEO_SELECTION_MAX_ROWS + 1}`)).rows;
  if (admitted.length > GEO_SELECTION_MAX_ROWS) throw invalid(`Choose a narrower scope: more than ${GEO_SELECTION_MAX_ROWS} selected observations exceed the read limit; use a shorter date range or fewer engines or question groups.`, 422);
  /** @type {Map<string, string[]>} */ const admittedIds = new Map();
  for (const entry of admitted) {
    const ids = admittedIds.get(entry.round_id) ?? []; ids.push(entry.id); admittedIds.set(entry.round_id, ids);
  }
  const coverageRows = (await selectionQuery(`SELECT count(*)::integer AS unknown_time
    ${from} WHERE ${dated ? contextRoundWhere.join(" AND ") : selectedRounds} AND ${beforeDates.join(" AND ")} AND s.asked_at IS NULL AND NOT ${paused}`)).rows[0];
  const skippedAnswers = Number((await selectionQuery(`SELECT count(*)::integer AS n ${from}
    WHERE ${selectedRounds} AND ${observed.join(" AND ")} AND ${paused}`)).rows[0]?.n ?? 0);
  const plannedRounds = dated ? Number((await selectionQuery(`SELECT count(*)::integer AS n FROM evimed_geo.rounds r WHERE ${planned.join(" AND ")}`)).rows[0]?.n ?? 0) : rounds.length;
  const observationDays = admitted.map((entry) => entry.observation_date).filter(Boolean).sort();
  const timeCoverage = { basis: "answer_asked_at", from: scope.from, to: scope.to, timeZone: scope.timeZone,
    observedFrom: observationDays[0] ?? null, observedTo: observationDays.at(-1) ?? null, unknownTime: Number(coverageRows?.unknown_time ?? 0),
    unknownTimeScope: dated ? "matching_filters_without_dates" : "selected_rounds", plannedRounds, plannedBasis: "round_schedule",
    currentContextFields: ["unknownTime", "plannedRounds"] };
  if (dated) for (const round of rounds) {
    const days = admitted.filter((entry) => entry.round_id === round.id).map((entry) => entry.observation_date).filter(Boolean).sort();
    round.selection_date = days[0] ?? null;
  }
  const [batches, skipBatches, questions, context, contaminated] = await Promise.all([
    Promise.all(roundIds.map((id) => measure.roundFactRows(id, project.id, project.userId, admittedIds.get(id) ?? []))),
    Promise.all(roundIds.map((id) => measure.roundSkippedEngines(id))),
    store.query(`SELECT q.*, coalesce(q.pool, g.pool) AS scope_pool, to_jsonb(q)->'client_tags' AS scope_client_tags FROM evimed_geo.questions q
      LEFT JOIN evimed_geo.question_groups g ON g.id = q.group_id AND g.geo_project_id = q.geo_project_id AND g.user_id = q.user_id
      WHERE q.geo_project_id = $1 AND q.user_id = $2 ORDER BY q.id`, [project.id, project.userId]),
    roundIds.length ? measure.projectContext(project.id) : null,
    measure.contaminatedControlGroups(project.id),
  ]);
  const roundVersions = new Set(rounds.map((round) => Number(round.set_version)).filter((version) => version > 0));
  const selectedQuestions = questions.rows.filter((question) => (!roundVersions.size || roundVersions.has(Number(question.set_version))) && (!scope.questionVersion || Number(question.set_version) === scope.questionVersion)
    && (!scope.groupIds.length || scope.groupIds.includes(String(question.group_id))) && (!scope.pools.length || scope.pools.includes(String(question.scope_pool)))
    && (!scope.clientTags.length || Array.isArray(question.scope_client_tags) && question.scope_client_tags.some((/** @type {string} */ tag) => scope.clientTags.includes(tag))));
  const questionIds = new Set(selectedQuestions.map((question) => String(question.id)));
  // Admission already applied every deterministic observation predicate before the bounded fact read.
  const rows = batches.flat();
  if (rows.length > GEO_SELECTION_MAX_ROWS) throw invalid(`Choose a shorter date range: at most ${GEO_SELECTION_MAX_ROWS} observations can be analyzed together.`, 422);
  const engines = scope.engines.length ? scope.engines : rounds.length ? [...new Set(rounds.flatMap((round) => Array.isArray(round.engines) && round.engines.length ? round.engines : project.engines))] : project.engines;
  const groups = [...new Map(rows.filter((row) => row.groupId).map((row) => [row.groupId, row.isControl])).entries()];
  const samplingContracts = rounds.map((round) => round.surface?.measurementContract ?? null);
  const samplingModes = [...new Set(samplingContracts.map((contract) => contract?.samplingMode ?? "legacy_recurring"))];
  const metricOptions = { samplingMode: samplingModes.length === 1 ? samplingModes[0] : "mixed", engines, competitors: project.competitors.map((/** @type {any} */ competitor) => String(competitor.brandName || competitor.genericName || "")).filter(Boolean),
    owned: context?.owned ?? {}, arms: { pilot: groups.filter(([, control]) => !control).map(([id]) => String(id)),
      control: groups.filter(([id, control]) => control && !contaminated.includes(String(id))).map(([id]) => String(id)) } };
  const computed = computeGeoSelection(rows, metricOptions);
  const jobs = (await store.query(`SELECT j.id,j.question_id,j.engine,j.round_id,j.repeat_index,j.status,j.snapshot_id,
      CASE WHEN s.id=ANY($7::text[]) AND s.probe_job_id=j.id AND s.round_id=j.round_id
        AND s.question_id=j.question_id AND s.engine=j.engine THEN s.id ELSE NULL END AS admitted_snapshot_id
    FROM evimed_geo.probe_jobs j JOIN evimed_geo.rounds r ON r.id=j.round_id AND r.geo_project_id=j.geo_project_id AND r.user_id=j.user_id
    LEFT JOIN evimed_geo.snapshots s ON s.id=j.snapshot_id AND s.geo_project_id=j.geo_project_id AND s.user_id=j.user_id
    WHERE j.geo_project_id=$1 AND j.user_id=$2 AND j.round_id=ANY($3::text[]) AND j.question_id=ANY($4::text[])
      AND (cardinality($5::text[])=0 OR j.engine=ANY($5::text[]))
      AND ($6::jsonb IS NULL OR jsonb_build_array(j.question_id,j.engine,coalesce(r.surface->>'mode','web'))
        IN (SELECT value FROM jsonb_array_elements($6::jsonb)))
    ORDER BY j.round_id,j.question_id,j.engine,j.repeat_index,j.id LIMIT ${GEO_SELECTION_MAX_ROWS + 1}`,
  [project.id, project.userId, roundIds, [...questionIds], scope.engines, subset ? JSON.stringify(subset.keys.map(key => JSON.parse(key))) : null,
    rows.map(row => row.snapshotId)])).rows;
  if (jobs.length > GEO_SELECTION_MAX_ROWS) throw invalid(`Choose a narrower scope: more than ${GEO_SELECTION_MAX_ROWS} planned observations exceed the read limit.`, 422);
  // Failed, skipped and queued jobs may have no snapshot. Source-history
  // absence requires this actual planned cohort; a snapshot array is not proof
  // of collection completeness. This current context has its own analysis digest.
  const sourceObservationPlan = { schemaVersion: 1, jobs: jobs.map(job => ({ id: String(job.id), roundId: String(job.round_id),
    questionId: String(job.question_id), engine: String(job.engine), repeatIndex: Number(job.repeat_index), status: String(job.status),
    snapshotId: job.snapshot_id == null ? null : String(job.snapshot_id), admittedSnapshotId: job.admitted_snapshot_id == null ? null : String(job.admitted_snapshot_id) })) };
  const errorRevision = (await store.query(`SELECT md5(coalesce(string_agg(to_jsonb(e)::text, '' ORDER BY e.id), '')) AS digest
    FROM evimed_geo.errors e WHERE e.geo_project_id = $1 AND e.user_id = $2
    AND (e.first_snapshot_id = ANY($3::text[]) OR e.last_snapshot_id = ANY($3::text[]) OR e.closed_snapshot_id = ANY($3::text[]))`,
  [project.id, project.userId, rows.map((row) => row.snapshotId)])).rows[0]?.digest ?? null;
  const answerRevision = (await store.query(`SELECT md5(coalesce(string_agg(md5(to_jsonb(s)::text), '' ORDER BY s.id), '')) AS digest
    FROM evimed_geo.snapshots s WHERE s.geo_project_id = $1 AND s.user_id = $2 AND s.id = ANY($3::text[])`,
  [project.id, project.userId, rows.map((row) => row.snapshotId)])).rows[0]?.digest ?? null;
  const comparisonSelection = scope.compareFrom && scope.compareTo ? await selectGeoRows(store, measure, project,
    { ...scope, round: null, from: scope.compareFrom, to: scope.compareTo, compareFrom: null, compareTo: null, selectionRef: null }, {}) : null;
  const comparison = comparisonSelection ? await compareGeoSelections(store, measure, project, { rows, scope, roundIds }, comparisonSelection, scope.comparisonMode) : null;
  const memberDigest = digest(/** @type {any[]} */ (computed.balance.deduped).map((row) => row.snapshotId));
  const dataRevision = digest({ methodVersion: GEO_MEASUREMENT_METHOD_VERSION, rows, skipped: skipBatches, rounds: rounds.map((round) => [round.id, round.status, round.set_version, round.surface]),
    // Current unplaced/scheduled context is disclosed beside the observed selection, but cannot invalidate its frozen members.
    errorRevision, answerRevision, subset, metricOptions, questions: selectedQuestions, comparisonRevision: comparisonSelection?.selection.dataRevision ?? null });
  if (expectedRevision && expectedRevision !== dataRevision) throw invalid("The saved selection changed after measurement. Refresh the view and use its new selection reference.", 409);
  const scopeSaved = { ...scope, selectionRef: null };
  const reference = `gsel_${digest([project.userId, project.id, scopeSaved, roundIds, dataRevision]).slice(0, 40)}`;
  const counts = { planned: jobs.length || (!scope.engines.length && !scope.groupIds.length && !scope.pools.length && !scope.clientTags.length ? rounds.reduce((sum, round) => sum + Number(round.planned ?? 0), 0) : null), snapshots: rows.length, returned: rows.filter((row) => row.status === "valid" || row.status === "refusal").length,
    refused: rows.filter((row) => row.status === "refusal").length, failed: rows.filter((row) => row.status === "failed").length,
    suspect: rows.filter((row) => row.status === "suspect").length, unjudged: rows.filter((row) => row.status === "valid" && !row.facts).length,
    partial: rows.filter((row) => row.facts && geoJudgementCoverage(row.facts) === "partial").length,
    balancedOut: computed.balance.deduped.length - computed.balance.rows.length, duplicateAnswers: rows.length - computed.balance.deduped.length,
    skippedEngineAnswers: skippedAnswers, questions: new Set(rows.map((row) => row.questionId).filter(Boolean)).size,
    observations: computed.balance.observations, balancedObservations: computed.balance.kept };
  const methods = [...new Set(rounds.map((round) => round.ref?.balance?.methodVersion ?? null))];
  const modes = [...new Set(rows.map((row) => row.surface?.mode ?? null))];
  const versions = [...new Set(rounds.map((round) => round.set_version == null ? null : Number(round.set_version)))];
  const selection = { version: 1, reference, dataRevision, memberDigest, methodVersion: GEO_MEASUREMENT_METHOD_VERSION, roundIds,
    counts, timeCoverage, engines, pools: [...new Set(rows.map((row) => row.pool).filter(Boolean))].sort(), questionIds: [...new Set(rows.map((row) => row.questionId).filter(Boolean))].sort(),
    exclusions: { skippedEngines: roundIds.flatMap((id, index) => skipBatches[index].map((engine) => ({ roundId: id, engine }))), clientTagsUnknown: scope.clientTags.length > 0 && !questions.rows.some((question) => Array.isArray(question.scope_client_tags)) },
    comparability: { kind: "observational", causal: false, methodVersions: methods, questionVersions: versions, modes, samplingModes, samplingContracts, consumerModelVersion: "unknown" },
    coverage: geoSelectionCoverage(/** @type {any[]} */ (computed.balance.rows), versions.length === 1 ? versions[0] : null) };
  bindMemberReferences(computed, reference);
  return { scope: scopeSaved, selection, rounds, rows, computed, metricOptions, questions: selectedQuestions, comparison, subset, sourceObservationPlan };
}

/** Observed comparisons use the same immutable question, engine and mode. Consumer model versions are disclosed, not invented.
 * @param {import('./geoStore.mjs').GeoStore} store @param {GeoMeasureStore} measure @param {any} project
 * @param {{rows: any[], scope: any, roundIds: string[]}} current @param {Awaited<ReturnType<typeof readGeoSelection>>} previous @param {string} mode
 */
async function compareGeoSelections(store, measure, project, current, previous, mode) {
  const a = new Set(current.rows.filter(comparableAnswer).map(comparisonKey)), b = new Set(previous.rows.filter(comparableAnswer).map(comparisonKey));
  const common = new Set([...a].filter((id) => b.has(id)));
  const subset = mode === "common" ? { keys: [...common].sort(), eligibleOnly: true } : null;
  const left = await selectGeoRows(store, measure, project, { ...current.scope, compareFrom: null, compareTo: null }, { frozenRoundIds: current.roundIds, subset });
  const right = await selectGeoRows(store, measure, project, previous.scope, { frozenRoundIds: previous.selection.roundIds, subset });
  for (const selected of [left, right]) readTransactions.getStore().references.set(selected.selection.reference, { selected, project });
  const result = { kind: "observational", causal: false, mode, methodVersion: GEO_MEASUREMENT_METHOD_VERSION, consumerModelVersion: "unknown",
    comparable: mode === "common" && common.size > 0 && geoComparisonContractsMatch(left, right), commonQuestionEngineModes: common.size,
    excluded: { current: current.rows.length - left.rows.length, previous: previous.rows.length - right.rows.length },
    currentSelection: left.selection, previousSelection: right.selection,
    cells: compareGeoMetricCohorts(left, right, { mode, commonCount: common.size }) };
  // Raw cohorts are request-local, never serialized into the public comparison response.
  Object.defineProperty(result, "cohorts", { value: { current: left, previous: right }, enumerable: false });
  return result;
}
