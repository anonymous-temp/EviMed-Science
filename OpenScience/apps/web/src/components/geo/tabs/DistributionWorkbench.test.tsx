import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { DistributionWorkbench } from './DistributionWorkbench';
import { firstPublishedDay } from '../spine/ActionsParts';
import { distributionFilled, geoProject } from '../__fixtures__/geoTabs';
import type { GeoExecutionOrder } from '@/lib/geoDistributionClient';

const api = vi.hoisted(() => ({ getGeoExecutionOrders: vi.fn(), getGeoOrderDetail: vi.fn(), getGeoProjectLedger: vi.fn(), cancel: vi.fn(), result: vi.fn(), select: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/geoDistributionClient', () => ({ getGeoExecutionOrders: api.getGeoExecutionOrders, getGeoOrderDetail: api.getGeoOrderDetail, getGeoProjectLedger: api.getGeoProjectLedger }));
vi.mock('@/lib/geoClient', async original => ({ ...await original<typeof import('@/lib/geoClient')>(), cancelGeoOrder: api.cancel }));
vi.mock('@/lib/resultProvenance', () => ({ getResultVersion: api.result }));
vi.mock('@/lib/projects', () => ({ useProjectStore: { getState: () => ({ select: api.select }) } }));
vi.mock('../spine/useOpenArticle', () => ({ useOpenArticle: () => api.open }));
const order = (extra = {}): GeoExecutionOrder => ({ id: 'order-a', articleId: 'a', articleTitle: 'Frozen article', media: 'Example media', domain: 'example.org', layer: 'popular', state: 'submitted', priceCny: 80, publishedUrl: 'https://example.org/article',
  articleResultVersionId: 'v1', articleDigest: 'one', currentResultVersionId: 'v2', versionState: 'update_needed', checks: [], cancellable: false,
  createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-20T01:00:00Z', sentAt: null, submittedAt: null, acceptedAt: null, publishedAt: '2026-10-02T01:00:00Z', stateAt: null, refundSeenAt: null, ...extra });
const details = (entry = order()) => ({ order: entry, events: { items: [{ id: 'event-a', at: entry.publishedAt, fromState: 'accepted', toState: 'published', phase: null, amountCny: null }], nextCursor: null, total: 1 } });
beforeEach(() => { vi.clearAllMocks(); api.getGeoExecutionOrders.mockResolvedValue({ items: [order()], nextCursor: null, total: 1 }); api.getGeoOrderDetail.mockResolvedValue(details()); api.select.mockResolvedValue(undefined); api.open.mockReturnValue(true); });
const mount = (project = geoProject()) => render(<MemoryRouter><DistributionWorkbench geoId="geo_1" project={project} /></MemoryRouter>);

it('orders page independently with complete totals and authoritative cancellation for the actual member', async () => {
  api.getGeoExecutionOrders.mockResolvedValueOnce({ items: [order()], nextCursor: 'page-2', total: 31 }).mockResolvedValueOnce({ items: [order({ id: 'last', articleTitle: 'Last article' })], nextCursor: null, total: 31 });
  mount(); const user = userEvent.setup();
  await screen.findByText(/Frozen article ·/); expect(screen.getByText('共 31 条 · 第 1 页')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '下一页' })); await screen.findByText(/Last article ·/);
  expect(api.getGeoExecutionOrders).toHaveBeenLastCalledWith('geo_1', { cursor: 'page-2', limit: 30 });
  await user.click(screen.getByRole('button', { name: /Last article ·/ })); await screen.findByRole('list', { name: '订单时间线' });
  expect(screen.queryByRole('button', { name: '撤单' })).not.toBeInTheDocument();
  expect(screen.getByText(/线上页面仍关联当时发布的版本/)).toBeInTheDocument();
});
it('an editor cannot cancel even when the server says the order state is cancellable', async () => {
  api.getGeoOrderDetail.mockResolvedValue(details(order({ cancellable: true })));
  const project = geoProject(); project.access = { owner: false, roles: ['editor'], abilities: ['read', 'edit', 'run'] };
  mount(project); await userEvent.click(await screen.findByRole('button', { name: /Frozen article ·/ }));
  await screen.findByRole('list', { name: '订单时间线' }); expect(screen.queryByRole('button', { name: '撤单' })).not.toBeInTheDocument();
});
it('publication opens its immutable version and refuses a digest mismatch instead of opening the current draft', async () => {
  const project = geoProject(); api.result.mockResolvedValue({ projectId: project.projectId, versionId: 'v1', digest: 'one', path: 'article.md', producer: { runId: 'run-v1' } });
  mount(project); const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: /Frozen article ·/ }));
  await user.click(await screen.findByRole('button', { name: '查看当时稿件' }));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith({ runId: 'run-v1', path: 'article.md', currentResultVersionId: 'v1' }));
  expect(api.select).toHaveBeenCalledWith(project.projectId);
  api.result.mockResolvedValue({ projectId: project.projectId, versionId: 'v1', digest: 'changed', path: 'article.md', producer: { runId: 'run-v1' } });
  await user.click(screen.getByRole('button', { name: '查看当时稿件' })); await waitFor(() => expect(api.result).toHaveBeenCalledTimes(2)); expect(api.open).toHaveBeenCalledTimes(1);
});
it('ledger shows net spend, refunds and unknown historic balance separately', async () => {
  const money = { budgetCny: 500, dailyCny: 100, reservedCny: 20, settledCny: 80, refundedCny: 30, spentCny: 50, availableCny: 430 };
  api.getGeoProjectLedger.mockResolvedValue({ items: [{ id: 'l1', orderId: 'order-a', kind: 'refund', amountCny: 30, createdAt: '2026-10-03', balance: { ...money, availableCny: null } }], nextCursor: null, total: 1, currency: 'CNY', summary: money, opening: null });
  mount(); await userEvent.click(screen.getByRole('button', { name: '费用流水' }));
  const rows = await screen.findByRole('list', { name: '费用流水' }); expect(within(rows).getByText(/变动后可用 —/)).toBeInTheDocument();
  expect(screen.getByText('累计支付')).toBeInTheDocument(); expect(screen.getByText('净支出')).toBeInTheDocument(); expect(screen.getAllByText('退款到账')).toHaveLength(2);
});
it('first publication uses actual events across all orders, including later lost or retired records', () => {
  expect(firstPublishedDay({ ...distributionFilled, firstPublishedAt: '2026-09-01T01:00:00Z' })).toBe('2026-09-01');
  expect(firstPublishedDay({ ...distributionFilled, firstPublishedAt: null })).toBeNull();
  expect(firstPublishedDay({ ...distributionFilled, orders: [{ ...distributionFilled.orders[0], state: 'lost', updatedAt: '2026-10-20', publishedAt: '2026-10-02' }], ownedLinks: [] })).toBe('2026-10-02');
  expect(firstPublishedDay({ ...distributionFilled, orders: [{ ...distributionFilled.orders[0], updatedAt: '2026-10-20', publishedAt: null }], ownedLinks: [] })).toBeNull();
});
