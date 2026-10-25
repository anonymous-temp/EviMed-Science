import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { GeoSignalsWorkbench } from './GeoSignalsWorkbench';
import type { GeoSignalDetail, GeoSignalPage } from '@/lib/geoSignalsClient';

const api = vi.hoisted(() => ({ members:vi.fn(), list: vi.fn(), detail: vi.fn(), disposition: vi.fn(), project: vi.fn(), stage: vi.fn(), open: vi.fn(), drawer: vi.fn(), moduleSession: vi.fn() }));
vi.mock('@/lib/geoSignalsClient', async original => ({ ...await original<typeof import('@/lib/geoSignalsClient')>(), listGeoSignals: api.list, getGeoSignal: api.detail, getGeoSignalMembers:api.members, setGeoSignalDisposition: api.disposition }));
vi.mock('@/lib/geoClient', async original => ({ ...await original<typeof import('@/lib/geoClient')>(), getGeoProject: api.project, stageGeoPlanContext: api.stage }));
vi.mock('@/lib/geoNativeClient',async original=>({...await original<typeof import('@/lib/geoNativeClient')>(),openGeoConversation:api.moduleSession}));
vi.mock('./useOpenGeoConversation', () => ({ useOpenGeoConversation: () => api.open }));
vi.mock('./useGeoPath', () => ({ useGeoDestinationPath: () => (_geo: string, target: { tab: string }) => target.tab === 'visibility' ? '/app/geo/geo/visibility?from=2026-01-01&session=held#geo-trend' : '/app/geo/geo/actions?session=held#geo-distribution' }));
vi.mock('@/components/runs/ProgrammeRunsDrawer', () => ({ ProgrammeRunsDrawer: (props: unknown) => { api.drawer(props); return <div>Exact run drawer</div>; } }));
const project = { projectId: 'control', sessionId: 'stale-session', access: { abilities: ['read', 'edit'] } };
const signal = (extra: Partial<GeoSignalDetail> = {}): GeoSignalDetail => ({ id: 'gs_exact', revision: 2, kind: 'source_changed', step: 'evidence', affectedSteps: ['evidence', 'content'],
  title: '引用资料已更正', createdAt: '2026-10-24T00:00:00Z', observedAt: null, detectedAt: '2026-10-24T00:00:00Z', disposition: 'active', state: 'pending', executionState: 'pending', availability: 'available', reason: null,
  businessOutcome: { state: 'unreviewed' }, actionable: true, currentAttempt: null, attempts: [], basisDigest: 'digest', dispositionReason: null,
  basis: { targets: [{ key: 'exact-old', type: 'article', id: 'article', label: '原稿中的限定结论', version: 'rv1', digest: 'old-digest', relationship: 'explicit_dependency' }] }, ...extra });
const attempt = { contextRef: 'gpc_previous', sessionId: 'original-session', requestId: 'request', runId: 'exact-run', submitted: true, createdAt: '2026-10-24T00:00:00Z', startedAt: '2026-10-24T00:01:00Z', finishedAt: null, status: 'running', state: 'processing' as const, executionState: 'processing' as const, availability: 'available' as const, reason: null, result: null };
const page = (items: GeoSignalDetail[]): GeoSignalPage => ({ items, total: items.length, counts: { pending: items.length, started: 0, processing: 0, completed: 0, ignored: 0, failed_recoverable: 0 }, actionable: items.length, nextCursor: null });
const draw = (path = '/app/geo/geo?signal=gs_exact', value = project) => render(<MemoryRouter initialEntries={[path]}><GeoSignalsWorkbench geoId="geo" project={value as never} /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks(); api.members.mockImplementation(async(_geo,_signal,input)=>({side:input.side,basisDigest:input.expectedBasisDigest,total:0,items:[],more:false,nextOffset:null})); api.moduleSession.mockImplementation(async(geoId,target)=>({projectId:'control',sessionId:target.sessionId??'primary-session',scope:{kind:'geo',geoProjectId:geoId,sessionId:target.sessionId??'primary-session'}})); api.detail.mockResolvedValue(signal()); api.list.mockResolvedValue(page([signal()])); api.project.mockResolvedValue({ projectId: 'control', sessionId: 'fresh-session' });
  api.stage.mockImplementation(async (_geo, body) => ({ referenceId: 'gpc_exact', sessionId: body.sessionId, draft: 'Review selected preserved versions.', state: 'staged' })); api.open.mockResolvedValue(true);
});

