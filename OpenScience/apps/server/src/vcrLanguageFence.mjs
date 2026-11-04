// Unwired safety primitive. Every authorization and judgment mutator must join
// the same fence before a background language worker may be enabled.
/** Account deletion and membership changes precede study locks.
 * @param {{query:(sql:string,values?:any[])=>Promise<any>}} client @param {string} userId */
export async function lockVcrLanguageActor(client,userId) {
  if(typeof userId!=='string'||!userId||userId.length>1024||/[\0\r\n]/.test(userId))throw new TypeError('Invalid account identity.');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-language-actor'),hashtext($1))",[userId]);
}

/** Source-level basis also covers grants whose study_id is null.
 * @param {{query:(sql:string,values?:any[])=>Promise<any>}} client @param {string[]} sourceIds */
export async function lockVcrLanguageSources(client, sourceIds) {
  if (!Array.isArray(sourceIds) || sourceIds.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value))) throw new TypeError('Invalid source identity.');
  for (const id of [...new Set(sourceIds)].sort()) await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-language-source'),hashtext($1))", [id]);
}

/** @param {{query:(sql:string,values?:any[])=>Promise<any>}} client @param {string} studyId */
export async function lockVcrLanguageStudyBasis(client, studyId) {
  if (typeof studyId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(studyId)) throw new TypeError('Invalid study identity.');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-language-basis'), hashtext($1))", [studyId]);
  const result = await client.query('SELECT id FROM evimed_vcr.studies WHERE id=$1 FOR UPDATE', [studyId]);
  if (!result.rows.length) throw Object.assign(new Error('Study is unavailable.'), { code: 'vcr_study_not_found' });
}

/** Call only after lockVcrLanguageStudyBasis, before candidate/source locks.
 * @param {{query:(sql:string,values?:any[])=>Promise<any>}} client
 * @param {{studyId:string, jobId:string, userId:string, owner:string, attempt:number, unitHash:string}} lease */
export async function lockVcrLanguageLease(client, { studyId, jobId, userId, owner, attempt, unitHash }) {
  if (![studyId, jobId, owner].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value))
    || typeof userId !== 'string' || !userId || userId.length > 1024 || /[\0\r\n]/.test(userId)
    || !Number.isSafeInteger(attempt) || attempt < 1 || typeof unitHash !== 'string' || !/^[a-f0-9]{64}$/.test(unitHash)) throw new TypeError('Invalid job lease identity.');
  const result = await client.query(`SELECT id FROM evimed_vcr.jobs WHERE study_id=$1 AND id=$2 AND state='running'
    AND method='matching.language' AND cancel_requested=false AND lease_owner=$3 AND attempts=$4 AND user_id=$5 AND lease_until>clock_timestamp() AND (scenario->'unitHashes') ? $6 FOR UPDATE`, [studyId, jobId, owner, attempt, userId, unitHash]);
  if (!result.rows.length) throw Object.assign(new Error('Job lease changed or expired.'), { code: 'vcr_language_lease_changed' });
}

/** Study and candidate locks must already be held. */
export async function bumpVcrCandidateLanguageEpoch(client,studyId,subjectKey,candidateTrialId) {
  await client.query(`INSERT INTO evimed_vcr.candidate_language_epochs(study_id,subject_key,candidate_trial_id,epoch) VALUES($1,$2,$3,1)
    ON CONFLICT(study_id,subject_key,candidate_trial_id) DO UPDATE SET epoch=evimed_vcr.candidate_language_epochs.epoch+1`,[studyId,subjectKey,candidateTrialId]);
}

/** Study lock must already be held. */
export async function bumpVcrLanguageStudyEpoch(client,studyId) {
  await client.query(`INSERT INTO evimed_vcr.language_study_basis_epochs(study_id,epoch) VALUES($1,1)
    ON CONFLICT(study_id) DO UPDATE SET epoch=evimed_vcr.language_study_basis_epochs.epoch+1`,[studyId]);
  await client.query('UPDATE evimed_vcr.candidate_trial_assessments SET invalidated_at=clock_timestamp() WHERE study_id=$1 AND invalidated_at IS NULL',[studyId]);
}
