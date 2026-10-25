import { HttpError } from './security.mjs';
import { geoReadTransactionActive, withGeoReadTransaction } from './geoReadScope.mjs';
import { projectMoney, mapOrder, orderCancellable, ORDER_SELECT, ORDER_STATES } from './geoMarketStore.mjs';
import { geoMarketReadPageOptions, geoMarketReadPage, geoMarketReadTimestamp } from './geoMarketOperations.mjs';
import { geoLedgerBalances } from './geoDistributionMoney.mjs';

const invalid = () => new HttpError(400, 'geo_payload_invalid', 'Invalid project distribution page.');
const iso = value => value == null ? null : new Date(value).toISOString();
const ledgerRow = row => ({ id: String(row.id), orderId: row.order_id ?? null, kind: String(row.kind), amountCny: Number(row.amount_cny), createdAt: iso(row.created_at) });
const orderQuery = `SELECT o.*,a.title AS article_title,a.layer AS article_layer,a.current_result_version_id,a.content_sha256 AS current_digest,
  m.name AS media_name,m.domain AS media_domain FROM (${ORDER_SELECT} WHERE o.geo_project_id=$1 AND o.user_id=(SELECT user_id FROM evimed_geo.projects WHERE id=$1)) o
  LEFT JOIN evimed_geo.articles a ON a.id=o.article_id AND a.geo_project_id=o.geo_project_id AND a.user_id=o.user_id
  LEFT JOIN evimed_geo.media m ON m.media_type=o.media_type AND m.resource_id=o.resource_id`;
const phases = new Set(['send_started', 'late_send_result', 'price_changed', 'url_changed', 'refund_seen', 'refund_escalated', 'auto_cancel', 'check', 'cited']);
const opaqueId = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const orderView = row => {
  const order = mapOrder(row);
  const comparable = Boolean(order.articleResultVersionId && order.articleDigest && row.current_result_version_id && row.current_digest);
  return { id: order.id, articleId: order.articleId, articleTitle: row.article_title ?? null, media: row.media_name ?? null, domain: row.media_domain ?? null,
    layer: row.article_layer ?? null, state: order.state, priceCny: order.settledCny ?? order.priceCny ?? order.reserveCny,
    articleResultVersionId: order.articleResultVersionId, articleDigest: order.articleDigest, currentResultVersionId: row.current_result_version_id ?? null,
    versionState: !comparable ? 'unknown' : order.articleResultVersionId === row.current_result_version_id && order.articleDigest === row.current_digest ? 'current' : 'update_needed',
    publishedUrl: order.publishedUrl, checks: order.checks, cancellable: orderCancellable(order), createdAt: order.createdAt, updatedAt: order.updatedAt,
    sentAt: order.sentAt, submittedAt: order.submittedAt, acceptedAt: order.acceptedAt, publishedAt: order.publishedAt, stateAt: order.stateAt, refundSeenAt: order.refundSeenAt };
};
export const geoDistributionEventView = row => ({ id: String(row.id), at: iso(row.at),
  fromState: ORDER_STATES.includes(row.from_state) ? row.from_state : null, toState: ORDER_STATES.includes(row.to_state) ? row.to_state : null,
  phase: phases.has(row.detail?.phase) ? row.detail.phase : null,
  amountCny: row.detail?.phase === 'refund_seen' && Number.isFinite(row.detail.amountCny) ? row.detail.amountCny : null });

/** Read-only projections of an already authorized GEO project; no marketplace client is composed here. */
export class GeoDistributionView {
  /** @param {{store:import('./geoStore.mjs').GeoStore}} input */
  constructor({ store }) { this.store = store; }

  async requireProject(project) {
    const rows = await this.store.query('SELECT budget FROM evimed_geo.projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [project.id, project.userId]);
    if (!rows.rows[0]) throw new HttpError(404, 'geo_project_not_found', 'GEO project not found.');
    return rows.rows[0];
  }

  /** @param {any} project @param {Record<string,any>} [input] */
  async orders(project, input = {}) {
    if (Object.keys(input).some(key => !['cursor', 'limit', 'articleId'].includes(key)) || input.articleId != null && !opaqueId(input.articleId)) throw invalid();
    const page = geoMarketReadPageOptions(input, `project-orders:${project.id}:${input.articleId ?? '*'}`);
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.orders(project, input));
    await this.requireProject(project);
    const [rows, count] = await Promise.all([
      this.store.query(`SELECT result.*,${geoMarketReadTimestamp('result.created_at')} AS _cursor_at FROM (${orderQuery}) result
        WHERE ($2::text IS NULL OR article_id=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::text))
        ORDER BY created_at DESC,id DESC LIMIT $5`, [project.id, input.articleId ?? null, page.at, page.id, page.limit + 1]),
      this.store.query('SELECT count(*)::integer AS n FROM evimed_geo.orders WHERE geo_project_id=$1 AND user_id=(SELECT user_id FROM evimed_geo.projects WHERE id=$1) AND ($2::text IS NULL OR article_id=$2)', [project.id, input.articleId ?? null]),
    ]);
    return { ...geoMarketReadPage(rows.rows, page, orderView), total: Number(count.rows[0].n) };
  }

