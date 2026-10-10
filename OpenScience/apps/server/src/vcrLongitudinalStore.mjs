/** Immutable longitudinal artifacts. Patient rows live only in the data plane;
 * the existing VCR database stores identities, lineage and aggregate summaries. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalScenarioJson } from '@evimed/domain';
import { writeContentAddressed, studyRelative } from './vcrDataPlane.mjs';
import { HttpError } from './security.mjs';

/** @param {any} value */
export const longitudinalHash = value => createHash('sha256').update(canonicalScenarioJson(value)).digest('hex');
/** @param {any} row */
export function longitudinalArtifactView(row) {
  return { id: row.id, kind: row.kind, hash: row.sha256, parentId: row.parent_id ?? null, createdAt: row.created_at,
    snapshotIds: row.snapshot_ids, summary: row.summary };
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
  /** Rejudge all source grants whenever patient-level artifacts are opened.
   * @param {any} study @param {string} id @param {string} actor */
  async read(study,id,actor) {
    const row = await this.record(study.id,id);
    for (const snapshotId of row.snapshot_ids) await this.access.require({studyId:study.id,actor,
      ability:'read_patient_level',snapshotId,purpose:'vcr',note:'longitudinal research'});
    for (const sourceId of row.source_ids) await this.access.require({studyId:study.id,actor,
      ability:'read_patient_level',sourceId,purpose:'vcr',note:'longitudinal research'});
    for (const binding of row.bindings ?? []) {
      const decision = await this.access.require({studyId:study.id,actor,ability:'read_patient_level',
        snapshotId:binding.snapshotId,fields:binding.fields,purpose:'vcr',note:'frozen forecast fields'});
      if (decision.fields?.denied?.length) throw new HttpError(403,'vcr_forecast_fields_unavailable','Fields used by this forecast are no longer available for this operation.');
    }
    const bytes = await fs.readFile(this.plane.resolve(row.location));
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new HttpError(409,'vcr_longitudinal_changed','The preserved input bytes have changed.');
    return {row,content:JSON.parse(bytes.toString('utf8'))};
  }
  /** @param {string} studyId */
  async list(studyId) {
    return (await this.store.query(`SELECT * FROM evimed_vcr.longitudinal_artifacts WHERE study_id=$1
      AND kind IN ('history','prediction','evaluation','comparison','trial_benchmark','trial_evaluation','prediction_interruption')
      ORDER BY created_at DESC,id DESC LIMIT 100`,[studyId])).rows.map(longitudinalArtifactView);
  }
}
