import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { geoProject } from '../__fixtures__/geoTabs';
import { clusterViewFixture, clustersFilled, G_SAFETY } from '../__fixtures__/geoSpine';
import { ClusterDrawer } from './ClusterDrawer';

const calls = vi.hoisted(() => ({ open: vi.fn(), view: null as unknown }));
vi.mock('./spineData', () => ({ useGeoCluster: () => ({ state: { kind: 'ready', data: calls.view }, reload: vi.fn() }), useGeoClusters: () => ({ state: { kind: 'ready', data: clustersFilled } }) }));
vi.mock('./useArticleActions', () => ({ useArticleActions: () => ({ open: calls.open, dialogs: null }) }));
vi.mock('../useOpenGeoConversation', () => ({ useOpenGeoConversation: () => vi.fn() }));

it('only opens the explicitly current GEO article pin for a member', async () => {
  const view = clusterViewFixture(G_SAFETY);
  view.articles = [{ ...view.articles[0], currentResultVersionId: 'v1', contentSha256: 'digest', versionBasis: 'current' },
    { ...view.articles[0], id: 'missing', title: '缺版本', currentResultVersionId: null, contentSha256: null, versionBasis: 'current' }];
  calls.view = view; calls.open.mockClear();
  const project = geoProject(); project.access = { owner: false, roles: ['viewer'], abilities: ['read'] };
  render(<MemoryRouter><ClusterDrawer geoId="geo_1" project={project} groupId={G_SAFETY} onClose={() => {}} /></MemoryRouter>);
  const list = screen.getByRole('list', { name: '这一群的稿件' });
  expect(within(list).getByText(/版本未记录，无法预览/)).toBeInTheDocument();
  await userEvent.click(within(list).getByRole('button', { name: /禁忌与必须就医/ }));
  expect(calls.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'art_safety', currentResultVersionId: 'v1', contentSha256: 'digest' }));
  expect(within(list).queryByRole('button', { name: /缺版本/ })).not.toBeInTheDocument();
});
