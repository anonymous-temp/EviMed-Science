import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { SourceRelationship } from './SourceRelationship';

const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/geoDistributionClient', () => ({ getGeoSourceOwnership: api.read, setGeoSourceOwnership: api.save }));
const target = { kind: 'page' as const, value: 'https://example.org/article?id=001' };
const record = { id: 'annotation', revision: 3, relation: 'partner', active: true, reviewedAt: '2026-10-24T00:00:00Z', reason: null, target, basis: 'user_annotation' };
beforeEach(() => { vi.clearAllMocks(); api.read.mockResolvedValue({ current: record, history: { items: [record], nextBeforeRevision: null } }); api.save.mockResolvedValue(record); });

it('page edits keep the exact address and expected revision and refresh after saving', async () => {
  const changed = vi.fn(); render(<SourceRelationship geoId="geo_1" target={target} canEdit onChanged={changed} />);
  const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: '修改关系' }));
  await user.selectOptions(screen.getByLabelText('与本项目的关系'), 'competitor'); await user.type(screen.getByLabelText('说明（选填）'), 'Confirmed page owner');
  await user.click(screen.getByRole('button', { name: '保存标记' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith('geo_1', { target, relation: 'competitor', expectedRevision: 3, reason: 'Confirmed page owner', active: true }));
  expect(changed).toHaveBeenCalledOnce(); expect(api.read).toHaveBeenCalledTimes(2);
});
it('viewers see inherited domain relationships and paged history without write controls', async () => {
  api.read.mockResolvedValue({ current: { ...record, active: false }, effective: { relation: 'own', origin: 'domain' }, history: { items: [record], nextBeforeRevision: 2 } });
  render(<SourceRelationship geoId="geo_1" target={target} canEdit={false} />);
  await screen.findByText('页面关系：自有'); expect(screen.getByText('沿用站点标记')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '修改关系' })).not.toBeInTheDocument();
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '变更记录' })); await user.click(screen.getByRole('button', { name: '更早记录' }));
  await waitFor(() => expect(api.read).toHaveBeenLastCalledWith('geo_1', target, 2)); expect(api.save).not.toHaveBeenCalled();
});
it('a conflicting save leaves the edit visible and offers reload without overwriting the newer annotation', async () => {
  api.save.mockRejectedValue(new Error('Concurrent annotation'));
  render(<SourceRelationship geoId="geo_1" target={target} canEdit />);
  const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: '修改关系' })); await user.click(screen.getByRole('button', { name: '保存标记' }));
  expect(await screen.findByRole('button', { name: '刷新' })).toBeInTheDocument(); expect(screen.getByLabelText('与本项目的关系')).toBeInTheDocument();
  expect(api.save).toHaveBeenCalledOnce();
});
