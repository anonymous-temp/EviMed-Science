import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CapabilityUi } from '@/lib/researchAgentUi';
import { useOpenTool } from './useOpenTool';

const mocks = vi.hoisted(() => ({ projectId: 'default', put: vi.fn(), navigate: vi.fn(), allocate: vi.fn(), bind: vi.fn(), error: vi.fn() }));
vi.mock('react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/apiClient', () => ({ getWebProjectId: () => mocks.projectId, putWebResearchSession: mocks.put, createWebStatisticalWorkspace: mocks.allocate, webErrorMessage: () => '请稍后重试。' }));
vi.mock('@/lib/dispatch', () => ({ bindConversationCapability: mocks.bind, newResearchSessionId: () => 'new-tool-root' }));
vi.mock('@/lib/projects', () => ({ useProjectStore: { getState: () => ({ load: async () => {} }) } }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error } }));
const statistics = { id: 'statistical-analysis', version: '1.0.0', title: '数据分析' } as CapabilityUi;

beforeEach(() => { vi.clearAllMocks(); mocks.projectId = 'default'; });

it('opens a newly allocated project and its recorded root in the native conversation', async () => {
  mocks.allocate.mockResolvedValue({ projectId: 'stat-owned', sessionId: 'session-owned' });
  const { result } = renderHook(useOpenTool);
  act(() => { result.current.open(statistics); result.current.open(statistics); });
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
  expect(mocks.allocate).toHaveBeenCalledTimes(1);
  expect(mocks.bind).not.toHaveBeenCalled();
  expect(mocks.navigate).toHaveBeenCalledWith('/app/chat?project=stat-owned', { state: {
    capabilityId: 'statistical-analysis', runtimeUiIntent: expect.objectContaining({ sessionId: 'session-owned', projectId: 'stat-owned' }),
  } });
});

it('keeps the allocation request identity after failure and only navigates once binding succeeds', async () => {
  mocks.allocate.mockRejectedValueOnce(new Error('Binding failed')).mockResolvedValue({ projectId: 'stat-retry', sessionId: 'session-retry' });
  const { result } = renderHook(useOpenTool);
  act(() => result.current.open(statistics));
  await waitFor(() => expect(result.current.opening).toBeNull());
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledTimes(1);
  const request = mocks.allocate.mock.calls[0][0];
  act(() => result.current.open(statistics));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
  expect(mocks.allocate.mock.calls[1][0]).toEqual(request);
});

it('other catalogue capabilities retain the existing binding and unscoped navigation', async () => {
  mocks.bind.mockResolvedValue({ sessionId: 'other-session' });
  const { result } = renderHook(useOpenTool);
  act(() => result.current.open({ ...statistics, id: 'clinical-evidence-synthesis' }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
  expect(mocks.allocate).not.toHaveBeenCalled();
  expect(mocks.bind).toHaveBeenCalledWith(null, { agentId: 'clinical-evidence-synthesis', agentVersion: '1.0.0' });
  expect(mocks.navigate.mock.calls[0][0]).toBe('/app/chat');
});


it('another catalogue tool after an isolated analysis binds and navigates in the ordinary default project', async () => {
  mocks.projectId = `stat-${'a'.repeat(40)}`;
  mocks.put.mockResolvedValue({ sessionId: 'new-tool-root' });
  const { result } = renderHook(useOpenTool);
  act(() => result.current.open({ ...statistics, id: 'meta-analysis' }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
  expect(mocks.put).toHaveBeenCalledWith('new-tool-root', { mode: 'specialist', agentId: 'meta-analysis', agentVersion: '1.0.0' }, { projectId: 'default' });
  expect(mocks.bind).not.toHaveBeenCalled();
  expect(mocks.navigate).toHaveBeenCalledWith('/app/chat?project=default', { state: {
    capabilityId: 'meta-analysis', runtimeUiIntent: expect.objectContaining({ projectId: 'default', sessionId: 'new-tool-root' }),
  } });
});
