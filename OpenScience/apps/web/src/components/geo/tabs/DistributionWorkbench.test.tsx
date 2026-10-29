import { GeoFrameContext } from '../geoFrame';
import { GeoDataCache } from '../geoProjectData';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { DistributionWorkbench } from './DistributionWorkbench';
import { firstPublishedDay } from '../spine/ActionsParts';
import { distributionFilled, geoProject } from '../__fixtures__/geoTabs';
import type { GeoExecutionOrder } from '@/lib/geoDistributionClient';

const api = vi.hoisted(() => ({ getGeoExecutionOrders: vi.fn(), getGeoOrderDetail: vi.fn(), getGeoProjectLedger: vi.fn(), getGeoOwnedPublications: vi.fn(), getGeoOwnedPublication: vi.fn(), confirmGeoOwnedPublication: vi.fn(), cancel: vi.fn(), result: vi.fn(), select: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/geoDistributionClient', () => ({ getGeoExecutionOrders: api.getGeoExecutionOrders, getGeoOrderDetail: api.getGeoOrderDetail, getGeoProjectLedger: api.getGeoProjectLedger, getGeoOwnedPublications: api.getGeoOwnedPublications, getGeoOwnedPublication: api.getGeoOwnedPublication, confirmGeoOwnedPublication: api.confirmGeoOwnedPublication }));
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

function NavigationProbe() {
  const location = useLocation(), navigate = useNavigate();
  return <><output aria-label="address">{location.search}</output><button onClick={() => navigate(-1)}>Browser back</button></>;
}
it('a direct order address restores detail and browser back returns to the preceding selection', async () => {
  render(<MemoryRouter initialEntries={['/actions?step=distribution&engines=kimi&order=order-a']}><DistributionWorkbench geoId="geo_1" project={geoProject()} /><NavigationProbe /></MemoryRouter>);
  await screen.findByRole('list', { name: '订单时间线' });
  expect(api.getGeoOrderDetail).toHaveBeenCalledWith('geo_1', 'order-a', { cursor: null, limit: 30 });
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: /关闭/ }));
  await waitFor(() => expect(screen.queryByRole('list', { name: '订单时间线' })).not.toBeInTheDocument());
  expect(screen.getByLabelText('address')).toHaveTextContent('engines=kimi');
  await user.click(screen.getByRole('button', { name: 'Browser back' }));
  await screen.findByRole('list', { name: '订单时间线' });
});

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
// The shared cache keeps each page loader and its refresh target together.
it('refreshing from page two refreshes the first-page key and preserves older page loaders', async () => {
  api.getGeoExecutionOrders.mockImplementation(async (_id, input) => input.cursor
    ? { items: [order({ id: 'older', articleTitle: 'Older article' })], nextCursor: null, total: 31 }
    : { items: [order({ articleTitle: 'Original first page' })], nextCursor: 'page-two', total: 31 });
  const data = new GeoDataCache(() => 100);
  const frame = { data } as NonNullable<React.ContextType<typeof GeoFrameContext>>;
  render(<MemoryRouter><GeoFrameContext.Provider value={frame}><DistributionWorkbench geoId="geo_1" project={geoProject()} /></GeoFrameContext.Provider></MemoryRouter>);
  const user = userEvent.setup();
  await screen.findByText(/Original first page ·/);
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText(/Older article ·/);
  api.getGeoExecutionOrders.mockImplementation(async (_id, input) => input.cursor
    ? { items: [order({ id: 'older', articleTitle: 'Older article' })], nextCursor: null, total: 32 }
    : { items: [order({ articleTitle: 'New first page' })], nextCursor: 'page-two', total: 32 });
  await user.click(screen.getByRole('button', { name: '刷新记录' }));
  await waitFor(() => expect(api.getGeoExecutionOrders).toHaveBeenLastCalledWith('geo_1', { cursor: null, limit: 30 }));
  expect(await screen.findByText(/New first page ·/)).toBeInTheDocument();
  expect(screen.getByText('共 32 条 · 第 1 页')).toBeInTheDocument();
  data.reload('distribution-orders:geo_1:page-two');
  await waitFor(() => expect(api.getGeoExecutionOrders).toHaveBeenLastCalledWith('geo_1', { cursor: 'page-two', limit: 30 }));
  expect(screen.getByText(/New first page ·/)).toBeInTheDocument();
});

it('an explicit owned-page update captures both pins and retries the same request after uncertain delivery', async () => {
  const link = { id: 'owned-a', url: 'https://example.org/owned?id=001', title: 'Owned page', platform: 'brand_site', status: 'active', publishedAt: '2026-10-01T00:00:00Z', articleId: 'a', articleTitle: 'Current draft', articleResultVersionId: 'v1', articleDigest: '1'.repeat(64), currentResultVersionId: 'v2', currentDigest: '2'.repeat(64), versionState: 'update_needed' };
  api.getGeoOwnedPublications.mockResolvedValue({ items: [link], nextCursor: null, total: 1 });
  api.getGeoOwnedPublication.mockResolvedValue({ link, revision: 0, history: { items: [], nextBeforeRevision: null } });
  api.confirmGeoOwnedPublication.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValueOnce({ revision: 2 });
  mount(); const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '自主发布' }));
  await user.click(await screen.findByRole('button', { name: 'Owned page' }));
  await user.click(await screen.findByRole('button', { name: '登记线上已更新为当前稿件' }));
  expect(api.confirmGeoOwnedPublication).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '确认登记' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '确认登记' })).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: '登记线上已更新为当前稿件' }));
  await user.click(screen.getByRole('button', { name: '确认登记' }));
  await waitFor(() => expect(api.confirmGeoOwnedPublication).toHaveBeenCalledTimes(2));
  const first = api.confirmGeoOwnedPublication.mock.calls[0]; expect(api.confirmGeoOwnedPublication.mock.calls[1]).toEqual(first);
  expect(first[0]).toBe('geo_1'); expect(first[1]).toBe('owned-a');
  expect(first[2]).toMatchObject({ expectedRevision: 0, expectedResultVersionId: 'v1', expectedDigest: '1'.repeat(64), resultVersionId: 'v2', digest: '2'.repeat(64) });
  expect(first[2].requestKey).toBeTruthy(); expect(api.cancel).not.toHaveBeenCalled();
});
it('an owned publication direct address remains readable by a viewer without update controls', async () => {
  const project = geoProject(); project.access = { owner: false, roles: ['viewer'], abilities: ['read'] };
  api.getGeoOwnedPublication.mockResolvedValue({ link: { id: 'owned-a', title: 'Recorded page', url: 'https://example.org/page', status: 'active', publishedAt: null, articleResultVersionId: null, articleDigest: null, currentResultVersionId: 'v2', currentDigest: '2'.repeat(64), versionState: 'unknown' }, revision: 0, history: { items: [], nextBeforeRevision: null } });
  render(<MemoryRouter initialEntries={['/actions?step=distribution&publication=owned-a']}><DistributionWorkbench geoId="geo_1" project={project} /></MemoryRouter>);
  await screen.findByText('此前没有记录完整的发布稿件版本。');
  expect(screen.queryByRole('button', { name: '登记线上已更新为当前稿件' })).not.toBeInTheDocument();
  expect(api.confirmGeoOwnedPublication).not.toHaveBeenCalled();
});
