/** Immutable longitudinal artifacts. Patient rows live only in the data plane;
 * the existing VCR database stores identities, lineage and aggregate summaries. */
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { canonicalScenarioJson } from '@evimed/domain';
import { writeContentAddressed, studyRelative } from './vcrDataPlane.mjs';
import { HttpError } from './security.mjs';

/**
 * Who a read is made for. A person-facing read (a route, a run's read in a conversation) runs inside `readingAs(person, …)`, and the
 * lineage of everything it reaches (list, report model, export inputs, a job's result) is judged as that person; with no one named it is
 * a platform-internal read and is judged as the study's owner (review eng round 2, P2-2: the page judged the requester and the report and
 * exports the owner, so a reviewer without patient-level access read in an export what the page withheld).
 * @type {AsyncLocalStorage<string>}
 */
const reader = new AsyncLocalStorage();
/** @template T @param {string} person @param {() => Promise<T>} work @returns {Promise<T>} */
export const readingAs = (person, work) => reader.run(String(person), work);
/** The person the current read is made for, or null. @returns {string | null} */
export const currentReader = () => reader.getStore() ?? null;

/** @param {any} value */
export const longitudinalHash = value => createHash('sha256').update(canonicalScenarioJson(value)).digest('hex');
/** @param {any} row */
export function longitudinalArtifactView(row) {
  return { id: row.id, kind: row.kind, hash: row.sha256, parentId: row.parent_id ?? null, createdAt: row.created_at,
    numberPath:`longitudinal.byId.${row.id}`,
    snapshotIds: row.snapshot_ids, summary: row.summary, ...(row.related_ids ? {relatedIds:row.related_ids} : {}) };
}

/** Metadata only. Checkpoints remain addressable by id; a normal page shows
 * the latest cumulative prediction of each cloud job. Reads use the caller's
 * store so exports participate in the same repeatable-read snapshot.
 * @param {any} store @param {string} studyId @param {any} [filter] */
export async function longitudinalIndex(store,studyId,filter = {},{actor = null} = {}) {
  const limit = Math.min(50,Math.max(1,Number(filter.limit) || 30));
  const offset = Math.max(0,Math.floor(Number(filter.offset) || 0));
  const where = `a.study_id=$1 AND a.kind IN ('history','prediction','prediction_set','evaluation','comparison','trial_benchmark','trial_evaluation','prediction_interruption')
    AND ($2::text IS NULL OR a.kind=$2) AND ($3::text IS NULL OR a.id=$3) AND ($6::text IS NULL OR a.parent_id=$6)
    AND ($3::text IS NOT NULL OR a.kind<>'prediction' OR a.summary->>'jobId' IS NULL OR NOT EXISTS
      (SELECT 1 FROM evimed_vcr.longitudinal_artifacts b WHERE b.study_id=a.study_id AND b.kind='prediction'
        AND b.summary->>'jobId'=a.summary->>'jobId' AND (b.created_at,b.id)>(a.created_at,a.id)))`;
  const rows = (await store.query(`SELECT a.* FROM evimed_vcr.longitudinal_artifacts a WHERE ${where}
    ORDER BY a.created_at DESC,a.id DESC LIMIT $4 OFFSET $5`,[studyId,filter.kind || null,filter.id || null,filter.all ? null : limit+1,offset,filter.parentId || null])).rows;
  const more = !filter.all && rows.length>limit;
  let page = more ? rows.slice(0,limit) : rows;
  const known = new Map(page.map((/** @type {any} */ row) => [row.id,row]));
  const parents = page.flatMap((/** @type {any} */ row) => ['prediction','trial_benchmark'].includes(row.kind) ? [row.id]
    : row.kind === 'prediction_set' ? (row.summary.components ?? []).map((/** @type {any} */ c) => c.id) : []);
  if (parents.length) {
    const children = (await store.query(`SELECT DISTINCT ON (parent_id,kind) * FROM evimed_vcr.longitudinal_artifacts
      WHERE study_id=$1 AND (parent_id=ANY($2::text[]) OR kind='comparison' AND summary->'predictionIds' ?| $2::text[])
        AND kind IN ('evaluation','comparison','trial_evaluation','prediction_interruption')
      ORDER BY parent_id,kind,created_at DESC,id DESC`,[studyId,parents])).rows;
    for (const child of children) {
      known.set(child.id,child);
      const parent = known.get(child.parent_id);
      if (parent) (parent.related_ids ??= {})[child.kind] = child.id;
    }
  }
  // Resolve prediction -> history and evaluation -> prediction -> history. An
  // incremental history does not expand its entire version ancestry here.
  for (let depth=0;depth<3;depth++) {
    const refs = [...new Set([...known.values()].flatMap((/** @type {any} */ row) => [row.summary?.historyId,
      ...(row.summary?.predictionIds ?? []),...(row.summary?.components ?? []).map((/** @type {any} */ c) => c.id),
      row.kind === 'history' ? null : row.parent_id]).filter(id => id && !known.has(id)))];
    if (!refs.length) break;
    for (const row of (await store.query('SELECT * FROM evimed_vcr.longitudinal_artifacts WHERE study_id=$1 AND id=ANY($2::text[])',[studyId,refs])).rows) known.set(row.id,row);
  }
  for (const row of known.values()) if (['evaluation','comparison','trial_evaluation','prediction_interruption'].includes(row.kind)) {
    const parent = known.get(row.parent_id);
    if (parent) (parent.related_ids ??= {})[row.kind] ??= row.id;
  }
  // Every row that leaves here is judged by the same lineage check a single read makes (the store's guard, set by the composition): a
  // row whose source grant, snapshot or field binding is gone is left out whole, never served as a stored summary.
  if (store.longitudinalGuard) {
    const allowed = await store.longitudinalGuard(studyId,[...known.values()],actor);
    for (const id of [...known.keys()]) if (!allowed.has(id)) known.delete(id);
    for (const row of known.values()) for (const [kind,id] of Object.entries(row.related_ids ?? {})) if (!known.has(/** @type {string} */ (id))) delete row.related_ids[kind];
    page = page.filter((/** @type {any} */ row) => known.has(row.id));
  }
  const ids = new Set(page.map((/** @type {any} */ row) => row.id));
  return {records:page.map(longitudinalArtifactView),related:[...known.values()].filter((/** @type {any} */ row) => !ids.has(row.id)).map(longitudinalArtifactView),
    ...(filter.all ? {byId:Object.fromEntries([...known].map(([id,row]) => [id,row.summary]))} : {}),
    more,nextOffset:more ? offset+limit : null,offset,
    digest:longitudinalHash(page.map((/** @type {any} */ row) => ({id:row.id,hash:row.sha256})).sort((a,b) => a.id.localeCompare(b.id)))};
}