it('stages only selected exact versions in the existing unsent native composer', async () => {
  draw();
  expect(await screen.findByText(/原稿中的限定结论/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '核查所选版本' }));
  await waitFor(() => expect(api.stage).toHaveBeenCalledWith('geo', expect.objectContaining({ mode: 'signal', signalId: 'gs_exact', expectedSignalRevision: 2, sessionId: 'fresh-session', focusRefs: ['exact-old'], intent: 'review' })));
  expect(api.open).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'control', sessionId: 'fresh-session', exactSession: true, geoPlanContext: { referenceId: 'gpc_exact' } }), 'Review selected preserved versions.');
});

it('shows each exact source review result and the unhandled remainder beside the completed attempt', async () => {
  api.detail.mockResolvedValue(signal({ executionState: 'completed', state: 'pending', businessOutcome: { state: 'partial' },
    sourceReview: { state: 'partial', total: 2, handled: 1, remaining: 1, updated: 1, unchanged: 0, proposed: 0, uncertain: 0, unhandled: 1,
      verification: 'reported_review', issues: [], records: [{ targetKey: 'exact-old', outcome: 'updated', reason: '仅本次所选稿件已更新。',
        after: { type: 'article', id: 'article', version: 'rv_after', path: 'revised.md', runId: 'exact-run', sessionId: 'original-session' },
        artifact: { versionId: 'rv_review', path: 'deliverables/review/geo-value.json', digest: 'review-digest', runId: 'exact-run', sessionId: 'original-session' } }] },
  }));
  draw();
  expect((await screen.findByText(/仍需处理/)).closest('[data-note]')).toHaveTextContent('仍需处理 1 项');
  expect(screen.getByText(/已关联更新版本：仅本次所选稿件已更新/)).toBeTruthy();
  expect(screen.getByRole('link', { name: '查看已关联的稿件版本' })).toHaveAttribute('href', '/app/runs/exact-run/files/revised.md?version=rv_after&geoProject=geo&signal=gs_exact');
  expect(screen.getByRole('link', { name: '查看这项核查的原始结果' })).toHaveAttribute('href', '/app/runs/exact-run/files/deliverables/review/geo-value.json?version=rv_review&geoProject=geo&signal=gs_exact');
  expect(screen.getByRole('button', { name: '核查所选版本' })).toBeTruthy();
});

it('a bound click recovers its conversation without another draft or context submission', async () => {
  api.stage.mockResolvedValue({ referenceId: 'gpc_exact', sessionId: 'original-session', state: 'bound', requestId: 'accepted', draft: 'Do not resend' });
  draw(); fireEvent.click(await screen.findByRole('button', { name: '核查所选版本' }));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'original-session', exactSession: true }), undefined));
  expect(api.open.mock.calls[0][0].geoPlanContext).toBeUndefined();
});

it('ignored running work remains visible and restore never starts or cancels it', async () => {
  api.detail.mockResolvedValue(signal({ state: 'ignored', disposition: 'ignored', executionState: 'processing', currentAttempt: attempt, attempts: [attempt] }));
  api.disposition.mockResolvedValue(signal({ state: 'processing', currentAttempt: attempt, attempts: [attempt] }));
  draw(); expect(await screen.findByText('已忽略 · AI 仍在处理')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '核查所选版本' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '恢复提醒' }));
  await waitFor(() => expect(api.disposition).toHaveBeenCalledWith('geo', 'gs_exact', expect.objectContaining({ expectedRevision: 2, disposition: 'active' })));
  expect(api.stage).not.toHaveBeenCalled(); expect(api.open).not.toHaveBeenCalled();
});

it('unknown run availability keeps recovery unavailable instead of starting a duplicate', async () => {
  api.detail.mockResolvedValue(signal({ availability: 'unknown', currentAttempt: { ...attempt, runId: null, availability: 'unknown' }, attempts: [] }));
  draw(); expect(await screen.findByRole('button', { name: '刷新执行记录' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /继续处理|核查所选/ })).toBeNull(); expect(api.stage).not.toHaveBeenCalled();
});

