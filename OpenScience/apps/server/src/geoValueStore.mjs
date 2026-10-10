import { createHash } from "node:crypto";
import { GEO_RESEARCH_CAPABILITIES, GEO_VALUE_COLLECTIONS, geoValueCanonical, geoValueImpacts, geoValueObject, mergeGeoValue } from "@evimed/domain";

/** The knowledge-base replacement hook reuses exact source links; it never invalidates unrelated findings. @param {any} store @param {any} event */
export async function geoValueSourceReplaced(store, event) {
  if (!store) return null;
  const project = await store.projectByControlProject(event.userId, event.projectId);
  if (!project) return null;
  const profile = await store.latestValue(project.id);
  const change = { id: `replacement:${event.replaced.sourceId}:${event.by.sourceId}`, sourceId: event.replaced.sourceId,
    replacedBy: event.by.sourceId, at: event.by.at, summary: "知识库资料已更新，可检查引用它的结论与内容。", status: "needs_review", reason: "source_replaced" };
  const impacts = geoValueImpacts({ ...profile.data, sourceChanges: [change] });
  if (!impacts.some((impact) => impact.findingIds.length)) return null;
  return store.writeValue(event.userId, project.id, { sourceChanges: [change] });
}

/** @param {any} row */
function profileRow(row) {
  return row ? { version: Number(row.version), data: row.data ?? {}, runId: row.run_id ?? null,
    updatedAt: new Date(row.created_at).toISOString() } : { version: 0, data: {}, runId: null, updatedAt: null };
}

/** @param {any} store @param {string} geoId @param {number | null} [version] */
export async function readGeoValue(store, geoId, version = null) {
  const result = await store.query(`SELECT * FROM evimed_geo.value_profiles WHERE geo_project_id = $1
    AND ($2::integer IS NULL OR version = $2) ORDER BY version DESC LIMIT 1`, [geoId, version]);
  return profileRow(result.rows[0]);
}

/** Stable automatic keys let later turns amend a finding without requiring a form. @param {Record<string, any>} patch */
function keyedPatch(patch) {
  return Object.fromEntries(Object.entries(patch).map(([field, value]) => [field,
    GEO_VALUE_COLLECTIONS.includes(field) && Array.isArray(value) ? value.map((entry) => {
      if (!geoValueObject(entry) || entry.id || entry.key) return entry;
      return { ...entry, id: `gv_${createHash("sha256").update(geoValueCanonical(entry)).digest("hex").slice(0, 24)}` };
    }) : value]));
}

/**
 * One version for an actual change, computed by the server. No field-completeness
 * rule: the bounds of the gateway protect resources; the model judges relevance.
 * @param {any} store @param {string} userId @param {string} geoId @param {Record<string, any>} patch
 * @param {string | null} [runId]
 */
export async function writeGeoValue(store, userId, geoId, patch, runId = null) {
  return store.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-geo-value:' || $1))", [geoId]);
    const previous = (await client.query(`SELECT * FROM evimed_geo.value_profiles WHERE geo_project_id = $1
      ORDER BY version DESC LIMIT 1`, [geoId])).rows[0];
    const data = mergeGeoValue(previous?.data, keyedPatch(patch));
    if (geoValueCanonical(data) === geoValueCanonical(previous?.data ?? {})) return { ...profileRow(previous), changed: false };
    const result = await client.query(`INSERT INTO evimed_geo.value_profiles (geo_project_id, version, user_id, data, run_id)
      VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
    [geoId, Number(previous?.version ?? 0) + 1, userId, JSON.stringify(data), runId]);
    return { ...profileRow(result.rows[0]), changed: true };
  });
}

/** @param {any} row */
export function geoResearchRow(row) {
  const detail = row.detail ?? {};
  return { id: String(row.key), capabilityId: detail.capabilityId ?? null, question: detail.question ?? null,
    basisVersion: detail.basisVersion ?? null, context: detail.context ?? null,
    rationale: detail.rationale ?? null, findingIds: detail.findingIds ?? [], groupIds: detail.groupIds ?? [],
    opportunityId: detail.opportunityId ?? null, status: row.state, runId: row.run_id ?? null,
    sessionId: row.session_id ?? null, result: detail.result ?? null, lastError: detail.lastError ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null };
}

/** @param {any} store @param {string} geoId */
export async function readGeoResearch(store, geoId) {
  const rows = await store.query(`SELECT * FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND kind = 'run'
    AND starts_with(key, 'run:research:') ORDER BY created_at DESC LIMIT 100`, [geoId]);
  return rows.rows.map(geoResearchRow);
}

/**
 * Reuse the GEO run ledger and its normal allowance checks. A repeated request
 * is the same task, including after a restart. Retry is an explicit operation,
 * not a loop caused by an incomplete scientific result.
 * @param {any} store @param {string} userId @param {string} geoId @param {Record<string, any>} input
 */
export async function requestGeoResearch(store, userId, geoId, input) {
  const capabilityId = String(input.capabilityId ?? "");
  const question = String(input.question ?? input.brief ?? "").trim();
  if (!GEO_RESEARCH_CAPABILITIES.includes(capabilityId) || !question) return {
    request: null, notice: !question ? "Describe the question this research should resolve; other work can continue."
      : "This specialist cannot be queued through GEO. Preserve the question and use the available research tools.",
  };
  const key = `run:research:${createHash("sha256").update(geoValueCanonical({ capabilityId, question,
    contextKey: input.contextKey ?? null, context: input.context ?? null })).digest("hex").slice(0, 24)}`;
  const detail = { purpose: "research", capabilityId, question, rationale: input.rationale ?? null,
    findingIds: Array.isArray(input.findingIds) ? input.findingIds : [],
    groupIds: Array.isArray(input.groupIds) ? input.groupIds : [], opportunityId: input.opportunityId ?? null,
    context: geoValueObject(input.context) ? input.context : null };
  const result = await store.query(`INSERT INTO evimed_geo.schedule_marks (geo_project_id, key, user_id, kind, state, detail)
    VALUES ($1, $2, $3, 'run', 'pending', $4::jsonb)
    ON CONFLICT (geo_project_id, key) DO UPDATE SET
      state = CASE WHEN $5 AND schedule_marks.state IN ('done', 'failed') THEN 'pending' ELSE schedule_marks.state END,
      dispatch_id = CASE WHEN $5 AND schedule_marks.state IN ('done', 'failed') THEN NULL ELSE schedule_marks.dispatch_id END,
      run_id = CASE WHEN $5 AND schedule_marks.state IN ('done', 'failed') THEN NULL ELSE schedule_marks.run_id END,
      session_id = CASE WHEN $5 AND schedule_marks.state IN ('done', 'failed') THEN NULL ELSE schedule_marks.session_id END,
      detail = CASE WHEN $5 AND schedule_marks.state IN ('done', 'failed')
        THEN schedule_marks.detail || jsonb_build_object('allowed', schedule_marks.attempts + 1) ELSE schedule_marks.detail END
    RETURNING *`, [geoId, key, userId, JSON.stringify(detail), input.retry === true]);
  return { request: geoResearchRow(result.rows[0]), notice: null };
}
