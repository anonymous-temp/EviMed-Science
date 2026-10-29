import { readGeoSignalProgress, writeGeoSignalProgress, geoSignalProgressSuperseded } from './geoSignalProgress.mjs';
import { GeoGroupChanges } from './geoGroupChanges.mjs';
import { createHash } from 'node:crypto';
import { geoValueImpacts } from '@evimed/domain';
import { canonicalJson } from './geoStore.mjs';
import { errorRow } from './geoMeasureStore.mjs';
import { geoErrorOrigin } from './geoErrors.mjs';
import { normalizeGeoOwnershipTarget } from './geoSourceOwnership.mjs';
import { geoMarketReadTimestamp } from './geoMarketOperations.mjs';

const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const MARK = 'signals:discovery:v1';
const PAGE = 100;
const displayLabel = value => value == null ? null : String(value).slice(0, 160);
const errorOccurrence = entry => ['business_reopened', 'new_wrong_occurrence', 'judgment_reactivated'].includes(entry?.kind);

/** Pure meaningful impact identity; unrelated profile edits and a later poll do not create a new alert. */
export function geoSourceImpactEvent(profile, impact, articles, claims) {
  const change = impact.change;
  const notice = Object.fromEntries(['id', 'sourceRef', 'sourceId', 'replacedBy', 'kind', 'noticeIdentifier', 'reason'].map(key => [key, change[key] ?? null]));
  const findings = list(profile.data.findings).filter(finding => impact.findingIds.includes(finding.id));
  const claimIds = new Set(findings.flatMap(finding => list(finding.claimIds)));
  const targets = [
    ...findings.map(finding => ({ type: 'finding', id: finding.id, label: finding.statement ?? finding.summary ?? finding.title ?? null, version: null, digest: digest(finding), relationship: 'source_dependency' })),
    ...claims.filter(claim => claimIds.has(claim.id) || [claim.sourceRef, claim.sourceId].some(ref => ref && [change.sourceRef, change.sourceId].includes(ref)))
      .map(claim => ({ type: 'claim', id: claim.id, label: claim.statement ?? null, version: claim.version ?? null, digest: digest(claim), relationship: 'source_dependency' })),
    ...articles.filter(article => impact.articleIds.includes(article.id)).map(article => ({ type: 'article', id: article.id, label: article.title ?? null,
      version: article.currentResultVersionId ?? null, digest: article.contentSha256 ?? null,
      relationship: list(article.valueContext?.findingIds).some(id => impact.findingIds.includes(id)) || list(article.claimIds).some(id => claimIds.has(id)) ? 'explicit_dependency' : 'possible_group_dependency' })),
  ].map(({ label, ...target }) => ({ ...target, label: displayLabel(label), key: `target_${digest(target)}` })).sort((a, b) => a.key.localeCompare(b.key));
  return { kind: 'source_changed', objectKey: String(change.id), eventVersion: digest({ notice, targets: targets.map(({ label: _label, ...target }) => target) }), title: String(change.summary || '资料有变化，需要检查相关结论和内容').slice(0, 1000),
    observedAt: change.at ?? null, basis: { notice, profileVersionAtDetection: profile.version, targets, mappingState: targets.length ? 'linked' : 'unknown',
      dependencyObservation: 'current_at_detection', findingIds: impact.findingIds, groupIds: impact.groupIds } };
}

/** Bounded reconciliation through the existing leased GEO worker and its existing durable marks. */
export class GeoSignalDiscovery {
  constructor({ store, signals, now = () => new Date(), report = (_code) => {} }) { this.store = store; this.signals = signals; this.now = now; this.report = report; this.groups = new GeoGroupChanges({store, signals, now}); }