it('opens the exact run and immutable result version without claiming medical resolution', async () => {
  const completed = { ...attempt, status: 'succeeded', state: 'completed' as const, executionState: 'completed' as const, result: { present: true, artifacts: [{ id: 'rv_old', path: 'deliverables/a/report.md', runId: 'exact-run', sessionId: 'original-session' }] } };
  api.detail.mockResolvedValue(signal({ kind: 'error_observed', state: 'completed', currentAttempt: completed, attempts: [completed], businessOutcome: { state: 'awaiting_remeasure' } }));
  draw(); expect(await screen.findByText('等待后续观察')).toBeTruthy();
  expect(screen.getByRole('link', { name: /report.md/ })).toHaveAttribute('href', '/app/runs/exact-run/files/deliverables/a/report.md?version=rv_old&geoProject=geo&signal=gs_exact');
  fireEvent.click(screen.getByRole('button', { name: '查看本次运行' }));
  expect(api.drawer).toHaveBeenCalledWith(expect.objectContaining({ initialRun: expect.objectContaining({ runId: 'exact-run', sessionId: 'original-session' }) }));
});

it('order anomalies open the existing order operation and do not offer AI resubmission', async () => {
  api.detail.mockResolvedValue(signal({ kind: 'order_anomaly', basis: { orderId: 'order-1' } }));
  draw(); expect(await screen.findByRole('link', { name: '查看订单和可执行操作' })).toHaveAttribute('href', '/app/geo/geo/actions?session=held&order=order-1#geo-distribution');
  expect(screen.queryByRole('button', { name: /对话中分析|核查所选|继续处理/ })).toBeNull();
});

it('late staging after leaving the page does not move the conversation', async () => {
  let resolve!: (value: unknown) => void;
  api.stage.mockReturnValue(new Promise(done => { resolve = done; }));
  const view = draw(); fireEvent.click(await screen.findByRole('button', { name: '核查所选版本' }));
  await waitFor(() => expect(api.stage).toHaveBeenCalledTimes(1)); view.unmount();
  await act(async () => { resolve({ referenceId: 'gpc_exact', sessionId: 'fresh-session', draft: 'Old draft' }); });
  expect(api.open).not.toHaveBeenCalled();
});

it('viewer keeps original evidence and run links but cannot stage or change disposition', async () => {
  draw('/app/geo/geo?signal=gs_exact', { ...project, access: { abilities: ['read'] } });
  expect(await screen.findByText(/原稿中的限定结论/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '核查所选版本' })).toBeNull(); expect(screen.queryByRole('button', { name: '忽略这条提醒' })).toBeNull();
});

it('overview preview reads full actionable scope and history opens through the same page', async () => {
  draw('/app/geo/geo');
  expect(await screen.findByText('引用资料已更正')).toBeTruthy();
  expect(api.list).toHaveBeenCalledWith('geo', { limit: 5, actionable: true });
  fireEvent.click(screen.getByRole('button', { name: '查看全部发现' }));
  expect(await screen.findByRole('combobox', { name: '处理状态' })).toBeTruthy();
  expect(api.list).toHaveBeenCalledWith('geo', { limit: 20 });
});

it('keeps history reachable after the final actionable item was ignored', async () => {
  api.list.mockResolvedValue({ ...page([]), counts: { ...page([]).counts, ignored: 1 } });
  draw('/app/geo/geo');
  fireEvent.click(await screen.findByRole('button', { name: '查看全部发现' }));
  expect(await screen.findByRole('combobox', { name: '处理状态' })).toBeTruthy();
});

