import { createHash } from 'node:crypto';
import { canonicalJson } from './geoStore.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const outcomes = ['no_change_needed', 'update_proposed', 'updated', 'uncertain'];

/** Structured review is an optional result of the existing native turn, never a medical delivery gate. */
export class GeoSourceReviews {
  constructor({ bridge, results, store }) { this.bridge = bridge; this.results = results; this.store = store; }

  async successor(project, target, after, run) {
    if (!object(after)) return null;
    if (target.type === 'article' && typeof target.version === 'string' && typeof after.resultVersionId === 'string') {
      const versions = await this.store.articleVersions(project.id, target.id);
      const accepted = versions.find(version => version.resultVersionId === after.resultVersionId
        && version.runId === run.id && version.sessionId === run.sessionId
        && (!version.requestId || run.kernelRequestIds?.includes(version.requestId)));
      if (!accepted || accepted.resultVersionId === target.version || accepted.digest === target.digest) return null;
      let cursor = accepted;
      const visited = new Set();
      while (cursor && visited.size < 128 && !visited.has(cursor.resultVersionId)) {
        visited.add(cursor.resultVersionId);
        if (cursor.resultVersionId === target.version && cursor.digest === target.digest) return { type: 'article', id: target.id,
          version: accepted.resultVersionId, digest: accepted.digest, path: accepted.path, runId: run.id, sessionId: run.sessionId };
        cursor = versions.find(version => version.resultVersionId === cursor.parentVersionId);
      }
      return null;
    }
    if (target.type === 'finding' && Number.isSafeInteger(after.profileVersion) && after.profileVersion > 0) {
      const profile = await this.store.latestValue(project.id, after.profileVersion);
      const finding = list(profile.data?.findings).find(item => item.id === target.id);
      if (profile.version !== after.profileVersion || profile.runId !== run.id || !finding || hash(finding) === target.digest) return null;
      return { type: 'finding', id: target.id, version: profile.version, digest: hash(finding), runId: run.id, sessionId: run.sessionId };
    }
    if (target.type === 'claim' && typeof after.claimId === 'string') {
      const result = (await this.store.query(`SELECT successor.id,successor.version FROM evimed_geo.claims original
        JOIN evimed_geo.claims successor ON successor.geo_project_id=original.geo_project_id AND successor.claim_key=original.claim_key
        WHERE original.geo_project_id=$1 AND original.user_id=$2 AND original.id=$3 AND original.version=$4
          AND successor.id=$5 AND successor.run_id=$6 AND successor.version>original.version`,
      [project.id, project.userId, target.id, target.version, after.claimId, run.id])).rows[0];
      return result ? { type: 'claim', id: result.id, version: result.version, runId: run.id, sessionId: run.sessionId } : null;
    }
    return null;
  }