  async errorEvents(project, row) {
    const error = errorRow(row);
    const events = [{ kind: 'first', snapshotId: error.firstSnapshotId }, ...error.judgmentHistory.filter(errorOccurrence)];
    for (const occurrence of events) {
      const snapshotId = occurrence.snapshotId ?? occurrence.after?.snapshotId;
      const snapshot = snapshotId ? (await this.store.query(`SELECT s.id,s.round_id,s.question_id,s.engine,s.asked_at,s.answer_sha256,
        f.statements,r.ref,q.group_id,q.set_version FROM evimed_geo.snapshots s
        LEFT JOIN evimed_geo.facts f ON f.snapshot_id=s.id AND f.geo_project_id=s.geo_project_id AND f.user_id=s.user_id
        LEFT JOIN evimed_geo.rounds r ON r.id=s.round_id AND r.geo_project_id=s.geo_project_id AND r.user_id=s.user_id
        LEFT JOIN evimed_geo.questions q ON q.id=s.question_id AND q.geo_project_id=s.geo_project_id AND q.user_id=s.user_id
        WHERE s.geo_project_id=$1 AND s.id=$2 AND s.user_id=$3`, [project.id, snapshotId, project.userId])).rows[0] : null;
      // A missing historic snapshot is unknown evidence, not a link to the latest answer.
      const statement = geoErrorOrigin(list(snapshot?.statements), error, list(snapshot?.ref?.evaluationBasis?.claims), { includeNonWrong: true });
      const eventVersion = occurrence.kind === 'first' ? 'first' : digest(occurrence);
      const noticeOccurrence = occurrence.kind === 'first' ? 'first' : occurrence.kind === 'judgment_reactivated' && occurrence.assessmentVersion
        ? `judgment:${occurrence.assessmentVersion}` : `seen:${snapshotId ?? eventVersion}`;
      const signal = await this.signals.record(project, { kind: 'error_observed', objectKey: error.id, eventVersion,
        title: error.statement || 'AI 回答中的医学说法需要检查', observedAt: snapshot?.asked_at ?? null,
        basis: { errorId: error.id, fingerprint: error.fingerprint, snapshotId: snapshot?.id ?? null, roundId: snapshot?.round_id ?? null,
          questionId: snapshot?.question_id ?? error.questionId, groupId: snapshot?.group_id ?? null, questionVersion: snapshot?.set_version ?? null,
          engine: error.engine, severity: error.severity, statement: error.statement, assessedStatement: statement,
          answerDigest: snapshot?.answer_sha256 ?? null, evidenceAvailability: statement ? 'preserved' : 'unknown', occurrence,
          notificationKey: `geo:wrong_ours:${error.id}:${noticeOccurrence}` } });
      if (error.judgmentState === 'active' && error.status !== 'closed') await this.signals.deliver(project, signal);
    }
  }

  async sources(project) {
    const rows = await this.signals.withValueRetention(project, async () => {
      const [profile, articles, claims] = await Promise.all([this.store.latestValue(project.id), this.store.listArticles(project.id), this.store.listClaims(project.id)]);
      const recorded = [];
      for (const impact of geoValueImpacts(profile.data, articles)) recorded.push(await this.signals.record(project, geoSourceImpactEvent(profile, impact, articles, claims)));
      return recorded;
    });
    // Notification delivery never holds a profile retention lock or database client.
    for (const row of rows) await this.signals.deliver(project, row);
  }

  async citations(project, snapshots) {
    for (const snapshot of snapshots) {
      if (!snapshot.engine) continue;
      for (const citation of list(snapshot.citations)) {
        const url = typeof citation === 'string' ? citation : citation?.url;
        let page;
        try { page = normalizeGeoOwnershipTarget({ kind: 'page', value: url }); } catch { continue; }
        await this.signals.record(project, { kind: 'citation_observed', objectKey: `${snapshot.engine}:${page.key}`, eventVersion: 'first_preserved_observation',
          title: `${page.hostname} 的页面出现在 AI 回答引用中`, observedAt: snapshot.asked_at,
          basis: { url, pageKey: page.key, engine: snapshot.engine, snapshotId: snapshot.id, questionId: snapshot.question_id,
            roundId: snapshot.round_id, answerDigest: snapshot.answer_sha256, citation, articleVersion: null,
            publicationRelationship: 'not_established', observation: 'first_preserved_by_discovery' } });
        // Individual page sightings remain visible history. The established article first-cited notice stays the one notification.
      }
    }
  }

  async orders(project, events) {
    for (const event of events) {
      const altered = event.detail?.reason === 'text_changed';
      if (!(event.from_state !== event.to_state && ['unknown', 'rejected', 'problem', 'lost'].includes(event.to_state)) && !altered) continue;
      let origin = event.id;
      let notificationKey = null;
      if (altered) {
        const first = await this.store.query(`WITH current_event AS (SELECT at,id FROM evimed_geo.order_events WHERE order_id=$1 AND id=$2)
          SELECT e.id FROM evimed_geo.order_events e,current_event current WHERE e.order_id=$1 AND e.detail->>'reason'='text_changed'
          AND (e.at,e.id)<=(current.at,current.id) AND NOT EXISTS (
            SELECT 1 FROM evimed_geo.order_events boundary WHERE boundary.order_id=$1 AND (boundary.at,boundary.id)>(e.at,e.id)
              AND (boundary.at,boundary.id)<=(current.at,current.id)
              AND (boundary.detail->>'reason' IS NOT NULL AND boundary.detail->>'reason'<>'text_changed'
                OR boundary.from_state IS DISTINCT FROM boundary.to_state AND boundary.to_state<>'problem'))
          ORDER BY e.at,e.id LIMIT 1`, [event.order_id, event.id]);
        origin = first.rows[0]?.id ?? event.id;
        const initial = await this.store.query(`SELECT id FROM evimed_geo.order_events
          WHERE order_id=$1 AND detail->>'reason'='text_changed' ORDER BY at,id LIMIT 1`, [event.order_id]);
        if (initial.rows[0]?.id === origin) notificationKey = `geo:order:${event.order_id}:text_changed`;
      }
      const row = await this.signals.record(project, { kind: 'order_anomaly', objectKey: event.order_id,
        eventVersion: altered ? `text:${origin}` : event.id, observedAt: event.at, title: altered ? '已发布内容发生变化，需要检查' : '投放订单需要处理',
        basis: { orderId: event.order_id, eventId: origin, fromState: event.from_state, toState: event.to_state,
          changedText: altered, ...(notificationKey ? { notificationKey } : {}), articleId: event.article_id, articleResultVersionId: event.article_result_version_id ?? null,
          articleDigest: event.article_digest ?? null, remedy: 'existing_order_detail' } });
      await this.signals.deliver(project, row);
    }
  }