it('resolves the first exact module primary before staging a signal in a same-id personal collision',async()=>{
 api.project.mockResolvedValue({projectId:'control',sessionId:null});
 draw('/app/geo/geo?signal=gs_exact',{...project,sessionId:null} as never);
 fireEvent.click(await screen.findByRole('button',{name:'核查所选版本'}));
 await waitFor(()=>expect(api.stage).toHaveBeenCalledWith('geo',expect.objectContaining({sessionId:'primary-session',mode:'signal'})));
 expect(api.moduleSession).toHaveBeenCalledWith('geo',{kind:'primary'});
 expect(api.moduleSession.mock.invocationCallOrder[0]).toBeLessThan(api.stage.mock.invocationCallOrder[0]);
 expect(api.stage.mock.invocationCallOrder[0]).toBeLessThan(api.open.mock.invocationCallOrder[0]);
 expect(api.open).toHaveBeenCalledWith(expect.objectContaining({sessionId:'primary-session',exactSession:true}),'Review selected preserved versions.');
});
it('does not stage or replace an unavailable exact signal conversation',async()=>{
 api.moduleSession.mockRejectedValueOnce(new Error('Exact session unavailable'));
 draw();fireEvent.click(await screen.findByRole('button',{name:'核查所选版本'}));
 await screen.findByText('暂时无法打开处理对话，已保留本次选择。');expect(api.stage).not.toHaveBeenCalled();expect(api.open).not.toHaveBeenCalled();
});

it('never replaces an unavailable submitted signal root with the primary',async()=>{
 api.detail.mockResolvedValue(signal({currentAttempt:{...attempt,sessionId:null,status:'failed',state:'failed_recoverable',executionState:'failed_recoverable'} as never}));
 draw();fireEvent.click(await screen.findByRole('button',{name:'在原对话继续处理'}));
 await screen.findByText('暂时无法打开处理对话，已保留本次选择。');
 expect(api.moduleSession).not.toHaveBeenCalled();expect(api.stage).not.toHaveBeenCalled();expect(api.open).not.toHaveBeenCalled();
});


it('shows immutable group values, denominators, exact side analysis and uncertainty before an unsent analyse draft', async () => {
  api.members.mockImplementation(async(_geo,_signal,input)=>({side:input.side,basisDigest:input.expectedBasisDigest,total:1,items:[{snapshotId:'old-'+input.side,engine:'deepseek',preservedAnswer:{text:input.side==='before'?'Frozen old answer':'Frozen new answer'}}],more:false,nextOffset:null}));
  api.detail.mockResolvedValue(signal({ kind: 'group_changed', businessOutcome: { state: 'observed' }, basis: {
    group: { id: 'g', label: 'Exact group', pool: 'P2', questionVersion: 3 },
    previous: { id: 'a', completedAt: '2026-10-25T01:00:00Z' }, current: { id: 'b', completedAt: '2026-10-25T01:01:00Z' },
    policy: { threshold: 5, noiseMeasured: false }, cells: [{ key: 'metric', metricId: 'M-01', delta: 20, before: { value: 20, numerator: 44, denominator: 220 }, after: { value: 40, numerator: 88, denominator: 220 } }],
    sides: { before: { selectionRef: 'gsel_before', count: 220 }, after: { selectionRef: 'gsel_after', count: 220 } },
  }, groupMembers: { before: { availability: 'preserved', total: 220, items: [{ snapshotId: 'old', questionId: 'question', engine: 'deepseek', preservedAnswer: { text: 'Frozen old answer' } }] }, after: { availability: 'unknown', total: null, items: [] } } }));
  draw();
  expect(await screen.findByText('品牌提及率：20% → 40%')).toBeTruthy();
  expect(screen.getByText(/前次 44 \/ 220；本次 88 \/ 220；差异 \+20 个百分点/)).toBeTruthy();
  expect(screen.getByText(/噪声未实测，不能据此判断由内容调整造成/)).toBeTruthy();
  expect(screen.getByRole('link', { name: '查看前轮共同样本' })).toHaveAttribute('href', '/app/geo/geo/visibility?selectionRef=gsel_before&session=held#geo-trend');
  expect(await screen.findByText('Frozen old answer')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '在对话中分析' }));
  await waitFor(() => expect(api.stage).toHaveBeenCalledWith('geo', expect.objectContaining({ mode: 'signal', intent: 'analyse', focusRefs: [] })));
  expect(api.open).toHaveBeenCalledWith(expect.objectContaining({ geoPlanContext: { referenceId: 'gpc_exact' } }), 'Review selected preserved versions.');
});
