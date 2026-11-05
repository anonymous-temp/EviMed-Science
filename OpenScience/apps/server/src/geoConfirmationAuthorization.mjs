import { createHash } from "node:crypto";
import { geoAbilitiesOf, geoConstant, geoValueCanonical } from "@evimed/domain";
import { geoMonitoringSet } from "./geoMeasureStore.mjs";
import { HttpError } from "./security.mjs";
import { GEO_CONFIRM_TRIES, GEO_JOB_MAX_ATTEMPTS } from "./geoConfirmationPolicy.mjs";

const SCOPE_KEYS = ["protocol", "generation", "questionVersion", "questionIds", "engines", "coverageDays", "repeats", "maxRounds", "maxJobAttempts", "cost"];
/** @param {any} consent @param {any} scope */
function scopeMatches(consent, scope) {
  return Boolean(consent && SCOPE_KEYS.every(key => geoValueCanonical(consent[key]) === geoValueCanonical(scope[key]))
    && typeof consent.actorId === "string" && consent.actorId && Number.isFinite(Date.parse(consent.authorizedAt)));
}

// The set lock always precedes the project row lock, as in question-set writes.
async function lockedProject(client, userId, geoId, actorId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('evimed-geo-set:' || $1))`, [geoId]);
  const row = (await client.query(`SELECT * FROM evimed_geo.projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`, [geoId, userId])).rows[0];
  if (!row) throw new HttpError(404, "geo_project_not_found", "GEO project not found.");
  if (actorId !== row.user_id) {
    const membership = (await client.query(`SELECT role FROM evimed_geo.members WHERE geo_project_id=$1 AND user_id=$2 ORDER BY role FOR SHARE`, [geoId, actorId])).rows;
    const abilities = geoAbilitiesOf(membership.map(item => item.role));
    if (!abilities.includes("run") || !abilities.includes("edit")) throw new HttpError(403, "geo_member_forbidden", "Project authority changed; reopen the project.");
  }
  return row;
}

/** The exact server-derived scope; the token also binds the monotonic generation. */
async function preview(client, project) {
  const set = await geoMonitoringSet(client, project.id);
  const questions = set.version == null ? [] : (await client.query(`SELECT id FROM evimed_geo.questions
    WHERE geo_project_id=$1 AND set_version=$2 AND is_measured AND retired_at IS NULL ORDER BY id`, [project.id, set.version])).rows.map(row => String(row.id));
  const repeats = set.contract?.repeats ?? Number(geoConstant("EC_CONFIRM_REPEATS"));
  const engines = [...project.engines].sort();
  const allowed = project.status === "active" && questions.length > 0 && engines.length > 0
    && Number.isInteger(repeats) && repeats >= 1 && repeats <= 20
    && (!set.contract || (set.contract.samplingMode !== "one_shot" && engines.every(engine => set.contract.engines?.includes(engine))));
  const scope = { protocol: 1, generation: String(project.confirmation_generation), questionVersion: set.version,
    questionIds: questions, engines, coverageDays: Number(project.coverage_days), repeats,
    maxRounds: GEO_CONFIRM_TRIES, maxJobAttempts: GEO_JOB_MAX_ATTEMPTS, cost: null };
  const token = createHash("sha256").update(geoValueCanonical(scope)).digest("hex");
  return { ...scope, token, allowed, authorized: allowed && scopeMatches(project.confirmation_authorization, scope) };
}

/** Validate the paid work while the caller holds the set and project locks.
 * @param {any} client @param {any} project @param {any} round @param {any[]} jobs @param {{ joining?: boolean }} [options] */
export async function validateGeoConfirmationRound(client, project, round, jobs, { joining = false } = {}) {
  const current = await preview(client, project);
  const consent = project.confirmation_authorization;
  if (!current.authorized) {
    throw new HttpError(409, "geo_confirmation_authorization_required", "Automatic confirmation requires current explicit authorization.");
  }
  const id = round.ref?.errorId;
  const error = id && (await client.query(`SELECT e.question_id, e.engine, e.confirm, e.first_snapshot_id, e.last_snapshot_id, s.asked_at
    FROM evimed_geo.errors e LEFT JOIN evimed_geo.snapshots s ON s.id=coalesce($4::text,e.first_snapshot_id)
      AND s.id IN (e.first_snapshot_id,e.last_snapshot_id) AND s.geo_project_id=e.geo_project_id AND s.user_id=e.user_id
      AND s.question_id=e.question_id AND s.engine=e.engine
    WHERE e.id=$1 AND e.geo_project_id=$2 AND e.user_id=$3 AND e.status <> 'closed' AND e.judgment_state='active'`, [id, project.id, project.user_id, round.ref?.observationId ?? null])).rows[0];
  const authorizedAt = Date.parse(consent.authorizedAt);
  const expectedEvent = error?.confirm?.eventId ?? error?.confirm?.observationId ?? error?.last_snapshot_id ?? error?.first_snapshot_id;
  const requestedEvent = round.ref?.eventId ?? round.ref?.observationId ?? error?.first_snapshot_id;
  if (!error || !error.asked_at || new Date(error.asked_at).getTime() <= authorizedAt
    || requestedEvent !== expectedEvent
    || !current.questionIds.includes(error.question_id) || round.setVersion !== current.questionVersion
    || round.engines.length !== 1 || round.engines[0] !== error.engine || !current.engines.includes(error.engine)
    || jobs.length !== current.repeats || round.planned !== current.repeats
    || jobs.some((job, index) => job.questionId !== error.question_id || job.engine !== error.engine || job.repeatIndex !== index)) {
    throw new HttpError(409, "geo_confirmation_scope_changed", "The error or confirmation round is outside the authorized scope.");
  }
  if (joining && (round.acceptedGeneration !== current.generation || !round.createdAt
    || new Date(round.createdAt).getTime() <= new Date(error.asked_at).getTime())) {
    throw new HttpError(409, "geo_confirmation_scope_changed", "This round predates the observation or its authorization.");
  }
  const [history] = (await client.query(`SELECT count(*) FILTER (WHERE ref->>'errorId'=$2 AND coalesce(ref->>'eventId',ref->>'observationId','')=coalesce($5::text,''))::int AS attempts,
      count(*) FILTER (WHERE status IN ('queued','running') AND ref->>'questionId'=$3 AND ref->>'engine'=$4)::int AS open
    FROM evimed_geo.rounds WHERE geo_project_id=$1 AND kind='confirm'`, [project.id, id, error.question_id, error.engine, round.ref?.eventId ?? round.ref?.observationId ?? null])).rows;
  if (!joining && (history.open || history.attempts >= current.maxRounds || Number(error.confirm?.tries ?? 0) >= current.maxRounds)) {
    throw new HttpError(409, "geo_confirmation_round_limit", "An open confirmation or the retry limit already covers this error.");
  }
  return { generation: current.generation, authorizedAt: consent.authorizedAt, observationAt: new Date(error.asked_at).toISOString() };
}

/** @param {any} store @param {string} userId @param {string} geoId @param {string} [actorId] */
export async function previewGeoConfirmationAuthorization(store, userId, geoId, actorId = userId) {
  return store.transaction(async client => preview(client, await lockedProject(client, userId, geoId, actorId)));
}

/** @param {any} store @param {string} userId @param {string} geoId @param {string} actorId @param {string} token @param {() => Date} [now] */
export async function authorizeGeoConfirmation(store, userId, geoId, actorId, token, now = null) {
  return store.transaction(async client => {
    const project = await lockedProject(client, userId, geoId, actorId);
    const current = await preview(client, project);
    if (!current.allowed || current.token !== token) throw new HttpError(409, "geo_confirmation_scope_changed", "Confirmation scope changed; review it again.");
    const generation = (BigInt(project.confirmation_generation) + 1n).toString();
    const authorizedAt = now ? now().toISOString() : new Date((await client.query('SELECT clock_timestamp() AS at')).rows[0].at).toISOString();
    const authorization = { ...current, generation, actorId, authorizedAt };
    await client.query(`UPDATE evimed_geo.projects SET confirmation_generation=$2, confirmation_authorization=$3::jsonb WHERE id=$1`,
      [geoId, generation, JSON.stringify(authorization)]);
    return authorization;
  });
}

/** @param {any} store @param {string} userId @param {string} geoId @param {string} [actorId] */
export async function revokeGeoConfirmation(store, userId, geoId, actorId = userId) {
  return store.transaction(async client => {
    await lockedProject(client, userId, geoId, actorId);
    await client.query(`UPDATE evimed_geo.projects SET confirmation_generation=confirmation_generation+1, confirmation_authorization=NULL, updated_at=now() WHERE id=$1`, [geoId]);
    return { authorized: false };
  });
}