export class VcrLongitudinalStore {
  /** @param {{store:any,plane:any,access:any}} parts */
  constructor({store,plane,access}) { this.store = store; this.plane = plane; this.access = access; }
  /** @param {any} study @param {string} kind @param {any} content @param {any} summary @param {any} [lineage] */
  async save(study,kind,content,summary,lineage = {}) {
    const bytes = Buffer.from(canonicalScenarioJson(content));
    const written = await writeContentAddressed(this.plane.root(),`${studyRelative(study.id)}/longitudinal`,'json',bytes);
    const id = `vlf_${longitudinalHash({studyId:study.id,kind,hash:written.sha256}).slice(0,40)}`;
    const row = await this.store.one(`INSERT INTO evimed_vcr.longitudinal_artifacts
      (id,study_id,kind,sha256,location,snapshot_ids,source_ids,parent_id,summary,bindings)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb)
      ON CONFLICT (study_id,kind,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING *`,
    [id,study.id,kind,written.sha256,written.location,JSON.stringify(lineage.snapshotIds ?? []),
      JSON.stringify(lineage.sourceIds ?? []),lineage.parentId ?? null,JSON.stringify(summary),JSON.stringify(lineage.bindings ?? [])]);
    return row;
  }
  /** @param {string} studyId @param {string} id */
  async record(studyId,id) {
    const row = await this.store.one('SELECT * FROM evimed_vcr.longitudinal_artifacts WHERE study_id=$1 AND id=$2',[studyId,id]);
    if (!row) throw new HttpError(404,'vcr_longitudinal_not_found','This research record is not in this study.');
    return row;
  }
  /** The one authorization of an artifact's whole lineage: every snapshot, source and field binding it was made from is judged again.
   * Throws the access error of the first one that is no longer allowed. @param {any} study @param {any} row @param {string} actor */
  async requireLineage(study,row,actor) {
    for (const snapshotId of row.snapshot_ids) await this.access.require({studyId:study.id,actor,
      ability:'read_patient_level',snapshotId,purpose:'vcr',note:'longitudinal research'});
    for (const sourceId of row.source_ids) await this.access.require({studyId:study.id,actor,
      ability:'read_patient_level',sourceId,purpose:'vcr',note:'longitudinal research'});
    for (const binding of row.bindings ?? []) {
      const decision = await this.access.require({studyId:study.id,actor,ability:'read_patient_level',
        snapshotId:binding.snapshotId,fields:binding.fields,purpose:'vcr',note:'frozen forecast fields'});
      if (decision.fields?.denied?.length) throw new HttpError(403,'vcr_forecast_fields_unavailable','Fields used by this forecast are no longer available for this operation.');
    }
  }
  /** The ids of the rows whose lineage is still allowed: the list, the report model and a run's read keep only these. A refusal leaves a
   * row out; any other failure is not a refusal and is thrown. Rows with one lineage are judged once.
   * @param {any} study @param {any[]} rows @param {string | null} [actor] @returns {Promise<Set<string>>} */
  async permitted(study,rows,actor = null) {
    const who = actor ?? study.userId;
    /** @type {Map<string,Promise<boolean>>} */ const judged = new Map();
    const allowed = new Set();
    for (const row of rows) {
      const key = JSON.stringify([row.snapshot_ids,row.source_ids,row.bindings ?? []]);
      if (!judged.has(key)) judged.set(key,this.requireLineage(study,row,who).then(() => true,error => {if (error instanceof HttpError) return false;throw error;}));
      if (await judged.get(key)) allowed.add(row.id);
    }
    return allowed;
  }
  /** Rejudge all source grants whenever patient-level artifacts are opened.
   * @param {any} study @param {string} id @param {string} actor */
  async read(study,id,actor) {
    const row = await this.record(study.id,id);
    await this.requireLineage(study,row,actor);
    const bytes = await fs.readFile(this.plane.resolve(row.location));
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new HttpError(409,'vcr_longitudinal_changed','The preserved input bytes have changed.');
    return {row,content:JSON.parse(bytes.toString('utf8'))};
  }
  /** @param {string} studyId @param {any} [filter] @param {any} [store] @param {string | null} [actor] */
  async list(studyId,filter = {},store = this.store,actor = null) {
    return longitudinalIndex(store,studyId,filter,{actor});
  }
}