  async project(project) {
    let mark = await readGeoSignalProgress(this.store,project,MARK);
    try {
      let sourceError = null;
      try { if ((await this.groups.project(project))?.superseded) return {superseded:true}; } catch (error) { sourceError = error; }
      const [errors, snapshots, events] = await Promise.all([
        this.store.query('SELECT * FROM evimed_geo.errors WHERE geo_project_id=$1 AND user_id=$4 AND id>$2 ORDER BY id LIMIT $3', [project.id, mark.errorId ?? '', PAGE, project.userId]),
        this.store.query(`SELECT s.*,${geoMarketReadTimestamp('s.created_at')} AS _cursor_at FROM evimed_geo.snapshots s WHERE geo_project_id=$1 AND user_id=$5
          AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3)) ORDER BY created_at,id LIMIT $4`, [project.id, mark.snapshotAt ?? null, mark.snapshotId ?? '', PAGE, project.userId]),
        this.store.query(`SELECT e.*,o.article_id,o.article_result_version_id,o.article_digest,${geoMarketReadTimestamp('e.at')} AS _cursor_at
          FROM evimed_geo.order_events e JOIN evimed_geo.orders o ON o.id=e.order_id WHERE o.geo_project_id=$1 AND o.user_id=$5
          AND ($2::timestamptz IS NULL OR (e.at,e.id)>($2::timestamptz,$3)) ORDER BY e.at,e.id LIMIT $4`, [project.id, mark.orderAt ?? null, mark.orderEventId ?? '', PAGE, project.userId]),
      ]);
      for (const error of errors.rows) await this.errorEvents(project, error);
      // Source reconciliation has no incremental cursor. A malformed or oversized
      // profile must not prevent independent answer and order observations.
      try { await this.sources(project); } catch (error) { sourceError = error; }
      await this.citations(project, snapshots.rows);
      await this.orders(project, events.rows);
      const notifications = await this.signals.documents.list(project.userId, 'geo-signal', { projectId: project.projectId, limit: PAGE,
        cursor: mark.noticeCursor ?? null, filter: { recordType: 'geo-signal', geoId: project.id } });
      for (const row of notifications.items) if (!['citation_observed', 'group_changed'].includes(row.payload.kind)) await this.signals.deliver(project, row);
      const tailSnapshot = snapshots.rows.at(-1), tailOrder = events.rows.at(-1);
      const detail = { ...mark, lastError: null, noticeCursor: notifications.nextCursor, errorId: errors.rows.length === PAGE ? errors.rows.at(-1).id : '',
        snapshotAt: tailSnapshot?._cursor_at ?? mark.snapshotAt ?? null, snapshotId: tailSnapshot?.id ?? mark.snapshotId ?? null,
        orderAt: tailOrder?._cursor_at ?? mark.orderAt ?? null, orderEventId: tailOrder?.id ?? mark.orderEventId ?? null };
      // Every cursor-bearing producer above is durable. Source reconciliation is
      // retried in full and never shares those observation cursors.
      mark = await writeGeoSignalProgress(this.store,project,MARK,detail,'done',this.now());
      if (sourceError) throw sourceError;
      return { errors: errors.rows.length, snapshots: snapshots.rows.length, orders: events.rows.length };
    } catch (error) {
      if (geoSignalProgressSuperseded(error)) return {superseded:true};
      const code = typeof error?.code === 'string' ? error.code : 'geo_signal_discovery_failed';
      try { await writeGeoSignalProgress(this.store,project,MARK,{...mark,lastError:code.slice(0,160)},'failed',this.now()); }
      catch (failure) { if (geoSignalProgressSuperseded(failure)) return {superseded:true}; this.report('geo_signal_retry_schedule_failed'); }
      throw error;
    }
  }

  async tick() {
    const selected = await this.store.query(`SELECT p.user_id,p.project_id FROM evimed_geo.projects p
      LEFT JOIN evimed_geo.schedule_marks m ON m.geo_project_id=p.id AND m.user_id=p.user_id AND m.key=$1
      WHERE p.deleted_at IS NULL AND NOT p.internal ORDER BY m.updated_at NULLS FIRST,p.created_at,p.id LIMIT 5`, [MARK]);
    const counts = { projects: 0, failed: 0 };
    for (const item of selected.rows) {
      const project = await this.store.projectByControlProject(item.user_id, item.project_id);
      if (!project) continue;
      try {
        if ((await this.project(project))?.superseded) break;
        counts.projects++;
      }
      catch (error) {
        counts.failed++;
        const code = typeof error?.code === 'string' ? error.code : 'geo_signal_discovery_failed';
        this.report(code);
        // The project attempt already wrote its failure through its exact read generation and lease fence.
      }
    }
    return counts;
  }
}