  async forRun(project, signal, run, targets) {
    const { context } = await this.bridge.scope({ id: project.userId }, project.id, signal.id, run.id);
    const selected = new Map(targets.filter(target => context.payload.basis.focusRefs.includes(target.key)).map(target => [target.key, target]));
    const records = new Map(), issues = [];
    let cursor = null, read = 0, unavailable = false;
    do {
      let page;
      try { page = await this.results.list(project.userId, { projectId: project.projectId, runId: run.id, limit: 100, cursor }); }
      catch { issues.push('review_result_unavailable'); unavailable = true; break; }
      for (const file of page.items) {
        if (!/(^|\/)geo-value\.json$/.test(file.path ?? '') || file.producer?.kind === 'workspace'
          || file.producer?.runId !== run.id || file.producer?.sessionId !== run.sessionId) continue;
        if (++read > 20) { issues.push('review_file_limit'); unavailable = true; continue; }
        if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 262144) { issues.push('review_file_unavailable'); unavailable = true; continue; }
        let raw;
        try { raw = await this.results.raw(project.userId, project.projectId, file.versionId); }
        catch { issues.push('review_result_unavailable'); unavailable = true; continue; }
        if (raw.version.versionId !== file.versionId || raw.version.digest !== file.digest || raw.bytes.length > 262144) { issues.push('review_file_unavailable'); unavailable = true; continue; }
        let parsed;
        try { parsed = JSON.parse(raw.bytes.toString('utf8')); } catch { issues.push('review_file_invalid'); continue; }
        for (const change of list(parsed?.sourceChanges)) {
          const review = change?.review;
          if (change?.id !== signal.payload.basis.notice?.id || !object(review) || review.signalId !== signal.id
            || review.basisDigest !== signal.payload.basisDigest || review.contextRef !== context.id) continue;
          if (!Array.isArray(review.targets) || review.targets.length > 100) { issues.push('review_targets_invalid'); continue; }
          for (const item of review.targets) {
            const target = selected.get(item?.targetKey);
            if (!target || !outcomes.includes(item?.outcome) || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 4000) { issues.push('review_target_invalid'); continue; }
            let after = null;
            try { if (item.outcome === 'updated') after = await this.successor(project, target, item.after, run); }
            catch {
              // Failure to inspect a successor is not a contradictory review.
              // Keep an already supported result, including its original proof;
              // the attempt's unknown scope below still prevents false closure.
              issues.push('review_successor_unavailable'); unavailable = true; continue;
            }
            const record = { targetKey: target.key, outcome: item.outcome === 'updated' && !after ? 'update_proposed' : item.outcome,
              reason: item.reason.trim(), after, verification: 'reported_review',
              warning: item.outcome === 'updated' && !after ? 'successor_unconfirmed' : null,
              contextRef: context.id, runId: run.id, sessionId: run.sessionId,
              artifact: { versionId: file.versionId, path: file.path, digest: file.digest, runId: run.id, sessionId: run.sessionId } };
            const prior = records.get(target.key);
            if (prior && canonicalJson([prior.outcome, prior.reason, prior.after]) !== canonicalJson([record.outcome, record.reason, record.after])) {
              records.set(target.key, { ...record, outcome: 'uncertain', warning: 'conflicting_review_results', after: null });
            } else if (!prior) records.set(target.key, record);
          }
        }
      }
      cursor = read > 20 ? null : page.nextCursor;
    } while (cursor);
    return { records: [...records.values()], selectedTargetKeys: [...selected.keys()], issues, availability: unavailable ? 'unknown' : 'available' };
  }
}

/** Prior work remains visible; an explicit later uncertainty supersedes only its exact target. */
export function summarizeGeoSourceReviews(targets, attempts) {
  const latest = new Map();
  for (const attempt of [...attempts].reverse()) {
    const review = attempt.sourceReview;
    for (const record of review?.records ?? []) latest.set(record.targetKey, { ...record, availability: 'available' });
    if (review?.availability === 'unknown') for (const key of review.selectedTargetKeys ?? attempt.focusRefs ?? targets.map(target => target.key)) {
      const preserved = latest.get(key);
      latest.set(key, { ...preserved, targetKey: key, reportedOutcome: preserved?.reportedOutcome ?? preserved?.outcome ?? null,
        outcome: 'uncertain', availability: 'unknown', warning: 'review_result_unavailable' });
    }
  }
  const records = targets.map(target => ({ targetKey: target.key, outcome: 'unhandled', reason: null, after: null, ...latest.get(target.key) }));
  const count = outcome => records.filter(record => record.outcome === outcome).length;
  const handled = count('no_change_needed') + count('updated'), unknown = records.some(record => record.availability === 'unknown');
  return { state: unknown ? 'unknown' : targets.length === 0 ? 'unknown' : handled === targets.length ? 'handled' : handled ? 'partial' : 'unreviewed',
    total: targets.length, handled, remaining: targets.length - handled, updated: count('updated'), unchanged: count('no_change_needed'),
    proposed: count('update_proposed'), uncertain: count('uncertain'), unhandled: count('unhandled'),
    verification: 'reported_review', records, issues: [...new Set(attempts.flatMap(attempt => attempt.sourceReview?.issues ?? []))] };
}