  /** @param {any} project @param {string} orderId @param {Record<string,any>} [input] */
  async order(project, orderId, input = {}) {
    if (!opaqueId(orderId) || Object.keys(input).some(key => !['cursor', 'limit'].includes(key))) throw invalid();
    const page = geoMarketReadPageOptions(input, `project-order-events:${project.id}:${orderId}`);
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.order(project, orderId, input));
    await this.requireProject(project);
    const found = await this.store.query(`${orderQuery} WHERE o.id=$2`, [project.id, orderId]);
    if (!found.rows[0]) throw new HttpError(404, 'geo_order_not_found', 'Order not found.');
    const [events, count] = await Promise.all([
      this.store.query(`SELECT e.*,${geoMarketReadTimestamp('e.at')} AS _cursor_at FROM evimed_geo.order_events e WHERE order_id=$1
        AND ($2::timestamptz IS NULL OR (at,id)<($2::timestamptz,$3::text)) ORDER BY at DESC,id DESC LIMIT $4`, [orderId, page.at, page.id, page.limit + 1]),
      this.store.query('SELECT count(*)::integer AS n FROM evimed_geo.order_events WHERE order_id=$1', [orderId]),
    ]);
    return { order: orderView(found.rows[0]), events: { ...geoMarketReadPage(events.rows, page, geoDistributionEventView), total: Number(count.rows[0].n) } };
  }

  /** Historical balances use the complete ledger prefix, even when only a page is returned.
   * @param {any} project @param {Record<string,any>} [input] */
  async ledger(project, input = {}) {
    if (Object.keys(input).some(key => !['cursor', 'limit'].includes(key))) throw invalid();
    const page = geoMarketReadPageOptions(input, `project-ledger:${project.id}`);
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.ledger(project, input));
    const [projectRows, ledgerRows, totals] = await Promise.all([
      this.store.query('SELECT budget FROM evimed_geo.projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [project.id, project.userId]),
      this.store.query(`SELECT l.*, ${geoMarketReadTimestamp('l.created_at')} AS _cursor_at FROM evimed_geo.ledger l
        WHERE geo_project_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text))
        ORDER BY created_at DESC,id DESC LIMIT $4`, [project.id, page.at, page.id, page.limit + 1]),
      this.store.query(`SELECT order_id,kind,sum(amount_cny) AS amount,count(*)::integer AS n
        FROM evimed_geo.ledger WHERE geo_project_id=$1 GROUP BY order_id,kind`, [project.id]),
    ]);
    if (!projectRows.rows[0]) throw new HttpError(404, 'geo_project_not_found', 'GEO project not found.');
    const sums = totals.rows.map(row => ({ orderId: row.order_id ?? null, kind: String(row.kind), amountCny: Number(row.amount) }));
    const selected = ledgerRows.rows.slice(0, page.limit), oldest = selected.at(-1);
    let opening = null;
    const balances = new Map();
    if (oldest) {
      const parameters = [project.id, oldest._cursor_at, oldest.id];
      const [prefix, budget] = await Promise.all([
        this.store.query(`SELECT order_id,kind,sum(amount_cny) AS amount FROM evimed_geo.ledger
          WHERE geo_project_id=$1 AND (created_at,id)<($2::timestamptz,$3::text) GROUP BY order_id,kind`, parameters),
        this.store.query(`SELECT amount_cny FROM evimed_geo.ledger WHERE geo_project_id=$1 AND kind='budget_set'
          AND (created_at,id)<($2::timestamptz,$3::text) ORDER BY created_at DESC,id DESC LIMIT 1`, parameters),
      ]);
      const timeline = geoLedgerBalances([...selected].reverse().map(ledgerRow), {
        openingSums: prefix.rows.map(row => ({ orderId: row.order_id ?? null, kind: String(row.kind), amountCny: Number(row.amount) })),
        openingBudgetCny: budget.rows[0] ? Number(budget.rows[0].amount_cny) : null,
      });
      opening = timeline.opening;
      for (const entry of timeline.entries) balances.set(entry.id, entry.balance);
    }
    return {
      ...geoMarketReadPage(ledgerRows.rows, page, row => ({ ...ledgerRow(row), balance: balances.get(String(row.id)) })),
      total: totals.rows.reduce((sum, row) => sum + Number(row.n), 0), currency: 'CNY', opening,
      summary: projectMoney({ budget: projectRows.rows[0].budget }, sums),
    };
  }
}
