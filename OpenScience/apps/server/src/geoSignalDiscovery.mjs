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
  ].map(({ label, ...target }) => ({ ...target, label, key: `target_${digest(target)}` })).sort((a, b) => a.key.localeCompare(b.key));
  return { kind: 'source_changed', objectKey: String(change.id), eventVersion: digest({ notice, targets: targets.map(({ label: _label, ...target }) => target) }), title: String(change.summary || '资料有变化，需要检查相关结论和内容'),
    observedAt: change.at ?? null, basis: { notice, profileVersionAtDetection: profile.version, targets, mappingState: targets.length ? 'linked' : 'unknown',
      dependencyObservation: 'current_at_detection', findingIds: impact.findingIds, groupIds: impact.groupIds } };
}

/** Bounded reconciliation through the existing leased GEO worker and its existing durable marks. */
export class GeoSignalDiscovery {
  constructor({ store, signals, now = () => new Date(), report = (_code) => {} }) { this.store = store; this.signals = signals; this.now = now; this.report = report; }

  async errorEvents(project, row) {
    const error = errorRow(row);
    const events = [{ kind: 'first', snapshotId: error.firstSnapshotId }, ...error.judgmentHistory.filter(errorOccurrence)];
    for (const occurrence of events) {
      const snapshotId = occurrence.snapshotId ?? occurrence.after?.snapshotId;
      const snapshot = snapshotId ? (await this.store.query(`SELECT s.id,s.round_id,s.question_id,s.engine,s.asked_at,s.answer_sha256,
        f.statements,r.ref,q.group_id,q.set_version FROM evimed_geo.snapshots s
        LEFT JOIN evimed_geo.facts f ON f.snapshot_id=s.id AND f.geo_project_id=s.geo_project_id
        LEFT JOIN evimed_geo.rounds r ON r.id=s.round_id AND r.geo_project_id=s.geo_project_id
        LEFT JOIN evimed_geo.questions q ON q.id=s.question_id AND q.geo_project_id=s.geo_project_id
        WHERE s.geo_project_id=$1 AND s.id=$2`, [project.id, snapshotId])).rows[0] : null;
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
    const [profile, articles, claims] = await Promise.all([this.store.latestValue(project.id), this.store.listArticles(project.id), this.store.listClaims(project.id)]);
    for (const impact of geoValueImpacts(profile.data, articles)) {
      const row = await this.signals.record(project, geoSourceImpactEvent(profile, impact, articles, claims));
      await this.signals.deliver(project, row);
    }
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
      const altered = event.detail?.phase === 'check' && event.detail?.reason === 'text_changed' && event.detail?.check?.missing?.length > 0;
      if (!(event.from_state !== event.to_state && ['unknown', 'rejected', 'problem', 'lost'].includes(event.to_state)) && !altered) continue;
      const row = await this.signals.record(project, { kind: 'order_anomaly', objectKey: event.order_id,
        eventVersion: altered ? `text:${digest(event.detail.check.missing)}` : event.id, observedAt: event.at, title: altered ? '已发布内容发生变化，需要检查' : '投放订单需要处理',
        basis: { orderId: event.order_id, eventId: event.id, fromState: event.from_state, toState: event.to_state,
          changedText: altered, articleId: event.article_id, articleResultVersionId: event.article_result_version_id ?? null,
          articleDigest: event.article_digest ?? null, remedy: 'existing_order_detail' } });
      await this.signals.deliver(project, row);
    }
  }

  async project(project) {
    const mark = (await this.store.query('SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key=$2', [project.id, MARK])).rows[0]?.detail ?? {};
    const [errors, snapshots, events] = await Promise.all([
      this.store.query('SELECT * FROM evimed_geo.errors WHERE geo_project_id=$1 AND id>$2 ORDER BY id LIMIT $3', [project.id, mark.errorId ?? '', PAGE]),
      this.store.query(`SELECT s.*,${geoMarketReadTimestamp('s.created_at')} AS _cursor_at FROM evimed_geo.snapshots s WHERE geo_project_id=$1
        AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3)) ORDER BY created_at,id LIMIT $4`, [project.id, mark.snapshotAt ?? null, mark.snapshotId ?? '', PAGE]),
      this.store.query(`SELECT e.*,o.article_id,o.article_result_version_id,o.article_digest,${geoMarketReadTimestamp('e.at')} AS _cursor_at
        FROM evimed_geo.order_events e JOIN evimed_geo.orders o ON o.id=e.order_id WHERE o.geo_project_id=$1
        AND ($2::timestamptz IS NULL OR (e.at,e.id)>($2::timestamptz,$3)) ORDER BY e.at,e.id LIMIT $4`, [project.id, mark.orderAt ?? null, mark.orderEventId ?? '', PAGE]),
    ]);
    for (const error of errors.rows) await this.errorEvents(project, error);
    await this.sources(project);
    await this.citations(project, snapshots.rows);
    await this.orders(project, events.rows);
    const notifications = await this.signals.documents.list(project.userId, 'geo-signal', { projectId: project.projectId, limit: PAGE,
      cursor: mark.noticeCursor ?? null, filter: { recordType: 'geo-signal', geoId: project.id } });
    for (const row of notifications.items) if (!['citation_observed', 'group_changed'].includes(row.payload.kind)) await this.signals.deliver(project, row);
    const tailSnapshot = snapshots.rows.at(-1), tailOrder = events.rows.at(-1);
    const detail = { ...mark, noticeCursor: notifications.nextCursor, errorId: errors.rows.length === PAGE ? errors.rows.at(-1).id : '',
      snapshotAt: tailSnapshot?._cursor_at ?? mark.snapshotAt ?? null, snapshotId: tailSnapshot?.id ?? mark.snapshotId ?? null,
      orderAt: tailOrder?._cursor_at ?? mark.orderAt ?? null, orderEventId: tailOrder?.id ?? mark.orderEventId ?? null };
    // Advancing a producer cursor is the final write, after every signal fact above is durable.
    await this.store.query(`INSERT INTO evimed_geo.schedule_marks(geo_project_id,key,user_id,kind,state,detail,updated_at)
      VALUES($1,$2,$3,'notice','done',$4::jsonb,$5) ON CONFLICT(geo_project_id,key) DO UPDATE SET detail=EXCLUDED.detail,updated_at=EXCLUDED.updated_at`,
    [project.id, MARK, project.userId, JSON.stringify(detail), this.now().toISOString()]);
    return { errors: errors.rows.length, snapshots: snapshots.rows.length, orders: events.rows.length };
  }

  async tick() {
    const selected = await this.store.query(`SELECT p.user_id,p.project_id FROM evimed_geo.projects p
      LEFT JOIN evimed_geo.schedule_marks m ON m.geo_project_id=p.id AND m.key=$1
      WHERE p.deleted_at IS NULL AND NOT p.internal ORDER BY m.updated_at NULLS FIRST,p.created_at,p.id LIMIT 5`, [MARK]);
    const counts = { projects: 0, failed: 0 };
    for (const item of selected.rows) {
      const project = await this.store.projectByControlProject(item.user_id, item.project_id);
      if (!project) continue;
      try { await this.project(project); counts.projects++; }
      catch (error) { counts.failed++; this.report(error?.code ?? 'geo_signal_discovery_failed'); }
    }
    return counts;
  }
}
